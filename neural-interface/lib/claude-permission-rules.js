// ── Permission rules as Claude Code's settings files hold them ──
// The sidepanel's /permissions view: what is allowed, denied or asked about, per
// settings scope. The files are the CLI's, written by the CLI (a permission
// card's "Always" goes through it). The SDK has no public call that lists or
// edits a session's live rules (0.3.288), so this reads the same files the CLI
// does, and removing a rule takes that one string out of its list: nothing
// else in the file is touched, and the CLI picks the change up by itself.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { canonicalInside, readConfinedFile, replaceFileAtomic } from './confined-fs.js';

const MAX_RULES = 300;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

// The text of one settings file, read as the regular file it has to be: opened
// without waiting on a FIFO, refused when it is a FIFO, a device or a folder
// before a byte is read, and never more than MAX_SETTINGS_BYTES
// (lib/confined-fs.js). `project`: the file arrived with a repository, so it
// must really be inside that project; a link that leads out is not followed.
// Without it the file is the user's own (of the default or a named account),
// which may be a link into their dotfiles: the file behind the link is read.
function readSettingsText(path, project) {
  if (project) return readConfinedFile(project, path, { maxBytes: MAX_SETTINGS_BYTES, encoding: 'utf-8' });
  const target = realpathSync(path);
  return readConfinedFile(dirname(target), target, { maxBytes: MAX_SETTINGS_BYTES, encoding: 'utf-8' });
}

function readScope(path, project = '') {
  const scope = { path, exists: false, defaultMode: '', allow: [], deny: [], ask: [], additionalDirectories: [], error: '' };
  if (!path || !existsSync(path)) return scope;
  scope.exists = true;
  let text;
  try { text = readSettingsText(path, project); }
  catch (err) {
    // Not read, and said as that: nothing here claims the file has no rules.
    scope.error = project && err?.status === 403
      ? 'is a link that leads out of the project, so it is not read here (Claude Code itself may still apply it)'
      : `could not be read (${err?.message || err})`;
    return scope;
  }
  try {
    const settings = JSON.parse(text);
    const p = settings && typeof settings === 'object' && settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
    const list = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, MAX_RULES) : []);
    scope.allow = list(p.allow);
    scope.deny = list(p.deny);
    scope.ask = list(p.ask);
    scope.additionalDirectories = list(p.additionalDirectories);
    scope.defaultMode = typeof p.defaultMode === 'string' ? p.defaultMode : '';
  } catch (err) {
    // A file that does not parse is skipped by the CLI, rules and all: say so.
    scope.error = `could not be read (${err.message})`;
  }
  return scope;
}

const real = (p) => { try { return realpathSync(p); } catch { return ''; } };

/**
 * The user-scope settings file of a tab. The default account: the one in
 * <home>/.claude. A tab under a named Claude account (`accountHome`, its config
 * directory) reads that account's settings.json, which SynaBun links to the
 * default account's file unless the account was given its own.
 *   path      what the CLI of that account reads
 *   writePath the real file behind it, so a removal lands where the rule is read
 *             from and a link stays a link; '' when the link leads to a file
 *             SynaBun does not manage (never written through)
 *   shared    it is the default account's file: a change shows in both
 *   own       a file of its own, or none yet
 */
export function userSettingsFile({ home, accountHome = '' } = {}) {
  const defaultPath = home ? join(home, '.claude', 'settings.json') : '';
  if (!accountHome) return { path: defaultPath, writePath: defaultPath, shared: false, own: true };
  const path = join(accountHome, 'settings.json');
  const target = real(path);
  if (!target) return { path, writePath: existsSync(path) ? '' : path, shared: false, own: true };
  const base = real(accountHome);
  if (base && (target === join(base, 'settings.json') || target.startsWith(base + sep))) return { path, writePath: target, shared: false, own: true };
  if (defaultPath && target === real(defaultPath)) return { path, writePath: target, shared: true, own: false };
  return { path, writePath: '', shared: false, own: false };
}

/**
 * @param o.home        the user's home directory
 * @param o.accountHome the config directory of the tab's Claude account ('' = the default account)
 * @param o.project     the project directory, or '' for user scope only
 * @returns {{ user: object, project: object|null, local: object|null }}
 */
export function readPermissionRules({ home, accountHome = '', project = '' } = {}) {
  const file = userSettingsFile({ home, accountHome });
  const user = readScope(file.path);
  // A named account: say whose file this is, and whether Remove can edit it.
  if (accountHome) { user.shared = file.shared; user.editable = !!file.writePath; }
  return {
    user,
    project: project ? readScope(join(project, '.claude', 'settings.json'), project) : null,
    local: project ? readScope(join(project, '.claude', 'settings.local.json'), project) : null,
  };
}

const SCOPE_FILES = { user: (home) => join(home, '.claude', 'settings.json'), project: (_, project) => join(project, '.claude', 'settings.json'), local: (_, project) => join(project, '.claude', 'settings.local.json') };
const RULE_LISTS = ['allow', 'ask', 'deny', 'additionalDirectories'];

export class PermissionRuleError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Remove one rule (an exact string) from one list of one settings file.
 * @param o.scope 'user' | 'project' | 'local'
 * @param o.list  'allow' | 'ask' | 'deny' | 'additionalDirectories'
 * @returns {{ removed: boolean, path: string }}
 */
export function removePermissionRule({ home, accountHome = '', project = '', scope, list, rule } = {}) {
  if (!SCOPE_FILES[scope]) throw new PermissionRuleError(400, 'Unknown settings scope');
  if (!RULE_LISTS.includes(list)) throw new PermissionRuleError(400, 'Unknown rule list');
  if (typeof rule !== 'string' || !rule || rule.length > 2000) throw new PermissionRuleError(400, 'A rule is required');
  if (scope === 'user' ? !(home || accountHome) : !project) throw new PermissionRuleError(400, scope === 'user' ? 'No home directory' : 'A registered project is required');
  // The user scope of a tab under a named account is that account's file.
  let path = SCOPE_FILES[scope](home, project);
  if (scope === 'user' && accountHome) {
    path = userSettingsFile({ home, accountHome }).writePath;
    if (!path) throw new PermissionRuleError(409, "This account's settings file is a link to a file SynaBun does not manage. Remove the rule there by hand.");
  }
  if (!existsSync(path)) return { removed: false, path };
  // The file that is rewritten. The user's own settings may be a link
  // (dotfiles): the file behind it is edited and the link stays. A project's
  // files arrive with its repository: its `.claude` folder must really be in
  // the project and the settings file must be a file, not a link, or nothing
  // is written (a link there could point the write anywhere).
  let target;
  if (scope === 'user') target = real(path) || path;
  else {
    try { target = join(canonicalInside(project, dirname(path)), basename(path)); }
    catch { throw new PermissionRuleError(409, "This project's .claude folder is a link that leads out of the project. Remove the rule there by hand."); }
  }
  let before;
  try { before = lstatSync(target); } catch { return { removed: false, path }; }
  if (before.isSymbolicLink() || !before.isFile()) throw new PermissionRuleError(409, 'That settings file is a link or not a regular file. Remove the rule there by hand.');
  let settings;
  try { settings = JSON.parse(readConfinedFile(dirname(target), target, { maxBytes: MAX_SETTINGS_BYTES, encoding: 'utf-8' })); }
  catch (err) { throw new PermissionRuleError(409, `The settings file could not be read (${err.message}). Fix it by hand first.`); }
  const current = settings?.permissions?.[list];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Array.isArray(current) || !current.includes(rule)) return { removed: false, path };
  settings.permissions[list] = current.filter(x => x !== rule);
  // Written through a temporary file nobody can name in advance, created
  // exclusively next to the settings file and never through a link, then
  // renamed over it. A file that changed since it was read is left alone.
  try { replaceFileAtomic(target, `${JSON.stringify(settings, null, 2)}\n`, { mode: before.mode & 0o777, expect: before }); }
  catch (err) { throw new PermissionRuleError(err?.status === 409 ? 409 : 500, err?.status === 409 ? 'The settings file changed while the rule was being removed. Nothing was written; try again.' : `The settings file could not be written (${err?.message || err}).`); }
  return { removed: true, path };
}

// ── Whether a sidepanel tab may be put in Bypass, and why not ──
// Bypass is Claude Code's bypassPermissions mode. Two things take it away:
// the user's settings or a managed policy (permissions.disableBypassPermissionsMode,
// in any settings file the session loads), and running as root outside a
// sandbox, where Claude Code refuses to start with the mode available.
//
// Claude Code is what enforces both. This module only answers ahead of time,
// so the panel can show the option as unavailable with the reason
// (GET /api/claude-code/bypass-policy) and the bridge can leave the launch
// option out where it would stop the process from starting.

import { existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { readConfinedFile } from './confined-fs.js';
import { userSettingsFile } from './claude-permission-rules.js';

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const SETTING = 'permissions.disableBypassPermissionsMode';
const SOURCE_TEXT = {
  user: 'your Claude Code settings',
  project: 'this project\'s settings',
  local: 'this project\'s settings (only you)',
  managed: 'a managed policy',
  flag: 'the session\'s settings',
};

export const BYPASS_ROOT_REASON = 'Bypass is not available: Claude Code refuses it when it runs as root.';

/** Why no process can be launched able to take Bypass ('' when one can). */
export function rootBypassBlock({ platform = process.platform, getuid = process.getuid, env = process.env } = {}) {
  const root = platform !== 'win32' && typeof getuid === 'function' && getuid() === 0;
  return root && env?.IS_SANDBOX !== '1' ? BYPASS_ROOT_REASON : '';
}

const disables = (settings) => settings?.permissions?.disableBypassPermissionsMode === 'disable';

const unavailable = (source, path = '') => ({
  available: false,
  source,
  reason: `Bypass is turned off by ${SOURCE_TEXT[source] || 'your Claude Code settings'} (${SETTING}${path ? ` in ${path}` : ''}).`,
});

/**
 * The verdict from what was read. `resolved` is the SDK's ResolvedSettings for
 * the tab's project; `accountSettings` the parsed user settings of a named
 * Claude account that has a file of its own (the SDK resolves the user tier of
 * the account the server runs under, never another one's).
 * @returns {{ available: boolean, reason: string, source: string }}
 */
export function bypassVerdict({ root = '', resolved = null, accountSettings = null, accountPath = '' } = {}) {
  if (root) return { available: false, source: 'root', reason: root };
  // Highest tier first: the one that says it is the one worth naming.
  const sources = Array.isArray(resolved?.sources) ? [...resolved.sources].reverse() : [];
  for (const s of sources) {
    if (disables(s?.settings)) return unavailable(typeof s.source === 'string' ? s.source : 'user', typeof s.path === 'string' ? s.path : '');
  }
  if (disables(resolved?.effective)) return unavailable('user');
  if (disables(accountSettings)) return unavailable('user', accountPath);
  return { available: true, source: '', reason: '' };
}

// A named account's own user settings, read as the regular file it has to be
// (it may be a link into the user's dotfiles: the file behind it is read).
function readAccountSettings(path) {
  if (!path || !existsSync(path)) return null;
  const target = realpathSync(path);
  return JSON.parse(readConfinedFile(dirname(target), target, { maxBytes: MAX_SETTINGS_BYTES, encoding: 'utf-8' }));
}

/**
 * @param o.resolveSettings the SDK's resolveSettings (absent on an SDK without it)
 * @param o.project         a registered project directory, or '' for none
 * @param o.home            the user's home directory
 * @param o.accountHome     the config directory of the tab's Claude account ('' = the default one)
 * @returns {Promise<{ available: boolean, reason: string, source: string, checked: boolean }>}
 *          `checked: false`: the settings could not be read, so nothing is claimed
 *          (the option stays offered; Claude Code still refuses what it must).
 */
export async function resolveBypassPolicy({ resolveSettings, project = '', home = '', accountHome = '', root = rootBypassBlock() } = {}) {
  if (root) return { ...bypassVerdict({ root }), checked: true };
  const file = accountHome ? userSettingsFile({ home, accountHome }) : null;
  // The account reads a user settings file that is not the default account's:
  // the SDK's user tier would be the wrong one, so it is left out and that file
  // is read here.
  const ownFile = !!file && !file.shared;
  let resolved = null;
  let accountSettings = null;
  let checked = true;
  if (typeof resolveSettings === 'function') {
    const settingSources = ownFile ? (project ? ['project', 'local'] : []) : (project ? null : ['user']);
    try { resolved = await resolveSettings({ ...(project ? { cwd: project } : {}), ...(settingSources ? { settingSources } : {}) }); }
    catch { checked = false; }
  } else checked = false;
  if (ownFile) {
    try { accountSettings = readAccountSettings(file.path); }
    catch { checked = false; }
  }
  return { ...bypassVerdict({ resolved, accountSettings, accountPath: ownFile ? file.path : '' }), checked };
}

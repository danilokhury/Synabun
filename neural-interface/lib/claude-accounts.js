// ═══════════════════════════════════════════
// SynaBun — Claude account profiles (per-account CLAUDE_CONFIG_DIR)
// ═══════════════════════════════════════════
//
// Mirrors the Codex multi-account model: every non-default account owns a
// config directory under ~/.claude-accounts/<id>. Claude Code stores settings,
// session history, plugins AND credentials under CLAUDE_CONFIG_DIR (on macOS
// the Keychain entry is keyed to that directory too), so pointing a spawn at a
// different directory switches the logged-in account. Shared, non-identity
// resources are symlinked back to ~/.claude so skills/commands/settings stay in
// sync; identity-bearing files stay isolated.
//
// The `default` account is the ambient ~/.claude and never gets an env override.

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_ACCOUNT_ID = 'default';
// `rules` carries SynaBun's rules file (rules/synabun.md) to accounts created
// from now on; accounts that already have their own `rules` directory get the
// file written into it by lib/rulesets/installer.js.
export const SHARED_LINKS = ['settings.json', 'CLAUDE.md', 'rules', 'commands', 'agents', 'skills', 'plugins', 'keybindings.json'];
export const ISOLATED_ITEMS = ['.credentials.json', '.claude.json', 'projects', 'todos', 'history.jsonl', 'statsig', 'shell-snapshots', 'plans'];
const CLAUDE_JSON_WHITELIST = ['mcpServers', 'theme', 'editorMode', 'preferredNotifChannel', 'autoUpdates', 'verbose'];

export class ClaudeAccountError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ClaudeAccountError';
    this.code = code;
    this.status = status;
  }
}

function readJson(path, fallback = null) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}
function sanitizeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 48);
}
function sanitizeLabel(value, fallback = 'Claude account') {
  const label = String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80);
  return label || fallback;
}

/** Read the OAuth identity Claude Code records after login. */
export function readClaudeIdentity(configDir) {
  if (!configDir) return null;
  const data = readJson(resolve(configDir, '.claude.json'), null);
  const account = data?.oauthAccount;
  if (!account || typeof account !== 'object') return null;
  return {
    email: account.emailAddress || account.email || null,
    organization: account.organizationName || null,
    accountUuid: account.accountUuid || null,
  };
}

export function createClaudeAccounts({
  dataHome,
  homeDir = homedir(),
  accountsRoot = null,
  log = () => {},
  now = Date.now,
  pollIntervalMs = 2000,
} = {}) {
  if (!dataHome) throw new Error('createClaudeAccounts requires dataHome');
  const registryPath = resolve(dataHome, 'data', 'claude-accounts.json');
  const defaultHome = resolve(homeDir, '.claude');
  const root = accountsRoot || resolve(homeDir, '.claude-accounts');

  function defaultAccount() {
    const identity = readClaudeIdentity(defaultHome);
    return { id: DEFAULT_ACCOUNT_ID, label: 'Default', email: identity?.email || null, organization: identity?.organization || null, home: defaultHome, builtin: true, createdAt: null };
  }
  function load() {
    const data = readJson(registryPath, null);
    const accounts = Array.isArray(data?.accounts) ? data.accounts.filter((row) => row?.id && row.id !== DEFAULT_ACCOUNT_ID) : [];
    return { accounts, defaultId: DEFAULT_ACCOUNT_ID };
  }
  function save(data) { writeJsonAtomic(registryPath, { accounts: data.accounts, defaultId: DEFAULT_ACCOUNT_ID, updatedAt: new Date(now()).toISOString() }); }

  function list() {
    const data = load();
    const rows = data.accounts.map((row) => {
      const identity = readClaudeIdentity(row.home);
      return { ...row, email: identity?.email || row.email || null, organization: identity?.organization || row.organization || null, builtin: false, loggedIn: !!identity?.email };
    });
    const base = defaultAccount();
    return [{ ...base, loggedIn: !!base.email }, ...rows];
  }
  function listForClient() {
    return list().map(({ id, label, email, organization, builtin, loggedIn, createdAt }) => ({ id, label, email, organization, isDefault: id === DEFAULT_ACCOUNT_ID, builtin, loggedIn, createdAt }));
  }
  function get(id) {
    const wanted = sanitizeId(id) || DEFAULT_ACCOUNT_ID;
    if (wanted === DEFAULT_ACCOUNT_ID) return { ...defaultAccount(), loggedIn: !!defaultAccount().email };
    return list().find((row) => row.id === wanted) || null;
  }
  const find = get;
  function homeFor(id) {
    const account = get(id);
    if (!account || account.id === DEFAULT_ACCOUNT_ID) return null;
    return account.home;
  }
  function envFor(id) {
    const home = homeFor(id);
    return home ? { CLAUDE_CONFIG_DIR: home } : {};
  }

  function linkShared(home) {
    const linked = [];
    for (const name of SHARED_LINKS) {
      const source = resolve(defaultHome, name);
      const target = resolve(home, name);
      if (!existsSync(source)) continue;
      try {
        if (lstatSync(target)) continue;
      } catch {}
      try {
        symlinkSync(source, target, process.platform === 'win32' ? 'junction' : undefined);
        linked.push(name);
      } catch (error) {
        log('claude-accounts', `link ${name} failed: ${error?.message || error}`);
      }
    }
    return linked;
  }
  function seedClaudeJson(home) {
    const target = resolve(home, '.claude.json');
    if (existsSync(target)) return false;
    const source = readJson(resolve(defaultHome, '.claude.json'), {}) || {};
    const seeded = { hasCompletedOnboarding: true };
    for (const key of CLAUDE_JSON_WHITELIST) if (source[key] !== undefined) seeded[key] = source[key];
    writeJsonAtomic(target, seeded);
    return true;
  }
  function seedHome(id) {
    const account = get(id);
    if (!account || account.id === DEFAULT_ACCOUNT_ID) throw new ClaudeAccountError('ACCOUNT_NOT_FOUND', `Claude account not found: ${id}`, 404);
    mkdirSync(resolve(account.home, 'projects'), { recursive: true });
    mkdirSync(resolve(account.home, 'todos'), { recursive: true });
    const linked = linkShared(account.home);
    const seededJson = seedClaudeJson(account.home);
    return { home: account.home, linked, seededJson };
  }

  function create({ label } = {}) {
    const data = load();
    const id = `cacct-${now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
    const account = { id, label: sanitizeLabel(label, `Claude ${data.accounts.length + 2}`), email: null, organization: null, home: resolve(root, id), createdAt: new Date(now()).toISOString() };
    data.accounts.push(account);
    save(data);
    const seeded = seedHome(id);
    return { ...account, isDefault: false, builtin: false, loggedIn: false, seeded };
  }
  function rename(id, label) {
    const wanted = sanitizeId(id);
    if (wanted === DEFAULT_ACCOUNT_ID) throw new ClaudeAccountError('DEFAULT_ACCOUNT', 'The default account cannot be renamed here', 409);
    const data = load();
    const account = data.accounts.find((row) => row.id === wanted);
    if (!account) throw new ClaudeAccountError('ACCOUNT_NOT_FOUND', `Claude account not found: ${id}`, 404);
    account.label = sanitizeLabel(label, account.label);
    save(data);
    return get(wanted);
  }
  function remove(id, { inUse = () => null } = {}) {
    const wanted = sanitizeId(id);
    if (wanted === DEFAULT_ACCOUNT_ID) throw new ClaudeAccountError('DEFAULT_ACCOUNT', 'The default account cannot be removed', 409);
    const data = load();
    const index = data.accounts.findIndex((row) => row.id === wanted);
    if (index === -1) throw new ClaudeAccountError('ACCOUNT_NOT_FOUND', `Claude account not found: ${id}`, 404);
    const reason = inUse(wanted);
    if (reason) throw new ClaudeAccountError('ACCOUNT_IN_USE', typeof reason === 'string' ? reason : `Claude account ${wanted} is in use`, 409);
    const [account] = data.accounts.splice(index, 1);
    save(data);
    if (account.home && resolve(account.home).startsWith(resolve(root))) {
      try { rmSync(account.home, { recursive: true, force: true }); } catch (error) { log('claude-accounts', `remove home failed: ${error?.message || error}`); }
    }
    return { ok: true, removed: account.id };
  }
  function recordIdentity(id) {
    const wanted = sanitizeId(id);
    const data = load();
    const account = data.accounts.find((row) => row.id === wanted);
    if (!account) return null;
    const identity = readClaudeIdentity(account.home);
    if (!identity?.email) return null;
    if (account.email !== identity.email || account.organization !== identity.organization) {
      account.email = identity.email;
      account.organization = identity.organization;
      if (!account.labelCustom && /^Claude \d+$/.test(account.label || '')) account.label = identity.email;
      save(data);
    }
    return { ...account, ...identity };
  }
  /** Poll for the OAuth identity to appear after a login terminal was opened. */
  function watchLogin(id, { onLogin = () => {}, onTimeout = () => {}, timeoutMs = 10 * 60_000 } = {}) {
    const started = now();
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      const identity = recordIdentity(id);
      if (identity) { stop(); try { onLogin(identity); } catch {} return; }
      if (now() - started > timeoutMs) { stop(); try { onTimeout(); } catch {} }
    }, pollIntervalMs);
    timer.unref?.();
    function stop() { if (stopped) return; stopped = true; clearInterval(timer); }
    return stop;
  }
  /** What the login terminal should run for an account. */
  function loginCommand(id) {
    const home = homeFor(id);
    if (!home) throw new ClaudeAccountError('DEFAULT_ACCOUNT', 'Log in to the default account from any Claude Code terminal', 409);
    return { env: { CLAUDE_CONFIG_DIR: home }, command: 'claude', args: [], cwd: home };
  }

  return {
    registryPath, defaultHome, root,
    list, listForClient, get, find, homeFor, envFor, create, rename, remove, seedHome, recordIdentity, watchLogin, loginCommand,
    readIdentity: (id) => readClaudeIdentity(id === DEFAULT_ACCOUNT_ID ? defaultHome : homeFor(id)),
  };
}

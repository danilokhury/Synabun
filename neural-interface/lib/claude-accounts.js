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
// Default follows CLAUDE_CONFIG_DIR when set, otherwise ~/.claude.
//
// One account, two credentials, one mode (docs/claude-sidepanel.md → Claude
// accounts). Each account can hold a Claude subscription login (Claude Code's
// own OAuth, inside that account's config directory) and an API key (SynaBun's
// `.synabun-api-key` file in the same directory). Its mode, "subscription" or
// "apiKey", decides what its sessions use; when only one credential exists,
// that one is the mode. describe() is the one reading of an account's state:
// the account list, the panel's sign-in screens, its composer picker, the
// Assistant's brain picker, the catalog and worker dispatch all show it.
// launchFor() is the one place a Claude Code process gets its credential.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readClaudeProfileApiKey, saveClaudeProfileApiKey, clearClaudeProfileApiKey } from './claude-profile-api-key.js';

export const DEFAULT_ACCOUNT_ID = 'default';
// `rules` carries SynaBun's rules file (rules/synabun.md) to accounts created
// from now on; accounts that already have their own `rules` directory get the
// file written into it by lib/rulesets/installer.js.
export const SHARED_LINKS = ['settings.json', 'CLAUDE.md', 'rules', 'commands', 'agents', 'skills', 'plugins', 'keybindings.json'];
export const ISOLATED_ITEMS = ['.credentials.json', '.claude.json', 'projects', 'todos', 'history.jsonl', 'statsig', 'shell-snapshots', 'plans'];
const CLAUDE_JSON_WHITELIST = ['mcpServers', 'theme', 'editorMode', 'preferredNotifChannel', 'autoUpdates', 'verbose'];

export const CLAUDE_AUTH_MODES = Object.freeze(['subscription', 'apiKey']);
// Everything inherited from the server's own environment that would decide a
// Claude Code process's credential or backend. Removed from every account
// launch: the account and its mode decide, never what SynaBun was started with.
export const CLAUDE_CREDENTIAL_ENV = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
]);
// A subscription check older than this is asked again when the list is read.
const STATUS_MAX_AGE_MS = 5 * 60_000;

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
const text = (value, max = 200) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/**
 * Claude Code's global config file (`.claude.json`, where `oauthAccount` lives)
 * for a config directory. An explicit CLAUDE_CONFIG_DIR keeps it inside that
 * directory; the ambient default keeps it in the home directory, next to
 * ~/.claude rather than inside it (the CLI's own layout).
 */
export function claudeGlobalConfigFile(configDir, { ambient = false, homeDir = homedir() } = {}) {
  return ambient ? resolve(homeDir, '.claude.json') : resolve(configDir, '.claude.json');
}

/** Read the OAuth identity Claude Code records after login. */
export function readClaudeIdentity(configDir, file = null) {
  if (!configDir && !file) return null;
  const data = readJson(file || resolve(configDir, '.claude.json'), null);
  const account = data?.oauthAccount;
  if (!account || typeof account !== 'object') return null;
  return {
    email: account.emailAddress || account.email || null,
    organization: account.organizationName || null,
    accountUuid: account.accountUuid || null,
  };
}

/** What an API key is shown as: never the key, never its prefix. */
export function apiKeyHint(key) {
  return typeof key === 'string' && key.length >= 8 ? `…${key.slice(-4)}` : null;
}

/**
 * The mode an account's sessions use, from its stored choice and the
 * credentials it holds. `subscription` is true (signed in), false (confirmed
 * signed out) or null (not known yet). A stored key with an unconfirmed
 * subscription keeps the key unless the user chose the subscription; both
 * present with no choice keeps the key, which is what SynaBun did before modes.
 */
export function resolveClaudeAuth({ preferredMode = null, hasKey = false, subscription = null } = {}) {
  const preferred = CLAUDE_AUTH_MODES.includes(preferredMode) ? preferredMode : null;
  let mode = null;
  if (hasKey && subscription === true) mode = preferred || 'apiKey';
  else if (hasKey) mode = preferred === 'subscription' && subscription !== false ? 'subscription' : 'apiKey';
  else if (subscription !== false) mode = 'subscription';
  const signedIn = mode === 'apiKey' ? true : mode === 'subscription' ? subscription : false;
  return { mode, signedIn, switchable: hasKey && subscription === true };
}

/** A launch environment applied to a base: inherited credentials out, the account's in. */
export function applyClaudeLaunchEnv(base, launch) {
  const env = { ...(base || {}) };
  for (const key of launch?.unset || CLAUDE_CREDENTIAL_ENV) delete env[key];
  return Object.assign(env, launch?.env || {});
}

export function createClaudeAccounts({
  dataHome,
  homeDir = homedir(),
  env = process.env,
  accountsRoot = null,
  log = () => {},
  now = Date.now,
  pollIntervalMs = 2000,
  // async (id) => Claude Code's own `auth status --json` for that account
  // ({ loggedIn, email, orgName, subscriptionType, authMethod }), or null.
  readNativeStatus = null,
  statusTimeoutMs = 20_000,
} = {}) {
  if (!dataHome) throw new Error('createClaudeAccounts requires dataHome');
  const registryPath = resolve(dataHome, 'data', 'claude-accounts.json');
  const configDir = env.CLAUDE_CONFIG_DIR;
  const defaultHome = resolve(configDir || resolve(homeDir, '.claude'));
  const defaultConfigFile = claudeGlobalConfigFile(defaultHome, { ambient: !configDir, homeDir });
  const root = accountsRoot || resolve(homeDir, '.claude-accounts');
  // id → the last answer of Claude Code's own status check (never a credential).
  const nativeStatus = new Map();
  const refreshing = new Map();
  const listeners = new Set();
  let nativeReader = typeof readNativeStatus === 'function' ? readNativeStatus : null;

  function configFileOf(id, home) { return id === DEFAULT_ACCOUNT_ID ? defaultConfigFile : resolve(home, '.claude.json'); }
  function defaultAccount() {
    const identity = readClaudeIdentity(defaultHome, defaultConfigFile);
    return { id: DEFAULT_ACCOUNT_ID, label: 'Default', email: identity?.email || null, organization: identity?.organization || null, home: defaultHome, builtin: true, createdAt: null };
  }
  function load() {
    const data = readJson(registryPath, null);
    const accounts = Array.isArray(data?.accounts) ? data.accounts.filter((row) => row?.id && row.id !== DEFAULT_ACCOUNT_ID) : [];
    const defaults = data?.default && typeof data.default === 'object' ? data.default : {};
    return { accounts, defaultId: DEFAULT_ACCOUNT_ID, default: defaults };
  }
  function save(data) {
    writeJsonAtomic(registryPath, { accounts: data.accounts, defaultId: DEFAULT_ACCOUNT_ID, default: data.default || {}, updatedAt: new Date(now()).toISOString() });
  }
  function storedMode(data, id) {
    const mode = id === DEFAULT_ACCOUNT_ID ? data.default?.authMode : data.accounts.find((row) => row.id === id)?.authMode;
    return CLAUDE_AUTH_MODES.includes(mode) ? mode : null;
  }

  // Terminal login needs only registry metadata, without reading CLI identity files.
  function profileFor(id) {
    if (id === DEFAULT_ACCOUNT_ID) return { id, home: defaultHome };
    return load().accounts.find(row => row.id === id) || null;
  }
  function keyHome(id) {
    const row = profileFor(id);
    if (!row || row.id !== id) throw new ClaudeAccountError('ACCOUNT_NOT_FOUND', 'Unknown Claude account', 404);
    return row.home;
  }
  function readApiKey(id) { return readClaudeProfileApiKey(keyHome(id)); }
  function saveApiKey(id, key) {
    saveClaudeProfileApiKey(keyHome(id), key);
    // A key just pasted is what the user wants this account to use.
    writeMode(id, 'apiKey');
    emit(id);
  }
  function clearApiKey(id) {
    clearClaudeProfileApiKey(keyHome(id));
    const data = load();
    if (storedMode(data, id) === 'apiKey') writeMode(id, null, data);
    emit(id);
  }
  // The key itself only for a launch; everything else sees whether one is there.
  function keyState(id) {
    try {
      const key = readApiKey(id);
      return key ? { present: true, hint: apiKeyHint(key), error: null, key } : { present: false, hint: null, error: null, key: null };
    } catch (error) {
      if (error?.code === 'ACCOUNT_NOT_FOUND') throw error;
      return { present: false, hint: null, error: 'unreadable', key: null };
    }
  }
  function fileChangedSince(file, at) {
    try { return statSync(file).mtimeMs > at; } catch { return false; }
  }
  function subscriptionOf(id, home) {
    const file = configFileOf(id, home);
    const status = nativeStatus.get(id);
    // Claude Code rewrites its global config when it signs in or out, so a file
    // newer than the last check outranks that check until it is asked again.
    if (status && !fileChangedSince(file, status.wall)) {
      return {
        signedIn: status.loggedIn, email: status.email, organization: status.organization,
        plan: status.plan, method: status.method, checkedAt: status.checkedAt, checked: true,
      };
    }
    // Its own record of an OAuth login, if any: a login is likely, its absence proves nothing.
    const identity = readClaudeIdentity(home, file);
    const signedIn = identity?.email ? true : status?.loggedIn === false ? false : null;
    return {
      signedIn, email: identity?.email || null, organization: identity?.organization || null,
      plan: identity?.email && status?.loggedIn ? status.plan : null, method: identity?.email ? 'claude.ai' : null,
      checkedAt: status?.checkedAt || null, checked: false,
    };
  }
  function describeProfile(profile, data = load()) {
    const id = profile.id;
    const isDefault = id === DEFAULT_ACCOUNT_ID;
    const base = isDefault ? defaultAccount() : profile;
    const key = keyState(id);
    const subscription = subscriptionOf(id, base.home);
    const preferredMode = storedMode(data, id);
    const auth = resolveClaudeAuth({ preferredMode, hasKey: key.present, subscription: subscription.signedIn });
    const identity = auth.mode === 'apiKey' ? key.hint : auth.mode === 'subscription' ? (subscription.email || subscription.organization) : null;
    const row = {
      id, provider: 'claude', label: isDefault ? 'Default' : sanitizeLabel(base.label, 'Claude account'), home: base.home,
      isDefault, builtin: isDefault, createdAt: base.createdAt || null,
      mode: auth.mode, preferredMode, signedIn: auth.signedIn, switchable: auth.switchable, identity: identity || null,
      subscription: { signedIn: subscription.signedIn, email: subscription.email, organization: subscription.organization, plan: subscription.plan, method: subscription.method, checked: subscription.checked, checkedAt: subscription.checkedAt },
      apiKey: { present: key.present, hint: key.hint, error: key.error },
      // The fields older panels read, from the same state.
      loggedIn: auth.signedIn,
      email: auth.mode === 'subscription' ? subscription.email : null,
      organization: auth.mode === 'subscription' ? subscription.organization : null,
      authMethod: auth.mode === 'apiKey' ? 'apiKey' : auth.mode === 'subscription' && subscription.signedIn ? (subscription.method || 'claude.ai') : null,
      // Kept in the registry for older readers; the live record wins.
      registryEmail: isDefault ? null : profile.email || null,
    };
    return { row, key: key.key };
  }
  function describe(id) {
    const wanted = sanitizeId(id) || DEFAULT_ACCOUNT_ID;
    const data = load();
    const profile = wanted === DEFAULT_ACCOUNT_ID ? { id: DEFAULT_ACCOUNT_ID, home: defaultHome } : data.accounts.find((row) => row.id === wanted);
    if (!profile) return null;
    return describeProfile(profile, data).row;
  }
  function list() {
    const data = load();
    return [{ id: DEFAULT_ACCOUNT_ID, home: defaultHome }, ...data.accounts].map((profile) => describeProfile(profile, data).row);
  }
  function clientRow(row) {
    const { home, registryEmail, ...rest } = row;
    return rest;
  }
  function listForClient() { return list().map(clientRow); }
  function describeForClient(id) { const row = describe(id); return row ? clientRow(row) : null; }
  function get(id) { return describe(id); }
  const find = get;
  function homeFor(id) {
    const wanted = sanitizeId(id);
    if (!wanted || wanted === DEFAULT_ACCOUNT_ID) return null;
    return profileFor(wanted)?.home || null;
  }
  function envFor(id) {
    // Native auth strips ambient config/auth variables before applying this
    // account's environment. Restore Default's explicit config location too.
    if (id === DEFAULT_ACCOUNT_ID && configDir) return { CLAUDE_CONFIG_DIR: defaultHome };
    const home = homeFor(id);
    return home ? { CLAUDE_CONFIG_DIR: home } : {};
  }

  /**
   * How a Claude Code process runs under an account: `unset` the inherited
   * credential variables, then add `env` (its config directory and, in API-key
   * mode, its key). `env` can carry a secret: pass it to the spawn only, never
   * to a log, a response, an event or a file.
   */
  function launchFor(id) {
    const wanted = typeof id === 'string' && id ? id : DEFAULT_ACCOUNT_ID;
    const data = load();
    const profile = wanted === DEFAULT_ACCOUNT_ID ? { id: DEFAULT_ACCOUNT_ID, home: defaultHome } : data.accounts.find((row) => row.id === wanted);
    if (!profile || !profile.home) {
      return { ok: false, accountId: wanted, code: 'account_unavailable', message: 'That Claude account is no longer set up in SynaBun.' };
    }
    const { row, key } = describeProfile(profile, data);
    const launchEnv = {};
    if (wanted !== DEFAULT_ACCOUNT_ID) launchEnv.CLAUDE_CONFIG_DIR = profile.home;
    else if (configDir) launchEnv.CLAUDE_CONFIG_DIR = defaultHome;
    if (row.mode === 'apiKey' && key) launchEnv.ANTHROPIC_API_KEY = key;
    return {
      ok: true, accountId: wanted, label: row.label, mode: row.mode, signedIn: row.signedIn, identity: row.identity,
      env: launchEnv, unset: [...CLAUDE_CREDENTIAL_ENV],
    };
  }

  /** Why an account cannot run a session now ('' when it can, or when that is not known yet). */
  function unusableReason(id) {
    const row = describe(id);
    if (!row) return 'That Claude account is no longer set up in SynaBun.';
    if (row.apiKey.error && row.mode !== 'subscription') return `The API key saved for ${row.label} cannot be read. Save it again.`;
    if (row.signedIn === false) return `${row.label} is signed out. Sign in with Claude or add an API key to it first.`;
    return '';
  }

  function writeMode(id, mode, data = load()) {
    if (id === DEFAULT_ACCOUNT_ID) {
      data.default = { ...(data.default || {}) };
      if (mode) data.default.authMode = mode; else delete data.default.authMode;
    } else {
      const account = data.accounts.find((row) => row.id === id);
      if (!account) throw new ClaudeAccountError('ACCOUNT_NOT_FOUND', `Claude account not found: ${id}`, 404);
      if (mode) account.authMode = mode; else delete account.authMode;
    }
    save(data);
  }
  /** Choose what an account's sessions use. The chosen credential must be there. */
  function setMode(id, mode) {
    const wanted = sanitizeId(id) || DEFAULT_ACCOUNT_ID;
    if (!CLAUDE_AUTH_MODES.includes(mode)) throw new ClaudeAccountError('MODE_INVALID', 'Choose "subscription" or "apiKey".', 400);
    const row = describe(wanted);
    if (!row) throw new ClaudeAccountError('ACCOUNT_NOT_FOUND', `Claude account not found: ${id}`, 404);
    if (mode === 'apiKey' && !row.apiKey.present) throw new ClaudeAccountError('MODE_NEEDS_CREDENTIAL', `Add an API key to ${row.label} first.`, 409);
    if (mode === 'subscription' && row.subscription.signedIn === false) throw new ClaudeAccountError('MODE_NEEDS_CREDENTIAL', `Sign in to ${row.label} with Claude first.`, 409);
    writeMode(wanted, mode);
    emit(wanted);
    return describe(wanted);
  }

  /** Remember what Claude Code said about an account's own login. */
  function noteNativeStatus(id, status) {
    if (!status || typeof status.loggedIn !== 'boolean') return;
    nativeStatus.set(id, {
      loggedIn: status.loggedIn,
      email: status.loggedIn ? text(status.email) : null,
      organization: status.loggedIn ? text(status.orgName ?? status.organization) : null,
      plan: status.loggedIn ? text(status.subscriptionType ?? status.plan, 40) : null,
      method: status.loggedIn ? text(status.authMethod ?? status.method, 40) : null,
      checkedAt: now(),
      // Compared with the config file's modification time: the clock files use.
      wall: Date.now(),
    });
  }
  function forgetNativeStatus(id) { nativeStatus.delete(id); }
  function setNativeStatusReader(reader) { nativeReader = typeof reader === 'function' ? reader : null; }
  function signature(row) { return row ? JSON.stringify([row.label, row.mode, row.signedIn, row.identity, row.subscription.signedIn, row.subscription.email, row.subscription.plan, row.apiKey.present, row.apiKey.hint, row.preferredMode]) : ''; }
  function checkOne(id) {
    if (refreshing.has(id)) return refreshing.get(id);
    const job = (async () => {
      let timer;
      try {
        const status = await Promise.race([
          Promise.resolve().then(() => nativeReader(id)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), statusTimeoutMs); timer.unref?.(); }),
        ]);
        if (status && typeof status.loggedIn === 'boolean' && profileFor(id)) noteNativeStatus(id, status);
      } catch (error) {
        log('claude-accounts', `status check failed for ${id}: ${String(error?.message || error).slice(0, 120)}`);
      } finally { clearTimeout(timer); refreshing.delete(id); }
    })();
    refreshing.set(id, job);
    return job;
  }
  /**
   * Ask Claude Code for the subscription state of these accounts (all by
   * default): `force` asks again, otherwise only an answer older than
   * `maxAgeMs` or none at all. Listeners hear about every account that changed.
   */
  async function refreshStatus(ids = null, { force = false, maxAgeMs = STATUS_MAX_AGE_MS } = {}) {
    if (!nativeReader) return list();
    const wanted = (Array.isArray(ids) ? ids : [DEFAULT_ACCOUNT_ID, ...load().accounts.map((row) => row.id)]).filter((id) => profileFor(id));
    const before = new Map(wanted.map((id) => [id, signature(describe(id))]));
    await Promise.all(wanted.map((id) => {
      const known = nativeStatus.get(id);
      if (!force && known && now() - known.checkedAt < maxAgeMs && !stale(id, maxAgeMs)) return null;
      return checkOne(id);
    }));
    for (const id of wanted) if (before.get(id) !== signature(describe(id))) emit(id);
    return list();
  }
  function stale(id, maxAgeMs = STATUS_MAX_AGE_MS) {
    const known = nativeStatus.get(id);
    if (!known || now() - known.checkedAt >= maxAgeMs) return true;
    const profile = profileFor(id);
    return !!profile && fileChangedSince(configFileOf(id, profile.home), known.wall);
  }

  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  function emit(accountId, extra = {}) {
    for (const listener of [...listeners]) { try { listener({ accountId, ...extra }); } catch {} }
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
    // Only shared preferences from Default's global config; never its login.
    const source = readJson(defaultConfigFile, {}) || {};
    const seeded = { hasCompletedOnboarding: true };
    for (const key of CLAUDE_JSON_WHITELIST) if (source[key] !== undefined) seeded[key] = source[key];
    writeJsonAtomic(target, seeded);
    return true;
  }
  function seedHome(id) {
    const wanted = sanitizeId(id);
    const account = wanted && wanted !== DEFAULT_ACCOUNT_ID ? profileFor(wanted) : null;
    if (!account) throw new ClaudeAccountError('ACCOUNT_NOT_FOUND', `Claude account not found: ${id}`, 404);
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
    if (label && String(label).trim()) account.labelCustom = true;
    data.accounts.push(account);
    save(data);
    const seeded = seedHome(id);
    // A directory made a moment ago holds no login: nothing to ask Claude Code.
    noteNativeStatus(id, { loggedIn: false });
    emit(id, { created: true });
    return { ...describe(id), seeded };
  }
  function rename(id, label) {
    const wanted = sanitizeId(id);
    if (wanted === DEFAULT_ACCOUNT_ID) throw new ClaudeAccountError('DEFAULT_ACCOUNT', 'The default account cannot be renamed here', 409);
    const data = load();
    const account = data.accounts.find((row) => row.id === wanted);
    if (!account) throw new ClaudeAccountError('ACCOUNT_NOT_FOUND', `Claude account not found: ${id}`, 404);
    account.label = sanitizeLabel(label, account.label);
    account.labelCustom = true;
    save(data);
    emit(wanted);
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
    nativeStatus.delete(wanted);
    if (account.home && resolve(account.home).startsWith(resolve(root))) {
      try { rmSync(account.home, { recursive: true, force: true }); } catch (error) { log('claude-accounts', `remove home failed: ${error?.message || error}`); }
    }
    emit(wanted, { removed: true });
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
  /** A subscription sign-in just finished: it is what the account uses from now on. */
  function noteSubscriptionSignIn(id, status = null) {
    const wanted = sanitizeId(id) || DEFAULT_ACCOUNT_ID;
    if (!profileFor(wanted)) return null;
    if (status) noteNativeStatus(wanted, status);
    if (wanted !== DEFAULT_ACCOUNT_ID) recordIdentity(wanted);
    writeMode(wanted, 'subscription');
    emit(wanted);
    return describe(wanted);
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
    registryPath, defaultHome, defaultConfigFile, root,
    list, listForClient, describe, describeForClient, profileFor, readApiKey, saveApiKey, clearApiKey, get, find, homeFor, envFor,
    launchFor, unusableReason, setMode, noteNativeStatus, forgetNativeStatus, noteSubscriptionSignIn, setNativeStatusReader,
    refreshStatus, stale, subscribe,
    create, rename, remove, seedHome, recordIdentity, watchLogin, loginCommand,
    readIdentity: (id) => (id === DEFAULT_ACCOUNT_ID ? readClaudeIdentity(defaultHome, defaultConfigFile) : readClaudeIdentity(homeFor(id))),
  };
}

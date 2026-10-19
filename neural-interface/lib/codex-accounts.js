// ═══════════════════════════════════════════
// SynaBun — Codex accounts (per-account CODEX_HOME)
// ═══════════════════════════════════════════
//
// The Codex twin of lib/claude-accounts.js (docs/codex-sidepanel.md → Codex
// accounts). Default is the ambient CODEX_HOME (or ~/.codex); every added
// account owns ~/.codex-accounts/<id>, whose config.toml, prompts/ and
// AGENTS.md link back to Default's so model, MCP and tool settings stay shared,
// while auth.json, sessions/ and the state database stay its own.
//
// One account, two credentials, one mode. Each account can hold a ChatGPT
// login (Codex's own, in its CODEX_HOME: auth.json or the keyring Codex is set
// to use) and an OpenAI API key (SynaBun's `.synabun-api-key`, 0600, in the
// same folder). Codex keeps one credential per CODEX_HOME — `codex login
// --with-api-key` replaces a ChatGPT login and the reverse — so SynaBun never
// writes the key into Codex's store: it hands it to the process that runs
// under API-key mode, and the ChatGPT login next to it stays untouched.
//   - `codex exec` (the SDK: workers, loops) reads CODEX_API_KEY, which wins
//     over auth.json.
//   - `codex app-server` (panel tabs, the Assistant's brain) ignores that
//     variable: it starts with an ephemeral credential store and is signed in
//     with `account/login/start {type:'apiKey'}` over its stdin.
// describe() is the one reading of an account's state; launchFor() is the one
// place a Codex process gets its credential. A key Codex itself holds (an older
// `codex login --with-api-key`) is shown as the account's API key and used by
// Codex as it is.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { readProfileApiKey, saveProfileApiKey, clearProfileApiKey } from './claude-profile-api-key.js';
import { apiKeyHint, resolveClaudeAuth } from './claude-accounts.js';

export const CODEX_DEFAULT_ACCOUNT_ID = 'default';
export const CODEX_AUTH_MODES = Object.freeze(['subscription', 'apiKey']);
// Everything inherited from SynaBun's own environment that would decide which
// OpenAI identity a Codex process uses: keys and tokens, and the organization /
// project headers that belong to an inherited key. Removed from every account
// launch: the account and its mode decide.
export const CODEX_CREDENTIAL_ENV = Object.freeze([
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
  'OPENAI_ORGANIZATION', 'OPENAI_PROJECT',
  'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT', 'OPENAI_FEDERATION_RULE_ID',
]);
// An app-server that runs on a key SynaBun holds: nothing it is told is kept,
// and the account's own auth.json (its ChatGPT login) is not read or replaced.
export const CODEX_EPHEMERAL_STORE_ARGS = Object.freeze(['-c', 'cli_auth_credentials_store="ephemeral"']);
const SHARED_FILES = ['config.toml', 'AGENTS.md'];
const STATUS_MAX_AGE_MS = 5 * 60_000;

export class CodexAccountError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CodexAccountError';
    this.code = code;
    this.status = status;
  }
}

/** 'chatgpt' is accepted for the subscription mode (what the UI calls it). */
export function normalizeCodexMode(mode) {
  if (mode === 'chatgpt') return 'subscription';
  return CODEX_AUTH_MODES.includes(mode) ? mode : null;
}

function readJson(path, fallback = null) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}
function sanitizeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
}
function sanitizeLabel(value, fallback) {
  const label = String(value || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80);
  return label || fallback;
}
const text = (value, max = 200) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

function jwtClaims(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

/**
 * What Codex's own auth.json in a CODEX_HOME holds, without its secrets:
 * { kind: 'chatgpt', email, plan } | { kind: 'apiKey', hint } | null (no file,
 * or nothing usable in it). With a keyring store there is no file: null says
 * nothing about a login then.
 */
export function readCodexAuthRecord(home) {
  if (!home) return null;
  let data;
  try { data = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const mode = String(data.auth_mode || '').toLowerCase();
  const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : null;
  if (tokens && (tokens.id_token || tokens.access_token) && mode !== 'apikey') {
    const claims = jwtClaims(tokens.id_token) || {};
    const auth = claims['https://api.openai.com/auth'] || {};
    return { kind: 'chatgpt', email: text(claims.email), plan: text(auth.chatgpt_plan_type, 40) };
  }
  if (typeof data.OPENAI_API_KEY === 'string' && data.OPENAI_API_KEY.trim()) {
    return { kind: 'apiKey', hint: apiKeyHint(data.OPENAI_API_KEY.trim()) };
  }
  return null;
}

/** A launch's environment applied to a base: inherited credentials out, the account's in (no key). */
export function applyCodexLaunchEnv(base, launch) {
  const env = { ...(base || {}) };
  for (const key of launch?.unset || CODEX_CREDENTIAL_ENV) delete env[key];
  return Object.assign(env, launch?.env || {});
}
/** What `codex exec` (the SDK) gets on top: in API-key mode, the key SynaBun holds. Spawn-only. */
export function codexExecEnv(launch) {
  return { ...(launch?.env || {}), ...(launch?.apiKey ? { CODEX_API_KEY: launch.apiKey } : {}) };
}
/** The `-c` overrides an app-server of the account starts with (before the subcommand). */
export function codexAppServerArgs(launch) {
  return launch?.apiKey ? [...CODEX_EPHEMERAL_STORE_ARGS] : [];
}

export function createCodexAccounts({
  dataHome,
  homeDir = homedir(),
  env = process.env,
  accountsRoot = null,
  log = () => {},
  now = Date.now,
  // async (id) => the `account/read` answer of an app-server run under that
  // account's own store ({ account: { type, email, planType } | null }), or null.
  readNativeStatus = null,
  statusTimeoutMs = 20_000,
  // Called before a new account links Default's config.toml (server.js repairs it there).
  prepareDefaultConfig = () => {},
} = {}) {
  if (!dataHome) throw new Error('createCodexAccounts requires dataHome');
  const registryPath = resolve(dataHome, 'data', 'codex-accounts.json');
  const defaultHome = resolve(env.CODEX_HOME || resolve(homeDir, '.codex'));
  const root = resolve(accountsRoot || resolve(homeDir, '.codex-accounts'));
  const nativeStatus = new Map();
  const refreshing = new Map();
  const listeners = new Set();
  let nativeReader = typeof readNativeStatus === 'function' ? readNativeStatus : null;

  // The registry keeps Default's row in the list (older readers expect it), always at Default's home.
  function load() {
    const data = readJson(registryPath, null);
    const rows = Array.isArray(data?.accounts) ? data.accounts.filter((row) => row && typeof row.id === 'string' && row.id) : [];
    let defaults = rows.find((row) => row.id === CODEX_DEFAULT_ACCOUNT_ID);
    const others = rows.filter((row) => row.id !== CODEX_DEFAULT_ACCOUNT_ID);
    defaults = { email: '', planType: '', type: 'chatgpt', createdAt: null, ...(defaults || {}), id: CODEX_DEFAULT_ACCOUNT_ID, label: 'Default', home: defaultHome };
    return { accounts: [defaults, ...others], defaultId: CODEX_DEFAULT_ACCOUNT_ID };
  }
  function save(data) {
    writeJsonAtomic(registryPath, { accounts: data.accounts, defaultId: CODEX_DEFAULT_ACCOUNT_ID, updatedAt: new Date(now()).toISOString() });
  }
  function rowOf(data, id) { return data.accounts.find((row) => row.id === id) || null; }
  function storedMode(data, id) { return normalizeCodexMode(rowOf(data, id)?.authMode); }

  /** The registry row of an account (with its home), or null. Never a fallback to another account. */
  function profileFor(id) {
    const wanted = typeof id === 'string' && id ? id : CODEX_DEFAULT_ACCOUNT_ID;
    return rowOf(load(), wanted);
  }
  function keyHome(id) {
    const row = profileFor(id);
    if (!row || row.id !== id) throw new CodexAccountError('ACCOUNT_NOT_FOUND', 'Unknown Codex account', 404);
    return row.home;
  }
  function readApiKey(id) { return readProfileApiKey(keyHome(id), 'codex'); }
  function keyState(id) {
    try {
      const key = readApiKey(id);
      return key ? { present: true, hint: apiKeyHint(key), error: null, key } : { present: false, hint: null, error: null, key: null };
    } catch (error) {
      if (error?.code === 'ACCOUNT_NOT_FOUND') throw error;
      return { present: false, hint: null, error: 'unreadable', key: null };
    }
  }
  function authFile(home) { return join(home, 'auth.json'); }
  function fileState(file) {
    try { return { exists: true, mtimeMs: statSync(file).mtimeMs }; } catch { return { exists: false, mtimeMs: 0 }; }
  }
  // Codex's own credential in the account's home: its ChatGPT login (subscription) or a key it holds.
  function nativeOf(id, home) {
    const file = fileState(authFile(home));
    const status = nativeStatus.get(id);
    // Codex rewrites auth.json when it signs in or out: a file newer than the last check, or one that
    // appeared or went away since, outranks that check until Codex is asked again.
    const fresh = status && file.exists === status.fileExisted && !(file.exists && file.mtimeMs > status.wall);
    if (fresh) {
      return {
        subscription: { signedIn: status.kind === 'chatgpt', email: status.email, plan: status.plan, checked: true, checkedAt: status.checkedAt },
        nativeKey: { present: status.kind === 'apiKey', hint: status.kind === 'apiKey' ? (readCodexAuthRecord(home)?.hint || null) : null },
      };
    }
    const record = readCodexAuthRecord(home);
    const signedIn = record?.kind === 'chatgpt' ? true : record?.kind === 'apiKey' ? false : status?.kind === 'none' ? false : null;
    return {
      subscription: { signedIn, email: record?.kind === 'chatgpt' ? record.email : null, plan: record?.kind === 'chatgpt' ? record.plan : null, checked: false, checkedAt: status?.checkedAt || null },
      nativeKey: { present: record?.kind === 'apiKey', hint: record?.kind === 'apiKey' ? record.hint : null },
    };
  }
  function describeProfile(profile, data = load()) {
    const id = profile.id;
    const isDefault = id === CODEX_DEFAULT_ACCOUNT_ID;
    const home = isDefault ? defaultHome : profile.home;
    const key = keyState(id);
    const native = nativeOf(id, home);
    const preferredMode = storedMode(data, id);
    const hasKey = key.present || native.nativeKey.present;
    const auth = resolveClaudeAuth({ preferredMode, hasKey, subscription: native.subscription.signedIn });
    const keySource = key.present ? 'synabun' : native.nativeKey.present ? 'codex' : null;
    const keyHint = key.present ? key.hint : native.nativeKey.hint;
    const sub = native.subscription;
    const identity = auth.mode === 'apiKey' ? keyHint : auth.mode === 'subscription' ? (sub.email || null) : null;
    const row = {
      id, provider: 'codex',
      label: isDefault ? 'Default' : sanitizeLabel(profile.label || profile.email, 'Codex account'), home,
      isDefault, builtin: isDefault, createdAt: profile.createdAt || null,
      mode: auth.mode, preferredMode, signedIn: auth.signedIn, switchable: auth.switchable, identity: identity || null,
      subscription: { signedIn: sub.signedIn, email: sub.email, plan: sub.plan, checked: sub.checked, checkedAt: sub.checkedAt },
      apiKey: { present: hasKey, hint: keyHint || null, error: key.error, source: keySource },
      // The fields older readers use (Automation Studio, the launch selectors), from the same state.
      loggedIn: auth.signedIn,
      email: auth.mode === 'subscription' ? (sub.email || '') : '',
      planType: auth.mode === 'subscription' ? (sub.plan || '') : '',
      type: auth.mode === 'apiKey' ? 'apiKey' : 'chatgpt',
      authMethod: auth.mode === 'apiKey' ? 'apiKey' : auth.mode === 'subscription' && sub.signedIn ? 'chatgpt' : null,
    };
    return { row, key: key.key };
  }
  function describe(id) {
    const wanted = sanitizeId(id) || CODEX_DEFAULT_ACCOUNT_ID;
    const data = load();
    const profile = rowOf(data, wanted);
    return profile ? describeProfile(profile, data).row : null;
  }
  function list() {
    const data = load();
    return data.accounts.map((profile) => describeProfile(profile, data).row);
  }
  function clientRow(row) {
    const { home, ...rest } = row;
    return rest;
  }
  function listForClient() { return list().map(clientRow); }
  function describeForClient(id) { const row = describe(id); return row ? clientRow(row) : null; }
  function homeFor(id) { return profileFor(sanitizeId(id) || CODEX_DEFAULT_ACCOUNT_ID)?.home || null; }

  /**
   * How a Codex process runs under an account: `unset` the inherited
   * credential variables, set `env` (its CODEX_HOME), and in API-key mode with
   * a key SynaBun holds, `apiKey` — for codexExecEnv() / codexAppServerArgs()
   * and the app-server's stdin login. `apiKey` is a secret: spawn and stdin
   * only, never a log, a response, an event or a file.
   */
  function launchFor(id) {
    const wanted = typeof id === 'string' && id ? id : CODEX_DEFAULT_ACCOUNT_ID;
    const data = load();
    const profile = rowOf(data, wanted);
    if (!profile || !profile.home) {
      return { ok: false, accountId: wanted, code: 'account_unavailable', message: 'That Codex account is no longer set up in SynaBun.' };
    }
    const { row, key } = describeProfile(profile, data);
    const apiKey = row.mode === 'apiKey' && row.apiKey.source === 'synabun' && key ? key : null;
    return {
      ok: true, accountId: wanted, label: row.label, mode: row.mode, signedIn: row.signedIn, identity: row.identity, home: row.home,
      env: { CODEX_HOME: row.home }, unset: [...CODEX_CREDENTIAL_ENV], apiKey,
      // Which credential a process started with: a change means the account's idle processes restart.
      credential: [row.mode || 'none', row.apiKey.source || '', row.apiKey.hint || '', row.subscription.email || ''].join(':'),
    };
  }

  /** Why an account cannot run now ('' when it can, or when that is not known yet). */
  function unusableReason(id) {
    const row = describe(id);
    if (!row) return 'That Codex account is no longer set up in SynaBun.';
    if (row.apiKey.error && row.mode !== 'subscription') return `The API key saved for ${row.label} cannot be read. Save it again.`;
    if (row.signedIn === false) return `${row.label} is signed out. Sign in with ChatGPT or add an API key to it first.`;
    return '';
  }

  function writeMode(id, mode, data = load()) {
    const account = rowOf(data, id);
    if (!account) throw new CodexAccountError('ACCOUNT_NOT_FOUND', `Codex account not found: ${id}`, 404);
    if (mode) account.authMode = mode; else delete account.authMode;
    save(data);
  }
  /** Choose what an account's sessions use. The chosen credential must be there. */
  function setMode(id, value) {
    const wanted = sanitizeId(id) || CODEX_DEFAULT_ACCOUNT_ID;
    const mode = normalizeCodexMode(value);
    if (!mode) throw new CodexAccountError('MODE_INVALID', 'Choose "subscription" (ChatGPT) or "apiKey".', 400);
    const row = describe(wanted);
    if (!row) throw new CodexAccountError('ACCOUNT_NOT_FOUND', `Codex account not found: ${id}`, 404);
    if (mode === 'apiKey' && !row.apiKey.present) throw new CodexAccountError('MODE_NEEDS_CREDENTIAL', `Add an API key to ${row.label} first.`, 409);
    if (mode === 'subscription' && row.subscription.signedIn === false) throw new CodexAccountError('MODE_NEEDS_CREDENTIAL', `Sign in to ${row.label} with ChatGPT first.`, 409);
    writeMode(wanted, mode);
    emit(wanted);
    return describe(wanted);
  }
  function saveApiKey(id, key) {
    saveProfileApiKey(keyHome(id), key, 'codex');
    // A key just pasted is what the user wants this account to use.
    writeMode(id, 'apiKey');
    emit(id);
  }
  function clearApiKey(id) {
    clearProfileApiKey(keyHome(id));
    const data = load();
    if (storedMode(data, id) === 'apiKey') writeMode(id, null, data);
    emit(id);
  }

  /** Remember what Codex said about the account's own store (`account/read`). */
  function noteNativeStatus(id, status) {
    if (!status || typeof status !== 'object' || !Object.hasOwn(status, 'account')) return;
    const account = status.account;
    const kind = !account ? 'none' : account.type === 'chatgpt' ? 'chatgpt' : account.type === 'apiKey' ? 'apiKey' : null;
    if (!kind) return; // A store Codex filled another way (Bedrock): the file reading stands.
    const profile = profileFor(id);
    if (!profile) return;
    const file = fileState(authFile(profile.home));
    nativeStatus.set(id, {
      kind,
      email: kind === 'chatgpt' ? text(account.email) : null,
      plan: kind === 'chatgpt' ? text(account.planType, 40) : null,
      checkedAt: now(),
      wall: Date.now(),
      fileExisted: file.exists,
    });
  }
  function forgetNativeStatus(id) { nativeStatus.delete(id); }
  function setNativeStatusReader(reader) { nativeReader = typeof reader === 'function' ? reader : null; }
  function signature(row) { return row ? JSON.stringify([row.label, row.mode, row.signedIn, row.identity, row.subscription.signedIn, row.subscription.email, row.subscription.plan, row.apiKey.present, row.apiKey.hint, row.apiKey.source, row.preferredMode]) : ''; }
  function checkOne(id) {
    if (refreshing.has(id)) return refreshing.get(id);
    const job = (async () => {
      let timer;
      try {
        const status = await Promise.race([
          Promise.resolve().then(() => nativeReader(id)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), statusTimeoutMs); timer.unref?.(); }),
        ]);
        if (status && profileFor(id)) noteNativeStatus(id, status);
      } catch (error) {
        log('codex-accounts', `status check failed for ${id}: ${String(error?.message || error).slice(0, 120)}`);
      } finally { clearTimeout(timer); refreshing.delete(id); }
    })();
    refreshing.set(id, job);
    return job;
  }
  function stale(id, maxAgeMs = STATUS_MAX_AGE_MS) {
    const known = nativeStatus.get(id);
    if (!known || now() - known.checkedAt >= maxAgeMs) return true;
    const profile = profileFor(id);
    if (!profile) return false;
    const file = fileState(authFile(profile.home));
    return file.exists !== known.fileExisted || (file.exists && file.mtimeMs > known.wall);
  }
  /** Ask Codex about these accounts' own stores (all by default); listeners hear about every change. */
  async function refreshStatus(ids = null, { force = false, maxAgeMs = STATUS_MAX_AGE_MS } = {}) {
    if (!nativeReader) return list();
    const wanted = (Array.isArray(ids) ? ids : load().accounts.map((row) => row.id)).filter((id) => profileFor(id));
    const before = new Map(wanted.map((id) => [id, signature(describe(id))]));
    await Promise.all(wanted.map((id) => (!force && !stale(id, maxAgeMs) ? null : checkOne(id))));
    for (const id of wanted) if (before.get(id) !== signature(describe(id))) emit(id);
    return list();
  }

  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  function emit(accountId, extra = {}) {
    for (const listener of [...listeners]) { try { listener({ accountId, ...extra }); } catch {} }
  }

  function linkShared(home) {
    try { prepareDefaultConfig(); } catch (error) { log('codex-accounts', `config repair failed: ${error?.message || error}`); }
    const linked = [];
    const link = (name, kind) => {
      const source = resolve(defaultHome, name);
      const target = resolve(home, name);
      try { lstatSync(target); return; } catch {}
      try {
        if (!existsSync(source)) {
          // config.toml and prompts/ are made when missing (shared from the start); AGENTS.md is not ours to create.
          if (name === 'AGENTS.md') return;
          if (kind === 'dir') mkdirSync(source, { recursive: true }); else { mkdirSync(defaultHome, { recursive: true }); writeFileSync(source, '', 'utf8'); }
        }
        symlinkSync(source, target, kind === 'dir' ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
        linked.push(name);
      } catch (error) { log('codex-accounts', `link ${name} failed: ${error?.message || error}`); }
    };
    for (const name of SHARED_FILES) link(name, 'file');
    link('prompts', 'dir');
    return linked;
  }
  function seedHome(id) {
    const account = id && id !== CODEX_DEFAULT_ACCOUNT_ID ? profileFor(id) : null;
    if (!account) throw new CodexAccountError('ACCOUNT_NOT_FOUND', `Codex account not found: ${id}`, 404);
    mkdirSync(resolve(account.home, 'sessions'), { recursive: true });
    return { home: account.home, linked: linkShared(account.home) };
  }

  function create({ label } = {}) {
    const data = load();
    const id = `acct-${now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
    const account = {
      id, label: sanitizeLabel(label, `Codex ${data.accounts.length + 1}`), email: '', planType: '', type: 'chatgpt',
      home: resolve(root, id), createdAt: new Date(now()).toISOString(),
    };
    if (label && String(label).trim()) account.labelCustom = true;
    data.accounts.push(account);
    save(data);
    const seeded = seedHome(id);
    // A folder made a moment ago holds no login: nothing to ask Codex.
    noteNativeStatus(id, { account: null });
    emit(id, { created: true });
    return { ...describe(id), seeded };
  }
  function rename(id, label) {
    const wanted = sanitizeId(id);
    if (wanted === CODEX_DEFAULT_ACCOUNT_ID) throw new CodexAccountError('DEFAULT_ACCOUNT', 'The default account cannot be renamed here', 409);
    const data = load();
    const account = rowOf(data, wanted);
    if (!account) throw new CodexAccountError('ACCOUNT_NOT_FOUND', `Codex account not found: ${id}`, 404);
    account.label = sanitizeLabel(label, account.label);
    account.labelCustom = true;
    save(data);
    emit(wanted);
    return describe(wanted);
  }
  function remove(id, { inUse = () => null } = {}) {
    const wanted = sanitizeId(id);
    if (wanted === CODEX_DEFAULT_ACCOUNT_ID) throw new CodexAccountError('DEFAULT_ACCOUNT', 'The default account cannot be removed', 409);
    const data = load();
    const index = data.accounts.findIndex((row) => row.id === wanted);
    if (index === -1) throw new CodexAccountError('ACCOUNT_NOT_FOUND', `Codex account not found: ${id}`, 404);
    const reason = inUse(wanted);
    if (reason) throw new CodexAccountError('ACCOUNT_IN_USE', typeof reason === 'string' ? reason : `Codex account ${wanted} is in use`, 409);
    const [account] = data.accounts.splice(index, 1);
    save(data);
    nativeStatus.delete(wanted);
    const home = account.home ? resolve(account.home) : '';
    // Only a folder SynaBun made for the account, under ~/.codex-accounts: never Default's home.
    if (home && home !== defaultHome && home.startsWith(`${root}${sep}`)) {
      try { rmSync(home, { recursive: true, force: true }); } catch (error) { log('codex-accounts', `remove home failed: ${error?.message || error}`); }
    }
    emit(wanted, { removed: true });
    return { ok: true, removed: account.id };
  }
  /** A ChatGPT sign-in just finished: it is what the account uses from now on, and names a still unnamed account. */
  function noteSubscriptionSignIn(id, status = null) {
    const wanted = sanitizeId(id) || CODEX_DEFAULT_ACCOUNT_ID;
    if (!profileFor(wanted)) return null;
    if (status) noteNativeStatus(wanted, status);
    const data = load();
    const account = rowOf(data, wanted);
    const row = describe(wanted);
    if (account && wanted !== CODEX_DEFAULT_ACCOUNT_ID && row?.subscription.email) {
      account.email = row.subscription.email;
      account.planType = row.subscription.plan || '';
      if (!account.labelCustom && /^(Codex \d+|New account)$/.test(account.label || '')) account.label = row.subscription.email;
    }
    if (account) account.authMode = 'subscription';
    save(data);
    emit(wanted);
    return describe(wanted);
  }

  return {
    registryPath, defaultHome, root,
    list, listForClient, describe, describeForClient, profileFor, homeFor, readApiKey, saveApiKey, clearApiKey,
    // The registry rows (id, label, home, …) for readers that only need where an account lives.
    registryRows: () => load().accounts,
    get: describe, find: describe,
    launchFor, unusableReason, setMode, noteNativeStatus, forgetNativeStatus, noteSubscriptionSignIn, setNativeStatusReader,
    refreshStatus, stale, subscribe, create, rename, remove, seedHome,
  };
}

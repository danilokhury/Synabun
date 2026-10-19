// Codex account sign-in state and changes (docs/codex-sidepanel.md → Codex
// accounts). Codex owns its ChatGPT login and its store; SynaBun owns only the
// API key it keeps per account (lib/codex-accounts.js). This adapter asks
// Codex what an account's own store holds (`account/read` from an app-server
// started under that account), signs a credential out, saves a pasted key
// after OpenAI accepts it, and changes an account's mode, each through
// `changeCredentials` so the account's idle panel processes restart under the
// new credential and busy ones refuse the change.
import { spawn } from 'node:child_process';
import { verifyOpenAiApiKey } from './claude-profile-api-key.js';
import { validateProviderApiKey } from './provider-panel-api-key-auth.js';
import { applyCodexLaunchEnv } from './codex-accounts.js';

const fail = (message, status = 409, code = null) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export function createCodexAccountAuth({
  accounts,
  codexBin = () => 'codex',
  env = () => process.env,
  spawnProcess = spawn,
  prepareConfig = () => {},
  statusTimeoutMs = 15_000,
  verifyKey = verifyOpenAiApiKey,
  changeCredentials = async (_id, change) => change(),
} = {}) {
  if (!accounts) throw new Error('createCodexAccountAuth requires accounts');
  function account(id) {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) throw fail('Unknown Codex account', 404);
    const row = accounts.profileFor(id);
    if (!row || row.id !== id) throw fail('Unknown Codex account', 404);
    return row;
  }
  // Codex run under the account's own store: inherited credentials out, its
  // CODEX_HOME in, never the key SynaBun holds (that is not Codex's store).
  function launch(id, args) {
    account(id);
    const plan = accounts.launchFor(id);
    if (!plan.ok) throw fail(plan.message, 404);
    prepareConfig(plan.home);
    let file = codexBin();
    if (!file) throw fail('Codex CLI not found. Install Codex to sign in.', 503);
    const script = /\.[cm]?js$/i.test(file);
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    const proc = spawnProcess(script ? process.execPath : file, script ? [file, ...args] : args, {
      env: { ...applyCodexLaunchEnv(env(), { unset: plan.unset, env: plan.env }), NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], shell, windowsHide: true,
    });
    proc.stdin?.on('error', () => {});
    return proc;
  }
  /** What Codex says the account's own store holds: { account: { type, email, planType } | null }. Never a credential. */
  function nativeRead(id, method, params, { signal, timeoutMs = statusTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      let proc;
      try { proc = launch(id, ['app-server']); } catch (error) { reject(error); return; }
      let buffer = '', settled = false, nextId = 1;
      const waiting = new Map();
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        try { proc.stdin.end(); } catch {}
        try { proc.kill(); } catch {}
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(new Error('Codex account read cancelled.'));
      const timer = setTimeout(() => finish(new Error('Codex did not answer in time. Try Refresh.')), timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const call = (method, params) => new Promise((ok, no) => {
        const callId = nextId++;
        waiting.set(callId, { ok, no });
        try { proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: callId, method, params })}\n`); }
        catch (error) { waiting.delete(callId); no(error); }
      });
      proc.stdout.setEncoding?.('utf8');
      proc.stdout.on('data', (chunk) => {
        buffer = (buffer + chunk).slice(-1_048_576);
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === undefined || msg.method) continue;
          const entry = waiting.get(msg.id);
          if (!entry) continue;
          waiting.delete(msg.id);
          if (msg.error) entry.no(new Error('Codex could not read the account.'));
          else entry.ok(msg.result);
        }
      });
      proc.stderr.on('data', () => {}); // Never forward CLI output: it can carry credential details.
      proc.on('error', () => finish(new Error('Could not start Codex. Check its installation.')));
      proc.on('close', () => finish(new Error('Codex closed before it answered.')));
      (async () => {
        try {
          await call('initialize', { clientInfo: { name: 'synabun-codex-accounts', title: 'SynaBun Codex accounts', version: '0.0.1' } });
          proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
          finish(null, await call(method, params));
        } catch (error) { finish(error); }
      })();
    });
  }
  async function nativeStatus(id) {
    const result = await nativeRead(id, 'account/read', { refreshToken: false });
    const native = result?.account && typeof result.account === 'object' ? result.account : null;
    return { account: native ? { type: native.type || null, email: native.email || null, planType: native.planType || null } : null };
  }
  const rateLimits = (id, options) => nativeRead(id, 'account/rateLimits/read', {}, options);
  // `codex logout` in the account's home: Codex removes its own login (auth.json or its keyring entry).
  function nativeLogout(id) {
    return new Promise((resolve, reject) => {
      let proc, timer;
      try { proc = launch(id, ['logout']); } catch { reject(fail('Could not sign out of Codex. Try again.', 500)); return; }
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); ok ? resolve() : reject(fail('Could not sign out of Codex. Try again.', 500)); };
      proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
      proc.on('error', () => finish(false));
      proc.on('close', (code) => finish(code === 0));
      timer = setTimeout(() => { try { proc.kill(); } catch {} finish(false); }, statusTimeoutMs);
      timer.unref?.();
    });
  }
  /** The account as every surface shows it, after asking Codex about its own store. */
  async function read(id) {
    account(id);
    let failure = null;
    try { await accounts.refreshStatus([id], { force: true }); } catch (error) { failure = error; }
    account(id);
    const row = accounts.describeForClient(id);
    if (failure && !row) throw failure;
    return { accountId: id, account: row };
  }
  const pending = new Set();
  async function guarded(id, work) {
    account(id);
    if (pending.has(id)) throw fail('Another sign-in change for this account is still running.');
    pending.add(id);
    try { return await work(); } finally { pending.delete(id); }
  }
  async function signInApiKey(id, key) {
    account(id); key = validateProviderApiKey('codex', key);
    try {
      return await guarded(id, async () => {
        await verifyKey(key);
        account(id); // A removed account is never recreated by a late answer.
        await changeCredentials(id, () => { account(id); accounts.saveApiKey(id, key); });
      });
    } finally { key = null; }
  }
  // `credential`: 'apiKey' removes the account's key (SynaBun's file, or Codex's own stored key),
  // 'subscription' runs Codex's own logout in the account's home, 'all' both.
  async function signOut(id, credential = 'all') {
    account(id);
    if (!['all', 'apiKey', 'subscription'].includes(credential)) throw fail('Choose which sign-in to remove.', 400);
    return guarded(id, () => changeCredentials(id, async () => {
      const row = accounts.describe(id);
      const ownKey = row?.apiKey?.source === 'synabun';
      const codexKey = row?.apiKey?.source === 'codex';
      if (credential === 'apiKey' && !row?.apiKey?.present && !row?.apiKey?.error) throw fail(`${row?.label || id} has no API key.`);
      if (credential === 'subscription' && codexKey) throw fail(`${row.label} has no ChatGPT sign-in: Codex holds an API key for it.`);
      if (credential !== 'subscription' && (ownKey || row?.apiKey?.error)) accounts.clearApiKey(id);
      // Codex's own store is cleared for a ChatGPT sign-out, or for a key Codex itself holds.
      if (credential === 'subscription' || (credential === 'all' && !ownKey) || (credential === 'apiKey' && codexKey)) {
        await nativeLogout(id);
        accounts.noteNativeStatus(id, { account: null });
      }
      return accounts.describeForClient(id);
    }));
  }
  /** What the account's sessions use from now on: its idle panel processes restart under it. */
  async function setMode(id, mode) {
    return guarded(id, () => changeCredentials(id, () => accounts.setMode(id, mode)));
  }
  return { read, nativeStatus, rateLimits, signInApiKey, signOut, setMode };
}

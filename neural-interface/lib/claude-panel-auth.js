// Claude owns OAuth credentials and refresh. SynaBun owns only pasted keys
// in a separate private profile file; this adapter exposes safe auth status.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyClaudeApiKey } from './claude-profile-api-key.js';
import { validateProviderApiKey, redactProviderSecrets } from './provider-panel-api-key-auth.js';

export function claudeAuthEnv(env, accountEnv) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(CLAUDECODE|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_API_KEY_FILE_DESCRIPTOR|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/.test(key)) delete clean[key];
  }
  return { ...clean, ...accountEnv, NO_COLOR: '1', FORCE_COLOR: '0' };
}

export function claudeAuthorizationUrl(text) {
  for (const match of text.matchAll(/https:\/\/[^\s<>"\x1b]+/g)) {
    try {
      const url = new URL(match[0]);
      if (['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname)
        && !url.username && !url.password && url.searchParams.has('client_id') && url.searchParams.has('code_challenge')) return url.href;
    } catch {}
  }
  return '';
}

export function createClaudePanelAuth({ accounts, executable, env = () => process.env, spawnProcess = spawn, timeoutMs = 10 * 60_000, statusTimeoutMs = 15_000, verifyKey = verifyClaudeApiKey, changeCredentials = async (_id, change) => change() } = {}) {
  const operations = new Map();
  function account(id = 'default') {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) throw Object.assign(new Error('Unknown Claude account'), { status: 404 });
    const row = accounts.profileFor ? accounts.profileFor(id) : accounts.get(id);
    if (!row || row.id !== id) throw Object.assign(new Error('Unknown Claude account'), { status: 404 });
    return row;
  }
  function launch(id, args, extraEnv = {}) {
    account(id);
    const found = executable();
    if (!found?.path) throw new Error(found?.reason || 'Claude CLI not found. Install Claude Code to sign in.');
    const script = /\.[cm]?js$/i.test(found.path);
    const proc = spawnProcess(script ? process.execPath : found.path, script ? [found.path, ...args] : args, {
      env: { ...claudeAuthEnv(env(), accounts.envFor(id)), ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    proc.stdin?.on('error', () => {}); // A native exit can race a manual-code write.
    return proc;
  }
  // Claude Code's own answer about the account's login (never a credential).
  function nativeStatus(id = 'default') {
    account(id);
    return new Promise((resolve, reject) => {
      let proc;
      try { proc = launch(id, ['auth', 'status', '--json']); } catch (error) { reject(error); return; }
      let output = '', settled = false;
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => { proc.kill(); finish(new Error('Claude authentication status timed out. Try Refresh.')); }, statusTimeoutMs);
      proc.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
      proc.stderr.on('data', () => {}); // Never forward CLI output or credential-bearing errors.
      proc.on('error', () => finish(new Error('Could not start Claude Code. Check its installation.')));
      proc.on('close', () => {
        try {
          const data = JSON.parse(output);
          if (typeof data.loggedIn !== 'boolean') throw new Error();
          finish(null, {
            loggedIn: data.loggedIn, email: redactProviderSecrets(data.email || null), orgName: redactProviderSecrets(data.orgName || null),
            authMethod: redactProviderSecrets(data.authMethod || null), subscriptionType: redactProviderSecrets(data.subscriptionType || null),
          });
        } catch { finish(new Error('Could not read Claude authentication. Update Claude Code to a version supporting auth status --json.')); }
      });
    });
  }
  // The account as every surface shows it (lib/claude-accounts.js describe()),
  // after asking Claude Code about its subscription login. A failed check of an
  // account that still has a usable API key is not an error: the key is used.
  async function read(id = 'default') {
    account(id);
    // An account running on its API key is signed in whatever its subscription
    // says: no process is started for the answer. The subscription half is
    // asked in the background, so the account list can show it later.
    const current = accounts.describeForClient?.(id);
    if (current?.mode === 'apiKey' && current.signedIn === true) {
      Promise.resolve(accounts.refreshStatus?.([id])).catch(() => {});
      return { accountId: id, account: current, state: snapshot(id) };
    }
    let status = null, failure = null;
    try { status = await nativeStatus(id); } catch (error) { failure = error; }
    account(id); // A profile removed meanwhile is gone, whatever the CLI said.
    if (status) accounts.noteNativeStatus?.(id, status);
    const row = accounts.describeForClient ? accounts.describeForClient(id) : null;
    if (failure && !(row?.mode === 'apiKey' && row.signedIn)) throw failure;
    return { accountId: id, account: row || legacyAccount(id, status), state: snapshot(id) };
  }
  // A host without the account model (an older caller, a test double).
  function legacyAccount(id, status) {
    if (accounts.readApiKey?.(id)) return { loggedIn: true, email: null, authMethod: 'apiKey', subscriptionType: null };
    return { loggedIn: status.loggedIn, email: status.email, authMethod: status.authMethod, subscriptionType: status.subscriptionType };
  }
  const keyPending = new Set();
  async function signInApiKey(id, key) {
    account(id); key = validateProviderApiKey('claude', key);
    if (keyPending.has(id) || ['starting', 'pending'].includes(snapshot(id).status)) throw Object.assign(new Error('Sign-in already pending'), { status: 409 });
    keyPending.add(id);
    try {
      await verifyKey(key);
      account(id); // A removed profile must never be recreated by a late reply.
      await changeCredentials(id, () => { account(id); accounts.saveApiKey(id, key); });
      operations.set(id, { status: 'success', authUrl: '' });
    } finally { keyPending.delete(id); key = null; }
  }
  // `credential`: 'apiKey' removes the key SynaBun keeps, 'subscription' runs
  // Claude Code's own logout in the account's config directory, 'all' both.
  async function signOut(id, credential = 'all') {
    account(id);
    if (!['all', 'apiKey', 'subscription'].includes(credential)) throw Object.assign(new Error('Choose which sign-in to remove.'), { status: 400 });
    if (keyPending.has(id)) throw Object.assign(new Error('Sign-in already pending'), { status: 409 });
    const op = operations.get(id);
    if (op && ['starting', 'pending'].includes(op.status) && credential !== 'apiKey') cancel(id, op.operationId);
    keyPending.add(id);
    try {
      await changeCredentials(id, async () => {
        if (credential !== 'subscription') accounts.clearApiKey(id);
        if (credential === 'apiKey') return;
        operations.delete(id);
        await new Promise((resolve, reject) => {
          let proc, timer;
          try { proc = launch(id, ['auth', 'logout']); } catch { reject(new Error('Could not sign out of Claude. Try again.')); return; }
          let settled = false;
          const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); ok ? resolve() : reject(new Error('Could not sign out of Claude. Try again.')); };
          proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
          proc.on('error', () => finish(false)); proc.on('close', code => finish(code === 0));
          timer = setTimeout(() => { proc.kill(); finish(false); }, statusTimeoutMs);
        });
        accounts.noteNativeStatus?.(id, { loggedIn: false });
      });
    } finally { keyPending.delete(id); }
  }
  // What the account's sessions use from now on; its idle panel processes end
  // so the next message starts under the new credential.
  async function setMode(id, mode) {
    account(id);
    if (keyPending.has(id) || ['starting', 'pending'].includes(snapshot(id).status)) throw Object.assign(new Error('Finish sign-in first.'), { status: 409 });
    return changeCredentials(id, () => accounts.setMode(id, mode));
  }
  function snapshot(id) {
    const op = operations.get(id);
    return op ? { accountId: id, operationId: op.operationId, status: op.status, authUrl: op.authUrl, error: op.error || '' } : { accountId: id, status: 'idle' };
  }
  function start(id = 'default') {
    account(id);
    if (keyPending.has(id)) throw Object.assign(new Error('Sign-in already pending'), { status: 409 });
    const existing = operations.get(id);
    if (existing && ['starting', 'pending'].includes(existing.status)) return snapshot(id);
    // BROWSER is a supported Claude Code handoff. Suppress its OS browser launch:
    // the panel opens the URL printed by the native command instead.
    const dir = mkdtempSync(join(tmpdir(), 'synabun-claude-oauth-'));
    const browser = join(dir, process.platform === 'win32' ? 'browser.cmd' : 'browser');
    writeFileSync(browser, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const op = { operationId: randomUUID(), status: 'starting', authUrl: '', process: null };
    operations.set(id, op);
    let timer, forceTimer, output = '';
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); rmSync(dir, { recursive: true, force: true }); };
    const finish = (status, error = '') => {
      if (!['starting', 'pending'].includes(op.status)) return;
      op.status = status; op.error = error; op.authUrl = '';
      clearTimeout(timer);
    };
    op.stop = (status, error) => {
      finish(status, error);
      op.process?.kill();
      forceTimer = setTimeout(() => op.process?.kill('SIGKILL'), 2000); forceTimer.unref?.();
    };
    try {
      op.process = launch(id, ['auth', 'login', '--claudeai'], { BROWSER: browser });
      const collect = chunk => {
        output = (output + chunk).slice(-65536);
        if (['starting', 'pending'].includes(op.status)) {
          const url = claudeAuthorizationUrl(output.slice(0, output.lastIndexOf('\n') + 1));
          if (url) { op.authUrl = url; op.status = 'pending'; }
        }
      };
      op.process.stdout.on('data', collect); op.process.stderr.on('data', collect);
      op.process.on('error', () => { finish('error', 'Could not start Claude Code. Check its installation.'); cleanup(); });
      op.process.on('close', async code => {
        cleanup();
        if (!['starting', 'pending'].includes(op.status)) return;
        if (code !== 0) { finish('error', 'Claude sign-in failed. Retry, or update Claude Code if auth login is unavailable.'); return; }
        try {
          const status = await nativeStatus(id);
          if (status.loggedIn) {
            // A subscription just signed into is what the account uses from now on.
            if (accounts.noteSubscriptionSignIn) accounts.noteSubscriptionSignIn(id, status);
            else accounts.recordIdentity?.(id);
            finish('success');
          } else finish('error', 'Claude Code finished without confirming sign-in. Try again.');
        } catch (error) { finish('error', error.message); }
      });
      timer = setTimeout(() => op.stop('error', 'Claude sign-in timed out. Try again.'), timeoutMs); timer.unref?.();
    } catch (error) { finish('error', error.message); cleanup(); }
    return snapshot(id);
  }
  function cancel(id, operationId) {
    account(id);
    const op = operations.get(id);
    if (!op || op.operationId !== operationId) throw Object.assign(new Error('This sign-in attempt is no longer active. Refresh its status.'), { status: 409 });
    if (['starting', 'pending'].includes(op.status)) op.stop('cancelled', '');
    return snapshot(id);
  }
  function submitCode(id, operationId, code) {
    account(id);
    const op = operations.get(id);
    if (!op || op.operationId !== operationId || op.status !== 'pending') throw Object.assign(new Error('This sign-in attempt is no longer active. Refresh its status.'), { status: 409 });
    if (typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\r\n\0]/.test(code)) throw Object.assign(new Error('Paste a single sign-in code from Claude.'), { status: 400 });
    if (!op.process?.stdin?.writable) throw new Error('Claude Code is no longer accepting a sign-in code. Retry sign-in.');
    op.process.stdin.write(`${code.trim()}\n`, error => {
      if (error && op.status === 'pending') op.stop('error', 'Claude Code stopped accepting the sign-in code. Retry sign-in.');
    });
    return snapshot(id);
  }
  return { start, read, nativeStatus, cancel, submitCode, snapshot, signInApiKey, signOut, setMode, close: () => { for (const [id, op] of operations) if (['starting', 'pending'].includes(op.status)) cancel(id, op.operationId); } };
}

// ═══════════════════════════════════════════
// SynaBun — one Antigravity agent process, spoken to over ACP
// ═══════════════════════════════════════════
//
// Google Antigravity's CLI (`agy`) has no Node SDK. What it offers a program
// is the Agent Client Protocol: `agy acp` is Google's "Antigravity ACP Server",
// JSON-RPC 2.0 over stdio, one JSON message per line (initialize, authenticate,
// session/new|load|list|resume|close|prompt|cancel|set_mode|set_model|
// set_config_option, and the agent's own session/update notifications and
// session/request_permission requests). This module starts that process and
// speaks the protocol through the protocol's official TypeScript SDK
// (@agentclientprotocol/sdk, its `unstable` surface: session/set_model and the
// per-turn `usage` of a prompt answer are not in the stable one yet).
//
//   createAcpConnection(spec)  starts `<command> ...args acp ...acpArgs`, answers at once
//     .initialize(extra?)      the agent's capabilities, auth methods, version
//     .request(method, params) any agent method; rejects with the agent's error
//     .notify(method, params)  session/cancel and the like
//     .close()                 ends the process (SIGTERM, then SIGKILL)
//     .exited                  resolves { code, signal } once the process is gone
//     .stderrTail()            the last few KB the agent wrote to stderr, redacted
//
// By default the client offers the agent no file system and no terminal (`fs`
// false, `terminal` false): Antigravity reads, writes and runs commands itself,
// and asks the client before each one it wants approved
// (session/request_permission). What the client answers is the caller's
// (`onPermission`); a caller that has none cancels every request, which the
// agent reads as "not approved". A caller that offers more says so in
// `initialize({ clientCapabilities })` and answers what it offered: the file and
// terminal methods through `onClientRequest`, elicitation/create through
// `onElicitation` (elicitation/complete arrives at `onNotification`). A method
// nobody answers is refused as "method not found".
//
// Nothing here throws at construction. A spawn that fails, or a process that
// ends, rejects every request in flight and every later one.

import { spawn as nodeSpawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable';

export const ACP_PROTOCOL_VERSION = PROTOCOL_VERSION;
/** What `initialize()` offers when the caller says nothing: no file system, no terminal. */
export const DEFAULT_CLIENT_CAPABILITIES = Object.freeze({ fs: Object.freeze({ readTextFile: false, writeTextFile: false }), terminal: false });
/** The client methods an agent may call once the client offered them (`fs`, `terminal`): `onClientRequest` answers them. */
export const ACP_CLIENT_METHODS = Object.freeze([
  'fs/read_text_file', 'fs/write_text_file',
  'terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release',
]);
const STDERR_KEEP = 8 * 1024;
const KILL_GRACE_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Credentials an agent might echo on stderr: never kept, never forwarded. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(\bauthorization["'=:\s]+(?:bearer|basic)\s+)[^\s"',;}]+/gi, '$1[redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, 'ya29.[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[redacted]')
    .replace(/\b(1\/\/[0-9A-Za-z_-]{20,})/g, '[redacted-refresh-token]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["'=:\s]+)("?)[^\s"',}]{8,}/gi, '$1$2[redacted]');
}

/** The error an ACP request rejected with, as one plain object (message, JSON-RPC code, data). */
export function acpErrorInfo(error) {
  if (!error) return { message: 'Unknown error' };
  const message = typeof error.message === 'string' && error.message ? error.message : String(error);
  const info = { message: redactSecrets(message) };
  if (Number.isInteger(error.code)) info.code = error.code;
  if (error.data !== undefined) {
    try { info.data = JSON.parse(redactSecrets(JSON.stringify(error.data))); } catch { /* not JSON: left out */ }
  }
  return info;
}

/** ACP's "authentication required" error (-32000), which every session method answers before a sign-in. */
export function isAuthRequired(error) {
  return Number(error?.code) === -32000 || /authentication required/i.test(String(error?.message || ''));
}

function withTimeout(promise, ms, what, onTimeout) {
  if (!ms || ms <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.(); } catch { /* the timeout is reported either way */ }
        reject(Object.assign(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`), { code: 'ETIMEDOUT' }));
      }, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Start `agy acp` and connect to it.
 *
 * `command` / `args`: what starts the CLI (a resolved launch spec: the file, and the words
 * before `acp`, such as `node cli.js` for a script). `acpArgs`: flags of the `acp` subcommand itself,
 * after it (`--gemini-dir <dir>`: a SynaBun home, lib/antigravity/home.js). `env` / `cwd`: the process's own.
 * `onUpdate(params)`: every session/update notification, as the agent sent it.
 * `onPermission(params, { signal })`: answers session/request_permission
 * ({ outcome: { outcome: 'selected', optionId } } or { outcome: { outcome: 'cancelled' } }).
 * `onClientRequest(method, params, { signal })`: answers the client methods of ACP_CLIENT_METHODS
 * (fs/read_text_file … terminal/release) with their result, or throws (a RequestError keeps its code).
 * `onElicitation(params, { signal })`: answers elicitation/create ({ action, content? }); one that
 * throws or answers nothing counts as { action: 'cancel' }.
 * `onNotification(method, params)` / `onRequest(method, params)`: anything else the agent
 * sends (elicitation/complete, extension methods; the client methods above too when their own
 * handler is missing); an unanswered request is refused as "method not found".
 * `onExit({ code, signal, stderr })`: once, when the process is gone.
 */
export function createAcpConnection({
  command,
  args = [],
  acpArgs = [],
  cwd = process.cwd(),
  env = process.env,
  spawnImpl = nodeSpawn,
  clientInfo = { name: 'synabun', title: 'SynaBun', version: '0' },
  onUpdate = () => {},
  onPermission = null,
  onClientRequest = null,
  onElicitation = null,
  onNotification = null,
  onRequest = null,
  onExit = null,
  onLog = null,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let stderr = '';
  let exitInfo = null;
  let closing = false;
  let child = null;
  let connection = null;
  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });
  const log = (line) => { try { onLog?.(line); } catch { /* logging never breaks the session */ } };

  const finish = (info) => {
    if (exitInfo) return;
    exitInfo = { code: info?.code ?? null, signal: info?.signal ?? null, error: info?.error ? redactSecrets(info.error) : undefined, stderr: stderrTail() };
    try { connection?.close(new Error(exitInfo.error || `Antigravity exited (${exitInfo.signal || exitInfo.code})`)); } catch { /* already closed */ }
    resolveExited(exitInfo);
    try { onExit?.(exitInfo); } catch { /* the exit is recorded either way */ }
  };
  function stderrTail() { return redactSecrets(stderr); }

  if (typeof command !== 'string' || !command) {
    queueMicrotask(() => finish({ error: 'Antigravity CLI (agy) is not installed or could not be resolved.' }));
  } else {
    try {
      child = spawnImpl(command, [...args, 'acp', ...(Array.isArray(acpArgs) ? acpArgs.map(String) : [])], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      queueMicrotask(() => finish({ error: error?.message || String(error) }));
    }
  }

  if (child) {
    child.on('error', (error) => finish({ error: error?.message || String(error) }));
    child.on('exit', (code, signal) => finish({ code, signal }));
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    child.stdin?.on?.('error', () => { /* a closed pipe ends in the exit above */ });
    // A client method without its own handler goes where every unknown request goes.
    const unhandled = (method, params) => {
      if (typeof onRequest === 'function') return onRequest(method, params);
      throw RequestError.methodNotFound(method);
    };
    const app = acpClient()
      .onNotification('session/update', (ctx) => { onUpdate(ctx.params); })
      .onRequest('session/request_permission', async (ctx) => {
        if (typeof onPermission !== 'function') return { outcome: { outcome: 'cancelled' } };
        try {
          const answer = await onPermission(ctx.params, { signal: ctx.signal });
          return answer?.outcome ? answer : { outcome: { outcome: 'cancelled' } };
        } catch (error) {
          log(`permission handler failed: ${error?.message || error}`);
          return { outcome: { outcome: 'cancelled' } };
        }
      })
      .onRequest('elicitation/create', async (ctx) => {
        if (typeof onElicitation !== 'function') return unhandled('elicitation/create', ctx.params);
        try {
          const answer = await onElicitation(ctx.params, { signal: ctx.signal });
          return typeof answer?.action === 'string' ? answer : { action: 'cancel' };
        } catch (error) {
          log(`elicitation handler failed: ${error?.message || error}`);
          return { action: 'cancel' };
        }
      })
      .onNotification('elicitation/complete', (ctx) => { try { onNotification?.('elicitation/complete', ctx.params); } catch { /* informational */ } });
    for (const method of ACP_CLIENT_METHODS) {
      app.onRequest(method, async (ctx) => {
        if (typeof onClientRequest !== 'function') return unhandled(method, ctx.params);
        return onClientRequest(method, ctx.params, { signal: ctx.signal });
      });
    }
    app
      .onNotification('*', (ctx) => { try { onNotification?.(ctx.method, ctx.params); } catch { /* informational */ } })
      .onRequest('*', async (ctx) => unhandled(ctx.method, ctx.params));
    try {
      connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
      connection.closed.catch?.(() => {});
    } catch (error) {
      queueMicrotask(() => finish({ error: error?.message || String(error) }));
    }
  }

  function gone() {
    return Object.assign(new Error(exitInfo?.error || 'The Antigravity agent is not running.'), { code: 'AGENT_EXITED', stderr: stderrTail() });
  }

  async function request(method, params = {}, { timeoutMs = requestTimeoutMs, signal } = {}) {
    if (exitInfo || !connection) throw gone();
    const pending = connection.agent.request(method, params, signal ? { signal } : undefined);
    return withTimeout(pending, timeoutMs, `Antigravity ${method}`);
  }

  async function notify(method, params = {}) {
    if (exitInfo || !connection) throw gone();
    return connection.agent.notify(method, params);
  }

  // One initialize per process: a second call shares the first answer, whatever it asks.
  // `clientCapabilities`: what the client offers the agent (DEFAULT_CLIENT_CAPABILITIES when not given).
  let initialized = null;
  function initialize({ clientCapabilities, ...extra } = {}) {
    if (!initialized) {
      initialized = request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities && typeof clientCapabilities === 'object'
          ? clientCapabilities
          : { fs: { ...DEFAULT_CLIENT_CAPABILITIES.fs }, terminal: DEFAULT_CLIENT_CAPABILITIES.terminal },
        clientInfo,
        ...extra,
      }, { timeoutMs: 30_000 }).catch((error) => { initialized = null; throw error; });
    }
    return initialized;
  }

  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      try { connection?.close(); } catch { /* already closed */ }
      if (!child) return exited;
      try { child.stdin?.end?.(); } catch { /* already closed */ }
      const grouped = process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0;
      const signal = (name) => {
        try { if (grouped) process.kill(-child.pid, name); else child.kill(name); } catch { /* gone */ }
      };
      const groupAlive = () => {
        if (!grouped) return !exitInfo;
        try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      };
      if (process.platform === 'win32' && child.pid) {
        // taskkill must capture the tree while its parent still exists. Killing the parent first loses it.
        await new Promise((resolve) => {
          let timer;
          let killer;
          const done = () => { clearTimeout(timer); resolve(); };
          try {
            killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            timer = setTimeout(() => { try { killer.kill('SIGKILL'); } catch {} done(); }, KILL_GRACE_MS);
            killer.on('exit', done);
            killer.on('error', done);
          } catch { done(); }
        });
        if (!exitInfo) signal('SIGKILL');
      } else signal('SIGTERM');
      const deadline = Date.now() + KILL_GRACE_MS;
      while (groupAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      // The parent can exit before an MCP child. Always signal the process group, even after `exited`.
      if (groupAlive()) {
        signal('SIGKILL');
      }
      const hardDeadline = Date.now() + 500;
      while (groupAlive() && Date.now() < hardDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
      if (!exitInfo) finish({ error: 'Antigravity shutdown exceeded its hard timeout', signal: 'SIGKILL' });
      return exited;
    })();
    return closePromise;
  }

  return {
    get pid() { return child?.pid ?? null; },
    get running() { return !exitInfo && !!connection; },
    exited,
    initialize,
    request,
    notify,
    close,
    stderrTail,
  };
}

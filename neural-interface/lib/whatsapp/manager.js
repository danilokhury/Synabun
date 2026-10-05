// Main-process side of the WhatsApp Link: forks host.js — the only process
// that loads Baileys or reads the WhatsApp credentials — speaks protocol.js
// over IPC, respawns it with backoff, and trips a crash breaker (host.state
// 'held') when it keeps dying. mode 'inproc' (SYNABUN_WHATSAPP_HOST=inproc)
// runs host-core inside this process instead: tests and a kill switch.
//
// Same shape as lib/pty-host/manager.js and lib/desktop/manager.js, with two
// deliberate differences: the child gets an ALLOWLISTED environment (no API
// keys or tokens — never a process.env spread) and piped stdio that is
// redacted before it reaches a log (never inherited).
//
// Every method resolves; none rejects. Failures are {ok:false, code, message}.
// After a respawn the host receives the last configure, then — if the link
// was running — connect({purpose:'run'}) again.

import { fork } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONN, ERR, EV, LIMITS, OP, PROTOCOL_VERSION, pickPrefs, validateEvent } from './protocol.js';
import { resolveWhatsAppPaths } from './paths.js';
import { redactWa } from './redact.js';

const HOST_PATH = fileURLToPath(new URL('./host.js', import.meta.url));

const ENV_ALLOW = Object.freeze([
  'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'ComSpec',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
]);
const ENV_PREFIX = 'SYNABUN_WHATSAPP_';
const HOST_CONFIG_VAR = 'SYNABUN_WHATSAPP_HOST_CONFIG';

/** The host's environment: allowlisted names and SYNABUN_WHATSAPP_* only. */
export function buildHostEnv(source = process.env, { platform = process.platform, extra = {} } = {}) {
  const win = platform === 'win32';
  const allow = new Set(win ? ENV_ALLOW.map((k) => k.toUpperCase()) : ENV_ALLOW);
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (typeof value !== 'string') continue;
    const cmp = win ? key.toUpperCase() : key;
    if (allow.has(cmp) || cmp.startsWith(ENV_PREFIX)) out[key] = value;
  }
  for (const key of Object.keys(out)) if ((win ? key.toUpperCase() : key) === HOST_CONFIG_VAR) delete out[key];
  return { ...out, ...extra };
}

// Debuggers, profilers and heap/report writers would expose the host's memory
// (keys) or write it to disk; preloads and --env-file could pull secrets back
// into an environment that was just allowlisted.
const BLOCKED_ARG = /^(?:--(?:inspect|debug|heapsnapshot|heap-prof|cpu-prof|prof|report|diagnostic-dir|trace|require|import|loader|experimental-loader|env-file|max-old-space-size|disable-warning)|-r$)/;
const VALUE_ARGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--env-file-if-exists',
  '--heapsnapshot-signal', '--heapsnapshot-near-heap-limit', '--report-dir', '--report-directory', '--report-filename',
  '--report-signal', '--diagnostic-dir', '--inspect-port', '--cpu-prof-dir', '--cpu-prof-name', '--cpu-prof-interval',
  '--heap-prof-dir', '--heap-prof-name', '--heap-prof-interval', '--max-old-space-size', '--disable-warning',
]);

function nodeNeedsSqliteFlag(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major === 22 && minor < 13;
}

/** The parent's execArgv minus debug/profiling/report/preload flags, plus the host's own. */
export function hostExecArgv(parent = process.execArgv, { nodeVersion = process.versions.node } = {}) {
  const out = [];
  for (let i = 0; i < parent.length; i++) {
    const arg = parent[i];
    if (BLOCKED_ARG.test(arg)) {
      if (!arg.includes('=') && VALUE_ARGS.has(arg) && i + 1 < parent.length) i += 1;
      continue;
    }
    out.push(arg);
  }
  out.push('--disable-warning=ExperimentalWarning', '--max-old-space-size=512');
  if (nodeNeedsSqliteFlag(nodeVersion) && !out.includes('--experimental-sqlite')) out.push('--experimental-sqlite');
  return out;
}

const PUBLIC_EVENTS = new Set(['state', 'qr', 'pairing_code', 'linked', 'owner_bound', 'inbound', 'ignored', 'throttled', 'fatal']);
const TERMINAL_CONN = new Set([CONN.LOGGED_OUT, CONN.REPLACED, CONN.FORBIDDEN, CONN.UNLINKED, CONN.LINK_EXPIRED, CONN.ERROR, CONN.LOCKED]);
const DESIRE_KILLERS = new Set(['LOGGED_OUT', 'REPLACED', 'FORBIDDEN', 'SESSION_ERROR', 'CONFIRM_TIMEOUT', 'RECONNECT_LIMIT', 'LOCKED']);
const LINE_BURST = 60;
const LINE_WINDOW_MS = 60_000;

function defaultConn() {
  return {
    state: CONN.IDLE, mode: null, registered: false, me: null, owner: null, lastDisconnect: null, retryInMs: null,
    counters: {}, paused: false, awaitingConfirmUntil: null, claim: null, lastError: null,
  };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {object} o
 * @param {string} o.dataHome
 * @param {object} [o.paths]           resolveWhatsAppPaths() result (computed from dataHome when absent)
 * @param {'fork'|'inproc'} [o.mode]
 * @param {Function} [o.loadRuntime]  inproc only: override the runtime loader (tests)
 * @param {Function|object} [o.log]   log(msg, level) or {info, warn, error}
 */
export function createWhatsAppManager({
  dataHome,
  paths = null,
  mode = process.env.SYNABUN_WHATSAPP_HOST === 'inproc' ? 'inproc' : 'fork',
  hostPath = HOST_PATH,
  forkImpl = fork,
  loadRuntime = undefined,
  log = () => {},
  now = () => Date.now(),
  respawnBackoffMs = [1000, 5000, 15000, 60000, 300000],
  crashLimit = 5,
  crashWindowMs = 15 * 60_000,
  stableMs = 10 * 60_000,
  requestTimeoutMs = 15_000,
  sendTimeoutMs = 90_000,
  readyTimeoutMs = 20_000,
  env = process.env,
  platform = process.platform,
  execArgv = undefined,
  hostOptions = null,        // inproc only: extra createHostCore options (tests: sendCaps)
} = {}) {
  const hostPaths = paths || resolveWhatsAppPaths({ dataHome, env, platform });
  const listeners = new Map();
  const pending = new Map(); // reqId → {resolve, timer, op}
  let queue = [];            // ops waiting for 'ready'
  let readyWaiters = [];
  let seq = 0;
  let child = null;
  let core = null;
  let token = null;          // identity of the current host (child or inproc core)
  let ready = false;
  let hadReady = false;
  let hostState = 'stopped';
  let hostPid = null;
  let restarts = 0;
  let lastError = null;
  let heldReason = null;
  let launchError = null;    // why the current launch failed before its ready event
  let configured = Promise.resolve(); // the configure replayed on ready
  let exitTimes = [];
  let failIdx = 0;
  let startedAt = 0;
  let respawnTimer = null;
  let readyTimer = null;
  let stoppedByUser = true;
  let lastPrefs = null;
  let desired = null;        // {purpose:'run', mode?} while the link should be up
  let connCache = defaultConn();
  let runtimeInfo = { loaded: false, version: null, fake: false, error: null };
  let lastStateKey = '';
  const lineTimes = [];

  function say(msg, level = 'info') {
    try {
      if (typeof log === 'function') log(msg, level);
      else log?.[level]?.(msg);
    } catch {}
  }

  function emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { say(`[whatsapp] '${name}' listener threw: ${err?.message || err}`, 'warn'); }
    }
  }

  function status() {
    const conn = { ...connCache };
    if (hostState === 'held') conn.state = CONN.HELD;
    else if (hostState === 'stopped') conn.state = CONN.IDLE;
    return {
      host: { state: hostState, pid: hostPid, restarts, lastError },
      conn,
      runtime: { ...runtimeInfo },
    };
  }

  function emitState() {
    const snap = status();
    const key = JSON.stringify(snap);
    if (key === lastStateKey) return;
    lastStateKey = key;
    emit('state', snap);
  }

  // ── Requests ──

  function sendRaw(msg) {
    if (mode === 'inproc') {
      const c = core;
      if (!c) return false;
      c.handleMessage(msg).catch(() => {});
      return true;
    }
    const c = child;
    if (!c || !c.connected) return false;
    try {
      c.send(msg, (err) => { if (err && msg.reqId) settle(msg.reqId, fail(ERR.HOST_UNAVAILABLE, 'the WhatsApp host is not accepting requests')); });
      return true;
    } catch {
      return false;
    }
  }

  function settle(reqId, result) {
    const entry = pending.get(reqId);
    if (!entry) return;
    pending.delete(reqId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  function failAll(code, message) {
    for (const reqId of [...pending.keys()]) settle(reqId, fail(code, message));
    queue = [];
  }

  function request(op, fields = {}, { timeoutMs = requestTimeoutMs } = {}) {
    return new Promise((resolve) => {
      if (hostState === 'held') {
        resolve(fail(ERR.HELD, heldReason || lastError || 'the WhatsApp host is held after repeated crashes'));
        return;
      }
      if (hostState === 'stopped') {
        resolve(fail(ERR.HOST_UNAVAILABLE, 'the WhatsApp host is not running'));
        return;
      }
      const reqId = ++seq;
      const msg = { op, reqId, ...fields };
      const timer = setTimeout(() => {
        queue = queue.filter((q) => q.reqId !== reqId);
        settle(reqId, fail(ERR.TIMEOUT, `${op} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(reqId, { resolve, timer, op });
      if (ready) {
        if (!sendRaw(msg)) settle(reqId, fail(ERR.HOST_UNAVAILABLE, 'the WhatsApp host is not accepting requests'));
      } else {
        queue.push(msg);
      }
    });
  }

  function flushQueue() {
    const q = queue;
    queue = [];
    for (const msg of q) {
      if (!pending.has(msg.reqId)) continue;
      if (!sendRaw(msg)) settle(msg.reqId, fail(ERR.HOST_UNAVAILABLE, 'the WhatsApp host is not accepting requests'));
    }
  }

  function waitReady(timeoutMs) {
    if (ready) return Promise.resolve(true);
    if (hostState === 'held' || hostState === 'stopped') return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((w) => w !== entry);
        resolve(false);
      }, timeoutMs);
      readyWaiters.push(entry);
    });
  }

  function resolveReadyWaiters(value) {
    const list = readyWaiters;
    readyWaiters = [];
    for (const w of list) {
      clearTimeout(w.timer);
      w.resolve(value);
    }
  }

  // ── Host → manager ──

  function hold(reason) {
    heldReason = reason;
    lastError = reason;
    hostState = 'held';
    desired = null;
    clearTimeout(respawnTimer);
    respawnTimer = null;
    failAll(ERR.HELD, reason);
    resolveReadyWaiters(false);
    say(`[whatsapp] host held: ${reason}`, 'warn');
    emit('fatal', { code: 'HOST_HELD', message: reason });
    emitState();
  }

  function onHostMessage(m, source) {
    if (source !== token) return;
    const v = validateEvent(m);
    if (!v.ok) {
      say(`[whatsapp] dropped an invalid message from the host: ${v.message}`, 'warn');
      return;
    }
    switch (m.t) {
      case EV.READY: {
        if (m.protocol !== PROTOCOL_VERSION) {
          const reason = `protocol mismatch (host speaks ${m.protocol}, expected ${PROTOCOL_VERSION})`;
          const c = child;
          hold(reason);
          if (c) { try { c.kill('SIGKILL'); } catch {} }
          return;
        }
        clearTimeout(readyTimer);
        readyTimer = null;
        ready = true;
        hostPid = m.pid;
        hostState = 'running';
        runtimeInfo = { ...m.runtime };
        connCache = { ...m.conn };
        const replay = hadReady;
        hadReady = true;
        configured = lastPrefs
          ? request(OP.CONFIGURE, { prefs: lastPrefs }).then((r) => { if (!r.ok) say(`[whatsapp] configure failed: ${r.message}`, 'warn'); })
          : Promise.resolve();
        flushQueue();
        if (replay && desired) {
          request(OP.CONNECT, { ...desired }).then((r) => {
            if (!r.ok) say(`[whatsapp] reconnect after a host restart failed: ${r.code}`, 'warn');
          });
        }
        resolveReadyWaiters(true);
        emitState();
        return;
      }
      case EV.REPLY: {
        if (m.ok) settle(m.reqId, isPlainObject(m.data) ? { ok: true, ...m.data } : { ok: true, data: m.data ?? null });
        else {
          const failed = fail(m.error?.code || ERR.INTERNAL, m.error?.message || 'the WhatsApp host refused the request');
          // THROTTLED says when WhatsApp's send caps free up again (the bridge re-sends then).
          if (Number.isFinite(m.error?.retryAfterMs)) failed.retryAfterMs = m.error.retryAfterMs;
          settle(m.reqId, failed);
        }
        return;
      }
      case EV.STATE:
        connCache = { ...m.conn };
        if (TERMINAL_CONN.has(m.conn.state)) desired = null;
        emitState();
        return;
      case EV.LOG:
        say(`[whatsapp-host] ${redactWa(m.message)}`, m.level === 'error' ? 'error' : m.level === 'warn' ? 'warn' : 'info');
        return;
      case EV.FATAL:
        if (DESIRE_KILLERS.has(m.code)) desired = null;
        emit('fatal', { code: m.code, ...(m.message ? { message: m.message } : {}) });
        return;
      case EV.LINKED:
        desired = { purpose: 'run', mode: m.mode };
        emit('linked', { mode: m.mode, me: m.me });
        return;
      case EV.INBOUND:
        emit('inbound', m.message); // listeners get the InboundMessage itself
        return;
      default: {
        const { t, ...payload } = m;
        if (PUBLIC_EVENTS.has(t)) emit(t, payload);
      }
    }
  }

  // ── Lifecycle ──

  function allowLine() {
    const t = now();
    while (lineTimes.length && t - lineTimes[0] > LINE_WINDOW_MS) lineTimes.shift();
    if (lineTimes.length >= LINE_BURST) return false;
    lineTimes.push(t);
    return true;
  }

  function pipeLines(stream, level) {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buf = '';
    const out = (line) => {
      if (line && allowLine()) say(`[whatsapp-host] ${redactWa(line).slice(0, 2000)}`, level);
    };
    stream.on('data', (s) => {
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        out(buf.slice(0, i).trimEnd());
        buf = buf.slice(i + 1);
      }
      if (buf.length > 64 * 1024) {
        out(`${buf.slice(0, 2000)}…`);
        buf = '';
      }
    });
    stream.on('end', () => { out(buf.trimEnd()); buf = ''; });
    stream.on('error', () => {});
  }

  function launch() {
    clearTimeout(respawnTimer);
    respawnTimer = null;
    ready = false;
    hostPid = null;
    launchError = null;
    hostState = 'starting';
    startedAt = now();
    emitState();
    if (mode === 'inproc') {
      launchInproc();
      return;
    }
    try { mkdirSync(hostPaths.waHome, { recursive: true, mode: 0o700 }); } catch {}
    const childEnv = buildHostEnv(env, { platform, extra: { [HOST_CONFIG_VAR]: JSON.stringify({ paths: hostPaths }) } });
    const me = {};
    token = me;
    let c;
    try {
      c = forkImpl(hostPath, [], {
        cwd: hostPaths.waHome,
        env: childEnv,
        execArgv: execArgv || hostExecArgv(),
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch (err) {
      launchError = `could not start the WhatsApp host: ${err?.message || err}`;
      queueMicrotask(() => onExit(me, null, null));
      return;
    }
    child = c;
    hostPid = c.pid ?? null;
    pipeLines(c.stdout, 'info');
    pipeLines(c.stderr, 'warn');
    c.on('message', (m) => onHostMessage(m, me));
    c.on('exit', (code, signal) => onExit(me, code, signal));
    c.on('error', (err) => {
      say(`[whatsapp] host process error: ${err?.message}`, 'warn');
      if (c.pid === undefined) onExit(me, null, null);
    });
    readyTimer = setTimeout(() => {
      if (token !== me || ready) return;
      launchError = `no ready event within ${readyTimeoutMs} ms`;
      try { c.kill('SIGKILL'); } catch {}
    }, readyTimeoutMs);
  }

  async function launchInproc() {
    const me = {};
    token = me;
    try {
      const { createHostCore } = await import('./host-core.js');
      if (token !== me) return;
      core = createHostCore({
        send: (m) => queueMicrotask(() => onHostMessage(m, me)),
        paths: hostPaths,
        env,
        platform,
        ...(loadRuntime ? { loadRuntime } : {}),
        ...(hostOptions && typeof hostOptions === 'object' ? hostOptions : {}),
      });
      const info = await core.init();
      if (token !== me) return;
      onHostMessage({ t: EV.READY, protocol: PROTOCOL_VERSION, pid: process.pid, ...info }, me);
    } catch (err) {
      lastError = `the in-process WhatsApp host failed: ${err?.message || err}`;
      core = null;
      hostState = 'stopped';
      resolveReadyWaiters(false);
      emitState();
    }
  }

  function onExit(me, code, signal) {
    if (me !== token) return;
    token = null;
    child = null;
    ready = false;
    hostPid = null;
    clearTimeout(readyTimer);
    readyTimer = null;
    failAll(ERR.HOST_UNAVAILABLE, 'the WhatsApp host exited');
    connCache = { ...connCache, state: desired ? CONN.RECONNECTING : CONN.IDLE, retryInMs: null };
    if (stoppedByUser || hostState === 'held') {
      if (hostState !== 'held') hostState = 'stopped';
      resolveReadyWaiters(false);
      emitState();
      return;
    }
    const reason = `exited (code ${code}, signal ${signal})`;
    lastError = launchError || `the WhatsApp host ${reason}`;
    launchError = null;
    const t = now();
    exitTimes = exitTimes.filter((x) => t - x < crashWindowMs);
    exitTimes.push(t);
    if (exitTimes.length >= crashLimit) {
      hold(`the WhatsApp host crashed ${exitTimes.length} times in ${Math.round(crashWindowMs / 60_000)} minutes`);
      return;
    }
    if (startedAt && t - startedAt >= stableMs) failIdx = 0;
    const delay = respawnBackoffMs[Math.min(failIdx, respawnBackoffMs.length - 1)] ?? 0;
    failIdx += 1;
    restarts += 1;
    hostState = 'backoff';
    say(`[whatsapp] host ${reason}; restarting in ${delay} ms`, 'warn');
    emitState();
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      if (!stoppedByUser && hostState === 'backoff') launch();
    }, delay);
  }

  // ── Public API ──

  async function start(prefs) {
    if (prefs !== undefined) lastPrefs = { ...(lastPrefs || {}), ...pickPrefs(prefs) };
    stoppedByUser = false;
    if (hostState === 'held') {
      heldReason = null;
      exitTimes = [];
      failIdx = 0;
      hostState = 'stopped';
    }
    if (hostState === 'stopped' || hostState === 'backoff') launch();
    else if (ready && prefs !== undefined) await request(OP.CONFIGURE, { prefs: lastPrefs });
    const ok = await waitReady(readyTimeoutMs + 1000);
    if (ok) await configured;
    if (!ok) return fail(hostState === 'held' ? ERR.HELD : ERR.HOST_UNAVAILABLE, lastError || 'the WhatsApp host did not start');
    return { ok: true, ...status() };
  }

  async function configure(prefs) {
    lastPrefs = { ...(lastPrefs || {}), ...pickPrefs(prefs) };
    if (!ready) return { ok: true, queued: true };
    return request(OP.CONFIGURE, { prefs: lastPrefs });
  }

  async function connect({ purpose = 'run', mode: connMode, link } = {}) {
    const fields = { purpose };
    if (connMode) fields.mode = connMode;
    if (link) fields.link = { method: link.method === 'code' ? 'code' : 'qr', ...(link.phone ? { phone: String(link.phone) } : {}) };
    const res = await request(OP.CONNECT, fields);
    if (res.ok && purpose === 'run') desired = { purpose: 'run', ...(connMode ? { mode: connMode } : {}) };
    return res;
  }

  async function stop({ timeoutMs = 3000 } = {}) {
    stoppedByUser = true;
    desired = null;
    clearTimeout(respawnTimer);
    respawnTimer = null;
    clearTimeout(readyTimer);
    readyTimer = null;
    resolveReadyWaiters(false);
    if (mode === 'inproc') {
      const c = core;
      core = null;
      token = null;
      ready = false;
      failAll(ERR.HOST_UNAVAILABLE, 'the WhatsApp host stopped');
      try { await c?.shutdown(); } catch {}
      if (hostState !== 'held') hostState = 'stopped';
      emitState();
      return { ok: true };
    }
    const c = child;
    if (!c) {
      if (hostState !== 'held') hostState = 'stopped';
      failAll(ERR.HOST_UNAVAILABLE, 'the WhatsApp host stopped');
      emitState();
      return { ok: true };
    }
    const exited = new Promise((resolve) => {
      if (c.exitCode !== null || c.signalCode !== null) resolve();
      else c.once('exit', () => resolve());
    });
    try { if (c.connected) c.send({ op: OP.SHUTDOWN }); } catch {}
    const term = setTimeout(() => { try { c.kill('SIGTERM'); } catch {} }, Math.floor(timeoutMs / 2));
    const kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, timeoutMs);
    let guard;
    await Promise.race([exited, new Promise((resolve) => { guard = setTimeout(resolve, timeoutMs + 2000); })]);
    clearTimeout(term);
    clearTimeout(kill);
    clearTimeout(guard);
    return { ok: true };
  }

  function killNow() {
    stoppedByUser = true;
    desired = null;
    clearTimeout(respawnTimer);
    respawnTimer = null;
    clearTimeout(readyTimer);
    readyTimer = null;
    if (child) { try { child.kill('SIGTERM'); } catch {} }
    if (core) { core.shutdown().catch(() => {}); core = null; token = null; }
  }

  function on(name, fn) {
    if (!PUBLIC_EVENTS.has(name)) throw new TypeError(`unknown WhatsApp manager event '${name}' (${[...PUBLIC_EVENTS].join(', ')})`);
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  }

  return {
    start,
    configure,
    connect,
    disconnect: async () => { desired = null; return request(OP.DISCONNECT); },
    logout: async () => { desired = null; return request(OP.LOGOUT, {}, { timeoutMs: 20_000 }); },
    confirmOwner: (accept) => request(OP.CONFIRM_OWNER, { accept: !!accept }, { timeoutMs: 20_000 }),
    claimStart: ({ ttlMs } = {}) => request(OP.CLAIM_START, Number.isFinite(ttlMs) ? { ttlMs } : {}),
    claimCancel: () => request(OP.CLAIM_CANCEL),
    ownerReset: () => request(OP.OWNER_RESET),
    send: (text, { replyTo = null } = {}) => {
      if (typeof text !== 'string') return Promise.resolve(fail(ERR.BAD_REQUEST, 'text must be a string'));
      return request(OP.SEND, { text, ...(replyTo ? { replyTo } : {}) }, { timeoutMs: sendTimeoutMs });
    },
    react: (id, name) => request(OP.REACT, { id, reaction: name ?? null }, { timeoutMs: sendTimeoutMs }),
    presence: (state) => request(OP.PRESENCE, { state }),
    markRead: (ids) => request(OP.READ, { ids: Array.isArray(ids) ? ids.slice(0, LIMITS.MAX_READ_IDS) : [] }),
    status,
    on,
    stop,
    killNow,
    /** Drive the fake runtime (SYNABUN_WHATSAPP_FAKE=1 only; the host refuses otherwise). */
    fake: (action, args = {}) => request(OP.FAKE, { action, args }),
    get mode() { return mode; },
    get paths() { return hostPaths; },
  };
}

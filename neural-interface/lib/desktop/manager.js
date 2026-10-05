// Main-server side of the native desktop helper (helper/SynabunDesktop.swift):
// starts it lazily, speaks the JSON-lines protocol (protocol.js), queues
// requests until it is ready, times them out (abort → TIMEOUT), respawns it with
// backoff when it dies, and shuts it down when idle. Same shape as
// lib/pty-host/manager.js.
//
// Respawn contract: after any respawn the first thing the new helper receives
// is `panic` (its predecessor may have died holding keys or buttons), then the
// last successful `configure` merged (protocol.js mergeConfigure) so queued
// actions never run with default guards, then the queued requests.
//
// SYNABUN_DESKTOP_HELPER=fake (or mode:'fake') runs the in-process fake core
// (fake-helper.js) behind the same API and event semantics — no child process.

import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import {
  BYPASS_COMMANDS, ERROR_CODES, EVENTS, PROTOCOL_VERSION, createLineParser, encodeMessage, helperError, mergeConfigure,
} from './protocol.js';

const HASH_FROM_NAME = /^synabun-desktop-([0-9a-f]{16})$/;
const BYPASS = new Set(BYPASS_COMMANDS);
const STOP_WAIT_MS = 2000;
const INTERNAL_TIMEOUT_MS = 5000;
const MAX_LATE_IDS = 256;

function stoppedError() {
  return helperError(ERROR_CODES.HELPER_UNAVAILABLE, 'the desktop helper is stopped', { stopped: true });
}

function asHelperError(err, fallbackCode) {
  if (err && typeof err.code === 'string' && ERROR_CODES[err.code]) return err;
  return helperError(fallbackCode, err?.message || String(err), err?.code ? { cause: err.code } : undefined);
}

/** resolveBinary may return a path or { path, hash }; a cached binary's name carries its hash. */
function normalizeBinary(value) {
  const path = typeof value === 'string' ? value : value?.path;
  if (typeof path !== 'string' || !path) {
    throw helperError(ERROR_CODES.HELPER_UNAVAILABLE, 'resolveBinary returned no helper path');
  }
  const hash = (value && typeof value === 'object' && value.hash) || basename(path).match(HASH_FROM_NAME)?.[1] || null;
  return { path, hash };
}

export function createDesktopHelperManager({
  resolveBinary,
  spawnImpl = spawn,
  mode = process.env.SYNABUN_DESKTOP_HELPER === 'fake' ? 'fake' : 'native',
  fakeOptions,
  env = {},
  log = () => {},
  now = Date.now,
  backoffMs = [0, 1000, 2000, 4000, 8000, 16000, 30000],
  stableMs = 60000,
  idleShutdownMs = 10 * 60 * 1000,
  defaultTimeoutMs = 15000,
  readyTimeoutMs = 15000,
  maxQueue = 32,
} = {}) {
  if (mode !== 'fake' && typeof resolveBinary !== 'function') {
    throw new TypeError('createDesktopHelperManager: resolveBinary is required unless mode is "fake"');
  }

  const listeners = { event: new Set(), state: new Set(), exit: new Set() };
  const inflight = new Map(); // id → entry already written to the helper
  const lateIds = new Set();  // action ids that timed out; a late reply proves the queue still moves
  let queue = [];             // entries waiting for 'ready'
  let seq = 0;
  let proc = null;            // current helper process (child or fake core)
  let state = 'absent';
  let lastError = null;
  let readyEvent = null;
  let restarts = 0;
  let failIdx = 0;
  let spawnCount = 0;
  let consecutiveTimeouts = 0;
  let stopped = false;
  let startPromise = null;
  let backoffTimer = null;
  let backoffWake = null;
  let idleTimer = null;
  let notBefore = 0;          // earliest time the next start may begin (backoff after failures)
  let lastConfigure = null;   // effective configuration, replayed after every respawn

  const say = (msg, level = 'info') => {
    try { log(msg, level); } catch {}
  };

  function emit(name, payload) {
    for (const fn of [...listeners[name]]) {
      try {
        fn(payload);
      } catch (err) {
        say(`[desktop] ${name} listener threw: ${err?.message || err}`, 'warn');
      }
    }
  }

  let lastStateKey = '';
  function setState(next) {
    state = next;
    const payload = { state, pid: proc?.pid ?? null, restarts, lastError };
    const key = JSON.stringify(payload);
    if (key === lastStateKey) return;
    lastStateKey = key;
    emit('state', payload);
  }

  function status() {
    return { state, pid: proc?.pid ?? null, restarts, lastError, ready: proc?.ready ? readyEvent : null };
  }

  function on(name, fn) {
    const set = listeners[name];
    if (!set) throw new TypeError(`unknown desktop helper manager event '${name}' (event, state, exit)`);
    set.add(fn);
    return () => set.delete(fn);
  }

  // ── Requests ──
  function settle(entry, err, result) {
    if (entry.done) return;
    entry.done = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (err) entry.reject(err);
    else entry.resolve(result);
  }

  function rejectQueue(err) {
    const q = queue;
    queue = [];
    for (const entry of q) settle(entry, err);
  }

  function dispatch(p, entry) {
    entry.sent = true;
    inflight.set(entry.id, entry);
    if (entry.cmd === 'shutdown') p.expectedExit = true;
    if (!p.send({ id: entry.id, cmd: entry.cmd, args: entry.args })) {
      inflight.delete(entry.id);
      settle(entry, helperError(ERROR_CODES.HELPER_UNAVAILABLE, 'the desktop helper is not accepting input'));
    }
  }

  function sendInternal(p, cmd, args = {}, timeoutMs = INTERNAL_TIMEOUT_MS) {
    const entry = {
      id: ++seq, cmd, args, timeoutMs, internal: true, sent: false, done: false, timer: null,
      resolve: () => {},
      reject: (err) => {
        if (err?.code !== ERROR_CODES.HELPER_UNAVAILABLE) say(`[desktop] internal ${cmd} failed: ${err?.message}`, 'warn');
      },
    };
    entry.timer = setTimeout(() => onTimeout(entry), timeoutMs);
    dispatch(p, entry);
    return entry;
  }

  function flushQueue(p) {
    const q = queue;
    queue = [];
    for (const entry of q) if (!entry.done) dispatch(p, entry);
  }

  function rememberLate(id) {
    lateIds.add(id);
    if (lateIds.size > MAX_LATE_IDS) lateIds.delete(lateIds.values().next().value);
  }

  function onTimeout(entry) {
    entry.timer = null;
    if (entry.done) return;
    if (!entry.sent) {
      queue = queue.filter((e) => e !== entry);
      settle(entry, helperError(ERROR_CODES.TIMEOUT, `${entry.cmd} timed out after ${entry.timeoutMs} ms waiting for the desktop helper to start`, {
        cmd: entry.cmd, timeoutMs: entry.timeoutMs, queued: true,
      }));
      return;
    }
    inflight.delete(entry.id);
    settle(entry, helperError(ERROR_CODES.TIMEOUT, `${entry.cmd} timed out after ${entry.timeoutMs} ms`, { cmd: entry.cmd, timeoutMs: entry.timeoutMs }));
    const p = proc;
    if (!p || p.exited || p.expectedExit) return; // shutting down anyway (stop / idle): the kill timer handles it
    if (!BYPASS.has(entry.cmd)) rememberLate(entry.id);
    if (!entry.internal) sendInternal(p, 'abort');
    consecutiveTimeouts += 1;
    if (consecutiveTimeouts >= 2) {
      consecutiveTimeouts = 0;
      lastError = 'two consecutive request timeouts';
      say(`[desktop] ${lastError}; restarting the helper`, 'warn');
      p.failReason = lastError;
      p.kill('SIGKILL'); // the exit handler rejects in-flight work and respawns with backoff
    }
  }

  function request(cmd, args = {}, { timeoutMs } = {}) {
    if (typeof cmd !== 'string' || !cmd) return Promise.reject(helperError(ERROR_CODES.BAD_ARGS, 'cmd must be a non-empty string'));
    if (stopped) return Promise.reject(stoppedError());
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const entry = { id: ++seq, cmd, args: args ?? {}, timeoutMs: ms, internal: false, sent: false, done: false, timer: null, resolve, reject };
      armIdle();
      if (proc?.ready && !proc.exited) {
        entry.timer = setTimeout(() => onTimeout(entry), ms);
        dispatch(proc, entry);
        return;
      }
      if (queue.length >= maxQueue) {
        reject(helperError(ERROR_CODES.HELPER_UNAVAILABLE, `the desktop helper queue is full (${maxQueue} waiting)`, { maxQueue }));
        return;
      }
      entry.timer = setTimeout(() => onTimeout(entry), ms);
      queue.push(entry);
      ensureStarted().catch(() => {}); // a failed start rejects the queue itself
    });
  }

  // ── Helper → manager ──
  function onMessage(p, msg) {
    if (p !== proc || !msg || typeof msg !== 'object') return;
    if (typeof msg.event === 'string' && msg.id === undefined) {
      onEvent(p, msg);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    onReply(p, msg);
  }

  function onEvent(p, ev) {
    if (ev.event === EVENTS.READY) {
      if (p.ready || stopped || p.expectedExit) return;
      if (ev.protocol !== PROTOCOL_VERSION) {
        p.failReason = `protocol mismatch (helper speaks ${ev.protocol}, expected ${PROTOCOL_VERSION})`;
        p.kill('SIGKILL');
        return;
      }
      p.ready = true;
      p.readyAt = now();
      clearTimeout(p.readyTimer);
      readyEvent = ev;
      setState('running');
      if (p.seq > 1) sendInternal(p, 'panic');
      if (lastConfigure) sendInternal(p, 'configure', lastConfigure);
      flushQueue(p);
      armIdle();
      p.resolveReady(ev);
    } else if (ev.event === EVENTS.LOG) {
      say(`[desktop-helper] ${ev.message}`, ev.level || 'info');
    }
    emit('event', ev);
  }

  function onReply(p, msg) {
    const entry = inflight.get(msg.id);
    if (!entry) {
      if (lateIds.delete(msg.id)) consecutiveTimeouts = 0;
      return;
    }
    inflight.delete(msg.id);
    if (!BYPASS.has(entry.cmd)) consecutiveTimeouts = 0;
    if (msg.ok) {
      if (entry.cmd === 'configure' && !entry.internal) lastConfigure = mergeConfigure(lastConfigure, entry.args);
      settle(entry, null, msg.result);
    } else {
      const e = msg.error || {};
      settle(entry, helperError(e.code || ERROR_CODES.INTERNAL, e.message || 'desktop helper error', e.details));
    }
    if (!entry.internal) armIdle();
  }

  // ── Lifecycle ──
  function makeProc(kind) {
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    readyPromise.catch(() => {});
    spawnCount += 1;
    return {
      kind, seq: spawnCount, pid: null, ready: false, readyAt: 0, startedAt: now(), exited: false, expectedExit: false,
      exitReason: null, failReason: null, readyTimer: null, exitWaiters: [], readyPromise, resolveReady, rejectReady,
      send: () => false, kill: () => {},
    };
  }

  function armReadyTimer(p) {
    p.readyTimer = setTimeout(() => {
      if (p.ready || p.exited) return;
      p.failReason = `no ready event within ${readyTimeoutMs} ms`;
      p.kill('SIGKILL');
    }, readyTimeoutMs);
  }

  function launchChild({ path, hash }) {
    const p = makeProc('child');
    proc = p;
    const childEnv = { ...process.env, ...env };
    if (hash && !childEnv.SYNABUN_DESKTOP_SOURCE_HASH) childEnv.SYNABUN_DESKTOP_SOURCE_HASH = hash;
    let child;
    try {
      child = spawnImpl(path, [], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, windowsHide: true });
    } catch (err) {
      queueMicrotask(() => handleExit(p, { error: err }));
      return p;
    }
    p.pid = child.pid ?? null;
    const parser = createLineParser((msg) => onMessage(p, msg), {
      onError: (err) => say(`[desktop] ${err.message}`, 'warn'),
    });
    child.stdout.on('data', (chunk) => parser.push(chunk));
    child.stdout.on('end', () => parser.end());
    let errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => {
      errBuf += s;
      let i;
      while ((i = errBuf.indexOf('\n')) !== -1) {
        const line = errBuf.slice(0, i).trimEnd();
        errBuf = errBuf.slice(i + 1);
        if (line) say(`[desktop-helper] ${line}`);
      }
      if (errBuf.length > 64 * 1024) {
        say(`[desktop-helper] ${errBuf.slice(0, 2048)}…`);
        errBuf = '';
      }
    });
    child.stdin.on('error', () => {}); // EPIPE while it dies; 'exit' does the bookkeeping
    child.on('error', (err) => {
      if (child.pid === undefined) handleExit(p, { error: err });
      else say(`[desktop] helper process error: ${err?.message}`, 'warn');
    });
    // 'close' comes after the last stdout byte; 'exit' is the fallback should
    // anything else keep the pipes open.
    child.on('close', (code, signal) => handleExit(p, { code, signal }));
    child.on('exit', (code, signal) => {
      setTimeout(() => handleExit(p, { code, signal }), 500).unref?.();
    });
    p.send = (obj) => {
      if (p.exited || !child.stdin.writable) return false;
      try {
        child.stdin.write(encodeMessage(obj));
        return true;
      } catch {
        return false;
      }
    };
    p.kill = (signal = 'SIGKILL') => {
      try { child.kill(signal); } catch {}
    };
    armReadyTimer(p);
    return p;
  }

  async function launchFake() {
    const { createFakeHelperCore } = await import('./fake-helper.js');
    const p = makeProc('fake');
    proc = p;
    const core = createFakeHelperCore({ ...(fakeOptions || {}), env: { ...process.env, ...env } });
    p.pid = core.pid;
    core.on((msg) => onMessage(p, msg));
    core.onExit(({ code, signal }) => handleExit(p, { code, signal }));
    p.send = (obj) => {
      if (p.exited) return false;
      core.handle(obj).then((reply) => { if (reply) onMessage(p, reply); }, (err) => say(`[desktop] fake helper: ${err?.message}`, 'warn'));
      return true;
    };
    p.kill = (signal = 'SIGKILL') => core.close({ code: null, signal });
    armReadyTimer(p);
    core.start();
    return p;
  }

  function sleepBackoff(ms) {
    return new Promise((resolve) => {
      backoffWake = resolve;
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        backoffWake = null;
        resolve();
      }, ms);
    });
  }

  /** Nothing was spawned (resolve or launch threw): fail the start and the queue. */
  function failBeforeSpawn(err) {
    const e = asHelperError(err, ERROR_CODES.HELPER_UNAVAILABLE);
    lastError = e.message;
    noteFailure(0);
    rejectQueue(e);
    setState(stopped ? 'stopped' : 'crashed');
    return e;
  }

  async function runStart() {
    const wait = notBefore - now();
    if (wait > 0) await sleepBackoff(wait);
    if (stopped) throw stoppedError();
    setState('starting');
    let p;
    try {
      if (mode === 'fake') {
        p = await launchFake();
      } else {
        const bin = normalizeBinary(await resolveBinary());
        if (stopped) throw stoppedError();
        p = launchChild(bin);
      }
    } catch (err) {
      if (stopped) throw stoppedError();
      throw failBeforeSpawn(err);
    }
    return p.readyPromise;
  }

  function ensureStarted() {
    if (stopped) return Promise.reject(stoppedError());
    if (proc?.ready && !proc.exited) return Promise.resolve(readyEvent);
    if (!startPromise) {
      const sp = runStart().finally(() => {
        if (startPromise === sp) startPromise = null;
      });
      sp.catch(() => {});
      startPromise = sp;
    }
    return startPromise;
  }

  /** Lazy and idempotent; resolves with the helper's `ready` event. Clears a previous stop(). */
  function start() {
    stopped = false;
    return ensureStarted();
  }

  /** Backoff index resets once a process stayed up stableMs; returns the next delay. */
  function noteFailure(startedAt) {
    if (startedAt && now() - startedAt >= stableMs) failIdx = 0;
    const delay = backoffMs[Math.min(failIdx, backoffMs.length - 1)] ?? 0;
    failIdx += 1;
    notBefore = now() + delay;
    return delay;
  }

  function handleExit(p, { code = null, signal = null, error = null } = {}) {
    if (p.exited) return;
    p.exited = true;
    clearTimeout(p.readyTimer);
    for (const w of p.exitWaiters.splice(0)) w();
    const current = p === proc;
    if (current) proc = null;
    const expected = p.expectedExit || stopped;
    const reason = p.failReason || (error ? `could not be spawned (${error.code || error.message})` : `exited (code ${code}, signal ${signal})`);

    if (current) {
      const err = helperError(ERROR_CODES.HELPER_UNAVAILABLE, expected ? 'the desktop helper stopped' : `the desktop helper ${reason}`, { code, signal });
      for (const entry of inflight.values()) settle(entry, err);
      inflight.clear();
      readyEvent = null;
    }
    emit('exit', { pid: p.pid, code, signal, expected, reason: expected ? (p.exitReason || 'shutdown') : reason });
    if (!current) return;

    if (!p.ready) {
      // Never became ready: fail the start. No automatic respawn — the next
      // request (or start()) retries, after the backoff delay.
      const err = helperError(ERROR_CODES.HELPER_UNAVAILABLE, `the desktop helper failed to start: ${reason}`, {
        code, signal, ...(error?.code ? { cause: error.code } : {}),
      });
      if (!expected) {
        lastError = reason;
        noteFailure(p.startedAt);
      }
      p.rejectReady(stopped ? stoppedError() : err);
      rejectQueue(stopped ? stoppedError() : err);
      setState(stopped ? 'stopped' : expected ? 'absent' : 'crashed');
      return;
    }
    if (expected) {
      setState(stopped ? 'stopped' : 'absent');
      return;
    }
    lastError = reason;
    const delay = noteFailure(p.startedAt);
    restarts += 1;
    say(`[desktop] helper ${reason}; restarting in ${delay} ms`, 'warn');
    setState('crashed');
    startPromise = null;
    ensureStarted().catch(() => {});
  }

  function shutdownProc(p, reason) {
    if (p.exited) return Promise.resolve();
    p.expectedExit = true;
    p.exitReason = reason;
    const exited = new Promise((resolve) => p.exitWaiters.push(resolve));
    if (p.ready) sendInternal(p, 'shutdown', {}, STOP_WAIT_MS); // releases held input, then exits
    else p.kill('SIGKILL');
    const killTimer = setTimeout(() => p.kill('SIGKILL'), STOP_WAIT_MS);
    return exited.finally(() => clearTimeout(killTimer));
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (!(idleShutdownMs > 0) || !Number.isFinite(idleShutdownMs)) return;
    idleTimer = setTimeout(onIdle, idleShutdownMs);
    idleTimer.unref?.();
  }

  function onIdle() {
    idleTimer = null;
    const p = proc;
    if (!p || !p.ready || p.exited || stopped) return;
    if (inflight.size > 0 || queue.length > 0) {
      armIdle();
      return;
    }
    say('[desktop] helper idle; stopping it until the next request');
    shutdownProc(p, 'idle').catch(() => {});
  }

  /** shutdown → ≤ 2 s → SIGKILL. No respawn until start() is called again. */
  async function stop() {
    stopped = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (backoffTimer) clearTimeout(backoffTimer);
    backoffTimer = null;
    const wake = backoffWake;
    backoffWake = null;
    wake?.();
    rejectQueue(stoppedError());
    const p = proc;
    if (p) await shutdownProc(p, 'stopped');
    setState('stopped');
  }

  return {
    start,
    request,
    on,
    status,
    stop,
    get mode() { return mode; },
  };
}

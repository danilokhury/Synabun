// Main-server side of the pty-host: forks the terminal process, forwards
// operations over IPC, hands terminal WebSocket upgrades to it, and gives the
// rest of server.js a node-pty-shaped proxy (write/resize/kill/pid/cols/rows)
// so loop drivers, live links and REST endpoints keep working unchanged.
//
// SYNABUN_PTY_HOST=inproc runs the same core inside the main process (no
// fork, no socket handoff) — the kill switch and the fallback.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EV, OP, UPGRADE_HEADER_WHITELIST } from './protocol.js';
import { createPtyHostCore } from './core.js';

const HOST_PATH = fileURLToPath(new URL('./host.js', import.meta.url));
const BACKOFF_MS = [0, 1000, 2000, 4000, 8000, 16000, 30000];
const STABLE_MS = 60000;
const HOLD_SOCKET_MS = 5000;

function pickHeaders(headers = {}) {
  const out = {};
  for (const k of UPGRADE_HEADER_WHITELIST) if (headers[k] !== undefined) out[k] = headers[k];
  return out;
}

function makeWaiter() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // loops create sessions without awaiting the spawn
  return { promise, resolve, reject, settled: false };
}

export function createPtyHostManager({
  config = {},
  mode = process.env.SYNABUN_PTY_HOST === 'inproc' ? 'inproc' : 'fork',
  execArgv = ['--disable-warning=ExperimentalWarning', '--max-old-space-size=1024'],
  hostPath = HOST_PATH,
  log = console,
} = {}) {
  const handlers = new Map();     // id → { onSpawned, onTap, onResized, onClients, onExit }
  const spawnWaiters = new Map(); // id → waiter
  const requests = new Map();     // reqId → { resolve, reject, timer }
  let reqSeq = 0;
  let child = null;
  let core = null;
  let ready = false;
  let queue = [];
  let heldSockets = [];
  let startedAt = 0;
  let restartIdx = 0;
  let restarts = 0;
  let restartTimer = null;
  let shuttingDown = false;
  let ptyAvailable = true;
  let ptyError = null;
  let hostPid = null;

  // ── Host → main events ──
  function settleSpawn(id, err, data) {
    const w = spawnWaiters.get(id);
    if (!w || w.settled) return;
    w.settled = true;
    if (err) w.reject(err); else w.resolve(data);
  }

  function dispatch(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case EV.READY:
        ready = true;
        hostPid = m.pid || null;
        ptyAvailable = m.ptyAvailable !== false;
        ptyError = m.ptyError || null;
        if (!ptyAvailable) log.warn?.('[pty] node-pty not available in the terminal host — terminal features disabled:', ptyError);
        flushQueue();
        releaseHeldSockets();
        break;
      case EV.SPAWNED:
        try { handlers.get(m.id)?.onSpawned?.(m); } catch (err) { log.warn?.('[pty-host] onSpawned', err?.message); }
        settleSpawn(m.id, null, m);
        break;
      case EV.SPAWN_ERROR: {
        const h = handlers.get(m.id);
        handlers.delete(m.id);
        settleSpawn(m.id, new Error(m.message || 'Terminal spawn failed'));
        spawnWaiters.delete(m.id);
        try { h?.onExit?.({ id: m.id, exitCode: -1, signal: null, reason: 'spawn-error', error: m.message }); } catch {}
        break;
      }
      case EV.TAP:
        try { handlers.get(m.id)?.onTap?.(m.data); } catch (err) { log.warn?.('[pty-host] onTap', err?.message); }
        break;
      case EV.RESIZED:
        try { handlers.get(m.id)?.onResized?.(m); } catch {}
        break;
      case EV.CLIENTS:
        try { handlers.get(m.id)?.onClients?.(m); } catch {}
        break;
      case EV.EXIT: {
        const h = handlers.get(m.id);
        handlers.delete(m.id);
        spawnWaiters.delete(m.id);
        // During a server shutdown the main-side exit effects (marking loop
        // files inactive, schedule outcomes) must not run — the PTYs die
        // because the server is going away, not because the work ended.
        if (!shuttingDown) {
          try { h?.onExit?.(m); } catch (err) { log.warn?.('[pty-host] onExit', err?.message); }
        }
        break;
      }
      case EV.REPLY: {
        const r = requests.get(m.reqId);
        if (!r) break;
        requests.delete(m.reqId);
        clearTimeout(r.timer);
        if (m.ok) r.resolve(m.data); else r.reject(new Error(m.error || 'pty-host request failed'));
        break;
      }
      case EV.WARN:
        log.warn?.('[pty-host]', m.message);
        break;
      default:
        break;
    }
  }

  // ── Lifecycle ──
  function start() {
    if (shuttingDown || child || core) return;
    startedAt = Date.now();
    ready = false;
    if (mode === 'inproc') {
      core = createPtyHostCore({ send: (m) => queueMicrotask(() => dispatch(m)), config });
      core.init().then((info) => dispatch({ t: EV.READY, pid: process.pid, ...info }));
      return;
    }
    const env = { ...process.env, SYNABUN_PTY_HOST_CONFIG: JSON.stringify(config) };
    if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.split(/\s+/).filter(o => o && !o.startsWith('--inspect')).join(' ');
    const c = fork(hostPath, [], {
      serialization: 'advanced',
      execArgv,
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    child = c;
    c.on('message', (m) => { if (c === child) dispatch(m); });
    c.on('exit', (code, signal) => { if (c === child) onChildExit(code, signal); });
    c.on('error', (err) => log.warn?.('[pty-host] child error:', err?.message));
  }

  function onChildExit(code, signal) {
    child = null;
    ready = false;
    hostPid = null;
    for (const r of requests.values()) { clearTimeout(r.timer); r.reject(new Error('pty-host exited')); }
    requests.clear();
    for (const h of heldSockets) { clearTimeout(h.timer); try { h.socket.destroy(); } catch {} }
    heldSockets = [];
    queue = [];
    const lost = [...handlers.entries()];
    handlers.clear();
    for (const [id] of lost) settleSpawn(id, new Error('pty-host exited'));
    spawnWaiters.clear();
    if (shuttingDown) return;
    log.warn?.(`[pty-host] terminal host exited (code ${code}, signal ${signal}) — ${lost.length} terminal(s) lost; restarting`);
    for (const [id, h] of lost) {
      try { h?.onExit?.({ id, exitCode: -1, signal: null, reason: 'pty-host-exit' }); } catch {}
    }
    if (Date.now() - startedAt > STABLE_MS) restartIdx = 0;
    const delay = BACKOFF_MS[Math.min(restartIdx, BACKOFF_MS.length - 1)];
    restartIdx++;
    restarts++;
    restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
  }

  // ── Main → host ──
  function sendOp(msg) {
    if (mode === 'inproc') {
      if (!core || !ready) { queue.push(msg); return; }
      core.handleMessage(msg);
      return;
    }
    if (!child || !ready || !child.connected) { queue.push(msg); return; }
    try { child.send(msg); } catch { queue.push(msg); }
  }

  function flushQueue() {
    const q = queue;
    queue = [];
    for (const msg of q) sendOp(msg);
  }

  function spawn(spec, h = {}) {
    handlers.set(spec.id, h);
    const w = makeWaiter();
    spawnWaiters.set(spec.id, w);
    sendOp({ op: OP.SPAWN, ...spec });
    return w.promise;
  }

  function whenSpawned(id) {
    return spawnWaiters.get(id)?.promise || Promise.reject(new Error('Session not found'));
  }

  function write(id, data) {
    if (typeof data !== 'string' || !data) return;
    sendOp({ op: OP.WRITE, id, data });
  }
  function resize(id, cols, rows) { sendOp({ op: OP.RESIZE, id, cols, rows }); }
  function kill(id, signal) { sendOp({ op: OP.KILL, id, signal }); }
  function setTap(id, on) { sendOp({ op: OP.TAP, id, on: !!on }); }

  function request(op, extra = {}, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      if (mode === 'fork' && (!child || !ready)) { reject(new Error('pty-host not ready')); return; }
      if (mode === 'inproc' && (!core || !ready)) { reject(new Error('pty-host not ready')); return; }
      const reqId = ++reqSeq;
      const timer = setTimeout(() => { requests.delete(reqId); reject(new Error('pty-host request timed out')); }, timeoutMs);
      requests.set(reqId, { resolve, reject, timer });
      sendOp({ op, reqId, ...extra });
    });
  }

  // ── WebSocket upgrade handoff ──
  // After this the main event loop never touches terminal bytes: the socket
  // handle moves to the host, which completes the WebSocket handshake itself.
  // Caveat: once any socket has been handed to a child, net.Server.close()
  // never invokes its callback (Node's per-child socket accounting). The
  // Neural Interface never closes its HTTP server; don't await close() on a
  // server that hands sockets off.
  function handoffUpgrade(req, socket, head, sessionId) {
    const msg = {
      op: OP.UPGRADE,
      sessionId,
      method: req.method,
      url: req.url,
      headers: pickHeaders(req.headers),
      head: head && head.length ? Buffer.from(head) : null,
    };
    if (mode === 'inproc') {
      if (!core || !ready) { hold(socket, () => core.handleUpgrade(msg, socket)); return; }
      core.handleUpgrade(msg, socket);
      return;
    }
    // Mandatory before a handle transfer: stop libuv reading on this side, or
    // bytes read here in the transfer window are lost.
    try {
      if (socket._handle) {
        socket._handle.readStop?.();
        socket._handle.reading = false;
      }
    } catch {}
    if (!child || !ready || !child.connected) { hold(socket, () => transfer(msg, socket)); return; }
    transfer(msg, socket);
  }

  function transfer(msg, socket) {
    if (socket.destroyed) return;
    if (!child || !child.connected) { try { socket.destroy(); } catch {} return; }
    try {
      if (socket.readableLength > 0) {
        const extra = socket.read();
        if (extra && extra.length) msg.head = msg.head ? Buffer.concat([msg.head, extra]) : extra;
      }
    } catch {}
    try {
      child.send(msg, socket, { keepOpen: false }, (err) => {
        if (err) { try { socket.destroy(); } catch {} }
      });
    } catch {
      try { socket.destroy(); } catch {}
    }
  }

  function hold(socket, run) {
    const entry = { socket, run, timer: null };
    entry.timer = setTimeout(() => {
      heldSockets = heldSockets.filter(e => e !== entry);
      try { socket.destroy(); } catch {}
    }, HOLD_SOCKET_MS);
    heldSockets.push(entry);
  }

  function releaseHeldSockets() {
    const list = heldSockets;
    heldSockets = [];
    for (const e of list) {
      clearTimeout(e.timer);
      try { e.run(); } catch { try { e.socket.destroy(); } catch {} }
    }
  }

  // ── node-pty-shaped proxy for server.js consumers ──
  function createProxy(id, { cols = 120, rows = 30 } = {}) {
    const proxy = {
      id,
      pid: undefined,
      cols,
      rows,
      exited: false,
      write(data) { if (!proxy.exited && data != null) write(id, typeof data === 'string' ? data : String(data)); },
      resize(c, r) { if (!proxy.exited) resize(id, c, r); },
      kill(signal) { if (!proxy.exited) kill(id, signal); },
      pause() {},
      resume() {},
    };
    return proxy;
  }

  // ── Stats / shutdown ──
  async function stats({ reset = false, detail = false } = {}) {
    const data = await request(OP.STATS, { reset, detail });
    return { ...data, mode, restarts };
  }

  async function shutdown({ timeoutMs = 1500 } = {}) {
    shuttingDown = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (mode === 'inproc') {
      try { core?.shutdownAll(); } catch {}
      return;
    }
    const c = child;
    if (!c) return;
    const exited = new Promise((r) => c.once('exit', r));
    try {
      await Promise.race([request(OP.SHUTDOWN, {}, timeoutMs), new Promise((r) => setTimeout(r, timeoutMs))]);
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, timeoutMs))]);
    try { c.kill('SIGTERM'); } catch {}
  }

  function killNow() {
    shuttingDown = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    try { child?.kill('SIGTERM'); } catch {}
    try { core?.shutdownAll(); } catch {}
  }

  return {
    start,
    spawn,
    whenSpawned,
    write,
    resize,
    kill,
    setTap,
    handoffUpgrade,
    createProxy,
    stats,
    shutdown,
    killNow,
    get mode() { return mode; },
    get ready() { return ready; },
    get ptyAvailable() { return ptyAvailable; },
    get ptyError() { return ptyError; },
    get restarts() { return restarts; },
    get hostPid() { return hostPid; },
  };
}

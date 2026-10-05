// pty-host core — owns every PTY session and its browser WebSockets.
//
// Runs inside the dedicated terminal process (host.js) so terminal keystrokes
// and output never wait on the main server's event loop (memory tools, hooks,
// Playwright, schedulers). The same core can run in-process
// (SYNABUN_PTY_HOST=inproc) — only the transport differs.
//
// Hot path per PTY chunk: coalesce for one event-loop turn → send one binary
// frame to each client → feed the headless model (snapshots) → tap to main
// only for sessions that need it (loop drivers, live links).

import { WebSocketServer } from 'ws';
import { writeFile, unlink } from 'node:fs/promises';
import { chmodSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createTerminalModel } from './snapshot.js';
import { evaluateFlow } from './flow.js';
import { EV, OP, HOST_DEFAULTS } from './protocol.js';
import { createEventLoopMonitor } from '../event-loop-monitor.js';

const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

const clampInt = (v, lo, hi) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};

export function createPtyHostCore({ send, config = {}, pty: injectedPty = null } = {}) {
  const cfg = { ...HOST_DEFAULTS, ...config };
  const sessions = new Map();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const loop = createEventLoopMonitor();
  const startedAt = Date.now();
  const counters = { bytesOut: 0, frames: 0, snapshots: 0, pauses: 0, demotions: 0, spawns: 0, exits: 0 };

  let pty = injectedPty;
  let ptyError = null;
  let shuttingDown = false;

  const emit = (msg) => { try { send(msg); } catch {} };

  // ── Startup ──
  async function init() {
    if (!pty) {
      try { pty = (await import('node-pty')).default; }
      catch (err) { ptyError = err.message; }
    }
    return { ptyAvailable: !!pty, ptyError };
  }

  const pingTimer = setInterval(() => {
    for (const s of sessions.values()) {
      for (const c of s.clients) {
        if (c.alive === false) { try { c.ws.terminate(); } catch {} continue; }
        c.alive = false;
        try { c.ws.ping(); } catch {}
      }
    }
  }, cfg.pingMs);
  pingTimer.unref?.();

  // ── Spawn ──
  function spawnSession(spec) {
    const { id } = spec;
    if (!id || sessions.has(id)) {
      emit({ t: EV.SPAWN_ERROR, id, message: 'Duplicate or missing session id' });
      return;
    }
    if (!pty) {
      emit({ t: EV.SPAWN_ERROR, id, message: `Terminal not available: node-pty failed to load (${ptyError || 'unknown'}). Run: cd neural-interface && npm run postinstall` });
      return;
    }
    const cols = clampInt(spec.cols, 2, 1000) || 120;
    const rows = clampInt(spec.rows, 1, 500) || 30;
    const env = { ...(spec.env || {}) };
    for (const k of Object.keys(env)) if (k.startsWith('NODE_CHANNEL_') || k === 'NODE_UNIQUE_ID') delete env[k];

    let file = spec.file;
    let args = Array.isArray(spec.args) ? spec.args : [];
    // Linux forkpty + execvp does not close inherited fds, so the host's IPC
    // channel (fd 3) would leak into every shell. macOS spawns with
    // POSIX_SPAWN_CLOEXEC_DEFAULT and needs no wrapper.
    if (IS_LINUX) {
      args = ['-c', 'exec 3>&-; exec "$@"', 'sh', file, ...args];
      file = '/bin/sh';
    }
    const opts = { name: spec.name || 'xterm-256color', cols, rows, cwd: spec.cwd, env, useConpty: IS_WIN };

    let proc;
    try {
      proc = pty.spawn(file, args, opts);
    } catch (err) {
      const msg = String(err?.message || err);
      if (!IS_WIN && (msg.includes('posix_spawn') || msg.includes('EACCES'))) {
        // npm/cpSync drop the execute bit on node-pty's spawn-helper. Fix once, retry once.
        try {
          const ptyBase = dirname(dirname(createRequire(import.meta.url).resolve('node-pty')));
          const helper = resolve(ptyBase, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
          if (existsSync(helper)) {
            chmodSync(helper, 0o755);
            proc = pty.spawn(file, args, opts);
          }
        } catch {}
      }
      if (!proc) {
        emit({ t: EV.SPAWN_ERROR, id, message: msg, code: 'spawn' });
        return;
      }
    }

    const s = {
      id,
      proc,
      model: createTerminalModel({ cols, rows, scrollback: cfg.snapshotScrollback }),
      profile: spec.profile || null,
      loopOwned: !!spec.loopOwned,
      tap: !!spec.tap,
      clients: new Set(),
      outputBytes: 0,
      coalesce: '',
      flushScheduled: false,
      tapBuf: '',
      tapTimer: null,
      pauseReasons: { flow: false, model: false },
      ptyPaused: false,
      pausedAt: 0,
      pausedWatch: null,
      resize: { last: null, timer: null, applied: { cols, rows }, appliedAt: 0 },
      tempFiles: [],
      graceTimer: null,
      exited: false,
    };
    sessions.set(id, s);
    counters.spawns++;

    proc.onData((data) => onPtyData(s, data));
    proc.onExit(({ exitCode, signal }) => onPtyExit(s, exitCode, signal));

    emit({ t: EV.SPAWNED, id, pid: proc.pid, cols, rows });
  }

  // ── Output path ──
  function onPtyData(s, data) {
    if (s.exited) return;
    s.coalesce += data;
    if (s.coalesce.length >= cfg.coalesceBurstBytes) { flush(s); return; }
    if (!s.flushScheduled) {
      s.flushScheduled = true;
      setImmediate(() => flush(s));
    }
  }

  function flush(s) {
    s.flushScheduled = false;
    if (!s.coalesce) return;
    const text = s.coalesce;
    s.coalesce = '';
    const payload = Buffer.from(text, 'utf8');
    s.outputBytes += payload.length;
    counters.bytesOut += payload.length;
    counters.frames++;

    for (const c of s.clients) deliver(s, c, payload);
    updateFlow(s);

    // Secondary consumers — after every client has its frame.
    s.model.write(text, () => {
      if (s.pauseReasons.model && s.model.pendingBytes < cfg.modelResumeBytes) setPause(s, 'model', false);
    });
    if (s.model.pendingBytes > cfg.modelPauseBytes) setPause(s, 'model', true);
    if (s.tap) queueTap(s, text);
  }

  function deliver(s, c, payload) {
    if (c.ws.readyState !== 1) return;
    if (c.pending) {
      c.pending.frames.push(payload);
      c.pending.bytes += payload.length;
      if (c.pending.bytes > cfg.pendingSnapshotCap) restartSnapshot(s, c);
      return;
    }
    if (c.lagging) return;
    if (c.ws.bufferedAmount > cfg.wsHighWater) { markLagging(s, c, 'buffer'); return; }
    if (c.flow && !c.visible && c.unacked > cfg.hiddenCap) { markLagging(s, c, 'hidden-cap'); return; }
    try { c.ws.send(payload); } catch { return; }
    if (c.flow) c.unacked += payload.length;
  }

  function queueTap(s, text) {
    s.tapBuf += text;
    if (s.tapBuf.length >= cfg.tapBatchBytes) { flushTap(s); return; }
    if (!s.tapTimer) s.tapTimer = setTimeout(() => flushTap(s), cfg.tapBatchMs);
  }

  function flushTap(s) {
    if (s.tapTimer) { clearTimeout(s.tapTimer); s.tapTimer = null; }
    if (!s.tapBuf) return;
    const data = s.tapBuf;
    s.tapBuf = '';
    emit({ t: EV.TAP, id: s.id, data });
  }

  // ── Snapshots (connect + resync) ──
  // Precondition: the session was flushed while this client received nothing
  // (not yet in s.clients, or lagging). Everything written to the model before
  // the barrier is in the snapshot; every frame after it is queued in
  // c.pending and replayed after the snapshot — no duplicates, no gaps.
  function beginSnapshot(s, c) {
    const token = {};
    c.pending = { frames: [], bytes: 0, token };
    s.model.barrier(() => finishSnapshot(s, c, token));
  }

  function restartSnapshot(s, c) {
    // The queue outgrew the cap while the model caught up: fold it into a new
    // snapshot instead (its bytes are already in the model).
    beginSnapshot(s, c);
  }

  function finishSnapshot(s, c, token) {
    if (!c.pending || c.pending.token !== token) return;
    if (c.ws.readyState !== 1) { c.pending = null; return; }
    let snap;
    try { snap = s.model.serialize(); } catch { snap = { ansi: '', plain: '', cols: s.model.cols, rows: s.model.rows }; }
    const frames = c.pending.frames;
    c.pending = null;
    clearLagState(c);
    c.lagging = null;
    c.unacked = 0;
    try {
      c.ws.send(JSON.stringify({ type: 'snapshot', data: snap.ansi, plain: snap.plain, reset: true, cols: snap.cols, rows: snap.rows }));
      counters.snapshots++;
    } catch { return; }
    for (const f of frames) deliver(s, c, f);
    updateFlow(s);
  }

  function resync(s, c) {
    if (c.pending || c.ws.readyState !== 1) return;
    flush(s); // c is lagging → receives nothing from this flush
    beginSnapshot(s, c);
  }

  function markLagging(s, c, reason) {
    if (c.lagging) return;
    c.lagging = reason;
    counters.demotions++;
    if (reason === 'buffer') {
      const tryResync = () => {
        if (c.ws.readyState !== 1) { clearLagState(c); return; }
        if (c.ws.bufferedAmount > cfg.wsLowWater) return;
        clearLagState(c);
        resync(s, c);
      };
      const sock = c.ws._socket;
      if (sock?.on) { c.drainHandler = tryResync; sock.on('drain', tryResync); }
      c.lagTimer = setInterval(tryResync, cfg.drainFallbackMs);
    }
    // 'hidden-cap' resyncs on visibility:true; 'stall' on the next ack or visibility.
  }

  function clearLagState(c) {
    if (c.lagTimer) { clearInterval(c.lagTimer); c.lagTimer = null; }
    if (c.drainHandler && c.ws._socket) { try { c.ws._socket.off('drain', c.drainHandler); } catch {} }
    c.drainHandler = null;
  }

  // ── Flow control ──
  function updateFlow(s) {
    if (s.exited) return;
    const views = [...s.clients].map(c => ({
      ref: c, flow: c.flow, lagging: c.lagging, pending: c.pending, open: c.ws.readyState === 1,
      visible: c.visible, unacked: c.unacked, lastAckAt: c.lastAckAt,
    }));
    const { pause, demote } = evaluateFlow({
      clients: views, loopOwned: s.loopOwned, paused: s.pauseReasons.flow, pausedAt: s.pausedAt, now: Date.now(), cfg,
    });
    for (const d of demote) markLagging(s, d.client.ref, d.reason);
    setPause(s, 'flow', pause);
  }

  function setPause(s, reason, on) {
    s.pauseReasons[reason] = on;
    // Once the child is dead or being killed, never pause again: node-pty only
    // reports the exit after it has drained the socket.
    const want = !s.exited && !s.draining && (s.pauseReasons.flow || s.pauseReasons.model);
    if (want && !s.ptyPaused) {
      s.ptyPaused = true;
      s.pausedAt = Date.now();
      counters.pauses++;
      try { s.proc.pause(); } catch {}
      // While paused: resume if the child died (node-pty only reports exit after
      // draining its socket), and run the stall watchdog.
      s.pausedWatch = setInterval(() => {
        const pid = s.proc?.pid;
        let alive = true;
        if (pid && !IS_WIN) { try { process.kill(pid, 0); } catch (e) { alive = e?.code === 'EPERM'; } }
        if (!alive) { s.draining = true; setPause(s, 'flow', false); return; }
        if (s.pauseReasons.flow) updateFlow(s);
      }, cfg.pausedWatchMs);
      s.pausedWatch.unref?.();
    } else if (!want && s.ptyPaused) {
      s.ptyPaused = false;
      if (s.pausedWatch) { clearInterval(s.pausedWatch); s.pausedWatch = null; }
      try { s.proc.resume(); } catch {}
    }
  }

  // ── Resize ──
  function queueResize(s, colsIn, rowsIn) {
    const cols = clampInt(colsIn, 2, 1000);
    const rows = clampInt(rowsIn, 1, 500);
    if (!cols || !rows || s.exited) return;
    s.resize.last = { cols, rows };
    if (s.resize.timer) return; // the pending trailing apply picks up the latest size
    if (!s.resize.appliedAt || Date.now() - s.resize.appliedAt >= cfg.resizeThrottleMs) applyResize(s);
    else s.resize.timer = setTimeout(() => applyResize(s), cfg.resizeThrottleMs);
  }

  function applyResize(s) {
    s.resize.timer = null;
    const r = s.resize.last;
    if (!r || s.exited) return;
    const a = s.resize.applied;
    if (a && a.cols === r.cols && a.rows === r.rows) return;
    s.resize.applied = { cols: r.cols, rows: r.rows };
    s.resize.appliedAt = Date.now();
    flush(s); // parse pending output under the OLD geometry first
    s.model.resize(r.cols, r.rows);
    try { s.proc.resize(r.cols, r.rows); } catch {}
    emit({ t: EV.RESIZED, id: s.id, cols: r.cols, rows: r.rows });
  }

  // ── Clients ──
  function handleUpgrade(msg, socket) {
    const req = { method: msg.method || 'GET', url: msg.url || '/', headers: msg.headers || {}, socket };
    const head = msg.head ? Buffer.from(msg.head) : Buffer.alloc(0);
    try {
      wss.handleUpgrade(req, socket, head, (ws) => attachClient(msg.sessionId, ws));
    } catch {
      try { socket.destroy(); } catch {}
    }
  }

  function attachClient(sessionId, ws) {
    const s = sessions.get(sessionId);
    if (!s || s.exited || shuttingDown) {
      try { ws.send(JSON.stringify({ type: 'error', message: 'Session not found' })); } catch {}
      try { ws.close(); } catch {}
      return;
    }
    if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = null; }

    // Flush BEFORE the client joins: pending bytes go to the model (and so into
    // the snapshot), never to this client as a stray pre-snapshot frame.
    flush(s);
    const c = {
      ws, flow: false, visible: true, unacked: 0, lastAckAt: 0,
      lagging: null, pending: null, alive: true, lagTimer: null, drainHandler: null,
    };
    s.clients.add(c);
    beginSnapshot(s, c);
    emitClients(s);

    ws.on('pong', () => { c.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      onClientMessage(s, c, m);
    });
    ws.on('close', () => {
      clearLagState(c);
      s.clients.delete(c);
      if (s.exited) return;
      updateFlow(s);
      emitClients(s);
      if (s.clients.size === 0 && !s.graceTimer) {
        s.graceTimer = setTimeout(() => {
          s.graceTimer = null;
          if (s.clients.size === 0 && !s.exited) killSession(s);
        }, cfg.graceMs);
        s.graceTimer.unref?.();
      }
    });
  }

  function onClientMessage(s, c, m) {
    if (s.exited) return;
    switch (m?.type) {
      case 'input':
        if (typeof m.data === 'string' && m.data) { try { s.proc.write(m.data); } catch {} }
        break;
      case 'resize':
        queueResize(s, m.cols, m.rows);
        break;
      case 'hello':
        c.flow = m.flow === 1 || m.flow === true;
        updateFlow(s);
        break;
      case 'ack': {
        const n = Number(m.bytes);
        if (Number.isFinite(n) && n > 0) c.unacked = Math.max(0, c.unacked - n);
        c.lastAckAt = Date.now();
        if (c.lagging === 'stall') resync(s, c);
        else updateFlow(s);
        break;
      }
      case 'visibility':
        c.visible = !!m.visible;
        if (c.visible && (c.lagging === 'hidden-cap' || c.lagging === 'stall')) resync(s, c);
        else updateFlow(s);
        emitClients(s);
        break;
      case 'image_paste':
      case 'image_drop':
      case 'memory_drop':
        saveDrop(s, c, m);
        break;
      default:
        break;
    }
  }

  async function saveDrop(s, c, m) {
    const imagesDir = cfg.imagesDir;
    const reply = (obj) => { try { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); } catch {} };
    if (!imagesDir) { reply({ type: 'error', message: 'Drop failed: no images directory' }); return; }
    try {
      if (m.type === 'memory_drop') {
        if (!m.content) return;
        const slug = String(m.title || 'memory').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
        const path = join(imagesDir, `synabun-${slug}-${Date.now()}.md`);
        await writeFile(path, String(m.content), 'utf-8');
        s.tempFiles.push(path);
        reply({ type: 'memory_saved', path });
        return;
      }
      if (!m.data) return;
      const ext = m.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const kind = m.type === 'image_paste' ? 'paste' : 'wbimg';
      const path = join(imagesDir, `synabun-${kind}-${s.id}-${Date.now()}.${ext}`);
      await writeFile(path, Buffer.from(String(m.data), 'base64'));
      s.tempFiles.push(path);
      reply({ type: m.type === 'image_paste' ? 'image_saved' : 'image_dropped', path });
    } catch (err) {
      const label = m.type === 'image_paste' ? 'Image paste' : m.type === 'image_drop' ? 'Image drop' : 'Memory drop';
      reply({ type: 'error', message: `${label} failed: ${err.message}` });
    }
  }

  function emitClients(s) {
    let visible = 0, flow = 0;
    for (const c of s.clients) { if (c.visible) visible++; if (c.flow) flow++; }
    emit({ t: EV.CLIENTS, id: s.id, total: s.clients.size, visible, flow });
  }

  // ── Exit / kill ──
  function onPtyExit(s, exitCode, signal) {
    if (s.exitHandled) return;
    s.exitHandled = true;
    s.draining = true;
    counters.exits++;
    if (s.pausedWatch) { clearInterval(s.pausedWatch); s.pausedWatch = null; }
    s.ptyPaused = false;
    // Final bytes first — to clients, the model and the tap — then the exit.
    flush(s);
    s.exited = true;
    flushTap(s);
    emit({ t: EV.EXIT, id: s.id, exitCode, signal: signal ?? null });
    // Pending snapshots were queued on the model before this barrier, so they
    // go out before the exit message.
    s.model.barrier(() => {
      const msg = JSON.stringify({ type: 'exit', exitCode });
      for (const c of s.clients) { try { if (c.ws.readyState === 1) c.ws.send(msg); } catch {} }
      cleanupSession(s);
    });
  }

  function cleanupSession(s) {
    if (s.pausedWatch) { clearInterval(s.pausedWatch); s.pausedWatch = null; }
    if (s.graceTimer) { clearTimeout(s.graceTimer); s.graceTimer = null; }
    if (s.resize.timer) { clearTimeout(s.resize.timer); s.resize.timer = null; }
    if (s.tapTimer) { clearTimeout(s.tapTimer); s.tapTimer = null; }
    for (const c of s.clients) clearLagState(c);
    for (const f of s.tempFiles.splice(0)) unlink(f).catch(() => {});
    try { s.model.dispose(); } catch {}
    sessions.delete(s.id);
  }

  function killSession(s, signal) {
    if (!s || s.exited) return;
    try { IS_WIN ? s.proc.kill() : s.proc.kill(signal || undefined); } catch {}
    // A paused PTY must drain for node-pty to report the exit.
    s.draining = true;
    setPause(s, 'flow', false);
  }

  // ── Main-process messages ──
  function handleMessage(msg, handle) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.op) {
      case OP.SPAWN: spawnSession(msg); break;
      case OP.WRITE: {
        const s = sessions.get(msg.id);
        if (s && !s.exited && typeof msg.data === 'string') { try { s.proc.write(msg.data); } catch {} }
        break;
      }
      case OP.RESIZE: { const s = sessions.get(msg.id); if (s) queueResize(s, msg.cols, msg.rows); break; }
      case OP.KILL: killSession(sessions.get(msg.id), msg.signal); break;
      case OP.TAP: {
        const s = sessions.get(msg.id);
        if (!s) break;
        const on = !!msg.on;
        if (on === s.tap) break;
        if (!on) flushTap(s);
        s.tap = on;
        break;
      }
      case OP.UPGRADE:
        if (handle) handleUpgrade(msg, handle);
        break;
      case OP.STATS:
        emit({ t: EV.REPLY, reqId: msg.reqId, ok: true, data: stats({ reset: !!msg.reset, detail: !!msg.detail }) });
        break;
      case OP.PING:
        emit({ t: EV.REPLY, reqId: msg.reqId, ok: true, data: { pong: Date.now() } });
        break;
      case OP.SHUTDOWN:
        shutdownAll();
        emit({ t: EV.REPLY, reqId: msg.reqId, ok: true, data: { shutdown: true } });
        break;
      default:
        break;
    }
  }

  function stats({ reset = false, detail = false } = {}) {
    let clients = 0, paused = 0;
    for (const s of sessions.values()) { clients += s.clients.size; if (s.ptyPaused) paused++; }
    const out = {
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      sessions: sessions.size,
      clients,
      pausedSessions: paused,
      counters: { ...counters },
      loop: loop.snapshot({ reset }),
    };
    if (detail) {
      const now = Date.now();
      out.detail = [...sessions.values()].map(s => ({
        id: s.id,
        paused: s.ptyPaused,
        pauseReasons: { ...s.pauseReasons },
        pausedForMs: s.ptyPaused ? now - s.pausedAt : 0,
        modelPendingBytes: s.model.pendingBytes,
        outputBytes: s.outputBytes,
        clients: [...s.clients].map(c => ({
          flow: c.flow, visible: c.visible, unacked: c.unacked, lagging: c.lagging,
          pending: c.pending ? c.pending.bytes : null,
          sinceAckMs: c.lastAckAt ? now - c.lastAckAt : null,
          buffered: c.ws.bufferedAmount,
        })),
      }));
    }
    return out;
  }

  function shutdownAll() {
    shuttingDown = true;
    for (const s of sessions.values()) {
      s.draining = true;
      try { IS_WIN ? s.proc.kill() : s.proc.kill('SIGHUP'); } catch {}
      try { s.proc.resume(); } catch {}
    }
    for (const s of sessions.values()) {
      for (const c of s.clients) { try { c.ws.close(1001, 'terminal host shutting down'); } catch {} }
    }
  }

  function dispose() {
    shutdownAll();
    clearInterval(pingTimer);
    loop.stop();
    try { wss.close(); } catch {}
  }

  return {
    init,
    handleMessage,
    handleUpgrade,
    stats,
    shutdownAll,
    dispose,
    get sessionCount() { return sessions.size; },
    // Test/diagnostic access.
    _sessions: sessions,
  };
}

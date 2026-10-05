// pty-host end-to-end: real PTYs, real WebSocket upgrades through the same
// handoff the Neural Interface server uses, in both transports (forked child
// with socket handoff, and the in-process kill-switch mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { createPtyHostManager } from '../lib/pty-host/manager.js';
import { createPtyHostCore } from '../lib/pty-host/core.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SHELL = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
const baseEnv = () => ({ ...process.env, PS1: '$ ', PROMPT: '$ ', TERM: 'xterm-256color' });

// The [fork] and [inproc] cases drive real PTYs, so they need node-pty's native
// module. It ships prebuilt for macOS and Windows only: an install that runs no
// build scripts on Linux (CI) cannot load it. Ask the host core, which loads it
// the way the product does at startup, and skip those cases with the reason
// when it cannot; everywhere it loads they run.
const probe = createPtyHostCore({ send() {} });
const { ptyAvailable, ptyError } = await probe.init();
probe.dispose();
const needsPty = ptyAvailable ? {} : {
  skip: `node-pty cannot load on this machine (${String(ptyError || 'unknown').split('\n')[0].trim()})`,
};

async function waitFor(pred, { timeout = 8000, interval = 10, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startHarness(t, { mode = 'fork', config = {} } = {}) {
  const imagesDir = mkdtempSync(join(tmpdir(), 'synabun-ptyhost-'));
  const mgr = createPtyHostManager({ mode, config: { imagesDir, ...config }, log: { warn() {}, log() {} } });
  mgr.start();
  const srv = createServer((req, res) => res.end('ok'));
  srv.on('upgrade', (req, socket, head) => {
    const id = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace('/ws/terminal/', ''));
    mgr.handoffUpgrade(req, socket, head, id);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const clients = new Set();
  t.after(async () => {
    for (const c of clients) { try { c.ws.terminate(); } catch {} }
    await mgr.shutdown({ timeoutMs: 1000 });
    // Once a socket has been handed to a child, net.Server.close() never calls
    // back (Node's worker-socket accounting) — close without waiting.
    srv.close();
    srv.unref();
    rmSync(imagesDir, { recursive: true, force: true });
  });

  let seq = 0;
  function spawn(spec = {}, handlers = {}) {
    const id = spec.id || `s${Date.now().toString(36)}${++seq}`;
    const events = { exits: [], resized: [], clients: [], taps: [] };
    const promise = mgr.spawn({
      id, file: spec.file || SHELL, args: spec.args || ['-f'], cwd: spec.cwd || tmpdir(),
      env: spec.env || baseEnv(), cols: spec.cols || 80, rows: spec.rows || 24, name: 'xterm-256color',
      tap: !!spec.tap, loopOwned: !!spec.loopOwned, profile: spec.profile || 'shell',
    }, {
      onExit: (m) => { events.exits.push(m); handlers.onExit?.(m); },
      onResized: (m) => events.resized.push(m),
      onClients: (m) => events.clients.push(m),
      onTap: (d) => events.taps.push(d),
      onSpawned: (m) => handlers.onSpawned?.(m),
    });
    return { id, promise, events };
  }

  function connect(id, { hello = true, visible = true, autoAck = false } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${encodeURIComponent(id)}`);
      ws.binaryType = 'nodebuffer';
      const c = { ws, msgs: [], binBytes: 0, text: '' };
      clients.add(c);
      ws.on('message', (d, isBin) => {
        if (isBin) {
          c.msgs.push({ bin: d });
          c.binBytes += d.length;
          c.text += d.toString('utf8');
          if (autoAck) ws.send(JSON.stringify({ type: 'ack', bytes: d.length }));
        } else {
          const m = JSON.parse(d.toString());
          c.msgs.push(m);
          if (m.type === 'snapshot') c.text += m.plain || '';
        }
      });
      ws.on('open', () => {
        if (hello) ws.send(JSON.stringify({ type: 'hello', flow: 1 }));
        if (!visible) ws.send(JSON.stringify({ type: 'visibility', visible: false }));
        resolve(c);
      });
      ws.on('error', reject);
    });
  }
  const send = (c, m) => c.ws.send(JSON.stringify(m));
  return { mgr, port, spawn, connect, send, imagesDir };
}

for (const mode of ['fork', 'inproc']) {
  test(`[${mode}] snapshot first, keystroke echo, colors survive reconnect, exit ordering`, needsPty, async (t) => {
    const h = await startHarness(t, { mode });
    const s = h.spawn();
    const spawned = await s.promise;
    assert.ok(spawned.pid > 0);
    const a = await h.connect(s.id, { autoAck: true });
    await waitFor(() => a.msgs.length > 0, { label: 'first frame' });
    assert.equal(a.msgs[0].type, 'snapshot', 'first frame of a connection is the snapshot');
    assert.equal(a.msgs[0].reset, true);

    const lat = [];
    for (const ch of 'qwertyuiop') {
      const from = a.text.length;
      const t0 = performance.now();
      h.send(a, { type: 'input', data: ch });
      await waitFor(() => a.text.slice(from).includes(ch), { interval: 1, label: `echo ${ch}` });
      lat.push(performance.now() - t0);
    }
    lat.sort((x, y) => x - y);
    assert.ok(lat[4] < 50, `median echo ${lat[4].toFixed(2)} ms`);

    h.send(a, { type: 'input', data: '\x15printf "\\033[1;31m%s\\033[0m\\n" "RE""D"\r' });
    await waitFor(() => a.text.includes('RED'), { label: 'colored output' });
    const b = await h.connect(s.id);
    await waitFor(() => b.msgs.length > 0, { label: 'reconnect snapshot' });
    const snap = b.msgs[0];
    assert.equal(snap.type, 'snapshot');
    assert.match(snap.data, /\x1b\[[0-9;]*31[0-9;]*m/, 'the reconnect snapshot keeps SGR colors');
    assert.ok(snap.plain.includes('RED'));
    assert.equal(snap.cols, 80);

    h.send(a, { type: 'input', data: "printf 'TA''IL'; exit 3\r" });
    await waitFor(() => s.events.exits.length === 1, { label: 'exit event' });
    assert.equal(s.events.exits[0].exitCode, 3);
    await waitFor(() => a.msgs.some(m => m.type === 'exit'), { label: 'client exit message' });
    const exitIdx = a.msgs.findIndex(m => m.type === 'exit');
    const tailIdx = a.msgs.findIndex(m => m.bin && m.bin.toString('utf8').includes('TAIL'));
    assert.ok(tailIdx >= 0 && tailIdx < exitIdx, 'final output precedes the exit message');
    assert.equal(a.msgs[exitIdx].exitCode, 3);
  });

  test(`[${mode}] a client connecting mid-stream ends in the same state as one connected from the start`, needsPty, async (t) => {
    const h = await startHarness(t, { mode });
    const s = h.spawn({ cols: 60, rows: 12 });
    await s.promise;
    const early = await h.connect(s.id, { autoAck: true });
    await waitFor(() => early.msgs.length > 0);
    h.send(early, { type: 'input', data: 'i=0; while [ $i -lt 30000 ]; do echo "line $i"; i=$((i+1)); done; echo STREAM_"DONE"\r' });
    await waitFor(() => early.text.includes('line 5000'), { timeout: 15000, label: 'stream underway' });
    const late = await h.connect(s.id, { autoAck: true });
    await waitFor(() => early.text.includes('STREAM_DONE') && late.text.includes('STREAM_DONE'), { timeout: 30000, label: 'stream done' });
    await sleep(100);

    const render = async (c) => {
      const t2 = new Terminal({ cols: 60, rows: 12, scrollback: 1000, allowProposedApi: true, logLevel: 'off' });
      t2.loadAddon(new Unicode11Addon());
      t2.unicode.activeVersion = '11';
      for (const m of c.msgs) {
        if (m.type === 'snapshot') await new Promise(r => t2.write('\x1bc' + m.data, r));
        else if (m.bin) await new Promise(r => t2.write(m.bin, r));
      }
      const buf = t2.buffer.active;
      const lines = [];
      for (let i = Math.max(0, buf.length - 400); i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
      return lines;
    };
    const lateSnapshots = late.msgs.filter(m => m.type === 'snapshot').length;
    assert.equal(late.msgs[0].type, 'snapshot');
    assert.equal(lateSnapshots, 1, 'one snapshot, then only live frames');
    assert.deepEqual(await render(late), await render(early), 'no gap and no duplicated bytes at the join');
  });

  test(`[${mode}] resize is applied once, drops land in the images dir and are removed on exit, unknown ids are rejected`, needsPty, async (t) => {
    const h = await startHarness(t, { mode });
    const s = h.spawn();
    await s.promise;
    const a = await h.connect(s.id);
    await waitFor(() => a.msgs.length > 0);
    h.send(a, { type: 'resize', cols: 100, rows: 30 });
    h.send(a, { type: 'resize', cols: 100, rows: 30 });
    await waitFor(() => s.events.resized.length >= 1, { label: 'resize' });
    await sleep(150);
    assert.equal(s.events.resized.length, 1, 'no-op resizes are skipped');
    assert.deepEqual([s.events.resized[0].cols, s.events.resized[0].rows], [100, 30]);

    h.send(a, { type: 'image_paste', data: Buffer.from('fake-png').toString('base64'), mimeType: 'image/png' });
    await waitFor(() => a.msgs.some(m => m.type === 'image_saved'), { label: 'image_saved' });
    const saved = a.msgs.find(m => m.type === 'image_saved').path;
    assert.ok(saved.startsWith(h.imagesDir) && existsSync(saved));
    h.send(a, { type: 'memory_drop', title: 'note', content: '# hello' });
    await waitFor(() => a.msgs.some(m => m.type === 'memory_saved'), { label: 'memory_saved' });

    h.send(a, { type: 'input', data: 'exit\r' });
    await waitFor(() => s.events.exits.length === 1, { label: 'exit' });
    await waitFor(() => !existsSync(saved), { label: 'temp file cleanup' });

    const ghost = await h.connect('does-not-exist');
    await waitFor(() => ghost.msgs.length > 0, { label: 'error frame' });
    assert.deepEqual(ghost.msgs[0], { type: 'error', message: 'Session not found' });
  });

  test(`[${mode}] output tap reaches the main process only while enabled`, needsPty, async (t) => {
    const h = await startHarness(t, { mode });
    const s = h.spawn({ tap: true });
    await s.promise;
    h.mgr.write(s.id, 'echo TAP_MARKER_"ONE"\r');
    await waitFor(() => s.events.taps.join('').includes('TAP_MARKER_ONE'), { label: 'tap data' });
    h.mgr.setTap(s.id, false);
    await sleep(50);
    const before = s.events.taps.join('').length;
    h.mgr.write(s.id, 'echo TAP_MARKER_"TWO"\r');
    await sleep(300);
    assert.ok(!s.events.taps.join('').slice(before).includes('TAP_MARKER_TWO'), 'no tap after it is switched off');
    h.mgr.kill(s.id);
    await waitFor(() => s.events.exits.length === 1, { label: 'exit after kill' });
  });
}

test('[fork] flow control: a visible client that stops acking pauses the PTY; acks resume it', needsPty, async (t) => {
  const h = await startHarness(t, { mode: 'fork', config: { flowHigh: 64 * 1024, flowLow: 16 * 1024, flowStallMs: 60_000 } });
  const s = h.spawn();
  await s.promise;
  const c = await h.connect(s.id);
  await waitFor(() => c.msgs.length > 0);
  h.send(c, { type: 'input', data: 'head -c 30000000 /dev/zero | tr "\\0" x; echo; echo FLOOD_"DONE"\r' });
  await sleep(800);
  const plateau = c.binBytes;
  await sleep(400);
  assert.ok(c.binBytes - plateau < 256 * 1024, `output must stop while unacked (grew ${c.binBytes - plateau} bytes)`);
  assert.ok(c.binBytes < 2 * 1024 * 1024, `received ${c.binBytes} bytes without acking`);
  const stats = await h.mgr.stats();
  assert.equal(stats.pausedSessions, 1);

  // Ack everything as it arrives → the flood completes.
  let acked = 0;
  const ackLoop = setInterval(() => {
    const n = c.binBytes - acked;
    if (n > 0) { acked += n; h.send(c, { type: 'ack', bytes: n }); }
  }, 5);
  t.after(() => clearInterval(ackLoop));
  await waitFor(() => c.text.includes('FLOOD_DONE'), { timeout: 60000, label: 'flood completes once acked' });
  clearInterval(ackLoop);
  h.mgr.kill(s.id);
});

test('[fork] hidden clients never pause the PTY and are resynced by snapshot when visible again', needsPty, async (t) => {
  const h = await startHarness(t, { mode: 'fork', config: { flowHigh: 32 * 1024, flowLow: 8 * 1024, hiddenCap: 256 * 1024 } });
  const s = h.spawn();
  await s.promise;
  const c = await h.connect(s.id, { visible: false });
  await waitFor(() => c.msgs.length > 0);
  h.send(c, { type: 'input', data: 'head -c 8000000 /dev/zero | tr "\\0" y; echo; echo HIDDEN_"DONE"\r' });
  // The PTY runs to completion although this client never acks.
  const probe = await h.connect(s.id, { hello: false });
  await waitFor(() => probe.text.includes('HIDDEN_DONE'), { timeout: 60000, label: 'producer finishes while the flow client is hidden' });
  assert.ok(c.binBytes <= 256 * 1024 + 200 * 1024, `hidden client stops receiving near the cap (${c.binBytes})`);
  const snapshotsBefore = c.msgs.filter(m => m.type === 'snapshot').length;
  h.send(c, { type: 'visibility', visible: true });
  await waitFor(() => c.msgs.filter(m => m.type === 'snapshot').length === snapshotsBefore + 1, { label: 'resync snapshot' });
  const last = c.msgs.filter(m => m.type === 'snapshot').at(-1);
  assert.ok(last.plain.includes('HIDDEN_DONE'), 'the resync snapshot carries the current screen');
  h.mgr.kill(s.id);
});

test('[fork] stall watchdog frees a PTY stuck behind a visible client that stopped acking; loop-owned never pause', needsPty, async (t) => {
  const h = await startHarness(t, { mode: 'fork', config: { flowHigh: 32 * 1024, flowLow: 8 * 1024, flowStallMs: 300 } });
  const s = h.spawn();
  await s.promise;
  const c = await h.connect(s.id);
  await waitFor(() => c.msgs.length > 0);
  const probe = await h.connect(s.id, { hello: false });
  h.send(c, { type: 'input', data: 'head -c 4000000 /dev/zero | tr "\\0" z; echo; echo STALL_"DONE"\r' });
  await waitFor(() => probe.text.includes('STALL_DONE'), { timeout: 30000, label: 'stalled client demoted, producer finishes' });
  h.send(c, { type: 'ack', bytes: 1 });
  await waitFor(() => c.msgs.filter(m => m.type === 'snapshot').length >= 2, { label: 'demoted client resynced on ack' });

  const loop = h.spawn({ loopOwned: true, tap: true });
  await loop.promise;
  const lc = await h.connect(loop.id);
  await waitFor(() => lc.msgs.length > 0);
  h.mgr.write(loop.id, 'head -c 3000000 /dev/zero | tr "\\0" w; echo; echo LOOP_"DONE"\r');
  await waitFor(() => loop.events.taps.join('').includes('LOOP_DONE'), { timeout: 30000, label: 'loop-owned session never pauses for the UI' });
  h.mgr.kill(s.id);
  h.mgr.kill(loop.id);
});

test('[fork] 30 sockets opened at once lose no input across the handoff', needsPty, async (t) => {
  const h = await startHarness(t, { mode: 'fork' });
  const s = h.spawn({ file: '/bin/cat', args: [] });
  await s.promise;
  const socks = await Promise.all(Array.from({ length: 30 }, () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/terminal/${s.id}`);
    ws.binaryType = 'nodebuffer';
    const c = { ws, text: '' };
    ws.on('message', (d, isBin) => { if (isBin) c.text += d.toString('utf8'); });
    ws.on('open', () => {
      // Input sent the instant the socket opens must survive the handle transfer.
      for (let j = 0; j < 5; j++) ws.send(JSON.stringify({ type: 'input', data: `m${ws._idx ?? ''}` }));
      resolve(c);
    });
    ws.on('error', reject);
  })));
  const markers = socks.map((c, i) => `K${i}Z`);
  socks.forEach((c, i) => c.ws.send(JSON.stringify({ type: 'input', data: markers[i] + '\r' })));
  await waitFor(() => socks.every(c => markers.every(m => c.text.includes(m))), { timeout: 15000, label: 'every client sees every marker' });
  for (const c of socks) c.ws.terminate();
  h.mgr.kill(s.id);
});

test('[fork] host crash: sessions report pty-host-exit, the host restarts, old ids are gone', needsPty, async (t) => {
  const h = await startHarness(t, { mode: 'fork' });
  const s = h.spawn();
  await s.promise;
  const pid = h.mgr.hostPid;
  assert.ok(pid > 0);
  process.kill(pid, 'SIGKILL');
  await waitFor(() => s.events.exits.length === 1, { label: 'synthesized exit' });
  assert.equal(s.events.exits[0].reason, 'pty-host-exit');
  assert.equal(s.events.exits[0].exitCode, -1);
  await waitFor(() => h.mgr.ready && h.mgr.hostPid && h.mgr.hostPid !== pid, { label: 'restarted host' });
  assert.equal(h.mgr.restarts, 1);
  const s2 = h.spawn();
  assert.ok((await s2.promise).pid > 0, 'spawning works after the restart');
  const ghost = await h.connect(s.id);
  await waitFor(() => ghost.msgs.length > 0);
  assert.equal(ghost.msgs[0].message, 'Session not found');
  h.mgr.kill(s2.id);
});

test('[fork] shutdown hangs up every PTY without running main-side exit effects', needsPty, async (t) => {
  const h = await startHarness(t, { mode: 'fork' });
  const s = h.spawn();
  const { pid } = await s.promise;
  await h.mgr.shutdown({ timeoutMs: 1500 });
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { label: 'shell gone' });
  assert.equal(s.events.exits.length, 0, 'exit effects are suppressed during shutdown');
});

test('spawn errors are reported instead of thrown, and a failed spawn rejects whenSpawned', async () => {
  const events = [];
  const core = createPtyHostCore({ send: (m) => events.push(m), pty: { spawn() { throw new Error('boom: no such shell'); } } });
  await core.init();
  core.handleMessage({ op: 'spawn', id: 'x1', file: '/nope', args: [], env: {}, cols: 80, rows: 24 });
  assert.deepEqual(events.map(e => e.t), ['spawn-error']);
  assert.match(events[0].message, /boom/);
  core.dispose();

  const mgr = createPtyHostManager({ mode: 'inproc', log: { warn() {} } });
  mgr.start();
  const exits = [];
  const p = mgr.spawn({ id: 'bad', file: '/definitely/not/a/shell', args: [], env: {}, cols: 80, rows: 24 }, { onExit: (m) => exits.push(m) });
  const outcome = await p.then(() => 'spawned', (err) => err.message);
  if (outcome === 'spawned') {
    await waitFor(() => exits.length === 1, { label: 'bad shell exits' });
    assert.notEqual(exits[0].exitCode, 0);
  } else {
    assert.ok(outcome.length > 0);
    assert.equal(exits[0]?.reason, 'spawn-error');
  }
  await mgr.shutdown();
});

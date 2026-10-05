import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import { connectClaudeSkin, ENGINE_UNAVAILABLE } from '../lib/claude-skin-connect.js';

// Timers on the paths these tests wait for are unref'd on purpose, so a pending
// call never holds the server open. With nothing else on the loop Node 22
// drains it before they fire, and the remaining tests of the file are cancelled
// with "Promise resolution is still pending but the event loop has already
// resolved". Hold the loop open for the length of the file.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

// A /ws/claude-skin connection gets the SDK bridge or a refusal the panel can
// show: there is no other engine. (It used to fall through to a per-turn engine
// whenever the bridge was missing, and that fallback took the server down. That
// engine and its kill-switch are gone; these tests keep the socket from ever
// being left without an answer.)

function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  return ws;
}
const client = (ws, msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)), false);

function fakeBridge() {
  const bridge = { received: [], sockets: [] };
  bridge.createClaudeBridge = (ws) => {
    bridge.sockets.push(ws);
    ws.send(JSON.stringify({ type: 'engine', engine: 'sdk' }));
    ws.on('message', (raw) => bridge.received.push(JSON.parse(raw.toString())));
  };
  return bridge;
}

test('a ready bridge gets the socket, and nothing else does', async () => {
  const ws = fakeSocket();
  const bridge = fakeBridge();
  const outcome = await connectClaudeSkin(ws, { bridgeReady: Promise.resolve(), getBridge: () => bridge });
  assert.equal(outcome, 'sdk');
  assert.deepEqual(ws.sent, [{ type: 'engine', engine: 'sdk' }]);
  client(ws, { type: 'query', prompt: 'hi' });
  assert.deepEqual(bridge.received, [{ type: 'query', prompt: 'hi' }]);
  assert.equal(ws.listenerCount('message'), 1, 'the holding listener is gone');
});

test('a connection that arrives before the bridge import settles waits for it', async () => {
  const ws = fakeSocket();
  const bridge = fakeBridge();
  let loaded = null;
  let settle;
  const bridgeReady = new Promise((resolve) => { settle = resolve; });
  const pending = connectClaudeSkin(ws, { bridgeReady, getBridge: () => loaded });
  // The panel sends its reattach as soon as the socket opens.
  client(ws, { type: 'reattach', windowId: 'w1', sessionId: 's1' });
  client(ws, { type: 'heartbeat', windowId: 'w1' });
  assert.deepEqual(ws.sent, [], 'nothing is decided while the bridge is still loading');
  loaded = bridge;
  settle();
  assert.equal(await pending, 'sdk');
  assert.deepEqual(bridge.received.map(m => m.type), ['reattach', 'heartbeat'], 'held messages reach the bridge in order');
});

test('a bridge that failed to load is a visible refusal', async () => {
  const ws = fakeSocket();
  const outcome = await connectClaudeSkin(ws, {
    bridgeReady: Promise.resolve(), getBridge: () => null,
    getBridgeError: () => 'the Claude Agent SDK bridge failed to load (Cannot find module)',
  });
  assert.equal(outcome, 'unavailable');
  assert.equal(ws.sent[0].type, 'engine');
  assert.equal(ws.sent[0].engine, 'unavailable');
  assert.match(ws.sent[0].error, /failed to load/);
  assert.equal(ws.sent[1].type, 'error');
  assert.equal(ws.sent[1].code, ENGINE_UNAVAILABLE);
  assert.match(ws.sent[1].message, /Claude Code is unavailable/);

  // A prompt sent anyway is answered, so the tab never waits on nothing.
  client(ws, { type: 'query', prompt: 'hello?' });
  assert.equal(ws.sent.length, 3);
  assert.equal(ws.sent[2].code, ENGINE_UNAVAILABLE);
  client(ws, { type: 'heartbeat' });
  assert.equal(ws.sent.length, 3, 'only prompts are answered');
});

test('a bridge that throws while attaching is refused the same way', async () => {
  const ws = fakeSocket();
  const outcome = await connectClaudeSkin(ws, {
    bridgeReady: Promise.resolve(),
    getBridge: () => ({ createClaudeBridge() { throw new Error('claude-agent-bridge not configured'); } }),
  });
  assert.equal(outcome, 'unavailable');
  assert.match(ws.sent[0].error, /not configured/);
});

test('a bridge import that never settles times out into a refusal', async () => {
  const ws = fakeSocket();
  const outcome = await connectClaudeSkin(ws, { bridgeReady: new Promise(() => {}), getBridge: () => null, readyTimeoutMs: 20 });
  assert.equal(outcome, 'unavailable');
  assert.match(ws.sent[0].error, /still starting/);
});

test('a socket that closed while waiting is left alone', async () => {
  const ws = fakeSocket();
  const bridge = fakeBridge();
  let settle;
  const pending = connectClaudeSkin(ws, { bridgeReady: new Promise((r) => { settle = r; }), getBridge: () => (ws.readyState === 1 ? null : bridge) });
  ws.readyState = 3;
  settle();
  assert.equal(await pending, 'closed');
  assert.equal(bridge.sockets.length, 0);
  assert.equal(ws.listenerCount('message'), 0);
});

test('there is no other engine to select: the old kill-switch values change nothing', async () => {
  // What server.js passed while the per-turn engine existed.
  const ws = fakeSocket();
  const bridge = fakeBridge();
  let legacyCalls = 0;
  const outcome = await connectClaudeSkin(ws, {
    engine: 'legacy', bridgeReady: Promise.resolve(), getBridge: () => bridge, legacy: () => { legacyCalls++; },
  });
  assert.equal(outcome, 'sdk');
  assert.equal(legacyCalls, 0);
  assert.deepEqual(ws.sent, [{ type: 'engine', engine: 'sdk' }]);

  // And with no bridge the answer is the refusal, never a handler someone passed in.
  const refused = fakeSocket();
  const none = await connectClaudeSkin(refused, {
    engine: 'legacy', bridgeReady: Promise.resolve(), getBridge: () => null, legacy: () => { legacyCalls++; },
  });
  assert.equal(none, 'unavailable');
  assert.equal(legacyCalls, 0);
  assert.equal(refused.sent.at(-1).code, ENGINE_UNAVAILABLE);
});

// server.js cannot be loaded in a test (it is the live server): pin its side of
// the contract in source.
test('server.js routes sidepanel sockets through the fail-closed selector', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('function handleClaudeSkinWebSocket(ws) {');
  assert.ok(start > 0);
  const body = server.slice(start, server.indexOf('\n}\n', start));
  assert.match(body, /connectClaudeSkin\(ws, \{/);
  assert.match(body, /bridgeReady: _claudeBridgeReady/);
  assert.doesNotMatch(body, /\bengine:|\blegacy:/, 'nothing selects an engine');
  assert.match(server, /const _claudeBridgeReady = \(async \(\) => \{/);
  // The per-turn engine, its kill-switch and what only it used are gone.
  for (const gone of ['handleClaudeSkinWebSocketLegacy', 'resolveClaudeSkinEngine', 'CLAUDE_SKIN_ENGINE', 'CLAUDE_SKIN_DEBUG', '_orphanedProcs', 'buildAskAnswerPrompt', 'spawnProc(']) {
    assert.equal(server.includes(gone), false, `${gone} is still in server.js`);
  }
  const connect = await readFile(new URL('../lib/claude-skin-connect.js', import.meta.url), 'utf8');
  assert.doesNotMatch(connect, /o\.legacy|engine === 'legacy'/);
  // The tray's × ends a session where it lives: in the bridge.
  const kill = server.slice(server.indexOf("app.post('/api/sidepanel/kill-session'"));
  assert.match(kill.slice(0, 1200), /_claudeBridge\?\.killSession\?\.\(windowId, sessionId\)/);
});

// The standalone chat page spoke an old subset of the socket protocol and
// nothing led to it. Its address now lands on the main interface.
test('the retired standalone chat page redirects to the main interface', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const route = server.indexOf("app.get('/claude-chat.html'");
  assert.ok(route > 0, 'the old address is answered');
  assert.match(server.slice(route, route + 200), /res\.redirect\(['"]\/['"]\)/);
  assert.ok(route < server.indexOf("app.use(express.static(join(__dirname, 'public')"), 'before the static files, so a leftover file never shadows it');
});

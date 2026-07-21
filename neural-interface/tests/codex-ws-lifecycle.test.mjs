import assert from 'node:assert/strict';
import test from 'node:test';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(payload);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const sessionValues = new Map();
globalThis.sessionStorage = {
  getItem(key) { return sessionValues.get(key) ?? null; },
  setItem(key, value) { sessionValues.set(key, String(value)); },
  removeItem(key) { sessionValues.delete(key); },
};
globalThis.location = { protocol: 'http:', host: 'synabun.test' };
globalThis.WebSocket = FakeWebSocket;

const { connectTab } = await import('../public/shared/cdx/cdx-ws.js');

test('restored Codex tab keeps its new socket through bootstrap and ready', () => {
  const tab = {
    id: 'panel-a',
    ws: null,
    connectionEpoch: null,
    connected: false,
    bootstrapped: false,
    threadId: 'thread-a',
    expectedThreadId: 'thread-a',
    pendingReattach: false,
    closed: false,
  };
  let boundState = null;
  let connectingCalls = 0;
  let openCalls = 0;
  let readyCalls = 0;
  const ignoredReasons = [];

  // Mirror cdx-tabs.js: bind module-local transport state before the callback,
  // then commit those values back to the tab when the scope exits.
  const withTab = (target, callback) => {
    const previous = boundState;
    boundState = {
      ws: target.ws,
      connected: target.connected,
      bootstrapped: target.bootstrapped,
    };
    try {
      return callback();
    } finally {
      target.ws = boundState.ws;
      target.connected = boundState.connected;
      target.bootstrapped = boundState.bootstrapped;
      boundState = previous;
    }
  };

  connectTab(tab, {
    onConnecting() {
      connectingCalls += 1;
    },
    onOpen(target, socket) {
      openCalls += 1;
      boundState.ws = socket;
      boundState.connected = true;
      socket.send(JSON.stringify({
        type: 'bootstrap',
        sessionId: target.id,
        connectionEpoch: target.connectionEpoch,
        threadId: target.threadId,
      }));
    },
    onReady() {
      readyCalls += 1;
      boundState.bootstrapped = true;
    },
    onIgnoredMessage(_message, _tab, reason) {
      ignoredReasons.push(reason);
    },
  }, { withTab });

  const socket = FakeWebSocket.instances.at(-1);
  const connectionEpoch = tab.connectionEpoch;
  assert.ok(socket);
  assert.equal(tab.ws, socket, 'bound-state commit must not clear the new socket');
  assert.equal(connectingCalls, 1);

  socket.open();

  assert.equal(openCalls, 1, 'the socket must not reject its own open event as stale');
  assert.equal(tab.connected, true);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), {
    type: 'bootstrap',
    sessionId: 'panel-a',
    connectionEpoch,
    threadId: 'thread-a',
  });

  socket.message({
    type: 'ready',
    sessionId: tab.id,
    connectionEpoch,
    threadId: 'thread-a',
  });
  assert.equal(readyCalls, 1);
  assert.equal(tab.bootstrapped, true, 'ready must leave the tab able to enable its composer');

  tab.ws = { readyState: FakeWebSocket.OPEN };
  tab.connectionEpoch = 'replacement-epoch';
  socket.message({
    type: 'ready',
    sessionId: tab.id,
    connectionEpoch,
    threadId: null,
  });

  assert.equal(readyCalls, 1);
  assert.deepEqual(ignoredReasons, ['stale_socket']);
});

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

  close(code, reason) {
    this.closeArgs = [code, reason];
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
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

const {
  connectTab,
  disconnectTab,
  scheduleReconnect,
  sendSocket,
} = await import('../public/shared/cdx/cdx-ws.js');

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

test('idle disconnect waits for release acknowledgement before closing', () => {
  const tab = {
    id: 'panel-release',
    ws: null,
    connectionEpoch: null,
    connected: false,
    bootstrapped: false,
    threadId: 'thread-release',
    pendingReattach: false,
    closed: false,
  };
  connectTab(tab, {}, { withTab: (_target, callback) => callback() });
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();

  disconnectTab(tab);
  assert.equal(socket.readyState, FakeWebSocket.OPEN);
  assert.equal(socket.__cxpReleasePending, true);
  assert.equal(tab.connected, false);
  assert.equal(tab.bootstrapped, false);
  assert.equal(sendSocket({ type: 'query' }, socket), false);
  const release = JSON.parse(socket.sent.at(-1));
  assert.deepEqual({
    type: release.type,
    sessionId: release.sessionId,
    connectionEpoch: release.connectionEpoch,
    threadId: release.threadId,
  }, {
    type: 'release',
    sessionId: tab.id,
    connectionEpoch: tab.connectionEpoch,
    threadId: tab.threadId,
  });

  socket.message({
    type: 'release_ack',
    accepted: true,
    sessionId: tab.id,
    connectionEpoch: tab.connectionEpoch,
    threadId: tab.threadId,
  });
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.equal(socket.__cxpIntentionalClose, true);
});

test('preserved disconnect closes without requesting writer release', () => {
  const tab = {
    id: 'panel-running',
    ws: null,
    connectionEpoch: null,
    connected: false,
    bootstrapped: false,
    threadId: 'thread-running',
    pendingReattach: false,
    closed: false,
  };
  connectTab(tab, {}, { withTab: (_target, callback) => callback() });
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();

  disconnectTab(tab, { releaseWriter: false });
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.equal(socket.sent.some((payload) => JSON.parse(payload).type === 'release'), false);
  assert.equal(socket.__cxpIntentionalClose, true);
});

test('rejected release keeps the socket attached for active work', () => {
  const tab = {
    id: 'panel-release-race',
    ws: null,
    connectionEpoch: null,
    connected: false,
    bootstrapped: false,
    threadId: 'thread-release-race',
    pendingReattach: false,
    closed: false,
  };
  let releaseRejected = 0;
  connectTab(tab, {
    onReleaseRejected() { releaseRejected += 1; },
  }, { withTab: (_target, callback) => callback() });
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  tab.bootstrapped = true;

  disconnectTab(tab);
  socket.message({
    type: 'release_ack',
    accepted: false,
    sessionId: tab.id,
    connectionEpoch: tab.connectionEpoch,
    threadId: tab.threadId,
  });

  assert.equal(socket.readyState, FakeWebSocket.OPEN);
  assert.equal(socket.__cxpReleasePending, false);
  assert.equal(socket.__cxpIntentionalClose, undefined);
  assert.equal(tab.ws, socket);
  assert.equal(tab.connected, true);
  assert.equal(tab.bootstrapped, true);
  assert.equal(releaseRejected, 1);
});

test('rapid switch-back reconnects after an accepted release', () => {
  const tab = {
    id: 'panel-switch-back',
    ws: null,
    connectionEpoch: null,
    connected: false,
    bootstrapped: false,
    threadId: 'thread-switch-back',
    pendingReattach: false,
    closed: false,
  };
  let closeMeta = null;
  const callbacks = { onClose: (_tab, _socket, meta) => { closeMeta = meta; } };
  const options = { withTab: (_target, callback) => callback() };
  connectTab(tab, callbacks, options);
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();

  disconnectTab(tab);
  connectTab(tab, callbacks, options);
  assert.equal(socket.__cxpReconnectAfterRelease, true);

  socket.message({
    type: 'release_ack',
    accepted: true,
    sessionId: tab.id,
    connectionEpoch: tab.connectionEpoch,
    threadId: tab.threadId,
  });
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.deepEqual(closeMeta, { intentional: true, reconnectAfterRelease: true });
});

test('switching away again cancels reconnect-after-release intent', () => {
  const tab = {
    id: 'panel-switch-away-again',
    ws: null,
    connectionEpoch: null,
    connected: false,
    bootstrapped: false,
    threadId: 'thread-switch-away-again',
    pendingReattach: false,
    closed: false,
  };
  let closeMeta = null;
  const callbacks = { onClose: (_tab, _socket, meta) => { closeMeta = meta; } };
  const options = { withTab: (_target, callback) => callback() };
  connectTab(tab, callbacks, options);
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();

  disconnectTab(tab);
  connectTab(tab, callbacks, options);
  disconnectTab(tab);
  assert.equal(socket.__cxpReconnectAfterRelease, false);

  socket.message({
    type: 'release_ack',
    accepted: true,
    sessionId: tab.id,
    connectionEpoch: tab.connectionEpoch,
    threadId: tab.threadId,
  });
  assert.deepEqual(closeMeta, { intentional: true, reconnectAfterRelease: false });
});

test('intentional disconnect cancels only that tab reconnect timer', async () => {
  const tab = {
    id: 'panel-reconnect-cancel',
    ws: null,
    connected: false,
    bootstrapped: false,
    pendingReattach: true,
    closed: false,
    reconnectTimer: null,
  };
  let reconnects = 0;
  scheduleReconnect(tab, () => { reconnects += 1; }, 5);
  assert.ok(tab.reconnectTimer);

  disconnectTab(tab);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(reconnects, 0);
  assert.equal(tab.reconnectTimer, null);
  assert.equal(tab.pendingReattach, false);
});

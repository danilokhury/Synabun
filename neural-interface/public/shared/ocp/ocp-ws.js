// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel: WebSocket Client
// Connects to /ws/opencode-skin, routes messages
// ═══════════════════════════════════════════

import { trace } from './ocp-trace.js';

let _ws = null;
let _connected = false;
let _reconnectTimer = null;
let _msgId = 0;
const _pending = new Map(); // id → { resolve, reject, timer }
const _listeners = new Map(); // type → Set<fn>

// ── Public API ──

export function isConnected() { return _connected; }

export function connectWs(callbacks = {}) {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
  clearReconnectTimer();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}/ws/opencode-skin`);

  _ws.onopen = () => {
    _connected = true;
    trace('ws:open', { url: `${proto}//${location.host}/ws/opencode-skin` });
    if (callbacks.onConnect) callbacks.onConnect();
    // Send init to start/detect OpenCode server
    sendWs({ type: 'init' });
  };

  _ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleIncoming(msg, callbacks);
  };

  _ws.onclose = () => {
    const wasConnected = _connected;
    _connected = false;
    _ws = null;
    trace('ws:close', { wasConnected, pending: _pending.size });
    rejectAllPending('WebSocket disconnected');
    if (callbacks.onDisconnect) callbacks.onDisconnect(wasConnected);
    scheduleReconnect(callbacks);
  };

  _ws.onerror = (e) => { trace('ws:error', { msg: e?.message || 'ws error' }); };
}

export function disconnectWs() {
  clearReconnectTimer();
  if (_ws) {
    _ws.__ocpIntentionalClose = true;
    try { _ws.close(); } catch {}
    _ws = null;
  }
  _connected = false;
  rejectAllPending('Intentional disconnect');
}

export function sendWs(msg) {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(msg));
  }
}

/** Send a message and await its response (matched by id).
 *  The returned promise has a `.requestId` property for cancellation via `rejectPending()`. */
export function requestWs(type, payload = {}, timeoutMs = 30000) {
  const id = ++_msgId;
  const startedAt = Date.now();
  trace('ws:request:start', { type, id, timeoutMs });
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      trace('ws:request:timeout', { type, id, ms: Date.now() - startedAt });
      reject(new Error(`Request ${type} timed out`));
    }, timeoutMs);
    _pending.set(id, { resolve, reject, timer, type, startedAt });
    sendWs({ type, id, ...payload });
  });
  p.requestId = id;
  return p;
}

/** Register a listener for a specific message type. Returns unsubscribe fn. */
export function onWsMessage(type, fn) {
  if (!_listeners.has(type)) _listeners.set(type, new Set());
  _listeners.get(type).add(fn);
  return () => _listeners.get(type)?.delete(fn);
}

/** Reject a specific pending request by id (e.g. to cancel a long-running message:send). */
export function rejectPending(id, reason = 'Aborted') {
  const entry = _pending.get(id);
  if (!entry) return false;
  _pending.delete(id);
  clearTimeout(entry.timer);
  entry.reject(new Error(reason));
  return true;
}

/** Remove all listeners. */
export function clearWsListeners() {
  _listeners.clear();
}

// ── Internals ──

function handleIncoming(msg, callbacks) {
  const { type, id } = msg;

  // Response to a pending request?
  if (id && _pending.has(id)) {
    const entry = _pending.get(id);
    _pending.delete(id);
    clearTimeout(entry.timer);
    const ms = Date.now() - (entry.startedAt || Date.now());
    if (type === 'error' || (msg.status && msg.status >= 400)) {
      const raw = msg.data?.error ?? msg.data?.message ?? msg.message ?? msg.data;
      let errMsg = msg.status ? `HTTP ${msg.status}` : 'Request failed';
      if (typeof raw === 'string') {
        errMsg = raw;
      } else if (raw && typeof raw === 'object') {
        errMsg = raw.message || (typeof raw.error === 'string' && raw.error)
          || JSON.stringify(raw);
      }
      trace('ws:request:error', { type: entry.type, id, status: msg.status, ms, err: errMsg });
      entry.reject(new Error(errMsg));
    } else {
      trace('ws:request:end', { type: entry.type, id, status: msg.status || 200, ms });
      entry.resolve(msg);
    }
    return;
  }

  // Init result (no id)
  if (type === 'init:result') {
    if (callbacks.onInit) callbacks.onInit(msg);
    dispatch(type, msg);
    return;
  }

  // Server status broadcast
  if (type === 'server:status') {
    if (callbacks.onServerStatus) callbacks.onServerStatus(msg);
    dispatch(type, msg);
    return;
  }

  // SSE event relay
  if (type === 'event') {
    try {
      const evSid = msg.event?.sessionID || msg.event?.sessionId || msg.event?.info?.id || '';
      trace('ws:event', { eventType: msg.eventType, sid: evSid, hidden: typeof document !== 'undefined' ? document.hidden : null });
    } catch {}
    if (callbacks.onEvent) callbacks.onEvent(msg.eventType, msg.event);
    dispatch(type, msg);
    dispatch(`event:${msg.eventType}`, msg.event);
    return;
  }

  // Error
  if (type === 'error') {
    if (callbacks.onError) callbacks.onError(msg);
    dispatch(type, msg);
    return;
  }

  // Generic typed result
  dispatch(type, msg);
}

function dispatch(type, data) {
  const fns = _listeners.get(type);
  if (fns) for (const fn of fns) {
    try { fn(data); } catch (e) { console.error(`[ocp-ws] Listener error for ${type}:`, e); }
  }
}

function rejectAllPending(reason) {
  for (const [id, entry] of _pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  _pending.clear();
}

function clearReconnectTimer() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
}

function scheduleReconnect(callbacks, delayMs = 3000) {
  clearReconnectTimer();
  if (_ws?.__ocpIntentionalClose) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connectWs(callbacks);
  }, delayMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — WebSocket client (multi-panel)
// One WS connection serves every OCP v2 panel on the page. Panels register a
// store via subscribeSession(sessionId, store) and receive only the events for
// that session. session.created events fan out to subscribeSessionCreated()
// listeners (used by the panel manager to spawn child panels).
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';
import { notify as uiNotify, NOTIF_TYPE } from '../ui-notifications.js';

const _notifiedPermissionIds = new Set();
// Per-store DONE/ERROR dedup: once an outcome fires for a turn, suppress
// duplicates until the next time `running` flips back to true (new turn).
// ERROR locks out future DONE; DONE allows a later ERROR through.
const _outcomeKey = new WeakMap();        // store → NOTIF_TYPE.DONE | NOTIF_TYPE.ERROR
const _outcomeSubscribed = new WeakSet(); // stores already wired for reset

function _fireOutcomeNotify(store, type) {
  const last = _outcomeKey.get(store);
  if (last === type) return;
  if (last === NOTIF_TYPE.ERROR && type === NOTIF_TYPE.DONE) return;
  _outcomeKey.set(store, type);
  const s = store.getState();
  const baseLabel = s.sessionInfo?.title || s.sessionInfo?.info?.title || 'OpenCode';
  const label = s.parentSessionId ? `↳ ${baseLabel}` : baseLabel;
  try {
    uiNotify('panel', type, label, { panel: 'opencode', provider: 'opencode' });
  } catch (err) { console.warn('[ocp-v2-ws] outcome notify failed', err); }
}

function _ensureOutcomeReset(store) {
  if (_outcomeSubscribed.has(store)) return;
  _outcomeSubscribed.add(store);
  try {
    store.subscribe((event, state) => {
      if (event?.type === 'running:set' && state.running) {
        _outcomeKey.delete(store);
      }
    });
  } catch (err) { console.warn('[ocp-v2-ws] outcome subscribe failed', err); }
}

let _ws = null;
let _connecting = null;
let _reqSeq = 0;
const _pending = new Map();           // id → { resolve, reject, timeout }
const _eventListeners = new Set();    // (eventType, event) => void  — raw fan-out

const _storesBySession = new Map();   // sessionId → Set<store>
const _allStores = new Set();         // every registered store (server:status broadcast)
const _sessionCreatedListeners = new Set();
// Buffer recent session.created events so a late-arriving subscriber (the
// panel manager registers ONLY after boot() finishes — see ocp-v2-panel.js)
// can still detect sub-agent spawns that fired before it was ready. Without
// this buffer, a child OpenCode session created during boot vanishes from
// the listener fanout and the pill/panel never spawns.
const _sessionCreatedBuffer = [];
const SESSION_CREATED_BUFFER_MAX = 32;
const SESSION_CREATED_BUFFER_TTL_MS = 60_000;

function url() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/opencode-v2`;
}

export function isConnected() {
  return _ws && _ws.readyState === WebSocket.OPEN;
}

export async function connect() {
  if (isConnected()) return _ws;
  if (_connecting) return _connecting;

  _connecting = new Promise((resolve, reject) => {
    const ws = new WebSocket(url());
    _ws = ws;
    let opened = false;

    ws.addEventListener('open', () => {
      opened = true;
      console.log('[ocp-v2-ws] open');
      _connecting = null;
      resolve(ws);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      console.log('[ocp-v2-ws] close');
      _ws = null;
      _connecting = null;
      for (const [, p] of _pending) p.reject(new Error('websocket closed'));
      _pending.clear();
      broadcastServerStatus({ status: 'reconnecting' });
      setTimeout(() => { connect().catch(() => {}); }, 1500);
      if (!opened) reject(new Error('websocket failed to open'));
    });

    ws.addEventListener('error', (err) => {
      console.warn('[ocp-v2-ws] error', err);
      if (!opened) broadcastServerStatus({ status: 'error' });
      if (!opened) {
        _connecting = null;
        reject(err);
      }
    });
  });

  return _connecting;
}

function broadcastServerStatus(payload) {
  if (_allStores.size === 0) getDefaultStore().setServerStatus(payload);
  for (const store of _allStores) store.setServerStatus(payload);
}

export function disconnect() {
  if (_ws) {
    try { _ws.close(); } catch {}
    _ws = null;
  }
}

// ── Per-panel registration ────────────────────────────────────────────────
// Bind a store to a sessionId so subsequent events for that session mutate
// only this store. Returns an unsubscribe.
export function subscribeSession(sessionId, store) {
  if (!store) return () => {};
  _allStores.add(store);
  _ensureOutcomeReset(store);
  if (!sessionId) {
    // Not yet bound — caller should call again once a session exists.
    return () => { _allStores.delete(store); };
  }
  let set = _storesBySession.get(sessionId);
  if (!set) { set = new Set(); _storesBySession.set(sessionId, set); }
  set.add(store);
  return () => {
    const s = _storesBySession.get(sessionId);
    if (s) {
      s.delete(store);
      if (!s.size) _storesBySession.delete(sessionId);
    }
    _allStores.delete(store);
  };
}

// session.created events — used by the panel manager to detect sub-agent
// spawns (info.parentID points at the parent session). Newly attached
// listeners replay the recent buffer so a late subscription still catches
// child sessions that fired during boot.
export function subscribeSessionCreated(cb) {
  _sessionCreatedListeners.add(cb);
  const now = Date.now();
  for (const entry of _sessionCreatedBuffer) {
    if (now - entry.ts > SESSION_CREATED_BUFFER_TTL_MS) continue;
    try { cb(entry.event); } catch (e) { console.warn('[ocp-v2-ws] session.created replay listener error', e); }
  }
  return () => _sessionCreatedListeners.delete(cb);
}

function handleMessage(msg) {
  if (msg.type === 'server:status') {
    const payload = { status: msg.status, port: msg.port, version: msg.version, managed: msg.managed };
    // Broadcast to every registered store; also poke the default singleton
    // so legacy callers (no panel registered yet) still see status.
    broadcastServerStatus(payload);
    return;
  }

  if (msg.type === 'providers:changed') {
    document.dispatchEvent(new CustomEvent('ocp-providers-changed'));
    return;
  }

  if (msg.type === 'event') {
    handleEvent(msg.eventType, msg.event || {});
    fanout(msg.eventType, msg.event || {});
    return;
  }

  if (msg.id != null && _pending.has(msg.id)) {
    const p = _pending.get(msg.id);
    _pending.delete(msg.id);
    clearTimeout(p.timeout);
    p.resolve(msg);
    return;
  }
}

function handleEvent(eventType, ev) {
  // session.created → broadcast to manager listeners (child-panel spawning).
  // Don't dispatch as a state mutation — the spawned panel's own subscribeSession
  // call will catch its own subsequent message events.
  if (eventType === 'session.created') {
    _sessionCreatedBuffer.push({ ts: Date.now(), event: ev });
    if (_sessionCreatedBuffer.length > SESSION_CREATED_BUFFER_MAX) {
      _sessionCreatedBuffer.splice(0, _sessionCreatedBuffer.length - SESSION_CREATED_BUFFER_MAX);
    }
    for (const cb of _sessionCreatedListeners) {
      try { cb(ev); } catch (e) { console.warn('[ocp-v2-ws] session.created listener error', e); }
    }
    return;
  }

  const sid = ev.sessionID || ev.sessionId || ev.info?.id;
  if (!sid) return;
  const targets = _storesBySession.get(sid);
  if (!targets || !targets.size) return;

  for (const store of targets) dispatchEvent(store, eventType, ev);
}

function dispatchEvent(store, eventType, ev) {
  switch (eventType) {
    case 'message.updated':
      if (ev.info) {
        store.upsertMessage(ev.info);
        // If the message arrives WITHOUT a completed timestamp, the server is
        // still streaming it — the local `running` flag may be stale (e.g.,
        // page reloaded mid-turn). Flip it on so the header shows "running"
        // instead of the stuck "idle". session.idle clears this.
        const completed = ev.info?.time?.completed;
        if (ev.info?.role === 'assistant' && (completed == null || completed === 0)) {
          if (!store.getState().running) store.setRunning(true);
        }
      }
      break;
    case 'message.removed':
      if (ev.messageID) store.removeMessage(ev.messageID);
      break;
    case 'message.part.updated':
      if (ev.part) {
        store.upsertPart(ev.part);
        // Live signal: any part still running/pending means the session is
        // running, regardless of whether send() was the local trigger. Catches
        // sub-agent-driven activity + post-reload state recovery.
        const partStatus = ev.part?.state?.status || ev.part?.status || '';
        if (partStatus === 'running' || partStatus === 'pending') {
          if (!store.getState().running) store.setRunning(true);
        }
      }
      break;
    case 'session.idle': {
      const wasRunning = store.getState().running;
      store.setRunning(false);
      // Only fire DONE on a real running→idle transition; idle echoes after
      // the panel was already idle (e.g., reconnect) should not notify.
      if (wasRunning) _fireOutcomeNotify(store, NOTIF_TYPE.DONE);
      break;
    }
    case 'session.updated':
      // Per-store filter already handled by registry; just refresh sessionInfo
      // when the SDK provides updated metadata (title, etc.). Avoid setSession
      // since it would clear the message map.
      // No-op for now — consumers re-render via existing subscriptions.
      break;
    case 'session.error':
      store.pushError({ message: ev.error?.message || ev.error?.name || 'session error', raw: ev.error });
      store.setRunning(false);
      _fireOutcomeNotify(store, NOTIF_TYPE.ERROR);
      break;
    case 'permission.asked':
    case 'permission.updated': {
      store.setPendingPermission(ev);
      const permId = String(ev.id || ev.permissionID || '');
      if (permId && !_notifiedPermissionIds.has(permId)) {
        _notifiedPermissionIds.add(permId);
        const s = store.getState();
        const baseLabel = s.sessionInfo?.title || s.sessionInfo?.info?.title || 'OpenCode';
        const label = s.parentSessionId ? `↳ ${baseLabel}` : baseLabel;
        try {
          uiNotify('panel', NOTIF_TYPE.ASK, label, { panel: 'opencode', provider: 'opencode' });
        } catch (err) { console.warn('[ocp-v2-ws] notify failed', err); }
      }
      break;
    }
    case 'permission.replied':
    case 'permission.rejected': {
      const pend = store.getState().pendingPermission;
      if (pend && (pend.id === ev.id || pend.permissionID === ev.permissionID)) {
        store.setPendingPermission(null);
      }
      const permId = String(ev.id || ev.permissionID || '');
      if (permId) _notifiedPermissionIds.delete(permId);
      break;
    }
    case 'question.asked':
      if (ev && ev.id) {
        store.addPendingQuestion(ev);
        const qId = String(ev.id || '');
        if (qId && !_notifiedPermissionIds.has(qId)) {
          _notifiedPermissionIds.add(qId);
          const s = store.getState();
          const baseLabel = s.sessionInfo?.title || s.sessionInfo?.info?.title || 'OpenCode';
          const label = s.parentSessionId ? `↳ ${baseLabel}` : baseLabel;
          try {
            uiNotify('panel', NOTIF_TYPE.ASK, label, { panel: 'opencode', provider: 'opencode' });
          } catch (err) { console.warn('[ocp-v2-ws] question notify failed', err); }
        }
      }
      break;
    case 'question.replied':
    case 'question.rejected': {
      const reqId = ev?.requestID || ev?.id;
      if (reqId) {
        store.removePendingQuestion(reqId);
        _notifiedPermissionIds.delete(String(reqId));
      }
      break;
    }
    default:
      break;
  }
}

// ── Public: subscribe to raw events (any session) ────────────────────────
export function onEvent(listener) {
  _eventListeners.add(listener);
  return () => _eventListeners.delete(listener);
}

function fanout(eventType, ev) {
  for (const fn of _eventListeners) {
    try { fn(eventType, ev); } catch (e) { console.warn('[ocp-v2-ws] event listener error', e); }
  }
}

// ── Request/response (id-correlated, 30s default timeout) ──

function request(payload, timeoutMs = 30000) {
  return new Promise(async (resolve, reject) => {
    try { await connect(); } catch (e) { return reject(e); }
    const id = ++_reqSeq;
    const timeout = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`request timeout: ${payload.type}`));
    }, timeoutMs);
    _pending.set(id, { resolve, reject, timeout });
    _ws.send(JSON.stringify({ ...payload, id }));
  });
}

export const api = {
  init:           ()              => request({ type: 'init' }),
  sessionList:    ()              => request({ type: 'session:list' }),
  sessionCreate:  (body, cwd)     => request({ type: 'session:create', body, cwd }),
  sessionGet:     (sessionId)     => request({ type: 'session:get', sessionId }),
  sessionUpdate:  (sessionId, body) => request({ type: 'session:update', sessionId, body }),
  sessionDelete:  (sessionId)     => request({ type: 'session:delete', sessionId }),
  sessionMessages:(sessionId)     => request({ type: 'session:messages', sessionId }),
  sessionContext: ({ sessionId, cwd } = {}) => request({ type: 'session:context', sessionId, cwd }),
  send: ({ sessionId, parts, model, agent, mode, variant, cwd, noAbortPrev }) =>
    request({ type: 'message:send', sessionId, parts, model, agent, mode, variant, cwd, noAbortPrev: !!noAbortPrev }, 30 * 60 * 1000),
  abort: (sessionId) => request({ type: 'message:abort', sessionId }),
  compact: ({ sessionId, cwd } = {}) => request({ type: 'session:compact', sessionId, cwd }, 2 * 60 * 1000),
  permissionReply: ({ sessionId, permissionId, response }) =>
    request({ type: 'permission:reply', sessionId, permissionId, response }),
  questionList:   ({ cwd } = {})              => request({ type: 'question:list', cwd }),
  questionReply:  ({ requestId, answers, cwd }) => request({ type: 'question:reply', requestId, answers, cwd }),
  questionReject: ({ requestId })             => request({ type: 'question:reject', requestId }),
};

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — WebSocket client (multi-panel)
// One WS connection serves every OCP v2 panel on the page. Panels register a
// store via subscribeSession(sessionId, store) and receive only the events for
// that session. session.created events fan out to subscribeSessionCreated()
// listeners (used by the panel manager to spawn child panels).
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';
import { notify as uiNotify, NOTIF_TYPE } from '../ui-notifications.js';
import { nativeLoopWindowId } from '../ui-native-window-id.js';
import { registerAutomationSession } from './ocp-v2-automation-ownership.js';
import { applyEvent, resolveEventTargets } from './ocp-v2-events.js';
import { createCapabilities, gatedRequest } from './ocp-v2-caps.js';
import { shouldAutoAccept, autoAcceptRequest, autoAcceptInherited } from './ocp-v2-approvals.js';
import { verifyDescendant, knownDescendant, createReconnectNotifier, requestOwner } from './ocp-v2-rehydrate.js';

// Request types the connected server answers. Empty against a server that
// predates the list; cleared on every disconnect and refilled on reconnect.
export const capabilities = createCapabilities();
export const supports = (...types) => capabilities.hasAll(...types);
// The @opencode-ai/sdk version the server answered `init` with ('' from a
// server that does not say).
let _sdkVersion = '';
export const sdkVersion = () => _sdkVersion;

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
      try { ws.send(JSON.stringify({ type: 'identify', windowId: nativeLoopWindowId })); }
      catch (err) { console.warn('[ocp-v2-ws] identify failed', err); }
      _connecting = null;
      _reconnects.opened();
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
      capabilities.clear();
      _reconnects.closed();
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

/** True when some panel is bound to this session. */
export function hasSessionStore(sessionId) {
  return !!_storesBySession.get(sessionId)?.size;
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

  if (msg.type === 'capabilities') {
    capabilities.set(msg.capabilities);
    _reconnects.capabilities();
    return;
  }

  if (msg.type === 'event') {
    // Native OpenCode runs travel over a different WebSocket than the run
    // router. Register ownership before any child-session listener runs so a
    // fast Task spawn cannot flash a child panel during the attach race.
    if (msg.nativeRunId && msg.nativeRootSessionId) {
      registerAutomationSession(msg.nativeRootSessionId, msg.nativeRunId);
    }
    handleEvent(msg.eventType, msg.event || {});
    fanout(msg.eventType, msg.event || {});
    return;
  }

  if (msg.id != null && _pending.has(msg.id)) {
    const p = _pending.get(msg.id);
    _pending.delete(msg.id);
    clearTimeout(p.timeout);
    if (msg.type === 'init:result') {
      capabilities.set(msg.capabilities);
      if (typeof msg.sdkVersion === 'string') _sdkVersion = msg.sdkVersion;
    }
    p.resolve(msg);
    return;
  }
}

function handleEvent(eventType, ev) {
  // session.created → broadcast to manager listeners (child-panel spawning).
  // Don't dispatch as a state mutation — the spawned panel's own subscribeSession
  // call will catch its own subsequent message events.
  if (eventType === 'session.created') {
    rememberParent(ev);
    _sessionCreatedBuffer.push({ ts: Date.now(), event: ev });
    if (_sessionCreatedBuffer.length > SESSION_CREATED_BUFFER_MAX) {
      _sessionCreatedBuffer.splice(0, _sessionCreatedBuffer.length - SESSION_CREATED_BUFFER_MAX);
    }
    for (const cb of _sessionCreatedListeners) {
      try { cb(ev); } catch (e) { console.warn('[ocp-v2-ws] session.created listener error', e); }
    }
    return;
  }

  // session.updated can be the first event that carries a child's parentID.
  if (eventType === 'session.updated') rememberParent(ev);
  // (A request that is answered while it is being handed over: handOverRequests.)
  if (ANSWERED.has(eventType)) noteAnswered(ev);

  const targets = resolveEventTargets({
    eventType, ev, storesBySession: _storesBySession, parentOf: _parentOf, allStores: _allStores,
  });
  for (const store of targets) applyEvent(store, eventType, ev, EVENT_HOOKS);
}

// child sessionID → parent sessionID, learned from session.created/updated.
// Lets a sub-agent's permission or question reach the panel of its parent
// when no child panel is open for it.
const _parentOf = new Map();
function rememberParent(ev) {
  const info = ev?.info || ev?.session || ev || {};
  const childId = info.id || ev?.sessionID || ev?.sessionId;
  const parentId = info.parentID || info.parentId || info.parent_id || ev?.parentID || ev?.parentId;
  if (childId && parentId && childId !== parentId) _parentOf.set(childId, parentId);
}

/**
 * A parent link the server reported some other way than a session event: the
 * children it listed for a session (the panel manager's scan after a reload).
 * Not for a link that was only inferred (a task tool's part): such a link is
 * read from the session itself when it is needed (isDescendantSession).
 */
export function rememberSessionParent(childId, parentId) {
  const child = String(childId || '');
  const parent = String(parentId || '');
  if (child && parent && child !== parent) _parentOf.set(child, parent);
}

// The parent session of `sessionId` as far as the page knows it: the link the
// server reported, else the one the panel on that session was made with.
function parentSessionOf(sessionId) {
  const known = _parentOf.get(sessionId);
  if (known) return known;
  for (const store of _storesBySession.get(sessionId) || []) {
    const parent = store.getState().parentSessionId;
    if (parent) return parent;
  }
  return '';
}

// Requests that were answered a moment ago (the newest 256 ids).
const ANSWERED = new Set(['permission.replied', 'question.replied', 'question.rejected']);
const _answered = new Set();
function noteAnswered(ev) {
  const id = String(ev?.requestID || ev?.id || ev?.permissionID || '');
  if (!id) return;
  _answered.delete(id);
  _answered.add(id);
  while (_answered.size > 256) _answered.delete(_answered.values().next().value);
}

// Roots: sessions the server said have no parent (saves asking again).
const _rootSessions = new Set();

/**
 * Verified ancestry: is `sessionId` a sub-agent session (at any depth) of
 * `ancestorId`? Known links come from session events; an unknown one is read
 * from the session itself. Anything that cannot be established is false.
 */
export function isDescendantSession(sessionId, ancestorId) {
  return verifyDescendant(sessionId, ancestorId, {
    parentOf: _parentOf,
    roots: _rootSessions,
    fetchParent: async (id) => {
      const res = await api.sessionGet(id);
      if (!res || res.error || (typeof res.status === 'number' && res.status >= 400) || !res.data?.id) return null;
      return String(res.data.parentID || res.data.parentId || '');
    },
  });
}

/**
 * The same question answered from what is already known (session events and
 * earlier verified lookups), without asking the server. For rendering: a card
 * is drawn only for a request of the bound session or of a known sub-agent.
 */
export function isKnownDescendantSession(sessionId, ancestorId) {
  return knownDescendant(sessionId, ancestorId, _parentOf);
}

// The socket came back after an outage: whatever was sent meanwhile reached no
// panel. Listeners re-read their session (the primary panel does it through its
// auto-heal; the panel manager does it for the sub-agent panel).
const _reconnectListeners = new Set();
const _reconnects = createReconnectNotifier(() => {
  for (const fn of _reconnectListeners) {
    try { fn(); } catch (e) { console.warn('[ocp-v2-ws] reconnect listener error', e); }
  }
});
export function onReconnect(listener) {
  _reconnectListeners.add(listener);
  return () => _reconnectListeners.delete(listener);
}

// A sub-agent's panel follows the switch of the session that spawned it, up
// the chain: a sub-agent of a sub-agent follows the session in the main panel.
// The chain is the sessions' own (child → parent), not the panels that happen
// to be open: a sub-agent whose parent's panel was closed still inherits.
function autoAcceptEnabledFor(store) {
  const s = store.getState();
  if (s.autoAccept) return true;
  return autoAcceptInherited(s.sessionId, {
    parentOf: (sessionId) => (sessionId === s.sessionId && s.parentSessionId) || parentSessionOf(sessionId),
    isOn: (sessionId) => [...(_storesBySession.get(sessionId) || [])].some((panel) => panel.getState().autoAccept === true),
  });
}

function sessionLabel(store) {
  const s = store.getState();
  const baseLabel = s.sessionInfo?.title || s.sessionInfo?.info?.title || 'OpenCode';
  return s.parentSessionId ? `↳ ${baseLabel}` : baseLabel;
}

const _compactedListeners = new Set();
/** Called with the store after OpenCode compacted its session (transcript changed). */
export function onSessionCompacted(listener) {
  _compactedListeners.add(listener);
  return () => _compactedListeners.delete(listener);
}

// What the reducer cannot do itself: desktop notifications and refetches.
const EVENT_HOOKS = {
  onOutcome(store, outcome) {
    _fireOutcomeNotify(store, outcome === 'error' ? NOTIF_TYPE.ERROR : NOTIF_TYPE.DONE);
  },
  onAsk(store, id, kind, ev) {
    if (!id || _notifiedPermissionIds.has(id)) return;
    _notifiedPermissionIds.add(id);
    // Auto-accept is the user's standing answer for this session: reply and
    // stay quiet. A refused reply leaves the card up for them.
    if (kind === 'permission' && shouldAutoAccept(autoAcceptEnabledFor(store), ev)) {
      const s = store.getState();
      // The label of the session that asked, read now: by the time the reply
      // is back the store may show another session's title.
      const label = sessionLabel(store);
      autoAcceptRequest(store, api, ev, { cwd: s.cwd || s.sessionInfo?.directory || undefined, isDescendant: isDescendantSession })
        .then((accepted) => { if (!accepted) notifyAsk(store, label); })
        .catch((err) => console.warn('[ocp-v2-ws] auto-accept failed', err));
      return;
    }
    notifyAsk(store);
  },
  onAskCleared(id) {
    if (id) _notifiedPermissionIds.delete(id);
  },
  onCompacted(store) {
    for (const fn of _compactedListeners) {
      try { fn(store); } catch (e) { console.warn('[ocp-v2-ws] compacted listener error', e); }
    }
  },
};

function notifyAsk(store, label = sessionLabel(store)) {
  try {
    uiNotify('panel', NOTIF_TYPE.ASK, label, { panel: 'opencode', provider: 'opencode' });
  } catch (err) { console.warn('[ocp-v2-ws] notify failed', err); }
}

/**
 * A panel was closed while requests were waiting in it: its own, or those of
 * sub-agents below it that have no panel. OpenCode still waits for an answer,
 * so each goes, at once, where it would have gone had that panel never
 * existed: to the nearest session above its own that has a panel
 * (resolveEventTargets). Call it after the closed panel's store was
 * unsubscribed.
 * A request whose chain of parents is not known here (its sub-agent was
 * announced by a task card only) has the chain read first, up to `within`
 * (the session the main panel has as a tab), and is shown then, unless it was
 * answered while that read was out.
 * A request that was announced when it was raised is not announced again.
 */
export function handOverRequests(store, { within = '' } = {}) {
  const s = store.getState();
  const asks = [
    ...(s.pendingPermissions || []).map((req) => ['permission.asked', req]),
    ...(s.pendingQuestions || []).map((req) => ['question.asked', req]),
  ];
  for (const [eventType, held] of asks) {
    // (`_auto`: a reply the closed panel sent is still out; refused, the card stays.)
    const { _auto, ...req } = held || {};
    const deliver = () => {
      const targets = resolveEventTargets({ eventType, ev: req, storesBySession: _storesBySession, parentOf: _parentOf, allStores: _allStores });
      for (const target of targets) applyEvent(target, eventType, req, EVENT_HOOKS);
      return targets.length > 0;
    };
    if (deliver() || !within) continue;
    isDescendantSession(requestOwner(req), within)
      .then((known) => { if (known && !_answered.has(String(req.requestID || req.id || req.permissionID || ''))) deliver(); })
      .catch((err) => console.warn('[ocp-v2-ws] handing over a closed panel\'s request failed', err));
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
  init:           ()              => request({ type: 'init', windowId: nativeLoopWindowId }),
  // options: { search, archived, roots, limit }. A server without
  // feature:session-list-filters ignores them and lists every live session.
  sessionList:    (options)       => request(options ? { type: 'session:list', options } : { type: 'session:list' }),
  sessionCreate:  (body, cwd)     => request({ type: 'session:create', body, cwd }),
  sessionGet:     (sessionId)     => request({ type: 'session:get', sessionId }),
  sessionUpdate:  (sessionId, body) => request({ type: 'session:update', sessionId, body }),
  sessionDelete:  (sessionId)     => request({ type: 'session:delete', sessionId }),
  sessionMessages:(sessionId)     => request({ type: 'session:messages', sessionId }),
  sessionContext: ({ sessionId, cwd } = {}) => request({ type: 'session:context', sessionId, cwd }),
  send: ({ sessionId, parts, model, agent, mode, variant, cwd, mcpProfile, noAbortPrev }) =>
    request({ type: 'message:send', sessionId, parts, model, agent, mode, variant, cwd, mcpProfile, noAbortPrev: !!noAbortPrev }, 30 * 60 * 1000),
  abort: (sessionId) => request({ type: 'message:abort', sessionId }),
  compact: ({ sessionId, cwd, mcpProfile, model } = {}) => request({ type: 'session:compact', sessionId, cwd, mcpProfile, model }, 5 * 60 * 1000),
  permissionReply: ({ sessionId, permissionId, response, cwd, message }) =>
    request({ type: 'permission:reply', sessionId, permissionId, response, cwd, message }),
  questionList:   ({ cwd, sessionId } = {})   => request({ type: 'question:list', cwd, sessionId }),
  questionReply:  ({ requestId, answers, cwd, sessionId }) => request({ type: 'question:reply', requestId, answers, cwd, sessionId }),
  questionReject: ({ requestId, sessionId })  => request({ type: 'question:reject', requestId, sessionId }),
  mcpProfileGet:  (sessionId) => request({ type: 'mcp:profile:get', sessionId }),
  mcpProfileSet:  (sessionId, profile) => request({ type: 'mcp:profile:set', sessionId, profile }, 45_000),

  // ── Newer request types: sent only when the server lists them (see
  //    ocp-v2-caps.js); otherwise they resolve { ok:false, unsupported:true }.
  sessionStatus:  ({ sessionId, cwd } = {}) => gated({ type: 'session:status', sessionId, cwd }),
  permissionList: ({ sessionId, cwd } = {}) => gated({ type: 'permission:list', sessionId, cwd }),
  sessionTodo:    ({ sessionId, cwd } = {}) => gated({ type: 'session:todo', sessionId, cwd }),
  sessionRevert:   ({ sessionId, messageID, partID, cwd } = {}) => gated({ type: 'session:revert', sessionId, messageID, partID, cwd }),
  sessionUnrevert: ({ sessionId, cwd } = {}) => gated({ type: 'session:unrevert', sessionId, cwd }),
  sessionFork:     ({ sessionId, messageID, cwd } = {}) => gated({ type: 'session:fork', sessionId, messageID, cwd }),
  sessionChildren: ({ sessionId, cwd } = {}) => gated({ type: 'session:children', sessionId, cwd }),
  sessionShare:    ({ sessionId, cwd } = {}) => gated({ type: 'session:share', sessionId, cwd }),
  sessionUnshare:  ({ sessionId, cwd } = {}) => gated({ type: 'session:unshare', sessionId, cwd }),
  sessionSharePolicy: ({ cwd } = {}) => gated({ type: 'session:share:policy', cwd }),
  messageDelete:   ({ sessionId, messageID, cwd } = {}) => gated({ type: 'message:delete', sessionId, messageID, cwd }),
  commandList:     ({ cwd } = {}) => gated({ type: 'command:list', cwd }),
  // A command is a turn: it can run as long as a prompt does.
  commandRun:      ({ sessionId, command, arguments: args, agent, model, variant, parts, cwd, mcpProfile } = {}) =>
    gated({ type: 'command:run', sessionId, command, arguments: args, agent, model, variant, parts, cwd, mcpProfile }, 30 * 60 * 1000),
  sessionShell:    ({ sessionId, command, agent, model, cwd, mcpProfile } = {}) =>
    gated({ type: 'session:shell', sessionId, command, agent, model, cwd, mcpProfile }, 10 * 60 * 1000),
  findFiles:       ({ query, cwd, dirs } = {}) => gated({ type: 'find:files', query, cwd, dirs }, 10000),
  findSymbols:     ({ sessionId, query, cwd } = {}) => gated({ type: 'find:symbols', sessionId, query, cwd }, 10000),
  resourceList:    ({ sessionId, cwd } = {}) => gated({ type: 'resource:list', sessionId, cwd }, 15000),
  referenceList:   ({ sessionId, cwd } = {}) => gated({ type: 'reference:list', sessionId, cwd }, 15000),
  agentList:       ({ cwd } = {}) => gated({ type: 'agent:list', cwd }, 15000),
  sessionDiff:     ({ sessionId, messageID, cwd } = {}) => gated({ type: 'session:diff', sessionId, messageID, cwd }),
  vcsGet:          ({ cwd } = {}) => gated({ type: 'vcs:get', cwd }),
  vcsStatus:       ({ cwd } = {}) => gated({ type: 'vcs:status', cwd }),
  vcsDiff:         ({ cwd, mode } = {}) => gated({ type: 'vcs:diff', cwd, mode }, 60_000),
  worktreeList:    ({ cwd } = {}) => gated({ type: 'worktree:list', cwd }),
  worktreeCreate:  ({ cwd, name } = {}) => gated({ type: 'worktree:create', cwd, name }, 60_000),
  worktreeRemove:  ({ cwd, directory } = {}) => gated({ type: 'worktree:remove', cwd, directory }, 60_000),
  mcpStatus:       ({ sessionId, cwd } = {}) => gated({ type: 'mcp:status', sessionId, cwd }),
  mcpConnect:      ({ sessionId, name, cwd } = {}) => gated({ type: 'mcp:connect', sessionId, name, cwd }, 60_000),
  mcpDisconnect:   ({ sessionId, name, cwd } = {}) => gated({ type: 'mcp:disconnect', sessionId, name, cwd }, 60_000),
  // OAuth: OpenCode opens the browser and waits for the callback.
  mcpAuthenticate: ({ sessionId, name, cwd } = {}) => gated({ type: 'mcp:authenticate', sessionId, name, cwd }, 5 * 60 * 1000 + 5000),
  // Registers a server on the serve running this session and, with `persist`,
  // saves it to the OpenCode config in the same request (see ocp-v2-status.js).
  mcpAdd:          ({ sessionId, name, config, persist, cwd } = {}) => gated({ type: 'mcp:add', sessionId, name, config, persist: persist === true, cwd }, 60_000),
  envStatus:       ({ sessionId, cwd } = {}) => gated({ type: 'env:status', sessionId, cwd }),
};

function gated(payload, timeoutMs) {
  return gatedRequest(capabilities, request, payload, timeoutMs);
}

// SynaBun — Codex Panel: WebSocket Transport

import { windowId } from './cdx-icons.js';
import { codexSocketMessageRejectionReason } from './cdx-protocol.js';

// ── Shared heartbeat; reconnect ownership lives on each tab ──
let _heartbeatInterval = null;

// ═══════════════════════════════════════════
//  Reconnect Timer
// ═══════════════════════════════════════════

export function clearReconnectTimer(tab) {
  if (tab?.reconnectTimer) {
    clearTimeout(tab.reconnectTimer);
    tab.reconnectTimer = null;
  }
}

export function scheduleReconnect(tab, reconnectFn, delayMs = 1200) {
  if (!tab || tab.reconnectTimer) return;
  tab.reconnectTimer = setTimeout(() => {
    tab.reconnectTimer = null;
    reconnectFn();
  }, delayMs);
}

// ═══════════════════════════════════════════
//  Heartbeat
// ═══════════════════════════════════════════

export function startHeartbeat(tabs) {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(() => {
    for (const tab of tabs) {
      if (tab.ws?.readyState === WebSocket.OPEN) {
        tab.ws.send(JSON.stringify({
          type: 'heartbeat',
          windowId,
          sessionId: tab.id,
          connectionEpoch: tab.connectionEpoch,
        }));
      }
    }
  }, 15_000);
}

export function stopHeartbeat() {
  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
}

// ═══════════════════════════════════════════
//  Disconnect
// ═══════════════════════════════════════════

function closeSocket(tab, ws, { intentional = true } = {}) {
  if (!tab || !ws) return;
  if (ws.__cxpReleaseTimer) {
    clearTimeout(ws.__cxpReleaseTimer);
    ws.__cxpReleaseTimer = null;
  }
  ws.__cxpReleasePending = false;
  ws.__cxpReleasePreviousState = null;
  if (intentional) ws.__cxpIntentionalClose = true;
  tab.connected = false;
  tab.bootstrapped = false;
  tab.pendingReattach = false;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try { ws.close(); } catch {}
    return;
  }
  if (tab.ws === ws) tab.ws = null;
}

export function disconnectTab(tab, { releaseWriter = true } = {}) {
  if (!tab || tab.closed) return;
  clearReconnectTimer(tab);
  const ws = tab.ws;
  if (!ws) {
    tab.connected = false;
    tab.bootstrapped = false;
    tab.pendingReattach = false;
    tab.ws = null;
    return;
  }
  if (releaseWriter && ws.readyState === WebSocket.OPEN && !ws.__cxpReleasePending) {
    try {
      ws.send(JSON.stringify({
        type: 'release',
        windowId,
        sessionId: tab.id,
        connectionEpoch: tab.connectionEpoch,
        threadId: tab.threadId || null,
      }));
      ws.__cxpReleasePreviousState = {
        connected: !!tab.connected,
        bootstrapped: !!tab.bootstrapped,
      };
      ws.__cxpReleasePending = true;
      ws.__cxpReconnectAfterRelease = false;
      tab.connected = false;
      tab.bootstrapped = false;
      ws.__cxpReleaseTimer = setTimeout(() => closeSocket(tab, ws), 1500);
      return;
    } catch {}
  }
  if (ws.__cxpReleasePending) {
    ws.__cxpReconnectAfterRelease = false;
    return;
  }
  closeSocket(tab, ws);
}

// ═══════════════════════════════════════════
//  Send
// ═══════════════════════════════════════════

export function sendSocket(msg, ws) {
  if (ws?.readyState !== WebSocket.OPEN || ws.__cxpReleasePending) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

// ═══════════════════════════════════════════
//  handleSocketMessage  (internal router)
// ═══════════════════════════════════════════

/**
 * Routes an incoming WebSocket message to the appropriate callback.
 *
 * @param {object} msg        — parsed JSON message from the server
 * @param {object} tab        — the tab this message belongs to
 * @param {object} callbacks  — handler map provided by the caller:
 *   onReattachResult(msg, tab)
 *   onReady(msg, tab)
 *   onThreadList(msg)
 *   onThreadStarted(msg)
 *   onThreadRenamed(msg)
 *   onHistory(msg)
 *   onThread(msg)
 *   onTurn(msg)
 *   onNotify(msg)
 *   onServerRequest(msg)
 *   onInterruptAck(msg)
 *   onError(msg)
 *   onModelList(msg)
 *   onGenericResponse(msg)       — account_info, config_data, mcp_status, etc.
 *   onThreadForked(msg)
 *   onClosed(msg, tab, ws)
 */
function handleSocketMessage(msg, tab, callbacks) {
  switch (msg.type) {
    case 'reattach_result':
      callbacks.onReattachResult?.(msg, tab);
      break;
    case 'ready':
      callbacks.onReady?.(msg, tab);
      break;
    case 'thread_list':
      callbacks.onThreadList?.(msg);
      break;
    case 'thread_started':
      callbacks.onThreadStarted?.(msg);
      break;
    case 'thread_renamed':
      callbacks.onThreadRenamed?.(msg);
      break;
    case 'history':
      callbacks.onHistory?.(msg);
      break;
    case 'thread':
      callbacks.onThread?.(msg);
      break;
    case 'turn':
      callbacks.onTurn?.(msg);
      break;
    case 'notify':
      callbacks.onNotify?.(msg);
      break;
    case 'server_request':
      callbacks.onServerRequest?.(msg);
      break;
    case 'interrupt_ack':
      callbacks.onInterruptAck?.(msg);
      break;
    case 'error':
      callbacks.onError?.(msg);
      break;
    case 'model_list':
      callbacks.onModelList?.(msg);
      break;
    case 'account_info':
    case 'account_login_started':
    case 'account_logged_out':
    case 'account_list':
    case 'account_switched':
    case 'account_add_started':
    case 'account_removed':
    case 'account_renamed':
    case 'config_data':
    case 'config_requirements':
    case 'experimental_features':
    case 'skills_list':
    case 'app_list':
    case 'plugin_list':
    case 'thread_loaded_list':
    case 'review_started':
    case 'thread_rolled_back':
    case 'background_cleaned':
    case 'turn_steered':
    case 'rate_limits':
    case 'status_snapshot':
    case 'mcp_status':
    case 'mcp_profile_changed':
    case 'config_saved':
    case 'mcp_refreshed':
    case 'mcp_oauth_done':
    case 'mcp_approval_updated':
    case 'codex_config_repaired':
    case 'permission_roots':
    case 'permission_root_removed':
    case 'storage_health':
    case 'server_request_response_result':
      callbacks.onGenericResponse?.(msg);
      break;
    case 'thread_forked':
    case 'thread_archived':
    case 'thread_unarchived':
      callbacks.onThreadForked?.(msg);
      break;
    case 'closed':
      callbacks.onClosed?.(msg, tab);
      break;
    default:
      break;
  }
}

// ═══════════════════════════════════════════
//  connectTab
// ═══════════════════════════════════════════

/**
 * Opens a WebSocket for the given tab and wires up event handlers.
 *
 * @param {object}   tab           — tab object; ws/connected/bootstrapped/pendingReattach are set on it
 * @param {object}   callbacks     — message handlers (same shape as handleSocketMessage expects),
 *                                   plus lifecycle hooks:
 *   onConnecting(tab)             — called immediately when connection starts
 *   onOpen(tab, ws, { shouldReattach, wasConnected })
 *   onClose(tab, ws, { intentional, reconnectAfterRelease })
 *   onMessageError(err, raw)      — parse/handler error
 *   ... all handleSocketMessage callbacks
 * @param {object}   opts
 * @param {Function} opts.withTab  — withTab(tab, fn) context‑switch helper from the monolith
 */
export function connectTab(tab, callbacks, opts = {}) {
  if (!tab || tab.closed) return;
  if (tab.ws && (tab.ws.readyState === WebSocket.OPEN || tab.ws.readyState === WebSocket.CONNECTING)) {
    if (tab.ws.__cxpReleasePending) tab.ws.__cxpReconnectAfterRelease = true;
    return;
  }

  const wasConnected = !!tab.connected;
  const shouldReattach = !!tab.pendingReattach;
  const withTab = opts.withTab || ((t, fn) => fn());

  clearReconnectTimer(tab);

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/codex-skin`);
  const connectionEpoch = crypto.randomUUID();

  // Establish transport ownership before entering a bound-tab scope. The
  // binder commits its module-local `_ws` value when that scope exits; if the
  // socket is first assigned inside the scope, that stale value can overwrite
  // tab.ws and make the socket reject its own open event as stale.
  tab.ws = ws;
  tab.connectionEpoch = connectionEpoch;
  tab.connected = false;
  tab.bootstrapped = false;

  withTab(tab, () => {
    callbacks.onConnecting?.(tab);
  });

  ws.onopen = () => {
    if (tab.closed || tab.ws !== ws || tab.connectionEpoch !== connectionEpoch) return;
    withTab(tab, () => {
      tab.connected = true;
      callbacks.onOpen?.(tab, ws, { shouldReattach, wasConnected });
    });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'release_ack' && ws.__cxpReleasePending
        && String(msg.sessionId || '') === String(tab.id || '')
        && String(msg.connectionEpoch || '') === String(connectionEpoch)) {
        if (ws.__cxpReleaseTimer) {
          clearTimeout(ws.__cxpReleaseTimer);
          ws.__cxpReleaseTimer = null;
        }
        const previousState = ws.__cxpReleasePreviousState;
        ws.__cxpReleasePending = false;
        if (msg.accepted || tab.closed) {
          closeSocket(tab, ws);
        } else {
          ws.__cxpReconnectAfterRelease = false;
          ws.__cxpReleasePreviousState = null;
          tab.connected = previousState?.connected ?? true;
          tab.bootstrapped = previousState?.bootstrapped ?? true;
          withTab(tab, () => callbacks.onReleaseRejected?.(tab, ws));
        }
        return;
      }
      if (tab.closed || tab.ws !== ws || tab.connectionEpoch !== connectionEpoch) {
        callbacks.onIgnoredMessage?.(null, tab, 'stale_socket');
        return;
      }
      const rejectionReason = codexSocketMessageRejectionReason(msg, tab);
      if (rejectionReason) {
        callbacks.onIgnoredMessage?.(msg, tab, rejectionReason);
        return;
      }
      withTab(tab, () => handleSocketMessage(msg, tab, callbacks));
    } catch (err) {
      if (callbacks.onMessageError) {
        callbacks.onMessageError(err, event.data?.slice?.(0, 200));
      } else {
        console.error('[cxp-ws] onmessage error:', err, 'raw:', event.data?.slice?.(0, 200));
      }
    }
  };

  ws.onclose = () => {
    if (tab.ws !== ws || tab.connectionEpoch !== connectionEpoch) return;
    withTab(tab, () => {
      if (ws.__cxpReleaseTimer) {
        clearTimeout(ws.__cxpReleaseTimer);
        ws.__cxpReleaseTimer = null;
      }
      const intentional = !!ws.__cxpIntentionalClose || tab.closed;
      const reconnectAfterRelease = !!ws.__cxpReconnectAfterRelease && !tab.closed;
      tab.connected = false;
      tab.bootstrapped = false;
      if (tab._reattachTimer) { clearTimeout(tab._reattachTimer); tab._reattachTimer = null; }
      callbacks.onClose?.(tab, ws, { intentional, reconnectAfterRelease });
    });
  };
}

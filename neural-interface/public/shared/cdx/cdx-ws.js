// SynaBun — Codex Panel: WebSocket Transport

import { windowId, STOR } from './cdx-icons.js';

// ── Singleton timers (not per-tab) ──
let _reconnectTimer = null;
let _heartbeatInterval = null;

// ═══════════════════════════════════════════
//  Reconnect Timer
// ═══════════════════════════════════════════

export function clearReconnectTimer() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
}

export function scheduleReconnect(reconnectFn) {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    reconnectFn();
  }, 1200);
}

// ═══════════════════════════════════════════
//  Heartbeat
// ═══════════════════════════════════════════

export function startHeartbeat(tabs) {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(() => {
    for (const tab of tabs) {
      if (tab.ws?.readyState === WebSocket.OPEN) {
        tab.ws.send(JSON.stringify({ type: 'heartbeat', windowId, sessionId: tab.id }));
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

export function disconnectTab(tab) {
  if (!tab || tab.closed) return;
  if (tab.reconnectTimer) {
    clearTimeout(tab.reconnectTimer);
    tab.reconnectTimer = null;
  }
  tab.connected = false;
  tab.bootstrapped = false;
  tab.pendingReattach = false;
  const ws = tab.ws;
  if (!ws) {
    tab.ws = null;
    return;
  }
  ws.__cxpIntentionalClose = true;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try { ws.close(); } catch {}
    return;
  }
  if (tab.ws === ws) tab.ws = null;
}

// ═══════════════════════════════════════════
//  Send
// ═══════════════════════════════════════════

export function sendSocket(msg, ws) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
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
    case 'config_saved':
    case 'mcp_refreshed':
    case 'mcp_oauth_done':
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
 *   onClose(tab, ws, { intentional })
 *   onMessageError(err, raw)      — parse/handler error
 *   ... all handleSocketMessage callbacks
 * @param {object}   opts
 * @param {Function} opts.withTab  — withTab(tab, fn) context‑switch helper from the monolith
 */
export function connectTab(tab, callbacks, opts = {}) {
  if (!tab || tab.closed) return;
  if (tab.ws && (tab.ws.readyState === WebSocket.OPEN || tab.ws.readyState === WebSocket.CONNECTING)) return;

  const wasConnected = !!tab.connected;
  const shouldReattach = !!tab.pendingReattach;
  const withTab = opts.withTab || ((t, fn) => fn());

  withTab(tab, () => {
    clearReconnectTimer();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/codex-skin`);
    tab.ws = ws;
    tab.connected = false;
    tab.bootstrapped = false;

    callbacks.onConnecting?.(tab);

    ws.onopen = () => withTab(tab, () => {
      tab.connected = true;
      callbacks.onOpen?.(tab, ws, { shouldReattach, wasConnected });
    });

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        withTab(tab, () => handleSocketMessage(msg, tab, callbacks));
      } catch (err) {
        if (callbacks.onMessageError) {
          callbacks.onMessageError(err, event.data?.slice?.(0, 200));
        } else {
          console.error('[cxp-ws] onmessage error:', err, 'raw:', event.data?.slice?.(0, 200));
        }
      }
    };

    ws.onclose = () => withTab(tab, () => {
      const intentional = !!ws.__cxpIntentionalClose || tab.closed;
      tab.connected = false;
      tab.bootstrapped = false;
      if (tab._reattachTimer) { clearTimeout(tab._reattachTimer); tab._reattachTimer = null; }
      callbacks.onClose?.(tab, ws, { intentional });
    });
  });
}

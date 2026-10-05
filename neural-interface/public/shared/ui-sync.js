// ═══════════════════════════════════════════
// SynaBun Neural Interface — Real-time Sync
// ═══════════════════════════════════════════
// Bidirectional WebSocket client connecting to /ws/sync.
// Receives server-side data mutations and relays client-originated
// events (card sync, terminal) to all other session participants.
// Also manages guest/owner role and feature permissions.

import { emit } from './state.js';
import { storage } from './storage.js';
import { applyHiddenModels, hydrateHiddenModels } from './ocp-hidden-models.js';

let _ws = null;
let _reconnectTimer = null;
let _reloadDebounce = null;
let _isGuest = false;
let _permissions = {};

const RECONNECT_INTERVAL = 5000;
const DEBOUNCE_MS = 300;

function clearOpenCodeHistoryClientState(message) {
  const exactKeys = new Set([
    'opencode-v2-windows',
    'synabun-ocp-windows',
    'synabun-ocp-session-snapshots',
    'synabun-opencode-session-mcp-profiles',
  ]);
  const prefixes = [
    'opencode-v2-tabs-',
    'opencode-v2-automations-',
    'opencode-v2-title-states-',
    'synabun-ocp-tabs-',
  ];
  for (const key of storage.keys()) {
    if (exactKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      storage.removeItem(key);
    }
  }
  emit('sync:opencode:history-cleared', message);

  const ownRequest = sessionStorage.getItem('synabun-opencode-history-clear-request');
  const initiatedHere = !!ownRequest && ownRequest === message?.requestId;
  sessionStorage.removeItem('synabun-opencode-history-clear-request');
  setTimeout(() => location.reload(), initiatedHere ? 4000 : 700);
}

// ── Server → Client event mapping ────────────
// Data mutations from REST endpoints trigger UI refresh events.

const SYNC_HANDLERS = {
  'memory:updated':  () => scheduleReload(),
  'memory:trashed':  () => { scheduleReload(); emit('trash:updated'); },
  'memory:deleted':  () => { scheduleReload(); emit('trash:updated'); },
  'memory:restored': () => { scheduleReload(); emit('trash:updated'); },
  'trash:purged':    () => { emit('trash:updated'); },
  'category:created': () => { emit('categories:changed'); emit('categories-changed'); scheduleReload(); },
  'category:updated': () => { emit('categories:changed'); emit('categories-changed'); scheduleReload(); },
  'category:deleted': () => { emit('categories:changed'); emit('categories-changed'); scheduleReload(); },
  // Memory map positions changed (new memories placed, an island refit, a rebuild).
  'map:updated':     (msg) => emit('sync:map:updated', msg),

  // OpenCode history is global to the host. Drop stale per-window tab/session
  // references in every connected UI before reloading against the empty DB.
  'opencode:history-cleared': (msg) => clearOpenCodeHistoryClientState(msg),

  // Settings → OpenCode model checkboxes changed in another window: refresh
  // the localStorage mirror (fires ocp-hidden-models-changed when it differs).
  'opencode:hidden-models-changed': (msg) => {
    applyHiddenModels(msg.models);
    emit('sync:opencode:hidden-models-changed', msg);
  },

  // Assistant → Models toggles (every provider): the Assistant's model menus,
  // Routes editor and Models manager reload their lists.
  'assistant:hidden-models-changed': (msg) => emit('sync:assistant:hidden-models-changed', msg),

  // Card sync (relayed from other clients)
  'card:opened':    (msg) => emit('sync:card:opened', msg),
  'card:closed':    (msg) => emit('sync:card:closed', msg),
  'card:moved':     (msg) => emit('sync:card:moved', msg),
  'card:resized':   (msg) => emit('sync:card:resized', msg),
  'card:compacted': (msg) => emit('sync:card:compacted', msg),
  'card:expanded':  (msg) => emit('sync:card:expanded', msg),

  // Terminal session list sync
  'terminal:session-created': (msg) => emit('sync:terminal:created', msg),
  'terminal:session-deleted': (msg) => emit('sync:terminal:deleted', msg),

  // Server-owned native loop conversations
  'sidepanel:run-created':   (msg) => emit('sync:sidepanel:run-created', msg),
  'sidepanel:run-updated':   (msg) => emit('sync:sidepanel:run-updated', msg),
  'sidepanel:run-claimed':   (msg) => emit('sync:sidepanel:run-claimed', msg),
  'sidepanel:run-completed': (msg) => emit('sync:sidepanel:run-completed', msg),
  'sidepanel:run-failed':    (msg) => emit('sync:sidepanel:run-failed', msg),
  'sidepanel:run-stopped':   (msg) => emit('sync:sidepanel:run-stopped', msg),
  'sidepanel:provider-event':(msg) => emit('sync:sidepanel:provider-event', msg),

  // Assistant (CLI-region orchestrator) — sessions, dispatches, permissions, accounts
  'assistant:session-created':     (msg) => emit('sync:assistant:session-created', msg),
  'assistant:session-updated':     (msg) => emit('sync:assistant:session-updated', msg),
  'assistant:session-ended':       (msg) => emit('sync:assistant:session-ended', msg),
  'assistant:dispatch':            (msg) => emit('sync:assistant:dispatch', msg),
  'assistant:run-removed':         (msg) => emit('sync:assistant:run-removed', msg),
  'assistant:permission-request':  (msg) => emit('sync:assistant:permission-request', msg),
  'assistant:permission-resolved': (msg) => emit('sync:assistant:permission-resolved', msg),
  'assistant:focus':               (msg) => emit('sync:assistant:focus', msg),
  'assistant:accounts-changed':    (msg) => emit('sync:assistant:accounts-changed', msg),
  'assistant:mailbox':             (msg) => emit('sync:assistant:mailbox', msg),
  'assistant:cost':                (msg) => emit('sync:assistant:cost', msg),
  'assistant:desktop':             (msg) => emit('sync:assistant:desktop', msg),
  'assistant:desktop-setup':       (msg) => emit('sync:assistant:desktop-setup', msg),
  'assistant:routing-changed':     (msg) => emit('sync:assistant:routing-changed', msg),

  // WhatsApp Link — states and counters only (never a QR, code, number or text); Settings → WhatsApp re-reads /api/whatsapp/status
  'whatsapp:status':               (msg) => emit('sync:whatsapp:status', msg),

  // Browser session lifecycle sync
  'browser:session-created': (msg) => emit('sync:browser:created', msg),
  'browser:session-deleted': (msg) => emit('sync:browser:deleted', msg),

  // Browser tab lifecycle sync
  'browser:tab-created':  (msg) => emit('sync:browser:tab-created', msg),
  'browser:tab-switched': (msg) => emit('sync:browser:tab-switched', msg),
  'browser:tab-closed':   (msg) => emit('sync:browser:tab-closed', msg),

  // Browser auto-open (triggered by menu/keybind manual open)
  'browser:open': (msg) => emit('browser:open', msg),

  // MCP profile sync
  'mcp:profile-changed': (msg) => {
    emit('mcp:profile-changed', msg);
    emit('sync:mcp:profile-changed', msg);
  },

  // Terminal link events
  'link:created':        (msg) => emit('sync:link:created', msg),
  'link:deleted':        (msg) => emit('sync:link:deleted', msg),
  'link:message':        (msg) => emit('sync:link:message', msg),
  'link:agent-started':  (msg) => emit('sync:link:agent-started', msg),
  'link:agent-finished': (msg) => emit('sync:link:agent-finished', msg),
  'link:paused':         (msg) => emit('sync:link:paused', msg),
  'link:resumed':        (msg) => emit('sync:link:resumed', msg),
  'link:error':          (msg) => emit('sync:link:error', msg),
  'link:chunk':          (msg) => emit('sync:link:chunk', msg),

  // Isolated agent events
  'agent:output':    (msg) => emit('sync:agent:output', msg),
  'agent:launched':  (msg) => emit('sync:agent:launched', msg),
  'agent:status':    (msg) => emit('sync:agent:status', msg),
  'agent:removed':   (msg) => emit('sync:agent:removed', msg),
  'agent:iteration': (msg) => emit('sync:agent:iteration', msg),

  // Schedule events
  'schedule:created':   (msg) => emit('sync:schedule:created', msg),
  'schedule:updated':   (msg) => emit('sync:schedule:updated', msg),
  'schedule:deleted':   (msg) => emit('sync:schedule:deleted', msg),
  'schedule:fired':     (msg) => emit('sync:schedule:fired', msg),
  'schedule:completed':       (msg) => emit('sync:schedule:completed', msg),
  'schedule:failed':          (msg) => emit('sync:schedule:failed', msg),
  'schedule:deferred':        (msg) => emit('sync:schedule:deferred', msg),
  'schedule:deferred-expired':(msg) => emit('sync:schedule:deferred-expired', msg),
  'schedule:timer-set':       (msg) => emit('sync:schedule:timer-set', msg),
  'schedule:timer-fired':     (msg) => emit('sync:schedule:timer-fired', msg),
  'schedule:timer-cancelled': (msg) => emit('sync:schedule:timer-cancelled', msg),
  'schedule-group:created':   (msg) => emit('sync:schedule-group:created', msg),
  'schedule-group:updated':   (msg) => emit('sync:schedule-group:updated', msg),
  'schedule-group:deleted':   (msg) => emit('sync:schedule-group:deleted', msg),
  'schedule-group:reordered': (msg) => emit('sync:schedule-group:reordered', msg),

  // Quick timer events
  'quick-timer:set':       (msg) => emit('sync:quick-timer:set', msg),
  'quick-timer:fired':     (msg) => emit('sync:quick-timer:fired', msg),
  'quick-timer:fired-now': (msg) => emit('sync:quick-timer:fired-now', msg),
  'quick-timer:cancelled': (msg) => emit('sync:quick-timer:cancelled', msg),
  'quick-timer:failed':    (msg) => emit('sync:quick-timer:failed', msg),

  // Skin change sync
  'skin:changed': (msg) => emit('sync:skin:changed', msg),

  // Session indexing progress
  'indexing:started':          (msg) => emit('ws:message', msg),
  'indexing:session-started':  (msg) => emit('ws:message', msg),
  'indexing:session-progress': (msg) => emit('ws:message', msg),
  'indexing:session-complete': (msg) => emit('ws:message', msg),
  'indexing:error':            (msg) => emit('ws:message', msg),
  'indexing:complete':         (msg) => emit('ws:message', msg),
  'indexing:cancelled':        (msg) => emit('ws:message', msg),

  // Permission updates from owner
  'permissions:changed': (msg) => {
    _permissions = msg.permissions || {};
    emit('permissions:changed', _permissions);
  },

  // Connection info
  'connected': (msg) => {
    _isGuest = !!msg.isGuest;
    _permissions = msg.permissions || {};
    emit('session:info', { isGuest: _isGuest, permissions: _permissions });
    // Catch up on hidden-model changes missed while disconnected.
    hydrateHiddenModels();
  },
};

// ── Debounced reload ───────────────────────
function scheduleReload() {
  if (_reloadDebounce) clearTimeout(_reloadDebounce);
  _reloadDebounce = setTimeout(() => {
    _reloadDebounce = null;
    emit('data:reload');
  }, DEBOUNCE_MS);
}

// ── WebSocket connection ───────────────────

function connect() {
  if (_ws && _ws.readyState <= 1) return; // CONNECTING or OPEN

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${protocol}//${location.host}/ws/sync`);

  _ws.onopen = () => {
    console.log('[sync-ws] Connected');
    if (_reconnectTimer) { clearInterval(_reconnectTimer); _reconnectTimer = null; }
  };

  _ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log('[sync-ws] ←', msg.type, msg);
      const handler = SYNC_HANDLERS[msg.type];
      if (handler) handler(msg);
    } catch { /* ignore malformed */ }
  };

  _ws.onclose = () => {
    console.log('[sync-ws] Disconnected, will reconnect in 5s');
    _ws = null;
    if (!_reconnectTimer) {
      _reconnectTimer = setInterval(connect, RECONNECT_INTERVAL);
    }
  };

  _ws.onerror = () => {}; // onclose fires after
}

// ── Public API ─────────────────────────────

/** Send a message to the sync channel (relayed to other clients) */
export function sendSync(msg) {
  if (_ws && _ws.readyState === 1) {
    _ws.send(JSON.stringify(msg));
  }
}

/** Whether this client is a guest (invited user) */
export function isGuest() { return _isGuest; }

/** Get current permissions object */
export function getPermissions() { return { ..._permissions }; }

/** Check if a specific feature is enabled */
export function hasPermission(key) { return !!_permissions[key]; }

/** Show a brief toast when guest action is blocked */
export function showGuestToast(msg = 'This action is disabled by the host') {
  let toast = document.getElementById('guest-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'guest-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(20,20,28,0.92);color:#f87171;border:1px solid rgba(248,113,113,0.25);padding:8px 18px;border-radius:8px;font-size:13px;z-index:99999;pointer-events:none;opacity:0;transition:opacity 0.3s;backdrop-filter:blur(12px);font-family:inherit;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}

export function initSync() {
  connect();

  // Listen for 403 events from API layer and show toast for guests
  window.addEventListener('synabun:forbidden', (e) => {
    if (_isGuest) showGuestToast(e.detail || 'This action is disabled by the host');
  });
}

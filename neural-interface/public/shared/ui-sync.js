// ═══════════════════════════════════════════
// SynaBun Neural Interface — Real-time Sync
// ═══════════════════════════════════════════
// Bidirectional WebSocket client connecting to /ws/sync.
// Receives server-side data mutations and relays client-originated
// events (card sync, terminal) to all other session participants.
// Also manages guest/owner role and feature permissions.

import { emit } from './state.js';

let _ws = null;
let _reconnectTimer = null;
let _reloadDebounce = null;
let _isGuest = false;
let _permissions = {};

const RECONNECT_INTERVAL = 5000;
const DEBOUNCE_MS = 300;

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

  // Browser session lifecycle sync
  'browser:session-created': (msg) => emit('sync:browser:created', msg),
  'browser:session-deleted': (msg) => emit('sync:browser:deleted', msg),

  // Browser auto-open (triggered by menu/keybind manual open)
  'browser:open': (msg) => emit('browser:open', msg),

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
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

export function initSync() {
  connect();

  // Listen for 403 events from API layer and show toast for guests
  window.addEventListener('synabun:forbidden', (e) => {
    if (_isGuest) showGuestToast(e.detail || 'This action is disabled by the host');
  });
}

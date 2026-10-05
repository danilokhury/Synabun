// ═══════════════════════════════════════════
// SynaBun Assistant — WebSocket client (/ws/assistant/:id)
// ═══════════════════════════════════════════
// Reattach on every open, 25 s heartbeat, exponential backoff reconnect, a
// bounded send queue while disconnected, and an "attached elsewhere" signal so
// the panel can offer a take-over instead of silently fighting another window.

const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const QUEUE_CAP = 50;

/**
 * createAssistantSocket(sessionId, { onPacket(packet), onStatus(status, extra) })
 * status: 'connecting' | 'open' | 'reconnecting' | 'closed' | 'attached-elsewhere'
 * Returns { connect, send, close, reconnect, takeOver, isOpen, sessionId }.
 */
export function createAssistantSocket(sessionId, { onPacket, onStatus } = {}) {
  let ws = null;
  let closed = false;
  let attempts = 0;
  let hbTimer = null;
  let reconnectTimer = null;
  let attachedElsewhere = false;
  const queue = [];

  const url = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/assistant/${encodeURIComponent(sessionId)}`;
  const setStatus = (status, extra) => { try { onStatus?.(status, extra); } catch { /* listener error */ } };

  function startHeartbeat() {
    stopHeartbeat();
    hbTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'heartbeat', at: Date.now() })); } catch { /* ignore */ }
      }
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }

  function flushQueue() {
    while (queue.length && ws?.readyState === WebSocket.OPEN) {
      const packet = queue.shift();
      try { ws.send(JSON.stringify(packet)); } catch { queue.unshift(packet); break; }
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer || attachedElsewhere) return;
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.min(attempts, 5)) + Math.floor(Math.random() * 400);
    attempts++;
    setStatus('reconnecting', { delay, attempts });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (closed) return;
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setStatus('connecting');
    let socket;
    try {
      socket = new WebSocket(url());
    } catch (err) {
      setStatus('reconnecting', { error: err?.message });
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      attempts = 0;
      attachedElsewhere = false;
      try { socket.send(JSON.stringify({ type: 'reattach', sessionId })); } catch { /* ignore */ }
      flushQueue();
      startHeartbeat();
      setStatus('open');
    };

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (!packet || typeof packet !== 'object') return;
      if (packet.type === 'error' && isAttachedElsewhere(packet)) {
        attachedElsewhere = true;
        setStatus('attached-elsewhere', packet);
      }
      try { onPacket?.(packet); } catch (err) { console.warn('[assistant-ws] packet handler failed', err); }
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      stopHeartbeat();
      ws = null;
      if (closed) { setStatus('closed'); return; }
      scheduleReconnect();
    };

    socket.onerror = () => { /* onclose follows */ };
  }

  function send(packet) {
    if (!packet || typeof packet !== 'object') return false;
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(packet)); return true; } catch { /* fall through to queue */ }
    }
    if (packet.type === 'heartbeat') return false;
    if (queue.length >= QUEUE_CAP) queue.shift();
    queue.push(packet);
    if (!closed && !ws) connect();
    return false;
  }

  function close() {
    closed = true;
    attachedElsewhere = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopHeartbeat();
    queue.length = 0;
    const socket = ws;
    ws = null;
    if (socket) { try { socket.close(); } catch { /* ignore */ } }
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    setStatus('closed');
  }

  function reconnect() {
    if (closed) return;
    attempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const socket = ws;
    ws = null;
    if (socket) { try { socket.close(); } catch { /* ignore */ } }
    connect();
  }

  // Take over from another window: a fresh socket re-sends `reattach`, which the
  // runtime treats as "this connection now owns the session".
  function takeOver() {
    attachedElsewhere = false;
    reconnect();
  }

  function onVisibility() {
    if (!document.hidden && !closed && !ws && !attachedElsewhere) reconnect();
  }
  function onOnline() {
    if (!closed && !ws && !attachedElsewhere) reconnect();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);

  return {
    sessionId,
    connect,
    send,
    close,
    reconnect,
    takeOver,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    isAttachedElsewhere: () => attachedElsewhere,
  };
}

function isAttachedElsewhere(packet) {
  const code = String(packet.code || packet.reason || '').toLowerCase();
  if (code.includes('attached') || code.includes('locked') || code.includes('owner')) return true;
  const message = String(packet.message || '').toLowerCase();
  return /attached (elsewhere|to another)|locked by another|another (window|client)/.test(message);
}

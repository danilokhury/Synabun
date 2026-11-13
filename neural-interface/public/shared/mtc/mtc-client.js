// ═══════════════════════════════════════════
// SynaBun — Maritaca panel: the socket to /ws/maritaca (no DOM)
// ═══════════════════════════════════════════
//
// `request(type, payload)` resolves with the server's `data` or rejects with an Error carrying `code`;
// every other message is an event for `on(type, fn)`. The socket opens on the first request, says
// `hello` first, and opens again (1 s, 2 s, 4 s … 30 s) after it drops while anything listens; requests
// in flight when it drops reject with code 'DISCONNECTED'. After two opens in a row that fail the client
// asks `probe()` (GET /api/maritaca/panel) and, when the answer says the socket will not open (a server
// from before the panel: 404; the automation browser or a guest: 403), stops and emits `blocked`.
// Events of its own: `connected` (the hello answer), `disconnected`, `retrying { attempt, waitMs }`, `blocked`.

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const PROBE_AFTER_FAILURES = 2;

export function maritacaSocketUrl(location = globalThis.location) {
  if (!location) return 'ws://127.0.0.1:3344/ws/maritaca';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws/maritaca`;
}

export function probeVerdict({ status = 0, body = null, failed = false } = {}) {
  if (failed) return { reason: 'offline', message: '' };
  if (status >= 200 && status < 300) return { reason: null, message: '' };
  const code = String(body?.code || '');
  const message = typeof body?.error === 'string' ? body.error : '';
  if (status === 404) return { reason: 'restart', message };
  if (status === 403 || status === 401) {
    if (code === 'WORKER_BROWSER') return { reason: 'automation', message };
    if (/GUEST|INVITE|ADMIN/i.test(code) || /guest/i.test(message)) return { reason: 'guest', message };
    return { reason: 'refused', message };
  }
  if (status >= 500) return { reason: null, message };
  return { reason: 'refused', message };
}

export async function defaultProbe(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return probeVerdict({ failed: true });
  try {
    const res = await fetchImpl('/api/maritaca/panel', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return probeVerdict({ status: res.status, body });
  } catch { return probeVerdict({ failed: true }); }
}

export function createMaritacaClient({
  url = maritacaSocketUrl(), WebSocketImpl = globalThis.WebSocket, setTimer = setTimeout, clearTimer = clearTimeout,
  requestTimeoutMs = 0, probe = () => defaultProbe(),
} = {}) {
  let ws = null;
  let opening = null;
  let hello = null;
  let seq = 0;
  let attempt = 0;
  let failures = 0;
  let reconnectTimer = null;
  let blocked = null;
  let closedByUs = false;
  const pending = new Map();
  const listeners = new Map();

  const emit = (type, payload) => { for (const fn of listeners.get(type) || []) { try { fn(payload); } catch { /* a listener's own problem */ } } };
  const rejectAll = (code, message) => {
    for (const [, entry] of pending) { clearTimer(entry.timer); entry.reject(Object.assign(new Error(message), { code })); }
    pending.clear();
  };

  function scheduleReconnect() {
    if (closedByUs || blocked || reconnectTimer) return;
    const waitMs = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    emit('retrying', { attempt, waitMs });
    reconnectTimer = setTimer(() => { reconnectTimer = null; open().catch(() => {}); }, waitMs);
  }

  async function checkBlocked() {
    let verdict;
    try { verdict = await probe(); } catch { verdict = { reason: null, message: '' }; }
    if (verdict?.reason && verdict.reason !== 'offline') {
      blocked = { reason: verdict.reason, message: verdict.message || '' };
      emit('blocked', blocked);
      return true;
    }
    return false;
  }

  function open() {
    if (ws && ws.readyState === 1 && hello) return Promise.resolve(hello);
    if (opening) return opening;
    if (blocked) return Promise.reject(Object.assign(new Error(blocked.message || blocked.reason), { code: 'BLOCKED', reason: blocked.reason }));
    closedByUs = false;
    opening = new Promise((resolve, reject) => {
      let socket;
      try { socket = new WebSocketImpl(url); } catch (error) { opening = null; reject(error); scheduleReconnect(); return; }
      ws = socket;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        opening = null;
        failures += 1;
        reject(error);
        (failures >= PROBE_AFTER_FAILURES ? checkBlocked() : Promise.resolve(false)).then((isBlocked) => { if (!isBlocked) scheduleReconnect(); });
      };
      socket.addEventListener('open', () => {
        sendRaw({ type: 'hello', reqId: 'hello' });
      });
      socket.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg?.type === 'result') {
          if (msg.reqId === 'hello') {
            if (!msg.ok) { fail(Object.assign(new Error(msg.error || 'hello refused'), { code: msg.code || 'HELLO' })); try { socket.close(); } catch {} return; }
            hello = msg.data || {};
            attempt = 0; failures = 0; settled = true; opening = null;
            emit('connected', hello);
            resolve(hello);
            return;
          }
          const entry = pending.get(msg.reqId);
          if (!entry) return;
          pending.delete(msg.reqId);
          clearTimer(entry.timer);
          if (msg.ok) entry.resolve(msg.data);
          else entry.reject(Object.assign(new Error(msg.error || 'request failed'), { code: msg.code || 'ERROR' }));
          return;
        }
        if (typeof msg?.type === 'string') emit(msg.type, msg);
      });
      socket.addEventListener('close', () => {
        if (ws === socket) ws = null;
        const wasOpen = !!hello;
        hello = null;
        rejectAll('DISCONNECTED', 'The connection to SynaBun dropped.');
        if (!settled) { fail(Object.assign(new Error('closed before hello'), { code: 'DISCONNECTED' })); return; }
        if (wasOpen) emit('disconnected', {});
        if (!closedByUs) scheduleReconnect();
      });
      socket.addEventListener('error', () => { /* close follows */ });
    });
    return opening;
  }

  function sendRaw(message) {
    if (!ws || ws.readyState !== 1) throw Object.assign(new Error('not connected'), { code: 'DISCONNECTED' });
    ws.send(JSON.stringify(message));
  }

  async function request(type, payload = {}) {
    await open();
    const reqId = `q${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = requestTimeoutMs > 0 ? setTimer(() => { pending.delete(reqId); reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })); }, requestTimeoutMs) : null;
      pending.set(reqId, { resolve, reject, timer });
      try { sendRaw({ type, reqId, ...payload }); }
      catch (error) { pending.delete(reqId); if (timer) clearTimer(timer); reject(error); }
    });
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }

  function close() {
    closedByUs = true;
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
    try { ws?.close(); } catch {}
    ws = null; hello = null;
  }

  function reconnectNow() {
    blocked = null; failures = 0; attempt = 0;
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
    return open();
  }

  return { open, request, on, close, reconnectNow, hello: () => hello, connected: () => !!(ws && ws.readyState === 1 && hello), blocked: () => blocked };
}

// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: the socket to /ws/antigravity (no DOM)
// ═══════════════════════════════════════════
//
// `request(type, payload)` resolves with the server's `data` or rejects with an
// Error carrying `code` and `authRequired`; every other message is an event for
// `on(type, fn)`. The socket opens on the first request, says `hello` first (with
// what `helloPayload()` returns: the panel's client capabilities), and opens again
// (1 s, 2 s, 4 s … 30 s) after it drops while anything is still listening;
// requests in flight when it drops reject with code 'DISCONNECTED'.
//
// A socket that never opens is not always a dropped connection: SynaBun refuses
// /ws/antigravity to its own automation browser, a relay and invite guests (403
// before the upgrade, which a page cannot see), and a server started before the
// panel existed does not know the path at all. After two opens in a row that fail,
// the client asks `probe()` (GET /api/antigravity/panel, refused or missing the same
// way) and, when the answer says the socket will not open, stops trying and emits
// `blocked { reason: 'automation' | 'refused' | 'guest' | 'restart', message }`
// instead of going on forever. `reconnectNow()` tries again at once.
// Events of its own: `connected` (hello), `disconnected`, `retrying { attempt, waitMs }`, `blocked`.
// `WebSocketImpl`, `url` and `probe` are injectable, so this runs under `node --test`.

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const PROBE_AFTER_FAILURES = 2;

export function antigravitySocketUrl(location = globalThis.location) {
  if (!location) return 'ws://127.0.0.1:3344/ws/antigravity';
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws/antigravity`;
}

/**
 * What GET /api/antigravity/panel says about the socket: { reason: null } (it should open: keep trying),
 * { reason: 'offline' } (SynaBun did not answer: keep trying), or a reason that stops the retries:
 * 'restart' (the server predates the panel), 'automation' (SynaBun's automation browser), 'guest' (an invite
 * guest), 'refused' (any other refusal: a relay, a proxy), each with the server's words in `message`.
 */
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
    const res = await fetchImpl('/api/antigravity/panel', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return probeVerdict({ status: res.status, body });
  } catch {
    return probeVerdict({ failed: true });
  }
}

export function createAntigravityClient({
  url = antigravitySocketUrl(),
  WebSocketImpl = globalThis.WebSocket,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  requestTimeoutMs = 0,
  helloPayload = () => ({}),
  probe = () => defaultProbe(),
} = {}) {
  let ws = null;
  let opening = null;
  let hello = null;
  let seq = 0;
  let attempt = 0;
  let failures = 0;          // opens in a row that closed before the hello
  let reconnectTimer = null;
  let disposed = false;
  let blocked = null;        // { reason, message } once a probe said the socket will not open
  let probing = null;
  const pending = new Map();
  const listeners = new Map();

  function emit(type, payload) {
    for (const fn of [...(listeners.get(type) || [])]) {
      try { fn(payload); } catch (error) { console.error('[antigravity] listener failed', error); }
    }
    for (const fn of [...(listeners.get('*') || [])]) {
      try { fn(type, payload); } catch (error) { console.error('[antigravity] listener failed', error); }
    }
  }

  function failPending(code, message) {
    for (const [reqId, entry] of [...pending]) {
      pending.delete(reqId);
      if (entry.timer) clearTimer(entry.timer);
      entry.reject(Object.assign(new Error(message), { code }));
    }
  }

  function onMessage(event) {
    let message;
    try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'result') {
      const entry = pending.get(message.reqId);
      if (!entry) return;
      pending.delete(message.reqId);
      if (entry.timer) clearTimer(entry.timer);
      if (message.ok) entry.resolve(message.data);
      else entry.reject(Object.assign(new Error(message.error?.message || 'Request failed'), { code: message.error?.code, data: message.error?.data, authRequired: !!message.authRequired }));
      return;
    }
    emit(message.type, message);
  }

  const listening = () => [...listeners.values()].some((set) => set.size);

  function scheduleReconnect() {
    if (disposed || reconnectTimer || blocked || !listening()) return;
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    emit('retrying', { attempt, waitMs: wait });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      // A socket that closes schedules the next try itself (onclose → afterFailure); only a socket that could not
      // even be made needs one from here.
      open().catch((error) => { if (error?.code !== 'DISCONNECTED' && error?.code !== 'BLOCKED') scheduleReconnect(); });
    }, wait);
  }

  // Two failed opens in a row: ask why before trying again.
  async function afterFailure() {
    if (failures < PROBE_AFTER_FAILURES || blocked || disposed) { scheduleReconnect(); return; }
    if (!probing) probing = Promise.resolve().then(() => probe()).catch(() => ({ reason: 'offline', message: '' })).finally(() => { probing = null; });
    const verdict = await probing;
    if (disposed) return;
    if (verdict?.reason && verdict.reason !== 'offline') {
      blocked = { reason: verdict.reason, message: verdict.message || '' };
      if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
      emit('blocked', blocked);
      return;
    }
    if (verdict?.reason === 'offline') emit('offline', {});
    scheduleReconnect();
  }

  function rawSend(type, payload) {
    const reqId = `q${++seq}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (requestTimeoutMs > 0) {
        entry.timer = setTimer(() => {
          pending.delete(reqId);
          reject(Object.assign(new Error(`${type} timed out`), { code: 'TIMEOUT' }));
        }, requestTimeoutMs);
      }
      pending.set(reqId, entry);
      try { ws.send(JSON.stringify({ ...payload, type, reqId })); } catch (error) {
        pending.delete(reqId);
        if (entry.timer) clearTimer(entry.timer);
        reject(Object.assign(new Error(error?.message || 'Send failed'), { code: 'DISCONNECTED' }));
      }
    });
  }

  function open() {
    if (disposed) return Promise.reject(Object.assign(new Error('Closed'), { code: 'DISPOSED' }));
    if (blocked) return Promise.reject(Object.assign(new Error(blocked.message || 'The Antigravity connection was refused.'), { code: 'BLOCKED', reason: blocked.reason }));
    if (ws && ws.readyState === 1 && hello) return Promise.resolve(hello);
    if (opening) return opening;
    if (typeof WebSocketImpl !== 'function') return Promise.reject(Object.assign(new Error('WebSockets are not available.'), { code: 'NO_WEBSOCKET' }));
    opening = new Promise((resolve, reject) => {
      let socket;
      try { socket = new WebSocketImpl(url); } catch (error) { opening = null; reject(error); return; }
      ws = socket;
      let settled = false;
      let opened = false;
      socket.onmessage = onMessage;
      socket.onopen = async () => {
        opened = true;
        try {
          let payload = {};
          try { payload = helloPayload() || {}; } catch { payload = {}; }
          hello = await rawSend('hello', payload);
          attempt = 0;
          failures = 0;
          settled = true;
          opening = null;
          emit('connected', hello);
          resolve(hello);
        } catch (error) {
          settled = true;
          opening = null;
          reject(error);
        }
      };
      socket.onclose = () => {
        if (ws === socket) { ws = null; hello = null; }
        failPending('DISCONNECTED', 'The connection to SynaBun dropped.');
        if (!opened) failures += 1;
        if (!settled) { settled = true; opening = null; reject(Object.assign(new Error('Could not connect to SynaBun.'), { code: 'DISCONNECTED' })); }
        emit('disconnected', { opened });
        if (listening()) afterFailure().catch(() => {});
      };
      socket.onerror = () => { /* onclose follows */ };
    });
    return opening;
  }

  async function request(type, payload = {}) {
    await open();
    return rawSend(type, payload);
  }

  /** Say hello again on the open socket (new client capabilities, or after an install): the new hello is `connected`. */
  async function refreshHello(type = 'hello', payload = null) {
    await open();
    let body = payload;
    if (!body) { try { body = helloPayload() || {}; } catch { body = {}; } }
    const answer = await rawSend(type, body);
    hello = answer;
    emit('connected', answer);
    return answer;
  }

  /** Try again now: forget a refusal, reset the back-off and open. */
  function reconnectNow() {
    blocked = null;
    failures = 0;
    attempt = 0;
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
    return open();
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }

  function dispose() {
    disposed = true;
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
    failPending('DISPOSED', 'Closed');
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
    listeners.clear();
  }

  return {
    open,
    request,
    refreshHello,
    reconnectNow,
    on,
    dispose,
    get hello() { return hello; },
    get connected() { return !!(ws && ws.readyState === 1 && hello); },
    get blocked() { return blocked; },
    supports: (capability) => !!hello?.capabilities?.includes(capability),
  };
}

// A separate, flattened CDP transport. Browser-level Target.setAutoAttach
// requires flat sessions; Playwright's public CDPSession cannot address those
// child session IDs. Do not reach into its private connection or patch Runtime.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class GuardCdpConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(`${pending.method} [session=${pending.sessionId || 'browser'}]: ${message.error.message}`), {
          code: message.error.code, method: pending.method, sessionId: pending.sessionId,
          protocolMessage: message.error.message,
          ...(!pending.sessionId ? { targetType: 'browser', targetId: 'root' } : {}),
        })); else pending.resolve(message.result);
      } else this.emit('event', message);
    });
    socket.on('close', () => { this.closed = true; this.rejectSession(); this.emit('close'); });
    socket.on('error', error => { this.rejectSession(undefined, error); });
  }
  send(method, params = {}, sessionId) {
    if (this.closed || this.closing) return Promise.reject(new Error('Network guard CDP transport closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Network guard: ${method} timed out`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer, sessionId, method });
      const failed = error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      };
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), failed); }
      catch (error) { failed(error); }
    });
  }
  rejectSession(sessionId, error = new Error('Network guard target detached')) {
    for (const [id, pending] of this.pending) {
      if (sessionId && pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error);
    }
  }
  detach() {
    if (this.detaching) return this.detaching;
    this.closing = true;
    this.rejectSession();
    this.detaching = new Promise(resolve => {
      if (this.closed) return resolve();
      const finish = () => { clearTimeout(timer); this.socket.removeListener('close', finish); resolve(); };
      // Closing our transport never closes browser targets. Await the actual
      // disconnect; terminate only this socket if the peer misses its close ACK.
      const timer = setTimeout(() => { this.socket.terminate?.(); finish(); }, 1000);
      this.socket.once('close', finish);
      try { this.socket.close(); } catch { this.socket.terminate?.(); finish(); }
    });
    return this.detaching;
  }
}

export async function connectGuardCdp(endpoint) {
  let address = endpoint;
  if (!/^wss?:\/\//.test(address)) {
    // The owned DevTools JSON API, not page retrieval. No cookies or profile
    // configuration are read or written; use the same endpoint as Playwright.
    const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Network guard: DevTools endpoint answered ${response.status}`);
    address = (await response.json()).webSocketDebuggerUrl;
  }
  if (typeof address !== 'string' || !/^wss?:\/\//.test(address)) throw new Error('Network guard: no DevTools WebSocket endpoint');
  const socket = new WebSocket(address, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return new GuardCdpConnection(socket);
}

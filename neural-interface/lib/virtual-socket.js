// ═══════════════════════════════════════════
// SynaBun — In-process "WebSocket" for reusing socket-bound server handlers
// ═══════════════════════════════════════════
//
// The Claude bridge and the Codex skin handler are written against a `ws`
// WebSocket: they call send()/ping()/terminate(), read readyState and
// bufferedAmount, and subscribe to 'message'/'close'/'pong'. The assistant
// brains drive those handlers from inside the server process, so this object
// satisfies that surface without any network socket. Outbound packets are
// delivered to `onSend`; inbound packets are injected with `receive()`.

import { EventEmitter } from 'node:events';

export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export function createVirtualSocket({ onSend = () => {}, name = 'virtual' } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const socket = {
    name,
    readyState: OPEN,
    bufferedAmount: 0,
    OPEN, CLOSING, CLOSED,
    send(payload, callback) {
      if (socket.readyState !== OPEN) { if (typeof callback === 'function') callback(new Error('virtual socket closed')); return; }
      let packet = payload;
      if (typeof payload === 'string') { try { packet = JSON.parse(payload); } catch { packet = payload; } }
      else if (Buffer.isBuffer(payload)) { try { packet = JSON.parse(payload.toString('utf8')); } catch { packet = payload.toString('utf8'); } }
      try { onSend(packet); } catch {}
      if (typeof callback === 'function') callback();
    },
    /** Inject an inbound message as the connected client would have sent it. */
    receive(message) {
      if (socket.readyState !== OPEN) return false;
      const raw = typeof message === 'string' ? message : JSON.stringify(message);
      emitter.emit('message', Buffer.from(raw, 'utf8'), false);
      return true;
    },
    ping() { setImmediate(() => { if (socket.readyState === OPEN) emitter.emit('pong'); }); },
    pong() {},
    close(code = 1000, reason = '') {
      if (socket.readyState === CLOSED) return;
      socket.readyState = CLOSED;
      emitter.emit('close', code, Buffer.from(String(reason || ''), 'utf8'));
    },
    terminate() { socket.close(1006, 'terminated'); },
    on: (...args) => { emitter.on(...args); return socket; },
    once: (...args) => { emitter.once(...args); return socket; },
    off: (...args) => { emitter.off(...args); return socket; },
    removeListener: (...args) => { emitter.removeListener(...args); return socket; },
    removeAllListeners: (...args) => { emitter.removeAllListeners(...args); return socket; },
    addEventListener(type, listener) { emitter.on(type, listener); },
    removeEventListener(type, listener) { emitter.off(type, listener); },
    emit: (...args) => emitter.emit(...args),
    listenerCount: (type) => emitter.listenerCount(type),
  };
  return socket;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — what the connected server understands (no DOM, no socket)
// Panel files are served statically and reload at any moment; server.js only
// changes when SynaBun restarts. So the server lists its request types
// (`capabilities` in init:result and after identify) and the panel shows a
// feature that needs a newer type only while that type is listed. A server
// that predates the list advertises nothing, and every gated feature stays
// hidden instead of failing with "unknown message type".
// ─────────────────────────────────────────────────────────────────────────────

export const UNSUPPORTED_MESSAGE = 'Restart SynaBun to enable this: the running server predates it.';

export function createCapabilities() {
  let types = new Set();
  const listeners = new Set();
  const emit = () => {
    for (const fn of listeners) {
      try { fn(api); } catch (e) { console.warn('[ocp-v2-caps] listener error', e); }
    }
  };
  const same = (next) => next.size === types.size && [...next].every((t) => types.has(t));
  const api = {
    /** Replace the list; anything that is not an array of strings clears it. */
    set(list) {
      const next = new Set((Array.isArray(list) ? list : []).filter((t) => typeof t === 'string' && t));
      if (same(next)) return;
      types = next;
      emit();
    },
    clear() { api.set([]); },
    has(type) { return types.has(type); },
    hasAll(...needed) { return needed.every((t) => types.has(t)); },
    list() { return [...types]; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return api;
}

/**
 * Send `payload` only when the server lists its type; otherwise resolve the
 * reply a failed request would have produced, without touching the socket.
 */
export function gatedRequest(caps, send, payload, timeoutMs) {
  if (!caps.has(payload?.type)) {
    return Promise.resolve({
      type: `${payload?.type}:result`, ok: false, unsupported: true, status: 501, error: UNSUPPORTED_MESSAGE,
    });
  }
  return send(payload, timeoutMs);
}

/** True when a reply is a failure: transport error, ok:false, or HTTP >= 400. */
export function replyFailed(res) {
  if (!res) return true;
  if (res.type === 'error' || res.ok === false || res.error) return true;
  return typeof res.status === 'number' && res.status >= 400;
}

export function replyError(res, fallback = 'Request failed') {
  if (!res) return fallback;
  const detail = res.error || res.data?.error || res.data?.message;
  if (typeof detail === 'string' && detail) return detail;
  if (detail && typeof detail === 'object') {
    try { return JSON.stringify(detail); } catch { /* fall through */ }
  }
  return typeof res.status === 'number' && res.status >= 400 ? `${fallback} (HTTP ${res.status})` : fallback;
}

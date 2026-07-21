// ═══════════════════════════════════════════
// BLOB STORE — Per-entry server storage for fat state
// ═══════════════════════════════════════════
//
// Companion to storage.js for values too large for the ui-state PATCH cycle
// (rendered transcript snapshots, graph node positions). Each entry persists
// individually — a streaming session uploads only its own snapshot, not the
// whole multi-MB map. Server side: /api/ui-blobs/:ns/:id (lib/ui-blob-store.js).

const _putTimers = new Map();   // `${ns}/${id}` -> timeout id
const _pendingPuts = new Map(); // `${ns}/${id}` -> { ns, id, value, opts }
const DEFAULT_DEBOUNCE_MS = 500;

export async function fetchBlobNamespace(ns) {
  try {
    const res = await fetch(`/api/ui-blobs/${encodeURIComponent(ns)}`);
    if (!res.ok) return {};
    const data = await res.json();
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch {
    return {};
  }
}

async function _sendPut(key) {
  const pending = _pendingPuts.get(key);
  if (!pending) return;
  _pendingPuts.delete(key);
  _putTimers.delete(key);
  const { ns, id, value, opts } = pending;
  const params = new URLSearchParams();
  if (opts.maxEntries) params.set('maxEntries', String(opts.maxEntries));
  if (opts.maxChars) params.set('maxChars', String(opts.maxChars));
  const qs = params.toString();
  try {
    const res = await fetch(`/api/ui-blobs/${encodeURIComponent(ns)}/${encodeURIComponent(id)}${qs ? '?' + qs : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[blob-store] PUT ${ns}/${id} failed:`, err.message, '— will retry');
    // Re-queue unless a newer value superseded this one while in flight.
    if (!_pendingPuts.has(key)) {
      _pendingPuts.set(key, pending);
      _putTimers.set(key, setTimeout(() => _sendPut(key), 2000));
    }
  }
}

// Debounced per-(ns,id), latest value wins.
export function putBlob(ns, id, value, opts = {}) {
  const key = `${ns}/${id}`;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  _pendingPuts.set(key, { ns, id, value, opts });
  if (_putTimers.has(key)) clearTimeout(_putTimers.get(key));
  _putTimers.set(key, setTimeout(() => _sendPut(key), debounceMs));
}

export function deleteBlob(ns, id) {
  const key = `${ns}/${id}`;
  if (_putTimers.has(key)) { clearTimeout(_putTimers.get(key)); _putTimers.delete(key); }
  _pendingPuts.delete(key);
  fetch(`/api/ui-blobs/${encodeURIComponent(ns)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    .catch(() => {});
}

// Flush all pending puts immediately. With useBeacon (pagehide path), bodies
// under ~60KB go via sendBeacon (survives unload); larger ones use a best-
// effort fetch — the last debounced PUT was at most a debounce window ago, so
// little is lost if it doesn't complete.
export function flushBlobs({ useBeacon = false } = {}) {
  for (const [key, pending] of [..._pendingPuts.entries()]) {
    if (_putTimers.has(key)) { clearTimeout(_putTimers.get(key)); _putTimers.delete(key); }
    if (useBeacon) {
      const { ns, id, value } = pending;
      const body = JSON.stringify(value);
      _pendingPuts.delete(key);
      if (body.length < 60_000) {
        navigator.sendBeacon(
          `/api/ui-blobs/${encodeURIComponent(ns)}/${encodeURIComponent(id)}`,
          new Blob([body], { type: 'application/json' })
        );
      } else {
        fetch(`/api/ui-blobs/${encodeURIComponent(ns)}/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: body.length < 640_000, // keepalive caps at ~64KB-1MB per spec/impl
        }).catch(() => {});
      }
    } else {
      _sendPut(key);
    }
  }
}

window.addEventListener('pagehide', () => flushBlobs({ useBeacon: true }));

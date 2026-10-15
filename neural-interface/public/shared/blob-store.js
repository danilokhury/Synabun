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
// One request per entry at a time, in the order they were asked for: a delete
// (or a newer write) that overtook a write still on its way would be undone by it.
const _inFlight = new Map();       // `${ns}/${id}` -> the request under way (a write or a delete); never rejects
const _waitingDeletes = new Map(); // `${ns}/${id}` -> sends the delete that waits behind that request
const _asked = new Map();          // `${ns}/${id}` -> counts the puts and deletes asked for

// Every put and delete of this page is numbered when it is asked for, and says which page it is of. Of two
// requests of one page for an entry the server keeps the one with the higher number, whichever arrives first
// (lib/ui-blob-store.js): what is sent while the page is being left (flushBlobs) cannot be put in an order here.
// A server from before this ignores the two fields; the order kept above is then all there is, as it was.
const _writer = (() => {
  try { return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
  catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
})();
let _revision = 0;

/** The address of one entry, for the request numbered `rev` (and what a write asks to be evicted). */
const _url = (ns, id, rev, opts = {}) => {
  const params = new URLSearchParams();
  if (opts.maxEntries) params.set('maxEntries', String(opts.maxEntries));
  if (opts.maxChars) params.set('maxChars', String(opts.maxChars));
  params.set('rev', String(rev));
  params.set('writer', _writer);
  return `/api/ui-blobs/${encodeURIComponent(ns)}/${encodeURIComponent(id)}?${params.toString()}`;
};
const _ask = (key) => { const n = (_asked.get(key) || 0) + 1; _asked.set(key, n); return n; };

function _track(key, request) {
  const tracked = Promise.resolve(request).then(() => {}, () => {}).then(() => { if (_inFlight.get(key) === tracked) _inFlight.delete(key); });
  _inFlight.set(key, tracked);
  return tracked;
}

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

// One entry, or null: there is none, or the server has no such namespace.
export async function fetchBlob(ns, id) {
  try {
    const res = await fetch(`/api/ui-blobs/${encodeURIComponent(ns)}/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function _sendPut(key) {
  const pending = _pendingPuts.get(key);
  if (!pending) return;
  _putTimers.delete(key);
  // Something of this entry is on its way: this write goes when that is settled (still pending until then).
  const busy = _inFlight.get(key);
  if (busy) { busy.then(() => _sendPut(key)); return; }
  _pendingPuts.delete(key);
  const { ns, id, value, opts, rev } = pending;
  const asked = _asked.get(key);
  const request = (async () => {
    const res = await fetch(_url(ns, id, rev, opts), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  })();
  _track(key, request);
  try {
    await request;
    _answer(pending.waiters, true);
  } catch (err) {
    // Re-queue only if nothing was asked for this entry meanwhile: a newer value superseded this one, or the
    // entry was deleted (a retry would bring back what was removed).
    const retry = _asked.get(key) === asked && !_pendingPuts.has(key);
    console.warn(`[blob-store] PUT ${ns}/${id} failed:`, err.message, retry ? '— will retry' : '— superseded');
    if (retry) {
      _pendingPuts.set(key, pending);
      _putTimers.set(key, setTimeout(() => _sendPut(key), 2000));
    } else {
      // Whoever waits for this write waits for the newer one that took its place; without one (the entry was
      // deleted) it was given up.
      const newer = _pendingPuts.get(key);
      if (newer) newer.waiters.push(...pending.waiters.splice(0));
      else _answer(pending.waiters, false);
    }
  }
}

// What the callers of putBlob that wait for it are told: `true`, the server has the value (or a newer one of the
// entry); `false`, the write was given up.
const _answer = (waiters, stored) => { for (const done of waiters.splice(0)) done(stored); };

// Debounced per-(ns,id), latest value wins. Answers a promise, for a caller that must not go on before the value
// is in the store: `true` once the server has stored it (or a newer value of the entry, when one was asked for
// meanwhile), `false` when the write was given up (the entry was deleted, or the page is going and the write was
// handed to a beacon, which says nothing back). It never rejects; a write that fails is tried again as before, and
// the promise waits with it.
export function putBlob(ns, id, value, opts = {}) {
  const key = `${ns}/${id}`;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  _ask(key);
  const waiters = _pendingPuts.get(key)?.waiters || [];
  const stored = new Promise((done) => { waiters.push(done); });
  _pendingPuts.set(key, { ns, id, value, opts, rev: ++_revision, waiters });
  if (_putTimers.has(key)) clearTimeout(_putTimers.get(key));
  _putTimers.set(key, setTimeout(() => _sendPut(key), debounceMs));
  return stored;
}

// A delete is tried once: one that failed (the server could not make it, refused it, or was not reached) is not
// sent again. This page cannot know what another page has written to the entry since, and a delete that arrived
// late would remove that.
export function deleteBlob(ns, id) {
  const key = `${ns}/${id}`;
  if (_putTimers.has(key)) { clearTimeout(_putTimers.get(key)); _putTimers.delete(key); }
  const dropped = _pendingPuts.get(key);
  _pendingPuts.delete(key);
  if (dropped) _answer(dropped.waiters, false);
  _ask(key);
  const rev = ++_revision;
  const send = (init = {}) => fetch(_url(ns, id, rev), { method: 'DELETE', ...init }).catch(() => {});
  const busy = _inFlight.get(key);
  if (!busy) { _track(key, send()); return; }
  // After the request of this entry that is on its way (sent once, also when the page goes first: flushBlobs).
  // Its turn sends it only while it is still the one that waits: a later delete has taken its place, or the
  // page that was about to be left has sent it already.
  _waitingDeletes.set(key, send);
  _track(key, busy.then(() => {
    if (_waitingDeletes.get(key) !== send) return undefined;
    _waitingDeletes.delete(key);
    return send();
  }));
}

// Flush all pending puts immediately. With useBeacon (pagehide path), bodies
// under ~60KB go via sendBeacon (survives unload); larger ones use a best-
// effort fetch — the last debounced PUT was at most a debounce window ago, so
// little is lost if it doesn't complete. What goes out here goes out at once,
// beside a request that may still be on its way: each carries its number, and
// the server keeps what was asked for last.
export function flushBlobs({ useBeacon = false } = {}) {
  // The page is going: a delete that waits behind a request cannot wait any longer.
  if (useBeacon) {
    for (const [key, send] of [..._waitingDeletes.entries()]) { _waitingDeletes.delete(key); send({ keepalive: true }); }
  }
  for (const [key, pending] of [..._pendingPuts.entries()]) {
    if (_putTimers.has(key)) { clearTimeout(_putTimers.get(key)); _putTimers.delete(key); }
    if (useBeacon) {
      const { ns, id, value, rev } = pending;
      const body = JSON.stringify(value);
      _pendingPuts.delete(key);
      _answer(pending.waiters, false);   // a beacon says nothing back: nobody is told it arrived
      if (body.length < 60_000) {
        navigator.sendBeacon(_url(ns, id, rev), new Blob([body], { type: 'application/json' }));
      } else {
        fetch(_url(ns, id, rev), {
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

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — one read of the provider list for every module
// The model picker, the variant picker, the context gauge and the composer
// each need `GET /api/opencode/providers/full` (the whole models.dev catalog,
// a few hundred kilobytes). They ask through here, so opening the panel reads
// it once. A change (`ocp-providers-changed`) drops the copy.
// ─────────────────────────────────────────────────────────────────────────────

// Long enough to cover the burst of readers at mount and at a refresh, short
// enough that a later, deliberate refresh reads the server again.
export const PROVIDERS_SHARE_MS = 3000;

/** A cache around `fetchJson()`: concurrent and near-simultaneous callers share one read. */
export function createSharedFetch(fetchJson, { shareMs = PROVIDERS_SHARE_MS, now = () => Date.now() } = {}) {
  let promise = null;
  let startedAt = 0;
  const read = () => {
    if (promise && now() - startedAt < shareMs) return promise;
    startedAt = now();
    const current = Promise.resolve().then(fetchJson);
    promise = current;
    // A failed read is not kept: the next caller tries again.
    current.catch(() => { if (promise === current) promise = null; });
    return current;
  };
  read.invalidate = () => { promise = null; };
  return read;
}

/** The parsed body of GET /api/opencode/providers/full: `{ ok, data: { all, default, connected } }`. */
export const fetchProvidersFull = createSharedFetch(() => fetch('/api/opencode/providers/full').then((r) => r.json()));

if (typeof document !== 'undefined') {
  document.addEventListener('ocp-providers-changed', () => fetchProvidersFull.invalidate());
}

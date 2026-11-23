// The memory count GET /api/health reports, kept for a few seconds.
//
// /api/health is the probe every open page sends every 3 s to tell a running server from a stopped one. It used to
// run a synchronous COUNT(*) on the memory database for each of them, on the server's one thread, so the probe was
// only as fast as the slowest statement in front of it. The answer to "is the server up" must not wait on the
// database: the count is read once per `ttlMs` and every probe in between gets the kept one.
//
// A read that throws is never kept: it throws to the caller (the route then says `ok: false, reason: 'db_error'`, as
// it always did) and the next request reads again.
//
// While the memory store is being upgraded (lib/memory-store-gate.js) the probe runs no statement: the count is null,
// and `storeState()` is what the route adds to say why. In the normal case it adds nothing.

export const HEALTH_COUNT_TTL_MS = 15_000;

/**
 * @param {{ read: () => number, ttlMs?: number, now?: () => number, store?: { reported: () => object | null } | null }} o
 * @returns {(() => number | null) & { invalidate: () => void, storeState: () => object }}
 */
export function createHealthCount({ read, ttlMs = HEALTH_COUNT_TTL_MS, now = Date.now, store = null } = {}) {
  if (typeof read !== 'function') throw new Error('read is required');
  let kept = null;
  const closed = () => { const state = store?.reported()?.state; return state === 'migrating' || state === 'failed'; };
  const count = () => {
    if (closed()) return null;
    const at = now();
    if (kept && at - kept.at < ttlMs && at >= kept.at) return kept.value;
    let value;
    // This very read may be the one that found the migration and started it.
    try { value = read(); } catch (error) { if (closed()) return null; throw error; }
    kept = { value, at };
    return value;
  };
  count.invalidate = () => { kept = null; };
  count.storeState = () => { const reported = store?.reported() ?? null; return reported ? { store: reported } : {}; };
  return count;
}

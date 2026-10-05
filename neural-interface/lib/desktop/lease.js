// ═══════════════════════════════════════════
// SynaBun — Desktop lease (one controller at a time)
// ═══════════════════════════════════════════
//
// There is one screen and one cursor. The lease names who drives it: an
// assistant session (its brain) or one of its computer-use worker runs. A
// session's worker takes the lease over from its parent; anyone else waits
// (DESKTOP_BUSY). An idle lease expires so a forgotten holder never blocks.

export function ownerKey(owner = {}) {
  return owner.runId ? `run:${owner.runId}` : `session:${owner.assistantSessionId || 'unknown'}`;
}

export function createLease({ now = Date.now, idleTtlMs = () => 120_000 } = {}) {
  let holder = null; // { key, owner, since, lastActionAt }
  const ttl = () => (typeof idleTtlMs === 'function' ? idleTtlMs() : idleTtlMs);

  function expired() { return !!holder && now() - holder.lastActionAt > ttl(); }
  function current() { if (expired()) holder = null; return holder ? { ...holder, owner: { ...holder.owner } } : null; }

  /** → { ok:true, acquired:boolean, transferred:boolean } | { ok:false, holder } */
  function acquire(owner) {
    const key = ownerKey(owner);
    if (expired()) holder = null;
    if (!holder) {
      holder = { key, owner: { ...owner }, since: now(), lastActionAt: now() };
      return { ok: true, acquired: true, transferred: false };
    }
    if (holder.key === key) { holder.lastActionAt = now(); return { ok: true, acquired: false, transferred: false }; }
    // A worker run dispatched by the holding session takes over.
    if (owner.runId && !holder.owner.runId && holder.owner.assistantSessionId && holder.owner.assistantSessionId === owner.assistantSessionId) {
      holder = { key, owner: { ...owner }, since: now(), lastActionAt: now() };
      return { ok: true, acquired: true, transferred: true };
    }
    return { ok: false, holder: current() };
  }
  function refresh(owner) { if (holder && holder.key === ownerKey(owner)) holder.lastActionAt = now(); }
  /** Release when the holder matches (by key, run id or session id). Returns the released holder. */
  function release({ key = null, runId = null, assistantSessionId = null } = {}) {
    if (!holder) return null;
    const h = holder;
    const match = (key && h.key === key) || (runId && h.owner.runId === String(runId))
      || (assistantSessionId && h.owner.assistantSessionId === String(assistantSessionId));
    if (!match) return null;
    holder = null;
    return h;
  }
  function forceRelease() { const h = holder; holder = null; return h; }
  function retryAfterMs() { return holder ? Math.max(1000, ttl() - (now() - holder.lastActionAt)) : 0; }
  return { acquire, refresh, release, forceRelease, current, retryAfterMs, expired };
}

// ═══════════════════════════════════════════
// SynaBun Neural Interface — is the server gone, or only slow
// What the page concludes from health probes that were not answered.
// DOM-free and dependency-free (unit-tested under Node).
//
// The page asks GET /api/health every 3 s and gives each request 3 s. It used
// to show "Server offline" after two requests in a row without an answer: six
// seconds. On 2026-11-21 a server that never stopped (same boot id before and
// after, its WebSockets still open) was shown as offline that way, twice,
// while it worked through slow database statements during and after a 9.4 GB
// backup. Not answering in time is not being gone, and the two look different
// from here:
//
//   refused   the request failed at once: nothing listens on the port (the
//             process ended), or what answered is not the server. Asked once
//             more right away; refused again is offline. A real stop is still
//             reported within the time of two failed connections.
//   timeout   the connection was taken and no answer came in time: the
//             process is there and busy (or the machine is). Nothing is shown
//             until that has lasted `slowGraceMs` over at least `slowMisses`
//             probes in a row; one answer in between starts the count again.
//             A hung server is still reported, just not a slow one.
//
// A hidden tab never concludes "offline" from timeouts: browsers hold back a
// background tab's timers and requests, so a late answer there says nothing
// about the server. It looks again the moment it is shown (`shown()`).
// ═══════════════════════════════════════════

export const PRESENCE_LIMITS = {
  slowGraceMs: 20000, // unanswered (but not refused) for this long before the offline screen
  slowMisses: 3,      // and at least this many probes in a row
};

/** How a failed probe ended: 'timeout' (given up on waiting) or 'refused' (nothing took it, or not the server's answer). */
export function probeFailureKind(error) {
  const name = String(error?.name || '');
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'refused';
}

/**
 * The misses of one page, in a row.
 *   missed(kind, { hidden, confirmed }) → 'confirm' | 'offline' | 'wait'
 *       'confirm'  refused once: ask again right away, then call missed(kind, { confirmed: true })
 *       'offline'  show the offline screen
 *       'wait'     slow, or a hidden tab that cannot tell: show nothing, keep probing
 *   answered() → { recovered, misses, ms }   an answer from the server ends the row
 *   snapshot() → { misses, ms, held } | null  the row under way (held: 'slow' | 'hidden' | null)
 */
export function createServerPresence({ limits = PRESENCE_LIMITS, now = () => Date.now() } = {}) {
  const lim = { ...PRESENCE_LIMITS, ...limits };
  let row = null; // { since, misses, held }

  return {
    missed(kind, { hidden = false, confirmed = false } = {}) {
      if (!row) row = { since: now(), misses: 0, held: null };
      row.misses += 1;
      if (kind !== 'timeout') {
        row.held = null;
        return confirmed ? 'offline' : 'confirm';
      }
      if (hidden) { row.held = 'hidden'; return 'wait'; }
      if (row.misses >= lim.slowMisses && now() - row.since >= lim.slowGraceMs) { row.held = null; return 'offline'; }
      row.held = 'slow';
      return 'wait';
    },
    answered() {
      const had = row;
      row = null;
      return had ? { recovered: true, misses: had.misses, ms: Math.max(0, now() - had.since) } : { recovered: false, misses: 0, ms: 0 };
    },
    snapshot() {
      return row ? { misses: row.misses, ms: Math.max(0, now() - row.since), held: row.held } : null;
    },
    /** The offline screen is up, or the page gave up watching: whatever comes next is a new row. */
    reset() { row = null; },
  };
}

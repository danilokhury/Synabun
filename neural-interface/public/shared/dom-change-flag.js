// ═══════════════════════════════════════════
// SynaBun Neural Interface — "did this subtree change since I last looked?"
// ═══════════════════════════════════════════
// One MutationObserver and one boolean per watched element. The side panels
// store a snapshot of each transcript (its markup, serialised) so a session
// shows at once after a reload; they wrote it again on every tab switch,
// changed or not: a clone and a serialisation of the whole transcript, plus an
// upload, inside the click that opens another session. With the flag a switch
// writes only what changed since the last write.
//
//   createDomChangeFlag(el) → { changed(), clear(), disconnect() }
//
// `changed()` is true from the start (nothing is known yet), after any node,
// text or attribute change under `el`, and always where there is no observer
// (an old engine, a test without one): a caller that cannot tell writes, as it
// did before. `clear()` says "what is there now has been written". Changes of
// the current task that the observer has not delivered yet are counted too.
// DOM-light on purpose: tests/dom-change-flag.test.mjs drives it with a
// stand-in observer.
//
// `ignore(record)` (optional) names records that are not a change of what is
// stored: the inline declarations transcript-rows.js puts on rows far from the
// screen come and go as the user scrolls, and a stored transcript holds none
// of them. A record it throws on counts as a change.

export function createDomChangeFlag(el, { MutationObserver: Observer, ignore = null } = {}) {
  const Ctor = Observer || el?.ownerDocument?.defaultView?.MutationObserver || globalThis.MutationObserver;
  let changed = true;
  let observer = null;
  /** Does any of these records count? Without a filter every record does. */
  const counts = (records) => {
    if (typeof ignore !== 'function') return records.length > 0;
    for (const record of records) {
      try { if (!ignore(record)) return true; } catch { return true; }
    }
    return false;
  };
  if (el && typeof Ctor === 'function') {
    try {
      observer = new Ctor((records) => { if (!Array.isArray(records) || counts(records)) changed = true; });
      observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
    } catch { observer = null; }
  }

  /** Records the observer holds but has not delivered: a change made earlier in this very task. */
  function pending() {
    try { return counts(observer?.takeRecords?.() || []); } catch { return true; }
  }

  return {
    changed() {
      if (!observer) return true;
      if (!changed && pending()) changed = true;
      return changed;
    },
    clear() {
      if (!observer) return;
      pending();
      changed = false;
    },
    disconnect() {
      try { observer?.disconnect(); } catch { /* already gone */ }
      observer = null;
    },
  };
}

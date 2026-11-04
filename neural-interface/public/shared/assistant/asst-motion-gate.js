// ═══════════════════════════════════════════
// SynaBun Assistant — loops run only on screen
// ═══════════════════════════════════════════
// The transcript's decorative loops (a run card's cameo, its stage's scene and
// sweep; a live rack's sweep, ticks and scene; a route line's sweep and icon)
// run only while their holder is on screen. One IntersectionObserver per
// renderer marks a holder that is not (scrolled out of its transcript, its tab
// hidden, its window minimised to nothing) with `data-offscreen`; the
// stylesheet pauses every animation under it (asst-styles.js), and the loop
// picks up where it stopped when the holder is back. Every frame the page
// draws restyles each running animation on the main thread, composited or
// not, so a loop nobody sees is never free; the observer is the browser's own,
// so watching costs nothing while the transcript scrolls.
//
//   createMotionGate({ IntersectionObserver }?) → { watch(el), unwatch(el), disconnect(), size() }
//
// No observer (an old engine, a test without one): nothing is marked, every
// loop runs as before. DOM-light on purpose: tests/assistant-motion-gate.test.mjs
// drives it with a stand-in observer.

export const OFFSCREEN_ATTR = 'data-offscreen';
const PRUNE_EVERY = 32; // watched holders between two sweeps for ones that left the document

export function createMotionGate({ IntersectionObserver: IO = globalThis.IntersectionObserver } = {}) {
  const watched = new Set();
  let io = null; // undefined: no observer here

  function mark(el, off) {
    try {
      if (off) { if (!el.hasAttribute(OFFSCREEN_ATTR)) el.setAttribute(OFFSCREEN_ATTR, ''); }
      else if (el.hasAttribute(OFFSCREEN_ATTR)) el.removeAttribute(OFFSCREEN_ATTR);
    } catch { /* not an element */ }
  }

  function observer() {
    if (io !== null) return io;
    if (typeof IO !== 'function') { io = undefined; return io; }
    try {
      io = new IO((entries) => {
        for (const entry of entries) {
          const el = entry.target;
          if (!watched.has(el)) continue;
          if (el.isConnected === false) { unwatch(el); continue; }
          mark(el, !entry.isIntersecting);
        }
      });
    } catch { io = undefined; }
    return io;
  }

  /** Holders removed while already off screen get no report: drop them now and then. */
  function prune() {
    for (const el of Array.from(watched)) if (el.isConnected === false) unwatch(el);
  }

  function watch(el) {
    if (!el || watched.has(el)) return false;
    const o = observer();
    if (!o) return false;
    watched.add(el);
    try { o.observe(el); } catch { watched.delete(el); return false; }
    if (watched.size % PRUNE_EVERY === 0) prune();
    return true;
  }

  function unwatch(el) {
    if (!watched.delete(el)) return;
    try { io?.unobserve(el); } catch { /* already gone */ }
    mark(el, false);
  }

  function disconnect() {
    try { io?.disconnect(); } catch { /* already gone */ }
    for (const el of watched) mark(el, false);
    watched.clear();
    if (io) io = null;
  }

  return { watch, unwatch, disconnect, size: () => watched.size };
}

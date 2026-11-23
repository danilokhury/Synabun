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
//   createMotionGate({ IntersectionObserver, onMark }?) → { watch(el), unwatch(el), disconnect(), size() }
//   createMarkSettle({ reconsider }) → { hold(row), holds(row), size(), dispose() }
//
// No observer (an old engine, a test without one): nothing is marked, every
// loop runs as before. DOM-light on purpose: tests/assistant-motion-gate.test.mjs
// drives it with a stand-in observer.
//
// A mark pauses nothing until the engine has styled it, and Chromium styles
// nothing inside a transcript row it skips (transcript-rows.js hands a row far
// from the screen to `content-visibility: auto`). A holder that leaves the
// screen in one jump is marked in the same frame as its row is made far, by
// two observers whose callbacks the engine runs in either order: when the row
// came first the pause never reached the animations, which stayed `running`
// for as long as the row was away. `onMark` tells the host of every mark that
// changed; createMarkSettle keeps the holder's row plain until that mark has
// been styled (the host: asst-panel.js).

export const OFFSCREEN_ATTR = 'data-offscreen';
const PRUNE_EVERY = 32; // watched holders between two sweeps for ones that left the document
/**
 * Frames a row stays plain after a mark changed under it. The first of them may be the frame the mark was
 * written in (its callbacks run before that frame is styled); the second cannot be, so every frame in
 * between was styled with the mark in it and the row plain.
 */
export const SETTLE_FRAMES = 2;

export function createMotionGate({ IntersectionObserver: IO = globalThis.IntersectionObserver, onMark = null } = {}) {
  const watched = new Set();
  let io = null; // undefined: no observer here

  function mark(el, off) {
    let changed = false;
    try {
      if (off) { if (!el.hasAttribute(OFFSCREEN_ATTR)) { el.setAttribute(OFFSCREEN_ATTR, ''); changed = true; } }
      else if (el.hasAttribute(OFFSCREEN_ATTR)) { el.removeAttribute(OFFSCREEN_ATTR); changed = true; }
    } catch { /* not an element */ }
    if (changed && typeof onMark === 'function') { try { onMark(el, off); } catch { /* the mark stands */ } }
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

/**
 * The rows a mark just changed under, each kept plain until the mark has been styled.
 *
 * `hold(row)` holds a row for SETTLE_FRAMES frames and asks `reconsider(row)` at once (a row already made
 * far is made plain again, in the task that wrote the mark) and once more when the hold ends (the row may
 * be far from then on). `holds(row)` is what the row watcher's `skip` asks. Nothing here reads a style or a
 * layout, and no frame is asked for while no row is held. A page that draws no frame (a hidden tab) keeps
 * its rows held, and plain, until it draws again. Without `requestAnimationFrame` nothing is ever held.
 *
 * @param {object} options
 * @param {(row: Element) => void} options.reconsider  decide again whether the row is far (the row watcher's)
 */
export function createMarkSettle({
  reconsider,
  frames = SETTLE_FRAMES,
  requestFrame = globalThis.requestAnimationFrame,
  cancelFrame = globalThis.cancelAnimationFrame,
} = {}) {
  /** @type {Map<Element, number>} row → frames it is still held for */
  const held = new Map();
  let request = 0;
  let disposed = false;

  const again = (row) => { try { reconsider?.(row); } catch { /* the row or its watcher is gone */ } };

  function frame() {
    request = 0;
    if (disposed) return;
    for (const [row, left] of Array.from(held)) {
      if (left > 1) { held.set(row, left - 1); continue; }
      held.delete(row);
      again(row);
    }
    if (held.size) request = requestFrame(frame);
  }

  function hold(row) {
    if (disposed || !row || typeof requestFrame !== 'function') return false;
    held.set(row, frames); // a second mark under a held row starts its count again
    again(row);
    if (!request) request = requestFrame(frame);
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (request && typeof cancelFrame === 'function') { try { cancelFrame(request); } catch { /* already gone */ } }
    request = 0;
    held.clear();
  }

  return { hold, holds: (row) => held.has(row), size: () => held.size, dispose };
}

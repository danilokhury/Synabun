// ── Graph pointer activity + resize coalescing ──
//
// The graph's render loop idles at a low frame rate until something counts as
// activity. A document-level mousemove used to count unconditionally, so moving
// the mouse over a terminal woke the Three.js scene (and its bloom chain) to
// full frame rate. These helpers decide what is really graph activity. They have
// no three.js dependency so they can be tested without a WebGL scene.

// UI that sits above the graph and must never wake it, even when it is a
// descendant of #graph-container.
const NON_GRAPH_UI = [
  '.term-viewport', '.term-float-tab', '#terminal-panel', '#term-peek-dock',
  '.sp-sidepanel', '.glass', '.resizable', '.detail-card',
  'input', 'textarea', 'select', 'button', '[contenteditable]',
].join(',');

/**
 * True when a pointer event is graph activity: the pointer is over the graph
 * canvas, or over a graph-owned overlay inside #graph-container. Terminals,
 * floats, panels and glass UI never count. A drag only counts when it started
 * on the canvas (`canvasDown`), so dragging a window across the graph does not
 * wake it while an orbit drag that leaves the canvas keeps it awake.
 *
 * @param {MouseEvent|PointerEvent|{target?: EventTarget, buttons?: number}} e
 * @param {HTMLCanvasElement|null|undefined} canvas  The graph canvas
 * @param {boolean} [canvasDown]  A press started on the canvas and is still held
 */
export function isGraphPointerActivity(e, canvas, canvasDown = false) {
  if (!e || !canvas) return false;
  if (canvasDown) return true;
  // A button is held but the press did not start on the canvas: a window/panel drag
  if (e.buttons) return false;
  const target = e.target;
  if (!target || typeof target.closest !== 'function') return false;
  if (target === canvas) return true;
  const container = canvas.closest?.('#graph-container') || canvas.parentElement;
  if (!container || !container.contains(target)) return false;
  return !target.closest(NON_GRAPH_UI);
}

/**
 * Debounce `fn` until `delayMs` of quiet. Returns a callable with:
 *  - `.flush()`  run a pending call now (e.g. on the container's transitionend)
 *  - `.cancel()` drop a pending call
 *  - `.pending`  whether a call is scheduled
 */
export function createResizeCoalescer(fn, delayMs = 150) {
  let timer = null;
  const run = () => {
    timer = null;
    fn();
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };
  schedule.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    run();
  };
  schedule.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  Object.defineProperty(schedule, 'pending', { get: () => timer !== null });
  return schedule;
}

// ═══════════════════════════════════════════
// SynaBun Neural Interface — App frame
// The inset rounded card the workspace sits in (styles.css "APP FRAME"). Outside it is the chrome: the title bar,
// the two explorers and a gutter of their tone. Inside it is everything else: the 3D and 2D graphs, every floating
// window and panel, the terminal, menus, tooltips and popovers. Modals and full-window backdrops still cover the
// whole window.
//
// One source of geometry: the CSS variables of :root (--navbar-height, --explorer-width, --file-explorer-width and
// --frame-gap, which is 0 on a page without the frame). frameRect() is the rect every clamp uses instead of 0,
// innerWidth, innerHeight or --navbar-height. The top half of this file is DOM-free (unit-tested).
// ═══════════════════════════════════════════

/** The class on <html> of a page that draws the frame (html-shell.js). */
export const FRAMED_CLASS = 'app-framed';

const num = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The frame's rect in viewport pixels from the window's size and the chrome around it: the navbar's height, the
 * open explorers' width and the gutter. A frame the window is too small for collapses to a zero-size rect at its
 * top-left corner instead of turning inside out.
 */
export function computeFrameRect({ viewportWidth = 0, viewportHeight = 0, navbarHeight = 0, sidebarWidth = 0, gap = 0 } = {}) {
  const g = Math.max(0, num(gap));
  const left = Math.max(0, num(sidebarWidth)) + g;
  const top = Math.max(0, num(navbarHeight)) + g;
  const right = Math.max(left, num(viewportWidth) - g);
  const bottom = Math.max(top, num(viewportHeight) - g);
  return { left, top, right, bottom, width: right - left, height: bottom - top, gap: g };
}

/** The area a menu, tooltip or popover for a point is kept in: `frame` when the point is inside it, else null (the
 *  window: the bar and the explorers are outside the frame, and what opens from them stays by them). */
export function boundsForPoint(frame, x, y) {
  if (!frame || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return x >= frame.left && x <= frame.right && y >= frame.top && y <= frame.bottom ? frame : null;
}

/** A rect `margin` pixels inside another (never inverted). */
export function insetRect(rect, margin = 0) {
  const m = Math.max(0, num(margin));
  const left = rect.left + m, top = rect.top + m;
  const right = Math.max(left, rect.right - m), bottom = Math.max(top, rect.bottom - m);
  return { ...rect, left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Where a box of `width` × `height` at (x, y) goes to stay inside `bounds`. A box larger than the bounds keeps its
 * top-left corner inside them (its header stays reachable), the same rule the old window clamps followed.
 */
export function clampBox(x, y, width, height, bounds) {
  return {
    x: Math.max(bounds.left, Math.min(num(x), bounds.right - Math.max(0, num(width)))),
    y: Math.max(bounds.top, Math.min(num(y), bounds.bottom - Math.max(0, num(height)))),
  };
}

/**
 * Where a box goes that must keep only `keep` pixels on screen (the floating terminals): its left edge may run
 * past the frame's left side and its right side past the frame's right, but its top never above the frame's top
 * (the header stays reachable).
 */
export function clampBoxLoose(x, y, width, height, bounds, keep = 80) {
  const k = Math.max(0, num(keep));
  return {
    x: Math.max(bounds.left + k - Math.max(0, num(width)), Math.min(num(x), bounds.right - k)),
    y: Math.max(bounds.top, Math.min(num(y), bounds.bottom - k)),
  };
}

// ── Page side ──

let _cacheKey = '';
let _cacheRect = null;

const isFramed = (el) => !!el?.classList?.contains?.(FRAMED_CLASS);

function inlineKey(el, win) {
  const s = el.style;
  return [
    isFramed(el) ? 1 : 0,
    s.getPropertyValue('--navbar-height'),
    s.getPropertyValue('--explorer-width'),
    s.getPropertyValue('--file-explorer-width'),
    s.getPropertyValue('--frame-gap'),
    win.innerWidth,
    win.innerHeight,
  ].join('|');
}

/**
 * The frame's rect now, in viewport pixels. Cheap to call per pointer event: the computed style is read only when
 * the window's size or one of the inline variables it depends on changed since the last call. A page without the
 * frame (a detached session window, onboarding) has no bar or explorers around its content: the whole window.
 */
export function frameRect(win = typeof window !== 'undefined' ? window : null) {
  const whole = () => computeFrameRect({ viewportWidth: win?.innerWidth || 0, viewportHeight: win?.innerHeight || 0 });
  const el = win?.document?.documentElement;
  if (!el || !isFramed(el) || typeof win.getComputedStyle !== 'function') return whole();
  try {
    const key = inlineKey(el, win);
    if (key === _cacheKey && _cacheRect) return _cacheRect;
    const cs = win.getComputedStyle(el);
    const navbar = cs.getPropertyValue('--navbar-height');
    _cacheRect = computeFrameRect({
      viewportWidth: win.innerWidth,
      viewportHeight: win.innerHeight,
      navbarHeight: navbar.trim() ? num(navbar) : 48,
      sidebarWidth: num(cs.getPropertyValue('--explorer-width')) + num(cs.getPropertyValue('--file-explorer-width')),
      gap: num(cs.getPropertyValue('--frame-gap')),
    });
    _cacheKey = key;
    return _cacheRect;
  } catch {
    return whole();
  }
}

/** Keep a box inside the frame (inset by `margin`): `{ x, y }` for its top-left corner. */
export function clampToFrame(x, y, width, height, margin = 0) {
  return clampBox(x, y, width, height, insetRect(frameRect(), margin));
}

/** The area a window of `width` × `height` is kept in: the frame when it fits there, else the whole window less
 *  8px (a modal taller than the frame still shows whole, as it did before the frame). */
export function windowArea(width, height, rect = frameRect()) {
  if (width <= rect.width && height <= rect.height) return rect;
  const vw = typeof window !== 'undefined' ? window.innerWidth : rect.right;
  const vh = typeof window !== 'undefined' ? window.innerHeight : rect.bottom;
  return insetRect(computeFrameRect({ viewportWidth: vw, viewportHeight: vh }), 8);
}

/** Where a window of `width` × `height` opens by default: centred in the frame, inside it (windowArea). */
export function centeredInFrame(width, height, rect = frameRect()) {
  const area = windowArea(width, height, rect);
  const at = clampBox(area.left + (area.width - width) / 2, area.top + (area.height - height) / 2, width, height, area);
  return { left: Math.round(at.x), top: Math.round(at.y) };
}

/** The area kept for something opened at a point: the frame when the point is in it, else the whole window. */
export function placementArea(x, y) {
  const f = frameRect();
  return boundsForPoint(f, x, y) || computeFrameRect({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
}

const _listeners = new Set();
let _watching = false;
let _lastNotified = '';
let _notifyRaf = 0;

function notify() {
  _notifyRaf = 0;
  const rect = frameRect();
  const key = `${rect.left}|${rect.top}|${rect.right}|${rect.bottom}`;
  if (key === _lastNotified) return;
  _lastNotified = key;
  for (const fn of [..._listeners]) {
    try { fn(rect); } catch (err) { console.error('[app-frame] listener failed', err); }
  }
}

function schedule() {
  if (_notifyRaf) return;
  _notifyRaf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(notify) : setTimeout(notify, 16);
}

function watch() {
  if (_watching || typeof window === 'undefined' || !window.document?.documentElement) return;
  _watching = true;
  const r = frameRect();
  _lastNotified = `${r.left}|${r.top}|${r.right}|${r.bottom}`;
  window.addEventListener?.('resize', schedule);
  // An explorer opening or closing, the navbar's measured height and the frame's own class all land on <html>'s
  // inline style or class list. Writes the frame does not depend on (--terminal-height, --right-panel-width…) are
  // filtered out by the rect comparison in notify().
  if (typeof MutationObserver === 'function') {
    new MutationObserver(schedule).observe(window.document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  }
}

/**
 * Call `fn(rect)` once per frame in which the frame's rect changed (window resize, an explorer opening or closing,
 * the navbar's height). Returns the unsubscribe function.
 */
export function onFrameChange(fn) {
  _listeners.add(fn);
  watch();
  return () => _listeners.delete(fn);
}

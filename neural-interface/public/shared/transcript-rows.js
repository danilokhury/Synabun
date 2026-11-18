// ═══════════════════════════════════════════
// SynaBun Neural Interface — the rows of a long transcript that are far from the screen cost nothing
// ═══════════════════════════════════════════
// A side panel's transcript keeps every row in the page: a long Claude session is 13,000 elements, and each
// restyle of the whole page (a variable written on <html> for every frame of a panel resize or a terminal
// drag, a class on <body>) walked all of them, on screen or not; a resize laid all of them out again, every
// frame. A closed panel is skipped whole (ui-sidepanel-windows.js). This is the same for the panel that is
// open: a row more than a screenful away from the visible part of its transcript is handed to
// `content-visibility: auto` at the exact size it was last laid out at, so the engine leaves what is inside
// it out of style, layout and paint until it comes near again.
//
// What keeps this invisible:
//  - A row on screen, or within one screen height above or below it, carries nothing: no containment, no
//    clip, no stacking context. What the user can see is drawn exactly as before (hover buttons that stick out
//    of a row, a card's glow, a menu opened in a row).
//  - A far row keeps its place and its size to the pixel: the size is the one a ResizeObserver reported for
//    it, never an estimate, and a row is only ever made far after it has been laid out. The transcript's
//    scroll height, the scroll position and the scrollbar do not move.
//  - `auto`, not `hidden`: find-in-page, a selection, focus, scrollIntoView and an anchor reach into a far
//    row, and the engine draws a far row by itself the moment it reaches the screen (a jump with the
//    scrollbar or End), before this module has even heard of it.
//  - The newest rows (the tail, where a session streams) are never far, so a session that writes while the
//    user reads further up grows the transcript as it always did.
//  - A row whose children's margins would collapse through it is left alone: containment would stop that
//    collapse and change the row's height.
//  - A far row whose content changed, or whose panel was resized meanwhile, has a stale size until it comes
//    near; it then takes its real one while still off screen. Rows above the visible part changing height
//    is what scroll anchoring is for; where the engine has none (Safari) the scroll position is moved by the
//    same amount here, so what is on screen stays where it is.
//  - Everything is three inline declarations on the row (content-visibility, its size, flex-shrink: 0),
//    written and removed together. Nothing here adds an
//    element, a class or an attribute, and a snapshot of a transcript is stored without them
//    (stripFarRowStyles, isFarRowStyleRecord).
//
// The deciding part is page-free and unit-tested (tests/transcript-rows.test.mjs); the observers are injected.

/** How far beyond the visible part of the transcript a row stays plain: one height of it, above and below. */
export const NEAR_MARGIN = '100% 0px';
/** The rows at the end that are never far: the row a session is writing, and the one before it. */
export const LIVE_TAIL_ROWS = 2;
/** A row smaller than this is not worth skipping (and a 0 px row is one that is not laid out at all). */
export const MIN_FAR_HEIGHT = 8;

/** How long after a far row is made plain a change of its height is still the stale size being corrected. */
const SETTLE_MS = 400;

const CV = 'content-visibility';
const CIS = 'contain-intrinsic-size';
const FS = 'flex-shrink';

// `display` values that make an element lay its children out in a context of its own: their margins never
// collapse through it, with or without containment.
const SELF_CONTAINED_DISPLAY = /^(?:inline-)?(?:flex|grid|table|flow-root)$|^inline-block$|^table-/;

/**
 * Would layout containment change this row's height? It does when a child's vertical margin collapses
 * through the row's top or bottom edge today: containment stops that. Pure: takes a computed style (or
 * anything with these fields) and what the row's parent is.
 *
 * @param {{ display?: string, overflowY?: string, paddingTop?: string, paddingBottom?: string,
 *   borderTopWidth?: string, borderBottomWidth?: string, contain?: string, position?: string, float?: string }} style
 */
export function rowKeepsItsHeight(style) {
  if (!style) return false;
  const display = String(style.display || '');
  if (display === 'none' || display === 'contents') return false;
  if (SELF_CONTAINED_DISPLAY.test(display)) return true;
  if (style.overflowY && style.overflowY !== 'visible') return true;
  if (/\b(?:layout|content|strict|paint)\b/.test(String(style.contain || ''))) return true;
  if (style.position === 'absolute' || style.position === 'fixed') return true;
  if (style.float && style.float !== 'none') return true;
  const px = (value) => parseFloat(value) || 0;
  const topClosed = px(style.paddingTop) > 0 || px(style.borderTopWidth) > 0;
  const bottomClosed = px(style.paddingBottom) > 0 || px(style.borderBottomWidth) > 0;
  return topClosed && bottomClosed;
}

/**
 * Should this row be far? Pure.
 * @param {{ near: boolean | undefined, width: number, height: number, safe: boolean, tail: boolean }} row
 */
export function shouldBeFar({ near, width, height, safe, tail }) {
  return near === false && safe === true && tail === false
    && Number.isFinite(height) && height >= MIN_FAR_HEIGHT && Number.isFinite(width) && width > 0;
}

/**
 * The value of `contain-intrinsic-size` for a far row: its last laid out CONTENT box, exactly. The
 * property sizes the content box; padding and border are added to it as always, so the row's outer size is
 * what it was. (The border box here would grow every far row by its own padding.)
 */
export function farSize(width, height) {
  // As reported, never rounded: engines lay out in fractions of a pixel (1/64, 1/60), and a size rounded to
  // a hundredth lands on the next fraction down for some rows. A sixty-fourth of a pixel per row is nothing,
  // and eight pixels of scroll height over five hundred of them.
  return `${width}px ${height}px`;
}

/** Take this module's two declarations off an element. Returns true when it carried them. */
export function clearFarRow(el) {
  const style = el?.style;
  if (!style || typeof style.getPropertyValue !== 'function') return false;
  if (style.getPropertyValue(CV) !== 'auto') return false;
  style.removeProperty(CV);
  style.removeProperty(CIS);
  style.removeProperty(FS);
  return true;
}

/**
 * Take the far declarations off every row of a copy of a transcript (what a snapshot stores): a stored
 * transcript must not come back with the sizes of another day and another width.
 */
export function stripFarRowStyles(container) {
  let stripped = 0;
  for (const row of container?.children || []) if (clearFarRow(row)) stripped += 1;
  return stripped;
}

/**
 * Is this mutation record one of this module's own writes: the `style` attribute of a row of `container`?
 * A watcher that asks "did the transcript change?" (dom-change-flag.js) leaves these out, since what is
 * stored never holds them. Any other style change on a row counts as before only when it is not paired with
 * a far declaration, which is the best that can be told from a record: rows do not carry other inline styles.
 */
export function isFarRowStyleRecord(record, container) {
  return !!record && record.type === 'attributes' && record.attributeName === 'style'
    && !!record.target && record.target.parentNode === container;
}

/**
 * Watch the rows of a transcript.
 *
 * @param {Element} scroller   the element that scrolls
 * @param {object} [options]
 * @param {Element} [options.container]  the element whose children are the rows (default: the scroller)
 * @param {(row: Element) => boolean} [options.skip]  rows to leave alone whatever else holds
 * @returns {{ refresh(): void, disconnect(): void, farCount(): number }}
 */
export function watchTranscriptRows(scroller, {
  container = scroller,
  skip = null,
  view = scroller?.ownerDocument?.defaultView || globalThis,
  IntersectionObserver: IO = view.IntersectionObserver,
  ResizeObserver: RO = view.ResizeObserver,
  MutationObserver: MO = view.MutationObserver,
  getComputedStyle: computed = typeof view.getComputedStyle === 'function' ? view.getComputedStyle.bind(view) : null,
  supportsContentVisibility = () => {
    try { return !!view.CSS?.supports?.(CV, 'auto') && !!view.CSS.supports(CIS, '1px 1px'); } catch { return false; }
  },
  now = () => (typeof view.performance?.now === 'function' ? view.performance.now() : Date.now()),
  nativeScrollAnchoring = () => {
    try {
      if (!view.CSS?.supports?.('overflow-anchor', 'auto')) return false;
      return !computed || computed(scroller).overflowAnchor !== 'none';
    } catch { return false; }
  },
} = {}) {
  const inert = { refresh() {}, disconnect() {}, farCount: () => 0 };
  if (!scroller || !container) return inert;
  // An engine without the property, or without the observers this needs to be exact: every row stays plain.
  if (typeof IO !== 'function' || typeof RO !== 'function' || typeof MO !== 'function' || !computed) return inert;
  if (!supportsContentVisibility()) return inert;

  /** @type {Map<Element, { near: boolean | undefined, above: boolean, width: number, height: number, safe: boolean | undefined, far: boolean, settleUntil: number }>} */
  const rows = new Map();
  let disposed = false;
  let anchoring = null; // asked once, on the first height change that needs it
  let parentContains = null; // the rows are flex or grid items: asked once, with the first row that could be far

  const isTail = (row) => {
    let el = container.lastElementChild;
    for (let i = 0; i < LIVE_TAIL_ROWS && el; i++, el = el.previousElementSibling) if (el === row) return true;
    return false;
  };

  const safeOf = (row, state) => {
    if (state.safe === undefined) {
      try {
        if (parentContains === null) parentContains = /^(?:inline-)?(?:flex|grid)$/.test(String(computed(container).display || ''));
        // Items of a flex or grid transcript need no look at their own style.
        state.safe = parentContains || rowKeepsItsHeight(computed(row));
      } catch { state.safe = false; }
    }
    return state.safe;
  };

  function apply(row, state) {
    const want = !disposed && row.parentNode === container
      && shouldBeFar({
        near: state.near, width: state.width, height: state.height, tail: isTail(row),
        // asked last: it reads a computed style, and only a row that would otherwise be far needs it
        safe: state.near === false && state.height >= MIN_FAR_HEIGHT && !(skip && skip(row)) ? safeOf(row, state) : false,
      });
    if (want) {
      const size = farSize(state.width, state.height);
      // All of them, always: a row with the first and not the size would collapse to nothing. The third
      // keeps a flex transcript from squeezing a row whose content it no longer sees: a row never shrinks
      // today (its content is its minimum), and a skipped row must not depend on how an engine reads the
      // minimum of a contained box.
      if (!state.far || row.style.getPropertyValue(CV) !== 'auto' || row.style.getPropertyValue(CIS) !== size) {
        row.style.setProperty(CIS, size);
        row.style.setProperty(FS, '0');
        row.style.setProperty(CV, 'auto');
      }
      state.far = true;
    } else if (state.far || row.style.getPropertyValue(CV) === 'auto') {
      row.style.removeProperty(CV);
      row.style.removeProperty(CIS);
      row.style.removeProperty(FS);
      // Laid out for real again: if its height is not what it was given, that is this module's doing
      // (the sizes observer keeps the scroll position, below).
      if (state.far) state.settleUntil = now() + SETTLE_MS;
      state.far = false;
    }
  }

  const intersections = new IO((entries) => {
    if (disposed) return;
    for (const entry of entries) {
      const state = rows.get(entry.target);
      if (!state) continue;
      // No box to compare with: the transcript is not laid out (a closed panel, a tab that is not showing).
      // What was known stays; a row is not declared far because its panel was closed.
      const bounds = entry.rootBounds;
      if (!bounds || !(bounds.height > 0) || !(bounds.width > 0)) continue;
      state.near = !!entry.isIntersecting;
      // The bounds are the visible part with one height of it added above and below (NEAR_MARGIN): the
      // visible part starts a third of the way down.
      state.above = entry.boundingClientRect.bottom <= bounds.top + bounds.height / 3 + 1;
      apply(entry.target, state);
    }
  }, { root: scroller, rootMargin: NEAR_MARGIN, threshold: 0 });

  const sizes = new RO((entries) => {
    if (disposed) return;
    let shift = 0;
    for (const entry of entries) {
      const row = entry.target;
      const state = rows.get(row);
      if (!state) continue;
      const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
      const width = box ? box.inlineSize : entry.contentRect?.width;
      const height = box ? box.blockSize : entry.contentRect?.height;
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      // A far row that is skipped reports the size it was given; that says nothing new.
      if (state.far && Math.abs(height - state.height) < 0.01 && Math.abs(width - state.width) < 0.01) continue;
      if (!(height > 0)) continue; // not laid out (display: none): the last real size stays
      // A row above the visible part that was far took its real height (the engine drew it as it came
      // near, or it was just made plain): its stale size was this module's, so the correction is too.
      // Without scroll anchoring it would push what is on screen down, or pull it up, by the difference.
      // A plain row that grows by itself is left to the engine, as it always was.
      if (state.above && state.height > 0 && (state.far || now() < state.settleUntil)) shift += height - state.height;
      state.settleUntil = 0;
      state.width = width;
      state.height = height;
      apply(row, state);
    }
    if (shift && Math.abs(shift) >= 0.5) {
      if (anchoring === null) anchoring = !!nativeScrollAnchoring();
      if (!anchoring) {
        // At once, never as a smooth scroll (a transcript may set scroll-behavior: smooth): this is a
        // correction of the position, not a movement.
        const top = scroller.scrollTop + shift;
        if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'instant' });
        else scroller.scrollTop = top;
      }
    }
  });

  function adopt(row) {
    if (!row || row.nodeType !== 1 || rows.has(row)) return;
    // A row that came with the declarations of another time (a stored transcript, a moved node) starts plain.
    clearFarRow(row);
    rows.set(row, { near: undefined, above: false, width: 0, height: 0, safe: undefined, far: false, settleUntil: 0 });
    intersections.observe(row);
    sizes.observe(row); // the content box: what contain-intrinsic-size sizes
  }

  function release(row) {
    const state = rows.get(row);
    if (!state) return;
    rows.delete(row);
    intersections.unobserve(row);
    sizes.unobserve(row);
    if (state.far) clearFarRow(row);
  }

  /** The rows that just stopped being the tail (a row was added after them), and the new tail. */
  function settleTail() {
    let el = container.lastElementChild;
    for (let i = 0; i < LIVE_TAIL_ROWS + 2 && el; i++, el = el.previousElementSibling) {
      const state = rows.get(el);
      if (state) apply(el, state);
    }
  }

  const changes = new MO((records) => {
    if (disposed) return;
    let touched = false;
    for (const record of records) {
      if (record.type !== 'childList' || record.target !== container) continue;
      for (const node of record.removedNodes) if (node.parentNode !== container) release(node);
      for (const node of record.addedNodes) if (node.parentNode === container) adopt(node);
      touched = true;
    }
    if (touched) settleTail();
  });
  changes.observe(container, { childList: true });
  for (const row of container.children) adopt(row);

  return {
    /** Forget what was decided about each row's formatting (a skin or a stylesheet changed) and decide again. */
    refresh() {
      if (disposed) return;
      parentContains = null;
      for (const [row, state] of rows) { state.safe = undefined; apply(row, state); }
    },
    disconnect() {
      if (disposed) return;
      disposed = true;
      changes.disconnect();
      intersections.disconnect();
      sizes.disconnect();
      for (const [row, state] of rows) if (state.far) clearFarRow(row);
      rows.clear();
    },
    farCount() {
      let n = 0;
      for (const state of rows.values()) if (state.far) n += 1;
      return n;
    },
  };
}

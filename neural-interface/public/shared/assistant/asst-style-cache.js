// ═══════════════════════════════════════════
// SynaBun Assistant — computed styles read once
// ═══════════════════════════════════════════
// A value the stylesheet decides and the renderer needs on a hot path (the
// rack's --rk-cut, where a long subject is cut; its bubble line's
// white-space), read once and kept until the renderer says it may have
// changed. getComputedStyle() on a frame's path forces a style recalculation
// of everything the frame dirtied (a rig's SVG, a scene); these values change
// only when a container query flips, which happens only when the stage's width
// changes, and the renderer's ResizeObserver sees every such change and calls
// invalidate().
//
//   createStyleCache({ read }?) → { get(el, prop), invalidate(el?), reads() }
//
// `read(el, prop)` defaults to getComputedStyle(el).getPropertyValue(prop)
// (trimmed); a read that throws counts as ''. DOM-free: tested in Node.

const defaultRead = (el, prop) => globalThis.getComputedStyle(el).getPropertyValue(prop);

export function createStyleCache({ read = defaultRead } = {}) {
  let values = new WeakMap(); // element → Map(prop → value)
  let count = 0;
  return {
    /** The element's computed `prop` (a custom property or a longhand), read once until invalidated. */
    get(el, prop) {
      if (!el) return '';
      let props = values.get(el);
      if (!props) { props = new Map(); values.set(el, props); }
      if (props.has(prop)) return props.get(prop);
      count += 1;
      let value = '';
      try { value = String(read(el, prop) ?? '').trim(); } catch { value = ''; }
      props.set(prop, value);
      return value;
    },
    /** Forget one element's values, or every value (no argument). */
    invalidate(el) {
      if (el) values.delete(el);
      else values = new WeakMap();
    },
    /** How many real reads were made (tests, the idle-CPU suite). */
    reads: () => count,
  };
}

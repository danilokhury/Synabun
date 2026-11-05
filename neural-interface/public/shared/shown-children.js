// ═══════════════════════════════════════════
// A container that has nothing left to show says so: data-empty
// ═══════════════════════════════════════════
// `data-empty` is on a container while none of its element children lacks the `hidden` attribute (no children at
// all included), and off as soon as one shows. CSS keys on it in place of `.x:not(:has(> :not([hidden])))`: that
// selector made Chromium re-check the page on every `hidden` toggle anywhere (~12 ms each on Windows), see
// tests/css-has-performance.test.mjs.
//
// syncEmpty(el) is for code that toggles the children itself (call it after the toggles); watchEmpty(root, selector)
// is for containers whose children many modules fill and toggle: one MutationObserver keeps every matching container
// true to its children. Mutation callbacks run before the next frame is drawn, so the page never shows a stale state.
// No imports: it runs under node --test with a stand-in DOM.

export const EMPTY_ATTR = 'data-empty';

/** Whether one of el's element children lacks the `hidden` attribute. */
export function hasShownChild(el) {
  for (const child of el?.children || []) {
    if (!child.hasAttribute('hidden')) return true;
  }
  return false;
}

/** Puts data-empty on el, or takes it off, to match its children. Returns whether it is empty (false for no element). */
export function syncEmpty(el) {
  if (!el || typeof el.hasAttribute !== 'function') return false;
  const empty = !hasShownChild(el);
  // Written only on a change: an observer of the attribute (or of the page's style) sees nothing otherwise.
  if (el.hasAttribute(EMPTY_ATTR) !== empty) {
    if (empty) el.setAttribute(EMPTY_ATTR, '');
    else el.removeAttribute(EMPTY_ATTR);
  }
  return empty;
}

/**
 * Keeps data-empty true on `root` (when it matches `selector`, or always when there is no selector) and on every
 * descendant that matches `selector`, as children come, go and toggle `hidden`.
 * @param {Element} root
 * @param {string|null} [selector]  the containers below root; null watches root alone
 * @param {{ Observer?: typeof MutationObserver }} [opts]
 * @returns {{ sync: () => void, disconnect: () => void }}
 */
export function watchEmpty(root, selector = null, { Observer = globalThis.MutationObserver } = {}) {
  if (!root) return { sync() {}, disconnect() {} };
  const isContainer = (el) => !!el && el.nodeType === 1
    && (el === root ? (!selector || el.matches(selector)) : (!!selector && el.matches(selector) && root.contains(el)));
  const syncWithin = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (isContainer(node)) syncEmpty(node);
    if (selector) for (const el of node.querySelectorAll(selector)) syncEmpty(el);
  };
  const sync = () => syncWithin(root);
  sync();
  if (typeof Observer !== 'function') return { sync, disconnect() {} };
  const observer = new Observer((records) => {
    const touched = new Set();
    for (const r of records) {
      if (r.type === 'attributes') {
        // A child's `hidden` changed: its parent is the container to check.
        const parent = r.target.parentNode;
        if (isContainer(parent)) touched.add(parent);
        continue;
      }
      if (isContainer(r.target)) touched.add(r.target);
      if (selector) for (const node of r.addedNodes) syncWithin(node);
    }
    for (const el of touched) syncEmpty(el);
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
  return { sync, disconnect: () => observer.disconnect() };
}

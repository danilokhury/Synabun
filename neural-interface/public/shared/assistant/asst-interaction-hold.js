// ═══════════════════════════════════════════
// SynaBun Assistant — loops hold still while the UI is dragged
// ═══════════════════════════════════════════
// While a window or a panel is dragged or resized the page carries
// `body.ui-interacting`, and every loop under a rack or a scene holds still
// (asst-rack-styles.js, asst-scene-styles.js). The sheets used to say so with
// `body.ui-interacting .asst-rack *` and `body.ui-interacting .asst-scene *`:
// a selector that ends in `*` behind a class on <body> gives the engine no
// class or id to look for, so each change of the class restyled the WHOLE
// page: 8-10 ms for 8.4k elements and 30-55 ms for 15.7k in the SynaBun
// browser (2026-11-15), twice per drag, 0.5-0.7 ms with the flag below.
//
// The racks and scenes carry the flag themselves instead: `data-ui-held`, set
// here whenever the class is on <body> and taken off when it goes. Only what
// is under them is restyled, which is exactly what the old rule changed. One
// observer on <body>'s class; while the flag is up, a second one marks a rack
// or a scene that is added meanwhile, so nothing loops through a drag.
//
//   installInteractionHold(doc?) → { sync(), held(), disconnect() }
//
// Idempotent per document. No observer (an old engine, a test without one):
// nothing is marked and every loop runs through a drag, as it did before the
// rule existed. DOM-light on purpose: tests/assistant-interaction-hold.test.mjs
// drives it with a stand-in document.

export const HELD_ATTR = 'data-ui-held';
export const HOLD_CLASS = 'ui-interacting';
export const HOLD_TARGETS = '.asst-rack, .asst-scene';

const installed = new WeakMap();

export function installInteractionHold(doc = globalThis.document) {
  if (!doc?.body) return null;
  const existing = installed.get(doc);
  if (existing) return existing;

  const body = doc.body;
  const Observer = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
  let held = false;
  let additions = null;

  function mark(el, on) {
    try {
      if (on) { if (!el.hasAttribute(HELD_ATTR)) el.setAttribute(HELD_ATTR, ''); }
      else if (el.hasAttribute(HELD_ATTR)) el.removeAttribute(HELD_ATTR);
    } catch { /* not an element */ }
  }

  function markUnder(node, on) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches?.(HOLD_TARGETS)) mark(node, on);
    const inner = node.querySelectorAll?.(HOLD_TARGETS);
    if (inner) for (const el of inner) mark(el, on);
  }

  function watchAdditions(on) {
    if (!on) { try { additions?.disconnect(); } catch { /* already gone */ } additions = null; return; }
    if (additions || typeof Observer !== 'function') return;
    additions = new Observer((records) => {
      if (!held) return;
      for (const record of records) for (const node of record.addedNodes || []) markUnder(node, true);
    });
    try { additions.observe(body, { childList: true, subtree: true }); } catch { additions = null; }
  }

  function sync() {
    if (!classes) return false;
    const on = !!body.classList?.contains(HOLD_CLASS);
    if (on === held) return held;
    held = on;
    // Taking the flag off reads the marked ones, so a rack that left its class meanwhile is cleared too.
    const targets = doc.querySelectorAll(on ? HOLD_TARGETS : `[${HELD_ATTR}]`);
    for (const el of targets) mark(el, on);
    watchAdditions(on);
    return held;
  }

  let classes = null;
  if (typeof Observer === 'function') {
    classes = new Observer(sync);
    try { classes.observe(body, { attributes: true, attributeFilter: ['class'] }); } catch { classes = null; }
  }

  const api = {
    sync,
    held: () => held,
    disconnect() {
      try { classes?.disconnect(); } catch { /* already gone */ }
      classes = null;
      if (held) { held = false; for (const el of doc.querySelectorAll(`[${HELD_ATTR}]`)) mark(el, false); }
      watchAdditions(false);
      installed.delete(doc);
    },
  };
  installed.set(doc, api);
  // No observer: nothing would ever take the flag off again, so nothing is marked at all.
  if (classes) sync();
  return api;
}

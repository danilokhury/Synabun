// ═══════════════════════════════════════════
// SynaBun — Assistant toolbar keyboard (ARIA toolbar, roving tabindex)
// ═══════════════════════════════════════════
//
// One tab stop for the whole bar; ←/→ move between controls (wrapping),
// Home/End jump to the ends. The brain's fields (model · effort · mode ·
// account) are toolbar controls that sit in the composer row: passed as
// `lead`, they open the arrow order, so it runs model … ⋯ wherever the host
// put the bar, and they keep their own tab stops (the bar's single stop stays
// on the bar). Controls come and go (brain switch, feature probes) and
// container queries hide them without touching any attribute, so the tab stop
// is re-checked on DOM changes AND on resize — otherwise a hidden control
// could leave the bar without a tab stop.

//
// Which controls show is a layout question (getClientRects). Inside a closed side panel nothing shows and
// nothing can take focus, so the question is not asked there: it made the engine lay the hidden panel out on
// every change of the bar, from the first load on. The tab stop is settled when the panel is shown
// (sidepanel-shown.js).

import { createShownGate } from '../sidepanel-shown.js';

const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** @returns {{ sync(preferred?: Element): void, items(): HTMLElement[], destroy(): void }} */
export function createRovingToolbar(toolbar, { selector = 'button', lead = null } = {}) {
  const all = () => [...toolbar.querySelectorAll(selector)];
  const usable = (b) => !b.disabled && !b.hidden && b.getClientRects().length > 0;
  const items = () => all().filter(usable);
  // The arrow order: the lead controls first, then the bar's own.
  const order = () => [...(lead ? [...lead.querySelectorAll(selector)].filter(usable) : []), ...items()];

  function settle(preferred = null) {
    const list = items();
    if (!list.length) return;
    const current = (preferred && list.includes(preferred) && preferred) || list.find((b) => b.tabIndex === 0) || list[0];
    for (const b of all()) b.tabIndex = b === current ? 0 : -1;
  }
  // The one a caller asked for while the panel was closed is the one settled on when it is shown.
  let wanted = null;
  const gate = createShownGate(toolbar, () => { const preferred = wanted; wanted = null; settle(preferred); });
  function sync(preferred = null) {
    if (preferred) wanted = preferred;
    gate.request();
  }

  const onFocusIn = (e) => {
    const b = e.target.closest?.(selector);
    if (b && toolbar.contains(b)) sync(b);
  };
  const onKeyDown = (e) => {
    if (!KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = order();
    const idx = list.indexOf(document.activeElement);
    if (idx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? list.length - 1
        : (idx + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    list[next].focus();
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; sync(); });
  };
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
  mutations?.observe(toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
  const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null; // container-query flips
  resizes?.observe(toolbar);
  toolbar.addEventListener('focusin', onFocusIn);
  toolbar.addEventListener('keydown', onKeyDown);
  lead?.addEventListener('keydown', onKeyDown);
  sync();

  return {
    sync,
    items,
    destroy() {
      gate.cancel();
      mutations?.disconnect();
      resizes?.disconnect();
      toolbar.removeEventListener('focusin', onFocusIn);
      toolbar.removeEventListener('keydown', onKeyDown);
      lead?.removeEventListener('keydown', onKeyDown);
    },
  };
}

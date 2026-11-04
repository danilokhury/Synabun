// SynaBun — taking the loading overlay out of rendering once it has faded (ui-loading.js). No imports, no DOM globals:
// the element and the timer are handed in (unit-tested under node --test).
//
// `hidden` fades the overlay to opacity 0 (0.8 s). A transparent overlay still renders, and its `#loading-text` pulse
// kept the page drawing 60 frames a second forever. After the fade the overlay also gets `gone` (display: none), which
// stops every animation inside it; showing it again removes both classes in the same call.

export const FADE_MS = 800;

/** Fade `el` out, then take it out of rendering. Returns a cancel function. */
export function concealOverlay(el, { setTimer = setTimeout, clearTimer = clearTimeout, fadeMs = FADE_MS } = {}) {
  if (!el) return () => {};
  el.classList.add('hidden');
  let timer = null;
  const done = () => {
    timer = null;
    el.removeEventListener?.('transitionend', onEnd);
    if (el.classList.contains('hidden')) el.classList.add('gone');
  };
  const onEnd = (event) => { if (!event || event.target === el) { if (timer) clearTimer(timer); done(); } };
  el.addEventListener?.('transitionend', onEnd);
  // A transition that never runs (reduced motion, a background tab, display already none) still ends here.
  timer = setTimer(done, fadeMs + 100);
  el._synabunConceal = () => { if (timer) clearTimer(timer); timer = null; el.removeEventListener?.('transitionend', onEnd); };
  return el._synabunConceal;
}

/** Show `el` again (cancels a pending conceal). */
export function revealOverlay(el) {
  if (!el) return;
  el._synabunConceal?.();
  el._synabunConceal = null;
  el.classList.remove('gone', 'hidden');
}

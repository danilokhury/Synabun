// Just-in-time tips: the Workspace tour's long tail. One beat each, at the moment a
// control first matters (the first worker card, the first usage strip, the first
// route card, the first time ⋯ opens, the first time computer use is switched on):
// one line in the tour's caption, the one highlight ring on the control, and, when
// the empty state's character is on screen, its arm pointing there. Shown once,
// ever (tour-state.js keeps the ids); gone at the next input of any kind, which
// still does what it does; never while the tour itself runs. Nothing here changes
// anything: it only says what a control is.
import { createHighlight, createStage, EASE } from './tour-stage.js';
import { markTipSeen, tipsSeen } from './tour-state.js';

export const TIP_IDS = Object.freeze(['run', 'usage', 'route', 'more', 'computer']);
const LIFE_MS = 14000; // a tip nobody answers leaves on its own

let current = null;

/** The tip on screen (for tests): { id, dismiss() } or null. */
export function currentTip() {
  return current;
}

/**
 * Show tip `id` once: `target` is the control it is about, `root` the panel root it
 * sits in (its caption goes at the foot of the transcript). Returns the tip, or null
 * when it was shown before, the tour runs, or there is nothing to point at.
 */
/** The tour's stylesheet, loaded once (a tip can come before the tour ever ran). */
let styles = null;
export function ensureTourStyles(href = '/shared/tour/tour.css') {
  if (styles) return styles;
  if (document.querySelector(`link[href="${href}"]`)) { styles = Promise.resolve(); return styles; }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  styles = Promise.race([new Promise((done) => { link.onload = link.onerror = done; }), new Promise(done => setTimeout(done, 1500))]);
  document.head.append(link);
  return styles;
}

export function showTip(id, { storage, tr, root, target, renderer = null, reduced = () => false, pageHost = document.body } = {}) {
  if (!TIP_IDS.includes(id) || !storage || !target?.isConnected || !root?.isConnected) return null;
  if (root.classList.contains('tour-on') || document.querySelector('.asst-root.tour-on')) return null; // the tour speaks for itself
  if (tipsSeen(storage).has(id)) return null;
  const line = tr(`tour.tips.${id}`);
  if (!line || line === `tour.tips.${id}`) return null;
  markTipSeen(storage, id);
  current?.dismiss({ calm: true });

  const transcript = root.querySelector('.asst-transcript');
  const tip = document.createElement('div');
  tip.className = 'tour-caption tour-tip';
  tip.setAttribute('aria-hidden', 'true');
  tip.innerHTML = '<div class="tour-caption-bg"></div><div class="tour-caption-body"><div class="tour-line"></div></div>';
  tip.querySelector('.tour-line').textContent = line;
  // At the foot of the transcript, over the conversation's last lines, never over the composer.
  const rb = root.getBoundingClientRect();
  const tb = (transcript || root).getBoundingClientRect();
  tip.style.bottom = `${Math.max(8, Math.round(rb.bottom - tb.bottom + 8))}px`;
  root.appendChild(tip);
  const announcer = root.querySelector('.asst-announce');
  if (announcer) announcer.textContent = line;

  const page = createStage(pageHost, { fixed: true, reduced, className: 'tour-tip-layer' });
  try { page.el.style.zIndex = String(Math.max(11001, (parseInt(getComputedStyle(root.closest('.assistant-panel') || root).zIndex, 10) || 0) + 1)); } catch { /* the stylesheet's */ }
  const ring = createHighlight(page, { reduced, seed: `tip-${id}` });
  ring.to(target.getBoundingClientRect(), { pad: 5 });
  // The character points when it is the empty state's, on screen and free.
  const hero = renderer?.mascot?.();
  const pointing = hero?.kind === 'hero' && !hero.parked?.() ? hero : null;
  try { pointing?.rig?.point?.(target, { poke: true }); } catch { /* an older rig */ }

  let gone = false;
  const onInput = () => dismiss();
  const timer = setTimeout(() => dismiss(), LIFE_MS);
  // Any input dismisses: the event goes on to do what it does (capture, passive, never stopped).
  window.addEventListener('pointerdown', onInput, { capture: true, passive: true });
  window.addEventListener('keydown', onInput, { capture: true, passive: true });
  window.addEventListener('wheel', onInput, { capture: true, passive: true });

  function dismiss({ calm = false } = {}) {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    window.removeEventListener('pointerdown', onInput, true);
    window.removeEventListener('keydown', onInput, true);
    window.removeEventListener('wheel', onInput, true);
    try { pointing?.rig?.point?.(null); } catch { /* gone */ }
    if (current === handle) current = null;
    const leave = () => { ring.destroy(); page.destroy(); tip.remove(); };
    if (calm || reduced() || typeof tip.animate !== 'function') { leave(); return; }
    ring.to(null);
    tip.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 200, easing: EASE.exit, fill: 'forwards' })
      .finished.then(leave, leave);
  }

  const handle = { id, el: tip, dismiss };
  current = handle;
  return handle;
}

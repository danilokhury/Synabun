// ═══════════════════════════════════════════
// SynaBun Neural Interface — the desktop app's title bar (page side)
// ═══════════════════════════════════════════
//
// The SynaBun desktop app's main window has no native title bar
// (packaging/desktop/src/titlebar.mjs): the page's own top bar, #title-bar,
// is the window's title bar, the way Discord's is. This makes it one:
//
//   layout   body.wco-active (the Window Controls Overlay rules in styles.css,
//            the installed PWA's too) while the system's buttons are over the
//            bar: the bar is as tall as they are and leaves their corner
//            free; off in full screen, where the system hides them
//   colours  the caption buttons (Windows, Linux) take the colours of the bar
//            under them, again whenever those change (a skin, the Memory
//            Explorer making the bar opaque, a stylesheet that loads late)
//   menu     Windows and Linux: a button at the bar's left opens the app's
//            menu, the one the hidden menu bar had (its shortcuts still work)
//   clicks   the bar's empty parts drag the window (the system double-clicks
//            them too); while something is drawn over the bar (a dialog, the
//            tour), that thing gets the clicks: body.desktop-titlebar-covered,
//            checked only after a change that can put something there
//
// In a browser and in the installed PWA nothing here runs: initDesktopTitleBar()
// returns null, and the PWA's own overlay handling (ui-navbar.js) is untouched.
// What it decides is desktop-titlebar-view.js (DOM-free, tested under node); a
// page without the navbar uses desktop-titlebar-page.js.

import { desktopWindow } from './desktop-bridge.js';
import { colorSender, textTone } from './desktop-titlebar-page.js';
import { barCovered, changedClasses, drawnUnderBar, fallbackTitlebarArea, overlayColorsFor, stackLevel, styleChange, titleBarActive } from './desktop-titlebar-view.js';
import { t } from './i18n.js';

const MENU_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>';
const COLOR_DELAY_MS = 120;
// The cover check while the page keeps changing: at most one per COVER_INTERVAL_MS (four a second).
const COVER_INTERVAL_MS = 250;
// The classes of <body> this module writes itself: never a reason to check again.
const OWN_BODY_CLASSES = new Set(['desktop-titlebar-covered', 'wco-active']);
// What a change of the page can do to the cover.
const IGNORE = 0;
const SOON = 1;
const NOW = 2;

/**
 * The map pages (index.html, index2d.html): #title-bar becomes the window's title bar. Returns the controller, or
 * null outside the desktop app's main window (a browser, the PWA) or on a page without the bar.
 */
export function initDesktopTitleBar({ doc = document, view = window } = {}) {
  const api = desktopWindow(view);
  const bar = doc.getElementById('title-bar');
  if (!api || !bar) return null;
  const facts = api.titleBar;
  const html = doc.documentElement;
  html.classList.add('desktop-titlebar', `desktop-titlebar--${facts.platform}`);
  const wco = view.navigator?.windowControlsOverlay || null;
  let state = { maximized: false, fullScreen: false, focused: true };
  const send = colorSender(api, doc);

  // ── The menu button (Windows, Linux): the app's menu, under the button ──
  let menuButton = null;
  if (facts.appMenu) {
    menuButton = doc.createElement('button');
    menuButton.type = 'button';
    menuButton.id = 'desktop-app-menu-btn';
    menuButton.className = 'bar-icon desktop-app-menu-btn';
    const label = t('desktop.titleBar.appMenu');
    menuButton.setAttribute('aria-label', label);
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.dataset.tooltip = label;
    menuButton.innerHTML = MENU_ICON;
    menuButton.addEventListener('click', (event) => {
      event.preventDefault();
      const rect = menuButton.getBoundingClientRect();
      Promise.resolve(api.showMenu({ x: Math.max(0, rect.left), y: Math.max(0, rect.bottom) })).catch(() => {});
    });
    const left = bar.querySelector('.bar-left');
    (left || bar).prepend(menuButton);
  }

  // ── Covered: something over the bar takes its clicks, so the bar stops dragging the window ──
  // Chromium gives the page no mouse events over a drag region, so this has to be right before the pointer gets
  // there. Measuring it costs a layout and the hit tests, so it runs only after a change that can put something over
  // the bar or take it away (pageChange below): on the next frame (coverNow) for an overlay's root coming, going,
  // shown or hidden, at most every COVER_INTERVAL_MS (coverSoon: at once when the page was quiet, then once more after
  // the last change) for the rest, and never for text or for what the bar holds. A change inside a part of the page
  // drawn under the bar (a side panel's transcript, a terminal's output) only has that part's style read again, in
  // case a rule lifted it over the bar (the side panels' `:has(.…-dropdown.open)`); the bar is measured then only if
  // one was.
  const body = doc.body;
  const clock = () => (typeof view.performance?.now === 'function' ? view.performance.now() : Date.now());
  let coverFrame = 0;
  let coverTimer = null;
  let measureNow = false; // the next check measures the bar
  let soonPending = false; // work at the throttled pace is waiting: verdicts, and the bar's measure when soonMeasure
  let soonMeasure = false;
  let lastSoon = -Infinity; // when that work last ran
  // Children of <body> drawn under the bar as a whole (drawnUnderBar), and those whose verdict the next check takes
  // again: read during a check, when the page's style is current anyway, and never their layout.
  const underBar = new Set();
  const toJudge = new Set();
  const judgeAgain = () => { for (const part of underBar) toJudge.add(part); };
  /** Takes the verdicts asked for; true when a part that was drawn under the bar no longer is. */
  const judgeParts = () => {
    if (!toJudge.size) return false;
    const level = bar.parentNode === body ? stackLevel(view.getComputedStyle(bar)) : null;
    let lifted = false;
    for (const part of toJudge) {
      if (level !== null && part.parentNode === body && drawnUnderBar(view.getComputedStyle(part), level)) underBar.add(part);
      else if (underBar.delete(part)) lifted = true;
    }
    toJudge.clear();
    return lifted;
  };
  const checkCover = () => {
    coverFrame = 0;
    let measure = measureNow;
    measureNow = false;
    const now = clock();
    if (soonPending && now - lastSoon >= COVER_INTERVAL_MS) {
      soonPending = false;
      lastSoon = now;
      if (soonMeasure) measure = true;
      soonMeasure = false;
    }
    // Reads in one go (the style, then one layout and the hit tests), then at most one write, and only of a change.
    if (judgeParts()) measure = true;
    if (measure) {
      let covered = false;
      if (body.classList.contains('wco-active')) {
        const rect = bar.getBoundingClientRect();
        const area = wco && wco.visible ? wco.getTitlebarAreaRect() : null;
        const left = Math.max(rect.left, area ? area.x : rect.left) + 2;
        const right = Math.min(rect.right, area ? area.x + area.width : rect.right) - 2;
        if (right > left && rect.height > 0) {
          const y = Math.round(rect.top + rect.height / 2);
          for (let i = 0; i <= 8 && !covered; i++) {
            const el = doc.elementFromPoint(Math.round(left + ((right - left) * i) / 8), y);
            covered = barCovered([{ inBar: !!el && (el === bar || bar.contains(el)), page: !el || el === html || el === body }]);
          }
        }
      }
      if (body.classList.contains('desktop-titlebar-covered') !== covered) body.classList.toggle('desktop-titlebar-covered', covered);
    }
    if (soonPending) armSoon();
  };
  /** The next check for the throttled work: the next frame once COVER_INTERVAL_MS has passed since it last ran. */
  const armSoon = () => {
    if (coverFrame || coverTimer) return;
    const wait = lastSoon + COVER_INTERVAL_MS - clock();
    if (wait <= 0) coverFrame = view.requestAnimationFrame(checkCover);
    else coverTimer = setTimeout(() => { coverTimer = null; if (!coverFrame) coverFrame = view.requestAnimationFrame(checkCover); }, wait);
  };
  /** A check on the next frame; `measured` false: only the verdicts asked for, unless one changes. */
  const coverNow = (measured = true) => {
    if (measured) measureNow = true;
    if (!coverFrame) coverFrame = view.requestAnimationFrame(checkCover);
  };
  /** A check at the throttled pace: at once after a quiet COVER_INTERVAL_MS, else when it is over (leading, trailing). */
  const coverSoon = (measured = true) => {
    soonPending = true;
    if (measured) soonMeasure = true;
    armSoon();
  };

  /** The child of <body> that holds `node` (the node itself when it is one); null for <body> or a node off the page. */
  const partOf = (node) => {
    for (let n = node; n; n = n.parentNode) if (n.parentNode === body) return n;
    return null;
  };
  const hasElement = (nodes) => { for (const node of nodes || []) if (node?.nodeType === 1) return true; return false; };
  // Each change → [IGNORE | SOON | NOW, whether the bar has to be measured].
  const QUIET = [IGNORE, false];
  const childListChange = (record) => {
    if (!hasElement(record.addedNodes) && !hasElement(record.removedNodes)) return QUIET; // text
    const target = record.target;
    if (target === body) { judgeAgain(); return [NOW, true]; } // an overlay's root; a sibling selector may match anew
    const part = partOf(target);
    if (!part || part === bar) return QUIET; // off the page, or what the bar holds: that counts as the bar
    toJudge.add(part);
    if (target === part) return [NOW, true]; // an overlay's root got or lost a child (:empty, :has() can show it)
    return [SOON, !underBar.has(part)];
  };
  const attributeChange = ({ target, name, before, after }) => {
    // A modal dialog is drawn above everything, wherever it is in the page.
    if (name === 'open' && target.nodeName === 'DIALOG') return [NOW, true];
    if (target === body) {
      if (name === 'class' && changedClasses(before, after).every(token => OWN_BODY_CLASSES.has(token))) return QUIET;
      judgeAgain();
      return [NOW, true];
    }
    const part = partOf(target);
    if (!part) return QUIET;
    if (part === bar) return target === bar ? [NOW, true] : QUIET;
    toJudge.add(part);
    // Shown, hidden or restacked: on the next frame; only moved, sized or repainted: at the throttled pace. Inside a
    // part drawn under the bar only its style is read again (a class can lift the whole part).
    const moveOnly = name === 'style' && styleChange(before, after) !== 'other';
    return [moveOnly ? SOON : NOW, target === part || !underBar.has(part)];
  };
  /** What a batch of the page's changes can do to the cover; a record this cannot read counts as one that can. */
  const pageChange = (records) => {
    const { attributes, others } = foldRecords(records);
    // The next frame's work and the throttled work, each with whether it measures the bar: kept apart, so that a
    // verdict read on the next frame never takes a throttled measure along before its time.
    let next = false;
    let nextMeasured = false;
    let soon = false;
    let soonMeasured = false;
    const add = ([level, measured]) => {
      if (level === NOW) { next = true; if (measured) nextMeasured = true; }
      else if (level === SOON) { soon = true; if (measured) soonMeasured = true; }
    };
    for (const record of others) {
      if (record?.type === 'characterData') continue; // text
      add(record?.type === 'childList' && record.target ? childListChange(record) : [NOW, true]);
    }
    for (const change of attributes) add(attributeChange(change));
    if (next) coverNow(nextMeasured);
    if (soon) coverSoon(soonMeasured);
  };

  // ── Colours: the bar as drawn where the buttons are, over whatever is under it there ──
  let colorTimer = null;
  const computeColors = () => {
    const rect = bar.getBoundingClientRect();
    const x = Math.round(facts.controls === 'left' ? rect.left + 2 : rect.right - 2);
    const y = Math.round(rect.top + rect.height / 2);
    const under = [];
    let below = false;
    for (const el of (typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : [])) {
      if (el === bar) { below = true; continue; }
      if (!below || bar.contains(el) || el === html) continue;
      under.push(view.getComputedStyle(el).backgroundColor);
    }
    return overlayColorsFor({
      bar: view.getComputedStyle(bar).backgroundColor,
      under,
      base: view.getComputedStyle(doc.body).backgroundColor,
      text: textTone(doc, view),
    });
  };
  const scheduleColors = () => {
    clearTimeout(colorTimer);
    colorTimer = setTimeout(() => { try { send(computeColors()); } catch {} }, COLOR_DELAY_MS);
  };

  // ── Layout: room for the window's controls while they are over the bar ──
  const layout = () => {
    const active = titleBarActive({ overlayVisible: wco ? wco.visible : null, hasOverlayApi: !!wco, fullScreen: !!state.fullScreen });
    doc.body.classList.toggle('wco-active', active);
    html.classList.toggle('desktop-titlebar--maximized', !!state.maximized);
    if (!wco) {
      const area = fallbackTitlebarArea(facts, view.innerWidth);
      html.style.setProperty('--desktop-titlebar-x', `${area.x}px`);
      html.style.setProperty('--desktop-titlebar-width', `${area.width}px`);
      html.style.setProperty('--desktop-titlebar-height', `${area.height}px`);
    }
    coverNow();
    scheduleColors();
  };
  const setState = (next) => { if (next && typeof next === 'object') state = { ...state, ...next }; layout(); };

  layout();
  Promise.resolve(api.state()).then(setState).catch(() => {});
  if (typeof api.onState === 'function') api.onState(setState);
  wco?.addEventListener('geometrychange', layout);
  view.addEventListener('resize', () => { coverNow(); scheduleColors(); });
  // The bar's own transitions (its background, its left edge beside a sidebar); what it holds never colours the buttons.
  bar.addEventListener('transitionend', (event) => { if (event?.target === bar) { scheduleColors(); coverSoon(); } });
  if (typeof doc.addEventListener === 'function') {
    // A popover is drawn above everything without a change of the page to see; an element in full screen too.
    doc.addEventListener('toggle', (event) => { if (event?.target?.nodeName !== 'DETAILS') coverNow(); }, true);
    doc.addEventListener('fullscreenchange', () => coverNow());
  }

  // What changes the bar's colours: its own class and style (the Memory Explorer, a sidebar), the stylesheets (a
  // skin's <link>, which draws once it has loaded) and the interface settings (variables on <html>). A class flipped
  // and back, a <title> or a <meta> changes nothing. A stylesheet or <html> can also restack the page: the cover too
  // (a theme's class or a stylesheet that loaded at once, the rest at the throttled pace).
  const restyled = (now) => {
    judgeAgain();
    scheduleColors();
    if (now) coverNow(); else coverSoon();
  };
  new view.MutationObserver((records) => {
    const { attributes, others } = foldRecords(records);
    if (attributes.length || others.length) scheduleColors();
  }).observe(bar, { attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style'] });
  const onSheetLoad = () => restyled(true);
  new view.MutationObserver((records) => {
    const { attributes, others } = foldRecords(records);
    for (const record of others) for (const node of record?.addedNodes || []) if (node.tagName === 'LINK') node.addEventListener('load', onSheetLoad, { once: true });
    if (attributes.some(change => isStylesheet(change.target)) || others.some(sheetsChanged)) restyled(false);
  }).observe(doc.head, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['href', 'media', 'disabled'] });
  new view.MutationObserver((records) => {
    const { attributes, others } = foldRecords(records);
    if (attributes.length || others.length) restyled(others.length > 0 || attributes.some(change => change.name === 'class'));
  }).observe(html, { attributes: true, attributeOldValue: true, attributeFilter: ['style', 'class'] });
  // What can come over the bar: anything added, shown or moved on the page (pageChange keeps what can matter).
  new view.MutationObserver(pageChange).observe(body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });

  return { facts, menuButton, refresh: layout, state: () => ({ ...state }) };
}

/**
 * One MutationObserver batch with each attribute's records folded into its net change: { target, name, before,
 * after } for an attribute whose value now differs from its value before the batch (a class removed and added back
 * in the same frame is no change), and the other records as they came.
 */
function foldRecords(records) {
  const first = new Map();
  const others = [];
  for (const record of records || []) {
    if (record?.type !== 'attributes' || !record.target || !record.attributeName) { others.push(record); continue; }
    let names = first.get(record.target);
    if (!names) first.set(record.target, (names = new Map()));
    if (!names.has(record.attributeName)) names.set(record.attributeName, record.oldValue ?? null);
  }
  const attributes = [];
  for (const [target, names] of first) {
    for (const [name, before] of names) {
      const after = target.getAttribute(name);
      if (after !== before) attributes.push({ target, name, before, after });
    }
  }
  return { attributes, others };
}

const isStylesheet = (node) => node?.nodeName === 'LINK' || node?.nodeName === 'STYLE';

/** Whether a record of <head> added or removed a stylesheet or changed one's text; a record this cannot read did. */
function sheetsChanged(record) {
  if (record?.type !== 'childList') return true;
  if (isStylesheet(record.target)) return true;
  for (const nodes of [record.addedNodes, record.removedNodes]) {
    for (const node of nodes || []) if (isStylesheet(node) || node?.querySelector?.('link, style')) return true;
  }
  return false;
}

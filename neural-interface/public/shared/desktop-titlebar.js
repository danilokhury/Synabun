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
//            tour), that thing gets the clicks: body.desktop-titlebar-covered
//
// In a browser and in the installed PWA nothing here runs: initDesktopTitleBar()
// returns null, and the PWA's own overlay handling (ui-navbar.js) is untouched.
// What it decides is desktop-titlebar-view.js (DOM-free, tested under node); a
// page without the navbar uses desktop-titlebar-page.js.

import { desktopWindow } from './desktop-bridge.js';
import { colorSender, textTone } from './desktop-titlebar-page.js';
import { barCovered, fallbackTitlebarArea, overlayColorsFor, titleBarActive } from './desktop-titlebar-view.js';
import { t } from './i18n.js';

const MENU_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>';
const COLOR_DELAY_MS = 120;

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
  let coverFrame = 0;
  const checkCover = () => {
    coverFrame = 0;
    if (!doc.body.classList.contains('wco-active')) { doc.body.classList.remove('desktop-titlebar-covered'); return; }
    const rect = bar.getBoundingClientRect();
    const area = wco && wco.visible ? wco.getTitlebarAreaRect() : null;
    const left = Math.max(rect.left, area ? area.x : rect.left) + 2;
    const right = Math.min(rect.right, area ? area.x + area.width : rect.right) - 2;
    if (!(right > left) || !(rect.height > 0)) { doc.body.classList.remove('desktop-titlebar-covered'); return; }
    const y = Math.round(rect.top + rect.height / 2);
    const samples = [];
    for (let i = 0; i <= 8; i++) {
      const el = doc.elementFromPoint(Math.round(left + ((right - left) * i) / 8), y);
      samples.push({ inBar: !!el && (el === bar || bar.contains(el)), page: !el || el === html || el === doc.body });
    }
    doc.body.classList.toggle('desktop-titlebar-covered', barCovered(samples));
  };
  const scheduleCover = () => { if (!coverFrame) coverFrame = view.requestAnimationFrame(checkCover); };

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
    scheduleCover();
    scheduleColors();
  };
  const setState = (next) => { if (next && typeof next === 'object') state = { ...state, ...next }; layout(); };

  layout();
  Promise.resolve(api.state()).then(setState).catch(() => {});
  if (typeof api.onState === 'function') api.onState(setState);
  wco?.addEventListener('geometrychange', layout);
  view.addEventListener('resize', () => { scheduleCover(); scheduleColors(); });
  bar.addEventListener('transitionend', scheduleColors);

  // What changes the bar's colours: its own class and style (the Memory Explorer, a sidebar), the stylesheets (a
  // skin's <link>, which draws once it has loaded) and the interface settings (variables on <html>).
  new view.MutationObserver(scheduleColors).observe(bar, { attributes: true, attributeFilter: ['class', 'style'] });
  new view.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes || []) if (node.tagName === 'LINK') node.addEventListener('load', scheduleColors, { once: true });
    }
    scheduleColors();
  }).observe(doc.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
  new view.MutationObserver(scheduleColors).observe(html, { attributes: true, attributeFilter: ['style', 'class'] });
  // What can come over the bar: anything added, shown or moved on the page.
  new view.MutationObserver(scheduleCover).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });

  return { facts, menuButton, refresh: layout, state: () => ({ ...state }) };
}

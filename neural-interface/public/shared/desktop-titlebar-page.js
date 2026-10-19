// ═══════════════════════════════════════════
// SynaBun Neural Interface — the desktop app's title bar on a page without the navbar
// ═══════════════════════════════════════════
//
// The SynaBun desktop app's main window has no native title bar
// (packaging/desktop/src/titlebar.mjs). A page of it without #title-bar
// (onboarding.html) declares that it lays out its own top with
// <meta name="synabun-titlebar">, then calls initDesktopPageTitleBar(): a strip
// along its top drags the window (the system double-clicks it too) and the
// caption buttons (Windows, Linux) take the page's background. The strip comes
// first in the page, under what the page draws there, so a control drawn over
// it keeps its clicks when it says -webkit-app-region: no-drag.
//
// Imports only import-free modules: the wizard still loads nothing of the app.
// The map pages use desktop-titlebar.js.

import { desktopWindow } from './desktop-bridge.js';
import { colorsKey, overlayColorsFor } from './desktop-titlebar-view.js';

/** The bar's text tone for the caption symbols (DESIGN.md nav-bar: text-primary), as the page defines it now. */
export function textTone(doc, view) {
  return view.getComputedStyle(doc.documentElement).getPropertyValue('--t-primary').trim() || 'rgba(255, 255, 255, 0.7)';
}

/** A sender of the caption buttons' colours that only sends a change; the page keeps the last pair on <html>. */
export function colorSender(api, doc) {
  let last = '';
  return (colors) => {
    const key = colorsKey(colors);
    if (!key || key === last) return;
    last = key;
    doc.documentElement.dataset.desktopTitlebarColors = key;
    Promise.resolve(api.setColors(colors)).catch(() => {});
  };
}

/** A page of the main window without the navbar: the strip, the classes, the caption colours. Null outside the app. */
export function initDesktopPageTitleBar({ doc = document, view = window } = {}) {
  const api = desktopWindow(view);
  if (!api || !doc.body) return null;
  const facts = api.titleBar;
  const html = doc.documentElement;
  html.classList.add('desktop-titlebar', `desktop-titlebar--${facts.platform}`, 'desktop-titlebar--page');
  let strip = doc.getElementById('synabun-desktop-drag-strip');
  if (!strip) {
    strip = doc.createElement('div');
    strip.id = 'synabun-desktop-drag-strip';
    strip.setAttribute('aria-hidden', 'true');
    strip.style.cssText = `position:fixed;top:0;left:0;right:0;height:env(titlebar-area-height,${facts.height}px);`
      + '-webkit-app-region:drag;app-region:drag;z-index:1;pointer-events:none;';
    doc.body.prepend(strip);
  }
  const send = colorSender(api, doc);
  const sendColors = () => {
    try { send(overlayColorsFor({ bar: 'transparent', base: view.getComputedStyle(doc.body).backgroundColor, text: textTone(doc, view) })); } catch {}
  };
  sendColors();
  return { facts, strip, refresh: sendColors };
}

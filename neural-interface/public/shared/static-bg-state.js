// Focus Mode's board (#static-bg) shown or hidden, with the same state on <html> as `static-bg-visible`.
//
// Rules outside the board need it (styles.css: the session pills keep clear of the whiteboard rail, the rail's show
// button exists only in Focus Mode). They used to read it with `:root:has(#static-bg.visible)` and
// `body:not(:has(#static-bg.visible))`; a :has() anchored on the root makes Chromium check the whole page again on
// every class change anywhere, which on the Windows desktop app cost tens of ms per change
// (tests/css-has-performance.test.mjs). No imports: tests/static-bg-state.test.mjs loads it under node.

export const STATIC_BG_ROOT_CLASS = 'static-bg-visible';

/**
 * Show or hide the board and say so on the root. Without a board there is nothing showing, so the root class is
 * cleared then too.
 * @param {Element|null|undefined} staticBg  #static-bg
 * @param {boolean} visible
 * @param {Element|null|undefined} [root]    <html>
 */
export function setStaticBgVisible(staticBg, visible, root = globalThis.document?.documentElement) {
  const on = !!staticBg && !!visible;
  staticBg?.classList.toggle('visible', on);
  root?.classList.toggle(STATIC_BG_ROOT_CLASS, on);
}

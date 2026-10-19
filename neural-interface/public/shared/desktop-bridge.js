// ═══════════════════════════════════════════
// SynaBun Neural Interface — the desktop app's bridge
// ═══════════════════════════════════════════
//
// Inside the SynaBun desktop app (packaging/desktop) the window's preload puts
// `window.synabunDesktop` on the pages of the app's own server: the app's
// version and system, its updater, and Quit. A browser tab has none, and every
// caller then keeps what an npm or Git install does.
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/desktop-update-view.test.mjs).

/** The bridge of the desktop app, or null in a browser. Only one with the updater the app exposes counts. */
export function desktopBridge(win = globalThis.window) {
  let bridge;
  try { bridge = win?.synabunDesktop; } catch { return null; }
  if (!bridge || typeof bridge !== 'object') return null;
  const updates = bridge.updates;
  if (!updates || typeof updates !== 'object' || typeof updates.state !== 'function' || typeof updates.check !== 'function') return null;
  return bridge;
}

/** True inside the window of the SynaBun desktop app. */
export function isDesktopApp(win = globalThis.window) {
  return desktopBridge(win) !== null;
}

/**
 * The title bar of the desktop app's main window (packaging/desktop/src/titlebar.mjs): its facts
 * ({ style, platform, height, controls, appMenu }), its state, the app's menu and the caption buttons' colours.
 * Null in a browser, in the installed PWA, and in any other window of the app (a detached session has a native frame).
 */
export function desktopWindow(win = globalThis.window) {
  const api = desktopBridge(win)?.window;
  if (!api || typeof api !== 'object' || typeof api.state !== 'function' || typeof api.setColors !== 'function') return null;
  const facts = api.titleBar;
  if (!facts || facts.style !== 'overlay' || !['darwin', 'win32', 'linux'].includes(facts.platform)) return null;
  return api;
}

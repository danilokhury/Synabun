/**
 * The splash window: small, frameless and centred where SynaBun's window is,
 * like Discord's updater. It is the first thing a start shows, it stays while
 * the server starts and the interface loads behind it, it is what an update
 * shows from the moment the install begins (the old copy) and from the moment
 * the new copy runs, and what a quit shows while the server stops. What it says
 * is splash-model.mjs's; this module only owns the window.
 *
 * Electron is handed in (main.mjs), so nothing here runs at import.
 */

import { join } from 'node:path';
import { SPLASH_LINE_MS, SPLASH_SIZE, splashView } from './splash-model.mjs';

/**
 * `BrowserWindow`, `screen`, `ipcMain`: Electron's. `page`: the splash's HTML.
 * `webPreferences()`: the app's sandboxed preferences. `bounds()`: where the
 * main window is or was ({ x, y, width, height } or null). `locale()`: the
 * app's language now. `onDetails()`: the Details button. `onClose()`: a person
 * closed it (Cmd+W, Alt+F4, the window menu): it is hidden, and the app decides
 * what that means (a start then ends out of sight, or SynaBun quits, as the
 * main window's close button would). `log`, `capture`.
 */
export function createSplash({
  BrowserWindow, screen, ipcMain, page, preload, version, background = '#050505', platform = process.platform,
  bounds = () => null, locale = () => 'en', onDetails = () => {}, onClose = () => {}, log = () => {}, capture = null, now = () => Date.now(),
  isQuitting = () => false,
}) {
  let win = null;
  let closing = false;
  let state = { stage: 'checking' };
  let shownAt = null;
  let lastCaptured = null;
  // Who waits for the splash to be on screen (whenShown).
  let waiting = [];
  const settleWaiting = (value) => { const list = waiting; waiting = []; for (const done of list) done(value); };

  const isSplashUrl = (url) => {
    try { return new URL(url).protocol === 'file:' && /\/splash\.html$/.test(new URL(url).pathname); } catch { return false; }
  };

  const view = () => ({ ...splashView(state, { locale: locale() }), lineMs: SPLASH_LINE_MS });

  function send() {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('synabun:splash:state', view()); } catch {}
    if (capture && state.stage !== lastCaptured && shownAt) {
      lastCaptured = state.stage;
      capture(win, `splash-${state.stage}`);
    }
  }

  /** Centred on the screen of the main window (or the one under the cursor). */
  function placement() {
    let area = null;
    try {
      const where = bounds();
      area = (where ? screen.getDisplayMatching(where) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
    } catch {}
    if (!area) area = { x: 0, y: 0, width: SPLASH_SIZE.width * 3, height: SPLASH_SIZE.height * 2 };
    return {
      x: Math.round(area.x + (area.width - SPLASH_SIZE.width) / 2),
      y: Math.round(area.y + (area.height - SPLASH_SIZE.height) / 2),
      width: SPLASH_SIZE.width,
      height: SPLASH_SIZE.height,
    };
  }

  function create() {
    const at = placement();
    const startedAt = now();
    closing = false;
    win = new BrowserWindow({
      ...at,
      useContentSize: true,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      movable: true,
      title: 'SynaBun',
      backgroundColor: background,
      // One window in the taskbar and the window switcher while SynaBun starts, as Discord's updater has.
      skipTaskbar: false,
      ...(platform === 'darwin' ? { roundedCorners: true } : {}),
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
        additionalArguments: [`--synabun-version=${version}`],
      },
    });
    win.setMenuBarVisibility?.(false);
    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      shownAt = now();
      log(`splash shown (${state.stage}) ${shownAt - startedAt} ms after it was asked for`);
      send();
      settleWaiting(true);
    });
    // A person closing it (Alt+F4, Cmd+W) hides it and tells the app (onClose), which applies what closing SynaBun's
    // window means (out of sight, or a quit). A quit closes it for good (a close refused here would cancel the quit).
    win.on('close', (event) => {
      if (closing || isQuitting()) return;
      event.preventDefault();
      win.hide();
      log(`splash closed by a person (${state.stage})`);
      try { onClose({ stage: state.stage }); } catch (error) { log(`splash close: ${error?.message || error}`); }
    });
    win.on('closed', () => {
      // The moment it leaves the screen (an update measures the time with no SynaBun window from here).
      log(`splash window gone (${state.stage})`);
      win = null; shownAt = null; lastCaptured = null; settleWaiting(false);
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadFile(page);
  }

  ipcMain.handle('synabun:splash:action', (event, name) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !isSplashUrl(event.senderFrame?.url)) throw new Error('not allowed');
    if (name === 'ready') { send(); return true; }
    if (name === 'details') { onDetails(); return true; }
    return false;
  });

  return {
    /** Show it (made on first use), saying `next`. */
    show(next = state) {
      state = { ...next };
      if (!win || win.isDestroyed()) create();
      else {
        if (!win.isVisible()) { win.show(); shownAt = shownAt || now(); }
        send();
      }
    },
    /**
     * Resolves true once the splash is on screen (its first frame drawn), or false when it is not shown within
     * `ms` or is closed: what hides another window waits for this, so that no moment passes with neither.
     */
    whenShown(ms = 2000) {
      if (win && !win.isDestroyed() && win.isVisible() && shownAt) return Promise.resolve(true);
      if (!win || win.isDestroyed()) return Promise.resolve(false);
      return new Promise((done) => {
        const timer = setTimeout(() => { waiting = waiting.filter(item => item !== finish); done(false); }, ms);
        const finish = (value) => { clearTimeout(timer); done(value); };
        waiting.push(finish);
      });
    },
    /** What it says now; a hidden or closed splash only remembers it. */
    update(next) {
      state = { ...next };
      send();
    },
    /** Gone, for good (the main window has the screen now, or the app is leaving). */
    close() {
      if (!win || win.isDestroyed()) return;
      const shownFor = shownAt ? now() - shownAt : 0;
      closing = true;
      log(`splash closed (${state.stage}) after ${shownFor} ms`);
      try { win.close(); } catch {}
    },
    get visible() { return !!win && !win.isDestroyed() && win.isVisible(); },
    get exists() { return !!win && !win.isDestroyed(); },
    get window() { return win && !win.isDestroyed() ? win : null; },
    get state() { return { ...state }; },
    isSplashUrl,
  };
}

/** The splash page's file, beside the status page. */
export const splashPageIn = (appDir) => join(appDir, 'src', 'pages', 'splash.html');

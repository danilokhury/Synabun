/**
 * The only bridge between a page and the app (sandboxed, context-isolated).
 *
 *   window.synabunDesktop   on pages of SynaBun's own server: the app's version,
 *                           platform and processor, its update function, Quit,
 *                           its own settings (`app`: Settings > App), and (main
 *                           window only) its title bar: `window`
 *   window.synabunShell     on the app's own status page: its status, the
 *                           start's live log, and the buttons on it
 *   window.synabunSplash    on the app's splash (pages/splash.html): what it
 *                           draws, and its Details button
 *
 * Nothing else is exposed, and no Electron object ever reaches a page: only
 * plain data goes in and out. The app checks the sender of every message
 * again (main.mjs), so a page cannot reach a channel that is not its own.
 *
 * The main window has no native title bar (src/titlebar.mjs): a page of it
 * that does not lay out a title bar of its own (no <meta name="synabun-titlebar">)
 * gets a strip along its top that drags the window, under the caption buttons.
 *
 * The main window stays hidden behind the splash until the interface is ready:
 * on the interface's pages (/, /index.html, /index2d.html), once SynaBun's
 * loading overlay (#loading-overlay: html-shell.js puts it in after the page's
 * translations load, ui-loading.js hides it once the map is drawn) is hidden or
 * shows an error; on any other page (onboarding), when it has loaded. This file
 * says so once per page (synabun:window 'interface-ready'); the app waits a few
 * seconds at most.
 */

const { contextBridge, ipcRenderer } = require('electron');

const argument = (name) => {
  const prefix = `--${name}=`;
  const found = (process.argv || []).find(arg => typeof arg === 'string' && arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
};

function channelListeners(channel) {
  const listeners = new Set();
  ipcRenderer.on(channel, (_event, payload) => {
    for (const listener of listeners) {
      try { listener(payload); } catch (error) { console.error(error); }
    }
  });
  return (listener) => {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** The main window's title bar facts (src/titlebar.mjs titleBarArgument), or null in any other window. */
const titleBar = (() => {
  const raw = argument('synabun-titlebar');
  if (!raw) return null;
  try {
    const facts = JSON.parse(decodeURIComponent(raw));
    const height = Number(facts?.height);
    if (facts?.style !== 'overlay' || !['darwin', 'win32', 'linux'].includes(facts.platform) || !Number.isFinite(height) || height < 24 || height > 96) return null;
    return Object.freeze({ style: 'overlay', platform: facts.platform, height, controls: facts.controls === 'left' ? 'left' : 'right', appMenu: facts.appMenu === true });
  } catch {
    return null;
  }
})();

/**
 * The interface is ready to be seen: SynaBun's loading overlay went away (or says why it cannot), or the page has
 * no overlay and has loaded. Once.
 */
function watchInterfaceReady(say) {
  let said = false;
  const ready = (reason) => { if (said) return; said = true; say(reason); };
  const interfacePage = /^\/(?:index\.html|index2d\.html)?$/.test(location.pathname);
  /** The overlay is there: ready once it is hidden, or says why the interface cannot load. */
  const follow = (overlay) => {
    const settled = () => ['hidden', 'error', 'server-offline'].some(name => overlay.classList.contains(name));
    if (settled()) { ready('overlay'); return; }
    const observer = new MutationObserver(() => { if (settled()) { observer.disconnect(); ready('overlay'); } });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  };
  const start = () => {
    if (!interfacePage) {
      if (document.readyState === 'complete') ready('loaded');
      else window.addEventListener('load', () => ready('loaded'), { once: true });
      return;
    }
    const overlay = document.getElementById('loading-overlay');
    if (overlay) { follow(overlay); return; }
    // Put in by the page's script after its translations load: watched for until it comes.
    const observer = new MutationObserver(() => {
      const found = document.getElementById('loading-overlay');
      if (found) { observer.disconnect(); follow(found); }
    });
    observer.observe(document.body || document.documentElement, { childList: true });
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

/** A page without a title bar of its own: a strip along the top drags the window (the system double-clicks it too). */
function addDragStrip() {
  if (document.querySelector('meta[name="synabun-titlebar"]') || document.getElementById('synabun-desktop-drag-strip')) return;
  const strip = document.createElement('div');
  strip.id = 'synabun-desktop-drag-strip';
  strip.setAttribute('aria-hidden', 'true');
  strip.style.cssText = `position:fixed;top:0;left:0;right:0;height:env(titlebar-area-height,${titleBar.height}px);`
    + '-webkit-app-region:drag;app-region:drag;z-index:2147483647;pointer-events:none;';
  (document.body || document.documentElement).appendChild(strip);
}

if (location.protocol === 'http:' && LOOPBACK.includes(location.hostname)) {
  const onChange = channelListeners('synabun:updates:changed');
  const onOpen = channelListeners('synabun:updates:open');
  const updates = (action) => ipcRenderer.invoke('synabun:updates', action);
  const onWindowState = titleBar ? channelListeners('synabun:window:state') : null;
  const windowAction = (action, payload) => ipcRenderer.invoke('synabun:window', action, payload);
  const onAppChange = channelListeners('synabun:app:changed');
  const appAction = (action, payload) => ipcRenderer.invoke('synabun:app', action, payload);
  if (titleBar) {
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', addDragStrip, { once: true });
    else addDragStrip();
    watchInterfaceReady((reason) => { windowAction('interface-ready', { reason }).catch(() => {}); });
  }
  contextBridge.exposeInMainWorld('synabunDesktop', Object.freeze({
    version: argument('synabun-version'),
    platform: process.platform,
    arch: process.arch,
    updates: Object.freeze({
      state: () => updates('state'),
      check: () => updates('check'),
      download: () => updates('download'),
      // Install now: at once when SynaBun is idle, otherwise as soon as it is.
      install: () => updates('install'),
      // Later: no countdown for a while (the update still installs on quit).
      later: () => updates('later'),
      // The page showed "updated to vX": once is enough.
      acknowledge: () => updates('acknowledge'),
      onChange,
      onOpen,
    }),
    quit: () => ipcRenderer.invoke('synabun:quit'),
    // Settings > App (src/app-prefs.mjs, src/login-item.mjs): the app's own settings, the login item as the system
    // has it, its folders and a restart. A setting is a known name and true or false; a folder is 'data' or 'logs'.
    app: Object.freeze({
      state: () => appAction('state'),
      set: (key, value) => appAction('set', { key: String(key ?? ''), value: value === true }),
      openFolder: (which) => appAction('open-folder', { which: which === 'logs' ? 'logs' : 'data' }),
      // macOS and Windows: the system's own list of login items.
      openLoginSettings: () => appAction('login-settings'),
      relaunch: () => appAction('relaunch'),
      onChange: onAppChange,
    }),
    // The main window's title bar (src/titlebar.mjs): null in any other window of the app.
    window: titleBar ? Object.freeze({
      titleBar,
      // { maximized, fullScreen, focused } now, and on every change.
      state: () => windowAction('state'),
      onState: onWindowState,
      // Windows and Linux: the app's menu, opened under the page's menu button (x, y: CSS pixels of the page).
      showMenu: (point) => windowAction('menu', { x: Number(point?.x), y: Number(point?.y) }),
      // Windows and Linux: the caption buttons in the colours of the bar under them (two #rrggbb colours).
      setColors: (colors) => windowAction('colors', { color: String(colors?.color ?? ''), symbolColor: String(colors?.symbolColor ?? '') }),
    }) : null,
  }));
} else if (location.protocol === 'file:' && /\/splash\.html$/.test(location.pathname)) {
  const onState = channelListeners('synabun:splash:state');
  contextBridge.exposeInMainWorld('synabunSplash', Object.freeze({
    onState,
    ready: () => ipcRenderer.invoke('synabun:splash:action', 'ready'),
    // 'details' only: the start's log, in the main window.
    action: (name) => ipcRenderer.invoke('synabun:splash:action', String(name)),
  }));
} else if (location.protocol === 'file:') {
  const onStatus = channelListeners('synabun:shell:status');
  const onLog = channelListeners('synabun:shell:log');
  contextBridge.exposeInMainWorld('synabunShell', Object.freeze({
    onStatus,
    // The start's steps as they happen (the server's own lines and the app's), for the Details area.
    onLog,
    titleBar,
    ready: () => ipcRenderer.invoke('synabun:shell:action', 'ready'),
    action: (name) => ipcRenderer.invoke('synabun:shell:action', String(name)),
  }));
}

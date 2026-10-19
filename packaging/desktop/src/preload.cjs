/**
 * The only bridge between a page and the app (sandboxed, context-isolated).
 *
 *   window.synabunDesktop   on pages of SynaBun's own server: the app's version,
 *                           platform and processor, its update function, Quit,
 *                           and (main window only) its title bar: `window`
 *   window.synabunShell     on the app's own status page: its status, the
 *                           start's live log, and the buttons on it
 *
 * Nothing else is exposed, and no Electron object ever reaches a page: only
 * plain data goes in and out. The app checks the sender of every message
 * again (main.mjs), so a page cannot reach a channel that is not its own.
 *
 * The main window has no native title bar (src/titlebar.mjs): a page of it
 * that does not lay out a title bar of its own (no <meta name="synabun-titlebar">)
 * gets a strip along its top that drags the window, under the caption buttons.
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
  if (titleBar) {
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', addDragStrip, { once: true });
    else addDragStrip();
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

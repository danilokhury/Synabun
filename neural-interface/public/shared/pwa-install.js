/** Shared by the Install as App menu, the first-run wizard, the native launcher's guide page and the main UI it hands over to. */
export function isStandalone(win = window, nav = navigator) {
  return win.matchMedia('(display-mode: standalone)').matches
    || win.matchMedia('(display-mode: window-controls-overlay)').matches || !!nav.standalone;
}

/** Chromium only: Safari and Firefox have no install event, so there is nothing a page can open there. */
export function canPromptPwaInstall(win = window) {
  return 'onbeforeinstallprompt' in win;
}

export function initPwaInstall({ win = window, nav = navigator, changed = () => {} } = {}) {
  win.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    win._pwaInstallPrompt = event;
    changed('available');
  });
  win.addEventListener('appinstalled', () => {
    win._pwaInstallPrompt = null;
    changed('installed');
  });
  if (isStandalone(win, nav)) changed('installed');
}

export async function requestPwaInstall(win = window) {
  const prompt = win._pwaInstallPrompt;
  if (!prompt) return 'instructions';
  // Called only by a click: genuine browser confirmation, never silent installation.
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  win._pwaInstallPrompt = null; // Browser install events are single-use, including dismissal.
  return outcome;
}

const OFFERED_KEY = 'synabun-pwa-install-offered';

function wasOffered(win) {
  if (win._pwaInstallOffered) return true;
  try { return win.sessionStorage.getItem(OFFERED_KEY) === '1'; } catch { return false; }
}

/**
 * The first-run wizard asks nothing itself: it opens the browser's own install dialog once, from a click the
 * user makes anyway. Call this synchronously in that click, before any await: prompt() needs the click's user
 * activation and uses it up, so never call it from a click that opens a popup, the clipboard or a file picker.
 * Nobody waits for the answer. Without an event it does nothing and the next click tries again; once the dialog
 * has opened, this tab never opens it again (sessionStorage: a reload of the wizard does not ask twice).
 */
export function offerPwaInstallOnce({ win = window, nav = navigator } = {}) {
  const prompt = win._pwaInstallPrompt;
  if (!prompt || isStandalone(win, nav) || wasOffered(win)) return false;
  if (nav.userActivation && !nav.userActivation.isActive) return false; // A scripted click: keep the event for a real one.
  win._pwaInstallPrompt = null; // Single-use, whatever the user answers.
  try { Promise.resolve(prompt.prompt()).catch(() => {}); } catch { return false; }
  win._pwaInstallOffered = true;
  try { win.sessionStorage.setItem(OFFERED_KEY, '1'); } catch {}
  return true;
}

const HANDOFF_KEY = 'synabun-pwa-install-handoff';

/**
 * The guide page's half of the handoff: it leaves a mark for the main UI and goes there instead of asking.
 * sessionStorage, so the mark is this tab's alone. False when it could not be left: the guide stays then.
 */
export function leavePwaInstallHandoff(win = window) {
  try { win.sessionStorage.setItem(HANDOFF_KEY, '1'); return true; } catch { return false; }
}

// A press that follows a link, or belongs to a shortcut (reload, new tab, DevTools), would spend the one dialog
// on a page that is leaving or busy. The next press gets it.
function keepsItsPress(event) {
  return !!(event.ctrlKey || event.metaKey || event.altKey) || /^F\d+$/.test(event.key || '')
    || !!event.target?.closest?.('a[href]');
}

/**
 * The main UI's half. It takes the mark, so only the one page load the guide handed over is armed: not a
 * reload, and never a normal tab. Armed, the first click or key press anywhere opens the browser's dialog
 * through offerPwaInstallOnce(), in the capture phase because prompt() must run inside the press and the UI
 * stops many of its events. Without an event yet the next press tries. `leave` names presses to keep out of
 * it (the menu item that opens the dialog itself). Returns the function that disarms it.
 */
export function armPwaInstallHandoff({ win = window, nav = navigator, leave = () => false } = {}) {
  let marked = false;
  try {
    marked = win.sessionStorage.getItem(HANDOFF_KEY) === '1';
    win.sessionStorage.removeItem(HANDOFF_KEY);
  } catch {}
  if (!marked || isStandalone(win, nav) || wasOffered(win)) return () => {};
  const disarm = () => ['click', 'keydown'].forEach(type => win.removeEventListener(type, press, true));
  const press = event => {
    if (keepsItsPress(event) || leave(event)) return;
    if (offerPwaInstallOnce({ win, nav })) disarm();
  };
  ['click', 'keydown'].forEach(type => win.addEventListener(type, press, true));
  return disarm;
}

const GUIDE_URL = '/install-app.html';

/**
 * Where Apps > Install as App goes when the browser has no dialog ready. The mark says the user asked for the
 * page, so it shows instead of handing over. Safari can add the page it is on to the Dock and the launcher
 * matches that URL without a query, so only a browser with the install event gets the mark.
 */
export function installGuideUrl(win = window) {
  return canPromptPwaInstall(win) ? `${GUIDE_URL}?from=menu` : GUIDE_URL;
}

export function installGuideRequested(search = '') {
  return new URLSearchParams(search).get('from') === 'menu';
}

/**
 * What the launcher's guide page is, for this browser and this install:
 * 'app' (already the installed app: leave), 'wizard' (first run where the wizard opens the dialog: leave),
 * 'handoff' (setup done and nobody asked for the page: leave, the main UI opens the dialog),
 * 'button' (one button that opens the browser's dialog: the page was asked for, or the setup read did not
 * answer), 'safari' or 'other' (plain instructions).
 */
export function installGuideMode({ standalone = false, canPrompt = false, setupComplete = null, requested = false, vendor = '' } = {}) {
  if (standalone) return 'app';
  if (!canPrompt) return /apple/i.test(vendor) ? 'safari' : 'other';
  if (setupComplete === false) return 'wizard';
  return setupComplete === true && !requested ? 'handoff' : 'button';
}

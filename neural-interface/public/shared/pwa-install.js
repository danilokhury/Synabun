/** Shared by the Install as App menu, the first-run wizard and the native launcher's guide page. */
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

/**
 * What the launcher's guide page is, for this browser and this install:
 * 'app' (already the installed app: leave), 'wizard' (first run where the wizard opens the dialog: leave),
 * 'button' (one button that opens the browser's dialog), 'safari' or 'other' (plain instructions).
 */
export function installGuideMode({ standalone = false, canPrompt = false, setupComplete = true, vendor = '' } = {}) {
  if (standalone) return 'app';
  if (canPrompt) return setupComplete === false ? 'wizard' : 'button';
  return /apple/i.test(vendor) ? 'safari' : 'other';
}

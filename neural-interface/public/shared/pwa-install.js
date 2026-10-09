/** Shared by the existing Install as App menu and the native launcher's first-run page. */
export function isStandalone(win = window, nav = navigator) {
  return win.matchMedia('(display-mode: standalone)').matches
    || win.matchMedia('(display-mode: window-controls-overlay)').matches || !!nav.standalone;
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

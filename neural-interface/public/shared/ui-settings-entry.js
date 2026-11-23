// SynaBun — the Settings window's entry: everything the page needs from Settings before it is opened.
//
// ui-settings.js, with what it imports, is about 2 MB of modules. The boot used to load it before the first frame;
// now the window loads on its first open, or in idle time after the page is shown (its search index is a launch
// step, launch-prefetch.js, which loads it), whichever comes first. What must work before that is wired here, as
// ui-settings.js's initSettings did: the three Settings buttons, the `open-settings` shortcut, reopening after a
// language change, the launch prefetches and the listeners that keep Settings' data current. The interface config
// and the skin are iface-config.js.

import { on } from './state.js';
import { t } from './i18n.js';
import { registerAction } from './ui-keybinds.js';
import { registerLaunchPrefetch } from './launch-prefetch.js';
import { prefetchSettingsData, refreshSettingsData } from './settings/settings-data.js';
import { createLazyModule } from './lazy-module.js';

export const settingsModule = createLazyModule(() => import('./ui-settings.js'), { name: 'Settings' });

/** Open Settings (`{ tab, expand, scrollTo }`, ui-settings.js), loading the window first when it has not loaded. */
export const openSettingsModal = settingsModule.asyncExport('openSettingsModal');

/** ui-settings.js's SETTINGS_REOPEN_KEY: the page a language change asked Settings to reopen on. */
export const SETTINGS_REOPEN_KEY = 'synabun-settings-reopen';

function reopenWanted() {
  try { return !!globalThis.sessionStorage?.getItem(SETTINGS_REOPEN_KEY); } catch { return false; }
}

/** settings-backup-encryption.js's RESTORE_OUTCOME_KEY: a restore that finished with problems, not yet read by the owner. */
export const RESTORE_OUTCOME_KEY = 'synabun-restore-outcome';

function restoreOutcomeWaiting() {
  try { return !!globalThis.sessionStorage?.getItem(RESTORE_OUTCOME_KEY); } catch { return false; }
}

let _initialized = false;
export function initSettings() {
  if (_initialized) return;
  _initialized = true;
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.addEventListener('click', () => openSettingsModal());

  const titlebarBtn = document.getElementById('titlebar-settings-btn');
  if (titlebarBtn) titlebarBtn.addEventListener('click', () => openSettingsModal());

  const menubarBtn = document.getElementById('menubar-settings-btn');
  if (menubarBtn) menubarBtn.addEventListener('click', () => openSettingsModal());

  registerAction('open-settings', openSettingsModal);

  // A language change reloaded the app: open Settings again where the user was, once the rest of the app has started.
  if (reopenWanted()) setTimeout(() => { settingsModule.call('reopenSettingsAfterReload', []); }, 0);

  // A restore that finished with problems, and the reload or restart after it: its message is still owed. Its module
  // loads only then.
  if (restoreOutcomeWaiting()) {
    setTimeout(() => {
      import('./settings/settings-backup-encryption-pane.js')
        .then(({ showWaitingRestoreOutcome }) => showWaitingRestoreOutcome({ tx: t }))
        .catch((error) => console.warn('[settings] could not show the restore outcome:', error?.message));
    }, 0);
  }

  // Launch: what Settings is built from, and its search index (the English names too), read and made once the
  // page has painted, so the first open and the first search wait for nothing. The index needs the window's module:
  // this step is what loads it in idle time.
  registerLaunchPrefetch('settings-data', () => prefetchSettingsData(), { order: 60, owner: true });
  registerLaunchPrefetch('settings-search-index', () => settingsModule.call('prebuildSettingsSearchIndex', []), { order: 62 });
  // Changes other windows announce: the next open shows them.
  on('sync:skin:changed', () => refreshSettingsData(['skins']));
  on('sync:greeting:changed', () => refreshSettingsData(['greeting']));
  on('sync:assistant:user-context-changed', () => refreshSettingsData(['userContext']));
}

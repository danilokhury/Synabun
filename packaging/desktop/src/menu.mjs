/**
 * The app menu and the tray menu, as Electron templates. Pure (tested in
 * packaging/tests/desktop-shell.test.mjs): the actions are handed in.
 *
 * macOS gets the standard menus, with the Edit roles that make copy and paste
 * work in the window. Windows and Linux keep the same menu for its shortcuts
 * and show it on Alt (the interface has a menu bar of its own); their tray
 * offers Open SynaBun, Check for Updates and Quit.
 *
 * While a downloaded update waits to be restarted into (`restartReady`), both
 * menus also offer Restart to Update, as Discord's does.
 */

export const MENU_IDS = Object.freeze({ checkForUpdates: 'check-for-updates', restartToUpdate: 'restart-to-update', openLogs: 'open-logs', quit: 'quit-synabun' });

export function appMenuTemplate({ platform = process.platform, t, actions, devTools = true, restartReady = false }) {
  const mac = platform === 'darwin';
  // Electron names its roles in English whatever the language: every one gets the app's own words.
  const role = (name) => ({ role: name, label: t(name) });
  const restart = restartReady ? [{ id: MENU_IDS.restartToUpdate, label: t('restartToUpdate'), click: () => actions.restartToUpdate('menu') }] : [];
  const check = { id: MENU_IDS.checkForUpdates, label: t('checkForUpdates'), click: () => actions.checkForUpdates('menu') };
  const quit = { id: MENU_IDS.quit, label: t('quit'), accelerator: mac ? 'Command+Q' : 'Control+Q', click: () => actions.quit() };
  const openLogs = { id: MENU_IDS.openLogs, label: t('openLogsFolder'), click: () => actions.openLogs() };
  const edit = {
    role: 'editMenu',
    label: t('edit'),
    submenu: [
      role('undo'), role('redo'), { type: 'separator' },
      role('cut'), role('copy'), role('paste'),
      ...(mac ? [role('pasteAndMatchStyle'), role('delete'), role('selectAll')] : [role('delete'), { type: 'separator' }, role('selectAll')]),
    ],
  };
  const view = {
    role: 'viewMenu',
    label: t('view'),
    submenu: [
      role('reload'), role('forceReload'), ...(devTools ? [role('toggleDevTools')] : []), { type: 'separator' },
      role('resetZoom'), role('zoomIn'), role('zoomOut'), { type: 'separator' },
      role('togglefullscreen'),
    ],
  };
  const help = {
    role: 'help',
    label: t('help'),
    submenu: [
      { label: t('website'), click: () => actions.openExternal('https://synabun.ai') },
      { label: t('releaseNotes'), click: () => actions.openExternal('https://github.com/danilokhury/Synabun/releases') },
      { type: 'separator' },
      openLogs,
    ],
  };
  if (mac) {
    return [
      {
        label: 'SynaBun',
        submenu: [
          { role: 'about', label: t('about') },
          { type: 'separator' },
          ...restart,
          check,
          { type: 'separator' },
          role('services'),
          { type: 'separator' },
          role('hide'), role('hideOthers'), role('unhide'),
          { type: 'separator' },
          quit,
        ],
      },
      edit,
      view,
      { role: 'windowMenu', label: t('window'), submenu: [role('minimize'), role('zoom'), { type: 'separator' }, { label: t('openApp'), click: () => actions.showWindow() }, role('front')] },
      help,
    ];
  }
  return [
    { label: t('file'), submenu: [...restart, check, openLogs, { type: 'separator' }, quit] },
    edit,
    view,
    { role: 'windowMenu', label: t('window'), submenu: [role('minimize'), role('close')] },
    help,
  ];
}

export function trayMenuTemplate({ t, actions, restartReady = false }) {
  return [
    { label: t('openApp'), click: () => actions.showWindow() },
    ...(restartReady ? [{ id: MENU_IDS.restartToUpdate, label: t('restartToUpdate'), click: () => actions.restartToUpdate('tray') }] : []),
    { id: MENU_IDS.checkForUpdates, label: t('checkForUpdates'), click: () => actions.checkForUpdates('tray') },
    { type: 'separator' },
    { id: MENU_IDS.quit, label: t('quit'), click: () => actions.quit() },
  ];
}

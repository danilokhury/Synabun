/**
 * SynaBun desktop app: the main process.
 *
 * Electron is the window and the app host, nothing more. SynaBun's server keeps
 * running on SynaBun's own Node 22 (the payload beside this app: runtime/,
 * app/, bootstrap.mjs), started and reused by the same launcher an npm install
 * uses, through the headless entry (synabun-cli). MCP clients and Claude Code
 * hooks are registered with that entry and never start this window.
 *
 *   start     one copy per data home; the splash (splash.mjs: small, centred,
 *             the mascot saying what happens) is the first thing on screen,
 *             and the main window appears only once the interface is ready
 *             behind it, as it was left (place, maximized, full screen). Its
 *             Details button opens the app's own status page in the main
 *             window, whose Details area shows every step of the start as it
 *             happens, the server's own installs and checks included
 *             (start-log.mjs); a start that fails ends there too, with what
 *             failed and the buttons to go on. A start at login that stays in
 *             the background shows nothing
 *   colour    one colour profile for everything the window draws (sRGB): on a
 *             Mac with a display profile of its own, tiles Chromium rasterizes
 *             and tiles it fills with one colour were matched differently, and
 *             a dark page showed a lighter band where its content was
 *   window    sandboxed, context-isolated, no Node; it shows the server's own
 *             pages and nothing else (other addresses go to the browser)
 *   title bar the app's own top bar is the window's title bar, with the
 *             system's caption buttons (Windows, Linux) or traffic lights
 *             (macOS) over it, in its colours (titlebar.mjs); Windows and
 *             Linux open the app's menu from a button in that bar
 *   close     closing the window keeps SynaBun running (the Dock on macOS, the
 *             tray on Windows and Linux); Quit stops the server the app started
 *   updates   the app's own update function (updater/): checked 30 s after
 *             launch and every 6 hours, downloaded at once, installed by itself
 *             when SynaBun is idle (after a countdown the user can postpone),
 *             when the user chooses Restart to Update (the interface's button,
 *             the app menu, the tray), when the app quits, or at the next start
 *             before the server; the window comes back as it was, and says once
 *             that it updated. With automatic updates off it checks and offers,
 *             and installs when the user asks. An install shows the splash
 *             before the window goes, and the new version shows it as its
 *             first act: a SynaBun window is on screen all along but for the
 *             moment the files are swapped. The pre-update snapshot is taken by
 *             this copy, ahead of time when it can (updater/data-guard.mjs),
 *             and handed to the new version, whose first start takes none
 *   settings  Settings > App (app-prefs.mjs, read before anything starts):
 *             automatic updates, open at login (login-item.mjs) and a start
 *             at login without a window, what the close button does, and
 *             hardware acceleration (read once, at start)
 *
 * Test-only switches, read from the environment at start and never settable
 * from a page: SYNABUN_DESKTOP_UPDATE_FEED (a local update feed),
 * SYNABUN_DESKTOP_TEST_DIR (screenshots of the window at each state, taken
 * with webContents.capturePage(), files that press menu items and the update
 * notice's buttons, and a `busy` file that makes SynaBun count as busy). See
 * docs/desktop-app.md.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, screen, session, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { cliInvocation } from './cli.mjs';
import { dataHomeFor, entryFor, isOnMountedVolume, isTranslocated, logsDirFor, macBundleFor, profileDirFor, readManifest } from './paths.mjs';
import { backendUrl, isBackendUrl, isSafeExternal, navigationDecision, permissionDecision } from './navigation.mjs';
import { boundsToSave, MIN_SIZE, relaunchIntent, restoreBounds, splashCloseAction } from './window-state.mjs';
import { pickLocale, translate } from './i18n.mjs';
import { appMenuTemplate, MENU_IDS, trayMenuTemplate } from './menu.mjs';
import { APP_OVERLAY, appMenuPosition, overlayColors, STATUS_OVERLAY, titleBarArgument, titleBarWindowOptions, windowStateOf } from './titlebar.mjs';
import { fetchActivity, pidAlive, runBackendHelper, stopBackend, watchBackend } from './backend.mjs';
import { createFileTail, createStartLog, fileSize, helperEventLine, lastLinesOf } from './start-log.mjs';
import { redactSecrets } from './log-redact.mjs';
import { createUpdateController, RELEASES_URL } from './updater/controller.mjs';
import { feedFromEnv, isNewer } from './updater/feed.mjs';
import { cleanupStagedUpdates, createMacAdapter, folderWritable } from './updater/mac.mjs';
import { createElectronUpdaterAdapter } from './updater/electron-updater-adapter.mjs';
import { recordAppImageSwap, relaunchAfterExit, reopenAfterExit, replaceAppImage } from './updater/linux.mjs';
import { finishPendingSwap, markUpdateHandoff, relaunchWindow, updateStateFiles } from './updater/state.mjs';
import { createDataGuard, runSnapshotCommand } from './updater/data-guard.mjs';
import { createSplash } from './splash.mjs';
import { splashOfSnapshot, stageOfSupervisorPhase } from './splash-model.mjs';
import { cleanupWindowsSwap, startWindowsSwap } from './updater/windows.mjs';
import { prefsPathFor, readPrefChange, readPrefs, writePrefs } from './app-prefs.mjs';
import {
  applyLoginArguments, createLoginItem, findNpmLoginEntry, LOGIN_DATA_FLAG, LOGIN_ENV, LOGIN_FLAG, LOGIN_PORT_FLAG, loginCarry, loginSupport,
  MAC_LOGIN_ITEMS_URL, openedAtLogin, removeNpmLoginEntry,
} from './login-item.mjs';

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STATUS_PAGE = join(APP_DIR, 'src', 'pages', 'status.html');
const SPLASH_PAGE = join(APP_DIR, 'src', 'pages', 'splash.html');
/** The longest the main window waits behind the splash for the interface to say it is ready, once its page loaded. */
const INTERFACE_READY_WAIT_MS = 12000;
/** A start or an update that cannot go on: how long the mascot says so on the splash on screen before the details take over. */
const FAILED_BEAT_MS = 1600;
const PRELOAD = join(APP_DIR, 'src', 'preload.cjs');
const ASSETS = join(APP_DIR, 'assets');
const BACKGROUND = '#050505';
const platform = process.platform;

// The end-to-end test's look at the title bar (SYNABUN_DESKTOP_TEST_DIR only): run in the page, plain data back.
const TITLE_BAR_PROBE = `(() => {
  const html = document.documentElement;
  const bar = document.getElementById('title-bar');
  const style = (el) => (el ? getComputedStyle(el) : null);
  const region = (el) => { const s = style(el); return s ? (s.getPropertyValue('-webkit-app-region') || s.getPropertyValue('app-region') || s.webkitAppRegion || '') : null; };
  const box = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
  const of = (selector) => { const el = document.querySelector(selector); return el ? { rect: box(el), appRegion: region(el) } : null; };
  const wco = navigator.windowControlsOverlay;
  const rect = bar ? bar.getBoundingClientRect() : null;
  const samples = rect ? [0.02, 0.25, 0.5, 0.75, 0.98].map((f) => {
    const x = Math.round(rect.left + rect.width * f); const y = Math.round(rect.top + rect.height / 2);
    const el = document.elementFromPoint(x, y);
    return { x, y, element: el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : null };
  }) : [];
  return {
    path: location.pathname,
    html: html.className, body: document.body ? document.body.className : '',
    wco: wco ? { visible: wco.visible, rect: wco.getTitlebarAreaRect().toJSON() } : null,
    bar: bar ? { rect: box(bar), offsetHeight: bar.offsetHeight, paddingLeft: style(bar).paddingLeft, paddingRight: style(bar).paddingRight, background: style(bar).backgroundColor, appRegion: region(bar) } : null,
    parts: { appMenu: of('#desktop-app-menu-btn'), logo: of('#titlebar-logo'), menubar: of('#title-bar .menubar'), search: of('#search-container'), pill: of('#title-bar .bar-right'), dragStrip: of('#synabun-desktop-drag-strip') },
    pill: (() => { const s = style(document.querySelector('#title-bar .bar-right')); return s ? { background: s.backgroundColor, border: s.borderTopColor } : null; })(),
    navbarHeight: getComputedStyle(html).getPropertyValue('--navbar-height').trim(),
    colors: html.dataset.desktopTitlebarColors || null,
    samples,
  };
})()`;
const TEST_SKIN_ON = `(() => { const s = document.createElement('style'); s.id = 'synabun-test-skin'; s.textContent = '#title-bar { background: rgba(26, 34, 64, 0.92) !important; }'; document.head.appendChild(s); return true; })()`;
const TEST_SKIN_OFF = `(() => { document.getElementById('synabun-test-skin')?.remove(); return true; })()`;

const resourcesDir = () => (!app.isPackaged && process.env.SYNABUN_DESKTOP_RESOURCES) || process.resourcesPath;

const cli = cliInvocation(process.argv, { packaged: app.isPackaged });
if (cli) runCommandLine(cli.args);
else startApp();

/** An old registration named this executable: hand the call to the headless entry, stdio and exit code untouched. */
function runCommandLine(args) {
  try { app.dock?.hide(); } catch {}
  // Whatever Electron keeps for itself goes where the window's profile is, never into a folder of its own.
  try { app.setPath('userData', profileDirFor(dataHomeFor({ env: process.env, home: homedir(), platform }))); } catch {}
  const entry = entryFor(resourcesDir(), readManifest(resourcesDir()));
  if (!entry) {
    process.stderr.write('SynaBun: this copy is incomplete, its command line entry is missing\n');
    app.exit(127);
    return;
  }
  const child = spawn(entry, args, { stdio: 'inherit', env: process.env, windowsHide: true });
  for (const signal of platform === 'win32' ? [] : ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal); } catch {} });
  child.on('error', (error) => { process.stderr.write(`SynaBun: ${error.message}\n`); app.exit(127); });
  child.on('exit', (code, signal) => app.exit(code ?? (signal ? 1 : 0)));
}

function startApp() {
  const env = process.env;
  // Windows: a start at login carries a data folder and a port of their own as arguments (login-item.mjs): they are
  // the environment from here, before the data folder is decided.
  if (platform === 'win32') applyLoginArguments({ argv: process.argv, env });
  const resources = resourcesDir();
  const manifest = readManifest(resources);
  const entry = entryFor(resources, manifest);
  const version = String(manifest?.version || app.getVersion());
  const dataHome = dataHomeFor({ env, home: homedir(), platform });
  const profileDir = profileDirFor(dataHome);
  const logsDir = logsDirFor(dataHome);
  const statePath = join(profileDir, 'desktop-state.json');
  const updateStateDir = join(profileDir, 'update-state');
  const testDir = env.SYNABUN_DESKTOP_TEST_DIR ? String(env.SYNABUN_DESKTOP_TEST_DIR) : null;

  mkdirSync(profileDir, { recursive: true });
  // The window's profile lives in the data home's runtime folder: never inside
  // the app, never beside the user's data, and one per data home.
  app.setPath('userData', profileDir);
  app.setPath('sessionData', profileDir);
  if (platform === 'win32') app.setAppUserModelId('ai.synabun.app');

  // Settings > App: read now, before the app is ready (hardware acceleration can only be turned off before).
  const prefsPath = prefsPathFor(profileDir);
  let prefs = readPrefs(prefsPath);
  const hardwareAcceleration = prefs.hardwareAcceleration;
  if (!hardwareAcceleration) app.disableHardwareAcceleration();
  // One colour profile for everything the windows draw. With the display's own profile, macOS matched the tiles
  // Chromium rasterizes (where a page has content) and the tiles it fills with one colour differently: on a dark
  // page, a lighter band across the middle, exactly on the GPU tile rows. SynaBun's colours are all sRGB.
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  // The macOS and Linux login entries say "at login" in the environment: nothing this app starts inherits it.
  const loginEnvAtStart = env[LOGIN_ENV] === '1';
  delete env[LOGIN_ENV];

  const logPath = join(logsDir, 'desktop.log');
  const log = (line) => {
    try {
      mkdirSync(logsDir, { recursive: true });
      try { if (statSync(logPath).size > 1024 * 1024) renameSync(logPath, `${logPath}.1`); } catch {}
      appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${redactSecrets(line)}\n`);
    } catch {}
  };

  if (!app.requestSingleInstanceLock()) {
    log('another window of SynaBun for this data home is open: handing over to it');
    app.quit();
    return;
  }

  // An update put in place: say that this copy runs (the swap script or the
  // Windows install watchdog keeps the old copy until then), and pick up what a
  // failed one left. How the window was when the old copy quit, for a start the
  // update made.
  const updateFiles = updateStateFiles(updateStateDir);
  const pendingSwap = finishPendingSwap({ stateDir: updateStateDir, current: version });
  const updatedStart = pendingSwap.started || process.argv.includes('--synabun-updated') || process.argv.includes('--updated');
  const relaunch = relaunchWindow(updateFiles.relaunch.read(), { updatedStart });
  updateFiles.relaunch.clear();
  if (pendingSwap.started) {
    const record = updateFiles.attempts.read();
    if (record && !isNewer(version, record.version)) updateFiles.attempts.clear();
  }
  const pendingRecord = updateFiles.pending.read();
  if (pendingRecord && !isNewer(version, pendingRecord.version)) updateFiles.pending.clear();
  if (platform === 'win32') cleanupWindowsSwap(updateStateDir);
  // The snapshot the old copy took for this install (lib/update-snapshot.js): this start's server uses it when the
  // new copy runs, and never when the swap failed or rolled back. Before anything starts the server.
  const installId = typeof pendingSwap.plan?.installId === 'string' ? pendingSwap.plan.installId : null;
  if (installId && pendingSwap.started) markUpdateHandoff({ dataHome, installId, status: 'installed' });
  if (installId && (pendingSwap.rolledBack || pendingSwap.failed)) markUpdateHandoff({ dataHome, installId, status: 'cancelled' });

  const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')) || {}; } catch { return {}; } };
  const writeState = (patch) => {
    try {
      const next = { ...readState(), ...patch };
      writeFileSync(`${statePath}.tmp`, JSON.stringify(next, null, 2) + '\n');
      renameSync(`${statePath}.tmp`, statePath);
    } catch {}
  };

  let locale = 'en';
  const t = (key, params) => translate(locale, key, params);
  let mainWindow = null;
  let tray = null;
  let statusShown = null;
  let backend = null;      // { port, launcherPid, supervisorPid, owned, version }
  let backendShown = false;
  let watcher = null;
  let quitting = false;
  let quitReady = false;
  let quitWork = null;
  let updater = null;
  let starting = null;
  let firstPath = relaunch?.path || '/';
  let serverStopped = false;
  // Open, or closed to the Dock / tray, as the user left it: set where the app shows the window and where its
  // close button hides it. Not isVisible() nor the window's show / hide events: on macOS both follow occlusion,
  // and an update must not bring back hidden a window that other windows only covered.
  let windowOpen = false;
  // The splash (splash.mjs) and the start it covers. `boot` is how this start ends on screen: the main window shown
  // (or minimized), or nothing (a start at login in the background, an update made while the window was closed).
  // The main window is `revealed` once the interface is ready behind the splash, or when a failure, a stopped
  // server or the Details button needs it; after that the splash has nothing more to say.
  let splash = null;
  let boot = { show: true, minimized: false };
  let revealed = false;
  let interfaceTimer = null;
  let dataGuard = null;
  let installingAtLaunch = false;
  // A person closed the splash while the start went on: a start that then fails says so in a notification.
  let splashClosedDuringStart = false;
  const processStart = Date.now() - Math.round(process.uptime() * 1000);
  // The start's live log (start-log.mjs): the status page's Details area. Open by itself on a first start (setup
  // installs and downloads then) and when a start fails; the server's supervisor writes to launcher.log.
  const startLog = createStartLog();
  const launcherLog = join(logsDir, 'launcher.log');
  const firstStart = (() => {
    try { return !/^\s*SETUP_COMPLETE\s*=\s*true\s*$/m.test(readFileSync(join(dataHome, '.env'), 'utf8')); } catch { return true; }
  })();
  startLog.onChange((change) => {
    if (mainWindow && !mainWindow.isDestroyed() && isStatusPage(mainWindow.webContents.getURL())) mainWindow.webContents.send('synabun:shell:log', change);
  });

  log(`SynaBun ${version} (${platform}-${process.arch}${app.runningUnderARM64Translation ? ', Rosetta' : ''}) starting; data home ${dataHome}`);
  if (pendingSwap.started) log(`this copy runs after an update to v${version}${pendingSwap.plan?.previous ? ` from v${pendingSwap.plan.previous}` : ''}`);
  if (pendingSwap.rolledBack) log(`the update to v${pendingSwap.rolledBack.version} did not start; this copy (v${version}) is back`);
  if (pendingSwap.failed) log(`the last update did not install: ${pendingSwap.failed}`);
  if (relaunch) log(`the window opens as it was before the update (${relaunch.visible ? 'shown' : 'in the background'}, ${relaunch.path})`);

  // ── Screenshots and a menu click for the end-to-end test (SYNABUN_DESKTOP_TEST_DIR only) ──
  let captureCount = 0;
  let lastCapturedState = null;
  /** A screenshot of `win` (the main window unless another is named), as its page draws it. */
  const captureWindow = (win, name, delay = 700) => {
    if (!testDir || !win || win.isDestroyed()) return;
    const file = join(testDir, `${String(++captureCount).padStart(3, '0')}-${name.replace(/[^\w.-]+/g, '-')}.png`);
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.capturePage().then((image) => {
        try { mkdirSync(testDir, { recursive: true }); writeFileSync(file, image.toPNG()); log(`test capture: ${file}`); } catch {}
      }).catch(() => {});
    }, delay);
  };
  const capture = (name) => captureWindow(mainWindow, name);
  if (testDir) {
    setInterval(() => {
      for (const [name, act] of [
        ['capture-request', () => {
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) capture('requested');
          if (splash?.visible) captureWindow(splash.window, 'requested-splash', 100);
        }],
        // The splash's Details button, as its page presses it.
        ['click-splash-details', () => { splash?.window?.webContents.executeJavaScript("document.getElementById('details')?.click()", true).catch(() => {}); }],
        // The splash closed as a person closes it (Cmd+W, Alt+F4): the same 'close' event.
        ['close-splash', () => { splash?.window?.close(); }],
        ['click-check-for-updates', () => Menu.getApplicationMenu()?.getMenuItemById(MENU_IDS.checkForUpdates)?.click()],
        ['click-restart-to-update', () => Menu.getApplicationMenu()?.getMenuItemById(MENU_IDS.restartToUpdate)?.click()],
        // What the window's close button and Quit do, through the same handlers.
        ['close-window', () => mainWindow?.close()],
        ['show-window', () => showWindow()],
        ['click-quit', () => Menu.getApplicationMenu()?.getMenuItemById(MENU_IDS.quit)?.click()],
        // The update notice's and dialog's buttons, through the same calls the page makes.
        ['click-later', () => updater?.later()],
        ['click-install-now', () => { updater?.installNow().catch(() => {}); }],
        // The title bar (titlebar.mjs): what the page lays out where, the window's states, a theme change.
        ['titlebar-probe', () => { probeTitleBar(); }],
        ['toggle-maximize', () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); }],
        ['toggle-fullscreen', () => mainWindow?.setFullScreen(!mainWindow.isFullScreen())],
        // The toolbar's own full screen button, as a click (a user gesture) would press it.
        ['click-fullscreen-button', () => { mainWindow?.webContents.executeJavaScript("document.getElementById('titlebar-fullscreen-btn')?.click()", true).catch(() => {}); }],
        ['press-escape', () => { for (const type of ['keyDown', 'keyUp']) mainWindow?.webContents.sendInputEvent({ type, keyCode: 'Escape' }); }],
        // A skin that changes the bar, the way a skin's stylesheet does (the page follows with the caption buttons).
        ['test-skin-on', () => { mainWindow?.webContents.executeJavaScript(TEST_SKIN_ON).catch(() => {}); }],
        ['test-skin-off', () => { mainWindow?.webContents.executeJavaScript(TEST_SKIN_OFF).catch(() => {}); }],
        // The SynaBun logo in the bar opens the Memory Explorer, which makes the bar opaque.
        ['click-titlebar-logo', () => { mainWindow?.webContents.executeJavaScript("document.getElementById('titlebar-logo')?.click()", true).catch(() => {}); }],
        ['open-app-menu', () => { popupAppMenu({ x: 8, y: 48 }); }],
      ]) {
        const file = join(testDir, name);
        if (existsSync(file)) { try { rmSync(file, { force: true }); } catch {} log(`test trigger: ${name}`); act(); }
      }
      // A click on the page, as a person's (a user gesture): the file holds the CSS selector of what to click.
      const click = join(testDir, 'click');
      if (existsSync(click)) {
        let selector = '';
        try { selector = readFileSync(click, 'utf8').trim(); rmSync(click, { force: true }); } catch {}
        log(`test trigger: click ${selector}`);
        if (selector && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el; })()`, true)
            .then((found) => { if (!found) log(`test click: nothing matches ${selector}`); }).catch(() => {});
        }
      }
    }, 500).unref();
  }

  // ── Windows ──

  const isStatusPage = (url) => {
    try { return fileURLToPath(new URL(url)) === STATUS_PAGE; } catch { return false; }
  };
  // The main window's pages are told about its title bar (preload.cjs); a window.open child keeps a native frame.
  const webPreferences = ({ titleBar = false } = {}) => ({
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: true,
    additionalArguments: [`--synabun-version=${version}`, ...(titleBar ? [titleBarArgument(platform)] : [])],
  });

  // ── The title bar (titlebar.mjs) ──

  // What the caption buttons were last given (Windows, Linux) or asked for (macOS has no colours to give).
  let overlayShown = null;
  function applyOverlay(colors, reason) {
    const next = overlayColors(colors);
    if (!next || !mainWindow || mainWindow.isDestroyed()) return false;
    const key = `${next.color}/${next.symbolColor}`;
    if (key === overlayShown) return true;
    overlayShown = key;
    if (platform !== 'darwin') {
      try { mainWindow.setTitleBarOverlay({ ...next }); } catch (error) { log(`the title bar colours could not be set: ${error.message}`); return false; }
    }
    log(`title bar colours ${next.color} / ${next.symbolColor} (${reason})`);
    return true;
  }

  function sendWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (backend && isBackendUrl(mainWindow.webContents.getURL(), backend.port)) mainWindow.webContents.send('synabun:window:state', windowStateOf(mainWindow));
  }

  /** Windows and Linux: the app's menu (the one the hidden menu bar had), opened under the page's menu button. */
  function popupAppMenu(point, zoomFactor = 1) {
    const at = appMenuPosition(point, zoomFactor);
    const menu = Menu.getApplicationMenu();
    if (!at || !menu || !mainWindow || mainWindow.isDestroyed() || platform === 'darwin') return false;
    menu.popup({ window: mainWindow, x: at.x, y: at.y });
    return true;
  }

  /** The end-to-end test's look at the title bar: the page's layout of it and the window's state, as JSON in the test folder. */
  function probeTitleBar() {
    if (!testDir || !mainWindow || mainWindow.isDestroyed()) return;
    const file = join(testDir, `${String(++captureCount).padStart(3, '0')}-titlebar-probe.json`);
    mainWindow.webContents.executeJavaScript(TITLE_BAR_PROBE).then((page) => {
      const facts = { at: new Date().toISOString(), window: { ...windowStateOf(mainWindow), bounds: mainWindow.getBounds(), contentBounds: mainWindow.getContentBounds(), trafficLights: platform === 'darwin' ? mainWindow.getWindowButtonPosition?.() || null : null }, overlayShown, page };
      try { mkdirSync(testDir, { recursive: true }); writeFileSync(file, JSON.stringify(facts, null, 2) + '\n'); log(`test probe: ${file}`); } catch {}
    }).catch((error) => log(`test probe failed: ${error.message}`));
  }

  const windowStatePath = join(profileDir, 'window-state.json');
  let saveTimer = null;
  // Maximized or full screen, for a window that starts hidden: done at its first show (Electron's maximize() and
  // setFullScreen() show a hidden window).
  let pendingBounds = null;
  const saveWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const saved = boundsToSave({
      normalBounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized() || !!pendingBounds?.maximized,
      fullScreen: mainWindow.isFullScreen() || !!pendingBounds?.fullScreen,
    });
    if (saved) { try { writeFileSync(windowStatePath, JSON.stringify(saved) + '\n'); } catch {} }
  };
  const saveWindowStateSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 500); };

  function createMainWindow({ show = true, minimized = false } = {}) {
    let saved = null;
    try { saved = JSON.parse(readFileSync(windowStatePath, 'utf8')); } catch {}
    const bounds = restoreBounds(saved, screen.getAllDisplays().map(display => display.workArea));
    overlayShown = null;
    mainWindow = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      minWidth: MIN_SIZE.width, minHeight: MIN_SIZE.height,
      show: false,
      title: 'SynaBun',
      // The status page's background from the first frame: no white flash before anything is drawn.
      backgroundColor: BACKGROUND,
      // No native title bar: the page's own bar is the title bar, under the system's buttons in its colours.
      ...titleBarWindowOptions(platform, { colors: STATUS_OVERLAY }),
      icon: platform === 'linux' && existsSync(join(ASSETS, 'icon.png')) ? join(ASSETS, 'icon.png') : undefined,
      webPreferences: webPreferences({ titleBar: true }),
    });
    overlayShown = `${STATUS_OVERLAY.color}/${STATUS_OVERLAY.symbolColor}`;
    // The end-to-end test reads and captures the window while other windows cover it (test runs only).
    if (testDir) mainWindow.webContents.setBackgroundThrottling(false);
    // The menu bar of Windows and Linux never shows (the bar's menu button opens the same menu); its shortcuts stay.
    if (platform !== 'darwin') mainWindow.setMenuBarVisibility(false);
    pendingBounds = null;
    if (!show && (bounds.maximized || bounds.fullScreen)) pendingBounds = { maximized: !!bounds.maximized, fullScreen: !!bounds.fullScreen };
    else {
      if (bounds.maximized) mainWindow.maximize();
      if (bounds.fullScreen) mainWindow.setFullScreen(true);
    }
    // After an update the window comes back as it was: shown, minimized, or only in the tray / Dock.
    mainWindow.once('ready-to-show', () => {
      if (!show) return;
      windowOpen = true;
      mainWindow.show();
      if (minimized) mainWindow.minimize();
    });
    mainWindow.on('close', (event) => {
      saveWindowState();
      if (quitting) return;
      event.preventDefault();
      // Settings > App: on Windows and Linux the close button can quit instead (macOS keeps an app in the Dock).
      if (platform !== 'darwin' && !prefs.closeToTray) { app.quit(); return; }
      hideMainWindow();
    });
    for (const name of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) mainWindow.on(name, saveWindowStateSoon);
    // The page lays its bar out for the window's state: no room for buttons that full screen hides.
    for (const name of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'enter-html-full-screen', 'leave-html-full-screen', 'focus', 'blur', 'restore']) {
      mainWindow.on(name, sendWindowState);
    }
    mainWindow.webContents.on('did-finish-load', () => {
      const url = mainWindow.webContents.getURL();
      if (backend && isBackendUrl(url, backend.port)) {
        backendShown = true;
        // The bar's colours from the style guide until the page reports the ones it draws (desktop-titlebar.js).
        applyOverlay(APP_OVERLAY, 'the interface');
        if (!revealed) {
          clearTimeout(interfaceTimer);
          interfaceTimer = setTimeout(() => revealMainWindow('the page loaded and said nothing more'), INTERFACE_READY_WAIT_MS);
        }
        capture('backend');
        if (updater) mainWindow.webContents.send('synabun:updates:changed', updater.state);
      } else {
        backendShown = false;
        if (isStatusPage(url)) applyOverlay(STATUS_OVERLAY, 'the status page');
      }
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) log(`the window could not load ${String(url).slice(0, 160)}: ${description} (${code})`);
    });
    mainWindow.webContents.on('unresponsive', () => log('the window\'s page stopped responding'));
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      log(`the window's page ended (${details.reason}); loading it again`);
      if (!quitting) setTimeout(() => { if (backend && backendShown) mainWindow.loadURL(backendUrl(backend.port)); else showStatus(statusShown || startingStatus()); }, 500);
    });
    mainWindow.loadFile(STATUS_PAGE);
  }

  /**
   * Bring SynaBun to the front (the Dock, the tray, a second start, a notification): while a start runs behind the
   * splash, the splash; once the main window may be seen, the main window.
   */
  function showWindow() {
    if (!revealed && !quitting && splash) {
      boot = { show: true, minimized: false };
      splash.show(splash.state);
      return;
    }
    // Quitting, or installing an update: the splash says what happens; the window would show a server going away.
    if (quitting && splash?.exists) { splash.show(splash.state); return; }
    showMainWindow();
  }

  function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow({ show: false });
    if (mainWindow.isMinimized()) mainWindow.restore();
    windowOpen = true;
    mainWindow.show();
    if (pendingBounds) {
      const { maximized, fullScreen } = pendingBounds;
      pendingBounds = null;
      if (maximized) mainWindow.maximize();
      if (fullScreen) mainWindow.setFullScreen(true);
    }
    mainWindow.focus();
    if (platform === 'darwin') app.dock?.show();
  }

  function hideMainWindow() {
    if (windowOpen) log('the window was closed: SynaBun goes on running');
    windowOpen = false;
    mainWindow.hide();
    if (platform === 'darwin') return;
    const state = readState();
    if (state.closeNoticeShown) return;
    writeState({ closeNoticeShown: true });
    try {
      if (Notification.isSupported()) new Notification({ title: t('stillRunningTitle'), body: tray ? t('stillRunningTray') : t('stillRunningOpen'), silent: true }).show();
    } catch {}
  }

  // ── The splash, and the main window behind it ──

  /** What the splash says; nothing when there is no splash (a start that shows nothing). */
  const splashSay = (next) => { splash?.update(next); };

  /**
   * The interface says it is ready (its loading overlay went away: preload.cjs), or it has had long enough: the
   * main window appears as it was left (place, maximized, full screen, minimized), and the splash goes once it is
   * on screen. A start that shows nothing only lets the splash go.
   */
  function revealMainWindow(reason) {
    clearTimeout(interfaceTimer);
    interfaceTimer = null;
    if (revealed) return;
    revealed = true;
    log(`the interface is ready (${reason}), ${Date.now() - processStart} ms after this copy started`);
    if (!boot.show) { splash?.close(); return; }
    splashSay({ stage: 'ready' });
    showMainWindow();
    if (boot.minimized) mainWindow.minimize();
    setTimeout(() => splash?.close(), 150);
  }

  /**
   * The start needs the main window before the interface (a failure, a conflict, a stopped server, Details). After a
   * failure (`beat`) the splash on screen says so for a moment first; one not on screen yet never appears.
   */
  function revealStatusPage(reason, { beat = false } = {}) {
    clearTimeout(interfaceTimer);
    interfaceTimer = null;
    const shown = splash?.visible || boot.show;
    if (!revealed) { revealed = true; log(`the window opens on the status page (${reason})`); }
    // Closed by a person during the start: nothing is on screen to say it failed, so a notification does (a click
    // shows the status page with the details).
    if (!shown && beat && splashClosedDuringStart && statusShown?.heading) notify(statusShown.heading, statusShown.line || '');
    const open = () => {
      if (quitting) return;
      if (shown) showMainWindow();
      splash?.close();
    };
    if (beat && splash?.visible) setTimeout(open, FAILED_BEAT_MS);
    else open();
  }

  /**
   * A person closed the splash (Cmd+W, Alt+F4) while a start or an install went on behind it: what the main window's
   * close button does applies. On Windows and Linux with "Keep running in the tray" off, SynaBun quits. Otherwise
   * the start goes on out of sight and ends there (no window appears when the interface is ready, or after the
   * update's restart), and the Dock, the tray or opening SynaBun again brings it back.
   */
  function onSplashClosed() {
    const action = splashCloseAction({ platform, closeToTray: prefs.closeToTray, revealed, quitting, installing: updater?.state?.status === 'installing' });
    if (action === 'continue') {
      // An install or a quit under way: it finishes, out of sight; the new copy opens as it was recorded.
      log('the splash was closed during an install or a quit: it goes on out of sight');
      return;
    }
    if (action === 'ignore') return;
    if (action === 'quit') {
      log('the splash was closed during the start and the close button quits: SynaBun quits');
      app.quit();
      return;
    }
    boot = { show: false, minimized: false };
    splashClosedDuringStart = true;
    log('the splash was closed during the start: it goes on out of sight');
    if (platform === 'darwin') return;
    const state = readState();
    if (state.closeNoticeShown) return;
    writeState({ closeNoticeShown: true });
    try {
      if (Notification.isSupported()) new Notification({ title: t('stillRunningTitle'), body: tray ? t('stillRunningTray') : t('stillRunningOpen'), silent: true }).show();
    } catch {}
  }

  // ── The status page ──

  /** A start under way: the status page's words, and the splash's stage (splash-model.mjs). */
  const startingStatus = (line = t('looking'), startedAt = Date.now(), stage = 'checking') => ({
    state: 'starting', busy: true, heading: t('headingStarting'), line, startedAt, elapsedLabel: t('elapsedLabel'),
    actions: [{ id: 'quit', label: t('quit') }], stage,
  });

  const OPEN_DETAILS = ['failed', 'conflict', 'stopped', 'incomplete'];
  function showStatus(status) {
    statusShown = { lang: locale, detailsLabel: t('details'), detailsOpen: firstStart || OPEN_DETAILS.includes(status.state), ...status };
    // The splash follows the start. A start that cannot go on ends on the status page, where the details and the
    // buttons are: the window appears with it (only while the splash covers the start; a window closed to the
    // Dock or the tray stays closed, as before).
    if (OPEN_DETAILS.includes(status.state)) {
      splashSay({ stage: 'failed' });
      if (!revealed) revealStatusPage(status.state, { beat: true });
    } else if (status.stage) {
      splashSay({ stage: status.stage, version: status.version, progress: status.progress || null });
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isStatusPage(mainWindow.webContents.getURL())) mainWindow.webContents.send('synabun:shell:status', statusShown);
    else { backendShown = false; mainWindow.loadFile(STATUS_PAGE); }
    if (status.state !== lastCapturedState) { lastCapturedState = status.state; capture(`status-${status.state}`); }
  }

  ipcMain.handle('synabun:shell:action', async (event, name) => {
    if (!isStatusPage(event.senderFrame?.url)) throw new Error('not allowed');
    if (name === 'ready') {
      if (statusShown) event.sender.send('synabun:shell:status', statusShown);
      event.sender.send('synabun:shell:log', { reset: true, lines: startLog.lines() });
      return true;
    }
    if (name === 'retry' || name === 'start') { startBackend(); return true; }
    if (name === 'logs') { await openLogs(); return true; }
    if (name === 'quit') { app.quit(); return true; }
    return false;
  });

  async function openLogs() {
    mkdirSync(logsDir, { recursive: true });
    const error = await shell.openPath(logsDir);
    if (error) log(`could not open the logs folder: ${error}`);
  }

  // ── The server ──

  function helperEnv() {
    const next = { ...env };
    // The window's own switches are not the server's business.
    for (const key of ['SYNABUN_DESKTOP_TEST_DIR', 'SYNABUN_DESKTOP_UPDATE_FEED', 'SYNABUN_DESKTOP_RESOURCES', 'ELECTRON_RUN_AS_NODE']) delete next[key];
    return next;
  }

  // The first start's snapshot steps, once each, with the time (desktop.log): the check of the copy made before the
  // update, or a new copy and its integrity check.
  let loggedSnapshotStep = null;
  function onHelperEvent(event, startedAt) {
    const line = helperEventLine(event, t);
    if (event.type === 'supervisor' && event.phase === 'snapshot') {
      const step = [event.detail?.step || 'start', event.detail?.state].filter(Boolean).join(' ');
      if (step !== loggedSnapshotStep) {
        loggedSnapshotStep = step;
        log(`the server's start: snapshot step ${step}, ${Date.now() - processStart} ms after this copy started`);
      }
    } else if (event.type === 'supervisor' && loggedSnapshotStep) {
      log(`the server's start: snapshot over (${event.phase}), ${Date.now() - processStart} ms after this copy started`);
      loggedSnapshotStep = null;
    }
    // The snapshot's progress moves the splash's bar; the log keeps one line per step of it.
    const progressOnly = event.type === 'supervisor' && event.phase === 'snapshot' && event.detail?.done !== undefined && event.detail?.done !== null && Number(event.detail.done) > 0;
    if (!progressOnly) startLog.add('app', line);
    const stage = statusShown?.stage || 'checking';
    if (event.type === 'existing' && event.kind === 'ours') showStatus(startingStatus(t('reusing'), startedAt, 'starting'));
    else if (event.type === 'step') showStatus(startingStatus(t('launching'), startedAt, stage));
    else if (event.type === 'supervisor' && event.phase && event.phase !== 'failed') {
      const detail = event.detail || {};
      const snapshot = event.phase === 'snapshot' ? splashOfSnapshot(detail) : null;
      const sized = !!snapshot && Number.isFinite(detail.files) && Number.isFinite(detail.bytes);
      // The status page says what the snapshot step is: the copy made before the update checked against the data, a
      // new copy (with its size), or SQLite's check of that copy.
      const text = sized ? t('snapshotSized', { files: detail.files, megabytes: Math.round(detail.bytes / 1048576) })
        : snapshot?.stage === 'confirming' ? t('snapshotCheck')
          : snapshot?.stage === 'verifying' ? t('snapshotIntegrity')
            : t(event.phase);
      // setup.js goes back to `checking` between its slow steps; after one of those the server is next, and the
      // splash says so rather than going back.
      const next = stageOfSupervisorPhase(event.phase, detail);
      const forward = next === 'checking' && ['browser', 'confirming', 'protecting', 'verifying', 'starting'].includes(stage) ? 'starting' : next;
      const keepLine = snapshot?.stage === 'protecting' && !sized && statusShown?.stage === 'protecting';
      showStatus({
        ...startingStatus(keepLine ? statusShown?.line || text : text, startedAt, forward),
        progress: snapshot ? snapshot.progress : null,
        hint: statusShown?.hint || '',
      });
    } else if (event.type === 'plan' && event.alternativePort) {
      showStatus({ ...startingStatus(t('launching'), startedAt, stage), hint: t('otherPort', { preferred: event.preferredPort, port: event.port }) });
    }
  }

  function startBackend() {
    if (starting) return starting;
    starting = (async () => {
      watcher?.stop();
      watcher = null;
      backendShown = false;
      serverStopped = false;
      if (!entry) {
        showStatus({ state: 'incomplete', heading: t('headingIncomplete'), line: t('incomplete', { what: manifest ? 'synabun-cli' : 'synabun-package.json' }), actions: [{ id: 'quit', label: t('quit'), primary: true }] });
        return;
      }
      const startedAt = Date.now();
      const remembered = readState();
      const preferPort = remembered.port || null;
      // Every attempt's log on its own: what the app runs, then what the supervisor writes from now on.
      startLog.clear();
      startLog.add('app', [
        t('logApp', { version, target: `${platform}-${process.arch}`, dataHome }),
        t('logRun', { command: `"${entry}" app-backend --json${preferPort ? ` --prefer-port ${preferPort}` : ''}` }),
      ]);
      const tail = createFileTail({ path: launcherLog, from: fileSize(launcherLog) });
      const follow = setInterval(() => startLog.add('server', tail.poll()), 400);
      showStatus(startingStatus(t('looking'), startedAt));
      let result;
      try {
        result = await runBackendHelper({ entry, env: helperEnv(), preferPort, onEvent: event => onHelperEvent(event, startedAt), cwd: dataHome });
      } finally {
        clearInterval(follow);
        startLog.add('server', tail.poll());
        startLog.add('server', tail.flush());
      }
      log(`backend helper: ${JSON.stringify(result)}`);
      if (result.type === 'ready') {
        const owned = result.started === true
          || (remembered.backend?.supervisorPid && remembered.backend.supervisorPid === result.supervisorPid && pidAlive(result.supervisorPid));
        backend = { port: result.port, launcherPid: result.launcherPid || remembered.backend?.launcherPid || null, supervisorPid: result.supervisorPid || null, owned: !!owned, version: result.version || version };
        writeState({ port: result.port, backend: owned ? { launcherPid: backend.launcherPid, supervisorPid: backend.supervisorPid, port: backend.port, version, startedAt: new Date().toISOString() } : null });
        startLog.add('app', t('logOpening'));
        showStatus({ ...startingStatus(t('opening'), startedAt, 'loading'), hint: result.alternativePort ? t('otherPort', { preferred: result.preferredPort, port: result.port }) : '' });
        // The page the window showed before an update, once; '/' every other time. Behind the splash the window
        // waits for the interface to say it is ready (preload.cjs), and no longer than INTERFACE_READY_WAIT_MS
        // after its page has loaded (or twice that, when the page never says it loaded).
        if (!revealed) {
          clearTimeout(interfaceTimer);
          interfaceTimer = setTimeout(() => revealMainWindow('no answer from the page'), INTERFACE_READY_WAIT_MS * 2);
        }
        mainWindow.loadURL(backendUrl(result.port, firstPath));
        firstPath = '/';
        watcher = watchBackend({
          port: result.port, supervisorPid: backend.supervisorPid, launcherPid: backend.launcherPid,
          onStopped: () => {
            if (quitting || updater?.state.status === 'installing') return;
            log('the server stopped');
            backendShown = false;
            serverStopped = true;
            startLog.add('app', t('logServerStopped', { file: launcherLog }));
            startLog.add('server', lastLinesOf(launcherLog, 40));
            showStatus({
              state: 'stopped', heading: t('headingStopped'), line: t('stopped'),
              actions: [{ id: 'start', label: t('startAgain'), primary: true }, { id: 'logs', label: t('openLogs') }, { id: 'quit', label: t('quit') }],
            });
          },
        });
        return;
      }
      if (result.type === 'conflict') {
        showStatus({
          state: 'conflict', heading: t('headingConflict'), line: t('conflict', { place: result.projectDir || result.install || '?', port: result.port }),
          actions: [{ id: 'retry', label: t('retry'), primary: true }, { id: 'logs', label: t('openLogs') }, { id: 'quit', label: t('quit') }],
        });
        return;
      }
      showStatus({
        state: 'failed', heading: t('headingFailed'), line: result.message || '', hint: t('failedHint'), detail: result.log ? result.log : '',
        actions: [{ id: 'retry', label: t('retry'), primary: true }, { id: 'logs', label: t('openLogs') }, { id: 'quit', label: t('quit') }],
      });
    })().finally(() => { starting = null; });
    return starting;
  }

  async function stopServer({ reason, always = false }) {
    watcher?.stop();
    watcher = null;
    if (!backend) return;
    if (!backend.owned && !always) { log(`leaving the server on port ${backend.port} running: this app did not start it`); return; }
    log(`stopping the server on port ${backend.port} (${reason})`);
    const result = await stopBackend({ port: backend.port, launcherPid: backend.launcherPid, supervisorPid: backend.supervisorPid, log });
    log(`server stop: ${result.stopped ? 'stopped' : 'NOT stopped'}${result.forced ? ' (forced)' : ''}`);
    writeState({ backend: null });
    backend = null;
  }

  // ── Updates ──

  async function offerMoveToApplications({ always = false } = {}) {
    if (platform !== 'darwin' || !app.isPackaged) return false;
    const bundle = macBundleFor(process.execPath);
    const temporary = isTranslocated(bundle) || (isOnMountedVolume(bundle) && !folderWritable(dirname(bundle)));
    if (!temporary && !always) return false;
    const answer = await dialog.showMessageBox(mainWindow?.isVisible() ? mainWindow : undefined, {
      type: 'question', buttons: [t('moveNow'), t('notNow')], defaultId: 0, cancelId: 1,
      message: t('moveTitle'), detail: isTranslocated(bundle) ? t('moveDetailTranslocated') : t('moveDetailVolume'),
    });
    if (answer.response !== 0) return false;
    try {
      // Stopped first: the server runs from the copy that is about to move.
      await stopServer({ reason: 'move to Applications', always: true });
      quitting = true;
      quitReady = true;
      return app.moveToApplicationsFolder({
        conflictHandler: (kind) => kind !== 'existsAndRunning'
          && dialog.showMessageBoxSync({ type: 'question', buttons: [t('moveNow'), t('notNow')], defaultId: 0, cancelId: 1, message: t('moveTitle') }) === 0,
      });
    } catch (error) {
      log(`move to Applications failed: ${error.message}`);
      quitting = false;
      quitReady = false;
      startBackend();
      return false;
    }
  }

  /**
   * Is SynaBun idle? The server says what runs (GET /api/system/activity); a
   * server that is still starting, or one that does not answer, is not idle.
   * Without a server (none started, or the one it had has stopped) nothing of
   * this app runs. The end-to-end test holds the app busy with a `busy` file
   * in its folder.
   */
  async function activityNow() {
    if (testDir && existsSync(join(testDir, 'busy'))) return { idle: false, busy: [{ kind: 'test', count: 1 }] };
    if (starting) return { idle: false, busy: [{ kind: 'unknown', count: 1 }] };
    if (!backend || serverStopped) return { idle: true, busy: [] };
    return fetchActivity(backend.port);
  }

  /**
   * How the window is now, for the copy that opens after the update (relaunchIntent: before the main window was first
   * revealed, how this start was to end on screen, never the hidden window's own state).
   */
  function rememberWindowForUpdate(next) {
    const alive = !!mainWindow && !mainWindow.isDestroyed();
    let path = '/';
    try {
      const url = new URL(mainWindow.webContents.getURL());
      if (backend && isBackendUrl(url.href, backend.port)) path = `${url.pathname}${url.search}${url.hash}`;
    } catch {}
    saveWindowState();
    const { visible, minimized } = relaunchIntent({ revealed, alive, windowOpen, minimized: alive && mainWindow.isMinimized(), boot });
    updateFiles.relaunch.write({ at: new Date().toISOString(), version: next, path, visible, minimized });
  }

  /** A notice outside the window, for when nobody sees the window: a click shows it. */
  function notify(title, body) {
    try {
      if (!Notification.isSupported()) return;
      const note = new Notification({ title, body, silent: true });
      note.on('click', () => showWindow());
      note.show();
    } catch {}
  }

  // The pages that carry the update notice (ui-update.js, through the navbar): the 3D and 2D maps. On any other
  // page (onboarding, a status page), or with the window out of sight, a system notification says it instead.
  const NOTICE_PAGES = /^\/(?:index\.html|index2d\.html)?$/;
  const interfaceShown = () => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized() || !backendShown || !backend) return false;
    const url = mainWindow.webContents.getURL();
    try { return isBackendUrl(url, backend.port) && NOTICE_PAGES.test(new URL(url).pathname); } catch { return false; }
  };

  async function createUpdater() {
    const feed = feedFromEnv(env);
    if (feed.rejected) log(`ignored ${'SYNABUN_DESKTOP_UPDATE_FEED'}: "${feed.rejected}" is neither https nor this machine`);
    if (feed.test) log(`update feed (test): ${feed.url}`);
    const host = {
      current: version,
      log,
      // Settings > App: off, an update waits for the user's Install now.
      autoUpdate: () => prefs.autoUpdate,
      updated: pendingSwap.started ? { version, previous: pendingSwap.plan?.previous || null } : null,
      attempts: updateFiles.attempts,
      activity: activityNow,
      downloaded: ({ version: next, file }) => {
        updateFiles.pending.write({ version: next, file: file || null, at: new Date().toISOString() });
      },
      beforeInstall: async ({ version: next, trigger, installId }) => {
        // On screen now: the splash (an install at launch), or the main window, open and not minimized. Then the
        // splash takes its place, and the new copy opens with one too. Out of sight, the update stays out of sight.
        const shown = !!splash?.visible || (!!mainWindow && !mainWindow.isDestroyed() && windowOpen && !mainWindow.isMinimized());
        rememberWindowForUpdate(next);
        log(`update to v${next} (${trigger}, install ${installId}): ${shown ? 'the splash takes the window\'s place' : 'nothing is on screen'}`);
        if (shown && splash) {
          revealed = false;
          splash.show({ stage: 'installing', version: next });
          // The window goes once the splash is on screen: never a moment with neither.
          await splash.whenShown();
        }
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
        splashSay({ stage: 'stopping', version: next });
        log(`update to v${next}: stopping the server`);
        // Windows cannot replace a node.exe that runs, and an AppImage's server dies with its mount: stop it first.
        await stopServer({ reason: `update to v${next}`, always: true });
        quitting = true;
        quitReady = true;
      },
      // The pre-update snapshot (updater/data-guard.mjs): the one prepared ahead when nothing was written since,
      // otherwise a new one now, with its progress on the splash. Without it nothing installs.
      protectData: async ({ version: next, installId }) => {
        const prepared = dataGuard?.prepared?.target === next;
        splashSay({ stage: prepared ? 'confirming' : 'protecting', version: next });
        const started = Date.now();
        const result = dataGuard
          ? await dataGuard.protect({ target: next, installId, onProgress: (event) => {
            if (event.phase === 'stale') log(`update to v${next}: the snapshot prepared ahead is not used: ${event.reason}`);
            splashSay({ ...splashOfSnapshot(event), version: next });
          } })
          : { type: 'failed', message: 'this copy cannot take the snapshot' };
        if (result?.type !== 'done') {
          log(`update to v${next}: the pre-update snapshot failed (${result?.code || '?'}): ${result?.message || ''}`);
          throw Object.assign(new Error(result?.message || 'the snapshot failed'), { userMessage: t('errorProtect', { reason: result?.message || '?' }) });
        }
        const what = result.skipped ? 'no user state to protect'
          : result.reused ? `the snapshot prepared ahead is still exact and is handed over (${result.path})`
            : `snapshot taken and handed over (${result.path})`;
        const timings = result.timings ? ` (${Object.entries(result.timings).map(([name, ms]) => `${name} ${ms} ms`).join(', ')})` : '';
        log(`update to v${next}: ${what}, ${Date.now() - started} ms${timings}`);
        splashSay({ stage: 'installing', version: next });
      },
      // Idle, with an update waiting: the snapshot is taken ahead, in the background.
      prepareData: ({ version: next }) => dataGuard?.prepare({ target: next }),
      cancelHandoff: ({ installId }) => { if (markUpdateHandoff({ dataHome, installId, status: 'cancelled' })) log(`the snapshot handed over for install ${installId} is cancelled`); },
      quitForUpdate: () => {
        splashSay({ stage: 'restarting' });
        log('quitting for the update: the splash stays until this copy ends');
        quitting = true;
        quitReady = true;
        app.quit();
        exitSoon();
      },
      afterFailedInstall: async () => {
        quitting = false;
        quitReady = false;
        updateFiles.relaunch.clear();
        // The splash that took the window's place says the update did not finish, for a moment. Then SynaBun comes
        // back as it was: the splash follows the server's start, and the window, with the update's error, appears
        // when it is ready.
        if (splash?.visible) {
          splashSay({ stage: 'failed', update: true });
          await new Promise(done => setTimeout(done, FAILED_BEAT_MS));
        }
        revealed = false;
        boot = { show: !!splash?.visible || windowOpen, minimized: false };
        await startBackend();
      },
    };
    let adapter;
    const packaged = app.isPackaged;
    if (!packaged) {
      adapter = createElectronUpdaterAdapter({ autoUpdater: null, feed, current: version, supported: false });
    } else if (platform === 'darwin') {
      const appPath = macBundleFor(process.execPath);
      try { cleanupStagedUpdates({ appPath, keepVersion: pendingRecord && isNewer(version, pendingRecord.version) ? pendingRecord.version : null }); } catch {}
      if (!pendingRecord || !isNewer(version, pendingRecord.version)) { try { rmSync(join(profileDir, 'updates'), { recursive: true, force: true }); } catch {} }
      adapter = createMacAdapter({
        feed, current: version, appPath, arch: process.arch, translated: app.runningUnderARM64Translation,
        cacheDir: join(profileDir, 'updates'), downloadsDir: (() => { try { return app.getPath('downloads'); } catch { return join(profileDir, 'updates'); } })(),
        stateDir: updateStateDir, parseYaml: text => yaml.load(text), fetchImpl: (url, options) => net.fetch(url, options),
        moveToApplications: () => offerMoveToApplications({ always: true }), reveal: (file) => { if (file) shell.showItemInFolder(file); }, env, log,
      });
    } else {
      const { NsisUpdater, AppImageUpdater } = await import('electron-updater');
      const supported = platform === 'win32' || !!env.APPIMAGE;
      adapter = createElectronUpdaterAdapter({
        autoUpdater: supported ? (platform === 'win32' ? new NsisUpdater() : new AppImageUpdater()) : null,
        platform, feed, current: version, log, supported,
        installWindows: async ({ installer, relaunch: reopen, version: next, previous, installId }) => {
          const started = await startWindowsSwap({
            instDir: dirname(process.execPath), exe: basename(process.execPath), installer, version: next, previous, stateDir: updateStateDir, relaunch: reopen, installId,
            runtimeNode: join(resources, String(manifest?.runtime?.bin || 'runtime'), 'node.exe'),
            scriptSource: readFileSync(join(APP_DIR, 'src', 'updater', 'win-swap.mjs'), 'utf8'), env: helperEnvForUpdate(),
          });
          log(`install watchdog started (pid ${started.pid}): ${started.script}`);
        },
        installAppImage: async ({ downloaded, relaunch: reopen, version: next, previous, installId }) => {
          const image = env.APPIMAGE;
          let placed;
          try {
            placed = replaceAppImage({ downloaded, target: image });
          } catch (error) {
            throw Object.assign(error, { userMessage: t('errorAppImage', { file: image, reason: error.code || error.message }) });
          }
          recordAppImageSwap({ stateDir: updateStateDir, image, previous: placed.previous, version: next, from: previous, relaunch: reopen, installId });
          if (reopen) relaunchAfterExit({ image, previous: placed.previous, stateDir: updateStateDir, env, cwd: dataHome });
        },
      });
    }
    // The pre-update snapshot, through SynaBun's own runtime (lib/update-snapshot.js), which also decides whether one
    // taken earlier still stands for the data (it compares the data home with what the snapshot records).
    dataGuard = createDataGuard({
      dataHome, current: version, log,
      run: (args, onEvent) => (entry
        ? runSnapshotCommand({ entry, args, env: helperEnv(), cwd: dataHome, onEvent })
        : Promise.resolve({ type: 'failed', code: 'INCOMPLETE', message: 'synabun-cli is missing from this copy' })),
    });
    const controller = createUpdateController({ adapter, host, t });
    let lastStep = null;
    controller.onChange((state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (backend && !win.isDestroyed() && isBackendUrl(win.webContents.getURL(), backend.port)) win.webContents.send('synabun:updates:changed', state);
      }
      // An update downloaded and ready to restart into: the menus say Restart to Update (menu.mjs).
      syncRestartItem(state);
      // An install at launch readies the file it downloaded earlier (its checksum, the unpacked copy checked against
      // it, macOS's first-start check): `preparing`. Only bytes that really come over the network are a download.
      if (installingAtLaunch && state.status === 'downloading') {
        const transferring = state.progress?.bytesPerSecond > 0 && state.progress.percent < 100 && state.progress.total > 0;
        splashSay(transferring
          ? { stage: 'downloading', version: state.latest, progress: { done: state.progress.transferred, total: state.progress.total, bytes: true } }
          : { stage: 'preparing', version: state.latest });
      }
      const step = state.status === 'downloaded' ? `downloaded-${state.auto?.phase || 'ready'}` : state.status;
      if (step !== lastStep) {
        lastStep = step;
        // The countdown is on the page; with no page in sight, a notice outside the window says it too.
        if (step === 'downloaded-countdown' && !interfaceShown()) notify(t('countdownTitle', { version: state.latest }), t('countdownBody'));
        if (['available', 'downloading', 'error', 'not-available', 'installing'].includes(state.status) || state.status === 'downloaded') capture(`update-${step}`);
      }
    });
    if (pendingSwap.rolledBack) {
      controller.failed({ version: pendingSwap.rolledBack.version, error: t('errorRolledBack', { version: pendingSwap.rolledBack.version || '?', previous: version }) });
    } else if (pendingSwap.failed) {
      const next = pendingSwap.plan?.version && isNewer(version, pendingSwap.plan.version) ? pendingSwap.plan.version : null;
      controller.failed({ version: next, error: t('errorSwapFailed', { version: next || '?', reason: pendingSwap.failed, previous: version }) });
    }
    return controller;
  }

  /** The environment of the copy the install watchdog opens: this copy's own, so it starts as this one did. */
  function helperEnvForUpdate() {
    const next = { ...env };
    delete next.ELECTRON_RUN_AS_NODE;
    return next;
  }

  async function checkForUpdatesInteractive(source) {
    log(`check for updates (${source})`);
    if (!updater) return;
    const state = await updater.check({ manual: true });
    if (mainWindow && !mainWindow.isDestroyed() && backendShown && backend && revealed) {
      showWindow();
      mainWindow.webContents.send('synabun:updates:open', state);
      return;
    }
    await nativeUpdateDialog(state);
  }

  /** The update, in a native dialog: for a check asked from the menu or the tray while the window cannot show the interface. */
  async function nativeUpdateDialog(state) {
    const parent = mainWindow?.isVisible() ? mainWindow : undefined;
    if (!state.supported) return;
    if (state.status === 'not-available') {
      await dialog.showMessageBox(parent, { type: 'info', buttons: [t('ok')], message: t('upToDate'), detail: t('upToDateDetail', { version }) });
    } else if (state.status === 'available' && state.install === 'move-to-applications') {
      await updater.install();
    } else if (state.status === 'available' && state.autoUpdate === false && state.install === 'restart') {
      // Automatic updates off: one click downloads it and installs it once nothing runs.
      const answer = await dialog.showMessageBox(parent, { type: 'info', buttons: [t('installNow'), t('later')], defaultId: 0, cancelId: 1, message: t('updateAvailable', { version: state.latest }), detail: t('updateAvailableOffDetail') });
      if (answer.response === 0) updater.installNow().catch(() => {});
    } else if (state.status === 'available') {
      const answer = await dialog.showMessageBox(parent, { type: 'info', buttons: [t('download'), t('later')], defaultId: 0, cancelId: 1, message: t('updateAvailable', { version: state.latest }), detail: t('updateAvailableManualDetail') });
      if (answer.response === 0) updater.download();
    } else if (state.status === 'downloading') {
      await dialog.showMessageBox(parent, { type: 'info', buttons: [t('ok')], message: t('updateDownloading', { version: state.latest }), detail: state.autoUpdate === false ? '' : t('updateAutoDetail') });
    } else if (state.status === 'downloaded') {
      const off = state.autoUpdate === false && !state.auto?.now;
      const answer = await dialog.showMessageBox(parent, { type: 'info', buttons: [t('installNow'), t('later')], defaultId: 0, cancelId: 1, message: t('updateReady', { version: state.latest }), detail: off ? t('updateReadyOffDetail') : t('updateAutoDetail') });
      if (answer.response === 0) updater.installNow().catch(() => {});
      else updater.later();
    } else if (state.status === 'error') {
      const answer = await dialog.showMessageBox(parent, { type: 'warning', buttons: [t('ok'), t('downloadYourself')], defaultId: 0, cancelId: 0, message: t('checkFailed'), detail: state.error || '' });
      if (answer.response === 1) shell.openExternal(state.releasesUrl || RELEASES_URL).catch(() => {});
    }
  }

  const fromBackend = (event) => !!backend && isBackendUrl(event.senderFrame?.url, backend.port);

  ipcMain.handle('synabun:updates', async (event, action) => {
    if (!fromBackend(event)) throw new Error('not allowed');
    if (!updater) return null;
    if (action === 'state') return updater.state;
    if (action === 'check') return updater.check({ manual: true });
    if (action === 'download') return updater.download();
    // Install now: at once when SynaBun is idle, otherwise as soon as it is.
    if (action === 'install') return updater.installNow();
    if (action === 'later') return updater.later();
    if (action === 'acknowledge') return updater.acknowledge();
    throw new Error('unknown action');
  });

  ipcMain.handle('synabun:quit', (event) => {
    if (!fromBackend(event)) throw new Error('not allowed');
    setImmediate(() => app.quit());
    return true;
  });

  // ── Settings > App (app-prefs.mjs, login-item.mjs) ──

  // The entry starts this data folder and port (when they are not the usual ones), so the npm entry it replaces is
  // the one for the folder a start at login really opens.
  const loginItem = createLoginItem({ platform, app, execPath: process.execPath, env, home: homedir(), log, carry: loginCarry({ env, dataHome }) });
  // What the last change met: the system's refusal of the login item, or a settings file that could not be written.
  let lastError = null;
  // The npm install's start at login that turning this one on replaced (said once, by the answer to that change).
  let loginReplaced = null;
  let startedAtLogin = false;
  let relaunching = false;

  const temporaryCopy = () => {
    if (platform !== 'darwin' || !app.isPackaged) return false;
    const bundle = macBundleFor(process.execPath);
    return !!bundle && (isTranslocated(bundle) || isOnMountedVolume(bundle));
  };
  const loginSupportNow = () => loginSupport({ platform, packaged: app.isPackaged, env, temporary: temporaryCopy() });

  /** Save settings; throws { code: 'save-failed' } and keeps the old ones when the file cannot be written. */
  function savePrefs(patch) {
    try {
      prefs = writePrefs(prefsPath, { ...prefs, ...patch });
    } catch (error) {
      log(`the app's settings could not be saved (${prefsPath}): ${error.message}`);
      throw Object.assign(new Error(error.message), { code: 'save-failed' });
    }
    return prefs;
  }

  /** What Settings > App shows: the settings, and the login item as the system has it now. */
  function appState() {
    const support = loginSupportNow();
    let login = { enabled: false, status: 'off' };
    if (support.supported) { try { login = loginItem.read(); } catch {} }
    const { autoUpdate, openAtLogin, startHidden, closeToTray } = prefs;
    return {
      version, platform, packaged: app.isPackaged,
      prefs: { autoUpdate, openAtLogin, startHidden, hardwareAcceleration: prefs.hardwareAcceleration, closeToTray },
      login: { supported: support.supported, reason: support.reason, enabled: login.enabled, status: login.status, openedAtLogin: startedAtLogin, replaced: loginReplaced },
      // Read once, at start: a change waits for a restart.
      hardwareAcceleration: { active: hardwareAcceleration, restartNeeded: prefs.hardwareAcceleration !== hardwareAcceleration },
      tray: !!tray,
      error: lastError,
    };
  }

  function sendAppChanged() {
    const state = appState();
    for (const win of BrowserWindow.getAllWindows()) {
      if (backend && !win.isDestroyed() && isBackendUrl(win.webContents.getURL(), backend.port)) win.webContents.send('synabun:app:changed', state);
    }
  }

  async function setLogin(on) {
    const support = loginSupportNow();
    if (!support.supported) { lastError = support.reason; return; }
    try {
      await loginItem.set(on);
    } catch (error) {
      lastError = error.code || 'refused';
      log(`open at login could not be turned ${on ? 'on' : 'off'}: ${error.message}`);
      // The setting follows what the system has now.
      try { savePrefs({ openAtLogin: loginItem.read().enabled }); } catch {}
      return;
    }
    // One start at login per data folder: this app's replaces the npm install's (two would start two servers). All
    // or nothing: when the npm install's stays, this one goes again.
    if (on) {
      const npm = findNpmLoginEntry({ platform, home: homedir(), env, dataHome });
      if (npm) {
        try {
          removeNpmLoginEntry(npm, { platform, env });
          loginReplaced = npm.kind;
          log(`open at login: replaced the npm install's start at login (${npm.where})`);
        } catch (error) {
          lastError = 'npm-entry';
          log(`open at login: the npm install's start at login (${npm.where}) could not be removed (${error.message}): turned off again`);
          try { await loginItem.set(false); } catch (undo) { log(`open at login: could not be turned off again: ${undo.message}`); }
          try { savePrefs({ openAtLogin: loginItem.read().enabled }); } catch {}
          return;
        }
      }
    }
    try { savePrefs({ openAtLogin: on }); } catch (error) { lastError = error.code; }
  }

  async function applyPref({ key, value }) {
    lastError = null;
    loginReplaced = null;
    if (key === 'openAtLogin') return setLogin(value);
    try { savePrefs({ [key]: value }); } catch (error) { lastError = error.code; return; }
    log(`setting ${key}: ${value}`);
    if (key === 'autoUpdate') updater?.autoChanged();
  }

  /** On every start while open at login is on: the item is put back in place, or the setting follows the system. */
  function healLogin() {
    if (!prefs.openAtLogin || !loginSupportNow().supported) return;
    loginItem.heal().then((result) => {
      try {
        if (!result.keep) {
          log(`open at login: the system has it ${result.status}; the setting follows`);
          savePrefs({ openAtLogin: false });
        }
      } catch {}
      sendAppChanged();
    }).catch((error) => log(`open at login: the check failed: ${error?.message || error}`));
  }

  async function openFolder(which) {
    const dir = which === 'data' ? dataHome : which === 'logs' ? logsDir : null;
    if (!dir) throw new Error('unknown folder');
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const error = await shell.openPath(dir);
    if (error) log(`could not open the ${which} folder: ${error}`);
    return { ok: !error, error: error || null };
  }

  /** The system's own list of login items, where a login item that waits for approval is allowed. */
  function openLoginSettings() {
    const url = platform === 'darwin' ? MAC_LOGIN_ITEMS_URL : platform === 'win32' ? 'ms-settings:startupapps' : null;
    if (url) shell.openExternal(url).catch(() => {});
    return !!url;
  }

  /** Quit and open again (a setting read at start). Never installs a downloaded update on the way. */
  function relaunchApp() {
    if (quitting) return;
    relaunching = true;
    log('restarting the app (Settings > App)');
    if (platform === 'linux' && app.isPackaged && env.APPIMAGE) reopenAfterExit({ image: env.APPIMAGE, env, cwd: dataHome });
    // Not a start at login (the data folder and port it carried are in the environment the new copy inherits).
    else app.relaunch({ args: process.argv.slice(1).filter(arg => ![LOGIN_FLAG, '--synabun-updated', '--updated'].includes(arg) && !arg.startsWith(LOGIN_DATA_FLAG) && !arg.startsWith(LOGIN_PORT_FLAG)) });
    app.quit();
  }

  ipcMain.handle('synabun:app', async (event, action, payload) => {
    if (!fromBackend(event)) throw new Error('not allowed');
    if (action === 'state') return appState();
    if (action === 'set') {
      const change = readPrefChange(payload);
      if (!change) throw new Error('a known setting and true or false');
      await applyPref(change);
      const state = appState();
      sendAppChanged();
      return state;
    }
    if (action === 'open-folder') return openFolder(payload?.which);
    if (action === 'login-settings') return openLoginSettings();
    if (action === 'relaunch') { setImmediate(relaunchApp); return true; }
    throw new Error('unknown action');
  });

  // The main window's title bar, for its own pages only (a window.open child has a native frame and no say).
  ipcMain.handle('synabun:window', (event, action, payload) => {
    if (!fromBackend(event) || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) throw new Error('not allowed');
    if (action === 'state') return windowStateOf(mainWindow);
    if (action === 'menu') return popupAppMenu(payload, event.sender.getZoomFactor());
    if (action === 'colors') {
      if (!overlayColors(payload)) throw new Error('two #rrggbb colours');
      return applyOverlay(payload, 'the page');
    }
    // The interface is ready to be seen (preload.cjs): the window comes out from behind the splash.
    if (action === 'interface-ready') {
      const reason = ['overlay', 'loaded'].includes(payload?.reason) ? payload.reason : 'page';
      if (!revealed) revealMainWindow(reason === 'overlay' ? 'the interface finished loading' : 'the page loaded');
      return true;
    }
    throw new Error('unknown action');
  });

  // ── Every page: what it may load, open and ask for ──

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault());
    const guard = (event, url) => {
      const decision = navigationDecision(url, backend?.port, { allowFile: isStatusPage });
      if (decision === 'allow') return;
      event.preventDefault();
      if (decision === 'external') shell.openExternal(url).catch(() => {});
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      if (backend && isBackendUrl(url, backend.port)) {
        // A window of its own (a detached session): the system's frame, dark like the app (nativeTheme below).
        return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: BACKGROUND, autoHideMenuBar: platform !== 'darwin', webPreferences: webPreferences() } };
      }
      if (isSafeExternal(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
  });

  // ── Lifetime ──

  // The server is stopped by now; a page that does not answer must not keep the app (and an update) waiting.
  const exitSoon = () => { setTimeout(() => { log('the window did not close in time: exiting'); app.exit(0); }, 8000).unref(); };

  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('will-quit', () => log('this copy ends'));
  app.on('window-all-closed', () => { /* SynaBun keeps running: the Dock or the tray brings the window back. */ });

  app.on('before-quit', (event) => {
    quitting = true;
    if (quitReady) return;
    event.preventDefault();
    if (quitWork) return;
    quitWork = (async () => {
      updater?.stop();
      // A downloaded update installs on the way out (never on a restart Settings asked for: that opens this copy again).
      const installOnQuit = !relaunching && !!updater?.willInstallOnQuit();
      if (backend && (backend.owned || installOnQuit)) {
        // The window goes at once; while the server stops (and an update is put in place), the splash says so.
        const shown = !!splash?.visible || (!!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
        if (shown && splash) {
          splash.show({ stage: 'quitting' });
          await splash.whenShown(1000);
        }
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
        await stopServer({ reason: 'quit', always: installOnQuit });
      }
      if (installOnQuit) await updater.installOnQuit();
      dataGuard?.discard();
    })().catch(error => log(`while quitting: ${error.message}`)).finally(() => {
      quitReady = true;
      app.quit();
      exitSoon();
    });
  });

  /** The pending update's install at launch: true when the app is on its way out to install it. */
  async function installPendingAtLaunch() {
    const pending = updateFiles.pending.read();
    if (!app.isPackaged || !pending?.version || !isNewer(version, pending.version)) return false;
    if (!pending.file || !existsSync(pending.file)) {
      log(`an update to v${pending.version} was downloaded earlier but its file is gone: the next check downloads it again`);
      return false;
    }
    if (updater.held(pending.version)) {
      log(`an update to v${pending.version} is waiting, but its last install failed: it is tried again at a later check`);
      return false;
    }
    log(`an update to v${pending.version} was downloaded in an earlier run: installing it before the server starts`);
    showStatus({ state: 'installing', busy: true, heading: t('headingInstalling'), line: t('installingAtLaunch', { version: pending.version }), startedAt: Date.now(), elapsedLabel: t('elapsedLabel'), stage: 'installing', version: pending.version });
    let leaving = false;
    installingAtLaunch = true;
    try {
      leaving = await updater.installAtLaunch(pending.version, { until: Date.now() + 3 * 60 * 1000 });
    } catch (error) {
      log(`the update at launch failed: ${error?.message || error}`);
    } finally {
      installingAtLaunch = false;
    }
    if (!leaving) log('the update was not installed at launch: SynaBun starts as usual, and installs it when it is idle');
    return leaving;
  }

  // ── Restart to Update ──

  // The menus offer Restart to Update while a downloaded update waits to be restarted into.
  let menuActions = null;
  let restartReady = false;
  function buildMenus() {
    if (!menuActions) return;
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({ platform, t, actions: menuActions, restartReady })));
    if (platform === 'darwin') {
      app.dock?.setMenu(Menu.buildFromTemplate([
        ...(restartReady ? [{ label: t('restartToUpdate'), click: () => menuActions.restartToUpdate('dock') }] : []),
        { label: t('checkForUpdates'), click: () => menuActions.checkForUpdates('dock') },
      ]));
    } else if (tray) {
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate({ t, actions: menuActions, restartReady })));
    }
  }
  function syncRestartItem(state) {
    const ready = !!state?.supported && state.status === 'downloaded' && state.install === 'restart' && !state.manualFile;
    if (ready === restartReady) return;
    restartReady = ready;
    buildMenus();
  }
  /** Restart to Update (a menu, the tray, the Dock): Install now. While something runs, the update says what it waits for. */
  async function restartToUpdate(source) {
    log(`restart to update (${source})`);
    if (!updater) return;
    const state = await updater.installNow();
    if (state?.status === 'downloaded' && state.auto?.now) {
      if (mainWindow && !mainWindow.isDestroyed() && backendShown && backend && revealed) {
        showWindow();
        mainWindow.webContents.send('synabun:updates:open', state);
      } else {
        await nativeUpdateDialog(state);
      }
    }
  }

  app.whenReady().then(async () => {
    // SynaBun is dark only (DESIGN.md): the menus, dialogs and any native frame follow it, not the system's light mode.
    nativeTheme.themeSource = 'dark';
    let saved = null;
    try { saved = JSON.parse(readFileSync(join(dataHome, 'data', 'ui-state.json'), 'utf8'))?.['synabun-locale'] || null; } catch {}
    locale = pickLocale(app.getPreferredSystemLanguages?.() || [app.getLocale()], saved);

    // A start by the login item (login-item.mjs): with "Start in the background" on, nothing on screen until the user
    // asks for it (the Dock, the tray, or opening SynaBun again). The entry says so itself (the flag on Windows, the
    // variable elsewhere); any other start shows the splash, then the window, and so does a second start that reaches
    // this one (second-instance, activate). After an update the window comes back as it was: shown, minimized (no
    // splash then), or only in the tray / Dock (nothing on screen either).
    startedAtLogin = app.isPackaged && !relaunch && !updatedStart
      && openedAtLogin({ platform, argv: process.argv, env: { [LOGIN_ENV]: loginEnvAtStart ? '1' : '' } });
    const hidden = startedAtLogin && prefs.startHidden;
    if (startedAtLogin) log(`opened at login${hidden ? ': no window until it is asked for' : ''}`);
    boot = relaunch ? { show: relaunch.visible, minimized: relaunch.minimized } : { show: !hidden, minimized: false };

    // The splash before anything slow: the first thing this copy puts on screen.
    splash = createSplash({
      BrowserWindow, screen, ipcMain, page: SPLASH_PAGE, preload: PRELOAD, version, background: BACKGROUND, platform,
      bounds: () => {
        if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.getBounds();
        try { return JSON.parse(readFileSync(windowStatePath, 'utf8')); } catch { return null; }
      },
      locale: () => locale,
      // Details: the start's log, on the status page in the main window, which shows from here on.
      onDetails: () => {
        log('the splash\'s Details: the status page shows the start');
        if (statusShown) statusShown = { ...statusShown, detailsOpen: true };
        revealStatusPage('Details');
        if (mainWindow && !mainWindow.isDestroyed() && isStatusPage(mainWindow.webContents.getURL()) && statusShown) mainWindow.webContents.send('synabun:shell:status', statusShown);
      },
      // A person closed the splash: what closing SynaBun's window means applies to the start it covers.
      onClose: () => onSplashClosed(),
      log, capture: testDir ? (win, name) => captureWindow(win, name, 600) : null,
      isQuitting: () => quitting,
    });
    if (boot.show && !boot.minimized) {
      splash.show({ stage: updatedStart ? 'restarting' : 'checking' });
      log(`splash asked for ${Date.now() - processStart} ms after this copy started${updatedStart ? ' (after an update)' : ''}`);
    }
    app.setAboutPanelOptions({ applicationName: 'SynaBun', applicationVersion: version, version: '', copyright: 'The SynaBun Authors', website: 'https://synabun.ai' });

    menuActions = {
      checkForUpdates: (source) => { checkForUpdatesInteractive(source).catch(error => log(`update check: ${error.message}`)); },
      restartToUpdate: (source) => { restartToUpdate(source).catch(error => log(`restart to update: ${error.message}`)); },
      quit: () => app.quit(),
      openLogs: () => { openLogs(); },
      openExternal: (url) => { if (isSafeExternal(url)) shell.openExternal(url).catch(() => {}); },
      showWindow,
    };
    if (platform !== 'darwin') {
      const trayIcon = join(ASSETS, platform === 'win32' ? 'tray.ico' : 'tray.png');
      try {
        tray = new Tray(existsSync(trayIcon) ? nativeImage.createFromPath(trayIcon) : nativeImage.createEmpty());
        tray.setToolTip('SynaBun');
        tray.on('click', () => showWindow());
      } catch (error) {
        log(`no tray icon: ${error.message}`);
        tray = null;
      }
    }
    buildMenus();

    session.defaultSession.setPermissionRequestHandler((contents, permission, decide, details) => {
      const allowed = permissionDecision(permission, details?.requestingUrl || contents?.getURL(), backend?.port);
      if (!allowed) log(`permission refused: ${permission} for ${String(details?.requestingUrl || contents?.getURL() || '').slice(0, 120)}`);
      decide(allowed);
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => permissionDecision(permission, origin, backend?.port));

    // The main window waits behind the splash, on the status page, until the interface is ready (or the start
    // needs it: a failure, Details).
    createMainWindow({ show: false });
    showStatus(startingStatus(t('looking'), Date.now(), updatedStart ? 'restarting' : 'checking'));
    healLogin();

    // A copy macOS runs from a temporary place, or from its disk image, cannot
    // keep its registrations or update itself: offer the move before anything starts.
    if (await offerMoveToApplications()) return;

    updater = await createUpdater();
    // Updated while nobody looked: one notice outside the window says so (the page says it when it is shown).
    if (pendingSwap.started && relaunch && !relaunch.visible) {
      notify(t('updatedTitle'), t('updatedBody', { version, previous: pendingSwap.plan?.previous || '?' }));
      updater.acknowledge();
    }
    // An update downloaded in an earlier run (the app was closed without quitting it, or it was postponed):
    // it installs now, before the server starts and while nothing runs. Only from the file already on disk.
    if (await installPendingAtLaunch()) return;
    updater.start();
    await startBackend();
  }).catch((error) => {
    log(`start failed: ${error?.stack || error}`);
    dialog.showErrorBox('SynaBun', String(error?.message || error));
    app.exit(1);
  });

  process.on('uncaughtException', (error) => log(`uncaught: ${error?.stack || error}`));
  process.on('unhandledRejection', (error) => log(`unhandled: ${error?.stack || error}`));
}

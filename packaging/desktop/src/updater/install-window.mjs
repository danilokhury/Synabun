/**
 * The install window: what a Windows update shows from the moment the app
 * hands over to its install watchdog until the new version's own window is up.
 *
 * The app's files are what the installer replaces, so nothing of the app can
 * draw while it runs. The window is a small WPF window of Windows PowerShell
 * (install-window.ps1, System32's powershell.exe: on every Windows SynaBun
 * supports, outside the install folder, per user, nothing elevated), started by
 * the watchdog (win-swap.mjs) before the app quits and placed over the splash it
 * takes over from. It draws the splash's mascot (the same 280 x 140 geometry and
 * the same `working` / `ready` / `failed` states), the stage line and the bar,
 * and nothing it was not told:
 *
 *   install-window.json   written here, by the app, once: every sentence already
 *                         translated (the splash's own words, splash-model.mjs),
 *                         where the splash is, the log's path
 *   install-view.json     written by the watchdog at every step
 *                         (win-swap.mjs composeWindowView): stage, mascot, status,
 *                         percent, an error and whether the window closes
 *   window-shown          written by the window once its first frame is drawn:
 *                         the app quits only after it (waitForMarker), so there
 *                         is never a moment with neither window
 *   window-up             written by the new version once its own splash is on
 *                         screen (or once it knows it shows none): the watchdog
 *                         then lets the install window go
 *
 * Plain Node (tested in packaging/tests/desktop-install-window.test.mjs).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { translate } from '../i18n.mjs';
import { SPLASH_LINE_MS, SPLASH_SIZE, splashView } from '../splash-model.mjs';

export const INSTALL_WINDOW_FILES = Object.freeze({
  config: 'install-window.json',
  view: 'install-view.json',
  script: 'install-window.ps1',
  logo: 'install-window-logo.png',
  shown: 'window-shown',
  up: 'window-up',
});

/** How long the app waits for the install window's first frame before it quits anyway (the splash covers until then). */
export const WINDOW_SHOWN_WAIT_MS = 8000;
/** The longest an install window lives, whatever happens: a watchdog that never answers does not leave it for ever. */
export const INSTALL_WINDOW_MAX_MS = 40 * 60 * 1000;

const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

/** One stage of the splash as the window draws it: the words, the mascot, the bubble's lines. */
function stageView(state, locale) {
  const view = splashView(state, { locale });
  return { stage: view.stage, mascot: view.mascot, status: view.status, lines: view.lines };
}

/**
 * Everything the window says, decided here so the watchdog and the window only pick:
 *   views   waiting · installing · restarting · ready · failed (the splash's stages)
 *   text    the window's own sentences, with {version} / {previous} filled and {percent} / {path} left for the
 *           watchdog
 * `bounds` is where the splash is (DIP), so the window opens in its place; null centres it.
 */
export function installWindowConfig({ locale = 'en', version, previous = null, bounds = null, logPath = '', maxMs = INSTALL_WINDOW_MAX_MS } = {}) {
  const lang = locale === 'pt-BR' ? 'pt-BR' : 'en';
  const next = VERSION.test(String(version || '')) ? String(version) : '';
  const before = VERSION.test(String(previous || '')) ? String(previous) : '';
  const t = (key, params = {}) => translate(lang, key, params);
  const waiting = stageView({ stage: 'installing', version: next }, lang);
  waiting.status = next ? t('installWindowWaiting', { version: next }) : waiting.status;
  const place = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }
    : null;
  return {
    synabunInstallWindow: 1,
    lang,
    version: next,
    previous: before,
    size: { width: SPLASH_SIZE.width, height: SPLASH_SIZE.height },
    bounds: place,
    lineMs: SPLASH_LINE_MS,
    maxMs,
    logPath: String(logPath || ''),
    views: {
      waiting,
      installing: stageView({ stage: 'installing', version: next }, lang),
      restarting: stageView({ stage: 'restarting', version: next }, lang),
      ready: stageView({ stage: 'ready', version: next }, lang),
      failed: { ...stageView({ stage: 'failed', update: true, version: next }, lang), lines: [] },
    },
    text: {
      title: t('installWindowTitle'),
      percent: t('splashPercent'),
      kept: t('installWindowKept', { version: next || '?', previous: before || '?' }),
      restored: t('installWindowRestored', { version: next || '?', previous: before || '?' }),
      notRestored: t('installWindowNotRestored', { version: next || '?' }),
      rolledBack: t('installWindowRolledBack', { version: next || '?', previous: before || '?' }),
      stalled: t('installWindowStalled'),
      log: t('installWindowLog'),
      openLog: t('installWindowOpenLog'),
      close: t('installWindowClose'),
    },
  };
}

/** The window's own folder in the update state folder: apart from the watchdog's (`swap`), which the new copy removes. */
export const installWindowDir = (stateDir) => join(stateDir, 'install-window');

/**
 * The window's files in its folder (installWindowDir): the script, the config and the logo, written fresh; a view
 * and the markers of an earlier update removed. Returns the paths.
 */
export function writeInstallWindowFiles({ stateDir, config, scriptSource, logoFile = null, windowDir = installWindowDir(stateDir) }) {
  mkdirSync(windowDir, { recursive: true });
  const script = join(windowDir, INSTALL_WINDOW_FILES.script);
  const configFile = join(windowDir, INSTALL_WINDOW_FILES.config);
  const logo = join(windowDir, INSTALL_WINDOW_FILES.logo);
  for (const name of [INSTALL_WINDOW_FILES.shown, INSTALL_WINDOW_FILES.up]) rmSync(join(stateDir, name), { force: true });
  rmSync(join(windowDir, INSTALL_WINDOW_FILES.view), { force: true });
  // Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page: the script is ASCII (its test says
  // so) and the words come from the JSON, which it reads as UTF-8 itself.
  writeFileSync(script, scriptSource);
  writeFileSync(configFile, `${JSON.stringify({ ...config, logo: logoFile && existsSync(logoFile) ? logo : null }, null, 2)}\n`, 'utf8');
  if (logoFile && existsSync(logoFile)) { try { copyFileSync(logoFile, logo); } catch {} }
  return { dir: windowDir, script, config: configFile, logo, view: join(windowDir, INSTALL_WINDOW_FILES.view), shown: join(stateDir, INSTALL_WINDOW_FILES.shown) };
}

/**
 * Resolves true once `file` exists, false after `ms`. Polls (the window and the new copy are other processes);
 * `exists` and `sleep` are handed in by the tests.
 */
export async function waitForMarker(file, ms, { exists = existsSync, sleep = (wait) => new Promise(done => setTimeout(done, wait)), now = () => Date.now(), every = 100 } = {}) {
  const until = now() + ms;
  for (;;) {
    if (exists(file)) return true;
    if (now() >= until) return false;
    await sleep(every);
  }
}

/** The new version says its window is up (or that it shows none): the watchdog then closes the install window. */
export function markWindowUp(stateDir, what = 'splash') {
  try { writeFileSync(join(stateDir, INSTALL_WINDOW_FILES.up), `${what} ${new Date().toISOString()}\n`); return true; } catch { return false; }
}

/** The text of the install window's script, from the app's own files (inside app.asar, which Electron reads). */
export function installWindowScript(appDir) {
  return readFileSync(join(appDir, 'src', 'updater', INSTALL_WINDOW_FILES.script), 'utf8');
}

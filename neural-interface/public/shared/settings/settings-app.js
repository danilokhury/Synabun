// ═══════════════════════════════════════════
// SETTINGS — App (what the page says)
// ═══════════════════════════════════════════
//
// The software's own controls: updates, start at login, the window, the
// folders and a restart. Two kinds of install answer them:
//
//   desktop  the SynaBun desktop app: its settings are the window's
//            (window.synabunDesktop.app, packaging/desktop/src/app-prefs.mjs),
//            its updates the app's updater (window.synabunDesktop.updates)
//   server   an npm or Git install: GET /api/system/app (lib/app-controls-api.js)
//            and the update check of GET /api/system/version
//
// A row that does not apply to this install is not shown, or is shown off
// with one line that says why. This file decides; settings-app-pane.js draws.
// No imports and no DOM: `node --test` loads it as it is (tests/settings-app.test.mjs).

export const APP_URL = '/api/system/app';
const K = 'settings.redesign.app';

const bool = (value) => value === true;
const text = (value, max = 400) => (typeof value === 'string' && value ? value.slice(0, max) : null);
const PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const LOGIN_STATUSES = new Set(['on', 'off', 'requires-approval', 'disabled', 'not-found']);
const SERVER_STATES = new Set(['on', 'off', 'stale', 'disabled']);

/** The desktop app's report (window.synabunDesktop.app.state()), checked field by field; null when there is none. */
export function readDesktopAppState(state) {
  if (!state || typeof state !== 'object') return null;
  const prefs = state.prefs && typeof state.prefs === 'object' ? state.prefs : {};
  const login = state.login && typeof state.login === 'object' ? state.login : {};
  const gpu = state.hardwareAcceleration && typeof state.hardwareAcceleration === 'object' ? state.hardwareAcceleration : {};
  return {
    platform: PLATFORMS.has(state.platform) ? state.platform : null,
    packaged: bool(state.packaged),
    prefs: {
      autoUpdate: prefs.autoUpdate !== false,
      openAtLogin: bool(prefs.openAtLogin),
      startHidden: prefs.startHidden !== false,
      hardwareAcceleration: prefs.hardwareAcceleration !== false,
      closeToTray: prefs.closeToTray !== false,
    },
    login: {
      supported: bool(login.supported),
      reason: text(login.reason, 40),
      enabled: bool(login.enabled),
      status: LOGIN_STATUSES.has(login.status) ? login.status : 'off',
      replaced: text(login.replaced, 40),
    },
    gpuRestartNeeded: bool(gpu.restartNeeded),
    tray: bool(state.tray),
    error: text(state.error, 40),
  };
}

/** GET /api/system/app (or a refusal of a write, which carries the same body), checked; null when it is not one. */
export function readServerAppState(answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.install !== 'string') return null;
  const startup = answer.startup && typeof answer.startup === 'object' ? answer.startup : {};
  return {
    install: text(answer.install, 20),
    desktop: bool(answer.desktop),
    autoUpdate: answer.updates?.auto !== false,
    startup: {
      supported: bool(startup.supported),
      reason: text(startup.reason, 40),
      enabled: bool(startup.enabled),
      state: SERVER_STATES.has(startup.state) ? startup.state : 'off',
      owner: text(startup.owner, 4096),
    },
    error: answer.ok === false ? text(answer.code, 40) || 'refused' : null,
  };
}

/** Why GET /api/system/app gave no state: 'remote' (asked from another computer), 'old' (a server from before it), 'offline'. */
export function serverRefusal(status, body) {
  const code = body && typeof body === 'object' ? String(body.code || '') : '';
  if (status === 403 && ['LOCAL_ONLY', 'REMOTE_FORBIDDEN', 'BAD_HOST', 'GUEST_FORBIDDEN'].includes(code)) return 'remote';
  if (status === 404 || status === 405) return 'old';
  return 'offline';
}

// ── Updates ──

/**
 * The line under the version: what the last check found. `data` is the page's
 * update data (ui-update.js getSynabunUpdateData): the desktop app's report as
 * versionDataFromDesktop() reads it, or GET /api/system/version.
 * Returns { key, params, tone } (tone: ok | warn | err | off | busy).
 */
export function updateStatus(data) {
  if (!data || typeof data !== 'object') return { key: `${K}.update.notChecked`, params: {}, tone: 'off' };
  const latest = text(data.latest, 64) || '';
  if (data.desktop) {
    if (data.supported === false) return { key: `${K}.update.unsupported`, params: {}, tone: 'off' };
    switch (data.status) {
      case 'checking': return { key: `${K}.update.checking`, params: {}, tone: 'busy' };
      case 'downloading': return { key: `${K}.update.downloading`, params: { version: latest, percent: Math.floor(Number(data.progress?.percent) || 0) }, tone: 'busy' };
      case 'downloaded': return { key: `${K}.update.ready`, params: { version: latest }, tone: 'warn' };
      case 'installing': return { key: `${K}.update.installing`, params: { version: latest }, tone: 'busy' };
      case 'error': return { key: `${K}.update.failed`, params: {}, tone: 'err' };
      case 'not-available': return { key: `${K}.update.upToDate`, params: {}, tone: 'ok' };
      default:
        if (data.updateAvailable && latest) return { key: `${K}.update.available`, params: { version: latest }, tone: 'warn' };
        return { key: `${K}.update.notChecked`, params: {}, tone: 'off' };
    }
  }
  if (data.updateAvailable && latest) return { key: `${K}.update.available`, params: { version: latest }, tone: 'warn' };
  if (!data.checkedAt) return { key: `${K}.update.notChecked`, params: {}, tone: 'off' };
  if (data.npmError && data.gitError) return { key: `${K}.update.failed`, params: {}, tone: 'err' };
  return { key: `${K}.update.upToDate`, params: {}, tone: 'ok' };
}

/** "Checked at 14:05" (`time` writes an ISO time the page's way), or '' before any check. */
export function checkedLine(data, { tx, time }) {
  const at = text(data?.checkedAt, 64);
  if (!at || !Number.isFinite(Date.parse(at))) return '';
  return tx(`${K}.update.checkedAt`, { time: time(at) });
}

/** Is there an update to install now (the Install update button)? */
export function canInstallUpdate(data) {
  if (!data?.updateAvailable) return false;
  if (data.desktop) return ['available', 'downloaded', 'error'].includes(data.status) || !data.status;
  return true;
}

/** The automatic updates switch: { checked, disabled, helpKey }. */
export function autoUpdateRow({ desktop, server, update }) {
  if (desktop) {
    return { checked: desktop.prefs.autoUpdate, disabled: update?.supported === false, helpKey: `${K}.update.autoHelpDesktop` };
  }
  return { checked: server ? server.autoUpdate : update?.autoCheck !== false, disabled: !server || server.desktop, helpKey: `${K}.update.autoHelpServer` };
}

// ── Startup ──

/** The sentence for an error code of a change, '' for none. */
export function startupErrorKey(code) {
  if (!code) return '';
  const known = ['refused', 'write-failed', 'no-wscript', 'bad-path', 'desktop-app', 'npm-entry', 'save-failed', 'network'];
  return `${K}.startup.error.${known.includes(code) ? code : 'refused'}`;
}

/**
 * The start at login switch and the line under it:
 *   { shown, checked, disabled, helpKey, note: { key, params, tone } | null, settingsButton: 'darwin' | 'win32' | null }
 * `platform` is the computer's (the desktop app says its own; the browser's guess otherwise).
 */
export function loginRow({ desktop, server, remote = false, platform = null }) {
  const note = (key, tone = 'off', params = {}) => ({ key, params, tone });
  if (desktop) {
    const { login } = desktop;
    const os = desktop.platform;
    const row = {
      shown: true, checked: login.enabled || login.status === 'requires-approval', disabled: !login.supported,
      helpKey: `${K}.startup.helpDesktop`, note: null, settingsButton: null,
    };
    if (!login.supported) row.note = note(`${K}.startup.reason.${['unpackaged', 'move-to-applications', 'no-appimage'].includes(login.reason) ? login.reason : 'unsupported'}`);
    else if (desktop.error && !['save-failed'].includes(desktop.error)) row.note = note(startupErrorKey(desktop.error), 'err');
    else if (login.status === 'requires-approval') {
      row.note = note(`${K}.startup.requiresApproval`, 'warn');
      row.settingsButton = 'darwin';
    } else if (login.status === 'disabled' || (desktop.prefs.openAtLogin && !login.enabled)) {
      row.note = note(`${K}.startup.disabledInSystem.${os || 'linux'}`, 'warn');
      if (os === 'darwin' || os === 'win32') row.settingsButton = os;
    } else if (login.replaced) row.note = note(`${K}.startup.replaced`, 'ok');
    if (desktop.error === 'save-failed') row.note = note(startupErrorKey('save-failed'), 'err');
    return row;
  }
  const row = { shown: true, checked: !!server?.startup.enabled, disabled: true, helpKey: `${K}.startup.helpServer`, note: null, settingsButton: null };
  if (remote) { row.note = note(`${K}.remote`); return row; }
  if (!server) { row.note = note(`${K}.serverOld`); return row; }
  const { startup } = server;
  if (!startup.supported) {
    // 'desktop': the SynaBun app answers for itself, and this one is from before its own settings.
    row.note = note(`${K}.startup.reason.${['not-here', 'desktop'].includes(startup.reason) ? startup.reason : 'unsupported'}`);
    return row;
  }
  row.disabled = false;
  if (server.error) row.note = note(startupErrorKey(server.error), 'err');
  else if (startup.owner && !startup.enabled) {
    row.note = note(`${K}.startup.owner`, 'off');
    row.disabled = true;
  } else if (startup.state === 'disabled') {
    row.note = note(`${K}.startup.disabledInSystem.${PLATFORMS.has(platform) ? platform : 'linux'}`, 'warn');
  }
  return row;
}

/** Start in the background (desktop only; shown under start at login, live while it is on). */
export function hiddenRow({ desktop }) {
  if (!desktop) return { shown: false, checked: false, disabled: true };
  const on = desktop.login.enabled || desktop.login.status === 'requires-approval';
  return { shown: true, checked: desktop.prefs.startHidden, disabled: !desktop.login.supported || !on, noteKey: on ? '' : `${K}.startup.hiddenNeedsLogin` };
}

// ── Window ──

/**
 * The window section: { reasonKey, closeToTray: { shown, checked, disabled, noteKey }, gpu: { checked, disabled, restartNeeded } }.
 * Outside the desktop app the rows are shown off, with the one line that says they belong to it.
 */
export function windowRows({ desktop }) {
  if (!desktop) {
    return {
      reasonKey: `${K}.window.desktopOnly`,
      closeToTray: { shown: true, checked: false, disabled: true, noteKey: '' },
      gpu: { checked: false, disabled: true, restartNeeded: false },
    };
  }
  const mac = desktop.platform === 'darwin';
  return {
    reasonKey: '',
    closeToTray: {
      shown: true,
      checked: mac ? true : desktop.prefs.closeToTray,
      disabled: mac,
      // macOS keeps an app in the Dock; elsewhere without a tray icon, opening SynaBun again shows the window.
      noteKey: mac ? `${K}.window.macDock` : (!desktop.tray && desktop.prefs.closeToTray ? `${K}.window.noTray` : ''),
    },
    gpu: { checked: desktop.prefs.hardwareAcceleration, disabled: false, restartNeeded: desktop.gpuRestartNeeded },
  };
}

// ── Maintenance ──

/** The folder buttons and the restart: { folders: boolean, restart: boolean, noteKey }. */
export function maintenanceRow({ desktop, server, remote = false, restartAvailable = true }) {
  if (desktop) return { folders: true, restart: restartAvailable, noteKey: '' };
  if (remote) return { folders: false, restart: restartAvailable, noteKey: `${K}.remote` };
  if (!server) return { folders: false, restart: restartAvailable, noteKey: `${K}.serverOld` };
  return { folders: true, restart: restartAvailable, noteKey: '' };
}

/** The platform of this computer as the browser says it, when nothing better is known. */
export function guessPlatform(userAgent = '') {
  const ua = String(userAgent);
  if (/Mac OS X|Macintosh/i.test(ua)) return 'darwin';
  if (/Windows/i.test(ua)) return 'win32';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

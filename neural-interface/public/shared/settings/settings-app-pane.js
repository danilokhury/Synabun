// ═══════════════════════════════════════════
// SETTINGS — App (the pane)
// ═══════════════════════════════════════════
//
// The software's own controls, in four sections: Updates (the version, the last
// check, Check for updates, Install update, automatic updates), Startup (start at
// login, start in the background), Window (what the close button does, hardware
// acceleration) and Maintenance (the data and logs folders, Restart SynaBun).
//
// Inside the desktop app the settings are the app's (window.synabunDesktop.app,
// desktop-bridge.js desktopApp); in an npm or Git install they are the server's
// (GET /api/system/app). Updates go through ui-update.js, the same check and the
// same dialog as the update badge. Restart SynaBun is the Apps menu's own item
// (#menu-restart-server). settings-app.js decides what each row shows; this draws.

import * as kit from './settings-kit.js';
import { desktopApp } from '../desktop-bridge.js';
import { on } from '../state.js';
import { forceCheckSynabunUpdate, getSynabunUpdateData, noteSynabunAutoCheck, openSynabunUpdateModal, refreshSynabunUpdateData } from '../ui-update.js';
import {
  APP_URL, autoUpdateRow, canInstallUpdate, checkedLine, guessPlatform, hiddenRow, loginRow, maintenanceRow, readDesktopAppState,
  readServerAppState, serverRefusal, updateStatus, windowRows,
} from './settings-app.js';

const RESTART_MENU_ITEM = 'menu-restart-server';
const WRITE = Object.freeze({ 'Content-Type': 'application/json', 'X-SynaBun-UI': '1', Accept: 'application/json' });

const row = (id) => `<div class="stg-help stg-app-note" id="${id}" role="status" hidden></div>`;

export function buildAppTab() {
  return `
      <div class="stg-pane stg-app" data-stg-pane="app">
        ${kit.card({
          id: 'stg-sec-app-updates', section: 'app.updates',
          status: kit.pill('', { id: 'stg-app-update-pill' }),
          body: `
          ${kit.toggleField('SYS001', `
            <button type="button" class="stg-action-btn" id="stg-app-install" ${kit.inv('SYS003')} title="${kit.H('SYS003')}" hidden>${kit.L('SYS003')}</button>
            <button type="button" class="stg-action-btn" id="stg-app-check" title="${kit.H('SYS001')}">${kit.L('SYS001')}</button>`, {
            label: `<span id="stg-app-version">${kit.te('settings.redesign.about.loading')}</span>`,
            helpHtml: '<span id="stg-app-update-line" aria-live="polite"></span>',
          })}
          ${kit.toggleField('SYS002', kit.switchInput('stg-app-auto-update'), { forId: 'stg-app-auto-update', helpHtml: '<span id="stg-app-auto-help"></span>' })}`,
        })}
        ${kit.card({
          id: 'stg-sec-app-startup', section: 'app.startup',
          body: `
          ${kit.toggleField('SYS004', `
            <button type="button" class="stg-action-btn compact" id="stg-app-login-settings" hidden></button>
            ${kit.switchInput('stg-app-login')}`, { forId: 'stg-app-login', helpHtml: '<span id="stg-app-login-help"></span>' })}
          ${row('stg-app-login-note')}
          ${kit.toggleField('SYS005', kit.switchInput('stg-app-hidden'), { forId: 'stg-app-hidden', attrs: 'id="stg-app-hidden-row" hidden' })}
          ${row('stg-app-hidden-note')}`,
        })}
        ${kit.card({
          id: 'stg-sec-app-window', section: 'app.window',
          body: `
          ${row('stg-app-window-note')}
          ${kit.toggleField('SYS006', kit.switchInput('stg-app-close-tray'), { forId: 'stg-app-close-tray' })}
          ${row('stg-app-close-note')}
          ${kit.toggleField('SYS007', `
            <button type="button" class="stg-action-btn compact" id="stg-app-relaunch" ${kit.inv('SYS008')} title="${kit.H('SYS008')}" hidden>${kit.L('SYS008')}</button>
            ${kit.switchInput('stg-app-gpu')}`, { forId: 'stg-app-gpu' })}
          ${row('stg-app-gpu-note')}`,
        })}
        ${kit.card({
          id: 'stg-sec-app-maintenance', section: 'app.maintenance',
          body: `
          <div class="stg-action-row">
            <button type="button" class="stg-action-btn" id="stg-app-open-data" ${kit.inv('SYS009')} title="${kit.H('SYS009')}">${kit.L('SYS009')}</button>
            <button type="button" class="stg-action-btn" id="stg-app-open-logs" ${kit.inv('SYS010')} title="${kit.H('SYS010')}">${kit.L('SYS010')}</button>
            <button type="button" class="stg-action-btn" id="stg-app-restart" ${kit.inv('SYS011')} title="${kit.H('SYS011')}">${kit.L('SYS011')}</button>
          </div>
          ${row('stg-app-maint-note')}`,
        })}
      </div>`;
}

/**
 * Load and draw the page the first time it is shown (and on every return to it), and wire it.
 * @param {HTMLElement} overlay  the Settings panel
 * @param {Object} [o]
 * @param {Function} [o.fetchImpl]  fetch (tests)
 * @param {(msg: string) => void} [o.toast]
 * @param {Window} [o.win]  where the desktop app's bridge and the user agent are read
 */
export function wireAppTab(overlay, { fetchImpl = (...args) => fetch(...args), toast = () => {}, win = window } = {}) {
  const pane = kit.paneOf(overlay, 'app');
  if (!pane) return;
  const $ = (id) => pane.querySelector(`#${id}`);
  const bridge = desktopApp(win);
  const platformGuess = guessPlatform(win.navigator?.userAgent);
  let desktop = null;      // readDesktopAppState()
  let server = null;       // readServerAppState()
  let remote = false;      // the server refused: this page is not on the computer that runs SynaBun
  let update = getSynabunUpdateData();
  let busy = false;
  // Nothing is said before the first answer: a row that waits for it is off, without a note.
  let loaded = false;

  const time = (iso) => {
    try { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch { return String(iso).slice(11, 16); }
  };
  const say = (node, key, params) => {
    if (!node) return;
    const textValue = key ? kit.tx(key, params) : '';
    node.textContent = textValue;
    node.hidden = !textValue;
  };
  const setSwitch = (id, { checked, disabled }) => {
    const input = $(id);
    if (!input) return;
    input.checked = !!checked;
    input.disabled = !!disabled || busy;
  };
  const tone = (node, value) => { if (node) node.dataset.state = value || ''; };

  // ── Drawing ──

  function drawUpdates() {
    const version = update?.current || desktop?.version || '';
    say($('stg-app-version'), version ? 'settings.redesign.app.version' : 'settings.redesign.about.loading', { version });
    const status = updateStatus(update);
    const line = [kit.tx(status.key, status.params), checkedLine(update, { tx: kit.tx, time })].filter(Boolean).join(' · ');
    const lineNode = $('stg-app-update-line');
    if (lineNode) lineNode.textContent = line;
    const pill = $('stg-app-update-pill');
    if (pill) { pill.textContent = kit.tx(status.key, status.params); pill.dataset.state = status.tone; }
    const install = $('stg-app-install');
    if (install) install.hidden = !canInstallUpdate(update);
    const auto = autoUpdateRow({ desktop, server, update });
    setSwitch('stg-app-auto-update', auto);
    say($('stg-app-auto-help'), auto.helpKey);
  }

  function drawStartup() {
    const login = loginRow({ desktop, server, remote, platform: desktop?.platform || platformGuess });
    setSwitch('stg-app-login', login);
    say($('stg-app-login-help'), login.helpKey);
    const note = $('stg-app-login-note');
    say(note, login.note?.key, login.note?.params);
    tone(note, login.note?.tone);
    const open = $('stg-app-login-settings');
    if (open) {
      open.hidden = !(bridge && login.settingsButton);
      if (login.settingsButton) open.textContent = kit.tx(`settings.redesign.app.startup.openSettings.${login.settingsButton}`);
    }
    const hidden = hiddenRow({ desktop });
    const hiddenField = $('stg-app-hidden-row');
    if (hiddenField) hiddenField.hidden = !hidden.shown;
    setSwitch('stg-app-hidden', hidden);
    say($('stg-app-hidden-note'), hidden.shown ? hidden.noteKey : '');
  }

  function drawWindow() {
    const rows = windowRows({ desktop });
    say($('stg-app-window-note'), rows.reasonKey);
    setSwitch('stg-app-close-tray', rows.closeToTray);
    say($('stg-app-close-note'), rows.closeToTray.noteKey);
    setSwitch('stg-app-gpu', rows.gpu);
    const relaunch = $('stg-app-relaunch');
    if (relaunch) relaunch.hidden = !rows.gpu.restartNeeded;
    say($('stg-app-gpu-note'), rows.gpu.restartNeeded ? 'settings.redesign.app.window.restartNeeded' : '');
  }

  function drawMaintenance() {
    const maint = maintenanceRow({ desktop, server, remote, restartAvailable: !!document.getElementById(RESTART_MENU_ITEM) });
    for (const id of ['stg-app-open-data', 'stg-app-open-logs']) { const btn = $(id); if (btn) btn.disabled = !maint.folders || busy; }
    const restart = $('stg-app-restart');
    if (restart) restart.hidden = !maint.restart;
    const note = $('stg-app-maint-note');
    if (note && !note.dataset.error) say(note, maint.noteKey);
  }

  function draw() {
    if (!loaded) {
      pane.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = true; });
      return;
    }
    drawUpdates();
    drawStartup();
    drawWindow();
    drawMaintenance();
  }

  // ── Loading ──

  async function readServer() {
    try {
      const res = await fetchImpl(APP_URL, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      if (res.ok) { server = readServerAppState(body); remote = false; return; }
      remote = serverRefusal(res.status, body) === 'remote';
      server = null;
    } catch {
      server = null;
    }
  }

  /**
   * The update state as it is, without a check of its own: the desktop app's last report, or the server's last
   * look (GET /api/system/version without ?force: with automatic updates off, opening this page asks nothing).
   * Through ui-update.js, so the badge and Install update see the same offer this page shows.
   */
  async function readUpdate() {
    try { return (await refreshSynabunUpdateData()) || getSynabunUpdateData(); } catch { return getSynabunUpdateData(); }
  }

  async function load() {
    if (bridge) {
      try { desktop = readDesktopAppState(await bridge.state()); } catch { desktop = null; }
    } else {
      await readServer();
    }
    update = (await readUpdate()) || update;
    loaded = true;
    if (!document.body.contains(overlay)) return;
    draw();
  }

  let loading = null;
  const ensure = () => { if (!loading) loading = load().finally(() => { loading = null; }); return loading; };
  draw();
  if (kit.paneActive(overlay, 'app')) ensure();
  overlay.addEventListener('stg-page-change', (e) => { if (e.detail?.page === 'app') ensure(); });

  // The app's updater and its settings speak when they change (a check on its schedule, the login item put back).
  const offUpdate = on('synabun-update:changed', (data) => { update = data || update; if (loaded && document.body.contains(overlay)) drawUpdates(); });
  let offApp = null;
  try {
    offApp = bridge?.onChange?.((state) => {
      const next = readDesktopAppState(state);
      if (next && document.body.contains(overlay)) { desktop = next; draw(); }
    });
  } catch {}
  const observer = new MutationObserver(() => {
    if (document.body.contains(overlay)) return;
    observer.disconnect();
    try { offUpdate?.(); } catch {}
    try { offApp?.(); } catch {}
  });
  observer.observe(document.body, { childList: true });

  // ── Changes ──

  /** One switch of the desktop app: the app answers with its whole state (and what the system said). */
  async function setDesktop(key, value) {
    try {
      desktop = readDesktopAppState(await bridge.set(key, value)) || desktop;
    } catch {
      desktop = desktop ? { ...desktop, error: 'save-failed' } : desktop;
      toast(kit.tx('settings.redesign.app.saveFailed'));
    }
  }

  /** One switch of an npm or Git install. */
  async function setServer(path, payload) {
    try {
      const res = await fetchImpl(`${APP_URL}/${path}`, { method: 'PUT', headers: WRITE, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => null);
      const next = readServerAppState(body);
      if (next) server = next;
      else {
        if (serverRefusal(res.status, body) === 'remote') remote = true;
        toast(kit.tx('settings.redesign.app.saveFailed'));
      }
      return res.ok;
    } catch {
      if (server) server = { ...server, error: 'network' };
      toast(kit.tx('settings.redesign.app.saveFailed'));
      return false;
    }
  }

  async function change(work) {
    if (busy) return;
    busy = true;
    try { await work(); } finally { busy = false; draw(); }
  }

  $('stg-app-auto-update')?.addEventListener('change', (e) => change(async () => {
    const on = e.target.checked;
    if (desktop) {
      await setDesktop('autoUpdate', on);
      update = (await readUpdate()) || update;
    } else if (await setServer('updates', { auto: on })) {
      noteSynabunAutoCheck(on);
      // Turned on: look now, as a start of the server would.
      if (on) { try { update = (await forceCheckSynabunUpdate({ alert: false })) || update; } catch {} }
    }
  }));

  $('stg-app-login')?.addEventListener('change', (e) => change(async () => {
    if (desktop) await setDesktop('openAtLogin', e.target.checked);
    else await setServer('startup', { enabled: e.target.checked });
  }));
  $('stg-app-hidden')?.addEventListener('change', (e) => change(() => setDesktop('startHidden', e.target.checked)));
  $('stg-app-close-tray')?.addEventListener('change', (e) => change(() => setDesktop('closeToTray', e.target.checked)));
  $('stg-app-gpu')?.addEventListener('change', (e) => change(() => setDesktop('hardwareAcceleration', e.target.checked)));
  $('stg-app-relaunch')?.addEventListener('click', () => { try { bridge?.relaunch?.(); } catch {} });
  $('stg-app-login-settings')?.addEventListener('click', () => { try { bridge?.openLoginSettings?.(); } catch {} });

  $('stg-app-check')?.addEventListener('click', () => change(async () => {
    const btn = $('stg-app-check');
    if (btn) btn.disabled = true;
    say($('stg-app-update-line'), 'settings.redesign.app.update.checking');
    let found = null;
    try { found = await forceCheckSynabunUpdate({ alert: false }); } catch {}
    // A failed check answers null: the desktop app's report says why; for the server, the check failed.
    if (found) update = found;
    else if (bridge) update = (await readUpdate()) || update;
    else update = { ...(update || {}), updateAvailable: false, checkedAt: new Date().toISOString(), npmError: 'failed', gitError: 'failed' };
    if (btn) btn.disabled = false;
  }));
  $('stg-app-install')?.addEventListener('click', () => openSynabunUpdateModal());

  async function openFolder(which) {
    const note = $('stg-app-maint-note');
    let ok = false;
    if (bridge) {
      try { ok = !!(await bridge.openFolder(which))?.ok; } catch { ok = false; }
    } else {
      try {
        const res = await fetchImpl(`${APP_URL}/open-folder`, { method: 'POST', headers: WRITE, body: JSON.stringify({ which }) });
        ok = res.ok;
      } catch { ok = false; }
    }
    if (note) {
      if (ok) { delete note.dataset.error; drawMaintenance(); } else { note.dataset.error = '1'; say(note, 'settings.redesign.app.maintenance.openFailed'); tone(note, 'err'); }
    }
  }
  $('stg-app-open-data')?.addEventListener('click', () => openFolder('data'));
  $('stg-app-open-logs')?.addEventListener('click', () => openFolder('logs'));
  $('stg-app-restart')?.addEventListener('click', () => document.getElementById(RESTART_MENU_ITEM)?.click());
}

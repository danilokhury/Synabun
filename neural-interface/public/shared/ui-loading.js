// ═══════════════════════════════════════════
// SynaBun Neural Interface — Loading Overlay
// Health check, server start, server-offline retry, command copy
// ═══════════════════════════════════════════

import { fetchHealth, startHealth } from './api.js';
import { emit } from './state.js';
import { t } from './i18n.js';
import {
  START_STORAGE, createStartBridge, fetchStartBeacon, isMacPlatform, isWindowsPlatform,
  manualStartCommands, openStartLink, startBeaconTarget, startButtonUsable, startStatusView,
} from './start-bridge.js';
// Imported with the app, not when it is needed: once the server is down
// nothing more can be fetched, and that is exactly when the overlay wants it.
import { createMascot } from './synabun-mascot.js';

const $ = (id) => document.getElementById(id);

// ── Internal refs (resolved once on init) ──
let _statusDot = null;
let _initCallback = null;
// The server-offline state: watches for the server and owns the Start button.
let _offlineBridge = null;
// The title the overlay was given for "offline" (a start replaces it while it runs).
let _offlineTitle = '';
// The mascot rig in the overlay, mounted the first time the server is offline.
let _mascot = null;

// What the mascot does for each thing the page knows about a start
// (startStatusView's `mascot`), as poses of the shared rig.
const MASCOT_POSE = {
  asleep: 'sleep',
  waking: 'wait',
  working: 'think',
  ready: 'success',
  failed: 'error',
  stalled: 'offline',
};

function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// ═══════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════

/**
 * Show an error state on the loading overlay.
 * @param {string}  title         Main heading text
 * @param {string}  sub           Subtitle / description
 * @param {boolean} canStart      Whether to show the "Start" action button
 * @param {boolean} serverOffline Whether to show the server-offline UI (mascot + command)
 */
export function showLoadingError(title, sub, canStart, serverOffline) {
  const $overlay = $('loading-overlay');
  if (!$overlay) return;

  $overlay.classList.add('error');
  if (serverOffline) $overlay.classList.add('server-offline');
  else $overlay.classList.remove('server-offline');

  if (_statusDot) _statusDot.classList.add('error');

  const $text = $('loading-text');
  const $sub = $('loading-sub');
  if ($text) $text.textContent = title;
  if ($sub) $sub.textContent = sub;
  if (serverOffline) _offlineTitle = title;

  // Offline, the button asks the OS to start the server (synabun://start); it
  // is left out only when that launcher is known not to be registered.
  const offlineStart = !!serverOffline && startButtonUsable(stored(START_STORAGE.launcher));
  const $action = $('loading-action');
  const $btn = $('loading-action-btn');
  if (canStart || offlineStart) {
    if ($action) $action.style.display = 'block';
    if ($btn) $btn.disabled = false;
    const $label = $('loading-action-label');
    if ($label) $label.textContent = serverOffline ? t('loading.startServer') : t('common.start');
  } else {
    if ($action) $action.style.display = 'none';
  }

  clearStartStatus();

  if (serverOffline) {
    const $hint = $('loading-server-cmd-hint');
    if ($hint) $hint.textContent = offlineStart ? t('loading.runCommandOr') : t('loading.runCommandSetup');
    watchForServer();
  } else {
    stopWatchingForServer();
  }
}

/**
 * Hide the loading overlay with a fade-out transition.
 * @param {number} [delay=400] Milliseconds before adding the hidden class
 */
export function hideLoading(delay = 400) {
  const $overlay = $('loading-overlay');
  if ($overlay) setTimeout(() => $overlay.classList.add('hidden'), delay);
}

/**
 * Show the loading overlay (remove hidden class).
 */
export function showLoading() {
  const $overlay = $('loading-overlay');
  if ($overlay) $overlay.classList.remove('hidden');
}

/**
 * Reset the loading overlay back to its initial "Connecting" state
 * and clear any error classes.
 */
function resetLoadingToConnecting() {
  const $overlay = $('loading-overlay');
  if (!$overlay) return;

  $overlay.classList.remove('error', 'server-offline');
  stopWatchingForServer();

  const $text = $('loading-text');
  const $sub = $('loading-sub');
  const $action = $('loading-action');
  const $actionStatus = $('loading-action-status');

  if ($text) $text.textContent = t('loading.connecting');
  if ($sub) $sub.textContent = t('loading.initializingNeural');
  if ($action) $action.style.display = 'none';
  if ($actionStatus) $actionStatus.textContent = '';
  clearStartStatus();
  if (_statusDot) _statusDot.classList.remove('error');
}

// ═══════════════════════════════════════════
// HEALTH CHECK (called during init)
// ═══════════════════════════════════════════

/**
 * Keep what a health answer says about this install for the moment the server
 * is down and cannot be asked: where it lives, how it was installed, and
 * whether the Start Server launcher is registered.
 */
export function rememberHealth(health) {
  if (!health) return;
  try {
    if (health.projectDir) {
      localStorage.setItem('synabun-project-dir', health.projectDir);
    }
    if (health.install) localStorage.setItem(START_STORAGE.install, health.install);
    if (health.startLauncher) localStorage.setItem(START_STORAGE.launcher, health.startLauncher);
  } catch {}
  if (health.projectDir) updateCmdText(health.projectDir);
}

/**
 * Run the health check pre-flight. If the database is unhealthy,
 * show the appropriate loading error. Returns true if healthy (or
 * the health endpoint itself failed, in which case we proceed).
 * Returns false if the database is known-unhealthy.
 */
export async function checkHealth() {
  try {
    const health = await fetchHealth();
    rememberHealth(health);
    if (!health.ok) {
      const messages = {
        db_missing:         [t('loading.health.databaseUnreachable.title'), health.detail || t('loading.health.databaseUnreachable.sub')],
        db_error:           [t('loading.health.databaseUnreachable.title'), health.detail || t('loading.health.databaseUnreachable.sub')],
        remote_unreachable: [t('loading.health.remoteUnreachable.title'), health.detail || t('loading.health.remoteUnreachable.sub')],
        auth_error:         [t('loading.health.authError.title'), health.detail || t('loading.health.authError.sub')],
      };
      const [title, sub] = messages[health.reason] || [t('loading.health.connectionError.title'), health.detail || t('loading.health.connectionError.sub')];
      showLoadingError(title, sub, !!health.canAutoStart);
      return false;
    }
    return true;
  } catch {
    // /api/health itself failed — try to restore cached path for offline display
    const cached = localStorage.getItem('synabun-project-dir');
    if (cached) updateCmdText(cached);
    return true;
  }
}

/**
 * Update the command text element with the restart command.
 */
function updateCmdText(projectDir) {
  const cmdEl = $('loading-cmd-text');
  if (!cmdEl) return;
  const commands = manualStartCommands({
    projectDir,
    install: stored(START_STORAGE.install),
    windows: isWindowsPlatform(navigator),
  });
  // One box: the command for this install (the checkout's when it is not known).
  cmdEl.textContent = commands[commands.length - 1].command;
}

// ═══════════════════════════════════════════
// INTERNAL — Server offline: Start Server + reconnect
// ═══════════════════════════════════════════

function stopWatchingForServer() {
  if (_offlineBridge) _offlineBridge.stop();
  _offlineBridge = null;
  poseMascot('asleep');
}

/** The lines a start writes under the button, emptied. */
function clearStartStatus() {
  for (const id of ['loading-action-status', 'loading-action-elapsed', 'loading-action-hint', 'loading-action-log']) {
    const el = $(id);
    if (el) el.textContent = '';
  }
  const $trail = $('loading-action-trail');
  if ($trail) $trail.replaceChildren();
}

/**
 * The overlay's mascot as the shared rig, so a start can be acted out. The
 * markup's own still drawing stays as the fallback when the rig cannot mount.
 */
function mountMascot() {
  if (_mascot) return;
  const host = $('loading-mascot');
  if (!host) return;
  try {
    const still = host.querySelector('svg');
    _mascot = createMascot(host, { width: 160, height: 80, pose: 'sleep', active: false });
    if (still && still !== _mascot.el) still.style.display = 'none';
  } catch {
    _mascot = null;
  }
}

/** 'asleep' is the still sleeping face (the overlay's own bob and z carry it); every other state plays its pose. */
function poseMascot(state) {
  const host = $('loading-mascot');
  if (host) host.setAttribute('data-state', state);
  if (!_mascot) return;
  try {
    _mascot.setPose(MASCOT_POSE[state] || 'sleep');
    _mascot.setActive(state !== 'asleep');
  } catch {}
}

/**
 * Draw one snapshot of the start: the sentence (a live region, written only
 * when it changes), the page's own clock, and the steps the launcher reported
 * with the time each one happened. Nothing here is estimated.
 */
function renderStart(snap) {
  const platform = isWindowsPlatform(navigator) ? 'windows' : isMacPlatform(navigator) ? 'mac' : 'linux';
  const view = startStatusView(snap, { platform });
  const say = (line) => (line ? t(`loading.start.${line.key}`, line.params) : '');

  poseMascot(view.mascot);

  const $text = $('loading-text');
  if ($text) {
    const title = view.mascot === 'waking' || view.mascot === 'working' ? t('loading.start.headingStarting')
      : view.mascot === 'ready' ? t('loading.start.headingReady')
        : view.mascot === 'failed' ? t('loading.start.headingFailed')
          : _offlineTitle || t('loading.serverOffline');
    if ($text.textContent !== title) $text.textContent = title;
  }

  const btn = $('loading-action-btn');
  const $label = $('loading-action-label');
  if (btn) btn.disabled = view.busy || view.state === 'online';
  if ($label) {
    $label.textContent = view.button === 'starting' ? t('loading.starting')
      : view.button === 'retry' ? t('common.retry') : t('loading.startServer');
  }

  const $status = $('loading-action-status');
  const line = say(view.headline);
  if ($status && $status.textContent !== line) $status.textContent = line;

  const $elapsed = $('loading-action-elapsed');
  if ($elapsed) {
    $elapsed.textContent = view.elapsed;
    $elapsed.setAttribute('aria-label', view.elapsed ? `${t('loading.start.elapsedLabel')}: ${view.elapsed}` : '');
  }

  const $hint = $('loading-action-hint');
  if ($hint) $hint.textContent = say(view.hint);

  const $trail = $('loading-action-trail');
  if ($trail) {
    $trail.replaceChildren(...view.trail.map((row) => {
      const item = document.createElement('li');
      const what = document.createElement('span');
      what.textContent = t(`loading.start.${row.key}`);
      const when = document.createElement('span');
      when.className = 'at';
      when.textContent = row.time;
      item.append(what, when);
      return item;
    }));
  }

  const $log = $('loading-action-log');
  if ($log) $log.textContent = view.error?.log ? t('loading.start.failedLog', { path: view.error.log }) : '';
}

/**
 * While the overlay says the server is offline: keep asking for it, and let
 * the Start button hand the OS a synabun://start link. Reconnects by itself
 * the moment the server answers, however it was started. While a start is
 * under way it shows what the launcher itself reports (its beacon), never a
 * guess: see start-bridge.js.
 */
function watchForServer() {
  if (_offlineBridge) return;
  mountMascot();
  const beaconAt = startBeaconTarget(window.location);
  const bridge = createStartBridge({
    probe: async () => {
      const health = await fetchHealth();
      return !!health && health.ok !== false;
    },
    launch: () => openStartLink({ document, location: window.location, userAgent: navigator.userAgent }),
    beacon: beaconAt ? () => fetchStartBeacon(beaconAt) : null,
    port: beaconAt ? beaconAt.port : 0,
    onUpdate(snap) {
      if (_offlineBridge !== bridge) return;
      renderStart(snap);
    },
    onState(state) {
      if (_offlineBridge !== bridge) return;
      if (state !== 'online') return;
      resetLoadingToConnecting();
      emit('loading:retried');
      if (_initCallback) _initCallback();
    },
  });
  _offlineBridge = bridge;
  bridge.watch();
}

// ═══════════════════════════════════════════
// INTERNAL — Action handlers
// ═══════════════════════════════════════════

/**
 * Handle the "Start Server" / retry action button click.
 * Calls /api/health/start and re-triggers init on success.
 */
async function handleStartAction() {
  // Server offline: nothing to call, the OS starts it.
  if (_offlineBridge) { _offlineBridge.start(); return; }

  const btn = $('loading-action-btn');
  const $status = $('loading-action-status');
  const $label = $('loading-action-label');

  if (btn) btn.disabled = true;
  if ($label) $label.textContent = t('loading.starting');
  if ($status) $status.textContent = t('loading.takeMoment');

  try {
    const data = await startHealth();
    if (data.ok && data.ready) {
      // Success — reset overlay and re-init
      resetLoadingToConnecting();
      emit('loading:started');
      if (_initCallback) _initCallback();
    } else {
      if ($status) $status.textContent = data.error || t('loading.couldNotStart');
      if (btn) btn.disabled = false;
      if ($label) $label.textContent = t('common.retry');
    }
  } catch (err) {
    if ($status) $status.textContent = t('loading.somethingWrong');
    if (btn) btn.disabled = false;
    if ($label) $label.textContent = t('common.retry');
  }
}

/**
 * Handle the "Copy command to clipboard" button in the server-offline panel.
 */
function handleCopyCommand() {
  const cmdEl = $('loading-cmd-text');
  const btn = $('loading-cmd-copy');
  if (!cmdEl || !btn) return;

  const cmd = cmdEl.textContent;
  navigator.clipboard.writeText(cmd).then(() => {
    btn.innerHTML = '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.style.color = 'rgba(100,255,100,0.7)';
    setTimeout(() => {
      btn.innerHTML = '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      btn.style.color = '';
    }, 1500);
  });
}

/**
 * Handle the "Retry Connection" button in the server-offline panel.
 * Pings /api/health and re-triggers init on success.
 */
async function handleRetryConnection() {
  const $status = $('loading-retry-status');
  if ($status) $status.textContent = t('loading.checking');

  try {
    const health = await fetchHealth();
    // fetchHealth uses AbortSignal.timeout(3000) internally
    if (health && health.ok !== false) {
      if ($status) $status.textContent = t('loading.connectedLoading');
      resetLoadingToConnecting();
      emit('loading:retried');
      if (_initCallback) _initCallback();
    } else {
      if ($status) $status.textContent = t('loading.notReadyYet');
      setTimeout(() => { if ($status) $status.textContent = ''; }, 3000);
    }
  } catch {
    if ($status) $status.textContent = t('loading.stillOffline');
    setTimeout(() => { if ($status) $status.textContent = ''; }, 3000);
  }
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the loading overlay. Wires up all event listeners for:
 * - Start Server button
 * - Copy command button
 * - Retry connection button
 *
 * @param {Object}   options
 * @param {Function} options.onInit   Callback to invoke when the user triggers
 *                                    a retry/start and it succeeds. This should
 *                                    be the variant's init() function.
 */
export function initLoading({ onInit } = {}) {
  _initCallback = onInit || null;
  _statusDot = $('status-dot');

  // ── Populate command with cached path ──
  const cached = localStorage.getItem('synabun-project-dir');
  if (cached) updateCmdText(cached);

  // ── Start Server / retry action button ──
  const actionBtn = $('loading-action-btn');
  if (actionBtn) actionBtn.addEventListener('click', handleStartAction);

  // ── Copy command to clipboard ──
  const copyBtn = $('loading-cmd-copy');
  if (copyBtn) copyBtn.addEventListener('click', handleCopyCommand);

  // ── Retry connection ──
  const retryBtn = $('loading-retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', handleRetryConnection);
}

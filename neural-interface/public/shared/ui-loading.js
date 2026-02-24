// ═══════════════════════════════════════════
// SynaBun Neural Interface — Loading Overlay
// Health check, Docker start, server-offline retry, command copy
// ═══════════════════════════════════════════

import { fetchHealth, startHealth } from './api.js';
import { emit } from './state.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

// ── Internal refs (resolved once on init) ──
let _statusDot = null;
let _initCallback = null;

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

  const $action = $('loading-action');
  if (canStart) {
    if ($action) $action.style.display = 'block';
    const $label = $('loading-action-label');
    if ($label) $label.textContent = t('common.start');
  } else {
    if ($action) $action.style.display = 'none';
  }

  const $status = $('loading-action-status');
  if ($status) $status.textContent = '';
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

  const $text = $('loading-text');
  const $sub = $('loading-sub');
  const $action = $('loading-action');
  const $actionStatus = $('loading-action-status');

  if ($text) $text.textContent = t('loading.connecting');
  if ($sub) $sub.textContent = t('loading.initializingNeural');
  if ($action) $action.style.display = 'none';
  if ($actionStatus) $actionStatus.textContent = '';
  if (_statusDot) _statusDot.classList.remove('error');
}

// ═══════════════════════════════════════════
// HEALTH CHECK (called during init)
// ═══════════════════════════════════════════

/**
 * Run the health check pre-flight. If the database is unhealthy,
 * show the appropriate loading error. Returns true if healthy (or
 * the health endpoint itself failed, in which case we proceed).
 * Returns false if the database is known-unhealthy.
 */
export async function checkHealth() {
  try {
    const health = await fetchHealth();
    if (!health.ok) {
      const messages = {
        docker_not_running: [t('loading.health.dockerNotRunning.title'), t('loading.health.dockerNotRunning.sub')],
        container_stopped:  [t('loading.health.containerStopped.title'), t('loading.health.containerStopped.sub')],
        qdrant_unreachable: [t('loading.health.qdrantUnreachable.title'), t('loading.health.qdrantUnreachable.sub')],
        remote_unreachable: [t('loading.health.remoteUnreachable.title'), health.detail || t('loading.health.remoteUnreachable.sub')],
        auth_error:         [t('loading.health.authError.title'), health.detail || t('loading.health.authError.sub')],
      };
      const [title, sub] = messages[health.reason] || [t('loading.health.connectionError.title'), health.detail || t('loading.health.connectionError.sub')];
      showLoadingError(title, sub, !!health.canAutoStart);
      return false;
    }
    return true;
  } catch {
    // /api/health itself failed — proceed and let the caller try loading data directly
    return true;
  }
}

// ═══════════════════════════════════════════
// INTERNAL — Action handlers
// ═══════════════════════════════════════════

/**
 * Handle the "Start Docker" / retry action button click.
 * Calls /api/health/start and re-triggers init on success.
 */
async function handleStartAction() {
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
 * - Start Docker button
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

  // ── Start Docker / retry action button ──
  const actionBtn = $('loading-action-btn');
  if (actionBtn) actionBtn.addEventListener('click', handleStartAction);

  // ── Copy command to clipboard ──
  const copyBtn = $('loading-cmd-copy');
  if (copyBtn) copyBtn.addEventListener('click', handleCopyCommand);

  // ── Retry connection ──
  const retryBtn = $('loading-retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', handleRetryConnection);
}

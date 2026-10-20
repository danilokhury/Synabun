// ═══════════════════════════════════════════
// SynaBun Neural Interface — Update Alert
// Checks for npm updates on page load, shows toolbar badge,
// and provides a 3-step modal wizard with blocking backup gate.
//
// Inside the SynaBun desktop app the updater is the app's own: it downloads and
// installs by itself, and the same badge, drawer item and dialog, plus a notice
// (the countdown before the restart, "updated", a failed install), show what it
// reports through window.synabunDesktop (desktop-bridge.js,
// desktop-update-view.js). The npm/GitHub check above is never asked.
// ═══════════════════════════════════════════

import { showUpdateToast } from './ui-tool-updates.js';
import { emit } from './state.js';
import { getLocale, t } from './i18n.js';
import { desktopBridge } from './desktop-bridge.js';
import {
  desktopCheckOutcome, desktopUpdateMeta, desktopUpdateNotice, desktopUpdateTooltip, desktopUpdateView, fillDesktopCopy, readDesktopUpdateState,
  versionDataFromDesktop,
} from './desktop-update-view.js';

const $ = (id) => document.getElementById(id);
const SYNABUN_GITHUB_URL = 'https://github.com/danilokhury/Synabun';

let _versionData = null;
let _btnWired = false;
let _pollWired = false;
// Inside the desktop app: the updater's last report as it came, and the update
// dialog while it is open ({ overlay, update, close }).
let _desktopState = null;
let _desktopDialog = null;

/** Where an update comes from, as the badge, the toast and the menu name it. */
export function synabunUpdateSourceLabel(data) {
  const src = data?.source;
  if (data?.desktop || src === 'app') return desktopT('update.source');
  if (src === 'both') return 'npm + GitHub';
  if (src === 'github') return 'GitHub';
  if (src === 'npm') return 'npm';
  return src || 'update';
}

function applyTopRightButton(data) {
  const btn = $('topright-update-btn');
  const badge = $('update-badge');
  if (!btn) return;
  const has = !!data?.updateAvailable;
  btn.style.display = has ? '' : 'none';
  if (badge) {
    badge.classList.add('update-click-target');
    badge.textContent = has ? '!' : '';
    if (has) badge.setAttribute('aria-label', 'Update SynaBun');
    else badge.removeAttribute('aria-label');
  }
  if (has) {
    const srcLabel = synabunUpdateSourceLabel(data);
    btn.dataset.tooltip = data.desktop
      ? desktopUpdateTooltip(_desktopState, { t: desktopT })
      : `SynaBun update available: v${data.current} → v${data.latest} (${srcLabel})`;
  }
  if (!_btnWired) {
    _btnWired = true;
    // Whole button opens the update flow — it's a dedicated SynaBun-update
    // button (display:none when no update available), so any click on it
    // should prompt the wizard, not just the green badge.
    btn.addEventListener('click', (e) => {
      if (!_versionData?.updateAvailable) return;
      e.stopPropagation();
      e.preventDefault();
      openUpdateModal();
    });
  }
}

function maybeShowUpdateAlert(data, { once = true } = {}) {
  if (!data?.updateAvailable) return;
  const key = `synabun-update-alert:${data.current}->${data.latest}:${synabunUpdateSourceLabel(data)}`;
  try {
    if (once && sessionStorage.getItem(key) === '1') return;
    sessionStorage.setItem(key, '1');
  } catch {}

  setTimeout(() => {
    showUpdateToast({
      updates: [{ label: `SynaBun v${data.current} → v${data.latest}`, source: synabunUpdateSourceLabel(data) }],
      errors: [],
      onClick: () => openSynabunUpdateModal(),
    });
  }, 500);
}

export async function initUpdate() {
  const desktop = desktopBridge();
  if (desktop) return initDesktopUpdate(desktop);
  try {
    const res = await fetch('/api/system/version');
    if (!res.ok) return;
    _versionData = await res.json();
    applyTopRightButton(_versionData);
    maybeShowUpdateAlert(_versionData);

    if (!_pollWired) {
      _pollWired = true;
      setInterval(() => {
        forceCheckSynabunUpdate({ alert: true }).catch(() => {});
      }, 30 * 60 * 1000);
    }
  } catch { /* silent — no update UI if check fails */ }
}

// Force a fresh server-side check (bypasses 1h cache via ?force=1) and
// re-applies the top-right button + badge state. Returns the latest
// _synabunUpdateCache shape so callers can compose toasts.
export async function forceCheckSynabunUpdate({ alert = false } = {}) {
  // Inside the desktop app the app checks its own release feed; an error is
  // null here, as a failed request is, so callers list it under the errors.
  const desktop = desktopBridge();
  if (desktop) {
    try {
      const data = applyDesktopState(await desktop.updates.check(), { alert });
      return data.status === 'error' ? null : data;
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch('/api/system/version?force=1');
    if (!res.ok) return null;
    _versionData = await res.json();
    applyTopRightButton(_versionData);
    if (alert) maybeShowUpdateAlert(_versionData);
    return _versionData;
  } catch {
    return null;
  }
}

/**
 * The update state for a surface that refreshes often (Notifications): the
 * desktop app's last report, which costs no check, or a fresh check of the
 * server for an npm or Git install, as before.
 */
export async function syncSynabunUpdateData() {
  const desktop = desktopBridge();
  if (!desktop) return forceCheckSynabunUpdate();
  try {
    return applyDesktopState(await desktop.updates.state(), { alert: false });
  } catch {
    return null;
  }
}

export function openSynabunUpdateModal() {
  if (!_versionData?.updateAvailable) return;
  openUpdateModal();
}

// Read-only accessor for the Notifications drawer to mirror SynaBun core
// update state without re-fetching. May be null until initUpdate() resolves.
export function getSynabunUpdateData() {
  return _versionData;
}

/** The line under the SynaBun item of Notifications > Updates. */
export function synabunUpdateMeta(data) {
  if (data?.desktop) return desktopUpdateMeta(_desktopState, { t: desktopT });
  return data?.source ? `Source: ${data.source}` : '';
}

// ── Desktop app ──
//
// window.synabunDesktop.updates is the app's updater (packaging/desktop). It
// checks about 30 s after the app opens and every 6 h, downloads what it finds,
// and installs it by itself once SynaBun is idle, after a one-minute countdown
// (the notice below, with Later); it reports each change here, and the menu bar
// and the tray of the app say so through onOpen. The page shows what it reports
// and passes on Install now and Later, never more.

/** A `desktop.*` string in the page's language; DESKTOP_COPY when the dictionary lacks it. */
function desktopT(key, params) {
  const full = `desktop.${key}`;
  const value = t(full, params);
  return value === full ? fillDesktopCopy(key, params) : value;
}

/** A time of day (an ISO time), written the way the page's language writes it. */
function desktopTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

/** A number with `digits` decimals, written the way the page's language writes it. */
function desktopNumber(value, digits) {
  try {
    return value.toLocaleString(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  } catch {
    return value.toFixed(digits);
  }
}

/** Take one report of the app's updater: the badge, the drawer, an open dialog and the notice follow it. */
function applyDesktopState(state, { alert = true } = {}) {
  _desktopState = state && typeof state === 'object' ? state : null;
  _versionData = versionDataFromDesktop(_desktopState);
  applyTopRightButton(_versionData);
  // An offer that waits for the user (macOS: a copy to move to Applications, or one in a folder SynaBun
  // cannot write): one toast per version and session. Every other update downloads and installs by
  // itself, and the notice speaks when there is something to say.
  if (alert && _versionData.updateAvailable && _versionData.status === 'available' && _versionData.install !== 'restart') maybeShowUpdateAlert(_versionData);
  emit('synabun-update:changed', _versionData);
  _desktopDialog?.update(_desktopState);
  renderDesktopNotice();
  return _versionData;
}

// ── The notice (bottom right): the countdown before the restart, "updated", a failed install ──

let _notice = null; // { el, key, kind, timer, hold }

const NOTICE_ICONS = { up: '↑', ok: '✓', err: '!' };

function hideDesktopNotice() {
  const current = _notice;
  if (!current) return;
  _notice = null;
  clearInterval(current.timer);
  clearTimeout(current.timer);
  current.el.classList.remove('show');
  setTimeout(() => current.el.remove(), 250);
}

/** What the notice says now: drawn from the last report, again every second while it counts down. */
function renderDesktopNotice() {
  const notice = desktopBridge() ? desktopUpdateNotice(_desktopState, { t: desktopT }) : null;
  if (!notice) {
    // A notice that says something of its own for a while (Later's answer, "updated") stays until it is done.
    if (_notice && !_notice.hold) hideDesktopNotice();
    return;
  }
  if (_notice && _notice.key === notice.key) {
    const line = _notice.el.querySelector('#desktop-update-notice-line');
    if (line && line.textContent !== notice.line) line.textContent = notice.line;
    return;
  }
  if (notice.kind === 'failed') {
    // A failed update is said once per session; the badge and the dialog keep it.
    const mark = `synabun-update-notice:${notice.key}`;
    try {
      if (sessionStorage.getItem(mark) === '1') { if (_notice && !_notice.hold) hideDesktopNotice(); return; }
      sessionStorage.setItem(mark, '1');
    } catch {}
  }
  showDesktopNotice(notice);
}

function showDesktopNotice(notice) {
  hideDesktopNotice();
  document.querySelectorAll('.update-notice').forEach(el => el.remove());
  const el = document.createElement('div');
  el.className = 'update-check-toast update-notice';
  el.id = 'desktop-update-notice';
  el.dataset.kind = notice.kind;
  el.setAttribute('role', 'status');
  const link = notice.link ? `<a class="update-notice-link" id="desktop-update-notice-link" href="${esc(notice.link.href)}" target="_blank" rel="noopener noreferrer">${esc(notice.link.label)}</a>` : '';
  const buttons = notice.actions.map(item => `<button class="action-btn action-btn--ghost update-notice-btn" type="button" data-notice-action="${esc(item.id)}" id="desktop-update-notice-${esc(item.id)}">${esc(item.label)}</button>`).join('');
  el.innerHTML = `
      <div class="utc-icon utc-icon--${notice.tone}" aria-hidden="true">${NOTICE_ICONS[notice.tone] || '↑'}</div>
      <div class="utc-body">
        <div class="utc-title" id="desktop-update-notice-title">${esc(notice.title)}</div>
        <div class="utc-sub" id="desktop-update-notice-line"${notice.ticking ? ' aria-live="off"' : ''}>${esc(notice.line)}</div>
        <div class="update-notice-actions">${link}${buttons}</div>
      </div>`;
  el.querySelectorAll('[data-notice-action]').forEach((btn) => {
    btn.addEventListener('click', (event) => { event.stopPropagation(); noticeAction(btn.dataset.noticeAction); });
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const current = { el, key: notice.key, kind: notice.kind, timer: null, hold: false };
  _notice = current;
  if (notice.ticking) {
    current.timer = setInterval(() => { if (_notice === current) renderDesktopNotice(); }, 1000);
  } else if (notice.kind === 'updated') {
    // Said once: the app forgets it now, and the notice stays a little while on its own.
    current.hold = true;
    current.timer = setTimeout(() => { if (_notice === current) hideDesktopNotice(); }, 12000);
    try { desktopBridge()?.updates.acknowledge?.()?.catch?.(() => {}); } catch {}
  } else {
    current.timer = setTimeout(() => { if (_notice === current) hideDesktopNotice(); }, 15000);
  }
}

async function noticeAction(id) {
  const desktop = desktopBridge();
  const current = _notice;
  if (!desktop || !current) return;
  if (id === 'dismiss') { hideDesktopNotice(); return; }
  if (id === 'details') { hideDesktopNotice(); openDesktopUpdateModal(); return; }
  if (id !== 'later') return;
  // Later: Later's answer takes the notice's place for a moment.
  clearInterval(current.timer);
  current.hold = true;
  current.el.querySelectorAll('[data-notice-action]').forEach(btn => { btn.disabled = true; });
  let answer = null;
  try { answer = await desktop.updates.later(); } catch {}
  if (_notice !== current) return;
  const line = current.el.querySelector('#desktop-update-notice-line');
  if (line) line.textContent = desktopT('notice.postponed');
  current.el.querySelector('.update-notice-actions')?.remove();
  current.timer = setTimeout(() => { if (_notice === current) hideDesktopNotice(); }, 5000);
  if (answer) applyDesktopState(answer, { alert: false });
}

async function initDesktopUpdate(desktop) {
  if (!_pollWired) {
    _pollWired = true;
    // No polling of our own: the app checks on its schedule and says what changed.
    try { desktop.updates.onChange((state) => applyDesktopState(state)); } catch {}
    try { desktop.updates.onOpen?.((state) => handleDesktopMenuCheck(state)); } catch {}
  }
  try {
    applyDesktopState(await desktop.updates.state());
  } catch { /* silent — no update UI if the app does not answer */ }
}

/** Check for Updates… in the app's own menu or tray finished: the dialog for an offer, a short toast otherwise. */
function handleDesktopMenuCheck(state) {
  applyDesktopState(state, { alert: false });
  const outcome = desktopCheckOutcome(state);
  if (outcome === 'offer') openUpdateModal();
  else if (outcome === 'error') showUpdateToast({ updates: [], errors: [readDesktopUpdateState(state).error || desktopT('update.errorFallback')] });
  else if (outcome === 'up-to-date') showUpdateToast({ updates: [], errors: [] });
}

function prefersLessMotion() {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; }
  catch { return false; }
}

const DESKTOP_ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
const DESKTOP_BACKUP_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

/** One page of the desktop dialog, from desktopUpdateView(). Everything the app or the feed said goes in as text. */
function renderDesktopStep(view) {
  const pill = view.testFeed ? ` <span class="update-channel-pill">${esc(desktopT('update.testFeed'))}</span>` : '';
  const working = view.step === 'installing' ? '<span class="update-spinner"></span>' : '';
  const diff = view.latest ? `
      <div class="update-version-diff">
        <span class="update-ver update-ver--old">v${esc(view.current)}</span>
        ${DESKTOP_ARROW}
        <span class="update-ver update-ver--new">v${esc(view.latest)}</span>
      </div>` : '';
  const body = view.body.map(line => `<p class="update-desktop-line" style="font-size:12px;color:var(--t-muted);margin:12px 0 6px">${esc(line)}</p>`).join('');
  const notes = view.notes !== null ? `
      <div class="update-notes-label">${esc(view.notesLabel)}</div>
      <div class="update-notes" id="desktop-update-notes" tabindex="0">${esc(view.notes)}</div>` : '';
  const unknown = view.progress?.percent === null;
  const progress = view.progress ? `
      <div class="update-progress" id="desktop-update-progress" role="progressbar" aria-label="${esc(view.title)}" aria-valuemin="0" aria-valuemax="100"${unknown ? '' : ` aria-valuenow="${view.progress.percent}"`}>
        <div class="update-progress-bar${unknown ? ' update-progress-bar--unknown' : ''}" id="desktop-update-progress-bar" style="width:${unknown ? 100 : view.progress.percent}%"></div>
      </div>
      <div class="update-progress-text" id="desktop-update-progress-text">${esc(view.progress.text)}</div>` : '';
  const file = view.file ? `<p class="update-desktop-file" id="desktop-update-file" style="font-size:11px;color:var(--t-muted);opacity:.75;margin:0 0 6px;overflow-wrap:anywhere">${esc(view.file)}</p>` : '';
  const link = view.link ? `<p class="update-desktop-link" style="margin:2px 0 6px"><a class="update-notice-link" id="desktop-update-link" href="${esc(view.link.href)}" target="_blank" rel="noopener noreferrer">${esc(view.link.label)}</a></p>` : '';
  const backup = view.backup ? `
      <button class="action-btn action-btn--ghost" type="button" data-desktop-action="${view.backup.id}" id="desktop-update-backup" style="width:100%;margin:10px 0 0">${DESKTOP_BACKUP_ICON}${esc(view.backup.label)}</button>
      <div class="update-backup-status" id="desktop-update-backup-status" style="display:none">
        <span class="update-backup-icon" id="desktop-update-backup-icon"></span>
        <span id="desktop-update-backup-text"></span>
      </div>` : '';
  const actions = view.actions.length ? `
      <div class="tag-delete-modal-actions" style="margin-top:14px">
        ${view.actions.map(item => `<button class="action-btn action-btn--${item.kind}" type="button" data-desktop-action="${item.id}" id="desktop-update-${item.id}">${esc(item.label)}</button>`).join('')}
      </div>` : '';
  return `
      <h3 class="update-modal-title" id="desktop-update-title">${working}${esc(view.title)}${pill}</h3>
      ${diff}
      ${body}
      ${notes}
      ${progress}
      ${file}
      ${link}
      ${backup}
      ${actions}`;
}

/**
 * The update dialog inside the desktop app: the same shell and liquid step
 * transition as the npm wizard below, one page per desktopUpdateView() step,
 * kept current by every report while it is open. A progress report moves the
 * bar in place; a new step slides in.
 */
function openDesktopUpdateModal() {
  const desktop = desktopBridge();
  if (!desktop) return;
  // One dialog: a second request (the badge, the menu, the tray) leaves the open one as it is.
  if (_desktopDialog) return;
  const viewOf = (state) => desktopUpdateView(state, { t: desktopT, number: desktopNumber, time: desktopTime });
  const first = viewOf(_desktopState);
  if (first.step === 'none') return;

  let view = null;
  let isAnimating = false;
  let pending = null;
  let working = false;
  // A page whose sentence counts down (the restart's seconds) is drawn again every second.
  let tick = null;

  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';
  overlay.id = 'desktop-update-overlay';
  overlay.style.zIndex = '300100';

  const modal = document.createElement('div');
  modal.className = 'tag-delete-modal update-modal update-modal--desktop';
  modal.id = 'desktop-update-modal';
  modal.style.maxWidth = '460px';
  modal.style.textAlign = 'left';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'desktop-update-title');

  const dotsRow = document.createElement('div');
  dotsRow.className = 'update-steps';
  dotsRow.innerHTML = [1, 2, 3].map(() => `<span class="update-step-dot"></span>`).join('');

  const stepWrap = document.createElement('div');
  stepWrap.className = 'update-step-content';

  modal.appendChild(dotsRow);
  modal.appendChild(stepWrap);
  overlay.appendChild(modal);

  // The page that stays: during a transition the one leaving is still there for a moment.
  const liveStep = () => [...stepWrap.children].find(el => el.classList.contains('update-step') && !el.classList.contains('is-leaving')) || stepWrap;

  function syncDots(dot) {
    dotsRow.style.visibility = dot ? '' : 'hidden';
    dotsRow.querySelectorAll('.update-step-dot').forEach((el, i) => {
      el.classList.toggle('active', i + 1 === dot);
      el.classList.toggle('done', i + 1 < dot);
    });
  }

  function buildStepNode(next) {
    const node = document.createElement('div');
    node.className = 'update-step';
    node.dataset.step = next.step;
    node.innerHTML = renderDesktopStep(next);
    return node;
  }

  function bindStepEvents(scope) {
    scope.querySelectorAll('[data-desktop-action]').forEach((btn) => {
      btn.addEventListener('click', () => act(btn.dataset.desktopAction));
    });
    // The step's own answer takes the focus, so Enter does what the dialog offers.
    const primary = scope.querySelector('.action-btn--primary');
    if (primary) { try { primary.focus({ preventScroll: true }); } catch {} }
  }

  // What changes inside one step: the bar and its words, a sentence, the file line.
  function patchStep(next) {
    const scope = liveStep();
    if (next.progress) {
      const meter = scope.querySelector('#desktop-update-progress');
      const bar = scope.querySelector('#desktop-update-progress-bar');
      const words = scope.querySelector('#desktop-update-progress-text');
      const unknown = next.progress.percent === null;
      if (bar) {
        bar.style.width = `${unknown ? 100 : next.progress.percent}%`;
        bar.classList.toggle('update-progress-bar--unknown', unknown);
      }
      if (meter) {
        if (unknown) meter.removeAttribute('aria-valuenow');
        else meter.setAttribute('aria-valuenow', String(next.progress.percent));
      }
      if (words && words.textContent !== next.progress.text) words.textContent = next.progress.text;
    }
    const lines = scope.querySelectorAll('.update-desktop-line');
    next.body.forEach((line, i) => { if (lines[i] && lines[i].textContent !== line) lines[i].textContent = line; });
    const file = scope.querySelector('#desktop-update-file');
    if (file && next.file && file.textContent !== next.file) file.textContent = next.file;
  }

  // The same liquid transition as setStep() in the npm wizard below.
  function setStep(next) {
    if (isAnimating) { pending = next; return; }
    view = next;
    syncDots(next.dot);

    const outgoing = stepWrap.firstElementChild;
    const incoming = buildStepNode(next);

    if (!outgoing) {
      stepWrap.appendChild(incoming);
      bindStepEvents(incoming);
      return;
    }

    if (prefersLessMotion()) {
      stepWrap.replaceChild(incoming, outgoing);
      bindStepEvents(incoming);
      return;
    }

    isAnimating = true;
    const oldH = outgoing.offsetHeight;
    const pinW = modal.offsetWidth;
    stepWrap.style.height = oldH + 'px';
    modal.style.width = pinW + 'px';

    incoming.style.position = 'absolute';
    incoming.style.left = '0';
    incoming.style.right = '0';
    incoming.style.top = '0';
    incoming.style.visibility = 'hidden';
    stepWrap.appendChild(incoming);
    bindStepEvents(incoming);
    const newH = incoming.offsetHeight;

    outgoing.style.position = 'absolute';
    outgoing.style.left = '0';
    outgoing.style.right = '0';
    outgoing.style.top = '0';
    outgoing.classList.add('is-leaving');

    incoming.style.visibility = '';
    incoming.classList.add('is-entering');

    requestAnimationFrame(() => {
      stepWrap.style.height = newH + 'px';
    });

    let settled = false;
    const finalize = () => {
      if (settled) return;
      settled = true;
      incoming.removeEventListener('animationend', onIncomingEnd);
      if (outgoing.parentNode === stepWrap) stepWrap.removeChild(outgoing);
      incoming.classList.remove('is-entering');
      incoming.style.position = '';
      incoming.style.left = '';
      incoming.style.right = '';
      incoming.style.top = '';
      incoming.style.visibility = '';
      stepWrap.style.height = '';
      modal.style.width = '';
      isAnimating = false;
      // A report that came while the step slid in: a new step slides in next, the same one is patched.
      const later = pending;
      pending = null;
      if (later && later.step !== view.step) setStep(later);
      else if (later) { view = later; patchStep(later); }
    };
    const onIncomingEnd = (ev) => {
      if (ev.target === incoming && ev.animationName === 'synabunStepIn') finalize();
    };
    incoming.addEventListener('animationend', onIncomingEnd);
    setTimeout(finalize, 480);
  }

  const shapeOf = (page) => `${page.step}|${page.dot}|${page.body.length}|${page.actions.map(item => item.id).join(',')}|${page.link ? 1 : 0}`;

  function update(state) {
    // A check this dialog asked for (Try again): its page stays until the answer.
    if (readDesktopUpdateState(state).status === 'checking') return;
    const next = viewOf(state);
    if (next.step === 'none') { close(); return; }
    keepTicking(next.ticking);
    if (isAnimating) { pending = next; return; }
    // The two pages of the manual install (before and after the download) are one step with two faces;
    // a ready update draws again when what it waits for, or its buttons, change.
    if (!view || shapeOf(next) !== shapeOf(view)) { setStep(next); return; }
    view = next;
    patchStep(next);
  }

  function keepTicking(on) {
    if (on && !tick) tick = setInterval(() => update(_desktopState), 1000);
    else if (!on && tick) { clearInterval(tick); tick = null; }
  }

  function setBusy(busy) {
    working = busy;
    liveStep().querySelectorAll('[data-desktop-action]').forEach((btn) => { btn.disabled = busy; });
  }

  async function act(id) {
    if (working) return;
    // Later on a ready update postpones its restart; everywhere else it only closes the dialog.
    if (id === 'later' && view?.step === 'downloaded') {
      close();
      try { const answer = await desktop.updates.later?.(); if (answer) applyDesktopState(answer, { alert: false }); } catch {}
      return;
    }
    if (id === 'later' || id === 'hide' || id === 'close') { close(); return; }
    if (id === 'backup') { downloadBackup(); return; }
    // Install now: at once when SynaBun is idle, otherwise as soon as it is (the app decides).
    const call = id === 'download' || id === 'manual-download' ? 'download'
      : id === 'install-now' || id === 'move' || id === 'show-file' ? 'install'
        : id === 'retry' ? (view?.retry === 'download' ? 'download' : 'check')
          : null;
    if (!call) return;
    setBusy(true);
    let answer = null;
    try {
      answer = await desktop.updates[call]();
    } catch (err) {
      // The app did not take the request: this dialog says so, the badge keeps the app's last report.
      setBusy(false);
      update({ ...(_desktopState || {}), status: 'error', error: String(err?.message || '') || null });
      return;
    }
    // The answer is a report like any other.
    if (answer) applyDesktopState(answer, { alert: false });
    if (call === 'check' && desktopCheckOutcome(answer) === 'up-to-date') {
      close();
      showUpdateToast({ updates: [], errors: [] });
      return;
    }
    if (_desktopDialog && _desktopDialog.overlay === overlay) setBusy(false);
  }

  async function downloadBackup() {
    const scope = liveStep();
    const btn = scope.querySelector('#desktop-update-backup');
    const status = scope.querySelector('#desktop-update-backup-status');
    const icon = scope.querySelector('#desktop-update-backup-icon');
    const text = scope.querySelector('#desktop-update-backup-text');
    if (!btn || !status || !icon || !text) return;

    btn.disabled = true;
    status.style.display = 'flex';
    icon.className = 'update-backup-icon spin';
    icon.textContent = '⟳';
    icon.style.color = '';
    text.textContent = desktopT('update.backupWorking');

    try {
      const res = await fetch('/api/system/backup');
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
        throw new Error(errMsg);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'synabun-backup.zip';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);

      icon.className = 'update-backup-icon';
      icon.textContent = '✓';
      icon.style.color = '#34c759';
      text.textContent = desktopT('update.backupDone', { file: filename, size: desktopNumber(blob.size / 1024 / 1024, 1) });
    } catch (err) {
      icon.className = 'update-backup-icon';
      icon.textContent = '✗';
      icon.style.color = 'var(--accent-red)';
      text.textContent = desktopT('update.backupFailed', { reason: err.message });
    } finally {
      btn.disabled = false;
    }
  }

  // While it installs there is nothing to dismiss: SynaBun is closing.
  const dismissable = () => view?.step !== 'installing';

  function onKey(event) {
    if (event.key !== 'Escape' || !dismissable()) return;
    event.stopPropagation();
    event.preventDefault();
    close();
  }

  function close() {
    if (!_desktopDialog || _desktopDialog.overlay !== overlay) return;
    _desktopDialog = null;
    keepTicking(false);
    window.removeEventListener('keydown', onKey, true);
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 150);
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && dismissable()) close();
  });
  window.addEventListener('keydown', onKey, true);
  _desktopDialog = { overlay, update, close };
  document.body.appendChild(overlay);
  setStep(first);
  keepTicking(first.ticking);
}

// ── Modal Wizard ──

function openUpdateModal() {
  if (!_versionData) return;
  if (_versionData.desktop) { openDesktopUpdateModal(); return; }

  let step = 1;
  let backupDone = false;
  let isAnimating = false;

  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';
  overlay.style.zIndex = '300100';

  const modal = document.createElement('div');
  modal.className = 'tag-delete-modal update-modal';
  modal.style.maxWidth = '460px';
  modal.style.textAlign = 'left';

  const dotsRow = document.createElement('div');
  dotsRow.className = 'update-steps';
  dotsRow.innerHTML = [1, 2, 3].map(() => `<span class="update-step-dot"></span>`).join('');

  const stepWrap = document.createElement('div');
  stepWrap.className = 'update-step-content';

  modal.appendChild(dotsRow);
  modal.appendChild(stepWrap);
  overlay.appendChild(modal);

  function buildStepNode(n) {
    const node = document.createElement('div');
    node.className = 'update-step';
    node.dataset.step = String(n);
    node.innerHTML = n === 1 ? renderStep1() : n === 2 ? renderStep2() : renderStep3();
    return node;
  }

  function syncStepDots() {
    const dots = dotsRow.querySelectorAll('.update-step-dot');
    dots.forEach((dot, i) => {
      const idx = i + 1;
      dot.classList.toggle('active', idx === step);
      dot.classList.toggle('done', idx < step);
    });
  }

  function prefersReducedMotion() {
    try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; }
    catch { return false; }
  }

  function setStep(n) {
    if (isAnimating) return;
    step = n;
    syncStepDots();

    const outgoing = stepWrap.firstElementChild;
    const incoming = buildStepNode(n);

    if (!outgoing) {
      stepWrap.appendChild(incoming);
      bindStepEvents(incoming);
      return;
    }

    if (prefersReducedMotion()) {
      stepWrap.replaceChild(incoming, outgoing);
      bindStepEvents(incoming);
      return;
    }

    isAnimating = true;

    // 1. Pin BOTH wrapper height AND modal width before any positioning
    //    changes. The modal is a flex item whose width derives from its
    //    in-flow content; when both step nodes go absolute, the only
    //    remaining in-flow child is the tiny .update-steps dots row,
    //    causing the modal to shrink horizontally to its min-width during
    //    the transition (visible as a horizontal snap).
    const oldH = outgoing.offsetHeight;
    const pinW = modal.offsetWidth;
    stepWrap.style.height = oldH + 'px';
    modal.style.width = pinW + 'px';

    // 2. Stage incoming absolutely positioned, hidden, to measure its
    //    natural height at the pinned modal width.
    incoming.style.position = 'absolute';
    incoming.style.left = '0';
    incoming.style.right = '0';
    incoming.style.top = '0';
    incoming.style.visibility = 'hidden';
    stepWrap.appendChild(incoming);
    bindStepEvents(incoming);
    const newH = incoming.offsetHeight;

    // 3. Position outgoing absolutely so the height tween isn't fought.
    outgoing.style.position = 'absolute';
    outgoing.style.left = '0';
    outgoing.style.right = '0';
    outgoing.style.top = '0';
    outgoing.classList.add('is-leaving');

    // 4. Reveal incoming and trigger its enter animation.
    incoming.style.visibility = '';
    incoming.classList.add('is-entering');

    // 5. Tween wrapper height. Next frame so the pinned values commit first.
    requestAnimationFrame(() => {
      stepWrap.style.height = newH + 'px';
    });

    let settled = false;
    const finalize = () => {
      if (settled) return;
      settled = true;
      incoming.removeEventListener('animationend', onIncomingEnd);
      if (outgoing.parentNode === stepWrap) stepWrap.removeChild(outgoing);
      incoming.classList.remove('is-entering');
      incoming.style.position = '';
      incoming.style.left = '';
      incoming.style.right = '';
      incoming.style.top = '';
      incoming.style.visibility = '';
      stepWrap.style.height = '';
      modal.style.width = '';
      isAnimating = false;
    };
    const onIncomingEnd = (ev) => {
      if (ev.target === incoming && ev.animationName === 'synabunStepIn') finalize();
    };
    incoming.addEventListener('animationend', onIncomingEnd);
    setTimeout(finalize, 480);
  }

  function renderStep1() {
    const src = _versionData.source;
    const channel = _versionData.installedChannel || 'stable';
    const channelTag = channel === 'prerelease'
      ? '<span class="update-channel-pill update-channel-pill--beta">beta</span>'
      : '';

    // The plan knows whether npm has the version shown: say what step 3 will do.
    const plan = _versionData.installPlan || {};
    const githubOnly = 'A new SynaBun release is tagged on GitHub. The npm publish may still be in progress.';
    const srcCopy = plan.reason === 'not-on-npm' || plan.reason === 'npm-unreachable'
      ? githubOnly
      : src === 'both'
        ? 'A new version of SynaBun is available on npm and GitHub.'
        : src === 'github' && plan.canAutoUpdate !== true
          ? githubOnly
          : 'A new version of SynaBun has been published to npm.';

    const npmStable = _versionData.npmLatestStable
      ? `npm latest v${esc(_versionData.npmLatestStable)}`
      : 'npm latest —';
    const npmBeta = _versionData.npmLatestBeta
      ? ` · npm beta v${esc(_versionData.npmLatestBeta)}`
      : '';
    const gitBit = _versionData.gitLatest
      ? ` · GitHub v${esc(_versionData.gitLatest)}`
      : ' · GitHub —';

    return `
      <h3 class="update-modal-title">Update Available ${channelTag}</h3>
      <div class="update-version-diff">
        <span class="update-ver update-ver--old">v${esc(_versionData.current)}</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        <span class="update-ver update-ver--new">v${esc(_versionData.latest)}</span>
      </div>
      <p style="font-size:12px;color:var(--t-muted);margin:12px 0 6px">${srcCopy}</p>
      <p style="font-size:11px;color:var(--t-muted);opacity:.75;margin:0 0 18px">${npmStable}${npmBeta}${gitBit}</p>
      <div class="tag-delete-modal-actions">
        <button class="action-btn action-btn--ghost" id="update-cancel">Cancel</button>
        <button class="action-btn action-btn--primary" id="update-next">Next</button>
      </div>`;
  }

  function renderStep2() {
    return `
      <h3 class="update-modal-title">Back Up Your Data</h3>
      <p style="font-size:12px;color:var(--t-muted);margin:4px 0 14px">
        Before updating, create a full system backup to protect your memories, settings, and configurations.
      </p>
      <button class="action-btn update-backup-btn" id="update-backup-download" style="width:100%;margin-bottom:10px">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Full Backup
      </button>
      <div class="update-backup-status" id="update-backup-status" style="display:none">
        <span class="update-backup-icon" id="update-backup-icon"></span>
        <span id="update-backup-text"></span>
      </div>
      <label class="update-skip-label" style="margin:8px 0 16px">
        <input type="checkbox" id="update-skip-backup" ${backupDone ? 'checked' : ''}>
        <span>I already have a backup</span>
      </label>
      <div class="tag-delete-modal-actions">
        <button class="action-btn action-btn--ghost" id="update-back">Back</button>
        <button class="action-btn action-btn--primary" id="update-next" ${backupDone ? '' : 'disabled'}>Next</button>
      </div>`;
  }

  function renderStep3() {
    const installPlan = _versionData.installPlan || {};
    const canAutoUpdate = installPlan.canAutoUpdate === true;
    const repoUrl = installPlan.openUrl || SYNABUN_GITHUB_URL;
    const installCmd = canAutoUpdate
      ? (installPlan.displayCommand || 'npm i -g synabun@latest')
      : repoUrl;
    // The server pins the command to the exact version shown in step 1. A
    // version that is on GitHub but not on npm yet is a manual update.
    const installIntro = canAutoUpdate
      ? 'SynaBun will close and run this command in a new terminal window:'
      : installPlan.reason === 'not-on-npm'
        ? 'This version is on GitHub but not on npm yet, so SynaBun cannot install it automatically. Open the release on GitHub, or check for updates again later:'
        : installPlan.reason === 'npm-unreachable'
          ? 'SynaBun could not reach npm to confirm this version is published there, so it cannot install it automatically. Check for updates again, or open the release on GitHub:'
          : 'This SynaBun install was not detected as an npm install. Open the GitHub repository to update from your checkout or installer:';
    const title = canAutoUpdate ? 'Run the Update' : 'Update from GitHub';
    const installSource = canAutoUpdate
      ? 'Installing from npm.'
      : (installPlan.manualHint || 'Open the SynaBun repository for the correct update path.');
    const autoRestartControl = canAutoUpdate ? `
      <p style="font-size:11px;color:var(--t-muted);opacity:.75;margin:10px 0 0">
        SynaBun will relaunch automatically after the update finishes.
      </p>` : '';
    const manualButton = canAutoUpdate ? `
        <button class="action-btn action-btn--ghost" id="update-manual" title="Run the command yourself in your own terminal">Manual</button>` : '';
    const updateNowButton = canAutoUpdate ? `
        <button class="action-btn action-btn--primary" id="update-run-now">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>
          Update Now
        </button>` : `
        <button class="action-btn action-btn--primary" id="update-run-now" data-url="${esc(repoUrl)}">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          Open GitHub
        </button>`;

    return `
      <h3 class="update-modal-title">${title}</h3>
      <p style="font-size:12px;color:var(--t-muted);margin:4px 0 12px">
        ${esc(installIntro)}
      </p>
      <div class="update-code-block">
        <code>${esc(installCmd)}</code>
        <button class="update-copy-btn" data-copy="${esc(installCmd)}" title="Copy">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
      <p style="font-size:11px;color:var(--t-muted);opacity:.75;margin:8px 0 0">${esc(installSource)}</p>
      ${autoRestartControl}

      <div class="update-run-status" id="update-run-status" style="display:none;margin:10px 0 0">
        <span class="update-backup-icon" id="update-run-icon"></span>
        <span id="update-run-text"></span>
      </div>

      <div class="tag-delete-modal-actions" style="margin-top:14px;flex-wrap:wrap;gap:8px">
        <button class="action-btn action-btn--ghost" id="update-back">Back</button>
        ${manualButton}
        ${updateNowButton}
      </div>

      <p id="update-manual-note" style="display:none;font-size:11px;color:var(--t-muted);opacity:.75;margin:10px 0 0">
        After running the command, restart SynaBun with <code>synabun</code>.
      </p>`;
  }

  function bindStepEvents(scope) {
    // Cancel / Done
    scope.querySelector('#update-cancel')?.addEventListener('click', close);
    scope.querySelector('#update-done')?.addEventListener('click', close);

    // Next
    scope.querySelector('#update-next')?.addEventListener('click', () => {
      setStep(step + 1);
    });

    // Back
    scope.querySelector('#update-back')?.addEventListener('click', () => {
      setStep(step - 1);
    });

    // Copy buttons
    scope.querySelectorAll('.update-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.dataset.copy;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#34c759" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          setTimeout(() => {
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
          }, 1500);
        });
      });
    });

    // Backup download
    scope.querySelector('#update-backup-download')?.addEventListener('click', handleBackupDownload);

    // Update Now — kick off click-to-update flow
    scope.querySelector('#update-run-now')?.addEventListener('click', handleRunUpdate);

    // Manual — surface the command + relaunch hint, hide auto-update controls
    scope.querySelector('#update-manual')?.addEventListener('click', () => {
      scope.querySelector('#update-manual-note').style.display = '';
      const runNow = scope.querySelector('#update-run-now');
      if (runNow) runNow.style.display = 'none';
    });

    // Skip checkbox
    const skipCb = scope.querySelector('#update-skip-backup');
    if (skipCb) {
      skipCb.addEventListener('change', () => {
        backupDone = skipCb.checked;
        const nextBtn = scope.querySelector('#update-next');
        if (nextBtn) nextBtn.disabled = !backupDone;
      });
    }
  }

  async function handleRunUpdate() {
    const installPlan = _versionData?.installPlan || {};
    const canAutoUpdate = installPlan.canAutoUpdate === true;
    const repoUrl = installPlan.openUrl || SYNABUN_GITHUB_URL;

    // Auto-restart is always on; server forces it true regardless of payload.
    const autoRestart = true;

    const liveStep = stepWrap.querySelector('.update-step:not(.is-leaving)') || stepWrap;
    const runBtn = liveStep.querySelector('#update-run-now');
    const backBtn = liveStep.querySelector('#update-back');
    const manualBtn = liveStep.querySelector('#update-manual');
    const status = liveStep.querySelector('#update-run-status');
    const icon = liveStep.querySelector('#update-run-icon');
    const text = liveStep.querySelector('#update-run-text');

    if (!runBtn || !backBtn || !status || !icon || !text) return;

    if (!canAutoUpdate) {
      window.open(repoUrl, '_blank', 'noopener,noreferrer');
      status.style.display = 'flex';
      icon.className = 'update-backup-icon';
      icon.textContent = '↗';
      icon.style.color = '#4fc3f7';
      text.innerHTML = installPlan.reason === 'not-on-npm' || installPlan.reason === 'npm-unreachable'
        ? `<strong>GitHub release opened</strong><span class="update-run-detail">Nothing was installed. Check for updates again once npm has this version.</span>`
        : `<strong>GitHub repository opened</strong><span class="update-run-detail">Use the repository instructions to update this non-npm installation.</span>`;
      return;
    }

    runBtn.disabled = true;
    backBtn.disabled = true;
    if (manualBtn) manualBtn.disabled = true;
    runBtn.innerHTML = '<span class="update-spinner"></span> Launching updater...';
    status.style.display = 'flex';
    icon.className = 'update-backup-icon spin';
    icon.textContent = '⟳';
    icon.style.color = '';
    text.innerHTML = '<strong>Launching updater</strong><span class="update-run-detail">Opening a terminal window for the npm update.</span>';

    try {
      const res = await fetch('/api/system/run-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server installs its own plan; naming the version on screen lets it
        // refuse when that plan has moved on since this modal was rendered.
        body: JSON.stringify({ autoRestart, target: installPlan.target }),
      });
      if (!res.ok) {
        let msg = `Updater failed (${res.status})`;
        let code = null;
        try { const b = await res.json(); msg = b.error || msg; code = b.code || null; } catch {}
        const failure = new Error(msg);
        failure.code = code;
        throw failure;
      }
      const launched = await res.json();
      // On Windows the updater also stops the SynaBun MCP servers AI clients started (updater.mjs).
      const onWindows = launched?.platform === 'win32';

      icon.className = 'update-backup-icon';
      icon.textContent = '✓';
      icon.style.color = '#34c759';
      text.innerHTML = `<strong>Updater terminal launched</strong><span class="update-run-detail">SynaBun is shutting down so npm can replace the package. Watch the terminal for install progress; SynaBun will relaunch automatically when it finishes.</span>${onWindows ? '<span class="update-run-detail">It also stops the SynaBun MCP servers your AI clients started. Reconnect them afterwards (in Claude Code: /mcp).</span>' : ''}<span class="update-run-hint">If no terminal window appears, ${onWindows ? 'close your AI clients, then ' : ''}run <code>${esc(installPlan.displayCommand || 'npm i -g synabun@latest')}</code> manually.</span>`;
      runBtn.innerHTML = 'Updater running…';

      // Server is shutting down. Optionally redirect to a friendly offline
      // notice — for now leave the page; user already understands from copy.
      // Re-enable Back so they can close the modal.
      setTimeout(() => { backBtn.disabled = false; }, 2500);
    } catch (err) {
      icon.className = 'update-backup-icon';
      icon.textContent = '✗';
      icon.style.color = 'var(--accent-red)';
      // A newer version is offered than the one on screen: load it, and keep the
      // stale command from being run. Going back re-renders the steps with it.
      const targetChanged = err.code === 'target-changed';
      if (targetChanged) {
        try {
          const fresh = await fetch('/api/system/version');
          if (fresh.ok) { _versionData = await fresh.json(); applyTopRightButton(_versionData); }
        } catch {}
      }
      text.textContent = targetChanged ? err.message : 'Failed to launch updater: ' + err.message;
      runBtn.disabled = targetChanged;
      backBtn.disabled = false;
      if (manualBtn) manualBtn.disabled = targetChanged;
      runBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg> Retry`;
    }
  }

  async function handleBackupDownload() {
    const liveStep = stepWrap.querySelector('.update-step:not(.is-leaving)') || stepWrap;
    const btn = liveStep.querySelector('#update-backup-download');
    const status = liveStep.querySelector('#update-backup-status');
    const icon = liveStep.querySelector('#update-backup-icon');
    const text = liveStep.querySelector('#update-backup-text');
    if (!btn) return;

    btn.disabled = true;
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<span class="update-spinner"></span> Creating backup...';
    status.style.display = 'flex';
    icon.className = 'update-backup-icon spin';
    icon.textContent = '⟳';
    text.textContent = 'Collecting files and database...';

    try {
      const res = await fetch('/api/system/backup');
      if (!res.ok) {
        let errMsg = 'Backup failed';
        try { const body = await res.json(); errMsg = body.error || errMsg; } catch {}
        throw new Error(errMsg);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'synabun-backup.zip';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);

      icon.className = 'update-backup-icon';
      icon.textContent = '✓';
      icon.style.color = '#34c759';
      text.textContent = `${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;

      backupDone = true;
      const nextBtn = liveStep.querySelector('#update-next');
      if (nextBtn) nextBtn.disabled = false;
      const skipCb = liveStep.querySelector('#update-skip-backup');
      if (skipCb) skipCb.checked = true;
    } catch (err) {
      icon.className = 'update-backup-icon';
      icon.textContent = '✗';
      icon.style.color = 'var(--accent-red)';
      text.textContent = 'Backup failed: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHTML;
    }
  }

  function close() {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 150);
  }

  // Boot: attach shell once, wire overlay-click-to-close, render initial step.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
  syncStepDots();
  setStep(1);
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

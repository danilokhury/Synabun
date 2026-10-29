// ═══════════════════════════════════════════
// SynaBun Neural Interface — the notice after an automatic restart: the page side
// ═══════════════════════════════════════════
//
// Asks GET /api/system/crash-notice when the page starts and every time its sync
// socket connects: a page that was open through the crash is not reloaded, its
// sockets reconnect (ui-sync.js `session:info`). What crash-notice-view.js says is
// drawn in the update toast's shape (bottom right, styles.css .update-check-toast,
// .crash-notice) once the loading screen is gone, and stays until it is dismissed.
// Dismiss asks the server to drop it (POST /api/system/crash-notice/dismiss), which
// tells every other window (`sync:crash-notice:changed`); this browser also keeps
// the id it dismissed, for a server that could not remove its record. Open logs
// is Settings > App's own: the desktop app's bridge, or POST
// /api/system/app/open-folder, which only a page on this computer may ask. Never
// asked by an invite guest, and never drawn for one, whatever reaches its sync
// socket: /api/system is the owner's (the server sends `crash-notice:` to the
// owner's pages only).

import { on } from './state.js';
import { getLocale, t } from './i18n.js';
import { desktopApp } from './desktop-bridge.js';
import { isGuest } from './ui-sync.js';
import { crashNoticeView, isLoopbackHost, readCrashNotice } from './crash-notice-view.js';

const NOTICE_URL = '/api/system/crash-notice';
const OPEN_FOLDER_URL = '/api/system/app/open-folder';
const WRITE = Object.freeze({ 'Content-Type': 'application/json', 'X-SynaBun-UI': '1', Accept: 'application/json' });
const DISMISSED_KEY = 'synabun-crash-notice-dismissed';
const NOTICE_ID = 'crash-notice';

const translate = (key, params) => t(`crashNotice.${key}`, params);

let _wired = false;
let _asking = null;
let _current = null; // { id, el }
let _waiting = null; // the notice that waits for the loading screen to go
let _guest = false;  // what the last `session:info` said (ui-sync.js isGuest() is the socket's own word)

const guestPage = () => _guest || isGuest();

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dismissedHere(id) {
  try { return localStorage.getItem(DISMISSED_KEY) === id; } catch { return false; }
}

function rememberDismissed(id) {
  try { localStorage.setItem(DISMISSED_KEY, id); } catch { /* storage refused: the server's word is enough */ }
}

function canOpenLogs() {
  if (typeof desktopApp()?.openFolder === 'function') return true;
  return isLoopbackHost(location.hostname);
}

function hide() {
  const current = _current;
  _current = null;
  if (!current) return;
  current.el.classList.remove('show');
  setTimeout(() => current.el.remove(), 250);
}

/** The loading screen covers the page while it starts: the notice waits for it to go. */
function whenPageShown(run) {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay || overlay.classList.contains('hidden')) { run(); return; }
  const watch = new MutationObserver(() => {
    if (!overlay.classList.contains('hidden')) return;
    watch.disconnect();
    run();
  });
  watch.observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

function show(view) {
  hide();
  document.querySelectorAll(`#${NOTICE_ID}`).forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = 'update-check-toast crash-notice';
  el.id = NOTICE_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', view.label);
  el.dataset.noticeId = view.id;
  const buttons = view.actions.map((item) => `<button class="action-btn action-btn--ghost crash-notice-btn" type="button" data-crash-action="${esc(item.id)}" id="crash-notice-${esc(item.id)}">${esc(item.label)}</button>`).join('');
  el.innerHTML = `
      <div class="utc-icon utc-icon--err" aria-hidden="true">!</div>
      <div class="utc-body">
        <div class="utc-title" id="crash-notice-title">${esc(view.title)}</div>
        <div class="utc-sub" id="crash-notice-when">${esc(view.when)}</div>
        ${view.how ? `<div class="utc-sub" id="crash-notice-how">${esc(view.how)}</div>` : ''}
        <div class="crash-notice-lost-title" id="crash-notice-lost-title">${esc(view.lostTitle)}</div>
        <ul class="utc-list crash-notice-lost" aria-labelledby="crash-notice-lost-title">${view.lost.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
        <div class="utc-sub crash-notice-note" id="crash-notice-note" role="status" hidden></div>
        <div class="update-notice-actions">${buttons}</div>
      </div>`;
  el.querySelectorAll('[data-crash-action]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (btn.dataset.crashAction === 'dismiss') dismiss(view.id);
      else if (btn.dataset.crashAction === 'logs') openLogs(el);
    });
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  _current = { id: view.id, el };
}

/** Show this notice (or none): once per crash, never one this browser dismissed, never on a guest's page. */
function present(notice) {
  if (!notice || guestPage()) {
    _waiting = null;
    hide();
    return;
  }
  // A notice something else took off the page is drawn again: it stays until it is dismissed.
  if (_current && !_current.el.isConnected) _current = null;
  if (dismissedHere(notice.id) || _current?.id === notice.id || _waiting?.id === notice.id) return;
  _waiting = notice;
  whenPageShown(() => {
    if (_waiting !== notice) return;
    _waiting = null;
    if (dismissedHere(notice.id) || guestPage()) return;
    show(crashNoticeView(notice, { t: translate, locale: getLocale(), canOpenLogs: canOpenLogs() }));
  });
}

/** Ask the server; an older server (404) or a guest (403) has nothing to say. */
export function checkCrashNotice() {
  if (guestPage()) return Promise.resolve(null);
  if (_asking) return _asking;
  _asking = (async () => {
    try {
      const res = await fetch(NOTICE_URL, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return null;
      const notice = readCrashNotice(await res.json());
      present(notice);
      return notice;
    } catch {
      return null;
    }
  })().finally(() => { _asking = null; });
  return _asking;
}

async function dismiss(id) {
  rememberDismissed(id);
  hide();
  try {
    const res = await fetch(`${NOTICE_URL}/dismiss`, { method: 'POST', headers: WRITE, body: JSON.stringify({ id }) });
    const next = res.ok ? readCrashNotice(await res.json()) : null;
    // A newer crash came while this one was shown: that one is news.
    if (next && next.id !== id) present(next);
  } catch { /* the server is away: this browser keeps it dismissed */ }
}

async function openLogs(el) {
  const note = el.querySelector('#crash-notice-note');
  const bridge = desktopApp();
  let ok = false;
  if (typeof bridge?.openFolder === 'function') {
    try { ok = !!(await bridge.openFolder('logs'))?.ok; } catch { ok = false; }
  } else {
    try {
      const res = await fetch(OPEN_FOLDER_URL, { method: 'POST', headers: WRITE, body: JSON.stringify({ which: 'logs' }) });
      ok = res.ok;
    } catch { ok = false; }
  }
  if (!note) return;
  note.hidden = ok;
  note.textContent = ok ? '' : translate('openLogsFailed');
}

/** Wire the notice once: ask now, and again every time the sync socket connects. */
export function initCrashNotice() {
  if (_wired) return;
  _wired = true;
  on('session:info', (info) => {
    _guest = !!info?.isGuest;
    if (_guest) present(null);
    else checkCrashNotice();
  });
  on('sync:crash-notice:changed', (message) => present(readCrashNotice(message)));
  checkCrashNotice();
}

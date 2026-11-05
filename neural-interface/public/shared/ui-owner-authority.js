// ═══════════════════════════════════════════
// SynaBun Neural Interface — the banner of a degraded owner authority: the page side
// ═══════════════════════════════════════════
//
// When the server cannot identify the program calling it (macOS, lib/peer-identity.js: netstat or ps missing,
// denied, slow past their cap), it pauses the owner's actions (503 PEER_UNAVAILABLE). This banner says so, with the
// reason and Reload to retry, in the update toast's glass at the top centre of the page (styles.css .owner-authority-notice):
// non-modal, nothing behind it is blocked. It shows when
//   • GET /api/health says `ownerAuthority.state: 'degraded'` (asked when the page starts and every time the sync
//     socket connects: a page that was open through a restart is not reloaded), or
//   • a request of the page got 503 PEER_UNAVAILABLE (public/shared/page-session.js dispatches
//     `synabun:peer-unavailable` on the window).
// While it shows, /api/health is asked again now and then, and the banner goes once the state is ok again (the
// page's next write then gets this boot's page secret by itself). Dismiss hides it until another reason comes. Never
// on an invite guest's page (the owner's authority is not a guest's concern). What it says is
// owner-authority-view.js (DOM-free, tested under node).

import { on } from './state.js';
import { t } from './i18n.js';
import { isGuest } from './ui-sync.js';
import { PEER_UNAVAILABLE_EVENT } from './page-session.js';
import { ownerAuthorityNoticeView, readOwnerAuthority, unavailableAuthority } from './owner-authority-view.js';

const HEALTH_URL = '/api/health';
const NOTICE_ID = 'owner-authority-notice';
/** How often /api/health is asked again while the banner shows. */
export const RECHECK_MS = 15_000;

const translate = (key, params) => t(`ownerAuthorityNotice.${key}`, params);

let _wired = false;
let _guest = false;
let _asking = null;
let _current = null;   // { key, el }
let _dismissed = null; // the key this page dismissed
let _recheck = null;

const guestPage = () => _guest || isGuest();

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stopRecheck() {
  if (_recheck) { clearInterval(_recheck); _recheck = null; }
}
function startRecheck() {
  if (_recheck) return;
  _recheck = setInterval(() => { checkOwnerAuthority(); }, RECHECK_MS);
  _recheck.unref?.();
}

function hide() {
  stopRecheck();
  const current = _current;
  _current = null;
  if (!current) return;
  current.el.classList.remove('show');
  setTimeout(() => current.el.remove(), 250);
}

/** The loading screen covers the page while it starts: the banner waits for it to go. */
function whenPageShown(run) {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay || overlay.classList.contains('hidden') || typeof MutationObserver === 'undefined') { run(); return; }
  const watch = new MutationObserver(() => {
    if (!overlay.classList.contains('hidden')) return;
    watch.disconnect();
    run();
  });
  watch.observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

function draw(view) {
  document.querySelectorAll(`#${NOTICE_ID}`).forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = 'owner-authority-notice';
  el.id = NOTICE_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-label', view.label);
  el.dataset.noticeKey = view.key;
  const buttons = view.actions.map((item) => `<button class="action-btn ${item.id === 'reload' ? 'action-btn--primary' : 'action-btn--ghost'} owner-authority-btn" type="button" data-owner-action="${esc(item.id)}" id="owner-authority-${esc(item.id)}">${esc(item.label)}</button>`).join('');
  el.innerHTML = `
      <div class="owner-authority-icon" aria-hidden="true">!</div>
      <div class="owner-authority-body">
        <div class="owner-authority-title" id="owner-authority-title">${esc(view.title)}</div>
        <div class="owner-authority-sub" id="owner-authority-text">${esc(view.body)}</div>
        ${view.reason ? `<div class="owner-authority-sub owner-authority-reason" id="owner-authority-reason">${esc(view.reason)}</div>` : ''}
        ${view.hint ? `<div class="owner-authority-hint" id="owner-authority-hint">${esc(view.hint)}</div>` : ''}
        <div class="update-notice-actions">${buttons}</div>
      </div>`;
  el.querySelectorAll('[data-owner-action]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (btn.dataset.ownerAction === 'reload') reloadPage();
      else if (btn.dataset.ownerAction === 'dismiss') dismiss(view.key);
    });
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  _current = { key: view.key, el };
  startRecheck();
}

/** Reload to retry: the page asks for everything again, the page secret included (a lookup that works hands it out). */
function reloadPage() {
  try { (typeof window !== 'undefined' && window.location ? window.location : globalThis.location).reload(); } catch { /* nothing to reload */ }
}

function dismiss(key) {
  _dismissed = key;
  hide();
}

/** Show the banner for this owner authority (or none): never on a guest's page, never one this page dismissed. */
export function presentOwnerAuthority(authority) {
  const view = ownerAuthorityNoticeView(authority, { t: translate });
  if (!view || guestPage()) { hide(); if (!view) _dismissed = null; return null; }
  // A banner something else took off the page is drawn again.
  if (_current && !_current.el.isConnected) _current = null;
  if (_dismissed === view.key) return null;
  if (_current?.key === view.key) return view;
  whenPageShown(() => {
    if (guestPage() || _dismissed === view.key || _current?.key === view.key) return;
    draw(view);
  });
  return view;
}

/** Ask GET /api/health; an older server (no `ownerAuthority`) or a failed request changes nothing. */
export function checkOwnerAuthority() {
  if (guestPage()) return Promise.resolve(null);
  if (_asking) return _asking;
  _asking = (async () => {
    try {
      const res = await fetch(HEALTH_URL, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return null;
      const authority = readOwnerAuthority(await res.json());
      if (authority) presentOwnerAuthority(authority);
      return authority;
    } catch {
      return null;
    }
  })().finally(() => { _asking = null; });
  return _asking;
}

/** Wire the banner once: ask now, again whenever the sync socket connects, and on every 503 PEER_UNAVAILABLE. */
export function initOwnerAuthorityNotice() {
  if (_wired) return;
  _wired = true;
  on('session:info', (info) => {
    _guest = !!info?.isGuest;
    if (_guest) hide();
    else checkOwnerAuthority();
  });
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener(PEER_UNAVAILABLE_EVENT, (event) => { presentOwnerAuthority(unavailableAuthority(event?.detail)); });
  }
  checkOwnerAuthority();
}

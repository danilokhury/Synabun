// ═══════════════════════════════════════════
// SynaBun Neural Interface — a page without the owner's access: the page side
// ═══════════════════════════════════════════
//
// When the server refuses this page the owner's access (SynaBun's automation browser opened it: 403 WORKER_BROWSER;
// or a refusal the page secret's recovery could not cure: PAGE_SECRET_REQUIRED, OWNER_ROUTE), the page says so in one
// way everywhere instead of showing a refused read as an empty list or default values:
//   • one banner at the top centre (the owner-authority banner's glass and warning tint, styles.css
//     .owner-authority-notice), with Reload and Dismiss; never on an invite guest's page;
//   • `markNoAccess(container)` in a panel whose data was refused: a "No access" block on top, its Save and actions
//     disabled (`noAccessHTML()` for a list that draws its own empty state);
//   • `ownerAccessRefused()` / `onOwnerAccessChange(fn)` for a poller that should stop (asst-computer.js).
// What it knows comes from page-session.js (the page's fetch tells every final refusal, and a refresh that got this
// boot's page secret); a page that becomes visible again while refused asks for the secret once more (one request).
// The words are owner-access.js (DOM-free, tested under node), `ownerAccess.*` in i18n.

import { on } from './state.js';
import { t } from './i18n.js';
import { isGuest } from './ui-sync.js';
import { OWNER_ACCESS_REFUSED_EVENT, OWNER_ACCESS_RESTORED_EVENT, refreshPageSession } from './page-session.js';
import { createOwnerAccessState, ownerAccessNoticeView, ownerAccessSayer, refusalOfError, refusalOfResponse } from './owner-access.js';

export { refusalOfError, refusalOfResponse };

const NOTICE_ID = 'owner-access-notice';
/** What markNoAccess disables: every control but a section's own disclosure (its header). */
const CONTROLS = 'button, input, textarea, select, .cc-dropdown-trigger';

const access = createOwnerAccessState();
const say = ownerAccessSayer((key, params) => t(`ownerAccess.${key}`, params));

let _wired = false;
let _guest = false;
let _current = null;   // { key, el }
let _dismissed = null; // the key this page dismissed
let _rechecking = null;

const guestPage = () => { try { return _guest || isGuest(); } catch { return _guest; } };

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** What the page knows about its own access: null, or { code, reason: 'automation'|'owner', url, at }. */
export function ownerAccessRefused() { return access.current(); }

/** Told every change of what the page knows (fn(current)); returns the unsubscribe. */
export function onOwnerAccessChange(fn) { return access.subscribe(fn); }

/** A refusal seen through a path page-session.js does not wrap (a refusal, an error or an event's detail). */
export function noteOwnerAccessRefusal(detail) {
  const changed = access.note(detail);
  if (changed) presentOwnerAccess();
  return changed;
}

/** The page is the owner's again (it got this boot's page secret). */
export function clearOwnerAccessRefusal() {
  if (access.clear()) presentOwnerAccess();
}

/** A sentence of the "No access" state, in the page's language. */
export function ownerAccessSay(key, params) { return say(key, params); }

/** The "No access" block a panel draws in place of its empty state or its fields. */
export function noAccessHTML({ id = '', compact = false } = {}) {
  return `<div class="owner-no-access${compact ? ' owner-no-access--compact' : ''}" role="status" data-owner-access="refused"${id ? ` id="${esc(id)}"` : ''}>
      <div class="owner-no-access-icon" aria-hidden="true">!</div>
      <div class="owner-no-access-body">
        <div class="owner-no-access-title">${esc(say('panelTitle'))}</div>
        <div class="owner-no-access-desc">${esc(say('panelBody'))}</div>
      </div>
    </div>`;
}

/**
 * A panel whose data was refused: the "No access" block at its top (once) and its controls disabled (Save, Reset,
 * fields, dropdowns; a section's header still opens and closes). Returns the container (or null).
 */
export function markNoAccess(container, { controls = CONTROLS, keep = null } = {}) {
  if (!container || typeof container.querySelector !== 'function') return null;
  container.dataset.ownerAccess = 'refused';
  if (!container.querySelector(':scope > .owner-no-access')) container.insertAdjacentHTML('afterbegin', noAccessHTML());
  const why = say('actionDisabled');
  container.querySelectorAll(controls).forEach((node) => {
    if (node.closest('.owner-no-access') || node.hasAttribute('aria-expanded')) return;
    if (keep && node.matches(keep)) return;
    if ('disabled' in node) node.disabled = true;
    node.setAttribute('aria-disabled', 'true');
    node.classList.add('owner-access-disabled');
    if (!node.getAttribute('title')) node.setAttribute('title', why);
  });
  return container;
}

// ── The banner ──

function hide() {
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
  el.className = 'owner-authority-notice owner-access-notice';
  el.id = NOTICE_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-label', view.label);
  el.dataset.noticeKey = view.key;
  const buttons = view.actions.map((item) => `<button class="action-btn ${item.id === 'reload' ? 'action-btn--primary' : 'action-btn--ghost'} owner-authority-btn" type="button" data-owner-access-action="${esc(item.id)}" id="owner-access-${esc(item.id)}">${esc(item.label)}</button>`).join('');
  el.innerHTML = `
      <div class="owner-authority-icon" aria-hidden="true">!</div>
      <div class="owner-authority-body">
        <div class="owner-authority-title" id="owner-access-title">${esc(view.title)}</div>
        <div class="owner-authority-sub" id="owner-access-text">${esc(view.body)}</div>
        <div class="update-notice-actions">${buttons}</div>
      </div>`;
  el.querySelectorAll('[data-owner-access-action]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (btn.dataset.ownerAccessAction === 'reload') {
        try { window.location.reload(); } catch { /* nothing to reload */ }
      } else {
        _dismissed = view.key;
        hide();
      }
    });
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  _current = { key: view.key, el };
}

/** Draw (or take away) the banner for what the page knows now. */
function presentOwnerAccess() {
  if (!_wired) return null;
  const view = ownerAccessNoticeView(access.current(), { t: (key, params) => t(`ownerAccess.${key}`, params) });
  if (!view || guestPage()) { hide(); if (!view) _dismissed = null; return null; }
  if (_current && !_current.el.isConnected) _current = null;
  if (_dismissed === view.key || _current?.key === view.key) return view;
  whenPageShown(() => {
    if (guestPage() || _dismissed === view.key || _current?.key === view.key) return;
    if (!access.current()) return;
    draw(view);
  });
  return view;
}

/** A refused page that becomes visible again asks for the page secret once (it may be the owner's window now). */
function recheck() {
  if (!access.current() || _rechecking) return _rechecking;
  _rechecking = refreshPageSession(window).then((ok) => { if (ok) clearOwnerAccessRefusal(); return ok; }).finally(() => { _rechecking = null; });
  return _rechecking;
}

/** Wire the banner once: every final refusal, every restore, the guest flag, and a recheck when the page shows again. */
export function initOwnerAccessNotice() {
  if (_wired || typeof window === 'undefined') return;
  _wired = true;
  on('session:info', (info) => {
    _guest = !!info?.isGuest;
    if (_guest) hide(); else presentOwnerAccess();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
  presentOwnerAccess();
}

// What the page knows is kept from the first refusal on, whoever draws it: page-session.js keeps the last one it told
// on the window (a refusal before this module loaded), and every later one comes as an event.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  if (window.__synabunOwnerAccessRefused) access.note(window.__synabunOwnerAccessRefused);
  window.addEventListener(OWNER_ACCESS_REFUSED_EVENT, (event) => { noteOwnerAccessRefusal(event?.detail); });
  window.addEventListener(OWNER_ACCESS_RESTORED_EVENT, () => { clearOwnerAccessRefusal(); });
}

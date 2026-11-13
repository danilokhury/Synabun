// ── The owner's review and approval of what an agent changed (re-review of 2026-11-11, finding 3) ──
//
// One dialog for both places that show a mark: the Schedules window (a schedule, and with it its template) and
// Automation Studio (a template). It shows what the server says will run and where (GET …/review), and its Approve
// button sends back the digest of exactly that review (POST …/approve). When the server answers 409 REVIEW_CHANGED
// (something changed after the review was served, possibly an agent) the dialog shows the fresh review instead and
// says so; nothing was approved. The words are in automation-approval-view.js; the strings in i18n
// `automationApproval.*`. The app's own markup only: no native dialog, no native select.

import { t, getLocale } from './i18n.js';
import { accountText, afterApprovalText, scheduleFlag, sourceText, weekdayName } from './automation-approval-view.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const paths = {
  schedule: (id) => `/api/schedules/${encodeURIComponent(id)}`,
  template: (id) => `/api/loop/templates/${encodeURIComponent(id)}`,
};

async function request(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status; err.code = body?.code; err.body = body;
    throw err;
  }
  return body;
}

/** The marked schedules and templates, for the flags: { schedules: { id: summary }, templates: { id: summary } }. */
export async function fetchAutomationApprovals() {
  try {
    const body = await request('/api/automation-approvals');
    return { schedules: body?.schedules || {}, templates: body?.templates || {} };
  } catch {
    // An older server (no route) or a guest: no flags from the server; the records' own marks still show.
    return { schedules: {}, templates: {} };
  }
}

let _open = null; // { kind, id, opener, onApproved, review, root, keydown }

function instructionsHTML(review) {
  const ins = review.instructions || {};
  const block = (label, text, empty) => `<section class="aap-block"><h5>${esc(label)}</h5>${text ? `<pre class="aap-text">${esc(text)}</pre>` : `<p class="aap-muted">${esc(empty)}</p>`}</section>`;
  const parts = [];
  if (review.kind === 'schedule') {
    parts.push(`<p class="aap-line"><span class="aap-key">${esc(t('automationApproval.dialog.template'))}</span> ${ins.templateMissing ? `<span class="aap-warn">${esc(t('automationApproval.dialog.templateMissing'))}</span>` : esc(ins.templateName || ins.templateId || '')}${review.marks?.template ? ` <span class="aap-chip">${esc(sourceText(review.marks.templateFrom, t))}</span>` : ''}</p>`);
  }
  parts.push(block(t('automationApproval.dialog.task'), ins.task, t('automationApproval.dialog.none')));
  parts.push(block(t('automationApproval.dialog.context'), ins.context, t('automationApproval.dialog.none')));
  if (review.kind === 'schedule') {
    const themes = Array.isArray(ins.dayThemes) ? ins.dayThemes : [];
    parts.push(`<section class="aap-block"><h5>${esc(t('automationApproval.dialog.dayThemes'))}</h5>${themes.length
      ? themes.map((d) => `<div class="aap-theme"><span class="aap-key">${esc(weekdayName(d.day, getLocale?.() || 'en'))}${d.label ? ` · ${esc(d.label)}` : ''}</span>${d.text ? `<pre class="aap-text">${esc(d.text)}</pre>` : `<p class="aap-muted">${esc(t('automationApproval.dialog.themeNoText'))}</p>`}</div>`).join('')
      : `<p class="aap-muted">${esc(t('automationApproval.dialog.noDayThemes'))}</p>`}</section>`);
    if (ins.iterations != null || ins.maxMinutes != null) {
      parts.push(`<p class="aap-line"><span class="aap-key">${esc(t('automationApproval.dialog.limits'))}</span> ${esc(t('automationApproval.dialog.limitsValue', { iterations: ins.iterations ?? '—', minutes: ins.maxMinutes ?? '—' }))}</p>`);
    }
  }
  return parts.join('');
}

function accountHTML(review) {
  if (review.kind === 'template') {
    const used = Array.isArray(review.usedBy) ? review.usedBy : [];
    return `<section class="aap-block"><h5>${esc(t('automationApproval.dialog.usedBy'))}</h5>${used.length
      ? `<ul class="aap-list">${used.map((u) => `<li>${esc(u.name || u.id)} · ${esc(accountText(u.account, t))}${u.marked ? ` <span class="aap-chip">${esc(t('automationApproval.dialog.scheduleAlsoMarked'))}</span>` : ''}</li>`).join('')}</ul>`
      : `<p class="aap-muted">${esc(t('automationApproval.dialog.usedByNone'))}</p>`}</section>`;
  }
  const a = review.account || {};
  const listNote = a.kind === 'morelogin'
    ? (a.onList ? t('automationApproval.dialog.onList') : t('automationApproval.dialog.offList'))
    : '';
  const chosen = a.kind === 'morelogin' ? (a.chosenBy === 'owner' ? t('automationApproval.dialog.chosenByOwner') : t('automationApproval.dialog.chosenByAgent')) : '';
  return `<section class="aap-block aap-account"><h5>${esc(t('automationApproval.dialog.account'))}</h5>
    <p class="aap-line aap-strong">${esc(accountText(a, t))}</p>
    ${chosen ? `<p class="aap-muted">${esc(chosen)}</p>` : ''}
    ${listNote ? `<p class="aap-muted">${esc(listNote)}</p>` : ''}
  </section>`;
}

function dialogHTML(review, { changed = false, error = '' } = {}) {
  const title = review.kind === 'schedule' ? t('automationApproval.dialog.scheduleTitle') : t('automationApproval.dialog.templateTitle');
  const flag = review.kind === 'schedule' ? scheduleFlag(review, t) : null;
  const marked = review.needsApproval === true;
  return `<div class="aap-dialog" role="dialog" aria-modal="true" aria-labelledby="aap-title" aria-describedby="aap-intro">
    <h4 id="aap-title">${esc(title)}</h4>
    <div class="aap-body">
      <p class="aap-name">${esc(review.name || review.id)}</p>
      ${changed ? `<p class="aap-notice aap-warn" role="alert">${esc(t('automationApproval.dialog.changed'))}</p>` : ''}
      ${error ? `<p class="aap-notice aap-warn" role="alert">${esc(error)}</p>` : ''}
      <p class="aap-help" id="aap-intro">${esc(marked ? (flag?.text || t('automationApproval.dialog.intro')) : t('automationApproval.dialog.nothing'))}</p>
      ${accountHTML(review)}
      <h5 class="aap-section">${esc(t('automationApproval.dialog.whatRuns'))}</h5>
      <p class="aap-muted">${esc(t('automationApproval.dialog.wholeContent'))}</p>
      ${instructionsHTML(review)}
      ${marked ? `<p class="aap-help">${esc(afterApprovalText(review, t))}</p>` : ''}
    </div>
    <div class="aap-actions">
      <button type="button" class="aap-btn" data-aap="cancel">${esc(t('automationApproval.dialog.cancel'))}</button>
      ${marked ? `<button type="button" class="aap-btn aap-btn--primary" data-aap="approve">${esc(review.kind === 'schedule' && review.marks?.template && review.marks?.schedule ? t('automationApproval.dialog.approveBoth') : t('automationApproval.dialog.approve'))}</button>` : ''}
    </div>
  </div>`;
}

function render(state) {
  if (!_open) return;
  _open.root.innerHTML = dialogHTML(_open.review, state);
  const focus = _open.root.querySelector('[data-aap="approve"]') || _open.root.querySelector('[data-aap="cancel"]');
  focus?.focus();
}

export function closeApprovalDialog() {
  if (!_open) return;
  const { root, opener, keydown } = _open;
  document.removeEventListener('keydown', keydown, true);
  root.remove();
  _open = null;
  if (opener?.isConnected) opener.focus();
}

async function approve(button) {
  if (!_open) return;
  const { kind, id, review } = _open;
  button.disabled = true;
  try {
    const out = await request(`${paths[kind](id)}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: review.digest }),
    });
    const done = _open.onApproved;
    closeApprovalDialog();
    try { done?.(out); } catch { /* the caller's own refresh */ }
  } catch (err) {
    if (!_open) return;
    if (err.code === 'REVIEW_CHANGED' && err.body?.review) {
      _open.review = err.body.review;
      render({ changed: true });
      return;
    }
    button.disabled = false;
    render({ error: t('automationApproval.dialog.failed', { error: err.message }) });
  }
}

/**
 * Opens the review of a schedule (and its template) or of a template.
 * @param {{ kind: 'schedule'|'template', id: string, opener?: HTMLElement|null, onApproved?: (result) => void,
 *   onError?: (message: string) => void }} o
 */
export async function openApprovalDialog({ kind, id, opener = null, onApproved = null, onError = null }) {
  closeApprovalDialog();
  let review;
  try {
    review = (await request(`${paths[kind](id)}/review`))?.review;
  } catch (err) {
    onError?.(t('automationApproval.dialog.loadFailed', { error: err.message }));
    return;
  }
  if (!review) { onError?.(t('automationApproval.dialog.loadFailed', { error: 'no review' })); return; }
  const root = document.createElement('div');
  root.className = 'aap-modal';
  root.addEventListener('click', (e) => {
    const action = e.target.closest?.('[data-aap]')?.dataset.aap;
    if (action === 'cancel') closeApprovalDialog();
    else if (action === 'approve') approve(e.target.closest('[data-aap]'));
    else if (e.target === root) closeApprovalDialog();
  });
  // Keys are the dialog's while it is open (capture phase, as the app's other popups).
  const keydown = (e) => {
    if (!_open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeApprovalDialog(); return; }
    if (e.key === 'Tab') {
      const items = [..._open.root.querySelectorAll('button:not([disabled])')];
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!_open.root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', keydown, true);
  document.body.appendChild(root);
  _open = { kind, id, opener, onApproved, review, root, keydown };
  render({});
}

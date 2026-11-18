// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: one agent
// ═══════════════════════════════════════════
//
// The workspace of one agent (or of a new one being made): its name, where it stands, the actions, and its tabs
// (Edit · Revisions · Runs · Test run). What each action does is the registry's lifecycle (docs/agents.md):
//
//   Save draft     a new agent: POST /agents. An agent: PATCH its draft with the etag that was read (an approved
//                  agent with no draft gets one over its current revision: the agent stays what was approved).
//   Submit         draft → in review.            Approve   the owner's: the draft becomes the agent's revision.
//   Back to draft  in review → draft.            Withdraw  the working revision, or the approved one.
//   Duplicate · Export · Discard draft · Delete
//
// A save the server refuses because the draft changed since it was read (409 etag_conflict), or because it named no
// etag the server could check (428 etag_required), shows what changed on each side against what is stored now and
// offers the two ways out: take the stored draft, or save the owner's text over it as the new draft content. Approving shows first what the agent may do, with what changed against the last approved revision.
// Leaving with unsaved changes asks. Nothing is approved by saving, importing or duplicating.

import { html, setHTML, ICONS } from '../../skills/studio/sx-dom.js';
import { wireDropdowns } from '../../cc-dropdown.js';
import { formOf, blankForm, patchOf, conflictFields, mergeOverTheirs, issuesByField, isDirty, slugOf } from './ax-form.js';
import { agentTabs, agentKeyText } from './ax-views.js';
import { scopeEntries, scopeFromValue } from './ax-options.js';
import { standingOf } from './ax-library.js';
import { AX_ICONS } from './ax-icons.js';
import { agentMark, standingLabels, scopeTag, loadingHTML, errorHTML, errorText, diffHTML, privilegeHTML, wordsOf, dropdown, downloadText } from './ax-ui.js';
import { renderEditorPanel, leaveEditorPanel, formDefinition } from './ax-editor-view.js';
import { renderRevisionsPanel, leaveRevisionsPanel } from './ax-revisions-view.js';
import { renderRunsPanel, renderTestPanel, leaveRunsPanel } from './ax-runs-view.js';

import { canExportNative } from './ax-native-export.js';
import { exportToHost } from './ax-export-view.js';

let life = null;
let menuEl = null;

export function leaveAgent() {
  life?.abort();
  life = null;
  menuEl?.remove();
  menuEl = null;
  leaveEditorPanel(); leaveRevisionsPanel(); leaveRunsPanel();
}

/** Close the workspace's menu; true when one was open. */
export function closeAgentMenu() {
  if (!menuEl) return false;
  const opener = menuEl.opener;
  menuEl.remove();
  menuEl = null;
  opener?.focus?.({ preventScroll: true });
  return true;
}

// ── The editor's state ──

/** A new agent's editor state. */
export function newEditor({ form = null, provider = '', scope = null, source = 'blank' } = {}) {
  const start = form || blankForm({ provider, scope });
  return { mode: 'new', key: null, agent: null, base: null, etag: null, form: start, idTouched: !!start.id && slugOf(start.name) !== start.id, dirty: !!form, editable: true, issues: null, delta: null, source, loading: false, error: null, busy: false, closed: false };
}

/** The editor state of a stored agent, before it was read. */
export function agentEditor(key) {
  return { mode: 'agent', key, agent: null, base: null, etag: null, form: blankForm(), idTouched: true, dirty: false, editable: false, issues: null, delta: null, loading: true, error: null, busy: false, closed: false };
}

/** Take the server's reading of an agent into the editor (GET /agents/:id, or a draft answer). */
export function adoptAgent(ed, agent, { validation = null, warnings = null, keepForm = false, latest = null } = {}) {
  const draft = agent?.draftDefinition || null;
  // An agent with nothing approved and no draft (every revision withdrawn) is read from its newest revision: a save
  // starts a draft over that one, as the registry does.
  const base = draft || agent?.approvedDefinition || latest || (ed.agent && !ed.agent.draftDefinition && !ed.agent.approvedDefinition ? ed.base : null) || null;
  ed.agent = agent;
  ed.base = base;
  ed.etag = base?.etag || agent?.approvedEtag || null;
  if (!keepForm) { ed.form = formOf(base); ed.dirty = false; }
  // A revision in review is read, not written: it goes back to draft first.
  ed.editable = !draft || draft.status === 'draft';
  ed.issues = validation ? { byField: issuesByField(validation.errors, warnings), valid: validation.ok === true } : (keepForm ? ed.issues : null);
  ed.loading = false;
  ed.error = null;
  return ed;
}

/** Read the agent again (and what its draft changed against the approved revision, for the summary's marks). */
export async function loadAgent(ctx, ed) {
  const gen = ctx.gen();
  ed.loading = !ed.agent;
  try {
    const res = await ctx.api.get(ed.key);
    let latest = null;
    if (!res.agent.draftDefinition && !res.agent.approvedDefinition) {
      const newest = [...(res.agent.revisions || [])].reverse().find((rev) => !rev.damaged && rev.revision);
      if (newest) { try { latest = (await ctx.api.revision(ed.key, newest.revision)).revision; } catch { latest = null; } }
    }
    if (!ctx.alive(gen) || ed.closed) return ed;
    adoptAgent(ed, res.agent, { validation: res.validation, warnings: res.warnings, latest });
    await loadDelta(ctx, ed);
  } catch (error) {
    if (!ctx.alive(gen) || ed.closed) return ed;
    ed.loading = false;
    ed.error = error;
  }
  return ed;
}

async function loadDelta(ctx, ed) {
  ed.delta = null;
  if (!ctx.caps.has('diff') || !ed.agent?.draftDefinition || !ed.agent?.approvedDefinition) return;
  try { ed.delta = (await ctx.api.diff(ed.key, { from: 'approved', to: 'draft' })).diff?.privileges || null; } catch { ed.delta = null; }
}

// ── Markup ──

function actionsHTML(ctx, ed) {
  const { t } = ctx;
  if (ed.loading || ed.error) return '';
  const draft = ed.agent?.draftDefinition || null;
  const inReview = draft?.status === 'in_review';
  const invalid = ed.issues && ed.issues.valid === false;
  const busy = ed.busy ? html` disabled` : '';
  const out = [];
  if (ed.mode === 'new') {
    out.push(html`<button type="button" class="sx-btn sx-btn--primary" data-act="save"${ed.busy || !ed.form.name.trim() ? html` disabled` : ''}>${ICONS.ok}${t('agentsStudio.action.createDraft')}</button>`);
    return html`${out}`;
  }
  if (!ctx.canDraft) return '';
  if (ed.editable) out.push(html`<button type="button" class="sx-btn${ed.dirty ? ' sx-btn--primary' : ''}" data-act="save"${ed.busy || !ed.dirty ? html` disabled` : ''} title="${t('agentsStudio.action.saveHelp')}">${t('agentsStudio.action.saveDraft')}</button>`);
  if (inReview) out.push(html`<button type="button" class="sx-btn" data-act="back-to-draft"${busy}>${t('agentsStudio.action.backToDraft')}</button>`);
  else if (ctx.caps.has('reviews') && (draft || ed.dirty)) out.push(html`<button type="button" class="sx-btn" data-act="submit"${ed.busy || invalid ? html` disabled` : ''} title="${invalid ? t('agentsStudio.action.fixFirst') : t('agentsStudio.action.submitHelp')}">${t('agentsStudio.action.submit')}</button>`);
  if (ctx.caps.has('reviews') && ctx.owner && (draft || ed.dirty)) out.push(html`<button type="button" class="sx-btn${!ed.dirty ? ' sx-btn--primary' : ''}" data-act="approve"${ed.busy || invalid ? html` disabled` : ''} title="${invalid ? t('agentsStudio.action.fixFirst') : t('agentsStudio.action.approveHelp')}">${ICONS.review}${t('agentsStudio.action.approve')}</button>`);
  out.push(html`<button type="button" class="sx-icon-btn" data-act="menu" aria-haspopup="menu" aria-expanded="false" aria-label="${t('agentsStudio.action.more')}" title="${t('agentsStudio.action.more')}"${busy}>${ICONS.more}</button>`);
  return html`${out}`;
}

function bannersHTML(ctx, ed) {
  const { t } = ctx;
  if (ed.loading || ed.error) return '';
  const out = [];
  const draft = ed.agent?.draftDefinition || null;
  const approved = ed.agent?.approvedDefinition || null;
  if (ed.mode === 'new') out.push(html`<div class="sx-banner sx-banner--draft">${ICONS.draft}<span class="sx-banner-text">${t('agentsStudio.banner.new')}</span></div>`);
  else if (draft?.status === 'in_review') out.push(html`<div class="sx-banner sx-banner--warn">${ICONS.review}<span class="sx-banner-text">${t('agentsStudio.banner.inReview')}${draft && ed.agent?.draft?.review?.note ? html`<span class="sx-banner-lines"><span>${t('agentsStudio.banner.note', { note: ed.agent.draft.review.note })}</span></span>` : ''}</span></div>`);
  else if (draft && approved) out.push(html`<div class="sx-banner sx-banner--draft">${ICONS.draft}<span class="sx-banner-text">${t('agentsStudio.banner.draftOverApproved', { draft: draft.revision, approved: approved.revision })}${ed.agent?.draft?.review?.returnNote ? html`<span class="sx-banner-lines"><span>${t('agentsStudio.banner.returned', { note: ed.agent.draft.review.returnNote })}</span></span>` : ''}</span></div>`);
  else if (draft) out.push(html`<div class="sx-banner sx-banner--draft">${ICONS.draft}<span class="sx-banner-text">${t('agentsStudio.banner.draftOnly')}${ed.agent?.draft?.review?.returnNote ? html`<span class="sx-banner-lines"><span>${t('agentsStudio.banner.returned', { note: ed.agent.draft.review.returnNote })}</span></span>` : ''}</span></div>`);
  else if (approved) out.push(html`<div class="sx-banner sx-banner--ok">${ICONS.ok}<span class="sx-banner-text">${t('agentsStudio.banner.approved', { n: approved.revision })}</span></div>`);
  else out.push(html`<div class="sx-banner">${ICONS.off}<span class="sx-banner-text">${t('agentsStudio.banner.withdrawn')}</span></div>`);
  if (ed.agent?.damaged) out.push(html`<div class="sx-banner sx-banner--warn">${ICONS.warn}<span class="sx-banner-text">${t('agentsStudio.damagedHelp')}</span></div>`);
  if (ed.mode === 'agent' && !ctx.canDraft) out.push(html`<div class="sx-banner">${ICONS.lock}<span class="sx-banner-text">${t('agentsStudio.banner.readOnly')}</span></div>`);
  return html`${out}`;
}

function headHTML(ctx, ed) {
  const { t } = ctx;
  const shown = ed.mode === 'new' ? { name: ed.form.name, icon: ed.form.icon, color: ed.form.color } : (ed.agent || { name: ed.key.id });
  const title = ed.mode === 'new' ? (ed.form.name || t('agentsStudio.editor.newTitle')) : (ed.form.name || ed.agent?.name || ed.key.id);
  const from = ctx.view.place === 'agent' ? ctx.view.from : 'library';
  const tabs = ed.mode === 'agent' ? agentTabs(ctx.capsKnown ? ctx.caps : null) : [];
  return html`<header class="sx-ws-head ax-ws-head">
    <nav class="sx-crumb" aria-label="${t('agentsStudio.editor.crumb')}"><button type="button" class="sx-link" data-act="back">${ICONS.back}${t(`agentsStudio.rail.${ed.mode === 'new' ? 'create' : from}`)}</button></nav>
    <div class="sx-ws-title">
      <span id="ax-ws-mark">${agentMark(ed.mode === 'new' ? { icon: ed.form.icon, color: ed.form.color } : { icon: ed.form.icon ?? shown.icon, color: ed.form.color ?? shown.color }, 20)}</span>
      <h3 class="sx-ws-name" id="ax-ws-name" tabindex="-1">${title}</h3>
      ${ed.mode === 'agent' && ed.agent ? html`<span class="ax-ws-state">${standingLabels(t, ed.agent)}</span>${scopeTag(t, ed.key.scope, ctx.info?.projects)}` : ed.mode === 'new' ? html`<span class="sx-label ax-status ax-status--draft">${t('agentsStudio.editor.unsavedNew')}</span>` : ''}
      <span class="sx-label ax-dirty" id="ax-dirty"${ed.dirty && ed.mode === 'agent' ? '' : html` hidden`}>${t('agentsStudio.editor.unsaved')}</span>
      <span class="sx-spacer"></span>
      <span class="sx-row ax-actions" id="ax-actions">${actionsHTML(ctx, ed)}</span>
    </div>
    ${tabs.length > 1 ? html`<div class="sx-tabs" role="tablist" aria-label="${title}">${tabs.map((tab) => html`<button type="button" class="sx-tab" role="tab" id="ax-tab-${tab}" data-act="tab" data-tab="${tab}" aria-selected="${ctx.view.tab === tab ? 'true' : 'false'}" aria-controls="ax-tabpanel" tabindex="${ctx.view.tab === tab ? '0' : '-1'}">${t(`agentsStudio.tab.${tab}`)}</button>`)}</div>` : ''}
  </header>`;
}

// ── Actions ──

const fileName = (key) => `agent-${key.id}${key.scope?.kind === 'project' ? '-project' : ''}.json`;

/** Save the form. True when what is stored is now what the form shows. */
export async function saveEditor(ctx, ed) {
  const { t } = ctx;
  if (ed.busy) return false;
  ed.busy = true;
  ed.onState?.();
  try {
    if (ed.mode === 'new') {
      const res = await ctx.api.create(formDefinition(ed));
      ed.dirty = false;
      ctx.toast(t('agentsStudio.toast.created', { name: res.draft?.name || res.agent?.id }));
      await ctx.adopted({ id: res.agent.id, scope: res.agent.scope });
      return true;
    }
    const patch = patchOf(ed.base, ed.form);
    if (!Object.keys(patch).length) { ed.dirty = false; return true; }
    const res = await ctx.api.updateDraft(ed.key, patch, ed.etag);
    adoptAgent(ed, res.agent, { validation: res.validation, warnings: res.warnings });
    await loadDelta(ctx, ed);
    ctx.toast(t('agentsStudio.toast.saved'));
    ctx.changed();
    return true;
  } catch (error) {
    // 428: the save named no etag the server could check (a form read before its draft existed, a page out of step):
    // the same question as a conflict, against what is stored now, so nothing is written over unseen.
    if (error.conflict || error.etagRequired) return resolveConflict(ctx, ed, error);
    if (error.status === 409 && error.code === 'not_editable') { ctx.toast(t('agentsStudio.toast.inReview'), 'error'); await loadAgent(ctx, ed); return false; }
    if (error.errors?.length) { ed.issues = { byField: issuesByField(error.errors, []), valid: false }; ed.redraw?.({ keepFocus: true }); }
    ctx.toast(t('agentsStudio.toast.saveFailed', { error: errorText(t, error) }), 'error');
    return false;
  } finally {
    ed.busy = false;
    ed.onState?.();
  }
}

/**
 * The draft changed since it was read. Show what changed on each side; the owner takes the stored draft, or saves
 * its own text over it (the fields changed here, written over what is stored now, against the etag that is current).
 */
async function resolveConflict(ctx, ed, error) {
  const { t } = ctx;
  let theirs = error.current;
  let etag = error.currentEtag;
  if (!theirs) {
    try { const res = await ctx.api.get(ed.key); theirs = res.agent.draftDefinition || res.agent.approvedDefinition; etag = theirs?.etag || null; } catch { theirs = null; }
  }
  if (!theirs) { ctx.toast(t('agentsStudio.toast.saveFailed', { error: errorText(t, error) }), 'error'); return false; }
  const fields = conflictFields(ed.base, ed.form, theirs);
  const there = fields.filter((f) => f.theirs && !f.clash);
  const here = fields.filter((f) => f.mine && !f.theirs);
  const both = fields.filter((f) => f.clash);
  const name = (f) => t(`agentsStudio.field.${f.field}`);
  const extra = document.createElement('div');
  setHTML(extra, html`<dl class="ax-conflict">
    ${there.length ? html`<div><dt>${t('agentsStudio.conflict.changedThere')}</dt><dd>${there.map(name).join(', ')}</dd></div>` : ''}
    ${here.length ? html`<div><dt>${t('agentsStudio.conflict.changedHere')}</dt><dd>${here.map(name).join(', ')}</dd></div>` : ''}
    ${both.length ? html`<div class="is-clash"><dt>${t('agentsStudio.conflict.changedBoth')}</dt><dd>${both.map(name).join(', ')}</dd></div>` : ''}
    ${!fields.length ? html`<div><dt>${t('agentsStudio.conflict.sameContent')}</dt><dd></dd></div>` : ''}
  </dl>`);
  const locked = theirs.status === 'in_review';
  const answer = await ctx.ask({
    title: t('agentsStudio.conflict.title'),
    lines: [t('agentsStudio.conflict.help'), locked ? t('agentsStudio.conflict.inReview') : (both.length ? t('agentsStudio.conflict.overwriteHelp') : t('agentsStudio.conflict.mergeHelp'))],
    extra, className: 'ax-dlg',
    buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'reload', label: t('agentsStudio.conflict.reload') }, ...(locked ? [] : [{ id: 'overwrite', label: t('agentsStudio.conflict.overwrite'), kind: 'primary' }])],
    focus: 'reload',
  });
  if (answer === 'reload') {
    await loadAgent(ctx, ed);
    ctx.toast(t('agentsStudio.toast.reloaded'));
    ctx.render({ keepFocus: true });
    return false;
  }
  if (answer !== 'overwrite') return false;
  const mine = mergeOverTheirs(ed.base, ed.form, theirs);
  try {
    const res = await ctx.api.updateDraft(ed.key, patchOf(theirs, mine), etag);
    adoptAgent(ed, res.agent, { validation: res.validation, warnings: res.warnings });
    await loadDelta(ctx, ed);
    ctx.toast(t('agentsStudio.toast.savedOver'));
    ctx.changed();
    ctx.render({ keepFocus: true });
    return true;
  } catch (again) {
    ctx.toast(t('agentsStudio.toast.saveFailed', { error: errorText(t, again) }), 'error');
    return false;
  }
}

/** What a refused transition says. */
const FAILED = Object.freeze({
  approve: 'agentsStudio.toast.approveFailed', submit: 'agentsStudio.toast.submitFailed', backToDraft: 'agentsStudio.toast.backToDraftFailed',
  withdraw: 'agentsStudio.toast.withdrawFailed', discard: 'agentsStudio.toast.discardFailed', delete: 'agentsStudio.toast.deleteFailed',
});

/** Run one of the workspace's transitions, saving first when the form has changes. */
async function transition(ctx, ed, name, run, { needsSave = true } = {}) {
  const { t } = ctx;
  if (ed.busy) return false;
  if (needsSave && ed.dirty && !(await saveEditor(ctx, ed))) return false;
  ed.busy = true;
  ed.onState?.();
  try {
    await run();
    return true;
  } catch (error) {
    // A transition (an approval above all) belongs to the content that was read: without a valid etag it is read again.
    if (error.conflict || error.etagRequired) { ctx.toast(t('agentsStudio.toast.changedElsewhere'), 'error'); await loadAgent(ctx, ed); ctx.render({ keepFocus: true }); return false; }
    if (error.errors?.length) { ed.issues = { byField: issuesByField(error.errors, []), valid: false }; ctx.render({ keepFocus: true }); }
    ctx.toast(t(FAILED[name], { error: errorText(t, error) }), 'error');
    return false;
  } finally {
    ed.busy = false;
    ed.onState?.();
  }
}

/** The approval's question: what this agent may do, and what changed against the last approved revision. */
export async function confirmApproval(ctx, key, definition, approved) {
  const { t } = ctx;
  let diff = null;
  if (ctx.caps.has('diff')) { try { diff = (await ctx.api.diff(key, { to: 'draft' })).diff; } catch { diff = null; } }
  const words = wordsOf(t, { projects: ctx.info?.projects });
  const extra = document.createElement('div');
  extra.className = 'ax-approve';
  setHTML(extra, html`
    <h4 class="sx-section-title">${t('agentsStudio.privilege.title')}</h4>
    ${privilegeHTML(t, definition, approved, diff?.privileges || null, words)}
    ${diff && diff.from ? html`<details class="sx-details ax-approve-diff"><summary>${t('agentsStudio.approve.showChanges')}</summary>${diffHTML(t, diff, words, { open: false })}</details>` : ''}`);
  const wider = diff?.privileges?.escalates === true && !!approved;
  const answer = await ctx.ask({
    title: t('agentsStudio.approve.title', { name: definition.name || key.id, n: definition.revision ?? '' }),
    lines: [approved ? t('agentsStudio.approve.helpNext', { n: approved.revision }) : t('agentsStudio.approve.helpFirst'), wider ? t('agentsStudio.approve.wider') : null],
    extra, wide: true, className: `ax-dlg${wider ? ' ax-dlg--wider' : ''}`,
    buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'approve', label: t('agentsStudio.action.approve'), kind: 'primary' }],
    focus: wider ? 'cancel' : 'approve',
  });
  return answer === 'approve';
}

async function approve(ctx, ed) {
  const { t } = ctx;
  if (ed.dirty && !(await saveEditor(ctx, ed))) return;
  const draft = ed.agent?.draftDefinition;
  if (!draft) return;
  if (!(await confirmApproval(ctx, ed.key, draft, ed.agent.approvedDefinition))) return;
  const done = await transition(ctx, ed, 'approve', async () => {
    const res = await ctx.api.approve(ed.key, { etag: draft.etag });
    ctx.toast(t('agentsStudio.toast.approved', { name: res.revision?.name || ed.key.id, n: res.revision?.revision ?? '' }));
  }, { needsSave: false });
  if (done) { await loadAgent(ctx, ed); ctx.changed(); ctx.render(); }
}

async function submit(ctx, ed) {
  const { t } = ctx;
  if (ed.dirty && !(await saveEditor(ctx, ed))) return;
  // An approved agent with no draft has nothing to send: a draft is opened over it first.
  const done = await transition(ctx, ed, 'submit', async () => {
    if (!ed.agent?.draftDefinition) { const opened = await ctx.api.openDraft(ed.key); adoptAgent(ed, opened.agent, { validation: opened.validation, warnings: opened.warnings }); }
    await ctx.api.submit(ed.key, { etag: ed.etag });
    ctx.toast(t('agentsStudio.toast.submitted'));
  }, { needsSave: false });
  if (done) { await loadAgent(ctx, ed); ctx.changed(); ctx.render(); }
}

async function backToDraft(ctx, ed) {
  const { t } = ctx;
  const done = await transition(ctx, ed, 'backToDraft', async () => {
    await ctx.api.requestChanges(ed.key, { etag: ed.etag });
    ctx.toast(t('agentsStudio.toast.backToDraft'));
  }, { needsSave: false });
  if (done) { await loadAgent(ctx, ed); ctx.changed(); ctx.render(); }
}

async function withdraw(ctx, ed) {
  const { t } = ctx;
  const draft = ed.agent?.draftDefinition;
  const approved = ed.agent?.approvedDefinition;
  const approvedCount = (ed.agent?.revisions || []).filter((r) => r.status === 'approved').length;
  let all = null;
  let extra = null;
  if (approvedCount > 0 && (draft || approvedCount > 1)) {
    extra = document.createElement('label');
    extra.className = 'sx-choice ax-dlg-choice';
    all = document.createElement('input');
    all.type = 'checkbox';
    all.className = 'sx-check';
    const span = document.createElement('span');
    span.textContent = t('agentsStudio.withdraw.all');
    extra.append(all, span);
  }
  const answer = await ctx.ask({
    title: t('agentsStudio.withdraw.title', { name: ed.agent?.name || ed.key.id }),
    lines: [draft ? t('agentsStudio.withdraw.draft', { n: draft.revision }) : approved ? t('agentsStudio.withdraw.approved', { n: approved.revision }) : t('agentsStudio.withdraw.nothing'), t('agentsStudio.withdraw.kept')],
    extra, className: 'ax-dlg',
    buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'withdraw', label: t('agentsStudio.action.withdraw'), kind: 'danger', disabled: !draft && !approved }],
    focus: 'cancel',
  });
  if (answer !== 'withdraw') return;
  let gone = false;
  const done = await transition(ctx, ed, 'withdraw', async () => {
    const res = await ctx.api.withdraw(ed.key, { all: all?.checked === true });
    gone = !res.agent;
    ctx.toast(t(res.discarded && !res.withdrawn?.length ? 'agentsStudio.toast.discarded' : 'agentsStudio.toast.withdrawn'));
  }, { needsSave: false });
  if (!done) return;
  ed.dirty = false;
  ctx.changed();
  if (gone) { ctx.go({ type: 'back' }, { force: true }); return; }
  await loadAgent(ctx, ed);
  ctx.render();
}

async function discardDraft(ctx, ed) {
  const { t } = ctx;
  const answer = await ctx.ask({
    title: t('agentsStudio.discard.title'),
    lines: [ed.agent?.approvedDefinition ? t('agentsStudio.discard.keepsApproved', { n: ed.agent.approvedDefinition.revision }) : t('agentsStudio.discard.removesAgent')],
    className: 'ax-dlg',
    buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'discard', label: t('agentsStudio.action.discardDraft'), kind: 'danger' }],
    focus: 'cancel',
  });
  if (answer !== 'discard') return;
  let removed = false;
  const done = await transition(ctx, ed, 'discard', async () => {
    const res = await ctx.api.discardDraft(ed.key, ed.agent?.draftDefinition?.etag || null);
    removed = res.removed === true;
    ctx.toast(t('agentsStudio.toast.discarded'));
  }, { needsSave: false });
  if (!done) return;
  ed.dirty = false;
  ctx.changed();
  if (removed) { ctx.go({ type: 'back' }, { force: true }); return; }
  await loadAgent(ctx, ed);
  ctx.render();
}

async function remove(ctx, ed) {
  const { t } = ctx;
  const answer = await ctx.ask({
    title: t('agentsStudio.delete.title', { name: ed.agent?.name || ed.key.id }),
    lines: [t('agentsStudio.delete.help'), t('agentsStudio.delete.runsKeep')],
    className: 'ax-dlg',
    buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'delete', label: t('agentsStudio.action.delete'), kind: 'danger' }],
    focus: 'cancel',
  });
  if (answer !== 'delete') return;
  const done = await transition(ctx, ed, 'delete', async () => {
    await ctx.api.remove(ed.key);
    ctx.toast(t('agentsStudio.toast.deleted', { name: ed.agent?.name || ed.key.id }));
  }, { needsSave: false });
  if (!done) return;
  ed.dirty = false;
  ctx.changed();
  ctx.go({ type: 'back' }, { force: true });
}

/** Ask for the id and the library of a copy, then make it and open it. */
export async function duplicateAgent(ctx, key, name) {
  const { t } = ctx;
  const extra = document.createElement('div');
  extra.className = 'ax-dlg-form';
  const life2 = new AbortController();
  const suggested = `${key.id}-copy`.slice(0, Number(ctx.info?.limits?.id) || 64);
  setHTML(extra, html`
    <div class="sx-field"><label class="sx-field-label" for="ax-dup-id">${t('agentsStudio.duplicate.id')}</label><input type="text" class="sx-input sx-mono" id="ax-dup-id" value="${suggested}" autocomplete="off" spellcheck="false" autocapitalize="off"><p class="sx-field-note sx-err-text" id="ax-dup-error" role="alert" hidden></p></div>
    <div class="sx-field"><span class="sx-field-label" id="ax-dup-scope-label">${t('agentsStudio.duplicate.scope')}</span>${dropdown('ax-dup-scope', scopeEntries(ctx.info?.projects || [], key.scope, { globalLabel: t('agentsStudio.scope.globalLibrary'), projectsLabel: t('agentsStudio.scope.pinTo') }), { labelledBy: 'ax-dup-scope-label' })}</div>`);
  let made = null;
  const answer = await ctx.ask({
    title: t('agentsStudio.duplicate.title', { name: name || key.id }),
    lines: [t('agentsStudio.duplicate.help')],
    extra, className: 'ax-dlg',
    buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'copy', label: t('agentsStudio.action.duplicate'), kind: 'primary' }],
    onOpen: (ui) => {
      wireDropdowns(ui.box, { signal: life2.signal });
      const input = ui.box.querySelector('#ax-dup-id');
      input.focus(); input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ui.byId.get('copy')?.click(); } }, { signal: life2.signal });
    },
    // The copy is made while the question is open: a refusal (an id that is taken) is said in it.
    accept: (id, ui) => {
      if (id !== 'copy') return true;
      if (made) return true;
      const input = ui.box.querySelector('#ax-dup-id');
      const note = ui.box.querySelector('#ax-dup-error');
      const scope = scopeFromValue(ui.box.querySelector('#ax-dup-scope').value);
      ui.setDisabled('copy', true);
      ctx.api.copy(key, { id: input.value.trim().toLowerCase(), scope }).then((res) => { made = res; ui.done('copy'); }, (error) => {
        note.hidden = false;
        note.textContent = errorText(t, error);
        ui.setDisabled('copy', false);
        input.focus();
      });
      return false;
    },
  });
  life2.abort();
  if (answer !== 'copy' || !made) return null;
  ctx.toast(t('agentsStudio.toast.duplicated', { id: made.agent.id }));
  ctx.changed();
  return { id: made.agent.id, scope: made.agent.scope };
}

async function exportAgent(ctx, ed) {
  const { t } = ctx;
  try {
    const res = await ctx.api.exportAgent(ed.key);
    downloadText(fileName(ed.key), `${JSON.stringify(res.bundle, null, 2)}\n`);
    ctx.toast(ctx.tp('agentsStudio.toast.exported', res.bundle?.agents?.length ?? 1));
  } catch (error) { ctx.toast(t('agentsStudio.toast.exportFailed', { error: errorText(t, error) }), 'error'); }
}

function openMenu(ctx, ed, opener, head) {
  const { t } = ctx;
  if (closeAgentMenu()) return;
  const draft = ed.agent?.draftDefinition;
  const s = standingOf(ed.agent);
  const items = [
    ctx.caps.has('copy') ? { id: 'duplicate', label: t('agentsStudio.action.duplicate') } : null,
    ctx.caps.has('export') ? { id: 'export', label: t('agentsStudio.action.export') } : null,
    canExportNative(ctx, ed.agent) ? { id: 'native-export', label: t('agentsStudio.nativeExport.action') } : null,
    draft?.status === 'draft' ? { id: 'discard', label: t('agentsStudio.action.discardDraft'), danger: true } : null,
    ctx.owner && (draft || s.status === 'approved') ? { id: 'withdraw', label: t('agentsStudio.action.withdrawMenu'), danger: true } : null,
    ctx.owner ? { id: 'delete', label: t('agentsStudio.action.delete'), danger: true } : null,
  ].filter(Boolean);
  const el = document.createElement('div');
  el.className = 'sx-menu ax-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', t('agentsStudio.action.more'));
  setHTML(el, html`${items.map((i, n) => html`<button type="button" role="menuitem" class="sx-menu-item${i.danger ? ' sx-menu-item--danger' : ''}" data-item="${i.id}" tabindex="${n === 0 ? '0' : '-1'}">${i.label}</button>`)}`);
  el.opener = opener;
  head.append(el);
  menuEl = el;
  opener.setAttribute('aria-expanded', 'true');
  el.querySelector('[role="menuitem"]')?.focus();
  el.addEventListener('keydown', (e) => {
    const list = [...el.querySelectorAll('[role="menuitem"]')];
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); } else if (e.key === 'End') { e.preventDefault(); list.at(-1)?.focus(); }
    else if (e.key === 'Tab') closeAgentMenu();
  });
  el.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-item]')?.dataset.item;
    if (!item) return;
    opener.setAttribute('aria-expanded', 'false');
    closeAgentMenu();
    if (item === 'duplicate') { const made = await duplicateAgent(ctx, ed.key, ed.agent?.name); if (made) ctx.go({ type: 'agent', key: made, tab: 'edit' }); }
    else if (item === 'export') exportAgent(ctx, ed);
    else if (item === 'native-export') exportToHost(ctx, ed);
    else if (item === 'discard') discardDraft(ctx, ed);
    else if (item === 'withdraw') withdraw(ctx, ed);
    else if (item === 'delete') remove(ctx, ed);
  });
}

// ── Drawing ──

/** Draw the workspace of the editor state `ed` in the main area. */
export function renderAgent(main, ctx, ed) {
  leaveAgent();
  life = new AbortController();
  const { signal } = life;
  const { t } = ctx;
  const tab = ed.mode === 'new' ? 'edit' : ctx.view.tab;
  setHTML(main, html`<section class="sx-place ax-place ax-ws" aria-labelledby="ax-ws-name">
    ${headHTML(ctx, ed)}
    <div class="sx-banners" id="ax-banners">${bannersHTML(ctx, ed)}</div>
    <div class="sx-tabpanel ax-tabpanel" id="ax-tabpanel" role="tabpanel" tabindex="-1"${ed.mode === 'agent' ? html` aria-labelledby="ax-tab-${tab}"` : html` aria-label="${t('agentsStudio.tab.edit')}"`}></div>
  </section>`);
  const panel = main.querySelector('#ax-tabpanel');
  const head = main.querySelector('.ax-ws-head');

  // The header follows the form (its name, its mark, whether something is unsaved, which actions are open).
  ed.onState = () => {
    if (!head.isConnected) return;
    const dirty = head.querySelector('#ax-dirty');
    if (dirty) dirty.hidden = !(ed.dirty && ed.mode === 'agent');
    const name = head.querySelector('#ax-ws-name');
    const title = ed.mode === 'new' ? (ed.form.name || t('agentsStudio.editor.newTitle')) : (ed.form.name || ed.agent?.name || ed.key.id);
    if (name && name.textContent !== title) name.textContent = title;
    setHTML(head.querySelector('#ax-ws-mark'), agentMark({ icon: ed.form.icon, color: ed.form.color }, 20));
    const actions = head.querySelector('#ax-actions');
    const focused = actions.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    setHTML(actions, actionsHTML(ctx, ed));
    if (focused) actions.querySelector(`[data-act="${focused}"]`)?.focus({ preventScroll: true });
  };

  if (ed.loading) setHTML(panel, loadingHTML(t));
  else if (ed.error) setHTML(panel, errorHTML(t, ed.error));
  else if (tab === 'revisions') renderRevisionsPanel(panel, ctx, ed);
  else if (tab === 'runs') renderRunsPanel(panel, ctx, ed);
  else if (tab === 'test') renderTestPanel(panel, ctx, ed);
  else renderEditorPanel(panel, ctx, ed);

  main.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-act]');
    if (menuEl && !menuEl.contains(e.target) && el?.dataset.act !== 'menu') closeAgentMenu();
    if (!el || !main.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'back') ctx.go({ type: 'back' });
    else if (act === 'tab') ctx.go({ type: 'tab', tab: el.dataset.tab });
    else if (act === 'save') saveEditor(ctx, ed).then((ok) => { if (ok && ed.mode === 'agent') ctx.render({ keepFocus: true }); });
    else if (act === 'submit') submit(ctx, ed);
    else if (act === 'approve') approve(ctx, ed);
    else if (act === 'back-to-draft') backToDraft(ctx, ed);
    else if (act === 'menu') openMenu(ctx, ed, el, head);
    else if (act === 'retry') loadAgent(ctx, ed).then(() => ctx.render());
  }, { signal });
  // Tabs: the arrows move between them.
  main.addEventListener('keydown', (e) => {
    const tabEl = e.target.closest?.('[role="tab"]');
    if (!tabEl || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const list = [...main.querySelectorAll('[role="tab"]')];
    const at = list.indexOf(tabEl);
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    e.preventDefault();
    list[to]?.focus();
    list[to]?.click();
  }, { signal });
}

/** Ctrl/⌘+S saves the form. True when the key was taken. */
export function agentShortcut(e, ctx, ed, mac) {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey || e.key.toLowerCase() !== 's' || !ed || ed.loading || ed.error) return false;
  if (ed.mode === 'agent' && (!ed.editable || !ed.dirty)) return true;
  if (ed.mode === 'agent' && ctx.view.tab !== 'edit') return true;
  saveEditor(ctx, ed).then((ok) => { if (ok && ed.mode === 'agent') ctx.render({ keepFocus: true }); });
  return true;
}

/** Whether leaving this editor would lose something. */
export const editorDirty = (ed) => !!ed && !ed.closed && ed.dirty === true && (ed.mode === 'agent' ? isDirty(ed.base, ed.form) : true);

export { agentKeyText };

// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the Review queue
// ═══════════════════════════════════════════
//
// An agent only becomes something a run may use when the owner approves a revision. What the Assistant, an agent
// or the owner sent to review waits here, the one waiting longest first: who made it, what it says about itself,
// what changed against the last approved revision (the fields, the instructions line by line) and, first of all,
// what it could newly do (the privilege delta: a change that widens what the agent may do is marked). The owner
// approves it (after the same summary the editor shows), asks for changes (it goes back to draft, with a note) or
// rejects it (the draft is withdrawn; an approved revision under it stays what runs).

import { html, setHTML, ICONS } from '../../skills/studio/sx-dom.js';
import { reviewQueue } from './ax-library.js';
import { keyOf, agentKeyText } from './ax-views.js';
import { AX_ICONS } from './ax-icons.js';
import { agentMark, scopeTag, timeTag, authorText, loadingHTML, errorHTML, emptyHTML, errorText, diffHTML, wordsOf } from './ax-ui.js';
import { confirmApproval } from './ax-agent-view.js';

let life = null;
/** What was read for each card: its diff and the draft (kept while the queue is open). */
const loaded = new Map();

export function leaveReview() {
  life?.abort();
  life = null;
}

/** Forget what was read (the window closed, or the library changed). */
export function forgetReview() { loaded.clear(); }

function cardHTML(ctx, agent) {
  const { t } = ctx;
  const key = agentKeyText(keyOf(agent));
  const draft = agent.draft || {};
  const review = draft.review || {};
  const state = loaded.get(`${key}@${draft.etag}`);
  const words = wordsOf(t, { projects: ctx.info?.projects });
  const body = !state ? loadingHTML(t, t('agentsStudio.review.reading'))
    : state.error ? html`<p class="sx-note sx-note--warn" role="alert">${t('agentsStudio.review.readFailed', { error: errorText(t, state.error) })}</p>`
    : html`${state.validation && state.validation.ok === false ? html`<div class="sx-banner sx-banner--warn">${ICONS.warn}<span class="sx-banner-text">${t('agentsStudio.review.notValid')}<span class="sx-banner-lines">${state.validation.errors.slice(0, 6).map((issue) => html`<span>${issue.message}</span>`)}</span></span></div>` : ''}
      ${state.warnings?.length ? html`<details class="sx-details ax-review-warnings"><summary>${ctx.tp('agentsStudio.review.warnings', state.warnings.length)}</summary><ul class="sx-plain-list">${state.warnings.map((issue) => html`<li>${issue.message}</li>`)}</ul></details>` : ''}
      ${diffHTML(t, state.diff, words, { open: true })}`;
  return html`<li class="sx-card ax-review-card" data-agent="${key}" tabindex="-1">
    <div class="sx-card-top">
      ${agentMark(agent, 18)}
      <h4 class="sx-card-kind"><button type="button" class="sx-name-btn" data-act="open-agent" data-agent="${key}">${draft.name || agent.name || agent.id}</button></h4>
      <span class="ax-rev">${t('agentsStudio.revisionShort', { n: draft.revision ?? '' })}</span>
      ${agent.approvedRevision ? html`<span class="sx-label">${t('agentsStudio.review.over', { n: agent.approvedRevision })}</span>` : html`<span class="sx-label ax-status ax-status--draft">${t('agentsStudio.review.newAgent')}</span>`}
      ${scopeTag(t, agent.scope, ctx.info?.projects)}
      <span class="sx-spacer"></span>
      <span class="sx-card-from">${t('agentsStudio.review.from', { author: authorText(t, review.submittedBy || draft.author) })} · ${timeTag(review.submittedAt || draft.updatedAt || agent.updatedAt, ctx.locale)}</span>
    </div>
    ${review.note ? html`<p class="sx-card-notes">${review.note}</p>` : ''}
    <div class="ax-review-body" data-review-body="${key}">${body}</div>
    <div class="sx-card-actions">
      <button type="button" class="sx-btn sx-btn--primary" data-act="approve" data-agent="${key}"${!state || state.error || state.validation?.ok === false || !ctx.owner ? html` disabled` : ''}>${ICONS.review}${t('agentsStudio.action.approve')}</button>
      <button type="button" class="sx-btn" data-act="request-changes" data-agent="${key}">${t('agentsStudio.action.requestChanges')}</button>
      <button type="button" class="sx-btn sx-btn--danger" data-act="reject" data-agent="${key}"${ctx.owner ? '' : html` disabled`}>${t('agentsStudio.action.reject')}</button>
      <span class="sx-spacer"></span>
      <button type="button" class="sx-btn sx-btn--ghost" data-act="open-agent" data-agent="${key}">${ICONS.edit}${t('agentsStudio.review.openEditor')}</button>
    </div>
  </li>`;
}

/** Ask for a note (asking for changes): the text, or null when the owner cancelled. */
function askNote(ctx, { title, help, action, kind = 'primary', placeholder }) {
  const { t } = ctx;
  const extra = document.createElement('div');
  extra.className = 'sx-field';
  setHTML(extra, html`<label class="sx-field-label" for="ax-note">${t('agentsStudio.review.noteLabel')}</label><textarea class="sx-input sx-textarea" id="ax-note" rows="3" maxlength="2000" placeholder="${placeholder}"></textarea>`);
  return ctx.ask({
    title, lines: [help], extra, className: 'ax-dlg',
    buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'go', label: action, kind }],
    onOpen: (ui) => ui.box.querySelector('#ax-note')?.focus(),
  }).then((answer) => (answer === 'go' ? extra.querySelector('#ax-note').value.trim() : null));
}

/** Draw the Review queue in the main area. */
export function renderReview(main, ctx) {
  leaveReview();
  life = new AbortController();
  const { signal } = life;
  const { t } = ctx;
  const queue = reviewQueue(ctx.agents);
  const body = ctx.loading ? loadingHTML(t)
    : ctx.loadError && !ctx.agents.length ? errorHTML(t, ctx.loadError)
    : !queue.length ? emptyHTML({ icon: ICONS.review, title: t('agentsStudio.review.emptyTitle'), lines: [t('agentsStudio.review.emptyHelp'), t('agentsStudio.review.emptyHow')], actions: ctx.canDraft ? html`<button type="button" class="sx-btn" data-act="go-create">${ICONS.plus}${t('agentsStudio.library.newAgent')}</button>` : '' })
    : html`<ul class="sx-cards ax-review-cards" aria-label="${t('agentsStudio.rail.review')}">${queue.map((agent) => cardHTML(ctx, agent))}</ul>`;
  setHTML(main, html`<section class="sx-place ax-place" aria-labelledby="ax-review-title">
    <header class="sx-place-head">
      <h3 class="sx-place-title" id="ax-review-title" tabindex="-1" data-autofocus>${t('agentsStudio.rail.review')}</h3>
      <p class="sx-place-sub">${queue.length ? ctx.tp('agentsStudio.review.waiting', queue.length) : t('agentsStudio.review.sub')}</p>
    </header>
    ${ctx.awaitingDraft ? html`<div class="sx-place-notices"><div class="sx-notice sx-notice--info">${AX_ICONS.send}<span class="sx-notice-text">${t('agentsStudio.review.awaiting')}</span></div></div>` : ''}
    <div class="sx-place-scroll" id="ax-review-list">${body}</div>
  </section>`);

  // Read every card's diff (what changed against the approved revision) and its draft's problems.
  const read = async (agent) => {
    const key = keyOf(agent);
    const text = agentKeyText(key);
    const id = `${text}@${agent.draft?.etag}`;
    if (loaded.has(id)) return;
    let state;
    try {
      const [diff, got] = await Promise.all([
        ctx.caps.has('diff') ? ctx.api.diff(key, { to: 'draft' }).then((res) => res.diff) : Promise.resolve(null),
        ctx.api.get(key),
      ]);
      state = { diff, validation: got.validation || null, warnings: got.warnings || [], agent: got.agent };
    } catch (error) { state = { error }; }
    loaded.set(id, state);
    if (!main.isConnected || signal.aborted) return;
    const card = [...main.querySelectorAll('.ax-review-card')].find((el) => el.dataset.agent === text);
    if (!card) return;
    // The card is drawn again where it is, the keyboard kept where it was in it.
    const active = card.contains(document.activeElement) ? document.activeElement.dataset.act : null;
    const holder = document.createElement('ul');
    setHTML(holder, cardHTML(ctx, agent));
    card.replaceWith(holder.firstElementChild);
    if (active) [...main.querySelectorAll('.ax-review-card')].find((el) => el.dataset.agent === text)?.querySelector(`[data-act="${active}"]`)?.focus({ preventScroll: true });
  };
  for (const agent of queue) read(agent);

  const agentOf = (text) => queue.find((a) => agentKeyText(keyOf(a)) === text) || null;
  const stateOf = (agent) => loaded.get(`${agentKeyText(keyOf(agent))}@${agent.draft?.etag}`) || null;
  const run = async (el, name, work) => {
    const card = el.closest('.ax-review-card');
    const buttons = card ? [...card.querySelectorAll('button')] : [el];
    for (const b of buttons) b.disabled = true;
    try { await work(); ctx.changed(); await ctx.reload(); } catch (error) {
      ctx.toast(t(name, { error: errorText(t, error) }), 'error');
      // What was read may be out of date (a draft changed meanwhile): the queue is read again.
      if (error.conflict) { forgetReview(); await ctx.reload(); return; }
      for (const b of buttons) if (b.isConnected) b.disabled = false;
    }
  };

  main.addEventListener('click', async (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !main.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'retry') { ctx.reload(); return; }
    if (act === 'go-create') { ctx.go({ type: 'place', place: 'create' }); return; }
    const agent = agentOf(el.dataset.agent);
    if (!agent) return;
    const key = keyOf(agent);
    if (act === 'open-agent') { ctx.go({ type: 'agent', key, tab: 'edit' }); return; }
    const etag = agent.draft?.etag || null;
    if (act === 'approve') {
      const state = stateOf(agent);
      const draft = state?.agent?.draftDefinition;
      if (!draft) return;
      if (!(await confirmApproval(ctx, key, draft, state.agent.approvedDefinition))) return;
      await run(el, 'agentsStudio.toast.approveFailed', async () => {
        const res = await ctx.api.approve(key, { etag: draft.etag });
        ctx.toast(t('agentsStudio.toast.approved', { name: res.revision?.name || key.id, n: res.revision?.revision ?? '' }));
      });
    } else if (act === 'request-changes') {
      const note = await askNote(ctx, { title: t('agentsStudio.review.changesTitle', { name: agent.name || agent.id }), help: t('agentsStudio.review.changesHelp'), action: t('agentsStudio.action.requestChanges'), placeholder: t('agentsStudio.review.changesPlaceholder') });
      if (note === null) return;
      await run(el, 'agentsStudio.toast.backToDraftFailed', async () => {
        await ctx.api.requestChanges(key, { etag, note });
        ctx.toast(t('agentsStudio.toast.changesRequested'));
      });
    } else if (act === 'reject') {
      const note = await askNote(ctx, { title: t('agentsStudio.review.rejectTitle', { name: agent.name || agent.id }), help: agent.approvedRevision ? t('agentsStudio.review.rejectHelpKeeps', { n: agent.approvedRevision }) : t('agentsStudio.review.rejectHelpNew'), action: t('agentsStudio.action.reject'), kind: 'danger', placeholder: t('agentsStudio.review.rejectPlaceholder') });
      if (note === null) return;
      await run(el, 'agentsStudio.toast.withdrawFailed', async () => {
        await ctx.api.withdraw(key, { revision: 'draft', note });
        ctx.toast(t('agentsStudio.toast.rejected'));
      });
    }
  }, { signal });
}

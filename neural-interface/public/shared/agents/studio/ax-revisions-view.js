// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: an agent's revisions
// ═══════════════════════════════════════════
//
// The history of one agent: the working draft, then every stored revision (approved, or withdrawn), newest first,
// each with who made it, when, and what the review said. Any two can be compared (the registry's diff: the fields,
// the instructions line by line, and what the newer one may newly do). A stored revision can be opened as a new
// draft: its content becomes the agent's working draft, over the current revision, to be edited, sent to review
// and approved like any change; the stored revision itself is never changed.

import { html, setHTML, ICONS } from '../../skills/studio/sx-dom.js';
import { wireDropdowns, setDropdownValue } from '../../cc-dropdown.js';
import { formOf, patchOf } from './ax-form.js';
import { statusLabel, timeTag, authorText, dropdown, loadingHTML, errorHTML, errorText, diffHTML, wordsOf, emptyHTML } from './ax-ui.js';

let life = null;

export function leaveRevisionsPanel() {
  life?.abort();
  life = null;
}

/** The revisions as the list shows them: the draft first, then the stored ones, newest first. */
export function revisionList(agent) {
  const stored = [...(agent?.revisions || [])].filter((rev) => rev && rev.revision).sort((a, b) => b.revision - a.revision);
  const draft = agent?.draft ? [{ ...agent.draft, working: true }] : [];
  return [...draft, ...stored.map((rev) => ({ ...rev, working: false }))];
}

/** What the two pickers start on: the newest revision against the one it was made over. */
export function defaultCompare(agent) {
  const list = revisionList(agent);
  if (!list.length) return { from: null, to: null };
  const to = list[0];
  const from = list.find((rev) => rev !== to && rev.revision === to.parentRevision) || list[1] || null;
  return { from: from ? (from.working ? 'draft' : String(from.revision)) : null, to: to.working ? 'draft' : String(to.revision) };
}

const refOf = (rev) => (rev.working ? 'draft' : String(rev.revision));

function entryHTML(ctx, ed, rev, current) {
  const { t } = ctx;
  const review = rev.review || {};
  const notes = [
    review.note ? t('agentsStudio.revisions.note.submitted', { note: review.note }) : null,
    review.returnNote ? t('agentsStudio.revisions.note.returned', { note: review.returnNote }) : null,
    review.decisionNote ? t('agentsStudio.revisions.note.decided', { note: review.decisionNote }) : null,
    review.withdrawNote ? t('agentsStudio.revisions.note.withdrawn', { note: review.withdrawNote }) : null,
  ].filter(Boolean);
  const canOpen = ctx.canDraft && !rev.working && !rev.damaged;
  return html`<li class="sx-version${rev.working ? ' sx-version--draft' : ''}" data-rev="${refOf(rev)}">
    <div class="sx-version-main">
      <span class="sx-version-id">${t('agentsStudio.revisionShort', { n: rev.revision })}</span>
      ${statusLabel(t, rev.damaged ? 'damaged' : rev.status)}
      ${current ? html`<span class="sx-label sx-label--latest">${t('agentsStudio.revisions.current')}</span>` : ''}
      <span class="sx-spacer"></span>
      <span class="sx-version-actions">
        ${rev.parentRevision ? html`<button type="button" class="sx-btn sx-btn--sm" data-act="compare-prev" data-rev="${refOf(rev)}" data-prev="${rev.parentRevision}">${t('agentsStudio.revisions.compareParent')}</button>` : ''}
        ${canOpen ? html`<button type="button" class="sx-btn sx-btn--sm" data-act="open-as-draft" data-rev="${rev.revision}" title="${t('agentsStudio.revisions.openAsDraftHelp')}">${ICONS.draft}${t('agentsStudio.revisions.openAsDraft')}</button>` : ''}
        ${ctx.owner && rev.status === 'approved' && !rev.working ? html`<button type="button" class="sx-btn sx-btn--sm sx-btn--danger" data-act="withdraw-rev" data-rev="${rev.revision}">${t('agentsStudio.action.withdraw')}</button>` : ''}
      </span>
    </div>
    <p class="sx-version-meta">${t('agentsStudio.revisions.madeBy', { author: authorText(t, rev.author) })} · ${timeTag(rev.createdAt, ctx.locale)}${rev.approvedAt ? html` · ${t('agentsStudio.revisions.approvedAt')} ${timeTag(rev.approvedAt, ctx.locale)}` : ''}${rev.parentRevision ? html` · ${t('agentsStudio.revisions.over', { n: rev.parentRevision })}` : ''}</p>
    ${notes.map((note) => html`<p class="sx-version-meta sx-version-note">${note}</p>`)}
    ${rev.damaged ? html`<p class="sx-version-meta sx-warn-text">${t('agentsStudio.damagedHelp')}</p>` : ''}
  </li>`;
}

function pickerEntries(ctx, list, selected) {
  const { t } = ctx;
  return list.map((rev) => ({ value: refOf(rev), label: `${t('agentsStudio.revisionShort', { n: rev.revision })} · ${t(`agentsStudio.status.${rev.status}`)}`, selected: refOf(rev) === selected }));
}

/** Draw the Revisions tab. */
export function renderRevisionsPanel(host, ctx, ed) {
  leaveRevisionsPanel();
  life = new AbortController();
  const { signal } = life;
  const { t } = ctx;
  const list = revisionList(ed.agent);
  if (!list.length) { setHTML(host, emptyHTML({ icon: ICONS.history, title: t('agentsStudio.revisions.emptyTitle'), lines: [t('agentsStudio.revisions.emptyHelp')] })); return; }
  const st = (ed.compare ||= defaultCompare(ed.agent));
  // A pick that is no longer there (a draft that was approved meanwhile) falls back to the default pair.
  const refs = new Set(list.map(refOf));
  if ((st.to && !refs.has(st.to)) || (st.from && !refs.has(st.from))) Object.assign(st, defaultCompare(ed.agent));
  const currentRev = ed.agent?.approvedRevision ?? null;
  const fromEntries = [{ value: '', label: t('agentsStudio.revisions.parent'), selected: !st.from }, ...pickerEntries(ctx, list, st.from)];
  setHTML(host, html`<div class="sx-versions ax-revisions">
    <div class="sx-versions-head">
      <h4 class="sx-section-title">${t('agentsStudio.revisions.compare')}</h4>
      <span class="sx-filter"><span class="sx-filter-key" id="ax-rev-from-label">${t('agentsStudio.revisions.from')}</span>${dropdown('ax-rev-from', fromEntries, { labelledBy: 'ax-rev-from-label' })}</span>
      <span class="sx-filter"><span class="sx-filter-key" id="ax-rev-to-label">${t('agentsStudio.revisions.to')}</span>${dropdown('ax-rev-to', pickerEntries(ctx, list, st.to), { labelledBy: 'ax-rev-to-label' })}</span>
    </div>
    <div class="sx-diff-box ax-diff-box" id="ax-rev-diff" aria-live="polite"></div>
    <h4 class="sx-section-title">${t('agentsStudio.revisions.history')}</h4>
    <ol class="sx-timeline">${list.map((rev) => entryHTML(ctx, ed, rev, !rev.working && rev.revision === currentRev))}</ol>
  </div>`);
  wireDropdowns(host, { signal });
  const box = host.querySelector('#ax-rev-diff');
  const words = wordsOf(t, { projects: ctx.info?.projects });
  let seq = 0;
  const showDiff = async () => {
    const mine = ++seq;
    if (!ctx.caps.has('diff')) { setHTML(box, html`<p class="sx-note">${t('agentsStudio.error.olderServer')}</p>`); return; }
    if (!st.to) { setHTML(box, ''); return; }
    if (st.from && st.from === st.to) { setHTML(box, html`<p class="sx-note">${t('agentsStudio.revisions.sameRevision')}</p>`); return; }
    setHTML(box, loadingHTML(t, t('agentsStudio.revisions.comparing')));
    try {
      // With no `from`, the registry compares with the revision this one was made over (nothing, for a first revision).
      const res = await ctx.api.diff(ed.key, { from: st.from, to: st.to });
      if (mine !== seq || !box.isConnected) return;
      setHTML(box, diffHTML(t, res.diff, words));
    } catch (error) {
      if (mine !== seq || !box.isConnected) return;
      setHTML(box, errorHTML(t, error, { retry: false }));
    }
  };
  showDiff();

  host.addEventListener('change', (e) => {
    if (e.target.id === 'ax-rev-from') { st.from = e.target.value || null; showDiff(); }
    else if (e.target.id === 'ax-rev-to') { st.to = e.target.value || null; showDiff(); }
  }, { signal });
  host.addEventListener('click', async (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !host.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'compare-prev') {
      st.to = el.dataset.rev;
      st.from = refs.has(el.dataset.prev) ? el.dataset.prev : null;
      setDropdownValue(host.querySelector('#ax-rev-to'), st.to);
      setDropdownValue(host.querySelector('#ax-rev-from'), st.from || '');
      showDiff();
      box.scrollIntoView({ block: 'nearest' });
    } else if (act === 'open-as-draft') {
      el.disabled = true;
      const ok = await openAsDraft(ctx, ed, Number(el.dataset.rev));
      if (!ok && el.isConnected) el.disabled = false;
    } else if (act === 'withdraw-rev') {
      const n = Number(el.dataset.rev);
      const answer = await ctx.ask({
        title: t('agentsStudio.withdraw.revisionTitle', { n }),
        lines: [n === currentRev ? t('agentsStudio.withdraw.currentRevision') : t('agentsStudio.withdraw.olderRevision'), t('agentsStudio.withdraw.kept')],
        className: 'ax-dlg',
        buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'withdraw', label: t('agentsStudio.action.withdraw'), kind: 'danger' }], focus: 'cancel',
      });
      if (answer !== 'withdraw') return;
      try {
        await ctx.api.withdraw(ed.key, { revision: n });
        ctx.toast(t('agentsStudio.toast.withdrawn'));
        ctx.changed();
        await ctx.reloadAgent();
      } catch (error) { ctx.toast(t('agentsStudio.toast.withdrawFailed', { error: errorText(t, error) }), 'error'); }
    }
  }, { signal });
}

/** A stored revision's content as the agent's working draft. True when the draft now holds it. */
async function openAsDraft(ctx, ed, n) {
  const { t } = ctx;
  const draft = ed.agent?.draftDefinition || null;
  if (draft?.status === 'in_review') { ctx.toast(t('agentsStudio.toast.inReview'), 'error'); return false; }
  if (ed.dirty || draft) {
    const answer = await ctx.ask({
      title: t('agentsStudio.revisions.replaceTitle', { n }),
      lines: [draft ? t('agentsStudio.revisions.replaceDraft', { draft: draft.revision }) : t('agentsStudio.revisions.replaceUnsaved')],
      className: 'ax-dlg',
      buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'replace', label: t('agentsStudio.revisions.replace'), kind: 'primary' }], focus: 'cancel',
    });
    if (answer !== 'replace') return false;
  }
  try {
    const revision = (await ctx.api.revision(ed.key, n)).revision;
    const patch = patchOf(ed.base, formOf(revision));
    // The same content as what the draft is made over: a draft is opened over it, with nothing changed yet.
    if (Object.keys(patch).length) await ctx.api.updateDraft(ed.key, patch, ed.etag);
    else if (!draft) await ctx.api.openDraft(ed.key);
    ed.dirty = false;
    ed.compare = null;
    ctx.toast(t('agentsStudio.toast.openedAsDraft', { n }));
    ctx.changed();
    await ctx.reloadAgent({ tab: 'edit' });
    return true;
  } catch (error) {
    if (error.conflict) { ctx.toast(t('agentsStudio.toast.changedElsewhere'), 'error'); await ctx.reloadAgent(); return false; }
    ctx.toast(t('agentsStudio.toast.saveFailed', { error: errorText(t, error) }), 'error');
    return false;
  }
}

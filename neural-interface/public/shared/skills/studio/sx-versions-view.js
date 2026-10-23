// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Versions tab
// ═══════════════════════════════════════════
//
// A library skill's history: its draft (the working copy, with the files changed since its version) and every
// revision, newest first, each with its labels (latest, candidate, best, approved, from SynaBun, installed where),
// who made it, from what, and when. Two revisions are compared file by file (the service's diff); the draft is
// compared with its version here. A revision comes back as a new draft (the draft that is there is saved as a
// version first, or replaced: the owner says); candidate and best are marked by the owner. Approved moves only
// through Review, and SynaBun's own versions only through an update of the app.

import { dropdownHTML, wireDropdowns } from '../../cc-dropdown.js';
import { html, raw, setHTML, ICONS, relativeTime, fullTime } from './sx-dom.js';
import { serviceDiff, changedFiles, lineDiff } from './sx-diff.js';
import { diffHTML, textDiffModel } from './sx-diff-view.js';
import { dirtyTabs, resetDocuments, saveVersion } from './sx-docs.js';
import { shortDigest } from './sx-editor-model.js';
import { choosePublishRevision } from './sx-plan.js';
import { adoptNow } from './sx-actions.js';

let _life = null;
const LABELS = ['latest', 'candidate', 'best', 'approved', 'upstream'];

function authorWords(t, a) {
  if (!a || a.kind === 'owner') return t('skillsStudio.versions.author.owner');
  if (a.kind === 'system') return t('skillsStudio.versions.author.system');
  const who = a.kind === 'assistant' ? t('skillsStudio.versions.author.assistant') : t('skillsStudio.versions.author.agent');
  return a.model ? `${who} · ${a.model}` : who;
}

function installedOn(ws, revisionId, t) {
  return (ws.skill?.installations || []).filter((i) => i.sourceRevisionId === revisionId).map((i) => t(`skillsStudio.runtime.${i.runtime}`));
}

function revisionRow(ctx, ws, rev, i, list) {
  const { t, locale } = ctx;
  const labels = (rev.labels || []).filter((l) => LABELS.includes(l));
  const installed = installedOn(ws, rev.revisionId, t);
  const prev = list[i + 1] || null;
  const owner = !ctx.guest && ws.subject.mode === 'library';
  return html`<li class="sx-version" data-rev="${rev.revisionId}">
    <div class="sx-version-main">
      <span class="sx-version-id" title="${rev.revisionId}">${t('skillsStudio.versions.rev', { id: shortDigest(rev.contentDigest) })}</span>
      ${labels.map((l) => html`<span class="sx-label sx-label--${l}">${t(`skillsStudio.versions.label.${l}`)}</span>`)}
      ${installed.length ? html`<span class="sx-label sx-label--installed" title="${installed.join(', ')}">${t('skillsStudio.versions.label.installed', { where: installed.join(', ') })}</span>` : ''}
      <span class="sx-spacer"></span>
      <time class="sx-dim" datetime="${rev.createdAt}" title="${fullTime(rev.createdAt, locale)}">${relativeTime(rev.createdAt, locale)}</time>
    </div>
    <p class="sx-version-meta">${authorWords(t, rev.author)} · ${t(`skillsStudio.versions.source.${['bundled', 'adopted', 'draft', 'assistant', 'import', 'restore', 'customize', 'local', 'github'].includes(rev.source?.kind) ? rev.source.kind : 'local'}`)}${rev.source?.appVersion ? ` ${rev.source.appVersion}` : ''} · ${ctx.tp('skillsStudio.versions.files', rev.files || 0)}${rev.note ? html` · <span class="sx-version-note">${rev.note}</span>` : ''}</p>
    <div class="sx-version-actions">
      ${prev ? html`<button type="button" class="sx-btn sx-btn--sm" data-ver="diff-prev" data-rev="${rev.revisionId}" data-prev="${prev.revisionId}">${t('skillsStudio.versions.diffPrev')}</button>` : ''}
      ${owner ? html`<button type="button" class="sx-btn sx-btn--sm" data-ver="restore" data-rev="${rev.revisionId}">${t('skillsStudio.versions.restore')}</button>
        ${labels.includes('candidate') ? '' : html`<button type="button" class="sx-btn sx-btn--sm sx-btn--ghost" data-ver="candidate" data-rev="${rev.revisionId}">${t('skillsStudio.versions.markCandidate')}</button>`}
        ${labels.includes('best') ? '' : html`<button type="button" class="sx-btn sx-btn--sm sx-btn--ghost" data-ver="best" data-rev="${rev.revisionId}">${t('skillsStudio.versions.markBest')}</button>`}` : ''}
      ${ws.subject.canPublish ? html`<button type="button" class="sx-btn sx-btn--sm" data-ver="publish" data-rev="${rev.revisionId}">${t('skillsStudio.versions.publishThis')}</button>` : ''}
    </div>
  </li>`;
}

/** Draw the Versions tab. */
export function renderVersionsTab(panel, ctx, ws) {
  const { t } = ctx;
  _life?.abort();
  _life = new AbortController();
  const signal = _life.signal;
  if (ws.subject.mode !== 'library' && !(ws.subject.mode === 'readonly' && ws.skill)) {
    const why = ws.subject.mode === 'adopt' ? 'adopt' : ws.subject.mode === 'inplace' ? 'inplace' : 'readonly';
    setHTML(panel, html`<div class="sx-empty"><span class="sx-placeholder-icon" aria-hidden="true">${ICONS.history}</span>
      <h4 class="sx-empty-title">${t('skillsStudio.versions.noneTitle')}</h4><p>${t(`skillsStudio.versions.none.${why}`)}</p>
      ${why === 'adopt' && !ctx.guest ? html`<button type="button" class="sx-btn sx-btn--primary" data-ver="adopt">${t('skillsStudio.ws.adoptNow')}</button>` : ''}</div>`);
    panel.querySelector('[data-ver="adopt"]')?.addEventListener('click', () => adoptNow(ctx, ws), { signal });
    return;
  }
  setHTML(panel, html`<div class="sx-versions"><p class="sx-help" role="status">${t('skillsStudio.versions.loading')}</p></div>`);
  const gen = ctx.gen();
  ctx.api.fetchSkillRevisions(ws.skill.skillId).then((res) => {
    if (!ctx.alive(gen) || !ws.shown || ws.tab !== 'versions') return;
    ws.revisions = (res.revisions || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    draw(panel, ctx, ws, signal);
  }).catch((err) => {
    if (!ctx.alive(gen) || ws.tab !== 'versions') return;
    setHTML(panel, html`<div class="sx-empty" role="alert"><p>${t('skillsStudio.versions.loadFailed', { error: err.message })}</p></div>`);
  });
}

function draw(panel, ctx, ws, signal) {
  const { t } = ctx;
  const list = ws.revisions || [];
  const draftChanges = ws.draft && ws.revision ? changedFiles(ws.revision.manifest?.files || [], ws.draft.files || []) : [];
  const pick = (id, label, selected) => raw(dropdownHTML(id, list.map((r, i) => ({ value: r.revisionId, label: `${t('skillsStudio.versions.rev', { id: shortDigest(r.contentDigest) })}${r.labels?.length ? ` · ${r.labels.filter((l) => LABELS.includes(l)).map((l) => t(`skillsStudio.versions.label.${l}`)).join(', ')}` : ''}`, selected: selected ? r.revisionId === selected : i === 0 })), { label }));
  setHTML(panel, html`<div class="sx-versions">
    <div class="sx-versions-head">
      <h4 class="sx-section-title">${ctx.tp('skillsStudio.versions.title', list.length)}</h4>
      <span class="sx-spacer"></span>
      ${list.length > 1 ? html`<div class="sx-compare-pick"><span class="sx-filter-key">${t('skillsStudio.versions.from')}</span>${pick('sx-ver-from', t('skillsStudio.versions.from'), list[1]?.revisionId)}
        <span class="sx-filter-key">${t('skillsStudio.versions.to')}</span>${pick('sx-ver-to', t('skillsStudio.versions.to'), list[0]?.revisionId)}
        <button type="button" class="sx-btn sx-btn--sm" data-ver="diff-pick">${t('skillsStudio.versions.compare')}</button></div>` : ''}
    </div>
    <ol class="sx-timeline">
      ${ws.draft ? html`<li class="sx-version sx-version--draft">
        <div class="sx-version-main"><span class="sx-version-id">${t('skillsStudio.versions.draft')}</span><span class="sx-label sx-label--draft">${t('skillsStudio.versions.label.draft')}</span><span class="sx-spacer"></span>
          ${ws.draft.updatedAt ? html`<time class="sx-dim" datetime="${ws.draft.updatedAt}" title="${fullTime(ws.draft.updatedAt, ctx.locale)}">${relativeTime(ws.draft.updatedAt, ctx.locale)}</time>` : ''}</div>
        <p class="sx-version-meta">${draftChanges.length ? ctx.tp('skillsStudio.versions.draftChanged', draftChanges.length) : t('skillsStudio.versions.draftSame')}</p>
        <div class="sx-version-actions">
          ${draftChanges.length ? html`<button type="button" class="sx-btn sx-btn--sm" data-ver="diff-draft">${t('skillsStudio.versions.diffDraft')}</button>` : ''}
          ${draftChanges.length && !ctx.guest ? html`<button type="button" class="sx-btn sx-btn--sm sx-btn--primary" data-ver="snapshot">${t('skillsStudio.ws.saveVersion')}</button>` : ''}
        </div></li>` : ''}
      ${list.map((rev, i) => revisionRow(ctx, ws, rev, i, list))}
    </ol>
    ${list.length ? '' : html`<p class="sx-help">${t('skillsStudio.versions.noRevisions')}</p>`}
    <section class="sx-diff-box" id="sx-ver-diff" aria-live="polite"></section>
  </div>`);
  wireDropdowns(panel, { signal });
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-ver]');
    if (!btn || btn.disabled) return;
    onAction(btn.dataset.ver, btn, panel, ctx, ws, signal);
  }, { signal });
}

async function showDiff(panel, ctx, from, to) {
  const { t } = ctx;
  const box = panel.querySelector('#sx-ver-diff');
  if (!box) return;
  setHTML(box, html`<p class="sx-help">${t('skillsStudio.versions.comparing')}</p>`);
  const gen = ctx.gen();
  try {
    const res = await ctx.api.fetchSkillsDiff(from, to);
    if (!ctx.alive(gen) || !box.isConnected) return;
    setHTML(box, html`<h4 class="sx-section-title">${t('skillsStudio.versions.diffTitle')}</h4>${diffHTML(t, serviceDiff(res.diff))}`);
  } catch (err) { if (box.isConnected) setHTML(box, html`<p class="sx-note sx-note--warn" role="alert">${t('skillsStudio.versions.diffFailed', { error: err.message })}</p>`); }
}

async function showDraftDiff(panel, ctx, ws) {
  const { t } = ctx;
  const box = panel.querySelector('#sx-ver-diff');
  if (!box || !ws.draft || !ws.revision) return;
  setHTML(box, html`<p class="sx-help">${t('skillsStudio.versions.comparing')}</p>`);
  const gen = ctx.gen();
  const changes = changedFiles(ws.revision.manifest?.files || [], ws.draft.files || []);
  const files = [];
  for (const c of changes.slice(0, 30)) {
    const binary = (ws.revision.manifest?.files || []).find((f) => f.path === c.path)?.encoding === 'binary';
    if (binary) { files.push({ path: c.path, status: c.status, hunks: [], added: 0, removed: 0, note: 'binary' }); continue; }
    try {
      const before = c.status === 'added' ? '' : ((await ctx.api.fetchSkillsRevisionFile(ws.revision.revisionId, c.path)).content ?? '');
      const afterRes = c.status === 'removed' ? { content: '' } : await ctx.api.fetchSkillsDraftFile(ws.draft.draftId, c.path);
      if (typeof afterRes.contentBase64 === 'string') { files.push({ path: c.path, status: c.status, hunks: [], added: 0, removed: 0, note: 'binary' }); continue; }
      const d = lineDiff(before, afterRes.content ?? '');
      files.push({ ...textDiffModel(c.path, d).files[0] || { path: c.path, hunks: [], added: 0, removed: 0 }, status: c.status });
    } catch { files.push({ path: c.path, status: c.status, hunks: [], added: 0, removed: 0, note: 'too large to compare line by line' }); }
  }
  if (!ctx.alive(gen) || !box.isConnected) return;
  setHTML(box, html`<h4 class="sx-section-title">${t('skillsStudio.versions.diffDraftTitle')}</h4>${diffHTML(t, { files })}`);
}

async function onAction(act, btn, panel, ctx, ws, signal) {
  const { t, tp } = ctx;
  if (act === 'diff-prev') { showDiff(panel, ctx, btn.dataset.prev, btn.dataset.rev); return; }
  if (act === 'diff-pick') {
    const from = panel.querySelector('#sx-ver-from')?.value; const to = panel.querySelector('#sx-ver-to')?.value;
    if (from && to && from !== to) showDiff(panel, ctx, from, to); else ctx.toast(t('skillsStudio.versions.pickTwo'), 'error');
    return;
  }
  if (act === 'diff-draft') { showDraftDiff(panel, ctx, ws); return; }
  // Publish that version: what was planned for another one is dropped there (a plan installs only what it was asked).
  if (act === 'publish') { choosePublishRevision(ws, btn.dataset.rev, { reviews: ctx.data?.reviews || [] }); ws.tab = 'publish'; ctx.render(); return; }
  if (act === 'snapshot') {
    if (dirtyTabs(ws).length) { ctx.toast(t('skillsStudio.toast.saveFirst'), 'error'); return; }
    const gen = ctx.gen();
    try { const out = await saveVersion(ws, ctx.api, { key: ctx.key }); if (!ctx.alive(gen)) return; ctx.toast(out.unchanged ? t('skillsStudio.toast.versionUnchanged') : t('skillsStudio.toast.versionSaved')); await ctx.reload(); }
    catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.toast.versionFailed', { error: err.message }), 'error'); }
    return;
  }
  if (act === 'candidate' || act === 'best') {
    const gen = ctx.gen();
    try {
      const skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill;
      await ctx.api.moveSkillPointer(ws.skill.skillId, { pointer: act, revisionId: btn.dataset.rev, expectedEtag: skill.etag, reason: 'marked in Skills Studio' });
      if (!ctx.alive(gen)) return;
      ctx.toast(t(`skillsStudio.versions.marked.${act}`));
      ws.skill = (await ctx.api.fetchSkill(ws.skill.skillId)).skill;
      if (ws.shown && ws.tab === 'versions') renderVersionsTab(panel, ctx, ws);
    } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.versions.markFailed', { error: err.message }), 'error'); }
    return;
  }
  if (act === 'restore') {
    // Unsaved text in an open document belongs to the draft being replaced: saved or given up first.
    const dirty = dirtyTabs(ws);
    if (dirty.length) {
      await ctx.ask({ title: t('skillsStudio.versions.restoreBlockedTitle'), lines: [tp('skillsStudio.versions.restoreBlocked', dirty.length)], buttons: [{ id: 'ok', label: t('skillsStudio.dialog.ok'), kind: 'primary' }], cancelId: 'ok' });
      return;
    }
    const changes = ws.draft && ws.revision ? changedFiles(ws.revision.manifest?.files || [], ws.draft.files || []) : [];
    let first = 'replace';
    if (changes.length) {
      first = await ctx.ask({
        title: t('skillsStudio.versions.restoreTitle'),
        lines: [tp('skillsStudio.versions.restoreDraftChanged', changes.length), t('skillsStudio.versions.restoreExplain')],
        buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'replace', label: t('skillsStudio.versions.restoreReplace'), kind: 'danger' }, { id: 'save', label: t('skillsStudio.versions.restoreSaveFirst'), kind: 'primary' }],
        focus: 'cancel',
      });
      if (first !== 'replace' && first !== 'save') return;
    }
    const gen = ctx.gen();
    try {
      if (first === 'save') await saveVersion(ws, ctx.api, { key: ctx.key, note: 'kept before a restore' });
      await ctx.api.createSkillsDraft({ skillId: ws.skill.skillId, baseRevisionId: btn.dataset.rev }, { idempotencyKey: ctx.key('restore') });
      if (!ctx.alive(gen)) return;
      resetDocuments(ws);
      ws.tab = 'edit';
      ctx.toast(t('skillsStudio.versions.restored', { id: shortDigest(ws.revisions.find((r) => r.revisionId === btn.dataset.rev)?.contentDigest) }));
      await ctx.reload();
      if (ws.shown) ctx.render();
    } catch (err) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.versions.restoreFailed', { error: err.message }), 'error'); }
  }
  void signal;
}

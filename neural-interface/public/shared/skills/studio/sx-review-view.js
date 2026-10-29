// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Review place
// ═══════════════════════════════════════════
//
// What waits for the owner (sx-review.js): submissions of the Review queue (a new skill or a change from the SynaBun
// Assistant or another agent: what it does, who made it, its checks, its scan findings, what it can do that the
// approved revision could not, the name it installs as, every file it changes with its lines) and the updates
// SynaBun ships for skills that are installed. Approving installs: "Approve & install" approves and installs to the
// targets the submission named (sx-install-flow.js: the service's plan, one question only when the plan asks one,
// then exactly that plan), and the card then says where it went and what a running session needs; "Approve only"
// leaves it approved with Install on its card. Ask for changes (the Assistant reads why) or reject. An update is
// read file by file before it is applied; "Keep mine" leaves the copy as it is until SynaBun ships another version.

import { scanFindingText } from './sx-scan.js';
import { studioErrorText } from './sx-errors.js';
import { html, setHTML, ICONS, relativeTime, fullTime, plural } from './sx-dom.js';
import { reviewCardModel, sortReviews, updateTargetKeys } from './sx-review.js';
import { serviceDiff, invertDiff, lineDiff } from './sx-diff.js';
import { diffHTML, textDiffModel } from './sx-diff-view.js';
import { targetWords, keyWords, reviewTargets, installFlow, flowWords, installBusy, acquireInstall, refreshSkillWorkspaces } from './sx-install-flow.js';

let _life = null;
const FILTERS = ['waiting', 'all', 'decided'];
/** Scan codes whose words carry the number of findings. */
const SCAN_COUNTED = ['blocked', 'incomplete', 'review', 'findings'];
/** What an install from a card said, by review id, for as long as the page lives: the card shows it after the reload. */
const _said = new Map();

function authorWords(t, a) {
  if (a.kind === 'owner') return t('skillsStudio.review.author.owner');
  const who = a.kind === 'assistant' ? t('skillsStudio.review.author.assistant') : t('skillsStudio.review.author.agent');
  const bits = [a.provider, a.model].filter(Boolean).join(' · ');
  return bits ? `${who} (${bits})` : who;
}

/**
 * Where a card's install goes, said whole: what the submission named, what of that is not available here and why,
 * where it then goes (never a silent fallback), or that nothing of it is available (then Publish is the way).
 */
function destinationHTML(ctx, card, dest) {
  const { t } = ctx;
  if (!dest) return '';
  const lines = [];
  if (card.targets.length) lines.push(html`<li>${t('skillsStudio.review.forTargets', { targets: card.targets.map((tg) => targetWords(ctx, tg)).join(', ') })}</li>`);
  for (const m of dest.missing) lines.push(html`<li class="sx-warn-text">${t('skillsStudio.review.targetUnavailable', { target: m.words, reason: m.why })}</li>`);
  if (!dest.targets.length) lines.push(html`<li class="sx-warn-text">${t('skillsStudio.review.noDestination')}</li>`);
  else if (dest.missing.length || !card.targets.length) {
    const why = dest.fallback === 'installed' ? t('skillsStudio.review.fallbackInstalled') : dest.fallback === 'claude' ? t('skillsStudio.review.fallbackDefault') : dest.fallback === 'assistants' ? t('skillsStudio.review.fallbackAssistants') : '';
    lines.push(html`<li>${t('skillsStudio.review.installsFor', { targets: dest.words.join(', ') })}${why ? html` <span class="sx-dim">${why}</span>` : ''}</li>`);
  }
  // One tile per runtime, as Publish shows them: where this card's install goes (Codex and OpenCode are first-class).
  if (dest.targets.length) {
    const picked = (rt) => [...dest.keys].some((k) => String(k).startsWith(`${rt}:`));
    lines.push(html`<li class="sx-dest-tiles" role="group" aria-label="${t('skillsStudio.review.destTilesLabel')}">${['claude', 'codex', 'opencode'].map((rt) => html`<span class="sx-dest-tile${picked(rt) ? ' is-on' : ''}" title="${picked(rt) ? t('skillsStudio.review.destTileOn', { runtime: t(`skillsStudio.runtime.${rt}`) }) : t('skillsStudio.review.destTileOff', { runtime: t(`skillsStudio.runtime.${rt}`) })}">${picked(rt) ? ICONS.ok : ''}<span>${t(`skillsStudio.runtime.${rt}`)}</span></span>`)}</li>`);
  }
  return html`${lines}`;
}

function cardHTML(ctx, card, focused) {
  const { t, locale } = ctx;
  const installs = card.actions.includes('approve_install') || card.actions.includes('install');
  const review = installs ? (ctx.data?.reviews || []).find((r) => r.reviewId === card.id) : null;
  const row = review ? ctx.rows.find((r) => r.skill?.skillId === review.skillId) || null : null;
  const dest = review ? reviewTargets(ctx, { review, skill: row?.skill || null, row }) : null;
  const canInstall = !!dest && dest.targets.length > 0;
  // An install of this skill on its way from any surface: its buttons are off here too, however the card is drawn again.
  const busy = installs && installBusy(card.skillId);
  const authority = card.authority.map((a) => html`<li>${a.added.length ? t('skillsStudio.review.authorityAdds', { what: t(`skillsStudio.review.authority.${a.kind}`), items: a.added.slice(0, 6).join(', ') }) : ''}${a.removed.length ? t('skillsStudio.review.authorityRemoves', { what: t(`skillsStudio.review.authority.${a.kind}`), items: a.removed.slice(0, 6).join(', ') }) : ''}</li>`);
  return html`<article class="sx-card sx-card--${card.state}${focused ? ' is-focused' : ''}" id="sx-review-${card.id}" aria-labelledby="sx-review-${card.id}-h" tabindex="-1">
    <header class="sx-card-top">
      <h4 class="sx-card-kind" id="sx-review-${card.id}-h"><span class="sx-card-mark" aria-hidden="true">${card.kind === 'new' ? ICONS.spark : ICONS.edit}</span>${t(`skillsStudio.review.kind.${card.kind}`)} · <span class="sx-mono">/${card.installAs || card.name}</span></h4>
      <span class="sx-state-chip sx-state-chip--review-${card.state}">${t(`skillsStudio.review.state.${card.state}`)}</span>
      <span class="sx-spacer"></span>
      <span class="sx-card-from">${authorWords(t, card.author)}${card.createdAt ? html` · <time datetime="${card.createdAt}" title="${fullTime(card.createdAt, locale)}">${relativeTime(card.createdAt, locale)}</time>` : ''}</span>
    </header>
    ${card.notes ? html`<p class="sx-card-notes">${card.notes}</p>` : ''}
    ${card.assumptions.length ? html`<ul class="sx-plain-list sx-card-assumptions">${card.assumptions.map((a) => html`<li>${t('skillsStudio.review.assumed', { text: a })}</li>`)}</ul>` : ''}
    <ul class="sx-facts sx-card-facts">
      ${card.installAs ? html`<li>${t('skillsStudio.review.installsAs')} <span class="sx-mono">/${card.installAs}</span></li>` : ''}
      ${dest ? destinationHTML(ctx, card, dest) : card.targets.length ? html`<li>${t('skillsStudio.review.forTargets', { targets: card.targets.map((tg) => targetWords(ctx, tg)).join(', ') })}</li>` : ''}
      <li class="${card.lint.errors ? 'sx-err-text' : ''}">${card.lint.errors ? ctx.tp('skillsStudio.review.lintErrors', card.lint.errors) : t('skillsStudio.review.lintOk')}${card.lint.warnings ? ` · ${ctx.tp('skillsStudio.review.lintWarnings', card.lint.warnings)}` : ''}</li>
      <li class="sx-scan-${card.scan.sev}">${SCAN_COUNTED.includes(card.scan.code) ? plural(t, `skillsStudio.review.scan.${card.scan.code}`, card.scan.found) : t(`skillsStudio.review.scan.${card.scan.code}`)}</li>
    </ul>
    ${card.scan.findings.length ? html`<details class="sx-details"><summary>${ctx.tp('skillsStudio.review.findings', card.scan.findings.length)}</summary><ul class="sx-findings">${card.scan.findings.map((f) => html`<li class="sx-finding sx-finding--${f.severity}"><span class="sx-finding-sev">${t(`skillsStudio.review.severity.${f.severity === 'info' ? 'low' : f.severity}`)}</span> ${scanFindingText(t, f)}${f.file ? html` <span class="sx-mono sx-dim">${f.file}${f.line ? `:${f.line}` : ''}</span>` : ''}</li>`)}</ul></details>` : ''}
    ${authority.length ? html`<div class="sx-authority"><p class="sx-help">${t('skillsStudio.review.authorityTitle')}</p><ul class="sx-plain-list">${authority}</ul></div>` : ''}
    <details class="sx-details" data-review-diff="${card.id}"><summary>${card.files.length ? ctx.tp('skillsStudio.review.filesChanged', card.files.length) : t('skillsStudio.review.showFiles')}</summary><div class="sx-diff-box" data-diff-box="${card.id}"><p class="sx-help">${t('skillsStudio.review.loadingDiff')}</p></div></details>
    ${card.comments.length ? html`<ul class="sx-plain-list sx-card-comments">${card.comments.map((c) => html`<li><span class="sx-dim">${c.by === 'owner' ? t('skillsStudio.review.author.owner') : t('skillsStudio.review.author.assistant')}:</span> ${c.body}</li>`)}</ul>` : ''}
    ${card.reason ? html`<p class="sx-help">${t('skillsStudio.review.yourNote', { text: card.reason })}</p>` : ''}
    ${saidHTML(ctx, card)}
    ${card.publication.length && !_said.has(card.id) ? html`<ul class="sx-plain-list">${card.publication.map((p) => html`<li class="${p.status === 'committed' ? '' : 'sx-warn-text'}">${keyWords(ctx, p.targetKey)}: ${t(`skillsStudio.publish.result.${['committed', 'skipped', 'needs-confirmation', 'failed'].includes(p.status) ? p.status : 'failed'}`)}${p.error ? ` · ${p.error}` : ''}</li>`)}</ul>` : ''}
    ${card.actions.length ? html`<div class="sx-card-actions" data-card-actions="${card.id}" data-busy="${busy ? '1' : '0'}">
      ${card.actions.includes('approve_install') && canInstall ? html`<button type="button" class="sx-btn sx-btn--primary" data-review="approve_install" data-id="${card.id}"${busy ? ' disabled' : ''}>${ICONS.publish}<span>${busy ? t('skillsStudio.review.installing') : t('skillsStudio.review.approveInstall')}</span></button>` : ''}
      ${card.actions.includes('install') && canInstall ? html`<button type="button" class="sx-btn sx-btn--primary" data-review="install" data-id="${card.id}"${busy ? ' disabled' : ''}>${ICONS.publish}<span>${busy ? t('skillsStudio.review.installing') : t('skillsStudio.review.installNow')}</span></button>` : ''}
      ${card.actions.includes('approve') ? html`<button type="button" class="sx-btn${canInstall ? '' : ' sx-btn--primary'}" data-review="approve" data-id="${card.id}"${busy ? ' disabled' : ''}>${canInstall ? t('skillsStudio.review.approveOnly') : t('skillsStudio.review.approveOnlyPrimary')}</button>` : ''}
      ${card.actions.includes('request_changes') ? html`<button type="button" class="sx-btn" data-review="request_changes" data-id="${card.id}"${busy ? ' disabled' : ''}>${t('skillsStudio.review.requestChanges')}</button>` : ''}
      ${card.actions.includes('reject') ? html`<button type="button" class="sx-btn sx-btn--ghost sx-btn--danger" data-review="reject" data-id="${card.id}"${busy ? ' disabled' : ''}>${t('skillsStudio.review.reject')}</button>` : ''}
      ${card.actions.includes('install') ? html`<button type="button" class="sx-btn${canInstall ? ' sx-btn--ghost' : ' sx-btn--primary'}" data-review="publish" data-id="${card.id}"${busy ? ' disabled' : ''}>${t('skillsStudio.review.openPublish')}</button>` : ''}
      <button type="button" class="sx-btn sx-btn--ghost" data-review="open" data-id="${card.id}">${t('skillsStudio.review.open')}</button>
    </div>` : ''}
  </article>`;
}

/** What the last install from this card said: where it went and what a running session needs, or why it did not go. */
function saidHTML(ctx, card) {
  const said = _said.get(card.id);
  if (!said) return '';
  return html`<div class="sx-outcome sx-outcome--${said.kind}" role="status" data-card-said="${card.id}">
    <p class="sx-outcome-line">${said.kind === 'info' ? ICONS.ok : ICONS.warn}<strong>${said.line}</strong></p>
    ${said.lines.length ? html`<ul class="sx-plain-list sx-outcome-notes">${said.lines.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
    ${said.kind !== 'info' ? html`<p class="sx-help">${ctx.t('skillsStudio.review.notInstalledHelp')}</p>` : ''}
  </div>`;
}

function updateCardHTML(ctx, u) {
  const { t } = ctx;
  const where = [...new Set([...u.legacyCopies.map((c) => c.path), ...(u.installations.length ? [plural(t, 'skillsStudio.review.libraryInstalls', u.installations.length)] : [])])];
  const hid = `sx-update-${String(u.name).replace(/[^A-Za-z0-9_-]/g, '_')}-h`;
  return html`<article class="sx-card sx-card--update" aria-labelledby="${hid}">
    <header class="sx-card-top">
      <h4 class="sx-card-kind" id="${hid}"><span class="sx-card-mark" aria-hidden="true">${ICONS.update}</span>${t('skillsStudio.review.kind.update')} · <span class="sx-mono">/${u.label}</span></h4>
      <span class="sx-spacer"></span><span class="sx-card-from">${t('skillsStudio.review.fromSynabun')}</span>
    </header>
    <p class="sx-card-notes">${t('skillsStudio.review.updateBody', { name: u.label })}</p>
    <ul class="sx-facts">${where.map((w) => html`<li class="sx-mono">${w}</li>`)}${u.runtimes.length ? html`<li>${t('skillsStudio.review.updateRuntimes', { runtimes: u.runtimes.map((r) => t(`skillsStudio.runtime.${r}`)).join(', ') })}</li>` : ''}</ul>
    <details class="sx-details" data-update-diff="${u.key}"><summary>${t('skillsStudio.review.reviewChanges')}</summary><div class="sx-diff-box" data-update-box="${u.key}"><p class="sx-help">${t('skillsStudio.review.loadingDiff')}</p></div></details>
    ${ctx.guest ? '' : html`<div class="sx-card-actions">
      <button type="button" class="sx-btn sx-btn--primary" data-update="apply" data-key="${u.key}">${t('skillsStudio.review.update')}</button>
      <button type="button" class="sx-btn sx-btn--ghost" data-update="keep" data-key="${u.key}">${t('skillsStudio.review.keepMine')}</button>
    </div>`}
  </article>`;
}

/** Draw the Review place. */
/** Review is left for another place: its listeners on the shared main area end. */
export function leaveReviewPlace() { _life?.abort(); _life = null; }

/** The window closed: what the cards said of their installs goes with it. */
export function forgetReviewOutcomes() { _said.clear(); }

export function renderReviewPlace(host, ctx) {
  const { t } = ctx;
  _life?.abort();
  _life = new AbortController();
  const signal = _life.signal;
  const filter = ctx.lib.reviewFilter || 'waiting';
  const { open, decided } = sortReviews(ctx.data?.reviews || []);
  // A submission installed from its card stays in the waiting list, saying where it went, until the window closes.
  const justInstalled = decided.filter((r) => _said.has(r.reviewId));
  const cards = (filter === 'decided' ? decided : filter === 'all' ? [...open, ...decided] : [...open, ...justInstalled]).map((r) => reviewCardModel(r, { guest: ctx.guest }));
  const updates = filter === 'decided' ? [] : ctx.updates;
  const focus = ctx.reviewFocus;
  setHTML(host, html`<section class="sx-place sx-place--review" aria-labelledby="sx-review-title">
    <div class="sx-place-head">
      <h3 class="sx-place-title" id="sx-review-title" tabindex="-1" data-autofocus>${t('skillsStudio.review.title')}</h3>
      <p class="sx-place-sub">${t('skillsStudio.review.subtitle')}</p>
      <span class="sx-spacer"></span>
      <div class="sx-seg" role="group" aria-label="${t('skillsStudio.review.filterLabel')}">${FILTERS.map((f) => html`<button type="button" data-review-filter="${f}" aria-pressed="${filter === f ? 'true' : 'false'}">${t(`skillsStudio.review.filter.${f}`)}</button>`)}</div>
    </div>
    <div class="sx-place-scroll">
      <div class="sx-cards">
        ${updates.length ? html`<h4 class="sx-section-title">${ctx.tp('skillsStudio.review.updatesTitle', updates.length)}</h4>${updates.map((u) => updateCardHTML(ctx, u))}` : ''}
        ${cards.length ? html`<h4 class="sx-section-title">${filter === 'decided' ? t('skillsStudio.review.decidedTitle') : ctx.tp('skillsStudio.review.waitingTitle', cards.length)}</h4>${cards.map((c) => cardHTML(ctx, c, c.id === focus))}` : ''}
        ${!cards.length && !updates.length ? html`<div class="sx-empty"><span class="sx-placeholder-icon" aria-hidden="true">${ICONS.review}</span><h4 class="sx-empty-title">${t('skillsStudio.review.emptyTitle')}</h4><p>${t('skillsStudio.review.emptyBody')}</p></div>` : ''}
      </div>
    </div>
  </section>`);
  if (focus) { ctx.clearReviewFocus(); requestAnimationFrame(() => { const el = host.querySelector(`#sx-review-${CSS.escape(focus)}`); el?.scrollIntoView({ block: 'nearest' }); el?.focus(); }); }
  host.addEventListener('click', (e) => onClick(e, host, ctx), { signal });
  host.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.open) return;
    if (d.dataset?.reviewDiff) loadReviewDiff(host, ctx, d.dataset.reviewDiff);
    if (d.dataset?.updateDiff) loadUpdateDiff(host, ctx, d.dataset.updateDiff);
  }, { signal, capture: true });
}

async function loadReviewDiff(host, ctx, id) {
  const { t } = ctx;
  const box = host.querySelector(`[data-diff-box="${CSS.escape(id)}"]`);
  const review = (ctx.data?.reviews || []).find((r) => r.reviewId === id);
  if (!box || !review || box.dataset.loaded) return;
  box.dataset.loaded = '1';
  const card = reviewCardModel(review);
  const gen = ctx.gen();
  try {
    if (card.fromRevisionId && card.revisionId) {
      const res = await ctx.api.fetchSkillsDiff(card.fromRevisionId, card.revisionId);
      if (!ctx.alive(gen) || !box.isConnected) return;
      setHTML(box, diffHTML(t, serviceDiff(res.diff)));
    } else if (card.revisionId) {
      // A new skill: every file is new, each shown as added.
      const rev = (await ctx.api.fetchSkillsRevision(card.revisionId)).revision;
      const files = [];
      for (const f of (rev?.manifest?.files || []).slice(0, 20)) {
        if (f.encoding !== 'utf-8') { files.push({ path: f.path, status: 'added', hunks: [], added: 0, removed: 0, note: 'binary' }); continue; }
        const got = await ctx.api.fetchSkillsRevisionFile(card.revisionId, f.path);
        const d = lineDiff('', got.content ?? '');
        files.push({ ...(textDiffModel(f.path, d).files[0] || { path: f.path, hunks: [], added: 0, removed: 0 }), status: 'added' });
      }
      if (!ctx.alive(gen) || !box.isConnected) return;
      setHTML(box, diffHTML(t, { files }, { open: 2 }));
    }
  } catch (err) { if (box.isConnected) setHTML(box, html`<p class="sx-note sx-note--warn" role="alert">${t('skillsStudio.review.diffFailed', { error: studioErrorText(ctx.t, err) })}</p>`); }
}

/** The changes an update makes, from the installed copy's side (what updating it would change). */
async function updateDiffModel(ctx, row) {
  const upstream = row.update?.upstreamRevisionId;
  if (!upstream) return { model: null, partial: false };
  const deploy = (row.skill?.installations || []).find((i) => row.update.installations.includes(i.installationId));
  if (deploy) return { model: serviceDiff((await ctx.api.fetchSkillsDiff(deploy.sourceRevisionId, upstream)).diff), partial: false };
  const copy = row.update.legacyCopies[0];
  if (!copy) return { model: null, partial: false };
  if (ctx.caps.has('compare-folder')) return { model: serviceDiff(invertDiff((await ctx.api.fetchSkillsCompare(upstream, copy.artifactId)).diff)), partial: false };
  // An older server: SKILL.md alone, the copy's text against SynaBun's.
  const entry = (await ctx.api.fetchSkillsCatalogEntry(copy.artifactId)).entry;
  const shipped = await ctx.api.fetchSkillsRevisionFile(upstream, 'SKILL.md');
  return { model: textDiffModel('SKILL.md', lineDiff(entry.text || '', shipped.content || '')), partial: true };
}

async function loadUpdateDiff(host, ctx, key) {
  const { t } = ctx;
  const box = host.querySelector(`[data-update-box="${CSS.escape(key)}"]`);
  const row = ctx.rows.find((r) => r.key === key);
  if (!box || !row || box.dataset.loaded) return;
  box.dataset.loaded = '1';
  const gen = ctx.gen();
  try {
    const { model, partial } = await updateDiffModel(ctx, row);
    if (!ctx.alive(gen) || !box.isConnected) return;
    setHTML(box, html`${partial ? html`<p class="sx-note" role="note">${t('skillsStudio.review.partialDiff')}</p>` : ''}${diffHTML(t, model)}`);
  } catch (err) { if (box.isConnected) setHTML(box, html`<p class="sx-note sx-note--warn" role="alert">${t('skillsStudio.review.diffFailed', { error: studioErrorText(ctx.t, err) })}</p>`); }
}

/**
 * An update of a shipped skill, from its workspace banner: read it (`review`), or go install SynaBun's version
 * where the old copy is (`apply`: Publish, with those targets picked; the plan shows what it replaces, backed up).
 */
export async function reviewUpdateFlow(ctx, row, mode) {
  const { t } = ctx;
  if (mode === 'review') {
    const box = document.createElement('div');
    box.className = 'sx-diff-box';
    box.textContent = t('skillsStudio.review.loadingDiff');
    const shown = ctx.ask({ title: t('skillsStudio.review.updateDiffTitle', { name: row.folderName }), extra: box, wide: true, buttons: [{ id: 'close', label: t('skillsStudio.dialog.close'), kind: 'primary' }], cancelId: 'close' });
    try {
      const { model, partial } = await updateDiffModel(ctx, row);
      if (box.isConnected) setHTML(box, html`${partial ? html`<p class="sx-note" role="note">${t('skillsStudio.review.partialDiff')}</p>` : ''}${diffHTML(t, model)}`);
    } catch (err) { if (box.isConnected) box.textContent = t('skillsStudio.review.diffFailed', { error: studioErrorText(ctx.t, err) }); }
    await shown;
    return;
  }
  // What the update replaces is ticked: the folder each old copy is in, the target of each older installation (never
  // a second copy for a runtime that reads the first one). Handed to openRow, which starts Publish over with it before
  // Publish is drawn (set afterwards, it raced the reading Publish had already begun: "Cannot set properties of null").
  const update = row.update;
  const installations = row.skill?.installations || [];
  const preset = (pub, targets) => { pub.checked = new Set(updateTargetKeys(update, installations, targets)); };
  await ctx.openRow(row.key, { tab: 'publish', revisionId: update?.upstreamRevisionId || null, preset });
}

async function askReason(ctx, { title, prompt, required }) {
  const { t } = ctx;
  const wrap = document.createElement('div');
  wrap.className = 'sx-dlg-form';
  const label = document.createElement('label');
  label.className = 'sx-field-label';
  label.htmlFor = 'sx-reason';
  label.textContent = prompt;
  const area = document.createElement('textarea');
  area.id = 'sx-reason';
  area.className = 'sx-input sx-textarea';
  area.rows = 4;
  area.maxLength = 4000;
  const err = document.createElement('p');
  err.className = 'ss-dlg-error';
  err.setAttribute('role', 'alert');
  wrap.append(label, area, err);
  setTimeout(() => area.focus(), 0);
  const answer = await ctx.ask({
    title, extra: wrap,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'ok', label: t('skillsStudio.review.send'), kind: 'primary' }],
    focus: 'cancel',
    accept: (id) => { if (id === 'ok' && required && !area.value.trim()) { err.textContent = t('skillsStudio.review.reasonRequired'); return false; } return true; },
  });
  return answer === 'ok' ? area.value.trim() : null;
}

async function onClick(e, host, ctx) {
  const { t } = ctx;
  const filterBtn = e.target.closest?.('[data-review-filter]');
  if (filterBtn) { ctx.lib.reviewFilter = filterBtn.dataset.reviewFilter; ctx.render(); host.querySelector(`[data-review-filter="${filterBtn.dataset.reviewFilter}"]`)?.focus(); return; }
  const upd = e.target.closest?.('[data-update]');
  if (upd) {
    const row = ctx.rows.find((r) => r.key === upd.dataset.key);
    if (!row) return;
    if (upd.dataset.update === 'keep') { ctx.keepUpdate(row.folderName, row.update?.upstreamRevisionId); ctx.toast(t('skillsStudio.toast.keptMine', { name: row.folderName })); ctx.render(); }
    else reviewUpdateFlow(ctx, row, 'apply');
    return;
  }
  const btn = e.target.closest?.('[data-review]');
  if (!btn || btn.disabled) return;
  const review = (ctx.data?.reviews || []).find((r) => r.reviewId === btn.dataset.id);
  if (!review) return;
  const card = reviewCardModel(review);
  const action = btn.dataset.review;
  const row = ctx.rows.find((r) => r.skill?.skillId === review.skillId);
  if (action === 'open') { if (row) ctx.openRow(row.key, { tab: 'versions' }); return; }
  if (action === 'publish') { if (row) ctx.openRow(row.key, { tab: 'publish', revisionId: card.revisionId, reviewId: card.id }); return; }
  if (action === 'install' || action === 'approve_install') { await installFromCard(ctx, host, card, review, btn, { approve: action === 'approve_install' }); return; }
  if (installBusy(review.skillId) && action !== 'open') { ctx.toast(t('skillsStudio.publish.busyElsewhere'), 'error'); return; }
  let reason = '';
  if (action !== 'approve') {
    reason = await askReason(ctx, {
      title: t(action === 'reject' ? 'skillsStudio.review.rejectTitle' : 'skillsStudio.review.changesTitle', { name: card.name }),
      prompt: t(action === 'reject' ? 'skillsStudio.review.rejectPrompt' : 'skillsStudio.review.changesPrompt'),
      required: action === 'request_changes',
    });
    if (reason === null) return;
  }
  const gen = ctx.gen();
  btn.disabled = true;
  try {
    await ctx.api.decideSkillsReview(card.id, action, reason);
    if (!ctx.alive(gen)) return;
    ctx.toast(t(`skillsStudio.review.decided.${action}`, { name: card.name }));
    await ctx.reload();
  } catch (err) {
    if (!ctx.alive(gen)) return;
    btn.disabled = false;
    ctx.toast(t('skillsStudio.review.decideFailed', { error: studioErrorText(ctx.t, err) }), 'error');
  }
}

/**
 * Approve (when asked) and install to the targets the submission named, in one go; then the card says where it went
 * and what a running session needs, or why it did not go. Nothing is asked unless the plan asks it.
 */
async function installFromCard(ctx, host, card, review, btn, { approve }) {
  const { t } = ctx;
  const row = ctx.rows.find((r) => r.skill?.skillId === review.skillId) || null;
  // Where it goes is decided before anything is approved: nothing of what it named available here means no install
  // (and no approval from this button), never an install elsewhere.
  const dest = reviewTargets(ctx, { review, skill: row?.skill || null, row });
  if (!dest.targets.length) { ctx.toast(t('skillsStudio.review.noDestination'), 'error'); return; }
  // One install of a skill at a time, from whichever surface (the lock covers the approval too, and is let go
  // however this ends); while it is held every card and banner of the skill shows it as on its way.
  const release = acquireInstall(review.skillId);
  if (!release) { ctx.toast(t('skillsStudio.publish.busyElsewhere'), 'error'); return; }
  const gen = ctx.gen();
  let out = null;
  try {
    if (approve) {
      try { await ctx.api.decideSkillsReview(card.id, 'approve', ''); } catch (err) {
        if (ctx.alive(gen)) ctx.toast(t('skillsStudio.review.decideFailed', { error: studioErrorText(ctx.t, err) }), 'error');
        return;
      }
      if (!ctx.alive(gen)) return;
    }
    out = await installFlow(ctx, { revisionId: card.revisionId, targets: dest.targets, reviewId: card.id });
  } finally { release(); }
  if (!ctx.alive(gen) || out.status === 'gone') return;
  const words = flowWords(ctx, out);
  if (words) { _said.set(card.id, words); ctx.toast(words.line, words.kind); ctx.announce(words.line); }
  else if (approve) ctx.toast(t('skillsStudio.review.decided.approve', { name: card.name }));
  // The skill's open workspace reads it again: its header pill, banners and Publish say what the Library row says.
  if (out.status === 'done') await refreshSkillWorkspaces(ctx, review.skillId, { resetPublish: true });
  await ctx.reload();
}

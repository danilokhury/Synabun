// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the fix panel and "Fix safe issues"
// ═══════════════════════════════════════════
//
// A health pill of the Library (or of a workspace's head) opens the fix panel of its row: every problem in plain
// words, what each fix does, and its buttons (sx-fixes.js says which). The Library's attention notice offers
// "Fix safe issues…": every one-press repair is read first and listed (what will be added, which record archived),
// nothing is written until the owner applies that list, and what was done or not is said item by item.
// Every write is a Studio API call (X-SynaBun-UI): a library skill's text goes to its draft (PATCH /v2/drafts), an
// agent's file is saved over the revision it was read at, a second library record is archived (Restore brings it
// back). Install locations change only through Publish and the existing remove flows.

import { studioErrorText } from './sx-errors.js';
import { subjectOf } from './sx-subject.js';
import { issuesOf, planTextFix, safeFixCandidates, issueCounts, fingerprintOf } from './sx-fixes.js';
import { healthWords } from './sx-library-view.js';
import { HEAD } from './sx-docs.js';
import { createFrontmatter } from '../ss-frontmatter.js';
import { lintArtifact } from '../ss-lint.js';
import { html, setHTML, ICONS, healthIcon } from './sx-dom.js';

const YAML_MODULE = '/vendor/yaml/yaml-2.9.1.min.js';
let _fm = null;
const frontmatter = async () => (_fm ||= createFrontmatter(await import(YAML_MODULE)));

/** The most text repairs "Fix safe issues" reads in one go (each is one or two reads). */
export const MAX_TEXT_READS = 40;

/** What a row allows the fix panel to do. */
export function canOf(ctx, deleteKind) {
  return (row) => {
    const s = subjectOf(row, { guest: ctx.guest, caps: ctx.caps });
    const library = s.mode === 'library' && !!row.skill?.skillId;
    return {
      edit: !ctx.guest && !row.binary && (library || (s.mode === 'inplace' && !!s.v1Id && row.kind === 'agent')),
      open: true,
      delete: !!deleteKind?.(ctx, row, s),
      archive: !ctx.guest && (!ctx.capsKnown || ctx.caps.has('library-delete')),
      dismiss: !ctx.guest,
    };
  };
}

/**
 * Read a row's head file and the safe repair of it, without writing anything.
 * @returns {Promise<{ changes: object[], apply: () => Promise<void> } | null>} null: nothing safe to do
 */
export async function readTextFix(ctx, row) {
  const { api } = ctx;
  const s = subjectOf(row, { guest: ctx.guest, caps: ctx.caps });
  if (s.mode === 'inplace' && s.v1Id && row.kind === 'agent') {
    const got = await api.fetchSkillsArtifact(s.v1Id);
    if (got.binary || got.readOnly) return null;
    const plan = planTextFix({ raw: got.rawContent, diagnostics: got.diagnostics, type: 'agent', folderName: row.folderName });
    if (!plan) return null;
    return { changes: plan.changes, apply: () => api.saveSkillsArtifact(s.v1Id, plan.text, { expectedRevision: got.revision }) };
  }
  if (s.mode !== 'library' || !row.skill?.skillId) return null;
  const skill = (await api.fetchSkill(row.skill.skillId)).skill;
  let draft = null;
  if (skill.pointers?.draft) {
    try { draft = (await api.fetchSkillsDraft(skill.pointers.draft)).draft; } catch (err) { if (err?.status !== 404) throw err; }
  }
  const latest = skill.pointers?.latest || null;
  const file = draft ? await api.fetchSkillsDraftFile(draft.draftId, HEAD) : latest ? await api.fetchSkillsRevisionFile(latest, HEAD) : null;
  if (!file || typeof file.content !== 'string') return null;
  const fm = await frontmatter();
  const folderName = String(skill.name || row.folderName || '');
  const lint = lintArtifact({ type: 'skill', parsed: fm.parse(file.content), folderName });
  const plan = planTextFix({ raw: file.content, diagnostics: lint.all, type: 'skill', folderName });
  if (!plan) return null;
  return {
    changes: plan.changes,
    apply: async () => {
      const target = draft || (await api.createSkillsDraft({ skillId: skill.skillId, baseRevisionId: latest }, { idempotencyKey: ctx.key('fix-draft') })).draft;
      await api.patchSkillsDraft(target.draftId, { expectedEtag: target.etag, ops: [{ op: 'put', path: HEAD, content: plan.text }] });
    },
  };
}

/** Archive the second library record of a skill (Restore in the Archived view brings it back). */
const archiveRecord = (ctx, row) => ctx.api.deleteLibrarySkill(row.skill.skillId, row.skill.etag ? { expectedEtag: row.skill.etag } : {});

/** The words of a step of the preview. */
function stepWords(ctx, step) {
  const { t } = ctx;
  if (step.kind === 'archive') return t('skillsStudio.fix.step.archive', { name: step.row.label, original: step.issue.health.name || '' });
  return t('skillsStudio.fix.step.text', { name: step.row.label, added: step.changes.map((c) => c.added).join(' · ') });
}

/** Say what was done (a notice kept above the list until OK, a toast, the live region). */
function report(ctx, done, failed) {
  const { t, tp } = ctx;
  const line = failed.length ? t('skillsStudio.fix.resultPartial', { done: done.length, failed: failed.length, first: failed[0] }) : tp('skillsStudio.fix.resultDone', done.length);
  ctx.lib.fixNotice = { kind: failed.length ? 'warn' : 'info', line, lines: [...done, ...failed] };
  ctx.toast(line, failed.length ? 'error' : 'info');
  ctx.announce(line);
}

/**
 * "Fix safe issues…": read every candidate, list exactly what would change, apply only that list on the owner's word.
 * @param {object} ctx @param {object[]} rows the Library's rows @param {Function} deleteKind
 */
export async function fixAllSafe(ctx, rows, deleteKind) {
  const { t, tp } = ctx;
  const { steps } = safeFixCandidates(rows, canOf(ctx, deleteKind));
  const gen = ctx.gen();
  ctx.toast(t('skillsStudio.fix.reading'));
  const ready = []; const unreadable = [];
  let reads = 0;
  for (const step of steps) {
    if (step.kind !== 'text') { ready.push(step); continue; }
    if (reads++ >= MAX_TEXT_READS) break;
    try {
      const fix = await readTextFix(ctx, step.row);
      if (fix) ready.push({ ...step, changes: fix.changes, apply: fix.apply });
    } catch (err) { unreadable.push(`${step.row.label}: ${studioErrorText(t, err)}`); }
    if (!ctx.alive(gen)) return;
  }
  if (!ctx.alive(gen)) return;
  const list = document.createElement('ul');
  list.className = 'sx-fix-preview';
  for (const step of ready) {
    const li = document.createElement('li');
    li.className = 'sx-fix-preview-row';
    li.textContent = stepWords(ctx, step);
    list.append(li);
  }
  if (!ready.length) {
    await ctx.ask({ title: t('skillsStudio.fix.previewTitle'), lines: [t('skillsStudio.fix.previewNothing'), ...unreadable], buttons: [{ id: 'ok', label: t('skillsStudio.dialog.close'), kind: 'primary' }], cancelId: 'ok' });
    return;
  }
  const answer = await ctx.ask({
    title: t('skillsStudio.fix.previewTitle'),
    lines: [t('skillsStudio.fix.previewIntro'), ...unreadable],
    extra: list,
    wide: true,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'apply', label: tp('skillsStudio.fix.apply', ready.length), kind: 'primary' }],
    focus: 'apply',
  });
  if (answer !== 'apply' || !ctx.alive(gen)) return;
  const done = []; const failed = [];
  for (const step of ready) {
    try {
      if (step.kind === 'archive') await archiveRecord(ctx, step.row); else await step.apply();
      done.push(stepWords(ctx, step));
    } catch (err) { failed.push(`${step.row.label}: ${studioErrorText(t, err)}`); }
  }
  if (!ctx.alive(gen)) return;
  report(ctx, done, failed);
  await ctx.reload();
}

/** One issue as a card of the panel: its word, what it means, how it is fixed, and its buttons. */
function issueCard(ctx, row, issue, index) {
  const { t } = ctx;
  const card = document.createElement('section');
  card.className = `sx-fix-card sx-fix-card--${issue.sev}`;
  card.setAttribute('aria-labelledby', `sx-fix-${index}-title`);
  const head = document.createElement('div');
  head.className = 'sx-fix-card-head';
  setHTML(head, html`${healthIcon(issue.code)}<strong id="sx-fix-${index}-title">${healthWords(issue.health, t)}</strong><span class="sx-fix-mode sx-fix-mode--${issue.mode}">${issue.mode === 'auto' ? t('skillsStudio.fix.mode.auto') : t('skillsStudio.fix.mode.guided')}</span>`);
  const explain = document.createElement('p');
  explain.className = 'sx-fix-explain';
  explain.textContent = explainOf(ctx, row, issue);
  card.append(head, explain);
  const bar = document.createElement('div');
  bar.className = 'sx-fix-actions';
  for (const action of issue.actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sx-btn sx-btn--sm${action === 'dismiss' ? ' sx-btn--ghost' : action === 'delete' ? ' sx-btn--danger' : (action === 'auto-text' || action === 'archive-duplicate') ? ' sx-btn--primary' : ''}`;
    b.dataset.fix = `${index}:${action}`;
    b.textContent = t(`skillsStudio.fix.action.${action}`);
    bar.append(b);
  }
  if (!issue.actions.length) {
    const p = document.createElement('p');
    p.className = 'sx-dim';
    p.textContent = t('skillsStudio.fix.nothingHere');
    bar.append(p);
  }
  card.append(bar);
  return card;
}

/** What a problem means for this row, in plain words. */
export function explainOf(ctx, row, issue) {
  const { t } = ctx;
  const h = issue.health;
  const runtime = h.runtime ? t(`skillsStudio.runtime.${h.runtime}`) : '';
  switch (issue.code) {
    case 'shadowed': return t('skillsStudio.fix.explain.shadowed', { runtime: runtime || '—' });
    case 'twice': return t('skillsStudio.fix.explain.twice', { runtime: runtime || '—' });
    case 'same-description': return t('skillsStudio.fix.explain.same-description', { names: (h.names || []).join(', ') });
    case 'duplicate-record': return `${t('skillsStudio.fix.explain.duplicate-record', { original: h.name || '' })}${h.why ? ` ${t(`skillsStudio.fix.duplicateWhy.${h.why}`)}` : ''}`;
    default: return t(`skillsStudio.fix.explain.${issue.code}`);
  }
}

/**
 * The fix panel of one row. Resolves when the owner is done (a fix applied, a place opened, or closed).
 * @param {object} ctx @param {object} row @param {{ deleteKind: Function, bulkDelete: Function }} hooks
 */
export async function openFixPanel(ctx, row, { deleteKind, bulkDelete } = {}) {
  const { t } = ctx;
  const issues = issuesOf(row, canOf(ctx, deleteKind)(row));
  const box = document.createElement('div');
  box.className = 'sx-fix-panel';
  if (!issues.length) {
    const p = document.createElement('p');
    p.textContent = t('skillsStudio.fix.none');
    box.append(p);
  }
  issues.forEach((issue, i) => box.append(issueCard(ctx, row, issue, i)));
  const answer = await ctx.ask({
    title: t('skillsStudio.fix.title', { name: row.label }),
    lines: issues.length ? [t('skillsStudio.fix.intro')] : [],
    extra: box,
    wide: true,
    buttons: [{ id: 'close', label: t('skillsStudio.dialog.close') }],
    cancelId: 'close',
    onOpen: (ui) => box.addEventListener('click', (e) => { const b = e.target.closest?.('[data-fix]'); if (b) ui.done(b.dataset.fix); }),
  });
  if (!answer || answer === 'close') return;
  const [index, action] = [Number(answer.split(':')[0]), answer.split(':').slice(1).join(':')];
  const issue = issues[index];
  if (!issue) return;
  await runAction(ctx, row, issue, action, { bulkDelete });
}

async function runAction(ctx, row, issue, action, { bulkDelete }) {
  const { t, tp } = ctx;
  const gen = ctx.gen();
  try {
    switch (action) {
      case 'dismiss':
        ctx.dismissIssues([issue.fingerprint]);
        ctx.toast(t('skillsStudio.fix.dismissed'));
        return;
      case 'open-edit': ctx.openRow(row.key, { tab: 'edit' }); return;
      case 'open-publish': ctx.openRow(row.key, { tab: 'publish' }); return;
      case 'open-update': ctx.openRow(row.key); return;
      case 'keep-mine':
        ctx.keepUpdate(row.folderName, row.update?.upstreamRevisionId);
        ctx.toast(t('skillsStudio.toast.keptMine', { name: row.folderName }));
        ctx.render();
        return;
      case 'move-bridges': await ctx.openSkillFolders(); return;
      case 'delete':
        ctx.lib.selected = new Set([row.key]);
        await bulkDelete?.(ctx);
        return;
      case 'auto-text': {
        const fix = await readTextFix(ctx, row);
        if (!ctx.alive(gen)) return;
        if (!fix) {
          const go = await ctx.ask({ title: t('skillsStudio.fix.title', { name: row.label }), lines: [t('skillsStudio.fix.textNothing')], buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.close') }, { id: 'open', label: t('skillsStudio.fix.action.open-edit'), kind: 'primary' }], focus: 'open' });
          if (go === 'open') ctx.openRow(row.key, { tab: 'edit' });
          return;
        }
        const step = { kind: 'text', row, issue, changes: fix.changes };
        const ok = await ctx.ask({ title: t('skillsStudio.fix.previewTitle'), lines: [t('skillsStudio.fix.previewIntro'), stepWords(ctx, step), row.skill ? t('skillsStudio.fix.textToDraft') : t('skillsStudio.fix.textInPlace')], buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'apply', label: tp('skillsStudio.fix.apply', 1), kind: 'primary' }], focus: 'apply' });
        if (ok !== 'apply' || !ctx.alive(gen)) return;
        await fix.apply();
        report(ctx, [stepWords(ctx, step)], []);
        await ctx.reload();
        return;
      }
      case 'archive-duplicate': {
        const step = { kind: 'archive', row, issue };
        const ok = await ctx.ask({ title: t('skillsStudio.fix.previewTitle'), lines: [stepWords(ctx, step)], buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'apply', label: tp('skillsStudio.fix.apply', 1), kind: 'primary' }], focus: 'apply' });
        if (ok !== 'apply' || !ctx.alive(gen)) return;
        await archiveRecord(ctx, row);
        report(ctx, [stepWords(ctx, step)], []);
        await ctx.reload();
        return;
      }
      case 'choose-copy': await chooseCopy(ctx, row, issue); return;
      default: return;
    }
  } catch (err) {
    if (ctx.alive(gen)) ctx.toast(t('skillsStudio.fix.failed', { error: studioErrorText(t, err) }), 'error');
  }
}

/** Two records of one skill that differ: the owner picks the one that keeps the name; the other is archived. */
async function chooseCopy(ctx, row, issue) {
  const { t, tp } = ctx;
  const original = ctx.rows.find((r) => r.key === issue.health.of);
  const pair = [original, row].filter(Boolean);
  const archivable = (r) => !(r.skill?.installations || []).length && !r.review;
  const box = document.createElement('div');
  box.className = 'sx-fix-choose';
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', t('skillsStudio.fix.chooseTitle'));
  let picked = null;
  for (const r of pair) {
    const label = document.createElement('label');
    label.className = 'sx-fix-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'sx-fix-keep';
    input.value = r.key;
    // Keeping one archives the other: only a record that can be archived (not installed, not in review) may go.
    const other = pair.find((x) => x !== r);
    input.disabled = !other || !archivable(other);
    input.addEventListener('change', () => { picked = r.key; });
    const text = document.createElement('span');
    const versions = Number(r.skill?.revisions) || 0;
    const installs = (r.skill?.installations || []).length;
    text.textContent = t('skillsStudio.fix.keepThis', { name: r.label, versions: tp('skillsStudio.fix.versions', versions), installs: tp('skillsStudio.fix.installs', installs) });
    label.append(input, text);
    box.append(label);
  }
  if (!pair.some((r) => archivable(r))) {
    await ctx.ask({ title: t('skillsStudio.fix.chooseTitle'), lines: [t('skillsStudio.fix.chooseNone')], buttons: [{ id: 'ok', label: t('skillsStudio.dialog.close'), kind: 'primary' }], cancelId: 'ok' });
    return;
  }
  const answer = await ctx.ask({
    title: t('skillsStudio.fix.chooseTitle'),
    lines: [t('skillsStudio.fix.chooseIntro')],
    extra: box,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'keep', label: t('skillsStudio.fix.keepConfirm'), kind: 'primary' }],
    accept: () => !!picked,
  });
  if (answer !== 'keep' || !picked) return;
  const gone = pair.find((r) => r.key !== picked);
  await archiveRecord(ctx, gone);
  report(ctx, [t('skillsStudio.fix.step.archive', { name: gone.label, original: pair.find((r) => r.key === picked)?.label || '' })], []);
  await ctx.reload();
}

/** The Library's attention notice: how many problems, and "Fix safe issues…" / "Show them". */
export function fixNoticeHTML(ctx, deleteKind) {
  if (ctx.guest || ctx.lib.view === 'archived' || ctx.loading) return '';
  const { t, tp } = ctx;
  const out = [];
  const n = ctx.lib.fixNotice;
  if (n) {
    out.push(html`<div class="sx-notice sx-notice--${n.kind === 'info' ? 'info' : 'warn'}" role="status" data-notice-box="fix">
      ${n.kind === 'info' ? ICONS.ok : ICONS.warn}<span class="sx-notice-text">${n.line}${n.lines.slice(0, 8).map((l) => html`<span class="sx-block">${l}</span>`)}</span>
      <button type="button" class="sx-btn sx-btn--ghost" data-lib="fix-notice-ok">${t('skillsStudio.notice.ok')}</button>
    </div>`);
  }
  const counts = issueCounts(ctx.rows, canOf(ctx, deleteKind));
  if (counts.total) {
    const { steps } = safeFixCandidates(ctx.rows, canOf(ctx, deleteKind));
    out.push(html`<div class="sx-notice sx-notice--warn sx-fix-notice" role="note" data-notice-box="attention">
      ${ICONS.warn}<span class="sx-notice-text">${tp('skillsStudio.fix.notice', counts.total)}${steps.length ? ` ${tp('skillsStudio.fix.noticeSafe', steps.length)}` : ''}</span>
      ${steps.length ? html`<button type="button" class="sx-btn sx-btn--primary" data-lib="fix-all">${t('skillsStudio.fix.fixAll')}</button>` : ''}
      ${ctx.lib.health === 'attention' ? '' : html`<button type="button" class="sx-btn" data-lib="fix-show">${t('skillsStudio.fix.showIssues')}</button>`}
    </div>`);
  }
  return html`${out}`;
}

/** The unreadable folders of the catalog, said with what can be done: read again, or leave them (dismissed). */
export const unreadableFingerprint = (count) => fingerprintOf('library', { code: 'unreadable', count });

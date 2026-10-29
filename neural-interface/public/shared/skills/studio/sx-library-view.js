// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Library place
// ═══════════════════════════════════════════
//
// The table of every skill, agent and command (sx-library.js): name and description, kind, where it comes from,
// its health (a word and an icon, never a colour alone), which runtimes have it, and when it last changed. Search,
// filters with counts (the app's own dropdown, never a native one), a sort that puts what needs attention first,
// and bulk actions that say per item what they did. The keyboard moves through the rows with the arrows (one row
// in the tab order), Enter opens, Space selects. At a narrow window the rows are cards (CSS).

import { studioErrorText } from './sx-errors.js';
import { dropdownHTML, wireDropdowns } from '../../cc-dropdown.js';
import { searchLibrary, filterRows, sortRows, worstHealth, SORTS, KINDS, SOURCES, RUNTIMES, HEALTH_FILTERS } from './sx-library.js';
import { subjectOf } from './sx-subject.js';
import { installStatus } from './sx-install.js';
import { alsoInstall, alsoInstallNow } from './sx-install-flow.js';
import { html, raw, setHTML, ICONS, healthIcon, relativeTime, fullTime, rovingFocus, plural } from './sx-dom.js';
import { dropKept, dropDraft } from './sx-docs.js';
import { encodeArtifactId } from '../ss-ids.js';
import { revealHidden } from '../ss-unicode.js';

let _life = null;      // the listeners of the drawn header (filters): they end with the next drawing
let _lastChecked = null;

const RT_LETTER = { claude: 'C', codex: 'X', opencode: 'O' };
const DIAG_REASONS = ['no-skill-md', 'unreadable-head', 'link', 'too-deep', 'unreadable', 'outside-project', 'not-a-folder'];

/** Where a row comes from, in words: a label and a detail. */
export function sourceLabel(row, t) {
  const detail = (() => {
    switch (row.source) {
      case 'plugin': return row.copies > 1 ? plural(t, 'skillsStudio.source.pluginCopies', row.copies, { plugin: row.pluginId || '' }) : (row.pluginId || '');
      case 'project': return row.projectLabel || '';
      case 'mine': return row.accounts.filter((a) => a !== 'default').length ? plural(t, 'skillsStudio.source.accounts', row.accounts.length) : '';
      case 'library': return row.skill?.revisions ? plural(t, 'skillsStudio.source.libraryVersions', row.skill.revisions) : t('skillsStudio.source.libraryDraft');
      case 'synabun': return row.installedCopies?.length ? plural(t, 'skillsStudio.source.installedCopies', row.installedCopies.length) : '';
      default: return '';
    }
  })();
  const label = row.source === 'mine' && row.scope === 'user' ? t('skillsStudio.source.mine')
    : row.orphanBridge ? t('skillsStudio.source.legacyBridge')
    : t(`skillsStudio.source.${row.source}`);
  return { label, detail };
}

/** The words of a health item. */
export function healthWords(h, t) {
  switch (h.code) {
    case 'invalid': return plural(t, 'skillsStudio.health.invalid', h.count);
    case 'warnings': return plural(t, 'skillsStudio.health.warnings', h.count);
    case 'twice': return t('skillsStudio.health.twice');
    case 'shadowed': return t('skillsStudio.health.shadowed');
    case 'same-description': return t('skillsStudio.health.sameDescription');
    default: return t(`skillsStudio.health.${h.code}`);
  }
}

/** A health capsule: the worst item's word and icon, with the rest named in its title. */
/** Why a health item is there, for the capsule's title: which runtime does what, or which skills look the same. */
export function healthWhy(h, t) {
  const runtime = h.runtime ? t(`skillsStudio.runtime.${h.runtime}`) : '';
  if (h.code === 'shadowed' && runtime) return t('skillsStudio.health.shadowedWhy', { runtime });
  if (h.code === 'twice' && runtime) return t('skillsStudio.health.twiceWhy', { runtime });
  if (h.code === 'same-description' && h.names?.length) return t('skillsStudio.health.sameDescriptionWhy', { names: h.names.map((n) => revealHidden(String(n))).join(', ') });
  return '';
}

export function healthCapsule(row, t) {
  const worst = worstHealth(row);
  const rest = row.health.filter((h) => h !== worst && h.sev !== 'ok');
  const all = row.health.map((h) => { const why = healthWhy(h, t); return why ? `${healthWords(h, t)}: ${why}` : healthWords(h, t); }).join(' · ');
  return html`<span class="sx-health sx-health--${worst.sev}" title="${all}">${healthIcon(worst.code)}<span>${healthWords(worst, t)}</span>${rest.length ? html`<span class="sx-health-more">+${rest.length}</span>` : ''}</span>`;
}

/**
 * The one status of a library skill (sx-install.js installStatus) as a pill: draft, in review, changes asked for,
 * approved · not installed, installed (where, in its title), installed with an update, not installed. A button
 * when it opens something (`button`: the data-ws action).
 */
export function statusPill(status, ctx, { button = null, id = null } = {}) {
  const { t } = ctx;
  const where = status.where.map((w) => {
    const runtime = t(`skillsStudio.runtime.${['claude', 'codex', 'opencode', 'agents'].includes(w.runtime) ? w.runtime : 'claude'}`);
    if (w.scope === 'project') return t('skillsStudio.publish.targetProject', { runtime, project: ctx.projects?.find((p) => p.path === w.projectPath)?.label || w.projectPath || '' });
    if (w.accountId && w.accountId !== 'default') return t('skillsStudio.publish.targetAccount', { runtime, account: w.accountId });
    return t('skillsStudio.publish.targetUser', { runtime });
  });
  const runtimes = [...new Set(status.where.map((w) => t(`skillsStudio.runtime.${['claude', 'codex', 'opencode', 'agents'].includes(w.runtime) ? w.runtime : 'claude'}`)))].join(', ');
  const text = status.code === 'installed' ? t('skillsStudio.status.installed', { where: runtimes }) : status.code === 'outdated' ? t('skillsStudio.status.outdated', { where: runtimes }) : t(`skillsStudio.status.${status.code}`);
  const title = where.length ? where.join(', ') : t(`skillsStudio.status.help.${status.code}`);
  // Not installed is no tick: the dashed circle (healthIcon has no 'off' and would fall through to the tick).
  const icon = status.code === 'installed' ? healthIcon('ok') : status.code === 'outdated' ? healthIcon('update') : status.code === 'review' || status.code === 'changes' ? healthIcon('review') : status.code === 'draft' ? healthIcon('draft') : status.code === 'approved' ? ICONS.publish : ICONS.off;
  const inner = html`${icon}<span>${text}</span>`;
  return button
    ? html`<button type="button" class="sx-status sx-status--${status.code}" data-ws="${button}"${id ? html` id="${id}"` : ''} title="${title}">${inner}</button>`
    : html`<span class="sx-status sx-status--${status.code}"${id ? html` id="${id}"` : ''} title="${title}">${inner}</span>`;
}

/** The runtime capsules of a row (C X O), each named in full. */
export function runtimeCapsules(row, t) {
  return html`<span class="sx-rts">${RUNTIMES.map((rt) => {
    const st = row.runtimes[rt]?.state || 'none';
    const label = `${t(`skillsStudio.runtime.${rt}`)}: ${t(`skillsStudio.runtimeState.${st}`)}`;
    return html`<span class="sx-rt sx-rt--${st}" role="img" aria-label="${label}" title="${label}">${RT_LETTER[rt]}</span>`;
  })}</span>`;
}

const kindLabel = (row, t) => (row.kind === 'command' ? t('skillsStudio.kind.commandLegacy') : t(`skillsStudio.kind.${row.kind}`));

function filterHeadHTML(ctx) {
  const { t, lib, counts } = ctx;
  const c = counts || { kinds: {}, sources: {}, runtimes: {}, health: {}, total: 0 };
  const entries = (key, values, countOf, words) => [
    { value: 'all', label: t(`skillsStudio.library.filter.${key}All`), selected: lib[key] === 'all' || (key === 'health' && lib.health === 'any') },
    ...values.map((v) => ({ value: v, label: `${words(v)} · ${countOf[v] ?? 0}`, selected: lib[key] === v })),
  ];
  const kind = entries('kind', KINDS, c.kinds, (v) => (v === 'command' ? t('skillsStudio.kind.commandLegacy') : t(`skillsStudio.kind.${v}`)));
  const source = entries('source', SOURCES, c.sources, (v) => t(`skillsStudio.source.${v}`));
  const runtime = entries('runtime', RUNTIMES, c.runtimes, (v) => t(`skillsStudio.runtime.${v}`));
  const health = [{ value: 'any', label: t('skillsStudio.library.filter.healthAll'), selected: lib.health === 'any' }, ...HEALTH_FILTERS.map((v) => ({ value: v, label: `${t(`skillsStudio.library.healthFilter.${v}`)} · ${c.health[v] ?? 0}`, selected: lib.health === v }))];
  const sort = SORTS.map((v) => ({ value: v, label: t(`skillsStudio.library.sort.${v}`), selected: lib.sort === v }));
  const dd = (id, label, list) => html`<div class="sx-filter"><span class="sx-filter-key" id="${id}-label">${label}</span>${raw(dropdownHTML(id, list, { labelledBy: `${id}-label`, classes: 'sx-dd' }))}</div>`;
  return html`
    <div class="sx-place-head">
      <h3 class="sx-place-title" id="sx-lib-title" tabindex="-1">${t('skillsStudio.library.title')}</h3>
      <div class="sx-search">
        ${ICONS.search}
        <label class="sx-sr" for="sx-lib-search">${t('skillsStudio.library.searchLabel')}</label>
        <input id="sx-lib-search" type="search" autocomplete="off" spellcheck="false" placeholder="${t('skillsStudio.library.searchPlaceholder')}" value="${lib.q}" data-autofocus>
      </div>
      ${dd('sx-f-kind', t('skillsStudio.library.filter.kind'), kind)}
      ${dd('sx-f-source', t('skillsStudio.library.filter.source'), source)}
      ${dd('sx-f-runtime', t('skillsStudio.library.filter.runtime'), runtime)}
      ${dd('sx-f-health', t('skillsStudio.library.filter.health'), health)}
      <span class="sx-spacer"></span>
      ${dd('sx-f-sort', t('skillsStudio.library.sort.label'), sort)}
      ${ctx.guest ? '' : html`<button type="button" class="sx-btn sx-btn--primary" data-lib="new">${ICONS.plus}<span>${t('skillsStudio.library.new')}</span></button>`}
    </div>`;
}

/** Whether the server reads when each skill changed (catalog `updatedAt`): a server older than the page does not. */
const knowsUpdated = (ctx) => !ctx.capsKnown || ctx.caps.has('catalog-updated');

function rowHTML(row, ctx, selected, first) {
  const { t, locale } = ctx;
  const src = sourceLabel(row, t);
  const name = row.label;
  const description = row.shownDescription;
  const updated = row.updatedAt ? relativeTime(row.updatedAt, locale) : '';
  const unknown = knowsUpdated(ctx) ? t('skillsStudio.library.unknownDate') : t('skillsStudio.library.unknownDateRestart');
  return html`<tr class="sx-lib-row${selected ? ' is-selected' : ''}" data-key="${row.key}">
    <td class="sx-col-check"><input type="checkbox" class="sx-check" data-check="${row.key}" tabindex="-1"${selected ? ' checked' : ''} aria-label="${t('skillsStudio.library.select', { name })}"></td>
    <td class="sx-col-name">
      <button type="button" class="sx-name-btn" data-open="${row.key}" tabindex="${first ? '0' : '-1'}" aria-describedby="sx-desc-${row.key.replace(/[^A-Za-z0-9_-]/g, '_')}">${name}</button>
      <span class="sx-desc" id="sx-desc-${row.key.replace(/[^A-Za-z0-9_-]/g, '_')}" title="${description}">${description || t('skillsStudio.library.noDescription')}</span>
    </td>
    <td class="sx-col-kind">${kindLabel(row, t)}</td>
    <td class="sx-col-source"><span class="sx-source">${src.label}</span>${src.detail ? html`<span class="sx-source-detail" title="${src.detail}">${src.detail}</span>` : ''}</td>
    <td class="sx-col-health">${healthCellHTML(row, ctx)}</td>
    <td class="sx-col-rt">${runtimeCapsules(row, t)}</td>
    <td class="sx-col-updated">${updated ? html`<time datetime="${row.updatedAt}" title="${fullTime(row.updatedAt, locale)}">${updated}</time>` : html`<span class="sx-dim" role="img" aria-label="${unknown}" title="${unknown}">—</span>`}</td>
  </tr>`;
}

/**
 * The health cell: a library skill shows its one status (the same as its workspace header) and its health only when
 * something is wrong, with Install when it is approved and not installed yet; the rest shows its health.
 */
function healthCellHTML(row, ctx) {
  const { t } = ctx;
  const status = installStatus({ skill: row.skill, row });
  if (!status) return healthCapsule(row, t);
  const worst = worstHealth(row);
  // Installed for one assistant and not the others in effect: one press from the row adds them.
  const also = ['installed', 'outdated'].includes(status.code) && !ctx.guest ? alsoInstall(ctx, { skill: row.skill, row }) : { targets: [], words: '' };
  return html`<span class="sx-health-cell">${statusPill(status, ctx)}${worst.sev === 'err' || worst.sev === 'warn' ? healthCapsule(row, t) : ''}${status.code === 'approved' && !ctx.guest ? html`<button type="button" class="sx-btn sx-btn--sm sx-btn--primary" data-install="${row.key}" tabindex="-1" title="${t('skillsStudio.library.installHelp')}">${t('skillsStudio.library.install')}</button>` : ''}${also.targets.length ? html`<button type="button" class="sx-btn sx-btn--sm" data-also-install="${row.key}" tabindex="-1" title="${t('skillsStudio.library.alsoInstallHelp')}">${t('skillsStudio.library.alsoInstall', { targets: also.words })}</button>` : ''}</span>`;
}

/**
 * The start-up move of the old Codex prompt / OpenCode command bridges (lib/skills/migration.js autoMigrate), said
 * once: what moved, with Undo (the bridges come back, the folders it made go) and OK; and the bridge files of shipped
 * skills that SynaBun did not move by itself because they are not proven its own, each with "Move it too" (the owner
 * confirms exactly those bytes). Drawn from GET /v2/migrations/notice (read with the Library); nothing on an older server.
 */
export function migrationNoticeHTML(ctx) {
  const n = ctx.data?.notice;
  if (!n || ctx.guest) return '';
  const { t, tp } = ctx;
  const out = [];
  if (n.pending) {
    const label = (m) => `${t(`skillsStudio.runtime.${['claude', 'codex', 'opencode'].includes(m.runtime) ? m.runtime : 'claude'}`)} /${m.name}`;
    const moved = (n.pending.migrated || []).map(label);
    // Moved by itself because its bytes were exactly an earlier SynaBun version's bridge (proof generated-previous).
    const earlier = (n.pending.migrated || []).filter((m) => m.proof === 'generated-previous').map(label);
    const failed = (n.pending.notMoved || []).map((m) => `/${m.name}`);
    out.push(html`<div class="sx-notice sx-notice--info" role="status" data-notice-box="auto">
      ${ICONS.ok}<span class="sx-notice-text">${tp('skillsStudio.notice.autoMoved', moved.length, { names: moved.join(', ') })}${earlier.length ? ` ${tp('skillsStudio.notice.autoEarlier', earlier.length, { names: earlier.join(', ') })}` : ''} ${t('skillsStudio.notice.autoWhy')}${failed.length ? ` ${tp('skillsStudio.notice.autoNotMoved', failed.length, { names: failed.join(', ') })}` : ''}</span>
      <button type="button" class="sx-btn" data-notice="undo" data-journal="${n.pending.journalId}">${t('skillsStudio.notice.undo')}</button>
      <button type="button" class="sx-btn sx-btn--ghost" data-notice="dismiss">${t('skillsStudio.notice.ok')}</button>
    </div>`);
  }
  for (const o of n.offers || []) {
    const runtime = t(`skillsStudio.runtime.${['claude', 'codex', 'opencode'].includes(o.runtime) ? o.runtime : 'claude'}`);
    out.push(html`<div class="sx-notice sx-notice--warn" role="note" data-notice-box="offer" data-bridge="${o.bridgeId}">
      ${ICONS.warn}<span class="sx-notice-text">${t('skillsStudio.notice.offer', { runtime, name: `/${o.name}`, path: shortPath(o.path) })}</span>
      <button type="button" class="sx-btn" data-notice="move" data-bridge="${o.bridgeId}" data-digest="${o.digest}">${t('skillsStudio.notice.moveToo')}</button>
    </div>`);
  }
  return html`${out}`;
}

/**
 * What the row's "Also install for …" did, kept above the list until OK: where it went and, per runtime, what a
 * session needs to see it (SynaBun's own panels list it at once; a terminal session needs a new one). A toast alone
 * would be gone before those lines are read.
 */
function installNoticeHTML(ctx) {
  const n = ctx.lib.installNotice;
  if (!n || ctx.guest) return '';
  return html`<div class="sx-notice sx-notice--${n.kind === 'info' ? 'info' : 'warn'}" role="status" data-notice-box="install">
    ${n.kind === 'info' ? ICONS.ok : ICONS.warn}<span class="sx-notice-text"><strong>${n.name}</strong>: ${n.line}${n.lines.map((l) => html`<span class="sx-block">${l}</span>`)}</span>
    <button type="button" class="sx-btn sx-btn--ghost" data-lib="install-notice-ok">${ctx.t('skillsStudio.notice.ok')}</button>
  </div>`;
}

/** The home folder as ~ (the full path stays in the element's title). */
function shortPath(path) { return String(path || '').replace(/^\/Users\/[^/]+(?=\/)/, '~').replace(/^\/home\/[^/]+(?=\/)/, '~'); }

/** A button of the start-up move's notice: Undo, OK, or Move it too (a confirmed move: the plan with the confirmation, then exactly that plan). */
async function onNoticeAction(btn, ctx) {
  const { t } = ctx;
  const act = btn.dataset.notice;
  const box = btn.closest('[data-notice-box]');
  for (const b of box?.querySelectorAll('button') || []) b.disabled = true;
  const gen = ctx.gen();
  try {
    if (act === 'dismiss') { await ctx.api.dismissSkillsMigrationNotice(); }
    else if (act === 'undo') {
      const out = await ctx.api.revertSkillsMigration(btn.dataset.journal);
      if (ctx.alive(gen)) ctx.toast(out.status === 'reverted' ? t('skillsStudio.notice.undone') : t('skillsStudio.notice.undonePartly'), out.status === 'reverted' ? 'info' : 'error');
    } else if (act === 'move') {
      const confirm = { [btn.dataset.bridge]: btn.dataset.digest };
      const planned = await ctx.api.planSkillsBridgeMigrationConfirmed(confirm);
      const out = await ctx.api.runSkillsBridgeMigration(planned.plan.planDigest, confirm);
      if (ctx.alive(gen)) ctx.toast(out.status === 'done' ? t('skillsStudio.notice.moved') : t('skillsStudio.notice.movedPartly'), out.status === 'done' ? 'info' : 'error');
    }
  } catch (err) {
    if (ctx.alive(gen)) ctx.toast(t('skillsStudio.notice.failed', { error: studioErrorText(ctx.t, err) }), 'error');
  }
  if (ctx.alive(gen)) ctx.reload();
}

function keptNoticeHTML(ctx) {
  const kept = Object.entries(ctx.keptDrafts()).filter(([, d]) => !ctx.workspaces.has(d.wsKey));
  if (!kept.length) return '';
  const known = kept.filter(([, d]) => ctx.rows.some((r) => r.key === d.wsKey));
  // Named whether or not their skill is listed now (one deleted, or from another data home): only those listed reopen.
  const names = [...new Set([...known, ...kept.filter((k) => !known.includes(k))].map(([, d]) => String(d.name || d.label || d.path || '?')))].slice(0, 4);
  return html`<div class="sx-notice sx-notice--info" role="status">
    ${ICONS.draft}<span class="sx-notice-text">${ctx.tp('skillsStudio.library.kept', kept.length, { names: names.join(', ') })}</span>
    ${known.length ? html`<button type="button" class="sx-btn" data-lib="kept-reopen">${ctx.t('skillsStudio.library.keptReopen')}</button>` : ''}
    <button type="button" class="sx-btn sx-btn--ghost" data-lib="kept-discard">${ctx.t('skillsStudio.library.keptDiscard')}</button>
  </div>`;
}

function summaryHTML(ctx, shown) {
  const { t, tp, counts, data } = ctx;
  const total = counts?.total ?? 0;
  const parts = [t('skillsStudio.library.shown', { shown: shown.length, total })];
  if (counts?.views?.attention) parts.push(tp('skillsStudio.library.attentionCount', counts.views.attention));
  const diag = data?.catalog?.diagnostics || [];
  // A server older than the page reads no change times: the dashes are said once, with what brings them.
  const restart = knowsUpdated(ctx) ? '' : html` · <span class="sx-note-warn" id="sx-lib-updated-restart">${t('skillsStudio.library.updatedRestart')}</span>`;
  return html`<p class="sx-summary" role="status">${parts.join(' · ')}${diag.length ? html` · <button type="button" class="sx-link" data-lib="diagnostics">${tp('skillsStudio.library.diagnostics', diag.length)}</button>` : ''}${data?.catalog?.truncated ? html` · <span class="sx-warn-text">${t('skillsStudio.library.truncated')}</span>` : ''}${restart}</p>`;
}

/**
 * What a bulk Delete does with a row: `disk` removes it from where it is (an agent, a command, a folder of the
 * owner's not in the library), `library` takes a library skill out of the library (a folder it came from stays; one
 * installed somewhere is left out: its installations are removed in Publish first), null leaves it.
 */
export function deleteKind(ctx, row, s) {
  if (ctx.guest) return null;
  if ((s.mode === 'inplace' || s.mode === 'adopt') && s.v1Id) return 'disk';
  if (s.mode === 'library' && row.skill?.skillId && row.skill.origin?.kind !== 'bundled' && !(row.skill.installations || []).length && ctx.caps.has('library-delete')) return 'library';
  return null;
}

function bulkHTML(ctx, rows) {
  const { t, tp, lib } = ctx;
  if (!lib.selected.size || ctx.guest) return '';
  const chosen = rows.filter((r) => lib.selected.has(r.key));
  const subjects = chosen.map((r) => ({ row: r, s: subjectOf(r, { guest: ctx.guest, caps: ctx.caps }) }));
  const adoptable = subjects.filter((x) => x.s.mode === 'adopt').length;
  const exportable = subjects.filter((x) => x.s.v1Id || (x.row.skill?.latest && ctx.caps.has('export'))).length;
  const deletable = subjects.filter((x) => deleteKind(ctx, x.row, x.s)).length;
  return html`<div class="sx-bulk" role="region" aria-label="${t('skillsStudio.library.bulk.region')}">
    <span class="sx-bulk-count">${tp('skillsStudio.library.bulk.selected', lib.selected.size)}</span>
    <button type="button" class="sx-btn" data-lib="bulk-adopt"${adoptable ? '' : ' disabled'} title="${t('skillsStudio.library.bulk.adoptHelp')}">${t('skillsStudio.library.bulk.adopt', { count: adoptable })}</button>
    <button type="button" class="sx-btn" data-lib="bulk-export"${exportable ? '' : ' disabled'}>${ICONS.download}<span>${t('skillsStudio.library.bulk.export', { count: exportable })}</span></button>
    <button type="button" class="sx-btn sx-btn--danger" data-lib="bulk-delete"${deletable ? '' : ' disabled'}>${ICONS.trash}<span>${t('skillsStudio.library.bulk.delete', { count: deletable })}</span></button>
    <button type="button" class="sx-btn sx-btn--ghost" data-lib="bulk-clear">${t('skillsStudio.library.bulk.clear')}</button>
  </div>`;
}

/** The Archived view: the skills deleted from the library, each with Restore (its versions never left). */
function archivedHTML(ctx) {
  const { t, locale } = ctx;
  const list = Array.isArray(ctx.data?.archived) ? ctx.data.archived : [];
  if (!list.length) return html`<div class="sx-empty"><h4 class="sx-empty-title">${t('skillsStudio.library.archivedTitle')}</h4><p>${t('skillsStudio.library.archivedEmpty')}</p></div>`;
  return html`<section class="sx-archived" aria-labelledby="sx-archived-title">
    <h4 class="sx-section-title" id="sx-archived-title">${t('skillsStudio.library.archivedTitle')}</h4>
    <p class="sx-help">${t('skillsStudio.library.archivedHelp')}</p>
    <ul class="sx-installs sx-archived-list">${list.map((a) => html`<li class="sx-install-row" data-archived="${a.skillId}">
      <span class="sx-install-where"><strong>${revealHidden(String(a.name || a.skillId))}</strong></span>
      <span class="sx-dim">${t('skillsStudio.library.archivedWhen', { when: relativeTime(a.archivedAt, locale), by: a.archivedBy || 'owner' })} · ${plural(t, 'skillsStudio.library.archivedVersions', Number(a.revisions) || 0)}</span>
      ${ctx.guest ? '' : html`<span class="sx-install-actions"><button type="button" class="sx-btn sx-btn--sm sx-btn--primary" data-restore="${a.skillId}">${t('skillsStudio.library.restore')}</button></span>`}
    </li>`)}</ul>
  </section>`;
}

/** The row's "Also install for …": one press, the installed version to the assistants that lack it. */
async function onAlsoInstall(btn, host, ctx) {
  const row = ctx.rows.find((r) => r.key === btn.dataset.alsoInstall);
  if (!row?.skill) return;
  btn.disabled = true;
  const gen = ctx.gen();
  const words = await alsoInstallNow(ctx, { skill: row.skill, row });
  if (!ctx.alive(gen)) return;
  if (words) {
    ctx.lib.installNotice = { kind: words.kind, name: row.name || row.skill.name || '', line: words.line, lines: Array.isArray(words.lines) ? words.lines : [] };
    ctx.toast(words.line, words.kind);
    ctx.announce([words.line, ...ctx.lib.installNotice.lines].join(' '));
  }
  ctx.reload();
}

/** Restore from the Archived view: the record and its draft are back, the versions never left. */
async function onRestore(btn, host, ctx) {
  const { t } = ctx;
  btn.disabled = true;
  const gen = ctx.gen();
  try {
    const out = await ctx.api.restoreSkillsSkill(btn.dataset.restore);
    if (!ctx.alive(gen)) return;
    ctx.toast(t('skillsStudio.library.restored', { name: out.name || '' }));
    ctx.announce(t('skillsStudio.library.restored', { name: out.name || '' }));
  } catch (err) {
    if (!ctx.alive(gen)) return;
    ctx.toast(t('skillsStudio.library.restoreFailed', { error: studioErrorText(ctx.t, err) }), 'error');
  }
  ctx.reload();
}

function tableHTML(ctx, shown) {
  const { t, lib } = ctx;
  if (lib.view === 'archived') return archivedHTML(ctx);
  if (ctx.loading) return html`<div class="sx-empty" role="status"><p>${t('skillsStudio.library.loading')}</p></div>`;
  if (ctx.loadError && !ctx.rows.length) {
    return html`<div class="sx-empty" role="alert"><h4 class="sx-empty-title">${t('skillsStudio.library.loadFailed')}</h4><p class="sx-dim">${studioErrorText(ctx.t, ctx.loadError)}</p><button type="button" class="sx-btn" data-lib="retry">${t('skillsStudio.shell.retry')}</button></div>`;
  }
  if (!ctx.rows.length) {
    return html`<div class="sx-empty"><h4 class="sx-empty-title">${t('skillsStudio.library.emptyTitle')}</h4><p>${t('skillsStudio.library.emptyHelp')}</p>${ctx.guest ? '' : html`<button type="button" class="sx-btn sx-btn--primary" data-lib="new">${t('skillsStudio.library.new')}</button>`}</div>`;
  }
  if (!shown.length) {
    return html`<div class="sx-empty"><h4 class="sx-empty-title">${t('skillsStudio.library.noMatchTitle')}</h4><p>${t('skillsStudio.library.noMatchHelp')}</p><button type="button" class="sx-btn" data-lib="clear-filters">${t('skillsStudio.library.clearFilters')}</button></div>`;
  }
  const allChecked = shown.every((r) => lib.selected.has(r.key));
  return html`<table class="sx-lib">
    <caption class="sx-sr">${t('skillsStudio.library.caption')}</caption>
    <thead><tr>
      <th class="sx-col-check" scope="col"><input type="checkbox" class="sx-check" data-check-all="1"${allChecked ? ' checked' : ''} aria-label="${t('skillsStudio.library.selectAll')}"${ctx.guest ? ' disabled' : ''}></th>
      <th class="sx-col-name" scope="col">${t('skillsStudio.library.col.name')}</th>
      <th class="sx-col-kind" scope="col">${t('skillsStudio.library.col.kind')}</th>
      <th class="sx-col-source" scope="col">${t('skillsStudio.library.col.source')}</th>
      <th class="sx-col-health" scope="col">${t('skillsStudio.library.col.health')}</th>
      <th class="sx-col-rt" scope="col">${t('skillsStudio.library.col.runtimes')}</th>
      <th class="sx-col-updated" scope="col">${t('skillsStudio.library.col.updated')}</th>
    </tr></thead>
    <tbody>${shown.map((r, i) => rowHTML(r, ctx, lib.selected.has(r.key), lib.focus ? r.key === lib.focus : i === 0))}</tbody>
  </table>`;
}

const visible = (ctx) => sortRows(filterRows(ctx.rows, ctx.lib), ctx.lib.sort);

/** Draw the Library place. */
/** The Library is left for another place: its listeners on the shared main area end. */
export function leaveLibraryPlace() { _life?.abort(); _life = null; }

export function renderLibraryPlace(host, ctx) {
  _life?.abort();
  _life = new AbortController();
  const signal = _life.signal;
  const shown = visible(ctx);
  setHTML(host, html`<section class="sx-place sx-place--library" aria-labelledby="sx-lib-title">
    ${filterHeadHTML(ctx)}
    <div class="sx-place-notices">${installNoticeHTML(ctx)}${migrationNoticeHTML(ctx)}${keptNoticeHTML(ctx)}${updateNoticeHTML(ctx)}</div>
    <div class="sx-place-scroll" id="sx-lib-scroll">
      <div id="sx-lib-summary">${summaryHTML(ctx, shown)}</div>
      <div id="sx-lib-table">${tableHTML(ctx, shown)}</div>
    </div>
    <div id="sx-lib-bulk">${bulkHTML(ctx, shown)}</div>
  </section>`);
  wireDropdowns(host, { signal });
  for (const [id, key] of [['sx-f-kind', 'kind'], ['sx-f-source', 'source'], ['sx-f-runtime', 'runtime'], ['sx-f-health', 'health'], ['sx-f-sort', 'sort']]) {
    host.querySelector(`#${id}`)?.addEventListener('change', (e) => {
      ctx.lib[key] = e.target.value;
      if (key !== 'sort') ctx.lib.view = 'all';
      ctx.saveLibraryView();
      redrawRows(host, ctx);
    }, { signal });
  }
  const search = host.querySelector('#sx-lib-search');
  search?.addEventListener('input', () => { const starting = !ctx.lib.q.trim() && search.value.trim(); searchLibrary(ctx.lib, search.value); ctx.saveLibraryView(); if (starting) ctx.render({ keepFocus: true }); else redrawRows(host, ctx); }, { signal });
  host.addEventListener('click', (e) => onClick(e, host, ctx), { signal });
  host.addEventListener('change', (e) => onCheck(e, host, ctx), { signal });
  host.addEventListener('keydown', (e) => onRowKey(e, host, ctx), { signal });
  const table = host.querySelector('#sx-lib-table');
  if (table) rovingFocus(table, '.sx-name-btn', { signal, onMove: (el) => { ctx.lib.focus = el.dataset.open; el.closest('tr')?.scrollIntoView({ block: 'nearest' }); } });
}

/** The table, its summary and the bulk bar again, after a filter or the selection changed (the header stays). */
function redrawRows(host, ctx) {
  const shown = visible(ctx);
  setHTML(host.querySelector('#sx-lib-summary'), summaryHTML(ctx, shown));
  setHTML(host.querySelector('#sx-lib-table'), tableHTML(ctx, shown));
  setHTML(host.querySelector('#sx-lib-bulk'), bulkHTML(ctx, shown));
  const table = host.querySelector('#sx-lib-table');
  if (table) rovingFocus(table, '.sx-name-btn', { signal: _life?.signal, onMove: (el) => { ctx.lib.focus = el.dataset.open; } });
  ctx.announce(ctx.t('skillsStudio.library.shown', { shown: shown.length, total: ctx.counts?.total ?? 0 }));
}

/** Put the keyboard in the Library's search field (⌘/Ctrl+P). */
export function focusLibrary(panel) {
  requestAnimationFrame(() => panel?.querySelector('#sx-lib-search')?.focus());
}

function updateNoticeHTML(ctx) {
  if (!ctx.updates.length || ctx.lib.view !== 'all') return '';
  return html`<div class="sx-notice sx-notice--info" role="status">${ICONS.update}<span class="sx-notice-text">${ctx.tp('skillsStudio.library.updatesNotice', ctx.updates.length, { names: ctx.updates.map((u) => u.name).join(', ') })}</span>
    <button type="button" class="sx-btn" data-act="place" data-place="review">${ctx.t('skillsStudio.library.reviewUpdates')}</button></div>`;
}

async function onClick(e, host, ctx) {
  const notice = e.target.closest?.('[data-notice]');
  if (notice && !notice.disabled) { onNoticeAction(notice, ctx); return; }
  const install = e.target.closest?.('[data-install]');
  if (install && host.contains(install)) { ctx.lib.focus = install.dataset.install; ctx.openRow(install.dataset.install, { tab: 'publish' }); return; }
  const also = e.target.closest?.('[data-also-install]');
  if (also && host.contains(also) && !also.disabled) { onAlsoInstall(also, host, ctx); return; }
  const restore = e.target.closest?.('[data-restore]');
  if (restore && host.contains(restore) && !restore.disabled) { onRestore(restore, host, ctx); return; }
  const open = e.target.closest?.('[data-open]');
  if (open && host.contains(open)) { ctx.lib.focus = open.dataset.open; ctx.openRow(open.dataset.open); return; }
  const btn = e.target.closest?.('[data-lib]');
  if (!btn || !host.contains(btn) || btn.disabled) return;
  const act = btn.dataset.lib;
  if (act === 'new') ctx.goPlace('create');
  else if (act === 'retry') ctx.reload();
  else if (act === 'install-notice-ok') { ctx.lib.installNotice = null; ctx.render(); }
  else if (act === 'clear-filters') { Object.assign(ctx.lib, { view: 'all', kind: 'all', source: 'all', runtime: 'all', health: 'any', q: '' }); ctx.saveLibraryView(); ctx.render(); }
  else if (act === 'bulk-clear') { ctx.lib.selected.clear(); redrawRows(host, ctx); }
  else if (act === 'diagnostics') showDiagnostics(ctx);
  else if (act === 'kept-reopen') reopenKept(ctx);
  else if (act === 'kept-discard') discardKept(ctx);
  else if (act === 'bulk-adopt') bulkAdopt(ctx);
  else if (act === 'bulk-export') bulkExport(ctx);
  else if (act === 'bulk-delete') bulkDelete(ctx);
}

function onCheck(e, host, ctx) {
  const box = e.target;
  if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') return;
  const shown = visible(ctx);
  if (box.dataset.checkAll) {
    if (box.checked) for (const r of shown) ctx.lib.selected.add(r.key); else for (const r of shown) ctx.lib.selected.delete(r.key);
  } else if (box.dataset.check) {
    const key = box.dataset.check;
    // Shift-click selects every row between the last one ticked and this one.
    if (e.shiftKey && _lastChecked) {
      const keys = shown.map((r) => r.key);
      const [a, b] = [keys.indexOf(_lastChecked), keys.indexOf(key)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) for (const k of keys.slice(a, b + 1)) { if (box.checked) ctx.lib.selected.add(k); else ctx.lib.selected.delete(k); }
    } else if (box.checked) ctx.lib.selected.add(key); else ctx.lib.selected.delete(key);
    _lastChecked = key;
  } else return;
  const focusKey = box.dataset.check;
  redrawRows(host, ctx);
  if (focusKey) host.querySelector(`[data-check="${CSS.escape(focusKey)}"]`)?.focus();
}

function onRowKey(e, host, ctx) {
  const btn = e.target.closest?.('.sx-name-btn');
  if (!btn || e.key !== ' ' || ctx.guest) return;
  e.preventDefault();
  const key = btn.dataset.open;
  if (ctx.lib.selected.has(key)) ctx.lib.selected.delete(key); else ctx.lib.selected.add(key);
  ctx.lib.focus = key;
  redrawRows(host, ctx);
  host.querySelector(`.sx-name-btn[data-open="${CSS.escape(key)}"]`)?.focus();
}

// ── Notices and bulk actions ──

async function showDiagnostics(ctx) {
  const { t } = ctx;
  const diag = ctx.data?.catalog?.diagnostics || [];
  const list = document.createElement('ul');
  list.className = 'sx-plain-list';
  for (const d of diag.slice(0, 50)) {
    const li = document.createElement('li');
    const key = `skillsStudio.library.diagReason.${d.reason}`;
    const reason = DIAG_REASONS.includes(d.reason) ? t(key) : (d.message || d.reason || '');
    li.textContent = `${d.path || t('skillsStudio.library.diagRoot')}: ${reason}`;
    li.title = d.message || '';
    list.append(li);
  }
  await ctx.ask({ title: t('skillsStudio.library.diagnosticsTitle'), lines: [t('skillsStudio.library.diagnosticsHelp')], extra: list, buttons: [{ id: 'ok', label: t('skillsStudio.dialog.close'), kind: 'primary' }], cancelId: 'ok', wide: true });
}

async function reopenKept(ctx) {
  const kept = Object.values(ctx.keptDrafts()).filter((d) => !ctx.workspaces.has(d.wsKey) && ctx.rows.some((r) => r.key === d.wsKey));
  const first = kept[0];
  if (!first) return;
  await ctx.openRow(first.wsKey, { tab: 'edit', file: first.path });
  const others = new Set(kept.slice(1).map((d) => d.wsKey));
  if (others.size) ctx.toast(ctx.tp('skillsStudio.library.keptMore', others.size));
}

async function discardKept(ctx) {
  const { t, tp } = ctx;
  const kept = Object.entries(ctx.keptDrafts()).filter(([, d]) => !ctx.workspaces.has(d.wsKey));
  const answer = await ctx.ask({
    title: t('skillsStudio.library.keptDiscardTitle'),
    lines: [tp('skillsStudio.library.keptDiscardHelp', kept.length)],
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'discard', label: t('skillsStudio.dialog.discard'), kind: 'danger' }],
    focus: 'cancel',
  });
  if (answer !== 'discard') return;
  dropKept(kept.map(([key]) => key));
  ctx.render();
}

async function bulkAdopt(ctx) {
  const { t, tp, api } = ctx;
  const chosen = ctx.rows.filter((r) => ctx.lib.selected.has(r.key) && subjectOf(r, { caps: ctx.caps }).mode === 'adopt');
  const answer = await ctx.ask({
    title: tp('skillsStudio.library.bulk.adoptTitle', chosen.length),
    lines: [t('skillsStudio.library.bulk.adoptExplain'), ...chosen.slice(0, 8).map((r) => `• ${r.label}`)],
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'adopt', label: t('skillsStudio.library.bulk.adoptConfirm'), kind: 'primary' }],
  });
  if (answer !== 'adopt') return;
  const gen = ctx.gen();
  let done = 0; const failed = [];
  for (const row of chosen) {
    try { await api.adoptSkillsArtifact(row.primary.id, { idempotencyKey: ctx.key('adopt') }); done++; } catch (err) { failed.push(`${row.label}: ${studioErrorText(ctx.t, err)}`); }
  }
  if (!ctx.alive(gen)) return;
  ctx.toast(failed.length ? t('skillsStudio.library.bulk.adoptPartial', { done, failed: failed.length, first: failed[0] }) : tp('skillsStudio.library.bulk.adoptDone', done), failed.length ? 'error' : 'info');
  ctx.lib.selected.clear();
  await ctx.reload();
}

function bulkExport(ctx) {
  const chosen = ctx.rows.filter((r) => ctx.lib.selected.has(r.key));
  let n = 0;
  for (const row of chosen) {
    const s = subjectOf(row, { caps: ctx.caps });
    const url = row.skill?.latest && ctx.caps.has('export') ? ctx.api.getSkillsRevisionExportUrl(row.skill.latest.revisionId, { format: 'bundle' })
      : s.v1Id ? ctx.api.getSkillsExportUrl(s.v1Id) : null;
    if (!url) continue;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    n++;
  }
  ctx.toast(ctx.tp('skillsStudio.library.bulk.exported', n));
}

async function bulkDelete(ctx) {
  const { t, tp, api } = ctx;
  const chosen = ctx.rows.filter((r) => ctx.lib.selected.has(r.key)).map((r) => ({ row: r, s: subjectOf(r, { caps: ctx.caps }) }))
    .map((x) => ({ ...x, kind: deleteKind(ctx, x.row, x.s) })).filter((x) => x.kind);
  if (!chosen.length) return;
  const onDisk = chosen.filter((x) => x.kind === 'disk');
  const inLibrary = chosen.filter((x) => x.kind === 'library');
  // Unsaved text in an open workspace of one of them goes with it only when the owner says so.
  const unsaved = chosen.filter((x) => ctx.workspaces.get(x.row.key)?.tabs.some((tab) => tab.dirty));
  const box = document.createElement('div');
  box.className = 'sx-dlg-form';
  const label = document.createElement('label');
  label.className = 'sx-field-label';
  label.htmlFor = 'sx-del-confirm';
  label.textContent = t('skillsStudio.library.bulk.deleteType', { word: t('skillsStudio.library.bulk.deleteWord') });
  const input = document.createElement('input');
  input.id = 'sx-del-confirm';
  input.className = 'sx-input';
  input.autocomplete = 'off';
  const err = document.createElement('p');
  err.className = 'ss-dlg-error';
  err.setAttribute('role', 'alert');
  box.append(label, input, err);
  const answer = await ctx.ask({
    title: tp('skillsStudio.library.bulk.deleteTitle', chosen.length),
    // Two kinds, said apart: what is removed from where it is, and what only leaves the library.
    lines: [
      ...(onDisk.length ? [t('skillsStudio.library.bulk.deleteExplain'), ...onDisk.slice(0, 8).map((x) => `• ${x.row.label} (${x.row.path || ''})`)] : []),
      ...(inLibrary.length ? [t('skillsStudio.library.bulk.deleteLibraryExplain'), ...inLibrary.slice(0, 8).map((x) => `• ${x.row.label}`)] : []),
      ...(unsaved.length ? [tp('skillsStudio.library.bulk.deleteUnsaved', unsaved.length)] : []),
    ],
    extra: box,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'delete', label: t('skillsStudio.library.bulk.deleteConfirm'), kind: 'danger' }],
    focus: 'cancel',
    accept: (id) => { if (id === 'delete' && input.value.trim().toLowerCase() !== t('skillsStudio.library.bulk.deleteWord').toLowerCase()) { err.textContent = t('skillsStudio.library.bulk.deleteTypeError'); return false; } return true; },
  });
  if (answer !== 'delete') return;
  const gen = ctx.gen();
  let done = 0; const failed = [];
  for (const x of chosen) {
    try {
      if (x.kind === 'disk') await api.deleteSkillsArtifact(x.s.v1Id);
      else await api.deleteLibrarySkill(x.row.skill.skillId);
      done++;
      const ws = ctx.workspaces.get(x.row.key);
      if (ws) { for (const tab of ws.tabs) dropDraft(ws, tab); ctx.closeWorkspace(ws); }
    } catch (e) { failed.push(`${x.row.label}: ${studioErrorText(ctx.t, e)}`); }
  }
  if (!ctx.alive(gen)) return;
  ctx.toast(failed.length ? t('skillsStudio.library.bulk.deletePartial', { done, failed: failed.length, first: failed[0] }) : tp('skillsStudio.library.bulk.deleted', done), failed.length ? 'error' : 'info');
  ctx.lib.selected.clear();
  await ctx.reload();
}

/** The P0 id of a row's entry (exported for the workspace's Export of an agent or a command). */
export const v1ExportId = (entry) => (entry?.path ? encodeArtifactId(`${entry.kind}:${entry.path}`) : null);

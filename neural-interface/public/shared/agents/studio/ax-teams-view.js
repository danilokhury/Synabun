// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: Teams
// ═══════════════════════════════════════════
//
// A team is one task given to several agents: each works in its own worktree and branch on the files its slice
// owns, the finished slices are joined on an integration branch where the tests run, and the result reaches the
// owner's branch only when the owner lands it (lib/teams/README.md). This place lists the teams and shows one live:
// its slices side by side (state, agent, run, branch, worktree, what it owns, how far it is ahead and behind), the
// integration branch and its last test result, the landing, and the feed of the team's events and messages. Land
// and Discard are the owner's, each behind a question that says what it does.
//
// The list is in two: Open (under way, the rail's count) and Finished (landed, completed, discarded, failed). A
// finished team says what of it is still on disk and in git, and offers the one step that fits: Clean up worktrees
// (landed), Force delete kept work (a discard that kept work), Remove (nothing left); Clear finished removes every
// finished team that can go and says how many stay. Each is behind a question that names what goes.
//
// A ready team whose work somebody merged into its base branch outside SynaBun says "Already on <branch>" instead
// of "Ready to land", in the list and in its detail, and offers Clean up & remove when nothing would be lost (or
// says what is in the way). A card of the Open list that waits on the owner (needs attention, ready; never a running
// one, never one with a live worker) has one quick action beside it: Clean up & remove, Discard & remove (nothing
// of the team on disk) or Discard. The decisions are ax-teams.js `quickActionOf` / `teamView`.
//
// The routes are the team scheduler's (GET /teams, /teams/:id, POST /teams/:id/land and /discard; with the
// capabilities `teams-cleanup` and `teams-remove`, POST /teams/:id/cleanup, DELETE /teams/:id and POST
// /teams/clear-finished; with `teams-on-target`, POST /teams/:id/cleanup-merged; with `teams-quick-discard`, the
// list's `liveRuns` / `left` and discard's `remove`). A server that does not have them yet answers "not there": the
// place then says what teams are and waits, without an error; a server without a capability is offered nothing that
// needs it.

import { html, setHTML, ICONS } from '../../skills/studio/sx-dom.js';
import { teamRows, teamView, splitTeams, clearableTeams, quickActionOf } from './ax-teams.js';
import { baseName } from './ax-library.js';
import { AX_ICONS } from './ax-icons.js';
import { timeTag, loadingHTML, errorHTML, emptyHTML, errorText, wordOr } from './ax-ui.js';

let life = null;
let refreshTimer = 0;

/** End the place's listeners (another place is drawn, or this one again). A refresh that is due stays due. */
export function leaveTeams() {
  life?.abort();
  life = null;
}

/** The window closed: nothing is read again. */
export function stopTeams() {
  leaveTeams();
  clearTimeout(refreshTimer);
  refreshTimer = 0;
}

const chip = (label, tone) => html`<span class="sx-state-chip ax-run-state ax-run-state--${tone}">${label}</span>`;
const teamState = (t, state) => wordOr(t, 'agentsStudio.teams.state', state || 'unknown');
const sliceState = (t, state) => wordOr(t, 'agentsStudio.teams.sliceState', state || 'unknown');
const shortCommit = (commit) => String(commit || '').slice(0, 9);
/** A team's status as a chip: "Already on <branch>" for a ready team whose work is there, its status otherwise. */
const statusChip = (t, team) => (team.onTarget ? chip(t('agentsStudio.teams.onTarget', { branch: team.onTarget.branch }), team.tone) : chip(teamState(t, team.status), team.tone));

/** A card's quick action: its words and its kind of button (the decision is ax-teams.js `quickActionOf`). */
const QUICK = Object.freeze({
  'cleanup-merged': { label: 'agentsStudio.teams.cleanupMerged', kind: 'primary' },
  'discard-remove': { label: 'agentsStudio.teams.discardRemove', kind: 'danger' },
  discard: { label: 'agentsStudio.teams.discard', kind: 'danger' },
});

function listHTML(ctx, st) {
  const { t } = ctx;
  if (st.loading && !st.rows) return loadingHTML(t);
  if (st.error) return errorHTML(t, st.error);
  const rows = st.rows || [];
  if (!rows.length) {
    return emptyHTML({
      icon: AX_ICONS.teams, title: t('agentsStudio.teams.emptyTitle'),
      lines: [t('agentsStudio.teams.emptyHelp'), st.available === false ? t(st.notRunning ? 'agentsStudio.teams.notRunning' : 'agentsStudio.teams.notAvailable') : t('agentsStudio.teams.emptyHow')],
    });
  }
  const { open, finished } = splitTeams(rows);
  // Whether the server can say a finished team still has worktrees (and remove the ones that do not).
  const removing = ctx.caps.has('teams-remove');
  const clear = clearableTeams(rows);
  const canClear = ctx.owner && removing && clear.removable.length > 0;
  let first = true;
  const rowHTML = (row) => {
    const autofocus = first;
    first = false;
    // The card opens the team; its quick action (the owner's, a team that waits on the owner) is a button of its own
    // beside it, never inside it, and the team's title describes it.
    const quick = ctx.owner ? quickActionOf(row, ctx.caps) : null;
    const titleId = `ax-team-t-${row.id}`;
    return html`<li class="ax-team-item"><button type="button" class="ax-team-row" data-act="open-team" data-team="${row.id}"${autofocus ? html` data-autofocus` : ''}>
      <span class="ax-team-row-main"><span class="ax-team-title" id="${titleId}">${row.title || row.id}</span><span class="sx-mono ax-team-id">${row.id}</span></span>
      <span class="ax-team-row-meta">${statusChip(t, row)}${row.onTarget && !row.onTarget.clean ? html`<span class="ax-team-left">${t('agentsStudio.teams.onTargetBlocked')}</span>` : ''}${row.finished && removing && !row.removable ? html`<span class="ax-team-left">${t('agentsStudio.teams.leftTag')}</span>` : ''}${row.slices !== null ? html`<span>${ctx.tp('agentsStudio.teams.slices', row.slices)}</span>` : ''}${row.density ? html`<span>${wordOr(t, 'agentsStudio.teams.density', row.density)}</span>` : ''}${row.project ? html`<span class="sx-tag" title="${row.project}">${AX_ICONS.pin}<span>${baseName(row.project)}</span></span>` : ''}<span class="sx-spacer"></span>${timeTag(row.createdAt, ctx.locale)}</span>
    </button>${quick ? html`<span class="ax-team-quick"><button type="button" class="sx-btn sx-btn--sm sx-btn--${QUICK[quick].kind}" data-act="quick" data-quick="${quick}" data-team="${row.id}" aria-describedby="${titleId}"${st.busy ? html` disabled` : ''}>${ICONS.trash}${t(QUICK[quick].label)}</button></span>` : ''}</li>`;
  };
  return html`<div class="ax-team-groups">
    <section class="ax-team-group" aria-labelledby="ax-teams-open-title">
      <header class="ax-team-group-head"><h4 class="sx-section-title" id="ax-teams-open-title">${t('agentsStudio.teams.openTitle')}</h4><span class="ax-team-group-count">${open.length}</span></header>
      ${open.length ? html`<ul class="ax-team-list" aria-labelledby="ax-teams-open-title">${open.map(rowHTML)}</ul>` : html`<p class="sx-note">${t('agentsStudio.teams.openEmpty')}</p>`}
    </section>
    ${finished.length ? html`<section class="ax-team-group" aria-labelledby="ax-teams-finished-title">
      <header class="ax-team-group-head"><h4 class="sx-section-title" id="ax-teams-finished-title">${t('agentsStudio.teams.finishedTitle')}</h4><span class="ax-team-group-count">${finished.length}</span><span class="sx-spacer"></span>${canClear ? html`<button type="button" class="sx-btn sx-btn--sm" data-act="clear-finished"${st.busy ? html` disabled` : ''}>${ICONS.trash}${t('agentsStudio.teams.clearFinished')}</button>` : ''}</header>
      <ul class="ax-team-list" aria-labelledby="ax-teams-finished-title">${finished.map(rowHTML)}</ul>
    </section>` : ''}
  </div>`;
}

/** How one thing that is left reads in a list: its folder (or branch), its branch beside it. */
const leftLine = (item) => (item.path && item.branch ? `${item.path} · ${item.branch}` : item.path || item.branch);

/** Why a discard kept a worktree, as a short note: the reason, the files, the commits. */
function keptNote(ctx, kept) {
  if (!kept) return '';
  const { t } = ctx;
  const parts = [kept.reason ? wordOr(t, 'agentsStudio.teams.keptReason', kept.reason) : ''];
  if (kept.files.length) parts.push(ctx.tp('agentsStudio.teams.keptFiles', kept.files.length));
  if (kept.commits) parts.push(ctx.tp('agentsStudio.teams.keptCommits', kept.commits));
  return parts.filter(Boolean).join(' · ');
}

/** Why a finished team's record cannot go, when nothing that is left is the reason. */
function blockedText(t, code) {
  const said = t(`agentsStudio.teams.removalBlocked.${code}`);
  return said === `agentsStudio.teams.removalBlocked.${code}` ? t('agentsStudio.teams.removalBlocked.other') : said;
}

/** Why a team stayed in the list after a step that would have removed it (the answer's `removal`). */
function stayReason(t, removal) {
  const code = removal?.code;
  return !code || code === 'TEAM_WORKTREES_LEFT' ? t('agentsStudio.teams.leftTag') : blockedText(t, code);
}

/**
 * A finished team's worktrees and branches: what is still on disk and in git, and the one step that fits (the
 * owner's only). Nothing is drawn for a server that does not say (no `removal`).
 */
function diskHTML(ctx, st, team) {
  const { t } = ctx;
  const r = team.removal;
  if (!team.finished || !r) return '';
  const busy = st.busy ? html` disabled` : '';
  const keptBy = new Map(team.kept.filter((item) => item.sliceId).map((item) => [item.sliceId, item]));
  const lead = r.next === 'cleanup' ? 'agentsStudio.teams.cleanupLead' : r.next === 'force_discard' ? 'agentsStudio.teams.keptLead' : 'agentsStudio.teams.byHandLead';
  const owner = ctx.owner;
  const actions = [
    owner && team.canCleanup && ctx.caps.has('teams-cleanup') ? html`<button type="button" class="sx-btn sx-btn--primary" data-act="cleanup"${busy}>${ICONS.trash}${t('agentsStudio.teams.cleanup')}</button>` : '',
    owner && team.canForceDiscard ? html`<button type="button" class="sx-btn sx-btn--danger" data-act="force-discard"${busy}>${ICONS.trash}${t('agentsStudio.teams.forceDiscard')}</button>` : '',
    owner && team.canRemove && ctx.caps.has('teams-remove') ? html`<button type="button" class="sx-btn sx-btn--danger" data-act="remove"${busy}>${ICONS.trash}${t('agentsStudio.teams.remove')}</button>` : '',
  ].filter(Boolean);
  return html`<section class="ax-side-card ax-team-disk" aria-labelledby="ax-team-disk-title">
    <h4 class="sx-section-title" id="ax-team-disk-title">${AX_ICONS.branch} ${t('agentsStudio.teams.diskTitle')}</h4>
    ${r.removable ? html`<p class="sx-note">${t('agentsStudio.teams.diskClean')}</p>` : ''}
    ${!r.removable && r.left.length ? html`<p class="sx-field-note${r.next === 'force_discard' ? ' sx-warn-text' : ''}" role="note">${t(lead)}</p>
      <ul class="sx-plain-list ax-left-list">${r.left.map((item) => { const note = keptNote(ctx, keptBy.get(item.sliceId)); return html`<li><span class="sx-mono ax-left-path">${item.path || item.branch}</span>${item.path && item.branch ? html`<span class="sx-mono sx-dim">${item.branch}</span>` : ''}${note ? html`<span class="sx-help">${note}</span>` : ''}</li>`; })}</ul>` : ''}
    ${!r.removable && !r.left.length ? html`<p class="sx-field-note sx-warn-text" role="note">${blockedText(t, r.code)}</p>` : ''}
    ${actions.length ? html`<div class="sx-row ax-team-actions">${actions}</div>` : ''}
  </section>`;
}

/**
 * A ready team whose work is on its base branch already (merged outside SynaBun): where it is, and either the one
 * step that fits (Clean up & remove, the owner's) or exactly what keeps the worktrees and branches from going
 * (uncommitted edits per worktree, commits the base branch lacks, a live worker, git's own words).
 */
function onTargetHTML(ctx, st, team) {
  const o = team.onTarget;
  if (!o) return '';
  const { t } = ctx;
  const branch = o.branch;
  const problems = [
    ...o.dirty.map((item) => html`<li><span class="sx-mono ax-left-path">${ctx.tp('agentsStudio.teams.onTargetDirty', item.files.length, { path: item.path })}</span><span class="sx-mono sx-dim">${item.files.slice(0, 6).join(', ')}${item.files.length > 6 ? ' …' : ''}</span></li>`),
    ...o.unmerged.map((item) => html`<li><span class="sx-mono ax-left-path">${ctx.tp('agentsStudio.teams.onTargetUnmerged', item.commits, { branch: item.branch, target: branch })}</span></li>`),
    ...(o.runs === null ? [html`<li><span class="sx-help">${t('agentsStudio.teams.onTargetNoRuns')}</span></li>`] : o.runs > 0 ? [html`<li><span class="sx-help">${ctx.tp('agentsStudio.teams.onTargetRuns', o.runs)}</span></li>`] : []),
    ...o.other.map((line) => html`<li><span class="sx-mono sx-dim">${line}</span></li>`),
  ];
  const offer = ctx.owner && team.canCleanupMerged && ctx.caps.has('teams-on-target');
  return html`<section class="ax-side-card ax-team-ontarget${o.clean ? '' : ' is-blocked'}" aria-labelledby="ax-team-ontarget-title">
    <h4 class="sx-section-title" id="ax-team-ontarget-title">${AX_ICONS.branch} ${t('agentsStudio.teams.onTarget', { branch })}</h4>
    <p class="sx-note">${t('agentsStudio.teams.onTargetLead', { branch })}</p>
    ${o.clean ? html`<p class="sx-field-note" role="note">${t('agentsStudio.teams.onTargetClean', { branch })}</p>` : html`<p class="sx-field-note sx-warn-text" role="note">${t('agentsStudio.teams.onTargetNotClean')}</p>
      ${problems.length ? html`<ul class="sx-plain-list ax-left-list">${problems}</ul>` : ''}
      <p class="sx-help">${t('agentsStudio.teams.onTargetFix', { branch })}</p>`}
    ${offer ? html`<div class="sx-row ax-team-actions"><button type="button" class="sx-btn sx-btn--primary" data-act="cleanup-merged"${st.busy ? html` disabled` : ''}>${ICONS.trash}${t('agentsStudio.teams.cleanupMerged')}</button></div>` : ''}
  </section>`;
}

function sliceHTML(ctx, slice) {
  const { t } = ctx;
  return html`<article class="ax-slice ax-slice--${slice.tone}" aria-label="${slice.title || slice.id}">
    <header class="ax-slice-head"><h5 class="ax-slice-title">${slice.title || slice.id}</h5>${chip(sliceState(t, slice.status), slice.tone)}</header>
    ${slice.task ? html`<p class="ax-slice-task" title="${slice.task}">${slice.task}</p>` : ''}
    <dl class="ax-facts ax-slice-facts">
      ${slice.agentRef ? html`<div><dt>${t('agentsStudio.teams.agent')}</dt><dd class="sx-mono">${slice.agentRef}</dd></div>` : ''}
      ${slice.branch ? html`<div><dt>${t('agentsStudio.teams.branch')}</dt><dd class="sx-mono">${slice.branch}</dd></div>` : ''}
      ${slice.worktree ? html`<div><dt>${t('agentsStudio.teams.worktree')}</dt><dd class="sx-mono" title="${slice.worktree}">${slice.worktree}</dd></div>` : ''}
      ${slice.ahead !== null || slice.behind !== null ? html`<div><dt>${t('agentsStudio.teams.aheadBehind')}</dt><dd class="sx-mono">${t('agentsStudio.teams.aheadBehindValue', { ahead: slice.ahead ?? 0, behind: slice.behind ?? 0 })}</dd></div>` : ''}
      ${slice.dependsOn.length ? html`<div><dt>${t('agentsStudio.teams.dependsOn')}</dt><dd class="sx-mono">${slice.dependsOn.join(', ')}</dd></div>` : ''}
    </dl>
    ${slice.note ? html`<p class="sx-field-note sx-warn-text">${slice.note}</p>` : ''}
    ${slice.ownedPaths.length ? html`<details class="sx-details ax-slice-owned"><summary>${ctx.tp('agentsStudio.teams.owned', slice.ownedPaths.length)}</summary><ul class="sx-plain-list ax-paths">${slice.ownedPaths.map((path) => html`<li class="sx-mono">${path}</li>`)}</ul></details>` : ''}
    ${slice.runId ? html`<button type="button" class="sx-btn sx-btn--sm" data-act="focus-run" data-run="${slice.runId}">${AX_ICONS.runs}${t('agentsStudio.runs.focus')}</button>` : ''}
  </article>`;
}

function detailHTML(ctx, st) {
  const { t } = ctx;
  if (st.detailLoading && !st.team) return loadingHTML(t);
  if (st.detailError) return errorHTML(t, st.detailError);
  if (!st.team) return emptyHTML({ icon: AX_ICONS.teams, title: t('agentsStudio.teams.goneTitle'), lines: [t('agentsStudio.teams.goneHelp')], actions: html`<button type="button" class="sx-btn" data-act="back">${t('agentsStudio.teams.backToList')}</button>` });
  const team = teamView(st.team);
  const i = team.integration;
  const l = team.landing;
  const tests = i.tests;
  // Why Land is not offered: its work is on its base branch already, or the team is not ready yet.
  const landHelp = team.onTarget ? t('agentsStudio.teams.onTargetNothingToLand', { branch: team.onTarget.branch }) : t('agentsStudio.teams.landNotReady');
  return html`<div class="ax-team">
    <section class="ax-team-summary" aria-label="${t('agentsStudio.teams.summary')}">
      <dl class="ax-facts">
        <div><dt>${t('agentsStudio.teams.status')}</dt><dd>${statusChip(t, team)}</dd></div>
        ${team.project ? html`<div><dt>${t('agentsStudio.teams.project')}</dt><dd class="sx-mono" title="${team.project}">${team.project}</dd></div>` : ''}
        ${team.density ? html`<div><dt>${t('agentsStudio.teams.densityLabel')}</dt><dd>${wordOr(t, 'agentsStudio.teams.density', team.density)}</dd></div>` : ''}
        ${team.baseBranch || team.baseCommit ? html`<div><dt>${t('agentsStudio.teams.base')}</dt><dd class="sx-mono">${team.baseBranch}${team.baseCommit ? ` @ ${shortCommit(team.baseCommit)}` : ''}</dd></div>` : ''}
        ${team.createdAt ? html`<div><dt>${t('agentsStudio.teams.created')}</dt><dd>${timeTag(team.createdAt, ctx.locale)}</dd></div>` : ''}
      </dl>
      ${team.attention ? html`<p class="sx-field-note sx-warn-text ax-team-attention" role="note">${team.attention}</p>` : ''}
    </section>
    ${onTargetHTML(ctx, st, team)}
    ${diskHTML(ctx, st, team)}
    <section aria-labelledby="ax-team-slices-title">
      <h4 class="sx-section-title" id="ax-team-slices-title">${ctx.tp('agentsStudio.teams.slices', team.slices.length)}</h4>
      ${team.slices.length ? html`<div class="ax-slices">${team.slices.map((slice) => sliceHTML(ctx, slice))}</div>` : html`<p class="sx-note">${t('agentsStudio.teams.noSlices')}</p>`}
    </section>
    ${team.readOnly ? html`<p class="sx-note">${t('agentsStudio.teams.readOnly')}</p>${ctx.owner && team.canDiscard ? html`<div class="ax-team-actions"><button type="button" class="sx-btn sx-btn--danger" data-act="discard"${st.busy ? html` disabled` : ''}>${ICONS.trash}${t('agentsStudio.teams.discard')}</button></div>` : ''}` : html`<div class="ax-team-cols">
      <section class="ax-side-card" aria-labelledby="ax-team-int-title">
        <h4 class="sx-section-title" id="ax-team-int-title">${AX_ICONS.branch} ${t('agentsStudio.teams.integration')}</h4>
        <dl class="ax-facts">
          ${i.state ? html`<div><dt>${t('agentsStudio.teams.status')}</dt><dd>${wordOr(t, 'agentsStudio.teams.state', i.state)}</dd></div>` : ''}
          ${i.branch ? html`<div><dt>${t('agentsStudio.teams.branch')}</dt><dd class="sx-mono">${i.branch}</dd></div>` : ''}
          ${i.head ? html`<div><dt>${t('agentsStudio.teams.head')}</dt><dd class="sx-mono">${shortCommit(i.head)}</dd></div>` : ''}
          ${i.lastGood ? html`<div><dt>${t('agentsStudio.teams.lastGood')}</dt><dd class="sx-mono">${shortCommit(i.lastGood)}</dd></div>` : ''}
          <div><dt>${t('agentsStudio.teams.tests')}</dt><dd>${!tests ? t('agentsStudio.teams.testsNone') : html`<span class="sx-state-chip ax-run-state ax-run-state--${tests.passed === true ? 'ok' : tests.passed === false ? 'err' : 'idle'}">${t(tests.passed === true ? 'agentsStudio.teams.testsPassed' : tests.passed === false ? 'agentsStudio.teams.testsFailed' : 'agentsStudio.teams.testsUnknown')}</span>${tests.at ? html` ${timeTag(tests.at, ctx.locale)}` : ''}`}</dd></div>
          ${tests?.command ? html`<div><dt>${t('agentsStudio.teams.testCommand')}</dt><dd class="sx-mono">${tests.command}</dd></div>` : ''}
        </dl>
        ${tests?.summary ? html`<details class="sx-details"><summary>${t('agentsStudio.teams.testOutput')}</summary><pre class="sx-pre sx-pre--sm">${tests.summary}</pre></details>` : ''}
      </section>
      <section class="ax-side-card" aria-labelledby="ax-team-land-title">
        <h4 class="sx-section-title" id="ax-team-land-title">${ICONS.publish} ${t('agentsStudio.teams.landing')}</h4>
        <dl class="ax-facts">
          <div><dt>${t('agentsStudio.teams.status')}</dt><dd>${team.onTarget ? t('agentsStudio.teams.onTarget', { branch: team.onTarget.branch }) : l.state ? wordOr(t, 'agentsStudio.teams.landingState', l.state) : t(team.status === 'merged' || team.status === 'landed' ? 'agentsStudio.teams.landed' : 'agentsStudio.teams.notLanded')}</dd></div>
          ${l.targetBranch ? html`<div><dt>${t('agentsStudio.teams.target')}</dt><dd class="sx-mono">${l.targetBranch}</dd></div>` : ''}
          ${l.commit ? html`<div><dt>${t('agentsStudio.teams.head')}</dt><dd class="sx-mono">${shortCommit(l.commit)}</dd></div>` : ''}
          ${l.at ? html`<div><dt>${t('agentsStudio.teams.landedAt')}</dt><dd>${timeTag(l.at, ctx.locale)}</dd></div>` : ''}
        </dl>
        ${l.error ? html`<p class="sx-field-note sx-err-text">${l.error}</p>` : ''}
        ${ctx.owner ? html`<div class="sx-row ax-team-actions">
          <button type="button" class="sx-btn sx-btn--primary" data-act="land"${team.canLand && !st.busy ? '' : html` disabled`} title="${team.canLand ? t('agentsStudio.teams.landHelp') : landHelp}">${ICONS.publish}${t('agentsStudio.teams.land')}</button>
          <button type="button" class="sx-btn sx-btn--danger" data-act="discard"${team.canDiscard && !st.busy ? '' : html` disabled`}>${ICONS.trash}${t('agentsStudio.teams.discard')}</button>
        </div>${team.canLand ? '' : html`<p class="sx-help">${landHelp}</p>`}` : ''}
      </section>
    </div>`}
    <section aria-labelledby="ax-team-feed-title">
      <h4 class="sx-section-title" id="ax-team-feed-title">${t('agentsStudio.teams.feed')}</h4>
      ${team.feed.length ? html`<ol class="ax-feed" id="ax-team-feed">${team.feed.map((item) => html`<li class="ax-feed-item${item.message ? ' is-message' : ''}">
          <span class="ax-feed-time">${timeTag(item.at, ctx.locale)}</span>
          <span class="ax-feed-kind">${item.message ? t('agentsStudio.teams.message') : item.kind}</span>
          ${item.from ? html`<span class="sx-mono ax-feed-from">${item.from}</span>` : ''}
          ${item.text ? html`<span class="ax-feed-text">${item.text}</span>` : ''}
        </li>`)}</ol>` : html`<p class="sx-note">${t('agentsStudio.teams.feedEmpty')}</p>`}
    </section>
    ${team.claims.length ? html`<details class="sx-details ax-claims"><summary>${ctx.tp('agentsStudio.teams.claims', team.claims.length)}</summary><ul class="sx-plain-list ax-paths">${team.claims.map((claim) => html`<li class="sx-mono">${claim.path}${claim.sliceId ? html` <span class="sx-dim">· ${claim.sliceId}</span>` : ''}</li>`)}</ul></details>` : ''}
  </div>`;
}

/** Read the teams list (and the open team) again. */
export async function loadTeams(ctx, st, { teamId = null } = {}) {
  const gen = ctx.gen();
  st.loading = true;
  try {
    const res = await ctx.api.teams();
    if (!ctx.alive(gen)) return;
    st.available = res.available;
    st.notRunning = res.notRunning === true;
    st.rows = teamRows(res.teams);
    st.error = null;
  } catch (error) {
    if (!ctx.alive(gen)) return;
    st.error = error;
  }
  st.loading = false;
  if (teamId) await loadTeam(ctx, st, teamId);
}

async function loadTeam(ctx, st, teamId) {
  const gen = ctx.gen();
  st.detailLoading = true;
  try {
    const res = await ctx.api.team(teamId);
    if (!ctx.alive(gen)) return;
    st.team = res.team;
    st.teamId = teamId;
    st.detailError = null;
  } catch (error) {
    if (!ctx.alive(gen)) return;
    st.detailError = error;
  }
  // Read once for this team: a team that is gone (or a server without the route) is not asked for again by a redraw.
  st.detailFor = teamId;
  st.detailLoading = false;
}

/** A team changed somewhere (`assistant:team-changed`): read it again a moment later, the place kept as it is. */
export function onTeamChanged(ctx, st, teamId) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const open = ctx.view.place === 'teams' ? ctx.view.teamId : null;
    await loadTeams(ctx, st, { teamId: open && (!teamId || teamId === open) ? open : null });
    if (ctx.view.place === 'teams') ctx.render({ keepFocus: true });
  }, 250);
}

export function newTeamsState() {
  return { rows: null, available: null, notRunning: false, loading: false, error: null, team: null, teamId: null, detailFor: null, detailLoading: false, detailError: null, busy: false };
}

/** Draw Teams in the main area: the list, or one team. */
export function renderTeams(main, ctx, st) {
  leaveTeams();
  life = new AbortController();
  const { signal } = life;
  const { t } = ctx;
  const teamId = ctx.view.teamId;
  if (teamId && st.teamId !== teamId) { st.team = null; st.teamId = teamId; st.detailError = null; st.detailFor = null; }
  const row = teamId ? (st.rows || []).find((r) => r.id === teamId) : null;
  const title = teamId ? (st.team ? teamView(st.team).title : row?.title) || teamId : t('agentsStudio.rail.teams');
  setHTML(main, html`<section class="sx-place ax-place" aria-labelledby="ax-teams-title">
    <header class="sx-place-head">
      ${teamId ? html`<button type="button" class="sx-link" data-act="back">${ICONS.back}${t('agentsStudio.rail.teams')}</button>` : ''}
      <h3 class="sx-place-title" id="ax-teams-title" tabindex="-1"${teamId ? html` data-autofocus` : ''}>${title}</h3>
      ${teamId ? html`<span class="sx-mono sx-dim">${teamId}</span>` : html`<p class="sx-place-sub">${t('agentsStudio.teams.sub')}</p>`}
      <span class="sx-spacer"></span>
      <button type="button" class="sx-btn sx-btn--sm" data-act="refresh">${ICONS.update}${t('agentsStudio.runs.refresh')}</button>
    </header>
    <div class="sx-place-scroll" id="ax-teams-body">${teamId ? detailHTML(ctx, st) : listHTML(ctx, st)}</div>
  </section>`);
  // The feed opens at its newest entry.
  const feed = main.querySelector('#ax-team-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;

  const reload = async () => { await loadTeams(ctx, st, { teamId: ctx.view.teamId }); if (ctx.view.place === 'teams') ctx.render({ keepFocus: true }); };
  if (st.rows === null && !st.loading && !st.error) reload();
  else if (teamId && st.detailFor !== teamId && !st.detailLoading) loadTeam(ctx, st, teamId).then(() => { if (ctx.view.place === 'teams') ctx.render({ keepFocus: true }); });

  const decide = async (which) => {
    const view = teamView(st.team);
    const land = which === 'land';
    const answer = await ctx.ask({
      title: t(land ? 'agentsStudio.teams.landTitle' : 'agentsStudio.teams.discardTitle', { name: view.title || view.id }),
      lines: land
        ? [t('agentsStudio.teams.landAsk', { branch: view.landing.targetBranch || view.baseBranch || t('agentsStudio.teams.yourBranch') }), t('agentsStudio.teams.landRefuses')]
        : [t('agentsStudio.teams.discardAsk'), t('agentsStudio.teams.discardKeeps')],
      className: 'ax-dlg',
      buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'go', label: t(land ? 'agentsStudio.teams.land' : 'agentsStudio.teams.discard'), kind: land ? 'primary' : 'danger' }],
      focus: 'cancel',
    });
    if (answer !== 'go') return;
    st.busy = true;
    ctx.render({ keepFocus: true });
    try {
      if (land) {
        await ctx.api.landTeam(view.id, {});
        ctx.toast(t('agentsStudio.teams.landedToast'));
      } else {
        const out = await ctx.api.discardTeam(view.id, {});
        const kept = Array.isArray(out?.kept) ? out.kept.length : 0;
        // What holds work is kept: say so, and where it can be deleted.
        ctx.toast(kept ? ctx.tp('agentsStudio.teams.discardKeptToast', kept) : t('agentsStudio.teams.discardedToast'));
      }
    } catch (error) {
      ctx.toast(t(land ? 'agentsStudio.teams.landFailed' : 'agentsStudio.teams.discardFailed', { error: errorText(t, error) }), 'error');
    }
    st.busy = false;
    await reload();
  };

  /** The things a question lists: at most ten, then how many more. */
  const listed = (items) => [...items.slice(0, 10).map((item) => `• ${leftLine(item)}`), items.length > 10 ? ctx.tp('agentsStudio.teams.moreItems', items.length - 10) : null];

  /** Clean up worktrees, Force delete kept work, or Remove: one finished team, behind its question. */
  const finish = async (which) => {
    const view = teamView(st.team);
    const name = view.title || view.id;
    const left = view.removal?.left || [];
    const asks = {
      cleanup: {
        title: t('agentsStudio.teams.cleanupTitle', { name }),
        lines: [t('agentsStudio.teams.cleanupAsk'), ...listed(left), t('agentsStudio.teams.cleanupSafe', { branch: view.landing.targetBranch || view.baseBranch || t('agentsStudio.teams.yourBranch') })],
        label: t('agentsStudio.teams.cleanup'), kind: 'primary',
      },
      'force-discard': {
        title: t('agentsStudio.teams.forceTitle', { name }),
        lines: [t('agentsStudio.teams.forceAsk'), ...listed(left), t('agentsStudio.teams.forceWarn')],
        label: t('agentsStudio.teams.forceDiscard'), kind: 'danger',
      },
      remove: {
        title: t('agentsStudio.teams.removeTitle', { name }),
        lines: [t('agentsStudio.teams.removeAsk'), t('agentsStudio.teams.removeKeeps')],
        label: t('agentsStudio.teams.remove'), kind: 'danger',
      },
    };
    const q = asks[which];
    const answer = await ctx.ask({ title: q.title, lines: q.lines, className: 'ax-dlg', buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'go', label: q.label, kind: q.kind }], focus: 'cancel' });
    if (answer !== 'go') return;
    st.busy = true;
    ctx.render({ keepFocus: true });
    try {
      if (which === 'cleanup') {
        await ctx.api.cleanupTeam(view.id);
        ctx.toast(t('agentsStudio.teams.cleanedToast'));
      } else if (which === 'force-discard') {
        const out = await ctx.api.discardTeam(view.id, { force: true });
        const kept = Array.isArray(out?.kept) ? out.kept.length : 0;
        ctx.toast(kept ? ctx.tp('agentsStudio.teams.forceIncomplete', kept) : t('agentsStudio.teams.forcedToast'), kept ? 'error' : 'info');
      } else {
        await ctx.api.removeTeam(view.id);
        ctx.toast(t('agentsStudio.teams.removedToast'));
        st.busy = false;
        // The team is gone: back to the list, read again.
        st.rows = (st.rows || []).filter((row) => row.id !== view.id);
        st.team = null;
        ctx.go({ type: 'back' });
        await reload();
        return;
      }
    } catch (error) {
      const key = which === 'cleanup' ? 'agentsStudio.teams.cleanupFailed' : which === 'force-discard' ? 'agentsStudio.teams.forceFailed' : 'agentsStudio.teams.removeFailed';
      ctx.toast(t(key, { error: errorText(t, error) }), 'error');
    }
    st.busy = false;
    await reload();
  };

  /** A team that left the list: drawn without it now (the reload confirms), and its detail closed when it was open. */
  const dropTeam = (teamId) => {
    st.rows = (st.rows || []).filter((row) => row.id !== teamId);
    if (st.teamId === teamId) st.team = null;
    if (ctx.view.teamId === teamId) ctx.go({ type: 'back' });
  };

  /**
   * Clean up & remove a ready team whose work is on its base branch already: behind a question that says where the
   * work is, what is deleted and that git is asked again first (the server refuses, deleting nothing, if a worktree
   * got edits or a branch got commits since this page read it).
   */
  const cleanupMerged = async ({ id, name, branch, count, items = [] }) => {
    const answer = await ctx.ask({
      title: t('agentsStudio.teams.cleanupMergedTitle', { name }),
      lines: [ctx.tp('agentsStudio.teams.cleanupMergedAsk', count, { branch }), ...listed(items), t('agentsStudio.teams.cleanupMergedSafe', { branch })],
      className: 'ax-dlg',
      buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'go', label: t('agentsStudio.teams.cleanupMerged'), kind: 'primary' }],
      focus: 'cancel',
    });
    if (answer !== 'go') return;
    st.busy = true;
    ctx.render({ keepFocus: true });
    try {
      const out = await ctx.api.cleanupMergedTeam(id);
      if (out?.teamRemoved === false) ctx.toast(t('agentsStudio.teams.cleanupMergedKeptToast', { reason: stayReason(t, out.removal) }));
      else { ctx.toast(t('agentsStudio.teams.cleanupMergedToast', { branch: out?.branch || branch })); dropTeam(id); }
    } catch (error) {
      ctx.toast(t('agentsStudio.teams.cleanupMergedFailed', { error: errorText(t, error) }), 'error');
    }
    st.busy = false;
    await reload();
  };

  /**
   * A card's Discard, or Discard & remove when nothing of the team is on disk or in git. Each question says whether
   * the card leaves the list: Discard moves it to Finished; Discard & remove takes it off, and keeps the team (in
   * Finished, discarded) when a worktree or branch holding work turns up after all.
   */
  const quickDiscard = async (row, remove) => {
    const name = row.title || row.id;
    const answer = await ctx.ask({
      title: t(remove ? 'agentsStudio.teams.discardRemoveTitle' : 'agentsStudio.teams.discardTitle', { name }),
      lines: remove
        ? [t('agentsStudio.teams.discardRemoveAsk'), t('agentsStudio.teams.discardRemoveSafe')]
        : [t('agentsStudio.teams.discardAsk'), t('agentsStudio.teams.discardMoves'), t('agentsStudio.teams.discardKeeps')],
      className: 'ax-dlg',
      buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'go', label: t(remove ? 'agentsStudio.teams.discardRemove' : 'agentsStudio.teams.discard'), kind: 'danger' }],
      focus: 'cancel',
    });
    if (answer !== 'go') return;
    st.busy = true;
    ctx.render({ keepFocus: true });
    try {
      const out = await ctx.api.discardTeam(row.id, remove ? { remove: true } : {});
      const kept = Array.isArray(out?.kept) ? out.kept.length : 0;
      if (kept) ctx.toast(ctx.tp('agentsStudio.teams.discardKeptToast', kept));
      else if (remove && out?.teamRemoved === true) { ctx.toast(t('agentsStudio.teams.discardRemovedToast')); dropTeam(row.id); }
      else if (remove) ctx.toast(t('agentsStudio.teams.discardStaysToast', { reason: stayReason(t, out?.removal) }));
      else ctx.toast(t('agentsStudio.teams.discardedToast'));
    } catch (error) {
      ctx.toast(t('agentsStudio.teams.discardFailed', { error: errorText(t, error) }), 'error');
    }
    st.busy = false;
    await reload();
  };

  /** Clear finished: every finished team with nothing left goes; the rest stay, and the toast says how many. */
  const clearFinished = async () => {
    const { removable, kept } = clearableTeams(st.rows || []);
    if (!removable.length) return;
    const answer = await ctx.ask({
      title: t('agentsStudio.teams.clearTitle'),
      lines: [ctx.tp('agentsStudio.teams.clearAsk', removable.length), kept ? ctx.tp('agentsStudio.teams.clearSkips', kept) : null, t('agentsStudio.teams.removeKeeps')],
      className: 'ax-dlg',
      buttons: [{ id: 'cancel', label: t('agentsStudio.action.cancel') }, { id: 'go', label: t('agentsStudio.teams.clearFinished'), kind: 'danger' }],
      focus: 'cancel',
    });
    if (answer !== 'go') return;
    st.busy = true;
    ctx.render({ keepFocus: true });
    try {
      const out = await ctx.api.clearFinishedTeams();
      const removed = Array.isArray(out?.removed) ? out.removed.length : 0;
      const skipped = Array.isArray(out?.skipped) ? out.skipped.length : 0;
      const said = [removed ? ctx.tp('agentsStudio.teams.clearedToast', removed) : t('agentsStudio.teams.clearNothing'), skipped ? ctx.tp('agentsStudio.teams.clearSkippedToast', skipped) : ''].filter(Boolean).join(' ');
      ctx.toast(said, removed ? 'info' : 'error');
    } catch (error) {
      ctx.toast(t('agentsStudio.teams.clearFailed', { error: errorText(t, error) }), 'error');
    }
    st.busy = false;
    await reload();
  };

  main.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !main.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'open-team') ctx.go({ type: 'team', teamId: el.dataset.team });
    else if (act === 'back') ctx.go({ type: 'back' });
    else if (act === 'refresh' || act === 'retry') { st.error = null; st.detailError = null; reload(); }
    else if (act === 'focus-run') ctx.focusRun(el.dataset.run);
    else if (act === 'land' || act === 'discard') decide(act);
    else if (act === 'cleanup' || act === 'force-discard' || act === 'remove') finish(act);
    else if (act === 'clear-finished') clearFinished();
    else if (act === 'quick') {
      // A card's own action: never the card's click (which opens the team).
      e.stopPropagation();
      const row = (st.rows || []).find((r) => r.id === el.dataset.team);
      const which = row ? quickActionOf(row, ctx.caps) : null;
      if (!which || which !== el.dataset.quick) return;
      if (which === 'cleanup-merged') cleanupMerged({ id: row.id, name: row.title || row.id, branch: row.onTarget.branch, count: row.left ?? 1 });
      else quickDiscard(row, which === 'discard-remove');
    } else if (act === 'cleanup-merged' && st.team) {
      const view = teamView(st.team);
      if (!view.canCleanupMerged) return;
      const items = [...view.slices.filter((slice) => slice.worktree || slice.branch).map((slice) => ({ path: slice.worktree, branch: slice.branch })), ...(view.integration.branch ? [{ path: '', branch: view.integration.branch }] : [])];
      cleanupMerged({ id: view.id, name: view.title || view.id, branch: view.onTarget.branch, count: items.length || 1, items });
    }
  }, { signal });
}

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
// The routes are the team scheduler's (GET /teams, /teams/:id, POST /teams/:id/land and /discard). A server that
// does not have them yet answers "not there": the place then says what teams are and waits, without an error.

import { html, setHTML, ICONS } from '../../skills/studio/sx-dom.js';
import { teamRows, teamView } from './ax-teams.js';
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
  return html`<ul class="ax-team-list" aria-label="${t('agentsStudio.rail.teams')}">${rows.map((row, n) => html`<li><button type="button" class="ax-team-row" data-act="open-team" data-team="${row.id}"${n === 0 ? html` data-autofocus` : ''}>
      <span class="ax-team-row-main"><span class="ax-team-title">${row.title || row.id}</span><span class="sx-mono ax-team-id">${row.id}</span></span>
      <span class="ax-team-row-meta">${chip(teamState(t, row.status), row.tone)}${row.slices !== null ? html`<span>${ctx.tp('agentsStudio.teams.slices', row.slices)}</span>` : ''}${row.density ? html`<span>${wordOr(t, 'agentsStudio.teams.density', row.density)}</span>` : ''}${row.project ? html`<span class="sx-tag" title="${row.project}">${AX_ICONS.pin}<span>${baseName(row.project)}</span></span>` : ''}<span class="sx-spacer"></span>${timeTag(row.createdAt, ctx.locale)}</span>
    </button></li>`)}</ul>`;
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
  return html`<div class="ax-team">
    <section class="ax-team-summary" aria-label="${t('agentsStudio.teams.summary')}">
      <dl class="ax-facts">
        <div><dt>${t('agentsStudio.teams.status')}</dt><dd>${chip(teamState(t, team.status), team.tone)}</dd></div>
        ${team.project ? html`<div><dt>${t('agentsStudio.teams.project')}</dt><dd class="sx-mono" title="${team.project}">${team.project}</dd></div>` : ''}
        ${team.density ? html`<div><dt>${t('agentsStudio.teams.densityLabel')}</dt><dd>${wordOr(t, 'agentsStudio.teams.density', team.density)}</dd></div>` : ''}
        ${team.baseBranch || team.baseCommit ? html`<div><dt>${t('agentsStudio.teams.base')}</dt><dd class="sx-mono">${team.baseBranch}${team.baseCommit ? ` @ ${shortCommit(team.baseCommit)}` : ''}</dd></div>` : ''}
        ${team.createdAt ? html`<div><dt>${t('agentsStudio.teams.created')}</dt><dd>${timeTag(team.createdAt, ctx.locale)}</dd></div>` : ''}
      </dl>
      ${team.attention ? html`<p class="sx-field-note sx-warn-text ax-team-attention" role="note">${team.attention}</p>` : ''}
    </section>
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
          <div><dt>${t('agentsStudio.teams.status')}</dt><dd>${l.state ? wordOr(t, 'agentsStudio.teams.landingState', l.state) : t(team.status === 'merged' || team.status === 'landed' ? 'agentsStudio.teams.landed' : 'agentsStudio.teams.notLanded')}</dd></div>
          ${l.targetBranch ? html`<div><dt>${t('agentsStudio.teams.target')}</dt><dd class="sx-mono">${l.targetBranch}</dd></div>` : ''}
          ${l.commit ? html`<div><dt>${t('agentsStudio.teams.head')}</dt><dd class="sx-mono">${shortCommit(l.commit)}</dd></div>` : ''}
          ${l.at ? html`<div><dt>${t('agentsStudio.teams.landedAt')}</dt><dd>${timeTag(l.at, ctx.locale)}</dd></div>` : ''}
        </dl>
        ${l.error ? html`<p class="sx-field-note sx-err-text">${l.error}</p>` : ''}
        ${ctx.owner ? html`<div class="sx-row ax-team-actions">
          <button type="button" class="sx-btn sx-btn--primary" data-act="land"${team.canLand && !st.busy ? '' : html` disabled`} title="${team.canLand ? t('agentsStudio.teams.landHelp') : t('agentsStudio.teams.landNotReady')}">${ICONS.publish}${t('agentsStudio.teams.land')}</button>
          <button type="button" class="sx-btn sx-btn--danger" data-act="discard"${team.canDiscard && !st.busy ? '' : html` disabled`}>${ICONS.trash}${t('agentsStudio.teams.discard')}</button>
        </div>${team.canLand ? '' : html`<p class="sx-help">${t('agentsStudio.teams.landNotReady')}</p>`}` : ''}
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
      if (land) await ctx.api.landTeam(view.id, {}); else await ctx.api.discardTeam(view.id, {});
      ctx.toast(t(land ? 'agentsStudio.teams.landedToast' : 'agentsStudio.teams.discardedToast'));
    } catch (error) {
      ctx.toast(t(land ? 'agentsStudio.teams.landFailed' : 'agentsStudio.teams.discardFailed', { error: errorText(t, error) }), 'error');
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
  }, { signal });
}

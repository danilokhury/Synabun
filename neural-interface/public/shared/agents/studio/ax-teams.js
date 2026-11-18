// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: teams, as the page reads them
// ═══════════════════════════════════════════
//
// A team is one task given to several agents, each in its own worktree and branch, joined on an integration branch
// and landed on the owner's branch only by the owner (lib/teams/README.md). The page reads them through
// GET /api/agents-studio/v1/teams and /teams/:id. Those routes belong to the team scheduler, which is built beside
// this page: everything here reads an answer defensively (either spelling of a field the journal and the route may
// use: `id` / `teamId`, `status` / `state`, slices as a list or as a record by id), so a field that is not there
// shows as nothing, never as an error. The words are the journal's own states (lib/teams/schema.js TEAM_STATES,
// SLICE_STATES) and the scheduler's statuses of a team (lib/teams/scheduler.js TEAM_STATUSES, phase P4: a team's
// `status` is the scheduler's, its `state` the journal's, and the status is what the list and the summary say); a
// state this page does not know is shown as written, in the neutral tone. The scheduler's answer for one team
// (lib/teams/api.js `teamDetail`) is read with its parts put back inside the team (ax-api.js `teamDetailOf`): claims
// by `glob`, the landing's `landed` / `refused` records, a slice's `lastReport`, an event's `event`, a message's
// `fromSlice`, the team's `attention`.
// No DOM and no imports.

export const TEAM_STATES = Object.freeze(['creating', 'planned', 'running', 'integrating', 'ready', 'landing', 'merged', 'completed', 'failed', 'cancelled']);
/** The scheduler's statuses of a team (phase P4, lib/teams/scheduler.js TEAM_STATUSES): what `status` holds there. */
export const SCHEDULER_TEAM_STATUSES = Object.freeze(['running', 'needs_attention', 'ready', 'completed', 'landed', 'discarded', 'failed']);
export const SLICE_STATES = Object.freeze(['planned', 'pending', 'blocked', 'running', 'done', 'rejected', 'integrating', 'integrated', 'conflict', 'tests-failed', 'completed', 'failed', 'cancelled']);

const TEAM_TONES = { creating: 'idle', planned: 'idle', running: 'active', integrating: 'active', ready: 'ok', landing: 'active', merged: 'done', completed: 'done', failed: 'err', cancelled: 'off', needs_attention: 'warn', landed: 'done', discarded: 'off' };
/** A team that reached the owner's branch, is on its way there, or was thrown away: nothing more to land or discard. */
const SETTLED_TEAM = new Set(['merged', 'landing', 'landed', 'discarded', 'completed']);
const SLICE_TONES = { planned: 'idle', pending: 'idle', blocked: 'warn', running: 'active', done: 'ok', rejected: 'err', integrating: 'active', integrated: 'done', completed: 'done', conflict: 'err', 'tests-failed': 'err', failed: 'err', cancelled: 'off' };

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4000) => (typeof value === 'string' ? value.slice(0, max) : '');
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');
const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);
const stateOf = (value) => text(first(value?.status, value?.state), 40).toLowerCase();

/** The tone of a team's or a slice's state: idle / active / ok / done / warn / err / off. */
export const teamTone = (state) => TEAM_TONES[state] || 'idle';
export const sliceTone = (state) => SLICE_TONES[state] || 'idle';

/** A row of the teams list. */
export function teamRow(team) {
  const t = isObject(team) ? team : {};
  const slices = Array.isArray(t.slices) ? t.slices.length : isObject(t.slices) ? Object.keys(t.slices).length : number(first(t.slices, t.sliceCount, t.slicesCount));
  const status = stateOf(t);
  return {
    id: text(first(t.id, t.teamId), 128),
    title: text(first(t.title, t.plan?.title, t.name), 200),
    project: text(first(t.project, t.projectPath, t.plan?.projectPath), 1024),
    status, tone: teamTone(status),
    density: text(first(t.density, t.plan?.density), 40),
    slices: slices ?? null,
    createdAt: text(first(t.createdAt, t.created_at), 40),
    updatedAt: text(first(t.updatedAt, t.updated_at), 40),
  };
}

/** The list, newest first, a team without an id left out. */
export function teamRows(teams) {
  return (Array.isArray(teams) ? teams : []).map(teamRow).filter((row) => row.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** How many teams are under way (the rail's count). */
export function activeTeams(rows) {
  // A team that waits on the owner (`needs_attention`) is still under way.
  return (Array.isArray(rows) ? rows : []).filter((row) => ['active', 'ok', 'warn'].includes(row.tone)).length;
}

function sliceOf(raw, plan) {
  const s = isObject(raw) ? raw : {};
  const id = text(first(s.id, s.sliceId), 128);
  const planned = isObject(plan) ? plan : {};
  const status = stateOf(s) || 'planned';
  const ab = isObject(s.aheadBehind) ? s.aheadBehind : s;
  return {
    id,
    title: text(first(s.title, planned.title, id), 200),
    task: text(first(s.task, planned.task), 4000),
    agentRef: text(first(s.agentRef, s.agent_ref, planned.agentRef, planned.agent_ref), 200),
    status, tone: sliceTone(status),
    runId: text(first(s.runId, s.run_id), 128) || null,
    worktree: text(first(s.worktree, s.worktreePath, s.path), 1024),
    branch: text(first(s.branch, s.branchName), 300),
    ownedPaths: (Array.isArray(first(s.ownedPaths, s.owned, s.paths, planned.ownedPaths)) ? first(s.ownedPaths, s.owned, s.paths, planned.ownedPaths) : []).filter((p) => typeof p === 'string').slice(0, 200),
    dependsOn: (Array.isArray(first(s.dependsOn, planned.dependsOn)) ? first(s.dependsOn, planned.dependsOn) : []).filter((p) => typeof p === 'string'),
    ahead: number(first(ab.ahead, s.ahead)),
    behind: number(first(ab.behind, s.behind)),
    note: text(first(s.cleanup?.kept ? `Worktree kept: ${s.cleanup.kept.reason} (${s.cleanup.kept.path})` : null, s.error, s.reason, s.note, isObject(s.lastReport) ? s.lastReport.message : null), 600),
    updatedAt: text(first(s.updatedAt, s.updated_at), 40),
  };
}

/** The slices of a team, in the plan's order (a slice the plan does not name comes after). */
export function sliceRows(team) {
  const t = isObject(team) ? team : {};
  const planned = Array.isArray(t.plan?.slices) ? t.plan.slices.filter(isObject) : [];
  const stored = Array.isArray(t.slices) ? t.slices.filter(isObject) : isObject(t.slices) ? Object.entries(t.slices).map(([id, slice]) => ({ id, ...(isObject(slice) ? slice : {}) })) : [];
  const byId = new Map(stored.map((slice) => [text(first(slice.id, slice.sliceId), 128), slice]));
  const out = [];
  for (const plan of planned) {
    const id = text(plan.id, 128);
    if (!id) continue;
    out.push(sliceOf({ id, ...(byId.get(id) || {}) }, plan));
    byId.delete(id);
  }
  for (const [id, slice] of byId) if (id) out.push(sliceOf(slice, null));
  return out;
}

/** The integration branch: its state, where its head is, and the last test run on it. */
export function integrationOf(team) {
  const i = isObject(team?.integration) ? team.integration : {};
  const tests = isObject(first(i.tests, i.lastTest, i.test)) ? first(i.tests, i.lastTest, i.test) : null;
  const passed = tests ? (tests.ok === true || tests.passed === true || tests.status === 'passed' ? true : (tests.ok === false || tests.passed === false || tests.status === 'failed' ? false : null)) : null;
  return {
    state: stateOf(i),
    branch: text(first(i.branch, i.branchName), 300),
    head: text(first(i.head, i.commit), 80),
    lastGood: text(first(i.lastGood, i.last_good), 80),
    tests: tests ? {
      passed,
      command: Array.isArray(tests.command) ? tests.command.join(' ') : text(first(tests.command, tests.cmd), 600),
      exitCode: number(first(tests.exitCode, tests.code)),
      at: text(first(tests.at, tests.finishedAt, tests.createdAt), 40),
      commit: text(first(tests.commit, tests.head), 80),
      summary: text(first(tests.summary, tests.output, tests.tail), 2000),
    } : null,
  };
}

/** The landing: whether the team's result reached the owner's branch, and how. */
export function landingOf(team) {
  const l = isObject(team?.landing) ? team.landing : {};
  // The scheduler keeps the landing git made (`landed`: targetBranch, mode, mergeCommit, to, at) and the last refusal
  // (`refused`: code, message, at) as records of their own.
  const landed = isObject(l.landed) ? l.landed : {};
  const refused = isObject(l.refused) ? l.refused : {};
  const str = (value) => (typeof value === 'string' ? value : null);
  return {
    state: stateOf(l),
    targetBranch: text(first(str(l.targetBranch), str(landed.targetBranch), str(l.target), str(team?.baseBranch)), 300),
    mode: text(first(str(l.mode), str(landed.mode)), 20),
    commit: text(first(str(l.commit), str(l.head), str(landed.mergeCommit), str(landed.to)), 80),
    at: text(first(str(l.at), str(l.landedAt), str(l.finishedAt), str(landed.at)), 40),
    error: text(first(str(l.error), str(l.reason), str(refused.message)), 600),
  };
}

/** The claims: which slice holds which path. */
export function claimRows(team) {
  const claims = Array.isArray(team?.claims) ? team.claims : [];
  return claims.filter(isObject).map((claim) => ({
    path: text(first(claim.path, claim.glob, claim.resource, claim.key), 1024),
    sliceId: text(first(claim.sliceId, claim.slice, claim.owner), 128),
  })).filter((row) => row.path).slice(0, 500);
}

/** The team's events and messages as one feed, newest last, the last `limit` of them. */
export function feedItems(team, limit = 100) {
  const rows = [];
  const take = (list, kindWord) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (!isObject(item)) continue;
      const body = first(item.text, item.body, item.message, item.summary, item.data?.text, item.data?.summary);
      rows.push({
        seq: number(first(item.seq, item.id)),
        kind: text(first(item.kind, item.type, item.event, kindWord), 80),
        message: kindWord === 'message' || item.kind === 'message' || item.type === 'message',
        at: text(first(item.at, item.createdAt, item.created_at, item.time), 40),
        from: text(first(item.fromSlice, item.from, item.sender, item.sliceId, item.slice, item.runId, item.author), 200),
        text: typeof body === 'string' ? body.slice(0, 2000) : '',
      });
    }
  };
  take(team?.events, 'event');
  take(team?.messages, 'message');
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.seq ?? 0) - (b.seq ?? 0));
  return rows.slice(-Math.max(1, limit));
}

/** One team as the page draws it. */
export function teamView(team) {
  const row = teamRow(team);
  const slices = sliceRows(team);
  const integration = integrationOf(team);
  return {
    ...row,
    slices,
    readOnly: team?.plan?.readOnly === true,
    baseBranch: text(first(team?.baseBranch, team?.plan?.baseBranch), 300),
    baseCommit: text(first(team?.baseCommit, team?.plan?.baseCommit), 80),
    integration, landing: landingOf(team), claims: claimRows(team), feed: feedItems(team),
    // What the scheduler waits on the owner for (status `needs_attention`): its sentence, shown as text.
    attention: text(isObject(team?.attention) ? first(team.attention.message, team.attention.code) : team?.attention, 600),
    // Landing is offered once the integration branch is ready (the server refuses anything else and says why).
    canLand: team?.plan?.readOnly !== true && row.status === 'ready',
    // A team that reached the owner's branch, or is on its way there, is not thrown away from here.
    canDiscard: !!row.id && !SETTLED_TEAM.has(row.status) && team?.removed !== true,
    sliceCounts: slices.reduce((acc, slice) => { acc[slice.tone] = (acc[slice.tone] || 0) + 1; return acc; }, {}),
  };
}

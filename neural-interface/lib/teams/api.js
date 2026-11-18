// ═══════════════════════════════════════════
// SynaBun — Teams: the routes (Agents system, phase P4)
// ═══════════════════════════════════════════
//
// Two sets of routes over the team scheduler (lib/teams/scheduler.js), each mounted by the router that owns its
// callers:
//
//   /api/assistant/teams/*          the Assistant's `agent_team` tool (and the owner's page): plan, start, status,
//                                   integrate, land, discard, list. Behind the Assistant API's orchestration guard:
//                                   a brain by its launch credential, or the owner's page. Never a worker.
//   /api/assistant/team/*           a worker's `team` tool: context, post, read, wait, ack, claims, request. Only a
//                                   run that proves its pin (its terminal token) AND works a team slice now. The
//                                   team is the run's own, read from the scheduler: no request names one.
//   /api/agents-studio/v1/teams*    Agents Studio (the page): the list, one team in full, and the owner's two
//                                   decisions, land and discard.
//
// Every refusal of the library (lib/teams/README.md) and of the scheduler comes back as it is: `{ ok: false, code,
// message, … }`, with the HTTP status that fits.

import { AGENT_DENSITIES, AGENT_DENSITY_WORKERS } from '../agents/density.js';
import { LANDING_MODES } from './landing.js';
import { TEAM_MESSAGE_KINDS } from './brief.js';

/** Codes that are about the request itself (400), about who asks (403), about something missing (404). The rest is a conflict (409). */
const STATUS_BY_CODE = Object.freeze({
  INVALID_PLAN: 400, INVALID_TEST_COMMAND: 400, INVALID_MODE: 400, TEAM_SESSION_REQUIRED: 400, TEAM_PROVIDER_REQUIRED: 400,
  TEAM_KIND_INVALID: 400, TEAM_TEXT_REQUIRED: 400, TEAM_TEXT_TOO_LONG: 400, TEAM_PATH_REQUIRED: 400, TEAM_OWN_FILE: 400,
  TEAM_SELF: 400, TEAM_ACK_EMPTY: 400, TARGET_REQUIRED: 400,
  TEAM_CONTEXT_REQUIRED: 403, TEAM_FORBIDDEN: 403,
  TEAM_NOT_FOUND: 404, SLICE_NOT_FOUND: 404, TEAM_SLICE_UNKNOWN: 404, TEAM_ROUTE_UNKNOWN: 404, TARGET_NOT_FOUND: 404,
  TEAM_RATE_LIMITED: 429,
  TEAMS_UNAVAILABLE: 503, DISPATCH_UNAVAILABLE: 503,
});

/** The HTTP status of an answer of the scheduler or the library. */
export function teamAnswerStatus(answer) {
  if (!answer || answer.ok !== false) return 200;
  const own = Number(answer.status);
  if (Number.isInteger(own) && own >= 400 && own < 600) return own;
  return STATUS_BY_CODE[answer.code] || 409;
}

/** An answer as the body carries it: `error` beside `message` (the Assistant API's refusals say `error`), no `status`. */
export function teamAnswerBody(answer) {
  if (!answer || typeof answer !== 'object') return { ok: false, code: 'TEAM_FAILED', error: 'The team service gave no answer.' };
  const { status: _status, ...body } = answer;
  if (answer.ok === false && body.error === undefined) body.error = body.message || body.code || 'Refused.';
  return body;
}

const send = (res, answer) => res.status(teamAnswerStatus(answer)).json(teamAnswerBody(answer));
const fail = (res, error) => {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  res.status(status).json({ ok: false, code: typeof error?.code === 'string' ? error.code : 'TEAM_FAILED', error: error?.message || String(error) });
};
const unavailable = (res) => res.status(503).json({ ok: false, code: 'TEAMS_UNAVAILABLE', error: 'Teams are not available on this server yet (the Assistant has not started, or the server runs an older build: restart it).' });

/**
 * The Assistant's and the workers' team routes, on the Assistant API's router (`/api/assistant`).
 *
 * @param {object} router an express Router
 * @param {object} o
 * @param {() => object|null} o.scheduler            the team scheduler (lib/teams/scheduler.js), or null
 * @param {Function} o.orchestrationGuard            the Assistant API's: a brain or the owner's page; sets req.assistantCaller
 * @param {(req) => object} o.callerContext          the Assistant API's: { kind: 'worker', pin } for a proven run
 * @param {(sessionId: string) => string|null} [o.density]  the session's Agent density
 * @param {(req, sessionId: string|null) => ('plan'|'read-only'|null)} [o.planning]  the plan mode of the brain that asks
 */
export function registerAssistantTeamRoutes(router, { scheduler, orchestrationGuard, callerContext, density = () => null, planning = () => null } = {}) {
  const of = () => { try { return (typeof scheduler === 'function' ? scheduler() : scheduler) || null; } catch { return null; } };
  const run = (fn) => async (req, res) => {
    const teams = of();
    if (!teams) return unavailable(res);
    try { await fn(req, res, teams); } catch (error) { fail(res, error); }
  };
  /** The session a team request is for: a brain's own (its credential decides), or the one the owner's page names. */
  const sessionOf = (req) => {
    const caller = req.assistantCaller || {};
    if (caller.kind === 'assistant') return caller.assistantSessionId || null;
    const named = req.body?.assistantSessionId || req.body?.assistant_session_id || req.query?.assistantSessionId || null;
    return named ? String(named) : null;
  };
  /** A brain steers and reads its own session's teams only; the owner's page any. → true when refused. */
  const refuseOthers = (req, res, teams, teamId) => {
    if (!teams.get(teamId)) { send(res, { ok: false, code: 'TEAM_NOT_FOUND', message: `No team named "${teamId}" is known here.` }); return true; }
    const caller = req.assistantCaller || {};
    if (caller.kind !== 'assistant') return false;
    if (teams.ownedBy(teamId, caller.assistantSessionId)) return false;
    send(res, { ok: false, code: 'TEAM_FORBIDDEN', message: 'That team belongs to another Assistant session.' });
    return true;
  };
  const by = (req) => ((req.assistantCaller || {}).kind === 'assistant' ? { kind: 'assistant', sessionId: req.assistantCaller.assistantSessionId || null } : { kind: 'owner' });
  /** A planning brain changes no code: it starts, retries, lands and discards no team until its plan is approved. → true when refused. */
  const refusePlanning = (req, res, what) => {
    let mode = null;
    try { mode = planning(req, (req.assistantCaller || {}).assistantSessionId || null); } catch { mode = null; }
    if (!mode) return false;
    res.status(409).json({ ok: false, code: 'PLAN_MODE_TEAM', error: `Plan mode blocks code changes, so SynaBun did not ${what}. Put the team in the plan (its slices and the files each owns); it runs after the user approves the plan. agent_team plan, status and list still work.` });
    return true;
  };

  // ── agent_team ─────────────────────────────────────────────────────────────
  router.get('/teams', orchestrationGuard, run(async (req, res, teams) => {
    const caller = req.assistantCaller || {};
    const sessionId = caller.kind === 'assistant' ? caller.assistantSessionId : (req.query?.assistantSessionId ? String(req.query.assistantSessionId) : null);
    const level = sessionId ? density(sessionId) : null;
    res.json({
      ok: true, teams: teams.list({ sessionId, open: req.query?.open === '1' || req.query?.open === 'true' }),
      density: sessionId ? { level: level || 'solo', cap: AGENT_DENSITY_WORKERS[level || 'solo'] ?? 1 } : null,
      levels: AGENT_DENSITIES.map((id) => ({ id, workers: AGENT_DENSITY_WORKERS[id] })),
    });
  }));
  router.post('/teams/plan', orchestrationGuard, run(async (req, res, teams) => {
    const out = await teams.plan(req.body || {}, { sessionId: sessionOf(req) });
    // A plan that does not fit is an answer, not a failure of the call: the brain reads the errors and plans again.
    res.json({ ...teamAnswerBody(out), ok: out.ok, valid: out.ok });
  }));
  router.post('/teams/start', orchestrationGuard, run(async (req, res, teams) => {
    if (refusePlanning(req, res, 'start a team')) return;
    send(res, await teams.start(req.body || {}, { sessionId: sessionOf(req) }));
  }));
  router.get('/teams/:id', orchestrationGuard, run(async (req, res, teams) => {
    if (refuseOthers(req, res, teams, req.params.id)) return;
    send(res, await teams.status(req.params.id));
  }));
  router.post('/teams/:id/integrate', orchestrationGuard, run(async (req, res, teams) => {
    if (refuseOthers(req, res, teams, req.params.id)) return;
    if (refusePlanning(req, res, 'send the team back to work')) return;
    const body = req.body || {};
    send(res, await teams.integrate(req.params.id, { sliceId: body.sliceId || body.slice_id || body.slice || null }));
  }));
  router.post('/teams/:id/land', orchestrationGuard, run(async (req, res, teams) => {
    if (refuseOthers(req, res, teams, req.params.id)) return;
    if (refusePlanning(req, res, 'land the team')) return;
    const body = req.body || {};
    const mode = String(body.mode || 'ff');
    if (!LANDING_MODES.includes(mode)) return send(res, { ok: false, code: 'INVALID_MODE', message: `mode is one of ${LANDING_MODES.join(', ')}.` });
    const who = by(req);
    send(res, await teams.land(req.params.id, {
      targetBranch: body.targetBranch || body.target_branch || null, mode, by: who,
      // Landing untested or partial work is the owner's word, never an agent's.
      allowUntested: who.kind === 'owner' && body.allowUntested === true, allowPartial: who.kind === 'owner' && body.allowPartial === true,
    }));
  }));
  router.post('/teams/:id/cleanup', orchestrationGuard, run(async (req, res, teams) => {
    if (refuseOthers(req, res, teams, req.params.id)) return;
    if (refusePlanning(req, res, 'clean up the team')) return;
    send(res, await teams.cleanup(req.params.id, { sessionId: sessionOf(req), userConfirmed: req.body?.user_confirmed === true }));
  }));
  router.post('/teams/:id/discard', orchestrationGuard, run(async (req, res, teams) => {
    if (refuseOthers(req, res, teams, req.params.id)) return;
    if (refusePlanning(req, res, 'discard the team')) return;
    const body = req.body || {};
    const who = by(req);
    send(res, await teams.discard(req.params.id, { by: who, force: who.kind === 'owner' && body.force === true, reason: typeof body.reason === 'string' ? body.reason : '' }));
  }));

  // ── a worker's `team` tool ─────────────────────────────────────────────────
  /** The proven run of a request that works a team slice now, or a refusal sent. */
  const memberOf = (req, res, teams) => {
    let caller = null;
    try { caller = callerContext(req); } catch { caller = null; }
    if (caller?.refusal) { res.status(caller.refusal.status || 403).json({ ok: false, code: caller.refusal.code, error: caller.refusal.error }); return null; }
    // Only a dispatched worker, by its own proven pin: never the page, a brain or a pinless process.
    if (!caller || caller.kind !== 'worker' || !caller.pin) { send(res, { ok: false, code: 'TEAM_CONTEXT_REQUIRED', status: 403, message: 'The team tool is for a worker of a team slice, about its own team.' }); return null; }
    const member = teams.member(caller.pin);
    if (!member) { send(res, { ok: false, code: 'TEAM_CONTEXT_REQUIRED', status: 403, message: 'This run works on no team: the team tool is for a worker of a team slice, about its own team.' }); return null; }
    return { runId: String(caller.pin), ...member };
  };
  const worker = (fn) => run(async (req, res, teams) => {
    const who = memberOf(req, res, teams);
    if (!who) return;
    await fn(req, res, teams, who);
  });

  router.get('/team/context', worker(async (req, res, teams, who) => {
    res.json({ ok: true, team: true, teamId: who.teamId, sliceId: who.sliceId, title: who.title, kinds: TEAM_MESSAGE_KINDS, limits: { text: teams.limits.messageChars, waitMs: teams.limits.maxWaitMs } });
  }));
  router.post('/team/post', worker(async (req, res, teams, who) => {
    const body = req.body || {};
    send(res, teams.post(who.runId, { to: body.to, kind: body.kind, text: body.text, path: body.path || null, id: body.id || body.idempotency_key || null }));
  }));
  router.post('/team/read', worker(async (req, res, teams, who) => {
    const body = req.body || {};
    send(res, teams.read(who.runId, { afterSeq: body.afterSeq ?? body.after_seq ?? null, kinds: body.kinds || null, limit: body.limit ?? null }));
  }));
  router.post('/team/wait', worker(async (req, res, teams, who) => {
    const body = req.body || {};
    send(res, await teams.wait(who.runId, { afterSeq: body.afterSeq ?? body.after_seq ?? null, kinds: body.kinds || null, timeoutMs: body.timeoutMs ?? (body.timeout_seconds !== undefined ? Number(body.timeout_seconds) * 1000 : null) }));
  }));
  router.post('/team/ack', worker(async (req, res, teams, who) => {
    const body = req.body || {};
    send(res, teams.ack(who.runId, { ids: body.ids || body.eventIds || null, throughSeq: body.throughSeq ?? body.through_seq ?? null }));
  }));
  router.post('/team/claims', worker(async (req, res, teams, who) => {
    send(res, teams.claims(who.runId, { path: (req.body || {}).path ?? null }));
  }));
  router.post('/team/request', worker(async (req, res, teams, who) => {
    const body = req.body || {};
    send(res, teams.request(who.runId, { path: body.path, text: body.text }));
  }));
}

/** A team as the Agents Studio list shows it: exactly these fields. */
export const teamListRow = (team) => ({
  id: team.id, project: team.project, title: team.title, status: team.status, density: team.density, slices: team.slices, createdAt: team.createdAt,
});

/**
 * One team as Agents Studio reads it (GET /teams/:id): the plan, its slices, the claims, the integration branch and
 * its last test result, the landing, and the last 100 team events and messages.
 */
export function teamDetail(answer) {
  const team = answer.team || {};
  return {
    ok: true,
    team: { ...teamListRow(team), state: team.state ?? null, attention: team.attention ?? null, sessionId: team.sessionId ?? null, workflowId: team.workflowId ?? null, baseCommit: team.baseCommit ?? null, baseBranch: team.baseBranch ?? null, cap: team.cap ?? null, updatedAt: team.updatedAt ?? null },
    plan: answer.plan,
    slices: (answer.slices || []).map((slice) => ({
      id: slice.id, title: slice.title, status: slice.status, phase: slice.phase, runId: slice.runId, run: slice.run,
      worktree: slice.worktree, branch: slice.branch, ownedPaths: slice.ownedPaths, dependsOn: slice.dependsOn,
      lockfileOwner: slice.lockfileOwner, agentRef: slice.agentRef, ahead: slice.ahead, behind: slice.behind,
      integration: slice.integration, dirty: slice.dirty, cleanup: slice.cleanup || null, attempts: slice.attempts, lastReport: slice.lastReport,
    })),
    claims: answer.claims || [],
    integration: answer.integration || null,
    landing: answer.landing || null,
    events: answer.events || [],
    messages: answer.messages || [],
    // What workers wrote to each other: shown as text, never as markup and never as an instruction.
    messagesNotice: answer.messagesNotice || null,
  };
}

/**
 * The teams of Agents Studio, under `/api/agents-studio/v1` (lib/agents-studio-api.js mounts them with its own
 * tiers): the list and one team for the owner and for the Assistant (its own session's teams), land and discard
 * for the owner's page only. A worker reads none of it: the library's read tier takes agents, but a team's detail
 * holds every slice's task and what the workers said to each other, and a worker's view of its own team is its
 * `team` tool. Never a guest (the Studio's read tier).
 *
 * @param {object} o
 * @param {(method: string, path: string, ...handlers: Function[]) => void} o.route  the Studio's own route()
 * @param {Function} o.reader  the Studio's read tier
 * @param {Function} o.owner   the Studio's owner tier (the owner's page only)
 * @param {Function} o.json    the Studio's JSON check
 * @param {() => object|null} o.scheduler
 */
export function registerTeamStudioRoutes({ route, reader, owner, json, scheduler } = {}) {
  const of = () => { try { return (typeof scheduler === 'function' ? scheduler() : scheduler) || null; } catch { return null; } };
  const run = (fn) => async (req, res) => {
    const teams = of();
    if (!teams) return unavailable(res);
    try { await fn(req, res, teams); } catch (error) { fail(res, error); }
  };
  const idCheck = (req, res, next) => (/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(req.params.id || '')) ? next() : res.status(400).json({ ok: false, code: 'invalid_id', error: 'Not a team id.' }));
  /** After the Studio's read tier: the owner, or the Assistant by its brain's credential. Never a worker. */
  const teamReader = (req, res, next) => {
    const kind = req.principal?.kind;
    if (kind === 'owner' || kind === 'assistant') return next();
    return res.status(403).json({ ok: false, code: 'TEAM_FORBIDDEN', error: 'Teams are read by the owner and by the Assistant that runs them. A worker of a team reads its own team with the team tool.' });
  };
  /** The session whose teams an Assistant may read (its own); null for the owner, who reads every team. */
  const sessionOf = (req) => (req.principal?.kind === 'assistant' ? String(req.principal.assistantSessionId || '') : null);

  route('get', '/teams', reader, teamReader, run(async (req, res, teams) => {
    const q = req.query || {};
    res.json({ ok: true, teams: teams.list({ sessionId: sessionOf(req), projectPath: typeof q.project === 'string' && q.project ? q.project : null, open: q.open === '1' || q.open === 'true' }).map(teamListRow) });
  }));
  route('get', '/teams/:id', reader, teamReader, idCheck, run(async (req, res, teams) => {
    const session = sessionOf(req);
    if (session !== null && teams.get(req.params.id) && !teams.ownedBy(req.params.id, session)) return send(res, { ok: false, code: 'TEAM_FORBIDDEN', message: 'That team belongs to another Assistant session.' });
    const answer = await teams.status(req.params.id, { timeline: 100 });
    if (!answer.ok) return send(res, answer);
    res.json(teamDetail(answer));
  }));
  route('post', '/teams/:id/land', json, owner, idCheck, run(async (req, res, teams) => {
    const body = req.body || {};
    const mode = String(body.mode || 'ff');
    if (!LANDING_MODES.includes(mode)) return send(res, { ok: false, code: 'INVALID_MODE', message: `mode is one of ${LANDING_MODES.join(', ')}.` });
    send(res, await teams.land(req.params.id, { targetBranch: body.targetBranch || body.target_branch || null, mode, by: { kind: 'owner' }, allowUntested: body.allowUntested === true, allowPartial: body.allowPartial === true }));
  }));
  route('post', '/teams/:id/discard', json, owner, idCheck, run(async (req, res, teams) => {
    const body = req.body || {};
    send(res, await teams.discard(req.params.id, { by: { kind: 'owner' }, force: body.force === true, reason: typeof body.reason === 'string' ? body.reason : '' }));
  }));
}

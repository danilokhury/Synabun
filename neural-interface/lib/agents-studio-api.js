// ── /api/agents-studio/v1: the agent registry over HTTP (Agents system, phase P1) ──
// The routes Agents Studio (the page) and the agent-forge workflow use; lib/agents/registry.js keeps the
// definitions and lib/agents/resolve.js turns one into a run. The older /api/agents routes (the isolated agent
// processes of server.js) are another thing and are not touched.
//
// Who may do what (the tiers of lib/skills/api-v2.js, which this file follows):
//
//   read      the owner, the Assistant and agents: the library, one agent, its revisions, a diff, an export, what a
//             ref would run as. Never a guest (an agent's instructions are the owner's).
//   draft     the owner (from SynaBun's own page) and agents (the Assistant by its brain's launch credential, a
//             worker by its run's proof): a new draft, a change to one, a copy, an import, sending a draft to
//             review, taking one's own back or withdrawing it. What the Assistant or an agent makes waits in
//             review; neither may touch a draft the owner is working on.
//   owner     the owner, from SynaBun's own page only: approving, asking for changes, withdrawing an approved
//             revision, deleting an agent, a test run (which runs a draft, so it is an approval of a kind). A
//             request with an agent's headers is refused here (403 UI_ONLY) whatever else it says, as is a guest,
//             another site's page, a request without the page's X-SynaBun-UI header, or one without this boot's
//             page secret cookie (lib/page-session.js, 403 PAGE_SECRET_REQUIRED): the gating of the Skills
//             Service's installs and of the Test density setting.
//
// An agent is named by its id in the path and its scope in the query: `?scope=project&project=<absolute path>`
// (nothing: the global library). Ids are checked by shape before anything is looked up; no id is ever a path.
// Errors are JSON `{ ok: false, error, code, … }`: 400 for what the request says, 403 for who sent it, 404, 409
// for a conflict (with the current etag), 413 for a limit, 428 when an etag is missing.

import { sendGuardError } from './http-guards.js';
import { registerTeamStudioRoutes } from './teams/api.js'; // agents-p4
import { sharedTeamScheduler } from './teams/scheduler.js'; // agents-p4
import { principalOf } from './skills/api-v2.js';
import { scopeOf } from './agents/registry.js';
import {
  AGENT_CAPABILITIES, AGENT_LIMITS, AGENT_PERMISSION_POLICIES, AGENT_PROVIDERS, AGENT_STATUSES, AGENT_TASK_CLASSES,
  dispatchFields, lintAgentDefinition, sameScope,
} from './agents/schema.js';
// agents-p6: agent-forge (the guide, the catalog a definition is filled from, the privilege check) and native export
import { AgentRegistryError } from './agents/registry.js';
import { privilegeDelta, privilegesOf } from './agents/schema.js';
import { exportNative, importNative, nativeFormats } from './agents/native-export.js';

export const AGENTS_STUDIO_BASE = '/api/agents-studio/v1';
export const AGENTS_STUDIO_VERSION = 1;
/** What this server's routes can do: the page shows a feature only while it is listed (public/ reloads before lib/). */
export const AGENTS_STUDIO_CAPABILITIES = Object.freeze([
  'agents', 'drafts', 'validate', 'lint', 'reviews', 'revisions', 'diff', 'copy', 'export', 'import', 'import-claude-agent', 'resolve', 'runs', 'test-run',
  'teams', // agents-p4: GET /teams, GET /teams/:id, POST /teams/:id/land, POST /teams/:id/discard
  // agents-p6: agent-forge and native export (the routes of the agents-p6 block below)
  'guide', 'forge-catalog', 'checks', 'native-export', 'native-import',
]);
/** The work time of a test run when the request names none (the dispatcher's own minimum). */
export const TEST_RUN_MINUTES = 20;
export const TEST_RUN_TAG = 'agent-test';

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ETAG_RE = /^sha256:[0-9a-f]{64}$/;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4000) => (typeof value === 'string' ? value.slice(0, max) : '');

function fail(res, err) {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const body = { ok: false, error: status >= 500 ? `The agents service failed: ${err?.message || err}` : (err?.message || String(err)) };
  if (typeof err?.code === 'string' && !/^E[A-Z]+$/.test(err.code)) body.code = err.code;
  for (const key of ['errors', 'currentEtag', 'current', 'found', 'problems', 'field', 'revisionStatus', 'agentRef', 'suggestions', 'diagnostics']) if (err?.[key] !== undefined) body[key] = err[key];
  return res.status(status).json(body);
}

/** The etag a request names: `If-Match` (quoted or not) or `expectedEtag` in the body. null when it names none. */
function expectedEtagOf(req) {
  const header = typeof req.headers['if-match'] === 'string' ? req.headers['if-match'].trim().replace(/^W\//, '').replace(/^"|"$/g, '') : '';
  const named = header || (typeof req.body?.expectedEtag === 'string' ? req.body.expectedEtag.trim() : '');
  return ETAG_RE.test(named) ? named : null;
}

/** Who made (or is changing) a revision, as the contract's author: { kind, ref }. */
export function authorOf(principal) {
  if (principal?.kind === 'assistant') return { kind: 'assistant', ref: principal.assistantSessionId || principal.terminal || null };
  if (principal?.kind === 'agent') return { kind: 'agent', ref: principal.terminal || null };
  return { kind: 'owner', ref: null };
}

/**
 * May this caller change that draft? The owner changes any. The Assistant changes what it or an agent made; an
 * agent only what it made itself. Neither changes a draft the owner is working on.
 */
export function mayEditDraft(principal, draftAuthor) {
  if (principal?.kind === 'owner') return true;
  const author = isObject(draftAuthor) ? draftAuthor : { kind: 'owner', ref: null };
  if (author.kind === 'owner' || author.kind === 'system') return false;
  if (principal?.kind === 'assistant') return true;
  return principal?.kind === 'agent' && author.kind === 'agent' && !!principal.terminal && author.ref === principal.terminal;
}

/** One run of an agent, as the list of its runs shows it. */
function runRow(run) {
  return {
    runId: run.runId, title: run.title || null, state: run.state, status: run.status || null, outcome: run.outcome || null,
    summary: text(run.lastResult?.summary || '', 600) || null,
    provider: run.provider || null, model: run.model || null, effort: run.effort || null, capability: run.capability || null,
    agentRef: run.agentRef || null, agentRevision: run.agentRevision ?? null, test: run.agentPin?.test === true,
    corrections: Array.isArray(run.agentPin?.corrections) ? run.agentPin.corrections : [],
    assistantSessionId: run.assistantSessionId || null, cwd: run.cwd || null, project: run.project || null,
    createdAt: run.createdAt || null, startedAt: run.startedAt || null, finishedAt: run.finishedAt || null,
    elapsedMs: run.elapsedMs ?? null, costUsd: run.costUsd ?? 0, active: run.active === true,
  };
}

/**
 * @param {object} app express app
 * @param {object} o
 * @param {object} o.registry lib/agents/registry.js
 * @param {object} o.resolver lib/agents/resolve.js createAgentResolver
 * @param {() => object|null} [o.dispatcher] the Assistant's dispatcher (the runs of an agent, a test run)
 * @param {(req) => boolean} [o.isGuestRequest]
 * @param {Function} [o.ownerGuard] lib/http-guards.js ownerRouteGuard(…) of this server (Host, Origin, guests)
 * @param {{ verify(req): boolean, require(req, res, next) }} [o.pageSession] lib/page-session.js: the owner's writes
 *   carry this boot's page secret
 * @param {(req) => string|null} [o.assistantOf] the Assistant session a request's brain credential belongs to
 * @param {(req) => ({ status, code, error }|null)} [o.terminalRefusal] an agent's pin counts only with its proof
 * @param {() => { path: string, label?: string }[]} [o.projects] the registered projects (for the page's scope picker)
 * @param {(definition: object) => object} [o.lintContext] what the host knows, for the softer checks:
 *   { knownSkills, knownModels, knownCategories, knownColorTokens } (lib/agents/schema.js lintAgentDefinition)
 * @param {object|null} [o.forge] agents-p6: lib/agents/forge-host.js createAgentForgeHost(…): the agent-forge guide,
 *   the catalog a definition is filled from, a Claude Code agent file read by its path, and where a native export
 *   is written. Without it the agent-forge routes answer 503 `FORGE_UNAVAILABLE`.
 */
export function registerAgentsStudioRoutes(app, {
  registry, resolver, dispatcher = () => null, isGuestRequest = null, ownerGuard = null, pageSession = null,
  assistantOf = null, terminalRefusal = null, projects = () => [], lintContext = null,
  // agents-p4: the team scheduler (lib/teams/scheduler.js), or what returns it. Default: the one server.js shares.
  teams = sharedTeamScheduler,
  forge = null, // agents-p6
} = {}) {
  if (!registry || !resolver) throw new Error('registerAgentsStudioRoutes needs { registry, resolver }');
  const route = (method, path, ...handlers) => app[method](`${AGENTS_STUDIO_BASE}${path}`, ...handlers);
  const safe = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err); } };

  // ── who is asking ──
  const refusedPin = (req, res) => {
    let refused = null;
    try { refused = typeof terminalRefusal === 'function' ? terminalRefusal(req) : null; } catch { refused = { status: 403, code: 'TERMINAL_TOKEN_INVALID', error: 'The run this request names could not be checked.' }; }
    if (!refused) return false;
    sendGuardError(res, Number(refused.status) || 403, String(refused.code || 'TERMINAL_TOKEN_INVALID'), String(refused.error || 'This request names a run it cannot prove it is.'));
    return true;
  };
  const json = (req, res, next) => {
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return sendGuardError(res, 403, 'CROSS_SITE', 'Cross-site requests are refused.');
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && typeof req.is === 'function' && !req.is('application/json')) return sendGuardError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON (Content-Type: application/json).');
    if (req.body !== undefined && req.body !== null && (typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ ok: false, error: 'The body is a JSON object.', code: 'invalid_body' });
    next();
  };
  /** The owner's own page: no agent header, the page's header, this boot's page secret, the owner route guard. */
  const ownerPage = (req, res, next) => {
    if (req.headers['x-synabun-ui'] !== '1') return sendGuardError(res, 403, 'UI_HEADER_REQUIRED', 'Send the X-SynaBun-UI: 1 header.');
    if (pageSession && !pageSession.verify(req)) return pageSession.require(req, res, next);
    return ownerGuard ? ownerGuard(req, res, next) : next();
  };
  const reader = (req, res, next) => {
    if (refusedPin(req, res)) return;
    req.principal = principalOf(req, isGuestRequest, assistantOf);
    if (req.principal.kind === 'guest') return sendGuardError(res, 403, 'GUEST_FORBIDDEN', 'Available to the owner only.');
    next();
  };
  const writer = (req, res, next) => {
    if (refusedPin(req, res)) return;
    req.principal = principalOf(req, isGuestRequest, assistantOf);
    if (req.principal.kind === 'guest') return sendGuardError(res, 403, 'GUEST_FORBIDDEN', 'Available to the owner only.');
    // A request without an agent's headers is the owner's page only when it proves it: a local process that merely
    // left the headers out is nobody.
    if (req.principal.kind === 'owner') return ownerPage(req, res, next);
    next();
  };
  const owner = (req, res, next) => {
    req.principal = principalOf(req, isGuestRequest, assistantOf);
    if (req.principal.kind !== 'owner') {
      const guest = req.principal.kind === 'guest';
      return sendGuardError(res, 403, guest ? 'GUEST_FORBIDDEN' : 'UI_ONLY', guest ? 'Available to the owner only.' : 'Approving, withdrawing, deleting and test runs are the owner\'s, from SynaBun\'s own page: send the draft to review and ask the owner to look at it in Agents.');
    }
    return ownerPage(req, res, next);
  };

  // ── what the request names ──
  const idCheck = (req, res, next) => (ID_RE.test(String(req.params.id || '')) ? next() : res.status(400).json({ ok: false, error: 'Not an agent id.', code: 'invalid_id' }));
  /** The scope a request names in its query: `scope=project&project=<path>`; nothing is the global library. */
  const scopeFromQuery = (query = {}) => {
    const kind = String(query.scope || '').trim().toLowerCase();
    const project = typeof query.project === 'string' && query.project ? query.project : null;
    if (kind === 'project' || (!kind && project)) return scopeOf({ kind: 'project', path: project || '' });
    if (kind && kind !== 'global') return scopeOf({ kind });
    return { kind: 'global' };
  };
  const keyOf = (req) => ({ id: req.params.id, scope: scopeFromQuery(req.query) });
  const lintOf = (definition) => {
    let known = {};
    try { known = (typeof lintContext === 'function' ? lintContext(definition) : null) || {}; } catch { known = {}; }
    return lintAgentDefinition(definition, known);
  };
  const withEtag = (res, etag) => { if (etag) res.set('ETag', `"${etag}"`); return res; };
  const draftBody = (out) => ({ ok: true, agent: out.agent, draft: out.draft, etag: out.etag, validation: out.validation, warnings: lintOf(out.draft), ...(out.notes ? { notes: out.notes } : {}), ...(out.action ? { action: out.action } : {}) });
  /** 403 unless the caller may change the draft this agent has (a caller that is making the first draft may). */
  const refuseOthersDraft = (req, res, key) => {
    if (req.principal.kind === 'owner') return false;
    const draft = registry.revision(key, 'draft');
    if (!draft || mayEditDraft(req.principal, draft.author)) return false;
    sendGuardError(res, 403, 'NOT_AUTHOR', draft.author?.kind === 'owner' ? 'The owner is working on this draft: it is not an agent\'s to change.' : 'This draft was made by another agent.');
    return true;
  };
  const dispatcherOf = () => { try { return (typeof dispatcher === 'function' ? dispatcher() : dispatcher) || null; } catch { return null; } };

  // ── reading ──
  route('get', '/capabilities', reader, safe(async (req, res) => {
    let list = [];
    try { list = (typeof projects === 'function' ? projects() : projects) || []; } catch { list = []; }
    res.json({
      ok: true, version: AGENTS_STUDIO_VERSION, capabilities: AGENTS_STUDIO_CAPABILITIES,
      providers: AGENT_PROVIDERS, capabilityLevels: AGENT_CAPABILITIES, permissionPolicies: AGENT_PERMISSION_POLICIES,
      taskClasses: AGENT_TASK_CLASSES, statuses: AGENT_STATUSES, limits: AGENT_LIMITS,
      projects: list.filter((p) => p && typeof p.path === 'string' && p.path).map((p) => ({ path: p.path, label: text(p.label || '', 200) || null })).slice(0, 500),
      testRun: { available: !!dispatcherOf(), minutes: TEST_RUN_MINUTES },
      stats: registry.stats(),
    });
  }));
  route('get', '/agents', reader, safe(async (req, res) => {
    const q = req.query || {};
    // What a run would get: the agents that can run, a project's own in place of the global one of its id.
    if (q.view === 'catalog') return res.json({ ok: true, agents: resolver.runnable({ projectPath: typeof q.cwd === 'string' && q.cwd ? q.cwd : null }) });
    const scope = ['global', 'project'].includes(String(q.scope || '').toLowerCase()) ? String(q.scope).toLowerCase() : 'all';
    const status = typeof q.status === 'string' && q.status ? q.status.split(',').map((item) => item.trim()).filter(Boolean) : null;
    res.json({ ok: true, agents: registry.list({ scope, projectPath: typeof q.project === 'string' && q.project ? q.project : null, status, q: text(q.q || '', 200) }) });
  }));
  route('get', '/resolve', reader, safe(async (req, res) => {
    const resolved = resolver.resolve(text(req.query?.ref || '', 200), { projectPath: typeof req.query?.cwd === 'string' && req.query.cwd ? req.query.cwd : null });
    res.json({ ok: true, ref: resolved.ref, requested: resolved.requested, id: resolved.id, revision: resolved.revision, etag: resolved.etag, scope: resolved.scope, name: resolved.name, fields: dispatchFields(resolved.definition) });
  }));
  route('get', '/export', reader, safe(async (req, res) => {
    const q = req.query || {};
    const scope = ['global', 'project'].includes(String(q.scope || '').toLowerCase()) ? String(q.scope).toLowerCase() : 'all';
    const chosen = scope === 'all' && !q.project ? null : registry.list({ scope, projectPath: typeof q.project === 'string' && q.project ? q.project : null }).map((agent) => ({ id: agent.id, scope: agent.scope }));
    res.json({ ok: true, bundle: registry.exportBundle({ agents: chosen }) });
  }));
  route('get', '/agents/:id', reader, idCheck, safe(async (req, res) => {
    const agent = registry.get(keyOf(req));
    const draft = agent.draftDefinition;
    const checked = draft ? registry.validate(draft) : null;
    withEtag(res, draft?.etag || agent.approvedEtag).json({ ok: true, agent, ...(draft ? { validation: { ok: checked.ok, errors: checked.errors }, warnings: lintOf(draft) } : {}) });
  }));
  route('get', '/agents/:id/revisions', reader, idCheck, safe(async (req, res) => res.json({ ok: true, revisions: registry.revisions(keyOf(req)) })));
  route('get', '/agents/:id/revisions/:revision', reader, idCheck, safe(async (req, res) => {
    const which = /^[1-9][0-9]{0,8}$/.test(req.params.revision) ? Number(req.params.revision) : ['draft', 'approved'].includes(req.params.revision) ? req.params.revision : null;
    if (which === null) return res.status(400).json({ ok: false, error: 'A revision is a number, "draft" or "approved".', code: 'invalid_revision' });
    registry.get(keyOf(req)); // 404 for an agent that does not exist
    const definition = registry.revision(keyOf(req), which);
    if (!definition) return res.status(404).json({ ok: false, error: 'There is no such revision.', code: 'revision_not_found' });
    withEtag(res, definition.etag).json({ ok: true, revision: definition });
  }));
  route('get', '/agents/:id/diff', reader, idCheck, safe(async (req, res) => {
    const pick = (value) => (typeof value === 'string' && value ? value : null);
    res.json({ ok: true, diff: registry.diff(keyOf(req), { from: pick(req.query?.from), to: pick(req.query?.to) }) });
  }));
  route('get', '/agents/:id/export', reader, idCheck, safe(async (req, res) => res.json({ ok: true, bundle: registry.exportBundle({ agents: [keyOf(req)] }) })));
  route('get', '/agents/:id/runs', reader, idCheck, safe(async (req, res) => {
    // The roster of runs is the owner's, and the Assistant's for its own session's: never a worker's.
    if (req.principal.kind === 'agent') return sendGuardError(res, 403, 'RUNS_FORBIDDEN', 'The runs of an agent are listed for the owner and for the Assistant\'s own session.');
    // The owner's page proves itself by this boot's page secret: a local process that merely sends no agent header
    // reads no roster of runs (as GET /api/assistant/runs).
    if (req.principal.kind === 'owner' && pageSession && !pageSession.verify(req)) return pageSession.require(req, res, () => {});
    const key = keyOf(req);
    registry.get(key);
    const from = dispatcherOf();
    if (!from) return res.json({ ok: true, runs: [], available: false });
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 50));
    const rows = from.list({ limit: 500, ...(req.principal.kind === 'assistant' ? { assistantSessionId: req.principal.assistantSessionId } : {}) })
      .filter((run) => run.agentPin?.id === key.id && sameScope(run.agentPin.scope, key.scope));
    res.json({ ok: true, available: true, runs: rows.slice(0, limit).map(runRow), total: rows.length });
  }));

  // ── checks (nothing is stored) ──
  const definitionOf = (body) => (isObject(body?.definition) ? body.definition : body);
  route('post', '/validate', json, reader, safe(async (req, res) => {
    const checked = registry.validate(definitionOf(req.body || {}));
    res.json({ ok: true, valid: checked.ok, errors: checked.errors, value: checked.value, warnings: lintOf(checked.value) });
  }));
  route('post', '/lint', json, reader, safe(async (req, res) => res.json({ ok: true, warnings: lintOf(definitionOf(req.body || {})) })));

  // ── drafts ──
  route('post', '/agents', json, writer, safe(async (req, res) => {
    const out = registry.create(definitionOf(req.body || {}), { author: authorOf(req.principal) });
    withEtag(res, out.etag).status(201).json(draftBody(out));
  }));
  route('post', '/agents/:id/draft', json, writer, idCheck, safe(async (req, res) => {
    const key = keyOf(req);
    if (refuseOthersDraft(req, res, key)) return;
    const out = registry.openDraft(key, { author: authorOf(req.principal) });
    withEtag(res, out.etag).json(draftBody(out));
  }));
  route('patch', '/agents/:id/draft', json, writer, idCheck, safe(async (req, res) => {
    const key = keyOf(req);
    if (refuseOthersDraft(req, res, key)) return;
    const body = req.body || {};
    const { expectedEtag: _etag, patch: named, ...rest } = body;
    const out = registry.updateDraft(key, isObject(named) ? named : rest, { expectedEtag: expectedEtagOf(req), author: authorOf(req.principal) });
    withEtag(res, out.etag).json(draftBody(out));
  }));
  route('delete', '/agents/:id/draft', json, writer, idCheck, safe(async (req, res) => {
    const key = keyOf(req);
    if (refuseOthersDraft(req, res, key)) return;
    res.json({ ok: true, ...registry.discardDraft(key, { expectedEtag: expectedEtagOf(req) }) });
  }));
  route('post', '/agents/:id/copy', json, writer, idCheck, safe(async (req, res) => {
    const body = req.body || {};
    const out = registry.copy(keyOf(req), { id: typeof body.id === 'string' && body.id ? body.id : null, scope: body.scope !== undefined && body.scope !== null ? scopeOf(body.scope) : null, author: authorOf(req.principal) });
    withEtag(res, out.etag).status(201).json(draftBody(out));
  }));
  route('post', '/import', json, writer, safe(async (req, res) => {
    const body = req.body || {};
    const bundle = body.bundle !== undefined ? body.bundle : body;
    // Replacing a draft that is already there is the owner's: an agent's import never overwrites one.
    const out = registry.importBundle(bundle, {
      author: authorOf(req.principal), scope: body.scope !== undefined && body.scope !== null ? scopeOf(body.scope) : null,
      replaceDrafts: req.principal.kind === 'owner' && body.replaceDrafts === true, prefer: body.prefer === 'draft' ? 'draft' : 'approved',
    });
    res.json({ ok: true, ...out });
  }));
  route('post', '/import-claude-agent', json, writer, safe(async (req, res) => {
    const body = req.body || {};
    const out = registry.importClaudeAgent(body.markdown, {
      fileName: text(body.fileName || '', 500), id: typeof body.id === 'string' && body.id ? body.id : null,
      scope: body.scope !== undefined && body.scope !== null ? scopeOf(body.scope) : null, author: authorOf(req.principal),
      replaceDraft: req.principal.kind === 'owner' && body.replaceDraft === true,
    });
    withEtag(res, out.etag).status(out.action === 'created' ? 201 : 200).json(draftBody(out));
  }));

  // ── review ──
  route('post', '/agents/:id/submit', json, writer, idCheck, safe(async (req, res) => {
    const key = keyOf(req);
    if (refuseOthersDraft(req, res, key)) return;
    const out = registry.submit(key, { actor: authorOf(req.principal), expectedEtag: expectedEtagOf(req), note: text(req.body?.note || '', 2000) || null });
    withEtag(res, out.etag).json(draftBody(out));
  }));
  route('post', '/agents/:id/request-changes', json, writer, idCheck, safe(async (req, res) => {
    // The owner asks for changes; the author takes its own submission back to edit it.
    const key = keyOf(req);
    if (refuseOthersDraft(req, res, key)) return;
    const out = registry.requestChanges(key, { actor: authorOf(req.principal), expectedEtag: expectedEtagOf(req), note: text(req.body?.note || '', 2000) || null });
    withEtag(res, out.etag).json(draftBody(out));
  }));
  route('post', '/agents/:id/approve', json, owner, idCheck, safe(async (req, res) => {
    const out = registry.approve(keyOf(req), { actor: 'owner', expectedEtag: expectedEtagOf(req), note: text(req.body?.note || '', 2000) || null });
    withEtag(res, out.etag).json({ ok: true, agent: out.agent, revision: out.revision, etag: out.etag });
  }));
  route('post', '/agents/:id/withdraw', json, writer, idCheck, safe(async (req, res) => {
    const key = keyOf(req);
    const body = req.body || {};
    const which = body.revision === undefined || body.revision === null || body.revision === '' ? null : body.revision;
    if (req.principal.kind !== 'owner') {
      // An agent withdraws the working revision it made, never a stored one: taking an approved agent out of use is the owner's.
      const draft = registry.revision(key, 'draft');
      if (body.all === true || !draft || (which !== null && which !== 'draft' && Number(which) !== draft.revision)) {
        return sendGuardError(res, 403, 'UI_ONLY', 'Withdrawing an approved revision is the owner\'s, from SynaBun\'s own page.');
      }
      if (refuseOthersDraft(req, res, key)) return;
    }
    const out = registry.withdraw(key, { revision: req.principal.kind === 'owner' ? which : 'draft', all: req.principal.kind === 'owner' && body.all === true, actor: authorOf(req.principal), note: text(body.note || '', 2000) || null });
    res.json({ ok: true, ...out });
  }));
  route('delete', '/agents/:id', json, owner, idCheck, safe(async (req, res) => res.json({ ok: true, ...registry.remove(keyOf(req)) })));

  // ── a test run ──
  // The owner tries an agent before approving it: a short run of the draft (or of a stored revision), dispatched
  // from the page, outside every Assistant session. The run is marked as a test on its record.
  route('post', '/agents/:id/test-run', json, owner, idCheck, safe(async (req, res) => {
    const key = keyOf(req);
    const body = req.body || {};
    const agent = registry.get(key);
    const from = dispatcherOf();
    if (!from) return res.status(503).json({ ok: false, error: 'Runs are not available on this server yet.', code: 'DISPATCH_UNAVAILABLE' });
    const asked = body.revision === undefined || body.revision === null || body.revision === '' ? (agent.draftDefinition ? 'draft' : 'approved') : body.revision;
    const which = asked === 'draft' || asked === 'approved' ? asked : (/^[1-9][0-9]{0,8}$/.test(String(asked)) ? Number(asked) : null);
    if (which === null) return res.status(400).json({ ok: false, error: 'revision is a number, "draft" or "approved".', code: 'invalid_revision' });
    const definition = registry.revision(key, which);
    if (!definition) return res.status(404).json({ ok: false, error: 'There is no such revision to run.', code: 'revision_not_found' });
    if (definition.status === 'withdrawn') return res.status(409).json({ ok: false, error: 'A withdrawn revision is not run.', code: 'AGENT_NOT_APPROVED' });
    const task = text(body.task || '', 16000).trim();
    if (!task) return res.status(400).json({ ok: false, error: 'task is required: what the agent should do in this test.', code: 'TASK_REQUIRED' });
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : (definition.scope.kind === 'project' ? definition.scope.path : null);
    if (!cwd) return res.status(400).json({ ok: false, error: 'cwd is required: the folder the test runs in.', code: 'CWD_REQUIRED' });
    const spec = { task, cwd, title: text(body.title || `Test: ${definition.name || definition.id}`, 80), maxMinutes: Number(body.maxMinutes ?? body.max_minutes) || TEST_RUN_MINUTES, tags: [TEST_RUN_TAG, ...(Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === 'string' && tag && tag !== TEST_RUN_TAG).slice(0, 9) : [])] };
    // What the owner overrides for this one test (the dispatcher's own spelling, and the tools' snake case).
    for (const [key2, ...names] of [['provider', 'provider'], ['model', 'model'], ['effort', 'effort'], ['accountId', 'accountId', 'account_id'], ['capability', 'capability'], ['permissionPolicy', 'permissionPolicy', 'permission_policy'], ['tools', 'tools'], ['usesBrowser', 'usesBrowser', 'uses_browser'], ['usesComputer', 'usesComputer', 'uses_computer'], ['moreloginProfile', 'moreloginProfile', 'morelogin_profile'], ['context', 'context'], ['budgetUsd', 'budgetUsd', 'budget_usd']]) {
      const value = names.map((name) => body[name]).find((item) => item !== undefined && item !== null && item !== '');
      if (value !== undefined) spec[key2] = value;
    }
    const prepared = resolver.prepareRevision(spec, definition, { requested: `${key.id}@${which}` });
    const result = await from.dispatch(prepared, { assistantSessionId: null, origin: 'ui' });
    res.status(result.queued ? 202 : 200).json({ ...result, ok: true, test: true, revision: definition.revision, revisionStatus: definition.status });
  }));

  // ── agents-p4 BEGIN: teams (lib/teams/api.js) ──────────────────────────────
  // The list and one team for whoever reads the library; landing and discarding are the owner's, from SynaBun's own
  // page only (the `owner` tier above: no agent header, X-SynaBun-UI, the page secret, the owner route guard).
  registerTeamStudioRoutes({ route, reader, owner, json, scheduler: teams });
  // ── agents-p4 END ──────────────────────────────────────────────────────────
  // ════ agents-p6 BEGIN: agent-forge and native export (docs/agents.md → agent-forge, Native export) ════
  // What the MCP tool `agent_definition` and Agents Studio add to the routes above. Nothing here approves, and
  // nothing here makes a draft usable: a draft still waits for the owner's approval (POST /agents/:id/approve).
  //   forge     the owner and the Assistant (by its brain's launch credential): the guide, the catalog, the
  //             privilege check, an export's preview, an import of a host's own agent as a draft. Never a worker
  //             (403 FORGE_ASSISTANT_ONLY): agent-forge is the Assistant's workflow.
  //   owner     writing an export into a host's folder: the owner's page only, as an approval is.
  const FORGE_ERROR_KEYS = ['existingDigest', 'currentDigest', 'path', 'files', 'hosts', 'host', 'instead', 'agents'];
  /** `safe`, with the keys the forge's own errors carry (a digest to name, the files of the guide, the hosts). */
  const forgeSafe = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      const extra = {};
      for (const key of FORGE_ERROR_KEYS) if (err?.[key] !== undefined) extra[key] = err[key];
      if (Object.keys(extra).length) { const send = res.json.bind(res); res.json = (body) => send({ ...body, ...extra }); }
      fail(res, err);
    }
  };
  const forgeUnavailable = (res) => res.status(503).json({ ok: false, error: 'agent-forge is not available on this server yet.', code: 'FORGE_UNAVAILABLE' });
  const noWorker = (req, res, next) => {
    if (req.principal.kind === 'agent') return sendGuardError(res, 403, 'FORGE_ASSISTANT_ONLY', 'agent-forge is the Assistant\'s workflow and the owner\'s page: a worker neither reads its guide nor previews or imports through it.');
    if (!forge) return forgeUnavailable(res);
    next();
  };
  const forgeReader = (req, res, next) => reader(req, res, () => noWorker(req, res, next));
  const forgeWriter = (req, res, next) => writer(req, res, () => noWorker(req, res, next));
  const forgeOwner = (req, res, next) => owner(req, res, () => (forge ? next() : forgeUnavailable(res)));
  const queryText = (value, max = 4000) => (typeof value === 'string' && value ? value.slice(0, max) : null);
  /** `draft`, `approved` or a number, as a request names a revision; undefined for anything else. */
  const revisionOf = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === 'draft' || value === 'approved') return value;
    return /^[1-9][0-9]{0,8}$/.test(String(value)) ? Number(value) : undefined;
  };

  // The agent-forge workflow SynaBun ships (skills/agent-forge): its SKILL.md, or one of its files (`file`).
  route('get', '/guide', forgeReader, forgeSafe(async (req, res) => res.json({ ok: true, ...forge.guide(queryText(req.query?.file, 512) || 'SKILL.md') })));

  // Everything a definition is filled from, so nothing in one is a guess: the agents there are (with their status),
  // and what exists on this server (providers, models, efforts, tool groups, MCP servers, colour tokens, MoreLogin
  // profiles agents may choose, registered projects). `provider` + `q` narrow the models; `project` picks whose
  // colour tokens; `search` narrows the agents.
  route('get', '/forge/catalog', forgeReader, forgeSafe(async (req, res) => {
    const q = req.query || {};
    const described = await forge.describe({ provider: queryText(q.provider, 40), q: queryText(q.q, 200), projectPath: queryText(q.project) });
    const agents = registry.list({ q: queryText(q.search, 200) || '' }).map((agent) => ({
      ref: agent.ref, id: agent.id, scope: agent.scope.kind, ...(agent.scope.kind === 'project' ? { projectPath: agent.scope.path } : {}),
      name: agent.name, description: text(agent.description, 200), status: agent.status, approvedRevision: agent.approvedRevision,
      draft: agent.draft ? { revision: agent.draft.revision, status: agent.draft.status, author: agent.draft.author?.kind || null } : null,
      provider: agent.provider, model: agent.model, capability: agent.capability, taskClasses: agent.taskClasses,
    }));
    res.json({
      ok: true, version: AGENTS_STUDIO_VERSION, agents, ...described,
      taskClasses: AGENT_TASK_CLASSES, capabilityLevels: AGENT_CAPABILITIES, permissionPolicies: AGENT_PERMISSION_POLICIES,
      limits: { id: AGENT_LIMITS.id, name: AGENT_LIMITS.name, description: AGENT_LIMITS.description, instructions: AGENT_LIMITS.instructions, mcpServers: AGENT_LIMITS.mcpServers, skills: AGENT_LIMITS.skills },
      nativeHosts: nativeFormats().map((format) => ({ host: format.host, supported: format.supported, format: format.format })),
    });
  }));

  // The checks of a definition with what it would let a worker do: the contract's errors, the softer findings, the
  // privileges (capability, browser, computer, servers, profile) and what is wider than the approved revision.
  const checksOf = (definition, against) => {
    const checked = registry.validate(definition);
    return {
      valid: checked.ok, errors: checked.errors, warnings: lintOf(checked.value), privileges: privilegesOf(checked.value),
      delta: { against: against ? against.revision : null, ...privilegeDelta(against || null, checked.value) },
    };
  };
  route('post', '/checks', json, forgeReader, forgeSafe(async (req, res) => {
    const definition = definitionOf(req.body || {});
    let against = null;
    try { if (ID_RE.test(String(definition?.id || ''))) against = registry.revision({ id: definition.id, scope: definition.scope !== undefined && definition.scope !== null ? scopeOf(definition.scope) : { kind: 'global' } }, 'approved'); } catch { against = null; }
    res.json({ ok: true, ...checksOf(isObject(definition) ? definition : {}, against) });
  }));
  route('get', '/agents/:id/checks', forgeReader, idCheck, forgeSafe(async (req, res) => {
    const key = keyOf(req);
    const agent = registry.get(key);
    const which = revisionOf(req.query?.revision, agent.draftDefinition ? 'draft' : 'approved');
    if (which === undefined) return res.status(400).json({ ok: false, error: 'A revision is a number, "draft" or "approved".', code: 'invalid_revision' });
    const definition = registry.revision(key, which);
    if (!definition) return res.status(404).json({ ok: false, error: 'There is no such revision.', code: 'revision_not_found' });
    // A working revision is compared with what is approved now; a stored one with the revision it was made over.
    const against = definition.status === 'draft' || definition.status === 'in_review'
      ? registry.revision(key, 'approved')
      : (definition.parentRevision ? registry.revision(key, definition.parentRevision) : null);
    withEtag(res, definition.etag).json({ ok: true, id: agent.id, scope: agent.scope, revision: definition.revision, status: definition.status, etag: definition.etag, ...checksOf(definition, against) });
  }));

  // ── native export ──
  // What each host has for an agent of its own (or why it has nothing): the table of docs/agents.md.
  route('get', '/native-export/formats', reader, safe(async (req, res) => res.json({ ok: true, formats: nativeFormats(), writes: !!forge })));

  /** The revision a native export is made from, with the agent it belongs to. */
  const exportSource = (req, res, fallback) => {
    const key = keyOf(req);
    const agent = registry.get(key);
    const which = revisionOf(req.query?.revision ?? req.body?.revision, fallback(agent));
    if (which === undefined) { res.status(400).json({ ok: false, error: 'A revision is a number, "draft" or "approved".', code: 'invalid_revision' }); return null; }
    const definition = registry.revision(key, which);
    if (!definition) { res.status(404).json({ ok: false, error: 'There is no such revision.', code: 'revision_not_found' }); return null; }
    return { key, agent, definition };
  };
  /**
   * Where an export goes unless the request says (`target`, and `targetProject` for a project: `project` in the
   * query is the agent's own scope): a project's agent into its project, a global one to the account.
   */
  const targetOf = (source, definition) => {
    const kind = queryText(source?.target, 20);
    const project = queryText(source?.targetProject);
    if (kind) return { target: kind, projectPath: project };
    if (project) return { target: 'project', projectPath: project };
    return definition.scope.kind === 'project' ? { target: 'project', projectPath: definition.scope.path } : { target: 'account', projectPath: null };
  };

  // A preview: the file's text for a host, what it cannot hold, and what is at its place now. Reads only: nothing
  // is written by this route, whoever asks. A draft may be previewed; only an approved revision is ever written.
  route('get', '/agents/:id/native-export', forgeReader, idCheck, forgeSafe(async (req, res) => {
    const found = exportSource(req, res, (agent) => (agent.approvedDefinition ? 'approved' : 'draft'));
    if (!found) return;
    const { key, definition } = found;
    const exported = exportNative(definition, queryText(req.query?.host, 40) || definition.provider);
    const head = { ok: true, id: key.id, scope: definition.scope, revision: definition.revision, status: definition.status, approved: definition.status === 'approved', written: false };
    if (!exported.supported) return res.json({ ...head, ...exported, target: null, writable: false });
    let target = null;
    let targetProblem = null;
    try { target = forge.targets.inspect(forge.targets.resolveTarget(exported, { id: key.id, ...targetOf(req.query, definition) }), exported, { id: key.id }); } catch (err) {
      if (!Number.isInteger(err?.status) || err.status >= 500) throw err;
      targetProblem = { code: err.code || null, error: err.message };
    }
    res.json({
      ...head, ...exported, target, ...(targetProblem ? { targetProblem } : {}),
      writable: head.approved && !!target?.writable,
      next: head.approved ? 'Only the owner writes it, from Agents Studio (the agent\'s Export): this preview wrote nothing.' : 'This revision is not approved: only an approved revision is exported, and only by the owner from Agents Studio.',
    });
  }));

  // The owner writes an export into the host's folder: the account level, or a registered project. Exactly what was
  // previewed (`contentDigest`), of an approved revision only; what is already there is replaced only with `replace`
  // and the digest the owner saw (`expectedDigest`).
  route('post', '/agents/:id/native-export', json, forgeOwner, idCheck, forgeSafe(async (req, res) => {
    const body = req.body || {};
    const found = exportSource(req, res, () => 'approved');
    if (!found) return;
    const { key, definition } = found;
    if (definition.status !== 'approved') return res.status(409).json({ ok: false, error: 'Only an approved revision is exported: approve the draft first.', code: 'AGENT_NOT_APPROVED', revisionStatus: definition.status });
    const exported = exportNative(definition, text(body.host || '', 40) || definition.provider);
    if (!exported.supported) return res.status(400).json({ ok: false, error: exported.reason, code: 'no_native_format', host: exported.host, instead: exported.instead });
    const named = typeof body.contentDigest === 'string' ? body.contentDigest.trim() : '';
    if (!ETAG_RE.test(named)) return res.status(428).json({ ok: false, error: 'Name the digest of the export you looked at (contentDigest): what is written is exactly what was previewed.', code: 'digest_required', currentDigest: exported.digest });
    if (named !== exported.digest) return res.status(409).json({ ok: false, error: 'The export is not what you looked at any more: preview it again.', code: 'content_changed', currentDigest: exported.digest });
    const resolved = forge.targets.resolveTarget(exported, { id: key.id, ...targetOf(body, definition) });
    const result = forge.targets.write(resolved, exported, { id: key.id, replace: body.replace === true, expectedDigest: typeof body.expectedDigest === 'string' ? body.expectedDigest.trim() : null });
    forge.onExport?.({ action: 'exported', id: key.id, scope: definition.scope, revision: definition.revision, host: exported.host, target: result.kind, path: result.path, result: result.action });
    res.status(result.action === 'created' ? 201 : 200).json({ ok: true, id: key.id, revision: definition.revision, format: exported.format, ...result, unrepresented: exported.unrepresented, notes: exported.notes });
  }));

  // ── native import ──
  // A host's own agent as a draft: a Claude Code agent file (its text, or its path in an agents folder Claude Code
  // reads) or an OpenCode agent (the text of an opencode.json, or one entry). It lands as a draft, whatever it says.
  route('post', '/native-import', json, forgeWriter, forgeSafe(async (req, res) => {
    const body = req.body || {};
    const host = text(body.host || 'claude-code', 40).trim().toLowerCase();
    const author = authorOf(req.principal);
    const replaceDraft = req.principal.kind === 'owner' && body.replaceDraft === true;
    const scope = body.scope !== undefined && body.scope !== null ? scopeOf(body.scope) : null;
    const id = typeof body.id === 'string' && body.id ? body.id : null;
    if (host === 'claude-code') {
      const file = typeof body.path === 'string' && body.path && body.source === undefined ? forge.readClaudeAgentFile(body.path) : null;
      const out = registry.importClaudeAgent(file ? file.markdown : body.source, { fileName: file ? file.fileName : text(body.fileName || '', 500), id, scope, author, replaceDraft });
      return withEtag(res, out.etag).status(out.action === 'created' ? 201 : 200).json(draftBody(out));
    }
    const { content, notes } = importNative(host, body.source, { name: text(body.name || '', 200), id, scope });
    const key = { id: content.id, scope: content.scope };
    if (!registry.has(key)) {
      const out = registry.create(content, { author });
      return withEtag(res, out.etag).status(201).json(draftBody({ ...out, notes, action: 'created' }));
    }
    const agent = registry.get(key);
    const draft = agent.draftDefinition;
    if (draft && (!replaceDraft || draft.status !== 'draft')) throw new AgentRegistryError(409, 'draft_exists', `Agent "${content.id}" already has a draft; change that one, or pass another id.`, { currentEtag: draft.etag });
    // The content becomes the draft over the newest revision (an update with that revision's etag starts the draft).
    const etag = draft ? draft.etag : (agent.approvedEtag || [...agent.revisions].reverse().find((rev) => rev.etag)?.etag || null);
    const { id: _id, scope: _scope, ...fields } = content;
    const out = registry.updateDraft(key, fields, { expectedEtag: etag, author });
    withEtag(res, out.etag).json(draftBody({ ...out, notes, action: 'drafted' }));
  }));
  // ════ agents-p6 END ════

  return { base: AGENTS_STUDIO_BASE, capabilities: AGENTS_STUDIO_CAPABILITIES };
}

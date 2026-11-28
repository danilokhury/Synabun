// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: its requests
// ═══════════════════════════════════════════
//
// Every request of Agents Studio (docs/agents.md → REST API, /api/agents-studio/v1), in one client: the library of
// agent definitions, a draft and its etag, the review transitions, export and import, the runs of an agent, the
// owner's test run, and the teams (the contract of the team scheduler: a server that does not have those routes yet
// answers as "not there", never as an error). No DOM and no imports: `fetch` is handed in, so the client is tested
// under Node with a stand-in (tests/agents-studio-logic.test.mjs).
//
// What a caller gets back is the server's JSON; what it gets thrown is an AgentsApiError that keeps the status, the
// code and the body. Two of them are part of the editor's flow and have a name of their own:
//   428 etag_required   the request named no etag (a programming mistake of the page; `currentEtag` says which one)
//   409 etag_conflict   the draft changed since it was read: `currentEtag` and `current` (the definition now stored)
// The owner's writes carry `X-SynaBun-UI: 1`. A request refused because this boot's page secret is missing (a tab
// left open across a restart: 403 PAGE_SECRET_REQUIRED or UI_ONLY) asks for it once and is sent again.

export const AGENTS_BASE = '/api/agents-studio/v1';
export const PAGE_SESSION_PATH = '/api/page-session';
const PAGE_SECRET_CODES = new Set(['PAGE_SECRET_REQUIRED', 'UI_ONLY']);
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class AgentsApiError extends Error {
  /** @param {string} message @param {{ status?: number, code?: string|null, body?: object|null }} [o] */
  constructor(message, { status = 0, code = null, body = null } = {}) {
    super(message);
    this.name = 'AgentsApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** The draft changed since it was read: `currentEtag` and `current` say what is stored now. */
  get conflict() { return this.status === 409 && this.code === 'etag_conflict'; }
  /** The request named no etag. */
  get etagRequired() { return this.status === 428; }
  /** The route is not on this server (an older one, or a phase that is not built yet). */
  get absent() { return this.status === 404 && (!this.body || this.code === 'not_json'); }
  get currentEtag() { return typeof this.body?.currentEtag === 'string' ? this.body.currentEtag : null; }
  get current() { return this.body?.current && typeof this.body.current === 'object' ? this.body.current : null; }
  /** The problems a refusal lists (a definition that is not valid). */
  get errors() { return Array.isArray(this.body?.errors) ? this.body.errors : []; }
}

/** The query of a scope: `{ scope: 'project', project }` for a project's agent, nothing for the global library. */
export function scopeQuery(scope) {
  if (scope && scope.kind === 'project') return { scope: 'project', project: String(scope.path || '') };
  return {};
}

/** `?a=1&b=2` of the values that are there ('' when none). */
export function queryString(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * The team routes are not served here: the route is not on this server (404 with no JSON of the scheduler's), or the
 * scheduler is not running yet (503 TEAMS_UNAVAILABLE, lib/teams/api.js: the Assistant has not started). Both are
 * "not there", never an error.
 */
export function teamsUnavailable(error) {
  if (!(error instanceof AgentsApiError)) return false;
  return error.status === 404 || (error.status === 503 && error.code === 'TEAMS_UNAVAILABLE');
}

/** The parts of one team's answer (GET /teams/:id, lib/teams/api.js `teamDetail`) that sit beside `team`. */
const TEAM_DETAIL_PARTS = Object.freeze(['plan', 'slices', 'claims', 'integration', 'landing', 'events', 'messages', 'messagesNotice']);

/**
 * One team as the page reads it: the scheduler answers `{ team, plan, slices, claims, integration, landing, events,
 * messages }` with the summary in `team` (where `slices` is a count) and the rest beside it; a part named beside
 * `team` is the one kept. An answer with everything inside `team` is taken as it is.
 */
export function teamDetailOf(data) {
  const team = data?.team && typeof data.team === 'object' && !Array.isArray(data.team) ? data.team : null;
  if (!team) return null;
  const out = { ...team };
  for (const part of TEAM_DETAIL_PARTS) if (data[part] !== undefined && data[part] !== null) out[part] = data[part];
  return out;
}

/** The key of an agent as the routes take it: its id checked by shape (never a path), and its scope. */
export function agentPath(key) {
  const id = String(key?.id || '');
  if (!ID_RE.test(id)) throw new AgentsApiError('Not an agent id.', { status: 400, code: 'invalid_id' });
  return { id, query: scopeQuery(key?.scope) };
}

/**
 * @param {object} [o]
 * @param {typeof fetch} [o.fetch] the page's fetch (a stand-in under test)
 * @param {string} [o.base]
 */
export function createAgentsApi({ fetch: fetchFn = (...args) => globalThis.fetch(...args), base = AGENTS_BASE } = {}) {
  async function send(method, url, { body, etag } = {}) {
    const headers = { Accept: 'application/json', 'X-SynaBun-UI': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-Match'] = `"${etag}"`;
    // Never from the browser's cache: a route's ETag is the content's digest, and a draft that only changed its status
    // (sent to review, sent back) would be answered from an earlier reading.
    const init = { method, headers, credentials: 'same-origin', cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    let res = await fetchFn(url, init);
    let data = await read(res);
    // A tab that outlived a restart holds the earlier boot's page secret: ask for this boot's once, send again.
    if (res.status === 403 && PAGE_SECRET_CODES.has(data?.code)) {
      const refreshed = await fetchFn(PAGE_SESSION_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }).then((r) => !!r?.ok, () => false);
      if (refreshed) { res = await fetchFn(url, init); data = await read(res); }
    }
    if (!res.ok) {
      const json = data && typeof data === 'object' ? data : null;
      throw new AgentsApiError(json?.error || `HTTP ${res.status}`, { status: res.status, code: json ? (json.code || null) : 'not_json', body: json });
    }
    if (!data || typeof data !== 'object') throw new AgentsApiError('The server answered something that is not JSON.', { status: res.status, code: 'not_json' });
    return data;
  }
  async function read(res) {
    try { return await res.json(); } catch { return null; }
  }
  const agentUrl = (key, rest = '', extra = {}) => {
    const { id, query } = agentPath(key);
    return `${base}/agents/${encodeURIComponent(id)}${rest}${queryString({ ...query, ...extra })}`;
  };
  const teamUrl = (teamId, rest = '') => {
    const id = String(teamId || '');
    if (!TEAM_ID_RE.test(id)) throw new AgentsApiError('Not a team id.', { status: 400, code: 'invalid_id' });
    return `${base}/teams/${encodeURIComponent(id)}${rest}`;
  };

  return {
    base,
    // ── reading ──
    capabilities: () => send('GET', `${base}/capabilities`),
    list: ({ scope = null, project = null, status = null, q = '' } = {}) => send('GET', `${base}/agents${queryString({ scope, project, status: Array.isArray(status) ? status.join(',') : status, q })}`),
    get: async (key) => send('GET', agentUrl(key)),
    revisions: async (key) => send('GET', agentUrl(key, '/revisions')),
    revision: async (key, which) => send('GET', agentUrl(key, `/revisions/${encodeURIComponent(String(which))}`)),
    diff: async (key, { from = null, to = null } = {}) => send('GET', agentUrl(key, '/diff', { from, to })),
    exportAgent: async (key) => send('GET', agentUrl(key, '/export')),
    nativeFormats: () => send('GET', `${base}/native-export/formats`),
    nativePreview: (key, options) => send('GET', agentUrl(key, '/native-export', options)),
    nativeWrite: (key, body) => send('POST', agentUrl(key, '/native-export'), { body }),
    exportAll: ({ scope = null, project = null } = {}) => send('GET', `${base}/export${queryString({ scope, project })}`),
    resolve: (ref, cwd = null) => send('GET', `${base}/resolve${queryString({ ref, cwd })}`),
    runs: async (key, { limit = 50 } = {}) => send('GET', agentUrl(key, '/runs', { limit })),
    // ── checks: nothing is stored ──
    validate: (definition) => send('POST', `${base}/validate`, { body: { definition } }),
    lint: (definition) => send('POST', `${base}/lint`, { body: { definition } }),
    // ── drafts ──
    create: (definition) => send('POST', `${base}/agents`, { body: { definition } }),
    openDraft: async (key) => send('POST', agentUrl(key, '/draft'), { body: {} }),
    /** Change the draft. `etag` is the one that was read: it rides as If-Match and as `expectedEtag`. */
    updateDraft: async (key, patch, etag) => send('PATCH', agentUrl(key, '/draft'), { body: { expectedEtag: etag || undefined, patch }, etag }),
    discardDraft: async (key, etag = null) => send('DELETE', agentUrl(key, '/draft'), { body: etag ? { expectedEtag: etag } : {}, etag }),
    copy: async (key, { id = null, scope = null } = {}) => send('POST', agentUrl(key, '/copy'), { body: { ...(id ? { id } : {}), ...(scope ? { scope } : {}) } }),
    importBundle: (bundle, { scope = null, replaceDrafts = false, prefer = 'approved' } = {}) => send('POST', `${base}/import`, { body: { bundle, ...(scope ? { scope } : {}), replaceDrafts, prefer } }),
    importClaudeAgent: ({ markdown, fileName = '', id = null, scope = null, replaceDraft = false }) => send('POST', `${base}/import-claude-agent`, { body: { markdown, fileName, ...(id ? { id } : {}), ...(scope ? { scope } : {}), replaceDraft } }),
    // ── review ──
    submit: async (key, { etag = null, note = '' } = {}) => send('POST', agentUrl(key, '/submit'), { body: { ...(etag ? { expectedEtag: etag } : {}), ...(note ? { note } : {}) }, etag }),
    requestChanges: async (key, { etag = null, note = '' } = {}) => send('POST', agentUrl(key, '/request-changes'), { body: { ...(etag ? { expectedEtag: etag } : {}), ...(note ? { note } : {}) }, etag }),
    /** The owner approves the content it read: the etag is required (428 without). */
    approve: async (key, { etag, note = '' } = {}) => send('POST', agentUrl(key, '/approve'), { body: { expectedEtag: etag || undefined, ...(note ? { note } : {}) }, etag }),
    withdraw: async (key, { revision = null, all = false, note = '' } = {}) => send('POST', agentUrl(key, '/withdraw'), { body: { ...(revision !== null ? { revision } : {}), ...(all ? { all: true } : {}), ...(note ? { note } : {}) } }),
    remove: async (key) => send('DELETE', agentUrl(key), { body: {} }),
    // ── a test run ──
    testRun: async (key, { task, cwd = null, revision = null, maxMinutes = null } = {}) => send('POST', agentUrl(key, '/test-run'), { body: { task, ...(cwd ? { cwd } : {}), ...(revision !== null ? { revision } : {}), ...(maxMinutes ? { maxMinutes } : {}) } }),
    // ── teams (the team scheduler's routes: absent on a server from before it) ──
    /**
     * → { available, teams, notRunning? }. A server without the route (404, or an answer with no list) and a scheduler
     * that is not running yet (503 TEAMS_UNAVAILABLE, then `notRunning: true`) are `available: false`.
     */
    async teams() {
      try {
        const data = await send('GET', `${base}/teams`);
        return Array.isArray(data.teams) ? { available: true, teams: data.teams } : { available: false, teams: [] };
      } catch (error) {
        if (teamsUnavailable(error)) return error.status === 503 ? { available: false, teams: [], notRunning: true } : { available: false, teams: [] };
        throw error;
      }
    },
    /** → { available, team }. `team` null: the route is not there, or the team is gone (teamDetailOf). */
    async team(teamId) {
      try {
        const team = teamDetailOf(await send('GET', teamUrl(teamId)));
        return team ? { available: true, team } : { available: false, team: null };
      } catch (error) {
        if (teamsUnavailable(error)) return { available: error.status === 404 && !error.absent, team: null };
        throw error;
      }
    },
    landTeam: async (teamId, body = {}) => send('POST', teamUrl(teamId, '/land'), { body }),
    /**
     * `{ force: true }` also deletes what a discard kept (the owner's word, behind its own question). `{ remove: true }`
     * (capability `teams-quick-discard`): the team's record goes too, in the same step, once the discard left nothing
     * → `teamRemoved`, and `removal` (why it stays) when it does not.
     */
    discardTeam: async (teamId, body = {}) => send('POST', teamUrl(teamId, '/discard'), { body }),
    /**
     * A ready team whose work is on its base branch already: its worktrees, branches and record, once the server asked
     * git again (capability `teams-on-target`) → { teamRemoved, branch, removed }. The owner's question was answered.
     */
    cleanupMergedTeam: async (teamId) => send('POST', teamUrl(teamId, '/cleanup-merged'), { body: { userConfirmed: true } }),
    /** A landed team's worktrees and branches (capability `teams-cleanup`). The owner's question was answered: `userConfirmed`. */
    cleanupTeam: async (teamId) => send('POST', teamUrl(teamId, '/cleanup'), { body: { userConfirmed: true } }),
    /** A closed team's record, once nothing of it is left (capability `teams-remove`). */
    removeTeam: async (teamId) => send('DELETE', teamUrl(teamId), { body: {} }),
    /** Every closed team that can go → { removed: [ids], skipped: [{ teamId, code, next, … }] } (capability `teams-remove`). */
    clearFinishedTeams: async () => send('POST', `${base}/teams/clear-finished`, { body: {} }),
  };
}

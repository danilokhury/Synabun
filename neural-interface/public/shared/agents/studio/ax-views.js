// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the view machine
// ═══════════════════════════════════════════
//
// Where the window is: one of four places of the rail (Library · Create · Review · Teams), or one agent opened from
// a place, with its tabs (Edit · Revisions · Runs · Test run). A view is a small plain object; `navigate` is the one
// function that moves it, so every way in (a rail button, a card, the menu's "Review queue", a link from the
// Assistant) lands the same way, and what is saved when the window closes is the view itself.
// No DOM and no imports.

export const PLACES = Object.freeze(['library', 'create', 'review', 'teams']);
export const AGENT_TABS = Object.freeze(['edit', 'revisions', 'runs', 'test']);
/** The ways into Create (the creator's first step). */
export const CREATE_MODES = Object.freeze(['blank', 'template', 'copy', 'import', 'describe']);

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A scope as the registry writes it, or null when the value is not one. */
export function cleanScope(scope) {
  if (!scope || typeof scope !== 'object') return null;
  if (scope.kind === 'global') return { kind: 'global' };
  if (scope.kind === 'project' && typeof scope.path === 'string' && scope.path && scope.path.length <= 1024) return { kind: 'project', path: scope.path };
  return null;
}

/** One text for an agent of one scope: what a row, a workspace and a saved view are found by. */
export function agentKeyText(key) {
  const scope = cleanScope(key?.scope) || { kind: 'global' };
  return `${scope.kind === 'project' ? `p:${scope.path}` : 'global'}|${String(key?.id || '')}`;
}

/** The same key from an agent's summary, or null when the id has not its shape. */
export function keyOf(agent) {
  const id = String(agent?.id || '');
  if (!ID_RE.test(id)) return null;
  return { id, scope: cleanScope(agent?.scope) || { kind: 'global' } };
}

export const DEFAULT_VIEW = Object.freeze({ place: 'library', agent: null, tab: 'edit', create: null, teamId: null, from: 'library' });

/**
 * A link into the Studio (`agents:open` with a detail), normalised: an unknown place falls back to the Library, an
 * id is kept only when it has its shape.
 * @param {object} detail `{ view | place, id, scope, tab, create, teamId }`
 */
export function parseOpen(detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const named = typeof d.view === 'string' ? d.view : d.place;
  const id = typeof d.id === 'string' && ID_RE.test(d.id) ? d.id : null;
  const tab = AGENT_TABS.includes(d.tab) ? d.tab : null;
  const create = CREATE_MODES.includes(d.create) ? d.create : null;
  const teamId = typeof d.teamId === 'string' && TEAM_ID_RE.test(d.teamId) ? d.teamId : null;
  let place = PLACES.includes(named) ? named : null;
  // The menu's words for the places: "new" is Create, "queue" is Review.
  if (named === 'new') place = 'create';
  if (named === 'queue') place = 'review';
  if (!place) place = id ? 'agent' : create ? 'create' : teamId ? 'teams' : null;
  if (id && (place === null || place === 'library' || place === 'agent')) place = 'agent';
  return { place, id: place === 'agent' ? id : null, scope: place === 'agent' ? (cleanScope(d.scope) || { kind: 'global' }) : null, tab, create, teamId, explicit: !!place };
}

/** The view a window starts in: what was saved the last time it closed, when it still reads as a view. */
export function initialView(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const place = PLACES.includes(s.place) || s.place === 'agent' ? s.place : 'library';
  const agent = place === 'agent' && typeof s.agent?.id === 'string' && ID_RE.test(s.agent.id) ? { id: s.agent.id, scope: cleanScope(s.agent.scope) || { kind: 'global' } } : null;
  return {
    place: place === 'agent' && !agent ? 'library' : place,
    agent,
    tab: AGENT_TABS.includes(s.tab) ? s.tab : 'edit',
    create: null,
    teamId: typeof s.teamId === 'string' && TEAM_ID_RE.test(s.teamId) ? s.teamId : null,
    from: PLACES.includes(s.from) ? s.from : 'library',
  };
}

/** What is kept of a view (never the creator's step: a half-made agent is not restored as a place). */
export function viewToSave(view) {
  return { place: view.place, agent: view.place === 'agent' ? view.agent : null, tab: view.tab, teamId: view.teamId || null, from: view.from };
}

/**
 * Move the view. Actions:
 *   { type: 'place', place, create?, teamId? }   a place of the rail
 *   { type: 'agent', key, tab? }                 open an agent (from the place the view is in)
 *   { type: 'tab', tab }                         another tab of the open agent
 *   { type: 'back' }                             from an agent to the place it was opened from; from a team to the list
 *   { type: 'team', teamId }                     one team, or the list (null)
 *   { type: 'open', want }                       a parsed link (parseOpen)
 * An action that makes no sense where the view is leaves it as it was (the same object: nothing to draw).
 */
export function navigate(view, action) {
  const a = action && typeof action === 'object' ? action : {};
  if (a.type === 'place') {
    if (!PLACES.includes(a.place)) return view;
    return { ...view, place: a.place, agent: null, create: a.place === 'create' && CREATE_MODES.includes(a.create) ? a.create : null, teamId: a.place === 'teams' ? (a.teamId && TEAM_ID_RE.test(a.teamId) ? a.teamId : null) : view.teamId, from: a.place };
  }
  if (a.type === 'agent') {
    const key = keyOf(a.key);
    if (!key) return view;
    return { ...view, place: 'agent', agent: key, tab: AGENT_TABS.includes(a.tab) ? a.tab : (view.place === 'agent' && agentKeyText(view.agent) === agentKeyText(key) ? view.tab : 'edit'), create: null, from: view.place === 'agent' ? view.from : (PLACES.includes(view.place) ? view.place : 'library') };
  }
  if (a.type === 'tab') {
    if (view.place !== 'agent' || !AGENT_TABS.includes(a.tab) || a.tab === view.tab) return view;
    return { ...view, tab: a.tab };
  }
  if (a.type === 'team') {
    const teamId = typeof a.teamId === 'string' && TEAM_ID_RE.test(a.teamId) ? a.teamId : null;
    if (view.place === 'teams' && view.teamId === teamId) return view;
    return { ...view, place: 'teams', agent: null, create: null, teamId, from: 'teams' };
  }
  if (a.type === 'back') {
    if (view.place === 'agent') return { ...view, place: PLACES.includes(view.from) ? view.from : 'library', agent: null };
    if (view.place === 'teams' && view.teamId) return { ...view, teamId: null };
    if (view.place === 'create' && view.create) return { ...view, create: null };
    return view;
  }
  if (a.type === 'open') {
    const want = a.want || {};
    if (want.place === 'agent' && want.id) return navigate(view, { type: 'agent', key: { id: want.id, scope: want.scope }, tab: want.tab || undefined });
    if (PLACES.includes(want.place)) return navigate(view, { type: 'place', place: want.place, create: want.create, teamId: want.teamId });
    return view;
  }
  return view;
}

/**
 * The rail: one item per place, the current one marked, a count where a place has one. An open agent keeps the
 * place it was opened from marked. `caps` (the server's capabilities, a Set) hides what the server cannot serve;
 * while it is unknown (null) nothing is hidden.
 * @param {object} view
 * @param {{ total?: number, review?: number, teams?: number|null }} [counts]
 * @param {Set<string>|null} [caps]
 */
export function railModel(view, counts = {}, caps = null) {
  const current = view.place === 'agent' ? (PLACES.includes(view.from) ? view.from : 'library') : view.place;
  const has = (cap) => !caps || caps.has(cap);
  return PLACES.map((place) => ({
    place,
    current: place === current,
    count: place === 'library' ? (counts.total ?? null) : place === 'review' ? (counts.review || null) : place === 'teams' ? (counts.teams || null) : null,
    hidden: (place === 'review' && !has('reviews')) || (place === 'create' && !has('drafts')),
  })).filter((item) => !item.hidden);
}

/** The tabs of an agent the server can serve (`revisions`, `runs`, `test-run` are capabilities of their own). */
export function agentTabs(caps = null) {
  const has = (cap) => !caps || caps.has(cap);
  return AGENT_TABS.filter((tab) => tab === 'edit' || (tab === 'revisions' && has('revisions')) || (tab === 'runs' && has('runs')) || (tab === 'test' && has('test-run')));
}

/** The refusals that mean "this caller is not the owner here" (lib/owner-authority.js, lib/page-session.js, the routes). */
export const REFUSAL_CODES = Object.freeze(['WORKER_BROWSER', 'OWNER_ROUTE', 'GUEST_FORBIDDEN', 'UI_ONLY', 'PAGE_SECRET_REQUIRED', 'PEER_REFUSED', 'PEER_UNAVAILABLE']);

/**
 * Why the Studio's first read (GET /capabilities) failed, so the window says the true reason:
 *   'refused'      the server answered, and will not serve this caller (SynaBun's automation browser, a guest, a
 *                  page without the owner's access): restarting changes nothing, and is never suggested
 *   'older'        the routes are not on this server (a server from before the Agents system): a restart loads them
 *   'unreachable'  no answer at all
 * @param {{ status?: number, code?: string|null, absent?: boolean }|null} error
 */
export function capsFailure(error) {
  const status = Number(error?.status) || 0;
  if (REFUSAL_CODES.includes(error?.code) || status === 401 || status === 403) return 'refused';
  if (error?.absent || error?.code === 'not_json' || status === 404) return 'older';
  if (!status) return 'unreachable';
  return status === 503 ? 'refused' : 'older';
}

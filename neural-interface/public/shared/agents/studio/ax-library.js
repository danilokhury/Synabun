// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the Library's rows
// ═══════════════════════════════════════════
//
// The registry lists one summary per agent and scope (lib/agents/registry.js `summary`): the approved revision's
// content when there is one, else the draft's, the agent's overall status (approved / in_review / draft / withdrawn)
// and its working draft's own. This module turns that list into what the Library, the Review queue and the menu's
// badge show: what a row says about its state (an approved agent with a newer draft says both), which rows a
// search and the filters keep, their order, and the counts.
// No DOM and no imports.

export const STATUSES = Object.freeze(['draft', 'in_review', 'approved', 'withdrawn']);
export const STATUS_FILTERS = Object.freeze(['all', ...STATUSES]);
export const SCOPE_FILTERS = Object.freeze(['all', 'global', 'project']);
export const SORTS = Object.freeze(['updated', 'name', 'status']);
export const LAYOUTS = Object.freeze(['cards', 'list']);
export const DEFAULT_FILTERS = Object.freeze({ q: '', scope: 'all', status: 'all', provider: 'all', sort: 'updated', layout: 'cards' });

const STATUS_ORDER = { in_review: 0, draft: 1, approved: 2, withdrawn: 3 };
const lower = (value) => String(value ?? '').toLowerCase();

/** Filters as they are kept: an unknown value falls back to its default. */
export function cleanFilters(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    q: typeof s.q === 'string' ? s.q.slice(0, 200) : '',
    scope: SCOPE_FILTERS.includes(s.scope) || (typeof s.scope === 'string' && s.scope.startsWith('project:')) ? s.scope : 'all',
    status: STATUS_FILTERS.includes(s.status) ? s.status : 'all',
    provider: typeof s.provider === 'string' && s.provider ? s.provider : 'all',
    sort: SORTS.includes(s.sort) ? s.sort : 'updated',
    layout: LAYOUTS.includes(s.layout) ? s.layout : 'cards',
  };
}

/**
 * What a row says about where its agent stands:
 *   status     the agent's overall status (what a run would find): approved, or the draft's, or withdrawn
 *   pending    'in_review' | 'draft' | null: a working revision on top of an approved one
 *   revision   the number shown: the approved revision's, else the draft's
 *   draftRevision  the working revision's number, when there is one
 */
export function standingOf(agent) {
  const status = STATUSES.includes(agent?.status) ? agent.status : 'draft';
  const draft = agent?.draft && typeof agent.draft === 'object' ? agent.draft : null;
  const draftStatus = draft && STATUSES.includes(draft.status) ? draft.status : null;
  return {
    status,
    pending: status === 'approved' && draftStatus ? draftStatus : null,
    revision: agent?.approvedRevision ?? draft?.revision ?? null,
    draftRevision: draft?.revision ?? null,
    inReview: draftStatus === 'in_review',
    damaged: agent?.damaged === true,
  };
}

/** Does the row pass the status filter? An approved agent with a draft in review is also found under "In review". */
function matchesStatus(agent, wanted) {
  if (wanted === 'all') return true;
  const standing = standingOf(agent);
  return standing.status === wanted || standing.pending === wanted;
}

function matchesScope(agent, wanted) {
  if (wanted === 'all') return true;
  const kind = agent?.scope?.kind === 'project' ? 'project' : 'global';
  if (wanted === 'global' || wanted === 'project') return kind === wanted;
  return kind === 'project' && `project:${agent.scope.path}` === wanted;
}

/** The rows a search and the filters keep. The search reads the name, the id, the description and the task classes. */
export function filterAgents(agents, filters = DEFAULT_FILTERS) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const words = lower(f.q).split(/\s+/).filter(Boolean);
  return (Array.isArray(agents) ? agents : []).filter((agent) => {
    if (!matchesStatus(agent, f.status) || !matchesScope(agent, f.scope)) return false;
    if (f.provider !== 'all' && agent?.provider !== f.provider) return false;
    if (!words.length) return true;
    const hay = lower([agent?.name, agent?.id, agent?.description, ...(agent?.taskClasses || []), agent?.model].join(' '));
    return words.every((word) => hay.includes(word));
  });
}

/** Sorted: by last change (newest first), by name, or by status (what waits for the owner first). */
export function sortAgents(agents, sort = 'updated') {
  const rows = [...(Array.isArray(agents) ? agents : [])];
  const byName = (a, b) => lower(a?.name || a?.id).localeCompare(lower(b?.name || b?.id)) || lower(a?.id).localeCompare(lower(b?.id));
  if (sort === 'name') return rows.sort(byName);
  if (sort === 'status') {
    const rank = (agent) => { const s = standingOf(agent); return STATUS_ORDER[s.pending || s.status] ?? 9; };
    return rows.sort((a, b) => rank(a) - rank(b) || byName(a, b));
  }
  return rows.sort((a, b) => lower(b?.updatedAt).localeCompare(lower(a?.updatedAt)) || byName(a, b));
}

/** The drafts that wait for the owner's decision, the one waiting longest first. */
export function reviewQueue(agents) {
  return (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.draft?.status === 'in_review')
    .sort((a, b) => lower(a?.draft?.review?.submittedAt || a?.draft?.updatedAt || a?.updatedAt).localeCompare(lower(b?.draft?.review?.submittedAt || b?.draft?.updatedAt || b?.updatedAt)));
}

/** Counts for the rail and the filters. */
export function countAgents(agents) {
  const rows = Array.isArray(agents) ? agents : [];
  const byStatus = { draft: 0, in_review: 0, approved: 0, withdrawn: 0 };
  let global = 0;
  let project = 0;
  for (const agent of rows) {
    const standing = standingOf(agent);
    byStatus[standing.status] += 1;
    if (standing.pending) byStatus[standing.pending] += 1;
    if (agent?.scope?.kind === 'project') project += 1; else global += 1;
  }
  return { total: rows.length, byStatus, review: reviewQueue(rows).length, global, project };
}

/** The providers the rows use (for the provider filter: only what is there is offered). */
export function providersOf(agents) {
  return [...new Set((Array.isArray(agents) ? agents : []).map((agent) => agent?.provider).filter((id) => typeof id === 'string' && id))].sort();
}

/** The projects agents are pinned to, with what each is called (`projects`: the registered ones, from GET /capabilities). */
export function projectsOf(agents, projects = []) {
  const labels = new Map((Array.isArray(projects) ? projects : []).map((p) => [p.path, p.label || null]));
  const paths = [...new Set((Array.isArray(agents) ? agents : []).filter((agent) => agent?.scope?.kind === 'project').map((agent) => agent.scope.path))];
  return paths.sort().map((path) => ({ path, label: labels.get(path) || baseName(path) }));
}

/** The last part of a path (what a project is called when it has no label). */
export function baseName(path) {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || String(path || '');
}

/** What a scope is called: the global library's word, or the project's label. */
export function scopeLabel(scope, projects = [], globalWord = 'Global') {
  if (scope?.kind !== 'project') return globalWord;
  const found = (Array.isArray(projects) ? projects : []).find((p) => p.path === scope.path);
  return found?.label || baseName(scope.path);
}

/** Who made a revision, as a word key: owner / assistant / agent / system. */
export function authorKind(author) {
  const kind = typeof author === 'string' ? author : author?.kind;
  return ['owner', 'assistant', 'agent', 'system'].includes(kind) ? kind : 'owner';
}

/**
 * How many drafts wait for the owner, from the answer of GET /agents?status=in_review (an agent counts once per
 * scope); null when the answer is not a list (an older server, a refusal).
 */
export function reviewCountOf(answer) {
  const agents = Array.isArray(answer?.agents) ? answer.agents : null;
  if (!agents) return null;
  return agents.filter((agent) => agent?.draft?.status === 'in_review').length;
}

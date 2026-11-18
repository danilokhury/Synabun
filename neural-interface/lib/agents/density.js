// ═══════════════════════════════════════════
// SynaBun — Agents: agent density
// ═══════════════════════════════════════════
//
// How many workers the Assistant may put on ONE task. The user picks a level next to the Test density control in
// the Assistant's composer; like that setting (assistant-test-density.js) it is stored per session (null = the
// default) and read when needed. Density is a target for code, complex, research and review; fewer workers need
// a reason. Every split worker gets its own git worktree: code slices are joined and tested; research/review
// workers get read-only worktrees that are removed when they end.
//
// This module is the wording and the numbers: the levels and their caps, the line the brain's prompt carries, and
// the "[SynaBun Agents]" line a change sends. Pure module: no I/O, no server imports.

export const AGENT_DENSITIES = Object.freeze(['solo', 'pair', 'team', 'swarm']);
export const DEFAULT_AGENT_DENSITY = 'solo';
export const AGENT_DENSITY_LABELS = Object.freeze({ solo: 'Solo', pair: 'Pair', team: 'Team', swarm: 'Swarm' });
/** The most workers one task may be given at a level. */
export const AGENT_DENSITY_WORKERS = Object.freeze({ solo: 1, pair: 2, team: 4, swarm: 6 });
/** The most workers any level allows (the hard ceiling of a team plan). */
export const MAX_TEAM_WORKERS = AGENT_DENSITY_WORKERS.swarm;
export const AGENTS_HEADER = '[SynaBun Agents]';

/** A known level, else `fallback` (the default level unless the caller wants to tell "not set" apart). */
export function normalizeAgentDensity(value, fallback = DEFAULT_AGENT_DENSITY) {
  const key = String(value ?? '').trim().toLowerCase();
  return AGENT_DENSITIES.includes(key) ? key : fallback;
}

export function agentDensityLabel(level) {
  return AGENT_DENSITY_LABELS[normalizeAgentDensity(level)];
}

/** The cap of a level: 1, 2, 4 or 6 workers on one task. An unknown level is the default (Solo: 1). */
export function maxWorkers(level) {
  return AGENT_DENSITY_WORKERS[normalizeAgentDensity(level)];
}

/** May a task be split at this level at all? (Solo never splits.) */
export function allowsTeams(level) {
  return maxWorkers(level) > 1;
}

/** How many workers a plan gets at a level: what was asked for, at least 1, at most the cap. */
export function clampWorkers(level, requested) {
  const n = Math.floor(Number(requested));
  return Math.max(1, Math.min(maxWorkers(level), Number.isFinite(n) ? n : 1));
}

/** Does a plan of `workers` workers fit the level? */
export function fitsDensity(level, workers) {
  const n = Number(workers);
  return Number.isInteger(n) && n >= 1 && n <= maxWorkers(level);
}

/** The lowest level that allows `workers` workers on one task, or null when no level does. */
export function densityForWorkers(workers) {
  const n = Number(workers);
  if (!Number.isInteger(n) || n < 1) return null;
  return AGENT_DENSITIES.find((level) => AGENT_DENSITY_WORKERS[level] >= n) || null;
}

const SPLIT_RULE = 'a target: plan the whole task first; split code/complex and research/review with agent_team, every worker in its own worktree (read-only for research/review); fewer only with a reason; one agent_route approval for the whole split, never per worker; all other classes stay single';

/** What a level means, in one clause (the brain's line and the change announcement). */
const DENSITY_SUMMARY = Object.freeze({
  solo: 'one worker per task; never split a task across workers',
  pair: `2 workers on one eligible task; ${SPLIT_RULE}`,
  team: `4 workers on one eligible task; ${SPLIT_RULE}`,
  swarm: `6 workers on one eligible task; ${SPLIT_RULE}`,
});

export function agentDensitySummary(level) {
  return DENSITY_SUMMARY[normalizeAgentDensity(level)];
}

/**
 * The entry of the brain's system prompt (assistant-persona.js, Rails), per level.
 * `where`: how the prompt names the control (a chat channel has no composer).
 */
export function agentDensityPersonaLine(level, { where = 'next to the Test density control' } = {}) {
  const id = normalizeAgentDensity(level);
  const head = `- Agent density: ${AGENT_DENSITY_LABELS[id]} (the user's setting, ${where}): ${DENSITY_SUMMARY[id]}.`;
  const tail = ` A change of level arrives as a "${AGENTS_HEADER}" line.`;
  if (id === 'solo') {
    return `${head} Give each task to a single worker, as before. Separate tasks may still run side by side, and a review by a second model is its own task, not a split.${tail}`;
  }
  const cap = AGENT_DENSITY_WORKERS[id];
  return `${head} Use ${cap} workers when the task can sensibly split that far. `
    + 'For code/complex, split into parts that are file-disjoint (no file is written by two parts) and say which files each part owns; parts that depend on each other name that dependency, and at most one part changes dependency lockfiles. '
    + 'SynaBun gives every part its own git worktree and branch under the project\'s .worktrees folder, never the user\'s checkout or branch, and joins the finished parts on an integration branch for the user to merge. '
    + `Research/review use distinct questions or review scopes through agent_team (empty owned_paths), each worker in its own read-only worktree, removed when it ends (changes are kept and reported); no integration or landing; synthesize their results. SynaBun refuses a plan with more parts than ${cap}, with overlapping files or with a dependency cycle.${tail}`;
}

/** The line a running brain gets when the level changes (like "[SynaBun Tests]" and "[SynaBun Router]"). */
export function agentDensityStamp(level) {
  const id = normalizeAgentDensity(level);
  return `${AGENTS_HEADER} Agent density: ${AGENT_DENSITY_LABELS[id]} - ${DENSITY_SUMMARY[id]}.`;
}

// The short name the phase plan uses.
export { normalizeAgentDensity as normalize };

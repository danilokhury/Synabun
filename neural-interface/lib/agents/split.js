// The session owns density; the brain supplies the task's decomposition before approval.
import { isAbsolute, resolve } from 'node:path';
import { normalizeAgentDensity, maxWorkers } from './density.js';
import { createGitRunner } from '../teams/git.js';
import { TEAM_LIMITS } from '../teams/schema.js';

/** One title limit for a route's planned_split and a team's slices: an approved split must always be startable. */
export const SPLIT_TITLE_MAX = TEAM_LIMITS.title;

/**
 * A slice title as a route and a team compare it: runs of whitespace folded, trimmed, cut to the shared limit
 * (never through a surrogate pair). A route stored before the limit may hold a longer title; the team's cut one equals it.
 */
export function splitTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, SPLIT_TITLE_MAX).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
}

export const SPLIT_CLASSES = new Set(['code', 'complex', 'research', 'review']);
const git = createGitRunner({ timeoutMs: 5000 });
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 400 }); };

/**
 * Whether a re-route's planned_split asks for a different plan than the one a route holds (workers, titles as the
 * team reads them, fewer reason). No split given, or a route whose project had no git commit, never counts.
 */
export function splitChanged(raw, prior) {
  if (!raw || typeof raw !== 'object' || !prior || prior.noRepo) return false;
  const titles = Array.isArray(raw.slices) ? raw.slices.map(splitTitle) : [];
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  return raw.workers !== prior.workers || titles.length !== prior.slices.length
    || titles.some((t, i) => t !== splitTitle(prior.slices[i])) || (reason || null) !== (prior.reason || null);
}

export async function planRouteSplit(body, session, taskClass) {
  const density = normalizeAgentDensity(session.agentDensity);
  const target = maxWorkers(density);
  const raw = body.planned_split ?? body.plannedSplit;
  if (target === 1 || !SPLIT_CLASSES.has(taskClass)) {
    if (raw && raw.workers !== 1) fail('ROUTE_SPLIT_INELIGIBLE', 'Solo and this task class never split.');
    return null;
  }
  let projectPath = null;
  if (SPLIT_CLASSES.has(taskClass)) {
    if (!body.cwd || !isAbsolute(body.cwd)) fail('ROUTE_PROJECT_REQUIRED', 'Pass cwd: the absolute project path, so SynaBun can check worktree support before approval.');
    projectPath = resolve(body.cwd);
    const head = await git(['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    if (!head.ok) return { density, target, workers: 1, slices: [String(body.summary || 'Task')],
      reason: 'The project is not a git repository with a commit; worktrees require one.', flow: 'single', projectPath, noRepo: true };
  }
  if (!raw || typeof raw !== 'object') fail('ROUTE_SPLIT_REQUIRED', `Plan the implementation first, then pass planned_split with ${target} distinct slice titles, or fewer with a reason. Route the whole task once.`);
  const workers = raw.workers;
  // Normalised exactly as the team schema reads a slice title, so the same text is compared at start.
  const slices = Array.isArray(raw.slices) ? raw.slices.map(s => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '') : [];
  const long = slices.findIndex(s => s.length > SPLIT_TITLE_MAX);
  if (long >= 0) fail('ROUTE_SPLIT_TITLE_TOO_LONG', `planned_split slice ${long + 1} has ${slices[long].length} characters; a slice title is at most ${SPLIT_TITLE_MAX} (agent_team uses the same titles). Shorten it and route again.`);
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!Number.isInteger(workers) || workers < 1 || workers > target || slices.length !== workers || slices.some(s => !s) || new Set(slices.map(s => s.toLowerCase())).size !== workers) {
    fail('ROUTE_SPLIT_INVALID', `planned_split needs 1–${target} workers and exactly that many distinct, nonempty slice titles (at most ${SPLIT_TITLE_MAX} characters each).`);
  }
  if (workers < target && !reason) fail('ROUTE_SPLIT_REASON_REQUIRED', `Using fewer than ${target} workers requires a short reason why this task cannot sensibly split further.`);
  if (reason.length > 400) fail('ROUTE_SPLIT_INVALID', 'The fewer-than-density reason must be at most 400 characters.');
  return { density, target, workers, slices, reason: reason || null, projectPath,
    flow: workers === 1 ? 'single' : 'team' };
}

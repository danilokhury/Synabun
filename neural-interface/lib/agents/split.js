// The session owns density; the brain supplies the task's decomposition before approval.
import { isAbsolute, resolve } from 'node:path';
import { normalizeAgentDensity, maxWorkers } from './density.js';
import { createGitRunner } from '../teams/git.js';

export const SPLIT_CLASSES = new Set(['code', 'complex', 'research', 'review']);
const git = createGitRunner({ timeoutMs: 5000 });
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 400 }); };

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
      reason: 'The project is not a git repository with a commit; worktrees require one.', flow: 'single', projectPath };
  }
  if (!raw || typeof raw !== 'object') fail('ROUTE_SPLIT_REQUIRED', `Plan the implementation first, then pass planned_split with ${target} distinct slice titles, or fewer with a reason. Route the whole task once.`);
  const workers = raw.workers;
  const slices = Array.isArray(raw.slices) ? raw.slices.map(s => typeof s === 'string' ? s.trim() : '') : [];
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!Number.isInteger(workers) || workers < 1 || workers > target || slices.length !== workers || slices.some(s => !s || s.length > 200) || new Set(slices.map(s => s.toLowerCase())).size !== workers) {
    fail('ROUTE_SPLIT_INVALID', `planned_split needs 1–${target} workers and exactly that many distinct, nonempty slice titles (at most 200 characters each).`);
  }
  if (workers < target && !reason) fail('ROUTE_SPLIT_REASON_REQUIRED', `Using fewer than ${target} workers requires a short reason why this task cannot sensibly split further.`);
  if (reason.length > 400) fail('ROUTE_SPLIT_INVALID', 'The fewer-than-density reason must be at most 400 characters.');
  return { density, target, workers, slices, reason: reason || null, projectPath,
    flow: workers === 1 ? 'single' : 'team' };
}

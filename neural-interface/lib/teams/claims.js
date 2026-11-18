// ═══════════════════════════════════════════
// SynaBun — Teams: path claims, and what a slice may write
// ═══════════════════════════════════════════
//
// A plan says which files each slice owns (lib/teams/schema.js: no file has two owners). While a team works, each
// slice holds its owned paths as claims in the coordination store (lib/coordination/store.js), taken when the team
// starts and given back when the slice finishes. Three things read them:
//
//   checkWrite(teamId, sliceId, path)   may this slice write this file? Allow or deny, with the slice that owns it.
//   the worker guard                    lib/worker-confinement.js asks the same question before a worker's write
//                                       (the slice's context is registered there by its worktree, so a run whose
//                                       working directory is a slice's worktree is confined without being told).
//   verifyOwnership(teamId, sliceId)    after the fact: what the slice's branch changed, against what it owns.
//
// The rule, for a file of the project (a path relative to the slice's worktree):
//   - the slice's own (pathOwner says so, and its claim is still held): allowed;
//   - a dependency lockfile: the plan's lockfile owner only, by rule, whatever pattern covers it;
//   - a file git ignores (build output, node_modules, a cache): allowed. It is never committed, so it never reaches
//     another slice;
//   - anything else, another slice's file or one nobody owns: denied. The worker asks the owner over the team
//     channel instead.
//   - `.git` and `.worktrees`: nobody's.
//
// The guard reads tool calls and command lines. A program a worker runs (a script, a build, a test runner) writes
// what it writes without being seen: that limit is the guard's own (lib/worker-confinement.js says it at its top).
// verifyOwnership is what closes it: a slice whose branch changed a file outside its ownership is rejected when it
// finishes (lib/teams/integration.js `finishSlice`), and nothing of it is joined.

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { EVENT_KINDS, teamRecipient } from '../coordination/store.js';
import { runGitReadSync } from '../git-read.js';
import { realPlace, registerTeamSlice, unregisterTeamSlice } from '../worker-confinement.js';
import {
  RESERVED_PATH_ROOTS, claimablePaths, globsOverlap, integrationBranchName, isLockfilePath, isTeamSlug, normalizeRelPath, pathOwner,
  branchName, worktreePath,
} from './schema.js';
import { parseNameStatus, parseStatus } from './git.js';
import { SETTLED_SLICE_STATES, TERMINAL_TEAM_STATES, planSlice, refuse, sliceState } from './state.js';

/** Dependency manifests by file name: changing one is the lockfile owner's job (a warning, not a refusal). */
export const MANIFEST_NAMES = Object.freeze([
  'package.json', 'pnpm-workspace.yaml', 'cargo.toml', 'pyproject.toml', 'requirements.txt', 'pipfile', 'go.mod', 'gemfile',
  'composer.json', 'pubspec.yaml', 'podfile', 'mix.exs', 'deno.json', 'build.gradle', 'build.gradle.kts', 'pom.xml',
]);
export const isManifestPath = (relPath) => MANIFEST_NAMES.includes(String(relPath || '').split('/').pop().toLowerCase());

/** Slice states in which a slice holds its claims: it is waiting for a worker or one is working it. */
const CLAIMING_SLICE_STATES = new Set(['planned', 'pending', 'blocked', 'running']);

const realOf = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Is this project-relative path ignored by git in this worktree? Asked of git, as a read. */
function gitIgnores(worktree, relPath) {
  try {
    const result = runGitReadSync(worktree, ['check-ignore', '-q', '--', relPath], { timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.store  a coordination store
 * @param {object} deps.state  createTeamState(...)
 * @param {Function} [deps.git]  createGitRunner(...): needed by verifyOwnership only
 * @param {(worktree: string, relPath: string) => boolean} [deps.isIgnored]  default: `git check-ignore`
 * @param {{ register: Function, unregister: Function }} [deps.registry]  where slice contexts are registered for
 *   the worker guard (default: lib/worker-confinement.js's own registry)
 * @param {(tag: string, detail: any) => void} [deps.log]
 */
export function createTeamClaims({ store, state, git = null, isIgnored = gitIgnores, registry = { register: registerTeamSlice, unregister: unregisterTeamSlice }, log = () => {} } = {}) {
  const plans = new Map();      // teamId → the team's plan (a plan does not change once the team exists)
  const contexts = new Map();   // `${teamId}/${sliceId}` → the context registered with the worker guard

  function planOf(teamId) {
    if (plans.has(teamId)) return plans.get(teamId);
    const record = isTeamSlug(teamId) ? state.record(teamId) : null;
    if (!record) return null;
    plans.set(teamId, record.plan);
    return record.plan;
  }

  /** Does the slice own something inside this folder? (`mkdir -p src` on the way to `src/api/x.js`.) */
  function ownsBeneath(plan, sliceId, relPath) {
    if (/[*?[\]{}!]/.test(relPath)) return false;
    const slice = plan.slices.find((each) => each.id === sliceId);
    return !!slice && slice.ownedPaths.some((glob) => globsOverlap(`${relPath}/**`, glob));
  }

  /**
   * The answer for a project-relative path. `allow`, the slice that owns the file (`owner`, null when nobody does),
   * a `code` and whether the slice owns something beneath the path (`beneath`, for a folder).
   */
  function checkRelative(teamId, sliceId, relPath) {
    const plan = planOf(teamId);
    if (!plan || !plan.slices.some((slice) => slice.id === sliceId)) return { allow: false, owner: null, relPath: String(relPath ?? ''), code: 'unknown_slice', beneath: false };
    const path = normalizeRelPath(relPath);
    if (path === null) return { allow: false, owner: null, relPath: String(relPath ?? ''), code: 'invalid_path', beneath: false };
    if (RESERVED_PATH_ROOTS.includes(path.split('/')[0].toLowerCase())) return { allow: false, owner: null, relPath: path, code: 'reserved_path', beneath: false };
    const owner = pathOwner(plan, path);
    const beneath = ownsBeneath(plan, sliceId, path);
    if (owner === sliceId) {
      if (isLockfilePath(path)) return { allow: true, owner, relPath: path, code: 'lockfile_owner', beneath };
      // The claim is what says the slice is at work on it: a slice that finished gave its claims back.
      const held = store.claimsFor({ teamId, sliceId, path }).length > 0;
      return held ? { allow: true, owner, relPath: path, code: 'owned', beneath } : { allow: false, owner, relPath: path, code: 'claim_released', beneath };
    }
    if (plan.readOnly) return { allow: false, owner: null, relPath: path, code: 'unowned', beneath: false };
    let ignored = false;
    try { ignored = isIgnored(worktreePath(plan.projectPath, teamId, sliceId), path) === true; } catch { ignored = false; }
    if (ignored) return { allow: true, owner, relPath: path, code: 'ignored', beneath };
    return { allow: false, owner, relPath: path, code: isLockfilePath(path) ? 'lockfile' : owner ? 'other_slice' : 'unowned', beneath };
  }

  const DENIALS = {
    unknown_slice: () => 'That slice is not part of the team.',
    invalid_path: (v) => `"${v.relPath.slice(0, 200)}" is not a path inside the project.`,
    reserved_path: (v) => `${v.relPath} is git's own data or a worktree folder: no slice writes there.`,
    outside_worktree: (v) => `${v.relPath} is outside this slice's worktree: a slice writes its own worktree only, never the user's checkout or another slice's.`,
    claim_released: (v) => `${v.relPath} is this slice's, but the slice has finished and gave its claims back.`,
    lockfile: (v) => (v.owner ? `${v.relPath} is a dependency lockfile: only the lockfile owner (slice "${v.owner}") changes it.` : `${v.relPath} is a dependency lockfile and this team has no lockfile owner: nobody changes it.`),
    other_slice: (v) => `${v.relPath} belongs to slice "${v.owner}".`,
    unowned: (v) => `${v.relPath} is not owned by any slice of this team.`,
  };

  /**
   * May this slice write this file? `path` is relative to the project (the slice's worktree is a checkout of it), or
   * absolute: then it must be inside the slice's own worktree.
   * @returns {{ allow: boolean, decision: 'allow'|'deny', owner: string|null, relPath: string, code: string, message: string }}
   */
  function checkWrite(teamId, sliceId, path) {
    let verdict;
    if (typeof path === 'string' && isAbsolute(path)) {
      const plan = planOf(teamId);
      const known = plan?.slices.some((slice) => slice.id === sliceId);
      const root = known ? realOf(worktreePath(plan.projectPath, teamId, sliceId)) : null;
      const rel = root ? relative(root, realPlace(resolve(path))) : null;
      if (!known) verdict = { allow: false, owner: null, relPath: path, code: 'unknown_slice', beneath: false };
      else if (!rel || rel.startsWith('..') || isAbsolute(rel)) verdict = { allow: false, owner: null, relPath: path, code: 'outside_worktree', beneath: false };
      else verdict = checkRelative(teamId, sliceId, rel.split(sep).join('/'));
    } else {
      verdict = checkRelative(teamId, sliceId, path);
    }
    const message = verdict.allow ? '' : `${(DENIALS[verdict.code] || DENIALS.unowned)(verdict)} Ask ${verdict.owner && verdict.owner !== sliceId ? `slice "${verdict.owner}"` : 'the team'} over the team channel instead of writing it.`;
    return { allow: verdict.allow, decision: verdict.allow ? 'allow' : 'deny', owner: verdict.owner, relPath: verdict.relPath, code: verdict.code, message };
  }

  /** What the worker guard gets for a slice (lib/worker-confinement.js `resolveWorkerConfinement({ team })`). */
  function context(teamId, sliceId) {
    const plan = planOf(teamId);
    const slice = plan?.slices.find((each) => each.id === sliceId);
    if (!slice) return null;
    return Object.freeze({
      teamId, sliceId,
      worktree: realOf(worktreePath(plan.projectPath, teamId, sliceId)),
      projectPath: plan.projectPath,
      ownedPaths: Object.freeze([...slice.ownedPaths]),
      lockfileOwner: slice.lockfileOwner === true,
      channel: teamRecipient(teamId),
      check: (relPath) => checkRelative(teamId, sliceId, relPath),
    });
  }

  function register(teamId, sliceId) {
    const made = context(teamId, sliceId);
    if (!made) return null;
    const key = `${teamId}/${sliceId}`;
    try { registry.register(made); contexts.set(key, made); } catch (error) { log('teams:register-failed', { teamId, sliceId, error: error?.message || String(error) }); }
    return made;
  }

  function claimSlice(plan, sliceId, runId) {
    const globs = claimablePaths(plan, sliceId);
    if (!globs.length) return { ok: true, claims: [] };   // a slice that owns lockfiles only: owned by rule
    return store.claim({ teamId: plan.teamId, sliceId, runId: runId || null, globs });
  }

  function announceConflict(teamId, sliceId, conflicts) {
    try {
      store.append({
        teamId, kind: EVENT_KINDS.CLAIM_CONFLICT,
        payload: { teamId, sliceId, conflicts: conflicts.map((each) => ({ glob: each.glob, heldBy: each.heldBy?.sliceId || null })) },
      });
    } catch (error) { log('teams:announce-failed', { teamId, error: error?.message || String(error) }); }
  }

  /**
   * Take every slice's claims: called when the team starts. All of them or none: a clash (which a valid plan does
   * not have) gives back what this call took and answers `CLAIM_CONFLICT`.
   * @param {string} teamId
   * @param {{ only?: (sliceId: string) => boolean }} [options]  which slices (default: every slice)
   */
  function start(teamId, { only = null } = {}) {
    const plan = planOf(teamId);
    if (!plan) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
    const taken = [];
    const claims = [];
    for (const slice of plan.slices) {
      if (only && !only(slice.id)) continue;
      const result = claimSlice(plan, slice.id, null);
      if (!result.ok) {
        for (const sliceId of taken) store.release({ teamId, sliceId });
        announceConflict(teamId, slice.id, result.conflicts);
        return refuse('CLAIM_CONFLICT', `Slice "${slice.id}" could not take its files: ${result.conflicts.map((each) => `${each.glob} is held by slice "${each.heldBy.sliceId}"`).join('; ')}.`, { sliceId: slice.id, conflicts: result.conflicts });
      }
      taken.push(slice.id);
      claims.push(...result.claims);
      register(teamId, slice.id);
    }
    return { ok: true, claims };
  }

  /** A slice goes to a run: its claims are (re)taken in that run's name and its context registered. */
  function assign(teamId, sliceId, runId = null) {
    const plan = planOf(teamId);
    if (!plan || !plan.slices.some((slice) => slice.id === sliceId)) return refuse('SLICE_NOT_FOUND', `Team "${teamId}" has no slice "${sliceId}".`);
    const result = claimSlice(plan, sliceId, runId);
    if (!result.ok) {
      announceConflict(teamId, sliceId, result.conflicts);
      return refuse('CLAIM_CONFLICT', `Slice "${sliceId}" could not take its files: ${result.conflicts.map((each) => `${each.glob} is held by slice "${each.heldBy.sliceId}"`).join('; ')}.`, { sliceId, conflicts: result.conflicts });
    }
    register(teamId, sliceId);
    return { ok: true, claims: result.claims };
  }

  /**
   * Give claims back: a slice's when it finishes, the whole team's with no `sliceId`. The slice's context stays
   * registered with the worker guard (a worker still running there is refused: its claims are gone) until `end`.
   */
  function release(teamId, sliceId = null) {
    return store.release(sliceId ? { teamId, sliceId } : { teamId });
  }

  /** The team is over (landed, discarded, removed): every claim back, every context off the worker guard. */
  function end(teamId) {
    const released = isTeamSlug(teamId) ? store.release({ teamId }).released : 0;
    for (const [key, made] of [...contexts]) {
      if (!key.startsWith(`${teamId}/`)) continue;
      try { registry.unregister(made); } catch { /* already gone */ }
      contexts.delete(key);
    }
    plans.delete(teamId);
    return { released };
  }

  /**
   * After a restart: the claims of every team under way are taken again where they should be held, and every slice
   * is registered with the worker guard again (the registry is in memory). Claims of teams that are over are given
   * back.
   */
  function restore() {
    const out = [];
    for (const entry of state.teams()) {
      const record = state.record(entry.teamId);
      if (!record) continue;
      if (TERMINAL_TEAM_STATES.includes(record.state) || record.removed) { out.push({ teamId: record.teamId, released: end(record.teamId).released }); continue; }
      plans.set(record.teamId, record.plan);
      const claimed = [];
      const conflicts = [];
      for (const slice of record.plan.slices) {
        const current = sliceState(record, slice.id);
        if (!SETTLED_SLICE_STATES.includes(current)) register(record.teamId, slice.id);
        if (!CLAIMING_SLICE_STATES.has(current)) continue;
        const result = claimSlice(record.plan, slice.id, record.slices[slice.id]?.runId || null);
        if (result.ok) claimed.push(slice.id); else conflicts.push({ sliceId: slice.id, conflicts: result.conflicts });
      }
      out.push({ teamId: record.teamId, claimed, conflicts });
    }
    return out;
  }

  /**
   * After the fact: what the slice's branch changed since it parted from the integration branch, and what is still
   * uncommitted in its worktree, against what the slice owns. A file a program wrote without the guard seeing it
   * shows up here.
   *
   * @returns {Promise<{ ok: boolean, head: string, reference: string, changed: object[], violations: object[],
   *   uncommitted: object[], stray: object[], warnings: object[] } | { ok: false, code: string }>}
   *   `ok`: the branch changed nothing outside the slice's ownership. `violations`: committed changes that are not
   *   the slice's. `stray`: uncommitted changes that are not the slice's (git-ignored files never count).
   */
  async function verifyOwnership(teamId, sliceId) {
    if (typeof git !== 'function') throw new Error('verifyOwnership needs a git runner.');
    const record = isTeamSlug(teamId) ? state.record(teamId) : null;
    if (!record) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
    const slice = planSlice(record, sliceId);
    if (!slice) return refuse('SLICE_NOT_FOUND', `Team "${teamId}" has no slice "${sliceId}".`);
    const cwd = record.projectPath;
    const rev = async (name) => { const out = await git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd }); return out.ok ? out.stdout.trim() : null; };
    const head = await rev(`refs/heads/${branchName(teamId, sliceId)}`);
    if (!head) return refuse('SLICE_BRANCH_MISSING', `The branch of slice "${sliceId}" is not there.`);
    const integration = (await rev(`refs/heads/${integrationBranchName(teamId)}`)) || record.integration.head;
    const base = await git(['merge-base', head, integration], { cwd });
    const reference = (base.ok && base.stdout.trim()) || record.slices[sliceId]?.startCommit || record.baseCommit;
    const diff = await git(['diff', '--name-status', '-z', '--no-renames', reference, head], { cwd });
    if (!diff.ok) return refuse('GIT_FAILED', `The slice's changes could not be read: ${diff.stderr.trim().slice(0, 300)}`);
    const changed = parseNameStatus(diff.stdout).map((entry) => ({ ...entry, owner: pathOwner(record.plan, entry.path) }));
    const violations = changed.filter((entry) => entry.owner !== sliceId).map((entry) => ({ ...entry, committed: true }));
    const worktree = worktreePath(record.projectPath, teamId, sliceId);
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktree });
    const uncommitted = status.ok
      ? parseStatus(status.stdout).flatMap((entry) => [entry.path, entry.from].filter(Boolean).map((path) => ({ path, status: `${entry.index}${entry.worktree}`.trim() || '?', owner: pathOwner(record.plan, path) })))
      : [];
    const stray = uncommitted.filter((entry) => entry.owner !== sliceId).map((entry) => ({ ...entry, committed: false }));
    const warnings = slice.lockfileOwner ? [] : changed.filter((entry) => entry.owner === sliceId && isManifestPath(entry.path)).map((entry) => ({
      code: 'manifest_changed', path: entry.path,
      message: `${entry.path} is a dependency manifest and slice "${sliceId}" is not the lockfile owner: a change of dependencies there leaves the lockfile behind.`,
    }));
    return { ok: violations.length === 0, head, reference, changed, violations, uncommitted, stray, warnings };
  }

  return { start, assign, release, end, restore, checkWrite, checkRelative, context, verifyOwnership, planOf };
}

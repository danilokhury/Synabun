// ═══════════════════════════════════════════
// SynaBun — Teams: one object for the scheduler
// ═══════════════════════════════════════════
//
// createTeams(deps) puts the teams modules together over what the caller injects: a coordination store, a git
// runner and a test-command runner. Nothing here is wired into the server, the dispatcher or the runtime: the
// scheduler phase creates one of these and calls it (lib/teams/README.md is the reference).
//
//   const teams = createTeams({ store });
//   await teams.recover();                                   // once, at start-up
//   const made = await teams.create(plan, { density, testCommand });
//   await teams.startSlice(teamId, sliceId, { runId });      // then dispatch the worker with cwd = started.worktree
//   await teams.finishSlice(teamId, sliceId, { runId });     // when the worker reports done
//   await teams.integrate(teamId, sliceId);                  // or integrateAll(teamId)
//   await teams.land(teamId, { targetBranch, mode });        // only when the owner (or the Assistant for them) says so
//   await teams.remove(teamId);                              // after the landing
//
// Every function answers `{ ok: true, … }` or a refusal `{ ok: false, code, message, … }`; none throws for
// something a caller can act on.

import { createGitRunner, createLocks } from './git.js';
import { createTeamClaims } from './claims.js';
import { createTeamIntegration } from './integration.js';
import { createTeamLanding } from './landing.js';
import { createTeamRecovery } from './recovery.js';
import { createTeamState } from './state.js';
import { createTestRunner } from './test-runner.js';
import { createTeamWorktrees } from './worktrees.js';

/**
 * @param {object} deps
 * @param {object} deps.store                 a coordination store (lib/coordination/store.js); required
 * @param {Function} [deps.git]               a git runner (default: createGitRunner())
 * @param {Function} [deps.runTests]          a test-command runner (default: createTestRunner())
 * @param {Function|null} [deps.setup]        the dependency setup step of every new team (default: none;
 *                                            `cloneNodeModules()` of lib/teams/worktrees.js is one)
 * @param {{ name: string, email: string }|null} [deps.identity]  who SynaBun's commits are by (default: the
 *                                            repository's own identity)
 * @param {(worktree: string, relPath: string) => boolean} [deps.isIgnored]  default: `git check-ignore`
 * @param {object} [deps.registry]            where slices are registered for the worker guard (default: lib/worker-confinement.js)
 * @param {() => number} [deps.now]
 * @param {(tag: string, detail: any) => void} [deps.log]
 */
export function createTeams({ store, git = createGitRunner(), runTests = createTestRunner(), setup = null, identity = null, isIgnored = undefined, registry = undefined, now = Date.now, log = () => {} } = {}) {
  const state = createTeamState({ store, log });
  const locks = createLocks();
  const worktrees = createTeamWorktrees({ state, git, locks, setup, now, log });
  const claims = createTeamClaims({ store, state, git, log, ...(isIgnored ? { isIgnored } : {}), ...(registry ? { registry } : {}) });
  const integration = createTeamIntegration({ store, state, git, locks, claims, runTests, identity, now, log });
  const landing = createTeamLanding({ state, git, locks, claims, identity, now });
  const recovery = createTeamRecovery({ state, git, locks, worktrees, claims, integration, now, log });

  /** Create a team (worktrees, branches, the record) and take every slice's claims. */
  async function create(plan, options = {}) {
    const made = await worktrees.create(plan, options);
    if (!made.ok) return made;
    const claimed = claims.start(made.team.teamId);
    if (!claimed.ok) {
      // A valid plan's claims never clash; should the store say otherwise, the team does not start.
      await worktrees.remove(made.team.teamId, { discard: true, force: true });
      claims.end(made.team.teamId);
      return claimed;
    }
    return { ...made, claims: claimed.claims };
  }

  /** Give a slice to a run: its worktree is prepared, its claims are in the run's name, the worker guard knows it. */
  async function startSlice(teamId, sliceId, options = {}) {
    const started = await worktrees.startSlice(teamId, sliceId, options);
    if (!started.ok) return started;
    const claimed = claims.assign(teamId, sliceId, options.runId || null);
    if (!claimed.ok) return claimed;
    return { ...started, context: claims.context(teamId, sliceId) };
  }

  /** Remove a team's worktrees and branches (after a landing, or `discard: true`); its claims go with it. */
  async function remove(teamId, options = {}) {
    const out = await worktrees.remove(teamId, options);
    if (out.ok) claims.end(teamId);
    return out;
  }

  return {
    create,
    get: worktrees.get,
    plan: (teamId) => worktrees.get(teamId)?.plan || null,
    list: worktrees.list,
    inspect: worktrees.inspect,
    startSlice,
    finishSlice: integration.finishSlice,
    finishReadOnlySlice: async (teamId, sliceId, options) => {
      const out = await worktrees.finishReadOnlySlice(teamId, sliceId, options);
      if (out.ok) {
        claims.release(teamId, sliceId);
        if (worktrees.get(teamId)?.state === 'completed') claims.end(teamId);
      }
      return out;
    },
    integrate: integration.integrate,
    integrateAll: integration.integrateAll,
    testIntegration: integration.testIntegration,
    resolveInSlice: integration.resolveInSlice,
    acceptIntegrationHead: integration.acceptIntegrationHead,
    land: landing.land,
    remove,
    prune: worktrees.prune,
    recover: recovery.recover,
    checkWrite: claims.checkWrite,
    verifyOwnership: claims.verifyOwnership,
    context: claims.context,
    modules: Object.freeze({ state, worktrees, claims, integration, landing, recovery }),
  };
}

export { createGitRunner, createLocks, TeamGitError } from './git.js';
export { createTestRunner } from './test-runner.js';
export { createTeamState, TeamError } from './state.js';
export { createTeamWorktrees, cloneNodeModules } from './worktrees.js';
export { createTeamClaims } from './claims.js';
export { createTeamIntegration } from './integration.js';
export { createTeamLanding, LANDING_MODES } from './landing.js';
export { createTeamRecovery } from './recovery.js';

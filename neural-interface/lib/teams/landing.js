// ═══════════════════════════════════════════
// SynaBun — Teams: landing a team's result in the user's branch
// ═══════════════════════════════════════════
//
// A team's joined work waits on its integration branch. The user's branch receives it only here, in a step of its
// own that somebody asks for (owner decision, 2026-11-15): `land(teamId, { targetBranch, mode })`.
//
//   mode 'ff'      the target branch is moved forward to the integration branch. Possible only while the target
//                  has not moved away from what the team was built on.
//   mode 'merge'   a merge commit of the target and the integration branch is made (always a merge commit, also
//                  when a fast-forward would do), and the target is moved to it. The merge is computed without a
//                  checkout (`git merge-tree`); one that conflicts is refused, never resolved.
//
// A landing changes nothing and answers with a report when:
//   NOT_FAST_FORWARD       mode 'ff' and the target has commits the integration branch lacks
//   MERGE_CONFLICT         mode 'merge' and the two do not merge cleanly
//   TESTS_NOT_PASSED       the test command has not passed on the integration branch's head (`allowUntested` lands
//                          a team that has no test command, or whose head was not tested, on the caller's word)
//   TEAM_NOT_READY         a slice is not joined yet (`allowPartial` lands what is joined)
//   DIRTY_FILES_AFFECTED   the landing would change a file that has uncommitted changes in the checkout that has
//                          the target branch (or would write over a file that is there and untracked or ignored)
//   CHECKOUT_BUSY          that checkout is in the middle of a merge, a rebase, a cherry-pick, a revert or a bisect
//   CHECKOUT_REFUSED       git itself would not update that checkout (it checks again as it starts)
//   TARGET_MOVED           the target moved while the landing was prepared
// and the report says what the user can run themselves (`userShouldRun`).
//
// Where the target is checked out (the user's own checkout, usually), the branch, the index and the files are
// updated together by a fast-forward of that checkout to the commit prepared above. git carries every uncommitted
// change of a file the landing does not touch across unchanged, staged or not, and refuses before it changes
// anything when one would be overwritten; nothing is stashed, and no hook runs. Where the target is checked out
// nowhere, only the branch is moved (compare-and-swap on its old commit).

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { integrationBranchName, isTeamSlug, parseBranchName } from './schema.js';
import { gitSaid, identityEnv, line, nulList, operationsUnderWay, parseNameStatus } from './git.js';
import { refuse, sliceState } from './state.js';
import { changesOf, commitOf, listWorktrees, repoLockKey } from './worktrees.js';

const isDirectory = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const present = (path) => { try { lstatSync(path); return true; } catch { return false; } };
const exists = (path) => existsSync(path);

export const LANDING_MODES = Object.freeze(['ff', 'merge']);

/** Do two project-relative paths name the same file, or is one inside the other? */
function touches(a, b) {
  const x = a.replace(/\/+$/, '');
  const y = b.replace(/\/+$/, '');
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * @param {object} deps
 * @param {object} deps.state   createTeamState(...)
 * @param {Function} deps.git   createGitRunner(...)
 * @param {object} deps.locks   createLocks()
 * @param {object} deps.claims  createTeamClaims(...)
 * @param {{ name: string, email: string }|null} [deps.identity]
 * @param {() => number} [deps.now]
 */
export function createTeamLanding({ state, git, locks, claims, identity = null, now = Date.now } = {}) {
  const isAncestor = async (cwd, older, newer) => (await git(['merge-base', '--is-ancestor', older, newer], { cwd })).ok;

  /**
   * Bring a team's integration branch into a branch of the user's.
   *
   * @param {string} teamId
   * @param {object} [options]
   * @param {string} [options.targetBranch]   default: the branch the project was on when the team was created
   * @param {'ff'|'merge'} [options.mode]     default 'ff'
   * @param {boolean} [options.allowUntested] land although the tests have not passed on the integration head
   * @param {boolean} [options.allowPartial]  land although some slices are not joined
   * @returns {Promise<{ ok: true, landed: object, changed: object[] } | { ok: false, code: string, message: string, report?: object }>}
   */
  async function land(teamId, { targetBranch = null, mode = 'ff', allowUntested = false, allowPartial = false } = {}) {
    const record = isTeamSlug(teamId) ? state.record(teamId) : null;
    if (!record) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
    if (record.plan.readOnly) return refuse('TEAM_READ_ONLY', 'Read-only teams never commit, integrate or land.');
    if (!LANDING_MODES.includes(mode)) return refuse('INVALID_MODE', 'mode is "ff" (move the branch forward) or "merge" (make a merge commit).');
    if (record.state === 'merged') return refuse('ALREADY_LANDED', `Team "${teamId}" has landed already (${record.landed?.targetBranch || 'its target'}).`, { landed: record.landed || null });
    if (['creating', 'integrating', 'landing'].includes(record.state)) return refuse('TEAM_NEEDS_RECOVERY', `Team "${teamId}" is recorded as ${record.state}: run recover() first.`, { state: record.state });
    if (['failed', 'cancelled'].includes(record.state) || record.removed) return refuse('TEAM_NOT_ACTIVE', `Team "${teamId}" is ${record.removed ? 'removed' : record.state}: there is nothing to land.`, { state: record.state });
    const target = typeof targetBranch === 'string' && targetBranch.trim() ? targetBranch.trim() : record.baseBranch;
    if (!target) return refuse('TARGET_REQUIRED', 'The project was on no branch when the team was created: name the branch to land on (targetBranch).');
    if (parseBranchName(target)) return refuse('TARGET_IS_TEAM_BRANCH', `${target} is a team's own branch: a landing goes to a branch of yours.`);
    const cwd = record.projectPath;
    if (!isDirectory(cwd)) return refuse('PROJECT_NOT_FOUND', `${cwd} is not a folder.`);
    if (!(await git(['check-ref-format', '--branch', target], { cwd })).ok) return refuse('TARGET_NOT_FOUND', `"${target.slice(0, 120)}" is not a branch name.`);
    const source = integrationBranchName(teamId);

    return locks.run(repoLockKey(cwd), () => locks.run(`team:${teamId}`, async () => {
      const head = await commitOf(git, cwd, `refs/heads/${source}`);
      if (!head) return refuse('INTEGRATION_BRANCH_MISSING', `${source} is not there. Run recover() first.`);
      if (head !== record.integration.head) return refuse('INTEGRATION_MOVED', `${source} is at ${head}, not at the commit SynaBun left it on (${record.integration.head}): somebody moved it.`, { head, recorded: record.integration.head });

      const open = record.plan.slices.map((slice) => ({ id: slice.id, state: sliceState(record, slice.id) })).filter((slice) => !['integrated', 'cancelled'].includes(slice.state));
      if (open.length && !allowPartial) return refuse('TEAM_NOT_READY', `Team "${teamId}" is not finished: ${open.map((slice) => `${slice.id} is ${slice.state}`).join(', ')}.`, { report: { teamId, slices: open } });

      const tests = record.integration.tests;
      const tested = !!tests && tests.ok === true && tests.commit === head;
      if (!tested && !allowUntested) {
        const why = !record.testCommand && !tests ? 'the team has no test command' : !tests || tests.commit !== head ? 'the tests have not been run on this commit' : 'the tests failed on this commit';
        return refuse('TESTS_NOT_PASSED', `${source} (${head.slice(0, 12)}) has not passed its tests: ${why}. Nothing was landed.`, { report: { teamId, integrationHead: head, tests: tests || null, testCommand: record.testCommand } });
      }

      const targetHead = await commitOf(git, cwd, `refs/heads/${target}`);
      if (!targetHead) return refuse('TARGET_NOT_FOUND', `There is no branch named ${target} in this project.`);
      if (head === targetHead || await isAncestor(cwd, head, targetHead)) return refuse('NOTHING_TO_LAND', `${target} already has everything on ${source}.`, { report: { teamId, targetBranch: target, targetHead, integrationHead: head } });

      const byHand = (how) => [`git checkout ${target}`, how === 'ff' ? `git merge --ff-only ${source}` : `git merge --no-ff ${source}`];
      const fastForward = await isAncestor(cwd, targetHead, head);
      if (mode === 'ff' && !fastForward) {
        const counts = /^(\d+)\s+(\d+)/.exec((await git(['rev-list', '--left-right', '--count', `${targetHead}...${head}`], { cwd })).stdout || '');
        return refuse('NOT_FAST_FORWARD', `${target} has moved since the team started: it has ${counts ? counts[1] : 'some'} commit(s) that ${source} does not have, so it cannot be moved forward to it. Land with mode "merge", or merge it yourself.`, {
          report: { teamId, targetBranch: target, targetHead, integrationHead: head, baseCommit: record.baseCommit, targetOnly: counts ? Number(counts[1]) : null, integrationOnly: counts ? Number(counts[2]) : null, userShouldRun: byHand('merge') },
        });
      }

      // The commit the target is moved to: the integration head, or a merge commit made without a checkout.
      let to = head;
      let mergeCommit = null;
      if (mode === 'merge') {
        const merged = await git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', targetHead, head], { cwd });
        const parts = nulList(merged.stdout);
        if (merged.status === 1) return refuse('MERGE_CONFLICT', `${source} does not merge cleanly into ${target}: ${parts.slice(1, 6).join(', ')}${parts.length > 6 ? '…' : ''}. Nothing was landed and nothing was resolved.`, { report: { teamId, targetBranch: target, targetHead, integrationHead: head, files: parts.slice(1), userShouldRun: byHand('merge') } });
        if (!merged.ok || !/^[0-9a-f]{40,64}$/.test(parts[0] || '')) return refuse('MERGE_UNAVAILABLE', `git could not work the merge out without a checkout (${gitSaid(merged)}); it needs git 2.38 or newer. Nothing was landed.`, { report: { userShouldRun: byHand('merge') } });
        const made = await git(['commit-tree', parts[0], '-p', targetHead, '-p', head, '-m', `Merge team ${teamId} (${source}) into ${target}\n\nSynaBun-Team: ${teamId}`], { cwd, env: await identityEnv(git, cwd, identity) });
        mergeCommit = line(made);
        if (!made.ok || !mergeCommit) return refuse('MERGE_UNAVAILABLE', `The merge commit could not be made: ${gitSaid(made)}. Nothing was landed.`, { report: { userShouldRun: byHand('merge') } });
        to = mergeCommit;
      }
      const changed = parseNameStatus((await git(['diff', '--name-status', '-z', '--no-renames', targetHead, to], { cwd })).stdout);

      // The checkout that has the target branch, if any: the landing must not disturb what is uncommitted there.
      const checkout = (await listWorktrees(git, cwd)).find((entry) => entry.branch === target) || null;
      if (checkout) {
        const place = checkout.path;
        if (!isDirectory(place)) return refuse('CHECKOUT_REFUSED', `${target} is registered as checked out in ${place}, which is not there. Run "git worktree prune", then land again.`, { report: { checkout: place, userShouldRun: ['git worktree prune'] } });
        const busy = await operationsUnderWay(git, place, { exists });
        if (busy.any) {
          const what = busy.merge ? 'merge' : busy.rebase ? 'rebase' : busy.cherryPick ? 'cherry-pick' : busy.revert ? 'revert' : 'bisect';
          return refuse('CHECKOUT_BUSY', `${place} is in the middle of a ${what}: a landing there cannot be guaranteed to leave it as it is. Finish or abort the ${what}, then land again or merge it yourself.`, { report: { checkout: place, operation: what, userShouldRun: byHand(mode) } });
        }
        const changes = await changesOf(git, place);
        if (changes === null) return refuse('CHECKOUT_REFUSED', `The uncommitted changes of ${place} could not be read, so the landing cannot be guaranteed to leave them alone.`, { report: { checkout: place, userShouldRun: byHand(mode) } });
        const dirty = [...new Set(changes.flatMap((change) => [change.path, change.from].filter(Boolean)))];
        const affected = changed.filter((entry) => dirty.some((path) => touches(entry.path, path))).map((entry) => ({ path: entry.path, status: entry.status, why: 'uncommitted changes' }));
        // A file the landing adds where one already is (untracked files are in `dirty`; an ignored one is not).
        const covered = changed.filter((entry) => entry.status === 'A' && !affected.some((each) => each.path === entry.path) && present(join(place, entry.path))).map((entry) => ({ path: entry.path, status: entry.status, why: 'a file that is not tracked is already there' }));
        if (affected.length || covered.length) {
          const files = [...affected, ...covered];
          return refuse('DIRTY_FILES_AFFECTED', `The landing would change ${files.length} file(s) that have uncommitted changes in ${place}: ${files.slice(0, 5).map((file) => file.path).join(', ')}${files.length > 5 ? '…' : ''}. Nothing was landed. Commit or put those changes aside yourself, then land again.`, { report: { teamId, checkout: place, targetBranch: target, files, userShouldRun: byHand(mode) } });
        }
      }

      const previous = record.state;
      const landing = { targetBranch: target, mode, from: targetHead, to, integrationHead: head, mergeCommit, checkout: checkout?.path || null, startedAt: now() };
      state.writeTeam(teamId, 'landing', { landing });
      if (checkout) {
        // Branch, index and files together; a file the landing does not touch keeps its uncommitted changes.
        const moved = await git(['merge', '--ff-only', '-q', to], { cwd: checkout.path });
        const after = await commitOf(git, cwd, `refs/heads/${target}`);
        if (!moved.ok || after !== to) {
          state.writeTeam(teamId, previous, { landing: null });
          if (after === targetHead) return refuse('CHECKOUT_REFUSED', `git would not update ${checkout.path}: ${gitSaid(moved)}. Nothing was landed.`, { report: { checkout: checkout.path, userShouldRun: byHand(mode) } });
          return refuse('TARGET_MOVED', `${target} is at ${after}, neither where it was nor where the landing put it. Nothing more was done; look at ${checkout.path} before landing again.`, { report: { checkout: checkout.path, targetHead: after, from: targetHead, to } });
        }
      } else {
        const moved = await git(['update-ref', '-m', `synabun: land team ${teamId}`, `refs/heads/${target}`, to, targetHead], { cwd });
        if (!moved.ok) {
          state.writeTeam(teamId, previous, { landing: null });
          return refuse('TARGET_MOVED', `${target} moved while the landing was prepared: ${gitSaid(moved)}. Nothing was landed.`, { report: { targetBranch: target, from: targetHead, to } });
        }
      }
      const landed = { ...landing, files: changed.length, at: now(), partial: open.length > 0, tested };
      state.writeTeam(teamId, 'merged', { landing: null, landed });
      claims.end(teamId);
      return { ok: true, landed, changed };
    }));
  }

  return { land };
}

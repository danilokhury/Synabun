// ═══════════════════════════════════════════
// SynaBun — Teams: recovery after a crash
// ═══════════════════════════════════════════
//
// A team's steps are written to the journal before and after they run (lib/teams/state.js). recover() is called
// once when the server starts, before anything else touches a team: it reads where each team stood and what git
// and the disk say, and brings the two together.
//
//   creating      the team was being made. It has no work yet, so what is half-made is taken apart and made again
//                 (worktrees and branches that still point at the base commit); the team is `planned`, or `failed`
//                 when it cannot be made.
//   integrating   a slice was being joined, or its tests were running. A cherry-pick or merge under way is aborted
//                 and the integration branch goes back to the commit before the join. The slice is `done` again,
//                 ready to be joined: its commits are on its own branch, nothing of it is lost.
//   landing       the user's branch was being moved. Where it is now decides: at the landing's commit, the team is
//                 `merged`; where it was, the team is as before; anywhere else, it is reported.
//   any other     a worktree whose folder is gone is put back from its branch (the commits are there; what was
//                 uncommitted in the folder went with the folder); a slice whose branch is gone too is `failed`.
//                 A team whose integration branch and worktree are both gone and none of whose slices is at work
//                 any more is over, and nothing of it is made again: `merged` when its integration head is on its
//                 base branch already (merged outside `land`), `failed` when it never joined anything.
//
// Recovery never deletes work: it removes only what a creation left half-made (no worker had started), and it moves
// only the integration branch, back to a commit SynaBun itself recorded, when everything after that commit is a
// copy of commits a slice still has. Anything it does not understand it leaves alone and lists under `attention`.
// The user's checkout and branch are never touched.

import { existsSync, lstatSync, realpathSync, rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { INTEGRATION_SLICE_ID, branchName, integrationBranchName, integrationWorktreePath, worktreesRoot } from './schema.js';
import { gitSaid, operationsUnderWay } from './git.js';
import { SETTLED_SLICE_STATES, TERMINAL_TEAM_STATES, sliceState } from './state.js';
import { branchAt, changesOf, commitOf, listWorktrees, repoLockKey, repositoryOf } from './worktrees.js';

const isDirectory = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const present = (path) => { try { lstatSync(path); return true; } catch { return false; } };
const exists = (path) => existsSync(path);
const realOf = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * @param {object} deps
 * @param {object} deps.state        createTeamState(...)
 * @param {Function} deps.git        createGitRunner(...)
 * @param {object} deps.locks        createLocks()
 * @param {object} deps.worktrees    createTeamWorktrees(...)
 * @param {object} deps.claims       createTeamClaims(...)
 * @param {object} deps.integration  createTeamIntegration(...)
 * @param {() => number} [deps.now]
 * @param {(tag: string, detail: any) => void} [deps.log]
 */
export function createTeamRecovery({ state, git, locks, worktrees, claims, integration, now = Date.now, log = () => {} } = {}) {
  /** A team that was being created: take the half-made pieces apart and make them again. */
  async function recoverCreation(record, report) {
    const plan = record.plan;
    const cwd = plan.projectPath;
    const pieces = [...plan.slices.map((slice) => slice.id), ...(plan.readOnly ? [] : [INTEGRATION_SLICE_ID])].map((sliceId) => worktrees.placeOf(plan, sliceId));
    // Nothing of a team in creation has work in it. Should one piece have some all the same, nothing is removed.
    const registered = (await listWorktrees(git, cwd)).map((entry) => realOf(entry.path));
    for (const piece of pieces) {
      const head = await commitOf(git, cwd, `refs/heads/${piece.branch}`);
      if (head && head !== plan.baseCommit) { report.attention.push({ code: 'branch_has_commits', sliceId: piece.sliceId, branch: piece.branch, head }); return; }
      // Only a folder git knows as a worktree is asked for its changes (git asked in a plain folder answers for the
      // repository around it). A folder under the team's own folder that is no worktree is a checkout that stopped:
      // the team's folder was not there before the creation began.
      if (isDirectory(piece.path) && registered.includes(realOf(piece.path))) {
        const changes = await changesOf(git, piece.path);
        // A checkout that stopped half-way shows the files it did not write as deleted: that is not work.
        if (changes && changes.some((change) => change.index !== 'D' && change.worktree !== 'D')) { report.attention.push({ code: 'unexpected_changes', sliceId: piece.sliceId, path: piece.path }); return; }
      }
    }
    for (const piece of pieces) {
      if (present(piece.path)) {
        await git(['worktree', 'remove', '--force', piece.path], { cwd });
        if (present(piece.path)) await rm(piece.path, { recursive: true, force: true });
      }
    }
    await git(['worktree', 'prune'], { cwd });
    const built = await worktrees.materialize(plan);
    if (!built.ok) {
      await worktrees.unmake(plan, built.made);
      // Branches the stopped creation had made: they point at the base and hold nothing.
      for (const piece of pieces) {
        if (await commitOf(git, cwd, `refs/heads/${piece.branch}`) === plan.baseCommit) await git(['branch', '-D', piece.branch], { cwd });
      }
      try { rmdirSync(join(worktreesRoot(cwd), plan.teamId)); } catch { /* not empty, or not there */ }
      await state.writeTeam(plan.teamId, 'failed', { error: built.failed, failedAt: now(), recovered: true });
      report.actions.push({ action: 'creation_failed', error: built.failed.error });
      return;
    }
    await state.writeTeam(plan.teamId, 'planned', { worktrees: built.made.map(({ sliceId, path, branch }) => ({ sliceId, path, branch })), recovered: true });
    report.actions.push({ action: 'creation_completed', worktrees: built.made.length });
  }

  /** A team that was in the middle of a join or a test run: the integration branch back to the commit before it. */
  async function recoverIntegration(record, report) {
    const teamId = record.teamId;
    const cwd = record.projectPath;
    const under = record.integrating && typeof record.integrating === 'object' ? record.integrating : {};
    const before = under.before || record.integration.head;
    const place = integrationWorktreePath(cwd, teamId);
    const branch = integrationBranchName(teamId);
    if (!isDirectory(place)) {
      // The folder is gone: put it back from the branch first, then carry on as for one that is there.
      await git(['worktree', 'prune'], { cwd });
      const added = await git(['worktree', 'add', '-q', place, branch], { cwd });
      if (!added.ok) { report.attention.push({ code: 'integration_worktree_missing', error: gitSaid(added) }); return; }
      report.actions.push({ action: 'worktree_restored', sliceId: INTEGRATION_SLICE_ID });
    }
    if (await branchAt(git, place) !== branch) {
      // Not the integration worktree as SynaBun left it (a plain folder, another branch): nothing is reset.
      report.attention.push({ code: 'integration_worktree_not_on_its_branch', path: place, branch });
      await state.writeTeam(teamId, 'running', { integrating: null, recoveredAt: now() });
      if (under.sliceId && sliceState(record, under.sliceId) === 'integrating') await state.writeSlice(teamId, under.sliceId, 'done', { recovered: true });
      return;
    }
    const head = await commitOf(git, place, 'HEAD');
    if (head !== before) {
      // What is on the branch after `before` must be the slice's own commits again (a cherry-pick's copies, or a
      // merge of the slice): only then is going back to `before` no loss.
      const sliceHead = under.sliceHead || (under.sliceId ? await commitOf(git, cwd, `refs/heads/${branchName(teamId, under.sliceId)}`) : null);
      const descends = (await git(['merge-base', '--is-ancestor', before, head], { cwd })).ok;
      const foreign = descends && sliceHead
        ? (await git(['cherry', sliceHead, head, before], { cwd })).stdout.split('\n').filter((each) => each.startsWith('+ ')).length
        : descends && !under.sliceId ? 0 : -1;
      if (foreign !== 0) {
        report.attention.push({ code: 'integration_has_other_commits', head, before, branch });
        await state.writeTeam(teamId, 'running', { integrating: null, recoveredAt: now() });
        if (under.sliceId && sliceState(record, under.sliceId) === 'integrating') await state.writeSlice(teamId, under.sliceId, 'done', { recovered: true });
        return;
      }
    }
    const clean = await integration.settle(place, before);
    report.actions.push({ action: 'integration_reset', to: before, from: head, clean, phase: under.phase || null });
    if (under.sliceId && sliceState(record, under.sliceId) === 'integrating') {
      await state.writeSlice(teamId, under.sliceId, 'done', { recovered: true });
      report.actions.push({ action: 'slice_ready_again', sliceId: under.sliceId });
    }
    await state.writeTeam(teamId, 'running', { integrating: null, recoveredAt: now() });
  }

  /** A team whose landing was under way: where the target branch is now says whether it landed. */
  async function recoverLanding(record, report) {
    const teamId = record.teamId;
    const cwd = record.projectPath;
    const landing = record.landing && typeof record.landing === 'object' ? record.landing : null;
    const ready = record.plan.slices.every((slice) => ['integrated', 'cancelled'].includes(sliceState(record, slice.id)));
    if (!landing) { await state.writeTeam(teamId, ready ? 'ready' : 'running', { landing: null, recoveredAt: now() }); return; }
    const at = await commitOf(git, cwd, `refs/heads/${landing.targetBranch}`);
    if (at && at === landing.to) {
      await state.writeTeam(teamId, 'merged', { landing: null, landed: { ...landing, at: now(), recovered: true } });
      await claims.end(teamId);
      report.actions.push({ action: 'landing_confirmed', targetBranch: landing.targetBranch, to: landing.to });
      return;
    }
    await state.writeTeam(teamId, ready ? 'ready' : 'running', { landing: null, recoveredAt: now() });
    report.actions.push({ action: 'landing_not_done', targetBranch: landing.targetBranch, at });
    if (at !== landing.from) report.attention.push({ code: 'target_moved', targetBranch: landing.targetBranch, at, from: landing.from, to: landing.to });
    if (landing.checkout && at === landing.from && isDirectory(landing.checkout)) {
      // The branch did not move. Should the checkout's files have been written before the crash, they show as
      // uncommitted changes there: the user's to look at, never SynaBun's to change.
      const changes = await changesOf(git, landing.checkout);
      const diff = await git(['diff', '--name-only', '-z', '--no-renames', landing.from, landing.to], { cwd });
      const files = new Set(diff.stdout.split('\0').filter(Boolean));
      const touched = (changes || []).map((change) => change.path).filter((path) => files.has(path));
      if (touched.length) report.attention.push({ code: 'checkout_may_be_half_updated', checkout: landing.checkout, files: touched.slice(0, 50), userShouldRun: [`git -C ${landing.checkout} status`] });
    }
  }

  /**
   * A team whose integration branch and worktree are both gone, and none of whose slices is still at work, is over:
   * what it joined is on its base branch already (merged outside `land`), or it never joined anything. Making the
   * branch again would bring back a worktree nobody uses, at every start-up. It is closed instead: `merged` (its
   * `landed` says so, `external: true`) or `failed`. A slice whose branch and folder are gone is `failed`, as below;
   * nothing is removed but the team's folder when it is empty. Everything else is left to the steps below: a slice
   * still at work or whose branch is still there, commits on the integration head its base branch does not have, a
   * base branch that is not there.
   * @returns {Promise<boolean>} true when the team was closed
   */
  async function closeIfOver(record, report) {
    if (record.plan.readOnly || !['planned', 'running', 'ready'].includes(record.state)) return false;
    const teamId = record.teamId;
    const cwd = record.projectPath;
    const there = async (sliceId) => {
      const { path, branch } = worktrees.placeOf(record.plan, sliceId);
      return present(path) || !!(await commitOf(git, cwd, `refs/heads/${branch}`));
    };
    if (await there(INTEGRATION_SLICE_ID)) return false;
    const gone = [];
    let left = false;
    for (const slice of record.plan.slices) {
      const settled = SETTLED_SLICE_STATES.includes(sliceState(record, slice.id));
      if (!(await there(slice.id))) { if (!settled) gone.push(slice.id); continue; }
      if (!settled) return false;
      left = true;
    }
    const states = record.plan.slices.map((slice) => (gone.includes(slice.id) ? 'failed' : sliceState(record, slice.id)));
    const head = record.integration.head;
    let closed = null;
    if (!states.includes('integrated') && head === record.baseCommit) closed = 'failed';
    else if (record.baseBranch && head) {
      const target = await commitOf(git, cwd, `refs/heads/${record.baseBranch}`);
      if (target && (await git(['merge-base', '--is-ancestor', head, target], { cwd })).ok) closed = 'merged';
    }
    if (!closed) return false;
    await git(['worktree', 'prune'], { cwd });
    for (const sliceId of gone) {
      await state.writeSlice(teamId, sliceId, 'failed', { reason: 'its branch and its worktree are gone', failedAt: now() });
      report.actions.push({ action: 'slice_failed', sliceId, reason: 'missing' });
    }
    const removed = !left;
    if (closed === 'merged') {
      const tests = record.integration.tests;
      await state.writeTeam(teamId, 'merged', {
        landing: null, removed, recoveredAt: now(),
        landed: {
          targetBranch: record.baseBranch, mode: null, from: null, to: head, integrationHead: head, mergeCommit: null, checkout: null,
          files: null, at: now(), partial: states.some((each) => !['integrated', 'cancelled'].includes(each)),
          tested: !!tests && tests.ok === true && tests.commit === head, external: true, recovered: true,
        },
      });
    } else {
      await state.writeTeam(teamId, 'failed', {
        error: 'Every slice ended and nothing was joined; the integration branch and its worktree were gone at the restart, so recovery closed the team instead of making an empty branch again.',
        failedAt: now(), removed, recovered: true,
      });
    }
    await claims.end(teamId);
    try { rmdirSync(join(worktreesRoot(cwd), teamId)); } catch { /* not empty, or not there */ }
    report.actions.push({ action: 'team_closed', state: closed, reason: closed === 'merged' ? 'merged_outside_landing' : 'nothing_integrated', targetBranch: record.baseBranch, head, removed });
    return true;
  }

  /** Worktrees whose folder is gone, slices left in the middle of a join. */
  async function recoverPieces(record, report) {
    const teamId = record.teamId;
    const cwd = record.projectPath;
    if (await closeIfOver(record, report)) return;
    let registered = await listWorktrees(git, cwd);
    for (const sliceId of [...record.plan.slices.map((slice) => slice.id), ...(record.plan.readOnly ? [] : [INTEGRATION_SLICE_ID])]) {
      const current = sliceId === INTEGRATION_SLICE_ID ? null : sliceState(record, sliceId);
      if (current && SETTLED_SLICE_STATES.includes(current) && current !== 'integrated') continue;
      const info = await worktrees.pieceInfo(record, sliceId, registered);
      if (info.exists && info.registered) {
        if (!info.onBranch) report.attention.push({ code: 'not_on_its_branch', sliceId, path: info.path, branch: info.branch, on: info.checkedOut });
        if (sliceId === INTEGRATION_SLICE_ID && info.head && info.head !== record.integration.head) report.attention.push({ code: 'integration_moved', head: info.head, recorded: record.integration.head });
        continue;
      }
      if (info.exists && !info.registered) { report.attention.push({ code: 'folder_is_not_a_worktree', sliceId, path: info.path }); continue; }
      await git(['worktree', 'prune'], { cwd });
      if (!info.branchExists) {
        if (sliceId === INTEGRATION_SLICE_ID) {
          // The branch is gone: start it again where SynaBun left it, when that commit is still there.
          const at = await commitOf(git, cwd, record.integration.head);
          const added = at ? await git(['worktree', 'add', '-q', '-b', info.branch, info.path, at], { cwd }) : null;
          if (added?.ok) report.actions.push({ action: 'integration_branch_restored', at });
          else report.attention.push({ code: 'integration_branch_missing', branch: info.branch });
        } else if (current !== 'integrated') {
          await state.writeSlice(teamId, sliceId, 'failed', { reason: 'its branch and its worktree are gone', failedAt: now() });
          report.actions.push({ action: 'slice_failed', sliceId, reason: 'missing' });
        }
        continue;
      }
      const added = await git(['worktree', 'add', '-q', info.path, info.branch], { cwd });
      if (added.ok) report.actions.push({ action: 'worktree_restored', sliceId });
      else report.attention.push({ code: 'worktree_not_restored', sliceId, path: info.path, error: gitSaid(added) });
      registered = await listWorktrees(git, cwd);
    }
    const fresh = await state.record(teamId);
    for (const slice of fresh.plan.slices) {
      if (sliceState(fresh, slice.id) === 'integrating' && fresh.state !== 'integrating') {
        await state.writeSlice(teamId, slice.id, 'done', { recovered: true });
        report.actions.push({ action: 'slice_ready_again', sliceId: slice.id });
      }
    }
    // An operation left open in a slice's worktree is the worker's to see; it is only said here.
    for (const slice of fresh.plan.slices) {
      const path = worktrees.placeOf(fresh.plan, slice.id).path;
      if (SETTLED_SLICE_STATES.includes(sliceState(fresh, slice.id))) continue;
      if (await branchAt(git, path) !== branchName(teamId, slice.id)) continue;   // said above, or not a worktree
      const busy = await operationsUnderWay(git, path, { exists });
      if (busy.cherryPick || busy.rebase || busy.revert) report.attention.push({ code: 'slice_operation_under_way', sliceId: slice.id, path });
    }
  }

  /**
   * Bring every team (or one) to a state that matches git and the disk. Call it once at start-up, before any other
   * function of a team. Safe to call again: a team that is consistent is left as it is.
   *
   * @param {{ teamId?: string }} [options]
   * @returns {Promise<{ ok: true, teams: { teamId: string, state: string, was: string, actions: object[], attention: object[] }[], claims: object[] }>}
   */
  async function recover({ teamId = null } = {}) {
    const out = [];
    for (const entry of await state.teams()) {
      if (teamId && entry.teamId !== teamId) continue;
      const first = await state.record(entry.teamId);
      if (!first || first.removed || TERMINAL_TEAM_STATES.includes(first.state)) continue;
      const report = { teamId: first.teamId, was: first.state, state: first.state, actions: [], attention: [] };
      out.push(report);
      const repo = await repositoryOf(git, first.projectPath);
      if (!repo.ok) { report.attention.push({ code: repo.code, message: repo.message }); continue; }
      try {
        await locks.run(repoLockKey(first.projectPath), () => locks.run(`team:${first.teamId}`, async () => {
          const record = await state.record(first.teamId);
          if (record.state === 'creating') await recoverCreation(record, report);
          else if (record.state === 'integrating') await recoverIntegration(record, report);
          else if (record.state === 'landing') await recoverLanding(record, report);
          const after = await state.record(first.teamId);
          if (!TERMINAL_TEAM_STATES.includes(after.state) && after.state !== 'creating') await recoverPieces(after, report);
          // An empty folder a failed creation left behind.
          if (after.state === 'failed') { try { rmdirSync(join(worktreesRoot(after.projectPath), after.teamId)); } catch { /* not empty, or not there */ } }
        }));
      } catch (error) {
        log('teams:recover-failed', { teamId: first.teamId, error: error?.message || String(error) });
        report.attention.push({ code: 'recovery_failed', message: error?.message || String(error) });
      }
      report.state = (await state.record(first.teamId))?.state || report.state;
    }
    const restored = await claims.restore();
    return { ok: true, teams: out, claims: restored };
  }

  return { recover };
}

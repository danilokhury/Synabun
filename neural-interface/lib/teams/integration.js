// ═══════════════════════════════════════════
// SynaBun — Teams: finishing a slice and joining it on the integration branch
// ═══════════════════════════════════════════
//
// A slice's worker leaves its changes in the slice's worktree. What happens next is the server's, in three steps:
//
//   finishSlice    commits the slice's own files on the slice's branch (the worker does not use git to write: see
//                  lib/worker-confinement.js), then checks after the fact what the branch changed against what the
//                  slice owns. A slice that changed anything else is `rejected`: nothing of it is joined.
//   integrate      takes a finished slice's commits onto the integration branch, in the team's integration
//                  worktree, by cherry-pick; runs the team's test command on exactly that commit; and only then
//                  calls the slice `integrated`. A slice is joined after the slices it depends on.
//   resolveInSlice after a conflict: brings the integration branch into the slice's worktree and leaves the
//                  conflicts there for the slice's owner. Finishing the slice again commits the result.
//
// Nothing is ever resolved by force:
//   - a conflict stops the join, the cherry-pick is aborted, the integration worktree is exactly as before, the
//     slice is `conflict`, and the answer is a report of the files and both sides (the commit and slice on the
//     integration branch, the commit of the slice, the three versions' ids, the first conflict of each file);
//   - failed tests take the integration branch back to the commit before the join (the last good one), the slice is
//     `tests-failed`, and the answer has the end of the test output.
//
// Every step is written to the store's journal before and after it runs (`integrating` with what is under way), so
// recover() can bring a team back from a crash in the middle of any of them (lib/teams/recovery.js).
//
// The commits SynaBun makes use the repository's own identity (user.name / user.email, as the user's commits do),
// carry `SynaBun-Team` and `SynaBun-Slice` trailers, are not signed, and run no hook.

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EVENT_KINDS } from '../coordination/store.js';
import { branchName, integrationBranchName, integrationOrder, integrationWorktreePath, pathOwner, worktreePath } from './schema.js';
import { gitOutput, gitSaid, identityEnv, line, nulList, operationsUnderWay, parseIndexEntries } from './git.js';
import { TERMINAL_TEAM_STATES, planSlice, refuse, sliceState } from './state.js';
import { branchAt, changesOf, commitOf } from './worktrees.js';

const isDirectory = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const exists = (path) => existsSync(path);
const realOf = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
/** Slice states a slice can be finished from: a worker has been at it. */
const FINISHABLE = new Set(['running', 'done', 'rejected', 'conflict', 'tests-failed']);
const LIST_CAP = 120;
const cap = (list, n = LIST_CAP) => (list.length > n ? [...list.slice(0, n), { more: list.length - n }] : list);
const short = (text, n = 400) => String(text ?? '').slice(0, n);

/** Does this file still have the markers git writes into a conflict? */
function hasConflictMarkers(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return /^<{7} /m.test(text) && /^>{7} /m.test(text);
  } catch {
    return false;
  }
}

/** The first conflict of a file, markers included, bounded. */
function firstConflict(file, limit = 1500) {
  try {
    const text = readFileSync(file, 'utf8');
    const from = text.search(/^<{7} /m);
    if (from < 0) return null;
    const rest = text.slice(from);
    const end = rest.search(/^>{7} .*$/m);
    const upTo = end < 0 ? rest.length : end + (rest.slice(end).indexOf('\n') + 1 || rest.length - end);
    return rest.slice(0, Math.min(upTo, limit));
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.store     a coordination store
 * @param {object} deps.state     createTeamState(...)
 * @param {Function} deps.git     createGitRunner(...)
 * @param {object} deps.locks     createLocks()
 * @param {object} deps.claims    createTeamClaims(...)
 * @param {Function} deps.runTests  the test-command runner: `({ cwd, command, commit, teamId, sliceId, projectPath })
 *                                => Promise<{ ok, exitCode?, output?, durationMs? }>` (default: lib/teams/test-runner.js)
 * @param {{ name: string, email: string }|null} [deps.identity]  who SynaBun's commits are by (default: the repository's own)
 * @param {() => number} [deps.now]
 * @param {(tag: string, detail: any) => void} [deps.log]
 */
export function createTeamIntegration({ store, state, git, locks, claims, runTests, identity = null, now = Date.now, log = () => {} } = {}) {
  const teamKey = (teamId) => `team:${teamId}`;
  const sliceKey = (teamId, sliceId) => `slice:${teamId}/${sliceId}`;
  const isAncestor = async (cwd, older, newer) => (await git(['merge-base', '--is-ancestor', older, newer], { cwd })).ok;

  function announce(kind, teamId, payload) {
    try { store.append({ teamId, kind, payload }); } catch (error) { log('teams:announce-failed', { teamId, error: error?.message || String(error) }); }
  }

  /** The record and the slice, or the refusal. */
  function load(teamId, sliceId) {
    const record = state.record(teamId);
    if (!record) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
    if (record.plan.readOnly) return refuse('TEAM_READ_ONLY', 'Read-only teams never commit, integrate or land.');
    const slice = planSlice(record, sliceId);
    if (!slice) return refuse('SLICE_NOT_FOUND', `Team "${teamId}" has no slice "${sliceId}".`);
    if (TERMINAL_TEAM_STATES.includes(record.state) || record.removed) return refuse('TEAM_NOT_ACTIVE', `Team "${teamId}" is ${record.removed ? 'removed' : record.state}.`, { state: record.state });
    if (record.state === 'creating' || record.state === 'landing') return refuse('TEAM_NEEDS_RECOVERY', `Team "${teamId}" is recorded as ${record.state}: run recover() first.`, { state: record.state });
    return { ok: true, record, slice };
  }

  /** The message of the commit SynaBun makes for a slice: a subject, the caller's body, and the trailers. */
  function commitMessage(teamId, slice, message, runId) {
    const given = typeof message === 'string' ? message.replace(/\r\n?/g, '\n').trim() : '';
    const [subject, ...body] = (given || `${slice.title} (team ${teamId}, slice ${slice.id})`).split('\n');
    const trailers = [`SynaBun-Team: ${teamId}`, `SynaBun-Slice: ${slice.id}`, ...(runId ? [`SynaBun-Run: ${String(runId).slice(0, 120)}`] : [])];
    return [short(subject, 200), body.join('\n').trim(), trailers.join('\n')].filter(Boolean).join('\n\n');
  }

  /** A pathspec list on standard input, for a git write in a slice's worktree: every path literal. */
  const pathspecs = (paths) => ({ input: `${paths.join('\0')}\0`, env: { GIT_LITERAL_PATHSPECS: '1' } });

  /**
   * Put the index entries of `paths` back as `entries` (parseIndexEntries) had them before an attempt: a path that
   * had none is taken out of the index, one that had some gets exactly those (an unmerged path its stages again).
   * Only the slice's worktree, which finishSlice has checked is a worktree of its own on the slice's branch. The
   * files themselves are never touched. True when it was done.
   */
  async function restoreIndex(worktree, paths, entries) {
    if (!paths.length) return true;
    const head = line(await git(['rev-parse', 'HEAD'], { cwd: worktree }));
    const zeros = '0'.repeat(head.length || 40);
    const input = paths.flatMap((path) => [`0 ${zeros}\t${path}`, ...(entries.get(path) || [])]);
    return (await git(['update-index', '-z', '--index-info'], { cwd: worktree, input: `${input.join('\0')}\0` })).ok;
  }

  /**
   * Stage the slice's own changed files. A file git tracks is staged with `add -u`, which takes the file as it is
   * (changed or deleted) without walking a folder: a plain `add` of a tracked file inside an ignored folder (a built
   * `dist/` the project force-tracks) stages it and then fails all the same, because git's walk counts a path inside
   * an ignored folder as ignored. A new file is staged with a plain `add`, never `-f`: a new file the .gitignore
   * covers never shows up as changed, so it is never asked for (finishSlice names those in `ignored`). A path with
   * no index entry that is not new (a staged deletion) is already as it should be.
   * @returns {Promise<{ ok: true } | { ok: false, command: string, result: object }>}
   */
  async function stageOwn(worktree, tracked, fresh) {
    if (tracked.length) {
      const result = await git(['add', '-u', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: worktree, ...pathspecs(tracked) });
      if (!result.ok) return { ok: false, command: 'git add -u', result };
    }
    if (fresh.length) {
      const result = await git(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: worktree, ...pathspecs(fresh) });
      if (!result.ok) return { ok: false, command: 'git add', result };
    }
    return { ok: true };
  }

  /**
   * The new files in a slice's worktree that the .gitignore covers and the slice owns: never committed, named in the
   * answer so the owner sees what stayed out. A folder nothing of which is tracked is one entry with a trailing `/`.
   */
  async function ignoredOwn(worktree, plan, sliceId) {
    const result = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: worktree });
    if (!result.ok) return [];
    return nulList(result.stdout).filter((path) => pathOwner(plan, path.replace(/\/+$/, '')) === sliceId).sort().map((path) => ({ path }));
  }

  /**
   * A slice's worker is done: commit the slice's own files on its branch and check what the branch changed.
   *
   * Only files the slice owns are committed. A change to any other file is left where it is, uncommitted, and makes
   * the slice `rejected` (unless `allowStray`: then the slice is done and the leftovers are reported). A commit a
   * worker made itself that touches a file outside the slice's ownership rejects the slice whatever is passed.
   *
   * A file git tracks is committed even inside a folder the .gitignore covers (a force-tracked build output); a new
   * file the .gitignore covers is never force-added: it stays out and is named in `ignored`. When staging or the
   * commit fails, the answer carries everything git said (`git.output`, bounded) and the index of the slice's own
   * paths is put back as it was before the attempt (`indexRestored`).
   *
   * @param {string} teamId
   * @param {string} sliceId
   * @param {object} [options]
   * @param {string} [options.message]     the commit's message (default: the slice's title); trailers are added
   * @param {boolean} [options.allowStray] finish although files outside the slice's ownership are changed in the
   *                                       worktree (they stay uncommitted and are never joined)
   * @param {string} [options.runId]       the run that worked the slice
   * @returns {Promise<{ ok: true, sliceId: string, head: string, committed: boolean, changed: object[], stray: object[], warnings: object[], ignored: { path: string }[] }
   *   | { ok: false, code: 'OWNERSHIP_VIOLATION'|'STRAY_CHANGES'|string, message: string, violations?: object[], stray?: object[] }>}
   */
  async function finishSlice(teamId, sliceId, { message = null, allowStray = false, runId = null, isCurrent = () => true } = {}) {
    const loaded = load(teamId, sliceId);
    if (!loaded.ok) return loaded;
    const { record, slice } = loaded;
    const current = sliceState(record, sliceId);
    if (!FINISHABLE.has(current)) return refuse(current === 'integrated' ? 'SLICE_ALREADY_INTEGRATED' : 'SLICE_NOT_STARTED', `Slice "${sliceId}" is ${current}: only a slice a worker has been at can be finished.`, { state: current });
    const worktree = worktreePath(record.projectPath, teamId, sliceId);
    const branch = branchName(teamId, sliceId);

    return locks.run(sliceKey(teamId, sliceId), async () => {
      if (!isDirectory(worktree)) return refuse('SLICE_WORKTREE_MISSING', `The worktree of slice "${sliceId}" is not there (${worktree}). Run recover() first.`, { path: worktree });
      const on = await branchAt(git, worktree);
      if (on !== branch) return refuse('SLICE_BRANCH_MOVED', `The worktree of slice "${sliceId}" is on ${on || 'no branch'}, not on ${branch}: its work was not committed.`, { path: worktree, branch, on: on || null });
      const busy = await operationsUnderWay(git, worktree, { exists });
      if (busy.cherryPick || busy.rebase || busy.revert || busy.bisect) return refuse('SLICE_WORKTREE_BUSY', `The worktree of slice "${sliceId}" is in the middle of a ${busy.rebase ? 'rebase' : busy.cherryPick ? 'cherry-pick' : busy.revert ? 'revert' : 'bisect'}: finish or abort it first.`, { path: worktree });
      if (busy.merge) {
        const unmerged = nulList((await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: worktree })).stdout);
        const unresolved = unmerged.filter((path) => hasConflictMarkers(join(worktree, path)));
        if (unresolved.length) return refuse('UNRESOLVED_CONFLICTS', `Slice "${sliceId}" still has conflicts to resolve in ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? '…' : ''}.`, { files: unresolved });
      }
      const changes = await changesOf(git, worktree);
      if (changes === null) return refuse('GIT_FAILED', `The changes in the worktree of slice "${sliceId}" could not be read.`);
      const paths = [...new Set(changes.flatMap((change) => [change.path, change.from].filter(Boolean)))];
      const mine = paths.filter((path) => pathOwner(record.plan, path) === sliceId);
      // A file that is not the slice's and is staged already (a program the worker ran staged it) is taken out of
      // the index, so the commit holds the slice's own files only; the file itself stays as it is. Not during a
      // merge: what is staged then is the integration branch's own work, and belongs in the merge commit.
      if (!busy.merge) {
        const staged = [...new Set(changes.filter((change) => change.index !== ' ' && change.index !== '?').flatMap((change) => [change.path, change.from].filter(Boolean)))]
          .filter((path) => pathOwner(record.plan, path) !== sliceId);
        if (staged.length) {
          const unstaged = await git(['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: worktree, ...pathspecs(staged) });
          if (!unstaged.ok) return refuse('GIT_FAILED', `The files slice "${sliceId}" does not own could not be taken out of its commit: ${gitOutput(unstaged)}`, { git: { command: 'git reset', status: unstaged.status, output: gitOutput(unstaged) } });
        }
      }
      // What the index holds for the slice's own paths before this attempt stages anything: a staging or a commit
      // that fails puts exactly that back, so a failed attempt leaves nothing staged behind (a worker cannot clear
      // the index itself: its git is read-only).
      let before = new Map();
      if (mine.length) {
        const index = await git(['ls-files', '-s', '-z'], { cwd: worktree });
        if (!index.ok) return refuse('GIT_FAILED', `The index of slice "${sliceId}" could not be read: ${gitOutput(index)}`, { git: { command: 'git ls-files', status: index.status, output: gitOutput(index) } });
        const all = parseIndexEntries(index.stdout);
        before = new Map(mine.filter((path) => all.has(path)).map((path) => [path, all.get(path)]));
      }
      const fresh = new Set(changes.filter((change) => change.index === '?').map((change) => change.path));
      /** A failed step: the index of the slice's own paths put back, and the refusal with everything git said. */
      const failed = async (code, what, command, result) => {
        const restored = await restoreIndex(worktree, mine, before);
        if (!restored) log('teams:index-not-restored', { teamId, sliceId });
        const output = gitOutput(result);
        return refuse(code, `${what} (${command}): ${output}${restored ? '' : '\nThe index of its worktree could not be put back as it was.'}`, { sliceId, git: { command, status: result?.status ?? null, output }, indexRestored: restored });
      };
      if (mine.length) {
        const staged = await stageOwn(worktree, mine.filter((path) => before.has(path)), mine.filter((path) => !before.has(path) && fresh.has(path)));
        if (!staged.ok) return failed('GIT_FAILED', `The files of slice "${sliceId}" could not be staged`, staged.command, staged.result);
      }
      const ignored = await ignoredOwn(worktree, record.plan, sliceId);
      const nothingStaged = (await git(['diff', '--cached', '--quiet'], { cwd: worktree })).ok;
      let committed = false;
      if (!nothingStaged || busy.merge) {
        const commit = await git(['commit', '-q', '--no-verify', '-m', commitMessage(teamId, slice, message, runId)], { cwd: worktree, env: await identityEnv(git, worktree, identity) });
        if (!commit.ok) return failed('COMMIT_FAILED', `The work of slice "${sliceId}" could not be committed`, 'git commit', commit);
        committed = true;
      }
      const verdict = await claims.verifyOwnership(teamId, sliceId);
      // A newer turn can start during git I/O. Its claims stay live and its result
      // will verify the entire branch, including any commit already made here.
      if (!isCurrent()) return { ok: false, sliceId, skipped: 'new-turn' };
      if (verdict.ok === false && verdict.code) return verdict;
      const data = {
        head: verdict.head, reference: verdict.reference, finishedAt: now(),
        changed: cap(verdict.changed.map((entry) => ({ path: short(entry.path), status: entry.status }))),
        stray: cap(verdict.stray.map((entry) => ({ path: short(entry.path), owner: entry.owner, status: entry.status }))),
        warnings: cap(verdict.warnings.map((entry) => ({ code: entry.code, path: short(entry.path) })), 40),
        ignored: cap(ignored.map((entry) => ({ path: short(entry.path) }))),
      };
      if (verdict.violations.length) {
        const violations = verdict.violations.map((entry) => ({ path: entry.path, status: entry.status, owner: entry.owner }));
        state.writeSlice(teamId, sliceId, 'rejected', { ...data, violations: cap(violations.map((entry) => ({ ...entry, path: short(entry.path) }))) }, runId);
        return refuse('OWNERSHIP_VIOLATION', `Slice "${sliceId}" committed changes to files it does not own (${violations.slice(0, 5).map((entry) => entry.path).join(', ')}${violations.length > 5 ? '…' : ''}): it is rejected and nothing of it is joined.`, { sliceId, head: verdict.head, violations, stray: verdict.stray, ignored, committed });
      }
      if (verdict.stray.length && !allowStray) {
        state.writeSlice(teamId, sliceId, 'rejected', data, runId);
        return refuse('STRAY_CHANGES', `Slice "${sliceId}" changed files it does not own (${verdict.stray.slice(0, 5).map((entry) => entry.path).join(', ')}${verdict.stray.length > 5 ? '…' : ''}). They were left uncommitted in its worktree and the slice is rejected; its own files are committed.`, { sliceId, head: verdict.head, stray: verdict.stray, ignored, committed });
      }
      state.writeSlice(teamId, sliceId, 'done', { ...data, violations: [] }, runId);
      claims.release(teamId, sliceId);
      return { ok: true, sliceId, head: verdict.head, committed, changed: verdict.changed, stray: verdict.stray, warnings: verdict.warnings, ignored };
    });
  }

  /**
   * The integration worktree back to a commit, with nothing left over (it is SynaBun's own: nobody works there).
   * Only ever a folder that is a linked worktree of its own: a reset aimed at a plain folder would reach the
   * repository around it, and the project's own checkout is the user's. False when it could not be done.
   */
  async function settle(place, commit) {
    // A linked worktree has a `.git` file; the project's own checkout has a `.git` folder and is never reset.
    let linked = false;
    try { linked = lstatSync(join(place, '.git')).isFile(); } catch { linked = false; }
    if (!linked) return false;
    const top = line(await git(['rev-parse', '--show-toplevel'], { cwd: place }));
    if (!top || realOf(top) !== realOf(place)) return false;
    const busy = await operationsUnderWay(git, place, { exists });
    if (busy.cherryPick) await git(['cherry-pick', '--abort'], { cwd: place });
    if (busy.merge) await git(['merge', '--abort'], { cwd: place });
    if (busy.revert) await git(['revert', '--abort'], { cwd: place });
    await git(['reset', '--hard', '-q', commit], { cwd: place });
    await git(['clean', '-fd', '-q'], { cwd: place });
    const head = await commitOf(git, place, 'HEAD');
    const left = await changesOf(git, place);
    return head === commit && Array.isArray(left) && left.length === 0;
  }

  /** What a join that stopped on a conflict looked like, read before it is aborted. */
  async function conflictReport(record, sliceId, { place, before, sliceHead, method }) {
    const unmerged = await git(['ls-files', '-u', '-z'], { cwd: place });
    const files = new Map();
    for (const item of nulList(unmerged.stdout)) {
      const match = /^(\d+) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(item);
      if (!match) continue;
      const entry = files.get(match[4]) || { path: match[4], base: null, ours: null, theirs: null };
      entry[match[3] === '1' ? 'base' : match[3] === '2' ? 'ours' : 'theirs'] = match[2];
      files.set(match[4], entry);
    }
    const stopped = method === 'cherry-pick' ? (await commitOf(git, place, 'CHERRY_PICK_HEAD')) || sliceHead : sliceHead;
    const subjectOf = async (commit) => line(await git(['log', '-1', '--format=%s', commit], { cwd: place }));
    const out = [];
    for (const entry of [...files.values()].slice(0, LIST_CAP)) {
      // The side that is already on the integration branch: the last commit there that touched the file, and the
      // slice it came from (its trailer; the file's owner by the plan when the commit has none).
      const last = await git(['log', '-1', '--format=%H%x00%s%x00%(trailers:key=SynaBun-Slice,valueonly,separator=%x2C)', `${record.baseCommit}..${before}`, '--', entry.path], { cwd: place, env: { GIT_LITERAL_PATHSPECS: '1' } });
      const [commit, subject, trailer] = (last.stdout || '').trim().split('\0');
      out.push({
        path: entry.path,
        owner: pathOwner(record.plan, entry.path),
        ours: { side: 'integration', commit: commit || before, subject: subject || '', slice: (trailer || '').split(',')[0].trim() || null, blob: entry.ours },
        theirs: { side: 'slice', commit: stopped, subject: await subjectOf(stopped), slice: sliceId, blob: entry.theirs },
        base: entry.base,
        excerpt: out.length < 12 ? firstConflict(join(place, entry.path)) : null,
      });
    }
    return {
      teamId: record.teamId, sliceId, method,
      integrationBranch: integrationBranchName(record.teamId), integrationHead: before,
      sliceBranch: branchName(record.teamId, sliceId), sliceHead, stoppedAt: stopped,
      files: out,
    };
  }

  /** Run the team's test command on a commit of the integration worktree, and leave the worktree on that commit. */
  async function testsOn(record, place, commit, command, sliceId) {
    const started = now();
    const head = await commitOf(git, place, 'HEAD');
    if (head !== commit) return { ok: false, commit, command, at: started, error: `the integration worktree is on ${head}, not on ${commit}` };
    let result;
    try {
      result = await runTests({ cwd: place, command, commit, teamId: record.teamId, sliceId, projectPath: record.projectPath });
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    // What was tested is the commit: a test run that moved the branch did not test it.
    const after = await commitOf(git, place, 'HEAD');
    const moved = after !== commit;
    await settle(place, commit);
    return {
      ok: result?.ok === true && !moved, commit, command, at: started, durationMs: Number(result?.durationMs) || now() - started,
      exitCode: result?.exitCode ?? null, timedOut: result?.timedOut === true,
      output: short(result?.output ?? '', 8000).slice(-8000),
      ...(moved ? { error: 'the test command moved the integration branch' } : result?.error ? { error: short(result.error) } : {}),
    };
  }

  /**
   * Join a finished slice on the integration branch: its commits are cherry-picked there, the test command runs on
   * exactly the resulting commit, and the slice is `integrated` only when both went well.
   *
   * @param {string} teamId
   * @param {string} sliceId
   * @param {object} [options]
   * @param {boolean} [options.test]  run the team's test command (default true; without a command nothing is run and
   *                                  the integration head counts as untested)
   * @param {string|string[]} [options.testCommand]  a command for this join instead of the team's
   * @returns {Promise<{ ok: true, sliceId: string, method: string, commit: string, before: string, tests: object|null, ready: boolean }
   *   | { ok: false, code: 'CONFLICT'|'TESTS_FAILED'|string, message: string, report?: object }>}
   */
  async function integrate(teamId, sliceId, { test = true, testCommand = undefined, isCurrent = () => true } = {}) {
    return locks.run(teamKey(teamId), async () => {
      const loaded = load(teamId, sliceId);
      if (!loaded.ok) return loaded;
      const { record, slice } = loaded;
      if (record.state === 'integrating') return refuse('TEAM_NEEDS_RECOVERY', `Team "${teamId}" is recorded in the middle of a join: run recover() first.`, { state: record.state });
      const current = sliceState(record, sliceId);
      const own = record.slices[sliceId] || {};
      if (current === 'integrated') return { ok: true, sliceId, already: true, method: own.method || null, commit: own.integrationCommit || record.integration.head, before: record.integration.head, tests: record.integration.tests, ready: record.state === 'ready' };
      if (current !== 'done') return refuse('SLICE_NOT_DONE', `Slice "${sliceId}" is ${current}: only a finished slice (finishSlice) is joined.`, { state: current });
      const waiting = slice.dependsOn.filter((dep) => sliceState(record, dep) !== 'integrated');
      if (waiting.length) return refuse('DEPENDENCIES_NOT_INTEGRATED', `Slice "${sliceId}" is joined after ${waiting.join(', ')}.`, { waiting });

      const cwd = record.projectPath;
      const place = integrationWorktreePath(cwd, teamId);
      const branch = integrationBranchName(teamId);
      if (!isDirectory(place)) return refuse('INTEGRATION_WORKTREE_MISSING', `The integration worktree of team "${teamId}" is not there (${place}). Run recover() first.`, { path: place });
      const on = await branchAt(git, place);
      if (on !== branch) return refuse('INTEGRATION_MOVED', `The integration worktree is on ${on || 'no branch'}, not on ${branch}.`, { path: place });
      const before = await commitOf(git, place, 'HEAD');
      if (before !== record.integration.head) return refuse('INTEGRATION_MOVED', `${branch} is at ${before}, not at the commit SynaBun left it on (${record.integration.head}): somebody moved it. Run recover() to take it from here.`, { head: before, recorded: record.integration.head });
      if (!await settle(place, before)) return refuse('INTEGRATION_WORKTREE_DIRTY', `The integration worktree of team "${teamId}" could not be cleaned.`, { path: place });
      const sliceHead = await commitOf(git, cwd, `refs/heads/${branchName(teamId, sliceId)}`);
      if (!sliceHead) return refuse('SLICE_BRANCH_MISSING', `The branch of slice "${sliceId}" is not there.`);
      if (sliceHead !== own.head) return refuse('SLICE_MOVED', `The branch of slice "${sliceId}" moved since the slice was finished: finish it again.`, { head: sliceHead, finished: own.head || null });

      const from = own.integratedHead || own.startCommit || record.baseCommit;
      const fresh = Number(line(await git(['rev-list', '--count', `${from}..${sliceHead}`], { cwd })) || 0);
      const nothingNew = fresh === 0 || await isAncestor(cwd, sliceHead, before);
      const merges = nothingNew ? 0 : Number(line(await git(['rev-list', '--count', '--merges', `${from}..${sliceHead}`], { cwd })) || 0);
      const method = nothingNew ? 'none' : merges === 0 ? 'cherry-pick' : (await isAncestor(cwd, before, sliceHead)) ? 'fast-forward' : 'merge';

      const under = { sliceId, before, sliceHead, method, startedAt: now() };
      state.writeTeam(teamId, 'integrating', { integrating: { ...under, phase: 'applying' } });
      state.writeSlice(teamId, sliceId, 'integrating', {}, own.runId || null);

      // A follow-up can supersede this turn while git or the tests are running.
      // The next turn keeps the slice. Only the disposable integration candidate is rolled back.
      function superseded(clean) {
        if (!clean) return refuse('TEAM_NEEDS_RECOVERY', 'The superseded candidate could not be rolled back. Inspect the integration worktree before retrying.', { sliceId });
        state.writeSlice(teamId, sliceId, 'running', {}, own.runId || null);
        state.writeTeam(teamId, 'running', { integrating: null });
        const assigned = claims.assign(teamId, sliceId, own.runId);
        return assigned.ok ? { ok: false, sliceId, skipped: 'new-turn' } : assigned;
      }

      if (method !== 'none') {
        const env = await identityEnv(git, place, identity);
        const applied = method === 'cherry-pick'
          ? await git(['cherry-pick', '--allow-empty', '--keep-redundant-commits', `${from}..${sliceHead}`], { cwd: place, env })
          : method === 'fast-forward'
            ? await git(['merge', '--ff-only', '-q', sliceHead], { cwd: place, env })
            : await git(['merge', '--no-ff', '--no-edit', '-q', '-m', `Join slice ${sliceId} of team ${teamId}\n\nSynaBun-Team: ${teamId}\nSynaBun-Slice: ${sliceId}`, sliceHead], { cwd: place, env });
        if (!applied.ok) {
          const report = await conflictReport(record, sliceId, { place, before, sliceHead, method });
          const clean = await settle(place, before);
          if (!isCurrent()) return superseded(clean);
          if (!clean) log('teams:integration-not-clean', { teamId, sliceId });
          if (!report.files.length) {
            // Not a conflict: git could not apply the commits for another reason. The slice is still finished.
            state.writeSlice(teamId, sliceId, 'done', { lastJoinError: short(gitSaid(applied)) }, own.runId || null);
            state.writeTeam(teamId, 'running', { integrating: null });
            return refuse('INTEGRATION_FAILED', `Slice "${sliceId}" could not be joined: ${gitSaid(applied)}. The integration branch is unchanged.`, { sliceId, before });
          }
          report.clean = clean;
          const stored = { ...report, files: cap(report.files.map((file) => ({ ...file, path: short(file.path), excerpt: file.excerpt ? short(file.excerpt, 1500) : null })), 40) };
          state.writeSlice(teamId, sliceId, 'conflict', { conflict: stored, conflictAt: now() }, own.runId || null);
          state.writeTeam(teamId, 'running', { integrating: null });
          announce(EVENT_KINDS.INTEGRATION_CONFLICT, teamId, { teamId, sliceId, files: report.files.map((file) => file.path).slice(0, 50), integrationHead: before, sliceHead });
          return refuse('CONFLICT', `Slice "${sliceId}" conflicts with what is already on ${branch} in ${report.files.slice(0, 5).map((file) => file.path).join(', ')}${report.files.length > 5 ? '…' : ''}. The join was aborted and the integration branch is unchanged; nothing was resolved.`, { sliceId, report });
        }
      }

      const candidate = await commitOf(git, place, 'HEAD');
      const command = testCommand === undefined ? record.testCommand : testCommand;
      let tests = record.integration.tests;
      let lastGood = record.integration.lastGood;
      if (method !== 'none' && test !== false && command) {
        state.writeTeam(teamId, 'integrating', { integrating: { ...under, candidate, phase: 'testing' } });
        tests = await testsOn(record, place, candidate, command, sliceId);
        if (!tests.ok) {
          const clean = await settle(place, before);
          if (!isCurrent()) return superseded(clean);
          state.writeSlice(teamId, sliceId, 'tests-failed', { tests: { ...tests, output: short(tests.output, 6000).slice(-6000) }, candidate, testsFailedAt: now() }, own.runId || null);
          state.writeTeam(teamId, 'running', { integrating: null });
          return refuse('TESTS_FAILED', `The tests failed on ${candidate.slice(0, 12)} (slice "${sliceId}" joined on ${branch}). The integration branch is back at ${before.slice(0, 12)}, the last good commit.`, { sliceId, report: { teamId, sliceId, candidate, before, tests, clean } });
        }
        lastGood = candidate;
      }
      if (!isCurrent()) return superseded(await settle(place, before));
      state.writeSlice(teamId, sliceId, 'integrated', { integrationCommit: candidate, integratedHead: sliceHead, method, integratedAt: now() }, own.runId || null);
      const after = state.record(teamId);
      const ready = after.plan.slices.every((each) => ['integrated', 'cancelled'].includes(sliceState(after, each.id)));
      state.writeTeam(teamId, ready ? 'ready' : 'running', { integrating: null, integration: { head: candidate, lastGood, tests: tests && tests.commit === candidate ? { ...tests, output: short(tests.output, 2000).slice(-2000) } : tests } });
      claims.release(teamId, sliceId);
      if (ready) announce(EVENT_KINDS.INTEGRATION_READY, teamId, { teamId, integrationBranch: branch, head: candidate, tested: !!tests && tests.commit === candidate && tests.ok === true });
      return { ok: true, sliceId, method, commit: candidate, before, tests: tests && tests.commit === candidate ? tests : null, ready };
    });
  }

  /**
   * Join every finished slice, in dependency order (integrationOrder). A slice that is not finished, or waits for
   * one that is not joined, is skipped; a slice that fails to join does not stop the ones that do not depend on it.
   * The scheduler wraps each join and its retry handling in the same slice reservation as worker events.
   * @returns {Promise<{ ok: boolean, ready: boolean, results: object[] }>}
   */
  async function integrateAll(teamId, options = {}, joinSlice = integrate) {
    const first = state.record(teamId);
    if (!first) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
    if (first.plan.readOnly) return refuse('TEAM_READ_ONLY', 'Read-only teams never commit, integrate or land.');
    const results = [];
    for (const sliceId of integrationOrder(first.plan)) {
      const record = state.record(teamId);
      const current = sliceState(record, sliceId);
      if (current === 'integrated') { results.push({ sliceId, ok: true, already: true }); continue; }
      if (current !== 'done') { results.push({ sliceId, ok: false, skipped: current }); continue; }
      const waiting = planSlice(record, sliceId).dependsOn.filter((dep) => sliceState(record, dep) !== 'integrated');
      if (waiting.length) { results.push({ sliceId, ok: false, skipped: 'blocked', waiting }); continue; }
      results.push({ sliceId, ...(await joinSlice(teamId, sliceId, options)) });
    }
    const last = state.record(teamId);
    return { ok: results.every((each) => each.ok), ready: last.state === 'ready', results };
  }

  /**
   * Run the test command on the integration branch as it is now, and record the answer for that commit. Nothing is
   * taken back when they fail: the commit simply does not count as tested.
   */
  async function testIntegration(teamId, { testCommand = undefined } = {}) {
    return locks.run(teamKey(teamId), async () => {
      const record = state.record(teamId);
      if (!record) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
      if (record.plan.readOnly) return refuse('TEAM_READ_ONLY', 'Read-only teams never commit, integrate or land.');
      if (TERMINAL_TEAM_STATES.includes(record.state) || record.removed || ['creating', 'integrating', 'landing'].includes(record.state)) return refuse('TEAM_NOT_ACTIVE', `Team "${teamId}" is ${record.removed ? 'removed' : record.state}.`, { state: record.state });
      const command = testCommand === undefined ? record.testCommand : testCommand;
      if (!command) return refuse('NO_TEST_COMMAND', `Team "${teamId}" has no test command.`);
      const place = integrationWorktreePath(record.projectPath, teamId);
      if (!isDirectory(place)) return refuse('INTEGRATION_WORKTREE_MISSING', `The integration worktree of team "${teamId}" is not there (${place}).`);
      if (await branchAt(git, place) !== integrationBranchName(teamId)) return refuse('INTEGRATION_MOVED', `The integration worktree is not on ${integrationBranchName(teamId)}.`, { path: place });
      const head = await commitOf(git, place, 'HEAD');
      if (head !== record.integration.head) return refuse('INTEGRATION_MOVED', `${integrationBranchName(teamId)} is at ${head}, not at ${record.integration.head}.`, { head, recorded: record.integration.head });
      const previous = record.state;
      state.writeTeam(teamId, 'integrating', { integrating: { sliceId: null, before: head, candidate: head, phase: 'testing', startedAt: now() } });
      const tests = await testsOn(record, place, head, command, null);
      state.writeTeam(teamId, previous, { integrating: null, integration: { head, lastGood: tests.ok ? head : record.integration.lastGood, tests: { ...tests, output: short(tests.output, 2000).slice(-2000) } } });
      return tests.ok ? { ok: true, commit: head, tests } : refuse('TESTS_FAILED', `The tests failed on ${head.slice(0, 12)}.`, { report: { teamId, candidate: head, tests } });
    });
  }

  /**
   * After a conflict: bring the integration branch into the slice's worktree and leave the conflicts there, for the
   * slice's owner to resolve in its own files. The slice is `running` again (its claims are taken again); finishing
   * it commits the result, and it is then joined without a cherry-pick.
   * @returns {Promise<{ ok: true, sliceId: string, worktree: string, integrationHead: string, conflicts: string[] } | { ok: false, code: string }>}
   */
  async function resolveInSlice(teamId, sliceId, { runId = null } = {}) {
    const loaded = load(teamId, sliceId);
    if (!loaded.ok) return loaded;
    const { record } = loaded;
    const current = sliceState(record, sliceId);
    if (current !== 'conflict') return refuse('SLICE_NOT_IN_CONFLICT', `Slice "${sliceId}" is ${current}: there is no conflict to bring into its worktree.`, { state: current });
    const worktree = worktreePath(record.projectPath, teamId, sliceId);
    const branch = branchName(teamId, sliceId);
    return locks.run(sliceKey(teamId, sliceId), async () => {
      if (!isDirectory(worktree)) return refuse('SLICE_WORKTREE_MISSING', `The worktree of slice "${sliceId}" is not there (${worktree}).`, { path: worktree });
      const on = await branchAt(git, worktree);
      if (on !== branch) return refuse('SLICE_BRANCH_MOVED', `The worktree of slice "${sliceId}" is on ${on || 'no branch'}, not on ${branch}.`, { path: worktree });
      if ((await operationsUnderWay(git, worktree, { exists })).any) return refuse('SLICE_WORKTREE_BUSY', `The worktree of slice "${sliceId}" is in the middle of another operation.`, { path: worktree });
      const integration = await commitOf(git, record.projectPath, `refs/heads/${integrationBranchName(teamId)}`);
      const merged = await git(['merge', '--no-commit', '--no-ff', integration], { cwd: worktree, env: await identityEnv(git, worktree, identity) });
      const conflicts = nulList((await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: worktree })).stdout);
      const started = (await operationsUnderWay(git, worktree, { exists })).merge;
      if (!started) return refuse('MERGE_NOT_STARTED', `The integration branch could not be brought into slice "${sliceId}": ${gitSaid(merged)}`, { path: worktree });
      const claimed = claims.assign(teamId, sliceId, runId);
      if (!claimed.ok) { await git(['merge', '--abort'], { cwd: worktree }); return claimed; }
      state.writeSlice(teamId, sliceId, 'running', { resolving: { integrationHead: integration, files: cap(conflicts.map((path) => short(path)), 60) }, rework: true, startedAt: now() }, runId);
      return { ok: true, sliceId, worktree, branch, integrationHead: integration, conflicts };
    });
  }

  /**
   * Somebody committed on the integration branch itself, in its worktree (an integrator worker fixing what the
   * slices together broke, the owner): take its head as the team's. Only a move forward from the commit SynaBun
   * left it on is taken, and only a worktree with nothing uncommitted. The new head counts as untested.
   * @returns {Promise<{ ok: true, head: string, previous: string, commits: number } | { ok: false, code: string }>}
   */
  async function acceptIntegrationHead(teamId) {
    return locks.run(teamKey(teamId), async () => {
      const record = state.record(teamId);
      if (!record) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
      if (record.plan.readOnly) return refuse('TEAM_READ_ONLY', 'Read-only teams never commit, integrate or land.');
      if (TERMINAL_TEAM_STATES.includes(record.state) || record.removed || ['creating', 'integrating', 'landing'].includes(record.state)) return refuse('TEAM_NOT_ACTIVE', `Team "${teamId}" is ${record.removed ? 'removed' : record.state}.`, { state: record.state });
      const place = integrationWorktreePath(record.projectPath, teamId);
      const branch = integrationBranchName(teamId);
      if (!isDirectory(place)) return refuse('INTEGRATION_WORKTREE_MISSING', `The integration worktree of team "${teamId}" is not there (${place}).`);
      if (await branchAt(git, place) !== branch) return refuse('INTEGRATION_MOVED', `The integration worktree is not on ${branch}.`, { path: place });
      if ((await operationsUnderWay(git, place, { exists })).any) return refuse('INTEGRATION_WORKTREE_DIRTY', 'The integration worktree is in the middle of an operation: finish or abort it first.', { path: place });
      const left = await changesOf(git, place);
      if (!Array.isArray(left) || left.length) return refuse('INTEGRATION_WORKTREE_DIRTY', `The integration worktree has uncommitted changes (${(left || []).slice(0, 5).map((change) => change.path).join(', ')}): commit or drop them first.`, { path: place });
      const head = await commitOf(git, place, 'HEAD');
      const previous = record.integration.head;
      if (head === previous) return { ok: true, head, previous, commits: 0 };
      if (!await isAncestor(record.projectPath, previous, head)) return refuse('INTEGRATION_REWOUND', `${branch} no longer has ${previous.slice(0, 12)}, the commit SynaBun left it on: only commits added on top of it are taken.`, { head, recorded: previous });
      const commits = Number(line(await git(['rev-list', '--count', `${previous}..${head}`], { cwd: record.projectPath })) || 0);
      state.writeTeam(teamId, record.state, { integration: { head, lastGood: record.integration.lastGood, tests: record.integration.tests }, acceptedAt: now() });
      return { ok: true, head, previous, commits };
    });
  }

  return { finishSlice, integrate, integrateAll, testIntegration, resolveInSlice, acceptIntegrationHead, settle, conflictReport };
}

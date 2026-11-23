// ═══════════════════════════════════════════
// SynaBun — Teams: managed worktrees
// ═══════════════════════════════════════════
//
// A team works in worktrees SynaBun makes and removes, never in the user's checkout and never on the user's branch
// (owner decision, 2026-11-15). For a plan (lib/teams/schema.js):
//
//   <project>/.worktrees/<team>/<slice>        branch synabun/<team>/<slice>        one per slice
//   <project>/.worktrees/<team>/integration    branch synabun/<team>/integration    where finished slices are joined
//
// all cut from one pinned commit: the plan's base, which is the project's HEAD when the team is created unless the
// plan names one. The user's uncommitted files are not in any of them (a worktree is a checkout of a commit), and
// nothing here writes the user's checkout, index, stash or branch. `.worktrees/` is added to the repository's own
// `.git/info/exclude` when the project does not ignore it yet, never to `.gitignore`.
//
// What is refused, with a code, changing nothing:
//   NOT_A_GIT_REPOSITORY / PROJECT_NOT_REPO_ROOT / NO_COMMITS   the project is not a repository's root with a commit
//   INVALID_PLAN            the plan does not pass validateTeamPlan (`errors` lists why)
//   TEAM_EXISTS             the team's folder, one of its branches, a worktree registered under its folder or a
//                           journal entry is already there. `.worktrees/` also holds worktrees people make by hand
//                           (`.worktrees/agents-system`): a team never takes such a name.
//
// Removal is conservative. `remove(teamId)` works after a landing, or with `discard: true`; either way a worktree
// with uncommitted changes and a branch with commits that are nowhere else stay, and are reported, unless
// `force: true`. What is removed is written to the journal with the commit each branch pointed at.
//
// Dependencies are not installed per worktree: `setup` is a step the caller supplies (default: none).
// `cloneNodeModules()` is one: a copy-on-write clone of the project's ignored node_modules folders, where the file
// system can clone. Changing dependencies (lockfiles, and with them the manifests) is the lockfile-owner slice's.

import { execFile } from 'node:child_process';
import { appendFileSync, constants as FS, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statfsSync } from 'node:fs';
import { copyFile, cp, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  INTEGRATION_SLICE_ID, WORKTREES_DIR, branchName, integrationBranchName, isTeamSlug, normalizeRelPath, normalizeTeamPlan,
  parseWorktreePath, validateTeamPlan, worktreePath, worktreesRoot,
} from './schema.js';
import { gitSaid, line, nulList, parseStatus, parseWorktreeList } from './git.js';
import { TERMINAL_TEAM_STATES, planPieces, planSlice, refuse, sliceState } from './state.js';

const execFileAsync = promisify(execFile);
const realOf = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const isDirectory = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };
const present = (path) => { try { lstatSync(path); return true; } catch { return false; } };

/** The key under which everything that changes a repository's worktrees and branches takes its turn. */
export const repoLockKey = (projectPath) => `repo:${realOf(projectPath)}`;

/** Slice states from which a slice can be given to a worker for the first time. */
const FRESH_SLICE_STATES = new Set(['planned', 'pending', 'blocked']);
/** Slice states from which a worker can be sent back to a slice it already worked. */
const REWORK_SLICE_STATES = new Set(['running', 'done', 'rejected', 'conflict', 'tests-failed']);

// ── asking git ───────────────────────────────────────────────────────────────

/** The commit a revision names, or null. */
export async function commitOf(git, cwd, revision) {
  return line(await git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { cwd })) || null;
}

/** Does this branch exist? */
export async function branchExists(git, cwd, branch) {
  return (await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })).ok;
}

/**
 * The branch a folder is on, when the folder is a worktree of its own: git's top level for it is the folder itself.
 * Null for a folder that is not one (git asked inside a plain folder answers for the repository around it, which
 * here is the user's checkout: nothing a team does may be aimed at it by such an answer), and for a detached HEAD.
 */
export async function branchAt(git, path) {
  if (!isDirectory(path)) return null;
  const top = line(await git(['rev-parse', '--show-toplevel'], { cwd: path }));
  if (!top || realOf(top) !== realOf(path)) return null;
  return line(await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: path })) || null;
}

/** Every worktree the repository knows. */
export async function listWorktrees(git, cwd) {
  const result = await git(['worktree', 'list', '--porcelain'], { cwd });
  return result.ok ? parseWorktreeList(result.stdout) : [];
}

/** The uncommitted changes of a checkout: `{ path, index, worktree, from? }` each (untracked files one by one). */
export async function changesOf(git, cwd) {
  const result = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd });
  return result.ok ? parseStatus(result.stdout) : null;
}

/** `[ahead, behind]` of `head` against `other`, or null. */
async function aheadBehind(git, cwd, other, head) {
  const result = await git(['rev-list', '--left-right', '--count', `${other}...${head}`], { cwd });
  const match = /^(\d+)\s+(\d+)/.exec(result.stdout || '');
  return result.ok && match ? { ahead: Number(match[2]), behind: Number(match[1]) } : null;
}

/** How many commits of `limit..head` have no equal change in `upstream` (git cherry's `+` lines). */
async function commitsOnlyIn(git, cwd, upstream, head, limit) {
  if (!head || head === limit) return 0;
  const result = await git(['cherry', upstream, head, limit], { cwd });
  if (!result.ok) return -1;
  return result.stdout.split('\n').filter((each) => each.startsWith('+ ')).length;
}

/**
 * Is `branch` merged into `target`, for a guarded cleanup? SynaBun joins slices on the integration branch by
 * cherry-pick, so a slice branch's own commits are usually not ancestors of the target, only copies of them are.
 *
 * - `via: 'ancestor'`: the branch's head is an ancestor of the target (deleted with `git branch -d`).
 * - `via: 'patch-equivalent'`: every commit the branch has beyond `base` that the target cannot reach has a
 *   patch-equivalent commit the target reaches (`git cherry <target> <branch> <base>` prints no `+` line), and none of
 *   them is a merge commit (deleted by compare-and-swap on `head`, never by `branch -D`).
 * - Otherwise `ok: false`, with the commits that have no equivalent in `commits`. A merge commit the target cannot
 *   reach is always one of them: it has no single patch to compare, and `git cherry` passes over merges in silence.
 *
 * @returns {Promise<{ ok: boolean, branch: string, head: string|null, via: 'ancestor'|'patch-equivalent'|null,
 *   commits: string[], detail: string }>}
 */
export async function mergedInto(git, cwd, branch, target, base) {
  const out = (ok, head, via, commits, detail) => ({ ok, branch, head, via, commits, detail: `${branch}: ${detail}` });
  if (!target) return out(false, null, null, [], 'no landing target is recorded');
  const head = await commitOf(git, cwd, `refs/heads/${branch}`);
  const targetHead = await commitOf(git, cwd, `refs/heads/${target}`);
  if (!head) return out(false, null, null, [], 'the branch is not there');
  if (!targetHead) return out(false, head, null, [], `the landing target ${target} is not there`);
  if ((await git(['merge-base', '--is-ancestor', head, targetHead], { cwd })).ok) return out(true, head, 'ancestor', [], `ancestor of ${target}`);
  const limit = base && await commitOf(git, cwd, base);
  if (!limit) return out(false, head, null, [], `not an ancestor of ${target}, and the team's base commit is not there to compare from`);
  const merges = await git(['rev-list', '--merges', head, '--not', targetHead, limit], { cwd });
  const cherry = await git(['cherry', targetHead, head, limit], { cwd });
  if (!merges.ok || !cherry.ok) return out(false, head, null, [], `not an ancestor of ${target}, and git could not compare it (${gitSaid(merges.ok ? cherry : merges)})`);
  const mergeCommits = merges.stdout.split('\n').map((each) => each.trim()).filter(Boolean);
  const missing = cherry.stdout.split('\n').filter((each) => each.startsWith('+ ')).map((each) => each.slice(2).trim().split(/\s/)[0]);
  const commits = [...new Set([...missing, ...mergeCommits])];
  if (!commits.length) return out(true, head, 'patch-equivalent', [], `every commit has a patch-equivalent commit in ${target}`);
  const parts = [];
  if (missing.length) parts.push(`${missing.length} commit${missing.length === 1 ? ' has' : 's have'} no patch-equivalent commit in ${target}: ${missing.join(', ')}`);
  if (mergeCommits.length) parts.push(`${mergeCommits.length} merge commit${mergeCommits.length === 1 ? ' is' : 's are'} not reachable from ${target}: ${mergeCommits.join(', ')}`);
  return out(false, head, null, commits, `not merged into ${target}: ${parts.join('; ')}`);
}

/**
 * The project as a repository: its HEAD and branch. A refusal for a folder that is not the root of a repository
 * with a commit.
 */
export async function repositoryOf(git, projectPath) {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) return refuse('INVALID_PLAN', 'projectPath must be an absolute path.');
  if (!isDirectory(projectPath)) return refuse('PROJECT_NOT_FOUND', `${projectPath} is not a folder.`);
  const inside = await git(['rev-parse', '--is-inside-work-tree'], { cwd: projectPath });
  if (!inside.ok || line(inside) !== 'true') return refuse('NOT_A_GIT_REPOSITORY', `${projectPath} is not a git repository: a team needs one, because every worker gets a worktree of it. Run "git init" and commit first, or give the task to one worker.`);
  const top = line(await git(['rev-parse', '--show-toplevel'], { cwd: projectPath }));
  if (!top || realOf(top) !== realOf(projectPath)) return refuse('PROJECT_NOT_REPO_ROOT', `${projectPath} is inside the repository ${top || '(unknown)'}, not its root: a team's worktrees are made for the repository's root folder.`, { repositoryRoot: top || null });
  const head = await commitOf(git, projectPath, 'HEAD');
  if (!head) return refuse('NO_COMMITS', `${projectPath} has no commit yet: a team starts from a commit. Commit something first.`);
  const branch = line(await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: projectPath })) || null;
  return { ok: true, top, head, branch };
}

/** Make sure the project ignores `.worktrees/`: through `.git/info/exclude`, and only when nothing ignores it yet. */
export async function ensureWorktreesExcluded(git, projectPath) {
  const probe = await git(['check-ignore', '-q', '--no-index', '--', `${WORKTREES_DIR}/probe`], { cwd: projectPath });
  if (probe.status === 0) return { added: false };
  const where = line(await git(['rev-parse', '--git-path', 'info/exclude'], { cwd: projectPath }));
  if (!where) return { added: false, error: 'the repository\'s exclude file could not be found' };
  const file = isAbsolute(where) ? where : resolve(projectPath, where);
  mkdirSync(dirname(file), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${before && !before.endsWith('\n') ? '\n' : ''}${WORKTREES_DIR}/\n`);
  return { added: true, file };
}

// ── dependency setup ─────────────────────────────────────────────────────────

/**
 * A dependency setup step: clone the project's node_modules folders into a worktree, copy-on-write, so a worker
 * can run the project without an install. Only folders git ignores, only where the file system can clone (APFS,
 * Btrfs, XFS with reflinks): anywhere else nothing is copied and the answer says so.
 *
 * @param {object} [options]
 * @param {string[]} [options.paths]  project-relative folders to clone. Default: the `node_modules` beside every
 *                                    tracked `package.json`.
 * @param {number} [options.limit]    at most this many folders (default 40)
 * @returns {(context: { projectPath: string, worktree: string, teamId: string, sliceId: string, git: Function }) =>
 *   Promise<{ cloned: { path: string, ok: boolean, reason?: string }[] }>}
 */
export function cloneNodeModules({ paths = null, limit = 40 } = {}) {
  return async function setup({ projectPath, worktree, git }) {
    let list = Array.isArray(paths) ? paths : null;
    if (!list) {
      const tracked = await git(['ls-files', '-z', '--', 'package.json', '*/package.json'], { cwd: projectPath });
      list = nulList(tracked.stdout).map((file) => posix.join(posix.dirname(file), 'node_modules'));
    }
    const cloned = [];
    let supported = null;
    for (const raw of [...new Set(list)].slice(0, Math.max(0, limit))) {
      const rel = normalizeRelPath(raw);
      if (rel === null) { cloned.push({ path: String(raw), ok: false, reason: 'not_inside_project' }); continue; }
      const from = join(projectPath, rel);
      const to = join(worktree, rel);
      if (!isDirectory(from) || present(to)) continue;
      // Never a folder the project tracks: that one is in the worktree already, from the commit.
      if ((await git(['check-ignore', '-q', '--', rel], { cwd: projectPath })).status !== 0) { cloned.push({ path: rel, ok: false, reason: 'not_ignored' }); continue; }
      if (supported === null) supported = await canClone(projectPath, worktree);
      if (!supported) { cloned.push({ path: rel, ok: false, reason: 'clone_not_supported' }); continue; }
      try {
        mkdirSync(dirname(to), { recursive: true });
        await cloneFolder(from, to);
        cloned.push({ path: rel, ok: true });
      } catch (error) {
        await rm(to, { recursive: true, force: true }).catch(() => {});
        cloned.push({ path: rel, ok: false, reason: error?.code || error?.message || 'failed' });
      }
    }
    return { cloned };
  };
}

/** What statfs answers as the type of an APFS volume on macOS (the one file system there that clones). */
const APFS_TYPE = 0x1a;

/**
 * Can a file of the project be cloned (copy-on-write) into the worktree? On macOS: both on one APFS volume (`cp -c`
 * copies in full where it cannot clone, and Node's forced clone is not implemented there, so the file system is
 * asked for its type). Elsewhere: asked by cloning one small file, which fails where the file system cannot.
 */
async function canClone(projectPath, worktree) {
  try {
    if (lstatSync(projectPath).dev !== lstatSync(worktree).dev) return false;
    if (process.platform === 'darwin') return statfsSync(worktree).type === APFS_TYPE;
  } catch {
    return false;
  }
  const probe = join(worktree, `.synabun-clone-probe-${process.pid}`);
  try {
    const source = [join(projectPath, 'package.json'), ...readdirSync(projectPath).map((name) => join(projectPath, name))].find((path) => { try { return lstatSync(path).isFile(); } catch { return false; } });
    if (!source) return false;
    await copyFile(source, probe, FS.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }
}

async function cloneFolder(from, to) {
  if (process.platform === 'darwin') { await execFileAsync('cp', ['-c', '-R', from, to], { maxBuffer: 4 * 1024 * 1024 }); return; }
  if (process.platform === 'linux') { await execFileAsync('cp', ['-R', '--reflink=always', from, to], { maxBuffer: 4 * 1024 * 1024 }); return; }
  await cp(from, to, { recursive: true, mode: FS.COPYFILE_FICLONE_FORCE, verbatimSymlinks: true, errorOnExist: true, force: false });
}

// ── the module ───────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.state   createTeamState(...) of lib/teams/state.js
 * @param {Function} deps.git   createGitRunner(...) of lib/teams/git.js
 * @param {object} deps.locks   createLocks() of lib/teams/git.js
 * @param {Function} [deps.setup]  the default dependency setup step (`create`'s `setup` option overrides it)
 * @param {() => number} [deps.now]
 * @param {(tag: string, detail: any) => void} [deps.log]
 */
export function createTeamWorktrees({ state, git, locks, setup: defaultSetup = null, now = Date.now, log = () => {} } = {}) {
  const repoKey = repoLockKey;
  const piecesOf = (plan) => [...plan.slices.map((slice) => slice.id), ...(plan.readOnly ? [] : [INTEGRATION_SLICE_ID])];
  const placeOf = (plan, sliceId) => ({ sliceId, path: worktreePath(plan.projectPath, plan.teamId, sliceId), branch: branchName(plan.teamId, sliceId) });

  /** What already stands in a new team's way: its folder, its branches, worktrees registered under its folder. */
  async function collisions(plan) {
    const found = [];
    const folder = join(worktreesRoot(plan.projectPath), plan.teamId);
    if (present(folder)) found.push({ kind: 'folder', path: folder });
    const refs = await git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${branchName(plan.teamId, 'x').slice(0, -1)}`], { cwd: plan.projectPath });
    for (const branch of (refs.stdout || '').split('\n').map((each) => each.trim()).filter(Boolean)) found.push({ kind: 'branch', branch });
    // A branch named like the folder a team's branches need (`synabun`, `synabun/<team>`) blocks them all.
    for (const blocker of [branchName(plan.teamId, 'x').split('/')[0], branchName(plan.teamId, 'x').split('/').slice(0, 2).join('/')]) {
      if (await branchExists(git, plan.projectPath, blocker)) found.push({ kind: 'branch', branch: blocker });
    }
    const real = realOf(folder);
    for (const entry of await listWorktrees(git, plan.projectPath)) {
      const at = resolve(entry.path);
      if (at === folder || at.startsWith(`${folder}/`) || at === real || at.startsWith(`${real}/`)) found.push({ kind: 'worktree', path: entry.path });
    }
    return found;
  }

  /** Make the worktrees and branches of a plan that are not there yet. Answers what it made, or the failure. */
  async function materialize(plan) {
    const made = [];
    for (const sliceId of piecesOf(plan)) {
      const { path, branch } = placeOf(plan, sliceId);
      const hasBranch = await branchExists(git, plan.projectPath, branch);
      const result = await git(['worktree', 'add', '-q', ...(hasBranch ? [path, branch] : ['-b', branch, path, plan.baseCommit])], { cwd: plan.projectPath });
      if (!result.ok) return { ok: false, made, failed: { sliceId, path, branch, error: gitSaid(result) } };
      made.push({ sliceId, path, branch, madeBranch: !hasBranch });
    }
    return { ok: true, made };
  }

  /** Take back what a failed creation made: worktrees, and branches that still point at the base. */
  async function unmake(plan, made) {
    for (const piece of made) {
      await git(['worktree', 'remove', '--force', piece.path], { cwd: plan.projectPath });
      if (present(piece.path)) await rm(piece.path, { recursive: true, force: true });
      if (piece.madeBranch && await commitOf(git, plan.projectPath, `refs/heads/${piece.branch}`) === plan.baseCommit) await git(['branch', '-D', piece.branch], { cwd: plan.projectPath });
    }
    await git(['worktree', 'prune'], { cwd: plan.projectPath });
    const folder = join(worktreesRoot(plan.projectPath), plan.teamId);
    try { rmdirSync(folder); } catch { /* something is still in it: it stays */ }
  }

  async function runSetup(plan, setup) {
    if (typeof setup !== 'function') return [];
    const out = [];
    for (const sliceId of piecesOf(plan)) {
      const { path } = placeOf(plan, sliceId);
      try {
        const result = await setup({ projectPath: plan.projectPath, worktree: path, teamId: plan.teamId, sliceId, git });
        out.push({ sliceId, ok: true, ...(result && typeof result === 'object' ? result : {}) });
      } catch (error) {
        log('teams:setup-failed', { teamId: plan.teamId, sliceId, error: error?.message || String(error) });
        out.push({ sliceId, ok: false, error: error?.message || String(error) });
      }
    }
    return out;
  }

  /**
   * Create a team: pin the base, make every slice's worktree and branch and the integration ones, record it.
   *
   * @param {object} input  a team plan (lib/teams/schema.js). `baseCommit` may be left out: the project's HEAD is
   *                        pinned then. One it names must be a commit of the repository.
   * @param {object} [options]
   * @param {string} [options.density]      the session's Agent density: the cap on slices (validateTeamPlan)
   * @param {number} [options.maxSlices]    the cap as a number
   * @param {string|string[]} [options.testCommand]  what `integrate` runs on each integration commit
   * @param {Function|null} [options.setup] the dependency setup step for this team (null: none)
   * @param {string} [options.createdBy]    who asked (a session id, for the record)
   * @returns {Promise<{ ok: true, team: object, setup: object[], excluded: object } | { ok: false, code: string, message: string }>}
   */
  async function create(input, { density = null, maxSlices = null, testCommand = null, setup = undefined, createdBy = null } = {}) {
    const draft = normalizeTeamPlan(input);
    const repo = await repositoryOf(git, draft.projectPath);
    if (!repo.ok) return repo;
    let baseCommit = repo.head;
    if (draft.baseCommit) {
      baseCommit = await commitOf(git, draft.projectPath, draft.baseCommit);
      if (!baseCommit || baseCommit !== draft.baseCommit) return refuse('BASE_NOT_FOUND', `${draft.baseCommit} is not a commit of this repository.`);
    }
    const checked = validateTeamPlan({ ...(input && typeof input === 'object' ? input : {}), baseCommit }, { density, maxSlices });
    if (!checked.ok) return refuse('INVALID_PLAN', `The plan is not valid: ${checked.errors[0].message}`, { errors: checked.errors });
    const plan = checked.value;
    const command = plan.readOnly ? null : testCommandOf(testCommand);
    if (command === false) return refuse('INVALID_TEST_COMMAND', 'testCommand is a command line (text) or a list of arguments.');

    return locks.run(repoKey(plan.projectPath), async () => {
      if (await state.record(plan.teamId)) return refuse('TEAM_EXISTS', `A team named "${plan.teamId}" is already recorded. Pick another team id, or remove that team first.`, { existing: [{ kind: 'journal', teamId: plan.teamId }] });
      const existing = await collisions(plan);
      if (existing.length) {
        const what = existing.map((each) => each.path || each.branch).join(', ');
        return refuse('TEAM_EXISTS', `"${plan.teamId}" is taken in this project (${what}). ${WORKTREES_DIR}/ also holds worktrees made by hand: pick another team id.`, { existing });
      }
      const excluded = await ensureWorktreesExcluded(git, plan.projectPath);
      const pieces = planPieces(plan);
      await state.writeTeam(plan.teamId, 'creating', {
        plan: pieces.team, baseBranch: repo.branch, headAtCreate: repo.head, testCommand: command, createdBy: typeof createdBy === 'string' ? createdBy : null,
        integration: { head: plan.baseCommit, lastGood: plan.baseCommit, tests: null },
      });
      for (const piece of pieces.slices) {
        await state.writeSlice(plan.teamId, piece.id, 'planned', { task: piece.task });
        await state.writeSlice(plan.teamId, piece.id, 'pending', { ownedPaths: piece.ownedPaths, ...placeOf(plan, piece.id), startCommit: plan.baseCommit });
      }
      const built = await materialize(plan);
      if (!built.ok) {
        await unmake(plan, built.made);
        await state.writeTeam(plan.teamId, 'failed', { error: built.failed, failedAt: now() });
        return refuse('WORKTREE_FAILED', `The worktree of "${built.failed.sliceId}" could not be made: ${built.failed.error}. Nothing of the team is left.`, { failed: built.failed });
      }
      const prepared = await runSetup(plan, plan.readOnly ? null : setup === undefined ? defaultSetup : setup);
      await state.writeTeam(plan.teamId, 'planned', { worktrees: built.made.map(({ sliceId, path, branch }) => ({ sliceId, path, branch })) });
      return { ok: true, team: await state.record(plan.teamId), setup: prepared, excluded };
    });
  }

  /** A team's record (lib/teams/state.js), or null. */
  const get = async (teamId) => (isTeamSlug(teamId) ? await state.record(teamId) : null);

  /**
   * The teams the journal knows, oldest first.
   * @param {{ projectPath?: string, states?: string[], includeRemoved?: boolean }} [query]
   */
  async function list({ projectPath = null, states = null, includeRemoved = true } = {}) {
    const wanted = projectPath ? realOf(projectPath) : null;
    const out = [];
    for (const entry of await state.teams(states ? { states } : {})) {
      const record = await state.record(entry.teamId);
      if (!record) continue;
      if (wanted && realOf(record.projectPath) !== wanted) continue;
      if (!includeRemoved && record.removed) continue;
      out.push({
        teamId: record.teamId, state: record.state, projectPath: record.projectPath, baseCommit: record.baseCommit, baseBranch: record.baseBranch,
        integrationBranch: record.plan.readOnly ? null : integrationBranchName(record.teamId), removed: record.removed,
        slices: record.plan.slices.map((slice) => ({ id: slice.id, title: slice.title, state: sliceState(record, slice.id), dependsOn: slice.dependsOn })),
        createdAt: record.createdAt, updatedAt: record.updatedAt,
      });
    }
    return out;
  }

  /** One worktree of a team as it is now: there or not, its branch and head, how far it is from the base, what is uncommitted. */
  async function pieceInfo(record, sliceId, registered = null) {
    const { path, branch } = placeOf(record.plan, sliceId);
    const known = registered || await listWorktrees(git, record.projectPath);
    const entry = known.find((each) => realOf(each.path) === realOf(path)) || null;
    const exists = isDirectory(path);
    const head = await commitOf(git, record.projectPath, `refs/heads/${branch}`);
    const info = { sliceId, path, branch, exists, registered: !!entry, branchExists: !!head, head, checkedOut: entry?.branch || null, onBranch: entry?.branch === branch, dirty: null, changes: [], base: null, lastCommit: null };
    if (exists && entry) {
      const changes = await changesOf(git, path);
      info.changes = changes || [];
      info.dirty = changes === null ? null : changes.length;
    }
    if (head) {
      info.base = await aheadBehind(git, record.projectPath, record.baseCommit, head);
      const last = await git(['log', '-1', '--format=%H%x00%s%x00%cI', head], { cwd: record.projectPath });
      const [sha, subject, date] = (last.stdout || '').trim().split('\0');
      if (last.ok && sha) info.lastCommit = { sha, subject: subject || '', date: date || null };
    }
    return info;
  }

  /**
   * A team as it stands on disk and in git: every slice's worktree and branch (ahead / behind the base and the
   * integration branch, uncommitted files, last commit), the integration branch, and the user's branch.
   */
  async function inspect(teamId) {
    const record = await get(teamId);
    if (!record) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
    const registered = isDirectory(record.projectPath) ? await listWorktrees(git, record.projectPath) : [];
    const integration = record.plan.readOnly ? {} : await pieceInfo(record, INTEGRATION_SLICE_ID, registered);
    const slices = [];
    for (const slice of record.plan.slices) {
      const info = await pieceInfo(record, slice.id, registered);
      const own = record.slices[slice.id] || {};
      slices.push({
        ...info, id: slice.id, title: slice.title, state: sliceState(record, slice.id), dependsOn: slice.dependsOn, ownedPaths: slice.ownedPaths,
        runId: own.runId || null, startCommit: own.startCommit || record.baseCommit,
        integration: info.head && integration.head ? await aheadBehind(git, record.projectPath, integration.head, info.head) : null,
        unintegrated: info.head && integration.head ? await commitsOnlyIn(git, record.projectPath, integration.head, info.head, record.baseCommit) : null,
      });
    }
    const target = record.landed?.targetBranch || record.baseBranch || null;
    const targetHead = target ? await commitOf(git, record.projectPath, `refs/heads/${target}`) : null;
    return {
      ok: true, teamId, state: record.state, projectPath: record.projectPath, baseCommit: record.baseCommit, baseBranch: record.baseBranch,
      removed: record.removed, testCommand: record.testCommand, slices,
      integration: {
        ...integration, recordedHead: record.integration.head, lastGood: record.integration.lastGood, tests: record.integration.tests,
        moved: !!integration.head && integration.head !== record.integration.head,
      },
      target: target ? {
        branch: target, head: targetHead, exists: !!targetHead,
        fastForward: !!(targetHead && integration.head) && (await git(['merge-base', '--is-ancestor', targetHead, integration.head], { cwd: record.projectPath })).ok,
        landed: record.state === 'merged',
      } : null,
      landed: record.landed || null,
    };
  }

  /**
   * Give a slice to a worker: check that what it waits for is joined, bring a slice with dependencies up to the
   * integration branch (its dependencies' work is there), and record the commit its own work starts from.
   * A slice sent back to work (after a conflict, a rejection, failed tests) keeps its worktree as it is.
   *
   * @returns {Promise<{ ok: true, sliceId: string, worktree: string, branch: string, startCommit: string, rework: boolean } | { ok: false, code: string }>}
   */
  async function startSlice(teamId, sliceId, { runId = null } = {}) {
    const record = await get(teamId);
    if (!record) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
    const slice = planSlice(record, sliceId);
    if (!slice) return refuse('SLICE_NOT_FOUND', `Team "${teamId}" has no slice "${sliceId}".`);
    if (TERMINAL_TEAM_STATES.includes(record.state) || record.state === 'creating' || record.removed) return refuse('TEAM_NOT_ACTIVE', `Team "${teamId}" is ${record.removed ? 'removed' : record.state}: no slice of it can start.`, { state: record.state });
    const current = sliceState(record, sliceId);
    const rework = REWORK_SLICE_STATES.has(current);
    if (!rework && !FRESH_SLICE_STATES.has(current)) return refuse('SLICE_NOT_STARTABLE', `Slice "${sliceId}" is ${current}: it cannot be started.`, { state: current });
    const waiting = slice.dependsOn.filter((dep) => sliceState(record, dep) !== 'integrated');
    if (waiting.length) return refuse('DEPENDENCIES_NOT_INTEGRATED', `Slice "${sliceId}" waits for ${waiting.join(', ')}: a slice starts once the slices it depends on are joined on the integration branch.`, { waiting });
    const { path, branch } = placeOf(record.plan, sliceId);
    return locks.run(`slice:${teamId}/${sliceId}`, async () => {
      if (!isDirectory(path)) return refuse('SLICE_WORKTREE_MISSING', `The worktree of slice "${sliceId}" is not there (${path}). Run recover() first.`, { path });
      const on = await branchAt(git, path);
      if (on !== branch) return refuse('SLICE_BRANCH_MOVED', `The worktree of slice "${sliceId}" is on ${on || 'no branch'}, not on ${branch}.`, { path, branch, on: on || null });
      let startCommit = record.slices[sliceId]?.startCommit || record.baseCommit;
      if (!rework) {
        const head = await commitOf(git, path, 'HEAD');
        const integration = await commitOf(git, record.projectPath, `refs/heads/${integrationBranchName(teamId)}`);
        if (slice.dependsOn.length && integration && integration !== head) {
          // Its dependencies' work is on the integration branch: the slice starts from there. Nothing of its own
          // is in the worktree yet, so this is a plain fast-forward.
          const moved = await git(['merge', '--ff-only', '-q', integration], { cwd: path });
          if (!moved.ok) return refuse('SLICE_NOT_FAST_FORWARD', `Slice "${sliceId}" could not be brought up to the integration branch: ${gitSaid(moved)}`, { path });
        }
        startCommit = await commitOf(git, path, 'HEAD') || head;
      }
      await state.writeSlice(teamId, sliceId, 'running', { startCommit, startedAt: now(), ...(rework ? { rework: true } : {}) }, runId);
      if (record.state === 'planned' || record.state === 'ready') await state.writeTeam(teamId, 'running', {});
      return { ok: true, sliceId, worktree: path, branch, startCommit, rework };
    });
  }

  /** A read-only worker has ended. Preserve any changed checkout or commit, including ignored files. */
  async function finishReadOnlySlice(teamId, sliceId, { failed = false } = {}) {
    const record = await get(teamId);
    if (!record?.plan.readOnly) return refuse('TEAM_NOT_READ_ONLY', 'This operation is for read-only workers.');
    if (!planSlice(record, sliceId)) return refuse('SLICE_NOT_FOUND', `Unknown slice ${sliceId}.`);
    return locks.run(repoKey(record.projectPath), async () => {
      const info = await pieceInfo(record, sliceId);
      let kept = null;
      if (info.exists || info.registered || info.branchExists) {
        const status = info.exists && info.registered && info.onBranch
          ? await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { cwd: info.path }) : null;
        const changes = status?.ok ? parseStatus(status.stdout) : null;
        if (!changes) kept = { ...info, reason: 'worktree_not_verified' };
        else if (changes.length || info.head !== record.baseCommit) kept = { sliceId, path: info.path, branch: info.branch, head: info.head,
          reason: changes.length ? 'uncommitted_changes' : 'worker_commits', files: changes.map(c => c.path), baseCommit: record.baseCommit };
        else {
          // Without --force: a concurrent change must make removal fail, never erase work.
          const gone = await git(['worktree', 'remove', info.path], { cwd: record.projectPath });
          if (!gone.ok) kept = { sliceId, path: info.path, branch: info.branch, reason: 'worktree_not_removed', error: gitSaid(gone) };
          else {
            const removed = await git(['branch', '-D', info.branch], { cwd: record.projectPath });
            if (!removed.ok) kept = { sliceId, path: info.path, branch: info.branch, reason: 'branch_not_removed', error: gitSaid(removed) };
          }
        }
      }
      const cleanup = { removed: !kept, kept, path: info.path, branch: info.branch };
      await state.writeSlice(teamId, sliceId, failed ? 'failed' : 'completed', { cleanup, endedAt: now() });
      const fresh = await get(teamId);
      const ended = fresh.plan.slices.every(s => fresh.slices[s.id]?.cleanup);
      if (ended) {
        const clean = fresh.plan.slices.every(s => fresh.slices[s.id]?.cleanup.removed);
        await state.writeTeam(teamId, 'completed', { removed: clean });
        if (clean) { try { rmdirSync(join(worktreesRoot(record.projectPath), teamId)); } catch {} }
      }
      return { ok: true, ...cleanup };
    });
  }

  /**
   * Remove a team's worktrees and branches. Only after a landing, or with `discard: true`. A worktree with
   * uncommitted changes and a branch whose commits are nowhere else are kept and reported, unless `force: true`.
   *
   * @returns {Promise<{ ok: true, complete: boolean, removed: object[], kept: object[] } | { ok: false, code: string }>}
   */
  async function remove(teamId, { discard = false, force = false, guarded = false, checkOnly = false } = {}) {
    const record = await get(teamId);
    if (!record) return refuse('TEAM_NOT_FOUND', `No team named "${teamId}" is recorded.`);
    if (guarded && record.plan.readOnly) return refuse('TEAM_NOT_LANDED', 'Read-only teams cannot land.', { checks: [{ name: 'landed', ok: false, detail: 'Read-only team' }] });
    if (record.plan.readOnly) {
      const removed = [], kept = [];
      for (const slice of record.plan.slices) {
        const out = await finishReadOnlySlice(teamId, slice.id, { failed: record.slices[slice.id]?.state === 'failed' });
        if (!out.ok) return out;
        if (out.kept) kept.push(out.kept);
        else removed.push({ sliceId: slice.id, path: out.path, branch: out.branch });
      }
      return { ok: true, complete: !kept.length, removed, kept };
    }
    if (record.state === 'integrating' || record.state === 'landing' || record.state === 'creating') return refuse('TEAM_NEEDS_RECOVERY', `Team "${teamId}" is recorded as ${record.state}: run recover() before removing it.`, { state: record.state });
    const landed = record.state === 'merged';
    if (!landed && !discard && !record.plan.readOnly && !checkOnly) return refuse('TEAM_NOT_LANDED', `Team "${teamId}" has not landed: its result is on ${integrationBranchName(teamId)}. Land it first, or pass discard: true to give its work up.`, { state: record.state });
    if (!isDirectory(record.projectPath)) return refuse('PROJECT_NOT_FOUND', `${record.projectPath} is not a folder.`);

    return locks.run(repoKey(record.projectPath), async () => {
      if (guarded) {
        const checks = [];
        const items = piecesOf(record.plan).map(sliceId => ({ sliceId, path: worktreePath(record.projectPath, teamId, sliceId), branch: sliceId === INTEGRATION_SLICE_ID ? integrationBranchName(teamId) : branchName(teamId, sliceId) }));
        const registered = await listWorktrees(git, record.projectPath);
        const target = record.landed?.targetBranch;
        for (const item of items) {
          let linked = false;
          try { linked = lstatSync(join(item.path, '.git')).isFile() && !lstatSync(item.path).isSymbolicLink(); } catch {}
          const valid = linked && await branchAt(git, item.path) === item.branch && registered.some(w => realOf(w.path) === realOf(item.path) && w.branch === item.branch && !w.locked) && registered.every(w => w.branch !== item.branch || realOf(w.path) === realOf(item.path));
          checks.push({ name: 'clean', ok: !!valid, detail: `${item.path}: ${valid ? 'linked worktree verified' : 'not an unlocked linked worktree on its expected branch'}` });
          if (valid) {
            const changes = await changesOf(git, item.path);
            checks.push({ name: 'clean', ok: changes !== null && changes.length === 0, detail: `${item.path}: ${changes === null ? 'status unavailable' : changes.map(c => c.path).join(', ') || 'clean'}` });
          }
          // Merged: an ancestor of the target, or every commit beyond the base patch-equivalent to one in it
          // (mergedInto). The head it checked is the one the deletion compares against.
          const merged = await mergedInto(git, record.projectPath, item.branch, target, record.baseCommit);
          item.head = merged.head;
          item.via = merged.via;
          checks.push({ name: 'merged', ok: merged.ok, detail: merged.detail, branch: item.branch, head: merged.head, via: merged.via, commits: merged.commits });
        }
        // branch -d checks the configured upstream, or HEAD when none exists.
        // Verify that criterion too for the ancestors it deletes, so a different target checkout cannot cause
        // partial removal. A patch-equivalent branch is deleted by compare-and-swap, which asks neither.
        for (const item of items.filter((each) => each.via === 'ancestor')) {
          const upstream = line(await git(['rev-parse', '--abbrev-ref', `${item.branch}@{upstream}`], { cwd: record.projectPath })) || 'HEAD';
          const safe = (await git(['merge-base', '--is-ancestor', item.head, upstream], { cwd: record.projectPath })).ok;
          checks.push({ name: 'merged', ok: safe, detail: `${item.branch}: safe branch -d against ${upstream}` });
        }
        const failed = checks.find(c => !c.ok);
        if (failed) return refuse(failed.name === 'merged' ? 'BRANCH_NOT_MERGED' : 'WORKTREE_DIRTY', failed.detail, { checks });
        if (checkOnly) return { ok: true, checks };
        // All checks precede all mutations. The branches are settled first, in one atomic ref transaction: every
        // ancestor is verified at the head that was checked, and every patch-equivalent branch is deleted only if it
        // is still at that head (`git branch -d` refuses those, and `-D` is never used). Such a branch is checked
        // out in its worktree, so that worktree's HEAD is detached at the same commit first (no file or index
        // changes); a failed transaction puts every HEAD back and removes nothing.
        const cwd = record.projectPath;
        const equivalent = items.filter((each) => each.via === 'patch-equivalent');
        const detached = [];
        const reattach = async () => {
          const failures = [];
          for (const item of detached.splice(0)) {
            const back = await git(['symbolic-ref', '-m', 'SynaBun cleanup refused', 'HEAD', `refs/heads/${item.branch}`], { cwd: item.path });
            if (!back.ok) failures.push(`${item.path}: ${gitSaid(back)}`);
          }
          return failures;
        };
        for (const item of equivalent) {
          const detach = await git(['update-ref', '--no-deref', '-m', 'SynaBun cleanup', 'HEAD', item.head], { cwd: item.path });
          if (!detach.ok) {
            const failures = await reattach();
            if (failures.length) throw new Error(`Cleanup interrupted: ${failures.join('; ')}`);
            return refuse('WORKTREE_DIRTY', `${item.path}: could not be detached for the branch deletion (${gitSaid(detach)}). Nothing was removed.`, { checks });
          }
          detached.push(item);
        }
        const transaction = [
          ...items.filter((each) => each.via === 'ancestor').map((each) => `verify refs/heads/${each.branch} ${each.head}`),
          ...equivalent.map((each) => `delete refs/heads/${each.branch} ${each.head}`),
        ].join('\n') + '\n';
        const settled = await git(['update-ref', '-m', 'SynaBun cleanup', '--stdin'], { cwd, input: transaction });
        if (!settled.ok) {
          const failures = await reattach();
          if (failures.length) throw new Error(`Cleanup interrupted: ${gitSaid(settled)}; ${failures.join('; ')}`);
          const moved = [];
          for (const item of items) {
            const current = await commitOf(git, cwd, `refs/heads/${item.branch}`);
            if (current !== item.head) moved.push(`${item.branch} (checked at ${item.head}, now ${current || 'gone'})`);
          }
          return refuse('BRANCH_MOVED', `${moved.length ? `${moved.join(', ')} moved` : 'A team branch changed'} between the merged check and the deletion (${gitSaid(settled)}). Nothing was removed.`, { checks, moved });
        }
        const removed = [];
        for (const item of items) {
          const gone = await git(['worktree', 'remove', item.path], { cwd });
          if (!gone.ok) throw new Error(`Cleanup interrupted: ${gitSaid(gone)}`);
          if (item.via === 'ancestor') {
            const deleted = await git(['branch', '-d', item.branch], { cwd });
            if (!deleted.ok) throw new Error(`Cleanup interrupted: ${gitSaid(deleted)}`);
          }
          removed.push({ sliceId: item.sliceId, path: item.path, branch: item.branch });
        }
        const pruned = await git(['worktree', 'prune'], { cwd: record.projectPath });
        if (!pruned.ok) throw new Error(`Cleanup prune failed: ${gitSaid(pruned)}`);
        try { rmdirSync(join(worktreesRoot(record.projectPath), teamId)); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
        await state.writeTeam(teamId, 'merged', { removed: true, removal: { at: now(), force: false, removed, kept: [] } });
        return { ok: true, complete: true, removed, checks };
      }
      const registered = await listWorktrees(git, record.projectPath);
      const integration = record.plan.readOnly ? {} : await pieceInfo(record, INTEGRATION_SLICE_ID, registered);
      const target = record.landed?.targetBranch || record.baseBranch || null;
      const targetHead = (target && await commitOf(git, record.projectPath, `refs/heads/${target}`)) || record.baseCommit;
      // What a slice's commits are measured against: once landed, the integration branch (what is there landed
      // with it); otherwise the user's branch, where nothing of the team is.
      const upstream = landed && integration.head ? integration.head : targetHead;
      const removed = [];
      const kept = [];
      const order = piecesOf(record.plan);
      for (const sliceId of order) {
        const info = sliceId === INTEGRATION_SLICE_ID ? integration : await pieceInfo(record, sliceId, registered);
        if (!info.exists && !info.registered && !info.branchExists) continue;
        const uncommitted = sliceId === INTEGRATION_SLICE_ID ? [] : info.changes.map((change) => change.path);
        const only = info.head
          ? (sliceId === INTEGRATION_SLICE_ID
            ? Number(line(await git(['rev-list', '--count', `${targetHead}..${info.head}`], { cwd: record.projectPath })) || 0)
            : await commitsOnlyIn(git, record.projectPath, upstream, info.head, record.baseCommit))
          : 0;
        // A folder that is there but is no worktree of the repository: what is in it is unknown, so it stays.
        if (!force && info.exists && !info.registered) {
          kept.push({ sliceId, path: info.path, branch: info.branch, head: info.head, reason: 'folder_is_not_a_worktree', files: [], commits: 0 });
          continue;
        }
        if (!force && (uncommitted.length || only !== 0)) {
          kept.push({
            sliceId, path: info.path, branch: info.branch, head: info.head,
            reason: uncommitted.length ? 'uncommitted_changes' : 'unintegrated_commits',
            files: uncommitted.slice(0, 50), commits: Math.max(only, 0),
          });
          continue;
        }
        if (info.registered || info.exists) {
          const gone = await git(['worktree', 'remove', '--force', info.path], { cwd: record.projectPath });
          if (!gone.ok && present(info.path)) {
            if (info.registered) { kept.push({ sliceId, path: info.path, branch: info.branch, head: info.head, reason: 'worktree_not_removed', error: gitSaid(gone) }); continue; }
            await rm(info.path, { recursive: true, force: true });
          }
        }
        await git(['worktree', 'prune'], { cwd: record.projectPath });
        if (info.branchExists) {
          const deleted = await git(['branch', '-D', info.branch], { cwd: record.projectPath });
          if (!deleted.ok) { kept.push({ sliceId, path: info.path, branch: info.branch, head: info.head, reason: 'branch_not_removed', error: gitSaid(deleted) }); continue; }
        }
        removed.push({ sliceId, path: info.path, branch: info.branch, head: info.head });
      }
      const folder = join(worktreesRoot(record.projectPath), teamId);
      let folderRemoved = false;
      try { rmdirSync(folder); folderRemoved = true; } catch { folderRemoved = !present(folder); }
      const complete = kept.length === 0;
      await state.writeTeam(teamId, landed ? 'merged' : 'cancelled', {
        removed: complete, removal: { at: now(), discard: !landed, force: !!force, removed, kept },
      });
      for (const slice of record.plan.slices) {
        if (!landed && removed.some((each) => each.sliceId === slice.id) && sliceState(record, slice.id) !== 'integrated') await state.writeSlice(teamId, slice.id, 'cancelled', { discarded: true });
      }
      return { ok: true, complete, landed, removed, kept, folderRemoved };
    });
  }

  /**
   * Clear what is stale in a project: worktree registrations whose folder is gone (`git worktree prune`) and the
   * empty folders of teams the journal knows. A folder somebody made by hand is never touched.
   */
  async function prune({ projectPath } = {}) {
    const repo = await repositoryOf(git, projectPath);
    if (!repo.ok) return repo;
    return locks.run(repoKey(projectPath), async () => {
      const before = await listWorktrees(git, projectPath);
      const stale = before.filter((entry) => entry.prunable || !present(entry.path)).map((entry) => ({ path: entry.path, branch: entry.branch, team: parseWorktreePath(projectPath, resolve(entry.path)) }));
      const result = await git(['worktree', 'prune'], { cwd: projectPath });
      const folders = [];
      const root = worktreesRoot(projectPath);
      let names = [];
      try { names = readdirSync(root); } catch { names = []; }
      for (const name of names) {
        if (!isTeamSlug(name) || !await state.record(name)) continue;
        try { rmdirSync(join(root, name)); folders.push(join(root, name)); } catch { /* not empty: a team's worktrees are in it */ }
      }
      return { ok: result.ok, pruned: stale, folders, ...(result.ok ? {} : { error: gitSaid(result) }) };
    });
  }

  return { create, get, list, inspect, startSlice, finishReadOnlySlice, remove, prune, materialize, unmake, pieceInfo, placeOf, collisions };
}

/** A test command as it is stored: text, a list of arguments, or null. `false` for anything else. */
export function testCommandOf(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value.trim().length && value.length <= 4000 ? value.trim() : false;
  if (Array.isArray(value) && value.length && value.length <= 200 && value.every((arg) => typeof arg === 'string' && arg.length <= 4000) && value[0]) return [...value];
  return false;
}

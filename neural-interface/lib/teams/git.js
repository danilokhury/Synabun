// ═══════════════════════════════════════════
// SynaBun — Teams: how git is run for a team
// ═══════════════════════════════════════════
//
// A team's git work happens in three kinds of place: the worktrees SynaBun made for it (slices and integration),
// the repository's own data (branches, the list of worktrees), and, for a landing only, the checkout that has the
// user's branch. Every command is an argument array, never a command line, and is run the same careful way:
//
//   hooks            `-c core.hooksPath=<the null device>`: nothing a repository's hooks name is started. A team's
//                    commits are bookkeeping on SynaBun's own branches; the project's checks are the test command
//                    that runs on the integration commit.
//   file monitor     a read is given lib/git-read.js's arguments (a program named in core.fsmonitor is never
//                    started; git's built-in monitor is kept); a write is given `core.fsmonitor=false`.
//   signing          `-c commit.gpgsign=false`: a signing program would wait for a passphrase nobody types.
//   remotes          GIT_ALLOW_PROTOCOL empty, GIT_NO_LAZY_FETCH=1: nothing here needs a remote.
//   recorded fixes   `-c rerere.enabled=false`: a conflict is reported, never resolved from an old recording.
//   editor, prompt   GIT_EDITOR / GIT_SEQUENCE_EDITOR `true`, GIT_TERMINAL_PROMPT=0, `--no-pager`.
//   housekeeping     `-c gc.auto=0`: no pruning starts in the middle of a team's work.
//
// Clean and smudge filters (git-lfs) still run: a checkout without them is not the project.
//
// The runner never throws for a command that fails: it answers `{ ok, status, stdout, stderr }` and the caller
// decides. It throws TeamGitError only when git itself cannot be started.

import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { gitRead, withGitFallback } from '../git-read.js';

export class TeamGitError extends Error {
  /** @param {string} code @param {string} message @param {object} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TeamGitError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Commands that only ask: they go through lib/git-read.js. */
const READ_COMMANDS = new Set([
  'rev-parse', 'rev-list', 'status', 'diff', 'log', 'show', 'ls-files', 'for-each-ref', 'show-ref', 'symbolic-ref',
  'merge-base', 'cat-file', 'check-ignore', 'check-ref-format', 'cherry', 'config', 'merge-tree', 'ls-tree', 'diff-tree',
  'name-rev', 'describe',
]);
/** Sub-commands that make a read command a write. */
const isRead = (args) => {
  const [command, ...rest] = args;
  if (!READ_COMMANDS.has(command)) return command === 'worktree' && rest[0] === 'list';
  // `symbolic-ref HEAD` asks; with a second name, -d or -m it writes.
  if (command === 'symbolic-ref') return !rest.some((arg) => arg === '-d' || arg === '--delete' || arg === '-m') && rest.filter((arg) => !arg.startsWith('-')).length <= 1;
  if (command === 'config') return rest.some((arg) => /^(?:--get|--get-all|--get-regexp|--list|-l)$/.test(arg));
  return true;
};

const WRITE_OPTIONS = Object.freeze([
  '--no-pager',
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'log.showSignature=false',
  '-c', 'rerere.enabled=false',
  '-c', 'merge.autoStash=false',
  '-c', 'gc.auto=0',
  '-c', 'advice.detachedHead=false',
]);

/** What every team command's environment adds. */
export const TEAM_GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
  LC_ALL: 'C',
});

/** The environment variables of the calling process that would aim git somewhere else: never passed on. */
const AIMING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX'];

function baseEnv(env) {
  const out = { ...env };
  for (const name of AIMING_ENV) delete out[name];
  return out;
}

/**
 * The git runner a team uses.
 *
 * @param {object} [options]
 * @param {string} [options.binary]     the git program (default `git`, found on PATH; SynaBun's own copy on a
 *                                      Windows PC without one, through lib/git-read.js)
 * @param {object} [options.env]        the environment to start from (default: this process's)
 * @param {number} [options.timeoutMs]  per command (default 2 minutes)
 * @param {number} [options.maxBuffer]  per stream (default 64 MB)
 * @param {(entry: object) => void} [options.onCommand]  told every command and its answer (tests, a log)
 * @returns {(args: string[], options?: { cwd: string, input?: string, env?: object, timeoutMs?: number }) =>
 *   Promise<{ ok: boolean, status: number, stdout: string, stderr: string }>}
 */
export function createGitRunner({ binary = 'git', env = process.env, timeoutMs = 120_000, maxBuffer = 64 * 1024 * 1024, onCommand = null } = {}) {
  const started = baseEnv(env);
  return async function git(args, { cwd, input = null, env: extra = null, timeoutMs: limit = timeoutMs } = {}) {
    if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== 'string')) throw new TeamGitError('GIT_ARGUMENTS', 'A git command is a list of text arguments.');
    if (typeof cwd !== 'string' || !cwd) throw new TeamGitError('GIT_FOLDER', 'A git command needs the folder it runs in.');
    let argv;
    let childEnv;
    if (isRead(args)) {
      const read = await gitRead(cwd, args, { binary, env: { ...started, ...(extra || {}) } });
      argv = read.args;
      childEnv = { ...read.env, LC_ALL: 'C', GIT_EDITOR: 'true' };
    } else {
      argv = [...WRITE_OPTIONS, ...args];
      childEnv = withGitFallback({ ...started, ...TEAM_GIT_ENV, ...(extra || {}) });
    }
    const result = await new Promise((done, fail) => {
      let child;
      try {
        child = execFile(binary, argv, { cwd, env: childEnv, timeout: limit, maxBuffer, windowsHide: true, shell: false, encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            if (error.code === 'ENOENT') { fail(new TeamGitError('GIT_UNAVAILABLE', `git could not be started (${binary}): ${error.message}`)); return; }
            // Killed by the timeout or by a signal, or its output was too long: a failed command, with why.
            done({ ok: false, status: -1, stdout: String(stdout || ''), stderr: `${String(stderr || '')}${error.killed ? `\ngit ${args[0]} was stopped after ${limit} ms.` : `\n${error.message}`}`.trim() });
            return;
          }
          const status = error ? error.code : 0;
          done({ ok: status === 0, status, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
      } catch (error) {
        fail(new TeamGitError('GIT_UNAVAILABLE', `git could not be started (${binary}): ${error.message}`));
        return;
      }
      if (input !== null && input !== undefined) child.stdin?.end(input);
      else child.stdin?.end();
    });
    if (typeof onCommand === 'function') {
      try { onCommand({ cwd, args, status: result.status }); } catch { /* a listener's failure is not the command's */ }
    }
    return result;
  };
}

// ── Reading git's answers ───────────────────────────────────────────────────

/** The first line of a command's output, trimmed; '' when it failed. */
export const line = (result) => (result && result.ok ? result.stdout.split('\n')[0].trim() : '');

/** A NUL-separated list (`-z`) as its items. */
export const nulList = (text) => String(text || '').split('\0').filter((item) => item.length > 0);

/** What a failed command said, in one line, for a report. */
export function gitSaid(result) {
  const text = `${result?.stderr || ''}\n${result?.stdout || ''}`.split('\n').map((each) => each.trim()).filter(Boolean);
  return (text.find((each) => /^(?:fatal|error):/i.test(each)) || text[0] || `git exited with ${result?.status}`).slice(0, 400);
}

/** How much of a failed command's output a report carries at most (gitOutput). */
export const GIT_OUTPUT_MAX = 4096;

/**
 * Everything a failed command said, every line (stderr, then stdout), for a report a person reads: git's own words
 * often run over several lines ("The following paths are ignored…", then the paths, then a hint), and the first
 * line alone does not say which. Longer than `max`: its beginning and its end, with a note of what was left out.
 */
export function gitOutput(result, max = GIT_OUTPUT_MAX) {
  const text = [result?.stderr, result?.stdout].map((each) => String(each || '').replace(/\r\n?/g, '\n').trim()).filter(Boolean).join('\n');
  if (!text) return `git exited with ${result?.status}`;
  if (text.length <= max) return text;
  const tail = Math.floor(max / 4);
  const head = Math.max(0, max - tail - 64);
  return `${text.slice(0, head)}\n… ${text.length - head - tail} characters left out …\n${text.slice(-tail)}`;
}

/**
 * `git ls-files -s -z` as a map from each path to its index entries, each as git printed it
 * (`<mode> <object> <stage>\t<path>`): one entry for a path at stage 0, up to three for an unmerged one. These are
 * the lines `git update-index --index-info` takes back.
 */
export function parseIndexEntries(text) {
  const out = new Map();
  for (const item of nulList(text)) {
    const tab = item.indexOf('\t');
    if (tab < 0 || !/^\d+ [0-9a-f]+ [0-3]$/.test(item.slice(0, tab))) continue;
    const path = item.slice(tab + 1);
    if (!out.has(path)) out.set(path, []);
    out.get(path).push(item);
  }
  return out;
}

/**
 * `git worktree list --porcelain` as entries: `{ path, head, branch, detached, bare, locked, prunable }`. `branch`
 * is the short name (`synabun/team/slice`), null for a detached or bare entry.
 */
export function parseWorktreeList(text) {
  const out = [];
  let entry = null;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) { if (entry) out.push(entry); entry = null; continue; }
    const at = raw.indexOf(' ');
    const key = at < 0 ? raw : raw.slice(0, at);
    const value = at < 0 ? '' : raw.slice(at + 1);
    if (key === 'worktree') { if (entry) out.push(entry); entry = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }; continue; }
    if (!entry) continue;
    if (key === 'HEAD') entry.head = value;
    else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') entry.detached = true;
    else if (key === 'bare') entry.bare = true;
    else if (key === 'locked') entry.locked = true;
    else if (key === 'prunable') entry.prunable = true;
  }
  if (entry) out.push(entry);
  return out;
}

/**
 * `git status --porcelain=v1 -z` as entries `{ path, index, worktree, from? }`. A rename or a copy carries the path
 * it came from; both paths count as changed. `??` is an untracked file, `!!` an ignored one.
 */
export function parseStatus(text) {
  const items = String(text || '').split('\0');
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.length < 4) continue;
    const entry = { index: item[0], worktree: item[1], path: item.slice(3) };
    if (entry.index === 'R' || entry.index === 'C' || entry.worktree === 'R' || entry.worktree === 'C') { entry.from = items[i + 1] || null; i += 1; }
    out.push(entry);
  }
  return out;
}

/** `git diff --name-status -z --no-renames` as entries `{ status, path }`. */
export function parseNameStatus(text) {
  const items = String(text || '').split('\0');
  const out = [];
  for (let i = 0; i + 1 < items.length; i += 2) {
    if (!items[i]) break;
    out.push({ status: items[i][0], path: items[i + 1] });
  }
  return out;
}

/** A promise chain per key: what is run under one key runs one at a time, in the order it was asked. */
export function createLocks() {
  const tails = new Map();
  return {
    /** @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>} */
    run(key, fn) {
      const before = tails.get(key) || Promise.resolve();
      const mine = before.then(fn, fn);
      const tail = mine.then(() => {}, () => {});
      tails.set(key, tail);
      tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return mine;
    },
    /** How many keys have something running or waiting. */
    size: () => tails.size,
  };
}

// ── Who commits ─────────────────────────────────────────────────────────────

/** The name SynaBun commits under in a repository that has no identity of its own. */
export const FALLBACK_IDENTITY = Object.freeze({ name: 'SynaBun Agents', email: 'agents@synabun.invalid' });

/**
 * The environment a commit of SynaBun's is made with. The repository's own identity (user.name / user.email, as
 * the user's commits have it) when it has one; `identity` when the caller names one; FALLBACK_IDENTITY for a
 * repository without any, where git would refuse to commit.
 * @param {Function} git @param {string} cwd @param {{ name?: string, email?: string }|null} [identity]
 */
export async function identityEnv(git, cwd, identity = null) {
  const named = (who) => ({ GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });
  if (identity && typeof identity.name === 'string' && identity.name && typeof identity.email === 'string' && identity.email) return named(identity);
  const name = line(await git(['config', '--get', 'user.name'], { cwd }));
  const email = line(await git(['config', '--get', 'user.email'], { cwd }));
  if (name && email) return {};
  return named({ name: name || FALLBACK_IDENTITY.name, email: email || FALLBACK_IDENTITY.email });
}

/** Which operations a checkout is in the middle of: `{ merge, cherryPick, revert, rebase, bisect, any }`. */
export async function operationsUnderWay(git, cwd, { exists }) {
  // One question to git (where this checkout keeps its own state), then the markers git leaves there.
  const dir = line(await git(['rev-parse', '--absolute-git-dir'], { cwd }));
  const at = (name) => !!dir && exists(`${dir}/${name}`);
  const out = {
    merge: at('MERGE_HEAD'), cherryPick: at('CHERRY_PICK_HEAD') || at('sequencer'), revert: at('REVERT_HEAD'),
    rebase: at('rebase-merge') || at('rebase-apply'), bisect: at('BISECT_LOG'),
  };
  out.any = out.merge || out.cherryPick || out.revert || out.rebase || out.bisect;
  return out;
}

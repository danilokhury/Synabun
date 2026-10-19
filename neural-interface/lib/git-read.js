// ═══════════════════════════════════════════
// SynaBun — git, for a read
// ═══════════════════════════════════════════
//
// A repository's own configuration can name programs, and git starts them for
// commands that only read. `git status` in a folder runs what that folder's
// `core.fsmonitor` names; `git diff` runs its external diff and textconv
// drivers; `git log` runs `gpg.program` when `log.showSignature` is on; a
// partial clone fetches a missing object through whatever its remote names
// (`uploadpack`, an `ext::` address, a credential helper); an index that a read
// refreshes runs the `post-index-change` hook. The routes that read (the
// status, the log, the changes, the committed version of a file) take the
// folder from the request, and a folder may hold a repository somebody else
// prepared: for a read none of those programs is started.
//
// gitRead() / gitReadSync() give the arguments and the environment one read is
// run with (runGitReadSync() runs one, for a caller without a runner of its
// own). What they switch off, and by what:
//
//   core.fsmonitor     `-c core.fsmonitor=false` when the repository names a
//                      program there. When its value is a boolean, git's own
//                      (built-in) monitor is kept as it is set: a large
//                      repository stays fast. The repository is asked once
//                      (`git config --type=bool --get core.fsmonitor`, which
//                      runs nothing) and the answer is remembered for a few
//                      seconds; the value is always given on the command
//                      line, so what the file says later does not matter.
//   hooks              `-c core.hooksPath=<the null device>`: no hook of the
//                      repository is found (post-index-change is the one a
//                      read reaches).
//   optional locks     GIT_OPTIONAL_LOCKS=0: `git status` takes no index lock
//                      and writes no index. (`git diff` still refreshes the
//                      index's file times for a file that was only touched:
//                      git does not put that under this setting. Nothing is
//                      started for it: the hook an index write has is one of
//                      the hooks above.)
//   external diff,     `--no-ext-diff --no-textconv` on diff, show and log
//   textconv           (diff.external, diff.<driver>.command, .textconv).
//   signatures         `-c log.showSignature=false`: gpg.program is not asked.
//   fetching           GIT_NO_LAZY_FETCH=1, and GIT_ALLOW_PROTOCOL set and
//                      empty: no transport is allowed, so nothing a remote
//                      names is started (uploadpack, ext::, ssh, a credential
//                      helper, a proxy command). A read never needs a remote.
//   a pager, a prompt  `--no-pager`, GIT_TERMINAL_PROMPT=0.
//
// The options given with `-c` reach the git that git starts inside a submodule
// as well: a submodule's own configuration is under the same rule.
//
// What is NOT switched off: clean and process filters (`filter.<driver>.clean`,
// `filter.<driver>.process`, for the files `.gitattributes` gives that driver).
// git reads a working-tree file through its filter to compare it with the
// index: `git diff` against the working tree for every such file it looks at,
// `git status` for one whose time changed while its size did not. Without the
// filter the comparison is wrong for every repository that uses one on purpose
// (git-lfs, git-crypt), so it stays. Smudge filters are not run by a read.
//
// Writes are not run through here: a commit by the owner runs the
// repository's hooks, and that is what a commit does.
//
// On a Windows PC without git, SynaBun's own copy of Git for Windows
// (lib/git-bash/) is the git of every read: its folder is put at the end of
// the read's PATH (setGitFallbackFolder, withGitFallback, which the commit
// routes use too). Nothing changes where the computer has a git of its own.

import { execFile, spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { delimiter } from 'node:path';

/** What the environment of a read adds. */
export const GIT_READ_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
  GIT_TERMINAL_PROMPT: '0',
});

/** Commands that take diff options. */
const DIFF_COMMANDS = new Set(['diff', 'show', 'log']);
/** Commands that compare the index with the working tree: the file system monitor is asked by these. */
const INDEX_COMMANDS = new Set(['status', 'diff', 'ls-files']);

const PROBE = ['config', '--type=bool', '--get', 'core.fsmonitor'];
const PROBE_TIMEOUT_MS = 3000;
export const MONITOR_MEMO_MS = 10_000;
const MONITOR_MEMO_MAX = 200;

let fallbackFolder = () => null;

/**
 * Where SynaBun's own git is on a computer that has none (Windows: the cmd folder of SynaBun's copy of Git for
 * Windows, lib/git-bash/manager.js), as a function asked at every start; null while git is the computer's own.
 * The folder goes at the end of PATH, so a git of the computer's, installed meanwhile, still comes first.
 */
export function setGitFallbackFolder(folder) {
  fallbackFolder = typeof folder === 'function' ? folder : () => null;
}

/** `env` with the fallback folder at the end of its PATH (whatever its spelling), or `env` itself without one. */
export function withGitFallback(env = process.env) {
  let folder = null;
  try { folder = fallbackFolder(); } catch { folder = null; }
  if (!folder) return env;
  const keys = Object.keys(env).filter((name) => name.toUpperCase() === 'PATH');
  const name = keys[0] || (process.platform === 'win32' ? 'Path' : 'PATH');
  const parts = String(env[name] || '').split(delimiter).filter(Boolean);
  if (parts.some((part) => part.toLowerCase() === folder.toLowerCase())) return env;
  const out = { ...env };
  for (const each of keys) delete out[each];
  out[name] = [...parts, folder].join(delimiter);
  return out;
}

/** The environment a read is run in: `env` and what a read adds to it (and SynaBun's git, where the computer has none). */
export function gitReadEnv(env = process.env) {
  return withGitFallback({ ...env, ...GIT_READ_ENV });
}

/** Does this command compare the index with the working tree (and so ask the file system monitor)? */
export function readsIndex(args) {
  return Array.isArray(args) && INDEX_COMMANDS.has(args[0]);
}

/**
 * The arguments of one read: git's own options first, then the command with what switches its external programs
 * off, then the caller's own arguments unchanged.
 * @param {string[]} args the command and its arguments, the command first (['status', '--porcelain'])
 * @param {{ monitor?: boolean }} [o] `monitor`: the repository has git's built-in file system monitor switched on
 */
export function gitReadArgs(args, { monitor = false } = {}) {
  const [command, ...rest] = Array.isArray(args) ? args : [];
  const own = [
    '--no-pager',
    '-c', `core.fsmonitor=${monitor === true ? 'true' : 'false'}`,
    '-c', `core.hooksPath=${devNull}`,
    '-c', 'log.showSignature=false',
  ];
  if (command === undefined) return own;
  return [...own, command, ...(DIFF_COMMANDS.has(command) ? ['--no-ext-diff', '--no-textconv'] : []), ...rest];
}

/**
 * What is remembered of the repositories that were asked for their monitor: per folder, for a few seconds, for at
 * most so many folders. Whatever is remembered, a read is given a boolean on its command line: a stale answer
 * can keep git's own monitor on or off for a moment, it can never let a program through.
 */
export function createMonitorMemo({ ttlMs = MONITOR_MEMO_MS, max = MONITOR_MEMO_MAX, now = Date.now } = {}) {
  const known = new Map();   // folder → { on, at }, the one asked longest ago first
  return {
    get(cwd) {
      const entry = known.get(cwd);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) { known.delete(cwd); return undefined; }
      return entry.on;
    },
    set(cwd, on) {
      known.delete(cwd);
      known.set(cwd, { on: on === true, at: now() });
      while (known.size > max) known.delete(known.keys().next().value);
      return on === true;
    },
    size: () => known.size,
  };
}

const memo = createMonitorMemo();
// The question itself: no value is given for core.fsmonitor here (the command line's would be the answer), and
// `git config` reads no index, so it asks no monitor.
const probeArgs = () => ['--no-pager', '-c', `core.hooksPath=${devNull}`, ...PROBE];
// "true" and nothing else: unset (exit 1), a program's path (exit 128: not a boolean), false, no git, a timeout.
const saysOn = (status, stdout) => status === 0 && String(stdout || '').trim() === 'true';

/**
 * Is git's built-in file system monitor switched on for the repository `cwd` is in? False for every other answer:
 * not set, a program's path, no repository, no git.
 * @param {string} cwd
 * @param {{ binary?: string, env?: object, remembered?: ReturnType<typeof createMonitorMemo> }} [o]
 * @returns {Promise<boolean>}
 */
export function builtInMonitor(cwd, { binary = 'git', env = process.env, remembered = memo } = {}) {
  const known = remembered.get(cwd);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((done) => {
    try {
      execFile(binary, probeArgs(), { cwd, env: gitReadEnv(env), timeout: PROBE_TIMEOUT_MS, windowsHide: true, shell: false, encoding: 'utf8' }, (error, stdout) => {
        done(remembered.set(cwd, saysOn(error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout)));
      });
    } catch {
      done(remembered.set(cwd, false));
    }
  });
}

/** builtInMonitor, for a caller that runs git synchronously. */
export function builtInMonitorSync(cwd, { binary = 'git', env = process.env, remembered = memo, spawn = spawnSync } = {}) {
  const known = remembered.get(cwd);
  if (known !== undefined) return known;
  let on = false;
  try {
    const result = spawn(binary, probeArgs(), { cwd, env: gitReadEnv(env), timeout: PROBE_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    on = !result.error && saysOn(result.status, result.stdout);
  } catch { on = false; }
  return remembered.set(cwd, on);
}

/**
 * How to run one read in `cwd`: `{ args, env }` for the program `git`. The repository is asked for its monitor
 * only for a command that compares the index with the working tree.
 * @param {string} cwd
 * @param {string[]} args the command first
 * @param {{ binary?: string, env?: object, remembered?: object }} [o]
 * @returns {Promise<{ args: string[], env: object }>}
 */
export async function gitRead(cwd, args, o = {}) {
  const monitor = readsIndex(args) ? await builtInMonitor(cwd, o) : false;
  return { args: gitReadArgs(args, { monitor }), env: gitReadEnv(o.env) };
}

/** gitRead, for a caller that runs git synchronously. */
export function gitReadSync(cwd, args, o = {}) {
  const monitor = readsIndex(args) ? builtInMonitorSync(cwd, o) : false;
  return { args: gitReadArgs(args, { monitor }), env: gitReadEnv(o.env) };
}

/**
 * One read, run now, for a caller that has no runner of its own: what spawnSync answers.
 * @param {string} cwd
 * @param {string[]} args the command first
 * @param {object} [options] spawnSync's (`encoding`, `timeout`, `maxBuffer`, …); `cwd` and what a read adds to
 *   the environment are not the caller's to change
 */
export function runGitReadSync(cwd, args, options = {}) {
  const read = gitReadSync(cwd, args, { env: options.env });
  return spawnSync('git', read.args, { windowsHide: true, ...options, cwd, env: read.env });
}

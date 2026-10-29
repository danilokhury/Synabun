// ── The OS sandbox of an evaluation's shell (P4, macOS) ──
// A task case that asks for a shell (`shell: true`) runs untrusted skill text with a real shell. Every command of that
// shell, and nothing else, runs under a Seatbelt profile of its own (evalShellProfile), through a small wrapper the
// runtime is told to use for its commands: Claude Code's CLAUDE_CODE_SHELL_PREFIX (its Bash tool and any hook command
// go through it), OpenCode's SHELL (its bash tool runs `$SHELL -c <command>`). The runtime itself stays outside, with
// its own sign-in; its shell, inside, has:
//
//   network   none at all: SynaBun's ports, local servers and the internet alike (the deny is `network*`)
//   writes    its job folder, its own temp, home and git folders, the terminal devices; inside the job folder, the
//             folders and files a runtime reads its settings, skills or code from (.claude, .opencode, .git,
//             opencode.json, … ss-evals.js EVAL_CONFIG_DIRS / EVAL_CONFIG_FILES, any letter case, a folder at any
//             depth) stay as SynaBun wrote them. No symlink can be created in any writable place (the last file-write
//             rule denies vnode-type SYMLINK): a shell step is the only thing that could plant or repoint a job-folder
//             symlink, and that link is the one way the (unsandboxed) eval read tool could be steered outside the folder
//             between its permission ask and its open — removing it is what makes the ask-time realpath check race-free
//   git       a repository of its own beside the job folder, never in it: GIT_DIR is the trial's git folder and
//             GIT_WORK_TREE the job folder, so `git init`, `add`, `commit`, `log`, `diff`, `branch` and `checkout` work on
//             the folder's files while no `.git` (a folder, or a `gitdir:` file) can be made anywhere in it. The runtime
//             outside runs git in the job folder too (Claude Code's status, OpenCode's project and snapshot reads):
//             there is no repository there to read, and that side's git takes no bare repository it was not pointed at
//             and reads no global or system configuration (lib/skills/eval-confinement.js evalGitSafetyEnv), so nothing
//             a command writes is read by it. A commit's identity is the trial home's .gitconfig (a test may set its own)
//   reads     nothing under /Users (every home folder), /Volumes, SynaBun's data home, /private/tmp or
//             /private/var/folders (other programs' temp files), except the job folder, its own temp, home and git
//             folders, the folders on PATH and a few language toolchains (runtimes, no settings), and Claude Code's
//             shell snapshot (its shell setup, which every one of its commands sources first)
//   others    a signal only to a process of its own sandbox (`kill -0` of any other process is refused); no launchd job
//             (`job-creation` is denied: `launchctl submit` is refused, while `launchctl print` still reads); no Apple
//             event (`appleevent-send` is denied: a real event, to System Events, fails with -4960, while
//             `osascript -e 1` still runs, because it sends none); no lookup of the Mach services that hold the user's
//             data or start programs outside it (EVAL_SHELL_MACH_DENY: a keychain read and pbcopy / pbpaste were seen
//             to fail; LaunchServices, the window server, screen capture and TCC are denied by name)
//   env       a short allowlist (locale, terminal, PATH and what the runtime's own command line needs): no token,
//             key or password of the runtime's environment reaches a command; HOME and TMPDIR are the trial's own, and
//             git's variables are the wrapper's (none of the runtime's)
//
// The `others` line is what the P4 verification saw. tests/skills-p4-eval-sandbox.test.mjs repeats the signal, keychain
// and launchd checks (a job its `launchctl submit` did make would be removed at once, and the test would fail); it
// sends no Apple event and asks no screen or app service again, since one that got through would act on the owner's
// session (a TCC prompt, an app started).
// Seatbelt is last-match-wins and matches resolved paths (lib/worker-sandbox.js: canonicalPath), so every path here is
// canonical and every allow comes after the deny it opens. This module only builds and writes; whether sandbox-exec
// works is lib/worker-sandbox.js sandboxExecAvailable(). A shell that cannot be set up this way is not given: the run
// fails closed (lib/skills/evals.js, server.js).

import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { SANDBOX_EXEC, canonicalPath, sandboxExecAvailable, sandboxSupported } from '../worker-sandbox.js';
import { EVAL_CONFIG_DIRS, EVAL_CONFIG_FILES } from '../../public/shared/skills/ss-evals.js';

/** Part of an evaluation's confinement version: a change to what an evaluation's shell may do is a new one. */
export const EVAL_SHELL_VERSION = 'skill-eval-shell/3';

/** Mach services an evaluation's shell never reaches (the keychain, the clipboard, apps, the screen). */
export const EVAL_SHELL_MACH_DENY = Object.freeze([
  ['global-name', 'com.apple.SecurityServer'], ['global-name', 'com.apple.securityd'], ['global-name', 'com.apple.securityd.xpc'],
  ['global-name', 'com.apple.security.agent'], ['global-name', 'com.apple.security.authhost'], ['global-name', 'com.apple.pasteboard.1'],
  ['global-name-prefix', 'com.apple.coreservices.launchservicesd'], ['global-name-prefix', 'com.apple.lsd.'],
  ['global-name', 'com.apple.windowserver.active'], ['global-name-prefix', 'com.apple.screencapture'], ['global-name', 'com.apple.tccd'],
]);

/** Folders under a home that hold language runtimes only: readable from an evaluation's shell when present. */
export const EVAL_SHELL_TOOLCHAINS = Object.freeze([
  '.nvm/versions', '.volta/tools/image', '.fnm/node-versions', '.local/share/fnm/node-versions', '.pyenv/versions', '.rbenv/versions',
  '.rustup/toolchains', '.asdf/installs', '.local/share/mise/installs', '.bun/bin', '.deno/bin',
]);

/** What of the runtime's environment a command keeps (everything else, its tokens and keys among it, is left out). */
export const EVAL_SHELL_ENV_KEEP = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'COLUMNS', 'LINES', 'USER', 'LOGNAME', 'TZ', 'SHLVL',
  // Claude Code's command line reads these (it sets BUN_OPTIONS from the first, and refuses to run without it).
  '__CLAUDE_CC_BUN_OPTIONS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
]);

/** The identity of a commit a shell step makes, in the trial home's .gitconfig (its lowest place: a test's own wins). */
export const EVAL_SHELL_GIT_IDENTITY = Object.freeze({ name: 'SynaBun evaluation', email: 'evaluation@synabun.invalid' });

const SHELLS = Object.freeze({ zsh: { path: '/bin/zsh', args: ['-f'] }, bash: { path: '/bin/bash', args: ['--noprofile', '--norc'] }, sh: { path: '/bin/sh', args: [] } });

/** Whether an evaluation's shell can be held here: macOS with a working sandbox-exec. */
export function evalShellSupported({ platform = process.platform, probe = sandboxExecAvailable } = {}) {
  return sandboxSupported(platform) && probe({ platform }) === true;
}

/** A Seatbelt string literal. */
function lit(text) { return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
/**
 * Text as a Seatbelt regular expression that matches it and nothing else. A #"…" literal is raw (a backslash is not an
 * escape there), so ASCII punctuation goes in a bracket ([.] is a dot); letters, digits and other characters stay as
 * they are. A path holding a quote, a backslash or a control character cannot be named this way: refused.
 */
function regexText(text) {
  let out = '';
  for (const c of String(text)) {
    if (c === '"' || c === '\\' || /[\u0000-\u001f\u007f]/.test(c)) throw new Error('The evaluation folder\'s path has a character the sandbox cannot name.');
    if (/[A-Za-z0-9_/ -]/.test(c) || c.charCodeAt(0) > 0x7f) out += c;
    else if (c === ']') out += '[]]';
    else if (c === '^') out += '[*^]';
    else out += `[${c}]`;
  }
  return out;
}
/** A Seatbelt regular expression literal (#"…", raw). */
const rx = (source) => `#"${source}"`;
/** A name for a regex in any letter case ([cC][lL]…), every other character as itself. */
function anyCase(name) { return [...String(name)].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : regexText(c))).join(''); }
/** The deepest existing ancestor resolved, and absolute: what Seatbelt sees. */
const canon = (p) => canonicalPath(isAbsolute(String(p)) ? String(p) : join(process.cwd(), String(p)));
const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * The directory nodes on the way to each allowed path that fall in a denied tree: `stat` of those nodes only (a
 * literal, never their contents), so a command can resolve its way into the job folder without listing a home.
 */
function metadataAncestors(allows, denies) {
  const out = new Set();
  for (const allow of allows) {
    for (let dir = dirname(allow), i = 0; i < 256; i++) {
      if (denies.some((d) => inside(dir, d))) out.add(dir);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return [...out].sort();
}

/**
 * The profile of one evaluation's shell.
 * @param {object} o
 * @param {string} o.root the job folder (the run's cwd)
 * @param {string} o.temp the trial's own temp folder
 * @param {string} o.home the trial's own home folder (HOME of every command)
 * @param {string} o.git the trial's own git folder (GIT_DIR of every command: the repository of the job folder's files)
 * @param {string[]} [o.denyReadTrees] trees nothing is read from (the home folders, SynaBun's data home, …), on top of
 *   /Users, /Volumes, /private/tmp and /private/var/folders
 * @param {string[]} [o.readOnly] paths read back after the denies (PATH folders, toolchains, Claude Code's snapshots)
 * @param {string} [o.note] a comment line
 * @returns {string}
 */
export function evalShellProfile({ root, temp, home, git, denyReadTrees = [], readOnly = [], note = '' } = {}) {
  if (!root || !temp || !home || !git) throw new Error('An evaluation shell profile needs its job, temp, home and git folders.');
  const job = canon(root);
  const tmp = canon(temp);
  const own = canon(home);
  const repo = canon(git);
  if (inside(repo, job) || inside(job, repo)) throw new Error('An evaluation shell\'s git folder is beside its job folder, never in it or around it.');
  const denies = [...new Set(['/Users', '/Volumes', '/private/tmp', '/private/var/folders', ...denyReadTrees.filter(Boolean).map(canon)])];
  const reads = [...new Set(readOnly.filter(Boolean).map(canon))].filter((p) => p !== '/' && !inside(job, p));
  const lines = ['(version 1)', `; synabun ${EVAL_SHELL_VERSION}${note ? `: ${String(note).replace(/[\r\n]+/g, ' ').slice(0, 200)}` : ''}`, '(allow default)'];
  lines.push('; no network at all (SynaBun, local servers, the internet)');
  lines.push('(deny network*)');
  lines.push('; a signal only to a process of this sandbox; no launchd job (launchctl submit refused); no Apple event sent');
  lines.push('(deny signal)', '(allow signal (target same-sandbox))', '(deny job-creation)', '(deny appleevent-send)');
  lines.push('; the keychain, the clipboard, LaunchServices, the window server, screen capture and TCC, by service name');
  lines.push(`(deny mach-lookup ${EVAL_SHELL_MACH_DENY.map(([kind, name]) => `(${kind} ${lit(name)})`).join(' ')})`);
  lines.push('; writes: the job folder, the trial\'s temp, home and git folders, the terminal devices');
  lines.push('(deny file-write*)');
  lines.push(`(allow file-write* (subpath ${lit(job)}) (subpath ${lit(tmp)}) (subpath ${lit(own)}) (subpath ${lit(repo)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/[0-9]+$"))`);
  lines.push('; the folders (at any depth: .git among them, so no repository is ever made here) and top files a runtime reads its settings or code from stay as SynaBun wrote them (any letter case)');
  const base = regexText(job);
  const dirRules = Object.keys(EVAL_CONFIG_DIRS).map((name) => `(regex ${rx(`^${base}/(.+/)?${anyCase(name)}(/|$)`)})`);
  const fileRules = Object.keys(EVAL_CONFIG_FILES).map((name) => `(regex ${rx(`^${base}/${anyCase(name)}$`)})`);
  lines.push(`(deny file-write* ${[...dirRules, ...fileRules].join(' ')})`);
  lines.push('; reads: no home folder, other volume, other temp files or SynaBun data');
  lines.push(`(deny file-read* ${denies.map((d) => `(subpath ${lit(d)})`).join(' ')})`);
  lines.push('; read back: the job folder, the trial\'s temp, home and git folders, the tools on PATH and the runtime\'s shell setup');
  lines.push(`(allow file-read* (subpath ${lit(job)}) (subpath ${lit(tmp)}) (subpath ${lit(own)}) (subpath ${lit(repo)})${reads.map((p) => ` (subpath ${lit(p)})`).join('')})`);
  // Apple's command-line tool shims (git, python3 from the Command Line Tools) keep an SDK lookup cache in the user's
  // temp folder whatever TMPDIR says: that one file name only.
  lines.push('(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))');
  // No symlink may be created in any writable place (last of the file-write rules, so it wins over every allow above,
  // xcrun_db included). A symlink is the one way a shell step of a trial could repoint a path inside the job folder at
  // a file OUTSIDE it between the read tool's permission ask (evalOpenCodeDecision, which resolves the real path and
  // refuses one leaving the folder) and the tool's open — a TOCTOU the ask alone cannot close, because the eval read
  // tool runs in the runtime's own process, not under this sandbox, so SynaBun cannot bind the path it finally opens.
  // The job folder is created fresh with no symlink, SynaBun's skill copy follows none, and Write/Edit make plain files
  // only, so the shell is the sole writer that could introduce one; deny it here and no symlink can ever exist in the
  // folder, which is what makes the ask-time realpath check race-free. Regular writes, mkdir, rename (mv) and hardlinks
  // to in-folder files are untouched; a hardlink to an outside file already fails (its lookup needs a read the denies
  // above refuse). Verified on macOS 26 (scratch probes, 2026-10-25): ln -s / ln -sf are refused, mv and mkdir work.
  lines.push('(deny file-write* (vnode-type SYMLINK))');
  const ancestors = metadataAncestors([job, tmp, own, repo, ...reads], denies);
  if (ancestors.length) lines.push(`(allow file-read-metadata ${ancestors.map((d) => `(literal ${lit(d)})`).join(' ')})`);
  return `${lines.join('\n')}\n`;
}

/**
 * The folders of a trial an evaluation's shell uses: the job folder, and beside it its temp, home, git (the repository
 * of the job folder's files, GIT_DIR) and sandbox folders.
 */
export function evalShellPaths(cwd) {
  const root = realpathSync(String(cwd || ''));
  const trialDir = dirname(root);
  return { root, trialDir, temp: join(trialDir, 'tmp'), home: join(trialDir, 'home'), git: join(trialDir, 'git'), dir: join(trialDir, 'sandbox') };
}

/** The real shell a command runs in (the runtime's shell's family: Claude Code's snapshot is written for it). */
export function evalInnerShell(shell = process.env.SHELL) {
  const name = basename(String(shell || '')).toLowerCase();
  return name === 'bash' ? 'bash' : name === 'sh' ? 'sh' : 'zsh';
}

/**
 * The wrapper one command goes through. Claude Code calls it as `wrapper '<command>'` (its shell prefix), OpenCode as
 * `wrapper -c '<command>'` (its shell); `-l`/`-i` before `-c` are let go. Anything else is refused (exit 126). Its git
 * works on the job folder's files from the trial's git folder (GIT_DIR, GIT_WORK_TREE), never looks above the trial's
 * folder for another repository and reads no system configuration; the global one is the trial home's.
 */
export function evalShellWrapper({ profilePath, shell = 'zsh', home, temp, root, git }) {
  if (!root || !git) throw new Error('An evaluation shell\'s wrapper needs its job and git folders.');
  const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const inner = SHELLS[shell] || SHELLS.zsh;
  const keep = EVAL_SHELL_ENV_KEEP.map((name) => `\${${name}+"${name}=$${name}"}`).join(' ');
  const gitEnv = `GIT_DIR=${sh(git)} GIT_WORK_TREE=${sh(root)} GIT_CEILING_DIRECTORIES=${sh(dirname(root))} GIT_CONFIG_NOSYSTEM=1`;
  return [
    '#!/bin/sh',
    `# SynaBun (${EVAL_SHELL_VERSION}): one command of a skill evaluation, under the evaluation's sandbox. Written per trial.`,
    'cmd=',
    'if [ $# -eq 1 ]; then cmd=$1',
    'else',
    '  while [ $# -gt 0 ]; do',
    '    case "$1" in',
    '      -c|-lc|-cl|-ic|-ci|-ilc|-lic) shift; cmd=${1-}; break ;;',
    '      -l|-i|--login|--interactive|--noprofile|--norc) shift ;;',
    '      *) break ;;',
    '    esac',
    '  done',
    'fi',
    'if [ -z "$cmd" ]; then echo "synabun: an evaluation shell runs one command (-c)." >&2; exit 126; fi',
    `exec /usr/bin/env -i ${keep} HOME=${sh(home)} TMPDIR=${sh(`${temp}/`)} CLAUDE_CODE_TMPDIR=${sh(temp)} SHELL=${sh(inner.path)} ${gitEnv} ${sh(SANDBOX_EXEC)} -f ${sh(profilePath)} ${sh(inner.path)}${inner.args.map((a) => ` ${a}`).join('')} -c "$cmd"`,
    '',
  ].join('\n');
}

/** The folders on PATH that sit in a denied tree, and the toolchains under each home: read back for the shell. */
export function evalShellReadPaths({ path = process.env.PATH, homes = [], claudeConfigDir = null } = {}) {
  const out = new Set();
  for (const dir of String(path || '').split(':')) if (dir && isAbsolute(dir) && existsSync(dir)) out.add(canon(dir));
  for (const h of homes.filter(Boolean)) for (const rel of EVAL_SHELL_TOOLCHAINS) { const p = join(h, rel); if (existsSync(p)) out.add(canon(p)); }
  if (claudeConfigDir) out.add(canon(join(claudeConfigDir, 'shell-snapshots')));
  return [...out];
}

/** The trial home's .gitconfig: a commit's identity (EVAL_SHELL_GIT_IDENTITY) and git's default-branch hint off. */
export function evalShellGitConfig() {
  return [
    `# SynaBun (${EVAL_SHELL_VERSION}): git's settings for a skill evaluation's shell. Written per trial.`,
    '[user]', `\tname = ${EVAL_SHELL_GIT_IDENTITY.name}`, `\temail = ${EVAL_SHELL_GIT_IDENTITY.email}`,
    '[advice]', '\tdefaultBranchName = false', '',
  ].join('\n');
}

/**
 * Set up one trial's shell: its temp, home and git folders (the home with its .gitconfig), its profile and its wrapper
 * (in the trial's own sandbox folder, outside the job folder, so nothing the shell does can change them).
 * → { wrapperPath, profilePath, shell, env, paths }
 * `env` is what the runtime gets (TMPDIR and CLAUDE_CODE_TMPDIR: its own temp files go into the trial's).
 * @param {object} o
 * @param {string} o.cwd the job folder
 * @param {string[]} [o.denyReadTrees] SynaBun's data home, the home folders
 * @param {string[]} [o.readOnly] evalShellReadPaths()
 * @param {string} [o.shell] the runtime's shell (its family is the inner shell)
 * @param {string} [o.wrapperName] the wrapper's file name (OpenCode accepts a shell by its name: zsh, bash or sh)
 */
export function prepareEvalShell({ cwd, denyReadTrees = [], readOnly = [], shell = process.env.SHELL, wrapperName = null, note = '' } = {}) {
  const paths = evalShellPaths(cwd);
  for (const dir of [paths.temp, paths.home, paths.git, paths.dir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.home, '.gitconfig'), evalShellGitConfig(), { mode: 0o600 });
  const inner = evalInnerShell(shell);
  const profile = evalShellProfile({ root: paths.root, temp: paths.temp, home: paths.home, git: paths.git, denyReadTrees, readOnly, note });
  const profilePath = join(paths.dir, 'shell.sb');
  writeFileSync(profilePath, profile, { mode: 0o600 });
  const name = wrapperName && /^(?:zsh|bash|sh)$/.test(wrapperName) ? wrapperName : inner;
  const wrapperPath = join(paths.dir, name);
  writeFileSync(wrapperPath, evalShellWrapper({ profilePath, shell: inner, home: canon(paths.home), temp: canon(paths.temp), root: paths.root, git: canon(paths.git) }), { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  return { wrapperPath, profilePath, shell: inner, paths, env: { TMPDIR: `${canon(paths.temp)}/`, CLAUDE_CODE_TMPDIR: canon(paths.temp) } };
}

// ═══════════════════════════════════════════
// SynaBun — Worker confinement: what a dispatched worker's capability means, on every provider (pure)
// ═══════════════════════════════════════════
//
// The Assistant's dispatcher (lib/assistant-dispatch.js) starts a worker with a capability:
//
//   full        the worker may touch anything the user can (unchanged: no guard, the explicit escape hatch)
//   workspace   file writes inside the run's working directory, the OS temp folder and the run's own scratch
//               folder only; never into ~/.claude, ~/.codex, ~/.agents, ~/.config/opencode, ~/.synabun, another
//               project or a dotfile outside the working directory. The shell stays usable but guarded.
//   read-only   no file writes at all, and a shell limited to read-only commands.
//
// Until now only Codex enforced this (its sandbox). This module is the one description of the rule, and each
// provider's adapter (lib/native-loop-providers.js) enforces it the way that provider can:
//
//   Claude Code   a PreToolUse hook on every tool call (subagents' included), which Claude Code runs before any
//                 permission mode: Write / Edit / MultiEdit / NotebookEdit by the path they name, Bash by reading
//                 the command line (workerShellDecision), memory and browser tools untouched. The run keeps
//                 bypassPermissions, so nothing waits for an answer: a refused call fails with the reason.
//   Codex         its sandbox: read-only, or workspace-write with the working directory (and Codex's own temp
//                 folders) as the writable roots and no parent folder. The shell is sandboxed by the OS.
//   OpenCode      permission rules in the run's own config (edit denied under read-only; bash and work outside the
//                 working directory asked) and an adapter that answers each ask by this policy, never "always".
//
// The shell heuristic reads the command line only. It sees redirections, the writing programs it knows (cp, mv,
// rm, ln, tee, sed -i, git -C, a global npm install…) and the paths they name; it resolves `cd`, `~`, $HOME and
// $TMPDIR, and follows a link to where it really points. It does not see what a program does on its own (a
// script, `node x.js`, `make`, a test runner), a path hidden in a variable it cannot read, or a write inside an
// awk / python / perl program: those run under workspace and are refused under read-only, where only a known
// read-only program runs. Codex's sandbox and OpenCode's rules are the stronger layer where they apply.
//
// The setting (lib/worker-guard-setting.js; Settings → Automations → Automation behavior → Protect workers):
//   enforce   (default) a call outside the capability is refused, with the reason in the run's transcript
//   warn      the same calls are allowed, each noted in the transcript as a warning
//   off       today's behaviour before this guard: Claude's read-only tool list, Codex's sandbox with the parent
//             folder, OpenCode answering "always"
// Capability "full" is never guarded whatever the setting.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const WORKER_GUARD_MODES = Object.freeze(['enforce', 'warn', 'off']);
export const WORKER_GUARD_DEFAULT = 'enforce';
export const WORKER_CONFINEMENT = 'worker';
/** The capabilities the guard applies to (never 'full'). */
export const GUARDED_CAPABILITIES = Object.freeze(['read-only', 'workspace']);
/** Folders under the home a worker must never write into (documented; the rule itself is "outside the writable roots"). */
export const PROTECTED_HOME_DIRS = Object.freeze(['.claude', '.codex', '.agents', '.config/opencode', '.synabun', '.local/share/opencode', '.ssh', '.gnupg', '.aws', '.config']);

export function normalizeWorkerGuardMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return WORKER_GUARD_MODES.includes(text) ? text : WORKER_GUARD_DEFAULT;
}

const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// A third-party MCP tool whose name says it changes something (under read-only).
const MCP_WRITE_VERB = /(?:^|[_-])(?:write|edit|create|delete|remove|move|rename|upload|insert|update|execute|exec|run|apply|push|deploy|send|post|put|patch|set|add|append|truncate|drop|commit|publish|install|uninstall|kill|restart|start|stop)(?:[_-]|$)|^(?:write|edit|create|delete|remove|move|rename|upload|insert|update|execute|apply|push|deploy|send|post|put|patch|set|add|append|truncate|drop|commit|publish|install|uninstall|kill|restart|start|stop)[A-Z]/i;

// ── Paths ───────────────────────────────────────────────────────────────────

/** `root` holds `target` (both absolute, normalized); allowRoot: the root itself counts. */
function inside(root, target, allowRoot = true) {
  if (!root || !target) return false;
  if (target === root) return allowRoot;
  const base = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(base);
}

/** Where a path really is: the deepest existing ancestor resolved through its links, the rest as named. */
export function realPlace(abs) {
  let probe = abs;
  const rest = [];
  for (let i = 0; i < 512; i++) {
    try {
      const real = realpathSync(probe);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return abs;
      rest.push(probe.slice(parent.length).replace(/^[\\/]+/, ''));
      probe = parent;
    }
  }
  return abs;
}

/** A glob tail (`build/*`, `logs/**`) is checked by its fixed head. */
function fixedHead(text) {
  const parts = String(text).split(/[\\/]+/);
  const kept = [];
  for (const part of parts) {
    if (/[*?[\]]/.test(part)) break;
    kept.push(part);
  }
  if (kept.length === parts.length) return text;
  return kept.length ? kept.join('/') : '.';
}

/** A placeholder directory name standing in for the fresh folder `mktemp -d` would make, under the real temp root. */
const MKTEMP_DIR = '.synabun-mktemp';

/**
 * The variables the guard can resolve with confidence: the well-known environment ones (the shell always has them,
 * and the guard sees the same user and machine as the worker). An arbitrary environment variable is deliberately
 * left out — the guard sees the server's environment, not the worker's exact one, so its value is not guaranteed;
 * such a `$VAR` stays unknown and is refused, as before. The line's own assignments (tracked by shellSegments) are
 * resolved separately and layered on top, because they come from the command itself and are therefore certain.
 */
function knownEnv(cwd, home, env) {
  const e = env || {};
  const temp = e.TMPDIR || e.TMP || e.TEMP || tmpdir();
  const known = { HOME: home, PWD: cwd, TMPDIR: e.TMPDIR || temp, TMP: e.TMP || temp, TEMP: e.TEMP || temp };
  if (e.USER) known.USER = e.USER;
  if (e.LOGNAME) known.LOGNAME = e.LOGNAME;
  return known;
}

/**
 * Expand `$VAR` / `${VAR}` and a leading `~` in a value, from `known` (the well-known env) with `vars` (what the
 * line assigned) layered on top. Returns the expanded string, or null when a `$…` is left unresolved (an unknown
 * variable, an arithmetic `$((…))`, a `$1`, or a command substitution the caller did not resolve) or a `~user`.
 */
function expandText(text, known, vars, home) {
  if (typeof text !== 'string') return null;
  let unknown = false;
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a || b;
    if (vars && Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (Object.prototype.hasOwnProperty.call(known, name)) return known[name];
    unknown = true;
    return m;
  });
  if (unknown || /\$/.test(out)) return null; // a `$` left over (another substitution, arithmetic, a positional)
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) return home + out.slice(1);
  if (out.startsWith('~')) return null; // ~user: not resolved (conservative; refused as unknown)
  return out;
}

/**
 * The directory `$(mktemp …)` / `` `mktemp …` `` would create a fresh entry in, as an absolute path under the real
 * temp root (resolved through its links), with a placeholder final segment standing in for the random name. null
 * for anything that is not a plain `mktemp` call. The base is the temp root, except `-p DIR` / `--tmpdir=DIR` or a
 * template operand with a directory part, which the real mktemp would honour (and which the allowed-roots check
 * then validates: a base outside the writable roots becomes a refusal, never a pass).
 */
function mktempBase(innerCmd, { cwd, home, env, vars }) {
  const toks = String(innerCmd).trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"]|['"]$/g, ''));
  if (!toks.length || toks[0].replace(/^.*\//, '') !== 'mktemp') return null;
  const known = knownEnv(cwd, home, env);
  const temp = known.TMPDIR;
  let base = temp;
  for (let i = 1; i < toks.length; i++) {
    const w = toks[i];
    if (w === '-p' || w === '--tmpdir') { const d = toks[i + 1]; if (d && !d.startsWith('-')) { base = d; i++; } else base = temp; }
    else if (w.startsWith('--tmpdir=')) base = w.slice('--tmpdir='.length) || temp;
    else if (w === '-t') { i++; base = temp; } // a prefix template (not a directory): mktemp uses TMPDIR
    else if (w.startsWith('-')) { /* -d, -u, -q, -V and the like: no directory */ }
    else base = w.includes('/') ? dirname(w) : cwd; // a template operand: mktemp makes it relative to cwd unless --tmpdir
  }
  const expanded = expandText(base, known, vars, home);
  if (expanded === null) return null;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  return join(realPlace(abs), MKTEMP_DIR);
}

/**
 * The value a `NAME=value` assignment resolves to (a string a later `$NAME` expands to), or null when it cannot be
 * known. A literal (with `$VAR` / `~` of what is already known) resolves; `NAME=$(mktemp …)` / backticks resolve to
 * a fresh folder under the temp root; every other command substitution, arithmetic or unknown variable stays null.
 */
function assignValue(afterEq, subs, { cwd, home, env, vars }) {
  if (!subs || !subs.length) return expandText(afterEq, knownEnv(cwd, home, env), vars, home);
  if (afterEq === '' && subs.length === 1) return mktempBase(subs[0], { cwd, home, env, vars });
  return null;
}

/**
 * A path a worker named, as an absolute location, or null when it cannot be read as one (a control character, an
 * unknown $variable, a command substitution). `~`, the well-known environment variables and the variables the
 * command line assigned before this point (`vars`, from shellSegments) are expanded.
 */
export function placeOf(raw, { cwd, home = homedir(), env = process.env, vars = null } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let text = expandText(raw, knownEnv(cwd, home, env), vars, home);
  if (text === null) return null;
  text = fixedHead(text);
  const abs = isAbsolute(text) ? resolve(text) : resolve(cwd, text);
  return realPlace(abs);
}

// ── The confinement ─────────────────────────────────────────────────────────

/**
 * What a run's capability means for it: null when nothing is guarded (capability full, or the guard off).
 * Throws when the working directory cannot be resolved (the run must not start on a guess).
 * @param {object} o
 * @param {string} o.capability 'read-only' | 'workspace' | 'full'
 * @param {string} o.cwd the run's working directory
 * @param {string} [o.mode] the setting: 'enforce' (default) | 'warn' | 'off'
 * @param {string} [o.scratchDir] the run's own scratch folder, writable too
 * @param {string[]} [o.tmpDirs] the OS temp folders (os.tmpdir() and /tmp by default)
 * @param {number} [o.serverPort] SynaBun's own port
 * @param {number[]} [o.localPorts] other local ports of SynaBun's the shell may not call (the run's own OpenCode serve)
 * @param {{ from:number, to:number }} [o.localPortRange] the ports SynaBun keeps for its OpenCode serves (4096-4400),
 *   the same band the macOS sandbox denies (lib/worker-sandbox.js)
 */
export function resolveWorkerConfinement({ capability, cwd, mode = WORKER_GUARD_DEFAULT, scratchDir = null, tmpDirs = null, home = homedir(), serverPort = null, localPorts = null, localPortRange = null } = {}) {
  const cap = String(capability || 'full');
  const guard = normalizeWorkerGuardMode(mode);
  if (!GUARDED_CAPABILITIES.includes(cap) || guard === 'off') return null;
  // A guarded run is rooted where the dispatcher put it, never where the server happens to run: without a working
  // directory its scratch folder is the only writable root, and without either it does not start.
  const rootDir = cwd && typeof cwd === 'string' ? cwd : (scratchDir && typeof scratchDir === 'string' ? scratchDir : null);
  if (!rootDir) throw new Error('A guarded worker needs a working directory (or a scratch folder of its own): the run did not start.');
  // The working directory where it really is; one that is not there yet (a stand-in in a test, a folder made
  // later) is kept as named: the rule still holds by its name, and realPlace() resolves what exists at each call.
  let root;
  try { root = realpathSync(rootDir); } catch { root = resolve(rootDir); }
  const temps = Array.isArray(tmpDirs) ? tmpDirs : [tmpdir(), '/tmp'];
  const writable = [root];
  for (const dir of [...temps, scratchDir].filter(Boolean)) {
    try { const real = realpathSync(dir); if (!writable.includes(real)) writable.push(real); } catch { /* a folder that is not there is not writable */ }
  }
  return Object.freeze({
    kind: WORKER_CONFINEMENT, capability: cap, mode: guard, enforced: guard === 'enforce',
    cwd: root, writable: Object.freeze(writable), home, serverPort: Number(serverPort) || null,
    localPorts: Object.freeze([...new Set((Array.isArray(localPorts) ? localPorts : []).map(Number).filter(validPort))]),
    localPortRange: portRange(localPortRange),
    protectedDirs: Object.freeze(PROTECTED_HOME_DIRS.map((d) => join(home, d))),
  });
}

const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
function portRange(range) {
  const from = Number(range?.from);
  const to = Number(range?.to);
  return validPort(from) && validPort(to) && from <= to ? Object.freeze({ from, to }) : null;
}

/**
 * Which of SynaBun's own local services a loopback port is, under this confinement: 'server' (SynaBun's own port),
 * 'serve' (the run's own OpenCode serve), 'reserved' (the band SynaBun keeps for its OpenCode serves), else null.
 */
export function controlPortOf(port, confinement) {
  const p = Number(port);
  if (!confinement || !validPort(p)) return null;
  if (p === Number(confinement.serverPort)) return 'server';
  if ((confinement.localPorts || []).includes(p)) return 'serve';
  const range = confinement.localPortRange;
  if (range && p >= range.from && p <= range.to) return 'reserved';
  return null;
}

function controlPortText(kind, host, port, confinement) {
  if (kind === 'server') return `${host}:${port} is SynaBun's own server`;
  if (kind === 'serve') return `${host}:${port} is this run's own OpenCode server`;
  const r = confinement.localPortRange;
  return `${host}:${port} is in the ports SynaBun keeps for its own OpenCode servers (${r.from}-${r.to})`;
}

const DEVICE_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd/1', '/dev/fd/2']);

/** Whether a resolved location may be written under this confinement (a device such as /dev/null always may). */
export function mayWrite(place, confinement) {
  if (!place || !confinement) return false;
  if (DEVICE_PATHS.has(place)) return true;
  return confinement.writable.some((root) => inside(root, place, true));
}

const rootsText = (c) => c.writable.map((r) => r === c.cwd ? `${r} (your working directory)` : r).join(', ');

// What the worker can do to make an unresolvable write target pass: say it plainly in the refusal so the run does
// not keep retrying the same shape. Variables the guard knows (a literal path, `$TMPDIR`, `$HOME`, `$PWD`, or a
// `D=$(mktemp -d)` the line set) resolve; anything else (another command substitution, an unknown variable) does not.
const passHint = (c) => `Write to a literal path, or under a variable the command sets itself (a literal, $TMPDIR, $HOME, $PWD, or D=$(mktemp -d)); this run writes inside ${rootsText(c)} only.`;

/** A refusal: { reason, rule, target? }. */
function refusal(rule, reason, target = null) {
  return target ? { rule, reason, target } : { rule, reason };
}

/**
 * Whether a worker may make this (non-shell) tool call: null when it may, else a refusal the worker reads.
 * Claude Code's built-in tools by name; MCP tools pass except a commit under read-only.
 */
export function workerToolDecision(toolName, input, confinement) {
  if (!confinement) return null;
  try {
    const name = String(toolName || '');
    const args = input && typeof input === 'object' ? input : {};
    if (name === 'Bash' || name === 'PowerShell') return workerShellDecision(args.command, confinement);
    if (CLAUDE_WRITE_TOOLS.has(name)) {
      if (confinement.capability === 'read-only') return refusal('read-only', `This run has capability read-only: ${name} is not available. Report what you found instead of changing files; a run that must edit needs capability workspace.`);
      const raw = typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : null;
      const place = raw ? placeOf(raw, { cwd: confinement.cwd, home: confinement.home }) : null;
      if (!place) return refusal('unknown-path', `${name} needs a plain path: SynaBun could not read "${String(raw || '').slice(0, 200)}". This run writes inside ${rootsText(confinement)} only.`);
      if (!mayWrite(place, confinement)) return refusal('write-outside', `${name} to ${place} is outside this run's workspace. This run (capability workspace) writes inside ${rootsText(confinement)} only; nothing is written under the home folder, another project or a tool's configuration.`, place);
      return null;
    }
    if (/^mcp__SynaBun__git$/.test(name) && confinement.capability === 'read-only' && String(args.action || '') === 'commit') {
      return refusal('read-only', 'This run has capability read-only: the git tool\'s commit action is not available.');
    }
    // Another MCP server's tool under read-only: one whose name says it writes is refused (SynaBun's own tools go
    // through SynaBun's own policies and stay; a third-party server's writes are its own and cannot be confined).
    const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
    if (mcp && confinement.capability === 'read-only' && mcp[1] !== 'SynaBun' && MCP_WRITE_VERB.test(mcp[2])) {
      return refusal('read-only', `This run has capability read-only: ${name} (a tool of the ${mcp[1]} server whose name says it writes) is not available. Read with that server's read tools, or report what should change.`);
    }
    return null;
  } catch (err) {
    return refusal('check-failed', `The call could not be checked (${err?.message || err}), so it is refused.`);
  }
}

// ── The shell heuristic ─────────────────────────────────────────────────────

// Programs that only read (with the options that would make them write or run something: refused). The
// read-only plan-mode classifier's table (lib/assistant-plan-permissions.js) widened for a worker's inspection.
const READ_PROGRAMS = new Map([
  ['ls', []], ['pwd', []], ['cat', []], ['head', []], ['tail', []], ['wc', []], ['stat', []], ['du', []], ['df', []],
  ['tree', ['-o', '-R']], ['file', []], ['date', []], ['uname', []], ['id', []], ['whoami', []], ['hostname', []], ['uptime', []],
  ['env', []], ['printenv', []], ['echo', []], ['printf', []], ['true', []], ['false', []], ['test', []], ['[', []], ['type', []], ['command', []],
  ['grep', []], ['egrep', []], ['fgrep', []], ['rg', ['--pre', '--pre-glob', '--hostname-bin']], ['ag', []], ['ugrep', []],
  ['fd', ['-x', '--exec', '-X', '--exec-batch']], ['fdfind', ['-x', '--exec', '-X', '--exec-batch']],
  ['find', ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']],
  ['which', []], ['whereis', []], ['basename', []], ['dirname', []], ['realpath', []], ['readlink', []],
  ['diff', []], ['cmp', []], ['comm', []], ['sort', ['-o', '--output', '-T', '--temporary-directory', '--compress-program']], ['uniq', []],
  ['cut', []], ['tr', []], ['tac', []], ['nl', []], ['column', []], ['fold', []], ['paste', []], ['rev', []], ['expand', []],
  ['jq', []], ['yq', ['-i', '--inplace']], ['xxd', ['-r']], ['od', []], ['hexdump', []], ['strings', []],
  ['md5', []], ['md5sum', []], ['shasum', []], ['sha1sum', []], ['sha256sum', []], ['cksum', []],
  ['sed', ['-i', '-I', '--in-place', '-f', '--file']], ['awk', ['-f', '--file']], ['gawk', ['-f', '--file']], ['mawk', ['-f']],
  ['less', []], ['more', []], ['ps', []], ['sleep', []], ['seq', []], ['bc', []], ['expr', []],
  ['curl', ['-o', '--output', '-O', '--remote-name', '--remote-name-all', '-J', '--remote-header-name', '--create-dirs', '--output-dir', '-D', '--dump-header', '-c', '--cookie-jar', '--trace', '--trace-ascii', '--trace-config', '-K', '--config', '--libcurl', '--etag-save', '--hsts', '--alt-svc', '--stderr', '-T', '--upload-file']],
  ['python', ['-m', '-c']], ['python3', ['-m', '-c']], ['node', ['-e', '--eval', '-p', '--print', '-r', '--require', '--import', '-i']],
  ['npm', []], ['npx', []], ['pnpm', []], ['yarn', []], ['vitest', []],
]);
// A program above whose arguments must match one of these shapes to count as a read (`cwd`: the run's working
// directory; `inside(path)` tells whether a path argument is under it).
const READ_SHAPES = new Map([
  ['python', (args) => args[0] === '--version' || args[0] === '-V'],
  ['python3', (args) => args[0] === '--version' || args[0] === '-V'],
  // node: its version, a syntax check, or the project's own tests / scripts under cwd (item 10 below).
  ['node', (args, { inside }) => args[0] === '--version' || args[0] === '-v'
    || ((args[0] === '--check' || args[0] === '-c') && args.length === 2)
    || (args[0] === '--test' && args.slice(1).filter((w) => !isOption(w)).every((w) => inside(w)))
    || (args.length >= 1 && !isOption(args[0]) && /\.(?:m?js|cjs)$/.test(args[0]) && /(^|\/)(?:scripts|tests?|test)\//.test(args[0]) && inside(args[0]))],
  ['npm', (args) => ['ls', 'list', 'view', 'info', 'show', 'outdated', 'audit', 'why', 'explain', '--version', '-v', 'help', 'ping', 'search', 'test', 't'].includes(args[0]) && !args.includes('fix')
    || (args[0] === 'run' && /^test(?::|$)/.test(String(args[1] || '')))],
  ['npx', (args) => args[0] === 'vitest' && !args.slice(1).some((w) => /^(?:-u|--update|--coverage|--reporter=(?:json|junit|html)|--outputFile)/.test(w))],
  ['vitest', (args) => !args.some((w) => /^(?:-u|--update|--coverage|--outputFile)/.test(w))],
  ['pnpm', (args) => ['ls', 'list', 'why', 'outdated', 'audit', '--version', '-v', 'test', 't'].includes(args[0]) && !args.includes('fix')],
  ['yarn', (args) => ['list', 'why', 'info', '--version', '-v', 'outdated', 'audit', 'test'].includes(args[0])],
  ['uniq', (args) => args.filter((w) => !isOption(w)).length <= 1],
  ['sed', (args) => !args.filter((w) => !isOption(w)).some((w) => /(^|[;\n{}\s])\s*[wWe](\s|$)|\/[gpImMx0-9]*[wWe][gpImMx0-9]*(\s|;|$)/.test(w))],
  ['awk', (args) => !args.some((w) => /[>|]|system\s*\(|getline|fflush\s*\(\s*"/.test(w))],
  ['gawk', (args) => !args.some((w) => /[>|]|system\s*\(|getline/.test(w))],
  ['mawk', (args) => !args.some((w) => /[>|]|system\s*\(|getline/.test(w))],
  ['curl', (args) => curlShape(args)],
]);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'shortlog', 'describe', 'cat-file', 'merge-base', 'show-ref', 'rev-list', 'diff-tree', 'name-rev', 'for-each-ref', 'count-objects', 'check-ignore', 'var', 'version', '--version']);
const GIT_READ_WITH_ARGS = new Map([
  ['branch', (a) => a.every((w) => /^(-a|-r|-v|-vv|--list|--all|--remotes|--verbose|--show-current|--contains|--merged|--no-merged|--format=.*|--sort=.*)$/.test(w) || !w.startsWith('-') && a.some((x) => /^(--list|--contains|--merged|--no-merged)$/.test(x)))],
  ['remote', (a) => a.length === 0 || a[0] === '-v' || a[0] === 'show' || a[0] === 'get-url'],
  ['tag', (a) => a.length === 0 || a.every((w) => /^(-l|--list|-n\d*|--contains|--merged|--sort=.*|--format=.*)$/.test(w) || !w.startsWith('-'))],
  ['stash', (a) => a[0] === 'list' || a[0] === 'show'],
  ['config', (a) => a.some((w) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(w)) && !a.some((w) => /^(--global|--system|--file|-f|--unset|--add|--replace-all|--edit|-e)$/.test(w))],
  ['worktree', (a) => a[0] === 'list'],
  ['submodule', (a) => a[0] === 'status'],
]);
// Options of a git read that write a file or run a program (abbreviated long options too).
const GIT_BLOCKED = ['--output', '--ext-diff', '--open-files-in-pager', '-O', '--textconv'];
// `git <sub>` that writes the repository (anything not read is taken as writing).
const GIT_GLOBAL_WRITE_OPTIONS = ['--global', '--system'];

// Programs that write the paths they are given (every path-like word is checked), or that write somewhere
// known. `dest`: only the destination words (the last non-option word, or -t DIR) are checked.
const WRITERS = new Map([
  ['rm', 'all'], ['rmdir', 'all'], ['unlink', 'all'], ['shred', 'all'], ['truncate', 'all'], ['touch', 'all'], ['mkdir', 'all'],
  ['mkfifo', 'all'], ['mknod', 'all'], ['chmod', 'all'], ['chown', 'all'], ['chgrp', 'all'], ['chflags', 'all'], ['xattr', 'all'], ['setfacl', 'all'],
  ['cp', 'dest'], ['mv', 'all'], ['install', 'dest'], ['rsync', 'dest'], ['scp', 'dest'], ['ln', 'dest'],
  ['tee', 'all'], ['dd', 'dd'], ['patch', 'patch'], ['tar', 'tar'], ['unzip', 'unzip'], ['zip', 'zip'],
  ['sed', 'sed'], ['perl', 'perl'], ['wget', 'wget'], ['curl', 'curl'], ['git', 'git'],
  ['npm', 'pkg'], ['pnpm', 'pkg'], ['yarn', 'pkg'], ['pip', 'pip'], ['pip3', 'pip'], ['brew', 'brew'], ['gem', 'gem'], ['cargo', 'cargo'],
  ['defaults', 'defaults'], ['crontab', 'crontab'], ['launchctl', 'launchctl'], ['find', 'find'], ['fd', 'fd'], ['fdfind', 'fd'],
  ['uniq', 'uniq'], ['sort', 'sort'], ['awk', 'awk'], ['gawk', 'awk'], ['mawk', 'awk'],
]);
const FIND_WRITES = ['-delete', '-fprint', '-fprint0', '-fprintf', '-fls'];
const FIND_EXEC = ['-exec', '-execdir', '-ok', '-okdir'];
const FD_EXEC = /^(-x|--exec|-X|--exec-batch)$/;
const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'pkexec']);
const WRAPPERS = new Set(['env', 'nice', 'nohup', 'time', 'timeout', 'gtimeout', 'command', 'builtin', 'exec', 'caffeinate', 'stdbuf', 'xargs', 'arch']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
// Interpreters that read their program from standard input when given none: fed from a pipe or a file they
// cannot be checked, so they are refused.
const INTERPRETERS = new Set(['node', 'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'deno', 'bun', 'osascript', 'lua', 'tclsh']);
// Shell keywords that may open a segment (`for … ; do touch x; done`): taken off the front, the command follows.
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time']);
const LONE_KEYWORDS = new Set(['done', 'fi', 'esac', '}', 'else', 'then', 'do', ';;']);
// Programs that talk to a network address (a URL or host:port argument): kept off loopback where the rule says so.
const NET_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie', 'nc', 'ncat', 'netcat', 'telnet', 'websocat', 'wscat', 'ab', 'hey', 'siege']);

/**
 * A command line → its simple commands, each { words, redirects: [{ op, target }], cwd, piped, stdin, vars },
 * following `cd`, `(` `)`, `$( )` and backticks; null when it cannot be read (a control character, an unbalanced
 * quote). Quotes are stripped from words (a quoted path is still a path), the word keeps a `quoted` mark. `piped`:
 * the command reads what the one before wrote; `stdin`: it reads a file (`<`), a here-document or a here-string.
 * `vars`: the shell variables this segment can resolve — the ones the line assigned before it (a literal, `$HOME`,
 * or `$(mktemp -d)`). An assignment persists only where bash keeps it (a standalone `VAR=…`, an `export`/`declare`/
 * `readonly`/`typeset`/`local`, never a `VAR=… cmd` prefix) and never leaks out of a subshell or a pipeline.
 */
export function shellSegments(command, { cwd, home = homedir(), env = process.env, seedVars = null } = {}) {
  const text = String(command ?? '');
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return null;
  const segments = [];
  const cwdStack = [];
  let here = cwd;
  let words = [];
  let word = '';
  let quoted = false;
  let hasWord = false;
  let wordSubs = []; // command substitutions seen while building the current word (for `VAR=$(…)`)
  let redirectNext = null; // the operator text waiting for its target
  let pendingRedirects = [];
  let piped = false;
  let nextPiped = false;
  let stdin = false;
  let subshellDepth = 0; // inside `( … )`: an assignment there does not leak out
  const assigned = { ...(seedVars || {}) }; // the resolved variables in effect for the next segment
  let i = 0;
  const finishWord = () => {
    if (!hasWord && !word && !wordSubs.length) return;
    if (redirectNext !== null) { pendingRedirects.push({ op: redirectNext, target: word, quoted }); redirectNext = null; }
    else words.push({ text: word, quoted, subs: wordSubs });
    word = ''; quoted = false; hasWord = false; wordSubs = [];
  };
  // The assignments `VAR=val` carries, read off a word (unquoted `NAME=` head): { name, afterEq, subs }.
  const assignOf = (w) => { const eq = w.text.indexOf('='); return { name: w.text.slice(0, eq), afterEq: w.text.slice(eq + 1), subs: w.subs || [] }; };
  const isAssign = (w) => w && !w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);
  const finishSegment = () => {
    finishWord();
    if (redirectNext !== null) { pendingRedirects.push({ op: redirectNext, target: '', quoted: false }); redirectNext = null; }
    if (words.length || pendingRedirects.length) {
      // `VAR=value` prefixes and leading keywords are stripped so the program is the first word.
      const wl = words.slice();
      const prefixAssigns = [];
      for (;;) {
        if (wl.length && isAssign(wl[0])) { prefixAssigns.push(assignOf(wl[0])); wl.shift(); continue; }
        if (wl.length && !wl[0].quoted && LEADING_KEYWORDS.has(wl[0].text)) { wl.shift(); continue; }
        break;
      }
      let list = wl.map((w) => w.text);
      let marks = wl.map((w) => w.quoted);
      if (list.length === 1 && !marks[0] && LONE_KEYWORDS.has(list[0])) { list = []; marks = []; }
      // `vars` is the state before this segment: the command's own prefix assignments do not affect its own
      // expansion (bash sets them only in the command's environment), so they are folded in only afterwards.
      const seg = { words: list, quoted: marks, redirects: pendingRedirects, cwd: here, piped, stdin, vars: { ...assigned } };
      segments.push(seg);
      // Which assignments persist for a later segment: a standalone `VAR=…` (no program), or the names an
      // `export` / `declare` / `readonly` / `typeset` / `local` sets. Nothing inside a subshell (`subshellDepth`)
      // or a pipeline segment (`piped` reads from the previous, `nextPiped` writes to the next) leaks out.
      const topLevel = subshellDepth === 0 && !piped && !nextPiped;
      const program = list[0];
      const exportLike = program === 'export' || program === 'declare' || program === 'readonly' || program === 'typeset' || program === 'local';
      const persist = !program ? prefixAssigns : exportLike ? wl.slice(1).filter(isAssign).map(assignOf) : [];
      if (topLevel) for (const a of persist) {
        const value = assignValue(a.afterEq, a.subs, { cwd: here, home, env, vars: assigned });
        if (value === null) delete assigned[a.name]; // becomes unknown: forget any earlier value (conservative)
        else assigned[a.name] = value;
      }
      // `cd X` moves what follows (also behind `command` / `builtin`, which run the same built-in).
      const cdAt = (list[0] === 'command' || list[0] === 'builtin') && (list[1] === 'cd' || list[1] === 'pushd') ? 1 : (list[0] === 'cd' || list[0] === 'pushd') ? 0 : -1;
      if (cdAt >= 0) {
        const target = list[cdAt + 1];
        if (!target || target === '-') here = cwd;
        else here = placeOf(target, { cwd: here, home, env, vars: seg.vars }) || null;
      }
    }
    words = []; pendingRedirects = []; piped = nextPiped; nextPiped = false; stdin = false;
  };
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") { quote = null; } else word += ch; i++; continue; }
    if (quote === '"') {
      if (ch === '"') { quote = null; i++; continue; }
      if (ch === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) { word += text[i + 1]; i += 2; continue; }
      if (ch === '$' && text[i + 1] === '(') { // a substitution inside quotes: its words are their own segment
        const end = matching(text, i + 1, '(', ')');
        if (end < 0) return null;
        const innerText = text.slice(i + 2, end);
        const inner = shellSegments(innerText, { cwd: here, home, env, seedVars: assigned });
        if (!inner) return null;
        segments.push(...inner);
        wordSubs.push(innerText); hasWord = true; i = end + 1; continue;
      }
      if (ch === '`') {
        const end = text.indexOf('`', i + 1);
        if (end < 0) return null;
        const innerText = text.slice(i + 1, end);
        const inner = shellSegments(innerText, { cwd: here, home, env, seedVars: assigned });
        if (!inner) return null;
        segments.push(...inner);
        wordSubs.push(innerText); hasWord = true; i = end + 1; continue;
      }
      word += ch; i++; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; hasWord = true; i++; continue; }
    if (ch === '\\') { if (i + 1 < text.length) { word += text[i + 1]; hasWord = true; i += 2; } else i++; continue; }
    if (ch === '#' && !word && !hasWord) { // a comment to the end of the line
      const end = text.indexOf('\n', i);
      if (end < 0) break;
      i = end; continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const end = matching(text, i + 1, '(', ')');
      if (end < 0) return null;
      const innerText = text.slice(i + 2, end);
      const inner = shellSegments(innerText, { cwd: here, home, env, seedVars: assigned });
      if (!inner) return null;
      segments.push(...inner);
      wordSubs.push(innerText); hasWord = true; i = end + 1; continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) return null;
      const innerText = text.slice(i + 1, end);
      const inner = shellSegments(innerText, { cwd: here, home, env, seedVars: assigned });
      if (!inner) return null;
      segments.push(...inner);
      wordSubs.push(innerText); hasWord = true; i = end + 1; continue;
    }
    if ((ch === '<' || ch === '>') && text[i + 1] === '(') { // process substitution: its own segment
      const end = matching(text, i + 1, '(', ')');
      if (end < 0) return null;
      const inner = shellSegments(text.slice(i + 2, end), { cwd: here, home, env, seedVars: assigned });
      if (!inner) return null;
      segments.push(...inner);
      hasWord = true; i = end + 1; continue;
    }
    if (ch === '(') { finishSegment(); cwdStack.push(here); subshellDepth++; i++; continue; }
    if (ch === ')') { finishSegment(); here = cwdStack.length ? cwdStack.pop() : here; if (subshellDepth > 0) subshellDepth--; i++; continue; }
    // `{ …; }` groups: a standalone brace only (`{}` of xargs and `${VAR}` are words)
    if (ch === '{' && !word && !hasWord && /\s/.test(text[i + 1] || '')) { i++; continue; }
    if (ch === '}' && !word && !hasWord && (i === 0 || /[\s;]/.test(text[i - 1])) && (i + 1 >= text.length || /[\s;&|)]/.test(text[i + 1]))) { finishSegment(); i++; continue; }
    if (ch === '\n' || ch === ';') { finishSegment(); i++; continue; }
    if (ch === '&' || ch === '|') { // && || | |& & (a background job)
      let op = '';
      while (i < text.length && (text[i] === '&' || text[i] === '|')) { op += text[i]; i++; }
      nextPiped = op === '|' || op === '|&';
      finishSegment();
      continue;
    }
    if (ch === '<' || ch === '>') {
      finishWord();
      // the operator: >, >>, >|, &>, &>>, 2>, 2>>, <, <<, <<<, <>, and fd dups (2>&1, >&2)
      let op = '';
      let j = i;
      while (j < text.length && '<>|&'.includes(text[j])) { op += text[j]; j++; }
      // a digit before the operator was taken as a word: `2` → part of the redirect
      if (words.length && /^\d+$/.test(words[words.length - 1].text) && !words[words.length - 1].quoted && (i === 0 || !/\s/.test(text[i - 1]))) { op = words.pop().text + op; }
      if (/&\d*$/.test(op) && (text[j] === undefined || /[\s;&|)]/.test(text[j]) || /\d/.test(text[j]))) { // a dup (2>&1, >&2): no file
        while (j < text.length && /\d/.test(text[j])) j++;
        i = j; continue;
      }
      if (op.startsWith('<<')) { // a here-doc or here-string: not a file; skip the word
        redirectNext = null;
        stdin = true;
        i = j;
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
        while (i < text.length && !/[\s;&|<>]/.test(text[i])) i++;
        continue;
      }
      if (op.includes('<') && !op.includes('>')) { // input: skip the file word
        stdin = true;
        i = j;
        while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
        while (i < text.length && !/[\s;&|<>]/.test(text[i])) i++;
        continue;
      }
      redirectNext = op; i = j;
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { finishWord(); i++; continue; }
    word += ch; hasWord = true; i++;
  }
  if (quote) return null;
  finishSegment();
  return segments;
}

function matching(text, open, a, b) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; else if (ch === '\\') i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === a) depth++;
    else if (ch === b) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function blockedFlag(word, flags) {
  return flags.some((flag) => word === flag || word.startsWith(`${flag}=`)
    || (flag.startsWith('--') && /^--[^-=]/.test(word) && flag.length > 3 && flag.startsWith(word.split('=')[0]) && word.split('=')[0].length >= 4)
    || (/^-[a-zA-Z]$/.test(flag) && /^-[a-zA-Z]/.test(word) && word.slice(1).includes(flag[1])));
}

const isOption = (w) => w.startsWith('-') && w !== '-';

/**
 * The words of a segment with wrappers (env, timeout 5, nice, xargs -I{}, arch -arm64) taken off the front:
 * { words, cwd } where `cwd` is the folder `env -C` / `--chdir` moved to (null when it cannot be read), else
 * undefined.
 */
function unwrap(words, { cwd, home, env, vars } = {}) {
  let list = words;
  let moved;
  const at = (raw) => placeOf(raw, { cwd: moved ?? cwd, home, env, vars }) || null;
  for (let guard = 0; guard < 8 && list.length; guard++) {
    const program = list[0];
    if (!WRAPPERS.has(program)) return { words: list, cwd: moved };
    let rest = list.slice(1);
    if (program === 'timeout' || program === 'gtimeout') {
      while (rest.length && rest[0].startsWith('-')) rest = rest.slice(rest[0] === '-s' || rest[0] === '-k' ? 2 : 1);
      rest = rest.slice(1); // the duration
    } else if (program === 'env') {
      // env [-i] [-u NAME] [-C DIR] [-S string] [-P path] [NAME=value]… command
      while (rest.length && (rest[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
        const flag = rest[0];
        rest = rest.slice(1);
        if (flag === '-u' || flag === '--unset' || flag === '-S' || flag === '--split-string' || flag === '-P' || flag === '--default-path') rest = rest.slice(1);
        else if (flag === '-C' || flag === '--chdir') { moved = rest[0] !== undefined ? at(rest[0]) : null; rest = rest.slice(1); }
        else if (flag.startsWith('--chdir=')) moved = at(flag.slice('--chdir='.length));
        else if (/^-[a-zA-Z]*C$/.test(flag)) { moved = rest[0] !== undefined ? at(rest[0]) : null; rest = rest.slice(1); }
        else if (/^-[a-zA-Z]*u$/.test(flag)) rest = rest.slice(1);
      }
    } else if (program === 'nice' || program === 'stdbuf' || program === 'xargs' || program === 'caffeinate' || program === 'arch') {
      while (rest.length && rest[0].startsWith('-')) {
        const flag = rest[0];
        rest = rest.slice(1);
        if (program === 'xargs' && /^-(I|L|n|P|d|s|E|a)$/.test(flag) && rest.length) rest = rest.slice(1);
        if (program === 'nice' && flag === '-n' && rest.length) rest = rest.slice(1);
        if (program === 'stdbuf' && /^-[ioe]$/.test(flag) && rest.length) rest = rest.slice(1);
        if (program === 'caffeinate' && /^-[tw]$/.test(flag) && rest.length) rest = rest.slice(1);
      }
      if (program === 'xargs') rest = rest.filter((w) => w !== '{}');
    } else if (program === 'time' || program === 'nohup' || program === 'command' || program === 'builtin' || program === 'exec') {
      while (rest.length && rest[0].startsWith('-')) rest = rest.slice(1);
    }
    list = rest;
  }
  return { words: list, cwd: moved };
}

/** `bash -c "…"` / `sh -c` / `eval` → the inner command line, or null. */
function innerCommand(words) {
  const program = words[0];
  if (program === 'eval') return words.slice(1).join(' ');
  if (SHELLS.has(program)) {
    const at = words.findIndex((w, i) => i > 0 && (w === '-c' || /^-[a-z]*c[a-z]*$/.test(w)));
    if (at > 0 && words[at + 1] !== undefined) return words[at + 1];
  }
  return null;
}

/** The destination of a copy-like command: -t DIR, else the last non-option word when two or more. */
function destinationOf(args) {
  const t = args.findIndex((w) => w === '-t' || w === '--target-directory');
  if (t >= 0 && args[t + 1]) return [args[t + 1]];
  const eq = args.find((w) => w.startsWith('--target-directory='));
  if (eq) return [eq.slice('--target-directory='.length)];
  const paths = args.filter((w) => !isOption(w));
  return paths.length >= 2 ? [paths[paths.length - 1]] : [];
}

/** curl's request shape under read-only: a GET or HEAD of a single address, nothing sent, nothing written. */
function curlShape(args) {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '-X' || w === '--request') { if (!/^(GET|HEAD)$/i.test(String(args[i + 1] || ''))) return false; i++; continue; }
    if (/^--request=/.test(w) && !/^--request=(GET|HEAD)$/i.test(w)) return false;
    if (/^-[a-zA-Z]*X$/.test(w)) { if (!/^(GET|HEAD)$/i.test(String(args[i + 1] || ''))) return false; i++; continue; }
    if (/^(-d|--data|--data-raw|--data-binary|--data-urlencode|--data-ascii|-F|--form|--form-string|--json|-T|--upload-file|-u|--user|--oauth2-bearer|--proxy-user|--netrc|-n|--netrc-file|--netrc-optional)(=|$)/.test(w)) return false;
    if (/^-[a-zA-Z]*[dFTun][a-zA-Z]*$/.test(w) && !/^-[sSLkvIi]+$/.test(w)) return false;
  }
  return true;
}

// Programs that name a host and a port as two words (`nc 127.0.0.1 4123`, `telnet localhost 4123`).
const HOST_PORT_CLIENTS = new Set(['nc', 'ncat', 'netcat', 'telnet']);

/** The network addresses a client command names (URLs, host:port words, and `host port` for nc / telnet): [{ host, port }]. */
function netTargets(args, program = '') {
  const out = [];
  for (const w of args) {
    if (isOption(w)) continue;
    const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(w);
    const authority = url ? url[1] : (/^[A-Za-z0-9.\[\]:_-]+$/.test(w) && /:\d{2,5}$/.test(w) ? w : null);
    if (!authority) continue;
    const hostPort = authority.replace(/^[^@]*@/, '');
    const m = /^\[([^\]]+)\](?::(\d+))?$|^([^:]+)(?::(\d+))?$/.exec(hostPort);
    if (!m) continue;
    const host = (m[1] || m[3] || '').toLowerCase();
    const port = Number(m[2] || m[4] || (url && /^https:/i.test(w) ? 443 : url ? 80 : 0)) || null;
    out.push({ host, port });
  }
  if (HOST_PORT_CLIENTS.has(program)) {
    const words = args.filter((w) => !isOption(w));
    for (let i = 0; i + 1 < words.length; i++) {
      if (/^\d{1,5}$/.test(words[i + 1]) && isLoopbackHost(words[i].toLowerCase().replace(/^\[|\]$/g, ''))) out.push({ host: words[i].toLowerCase(), port: Number(words[i + 1]) });
    }
  }
  return out;
}
/**
 * A host name or address of this computer's loopback: localhost (and *.localhost, a trailing dot), 127.0.0.0/8 in
 * any spelling a client accepts (dotted, 127.1, one decimal, hex or octal number), 0.0.0.0, ::1 / :: and the
 * IPv4-mapped forms (::ffff:127.0.0.1, ::ffff:7f00:1).
 */
export function isLoopbackHost(raw) {
  const host = String(raw || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '0') return true;
  if (/^127\./.test(host) || host === '127') return true;
  if (/^(?:0:){0,7}:?:?0*1$/.test(host) && host.includes(':')) return true; // ::1, 0:0:0:0:0:0:0:1
  if (/^(?:0*:)*:?$/.test(host) && host.includes(':')) return true;          // ::
  const mapped = /^(?:0*:){0,5}:?ffff:(.+)$/.exec(host);
  if (mapped) return /^127\./.test(mapped[1]) || /^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(mapped[1]);
  // One number for the whole address (2130706433, 0x7f000001, 017700000001): its top byte is 127.
  let n = null;
  if (/^0x[0-9a-f]+$/.test(host)) n = parseInt(host.slice(2), 16);
  else if (/^0[0-7]+$/.test(host)) n = parseInt(host, 8);
  else if (/^\d+$/.test(host)) n = Number(host);
  if (n !== null && Number.isFinite(n) && n <= 0xffffffff) return (n >>> 24) === 127 || n === 0;
  // The first part as a number (0x7f.1, 0177.0.0.1).
  const first = host.split('.')[0];
  if (host.includes('.') && /^(?:0x7f|0177)$/.test(first)) return true;
  return false;
}

// A loopback address with a port, as inline code writes it.
const INLINE_LOOPBACK = /(?:^|[^\w.])(localhost|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|\[[0-9a-f:.]+\]|::1|0x7f[0-9a-f]{6}|2130706433):(\d{1,5})(?!\d)/gi;

/**
 * Which of SynaBun's own local services an interpreter's inline code (node -e, python -c, …) names, a loopback host
 * and a control port together in any word: { kind, host, port } (controlPortOf), else null. A cheap explanatory layer,
 * not a boundary — inline code is opaque, so a worker can hide the address in a variable or build the string in
 * pieces; the real boundary for this is the OS isolation of the worker's process tree. It is here to turn the
 * published proof-of-concept (`node -e "fetch('http://127.0.0.1:<port>/api/page-session')"`) into a plain refusal
 * instead of a silent pass.
 */
function inlineCodeControlPort(args, confinement) {
  const text = args.join(' ');
  for (const m of text.matchAll(INLINE_LOOPBACK)) {
    if (!isLoopbackHost(m[1])) continue;
    const kind = controlPortOf(m[2], confinement);
    if (kind) return { kind, host: m[1], port: Number(m[2]) };
  }
  return null;
}

/** Paths a writing command writes, by its kind; `null` means "writes somewhere SynaBun cannot name" (refused). */
function writtenPaths(program, kind, args) {
  const paths = args.filter((w) => !isOption(w));
  switch (kind) {
    case 'all': return paths;
    case 'dest': return destinationOf(args);
    case 'dd': return args.filter((w) => w.startsWith('of=')).map((w) => w.slice(3));
    case 'patch': { const d = args.findIndex((w) => w === '-d' || w === '--directory'); return d >= 0 && args[d + 1] ? [args[d + 1]] : ['.']; }
    case 'tar': {
      const out = [];
      const creating = args.some((w) => /^-?[A-Za-z]*c[A-Za-z]*$/.test(w) && !w.startsWith('--')) || args.includes('--create');
      const extracting = args.some((w) => /^-?[A-Za-z]*x[A-Za-z]*$/.test(w) && !w.startsWith('--')) || args.includes('--extract') || args.includes('--get');
      const c = args.findIndex((w) => w === '-C' || w === '--directory');
      if (c >= 0 && args[c + 1]) out.push(args[c + 1]); else if (extracting) out.push('.');
      if (creating) { const f = args.findIndex((w) => w === '-f' || w === '--file' || /^-[A-Za-z]*f$/.test(w)); if (f >= 0 && args[f + 1] && args[f + 1] !== '-') out.push(args[f + 1]); }
      return out;
    }
    case 'unzip': { const d = args.findIndex((w) => w === '-d'); return d >= 0 && args[d + 1] ? [args[d + 1]] : ['.']; }
    case 'zip': return paths.length ? [paths[0]] : ['.'];
    case 'sed': {
      if (args.some((w) => blockedFlag(w, ['-i', '-I', '--in-place']))) return paths.filter((w) => !/^(-e|-f)$/.test(w));
      // a `w file` / `W file` command or an `s///w file` flag writes the file it names; it cannot be read apart, so it is refused
      return paths.some((w) => /(^|[;\n{}\s])\s*[wW](\s|$)|\/[gpImMx0-9]*[wW][gpImMx0-9]*(\s|;|$)/.test(w)) ? null : [];
    }
    case 'awk': return args.some((w) => />/.test(w) && !isOption(w)) ? null : [];
    case 'uniq': return paths.length >= 2 ? [paths[paths.length - 1]] : [];
    case 'sort': { const o = args.findIndex((w) => w === '-o' || w === '--output'); if (o >= 0 && args[o + 1]) return [args[o + 1]]; const eq = args.find((w) => w.startsWith('--output=')); return eq ? [eq.slice('--output='.length)] : []; }
    case 'perl': return args.some((w) => /^-[a-zA-Z]*i/.test(w)) ? paths : [];
    case 'wget': {
      const o = args.findIndex((w) => w === '-O' || w === '--output-document');
      if (o >= 0 && args[o + 1]) return args[o + 1] === '-' ? [] : [args[o + 1]];
      if (args.some((w) => /^-[a-zA-Z]*O-$/.test(w) || w === '--output-document=-')) return [];
      const p = args.findIndex((w) => w === '-P' || w === '--directory-prefix');
      if (p >= 0 && args[p + 1]) return [args[p + 1]];
      return ['.'];
    }
    case 'curl': {
      const out = [];
      for (let i = 0; i < args.length; i++) {
        const w = args[i];
        if (['-o', '--output', '-D', '--dump-header', '-c', '--cookie-jar', '--trace', '--trace-ascii', '--libcurl', '--etag-save', '--hsts', '--alt-svc', '--stderr', '--output-dir'].includes(w)) { if (args[i + 1]) out.push(args[i + 1]); i++; }
        else if (/^--(output|output-dir|dump-header|cookie-jar|trace|trace-ascii|libcurl|etag-save|hsts|alt-svc|stderr)=/.test(w)) out.push(w.split('=').slice(1).join('='));
        else if (/^-[a-zA-Z]*o$/.test(w) && args[i + 1]) { out.push(args[i + 1]); i++; }
        else if (w === '-O' || w === '--remote-name' || /^-[a-zA-Z]*O$/.test(w) || w === '-J' || w === '--remote-header-name') out.push('.');
      }
      return out;
    }
    case 'git': {
      let rest = args;
      let dir = null;
      while (rest.length && isOption(rest[0])) {
        if (rest[0] === '-C' && rest[1]) { dir = rest[1]; rest = rest.slice(2); continue; }
        if (rest[0] === '-c' && rest[1]) { rest = rest.slice(2); continue; }
        if (rest[0].startsWith('--git-dir') || rest[0].startsWith('--work-tree')) { const eq = rest[0].indexOf('='); if (eq > 0) dir = rest[0].slice(eq + 1); else if (rest[1]) { dir = rest[1]; rest = rest.slice(2); continue; } }
        rest = rest.slice(1);
      }
      const [sub, ...subArgs] = rest;
      if (!sub) return [];
      if (GIT_READ.has(sub)) return subArgs.some((w) => blockedFlag(w, GIT_BLOCKED)) ? null : [];
      const shaped = GIT_READ_WITH_ARGS.get(sub);
      if (shaped && shaped(subArgs)) return [];
      if (sub === 'config' && subArgs.some((w) => GIT_GLOBAL_WRITE_OPTIONS.includes(w))) return null;
      if (sub === 'clone') { const p = subArgs.filter((w) => !isOption(w)); return [p.length >= 2 ? p[p.length - 1] : dir || '.']; }
      if (sub === 'worktree' && subArgs[0] === 'add') { const p = subArgs.slice(1).filter((w) => !isOption(w)); return [p[0] || '.']; }
      if (sub === 'init') { const p = subArgs.filter((w) => !isOption(w)); return [p[0] || dir || '.']; }
      if (sub === 'archive') { const o = subArgs.findIndex((w) => w === '-o' || w === '--output'); if (o >= 0 && subArgs[o + 1]) return [subArgs[o + 1]]; const eq = subArgs.find((w) => w.startsWith('--output=')); return eq ? [eq.slice('--output='.length)] : []; }
      return [dir || '.'];
    }
    case 'pkg': {
      const sub = args.find((w) => !isOption(w)) || '';
      if (args.some((w) => w === '-g' || w === '--global' || w === 'global')) return null;
      if (sub === 'config' && args.includes('set')) return null;
      const prefix = args.findIndex((w) => w === '--prefix' || w === '-C' || w === '--dir');
      if (prefix >= 0 && args[prefix + 1]) return [args[prefix + 1]];
      const eq = args.find((w) => w.startsWith('--prefix=') || w.startsWith('--dir='));
      if (eq) return [eq.split('=').slice(1).join('=')];
      return ['.'];
    }
    case 'pip': {
      if (args.includes('--user')) return null;
      const t = args.findIndex((w) => w === '-t' || w === '--target' || w === '--prefix' || w === '--root');
      if (t >= 0 && args[t + 1]) return [args[t + 1]];
      return ['.']; // an install into the active environment: not seen (a venv inside the workspace is the usual case)
    }
    case 'find': {
      if (!args.some((w) => FIND_WRITES.includes(w) || FIND_EXEC.includes(w))) return [];
      const roots = [];
      for (const w of args) { if (w.startsWith('-') || w === '(' || w === '!') break; roots.push(w); }
      // -exec payloads are checked as commands of their own (checkWords); -delete and -fprint* write the roots
      return args.some((w) => FIND_WRITES.includes(w)) ? (roots.length ? roots : ['.']) : [];
    }
    case 'fd': return [];
    case 'brew': return args.some((w) => /^(install|uninstall|upgrade|link|unlink|tap|untap|services|cleanup|pin|unpin|reinstall)$/.test(w)) ? null : [];
    case 'gem': return args[0] === 'install' && !args.includes('--user-install') ? null : [];
    case 'cargo': return args[0] === 'install' ? null : ['.'];
    case 'defaults': return args.some((w) => /^(write|delete|import|rename)$/.test(w)) ? null : [];
    case 'crontab': return args.some((w) => w === '-e' || w === '-r' || w === '-' || !isOption(w)) ? null : [];
    case 'launchctl': return args.some((w) => /^(load|unload|bootstrap|bootout|enable|disable|submit|setenv|unsetenv)$/.test(w)) ? null : [];
    default: return [];
  }
}

/** The payloads of find -exec / -execdir / -ok / -okdir (up to `;` or `+`) and fd -x / -X: each a command of its own. */
function execPayloads(program, args) {
  const out = [];
  if (program === 'find') {
    for (let i = 0; i < args.length; i++) {
      if (!FIND_EXEC.includes(args[i])) continue;
      const words = [];
      let j = i + 1;
      for (; j < args.length && args[j] !== ';' && args[j] !== '+'; j++) words.push(args[j]);
      out.push(words); // `{}` stays: a file find found, under the roots (checked as a relative path)
      i = j;
    }
  } else if (program === 'fd' || program === 'fdfind') {
    const at = args.findIndex((w) => FD_EXEC.test(w));
    if (at >= 0) out.push(args.slice(at + 1).filter((w) => w !== ';' && w !== '+'));
  }
  return out.filter((w) => w.length);
}

const READ_ONLY_INTRO = 'This run has capability read-only: the shell runs read-only commands only (rg, grep, ls, cat, head, tail, find, stat, diff, jq, git log / diff / status / show / blame, node --check, the project\'s own tests (node --test, npm test, vitest), npm ls, curl without an output file…).';

/**
 * Whether a worker may run this command line: null when it may, else a refusal { rule, reason, target? }.
 * read-only: every simple command must be a known read-only program, and nothing may be redirected to a file.
 * workspace: nothing privileged, no redirection to a file outside the writable roots, no writing program whose
 * written path is outside them (or that writes somewhere SynaBun cannot name). Both: no shell or interpreter fed
 * from a pipe or a file, no call to SynaBun's own port (read-only: no call to loopback at all).
 */
export function workerShellDecision(command, confinement) {
  if (!confinement) return null;
  try {
    const text = String(command ?? '');
    if (!text.trim()) return null;
    const segments = shellSegments(text, { cwd: confinement.cwd, home: confinement.home });
    if (!segments) return refusal('unreadable', 'SynaBun could not read this command line (an unbalanced quote or a control character), so it did not run. Write it more plainly.');
    const readOnly = confinement.capability === 'read-only';
    for (const seg of segments) {
      const found = checkSegment(seg, confinement, readOnly);
      if (found) return found;
    }
    return null;
  } catch (err) {
    return refusal('check-failed', `The command could not be checked (${err?.message || err}), so it is refused.`);
  }
}

/** bash's and zsh's /dev/tcp/<host>/<port> (a connection the shell opens itself) to one of SynaBun's control ports. */
function devTcpControlPort(text, confinement) {
  const m = /^\/dev\/(?:tcp|udp)\/([^/]+)\/(\d{1,5})$/i.exec(String(text || ''));
  if (!m || !isLoopbackHost(m[1])) return null;
  const kind = controlPortOf(m[2], confinement);
  return kind ? { kind, host: m[1], port: Number(m[2]) } : null;
}

function checkSegment(seg, confinement, readOnly) {
  const cwd = seg.cwd;
  // A connection the shell itself opens (exec 3<>/dev/tcp/127.0.0.1/<port>), in either direction.
  for (const t of [...seg.redirects.map((r) => r.target), ...seg.words]) {
    const hit = devTcpControlPort(t, confinement);
    if (hit) return refusal('loopback', `${controlPortText(hit.kind, hit.host, hit.port, confinement)}: a dispatched worker does not call it with the shell (its MCP tools are the way in).`);
  }
  // Redirections first: a file written, wherever the program is.
  for (const r of seg.redirects) {
    if (!r.op.includes('>')) continue;
    const target = r.target;
    if (DEVICE_PATHS.has(target)) continue;
    if (readOnly) return refusal('read-only', `${READ_ONLY_INTRO} Writing output to a file (${r.op} ${target || ''}) is not available; a run that must write needs capability workspace.`);
    if (cwd === null) return refusal('unknown-path', `After a cd to a folder SynaBun could not resolve, ${r.op} ${target} cannot be checked, so it did not run.`);
    const place = placeOf(target, { cwd, home: confinement.home, vars: seg.vars });
    if (!place) return refusal('unknown-path', `The redirection target "${target.slice(0, 200)}" uses a value SynaBun could not resolve (an unknown variable, a command substitution other than $(mktemp …), or an odd character), so the command did not run. ${passHint(confinement)}`);
    if (!mayWrite(place, confinement)) return refusal('write-outside', `${r.op} ${target} would write ${place}, outside this run's workspace. This run writes inside ${rootsText(confinement)} only.`, place);
  }
  return checkWords(seg.words, { cwd, piped: seg.piped, stdin: seg.stdin, vars: seg.vars }, confinement, readOnly);
}

/** One command's words (wrappers still on), in a context { cwd, piped, stdin, vars }. */
function checkWords(rawWords, ctx, confinement, readOnly, depth = 0) {
  if (depth > 6) return refusal('unreadable', 'The command nests too deep to check, so it did not run.');
  const unwrapped = unwrap(rawWords, { cwd: ctx.cwd, home: confinement.home, vars: ctx.vars });
  const words = unwrapped.words;
  if (!words.length) return null;
  const cwd = unwrapped.cwd !== undefined ? unwrapped.cwd : ctx.cwd;
  const unknownCwd = cwd === null;
  const program = words[0].replace(/^.*\//, '');
  if (PRIVILEGE.has(program)) return refusal('privilege', `${program} is not available to a dispatched worker (capability ${confinement.capability}): nothing runs with higher privileges than the run itself.`);
  const args = words.slice(1);
  // A shell or interpreter with no program of its own reads it from a pipe or a file: it cannot be checked.
  if (SHELLS.has(program) || INTERPRETERS.has(program) || program === 'eval') {
    const inner = innerCommand([program, ...args]);
    if (inner !== null) {
      const nested = shellSegments(inner, { cwd, home: confinement.home, seedVars: ctx.vars });
      if (!nested) return refusal('unreadable', `SynaBun could not read the command passed to ${program} -c, so it did not run. Write it more plainly.`);
      for (const sub of nested) { const found = checkSegment({ ...sub, piped: sub.piped, stdin: sub.stdin }, confinement, readOnly); if (found) return found; }
      return null;
    }
    const scriptless = !args.some((w) => !isOption(w)) || args.includes('-') || args.includes('/dev/stdin');
    const hasCode = args.some((w) => /^(-e|--eval|-p|--print|-c|-m|-r|-E|-S)$/.test(w));
    if (program !== 'eval' && scriptless && !hasCode && (ctx.piped || ctx.stdin || SHELLS.has(program) || args.includes('-') || args.includes('/dev/stdin'))) {
      return refusal('unreadable', `${program} would read its program from ${ctx.piped ? 'a pipe' : ctx.stdin ? 'a file' : 'standard input'}, which SynaBun cannot check, so it did not run. Write the command out, or put the script in a file inside your working directory and run that.`);
    }
    // A guarded worker's shell may not call SynaBun's own server or its OpenCode serves (its MCP tools are the way
    // in). The net-client check below reads the command line, but an interpreter's inline code is opaque, so under
    // workspace a fetch to one of them would pass unseen. This refuses the obvious form with a plain reason; it is a
    // speed-bump, not the boundary (see inlineCodeControlPort). Under read-only an inline interpreter never runs at
    // all (it is not a read-only program), so this only matters for workspace.
    const inline = INTERPRETERS.has(program) && hasCode && !readOnly ? inlineCodeControlPort(args, confinement) : null;
    if (inline) {
      if (inline.kind === 'server') return refusal('loopback-inline', `${program} with inline code (-e / -c) that names SynaBun's own server (localhost:${confinement.serverPort}) did not run: a dispatched worker does not call SynaBun's own port — its MCP tools are the way in, and whatever they cannot do is the run's to report. Put a script that does not call SynaBun's own port in a file inside your working directory and run that.`);
      return refusal('loopback-inline', `${program} with inline code (-e / -c) did not run: ${controlPortText(inline.kind, inline.host, inline.port, confinement)}, which a dispatched worker does not call — its tools are the way in, and whatever they cannot do is the run's to report.`);
    }
  }
  // A network client aimed at loopback: never SynaBun's own port or its OpenCode serves; under read-only not loopback
  // at all.
  if (NET_CLIENTS.has(program)) {
    const targets = netTargets(args, program);
    for (const t of targets) {
      if (!isLoopbackHost(t.host)) continue;
      if (readOnly) return refusal('loopback', `${READ_ONLY_INTRO} A request to ${t.host}${t.port ? `:${t.port}` : ''} (this computer's own services) is not available to a read-only run.`);
      const kind = controlPortOf(t.port, confinement);
      if (kind === 'server') return refusal('loopback', `${program} to ${t.host}:${t.port} is SynaBun's own server: a dispatched worker does not call it with the shell (its MCP tools are the way in).`);
      if (kind) return refusal('loopback', `${program} to ${controlPortText(kind, t.host, t.port, confinement)}: a dispatched worker does not call it with the shell (its tools are the way in).`);
    }
  }
  // find -exec / fd -x payloads are commands of their own; a writing payload writes what find found, under the roots.
  if ((program === 'find' || program === 'fd' || program === 'fdfind') && !readOnly) {
    for (const payload of execPayloads(program, args)) {
      const found = checkWords(payload, { cwd, piped: false, stdin: false, vars: ctx.vars }, confinement, readOnly, depth + 1);
      if (found) return found;
      const inner = unwrap(payload, { cwd, home: confinement.home, vars: ctx.vars }).words;
      const innerProgram = String(inner[0] || '').replace(/^.*\//, '');
      if (WRITERS.has(innerProgram) || SHELLS.has(innerProgram) || INTERPRETERS.has(innerProgram)) {
        const roots = [];
        if (program === 'find') { for (const w of args) { if (w.startsWith('-') || w === '(' || w === '!') break; roots.push(w); } }
        else { const at = args.findIndex((w) => FD_EXEC.test(w)); const before = args.slice(0, at).filter((w) => !isOption(w)); if (before.length >= 2) roots.push(before[1]); }
        for (const root of roots.length ? roots : ['.']) {
          if (unknownCwd) return refusal('unknown-path', `After a cd to a folder SynaBun could not resolve, ${program} … -exec ${innerProgram} cannot be checked, so it did not run.`);
          const place = placeOf(root, { cwd, home: confinement.home, vars: ctx.vars });
          if (!place) return refusal('unknown-path', `${program} names a folder SynaBun could not read ("${String(root).slice(0, 200)}"), so its -exec ${innerProgram} did not run.`);
          if (!mayWrite(place, confinement)) return refusal('write-outside', `${program} … -exec ${innerProgram} would act on files under ${place}, outside this run's workspace. This run writes inside ${rootsText(confinement)} only.`, place);
        }
      }
    }
  }
  if (readOnly) {
    if (program === 'cd' || program === 'pushd' || program === 'popd' || program === 'export' || program === 'unset' || program === 'set' || program === 'alias' || program === 'wait' || program === 'exit' || program === 'return' || program === 'for' || program === 'case' || program === 'select' || program === 'function' || program === 'local' || program === 'read') return null;
    if (program === 'git') {
      let rest = args;
      while (rest.length && isOption(rest[0])) {
        if (rest[0] === '-C' && rest[1]) { rest = rest.slice(2); continue; }
        if (rest[0] === '--no-pager' || rest[0] === '-P') { rest = rest.slice(1); continue; }
        return refusal('read-only', `${READ_ONLY_INTRO} git with the global option ${rest[0]} may run a program or write, so it did not run.`);
      }
      const [sub, ...subArgs] = rest;
      if (sub && (GIT_READ.has(sub) || GIT_READ_WITH_ARGS.get(sub)?.(subArgs)) && !subArgs.some((w) => blockedFlag(w, GIT_BLOCKED))) return null;
      return refusal('read-only', `${READ_ONLY_INTRO} git ${sub || ''} may change the repository, so it did not run.`);
    }
    const blocked = READ_PROGRAMS.get(program);
    if (blocked === undefined) {
      const runner = /^(pytest|jest|mocha|make|cargo|go|deno|bun|tsc|eslint|prettier|python2|perl|ruby|php|sh|bash|zsh|dash|ksh|fish)$/.test(program);
      return refusal('read-only', `${READ_ONLY_INTRO} ${program} is not in that list${runner ? ' (a program or a test runner may write files and build output)' : ''}, so it did not run; a run that must execute programs needs capability workspace.`);
    }
    const bad = args.find((w) => blockedFlag(w, blocked));
    if (bad) return refusal('read-only', `${READ_ONLY_INTRO} ${program} with an option that writes or runs something (${bad}) did not run.`);
    const shape = READ_SHAPES.get(program);
    const inside = (w) => { const place = placeOf(w, { cwd, home: confinement.home, vars: ctx.vars }); return !!place && inside_(confinement.cwd, place); };
    if (shape && !shape(args, { cwd, inside })) return refusal('read-only', `${READ_ONLY_INTRO} ${program} ${args[0] || ''} may write or run a program, so it did not run; a run that must execute programs needs capability workspace.`);
    return null;
  }
  // workspace
  const kind = WRITERS.get(program);
  if (!kind) return null;
  const targets = writtenPaths(program, kind, args);
  if (targets === null) return refusal('write-outside', `${program} ${args.slice(0, 3).join(' ')} writes outside this run's workspace, or to a file SynaBun cannot name (a global install, a user-wide setting, a system folder, a sed w / awk > inside a program). This run (capability workspace) writes inside ${rootsText(confinement)} only.`);
  for (const target of targets) {
    if (unknownCwd) return refusal('unknown-path', `After a cd to a folder SynaBun could not resolve, ${program} ${target} cannot be checked, so it did not run.`);
    const place = placeOf(target, { cwd, home: confinement.home, vars: ctx.vars });
    if (!place) return refusal('unknown-path', `${program} names a path SynaBun could not resolve ("${String(target).slice(0, 200)}": an unknown variable, a command substitution other than $(mktemp …), or an odd character), so it did not run. ${passHint(confinement)}`);
    if (!mayWrite(place, confinement)) return refusal('write-outside', `${program} would write ${place}, outside this run's workspace. This run (capability workspace) writes inside ${rootsText(confinement)} only; nothing is written under the home folder, another project or a tool's configuration.`, place);
  }
  return null;
}
const inside_ = (root, target) => inside(root, target, true);

// ── Provider mappings ───────────────────────────────────────────────────────

/** Codex: the sandbox mode and the extra writable folders a guarded run gets. */
export function codexSandboxFor(confinement, { parentDir = null, scratchDir = null } = {}) {
  if (!confinement) return null;
  if (confinement.capability === 'read-only') return { sandboxMode: 'read-only', additionalDirectories: undefined };
  const extra = [];
  if (!confinement.enforced && parentDir) extra.push(parentDir);
  if (scratchDir) extra.push(scratchDir);
  return { sandboxMode: 'workspace-write', additionalDirectories: extra.length ? extra : undefined };
}

/**
 * OpenCode 2's Code Mode tool. Inside it a model scripts the tools of the Code Mode catalog, among them
 * `tools.opencode.session_move` (which moves the session to another folder: the read tool then reads there, and
 * nothing asks), `worktree_create` / `worktree_remove`, and every MCP server whose `codemode` is not false (OpenCode
 * 2.1.4's default: such a server's tools are reachable through `execute` only). Code Mode itself asks nothing, so the
 * guard cannot check what runs inside it: an enforced worker has it off (a `deny` rule takes the tool, and the whole
 * catalog with it, off the model's list) and its MCP servers set `codemode: false`, which keeps their tools direct
 * calls (server.js setupOpencodeLoopConfig, lib/native-loop-providers.js openCodeRunConfigFor).
 */
export const OPENCODE_CODE_MODE_TOOL = 'execute';

/**
 * OpenCode: the permission rules (OpenCode 2's `{ action, resource, effect }`) a guarded run's config and its
 * session get. Every ask reaches the adapter, which answers it with openCodePermissionDecision(); nothing is a
 * blanket "always". Under Enforce, Code Mode (`execute`) is denied; Warn keeps it and notes each call
 * (openCodeCodeModeDecision).
 */
export function openCodePermissionsFor(confinement) {
  if (!confinement) return null;
  const rule = (action, effect) => ({ action, resource: '*', effect });
  return [
    rule('edit', confinement.capability === 'read-only' ? 'deny' : 'ask'),
    rule('shell', 'ask'),
    rule('webfetch', 'allow'),
    rule('external_directory', 'ask'),
    ...(confinement.enforced ? [rule(OPENCODE_CODE_MODE_TOOL, 'deny')] : []),
  ];
}

/**
 * A Code Mode call (an OpenCode tool part named `execute`) under a confinement: null for any other tool or an
 * unguarded run, else what the run records. Under Enforce the call never ran (the tool is not offered, so OpenCode
 * answers it with its own "No tool named" error): the reason says plainly that Code Mode is off. Under Warn it ran:
 * the reason says the guard could not check inside it.
 */
export function openCodeCodeModeDecision(toolName, confinement) {
  if (!confinement || String(toolName || '').toLowerCase() !== OPENCODE_CODE_MODE_TOOL) return null;
  if (confinement.enforced) {
    return refusal('code-mode', 'Code Mode is off for protected workers: OpenCode\'s execute tool is not available in this run (inside it, session_move could move the session out of its working directory and nothing would ask). Call each tool directly instead: read, glob, grep, edit, write, the shell, and SynaBun\'s MCP tools.');
  }
  return refusal('code-mode', 'Code Mode (OpenCode\'s execute tool) ran: Protect workers cannot check the calls inside it (session_move can move the session out of its working directory). Under Enforce, Code Mode is off for protected workers.');
}

/** The line a guarded OpenCode run's notes start with about Code Mode, or null (no guard). */
export function openCodeCodeModeNote(confinement) {
  if (!confinement) return null;
  return confinement.enforced
    ? `worker confinement (enforce, capability ${confinement.capability}): Code Mode is off for protected workers. OpenCode's execute tool is not offered to this run, and its MCP servers (SynaBun's included) are direct tool calls.`
    : `worker confinement (warn, capability ${confinement.capability}): Code Mode stays on as before; each execute call is noted, because Protect workers cannot check the calls inside it. Enforce turns it off.`;
}

const OPENCODE_EDIT_KINDS = /^(?:edit|write|patch|multiedit|apply_patch)$/i;

/** The path an OpenCode permission request names, from its metadata or its pattern. */
function openCodePathOf(request) {
  const meta = request?.metadata && typeof request.metadata === 'object' ? request.metadata : {};
  for (const key of ['filePath', 'filepath', 'file_path', 'path', 'directory', 'dir']) if (typeof meta[key] === 'string' && meta[key]) return meta[key];
  const pattern = request?.pattern ?? request?.patterns;
  if (typeof pattern === 'string' && pattern) return pattern;
  if (Array.isArray(pattern) && typeof pattern[0] === 'string' && pattern[0]) return pattern[0];
  return null;
}

/**
 * An OpenCode permission request (the `permission.asked` payload: { permission | type, metadata, pattern(s) }) under
 * a confinement: null when it may go ahead, else a refusal.
 */
export function openCodePermissionDecision(request, confinement, { toolName = null } = {}) {
  if (!confinement) return null;
  try {
    const kind = String(request?.permission || request?.type || '').toLowerCase();
    if (kind === 'bash') return workerShellDecision(request?.metadata?.command ?? openCodePathOf(request) ?? '', confinement);
    if (OPENCODE_EDIT_KINDS.test(kind)) {
      if (confinement.capability === 'read-only') return refusal('read-only', `This run has capability read-only: ${kind} is not available. Report what you found instead of changing files.`);
      const raw = openCodePathOf(request);
      const place = raw ? placeOf(raw, { cwd: confinement.cwd, home: confinement.home }) : null;
      if (!place) return refusal('unknown-path', `${kind} names a path SynaBun could not read; this run writes inside ${rootsText(confinement)} only.`);
      if (!mayWrite(place, confinement)) return refusal('write-outside', `${kind} to ${place} is outside this run's workspace: this run writes inside ${rootsText(confinement)} only.`, place);
      return null;
    }
    if (kind === 'external_directory') {
      // Reads outside the workspace are allowed; writes are not. The adapter resolves the ask's tool reference
      // against the actual tool part (not metadata guessed from the path), so an unidentified caller fails closed
      // outside writable roots, as do shell and edit calls. SynaBun's own protected home folders (its data home,
      // the runtime credential stores) stay refused even for a read: the serve's OS sandbox denies them too.
      const raw = openCodePathOf(request);
      const place = raw ? placeOf(raw, { cwd: confinement.cwd, home: confinement.home }) : null;
      if (/^(?:read|grep|glob|list)$/i.test(String(toolName || ''))) {
        if (place && isProtectedPlace(place, confinement)) {
          return refusal('protected-path', `${toolName} requested ${place}, one of SynaBun's protected home folders (its data home or a runtime's credential store): a worker does not read there, whatever its capability.`, place);
        }
        return null;
      }
      if (place && mayWrite(place, confinement)) return null;
      return refusal('write-outside', `${toolName || 'An unidentified tool'} requested access to ${place || raw || 'a folder outside the working directory'} (capability ${confinement.capability}): only read, grep, glob and list may read outside this run's workspace; the shell and edit tools stay inside ${rootsText(confinement)}.`, place || undefined);
    }
    return null; // every other ask (webfetch, a tool rule the user set) keeps today's answer
  } catch (err) {
    return refusal('check-failed', `The request could not be checked (${err?.message || err}), so it is refused.`);
  }
}

/** What the run's transcript records for a decision: { type: 'synabun.confinement', action, tool, rule, reason, target? }. */
export function confinementEvent(decision, { tool, confinement, provider = null } = {}) {
  return {
    type: 'synabun.confinement',
    action: confinement?.enforced ? 'refused' : 'warned',
    capability: confinement?.capability || null,
    tool: tool || null,
    rule: decision?.rule || null,
    reason: decision?.reason || '',
    ...(decision?.target ? { target: decision.target } : {}),
    ...(provider ? { provider } : {}),
  };
}

/** One line for a transcript tail. */
export function describeConfinementEvent(event) {
  const verb = event?.action === 'warned' ? 'guard warning' : 'refused';
  return `${verb}: ${event?.tool || 'tool'}${event?.target ? ` → ${event.target}` : ''} (${event?.rule || 'rule'}) ${String(event?.reason || '').slice(0, 200)}`;
}

/** Whether a path is one of the protected home folders (for messages and tests). */
export function isProtectedPlace(place, confinement) {
  if (!place || !confinement) return false;
  return confinement.protectedDirs.some((dir) => inside(realPlace(dir), place, true));
}

export const _internals = { shellSegments, writtenPaths, unwrap, READ_PROGRAMS, WRITERS, existsSync, lstatSync };

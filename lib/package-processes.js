/**
 * SynaBun — stop SynaBun's own processes before npm replaces its folder (Windows).
 *
 * `npm i -g synabun@<version>` renames the installed package folder away and
 * extracts the new one. Windows refuses to rename or remove a folder while a
 * process runs from it or holds one of its native modules loaded
 * (onnxruntime_binding.node, onnxruntime.dll, DirectML.dll, sharp's libvips),
 * and npm then fails with EPERM, EBUSY or ENOTEMPTY. The SynaBun server stops
 * its own children before an update, but the MCP servers an AI client started
 * (Claude Code, Codex, Cursor, OpenCode, ...) and their embedding workers are
 * not its children: they keep running from the folder.
 *
 * What counts as one of SynaBun's processes (findPackageProcesses):
 *   - any process whose executable is inside the package root;
 *   - a node process whose entrypoint is inside it: the script Node runs (the
 *     first argument after node's own options: `node <root>\mcp-server\run.mjs`,
 *     the embedding worker it forks, a hook) or a module it preloads (-r,
 *     --require, --import, --loader). No other argument decides: a config file,
 *     a data folder, a --prefix or a working folder inside the package does not
 *     make `node C:\tools\client\cli.js --mcp-config <root>\.mcp.json` (an AI
 *     client) or `npm --prefix <root> ...` one of SynaBun's processes.
 * Paths compare in every form they have: as written (`\\?\` and `\\?\UNC\`
 * taken off, either slash, any case) and as the real path (junctions, symbolic
 * links and 8.3 short names resolved), for the root and for each process. Only
 * on a whole folder name: `...\synabun-foo`, `...\synabun - Copy`, a checkout
 * and another install are someone else's. Never the process that asks, the
 * processes it descends from (its terminal among them) or the ones it started.
 *
 * The process list comes from one fixed PowerShell command (Get-CimInstance
 * Win32_Process; wmic is gone from current Windows 11) that takes no input at
 * all: the root and the PIDs never reach PowerShell, the matching happens here.
 * Before each kill the list is read again, and a process whose creation time
 * changed (Windows gave its PID to another one) is left alone.
 *
 * Used by updater.mjs (staged next to it, in lib/, by server.js
 * stageSynabunUpdater) and preuninstall.js. Only node: modules and
 * ./runtime-dependencies.js (which has only node: modules too): the staged copy
 * has nothing else next to it.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestDebugLog } from './runtime-dependencies.js';

/** How npm says a file or folder is in use on Windows: the codes, and the errno npm exits with for each. */
export const WINDOWS_LOCK_ERRNO = Object.freeze({ EPERM: -4048, EBUSY: -4082, ENOTEMPTY: -4051 });

/** How many times npm runs again after a lock failure (each time after another stop). */
export const LOCK_RETRIES = 2;

/** How long the stop waits for the processes it ended to be gone. */
export const STOP_WAIT_MS = 10_000;

/** The longest the process list may take. */
export const LIST_TIMEOUT_MS = 30_000;

/**
 * The most the whole stop step may take: every list (each up to LIST_TIMEOUT_MS), kill (up to 15 s) and wait of
 * every pass the updater makes. Generous (a pass takes seconds), but never endless: past it nothing more is
 * stopped, and the updater ends with what to close by hand.
 */
export const STOP_DEADLINE_MS = 180_000;

/**
 * The stop step's time limit, counted only while a stop pass runs: `run(pass)`
 * hands the pass an absolute deadline made of what the earlier passes left,
 * then takes the time the pass took from it. The time npm takes between passes
 * is never counted: a slow install leaves the next pass its full share.
 */
export function createStopBudget({ totalMs = STOP_DEADLINE_MS, now = Date.now } = {}) {
  let left = totalMs;
  return {
    get leftMs() { return left; },
    async run(pass) {
      const started = now();
      try {
        return await pass(started + Math.max(0, left));
      } finally {
        left -= Math.max(0, now() - started);
      }
    },
  };
}

// Every process as one JSON array, written as base64 of its UTF-8: what reaches
// the pipe is ASCII whatever the console code page is (a user folder named
// "João"). One line, single quotes only: nothing in it needs quoting on a
// command line, and nothing in it comes from the caller.
export const PROCESS_LIST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object { $created = $null; '
    + "if ($_.CreationDate) { $created = $_.CreationDate.ToUniversalTime().ToString('o') }; "
    + '[pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; '
    + 'exe = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine; created = $created } })',
  '$json = ConvertTo-Json -InputObject $rows -Compress -Depth 2',
  '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))',
].join('; ');

const systemFolder = (env) => win32.join(String(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows'), 'System32');

/** What to hand spawnSync to list the processes: the same constant script whatever the caller's input, never a shell. */
export function processListCommand({ env = process.env } = {}) {
  return {
    file: win32.join(systemFolder(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROCESS_LIST_SCRIPT],
    options: { env, encoding: 'utf8', windowsHide: true, shell: false, timeout: LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  };
}

/** The processes in PowerShell's answer: [{ pid, ppid, name, exe, cmd, created }], or null when it is not one. */
export function parseProcessList(stdout) {
  try {
    const text = Buffer.from(String(stdout || '').trim(), 'base64').toString('utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter(row => Number.isInteger(row?.pid) && row.pid > 0)
      .map(row => ({
        pid: row.pid,
        ppid: Number.isInteger(row.ppid) ? row.ppid : 0,
        name: String(row.name || ''),
        exe: String(row.exe || ''),
        cmd: String(row.cmd || ''),
        created: Number.isFinite(Date.parse(row.created)) ? Date.parse(row.created) : null,
      }));
  } catch {
    return null;
  }
}

/** Every process on this Windows machine, or null when they cannot be listed. */
export function listWindowsProcesses({ env = process.env, spawn = spawnSync } = {}) {
  const command = processListCommand({ env });
  const result = spawn(command.file, command.args, command.options);
  if (result.error || result.status !== 0) return null;
  return parseProcessList(result.stdout);
}

/** What to hand spawnSync to end one process and everything it started: taskkill /PID <pid> /T /F, never a shell. */
export function taskkillCommand(pid, { env = process.env } = {}) {
  return {
    file: win32.join(systemFolder(env), 'taskkill.exe'),
    args: ['/PID', String(pid), '/T', '/F'],
    options: { env, windowsHide: true, shell: false, stdio: 'ignore', timeout: 15_000 },
  };
}

/** A command line split into its arguments the way a Windows program reads it (CommandLineToArgvW). */
export function splitWindowsCommandLine(line) {
  const text = String(line || '');
  const args = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '\\') {
      let n = 0;
      while (text[i] === '\\') { n++; i++; }
      if (text[i] === '"') {
        current += '\\'.repeat(n >> 1);
        if (n % 2) { current += '"'; i++; }
      } else {
        current += '\\'.repeat(n);
      }
      started = true;
      continue;
    }
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { current += '"'; i += 2; started = true; continue; }
      quoted = !quoted;
      started = true;
      i++;
      continue;
    }
    if (!quoted && (c === ' ' || c === '\t')) {
      if (started) { args.push(current); current = ''; started = false; }
      i++;
      continue;
    }
    current += c;
    started = true;
    i++;
  }
  if (started) args.push(current);
  return args;
}

/**
 * A Windows path as written, made plain: a `file:` URL read as a path, forward
 * slashes turned back, the `\\?\`, `\\.\` and `\??\` prefixes taken off
 * (`\\?\UNC\srv\share` is `\\srv\share`), `.`, `..` and doubled separators
 * resolved, no trailing separator. Null for anything that is not an absolute
 * drive or share path: a relative one would need the process's working folder,
 * which the process list does not give.
 */
export function lexicalPath(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  if (/^file:/i.test(text)) {
    try { text = fileURLToPath(text, { windows: true }); } catch { return null; }
  }
  text = text.replace(/\//g, '\\');
  const prefix = /^(?:\\\\[?.]\\|\\\?\?\\)/.exec(text);
  if (prefix) {
    const rest = text.slice(prefix[0].length);
    text = /^unc\\/i.test(rest) ? `\\\\${rest.slice(4)}` : rest;
  }
  if (!/^[A-Za-z]:\\/.test(text) && !/^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(text)) return null;
  const normal = win32.normalize(text);
  return normal.length > win32.parse(normal).root.length ? normal.replace(/\\+$/, '') : normal;
}

const folderDepth = (path) => path.slice(win32.parse(path).root.length).split('\\').filter(Boolean).length;

// A folder npm installed: its parent is node_modules (as installKind in runtime-dependencies.js reads it).
const npmInstalled = (path) => win32.basename(win32.dirname(path)).toLowerCase() === 'node_modules';

// What paths are compared by: forward slashes, lower case.
const keyOf = (path) => path.replace(/\\/g, '/').toLowerCase();

// The real path of a file or folder on this machine: junctions, symbolic links
// and 8.3 short names resolved to the long names (GetFinalPathNameByHandle).
// Only on Windows: anywhere else the paths are another machine's and stay as written.
const nativeRealpath = (path) => {
  if (process.platform !== 'win32') throw new Error('Windows paths resolve only on Windows');
  return realpathSync.native(path);
};
// Whether a path is a folder, the same way: asked only on Windows.
const nativeIsDirectory = (path) => process.platform === 'win32' && statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/**
 * The canonical form of an absolute Windows path: its real path (`realpath`,
 * fs.realpathSync.native by default), through its nearest ancestor that
 * resolves when the path itself does not (a script removed since it started),
 * or lexicalPath when nothing on the way resolves. Null when it is not absolute.
 */
export function canonicalPath(value, { realpath = nativeRealpath } = {}) {
  return resolvePath(value, realpath)?.real ?? null;
}

// { lexical, real, resolved }: canonicalPath's answer, and whether `realpath` answered for the path or an ancestor
// of it (false: `real` is only the path as written).
function resolvePath(value, realpath) {
  const lexical = lexicalPath(value);
  if (!lexical) return null;
  const tail = [];
  for (let current = lexical; ;) {
    let real = null;
    try { real = lexicalPath(realpath(current)); } catch {}
    if (real) return { lexical, real: tail.length ? win32.join(real, ...tail.reverse()) : real, resolved: true };
    const parent = win32.dirname(current);
    if (parent === current) return { lexical, real: lexical, resolved: false };
    tail.push(win32.basename(current));
    current = parent;
  }
}

/**
 * A package root as it is compared: lexicalPath with forward slashes. Null for
 * anything that is not an absolute folder at least `minDepth` levels below a
 * drive or share: a root like `C:\` would take in every process.
 */
export function normalizeRoot(root, { minDepth = 2 } = {}) {
  const lexical = lexicalPath(root);
  if (!lexical || folderDepth(lexical) < Math.max(1, minDepth)) return null;
  return lexical.replace(/\\/g, '/');
}

/**
 * The forms of one package root that count: [as given, its real path] (one
 * when they are the same), or [] when it is not a folder npm installed. Whether
 * npm installed it (its parent is node_modules, as installKind in
 * runtime-dependencies.js reads it) is read on the real path whenever that
 * resolves: a short name (`NODE_M~1`) is node_modules, and an `npm link` alias
 * of a checkout is the checkout, in every spelling: `npm i -g` replaces only
 * the link, and the checkout's processes are a developer's. On the path as
 * given only when nothing resolves.
 */
export function rootForms(value, { realpath = nativeRealpath } = {}) {
  if (typeof value !== 'string' || !normalizeRoot(value)) return [];
  const forms = resolvePath(value, realpath);
  if (!forms || !npmInstalled(forms.resolved ? forms.real : forms.lexical)) return [];
  return keyOf(forms.real) === keyOf(forms.lexical) ? [forms.lexical] : [forms.lexical, forms.real];
}

/**
 * Decides whether a path is inside one of `rootList` (only the roots npm
 * installed, rootForms), comparing every form of both: each root as given and
 * as its real path, each path as written and, when that does not match, as its
 * canonical path (one resolution per path). `inside(path)` is what follows the
 * root (`\mcp-server\run.mjs`; '' for the root itself), or null;
 * `isDirectory(path)` asks the file system (injectable, like `realpath`).
 */
export function createPathMatcher(rootList, { realpath = nativeRealpath, isDirectory = nativeIsDirectory } = {}) {
  const keys = new Set();
  for (const value of Array.isArray(rootList) ? rootList : [rootList]) {
    for (const form of rootForms(value, { realpath })) keys.add(keyOf(form));
  }
  const rootKeys = [...keys];
  const resolved = new Map();
  const below = (path) => {
    const key = keyOf(path);
    const root = rootKeys.find(candidate => key === candidate || key.startsWith(`${candidate}/`));
    if (root == null) return null;
    // What follows the root, in the path's own case when lower-casing kept its length.
    return (key.length === path.length ? path.slice(root.length) : key.slice(root.length)).replace(/\//g, '\\');
  };
  return {
    roots: rootKeys,
    isDirectory(value) {
      const lexical = lexicalPath(value);
      try { return !!lexical && isDirectory(lexical) === true; } catch { return false; }
    },
    inside(value) {
      const lexical = rootKeys.length ? lexicalPath(value) : null;
      if (!lexical) return null;
      const direct = below(lexical);
      if (direct != null) return direct;
      const cacheKey = keyOf(lexical);
      if (!resolved.has(cacheKey)) resolved.set(cacheKey, canonicalPath(lexical, { realpath }));
      const real = resolved.get(cacheKey);
      return real ? below(real) : null;
    },
  };
}

/**
 * The folders whose processes are stopped before `npm i -g` replaces the
 * package: each form of it the caller knows (the configured one, the one it
 * resolved) and, when it differs, its real path (a junction, a short 8.3
 * name). Only a folder npm installed (rootForms, with Windows path rules on any
 * OS): a checkout, or the checkout an `npm link` points to, is never what
 * `npm i -g` replaces.
 */
export function packageRootsToStop(packageRoots, { realpath = nativeRealpath } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(packageRoots) ? packageRoots : [packageRoots]) {
    for (const form of rootForms(value, { realpath })) {
      if (seen.has(keyOf(form))) continue;
      seen.add(keyOf(form));
      out.push(form);
    }
  }
  return out;
}

// Node's options that take the next argument as their value when it is not
// given with `=` (`--require x`). Any other option is a flag, or a V8 option
// whose value is a number (`--max-old-space-size 4096`).
const NODE_VALUE_OPTIONS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions',
  '--env-file', '--env-file-if-exists', '--input-type', '--title', '--inspect-port', '--debug-port', '--inspect-publish-uid',
  '--redirect-warnings', '--disable-warning', '--disable-proto', '--dns-result-order', '--unhandled-rejections',
  '--experimental-default-type', '--experimental-policy', '--policy-integrity', '--experimental-sea-config',
  '--experimental-config-file', '--experimental-specifier-resolution', '--es-module-specifier-resolution',
  '--build-snapshot-config', '--snapshot-blob', '--localstorage-file', '--icu-data-dir', '--openssl-config',
  '--tls-cipher-list', '--tls-keylog', '--secure-heap', '--secure-heap-min', '--security-revert', '--use-largepages',
  '--v8-pool-size', '--max-http-header-size', '--network-family-autoselection-attempt-timeout',
  '--allow-fs-read', '--allow-fs-write', '--diagnostic-dir', '--report-dir', '--report-directory', '--report-filename',
  '--report-signal', '--heapsnapshot-signal', '--heapsnapshot-near-heap-limit', '--cpu-prof-dir', '--cpu-prof-name',
  '--cpu-prof-interval', '--heap-prof-dir', '--heap-prof-name', '--heap-prof-interval', '--trace-event-categories',
  '--trace-event-file-pattern', '--trace-require-module', '--watch-path', '--watch-kill-signal',
  '--test-concurrency', '--test-coverage-branches', '--test-coverage-functions', '--test-coverage-lines',
  '--test-coverage-include', '--test-coverage-exclude', '--test-global-setup', '--test-isolation', '--test-name-pattern',
  '--test-reporter', '--test-reporter-destination', '--test-shard', '--test-skip-pattern', '--test-timeout',
  '--max-old-space-size', '--max-semi-space-size', '--stack-size', '--stack-trace-limit',
  '--logfile', '--trace-file',
]);
// The options whose value is code Node loads before the entrypoint.
const NODE_PRELOAD_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
// After these Node runs no script: the code is their value (-e, -p) or a package.json script (--run).
const NODE_NO_SCRIPT_OPTIONS = new Set(['-e', '--eval', '-p', '--print', '-pe', '-ep', '--run']);
// An entrypoint or a preload of SynaBun's is a code file below the root: .js, .mjs, .cjs or .ts (every one SynaBun
// starts has its extension). The root itself, a folder, a name without an extension, a config or a data file means
// node's options were read wrong, and never makes a process SynaBun's.
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

/**
 * One of node's own arguments as Node reads it: { name, value }. A long
 * option's name ends at the first `=` (`--require=x` carries its value) and
 * its underscores are dashes (`--diagnostic_dir` is `--diagnostic-dir`; V8's
 * options take either spelling too). A short option (`-r`) is its own name.
 */
export function nodeOption(arg) {
  if (!arg.startsWith('--')) return { name: arg, value: null };
  const eq = arg.indexOf('=');
  const name = (eq > 0 ? arg.slice(0, eq) : arg).replace(/_/g, '-');
  return { name, value: eq > 0 ? arg.slice(eq + 1) : null };
}

/**
 * What a node command line runs: { script, preloads }. `script` is the first
 * argument after node's own options (null when there is none: -e, -p, --run, a
 * REPL); `preloads` are the values of -r / --require / --import / --loader.
 * Everything after the script is the script's own arguments and never read.
 */
export function nodeEntrypoint(commandLine) {
  const args = splitWindowsCommandLine(commandLine).slice(1);
  const out = { script: null, preloads: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { out.script = args[i + 1] ?? null; break; }
    if (arg === '-') break;
    if (!arg.startsWith('-')) { out.script = arg; break; }
    const { name, value: inline } = nodeOption(arg);
    if (NODE_NO_SCRIPT_OPTIONS.has(name)) break;
    let value = inline;
    if (value == null && NODE_VALUE_OPTIONS.has(name)) value = args[++i] ?? null;
    else if (value == null && /^\d+(?:\.\d+)?$/.test(args[i + 1] ?? '')) i++;
    if (value != null && NODE_PRELOAD_OPTIONS.has(name)) out.preloads.push(value);
  }
  return out;
}

/**
 * Why a node command line is SynaBun's: { arg, rest, via } (`via` 'script' or
 * 'preload', `rest` what follows the root), or null. Only the entrypoint and
 * the preloads are read (nodeEntrypoint), and only a code file below the root
 * counts (never the root itself or a folder); `rootList` is a list of roots or
 * a createPathMatcher.
 */
export function commandLineReference(commandLine, rootList, { realpath = nativeRealpath, isDirectory = nativeIsDirectory } = {}) {
  const matcher = typeof rootList?.inside === 'function' ? rootList : createPathMatcher(rootList, { realpath, isDirectory });
  if (!matcher.roots.length) return null;
  const { script, preloads } = nodeEntrypoint(commandLine);
  const checks = [...(script ? [[script, 'script']] : []), ...preloads.map(value => [value, 'preload'])];
  for (const [arg, via] of checks) {
    const rest = matcher.inside(arg);
    if (!rest || !CODE_FILE.test(win32.basename(rest)) || matcher.isDirectory(arg)) continue;
    return { arg, rest, via };
  }
  return null;
}

const isNode = (proc) => win32.basename(proc.exe || '').toLowerCase() === 'node.exe' || String(proc.name || '').toLowerCase() === 'node.exe';

// A parent is older than its child: a PID Windows gave again to a newer process is not a parent.
const olderOrUnknown = (parent, child) => parent.created == null || child.created == null || parent.created <= child.created;

/** The PIDs `pid` descends from in `processes`, nearest first. */
function ancestorsOf(pid, byPid) {
  const out = [];
  for (let child = byPid.get(pid); child;) {
    const parent = byPid.get(child.ppid);
    if (!parent || parent.pid === pid || out.includes(parent.pid) || !olderOrUnknown(parent, child)) break;
    out.push(parent.pid);
    child = parent;
  }
  return out;
}

/**
 * The PIDs never to stop: `selfPid`, the processes it descends from (each
 * parent older than its child: a PID Windows gave again to a newer process is
 * not a parent) and the ones it started.
 */
export function protectedPids(processes, selfPid) {
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const out = new Set([selfPid, 0, 4, ...ancestorsOf(selfPid, byPid)]);
  const self = byPid.get(selfPid);
  const descendants = new Set([selfPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of processes) {
      if (descendants.has(proc.pid) || !descendants.has(proc.ppid)) continue;
      const parent = byPid.get(proc.ppid) || self;
      if (parent && !olderOrUnknown(parent, proc)) continue;
      descendants.add(proc.pid);
      out.add(proc.pid);
      grew = true;
    }
  }
  return out;
}

/** What is shown for a process: its program and the path inside the package, the root written as <SynaBun>. */
export function describeProcess(proc, reference = null) {
  const program = proc.name || win32.basename(proc.exe || '') || 'process';
  if (reference) return `${program}${reference.via === 'preload' ? ' (preloads)' : ''} <SynaBun>${reference.rest}`.slice(0, 160);
  return `${program} (runs from <SynaBun>)`;
}

/**
 * The processes to stop, from a process list: [{ pid, ppid, name, created, reason, summary }].
 * `reason` is 'executable' (its program file is inside a root), 'script' (node
 * runs a script inside a root) or 'preload' (node preloads a module inside a root).
 */
export function findPackageProcesses({ processes, roots: rootList, selfPid = process.pid, realpath = nativeRealpath, isDirectory = nativeIsDirectory }) {
  if (!Array.isArray(processes)) return [];
  const matcher = createPathMatcher(rootList, { realpath, isDirectory });
  if (!matcher.roots.length) return [];
  const keep = protectedPids(processes, selfPid);
  const targets = [];
  const target = (proc, reason, reference = null) => ({
    pid: proc.pid, ppid: proc.ppid, name: proc.name, created: proc.created, reason, summary: describeProcess(proc, reference),
  });
  for (const proc of processes) {
    if (keep.has(proc.pid)) continue;
    if (proc.exe && matcher.inside(proc.exe) != null) {
      targets.push(target(proc, 'executable'));
      continue;
    }
    if (!isNode(proc)) continue;
    const reference = commandLineReference(proc.cmd, matcher);
    if (reference) targets.push(target(proc, reference.via, reference));
  }
  return targets;
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};
const pause = (ms) => new Promise(done => setTimeout(done, ms));

// The same process as the target: its PID, with the creation time it had when it was matched.
const sameProcess = (target, list) => {
  if (target.created == null || !Array.isArray(list)) return false;
  return list.some(proc => proc.pid === target.pid && proc.created === target.created);
};

// Why a target is left alone at the kill: sameProcess said no.
const whySkipped = (target, list) => {
  if (!Array.isArray(list)) return 'could not be checked again';
  if (target.created == null) return 'has no creation time to check';
  return list.some(proc => proc.pid === target.pid) ? 'now belongs to another process' : 'has already ended';
};

/**
 * Stop every process of findPackageProcesses and wait (bounded) until they are gone.
 *
 * There is no cheap graceful stop for these from outside: an MCP stdio server
 * ends when its client closes its input, and `taskkill` without /F only posts
 * WM_CLOSE to windows, which a console process has none of. So each one is
 * ended with `taskkill /PID <pid> /T /F` (its own children with it), the
 * outermost first.
 *
 * Right before each kill the processes are listed again (the same fixed
 * script), and a target that has ended, or whose PID now belongs to a process
 * created at another time, is left alone. A target below one that was just
 * ended went with it (/T) and is not killed again: its PID may be someone
 * else's by then.
 *
 * Everything happens before `deadline` (an absolute time; by default
 * STOP_DEADLINE_MS from now): past it no list is read and nothing is killed,
 * and the targets not reached count as remaining while they run.
 *
 * Returns { listed, stopped: [target], remaining: [target], skipped: [target], timedOut }:
 * `skipped` were left alone at the kill (ended, PID reused, or the list could
 * not be read again); `listed` false means the processes could not be listed
 * and nothing was done; `timedOut` that the deadline cut the step short.
 */
export async function stopPackageProcesses({
  roots: rootList, selfPid = process.pid, list = listWindowsProcesses, kill = (pid) => {
    const command = taskkillCommand(pid);
    spawnSync(command.file, command.args, command.options);
  },
  isAlive = pidAlive, sleep = pause, now = Date.now, log = () => {}, waitMs = STOP_WAIT_MS, deadline = null,
  realpath = nativeRealpath, isDirectory = nativeIsDirectory,
} = {}) {
  const until = Number.isFinite(deadline) ? deadline : now() + STOP_DEADLINE_MS;
  const late = () => now() >= until;
  if (late()) return { listed: false, stopped: [], remaining: [], skipped: [], timedOut: true };
  const processes = list();
  if (!Array.isArray(processes)) return { listed: false, stopped: [], remaining: [], skipped: [], timedOut: false };
  const targets = findPackageProcesses({ processes, roots: rootList, selfPid, realpath, isDirectory });
  if (!targets.length) return { listed: true, stopped: [], remaining: [], skipped: [], timedOut: false };
  const byPid = new Map(processes.map(proc => [proc.pid, proc]));
  const ancestry = new Map(targets.map(target => [target.pid, ancestorsOf(target.pid, byPid)]));
  const targetPids = new Set(targets.map(target => target.pid));
  const depth = (target) => ancestry.get(target.pid).filter(pid => targetPids.has(pid)).length;
  const killed = new Set();
  const skipped = [];
  // The list each kill is checked against; read again after every kill.
  let current = null;
  let timedOut = false;
  for (const target of [...targets].sort((a, b) => depth(a) - depth(b))) {
    if (ancestry.get(target.pid).some(pid => killed.has(pid))) continue;
    if (late()) { timedOut = true; break; }
    if (!current) current = list();
    if (!sameProcess(target, current)) {
      skipped.push(target);
      log(`  PID ${target.pid} ${whySkipped(target, current)}, left alone: ${target.summary}`);
      continue;
    }
    log(`  Stopping PID ${target.pid}: ${target.summary}`);
    kill(target.pid);
    killed.add(target.pid);
    current = null;
  }
  const watched = targets.filter(target => !skipped.includes(target));
  const waitUntil = Math.min(now() + waitMs, until);
  let remaining = watched.filter(target => isAlive(target.pid));
  while (remaining.length && now() < waitUntil) {
    await sleep(250);
    remaining = remaining.filter(target => isAlive(target.pid));
  }
  if (remaining.length && late()) timedOut = true;
  // A PID still in use may be another process's by now: only the same process counts as remaining.
  if (remaining.length && !late()) {
    const after = list();
    if (Array.isArray(after)) remaining = remaining.filter(target => sameProcess(target, after));
  }
  return { listed: true, stopped: watched.filter(target => !remaining.includes(target)), remaining, skipped, timedOut };
}

/**
 * The lock code (EPERM, EBUSY, ENOTEMPTY) a failed npm reported, or null.
 * npm's last `error code X` in its debug log decides when it is there, whatever
 * X is (a lifecycle script's `error code 1` is no lock, even with an EPERM
 * cleanup warning before it). Without one: the stack of the error npm failed
 * with (`verbose stack Error: EBUSY: resource busy or locked, rename`), then
 * its exit status (npm exits with the errno: -4082 for EBUSY, read back as
 * 4294963214 by a 32-bit unsigned exit code).
 */
export function npmLockCode({ status = null, logText = '' } = {}) {
  const codes = Object.keys(WINDOWS_LOCK_ERRNO);
  const text = String(logText || '');
  const verdicts = [...text.matchAll(/^[ \t]*(?:\d+ )?(?:npm )?(?:error|ERR!) code (\S+)/gm)];
  if (verdicts.length) {
    const verdict = verdicts.at(-1)[1];
    return codes.includes(verdict) ? verdict : null;
  }
  const stack = new RegExp(`^[ \\t]*(?:\\d+ )?(?:npm )?(?:verbose stack (?:[\\w.]*Error: )?|error |ERR! )(${codes.join('|')}): `, 'm').exec(text);
  if (stack) return stack[1];
  if (Number.isFinite(status)) {
    const signed = status > 0x7fffffff ? status - 0x100000000 : status;
    for (const [code, errno] of Object.entries(WINDOWS_LOCK_ERRNO)) if (signed === errno) return code;
  }
  return null;
}

/** An npm run, as the retry loop sees it: { ok, status, signal, error, logFile, lockCode }. */
export function npmOutcome(result, { logsDir = null, startedAt = 0, readFile = readFileSync } = {}) {
  const ok = !result.error && result.status === 0;
  const logFile = ok ? null : newestDebugLog(logsDir, startedAt);
  let logText = '';
  if (logFile) { try { logText = readFile(logFile, 'utf8'); } catch {} }
  return {
    ok,
    status: result.status ?? null,
    signal: result.signal || null,
    error: result.error ? (result.error.code || result.error.message) : null,
    logFile,
    lockCode: ok || result.error ? null : npmLockCode({ status: result.status, logText }),
  };
}

/**
 * Run npm; when it fails because a file in the folder is in use, stop
 * SynaBun's processes again (an AI client may have started its MCP server
 * again) and run it again, at most `retries` more times. A stop that reached
 * its deadline (`{ timedOut: true }`) ends the retries there.
 * Returns the last outcome plus { attempts, locked, timedOut } (locked: still a lock failure at the end).
 */
export async function installWithLockRetries({ install, stop, retries = LOCK_RETRIES, log = () => {} }) {
  for (let attempt = 1; ; attempt++) {
    const outcome = await install(attempt);
    if (outcome.ok || !outcome.lockCode || attempt > retries) {
      return { ...outcome, attempts: attempt, locked: !outcome.ok && !!outcome.lockCode, timedOut: false };
    }
    log(`\nnpm could not replace the SynaBun folder (${outcome.lockCode}): something still runs from it. Stopping SynaBun's processes again, then retry ${attempt} of ${retries}.`);
    const stopped = await stop(attempt);
    if (stopped?.timedOut) return { ...outcome, attempts: attempt, locked: true, timedOut: true };
  }
}

// ═══════════════════════════════════════════
// SynaBun — where the user's Claude Code, Codex and OpenCode are
// ═══════════════════════════════════════════
//
// One answer for every place that looks for one of these CLIs: the version
// check behind the side panels' banner and the update badges
// (GET /api/system/tool-versions), Settings' Detect button, the one-click
// install's final check (cli-install.js), and every launcher in server.js
// (getClaudeBin, getCodexBin, the `opencode serve` launches, terminal tabs,
// update commands). Detection, the banner, launching and updates therefore
// always mean the same file.
//
// Resolution order per tool. The first candidate that exists AND answers
// `--version` wins:
//
//   configured      cli-config.json, Settings > Terminal: a file path (~ is
//                   the home folder), or a command name looked up like PATH
//   path            the PATH this process was given, then the OS PATH a new
//                   terminal would have now (os-path.js: the registry on
//                   Windows, the login shell on macOS and Linux)
//   known-location  the folders each install method uses on this system:
//                   the vendors' own (toolSpecificFiles) first, then every
//                   package manager's (augmented-path.js knownInstallDirs)
//
// Never a file inside SynaBun's own install or runtime folders
// (`isInsideSynabun`), never a dependency's `node_modules/.bin` command, never
// a Windows app alias in WindowsApps (an older Claude Desktop registers a
// `claude.exe` there that opens the desktop app). On Windows a folder is
// searched in PATHEXT order (.exe before .cmd/.bat, then .ps1; an
// extensionless file is never a Windows program), and an npm command file is
// followed to the program it runs (claude.exe, Codex's vendored codex.exe,
// OpenCode's opencode.exe) so that nothing needs a shell to start it; one that
// cannot be followed is run through cmd.exe with every word escaped.
//
// A status has three states: installed (path, version, how it was found, the
// install method), missing, and broken: found, but `--version` failed, with
// the real error. Versions are cached per file identity (real path, size,
// mtime), so an update is probed again by itself; `force` (Re-check) reads the
// OS PATH again and probes everything again.
//
// Every dependency is injectable, so Windows, Linux and macOS resolution is
// tested from any host. Nothing here throws.

import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgetAugmentedPath, knownInstallDirs, withPathEnv, getAugmentedPath, pathEnvValue } from './augmented-path.js';
import { detectInstallSourceOf } from './cli-update-planner.js';
import { windowsClaudeTargets } from './claude-executable.js';
import { resolveTrustedWindowsCodexBinary, windowsCodexPackageJsonCandidates } from './codex-runtime-path.js';
import { osPath as defaultOsPath } from './os-path.js';

export const CLI_TOOLS = Object.freeze({
  'claude-code': Object.freeze({ key: 'claude-code', command: 'claude', label: 'Claude Code' }),
  codex: Object.freeze({ key: 'codex', command: 'codex', label: 'Codex' }),
  opencode: Object.freeze({ key: 'opencode', command: 'opencode', label: 'OpenCode' }),
  gemini: Object.freeze({ key: 'gemini', command: 'gemini', label: 'Gemini CLI' }),
});

const PROBE_TIMEOUT_MS = 15_000;
const LAUNCH_MEMO_MS = 3_000;
const FAILURE_REPROBE_MS = 60_000;   // a failed --version is asked again by a plain check after this
const FAILURE_KEEP_MS = 10 * 60_000; // launchers skip a known failure for this long (or until the file changes)
const MAX_PROBES = 6;
const LAUNCHABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function homeOf(env, platform) {
  if (platform === 'win32') return env.USERPROFILE || env.HOME || os.homedir();
  return env.HOME || os.homedir();
}

// ── Names, places, launch specs (pure) ─────────────────────────────────────

/**
 * The file names a command has on Windows, in the order Windows tries them:
 * PATHEXT's own order, kept to the extensions a program can be started from
 * (.com .exe .bat .cmd), then a PowerShell script.
 */
export function windowsCommandNames(command, pathext = '') {
  const listed = String(pathext || '.COM;.EXE;.BAT;.CMD').split(';')
    .map(ext => ext.trim().toLowerCase())
    .filter(ext => LAUNCHABLE_EXTENSIONS.includes(ext));
  const order = [...new Set(listed.length ? listed : LAUNCHABLE_EXTENSIONS)];
  return [...order.map(ext => `${command}${ext}`), `${command}.ps1`];
}

/** A PATH folder that is a dependency's commands, never the user's tool. */
export function isPackageBinDir(dir) {
  return /[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(String(dir || ''));
}

/** A Windows app alias folder (zero-byte reparse points that start a Store/desktop app). */
export function isWindowsAppsDir(file) {
  return /[\\/]microsoft[\\/]windowsapps([\\/]|$)/i.test(String(file || ''));
}

function listDir(readdir, dir) {
  try { return readdir(dir).map(String).slice(0, 300); } catch { return []; }
}

/**
 * WinGet installs a portable package under
 * %LOCALAPPDATA%\Microsoft\WinGet\Packages\<Publisher.Id>_<source>\ and links
 * it from WinGet\Links (a known folder). The package folder is looked in too,
 * for a link that is missing.
 */
function wingetPackageFiles({ localAppData, prefixes, exe, readdir, pathImpl }) {
  const root = pathImpl.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  const out = [];
  for (const name of listDir(readdir, root)) {
    const lower = name.toLowerCase();
    if (!prefixes.some(prefix => lower.startsWith(prefix))) continue;
    const dir = pathImpl.join(root, name);
    out.push(pathImpl.join(dir, exe));
    for (const sub of listDir(readdir, dir).slice(0, 20)) out.push(pathImpl.join(dir, sub, exe));
  }
  return out;
}

/**
 * The vendors' own install locations for one tool (before every package
 * manager's folders), checked against their installers and docs on
 * 2026-10-17:
 *
 *   Claude Code   native installer: ~/.local/bin/claude, %USERPROFILE%\.local\bin\claude.exe
 *                 (a known folder); the older local install ~/.claude/local/claude;
 *                 WinGet Anthropic.ClaudeCode
 *   Codex         standalone installer: $CODEX_INSTALL_DIR, else ~/.local/bin/codex
 *                 (macOS, Linux) or %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe,
 *                 each a link into $CODEX_HOME/packages/standalone/current/bin
 *   OpenCode      install script: ~/.opencode/bin/opencode (older scripts:
 *                 $OPENCODE_INSTALL_DIR, $XDG_BIN_DIR); on Windows the folder
 *                 SynaBun's own install uses, %USERPROFILE%\.opencode\bin
 */
export function toolSpecificFiles(toolKey, {
  platform = process.platform,
  env = process.env,
  home = homeOf(env, platform),
  readdir = readdirSync,
} = {}) {
  const pathImpl = pathFor(platform);
  const join = (...parts) => pathImpl.join(...parts);
  const windows = platform === 'win32';
  const exe = (name) => (windows ? `${name}.exe` : name);
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const out = [];
  const add = (file, via) => { if (file) out.push({ file, via }); };
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  switch (toolKey) {
    case 'claude-code':
      add(join(home, '.local', 'bin', exe('claude')), 'native');
      if (!windows) add(join(home, '.claude', 'local', 'claude'), 'native');
      if (windows) for (const file of wingetPackageFiles({ localAppData, prefixes: ['anthropic.claudecode'], exe: 'claude.exe', readdir, pathImpl })) add(file, 'winget');
      break;
    case 'codex':
      if (env.CODEX_INSTALL_DIR) add(join(env.CODEX_INSTALL_DIR, exe('codex')), 'standalone');
      add(windows ? join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : join(home, '.local', 'bin', 'codex'), 'standalone');
      add(join(codexHome, 'packages', 'standalone', 'current', 'bin', exe('codex')), 'standalone');
      add(join(codexHome, 'packages', 'standalone', 'current', exe('codex')), 'standalone');
      if (windows) for (const file of wingetPackageFiles({ localAppData, prefixes: ['openai.codex'], exe: 'codex.exe', readdir, pathImpl })) add(file, 'winget');
      break;
    case 'opencode':
      add(join(home, '.opencode', 'bin', exe('opencode')), 'standalone');
      if (env.OPENCODE_INSTALL_DIR) add(join(env.OPENCODE_INSTALL_DIR, exe('opencode')), 'standalone');
      if (env.XDG_BIN_DIR) add(join(env.XDG_BIN_DIR, exe('opencode')), 'standalone');
      if (windows) for (const file of wingetPackageFiles({ localAppData, prefixes: ['sst.opencode', 'anomalyco.opencode', 'opencode.'], exe: 'opencode.exe', readdir, pathImpl })) add(file, 'winget');
      break;
    default:
      break;
  }
  return out;
}

/**
 * What a value in Settings > Terminal means: a file path, a command name, or
 * a command line (which terminal tabs run as written but nothing can resolve
 * to a file). The tool's own name is "not configured".
 */
export function describeConfigured(value, toolKey, {
  platform = process.platform,
  env = process.env,
  home = homeOf(env, platform),
  exists = existsSync,
} = {}) {
  const raw = String(value || '').trim();
  const tool = CLI_TOOLS[toolKey];
  if (!raw || !tool || raw === tool.command) return null;
  const pathImpl = pathFor(platform);
  let text = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) text = pathImpl.join(home, text.slice(1));
  if (exists(text)) return { value: raw, kind: 'path', file: pathImpl.normalize(text) };
  if (/\s/.test(text)) return { value: raw, kind: 'command-line' };
  const hasSeparator = text.includes('/') || (platform === 'win32' && text.includes('\\'));
  if (hasSeparator) return { value: raw, kind: 'path', file: pathImpl.normalize(text) };
  return { value: raw, kind: 'command', name: text };
}

/** OpenCode's npm package: its command file runs node_modules\opencode-ai\bin\opencode.exe, the platform build its postinstall put there. */
export function windowsOpencodeTargets(launcher, arch = process.arch) {
  const pathImpl = path.win32;
  const folder = pathImpl.dirname(String(launcher || ''));
  const roots = [pathImpl.join(folder, 'node_modules')];
  if (pathImpl.basename(folder).toLowerCase() === '.bin') roots.push(pathImpl.dirname(folder));
  const platformPackages = arch === 'x64' ? ['opencode-windows-x64', 'opencode-windows-x64-baseline'] : [`opencode-windows-${arch}`];
  return roots.flatMap(root => [
    pathImpl.join(root, 'opencode-ai', 'bin', 'opencode.exe'),
    ...platformPackages.flatMap(name => [
      pathImpl.join(root, 'opencode-ai', 'node_modules', name, 'bin', 'opencode.exe'),
      pathImpl.join(root, name, 'bin', 'opencode.exe'),
    ]),
  ]);
}

/** A Windows program begins with "MZ" (OpenCode's npm placeholder is a shell script). Reads two bytes: a CLI can be 200 MB. */
export function isPortableExecutable(file) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x4d && head[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (fd != null) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/**
 * How a found file is started without a shell.
 *
 *   direct       the file itself (every POSIX file; a Windows .exe/.com; an
 *                npm command file followed to the .exe it runs)
 *   node-script  a JavaScript entry run by the Node running SynaBun (an old
 *                npm Claude Code's cli.js)
 *   powershell   a .ps1, through powershell.exe -File
 *   cmd          a .cmd/.bat that could not be followed: cmd.exe, escaped
 *   unsupported  nothing Windows can start (an extensionless shell script)
 */
export function launchSpecFor(file, toolKey, {
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  exists = existsSync,
  isExecutableFile = isPortableExecutable,
  resolvePlatformPackage,
  acceptBinary = () => true,
} = {}) {
  if (platform !== 'win32') return { kind: 'direct', file, launchPath: file };
  const ext = path.win32.extname(file).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { kind: 'direct', file, launchPath: file };
  if (ext === '.ps1') return { kind: 'powershell', file, launchPath: file };
  if (ext !== '.cmd' && ext !== '.bat') return { kind: 'unsupported', file, launchPath: null };

  let rejectedBinary = false;
  const acceptTarget = (target) => {
    if (acceptBinary(target)) return true;
    rejectedBinary = true;
    return false;
  };
  if (toolKey === 'claude-code') {
    for (const target of windowsClaudeTargets(file)) {
      if (!exists(target) || !acceptTarget(target)) continue;
      if (/\.exe$/i.test(target)) return { kind: 'direct', file, launchPath: target, via: 'npm-package' };
      return { kind: 'node-script', file, launchPath: target, via: 'npm-package' };
    }
  } else if (toolKey === 'codex') {
    const found = resolveTrustedWindowsCodexBinary({
      launchers: [file],
      codexPackageJsonPaths: windowsCodexPackageJsonCandidates({ appData: env.APPDATA, npmConfigPrefix: env.NPM_CONFIG_PREFIX || env.npm_config_prefix }),
      arch,
      exists,
      acceptBinary: acceptTarget,
      ...(resolvePlatformPackage ? { resolvePlatformPackage } : {}),
    });
    if (found.path) return { kind: 'direct', file, launchPath: found.path, via: found.source };
  } else if (toolKey === 'opencode') {
    // The package's bin\opencode.exe is a placeholder script until its postinstall ran: only a real program counts.
    const target = windowsOpencodeTargets(file, arch).find(candidate => exists(candidate) && acceptTarget(candidate) && isExecutableFile(candidate));
    if (target) return { kind: 'direct', file, launchPath: target, via: 'npm-package' };
  }
  // Do not fall back to executing a shim whose known target is SynaBun's copy.
  if (rejectedBinary) return { kind: 'unsupported', file, launchPath: null, rejectedReason: 'inside-synabun' };
  return { kind: 'cmd', file, launchPath: file };
}

// cmd.exe quoting, as cross-spawn does it: every metacharacter escaped with ^,
// the arguments of a command file twice (the file hands them on with %*).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function cmdEscapeCommand(file) {
  return String(file).replace(CMD_META, '^$1');
}

export function cmdEscapeArgument(value, doubleEscape = true) {
  let arg = String(value);
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1');
  arg = `"${arg}"`.replace(CMD_META, '^$1');
  return doubleEscape ? arg.replace(CMD_META, '^$1') : arg;
}

/** The program, its arguments and the spawn options that start `spec` with `args`, never through a shell of ours. */
export function spawnArgsFor(spec, args = [], { env = process.env, execPath = process.execPath } = {}) {
  const list = args.map(String);
  switch (spec?.kind) {
    case 'node-script':
      return { command: execPath, args: [spec.launchPath, ...list], options: {} };
    case 'powershell': {
      const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
      const shell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return { command: shell, args: ['-NoProfile', '-NonInteractive', '-File', spec.launchPath, ...list], options: {} };
    }
    case 'cmd': {
      const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
      const comspec = env.ComSpec || env.COMSPEC || path.win32.join(root, 'System32', 'cmd.exe');
      const line = [cmdEscapeCommand(spec.launchPath), ...list.map(arg => cmdEscapeArgument(arg, true))].join(' ');
      return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
    }
    default:
      return { command: spec?.launchPath || spec?.file, args: list, options: {} };
  }
}

// ── --version ───────────────────────────────────────────────────────────────

/** "2.1.302 (Claude Code)" → "2.1.302"; "codex-cli 0.163.0" → "0.163.0"; a prerelease suffix is kept. */
export function parseCliVersion(text) {
  const match = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/);
  return match ? `${match[1]}.${match[2]}.${match[3]}${match[4] || ''}` : null;
}

function firstLines(text, count = 3) {
  return String(text || '').split(/\r?\n/).map(line => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter(Boolean).slice(0, count).join(' · ').slice(0, 400);
}

/**
 * Run `<spec> --version` and read the answer: { ok, version, output, error }.
 * `error` is a sentence about what went wrong, with what the CLI printed. The
 * CLI runs in a process group of its own (POSIX); its whole group/tree is stopped at
 * the timeout: a CLI that hangs, or leaves a child holding its output open,
 * never holds a check up longer than `timeoutMs`.
 */
export function probeVersion(spec, {
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  spawnImpl = spawn,
  execPath = process.execPath,
  cwd = os.tmpdir(),
  platform = process.platform,
} = {}) {
  return new Promise((resolve) => {
    if (!spec || spec.kind === 'unsupported') {
      resolve({ ok: false, version: null, output: '', error: 'Windows cannot start this file: it has no program extension (.exe, .cmd).' });
      return;
    }
    const { command, args, options } = spawnArgsFor(spec, ['--version'], { env, execPath });
    const childEnv = { ...withPathEnv(env, pathEnvValue(env), platform), NO_COLOR: '1', TERM: 'dumb' };
    delete childEnv.FORCE_COLOR;
    let child;
    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;
    let stopped = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = () => {
      if (stopped || !child?.pid) return;
      stopped = true;
      const killChild = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
      if (platform === 'win32') {
        // Keep cmd.exe alive until taskkill has enumerated the descendants.
        try {
          const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', killChild);
          killer.on('close', (code) => { if (code !== 0) killChild(); });
        } catch { killChild(); }
        return;
      }
      if (platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* not a group */ } }
      killChild();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      const said = firstLines(err) || firstLines(out);
      const message = `did not answer --version within ${Math.max(1, Math.round(timeoutMs / 1000))} s`;
      finish({ ok: false, version: parseCliVersion(out), output: said, error: said ? `${message}: ${said}` : message });
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawnImpl(command, args, {
        ...options,
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
      });
    } catch (error) {
      finish({ ok: false, version: null, output: '', error: `could not be started (${error?.code || error?.message || error})` });
      return;
    }
    const cap = (text, chunk) => (text.length > 64 * 1024 ? text : text + chunk);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { out = cap(out, chunk); });
    child.stderr?.on('data', (chunk) => { err = cap(err, chunk); });
    child.on('error', (error) => {
      const code = error?.code || 'error';
      const message = String(error?.message || '');
      finish({ ok: false, version: null, output: '', error: `could not be started (${message && message !== code ? `${code}: ${message}` : code})` });
    });
    child.on('exit', (code, signal) => {
      // What it printed may still be on its way: read it when the streams end (or soon after: a child of
      // the CLI may hold them open, and is then stopped with the group).
      let fallback = null;
      let read = false;
      const done = () => {
        if (timedOut || read) return;
        read = true;
        clearTimeout(fallback);
        if (code === 0) {
          const version = parseCliVersion(out) || parseCliVersion(err) || firstLines(out, 1).slice(0, 40) || 'unknown';
          finish({ ok: true, version, output: firstLines(out || err), error: null });
          return;
        }
        const message = signal
          ? `was stopped by ${signal} as it started${signal === 'SIGKILL' ? ' (on macOS: Gatekeeper or a code signature refused it)' : ''}`
          : `exited with code ${code}`;
        const said = firstLines(err) || firstLines(out);
        finish({ ok: false, version: parseCliVersion(out), output: said, error: said ? `${message}: ${said}` : message });
      };
      let pending = 2;
      const one = () => { if (--pending === 0) done(); };
      fallback = setTimeout(() => { stop(); done(); }, 300);
      fallback.unref?.();
      if (child.stdout && !child.stdout.readableEnded) child.stdout.once('end', one); else one();
      if (child.stderr && !child.stderr.readableEnded) child.stderr.once('end', one); else one();
    });
  });
}

// ── The resolver ────────────────────────────────────────────────────────────

function defaultIsLaunchable(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Why a configured file cannot be a candidate, or null when it can. */
function configuredFileProblem(file, platform, { stat, access }) {
  let info;
  try { info = stat(file); } catch { return 'not found'; }
  if (typeof info?.isFile === 'function' && !info.isFile()) return 'not a file';
  if (platform !== 'win32') {
    try { access(file, constants.X_OK); } catch { return 'not executable by this user'; }
  }
  return null;
}

function fileIdentity(file, { realpath, stat }) {
  try {
    const real = realpath(file);
    const info = stat(real);
    return `${real}|${info.mtimeMs}|${info.size}`;
  } catch {
    return String(file);
  }
}

/**
 * @param {object} deps
 * @param {(file: string) => boolean} [deps.isInsideSynabun]  SynaBun's own install/runtime folders
 * @param {(toolKey: string) => (string|null)} [deps.configured]  the Settings value (cli-config.json)
 * @param {object} [deps.osPath]  os-path.js reader ({ cached, refresh, stale, snapshot })
 */
export function createCliResolver({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  home = homeOf(env, platform),
  isInsideSynabun = () => false,
  configured = () => null,
  osPath = defaultOsPath,
  probe = probeVersion,
  exists = existsSync,
  isLaunchable = defaultIsLaunchable,
  readdir = readdirSync,
  readFile = readFileSync,
  realpath = realpathSync,
  stat = statSync,
  access = accessSync,
  resolvePlatformPackage,
  isExecutableFile,
  now = Date.now,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  maxProbes = MAX_PROBES,
  log = () => {},
} = {}) {
  const pathImpl = pathFor(platform);
  const windows = platform === 'win32';
  const versions = new Map();   // launch identity → { at, result }
  const launchMemo = new Map(); // toolKey → { at, value }
  const lastStatus = new Map(); // toolKey → status
  const background = new Map(); // toolKey → promise
  const pathOnly = () => env.SYNABUN_TOOL_DISCOVERY === 'path';

  const searchDirs = (osEntries) => {
    const delimiter = windows ? ';' : ':';
    const inherited = String(pathEnvValue(env)).split(delimiter);
    const list = pathOnly() ? inherited : [...inherited, ...osEntries];
    const seen = new Set();
    return list.filter((dir) => {
      const text = String(dir || '').trim();
      if (!text || isPackageBinDir(text)) return false;
      const key = windows ? text.toLowerCase().replace(/[\\/]+$/, '') : text.replace(/\/+$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const namesOf = (command) => (windows ? windowsCommandNames(command, env.PATHEXT) : [command]);

  /** Every candidate for a tool, in resolution order, each file once (by what it really is). */
  function collect(toolKey, { osEntries = osPath.cached(), configuredValue } = {}) {
    const tool = CLI_TOOLS[toolKey];
    const out = [];
    const rejected = [];
    const seen = new Set();
    const settings = describeConfigured(configuredValue === undefined ? safeConfigured(toolKey) : configuredValue, toolKey, { platform, env, home, exists });
    const consider = (file, foundBy, via) => {
      if (!file) return;
      const normal = pathImpl.normalize(file);
      if (!isLaunchable(normal, platform)) return;
      let id;
      try { id = realpath(normal); } catch { id = normal; }
      if (windows) id = id.toLowerCase();
      if (seen.has(id)) return;
      seen.add(id);
      if (windows && isWindowsAppsDir(normal)) { rejected.push({ path: normal, reason: 'windows-app-alias' }); return; }
      if (isInsideSynabun(normal)) { rejected.push({ path: normal, reason: 'inside-synabun' }); return; }
      out.push({ file: normal, foundBy, via });
    };
    const dirs = searchDirs(osEntries);

    if (settings?.kind === 'path') consider(settings.file, 'configured', 'settings');
    else if (settings?.kind === 'command') {
      for (const dir of dirs) for (const name of namesOf(settings.name)) consider(pathImpl.join(dir, name), 'configured', 'settings');
      if (!pathOnly()) for (const { dir } of knownInstallDirs({ platform, env, home, readdir, readFile })) for (const name of namesOf(settings.name)) consider(pathImpl.join(dir, name), 'configured', 'settings');
    }
    for (const dir of dirs) for (const name of namesOf(tool.command)) consider(pathImpl.join(dir, name), 'path', 'path');
    if (!pathOnly()) {
      for (const { file, via } of toolSpecificFiles(toolKey, { platform, env, home, readdir })) consider(file, 'known-location', via);
      for (const { dir, via } of knownInstallDirs({ platform, env, home, readdir, readFile })) for (const name of namesOf(tool.command)) consider(pathImpl.join(dir, name), 'known-location', via);
    }
    return { candidates: out, rejected, settings };
  }

  function safeConfigured(toolKey) {
    try { return configured(toolKey) ?? null; } catch { return null; }
  }

  const specOf = (candidate, toolKey) => launchSpecFor(candidate.file, toolKey, { platform, arch, env, exists, acceptBinary: (file) => !isInsideSynabun(file), ...(resolvePlatformPackage ? { resolvePlatformPackage } : {}), ...(isExecutableFile ? { isExecutableFile } : {}) });

  const versionKey = (spec) => `${spec.kind}|${fileIdentity(spec.launchPath || spec.file, { realpath, stat })}|${spec.kind === 'direct' ? '' : fileIdentity(spec.file, { realpath, stat })}`;

  async function probeCached(spec, { force = false } = {}) {
    const key = versionKey(spec);
    const hit = versions.get(key);
    const age = hit ? now() - hit.at : Infinity;
    if (!force && hit && (hit.result.ok || age < FAILURE_REPROBE_MS)) return hit.result;
    const result = await probe(spec, { env: withPathEnv(env, getAugmentedPath({ platform, env, osPath: osPath.cached() }), platform), timeoutMs: probeTimeoutMs });
    versions.set(key, { at: now(), result });
    return result;
  }

  function realOf(file) {
    try { return realpath(file); } catch { return file; }
  }

  function configuredStatus(settings, winner, tried) {
    if (!settings) return null;
    if (settings.kind === 'command-line') {
      return { value: settings.value, ok: null, error: 'a command line: terminal tabs run it as written, everything else looks for the CLI elsewhere' };
    }
    if (winner?.foundBy === 'configured') return { value: settings.value, ok: true, error: null };
    if (settings.kind === 'path') {
      const problem = configuredFileProblem(settings.file, platform, { stat, access });
      if (problem) return { value: settings.value, ok: false, error: problem };
      if (isInsideSynabun(settings.file)) return { value: settings.value, ok: false, error: 'inside SynaBun, not an installation of the CLI' };
      const own = tried.find(item => item.foundBy === 'configured');
      return { value: settings.value, ok: false, error: own?.error || 'did not answer --version' };
    }
    const own = tried.find(item => item.foundBy === 'configured');
    return { value: settings.value, ok: false, error: own?.error || 'not found on PATH or in the known install folders' };
  }

  function statusOf(toolKey, state, { candidate = null, spec = null, result = null, settings = null, rejected = [], tried = [] } = {}) {
    const realPath = candidate ? realOf(candidate.file) : null;
    const snapshot = typeof osPath.snapshot === 'function' ? osPath.snapshot() : null;
    return {
      tool: toolKey,
      label: CLI_TOOLS[toolKey]?.label || toolKey,
      state,
      version: result?.version || null,
      path: candidate?.file || null,
      launchPath: spec?.launchPath || null,
      launchKind: spec?.kind || null,
      realPath,
      foundBy: candidate?.foundBy || null,
      via: candidate?.via || null,
      installSource: candidate ? detectInstallSourceOf({ path: candidate.file, realPath }) : 'unknown',
      error: state === 'broken' ? (result?.error || 'did not answer --version') : null,
      configured: configuredStatus(settings, state === 'installed' ? candidate : null, tried),
      candidates: tried.slice(0, 8),
      rejected: rejected.slice(0, 5),
      osPath: snapshot ? { source: snapshot.source, ok: snapshot.ok, error: snapshot.error } : null,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  /** The full answer for one tool: every candidate in order, probed until one answers. */
  async function resolve(toolKey, { force = false, configured: configuredValue, freshOsPath = false } = {}) {
    if (!CLI_TOOLS[toolKey]) return statusOf(toolKey, 'missing');
    if (force) {
      if (!freshOsPath) { try { await osPath.refresh({ force: true }); } catch { /* the old answer stays */ } }
      forgetAugmentedPath();
      launchMemo.delete(toolKey);
    } else if (typeof osPath.stale === 'function' && osPath.stale()) {
      try { await osPath.refresh(); } catch { /* the old answer stays */ }
    }
    const { candidates, rejected, settings } = collect(toolKey, { osEntries: osPath.cached(), configuredValue });
    const tried = [];
    let failure = null;
    for (const candidate of candidates) {
      if (tried.length >= maxProbes) break;
      const spec = specOf(candidate, toolKey);
      if (spec.rejectedReason) {
        rejected.push({ path: candidate.file, reason: spec.rejectedReason });
        continue;
      }
      const result = await probeCached(spec, { force });
      tried.push({ path: candidate.file, foundBy: candidate.foundBy, ok: result.ok, version: result.version || null, error: result.error || null });
      if (result.ok) {
        const status = statusOf(toolKey, 'installed', { candidate, spec, result, settings, rejected, tried });
        if (configuredValue === undefined) { lastStatus.set(toolKey, status); launchMemo.delete(toolKey); }
        return status;
      }
      if (!failure) failure = { candidate, spec, result };
    }
    const status = failure
      ? statusOf(toolKey, 'broken', { ...failure, settings, rejected, tried })
      : statusOf(toolKey, 'missing', { settings, rejected, tried });
    if (configuredValue === undefined) { lastStatus.set(toolKey, status); launchMemo.delete(toolKey); }
    return status;
  }

  async function resolveAll(keys = Object.keys(CLI_TOOLS), { force = false } = {}) {
    if (force) {
      try { await osPath.refresh({ force: true }); } catch { /* the old answer stays */ }
      forgetAugmentedPath();
      launchMemo.clear();
    }
    const entries = await Promise.all(keys.map(async key => [key, await resolve(key, { force, freshOsPath: force })]));
    return Object.fromEntries(entries);
  }

  function inBackground(toolKey) {
    if (background.has(toolKey)) return;
    const run = resolve(toolKey).catch(() => null).finally(() => background.delete(toolKey));
    background.set(toolKey, run);
  }

  /**
   * What a launcher starts, at once (no process is started here): the same
   * candidates in the same order, skipping any whose --version is known to
   * fail. A candidate not probed yet is taken as it is, and the full check
   * runs in the background so that the next launch knows. All known to fail:
   * the first is answered as `broken`, so the launch fails with its own error
   * rather than "not installed".
   */
  function launcher(toolKey) {
    const osKey = osPath.cached().join('\0');
    const memo = launchMemo.get(toolKey);
    if (memo && memo.osKey === osKey && now() - memo.at < LAUNCH_MEMO_MS) return memo.value;
    let value = { tool: toolKey, path: null, launchPath: null, spec: null, foundBy: null, version: null, state: 'missing' };
    if (CLI_TOOLS[toolKey]) {
      const { candidates } = collect(toolKey);
      let firstFailed = null;
      let unprobed = false;
      for (const candidate of candidates) {
        const spec = specOf(candidate, toolKey);
        if (spec.kind === 'unsupported') continue;
        const hit = versions.get(versionKey(spec));
        if (hit && !hit.result.ok && now() - hit.at < FAILURE_KEEP_MS) {
          if (!firstFailed) firstFailed = { candidate, spec, hit };
          continue;
        }
        if (!hit) unprobed = true;
        value = { tool: toolKey, path: candidate.file, launchPath: spec.launchPath, spec, foundBy: candidate.foundBy, version: hit?.result?.version || null, state: hit?.result?.ok ? 'installed' : 'unverified' };
        break;
      }
      if (!value.path && firstFailed) {
        value = { tool: toolKey, path: firstFailed.candidate.file, launchPath: firstFailed.spec.launchPath, spec: firstFailed.spec, foundBy: firstFailed.candidate.foundBy, version: firstFailed.hit.result.version || null, state: 'broken', error: firstFailed.hit.result.error };
      }
      if (unprobed) inBackground(toolKey);
    }
    launchMemo.set(toolKey, { at: now(), osKey, value });
    return value;
  }

  /** Forget what was found: the next answer reads the OS PATH and probes again. */
  function invalidate() {
    versions.clear();
    launchMemo.clear();
    lastStatus.clear();
    forgetAugmentedPath();
    try { osPath.invalidate?.(); } catch { /* nothing to forget */ }
  }

  return {
    resolve,
    resolveAll,
    launcher,
    invalidate,
    last: (toolKey) => lastStatus.get(toolKey) || null,
    candidates: (toolKey, options) => collect(toolKey, options),
    spawnArgs: (spec, args) => spawnArgsFor(spec, args, { env }),
  };
}

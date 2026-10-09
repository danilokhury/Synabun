/**
 * SynaBun — the Start Server bridge
 *
 * The offline page cannot ask a server that is down to start itself, so it
 * hands the operating system a synabun://start link. This module owns both
 * ends of that hand-off:
 *
 *   registration — what each OS needs to route synabun:// to launcher.mjs
 *                  (HKCU registry on Windows, ~/.synabun/SynaBun.app on macOS,
 *                  a .desktop entry on Linux). Written by postinstall.js, by
 *                  setup.js on every start and by the server at boot, so npm
 *                  and GitHub installs, new or old, end up the same.
 *   launch       — what launcher.mjs does when the OS runs it: nothing if the
 *                  server already answers or a start is under way, otherwise
 *                  the normal supervisor (setup.js), once.
 *
 *   progress     — a launch says what it has actually seen happen (itself
 *                  running, the Terminal asked to open, the supervisor's own
 *                  phases, the server answering) on a loopback beacon the
 *                  offline page reads, because that page has no server to ask.
 *
 * Nothing here stays running: the OS starts the launcher per click and it
 * exits once the server answers.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataHome, getPlatformDataHome, pathIsInside } from './paths.js';
import { readPackagedRuntime } from './packaged-runtime.js';

export const START_PROTOCOL = 'synabun';
/** 1 was the handler that ran setup.js directly (no lock, no health check). */
export const LAUNCHER_REVISION = 2;
export const DEFAULT_PORT = 3344;

const BUNDLE_ID = 'ai.synabun.launcher';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
const WIN_KEY = 'HKCU\\Software\\Classes\\synabun';

/** A start that has not answered after this long no longer blocks a new one. */
export const LOCK_TTL_MS = 10 * 60 * 1000;
export const SUPERVISOR_TTL_MS = 15 * 60 * 1000;
const HEALTH_WAIT_MS = 5 * 60 * 1000;
/** How often a waiting launch looks: at the port, and at what the supervisor says it is doing. */
const WAIT_POLL_MS = 200;

// ═══════════════════════════════════════════
// Quoting
// ═══════════════════════════════════════════

/** One POSIX shell word. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** One argument of a Windows command line (CommandLineToArgvW rules). */
export function winQuote(value) {
  let out = '"';
  let slashes = 0;
  for (const ch of String(value)) {
    if (ch === '\\') { slashes++; continue; }
    if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/**
 * One argument of a .desktop Exec line: quoted per the Exec rules (" ` $ \
 * escaped), then escaped again as a desktop-entry string, with % doubled so
 * it is not read as a field code.
 */
export function desktopExecArg(value) {
  const quoted = `"${String(value).replace(/(["`$\\])/g, '\\$1')}"`;
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════
// Configuration the launcher must agree with the server on
// ═══════════════════════════════════════════

export function normalizePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function readDotEnvValue(dataHome, key) {
  try {
    for (const line of readFileSync(join(dataHome, '.env'), 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(`${key}=`)) continue;
      return trimmed.slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return null;
}

/** The port the server listens on: the environment, then DATA_HOME/.env, then 3344 — as server.js reads it. */
export function resolvePort({ explicit = null, env = process.env, dataHome } = {}) {
  return normalizePort(explicit)
    || normalizePort(env.NEURAL_PORT)
    || (dataHome ? normalizePort(readDotEnvValue(dataHome, 'NEURAL_PORT')) : null)
    || DEFAULT_PORT;
}

/**
 * What a registration has to pin because the OS starts the launcher with a
 * bare environment: a data home that is not the platform default, and a port
 * the launcher would not arrive at as 3344 by itself.
 */
export function launcherOverrides({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const dataHome = getDataHome({ env, home, os: platform });
  const standard = getPlatformDataHome({ env, home, os: platform });
  // Read the port the way the launcher will, so setup.js (bare environment)
  // and the server (DATA_HOME/.env loaded) write the same registration.
  const port = resolvePort({ env, dataHome });
  // Where a handler with no --port lands: DATA_HOME/.env, then 3344. A server
  // run with NEURAL_PORT=3344 over a .env that names another port has to pin
  // its 3344, or the next click starts (and waits for) the other one.
  const unpinned = resolvePort({ env: {}, dataHome });
  return {
    dataHome: dataHome !== standard ? dataHome : null,
    port: port !== DEFAULT_PORT || unpinned !== DEFAULT_PORT ? port : null,
  };
}

// ═══════════════════════════════════════════
// Registration
// ═══════════════════════════════════════════

export function launcherLocations({ platform = process.platform, home = homedir() } = {}) {
  if (platform === 'win32') return { kind: 'registry', key: WIN_KEY };
  if (platform === 'darwin') {
    const app = posix.join(home, '.synabun', 'SynaBun.app');
    return {
      kind: 'app',
      app,
      plist: posix.join(app, 'Contents', 'Info.plist'),
      executable: posix.join(app, 'Contents', 'MacOS', 'synabun-launcher'),
      terminalScript: posix.join(app, 'Contents', 'Resources', 'SynaBun Server.command'),
    };
  }
  return { kind: 'desktop', desktopFile: posix.join(home, '.local', 'share', 'applications', 'synabun.desktop') };
}

function launcherArgs({ dataHome, port, terminalScript }) {
  const args = ['--via=protocol'];
  if (dataHome) args.push('--data-home', dataHome);
  if (port) args.push('--port', String(port));
  if (terminalScript) args.push('--terminal-script', terminalScript);
  return args;
}

/**
 * Everything a registration consists of, as data: files to write, registry
 * values to set and the commands that tell the OS about them. No side effects.
 */
export function buildLauncherPlan({
  platform = process.platform,
  nodePath = process.execPath,
  packageRoot,
  home = homedir(),
  dataHome = null,
  port = null,
  entry = null,
} = {}) {
  if (!packageRoot) throw new Error('packageRoot is required');
  const where = launcherLocations({ platform, home });
  const plan = { platform, revision: LAUNCHER_REVISION, where, files: [], registry: [], refresh: [] };
  // A packaged application is reached through its entry executable, which
  // brings its own Node: `<entry> launcher ...` and `<entry> start`.
  const handler = (args, launcherPath) => (entry ? [entry, 'launcher', ...args] : [nodePath, launcherPath, ...args]);

  if (platform === 'win32') {
    const launcher = win32.join(packageRoot, 'launcher.mjs');
    const command = [...handler(launcherArgs({ dataHome, port }), launcher), '--'].map(winQuote).join(' ') + ' "%1"';
    plan.registry.push(
      { key: WIN_KEY, name: null, value: 'URL:SynaBun Protocol' },
      { key: WIN_KEY, name: 'URL Protocol', value: '' },
      { key: `${WIN_KEY}\\shell\\open\\command`, name: null, value: command },
    );
    return plan;
  }

  const launcher = posix.join(packageRoot, 'launcher.mjs');
  const setup = posix.join(packageRoot, 'setup.js');

  if (platform === 'darwin') {
    const args = launcherArgs({ dataHome, port, terminalScript: where.terminalScript });
    plan.files.push({
      path: where.plist,
      mode: 0o644,
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>`,
        '  <key>CFBundleName</key><string>SynaBun</string>',
        '  <key>CFBundleExecutable</key><string>synabun-launcher</string>',
        '  <key>CFBundlePackageType</key><string>APPL</string>',
        `  <key>CFBundleVersion</key><string>${LAUNCHER_REVISION}.0</string>`,
        // No Dock icon: the launcher is gone again within seconds.
        '  <key>LSUIElement</key><true/>',
        '  <key>CFBundleURLTypes</key>',
        '  <array><dict>',
        '    <key>CFBundleURLName</key><string>SynaBun Protocol</string>',
        `    <key>CFBundleURLSchemes</key><array><string>${xmlEscape(START_PROTOCOL)}</string></array>`,
        '  </dict></array>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    }, {
      // macOS delivers the link as an Apple Event, which a script never sees:
      // being launched at all is the request to start.
      path: where.executable,
      mode: 0o755,
      content: [
        '#!/bin/sh',
        `# SynaBun start launcher (revision ${LAUNCHER_REVISION}). macOS runs this for ${START_PROTOCOL}:// links.`,
        '# Generated by SynaBun and rewritten when the install moves. Do not edit.',
        ...(entry ? [
          `ENTRY=${shQuote(entry)}`,
          '[ -x "$ENTRY" ] || exit 127',
          `exec "$ENTRY" ${['launcher', ...args].map(shQuote).join(' ')} >/dev/null 2>&1`,
        ] : [
          `NODE=${shQuote(nodePath)}`,
          'if [ ! -x "$NODE" ]; then',
          '  NODE="$(PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" command -v node 2>/dev/null)"',
          'fi',
          '[ -n "$NODE" ] || exit 127',
          `exec "$NODE" ${[launcher, ...args].map(shQuote).join(' ')} >/dev/null 2>&1`,
        ]),
        '',
      ].join('\n'),
    }, {
      // Terminal runs this in the user's login shell: the same environment and
      // the same privacy grants as a server they started by hand.
      path: where.terminalScript,
      mode: 0o755,
      content: [
        '#!/bin/sh',
        '# Runs the SynaBun server in this window (opened by the Start Server button).',
        '# Generated by SynaBun and rewritten when the install moves. Do not edit.',
        `printf '\\033]0;SynaBun Server\\007'`,
        ...(entry ? [] : [
          `NODE=${shQuote(nodePath)}`,
          '[ -x "$NODE" ] || NODE=node',
        ]),
        ...(dataHome ? [`export SYNABUN_DATA_HOME=${shQuote(dataHome)}`] : []),
        ...(port ? [`export NEURAL_PORT=${shQuote(String(port))}`] : []),
        'export SYNABUN_OPEN_BROWSER=0',
        `cd ${shQuote(packageRoot)} || exit 1`,
        entry
          ? `exec ${shQuote(entry)} start`
          : `exec "$NODE" --disable-warning=ExperimentalWarning ${shQuote(setup)}`,
        '',
      ].join('\n'),
    });
    plan.refresh.push({ file: LSREGISTER, args: ['-f', where.app] });
    return plan;
  }

  const exec = [...handler(launcherArgs({ dataHome, port }), launcher), '--'].map(desktopExecArg).join(' ');
  plan.files.push({
    path: where.desktopFile,
    mode: 0o644,
    content: [
      '[Desktop Entry]',
      'Type=Application',
      'Name=SynaBun',
      `Comment=Starts the SynaBun server (${START_PROTOCOL}:// links)`,
      `Exec=${exec} %u`,
      `MimeType=x-scheme-handler/${START_PROTOCOL};`,
      'NoDisplay=true',
      // The launcher starts the server in the background and exits: no window to keep.
      'Terminal=false',
      `X-SynaBun-Launcher=${LAUNCHER_REVISION}`,
      '',
    ].join('\n'),
  });
  plan.refresh.push(
    { file: 'xdg-mime', args: ['default', basename(where.desktopFile), `x-scheme-handler/${START_PROTOCOL}`] },
    { file: 'update-desktop-database', args: [dirname(where.desktopFile)] },
  );
  return plan;
}

function regExe(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  return root ? win32.join(root, 'System32', 'reg.exe') : 'reg';
}

function defaultRun(file, args, { timeout = 15000 } = {}) {
  return execFileSync(file, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/** The current value of one registry entry, or null when it is not there. */
function readRegistryValue(entry, { run = defaultRun, env = process.env } = {}) {
  try {
    const out = run(regExe(env), ['query', entry.key, ...(entry.name === null ? ['/ve'] : ['/v', entry.name])]);
    for (const line of String(out).split(/\r?\n/)) {
      const at = line.indexOf('REG_SZ');
      if (at < 0) continue;
      return line.slice(at + 'REG_SZ'.length).trim();
    }
    return null;
  } catch {
    return null;
  }
}

function fileMatches(file) {
  try {
    if (readFileSync(file.path, 'utf8') !== file.content) return false;
    // A launcher that lost its executable bit is as good as missing.
    return !(file.mode & 0o111) || (statSync(file.path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** 'registered' | 'stale' | 'missing', without changing anything. */
export function inspectLauncher(plan, { run = defaultRun, env = process.env } = {}) {
  let present = 0;
  let current = 0;
  for (const file of plan.files) {
    if (existsSync(file.path)) present++;
    if (fileMatches(file)) current++;
  }
  for (const entry of plan.registry) {
    const value = readRegistryValue(entry, { run, env });
    if (value !== null) present++;
    if (value === entry.value) current++;
  }
  const total = plan.files.length + plan.registry.length;
  if (current === total) return 'registered';
  return present ? 'stale' : 'missing';
}

/**
 * Bring the OS in line with a plan. Writes only what differs, so calling it on
 * every start costs a few file reads. Returns { ok, changed, state, errors }.
 */
export function applyLauncherPlan(plan, { run = defaultRun, env = process.env } = {}) {
  const errors = [];
  let changed = 0;

  for (const file of plan.files) {
    if (fileMatches(file)) continue;
    try {
      mkdirSync(dirname(file.path), { recursive: true });
      const temp = `${file.path}.${process.pid}.tmp`;
      writeFileSync(temp, file.content, { encoding: 'utf8', mode: file.mode });
      chmodSync(temp, file.mode);
      renameSync(temp, file.path);
      changed++;
    } catch (error) {
      errors.push(`${file.path}: ${error.message}`);
    }
  }

  for (const entry of plan.registry) {
    if (readRegistryValue(entry, { run, env }) === entry.value) continue;
    try {
      run(regExe(env), ['add', entry.key, ...(entry.name === null ? ['/ve'] : ['/v', entry.name]), '/t', 'REG_SZ', '/d', entry.value, '/f']);
      changed++;
    } catch (error) {
      errors.push(`${entry.key}: ${error.message}`);
    }
  }

  // The OS caches its handler table: tell it only when something moved. These
  // are best effort (a minimal Linux has neither tool and still resolves the
  // entry through mimeinfo on most desktops).
  if (changed) {
    for (const command of plan.refresh) {
      try { run(command.file, command.args); } catch {}
    }
  }

  const state = errors.length ? inspectLauncher(plan, { run, env }) : 'registered';
  return { ok: errors.length === 0, changed, state, errors };
}

/**
 * Whether this process may touch the user's registration. A test run or a
 * throwaway data home must never repoint the real handler at itself.
 */
export function launcherRegistrationAllowed({ env = process.env, dataHome = null } = {}) {
  if (env.SYNABUN_LAUNCHER_REGISTER === '0') return false;
  if (env.NODE_TEST_CONTEXT || env.VITEST) return false;
  if (dataHome) {
    try { if (pathIsInside(dataHome, tmpdir())) return false; } catch {}
  }
  return true;
}

/** The entry executable of a packaged application, or null for an npm or Git install. */
function packagedEntry({ packageRoot, env }) {
  return packageRoot ? readPackagedRuntime({ packageRoot, env })?.entry ?? null : null;
}

/** Register (or repair) the synabun:// handler for this install. Never throws. */
export function registerStartLauncher({
  platform = process.platform,
  nodePath = process.execPath,
  packageRoot,
  home = homedir(),
  env = process.env,
  run = defaultRun,
} = {}) {
  try {
    const overrides = launcherOverrides({ env, home, platform });
    if (!launcherRegistrationAllowed({ env, dataHome: overrides.dataHome })) {
      return { ok: true, changed: 0, state: 'skipped', errors: [] };
    }
    const plan = buildLauncherPlan({ platform, nodePath, packageRoot, home, entry: packagedEntry({ packageRoot, env }), ...overrides });
    return applyLauncherPlan(plan, { run, env });
  } catch (error) {
    return { ok: false, changed: 0, state: 'missing', errors: [error.message] };
  }
}

/** Read-only: is this install's handler in place? */
export function startLauncherState({
  platform = process.platform,
  nodePath = process.execPath,
  packageRoot,
  home = homedir(),
  env = process.env,
  run = defaultRun,
} = {}) {
  try {
    const plan = buildLauncherPlan({ platform, nodePath, packageRoot, home, entry: packagedEntry({ packageRoot, env }), ...launcherOverrides({ env, home, platform }) });
    return inspectLauncher(plan, { run, env });
  } catch {
    return 'missing';
  }
}

// ═══════════════════════════════════════════
// Launch
// ═══════════════════════════════════════════

/**
 * Read the launcher's arguments. Only `start` is an action: a link that asks
 * for anything else is ignored, and nothing from the link is ever passed on.
 */
export function parseLauncherArgs(argv = []) {
  const out = { action: 'start', via: 'manual', dataHome: null, port: null, terminalScript: null, link: null };
  let afterDashes = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '');
    if (new RegExp(`^${START_PROTOCOL}:`, 'i').test(arg)) {
      out.link = arg;
      out.action = parseStartLink(arg);
      continue;
    }
    if (afterDashes) continue; // whatever else follows `--` came from the link
    if (arg === '--') { afterDashes = true; continue; }
    if (arg === '--via=protocol') out.via = 'protocol';
    else if (arg === '--data-home') out.dataHome = argv[++i] || null;
    else if (arg === '--port') out.port = normalizePort(argv[++i]);
    else if (arg === '--terminal-script') out.terminalScript = argv[++i] || null;
  }
  return out;
}

/** 'start' for synabun://start (any query), otherwise 'ignore'. */
export function parseStartLink(link) {
  const match = new RegExp(`^${START_PROTOCOL}:(?://)?([a-z-]*)/?(?:[?#].*)?$`, 'i').exec(String(link || '').trim());
  return match && match[1].toLowerCase() === 'start' ? 'start' : 'ignore';
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** What a click should do, given what is already there. */
export function decideLaunch({ healthy, lock = null, supervisor = null, now = Date.now(), alive = pidAlive } = {}) {
  if (healthy) return 'already-running';
  if (lock && alive(lock.pid) && now - Number(lock.startedAt || 0) < LOCK_TTL_MS) return 'already-starting';
  // A supervisor only lives while its server does. One that has been alive
  // this long without a server answering is a reused pid, not a start; one
  // that wrote down its own end is over, whoever has its pid now.
  if (supervisor && !supervisor.endedAt && alive(supervisor.pid) && now - Number(supervisor.startedAt || 0) < SUPERVISOR_TTL_MS) return 'already-starting';
  return 'start';
}

export function launcherStatePaths(dataHome) {
  const dir = join(dataHome, 'data');
  const lock = join(dir, 'start-launcher.lock');
  return {
    dir,
    lock,
    mutex: launchMutexPath(lock),
    supervisor: join(dir, 'supervisor.json'),
    log: join(dir, 'launcher.log'),
  };
}

/**
 * The mutex that goes with a lock file: DATA_HOME/runtime/start-launcher.mutex
 * for DATA_HOME/data/start-launcher.lock. Derived from the lock's own path, so
 * everyone after one lock is behind one mutex, and kept out of data/: an
 * operating-system lock is not data, and a backup that copied it or a restore
 * that replaced it would split it in two.
 */
export function launchMutexPath(lockPath) {
  return join(dirname(dirname(lockPath)), 'runtime', `${basename(lockPath, '.lock')}.mutex`);
}

/** What a supervisor says it is doing. Each one is written when it begins, never ahead of it. */
export const SUPERVISOR_PHASES = Object.freeze([
  'checking',      // looking at the install: nothing slow has begun
  'dependencies',  // npm install is running (a first start, or the first after an update)
  'browser',       // downloading the automation browser
  'build',         // compiling the MCP server
  'snapshot',      // backing the data home up before the first start of a new version
  'server',        // the server process was spawned
  'listening',     // the server printed its address
  'failed',        // it ended without a server; `error` says why
]);

function supervisorError(error) {
  const exitCode = Number(error?.exitCode);
  return {
    code: String(error?.code || 'SETUP_FAILED').slice(0, 40),
    message: String(error?.message || error || 'the start failed').slice(0, 300),
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function writeRecord(path, record, pid) {
  const text = JSON.stringify(record) + '\n';
  const temp = `${path}.${pid}.tmp`;
  try {
    // Replaced whole: a launcher reading it mid-start never sees half a record.
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, path);
  } catch {
    try { writeFileSync(path, text, 'utf8'); } catch {}
    try { rmSync(temp, { force: true }); } catch {}
  }
}

/**
 * Called by setup.js: say that a supervisor owns the server from now on, and
 * what it is doing. A second click reads the record and starts nothing; the
 * launcher that started this supervisor passes its phases on to the page.
 * Returns { phase(name, detail), fail(error), release() }: `release` (on
 * exit) removes the record unless it says why the start failed.
 */
export function openSupervisorRecord(dataHome, { pid = process.pid, now = () => Date.now() } = {}) {
  const { dir, supervisor } = launcherStatePaths(dataHome);
  const startedAt = now();
  const record = { pid, startedAt, phase: 'checking', phaseAt: startedAt };
  let ended = false;
  const write = () => {
    try { mkdirSync(dir, { recursive: true }); } catch {}
    writeRecord(supervisor, record, pid);
  };
  write();
  return {
    phase(name, detail = null) {
      if (ended || !SUPERVISOR_PHASES.includes(name) || name === 'failed') return;
      record.phase = name;
      record.phaseAt = now();
      if (detail && typeof detail === 'object') record.detail = detail; else delete record.detail;
      write();
    },
    fail(error) {
      if (ended) return;
      ended = true;
      record.phase = 'failed';
      record.phaseAt = record.endedAt = now();
      record.error = supervisorError(error);
      delete record.detail;
      write();
    },
    release() {
      // A record of why it failed stays for the launcher and the next click to
      // read; `endedAt` keeps it from ever counting as a start under way.
      if (ended) return;
      try { if (readJson(supervisor)?.pid === pid) rmSync(supervisor, { force: true }); } catch {}
    },
  };
}

/**
 * A start that ended before it could open its record (two data homes that
 * disagree, say). Written only into a data directory that is already there:
 * a failed start creates nothing.
 */
export function noteSupervisorFailure(dataHome, error, { pid = process.pid, now = Date.now() } = {}) {
  const { dir, supervisor } = launcherStatePaths(dataHome);
  if (!existsSync(dir)) return false;
  writeRecord(supervisor, { pid, startedAt: now, phase: 'failed', phaseAt: now, endedAt: now, error: supervisorError(error) }, pid);
  return true;
}

const MUTEX_TIMEOUT_MS = 2000;
const SQLITE_BUSY = 5;

/**
 * node:sqlite, loaded on first use: postinstall.js and setup.js import this
 * module on any Node, and only a launch needs it. The server runs with
 * --disable-warning=ExperimentalWarning; the OS starts the launcher without
 * it, so the one line node prints for this module is kept out of its console.
 */
function loadSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/SQLite is an experimental feature/i.test(String(warning?.message ?? warning))) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
  try { return createRequire(import.meta.url)('node:sqlite'); } finally { process.emitWarning = emitWarning; }
}

/**
 * Run `fn` as the only process inside, among everyone who uses `path`. The
 * mutex is a write transaction (BEGIN IMMEDIATE) on an empty SQLite database,
 * like the rules installer's lock (neural-interface/lib/rulesets/lock.js):
 * the operating system holds it and gives it back when the process ends,
 * however it ends. Nothing is ever written to the file, there is no stale
 * state to clean up, and so nothing here has to judge or remove someone
 * else's claim. Returns { ran, value }; `ran` is false when another process
 * stayed inside for `timeoutMs`. Throws when the mutex cannot be used at all.
 */
function withLaunchMutex(path, fn, { timeoutMs = MUTEX_TIMEOUT_MS } = {}) {
  const { DatabaseSync } = loadSqlite();
  mkdirSync(dirname(path), { recursive: true });
  // Which file the path leads to, by stat alone (never a second descriptor on it).
  const identity = () => {
    try { const info = statSync(path, { bigint: true }); return `${info.dev}:${info.ino}`; } catch { return null; }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = identity();
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(Number(timeoutMs) || 0))}`);
      const opened = identity();
      try {
        db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        const busy = (Number(error?.errcode) & 0xff) === SQLITE_BUSY || /database is locked/i.test(String(error?.errstr || error?.message || ''));
        if (busy) return { ran: false };
        throw error;
      }
      try {
        // Deleted or replaced while it was being taken: this transaction is on
        // a file nobody else looks at. Give it back and take the one there now.
        if (opened === null || (before !== null && before !== opened) || identity() !== opened) continue;
        return { ran: true, value: fn() };
      } finally {
        try { db.exec('ROLLBACK'); } catch {}
      }
    } finally {
      try { db.close(); } catch {}
    }
  }
  throw new Error(`its mutex (${path}) was replaced while it was being taken`);
}

/**
 * Take the launch lock, or return null when a live launch holds it. Reading
 * the record, judging it dead and replacing it all happen inside the launch
 * mutex, and so does the release: two launchers that found the same dead lock
 * cannot remove each other's fresh one, and a late release cannot remove a
 * lock taken after it. Throws (code LAUNCH_LOCK_UNAVAILABLE) when the lock
 * cannot be taken at all; the caller then starts nothing.
 */
export function acquireLaunchLock(lockPath, {
  pid = process.pid, now = Date.now(), alive = pidAlive, port = null, mutexTimeoutMs = MUTEX_TIMEOUT_MS,
} = {}) {
  const mutexPath = launchMutexPath(lockPath);
  const id = randomBytes(8).toString('hex');
  const record = JSON.stringify({ pid, startedAt: now, port, id }) + '\n';
  let taken;
  try {
    taken = withLaunchMutex(mutexPath, () => {
      const held = readJson(lockPath);
      if (held && alive(held.pid) && now - Number(held.startedAt || 0) < LOCK_TTL_MS) return false;
      // There and unreadable, a moment old: nobody else is writing it now (this
      // is the mutex), so it is what a launcher that died mid-write left, or
      // not ours at all. It gets a few seconds before it counts as debris.
      if (!held) {
        try { if (Date.now() - statSync(lockPath).mtimeMs < 5000) return false; } catch {}
      }
      // Written in place: a reader outside the mutex (decideLaunch) may catch
      // it half written, reads nothing, and then waits here like everyone else.
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, record, 'utf8');
      return true;
    }, { timeoutMs: mutexTimeoutMs });
  } catch (cause) {
    throw Object.assign(new Error(`the launch lock could not be taken (${lockPath}): ${cause?.message || cause}`), { code: 'LAUNCH_LOCK_UNAVAILABLE', cause });
  }
  // Someone else inside the mutex for that long is a launch at work, too.
  if (!taken.ran || !taken.value) return null;
  return {
    release() {
      try {
        withLaunchMutex(mutexPath, () => {
          if (readJson(lockPath)?.id === id) rmSync(lockPath, { force: true });
        }, { timeoutMs: mutexTimeoutMs });
      } catch {}
    },
  };
}

/** True when something accepts a TCP connection on the port. */
export function portAccepts(port, { timeoutMs = 400, host = '127.0.0.1', connectImpl = connect } = {}) {
  return new Promise((done) => {
    let settled = false;
    let socket = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch {}
      done(value);
    };
    try {
      socket = connectImpl({ port, host });
      socket.setTimeout?.(timeoutMs, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/**
 * True when a server holds the port: something answers HTTP there (a starting
 * server answers before it is ready), or, when no answer came, something still
 * accepts connections. A server too busy to answer in time is a server all the
 * same, and a second one could not take its port.
 */
export async function probeServer(port, { timeoutMs = 1500, fetchImpl = globalThis.fetch, accepts = portAccepts } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    try { await response.body?.cancel(); } catch {}
    return true;
  } catch {
    try { return (await accepts(port)) === true; } catch { return false; }
  }
}

// ═══════════════════════════════════════════
// Progress: the start beacon
// ═══════════════════════════════════════════

export const BEACON_VERSION = 1;
export const BEACON_PATH = '/synabun-start-status';
/** How long a launch that failed keeps saying so, for a page that has not read it yet. */
export const BEACON_LINGER_MS = 20 * 1000;

/**
 * Where a launch reports while the server is down: the server's port + 10000
 * on the loopback address (3344 → 13344), − 10000 when that is past the last
 * port. The page derives it the same way (`startBeaconPort` in
 * neural-interface/public/shared/start-bridge.js): the two must agree.
 */
export function startBeaconPort(port) {
  const p = normalizePort(port) || DEFAULT_PORT;
  return p + 10000 <= 65535 ? p + 10000 : p - 10000;
}

const DETAIL_NUMBERS = ['files', 'bytes', 'skippedFiles', 'port', 'pid', 'exitCode'];
const DETAIL_STRINGS = ['name', 'step', 'version'];

/** What of a supervisor record goes out on the beacon: known fields, bounded, nothing else from the file. */
export function publicSupervisorState(record) {
  if (!record || typeof record !== 'object' || !SUPERVISOR_PHASES.includes(record.phase)) return null;
  const out = {
    phase: record.phase,
    at: Number(record.phaseAt) || Number(record.startedAt) || 0,
    startedAt: Number(record.startedAt) || 0,
  };
  if (record.detail && typeof record.detail === 'object') {
    const detail = {};
    for (const key of DETAIL_NUMBERS) if (Number.isFinite(Number(record.detail[key])) && record.detail[key] !== null) detail[key] = Number(record.detail[key]);
    for (const key of DETAIL_STRINGS) if (typeof record.detail[key] === 'string') detail[key] = record.detail[key].slice(0, 80);
    if (Object.keys(detail).length) out.detail = detail;
  }
  if (record.phase === 'failed') out.error = supervisorError(record.error);
  return out;
}

/**
 * The beacon of one launch: a loopback-only HTTP listener that answers one
 * read-only question, "what has this launch seen happen so far?".
 *
 *   step(id)         — something the launcher itself did or saw, with its time
 *   supervisor(rec)  — the supervisor's own record, as it stands
 *   finish(state, e) — 'started' | 'failed' | 'gave-up'
 *
 * It answers only its own host name (a page elsewhere cannot reach it by
 * rebinding a name), gives the answer only to a page of this server's own
 * loopback origin, and changes nothing. A port it cannot have is not an
 * error: the launch goes on unreported and the page says less.
 */
export function createStartBeacon({
  port,
  startedAt = Date.now(),
  now = () => Date.now(),
  launchId = randomBytes(8).toString('hex'),
  logPath = null,
  createServerImpl = createServer,
} = {}) {
  const beaconPort = startBeaconPort(port);
  const hosts = new Set([`127.0.0.1:${beaconPort}`, `localhost:${beaconPort}`]);
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
  const status = { state: 'starting', steps: [{ id: 'received', at: startedAt }], supervisor: null, error: null };
  let server = null;
  let listening = false;
  let closed = false;
  let retryTimer = null;
  let finalReads = 0;
  let onFinalRead = null;
  // Each phase the supervisor was seen in, with the time it gave for it. One
  // that came and went between two looks is not here: this is what was seen.
  const phases = [];

  const snapshot = () => ({
    synabun: 'start-beacon',
    v: BEACON_VERSION,
    port,
    launchId,
    startedAt,
    now: now(),
    state: status.state,
    steps: status.steps,
    supervisor: status.supervisor,
    error: status.error,
    log: logPath,
  });

  function handle(req, res) {
    const deny = (code) => { res.writeHead(code, { 'Content-Length': '0', 'Cache-Control': 'no-store' }); res.end(); };
    try {
      if (!hosts.has(String(req.headers.host || '').toLowerCase())) return deny(403);
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin)) return deny(403);
      if (String(req.url || '').split('?')[0] !== BEACON_PATH) return deny(404);
      const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '600',
          'Content-Length': '0',
        });
        return res.end();
      }
      if (req.method !== 'GET') return deny(405);
      const body = JSON.stringify(snapshot());
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(body)),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
      if (status.state !== 'starting' && origin) {
        finalReads++;
        onFinalRead?.();
      }
    } catch {
      try { deny(500); } catch {}
    }
  }

  /** Try to take the port; `retryMs` keeps trying while an earlier launch still holds it. Resolves true | false. */
  function listen({ retryMs = 0, retryEveryMs = 400 } = {}) {
    const deadline = now() + retryMs;
    return new Promise((done) => {
      const attempt = () => {
        retryTimer = null;
        if (closed) return done(false);
        let candidate;
        try {
          candidate = createServerImpl(handle);
        } catch {
          return done(false);
        }
        let bound = false;
        // Kept for the listener's whole life: an error with nobody listening for
        // it would end the launcher, and the beacon is never worth that.
        candidate.on('error', () => {
          if (bound) return;
          try { candidate.close(); } catch {}
          if (closed || now() >= deadline) return done(false);
          retryTimer = setTimeout(attempt, retryEveryMs);
          retryTimer.unref?.();
        });
        candidate.once('listening', () => {
          bound = true;
          if (closed) { try { candidate.close(); } catch {} return done(false); }
          server = candidate;
          listening = true;
          // A slow or silent client cannot hold the launcher open.
          server.headersTimeout = 5000;
          server.requestTimeout = 5000;
          server.keepAliveTimeout = 1000;
          done(true);
        });
        candidate.unref?.();
        candidate.listen({ port: beaconPort, host: '127.0.0.1', exclusive: true });
      };
      attempt();
    });
  }

  return {
    port: beaconPort,
    launchId,
    get listening() { return listening; },
    get state() { return status.state; },
    snapshot,
    listen,
    step(id, extra = {}) {
      if (status.state !== 'starting' || status.steps.some(s => s.id === id)) return;
      status.steps.push({ id: String(id), at: now(), ...extra });
    },
    supervisor(record) {
      if (status.state !== 'starting') return;
      const next = publicSupervisorState(record);
      if (!next) return;
      if (phases[phases.length - 1]?.phase !== next.phase) phases.push({ phase: next.phase, at: next.at });
      status.supervisor = { ...next, phases: phases.slice(-12) };
    },
    finish(state, error = null) {
      if (status.state !== 'starting') return;
      status.state = state;
      status.error = error ? supervisorError(error) : null;
      status.steps.push({ id: state, at: now() });
    },
    /**
     * Keep answering until a page has read how it ended (and a moment more,
     * for a second tab), `ms` at the most. A beacon nobody can reach is over at once.
     */
    linger(ms, { afterReadMs = 1500 } = {}) {
      if (!listening || closed || !(ms > 0)) return Promise.resolve();
      return new Promise((done) => {
        let timer = setTimeout(done, ms);
        const soon = () => {
          onFinalRead = null;
          clearTimeout(timer);
          timer = setTimeout(done, afterReadMs);
        };
        if (finalReads > 0) soon(); else onFinalRead = soon;
      });
    },
    close() {
      closed = true;
      listening = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      onFinalRead = null;
      try { server?.close(); } catch {}
      try { server?.closeAllConnections?.(); } catch {}
      server = null;
    },
  };
}

const LOGIN_ENV_SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh', 'mksh', 'yash', 'fish']);
/** What a launch decides for itself. A profile may export its own; the launch's values stand. */
const LAUNCH_SETTINGS = ['SYNABUN_DATA_HOME', 'NEURAL_PORT', 'SYNABUN_OPEN_BROWSER'];

/**
 * The environment a terminal would give the server. A desktop starts the
 * launcher with a bare one (no nvm, no Homebrew, no exported keys), so ask the
 * user's own shell, bounded, and fall back to a PATH that at least finds node.
 * The shell's answer goes over `env`, except for the launch's own settings:
 * the server has to listen where the launcher probes and keep its state where
 * the launcher's lock is.
 */
export function resolveLaunchEnv({
  env = process.env,
  nodePath = process.execPath,
  platform = process.platform,
  home = homedir(),
  timeoutMs = 5000,
  runShell = spawnSync,
} = {}) {
  // Windows hands a protocol handler the user's full environment already.
  if (platform === 'win32') return { ...env };
  const nodeDir = dirname(nodePath);
  // node first, so npm / npx (and CLIs installed next to it) are the same install.
  const withNode = (base) => {
    const parts = String(base.PATH || '').split(':').filter(Boolean);
    const extra = ['/usr/local/bin', '/opt/homebrew/bin', posix.join(home, '.local', 'bin'), '/usr/bin', '/bin'];
    const path = [nodeDir, ...parts, ...extra].filter((p, i, all) => all.indexOf(p) === i).join(':');
    return { ...base, PATH: path };
  };

  const shell = env.SHELL || '';
  if (!LOGIN_ENV_SHELLS.has(basename(shell))) return withNode(env);
  try {
    const marker = `__SYNABUN_ENV_${randomBytes(8).toString('hex')}__`;
    const script = `process.stdout.write(${JSON.stringify(marker)}+JSON.stringify(process.env)+${JSON.stringify(marker)})`;
    const result = runShell(shell, ['-ilc', `${shQuote(nodePath)} -e ${shQuote(script)}`], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...env, HOME: env.HOME || home },
    });
    const out = String(result?.stdout || '');
    const start = out.indexOf(marker);
    const end = out.lastIndexOf(marker);
    if (start < 0 || end <= start) return withNode(env);
    const resolved = JSON.parse(out.slice(start + marker.length, end));
    if (!resolved || typeof resolved !== 'object') return withNode(env);
    const decided = Object.fromEntries(LAUNCH_SETTINGS.filter(key => env[key]).map(key => [key, env[key]]));
    return withNode({ ...env, ...resolved, ...decided });
  } catch {
    return withNode(env);
  }
}

function appendLog(logPath, line) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    try { if (statSync(logPath).size > 1024 * 1024) renameSync(logPath, `${logPath}.1`); } catch {}
    writeFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {}
}

export function noteDesktopLaunch(dataHome, line) {
  appendLog(launcherStatePaths(dataHome).log, `desktop: ${line}`);
}

async function waitForServer({ port, probe, sleep, now, timeoutMs, pollMs = WAIT_POLL_MS, stillGoing = () => true }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await probe(port)) return true;
    if (!stillGoing()) return false;
    await sleep(pollMs);
  }
  return false;
}

/**
 * Run one launch. Returns { outcome, code, port }:
 *   'ignored'          — the link asked for something other than start
 *   'already-running'  — a server answers
 *   'already-starting' — another launch (or a supervisor) is on it
 *   'started'          — the server answered after this launch
 *   'spawned'          — started, but it had not answered when the wait ended
 *   'failed'           — it could not be started
 *
 * `beacon: true` (launcher.mjs) reports the launch on its beacon while it
 * lasts, and `lingerMs` keeps a failure readable there for a moment. Every
 * step is also written to DATA_HOME/data/launcher.log with how long it took.
 */
export async function runLauncher({
  argv = [],
  env = process.env,
  platform = process.platform,
  packageRoot,
  nodePath = process.execPath,
  home = homedir(),
  probe = probeServer,
  spawnImpl = spawn,
  runShell = spawnSync,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
  now = () => Date.now(),
  waitMs = HEALTH_WAIT_MS,
  pollMs = WAIT_POLL_MS,
  beacon = false,
  lingerMs = 0,
  alive = pidAlive,
  background = false,
} = {}) {
  const args = parseLauncherArgs(argv);
  if (args.action !== 'start') return { outcome: 'ignored', code: 0, port: null };

  const launchedAt = now();
  const since = () => `${Math.max(0, now() - launchedAt)} ms`;
  const launchEnv = { ...env };
  if (args.dataHome) launchEnv.SYNABUN_DATA_HOME = args.dataHome;
  const dataHome = getDataHome({ env: launchEnv, home, os: platform });
  const port = resolvePort({ explicit: args.port, env: launchEnv, dataHome });
  // From here on the environment says what was decided, and resolveLaunchEnv
  // keeps it over anything a profile exports: the port probed below, the data
  // home the lock is in and the server that gets started are the same ones.
  Object.assign(launchEnv, { SYNABUN_DATA_HOME: dataHome, NEURAL_PORT: String(port), SYNABUN_OPEN_BROWSER: '0' });
  const paths = launcherStatePaths(dataHome);
  const log = (line) => appendLog(paths.log, `[${process.pid}] ${line}`);
  const makeBeacon = () => {
    if (!beacon) return null;
    try {
      const options = { port, startedAt: launchedAt, now, logPath: paths.log };
      return typeof beacon === 'function' ? beacon(options) : createStartBeacon(options);
    } catch {
      return null;
    }
  };

  const healthy = await probe(port);
  const decision = decideLaunch({ healthy, lock: readJson(paths.lock), supervisor: readJson(paths.supervisor), now: now(), alive });
  if (decision !== 'start') {
    log(`${decision} (port ${port}, via ${args.via})`);
    // A start somebody else began (by hand in a terminal, say) has nobody
    // reporting it when no launcher is with it: this click does, for as long
    // as that start lasts. Windows keeps a console open for a launcher that
    // stays, so there it stands down at once.
    if (decision === 'already-starting' && (platform !== 'win32' || background)) {
      const standIn = makeBeacon();
      if (standIn && await standIn.listen()) {
        const supervisorOf = () => {
          const record = readJson(paths.supervisor);
          if (record) standIn.supervisor(record);
          return record;
        };
        const up = await waitForServer({
          port, probe, sleep, now, timeoutMs: waitMs, pollMs,
          stillGoing: () => {
            const record = supervisorOf();
            const lock = readJson(paths.lock);
            return !!(record && !record.endedAt && alive(record.pid)) || !!(lock && alive(lock.pid));
          },
        });
        const record = readJson(paths.supervisor);
        if (up) standIn.finish('started');
        else if (record?.phase === 'failed') standIn.finish('failed', record.error);
        else standIn.finish('gave-up');
        if (!up) await standIn.linger(lingerMs);
      }
      standIn?.close();
    }
    return { outcome: decision, code: 0, port };
  }

  const report = makeBeacon();
  // An earlier launch that failed may still be saying so: take over when it lets go.
  report?.listen({ retryMs: 5000 });
  const fail = (error, line = error.message) => {
    log(`failed: ${line}`);
    report?.finish('failed', error);
    return { outcome: 'failed', code: 1, port };
  };
  const conclude = async (result) => {
    if (report && result.outcome !== 'started') await report.linger(lingerMs);
    report?.close();
    return result;
  };

  let lock;
  try {
    lock = acquireLaunchLock(paths.lock, { now: now(), port });
  } catch (error) {
    return conclude(fail({ code: 'LOCK_UNAVAILABLE', message: error.message }));
  }
  if (!lock) {
    log(`already-starting (lost the lock, port ${port})`);
    report?.close();
    return { outcome: 'already-starting', code: 0, port };
  }
  log(`starting (port ${port}, via ${args.via})`);
  report?.step('locked');

  // What the supervisor of this launch says about itself. One of an earlier
  // launch (a failure left for the next click to read) is not ours.
  let supervisor = null;
  const readSupervisor = () => {
    const record = readJson(paths.supervisor);
    if (!record || Number(record.startedAt) < launchedAt - 2000) return;
    if (!supervisor) log(`the supervisor is running after ${since()}`);
    if (record.phase && record.phase !== supervisor?.phase) log(`supervisor: ${record.phase}${record.phase === 'failed' ? ` (${record.error?.message || 'no reason given'})` : ''} at ${since()}`);
    supervisor = record;
    report?.supervisor(record);
  };
  const supervisorEnded = () => !!supervisor && (!!supervisor.endedAt || !alive(supervisor.pid));
  const supervisorFailure = (fallback) => (supervisor?.phase === 'failed' && supervisor.error
    ? { ...supervisor.error }
    : fallback);
  const answered = () => {
    log(`started: answering after ${since()}`);
    report?.finish('started');
    return { outcome: 'started', code: 0, port };
  };
  const gaveUp = () => {
    log(`not answering yet (gave up waiting after ${since()})`);
    report?.finish('gave-up', { code: 'NO_ANSWER', message: `no answer after ${Math.round(waitMs / 1000)} s` });
    return { outcome: 'spawned', code: 0, port };
  };

  const setup = join(packageRoot, 'setup.js');
  const nodeArgs = ['--disable-warning=ExperimentalWarning', setup];
  let result;
  try {
    result = await (async () => {
      if (!existsSync(setup)) return fail({ code: 'SETUP_MISSING', message: `${setup} is missing` });

      // ── Windows: the OS opened a console for this process; the server lives in it ──
      if (platform === 'win32' && !background) {
        log(`starting in this console (port ${port})`);
        const child = spawnImpl(nodePath, nodeArgs, {
          cwd: packageRoot,
          stdio: 'inherit',
          env: resolveLaunchEnv({ env: launchEnv, nodePath, platform, home, runShell }),
        });
        report?.step('spawned');
        let exited = null;
        const done = new Promise((res) => {
          child.once('error', (error) => { exited = { code: 1, error }; res(); });
          child.once('exit', (code) => { exited = { code: code ?? 1 }; res(); });
        });
        const up = await waitForServer({ port, probe, sleep, now, timeoutMs: waitMs, pollMs, stillGoing: () => { readSupervisor(); return !exited; } });
        lock.release();
        if (up) {
          answered();
          report?.close(); // the console stays for as long as the server does; the beacon does not
        } else {
          readSupervisor();
          fail(supervisorFailure({
            code: exited ? 'SUPERVISOR_EXITED' : 'NO_ANSWER',
            message: exited ? `the supervisor exited (${exited.error?.message || `code ${exited.code}`})` : `no answer after ${Math.round(waitMs / 1000)} s`,
            exitCode: exited?.code,
          }), `not answering${exited ? ` (exit ${exited.code})` : ''}`);
          // Still running, just silent: the console stays, the beacon says so and goes.
          if (!exited && report) { await report.linger(lingerMs); report.close(); }
        }
        await done; // keep the console (and the supervisor in it) until the server stops
        return { outcome: up ? 'started' : 'failed', code: exited?.code ?? 0, port };
      }

      // ── macOS: a Terminal window, exactly like a server started by hand ──
      if (!background && platform === 'darwin' && args.terminalScript && existsSync(args.terminalScript)) {
        const asked = now();
        const opened = runShell('/usr/bin/open', ['-a', 'Terminal', args.terminalScript], { timeout: 15000, stdio: 'ignore' });
        if (!opened?.error && opened?.status === 0) {
          log(`opened Terminal (port ${port}) in ${Math.max(0, now() - asked)} ms`);
          report?.step('terminal');
          const up = await waitForServer({ port, probe, sleep, now, timeoutMs: waitMs, pollMs, stillGoing: () => { readSupervisor(); return !supervisorEnded(); } });
          if (up) return answered();
          // The supervisor this launch saw start is gone and nothing answers:
          // it is over, and holding the lock would only block the next click.
          if (supervisorEnded()) {
            return fail(supervisorFailure({ code: 'SUPERVISOR_EXITED', message: 'the server stopped before it answered (the Terminal window says why)' }));
          }
          return gaveUp();
        }
        log(`Terminal did not open (${opened?.error?.message || `status ${opened?.status}`}); starting in the background`);
      }

      // ── Linux (and the macOS fallback): detached, with the login shell's environment ──
      let out = 'ignore';
      try { out = openSync(paths.log, 'a'); } catch {}
      const child = spawnImpl(nodePath, nodeArgs, {
        cwd: packageRoot,
        detached: true,
        windowsHide: background,
        stdio: ['ignore', out, out],
        // Packaged re-entry and isolated tests can supply an already resolved
        // environment. Do not read a login profile or add host CLI paths twice.
        env: background && launchEnv.SYNABUN_LAUNCH_ENV === 'resolved'
          ? launchEnv : resolveLaunchEnv({ env: launchEnv, nodePath, platform, home, runShell }),
      });
      let exited = null;
      child.once('error', (error) => { exited = { code: 1, error }; });
      child.once('exit', (code) => { exited = { code: code ?? 1 }; });
      child.unref();
      if (typeof out === 'number') { try { closeSync(out); } catch {} }
      log(`started in the background (pid ${child.pid}, port ${port}) after ${since()}`);
      report?.step('spawned');
      const up = await waitForServer({ port, probe, sleep, now, timeoutMs: waitMs, pollMs, stillGoing: () => { readSupervisor(); return !exited; } });
      if (up) return answered();
      if (exited) {
        readSupervisor();
        const reason = `the supervisor exited (${exited.error?.message || `code ${exited.code}`})`;
        return fail(supervisorFailure({ code: 'SUPERVISOR_EXITED', message: reason, exitCode: exited.code }), reason);
      }
      return gaveUp();
    })();
  } finally {
    lock.release();
  }
  return conclude(result);
}

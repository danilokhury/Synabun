/**
 * SynaBun's Windows update, after the app has quit: the installer runs into a
 * folder the installed copy has been moved out of, so the old copy can always
 * come back. Nothing is half installed: either the new version runs, or the
 * old one is back where it was.
 *
 *   1  wait for the app (its pid) to end; after two minutes nothing has changed
 *      and nothing happens
 *   2  stop what still runs from the install folder: the app's own helpers, an
 *      AI tool's SynaBun MCP server, a hook (the installer would stop them too)
 *   3  move the install folder aside (<folder>.previous). A folder that cannot
 *      be moved (a file in use) stays as it is: nothing is installed, and the
 *      old copy opens again
 *   4  run the downloaded installer silently into the same folder
 *      (--updated /S /D=<folder>): per user, never asking for administrator rights
 *   5  check what it put there: SynaBun.exe, and the payload of exactly the
 *      version that was downloaded. Otherwise the old copy goes back
 *   6  open the new copy (--synabun-updated) and wait for it to say it runs
 *      (`started`, written by the new copy); then the old copy is removed. A new
 *      copy that does not start within three minutes is replaced by the old one
 *
 * With SYNABUN_SWAP_WINDOW set (the app had something on screen), the
 * install window (install-window.mjs, install-window.ps1) opens first, over
 * the splash, and every step above says what it does there: waiting,
 * installing with the unpacking's own percentage (the installer writes it to
 * the file PROGRESS_ENV names), restarting, and ready once the new copy's
 * window is up (window-up), when it closes; a failure stays on screen with its
 * sentence and the log until it is closed.
 *
 * The state folder gets the markers every system's swap writes (swap.log,
 * swapped, swap-failed, rolled-back; state.mjs), and the next start of the app
 * reports what happened.
 *
 * It runs as a script of its own (`node win-swap.mjs`) under a copy of
 * SynaBun's node.exe in the update state folder, never from the install folder
 * it replaces; its parameters come in the environment (SWAP_ENV). The steps are
 * runWindowsSwap() with the system calls handed in, so
 * packaging/tests/desktop-updater.test.mjs runs every path on any system.
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SWAP_ENV = Object.freeze({
  pid: 'SYNABUN_SWAP_PID',
  instDir: 'SYNABUN_SWAP_INSTDIR',
  installer: 'SYNABUN_SWAP_INSTALLER',
  version: 'SYNABUN_SWAP_VERSION',
  previous: 'SYNABUN_SWAP_PREVIOUS',
  stateDir: 'SYNABUN_SWAP_STATE',
  relaunch: 'SYNABUN_SWAP_RELAUNCH',
  exe: 'SYNABUN_SWAP_EXE',
  // How long the new copy has to start (tests give less than three minutes).
  startMs: 'SYNABUN_SWAP_START_MS',
  // The install window's folder (install-window.mjs): set when the app asked for one, empty otherwise.
  window: 'SYNABUN_SWAP_WINDOW',
});

/** The file the installer writes its unpacking progress to ("<done bytes> <total bytes>"; installer.nsh SynaProgress). */
export const PROGRESS_ENV = 'SYNABUN_INSTALL_PROGRESS';

export const SWAP_LIMITS = Object.freeze({ quitMs: 2 * 60 * 1000, stopMs: 15 * 1000, moveMs: 20 * 1000, installMs: 15 * 60 * 1000, startMs: 3 * 60 * 1000, upMs: 30 * 1000 });

/** What the installer is told: an update (keeps the user's data), silent, into exactly this folder. */
export function installerArgs(instDir) {
  return ['--updated', '/S', `/D=${instDir}`];
}

/**
 * The parameters from the environment, or null when one is missing. A version
 * is a version, a folder an absolute Windows path, the pid a number: anything
 * else and the script does nothing.
 */
export function swapParams(env = process.env) {
  const value = (key) => String(env[SWAP_ENV[key]] || '').trim();
  const pid = Number(value('pid'));
  const absolute = (path) => /^[A-Za-z]:\\/.test(path) || /^\\\\/.test(path) || path.startsWith('/');
  const params = {
    pid, instDir: value('instDir'), installer: value('installer'), version: value('version'), previous: value('previous') || null,
    stateDir: value('stateDir'), relaunch: value('relaunch') === '1', exe: value('exe') || 'SynaBun.exe',
    windowDir: value('window') || null,
  };
  const startMs = Number(value('startMs'));
  if (Number.isInteger(startMs) && startMs >= 1000 && startMs <= SWAP_LIMITS.startMs) params.limits = { startMs };
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (![params.instDir, params.installer, params.stateDir].every(absolute)) return null;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(params.version)) return null;
  if (!/^[\w.-]+\.exe$/i.test(params.exe)) return null;
  if (params.windowDir && !absolute(params.windowDir)) params.windowDir = null;
  return params;
}

/** The environment the new copy opens with: the app's own, without this script's parameters. */
export function appEnvironment(env = process.env) {
  const next = { ...env };
  for (const key of Object.values(SWAP_ENV)) delete next[key];
  return next;
}

/**
 * "<done> <total>" as the installer writes it (installer.nsh SynaProgress): { done, total }, or null for anything
 * else (a half-written line, nothing yet). The larger number is the total, whatever order the plugin hands them in.
 */
export function installerProgress(text) {
  const match = /^\s*(\d{1,15})\s+(\d{1,15})\s*$/.exec(String(text ?? ''));
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const total = Math.max(a, b);
  if (!(total > 0)) return null;
  return { done: Math.min(a, b), total };
}

/** A whole percentage that never says 100 before the end. */
export function percentOf({ done, total } = {}) {
  if (!(Number(total) > 0) || !Number.isFinite(Number(done))) return null;
  return Math.max(0, Math.min(99, Math.floor((Number(done) / Number(total)) * 100)));
}

/**
 * What the install window draws (install-window.ps1), from its config (install-window.mjs installWindowConfig)
 * and where the swap is:
 *   phase     waiting · installing · restarting · ready · failed
 *   progress  { done, total } of the unpacking (installing only)
 *   outcome   for failed: kept (nothing changed) · restored (the installer failed, the old copy is back) ·
 *             rolled-back (the new copy did not start) · broken (the old copy could not be put back) ·
 *             stalled (the script itself failed: what happened is in the log)
 *   reason    the watchdog's own words, shown small under the sentence
 * A ready view closes the window; a failed one stays until the person closes it.
 */
export function composeWindowView(config, { phase, progress = null, outcome = 'kept', reason = '', log = '' } = {}) {
  const views = config?.views || {};
  const text = config?.text || {};
  const name = ['waiting', 'installing', 'restarting', 'ready', 'failed'].includes(phase) ? phase : 'waiting';
  const base = views[name] || views.installing || {};
  const percent = name === 'installing' && progress ? percentOf(progress) : null;
  const view = {
    phase: name,
    stage: String(base.stage || (name === 'failed' ? 'failed' : 'installing')),
    mascot: String(base.mascot || (name === 'failed' ? 'failed' : name === 'ready' ? 'ready' : 'working')),
    status: String(base.status || ''),
    lines: Array.isArray(base.lines) ? base.lines.map(String) : [],
    percent,
    label: percent === null ? '' : String(text.percent || '{percent}%').replace('{percent}', String(percent)),
    error: null,
    detail: '',
    log: String(log || config?.logPath || ''),
    close: name === 'ready',
    closeAfterMs: name === 'ready' ? 900 : null,
  };
  if (name === 'failed') {
    const sentence = { kept: text.kept, restored: text.restored, 'rolled-back': text.rolledBack, broken: text.notRestored, stalled: text.stalled }[outcome] || text.kept;
    view.error = String(sentence || reason || 'The update did not install.');
    view.detail = String(reason || '').slice(0, 300);
  }
  return view;
}

/**
 * The swap. `ops` are the system calls: now, sleep, log, write, exists, remove,
 * rename, alive, listUnder (null when it cannot tell), kill, runInstaller,
 * readVersion, open. Resolves { ok, reason?, started?, rolledBack? }.
 */
export async function runWindowsSwap(params, ops) {
  const { pid, instDir, installer, version, stateDir, relaunch, exe = 'SynaBun.exe' } = params;
  const limits = { ...SWAP_LIMITS, ...(params.limits || {}) };
  // The install window (install-window.mjs): asked for by the app when something was on screen. Every step says
  // what it does there; a visible update proceeds only after a window acknowledges its first frame.
  const windowConfig = params.window?.config || null;
  let lastView = '';
  const show = (phase, extra = {}) => {
    if (!windowConfig) return;
    const view = composeWindowView(windowConfig, { phase, ...extra });
    const key = JSON.stringify(view);
    if (key === lastView) return;
    lastView = key;
    try { ops.writeView(view); } catch {}
  };
  const backup = `${instDir}.previous`;
  const failedCopy = `${instDir}.failed-update`;
  const say = (line) => { try { ops.log(line); } catch {} };
  const mark = (name, text = '') => { try { ops.write(join(stateDir, name), text); } catch {} };
  const unmark = (name) => { try { ops.remove(join(stateDir, name)); } catch {} };
  const openApp = (args = []) => {
    try {
      const opened = ops.open(join(instDir, exe), args);
      say(`opened ${exe}${args.length ? ` ${args.join(' ')}` : ''}${opened ? ` (pid ${opened})` : ''}`);
      return opened;
    } catch (error) {
      say(`could not open ${exe}: ${error?.message || error}`);
      return null;
    }
  };
  const waitUntil = async (test, ms, every = 100) => {
    const until = ops.now() + ms;
    for (;;) {
      if (test()) return true;
      if (ops.now() >= until) return false;
      await ops.sleep(every);
    }
  };
  const holders = (folder) => {
    const found = ops.listUnder(folder);
    return Array.isArray(found) ? found : null;
  };
  /** Stop everything that runs from `folder`; true once nothing does (or nothing can tell). */
  const stopUnder = async (folder) => {
    let running = holders(folder);
    if (!running) return true;
    if (!running.length) return true;
    say(`stopping what runs from ${folder}: ${running.map(item => `${item.name || '?'} (${item.pid})`).join(', ')}`);
    for (const item of running) { try { ops.kill(item.pid); } catch {} }
    const done = await waitUntil(() => { running = holders(folder); return !running || running.length === 0; }, limits.stopMs, 500);
    if (!done) say(`still running from ${folder}: ${(running || []).map(item => `${item.name || '?'} (${item.pid})`).join(', ')}`);
    return done;
  };
  const move = async (from, to) => {
    let lastError = null;
    const moved = await waitUntil(() => {
      try { ops.rename(from, to); return true; } catch (error) { lastError = error; return false; }
    }, limits.moveMs, 500);
    return { moved, error: lastError };
  };
  /** The old copy back in place: whatever the installer left is removed first. */
  const restore = async () => {
    if (!ops.exists(backup)) return ops.exists(join(instDir, exe));
    await stopUnder(instDir);
    if (ops.exists(instDir)) {
      const aside = await move(instDir, failedCopy);
      if (!aside.moved) { say(`the new copy could not be moved away: ${aside.error?.code || aside.error?.message || 'unknown'}`); return false; }
    }
    const back = await move(backup, instDir);
    if (!back.moved) { say(`the old copy could not be put back: ${back.error?.code || back.error?.message || 'unknown'}`); return false; }
    try { ops.remove(failedCopy); } catch {}
    return true;
  };
  const fail = (reason, outcome = 'kept') => {
    say(`failed: ${reason}`);
    mark('swap-failed', reason);
    show('failed', { outcome, reason });
    return { ok: false, reason };
  };

  if (windowConfig) {
    show('waiting');
    try {
      const shown = await ops.openWindow();
      // The window only shows progress: without one the update still installs, out of sight.
      say(shown ? `the install window opened (pid ${shown})` : 'no install window could open; installing without one');
    } catch (error) {
      say(`no install window could open (${error?.message || error}); installing without one`);
    }
  }
  say(`update to v${version}: waiting for SynaBun (pid ${pid}) to quit`);
  if (!(await waitUntil(() => !ops.alive(pid) || ops.exists(join(stateDir, 'window-cancel')), limits.quitMs))) return fail('SynaBun did not quit within two minutes');
  if (ops.exists(join(stateDir, 'window-cancel'))) return fail('The visible update was cancelled before replacement');
  if (!ops.exists(join(instDir, exe))) return fail(`SynaBun is not in ${instDir}`);
  if (!ops.exists(installer)) {
    const result = fail('the downloaded installer is gone');
    if (relaunch) openApp();
    return result;
  }

  await stopUnder(instDir);
  // An old copy a finished update could not remove: it is not needed, the copy in the folder runs.
  if (ops.exists(backup)) { say(`removing ${basename(backup)} from an earlier update`); try { ops.remove(backup); } catch {} }
  const aside = await move(instDir, backup);
  if (!aside.moved) {
    const busy = holders(instDir) || [];
    const reason = `files in ${instDir} are in use${busy.length ? ` by ${[...new Set(busy.map(item => item.name || item.pid))].join(', ')}` : ''} (${aside.error?.code || 'unknown'}); nothing was installed`;
    const result = fail(reason);
    if (relaunch) openApp();
    return result;
  }
  say(`the installed copy is aside: ${backup}`);

  show('installing');
  let lastPercent = -1;
  const ran = await ops.runInstaller(installer, instDir, limits.installMs, (progress) => {
    const percent = percentOf(progress);
    if (percent === null || percent === lastPercent) return;
    lastPercent = percent;
    show('installing', { progress });
  });
  const found = ops.readVersion(instDir);
  say(`the installer ended (exit ${ran?.status ?? 'none'}${ran?.error ? `, ${ran.error}` : ''}); the folder holds ${found ? `v${found}` : 'no SynaBun'}`);
  if (ran?.status !== 0 || String(found) !== String(version) || !ops.exists(join(instDir, exe))) {
    const reason = ran?.error ? `the installer could not run (${ran.error})`
      : String(found) !== String(version) ? `the installer left ${found ? `v${found}` : 'no SynaBun'} instead of v${version} (exit ${ran?.status ?? 'none'})`
        : `the installer failed (exit ${ran?.status ?? 'none'})`;
    const restored = await restore();
    const result = fail(restored ? `${reason}; the installed version was kept` : `${reason}; the old copy could not be put back in ${instDir}`, restored ? 'restored' : 'broken');
    if (restored && relaunch) openApp();
    return result;
  }
  mark('swapped');
  say('the new copy is in place');
  if (!relaunch) {
    show('ready');
    return { ok: true, started: null };
  }

  show('restarting');
  unmark('started');
  openApp(['--synabun-updated']);
  if (await waitUntil(() => ops.exists(join(stateDir, 'started')), limits.startMs)) {
    say('the new copy started');
    // The install window stays until the new copy's own window is up (it writes window-up), so there is no moment
    // with neither; a copy that never says so (it starts out of sight) lets it go after upMs.
    if (windowConfig) {
      const up = await waitUntil(() => ops.exists(join(stateDir, 'window-up')), limits.upMs);
      say(up ? 'the new copy\'s window is up: the install window closes' : 'the new copy did not say its window is up: the install window closes');
      show('ready');
    }
    try { ops.remove(backup); } catch (error) { say(`the old copy stays in ${backup}: ${error?.message || error}`); }
    unmark('swapped');
    return { ok: true, started: true };
  }
  say('the new copy did not start within three minutes: putting the old one back');
  const restored = await restore();
  unmark('swapped');
  if (!restored) return fail('the new copy did not start, and the old copy could not be put back', 'broken');
  mark('rolled-back');
  show('failed', { outcome: 'rolled-back', reason: `v${version} did not start within three minutes` });
  openApp();
  return { ok: false, rolledBack: true };
}

/** What runs from a folder, by executable path (PowerShell, the folder passed in the environment). Null when it cannot tell. */
function listUnderWindows(folder) {
  const script = '$root = [IO.Path]::GetFullPath($env:SYNABUN_SWAP_LIST).TrimEnd([char]92) + [char]92; '
    + '@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } '
    + '| ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name } }) | ConvertTo-Json -Compress';
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, SYNABUN_SWAP_LIST: folder }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (result.status !== 0) return null;
  const text = String(result.stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(item => Number.isInteger(item?.pid) && item.pid !== process.pid);
  } catch {
    return null;
  }
}

/** Windows PowerShell 5.1, by its full path (never a `powershell` looked up on PATH). */
export function windowsPowerShell(env = process.env) {
  return join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The command line of the install window (install-window.ps1): STA for WPF, no profile, the files by their paths. */
export function installWindowArgs({ script, config, view, shown, watchdog, languageMode = null }) {
  return ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Config', config, '-View', view, '-Shown', shown, '-Watchdog', String(watchdog), ...(languageMode ? ['-LanguageMode', languageMode] : [])];
}

/** App Control can give a policy-trusted signed script FullLanguage; CLM/blocked/timeout uses native. */
export function installWindowChoice({ mode = '', shown = false, nativeAvailable = false } = {}) {
  if (shown && mode.trim() === 'FullLanguage') return 'powershell';
  return nativeAvailable ? 'native' : 'abort';
}

/** Small native protocol: fixed UTF-16LE lines, no executable code and no locale/code-page ambiguity. */
export function nativeWindowView(view, config = {}) {
  const fields = [view.phase, view.percent ?? '', view.status, view.error, view.detail, view.log,
    config.text?.close, config.text?.stalled, view.mascot, config.text?.openLog];
  return Buffer.from(fields.map(value => String(value ?? '').replace(/[\r\n\0]/g, ' ').slice(0, 2047)).join('\n') + '\n', 'utf16le');
}

export async function openInstallWindow({ windowDir, stateDir, env = process.env, spawnImpl = spawn,
  exists = existsSync, readText = file => readFileSync(file, 'utf8'), sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = () => Date.now(), log = () => {}, waitMs = 8000 } = {}) {
  if (!windowDir) return null;
  const marker = join(stateDir, 'window-shown');
  const modeFile = join(windowDir, 'language-mode');
  const native = join(windowDir, 'SynaBun-install-window.exe');
  let ps = null;
  let mode = '';
  const start = (file, args, name) => {
    const child = spawnImpl(file, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: windowDir, env: appEnvironment(env) });
    child.on('error', (error) => { log(`${name} install window could not start: ${error?.code || 'no code'}${error?.errno !== undefined ? ` (errno ${error.errno})` : ''}: ${error?.message || error}`); });
    child.on('exit', (code, signal) => { log(`${name} install window exited (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})`); });
    child.unref(); return child;
  };
  try {
    ps = start(windowsPowerShell(env), installWindowArgs({
      script: join(windowDir, 'install-window.ps1'), config: join(windowDir, 'install-window.json'),
      view: join(windowDir, 'install-view.json'), shown: marker, watchdog: process.pid, languageMode: modeFile,
    }), 'PowerShell');
    const until = now() + waitMs;
    do {
      try { mode = readText(modeFile).trim(); } catch {}
      if (exists(marker) && mode === 'FullLanguage') { log('install window language mode: FullLanguage'); return ps.pid || null; }
      if (mode && mode !== 'FullLanguage') break;
      if (ps.exitCode !== null && ps.exitCode !== undefined) break;
      await sleep(100);
    } while (now() < until);
  } catch (error) { log(`PowerShell install window: ${error?.code ? `${error.code}: ` : ''}${error?.message || error}`); }
  log(`install window language mode: ${mode || 'blocked or no startup report'}${ps && ps.exitCode !== null && ps.exitCode !== undefined ? ` (PowerShell exit ${ps.exitCode})` : ''}; selecting native fallback`);
  try { ps?.kill(); } catch {}
  try { rmSync(marker, { force: true }); } catch {}
  if (installWindowChoice({ mode, nativeAvailable: exists(native) }) !== 'native') return null;
  try {
    const child = start(native, [windowDir, stateDir, String(process.pid)], 'native');
    const until = now() + waitMs;
    do {
      if (exists(marker)) return child.pid || null;
      if (child.exitCode !== null && child.exitCode !== undefined) break;
      await sleep(100);
    } while (now() < until);
    try { child.kill(); } catch {}
  } catch (error) { log(`native install window: ${error?.code ? `${error.code}: ` : ''}${error?.message || error}`); }
  return null;
}

/** Writes a file in one rename, so a reader never sees half of it. */
function writeWhole(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  try { renameSync(temp, file); } catch (error) { try { rmSync(temp, { force: true }); } catch {} throw error; }
}

/**
 * The installer, waited for without holding the event loop: its unpacking progress is read from the file it writes
 * (PROGRESS_ENV) twice a second. Resolves { status, error }.
 */
export function runInstallerWithProgress({ installer, instDir, ms, onProgress = () => {}, progressFile, spawnImpl = spawn, readText = (file) => readFileSync(file, 'utf8'), every = 500, env = process.env }) {
  return new Promise((done) => {
    let settled = false;
    let timer = null;
    let killer = null;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(killer);
      read();
      done(result);
    };
    const read = () => {
      if (!progressFile) return;
      let text = null;
      try { text = readText(progressFile); } catch { return; }
      const progress = installerProgress(text);
      if (progress) { try { onProgress(progress); } catch {} }
    };
    try {
      if (progressFile) { try { rmSync(progressFile, { force: true }); } catch {} }
      // NSIS reads /D= raw, to the end of the line: the arguments go as they are, only the program is quoted.
      child = spawnImpl(installer, installerArgs(instDir), {
        argv0: `"${installer}"`, windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore',
        env: progressFile ? { ...env, [PROGRESS_ENV]: progressFile } : env,
      });
    } catch (error) {
      finish({ status: null, error: error?.code || error?.message || String(error) });
      return;
    }
    child.once('error', (error) => finish({ status: null, error: error?.code || error?.message || String(error) }));
    child.once('exit', (code, signal) => finish({ status: code, error: signal ? `ended by ${signal}` : null }));
    timer = setInterval(read, every);
    killer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ status: null, error: 'ETIMEDOUT' });
    }, ms);
  });
}

/** The real system calls, on Windows. */
export function windowsOps({ stateDir, env = process.env, windowDir = null }) {
  const logFile = join(stateDir, 'swap.log');
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise(done => setTimeout(done, ms)),
    log: (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`),
    write: (file, text) => writeFileSync(file, text),
    exists: (path) => existsSync(path),
    remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }),
    rename: (from, to) => renameSync(from, to),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } },
    listUnder: (folder) => listUnderWindows(folder),
    kill: (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 }),
    runInstaller: (installer, instDir, ms, onProgress) => runInstallerWithProgress({
      installer, instDir, ms, onProgress, progressFile: join(stateDir, 'swap', 'install-progress.txt'), env,
    }),
    readVersion: (instDir) => {
      try { return String(JSON.parse(readFileSync(join(instDir, 'resources', 'synabun-package.json'), 'utf8')).version || '') || null; } catch { return null; }
    },
    open: (file, args) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', cwd: dirname(file), env: appEnvironment(env) });
      child.on('error', () => {});
      child.unref();
      return child.pid || null;
    },
    openWindow: () => openInstallWindow({ windowDir, stateDir, env,
      log: line => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`) }),
    writeView: (view) => {
      if (!windowDir) return;
      writeWhole(join(windowDir, 'install-view.json'), `${JSON.stringify(view)}\n`);
      writeWhole(join(windowDir, 'native-view.txt'), nativeWindowView(view, readWindowConfig(windowDir) || {}));
    },
  };
}

/** The install window's config, when the app asked for one and wrote it; null otherwise (the swap shows nothing). */
export function readWindowConfig(windowDir) {
  if (!windowDir) return null;
  try {
    const config = JSON.parse(readFileSync(join(windowDir, 'install-window.json'), 'utf8'));
    return config?.synabunInstallWindow === 1 && config.views ? config : null;
  } catch { return null; }
}

// Run as a script: `node win-swap.mjs`, everything else in the environment.
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  const params = swapParams(process.env);
  if (!params) process.exit(2);
  const config = readWindowConfig(params.windowDir);
  if (config) params.window = { config };
  const ops = windowsOps({ stateDir: params.stateDir, env: process.env, windowDir: config ? params.windowDir : null });
  runWindowsSwap(params, ops)
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      try { appendFileSync(join(params.stateDir, 'swap.log'), `${new Date().toISOString()} failed: ${error?.stack || error}\n`); } catch {}
      try { writeFileSync(join(params.stateDir, 'swap-failed'), `the update script failed: ${error?.message || error}`); } catch {}
      if (config) { try { ops.writeView(composeWindowView(config, { phase: 'failed', outcome: 'stalled', reason: `the update script failed: ${error?.message || error}` })); } catch {} }
      process.exit(1);
    });
}

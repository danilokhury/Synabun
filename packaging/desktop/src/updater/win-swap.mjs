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
});

export const SWAP_LIMITS = Object.freeze({ quitMs: 2 * 60 * 1000, stopMs: 15 * 1000, moveMs: 20 * 1000, installMs: 15 * 60 * 1000, startMs: 3 * 60 * 1000 });

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
  };
  const startMs = Number(value('startMs'));
  if (Number.isInteger(startMs) && startMs >= 1000 && startMs <= SWAP_LIMITS.startMs) params.limits = { startMs };
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (![params.instDir, params.installer, params.stateDir].every(absolute)) return null;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(params.version)) return null;
  if (!/^[\w.-]+\.exe$/i.test(params.exe)) return null;
  return params;
}

/** The environment the new copy opens with: the app's own, without this script's parameters. */
export function appEnvironment(env = process.env) {
  const next = { ...env };
  for (const key of Object.values(SWAP_ENV)) delete next[key];
  return next;
}

/**
 * The swap. `ops` are the system calls: now, sleep, log, write, exists, remove,
 * rename, alive, listUnder (null when it cannot tell), kill, runInstaller,
 * readVersion, open. Resolves { ok, reason?, started?, rolledBack? }.
 */
export async function runWindowsSwap(params, ops) {
  const { pid, instDir, installer, version, stateDir, relaunch, exe = 'SynaBun.exe' } = params;
  const limits = { ...SWAP_LIMITS, ...(params.limits || {}) };
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
  const fail = (reason) => {
    say(`failed: ${reason}`);
    mark('swap-failed', reason);
    return { ok: false, reason };
  };

  say(`update to v${version}: waiting for SynaBun (pid ${pid}) to quit`);
  if (!(await waitUntil(() => !ops.alive(pid), limits.quitMs))) return fail('SynaBun did not quit within two minutes');
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

  const ran = await ops.runInstaller(installer, instDir, limits.installMs);
  const found = ops.readVersion(instDir);
  say(`the installer ended (exit ${ran?.status ?? 'none'}${ran?.error ? `, ${ran.error}` : ''}); the folder holds ${found ? `v${found}` : 'no SynaBun'}`);
  if (ran?.status !== 0 || String(found) !== String(version) || !ops.exists(join(instDir, exe))) {
    const reason = ran?.error ? `the installer could not run (${ran.error})`
      : String(found) !== String(version) ? `the installer left ${found ? `v${found}` : 'no SynaBun'} instead of v${version} (exit ${ran?.status ?? 'none'})`
        : `the installer failed (exit ${ran?.status ?? 'none'})`;
    const restored = await restore();
    const result = fail(restored ? `${reason}; the installed version was kept` : `${reason}; the old copy could not be put back in ${instDir}`);
    if (restored && relaunch) openApp();
    return result;
  }
  mark('swapped');
  say('the new copy is in place');
  if (!relaunch) return { ok: true, started: null };

  unmark('started');
  openApp(['--synabun-updated']);
  if (await waitUntil(() => ops.exists(join(stateDir, 'started')), limits.startMs)) {
    say('the new copy started');
    try { ops.remove(backup); } catch (error) { say(`the old copy stays in ${backup}: ${error?.message || error}`); }
    unmark('swapped');
    return { ok: true, started: true };
  }
  say('the new copy did not start within three minutes: putting the old one back');
  const restored = await restore();
  unmark('swapped');
  if (!restored) return fail('the new copy did not start, and the old copy could not be put back');
  mark('rolled-back');
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

/** The real system calls, on Windows. */
export function windowsOps({ stateDir, env = process.env }) {
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
    runInstaller: async (installer, instDir, ms) => {
      // NSIS reads /D= raw, to the end of the line: the arguments go as they are, only the program is quoted.
      const result = spawnSync(installer, installerArgs(instDir), {
        argv0: `"${installer}"`, windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore', timeout: ms,
      });
      return { status: result.status, error: result.error ? (result.error.code || result.error.message) : null };
    },
    readVersion: (instDir) => {
      try { return String(JSON.parse(readFileSync(join(instDir, 'resources', 'synabun-package.json'), 'utf8')).version || '') || null; } catch { return null; }
    },
    open: (file, args) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', cwd: dirname(file), env: appEnvironment(env) });
      child.on('error', () => {});
      child.unref();
      return child.pid || null;
    },
  };
}

// Run as a script: `node win-swap.mjs`, everything else in the environment.
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  const params = swapParams(process.env);
  if (!params) process.exit(2);
  runWindowsSwap(params, windowsOps({ stateDir: params.stateDir, env: process.env }))
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      try { appendFileSync(join(params.stateDir, 'swap.log'), `${new Date().toISOString()} failed: ${error?.stack || error}\n`); } catch {}
      try { writeFileSync(join(params.stateDir, 'swap-failed'), `the update script failed: ${error?.message || error}`); } catch {}
      process.exit(1);
    });
}

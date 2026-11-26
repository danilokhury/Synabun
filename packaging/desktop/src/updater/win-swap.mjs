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

import { execFile, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, win32 } from 'node:path';
import { promisify } from 'node:util';
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

export const SWAP_LIMITS = Object.freeze({ quitMs: 2 * 60 * 1000, stopMs: 15 * 1000, moveMs: 20 * 1000, diagMs: 5 * 1000, installMs: 15 * 60 * 1000, startMs: 3 * 60 * 1000, upMs: 30 * 1000 });

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
      const launchPid = opened?.pid ?? opened;
      say(`opened ${exe}${args.length ? ` ${args.join(' ')}` : ''}${launchPid ? ` (pid ${launchPid})` : ''}`);
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
  const formatHolder = (item) => {
    const base = `${item?.name || '?'} (${item?.pid ?? '?'})`;
    return item?.detail ? `${base} [${item.detail}]` : base;
  };
  // Keep every observed identity for the failure report, including ones stopped on earlier ticks.
  const observed = new Map();
  const holderKey = proc => JSON.stringify([proc.pid, proc.created ?? null, proc.name]);
  const record = (proc, label) => {
    observed.set(holderKey(proc), { proc, label });
  };
  const scan = (folder, deadline) => {
    const timeoutMs = deadline - ops.now();
    if (timeoutMs <= 0) return null;
    try {
      const found = ops.listUnder(folder, {
        timeoutMs,
        onSuspected: list => {
          for (const proc of list) {
            if (!observed.has(holderKey(proc))) say(`${formatHolder(proc)}: ${proc.label}`);
            record(proc, proc.label);
          }
        },
      });
      if (!Array.isArray(found)) return null;
      for (const proc of found) record(proc, 'suspected');
      return found;
    } catch { return null; }
  };
  const stopTick = async (folder, deadline) => {
    const running = scan(folder, deadline);
    if (running === null) {
      say(`could not list processes under ${folder}; retrying`);
      return false;
    }
    if (!running.length) return true;
    say(`stopping what runs from ${folder}: ${running.map(formatHolder).join(', ')}`);
    for (const proc of running) {
      const timeoutMs = deadline - ops.now();
      if (timeoutMs <= 0) break;
      try {
        const result = await ops.kill(proc.pid, proc, { instDir: folder, timeoutMs });
        if (result?.killed) record(proc, 'killed');
      } catch {}
    }
    return false;
  };
  const waitTick = async deadline => {
    const ms = Math.min(500, deadline - ops.now());
    if (ms > 0) await ops.sleep(ms);
  };
  const stopUnder = async folder => {
    const deadline = ops.now() + limits.stopMs;
    while (ops.now() < deadline) {
      if (await stopTick(folder, deadline)) return;
      await waitTick(deadline);
    }
    say(`stop before move timed out for ${folder}; rescanning on rename retries`);
  };
  const diagnose = async folder => {
    // Cap all final diagnostics under one separate deadline so a slow CIM never delays relaunching the old copy.
    const diagUntil = ops.now() + limits.diagMs;
    let busy = scan(folder, diagUntil);
    if (busy === null && ops.now() + 200 < diagUntil) {
      await ops.sleep(200);
      busy = scan(folder, diagUntil);
    }
    let lockedFiles = [];
    if (typeof ops.probeLockedFiles === 'function' && diagUntil - ops.now() > 0) {
      try {
        const probed = ops.probeLockedFiles(folder, { maxMs: Math.max(1, diagUntil - ops.now()) });
        if (Array.isArray(probed)) lockedFiles = probed.filter(item => item && (typeof item === 'string' || typeof item.file === 'string'));
      } catch {}
    }
    const formatLocked = (item) => (typeof item === 'string' ? item : `${item.file}${item.code ? ` (${item.code})` : ''}`);
    if (busy === null) {
      say(`final lock check for ${folder}: process enumeration failed`);
    }
    for (const { proc, label } of observed.values()) {
      say(`final lock check for ${folder}: ${formatHolder(proc)}: ${label}`);
    }
    if (lockedFiles.length > 0) {
      say(`final lock check for ${folder}: suspected locked files: ${lockedFiles.map(formatLocked).join(', ')}`);
    }
    return { busy, lockedFiles };
  };
  const move = async (from, to, { rescan = true } = {}) => {
    const deadline = ops.now() + limits.moveMs;
    for (;;) {
      try {
        ops.rename(from, to);
        return { moved: true };
      } catch (error) {
        if (ops.now() >= deadline) {
          const diagnostics = rescan ? await diagnose(from) : {};
          return { moved: false, error, ...diagnostics };
        }
      }
      if (rescan) await stopTick(from, deadline);
      await waitTick(deadline);
    }
  };
  const restore = async ({ replacement = null } = {}) => {
    if (!ops.exists(backup)) return ops.exists(join(instDir, exe));
    if (replacement?.stop) {
      say(`stopping hung replacement launch via process handle (pid ${replacement.pid})`);
      try { replacement.stop(); } catch {}
    }
    await stopUnder(instDir);
    if (ops.exists(instDir)) {
      const aside = await move(instDir, failedCopy);
      if (!aside.moved) { say(`the new copy could not be moved away: ${aside.error?.code || aside.error?.message || 'unknown'}`); return false; }
    }
    const back = await move(backup, instDir, { rescan: false });
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
  const aside = await move(instDir, backup, { rescan: true });
  if (!aside.moved) {
    const { busy, lockedFiles } = aside;
    const errCode = aside.error?.code || 'unknown';
    const holderNames = Array.isArray(busy) && busy.length ? [...new Set(busy.map(item => item.name || item.pid))].join(', ') : '';
    const lockedSummary = lockedFiles.length ? `suspected locked: ${lockedFiles.slice(0, 5).map(item => (typeof item === 'string' ? item : item.file)).join(', ')}` : '';
    let detail = errCode;
    if (!holderNames && lockedSummary) detail = `${errCode}, ${lockedSummary}`;
    else if (!holderNames && busy === null) detail = `process enumeration failed, ${errCode}`;
    const reason = `files in ${instDir} are in use${holderNames ? ` by ${holderNames}` : ''} (${detail}); nothing was installed`;
    const result = fail(reason);
    if (relaunch) openApp();
    return result;
  }
  observed.clear();
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
  const replacement = openApp(['--synabun-updated']);
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
  const restored = await restore({ replacement });
  unmark('swapped');
  if (!restored) return fail('the new copy did not start, and the old copy could not be put back', 'broken');
  mark('rolled-back');
  show('failed', { outcome: 'rolled-back', reason: `v${version} did not start within three minutes` });
  openApp();
  return { ok: false, rolledBack: true };
}

// Every process as one JSON array, written as base64 of its UTF-8 so Unicode user paths
// never mangle through Windows console code pages, and no caller path ever reaches PowerShell.
function processQuery(source) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$rows = @(' + source + ' | ForEach-Object { $created = $null; '
      + "if ($_.CreationDate) { $created = $_.CreationDate.ToUniversalTime().ToString('o') }; "
      + '[pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; '
      + 'exe = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine; created = $created } })',
    '$json = ConvertTo-Json -InputObject $rows -Compress -Depth 2',
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))',
  ].join('; ');
}

export const PROCESS_LIST_SCRIPT = processQuery('Get-CimInstance -ClassName Win32_Process');

/** Parse the base64-encoded UTF-8 JSON emitted by PROCESS_LIST_SCRIPT, or null on any failure. */
export function parseProcessList(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8').replace(/^\uFEFF/, '');
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter(row => Number.isInteger(row?.pid) && row.pid > 0)
      .map(row => ({
        pid: row.pid,
        name: String(row.name || ''),
        exe: String(row.exe || ''),
        cmd: String(row.cmd || ''),
        created: validCreationTime(row.created) ? row.created : null,
      }));
  } catch {
    return null;
  }
}

// Keep the full CIM timestamp. JavaScript Date truncates it to milliseconds.
const validCreationTime = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));

function pathKey(path) {
  if (!path) return '';
  return win32.normalize(path).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

function canonicalKey(path, realpath) {
  if (typeof path !== 'string' || !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(path)) return '';
  try { return pathKey(realpath(path)); } catch { return ''; }
}

const BUNDLED_NODE = 'resources/runtime/node.exe';
// Current releases carry Git as an archive. Older installs have these pinned binaries in resources/git.
const OWN_IMAGES = new Set([
  'synabun.exe', BUNDLED_NODE, 'resources/cloudflared/cloudflared.exe',
  'resources/git/bin/bash.exe', 'resources/git/usr/bin/bash.exe',
  'resources/git/cmd/git.exe', 'resources/git/ucrt64/bin/git.exe',
]);

// Only accept a direct packaged script invocation. Unknown flags, eval, relative scripts and
// arbitrary later arguments never establish ownership. These two flags are used by our launcher and forks.
function bundledScript(cmd, root, realpath) {
  const direct = /^\s*(?:"[^"]+"|[^\s"]+)\s+(?:(?:--disable-warning=ExperimentalWarning|--max-old-space-size=\d+)\s+)*(?:"([^"]+)"|([^\s"]+))(?=\s|$)/.exec(cmd || '');
  const script = direct?.[1] ?? direct?.[2];
  if (!script || !win32.isAbsolute(script)) return false;
  // node-pty forks this extensionless module name. The shipped file is conpty_console_list_agent.js.
  const file = /[\\/]node-pty[\\/]lib[\\/]conpty_console_list_agent$/i.test(script) ? script + '.js' : script;
  const key = canonicalKey(file, realpath);
  return key === root + '/resources/bootstrap.mjs'
    || (key.startsWith(root + '/resources/app/') && /\.[cm]?js$/.test(key));
}

/** The CIM image must resolve in full to a shipped executable inside this installation. */
export function inspectProcessesUnder(processes, folder, { selfPid = process.pid, realpath = realpathSync.native, backendOnly = false, deadline = Infinity } = {}) {
  const resolved = canonicalKey(folder, realpath);
  const root = resolved && win32.relative(win32.parse(resolved).root, resolved) ? resolved : '';
  const references = [pathKey(folder), root].filter(Boolean);
  const verified = [];
  const suspected = [];
  for (const proc of processes) {
    if (Date.now() >= deadline) return null;
    const image = canonicalKey(proc.exe, realpath);
    const rel = root && image.startsWith(root + '/') ? image.slice(root.length + 1) : '';
    const own = backendOnly ? rel === 'synabun.exe' || rel === BUNDLED_NODE : OWN_IMAGES.has(rel);
    if (own && proc.pid > 4 && proc.pid !== selfPid && validCreationTime(proc.created)
        && (rel !== BUNDLED_NODE || bundledScript(proc.cmd, root, realpath))) {
      verified.push(proc);
      continue;
    }
    const mentions = `${proc.exe}\n${proc.cmd}`.replace(/\\/g, '/').toLowerCase();
    if (rel || references.some(ref => mentions.split(ref).slice(1).some(tail => !tail || /^[/'"\s,;)]/.test(tail)))) {
      const label = !image || !root || own ? 'suspected' : "left running (not SynaBun's own executable)";
      suspected.push({ ...proc, label });
    }
  }
  return { verified, suspected };
}

const clampTimeout = (timeoutMs, fallback = 15000) => {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(30000, Math.floor(n)));
};

/** Full path to Windows taskkill.exe (never looked up on PATH). */
export function windowsTaskkill(env = process.env) {
  return join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
}

const execFileAsync = promisify(execFile);

/** Read the owning process of the IPv4 loopback listener, or one recorded process by PID. */
export async function queryWindowsProcess({ port, pid }, {
  exec = execFileAsync, env = process.env, timeoutMs = 3000,
} = {}) {
  let source;
  if (Number.isInteger(pid) && pid > 0) {
    source = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`;
  } else if (Number.isInteger(port) && port > 0 && port <= 65535) {
    source = `Get-NetTCPConnection -State Listen -LocalPort ${port}`
      + " | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::') }"
      + ' | Select-Object -ExpandProperty OwningProcess -Unique'
      + ' | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId = $_" }';
  } else return null;
  if (timeoutMs <= 0) return null;
  try {
    const { stdout } = await exec(windowsPowerShell(env), ['-NoProfile', '-NonInteractive', '-Command', processQuery(source)], {
      env, encoding: 'utf8', windowsHide: true, timeout: clampTimeout(timeoutMs), maxBuffer: 4 * 1024 * 1024,
    });
    const rows = parseProcessList(stdout);
    return rows?.length === 1 && (pid == null || rows[0].pid === pid) ? rows[0] : null;
  } catch { return null; }
}

/** Recheck the executable and the full CIM creation timestamp immediately before each individual kill. */
export async function killVerifiedProcessWindows(target, {
  instDir, backendOnly = false, realpath = realpathSync.native, exec = execFileAsync, env = process.env,
  timeoutMs = 15000, now = Date.now, log = () => {},
} = {}) {
  if (!target || !Number.isInteger(target.pid) || target.pid <= 4 || !validCreationTime(target.created)) return { killed: false };
  const deadline = now() + timeoutMs;
  const live = await queryWindowsProcess({ pid: target.pid }, { exec, env, timeoutMs: deadline - now() });
  if (live?.created !== target.created) {
    log(`skipping pid ${target.pid}: creation time changed or could not be verified`);
    return { killed: false };
  }
  if (!inspectProcessesUnder([live], instDir, { backendOnly, realpath }).verified.length) {
    log(`skipping pid ${target.pid}: live image could not be verified under ${instDir}`);
    return { killed: false };
  }
  const remaining = deadline - now();
  if (remaining <= 0) return { killed: false };
  // taskkill takes a PID, not a process handle. PID reuse between this check and taskkill is still possible.
  try {
    await exec(windowsTaskkill(env), ['/PID', String(target.pid), '/F'], { env, windowsHide: true, timeout: clampTimeout(remaining) });
    return { killed: true };
  } catch { return { killed: false }; }
}

/**
 * List verified SynaBun processes holding `folder` on Windows via PowerShell CIM within `timeoutMs`.
 * Returns an array of verified targets on success, or null when enumeration failed or budget expired
 * (caller must retry, never treat null as empty). Any non-verified `folder` references are reported
 * via `onSuspected` for logging and never returned for killing.
 */
export function listUnderWindows(folder, {
  spawn = spawnSync, env = process.env, selfPid = process.pid,
  realpath = realpathSync.native, timeoutMs = SWAP_LIMITS.stopMs, onSuspected = null,
} = {}) {
  if (Number.isFinite(timeoutMs) && timeoutMs <= 0) return null;
  // On non-Windows hosts running win-swap.mjs directly as a subprocess test, powershell.exe does not exist.
  if (spawn === spawnSync && process.platform !== 'win32') return [];
  const deadline = Date.now() + timeoutMs;
  const powershell = windowsPowerShell(env);
  const result = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROCESS_LIST_SCRIPT], {
    env, encoding: 'utf8', windowsHide: true, timeout: clampTimeout(timeoutMs, SWAP_LIMITS.stopMs), maxBuffer: 64 * 1024 * 1024,
  });
  if (!result || result.error || result.status !== 0) return null;
  const processes = parseProcessList(result.stdout);
  if (!processes) return null;
  const matches = inspectProcessesUnder(processes, folder, { selfPid, realpath, deadline });
  if (!matches || Date.now() >= deadline) return null;
  const { verified, suspected } = matches;
  if (typeof onSuspected === 'function' && suspected.length > 0) {
    try { onSuspected(suspected); } catch {}
  }
  return verified;
}

const LOCK_PROBE_PRIORITY = [
  'SynaBun.exe',
  'synabun-cli.exe',
  join('resources', 'runtime', 'node.exe'),
  join('resources', 'cloudflared', 'cloudflared.exe'),
  join('resources', 'app.asar'),
];
const LOCK_PROBE_EXT = /\.(?:exe|dll|node|asar|cmd|bat|ps1|js|mjs|cjs)$/i;
const LOCK_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ETXTBSY']);

/**
 * Best-effort heuristic read-only probe to
 * list suspected locked files inside `folder` on final rename failure. Every result is explicitly
 * labeled `suspected: true`. Bounded by `maxFiles` and `maxMs`.
 */
export function probeLockedFiles(folder, {
  maxFiles = 400, maxMs = 2500, maxFound = 15,
  open = openSync, close = closeSync, readdir = readdirSync, exists = existsSync, now = () => Date.now(),
} = {}) {
  if (!folder || !exists(folder) || maxMs <= 0) return [];
  const deadline = now() + maxMs;
  const found = [];
  const seen = new Set();
  let checked = 0;
  const testFile = (fullPath) => {
    if (found.length >= maxFound || checked >= maxFiles || now() >= deadline) return;
    if (seen.has(fullPath)) return;
    seen.add(fullPath);
    checked++;
    let fd = null;
    try {
      fd = open(fullPath, 'r');
    } catch (error) {
      if (LOCK_ERROR_CODES.has(error?.code)) {
        found.push({ file: relative(folder, fullPath).replace(/\\/g, '/'), code: error.code, suspected: true });
      }
    } finally {
      if (fd !== null) { try { close(fd); } catch {} }
    }
  };
  for (const rel of LOCK_PROBE_PRIORITY) {
    if (now() >= deadline) break;
    const full = join(folder, rel);
    if (exists(full)) testFile(full);
  }
  const queue = [folder];
  while (queue.length && found.length < maxFound && checked < maxFiles && now() < deadline) {
    const dir = queue.shift();
    let entries;
    try { entries = readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (found.length >= maxFound || checked >= maxFiles || now() >= deadline) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && LOCK_PROBE_EXT.test(entry.name)) testFile(full);
    }
  }
  return found;
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
  const writeLog = (line) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch {} };
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise(done => setTimeout(done, ms)),
    log: (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`),
    write: (file, text) => writeFileSync(file, text),
    exists: (path) => existsSync(path),
    remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }),
    rename: (from, to) => renameSync(from, to),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } },
    listUnder: (folder, opts = {}) => listUnderWindows(folder, { env, ...opts }),
    probeLockedFiles: (folder, opts = {}) => probeLockedFiles(folder, opts),
    kill: (_pid, target, opts = {}) => killVerifiedProcessWindows(target, { ...opts, env, log: writeLog }),
    runInstaller: (installer, instDir, ms, onProgress) => runInstallerWithProgress({
      installer, instDir, ms, onProgress, progressFile: join(stateDir, 'swap', 'install-progress.txt'), env,
    }),
    readVersion: (instDir) => {
      try { return String(JSON.parse(readFileSync(join(instDir, 'resources', 'synabun-package.json'), 'utf8')).version || '') || null; } catch { return null; }
    },
    open: (file, args) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', cwd: dirname(file), env: appEnvironment(env) });
      let exited = false;
      child.once('error', () => { exited = true; });
      child.once('exit', () => { exited = true; });
      child.unref();
      return {
        pid: child.pid || null,
        stop: () => {
          if (!exited && child.exitCode === null && child.signalCode === null) {
            try { child.kill(); } catch {}
          }
        },
      };
    },
    openWindow: () => openInstallWindow({ windowDir, stateDir, env, log: writeLog }),
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

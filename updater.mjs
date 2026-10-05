#!/usr/bin/env node
// SynaBun updater.
//
// Normal flow:
//   1. The running server copies this file into a user-data staging directory.
//   2. The staged runner calls it with --payload payload.json.
//   3. This process waits for the old server to exit, then runs npm i -g.
//
// The payload names one exact version (installSpec "synabun@2.0.1"): the one the
// update check showed. It is what gets installed and what the handoff marker
// records. A payload that names a target must pin exactly that version; a
// dist-tag, a missing spec or another version is refused. Only an invocation
// with no target at all (the legacy --tag form) installs a dist-tag.
//
// After the install the updater starts SynaBun again and watches the start:
// a launcher that stops (its pre-update snapshot failed, say) is reported
// here with its message, not as "launched".
//
// Keeping the updater outside the installed package is intentional. On Windows,
// running from node_modules/synabun can hold locks on the directory npm needs to
// rename during a global update.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const payload = loadPayload(args.payload);

const legacyTag = sanitizeTag(args.tag || 'latest');
// The version the payload says is being installed, when it names one.
const payloadTarget = payload.target == null || String(payload.target).trim() === '' ? null : String(payload.target).trim();
const requestedSpec = payload.installSpec || args['install-spec'] || null;
// The dist-tag default exists only for an invocation that names no target.
const installSpec = sanitizeInstallSpec(requestedSpec || (payloadTarget ? '' : `synabun@${legacyTag}`));
const displayCommand = payload.displayCommand || `npm i -g ${installSpec}`;
// The exact version the spec pins, or null for a dist-tag spec (legacy callers).
const pinnedVersion = /^synabun@(\d.*)$/.exec(installSpec || '')?.[1] || null;
const targetVersion = pinnedVersion || payloadTarget || null;
// Where the launcher leaves its stop message (lib/first-launch-protection.js).
const LAUNCHER_STOP_MARKER = '===== launcher stopped ';
const launcherLogPath = payload.launcherLogPath
  || (payload.handoffPath ? join(dirname(payload.handoffPath), 'server-stderr.log') : null);
// How long the relaunch is watched before the updater lets go of it.
const RELAUNCH_OBSERVE_MS = Number.isFinite(payload.relaunchObserveMs) && payload.relaunchObserveMs >= 0
  ? Math.min(payload.relaunchObserveMs, 120000)
  : 20000;
const serverPid = toPid(payload.serverPid ?? args.pid);
const cleanupPids = sanitizePidList(payload.cleanupPids).filter(pid => pid !== serverPid && pid !== process.pid);
const autoRestart = payload.autoRestart != null ? !!payload.autoRestart : !!args.restart;
const safeCwd = payload.cwd || process.cwd();
const noHold = !!args['no-hold'];

const isWin = process.platform === 'win32';
const NPM_BIN = isWin ? 'npm.cmd' : 'npm';
const HR = '='.repeat(56);

process.on('SIGINT', () => {});

try {
  if (requestedSpec && !installSpec) throw new Error('No valid SynaBun install target was provided.');
  if (payloadTarget && !pinnedVersion) {
    throw new Error(`The update payload shows v${printable(payloadTarget)} but does not pin that exact version to install. Nothing was installed.`);
  }
  if (!installSpec) throw new Error('No valid SynaBun install target was provided.');
  if (payloadTarget && payloadTarget !== pinnedVersion) {
    throw new Error(`The update payload shows v${printable(payloadTarget)} but would install v${pinnedVersion}. Nothing was installed.`);
  }

  console.log(`\n${HR}`);
  console.log(`  SynaBun Updater`);
  if (payload.current || payloadTarget) {
    console.log(`  ${payload.current || '?'} -> ${targetVersion || installSpec}`);
  }
  console.log(`${HR}\n`);

  if (serverPid) {
    console.log(`Waiting for SynaBun server (PID ${serverPid}) to exit...`);
    const exited = await waitForExit(serverPid, 30000);
    if (exited) {
      console.log('  Server exited.\n');
    } else {
      console.warn('  Server still alive after 30s - forcing server process kill.\n');
      forceKillPid(serverPid);
      await sleep(1500);
    }
  } else {
    console.log('No server PID provided - assuming already stopped.\n');
  }

  await sleep(1500);
  if (cleanupPids.length) {
    console.log(`Cleaning up ${cleanupPids.length} pre-existing child process${cleanupPids.length === 1 ? '' : 'es'}...`);
    for (const pid of cleanupPids) {
      if (!isPidAlive(pid)) continue;
      forceKillTree(pid);
    }
    await sleep(1000);
    console.log('  Cleanup complete.\n');
  }

  console.log(`Running: ${displayCommand}\n`);
  console.log(HR);
  const installRes = spawnSync(NPM_BIN, ['i', '-g', installSpec], {
    cwd: safeCwd,
    stdio: 'inherit',
    shell: isWin,
  });
  console.log(HR);

  if (installRes.error) throw installRes.error;
  if (installRes.status !== 0) {
    console.error(`\nnpm update command failed with exit code ${installRes.status}.\n`);
    markHandoff('failed', { failedAt: new Date().toISOString(), reason: `npm exited with code ${installRes.status}` });
    printFixTips(displayCommand);
    await maybeHoldOpen(noHold);
    process.exit(installRes.status || 1);
  }

  console.log(`\nSynaBun update installed.\n`);
  markHandoff('installed', { installedAt: new Date().toISOString() });

  if (autoRestart) {
    console.log('Relaunching SynaBun...\n');
    const outcome = await relaunchAndObserve();
    if (outcome.state === 'running') {
      console.log('  synabun launched (detached).\n');
    } else {
      reportRelaunchFailure(outcome);
      await maybeHoldOpen(noHold);
      process.exit(outcome.code > 0 ? outcome.code : 1);
    }
  } else {
    console.log('Run "synabun" to start the new version.\n');
  }

  await maybeHoldOpen(noHold);
  process.exit(0);
} catch (err) {
  markHandoff('failed', { failedAt: new Date().toISOString(), reason: String(err?.message || err) });
  console.error(`\nUpdate failed: ${err.message}\n`);
  if (payload.safetySnapshot) console.error(`Your verified pre-update snapshot is safe at:\n  ${payload.safetySnapshot}\n`);
  printFixTips(displayCommand);
  await maybeHoldOpen(noHold);
  process.exit(1);
}

// The handoff marker tells the launcher what this update did. `installed` lets
// it reuse the pre-update snapshot for exactly this version; `failed` closes a
// `prepared` marker so it is never mistaken for an update that happened.
function markHandoff(status, extra = {}) {
  if (!payload.handoffPath) return;
  try {
    writeFileSync(payload.handoffPath, JSON.stringify({
      version: 1,
      status,
      ...extra,
      current: payload.current || null,
      target: targetVersion || installSpec,
      snapshotPath: payload.safetySnapshot || null,
    }, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.warn(`Could not update the upgrade handoff marker: ${error.message}`);
  }
}

// Starts SynaBun detached and watches the start for a moment. The launcher
// either stops early (it exits; its reason is in its log) or passes its
// pre-update check, which it records by closing the handoff as `verified`.
// Still running when the watch ends counts as launched.
async function relaunchAndObserve() {
  const startedAt = Date.now();
  let exited = null;
  let spawnError = null;
  let child;
  try {
    child = spawn(isWin ? 'synabun.cmd' : 'synabun', [], {
      cwd: safeCwd,
      detached: true,
      stdio: 'ignore',
      shell: isWin,
    });
  } catch (error) {
    return { state: 'not-started', message: error.message, startedAt };
  }
  child.once('error', (error) => { spawnError = error; });
  child.once('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = startedAt + RELAUNCH_OBSERVE_MS;
  for (;;) {
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    if (spawnError) return { state: 'not-started', message: spawnError.message, startedAt };
    if (exited) return { state: 'exited', code: exited.code, signal: exited.signal, startedAt };
    if (handoffStatus() === 'verified' || Date.now() >= deadline) break;
  }
  child.unref();
  return { state: 'running', startedAt };
}

function handoffStatus() {
  if (!payload.handoffPath) return null;
  try { return JSON.parse(readFileSync(payload.handoffPath, 'utf8'))?.status || null; } catch { return null; }
}

function reportRelaunchFailure(outcome) {
  const how = outcome.state === 'exited'
    ? ` (it exited with ${outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`})`
    : '';
  console.error(`The update was installed, but SynaBun did not start${how}.`);
  if (outcome.message) console.error(`  ${outcome.message}`);
  const stopMessage = readLauncherStopMessage(launcherLogPath, outcome.startedAt);
  if (stopMessage) console.error(`\n${stopMessage}`);
  if (launcherLogPath) console.error(`\nLauncher log: ${launcherLogPath}`);
  console.error('Run "synabun" in a terminal to see the full output.\n');
}

// The last stop record the launcher wrote since `sinceMs`, or null. Reads only
// the end of the log: the server's stderr shares the file.
function readLauncherStopMessage(path, sinceMs) {
  if (!path) return null;
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    const at = text.lastIndexOf(LAUNCHER_STOP_MARKER);
    if (at < 0) return null;
    const record = text.slice(at).split(/\r?\n/);
    const stoppedAt = Date.parse(record[0].slice(LAUNCHER_STOP_MARKER.length).split(' ')[0]);
    // A record from an earlier launch is not this one's reason.
    if (!Number.isFinite(stoppedAt) || stoppedAt < sinceMs - 2000) return null;
    return record.slice(1, 40).join('\n').trim() || null;
  } catch {
    return null;
  } finally {
    if (fd != null) { try { closeSync(fd); } catch {} }
  }
}

// A value from the payload, safe to print: a version-like string or a placeholder.
function printable(value) {
  return /^[0-9A-Za-z.+-]{1,64}$/.test(value) ? value : '?';
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function loadPayload(path) {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read update payload: ${err.message}`);
  }
}

function sanitizeTag(raw) {
  const allowed = new Set(['latest', 'beta', 'next', 'rc', 'alpha']);
  const t = String(raw || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  return allowed.has(t) ? t : 'latest';
}

function sanitizeInstallSpec(raw) {
  const spec = String(raw || '').trim();
  if (/^synabun@(latest|beta|next|rc|alpha)$/.test(spec)) return spec;
  if (/^synabun@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) return spec;
  return null;
}

function toPid(raw) {
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function sanitizePidList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const pid = toPid(item);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(250);
  }
  return false;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function forceKillTree(pid) {
  try {
    if (isWin) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: true,
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try { spawnSync('pkill', ['-P', String(pid)], { stdio: 'ignore' }); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}

function forceKillPid(pid) {
  try {
    if (isWin) {
      spawnSync('taskkill', ['/pid', String(pid), '/F'], {
        shell: true,
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}

function printFixTips(command) {
  console.error('Common fixes:');
  if (isWin) {
    console.error('  EBUSY/EPERM: close other SynaBun terminals/windows, then retry.');
    console.error('  Run as admin: right-click cmd -> "Run as administrator", then retry.');
    console.error('  Force kill:   taskkill /F /IM node.exe   (warning: kills all node processes)');
  } else {
    console.error('  EACCES: re-run with sudo, or fix global npm prefix permissions.');
    console.error('  Stale lock: rm -rf ~/.npm/_locks/*');
  }
  console.error('  Cache:        npm cache clean --force');
  console.error(`\nManual retry:    ${command}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function maybeHoldOpen(skip) {
  if (skip) return Promise.resolve();
  return new Promise(resolve => {
    console.log('\n[Press Enter to close this window]');
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      process.stdin.once('data', () => resolve());
    } catch {
      setTimeout(resolve, 30000);
    }
  });
}

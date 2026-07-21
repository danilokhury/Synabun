#!/usr/bin/env node
// SynaBun updater.
//
// Normal flow:
//   1. The running server copies this file into a user-data staging directory.
//   2. The staged runner calls it with --payload payload.json.
//   3. This process waits for the old server to exit, then runs npm i -g.
//
// Keeping the updater outside the installed package is intentional. On Windows,
// running from node_modules/synabun can hold locks on the directory npm needs to
// rename during a global update.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));
const payload = loadPayload(args.payload);

const legacyTag = sanitizeTag(args.tag || 'latest');
const installSpec = sanitizeInstallSpec(payload.installSpec || args['install-spec'] || `synabun@${legacyTag}`);
const displayCommand = payload.displayCommand || `npm i -g ${installSpec}`;
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
  if (!installSpec) throw new Error('No valid SynaBun install target was provided.');

  console.log(`\n${HR}`);
  console.log(`  SynaBun Updater`);
  if (payload.current || payload.target) {
    console.log(`  ${payload.current || '?'} -> ${payload.target || installSpec}`);
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
    printFixTips(displayCommand);
    await maybeHoldOpen(noHold);
    process.exit(installRes.status || 1);
  }

  console.log(`\nSynaBun update installed.\n`);
  if (payload.handoffPath) {
    try {
      writeFileSync(payload.handoffPath, JSON.stringify({
        version: 1,
        status: 'installed',
        installedAt: new Date().toISOString(),
        current: payload.current || null,
        target: payload.target || installSpec,
        snapshotPath: payload.safetySnapshot || null,
      }, null, 2) + '\n', 'utf8');
    } catch (error) {
      console.warn(`Could not update the upgrade handoff marker: ${error.message}`);
    }
  }

  if (autoRestart) {
    console.log('Relaunching SynaBun...\n');
    const child = spawn(isWin ? 'synabun.cmd' : 'synabun', [], {
      cwd: safeCwd,
      detached: true,
      stdio: 'ignore',
      shell: isWin,
    });
    child.unref();
    console.log('  synabun launched (detached).\n');
  } else {
    console.log('Run "synabun" to start the new version.\n');
  }

  await maybeHoldOpen(noHold);
  process.exit(0);
} catch (err) {
  console.error(`\nUpdate failed: ${err.message}\n`);
  if (payload.safetySnapshot) console.error(`Your verified pre-update snapshot is safe at:\n  ${payload.safetySnapshot}\n`);
  printFixTips(displayCommand);
  await maybeHoldOpen(noHold);
  process.exit(1);
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

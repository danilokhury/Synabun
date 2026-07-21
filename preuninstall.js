#!/usr/bin/env node

/**
 * SynaBun — NPM preuninstall script
 *
 * Runs before `npm uninstall synabun` AND before `npm i -g synabun@x`
 * overwrites the existing install.
 *
 *   1. Politely ask any running SynaBun server to shut down so its child
 *      processes (opencode sidecar, agents, pty terminals) release file
 *      handles inside neural-interface/. Without this step, npm's rename
 *      step fails with EBUSY on Windows.
 *   2. Remove nested node_modules that cause EPERM/deep-path errors on Windows.
 *   3. Remove the synabun:// protocol handler registration.
 *
 * Graceful — if any step fails, don't block the uninstall. npm will handle
 * the remainder; the user can always retry.
 */

import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Step 1: ask running SynaBun server to shut down cleanly ──
// Default port 3344 (matches NEURAL_PORT default in server.js). If the user
// changed NEURAL_PORT we miss them; that's acceptable since the next steps
// degrade gracefully. We don't want to scan all ports — too invasive for a
// preuninstall script.

await tryGracefulServerShutdown();

async function tryGracefulServerShutdown() {
  const port = Number(process.env.NEURAL_PORT) || 3344;
  const url = `http://127.0.0.1:${port}/api/server/shutdown`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return; // server returned but not OK — proceed anyway
    // Wait for server to actually exit (poll with a HEAD request to /api/health
    // or just sleep — sleep is simpler and uses no network).
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const ping = new AbortController();
        const tt = setTimeout(() => ping.abort(), 500);
        await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ping.signal });
        clearTimeout(tt);
        // Still up — keep waiting.
      } catch {
        // Connection refused / aborted — server is gone.
        break;
      }
    }
    // Extra grace for child processes to release file handles on Windows.
    await new Promise(r => setTimeout(r, 1500));
  } catch {
    // No server listening, fetch unavailable, etc. — just continue.
  }
}

// ── Step 1b: kill any orphaned processes holding file handles ──
//
// Even after a graceful server shutdown (or when no server is running),
// orphaned children can survive: opencode-ai sidecars spawned via cmd.exe,
// MCP servers (claude-memory-mcp) spawned by Claude Code instances rather
// than by SynaBun itself, agent processes, etc. On Windows these orphans
// keep file handles inside the install dir open, causing EBUSY when npm
// tries to rename it.
//
// We nuke any process whose command line references the SynaBun install
// path. This catches every orphan regardless of how they got that way.
// Skips the current PID (we are the preuninstall process itself).

killOrphansInsideInstall();

function killOrphansInsideInstall() {
  const installPath = __dirname;
  const selfPid = process.pid;
  const plat = platform();

  if (plat === 'win32') {
    // PowerShell: Get-CimInstance returns every process with CommandLine.
    // Pass the install path via env so this PowerShell command line does not
    // itself contain the path we are trying to match and kill.
    // Stop-Process -Force kills synchronously; -ErrorAction SilentlyContinue
    // suppresses "process already exited" noise.
    const ps = `
$ErrorActionPreference = 'SilentlyContinue';
$installPath = $env:SYNABUN_INSTALL_PATH;
$selfPid = [int]$env:SYNABUN_PREUNINSTALL_PID;
Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -ne $selfPid -and
    $_.ProcessId -ne $PID -and (
      ($_.CommandLine -and $_.CommandLine -like "*$installPath*") -or
      ($_.ExecutablePath -and $_.ExecutablePath -like "$installPath*")
    )
  } |
  ForEach-Object {
    Write-Host ('  Killing orphan PID ' + $_.ProcessId + ' (' + $_.Name + ')');
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
	`.trim();
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
        stdio: 'inherit',
        timeout: 8000,
        env: {
          ...process.env,
          SYNABUN_INSTALL_PATH: installPath,
          SYNABUN_PREUNINSTALL_PID: String(selfPid),
        },
      });
    } catch {
      // PowerShell unavailable, blocked, or timed out. Fall through.
    }
  } else {
    // Unix: pgrep -f matches against the full command line. -P 1 skips
    // self/children of init we shouldn't touch. We just enumerate then
    // SIGKILL each one that isn't us.
    try {
      const out = execSync(`pgrep -f "${installPath.replace(/[/.*?+^$|(){}\\\[\]]/g, '\\$&')}"`, {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      const pids = out.split('\n')
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n) && n > 0 && n !== selfPid);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    } catch {
      // No matches or pgrep missing — fine.
    }
  }

  // Brief grace for OS to release file handles after killing.
  // Synchronous busy-wait so we run before the rmSync calls below.
  const until = Date.now() + 1500;
  while (Date.now() < until) { /* spin */ }
}

// ── Step 2: remove nested node_modules ──

const dirs = [
  resolve(__dirname, 'neural-interface', 'node_modules'),
  resolve(__dirname, 'mcp-server', 'node_modules'),
];

for (const dir of dirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Non-fatal — npm will handle remaining cleanup
  }
}

// ── Step 3: remove protocol handler ──

const plat = platform();

if (plat === 'win32') {
  try {
    execSync('reg delete "HKCU\\Software\\Classes\\synabun" /f', { stdio: 'pipe' });
  } catch {}
} else if (plat === 'darwin') {
  const appPath = resolve(homedir(), '.synabun', 'SynaBun.app');
  try {
    rmSync(appPath, { recursive: true, force: true });
  } catch {}
} else {
  const desktopFile = resolve(homedir(), '.local', 'share', 'applications', 'synabun.desktop');
  try {
    if (existsSync(desktopFile)) rmSync(desktopFile);
  } catch {}
}

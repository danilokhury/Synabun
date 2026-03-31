#!/usr/bin/env node

/**
 * SynaBun — NPM preuninstall script
 *
 * Runs before `npm uninstall synabun`.
 * Removes nested node_modules that cause EPERM/deep-path errors on Windows.
 * Removes the synabun:// protocol handler registration.
 * Graceful — if cleanup fails, don't block the uninstall.
 */

import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Remove nested node_modules ──

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

// ── Remove protocol handler ──

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

#!/usr/bin/env node

/**
 * Rebuild node-pty native addon for the current platform + Node.js ABI.
 *
 * Runs automatically via postinstall. If the prebuilt binary already works,
 * this is a no-op. If it doesn't (ABI mismatch, missing prebuild), we
 * rebuild from source using node-gyp.
 *
 * Works on macOS (ARM + Intel), Linux (x64/ARM), and Windows (x64/ARM).
 */

import { execSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ptyDir = resolve(__dirname, '..', 'node_modules', 'node-pty');

if (!existsSync(ptyDir)) {
  console.log('[rebuild-pty] node-pty not found, skipping');
  process.exit(0);
}

// Step 1a: Fix spawn-helper permissions on Unix (cpSync/npm don't preserve +x)
if (process.platform !== 'win32') {
  for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'prebuilds/linux-x64', 'prebuilds/linux-arm64', 'build/Release']) {
    const sh = resolve(ptyDir, dir, 'spawn-helper');
    if (existsSync(sh)) try { chmodSync(sh, 0o755); } catch {}
  }
}

// Step 1b: Check if node-pty actually works (spawn test, not just module load)
try {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const testCode = [
    `const p=require(${JSON.stringify(ptyDir)})`,
    `const t=p.spawn(${JSON.stringify(shell)},[],{cols:10,rows:10})`,
    `setTimeout(()=>{t.kill();process.exit(0)},500)`,
  ].join(';');
  execSync(`node -e ${JSON.stringify(testCode)}`, { stdio: 'pipe', timeout: 10_000 });
  console.log('[rebuild-pty] node-pty prebuilt binary works, skipping rebuild');
  process.exit(0);
} catch {
  console.log('[rebuild-pty] Prebuilt binary incompatible or spawn failed, rebuilding from source...');
}

// Step 2: Rebuild from source
try {
  execSync('npx node-gyp rebuild', {
    cwd: ptyDir,
    stdio: 'inherit',
    timeout: 120_000,
  });
} catch (err) {
  console.error('[rebuild-pty] node-gyp rebuild failed:', err.message);
  console.error('[rebuild-pty] Terminal features may not work. Ensure build tools are installed:');
  console.error('  macOS:  xcode-select --install');
  console.error('  Linux:  sudo apt install build-essential python3');
  console.error('  Windows: npm install -g windows-build-tools');
  process.exit(0); // non-fatal — the rest of the app can still run
}

// Step 3: Copy rebuilt binaries into prebuilds/ so node-pty finds them
const arch = process.arch;
const platform = process.platform;
const prebuildsDir = resolve(ptyDir, 'prebuilds', `${platform}-${arch}`);
const buildDir = resolve(ptyDir, 'build', 'Release');

if (existsSync(buildDir)) {
  mkdirSync(prebuildsDir, { recursive: true });

  const files = ['pty.node', 'spawn-helper', 'conpty.node', 'conpty_console_list.node', 'winpty-agent.exe', 'winpty.dll'];
  for (const file of files) {
    const src = resolve(buildDir, file);
    if (existsSync(src)) {
      cpSync(src, resolve(prebuildsDir, file));
    }
  }

  // Ensure spawn-helper is executable (cpSync doesn't preserve execute bit)
  if (process.platform !== 'win32') {
    const spawnHelper = resolve(prebuildsDir, 'spawn-helper');
    if (existsSync(spawnHelper)) {
      chmodSync(spawnHelper, 0o755);
    }
  }

  console.log(`[rebuild-pty] Rebuilt for ${platform}-${arch} (Node ${process.version})`);
} else {
  console.warn('[rebuild-pty] build/Release not found after rebuild');
}

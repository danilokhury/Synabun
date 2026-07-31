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
import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureVendoredExecutables } from '../lib/native-binary-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const neuralRoot = resolve(__dirname, '..');
const ptyDir = resolve(neuralRoot, 'node_modules', 'node-pty');

// Step 1a: Restore execute permissions on every vendored native binary.
//
// npm does not preserve the execute bit for files shipped via a package's
// `files` array with no `bin` entry — which is exactly how the Claude Agent SDK
// and Codex ship their native payloads. This repo also commits node_modules, so
// a checkout can materialize them 0644 as well.
//
// The previous version of this step hardcoded four prebuild directories (naming
// linux dirs that do not exist here while missing ones that do) and chmod'd
// node_modules/.bin/claude and @anthropic-ai/claude-code/cli.js — neither of
// which exists any more, since that package was replaced by
// @anthropic-ai/claude-agent-sdk. The sweep below enumerates instead.
//
// This runs BEFORE the node-pty guard below: the sweep also covers the Claude
// and Codex binaries, which must be repaired even in an install that has no
// node-pty at all.
function sweepVendoredBinaries(label) {
  const sweep = ensureVendoredExecutables({ root: neuralRoot, log: console.log });
  for (const failure of sweep.failed) {
    console.warn(`[rebuild-pty] ${failure.path} is not launchable (${failure.state}).`
      + (failure.repairCommand ? ` Try: ${failure.repairCommand}` : ''));
  }
  if (label && sweep.repaired.length) {
    console.log(`[rebuild-pty] ${label}: repaired ${sweep.repaired.length} binaries`);
  }
  return sweep;
}

sweepVendoredBinaries();

if (!existsSync(ptyDir)) {
  console.log('[rebuild-pty] node-pty not found, skipping rebuild');
  process.exit(0);
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
  console.error('  Windows: Install Visual Studio Build Tools 2022 with "Desktop development with C++" workload');
  console.error('           Or: winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools"');
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

  // cpSync does not preserve the execute bit, so re-sweep the freshly copied
  // binaries (this also picks up the prebuilds dir we just created).
  sweepVendoredBinaries('post-rebuild');

  console.log(`[rebuild-pty] Rebuilt for ${platform}-${arch} (Node ${process.version})`);
} else {
  console.warn('[rebuild-pty] build/Release not found after rebuild');
}

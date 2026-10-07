#!/usr/bin/env node

/**
 * SynaBun — NPM postinstall script
 *
 * Runs automatically after `npm install -g synabun`.
 * Installs subdependencies and builds the MCP server.
 * Does NOT start the server — that's setup.js / `synabun` command.
 */

import { execSync } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { registerStartLauncher } from './lib/start-launcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ANSI color helpers ──

const c = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
};

function ok(msg)   { console.log(`  ${c.green}\u2713${c.reset} ${msg}`); }
function warn(msg) { console.log(`  ${c.yellow}!${c.reset} ${msg}`); }
function fail(msg) { console.log(`  ${c.red}\u2717${c.reset} ${msg}`); }
function info(msg) { console.log(`  ${c.cyan}\u2192${c.reset} ${msg}`); }

// ── Dependency installation ──

function needsInstall(dir) {
  return !existsSync(resolve(dir, 'node_modules', '.package-lock.json'));
}

function installDeps(name, dir, { includeDev = false } = {}) {
  if (!needsInstall(dir)) {
    ok(`${name} dependencies already installed`);
    return;
  }

  info(`Installing ${name} dependencies...`);
  try {
    const omitFlag = includeDev ? '' : ' --omit=dev';
    execSync(`npm install${omitFlag} --ignore-scripts`, {
      cwd: dir,
      stdio: 'inherit',
      timeout: 300_000,
    });
    ok(`${name} dependencies installed`);
  } catch (err) {
    fail(`Failed to install ${name} dependencies`);
    console.error(err.stderr?.toString() || err.message);
    process.exit(1);
  }
}

function needsBuild() {
  return !existsSync(resolve(__dirname, 'mcp-server', 'dist', 'index.js'));
}

// ── node-pty native rebuild ──

function rebuildPty() {
  const rebuildScript = resolve(__dirname, 'neural-interface', 'scripts', 'rebuild-pty.js');
  if (!existsSync(rebuildScript)) {
    warn('rebuild-pty.js not found, skipping native rebuild');
    return;
  }

  info('Rebuilding node-pty native addon...');
  try {
    execSync(`node "${rebuildScript}"`, {
      cwd: resolve(__dirname, 'neural-interface'),
      stdio: 'inherit',
      timeout: 120_000,
    });
    ok('node-pty rebuilt');
  } catch (err) {
    warn('node-pty rebuild failed (terminal features may not work)');
  }
}

// ── MCP server build ──

function buildMcpServer() {
  const distIndex = resolve(__dirname, 'mcp-server', 'dist', 'index.js');
  if (existsSync(distIndex)) {
    ok('MCP server already built');
    return;
  }

  info('Building MCP server from source...');
  try {
    execSync('npx tsc', {
      cwd: resolve(__dirname, 'mcp-server'),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    ok('MCP server built');
  } catch (err) {
    fail('MCP server build failed:');
    const stdout = err.stdout?.toString().trim();
    const stderr = err.stderr?.toString().trim();
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    if (!stdout && !stderr) console.error(err.message);
  }
}

// ── Protocol handler registration ──
//
// The synabun:// handler behind the offline page's Start Server button. The
// same registration runs on every start (setup.js), so this only makes the
// button work before the first one.

function registerProtocolHandler() {
  const result = registerStartLauncher({ packageRoot: __dirname });
  if (result.state === 'skipped') return;
  if (result.ok) ok('Registered synabun:// protocol handler');
  else warn(`Could not register synabun:// protocol handler (${result.errors[0]})`);
}

// ── Updater shim executable bit ──
//
// npm publish drops the executable bit on macOS/Linux when the tarball is
// built on Windows (a common pipeline issue). The in-app updater needs
// updater.sh to be executable so the per-OS terminal-launch path can
// `exec()` it directly. Restore the bit defensively on every postinstall.

function ensureUpdaterShExecutable() {
  if (platform() === 'win32') return;
  const shPath = resolve(__dirname, 'updater.sh');
  if (!existsSync(shPath)) return;
  try {
    chmodSync(shPath, 0o755);
    ok('updater.sh marked executable');
  } catch (err) {
    warn(`updater.sh chmod failed (${err.message}) — manual fix: chmod +x "${shPath}"`);
  }
}

// ── Main ──

function main() {
  console.log(`\n  ${c.cyan}SynaBun${c.reset} ${c.dim}postinstall${c.reset}\n`);

  installDeps('Neural Interface', resolve(__dirname, 'neural-interface'));
  installDeps('MCP Server', resolve(__dirname, 'mcp-server'), { includeDev: needsBuild() });
  rebuildPty();
  buildMcpServer();
  registerProtocolHandler();
  ensureUpdaterShExecutable();

  console.log(`\n  ${c.green}\u2713${c.reset} Setup complete. Run ${c.cyan}synabun${c.reset} to start.\n`);
}

main();

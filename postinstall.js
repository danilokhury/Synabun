#!/usr/bin/env node

/**
 * SynaBun — NPM postinstall script
 *
 * Runs automatically after `npm install -g synabun`.
 * Installs subdependencies and builds the MCP server.
 * Does NOT start the server — that's setup.js / `synabun` command.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ── Ensure data directories exist ──

function ensureDirectories() {
  const dirs = [
    resolve(__dirname, 'data'),
    resolve(__dirname, 'mcp-server', 'data'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// ── Dependency installation ──

function needsInstall(dir) {
  return !existsSync(resolve(dir, 'node_modules', '.package-lock.json'));
}

function installDeps(name, dir) {
  if (!needsInstall(dir)) {
    ok(`${name} dependencies already installed`);
    return;
  }

  info(`Installing ${name} dependencies...`);
  try {
    execSync('npm install', {
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

  info('Building MCP server...');
  try {
    execSync('npm run build', {
      cwd: resolve(__dirname, 'mcp-server'),
      stdio: 'pipe',
      timeout: 60_000,
    });
    ok('MCP server built');
  } catch (err) {
    fail('MCP server build failed');
    console.error(err.stderr?.toString() || err.message);
    process.exit(1);
  }
}

// ── Main ──

function main() {
  console.log(`\n  ${c.cyan}SynaBun${c.reset} ${c.dim}postinstall${c.reset}\n`);

  ensureDirectories();
  installDeps('Neural Interface', resolve(__dirname, 'neural-interface'));
  installDeps('MCP Server', resolve(__dirname, 'mcp-server'));
  rebuildPty();
  buildMcpServer();

  console.log(`\n  ${c.green}\u2713${c.reset} Setup complete. Run ${c.cyan}synabun${c.reset} to start.\n`);
}

main();

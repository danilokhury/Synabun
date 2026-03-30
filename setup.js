#!/usr/bin/env node

/**
 * SynaBun — Single-command setup & launch
 *
 * Usage: node setup.js   (or: npm start)
 *
 * 1. Checks Node.js version (>=22)
 * 2. Ensures data directory exists (~/.synabun or %APPDATA%/synabun)
 * 3. Migrates data from old scaffolded installs if detected
 * 4. Installs npm deps for neural-interface/ and mcp-server/
 * 5. Builds the MCP server TypeScript (if dist/ is missing or stale)
 * 6. Starts the Neural Interface Express server
 * 7. Auto-opens browser to onboarding wizard (or main page if setup complete)
 */

import { execSync, spawn, exec } from 'node:child_process';
import { existsSync, readFileSync, cpSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { getDataHome, ensureDataDirs, PACKAGE_ROOT } from './lib/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ANSI color helpers ──

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
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

// ── Data home resolution ──

const DATA_HOME = getDataHome();

// ── Migration: detect old scaffolded install in CWD ──

function migrateFromScaffold() {
  const cwd = process.cwd();

  // Don't migrate if we're already in the data home or package root
  if (cwd === DATA_HOME || cwd === PACKAGE_ROOT) return;

  // Don't migrate if data home already has a .env (already set up)
  if (existsSync(resolve(DATA_HOME, '.env'))) return;

  // Detect old scaffolded install: has neural-interface/server.js + .env
  const hasScaffold = existsSync(resolve(cwd, 'neural-interface', 'server.js'))
    && existsSync(resolve(cwd, '.env'));

  if (!hasScaffold) return;

  info('Detected old scaffolded install — migrating data...');

  // Migrate .env
  cpSync(resolve(cwd, '.env'), resolve(DATA_HOME, '.env'));

  // Migrate data/ directory contents
  const dataDir = resolve(cwd, 'data');
  if (existsSync(dataDir)) {
    cpSync(dataDir, resolve(DATA_HOME, 'data'), {
      recursive: true,
      filter: (src) => !src.replace(/\\/g, '/').includes('/node_modules'),
    });
  }

  // Migrate mcp-server/data/ to mcp-data/
  const mcpDataDir = resolve(cwd, 'mcp-server', 'data');
  if (existsSync(mcpDataDir)) {
    cpSync(mcpDataDir, resolve(DATA_HOME, 'mcp-data'), { recursive: true });
  }

  ok(`Migrated data to ${DATA_HOME}`);
  info('You can safely delete the old scaffolded files from:');
  console.log(`  ${c.dim}${cwd}${c.reset}`);
  console.log('');
}

// ── Phase 1: Prerequisite checks ──

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    fail(`Node.js 22+ required, found v${process.versions.node}`);
    process.exit(1);
  }
  ok(`Node.js v${process.versions.node}`);
}

// ── Phase 2: Dependency installation ──

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

// ── Phase 3: Playwright Chromium (for browser automation) ──

function installPlaywrightChromium() {
  const niDir = resolve(PACKAGE_ROOT, 'neural-interface');
  try {
    const result = execSync('node -e "const pw=require(\'playwright\');const p=pw.chromium.executablePath();process.stdout.write(p)"', {
      cwd: niDir, encoding: 'utf8', timeout: 10_000,
    });
    if (existsSync(result)) {
      ok('Playwright Chromium already installed');
      return;
    }
  } catch { /* not installed */ }

  info('Installing Playwright Chromium (for browser automation)...');
  try {
    execSync('npx playwright install chromium', {
      cwd: niDir,
      stdio: 'inherit',
      timeout: 120_000,
    });
    ok('Playwright Chromium installed');
  } catch (err) {
    console.log('  (optional) Playwright Chromium install failed — system Chrome will be used');
  }
}

// ── Phase 4: MCP server build ──

function needsBuild() {
  const distIndex = resolve(PACKAGE_ROOT, 'mcp-server', 'dist', 'index.js');
  return !existsSync(distIndex);
}

function buildMcpServer() {
  if (!needsBuild()) {
    ok('MCP server already built');
    return;
  }

  warn('MCP server dist/ not found — attempting build (requires TypeScript)');
  try {
    execSync('npx tsc', {
      cwd: resolve(PACKAGE_ROOT, 'mcp-server'),
      stdio: 'pipe',
      timeout: 60_000,
    });
    ok('MCP server built');
  } catch (err) {
    warn('MCP server build failed (TypeScript not available) — reinstall with: npm install -g synabun@latest');
  }
}

// ── Phase 5: Setup state detection ──

function isSetupComplete() {
  const envPath = resolve(DATA_HOME, '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('SETUP_COMPLETE=')) {
        return trimmed.split('=')[1] === 'true';
      }
    }
  } catch {}
  return false;
}

// ── Phase 6: Server launch + browser open ──

function openBrowser(url) {
  const plat = platform();
  const fallback = () => { warn('Could not open browser automatically'); info(`Open manually: ${url}`); };

  if (plat === 'win32') {
    exec(`start "" "${url}"`, (err) => { if (err) fallback(); });
  } else if (plat === 'darwin') {
    exec(`open "${url}"`, (err) => { if (err) fallback(); });
  } else {
    exec(`xdg-open "${url}"`, (err) => { if (err) fallback(); });
  }
}

function startServer() {
  const serverPath = resolve(PACKAGE_ROOT, 'neural-interface', 'server.js');

  info('Starting Neural Interface server...');
  console.log('');

  const child = spawn('node', [serverPath], {
    cwd: resolve(PACKAGE_ROOT, 'neural-interface'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SYNABUN_DATA_HOME: DATA_HOME,
      MEMORY_DATA_DIR: resolve(DATA_HOME, 'mcp-data'),
    },
  });

  let opened = false;
  const setupComplete = isSetupComplete();

  child.stdout.on('data', (data) => {
    process.stdout.write(data.toString());

    if (!opened && data.toString().includes('Server:')) {
      opened = true;
      const port = data.toString().match(/Server:\s+http:\/\/localhost:(\d+)/)?.[1] || '3344';
      const url = `http://localhost:${port}${setupComplete ? '/' : '/onboarding.html'}`;

      if (!setupComplete) setTimeout(() => openBrowser(url), 1500);
    }
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(data.toString());
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      fail(`Server exited with code ${code}`);
      process.exit(code);
    }
  });

  // Clean shutdown on Ctrl+C
  process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
}

// ── Main ──

function main() {
  const version = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;

  // Banner
  console.log('');
  console.log(`  ${c.cyan}╔═══════════════════════════════════╗${c.reset}`);
  console.log(`  ${c.cyan}║${c.reset}                                   ${c.cyan}║${c.reset}`);
  console.log(`  ${c.cyan}║${c.reset}   ${c.bold}${c.cyan}[██] [██]${c.reset}   ${c.bold}${c.cyan}SynaBun${c.reset}             ${c.cyan}║${c.reset}`);
  console.log(`  ${c.cyan}║${c.reset}                                   ${c.cyan}║${c.reset}`);
  console.log(`  ${c.cyan}║${c.reset}   ${c.dim}Persistent Vector Memory${c.reset}       ${c.cyan}║${c.reset}`);
  console.log(`  ${c.cyan}║${c.reset}                                   ${c.cyan}║${c.reset}`);
  console.log(`  ${c.cyan}╚═══════════════════════════════════╝${c.reset}`);
  console.log(`           ${c.dim}synabun.ai${c.reset}`);
  console.log('');
  info(`v${version}`);
  info(`Data: ${DATA_HOME}`);
  console.log('');

  // Ensure data directories
  ensureDataDirs(DATA_HOME);

  // Migrate old scaffolded installs
  migrateFromScaffold();

  // Prerequisites
  checkNodeVersion();
  console.log('');

  // Dependencies (installed in global package location)
  installDeps('Neural Interface', resolve(PACKAGE_ROOT, 'neural-interface'));
  installDeps('MCP Server', resolve(PACKAGE_ROOT, 'mcp-server'), { includeDev: needsBuild() });
  console.log('');

  // Playwright browser
  installPlaywrightChromium();
  console.log('');

  // Build
  buildMcpServer();
  console.log('');

  // State
  if (isSetupComplete()) {
    ok('Setup already complete');
  } else {
    info('First-time setup \u2014 opening onboarding wizard');
  }
  console.log('');

  // Launch
  startServer();
}

main();

#!/usr/bin/env node

/**
 * SynaBun — Single-command setup & launch
 *
 * Usage: node setup.js   (or: npm start)
 *
 * 1. Checks Node.js version (>=18)
 * 2. Checks if Docker is available (warns if not)
 * 3. Installs npm deps for neural-interface/ and mcp-server/
 * 4. Builds the MCP server TypeScript (if dist/ is missing or stale)
 * 5. Starts the Neural Interface Express server
 * 6. Auto-opens browser to onboarding wizard (or main page if setup complete)
 */

import { execSync, spawn, exec } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

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

// ── Phase 1: Prerequisite checks ──

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    fail(`Node.js 18+ required, found v${process.versions.node}`);
    process.exit(1);
  }
  ok(`Node.js v${process.versions.node}`);
}

function checkDocker() {
  try {
    execSync('docker --version', { stdio: 'pipe' });
    ok('Docker found');
    return true;
  } catch {
    // On Windows, Docker Desktop might not be in PATH
    if (platform() === 'win32') {
      const winPaths = [
        'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
        `${process.env.LOCALAPPDATA}\\Docker\\resources\\bin\\docker.exe`,
        `${process.env.ProgramFiles}\\Docker\\Docker\\resources\\bin\\docker.exe`,
      ];
      for (const p of winPaths) {
        if (existsSync(p)) {
          ok(`Docker found at ${p}`);
          warn('Docker is not in PATH \u2014 the onboarding wizard will handle Docker startup');
          return true;
        }
      }
    }

    warn('Docker not found \u2014 you will need Docker to run Qdrant');
    warn('Install from: https://docs.docker.com/get-docker/');
    return false;
  }
}

// ── Phase 2: Dependency installation ──

function needsInstall(dir) {
  return !existsSync(resolve(dir, 'node_modules'));
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
      stdio: 'pipe',
      timeout: 120_000,
    });
    ok(`${name} dependencies installed`);
  } catch (err) {
    fail(`Failed to install ${name} dependencies`);
    console.error(err.stderr?.toString() || err.message);
    process.exit(1);
  }
}

// ── Phase 3: MCP server build ──

function needsBuild() {
  const distIndex = resolve(__dirname, 'mcp-server', 'dist', 'index.js');
  if (!existsSync(distIndex)) return true;

  const srcIndex = resolve(__dirname, 'mcp-server', 'src', 'index.ts');
  try {
    return statSync(srcIndex).mtimeMs > statSync(distIndex).mtimeMs;
  } catch {
    return true;
  }
}

function buildMcpServer() {
  if (!needsBuild()) {
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

// ── Phase 4: Setup state detection ──

function isSetupComplete() {
  const envPath = resolve(__dirname, '.env');
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

// ── Phase 5: Server launch + browser open ──

function openBrowser(url) {
  const plat = platform();
  let cmd;

  if (plat === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (plat === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      warn('Could not open browser automatically');
      info(`Open manually: ${url}`);
    }
  });
}

function startServer() {
  const serverPath = resolve(__dirname, 'neural-interface', 'server.js');

  info('Starting Neural Interface server...');
  console.log('');

  const child = spawn('node', [serverPath], {
    cwd: resolve(__dirname, 'neural-interface'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let opened = false;
  const setupComplete = isSetupComplete();

  child.stdout.on('data', (data) => {
    process.stdout.write(data.toString());

    if (!opened && data.toString().includes('Server:')) {
      opened = true;
      const port = data.toString().match(/Server:\s+http:\/\/localhost:(\d+)/)?.[1] || '3344';
      const url = `http://localhost:${port}${setupComplete ? '/' : '/onboarding.html'}`;

      setTimeout(() => openBrowser(url), 1500);
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

  // Prerequisites
  checkNodeVersion();
  checkDocker();
  console.log('');

  // Dependencies
  installDeps('Neural Interface', resolve(__dirname, 'neural-interface'));
  installDeps('MCP Server', resolve(__dirname, 'mcp-server'));
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

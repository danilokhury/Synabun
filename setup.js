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
import { existsSync, readFileSync, writeFileSync, cpSync, readdirSync, mkdirSync } from 'node:fs';
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

  info('Building MCP server from source...');
  try {
    execSync('npx tsc', {
      cwd: resolve(PACKAGE_ROOT, 'mcp-server'),
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
    console.error('\n  Report this at: https://github.com/danilokhury/Synabun/issues');
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

// ── CLI: profile subcommand ──

const TOOL_GROUPS = {
  memory:            { label: 'Memory',     tools: 6, alwaysOn: true },
  category:          { label: 'Categories', tools: 1, alwaysOn: true },
  sync:              { label: 'Sync',       tools: 1, alwaysOn: true },
  loop:              { label: 'Loop',       tools: 1, alwaysOn: true },
  profile:           { label: 'Profile',    tools: 1, alwaysOn: true },
  git:               { label: 'Git',        tools: 1  },
  image:             { label: 'Images',     tools: 1  },
  whiteboard:        { label: 'Whiteboard', tools: 5  },
  card:              { label: 'Cards',      tools: 5  },
  tictactoe:         { label: 'TicTacToe',  tools: 1  },
  browser:           { label: 'Browser',    tools: 18 },
  browser_twitter:   { label: 'Twitter/X',  tools: 1  },
  browser_facebook:  { label: 'Facebook',   tools: 1  },
  browser_tiktok:    { label: 'TikTok',     tools: 4  },
  browser_whatsapp:  { label: 'WhatsApp',   tools: 2  },
  browser_instagram: { label: 'Instagram',  tools: 5  },
  browser_linkedin:  { label: 'LinkedIn',   tools: 8  },
  leonardo:          { label: 'Leonardo',   tools: 5  },
  discord:           { label: 'Discord',    tools: 8  },
};

function readRegistry(dataHome) {
  const registryPath = resolve(dataHome, 'data', 'mcp-registry.json');
  try {
    if (existsSync(registryPath)) return JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch {}
  return null;
}

function getProfiles(dataHome) {
  const registry = readRegistry(dataHome);
  if (registry?.profiles) return registry.profiles;
  // Fallback defaults
  return {
    core:       { label: 'Core',       groups: ['git', 'image'] },
    standard:   { label: 'Standard',   groups: ['git', 'image', 'whiteboard', 'card', 'tictactoe'] },
    twitter:    { label: 'Twitter/X',  groups: ['git', 'image', 'browser', 'browser_twitter'] },
    facebook:   { label: 'Facebook',   groups: ['git', 'image', 'browser', 'browser_facebook'] },
    tiktok:     { label: 'TikTok',     groups: ['git', 'image', 'browser', 'browser_tiktok'] },
    whatsapp:   { label: 'WhatsApp',   groups: ['git', 'image', 'browser', 'browser_whatsapp'] },
    instagram:  { label: 'Instagram',  groups: ['git', 'image', 'browser', 'browser_instagram'] },
    linkedin:   { label: 'LinkedIn',   groups: ['git', 'image', 'browser', 'browser_linkedin'] },
    discord:    { label: 'Discord',    groups: ['git', 'image', 'discord'] },
    browser:    { label: 'Browser',    groups: ['git', 'image', 'whiteboard', 'card', 'tictactoe', 'browser', 'browser_twitter', 'browser_facebook', 'browser_tiktok', 'browser_whatsapp', 'browser_instagram', 'browser_linkedin', 'leonardo'] },
    full:       { label: 'Full',       groups: ['git', 'image', 'whiteboard', 'card', 'tictactoe', 'browser', 'browser_twitter', 'browser_facebook', 'browser_tiktok', 'browser_whatsapp', 'browser_instagram', 'browser_linkedin', 'leonardo', 'discord'] },
    leonardoai: { label: 'LeonardoAI', groups: ['leonardo'] },
  };
}

function countProfileTools(groups) {
  const alwaysOn = Object.values(TOOL_GROUPS).filter(g => g.alwaysOn).reduce((s, g) => s + g.tools, 0);
  const groupTools = (groups || []).reduce((s, g) => s + (TOOL_GROUPS[g]?.tools || 0), 0);
  return alwaysOn + groupTools;
}

function getCurrentProfile(dataHome) {
  const profilePath = resolve(dataHome, 'data', 'active-profile.json');
  try {
    if (existsSync(profilePath)) {
      const data = JSON.parse(readFileSync(profilePath, 'utf-8'));
      if (data.profile) return data.profile;
    }
  } catch {}
  return 'full';
}

function writeProfile(dataHome, profileName) {
  const payload = JSON.stringify({ profile: profileName }, null, 2) + '\n';

  // Write to data/active-profile.json (Neural Interface reads this)
  const niPath = resolve(dataHome, 'data', 'active-profile.json');
  const niDir = resolve(niPath, '..');
  if (!existsSync(niDir)) mkdirSync(niDir, { recursive: true });
  writeFileSync(niPath, payload, 'utf-8');

  // Write to mcp-server/data/active-profile.json (MCP server watches this)
  const mcpPath = resolve(PACKAGE_ROOT, 'mcp-server', 'data', 'active-profile.json');
  const mcpDir = resolve(mcpPath, '..');
  if (!existsSync(mcpDir)) mkdirSync(mcpDir, { recursive: true });
  writeFileSync(mcpPath, payload, 'utf-8');
}

function handleProfileCommand(dataHome) {
  const sub = process.argv[3];
  const profiles = getProfiles(dataHome);
  const current = getCurrentProfile(dataHome);

  // synabun profile  OR  synabun profile list
  if (!sub || sub === 'list') {
    console.log('');
    console.log(`  ${c.bold}Available MCP Profiles${c.reset}`);
    console.log('');
    for (const [name, prof] of Object.entries(profiles)) {
      const label = prof.label || name;
      const tools = countProfileTools(prof.groups);
      const active = name === current ? ` ${c.green}← active${c.reset}` : '';
      const groups = (prof.groups || []).join(', ');
      console.log(`  ${c.cyan}${name.padEnd(14)}${c.reset} ${c.dim}${label.padEnd(12)}${c.reset} ~${String(tools).padStart(2)} tools  ${c.dim}[${groups}]${c.reset}${active}`);
    }
    console.log('');
    console.log(`  ${c.dim}Usage: synabun profile set <name>${c.reset}`);
    console.log('');
    return;
  }

  // synabun profile get
  if (sub === 'get') {
    const prof = profiles[current];
    const tools = prof ? countProfileTools(prof.groups) : '?';
    console.log('');
    console.log(`  ${c.bold}Current Profile:${c.reset} ${c.cyan}${current}${c.reset}  (~${tools} tools)`);
    if (prof?.groups) console.log(`  ${c.dim}Groups: ${prof.groups.join(', ')}${c.reset}`);
    console.log('');
    return;
  }

  // synabun profile set <name>
  if (sub === 'set') {
    const name = process.argv[4]?.toLowerCase().trim();
    if (!name) {
      fail('Missing profile name. Usage: synabun profile set <name>');
      console.log(`  ${c.dim}Run "synabun profile list" to see available profiles.${c.reset}`);
      process.exit(1);
    }
    if (!profiles[name]) {
      fail(`Unknown profile "${name}"`);
      console.log('');
      console.log(`  ${c.dim}Available profiles:${c.reset} ${Object.keys(profiles).join(', ')}`);
      process.exit(1);
    }
    writeProfile(dataHome, name);
    const prof = profiles[name];
    const tools = countProfileTools(prof.groups);
    ok(`Profile set to ${c.cyan}${name}${c.reset} (${prof.label}, ~${tools} tools)`);
    console.log(`  ${c.dim}Groups: ${prof.groups.join(', ')}${c.reset}`);
    console.log('');
    console.log(`  ${c.dim}Running MCP servers will pick up the change automatically.${c.reset}`);
    return;
  }

  fail(`Unknown subcommand "${sub}". Usage: synabun profile [list|get|set <name>]`);
  process.exit(1);
}

// ── Main ──

function main() {
  const version = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;

  // ── Subcommand routing (before setup flow) ──
  const cmd = process.argv[2];
  if (cmd === 'profile') {
    handleProfileCommand(DATA_HOME);
    process.exit(0);
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(`synabun v${version}`);
    process.exit(0);
  }

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

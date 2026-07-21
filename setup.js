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
import { existsSync, readFileSync, writeFileSync, cpSync, readdirSync, mkdirSync, unlinkSync, createWriteStream, statSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import {
  getDataHome,
  getDataHomeDiagnostics,
  getPlatformDataHome,
  ensureDataDirs,
  PACKAGE_ROOT,
} from './lib/paths.js';
import {
  DATA_HOME_MANIFEST,
  acknowledgeLegacyDataRoot,
  dataHomeHasState,
  inspectDataHome,
  migrateDataHome,
  planDataHomeMigration,
  resolveDataHomeConflict,
} from './lib/data-home-migration.js';
import { auditAndRepairClientConfigs } from './lib/client-config-repair.js';

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

const REQUESTED_DATA_HOME = getDataHome();
const REQUESTED_DATA_HOME_DIAGNOSTICS = getDataHomeDiagnostics(REQUESTED_DATA_HOME, PACKAGE_ROOT);
// Old client registrations can inject SYNABUN_DATA_HOME=<checkout>. Never let
// that legacy override keep mutable state inside replaceable application code.
const DATA_HOME = REQUESTED_DATA_HOME_DIAGNOSTICS.dataHomeInsidePackage
  ? getPlatformDataHome()
  : REQUESTED_DATA_HOME;
process.env.SYNABUN_DATA_HOME = DATA_HOME;
process.env.MEMORY_DATA_DIR = resolve(DATA_HOME, 'mcp-data');

// ── Migration: move legacy in-repository state to the platform data home ──

function looksLikeSynabunCheckout(root) {
  return existsSync(resolve(root, 'neural-interface', 'server.js'))
    && existsSync(resolve(root, 'setup.js'));
}

function getLegacyDataRoots() {
  const values = [];
  if (resolve(REQUESTED_DATA_HOME) !== resolve(DATA_HOME)) values.push(REQUESTED_DATA_HOME);
  values.push(PACKAGE_ROOT);
  if (looksLikeSynabunCheckout(process.cwd())) values.push(process.cwd());
  let acknowledged = [];
  try {
    const manifest = JSON.parse(readFileSync(resolve(DATA_HOME, DATA_HOME_MANIFEST), 'utf-8'));
    acknowledged = Array.isArray(manifest.acknowledgedLegacyRoots)
      ? manifest.acknowledgedLegacyRoots.map(value => resolve(value))
      : [];
  } catch {}
  return [...new Set(values.map(value => resolve(value)))]
    .filter(value => value !== resolve(DATA_HOME) && !acknowledged.includes(value) && dataHomeHasState(value));
}

function formatDataSummary(label, summary) {
  const memory = summary.memory?.exists
    ? `${summary.memory.memoryCount ?? '?'} memories, DB ${summary.memory.integrity}`
    : 'no memory DB';
  return `${label}: ${summary.root}\n`
    + `    ${summary.fileCount} files, ${summary.schedules} schedules, ${summary.templates} templates, ${summary.groups} groups, ${memory}\n`
    + `    backup: ${summary.backup?.status || 'unknown'}, latest change: ${summary.latestModifiedAt || 'unknown'}\n`
    + `    fingerprint: ${summary.fingerprint}`;
}

function printDataHomeConflict(plan) {
  fail('SynaBun found different user state in two locations and stopped before changing either copy.');
  console.log('');
  console.log(`  ${formatDataSummary('Legacy ', plan.sourceSummary)}`);
  console.log(`  ${formatDataSummary('External', plan.targetSummary)}`);
  console.log('');
  info('Review the report with: synabun doctor');
  info('Keep external state: synabun migrate-data --choose external');
  info('Restore legacy state: synabun migrate-data --choose legacy');
  console.log('');
}

function preflightDataHome() {
  const legacyRoots = getLegacyDataRoots();
  if (!legacyRoots.length) return { status: 'ready', target: DATA_HOME };

  for (const source of legacyRoots) {
    const plan = planDataHomeMigration({ sourceRoot: source, targetRoot: DATA_HOME });
    if (!plan.targetHasState) {
      info(`Detected legacy SynaBun data in ${source}`);
      const result = migrateDataHome({ sourceRoot: source, targetRoot: DATA_HOME });
      ok(`Copied and verified ${result.marker.sourceFileCount} files in ${DATA_HOME}`);
      info(`The source was preserved at ${source}`);
      console.log('');
      return { status: 'migrated', source, target: DATA_HOME, result };
    }
    if (plan.identical) {
      acknowledgeLegacyDataRoot({ targetRoot: DATA_HOME, sourceRoot: source });
      continue;
    }
    printDataHomeConflict(plan);
    return { status: 'conflict', source, target: DATA_HOME, plan };
  }
  return { status: 'ready', target: DATA_HOME, identicalLegacyRoots: legacyRoots };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function handleMigrateDataCommand() {
  const sourceRoot = resolve(readOption('--from') || getLegacyDataRoots()[0] || PACKAGE_ROOT);
  const targetRoot = resolve(readOption('--to') || getPlatformDataHome());
  const choice = readOption('--choose');
  const apply = process.argv.includes('--apply');
  const plan = planDataHomeMigration({ sourceRoot, targetRoot });

  console.log('');
  console.log(`  ${c.bold}SynaBun Data Migration${c.reset}`);
  console.log(`  Source:      ${plan.sourceRoot}`);
  console.log(`  Destination: ${plan.targetRoot}`);
  console.log(`  Files:       ${plan.files.length} (${plan.newFiles} new, ${plan.sameFiles} identical, ${plan.conflicts.length} conflicts)`);
  if (plan.skippedSymlinks.length) console.log(`  Skipped:     ${plan.skippedSymlinks.length} symlink(s)`);
  console.log('');

  if (choice) {
    if (!['external', 'legacy'].includes(choice)) throw new Error('--choose must be external or legacy');
    const result = resolveDataHomeConflict({ sourceRoot, targetRoot, choice });
    ok(`Selected ${choice} data after preserving both roots at ${result.recoveryRoot}`);
    if (result.displacedTarget) info(`Previous external root preserved at ${result.displacedTarget}`);
    console.log('');
    return;
  }

  if (!apply) {
    info('Dry run only. Re-run with --apply when the destination is empty.');
    if (plan.targetHasState) info('Both roots have state; use synabun doctor, then --choose external or --choose legacy.');
    console.log('');
    return;
  }

  const result = migrateDataHome({ sourceRoot, targetRoot });
  ok(`Migration complete: ${result.marker.sourceFileCount} files verified`);
  if (result.backupRoot) info(`Previous destination preserved at ${result.backupRoot}`);
  info(`Source preserved at ${sourceRoot}`);
  console.log('');
}

function handleDoctorCommand() {
  const legacyRoots = getLegacyDataRoots();
  const report = {
    version: 1,
    checkedAt: new Date().toISOString(),
    packageRoot: PACKAGE_ROOT,
    requestedDataHome: REQUESTED_DATA_HOME,
    activeDataHome: DATA_HOME,
    unsafeRequestedOverride: REQUESTED_DATA_HOME_DIAGNOSTICS.dataHomeInsidePackage,
    active: inspectDataHome(DATA_HOME),
    clients: auditAndRepairClientConfigs({ dataHome: DATA_HOME, packageRoot: PACKAGE_ROOT, apply: false }),
    legacy: legacyRoots.map(root => inspectDataHome(root)),
    conflicts: legacyRoots.map(root => planDataHomeMigration({ sourceRoot: root, targetRoot: DATA_HOME }))
      .filter(plan => plan.targetHasState && !plan.identical)
      .map(plan => ({
        sourceRoot: plan.sourceRoot,
        targetRoot: plan.targetRoot,
        conflicts: plan.conflicts,
        targetOnlyFiles: plan.targetOnlyFiles,
        sourceSummary: plan.sourceSummary,
        targetSummary: plan.targetSummary,
      })),
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('');
  console.log(`  ${c.bold}SynaBun Doctor${c.reset}`);
  console.log(`  Application: ${PACKAGE_ROOT}`);
  console.log(`  Data home:   ${DATA_HOME}`);
  if (report.unsafeRequestedOverride) warn(`Ignored unsafe data-home override: ${REQUESTED_DATA_HOME}`);
  console.log('');
  console.log(`  ${formatDataSummary('Active  ', report.active)}`);
  for (const summary of report.legacy) console.log(`  ${formatDataSummary('Legacy  ', summary)}`);
  console.log('');
  if (report.conflicts.length) {
    fail(`${report.conflicts.length} divergent data root${report.conflicts.length === 1 ? '' : 's'} require an explicit choice.`);
  } else {
    ok('No divergent data roots detected.');
  }
  const staleClients = report.clients.changed.length;
  if (staleClients) warn(`${staleClients} client registration${staleClients === 1 ? '' : 's'} use stale SynaBun paths.`);
  else ok('Connected client registrations use canonical paths.');
  console.log('');
}

function repairClientConfigs() {
  try {
    const result = auditAndRepairClientConfigs({ dataHome: DATA_HOME, packageRoot: PACKAGE_ROOT, apply: true });
    if (result.changed.length) ok(`Repaired ${result.changed.length} SynaBun client registration${result.changed.length === 1 ? '' : 's'}`);
  } catch (error) {
    warn(`Could not audit client registrations: ${error.message}`);
  }
}

async function protectFirstLaunchAfterUpdate(version) {
  const manifestPath = resolve(DATA_HOME, DATA_HOME_MANIFEST);
  const handoffPath = resolve(DATA_HOME, 'data', 'update-handoff.json');
  let manifest = {};
  let handoff = null;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch {}
  try { handoff = JSON.parse(readFileSync(handoffPath, 'utf-8')); } catch {}
  const pendingHandoff = handoff && ['prepared', 'installed'].includes(handoff.status);
  if (manifest.lastAppVersion === version && !pendingHandoff) return true;
  if (!dataHomeHasState(DATA_HOME)) return true;

  let snapshotPath = pendingHandoff && handoff.snapshotPath && existsSync(handoff.snapshotPath)
    ? handoff.snapshotPath
    : null;
  try {
    if (!snapshotPath) {
      info(`Protecting user state before first launch of v${version}...`);
      const { createVerifiedBackup, applyBackupRetention } = await import('./neural-interface/lib/backup-service.js');
      const folderPath = resolve(DATA_HOME, 'backups', 'updates');
      const snapshot = await createVerifiedBackup({
        dataHome: DATA_HOME,
        databasePath: resolve(DATA_HOME, 'mcp-data', 'memory.db'),
        folderPath,
        kind: 'pre-update',
        appVersion: manifest.lastAppVersion || null,
      });
      applyBackupRetention({ folderPath });
      snapshotPath = snapshot.path;
      ok(`Verified upgrade snapshot: ${snapshot.name}`);
    }

    const nextManifest = {
      version: 1,
      installationId: manifest.installationId || `${Date.now()}-${process.pid}`,
      dataSchemaVersion: manifest.dataSchemaVersion || 1,
      ...manifest,
      lastAppVersion: version,
      lastUpgradeVerifiedAt: new Date().toISOString(),
      lastUpgradeSnapshot: snapshotPath,
    };
    const manifestTemp = `${manifestPath}.${process.pid}.tmp`;
    writeFileSync(manifestTemp, JSON.stringify(nextManifest, null, 2) + '\n', 'utf-8');
    renameSync(manifestTemp, manifestPath);

    if (pendingHandoff) {
      writeFileSync(handoffPath, JSON.stringify({
        ...handoff,
        status: 'verified',
        verifiedAt: new Date().toISOString(),
        launchedVersion: version,
        snapshotPath,
      }, null, 2) + '\n', 'utf-8');
    }
    return true;
  } catch (error) {
    warn(`Could not create a verified upgrade snapshot: ${error.message}`);
    info('No user state was deleted. Run "synabun doctor" before cleaning or replacing the checkout.');
    return false;
  }
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
  const nm = resolve(dir, 'node_modules');
  if (!existsSync(resolve(nm, '.package-lock.json'))) return true;
  // Guard against a corrupted/partially-wiped node_modules where
  // .package-lock.json survived but the actual packages didn't.
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    const dep = Object.keys(pkg.dependencies || {})[0];
    if (dep && !existsSync(resolve(nm, dep))) return true;
  } catch {
    return true;
  }
  return false;
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

// Sentinel exit code for supervised restart. Server exits with this code via
// /api/server/restart; the supervisor below respawns instead of giving up.
// 75 = sysexits EX_TEMPFAIL — conventional "transient, retry" signal.
const RESTART_EXIT_CODE = 75;

// Marker file written by /api/server/restart before tearing down. If the
// server crashes during shutdown (e.g. native module mutex error in sqlite/
// playwright/node-pty), the exit code will not be 75 — but the marker tells
// the supervisor the user asked for a restart, so we respawn anyway.
const RESTART_MARKER = resolve(DATA_HOME, 'restart-requested');

function startServer() {
  const serverPath = resolve(PACKAGE_ROOT, 'neural-interface', 'server.js');
  const niDir = resolve(PACKAGE_ROOT, 'neural-interface');
  const setupComplete = isSetupComplete();

  // Clear any stale marker from a previous run so we do not respawn on a
  // clean exit from this child.
  try { if (existsSync(RESTART_MARKER)) unlinkSync(RESTART_MARKER); } catch {}

  info('Starting Neural Interface server...');
  console.log('');

  // Capture the server's stdout/stderr to log files so diagnostics survive
  // regardless of how the supervisor itself was launched (Apps dropdown, manual
  // `node setup.js`, or launchd). Previously logs only reached the launching
  // terminal — when started outside a terminal they were lost, leaving
  // data/server-*.log frozen at the last launchd run. Rotate at 50MB so capture
  // never grows unbounded.
  const LOG_DIR = resolve(DATA_HOME, 'data');
  const STDOUT_LOG = resolve(LOG_DIR, 'server-stdout.log');
  const STDERR_LOG = resolve(LOG_DIR, 'server-stderr.log');
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const rotateIfLarge = (p) => {
    try { if (existsSync(p) && statSync(p).size > 50 * 1024 * 1024) renameSync(p, p + '.1'); } catch {}
  };
  rotateIfLarge(STDOUT_LOG);
  rotateIfLarge(STDERR_LOG);
  let outLog = null, errLog = null;
  try { outLog = createWriteStream(STDOUT_LOG, { flags: 'a' }); } catch (e) { warn(`Could not open stdout log: ${e.message}`); }
  try { errLog = createWriteStream(STDERR_LOG, { flags: 'a' }); } catch (e) { warn(`Could not open stderr log: ${e.message}`); }
  // A full disk reports asynchronously from WriteStream.write(). Without an
  // error listener that event terminates the supervisor itself, even though
  // the child server's persistence paths already handle ENOSPC. Disable only
  // the affected capture stream and keep the server console/supervision alive.
  const disableLogStream = (kind, stream, error) => {
    if (kind === 'stdout' && outLog === stream) outLog = null;
    if (kind === 'stderr' && errLog === stream) errLog = null;
    warn(`Could not persist ${kind} server log: ${error.message} — continuing without file capture.`);
    try { stream.destroy(); } catch {}
  };
  const stdoutLog = outLog;
  const stderrLog = errLog;
  stdoutLog?.on('error', (error) => disableLogStream('stdout', stdoutLog, error));
  stderrLog?.on('error', (error) => disableLogStream('stderr', stderrLog, error));
  const stamp = `\n===== supervisor start ${new Date().toISOString()} (pid ${process.pid}) =====\n`;
  try { outLog?.write(stamp); errLog?.write(stamp); } catch {}

  let firstLaunch = true;
  let currentChild = null;
  let shuttingDown = false;
  const restartLog = [];
  const CRASH_WINDOW_MS = 60_000;
  const CRASH_LIMIT = 5;

  function spawnOnce() {
    const child = spawn('node', ['--disable-warning=ExperimentalWarning', '--max-old-space-size=6144', serverPath], {
      cwd: niDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SYNABUN_DATA_HOME: DATA_HOME,
        MEMORY_DATA_DIR: resolve(DATA_HOME, 'mcp-data'),
        SYNABUN_SUPERVISED: '1',
      },
    });
    currentChild = child;

    let opened = !firstLaunch;
    child.stdout.on('data', (data) => {
      const s = data.toString();
      process.stdout.write(s);
      try { outLog?.write(s); } catch {}
      if (!opened && s.includes('Server:')) {
        opened = true;
        const port = s.match(/Server:\s+http:\/\/localhost:(\d+)/)?.[1] || '3344';
        const url = `http://localhost:${port}${setupComplete ? '/' : '/onboarding.html'}`;
        setTimeout(() => openBrowser(url), 1500);
      }
    });
    child.stderr.on('data', (data) => {
      const s = data.toString();
      process.stderr.write(s);
      try { errLog?.write(s); } catch {}
    });

    child.on('exit', (code) => {
      currentChild = null;
      if (shuttingDown) return;

      // Treat a present marker file the same as exit code 75. Native module
      // crashes during shutdown can clobber the exit code; the marker keeps
      // restart reliable in that case.
      let restartRequested = code === RESTART_EXIT_CODE;
      if (!restartRequested && existsSync(RESTART_MARKER)) {
        restartRequested = true;
        info(`Server exited with code ${code} but restart marker present — respawning.`);
      }
      try { if (existsSync(RESTART_MARKER)) unlinkSync(RESTART_MARKER); } catch {}

      if (restartRequested) {
        if (code === RESTART_EXIT_CODE) info('Server requested restart — respawning...');
        const now = Date.now();
        restartLog.push(now);
        while (restartLog.length && now - restartLog[0] > CRASH_WINDOW_MS) restartLog.shift();
        if (restartLog.length > CRASH_LIMIT) {
          fail(`Server restarted ${restartLog.length} times in ${Math.round(CRASH_WINDOW_MS / 1000)}s — aborting supervisor.`);
          process.exit(1);
        }
        firstLaunch = false;
        setTimeout(spawnOnce, 250);
        return;
      }

      if (code !== 0 && code !== null) {
        fail(`Server exited with code ${code}`);
        process.exit(code);
      }
      process.exit(0);
    });
  }

  spawnOnce();

  const stop = (sig) => {
    shuttingDown = true;
    if (currentChild) {
      try { currentChild.kill(sig); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
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
  gsc:               { label: 'Google Search Console', tools: 30 },
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
    browser:    { label: 'Browser',    groups: ['git', 'image', 'whiteboard', 'card', 'tictactoe', 'browser', 'browser_twitter', 'browser_facebook', 'browser_tiktok', 'browser_whatsapp', 'browser_instagram', 'browser_linkedin', 'leonardo', 'gsc'] },
    full:       { label: 'Full',       groups: ['git', 'image', 'whiteboard', 'card', 'tictactoe', 'browser', 'browser_twitter', 'browser_facebook', 'browser_tiktok', 'browser_whatsapp', 'browser_instagram', 'browser_linkedin', 'leonardo', 'discord', 'gsc'] },
    leonardoai: { label: 'LeonardoAI', groups: ['leonardo'] },
    gsc:        { label: 'GSC',        groups: ['git', 'image', 'browser', 'gsc'] },
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

  // Write to mcp-data/active-profile.json (MCP server watches this)
  const mcpPath = resolve(dataHome, 'mcp-data', 'active-profile.json');
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

async function main() {
  const version = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;

  // ── Subcommand routing (before setup flow) ──
  const cmd = process.argv[2];
  if (cmd === 'profile') {
    handleProfileCommand(DATA_HOME);
    process.exit(0);
  }
  if (cmd === 'migrate-data') {
    handleMigrateDataCommand();
    process.exit(0);
  }
  if (cmd === 'doctor') {
    handleDoctorCommand();
    process.exit(0);
  }
  if (cmd === 'restore-backup') {
    const backupPath = readOption('--from') || readOption('--backup');
    if (!backupPath) throw new Error('Usage: synabun restore-backup --from <backup.zip> [--apply]');
    const { restoreDataHomeFromBackup } = await import('./scripts/restore-data-home-from-backup.mjs');
    const result = restoreDataHomeFromBackup({
      backupPath,
      targetRoot: DATA_HOME,
      legacyRoot: PACKAGE_ROOT,
      apply: process.argv.includes('--apply'),
    });
    if (!result.applied) {
      info(`Verified backup: ${result.database.memories} memories, SQLite ${result.database.integrity}`);
      info('Dry run only. Re-run with --apply after stopping SynaBun MCP/server processes.');
    } else {
      ok(`Restored ${result.database.memories} memories to ${result.targetRoot}`);
      if (result.displacedTarget) info(`Previous external state preserved at ${result.displacedTarget}`);
    }
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

  // Inspect and migrate before creating empty destination directories. A
  // divergent pair stops normal launch without overwriting either root.
  const preflight = preflightDataHome();
  if (preflight.status === 'conflict') process.exit(2);

  // Ensure data directories
  ensureDataDirs(DATA_HOME);

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

  await protectFirstLaunchAfterUpdate(version);
  console.log('');

  // Existing registrations can carry checkout-local DOTENV_PATH and data-home
  // overrides. Rewrite only their SynaBun entry after the new MCP build exists.
  repairClientConfigs();
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

main().catch(error => {
  fail(error.message);
  process.exit(1);
});

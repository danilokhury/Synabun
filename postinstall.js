#!/usr/bin/env node

/**
 * SynaBun — NPM postinstall script
 *
 * Runs after `npm i -g synabun` (and after `npm install` in a checkout). npm
 * has already installed every runtime dependency at the package root, at the
 * versions npm-shrinkwrap.json pins, so nothing is installed here: this only
 * finishes what npm cannot (node-pty's binary, the MCP build of the installed
 * source, the synabun:// handler, the updater shim's executable bit).
 * Does NOT start the server — that's setup.js / `synabun` command.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, chmodSync, lstatSync, readFileSync, readlinkSync, unlinkSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { registerStartLauncher } from './lib/start-launcher.js';
import { buildMcpServerSafely, mcpDistWhole } from './lib/mcp-build.js';

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

function ok(msg)   { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function warn(msg) { console.log(`  ${c.yellow}!${c.reset} ${msg}`); }
function fail(msg) { console.log(`  ${c.red}✗${c.reset} ${msg}`); }
function info(msg) { console.log(`  ${c.cyan}→${c.reset} ${msg}`); }

// ── node-pty native rebuild ──
//
// On an install or an update npm runs no dependency's install script
// (npm-shrinkwrap.json keeps them off: lib/root-dependencies.mjs
// withoutInstallScript), so node-pty is this script's: its prebuilt binary on
// macOS and Windows, with the execute bit of its spawn helper restored; a
// compile where it has none (Linux) or the one it has does not start. Never
// fatal: without it only the terminal is missing. A bare `npm rebuild -g`
// reads each package's own package.json and runs those scripts after all:
// SynaBun never runs one, and its repair is `npm i -g synabun@<version>` or
// `npm rebuild -g synabun --ignore-scripts` followed by this script.

function rebuildPty() {
  const rebuildScript = resolve(__dirname, 'neural-interface', 'scripts', 'rebuild-pty.js');
  if (!existsSync(rebuildScript)) {
    warn('rebuild-pty.js not found, skipping native rebuild');
    return;
  }

  info('Checking node-pty native addon...');
  try {
    execFileSync(process.execPath, [rebuildScript], {
      cwd: resolve(__dirname, 'neural-interface'),
      stdio: 'inherit',
      timeout: 120_000,
    });
    ok('node-pty ready');
  } catch (err) {
    warn('node-pty rebuild failed (terminal features may not work)');
  }
}

// ── MCP server build ──
//
// Every install and update builds the MCP server from the source it brought
// (lib/mcp-build.js), even when a dist is there: the shipped or previous dist
// may be from another version or source. The build goes into a temp folder and
// replaces dist only when it succeeded; a failure keeps the previous (or the
// shipped, prebuilt) dist and never fails `npm i -g`: exiting non-zero here
// would make npm roll the whole install back, which is worse than a working
// prebuilt server. TypeScript is a root dependency, so npm -g installs it.

function buildMcpServer() {
  const result = buildMcpServerSafely(__dirname, {
    force: true,
    waitMs: 180_000,
    log: { ok, info, warn, fail, error: (text) => console.error(text) },
  });
  // Failed and nothing whole to start from (a first install whose compile failed): said clearly, with the way out.
  // Still exit 0: a non-zero exit makes npm remove the whole install, and a copy that setup.js refuses to start with a
  // clear message is better than none; `synabun` says the same when it is run.
  if (result.status === 'failed' && result.reason !== 'busy' && !mcpDistWhole(__dirname).complete) {
    fail('The MCP server is not built: SynaBun cannot start until it is. See the compiler output above.');
    info(`To repair: npm i -g synabun@${version()} (the same install again), or report this at https://github.com/danilokhury/Synabun/issues`);
    return false;
  }
  return true;
}

function version() {
  try { return JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version || 'latest'; } catch { return 'latest'; }
}

// ── Links an older postinstall left ──
//
// Up to 2.0.8 this script ran `npm install` in mcp-server/ and neural-interface/
// itself. Inside `npm i -g`, npm sets npm_config_global for its scripts, so each
// of those installs put its folder in the global packages as a link of its own,
// beside SynaBun: claude-memory-mcp -> synabun/mcp-server and
// neural-memory-interface -> synabun/neural-interface. Only such a link, pointing
// at this package's own folder, is removed.

function removeStalePartLinks() {
  const parent = dirname(__dirname);
  if (basename(parent) !== 'node_modules') return;
  const same = (a, b) => (platform() === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const [name, folder] of [['claude-memory-mcp', 'mcp-server'], ['neural-memory-interface', 'neural-interface']]) {
    const link = join(parent, name);
    try {
      if (!lstatSync(link).isSymbolicLink()) continue;
      const target = readlinkSync(link).replace(/^\\\\\?\\/, '');
      if (!same(resolve(parent, target), resolve(__dirname, folder))) continue;
      unlinkSync(link);
      ok(`Removed ${name}, a link an older SynaBun left in the global packages`);
    } catch {}
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

  removeStalePartLinks();
  rebuildPty();
  const built = buildMcpServer();
  registerProtocolHandler();
  ensureUpdaterShExecutable();

  if (built) console.log(`\n  ${c.green}✓${c.reset} Setup complete. Run ${c.cyan}synabun${c.reset} to start.\n`);
  else console.log(`\n  ${c.red}✗${c.reset} Setup did not complete: the MCP server is not built (see above).\n`);
}

// Never a non-zero exit: npm would roll the whole install back for it. Whatever goes wrong here is said, and
// setup.js (the `synabun` command) checks the build again and refuses to start a server that cannot load.
try {
  main();
} catch (err) {
  fail(`postinstall did not finish: ${err?.message || err}`);
  info('Run synabun: it checks the build again and says what is missing.');
}

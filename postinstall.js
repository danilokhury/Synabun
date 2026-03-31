#!/usr/bin/env node

/**
 * SynaBun — NPM postinstall script
 *
 * Runs automatically after `npm install -g synabun`.
 * Installs subdependencies and builds the MCP server.
 * Does NOT start the server — that's setup.js / `synabun` command.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

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

  // dist/ ships pre-built in the npm package — build is a fallback only
  warn('MCP server dist/ not found — attempting build (requires TypeScript)');
  try {
    execSync('npx tsc', {
      cwd: resolve(__dirname, 'mcp-server'),
      stdio: 'pipe',
      timeout: 60_000,
    });
    ok('MCP server built');
  } catch (err) {
    warn('MCP server build failed (TypeScript not available) — this is OK if dist/ was shipped');
  }
}

// ── Protocol handler registration ──

function registerProtocolHandler() {
  const nodeBin = process.execPath;
  const setupJs = resolve(__dirname, 'setup.js');
  const plat = platform();

  if (plat === 'win32') {
    // Windows — HKCU registry (no admin required)
    try {
      const cmd = `"${nodeBin}" "${setupJs}" "%1"`;
      execSync(`reg add "HKCU\\Software\\Classes\\synabun" /ve /d "URL:SynaBun Protocol" /f`, { stdio: 'pipe' });
      execSync(`reg add "HKCU\\Software\\Classes\\synabun" /v "URL Protocol" /d "" /f`, { stdio: 'pipe' });
      execSync(`reg add "HKCU\\Software\\Classes\\synabun\\shell\\open\\command" /ve /d "${cmd}" /f`, { stdio: 'pipe' });
      ok('Registered synabun:// protocol handler');
    } catch {
      warn('Could not register synabun:// protocol handler');
    }
  } else if (plat === 'darwin') {
    // macOS — minimal .app bundle in ~/.synabun/
    try {
      const appDir = resolve(homedir(), '.synabun', 'SynaBun.app', 'Contents');
      const macosDir = resolve(appDir, 'MacOS');
      mkdirSync(macosDir, { recursive: true });

      writeFileSync(resolve(appDir, 'Info.plist'), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>CFBundleIdentifier</key><string>ai.synabun.launcher</string>',
        '  <key>CFBundleName</key><string>SynaBun</string>',
        '  <key>CFBundleExecutable</key><string>synabun-launcher</string>',
        '  <key>CFBundleVersion</key><string>1.0</string>',
        '  <key>CFBundleURLTypes</key>',
        '  <array><dict>',
        '    <key>CFBundleURLName</key><string>SynaBun Protocol</string>',
        '    <key>CFBundleURLSchemes</key><array><string>synabun</string></array>',
        '  </dict></array>',
        '</dict>',
        '</plist>',
      ].join('\n'));

      const launcherPath = resolve(macosDir, 'synabun-launcher');
      writeFileSync(launcherPath, `#!/bin/sh\nexec "${nodeBin}" "${setupJs}" "$@"\n`);
      chmodSync(launcherPath, 0o755);

      // Register with LaunchServices
      try {
        execSync(`/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -R "${resolve(homedir(), '.synabun', 'SynaBun.app')}"`, { stdio: 'pipe' });
      } catch {
        try { execSync(`open "${resolve(homedir(), '.synabun', 'SynaBun.app')}"`, { stdio: 'pipe' }); } catch {}
      }

      ok('Registered synabun:// protocol handler');
    } catch {
      warn('Could not register synabun:// protocol handler');
    }
  } else {
    // Linux — .desktop file
    try {
      const appsDir = resolve(homedir(), '.local', 'share', 'applications');
      mkdirSync(appsDir, { recursive: true });

      writeFileSync(resolve(appsDir, 'synabun.desktop'), [
        '[Desktop Entry]',
        'Type=Application',
        'Name=SynaBun',
        `Exec="${nodeBin}" "${setupJs}" %u`,
        'MimeType=x-scheme-handler/synabun;',
        'NoDisplay=true',
        'Terminal=true',
        '',
      ].join('\n'));

      try { execSync('xdg-mime default synabun.desktop x-scheme-handler/synabun', { stdio: 'pipe' }); } catch {}

      ok('Registered synabun:// protocol handler');
    } catch {
      warn('Could not register synabun:// protocol handler');
    }
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

  console.log(`\n  ${c.green}\u2713${c.reset} Setup complete. Run ${c.cyan}synabun${c.reset} to start.\n`);
}

main();

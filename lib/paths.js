/**
 * SynaBun — Shared path resolution
 *
 * Separates CODE paths (global npm package) from DATA paths (user-specific).
 * All consumers import from here to ensure consistent path resolution.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Root of the SynaBun package (where code lives).
 * In global install: /path/to/node_modules/synabun
 * In dev mode: the repo root
 */
export const PACKAGE_ROOT = resolve(__dirname, '..');

/**
 * Detect if running from a global npm install.
 */
function isGlobalInstall() {
  return PACKAGE_ROOT.replace(/\\/g, '/').includes('/node_modules/synabun');
}

/**
 * Resolve the user's data home directory.
 *
 * Priority:
 * 1. SYNABUN_DATA_HOME env var (explicit override)
 * 2. Platform default (~/.synabun, %APPDATA%/synabun)
 * 3. Dev fallback: repo root (when not a global install)
 */
export function getDataHome() {
  if (process.env.SYNABUN_DATA_HOME) {
    return resolve(process.env.SYNABUN_DATA_HOME);
  }

  if (isGlobalInstall()) {
    const home = homedir();
    if (platform() === 'win32' && process.env.APPDATA) {
      return resolve(process.env.APPDATA, 'synabun');
    }
    return resolve(home, '.synabun');
  }

  // Dev mode: data lives alongside code in the repo root
  return PACKAGE_ROOT;
}

/**
 * Create the data directory structure if it doesn't exist.
 * Safe to call on every startup (idempotent).
 */
export function ensureDataDirs(dataHome) {
  const dirs = [
    resolve(dataHome, 'data'),
    resolve(dataHome, 'data', 'images'),
    resolve(dataHome, 'data', 'custom-icons'),
    resolve(dataHome, 'data', 'pending-remember'),
    resolve(dataHome, 'data', 'pending-compact'),
    resolve(dataHome, 'data', 'loop'),
    resolve(dataHome, 'data', 'plans'),
    resolve(dataHome, 'data', 'browser-profiles'),
    resolve(dataHome, 'mcp-data'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

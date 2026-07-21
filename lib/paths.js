/**
 * SynaBun — Shared path resolution
 *
 * Separates CODE paths (global npm package) from DATA paths (user-specific).
 * All consumers import from here to ensure consistent path resolution.
 */

import { resolve, dirname, relative, isAbsolute, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
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
export function isGlobalInstall() {
  return PACKAGE_ROOT.replace(/\\/g, '/').includes('/node_modules/synabun');
}

/**
 * Platform-owned location for mutable SynaBun state.
 *
 * Code and user data must not share a Git worktree: ignored runtime files can
 * be silently removed by repository cleanup commands. Keep this helper free of
 * filesystem side effects so setup/migration code can safely inspect it.
 */
export function getPlatformDataHome({
  env = process.env,
  home = homedir(),
  os = platform(),
} = {}) {
  if (os === 'win32' && env.APPDATA) return win32.resolve(env.APPDATA, 'synabun');
  return resolve(home, '.synabun');
}

/**
 * Resolve the user's data home directory.
 *
 * Priority:
 * 1. SYNABUN_DATA_HOME env var (explicit override)
 * 2. Platform default (~/.synabun, %APPDATA%/synabun)
 *
 * Development builds intentionally use the same platform-owned default. This
 * prevents branch switches and `git clean` from touching live user state.
 */
export function getDataHome({ env = process.env, home = homedir(), os = platform() } = {}) {
  if (env.SYNABUN_DATA_HOME) {
    return resolve(env.SYNABUN_DATA_HOME);
  }
  return getPlatformDataHome({ env, home, os });
}

export function pathIsInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function getDataHomeDiagnostics(
  dataHome = getDataHome(),
  packageRoot = PACKAGE_ROOT,
  { env = process.env, home = homedir(), os = platform() } = {},
) {
  const resolvedDataHome = resolve(dataHome);
  const resolvedPackageRoot = resolve(packageRoot);
  return {
    dataHome: resolvedDataHome,
    packageRoot: resolvedPackageRoot,
    explicitOverride: !!env.SYNABUN_DATA_HOME,
    dataHomeInsidePackage: pathIsInside(resolvedDataHome, resolvedPackageRoot),
    recommendedDataHome: getPlatformDataHome({ env, home, os }),
  };
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

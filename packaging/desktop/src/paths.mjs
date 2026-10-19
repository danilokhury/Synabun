/**
 * Where the desktop app finds things. Pure: no Electron, so the rules are
 * tested under plain Node (packaging/tests/desktop-shell.test.mjs).
 *
 *   resources   process.resourcesPath: the packaged payload sits there
 *               (synabun-package.json, bootstrap.mjs, runtime/, app/, cloudflared/)
 *   entry       the headless native entry next to the window (synabun-cli,
 *               synabun-cli.exe, or the AppImage's AppRun): everything that is
 *               not the window goes through it, MCP and hooks included
 *   data home   the user's SynaBun data, outside the app: lib/paths.js decides
 *               it the same way, and a test keeps the two equal
 *   profile     the window's own Chromium profile, window state and update
 *               cache, inside the data home's runtime/ (never backed up, never
 *               a reason for a data-home migration to stop)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';

export const MANIFEST = 'synabun-package.json';

/** lib/paths.js getDataHome(): SYNABUN_DATA_HOME, else %APPDATA%\synabun or ~/.synabun. */
export function dataHomeFor({ env = process.env, home, platform = process.platform } = {}) {
  if (env.SYNABUN_DATA_HOME) return resolve(env.SYNABUN_DATA_HOME);
  if (platform === 'win32' && env.APPDATA) return win32.resolve(env.APPDATA, 'synabun');
  return resolve(home, '.synabun');
}

/** The window's Chromium profile and the app's own state. */
export function profileDirFor(dataHome) {
  return join(dataHome, 'runtime', 'desktop');
}

/** Where the server, the launcher and the app write their logs. */
export function logsDirFor(dataHome) {
  return join(dataHome, 'data');
}

/** What the builder recorded about this payload, or null when there is none. */
export function readManifest(resources) {
  try {
    const manifest = JSON.parse(readFileSync(join(resources, MANIFEST), 'utf8'));
    return manifest && manifest.synabunPackage === 1 ? manifest : null;
  } catch {
    return null;
  }
}

/** The headless entry of this payload (absolute), or null when it is missing. */
export function entryFor(resources, manifest) {
  if (!manifest || typeof manifest.entry !== 'string' || !manifest.entry) return null;
  const entry = resolve(resources, manifest.entry);
  return existsSync(entry) ? entry : null;
}

/** The .app bundle around the running executable on macOS (…/SynaBun.app), else null. */
export function macBundleFor(execPath) {
  const contents = dirname(dirname(execPath));
  const bundle = dirname(contents);
  return /\.app$/i.test(bundle) && /\/Contents$/.test(contents.replace(/\\/g, '/')) ? bundle : null;
}

/** macOS runs a quarantined copy that was never moved from a random read-only folder. */
export function isTranslocated(path) {
  return /\/AppTranslocation\//.test(String(path || ''));
}

/** A copy started from the disk image it came in (or another mounted volume). */
export function isOnMountedVolume(path) {
  return /^\/Volumes\/[^/]+\//.test(String(path || ''));
}

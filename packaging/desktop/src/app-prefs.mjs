/**
 * The app's own settings (Settings > App in the interface): what the main
 * process needs before the window or the server exists, so they live in a
 * file it reads synchronously at start, beside the window's profile
 * (DATA_HOME/runtime/desktop/app-prefs.json), never on the server.
 *
 *   autoUpdate            updates download and install by themselves (on, as
 *                         before this file existed); off: the app still checks
 *                         and says so, and installs when the user asks
 *   openAtLogin           what the user asked for; the system's own login entry
 *                         says whether it is in place (login-item.mjs), and the
 *                         npm install reads that entry, never this file
 *   startHidden           a start at login opens no window (the Dock or the
 *                         tray brings it back)
 *   hardwareAcceleration  the GPU draws the window; read once, at start
 *   closeToTray           the window's close button keeps SynaBun running
 *                         (Windows and Linux; macOS keeps an app in the Dock)
 *
 * Pure but for the two file calls, which take an `fs` (tests).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PREFS_FILE = 'app-prefs.json';

export const DEFAULT_PREFS = Object.freeze({
  autoUpdate: true,
  openAtLogin: false,
  startHidden: true,
  hardwareAcceleration: true,
  closeToTray: true,
});

/** The keys a page may set, all of them switches. */
export const PREF_KEYS = Object.freeze(Object.keys(DEFAULT_PREFS));

export function prefsPathFor(profileDir) {
  return join(profileDir, PREFS_FILE);
}

/** Whatever the file held, as settings: a missing or malformed value is its default. */
export function normalizePrefs(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const prefs = {};
  for (const key of PREF_KEYS) prefs[key] = typeof source[key] === 'boolean' ? source[key] : DEFAULT_PREFS[key];
  return prefs;
}

export function readPrefs(path, { fs = { readFileSync } } = {}) {
  try {
    return normalizePrefs(JSON.parse(fs.readFileSync(path, 'utf8')));
  } catch {
    return normalizePrefs(null);
  }
}

/** Write the settings in one rename; returns what was written. Throws when the file cannot be written. */
export function writePrefs(path, prefs, { fs = { mkdirSync, renameSync, writeFileSync } } = {}) {
  const next = normalizePrefs(prefs);
  fs.mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(temp, path);
  return next;
}

/** One switch from a page: a known key and a boolean, or null. */
export function readPrefChange(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const key = String(payload.key ?? '');
  if (!PREF_KEYS.includes(key) || typeof payload.value !== 'boolean') return null;
  return { key, value: payload.value };
}

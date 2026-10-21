// ═══════════════════════════════════════════
// SynaBun — /api/system/app: Settings > App for an npm or Git install
// ═══════════════════════════════════════════
//
//   GET  /api/system/app               { ok, install, desktop, updates: { auto }, startup: { … } }
//   PUT  /api/system/app/updates       { auto: boolean }      the automatic update check and its badge
//   PUT  /api/system/app/startup       { enabled: boolean }   start the server at login (lib/login-start.js)
//   POST /api/system/app/open-folder   { which: 'data' | 'logs' }
//
// Automatic updates here are the check: on (the default), the server looks for
// a newer version when it starts and the page shows the update badge and asks
// again every half hour; off, it looks only when the user asks (Check for
// updates). Installing always goes through the update dialog and its backup
// step; nothing installs unattended. The setting is DATA_HOME/data/app-settings.json.
//
// In the desktop app (`desktop: true`) the app's own settings are the
// window's (packaging/desktop/src/app-prefs.mjs, through the preload bridge):
// this answers what it is and changes nothing.
//
// These are the owner's acts on this computer (a login entry, a folder opened
// on its screen), so the routes take the guards of /api/cli/install
// (lib/http-guards.js): a loopback socket and no proxy header, a localhost
// Host, no invite guest; a write also its own Origin, a JSON body,
// X-SynaBun-UI: 1 and no agent header. (`/api/system` is admin-only in
// lib/request-gate.js too.) A request names a switch, never a path or a command.

import { Router } from 'express';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { guestForbidden, noStore, requireLocal, requireLocalHost, requireSameOriginJson, sendGuardError, uiOnly } from './http-guards.js';
import { runProgram } from './file-explorer-system.js';

export const APP_SETTINGS_DEFAULTS = Object.freeze({ autoUpdateCheck: true });

export function normalizeAppSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(APP_SETTINGS_DEFAULTS)) out[key] = typeof source[key] === typeof value ? source[key] : value;
  return out;
}

/** DATA_HOME/data/app-settings.json, read once and written through (this server is its only writer). */
export function createAppSettingsStore({ path, fs = { mkdirSync, readFileSync, renameSync, writeFileSync } } = {}) {
  let current = null;
  const load = () => {
    if (current) return current;
    try { current = normalizeAppSettings(JSON.parse(fs.readFileSync(path, 'utf8'))); } catch { current = normalizeAppSettings(null); }
    return current;
  };
  return {
    get: () => ({ ...load() }),
    set(patch) {
      const next = normalizeAppSettings({ ...load(), ...patch });
      fs.mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n');
      fs.renameSync(temp, path);
      current = next;
      return { ...next };
    },
  };
}

/** The program that shows a folder in the system's file manager (no shell; the path is an argument of its own). */
export function openFolderCommand(platform, path, { env = process.env } = {}) {
  if (platform === 'darwin') return { file: 'open', args: [path] };
  // explorer.exe answers 1 even when it opened the folder.
  if (platform === 'win32') return { file: 'explorer.exe', args: [path], anyExit: true };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { file: 'xdg-open', args: [path] };
}

/** Open a folder on this computer's screen; resolves true when the file manager took it. */
export async function openFolderOnScreen(path, { platform = process.platform, env = process.env, run = runProgram, mkdir = mkdirSync } = {}) {
  const command = openFolderCommand(platform, path, { env });
  if (!command) return false;
  try { mkdir(path, { recursive: true }); } catch {}
  try {
    await run(command.file, command.args);
    return true;
  } catch (error) {
    return !!command.anyExit && error?.code !== 'ENOENT';
  }
}

function localRouter({ isGuestRequest, port }) {
  const router = Router();
  const portOf = () => Number(typeof port === 'function' ? port() : port);
  const built = new Map();
  const perPort = (name, factory) => (req, res, next) => {
    const key = `${name}:${portOf()}`;
    let guard = built.get(key);
    if (!guard) {
      try { guard = factory(portOf()); } catch { return sendGuardError(res, 500, 'BAD_PORT', 'The app settings have no valid port.'); }
      built.set(key, guard);
    }
    return guard(req, res, next);
  };
  router.use(noStore, guestForbidden(isGuestRequest), requireLocal, perPort('host', requireLocalHost));
  return { router, mutating: [perPort('origin', requireSameOriginJson), uiOnly] };
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof createAppSettingsStore>} deps.store
 * @param {ReturnType<import('./login-start.js').createLoginStart>} deps.loginStart
 * @param {{ data: string, logs: string }} deps.folders
 * @param {string} deps.install         'npm' | 'git' | 'app' | 'desktop'
 * @param {(auto: boolean) => void} [deps.onAutoUpdateChange]
 * @param {(path: string) => Promise<boolean>} [deps.openFolder]
 */
export function createAppControlsApi({
  store, loginStart, folders, install = 'npm', onAutoUpdateChange = () => {}, openFolder = (path) => openFolderOnScreen(path),
  isGuestRequest = () => false, port = 3344, log = () => {},
} = {}) {
  if (!store || !loginStart || !folders) throw new Error('createAppControlsApi needs the settings store, the login start and the folders');
  const { router, mutating } = localRouter({ isGuestRequest, port });
  const desktop = install === 'desktop';

  const body = () => {
    let startup;
    try { startup = loginStart.status(); } catch (error) { startup = { supported: false, reason: 'unsupported', enabled: false, state: 'off', owner: null, error: String(error?.message || error) }; }
    return { ok: true, install, desktop, updates: { auto: store.get().autoUpdateCheck !== false }, startup };
  };

  router.get('/', (req, res) => { res.json(body()); });

  router.put('/updates', ...mutating, (req, res) => {
    const auto = req.body?.auto;
    if (typeof auto !== 'boolean') return res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Send { auto: true | false }.' });
    if (desktop) return res.status(409).json({ ok: false, code: 'DESKTOP_MANAGED', error: 'The SynaBun app keeps this setting itself.' });
    try { store.set({ autoUpdateCheck: auto }); } catch (error) {
      return res.status(500).json({ ok: false, code: 'SAVE_FAILED', error: String(error?.message || error) });
    }
    try { onAutoUpdateChange(auto); } catch {}
    res.json(body());
  });

  router.put('/startup', ...mutating, async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Send { enabled: true | false }.' });
    try {
      await loginStart.set(enabled);
    } catch (error) {
      const code = String(error?.code || 'refused');
      log(`[app] start at login could not be turned ${enabled ? 'on' : 'off'}: ${error?.message || error}`);
      return res.status(409).json({ ...body(), ok: false, code, error: String(error?.message || error).slice(0, 300) });
    }
    res.json(body());
  });

  router.post('/open-folder', ...mutating, async (req, res) => {
    const which = req.body?.which;
    if (which !== 'data' && which !== 'logs') return res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: "Send { which: 'data' | 'logs' }." });
    const opened = await openFolder(folders[which]).catch(() => false);
    if (!opened) return res.status(422).json({ ok: false, code: 'NO_FILE_MANAGER', error: 'No file manager opened the folder.' });
    res.json({ ok: true });
  });

  return router;
}

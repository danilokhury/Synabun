/**
 * What an update leaves for the next run of the app, in the update state
 * folder (<data folder>/runtime/desktop/update-state). Plain Node, the same on
 * every system (tested in packaging/tests/desktop-updater.test.mjs).
 *
 *   plan.json      written before an install: what replaces what, from which
 *                  version to which, where the old copy waits, and whether the
 *                  new copy is opened
 *   swapped        the new copy is in place; the old one is kept until the new
 *                  one says it runs
 *   started        written by the new copy when it starts; the swap script
 *                  (macOS, Linux) or the install watchdog (Windows) waits for it
 *   swap-failed    why nothing changed (said once, by the next start)
 *   rolled-back    the new copy did not start and the old one is back
 *   attempts.json  installs of one version that did not end in its start: the
 *                  updater retries a failed version only later, and never in a loop
 *   pending.json   a downloaded update waiting to be installed: the next start
 *                  installs it before its server
 *   relaunch.json  how the window was when the app quit to update: the new copy
 *                  opens it the same way
 *
 * plan.json carries the install's id. The pre-update snapshot the app took for
 * that install is handed over in <data folder>/data/update-handoff.json under the
 * same id (lib/update-snapshot.js), and the next start marks it: `installed`
 * when the new copy runs, `cancelled` when the swap failed or rolled back
 * (markUpdateHandoff).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** How long a relaunch.json is believed: an app opened by hand much later opens as usual. */
export const RELAUNCH_FRESH_MS = 15 * 60 * 1000;

export function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Write JSON through a temporary file and a rename: a reader never sees half of it. */
export function writeJsonFile(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    renameSync(temp, path);
    return true;
  } catch {
    try { rmSync(temp, { force: true }); } catch {}
    return false;
  }
}

/** The small records of the update state folder, read and written by name. */
export function updateStateFiles(stateDir) {
  const file = (name) => join(stateDir, name);
  const ensure = () => { try { mkdirSync(stateDir, { recursive: true }); } catch {} };
  const record = (name) => ({
    read: () => readJsonFile(file(name)),
    write: (value) => { ensure(); return writeJsonFile(file(name), value); },
    clear: () => { try { rmSync(file(name), { force: true }); } catch {} },
  });
  return { attempts: record('attempts.json'), pending: record('pending.json'), relaunch: record('relaunch.json'), plan: record('plan.json') };
}

/**
 * What an earlier swap left for this run. The new copy says it started (the
 * script waits for that before it removes the old copy); an update installed
 * on quit has nobody waiting, so its old copy goes here. A swap that failed or
 * rolled back is reported once.
 */
export function finishPendingSwap({ stateDir, current, removeTree = (path) => rmSync(path, { recursive: true, force: true }) } = {}) {
  const out = { started: false, rolledBack: null, failed: null, plan: null };
  const exists = (name) => existsSync(join(stateDir, name));
  const plan = readJsonFile(join(stateDir, 'plan.json'));
  out.plan = plan && typeof plan === 'object' ? plan : null;
  if (exists('swapped') && plan && String(plan.version) === String(current)) {
    try { writeFileSync(join(stateDir, 'started'), new Date().toISOString()); out.started = true; } catch {}
    if (!plan.relaunch && typeof plan.backup === 'string' && /\.previous$/.test(plan.backup)) {
      try { removeTree(plan.backup); } catch {}
      rmSync(join(stateDir, 'swapped'), { force: true });
    }
  }
  if (exists('rolled-back')) {
    out.rolledBack = { version: plan?.version || null, previous: plan?.previous || null };
    rmSync(join(stateDir, 'rolled-back'), { force: true });
  }
  if (exists('swap-failed')) {
    try { out.failed = readFileSync(join(stateDir, 'swap-failed'), 'utf8').trim() || 'unknown'; } catch { out.failed = 'unknown'; }
    rmSync(join(stateDir, 'swap-failed'), { force: true });
  }
  return out;
}

/**
 * The desktop app's handoff of a pre-update snapshot (data/update-handoff.json,
 * written by lib/update-snapshot.js before the swap): the new copy says
 * `installed` once it runs, so its first start uses the snapshot instead of
 * taking one; a swap that failed or rolled back says `cancelled`. Only this
 * install's handoff (its id), only from `prepared`. True when it changed.
 */
export function markUpdateHandoff({ dataHome, installId, status, now = () => new Date() } = {}) {
  if (!dataHome || !installId || !['installed', 'cancelled'].includes(status)) return false;
  const path = join(dataHome, 'data', 'update-handoff.json');
  const handoff = readJsonFile(path);
  if (!handoff || typeof handoff !== 'object' || handoff.source !== 'desktop' || handoff.installId !== installId || handoff.status !== 'prepared') return false;
  return writeJsonFile(path, { ...handoff, status, [status === 'installed' ? 'installedAt' : 'cancelledAt']: now().toISOString() });
}

/**
 * How the new copy opens its window after an update (`relaunch.json`, written
 * by the copy that quit): shown, minimized, or left in the tray / Dock, and on
 * which page of the interface. Only for a start the update itself made, and
 * only fresh.
 */
export function relaunchWindow(record, { updatedStart = false, now = Date.now() } = {}) {
  if (!updatedStart || !record || typeof record !== 'object') return null;
  const at = Date.parse(record.at);
  if (!Number.isFinite(at) || now - at > RELAUNCH_FRESH_MS || at - now > 60 * 1000) return null;
  return { visible: record.visible !== false, minimized: record.visible !== false && record.minimized === true, path: safeInterfacePath(record.path) };
}

/** A path of the interface (`/index2d.html#x`), never another origin or scheme. */
export function safeInterfacePath(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text.startsWith('/') || text.startsWith('//') || text.length > 512 || /[\\\s]/.test(text)) return '/';
  try {
    const url = new URL(text, 'http://localhost');
    return url.origin === 'http://localhost' ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

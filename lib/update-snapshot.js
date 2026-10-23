/**
 * SynaBun — the desktop app's protection of the data before an update
 * (`<entry> update-snapshot --json`, packaged/runtime/bootstrap.mjs).
 *
 * A new version never runs on user state without a verified pre-update
 * snapshot that is still exact (lib/first-launch-protection.js). The desktop
 * app takes that snapshot itself, before it replaces its own files, and hands it
 * over to the new version's first start, which then takes none when nothing
 * changed since: the slow part of an update happens while the old version still
 * shows its window, never in a window that is gone.
 *
 *   prepare   while SynaBun still runs and the update waits for its moment (a
 *             countdown, an idle minute after the download): the snapshot is
 *             taken in the background, or the one taken earlier (--reuse) is
 *             kept when it is still exact
 *   install   after the app stopped its server, right before it replaces its
 *             files: the prepared snapshot when it is still exact, otherwise a
 *             new one; then the handoff in data/update-handoff.json (status
 *             `prepared`, the install's id, the archive's stamp). The new copy
 *             marks it `installed` once it runs
 *             (packaging/desktop/src/updater/state.mjs); a swap that failed or
 *             rolled back marks it `cancelled`
 *
 * "Still exact" is decided from the data itself, never from what one process
 * saw: the snapshot records what it was taken from (every database's
 * fingerprint, every other file's content) and checkUpgradeSnapshotFreshness
 * compares the data home with it now. A memory saved meanwhile by any process
 * (the server on its way out, an AI tool's own MCP server) makes it stale. The
 * new version's first start makes the same check before its server, and so any
 * migration, runs: a write during the swap is caught there.
 *
 * The snapshot is the backup service's upgrade snapshot (createUpgradeSnapshot:
 * a clone of each database where the file system clones, stored uncompressed,
 * checksummed as it is written, every database copy passing SQLite's integrity
 * check, read back once), so Settings > restore and `synabun restore-backup`
 * restore it as any backup. Its stamp (device, inode, size, modification time)
 * lets the new version know the file is the one that was read back, without
 * reading it again.
 *
 * Every step is one JSON line on stdout: { type: 'progress', phase, ... },
 * then { type: 'done', ... } or { type: 'failed', code, message }. Phases:
 * `check` (a prepared snapshot is compared with the data), `stale` (it is not
 * used: `reason`), `reuse`, then those of createUpgradeSnapshot for a new one
 * (collect, copy, archive, verify, integrity).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, isAbsolute } from 'node:path';
import { dataHomeHasState } from './data-home-migration.js';

export const UPDATE_HANDOFF_FILE = 'update-handoff.json';
export const handoffPathFor = (dataHome) => resolve(dataHome, 'data', UPDATE_HANDOFF_FILE);
export const updateSnapshotFolder = (dataHome) => resolve(dataHome, 'backups', 'updates');

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INSTALL_ID = /^[A-Za-z0-9_-]{6,64}$/;
const SNAPSHOT_NAME = /^synabun-pre-update-[\dT:.\-Z]+\.zip$/;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

function inside(folder, path) {
  const rel = relative(resolve(folder), resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The command line: --target <version> [--current <version>] [--install-id <id>] [--prepare]
 * [--reuse <file> --reuse-stamp <json>] [--discard <file>] (a prepared snapshot that is no longer exact: its room
 * goes to the new one).
 */
export function parseUpdateSnapshotArgs(args = []) {
  const value = (name) => {
    const at = args.indexOf(name);
    return at >= 0 && typeof args[at + 1] === 'string' ? args[at + 1] : null;
  };
  const target = value('--target');
  const current = value('--current');
  const installId = value('--install-id');
  const reuse = value('--reuse');
  const discard = value('--discard');
  let reuseStamp = null;
  try { reuseStamp = value('--reuse-stamp') ? JSON.parse(value('--reuse-stamp')) : null; } catch { reuseStamp = null; }
  if (!target || !VERSION.test(target)) return { error: 'a --target version' };
  if (current && !VERSION.test(current)) return { error: 'a --current version' };
  if (installId && !INSTALL_ID.test(installId)) return { error: 'an --install-id of letters, digits, _ and -' };
  const prepare = args.includes('--prepare');
  if (!prepare && !installId) return { error: 'an --install-id (or --prepare)' };
  return { target, current, installId, prepare, reuse, reuseStamp, discard };
}

/**
 * Why the prepared snapshot at `path` cannot stand for this install, or null
 * when it can: it is a pre-update snapshot in the update folder, the very file
 * the preparation wrote and read back (its stamp is unchanged), its database
 * passed SQLite's integrity check, and the data home is still what it was taken
 * from (checkUpgradeSnapshotFreshness: whoever wrote since, it is stale).
 */
export async function preparedSnapshotProblem({ path, stamp, folderPath, service, dataHome = null, databasePath = null }) {
  if (!path) return 'none was prepared';
  if (!inside(folderPath, path) || !SNAPSHOT_NAME.test(basename(path))) return 'it is not a snapshot of the update folder';
  if (!existsSync(path)) return 'its file is gone';
  if (!service.sameBackupFile(path, stamp)) return 'its file changed after it was checked';
  let manifest;
  try {
    manifest = await service.readBackupArchiveManifest(path);
  } catch (error) {
    return `its manifest cannot be read (${error?.message || error})`;
  }
  if (manifest?.kind !== 'pre-update' || manifest?.verified !== true) return 'it is not a verified pre-update snapshot';
  if (manifest.database && manifest.database.integrity !== 'ok') return 'its database copy was not checked with SQLite\'s integrity check';
  if (!dataHome) return null;
  const freshness = await service.checkUpgradeSnapshotFreshness({ dataHome, manifest, ...(databasePath ? { databasePath } : {}) });
  if (!freshness?.fresh) return `the data changed after it was taken (${freshness?.reason || 'unknown'})`;
  return null;
}

/**
 * Take (or reuse) the pre-update snapshot and, for an install, write the
 * handoff. Everything that touches the system is a parameter, for the tests.
 * Resolves the last event ({ type: 'done' | 'failed' }); `emit` gets every one.
 */
export async function runUpdateSnapshot({
  dataHome,
  current = null,
  target,
  installId = null,
  prepare = false,
  reuse = null,
  reuseStamp = null,
  discard = null,
  emit = () => {},
  loadBackupService = () => import('../neural-interface/lib/backup-service.js'),
  now = () => new Date(),
} = {}) {
  const say = (event) => { try { emit(event); } catch { /* the caller went away: the work goes on */ } return event; };
  const folderPath = updateSnapshotFolder(dataHome);
  const databasePath = resolve(dataHome, 'mcp-data', 'memory.db');
  const removable = (path) => !!path && existsSync(path) && inside(folderPath, path) && SNAPSHOT_NAME.test(basename(path));
  // A data home with nothing of the user's in it needs no snapshot (the new version's first start agrees:
  // lib/first-launch-protection.js), and gets no handoff.
  if (!dataHomeHasState(dataHome)) return say({ type: 'done', skipped: 'no-state', prepared: !!prepare, reused: false, path: null });
  let service;
  try {
    service = await loadBackupService();
  } catch (error) {
    return say({ type: 'failed', code: 'BACKUP_SERVICE', message: `the backup code could not be loaded: ${error?.message || error}` });
  }
  try {
    let snapshot = null;
    let reused = false;
    let stale = null;
    if (discard && discard !== reuse && removable(discard)) {
      say({ type: 'progress', phase: 'stale', reason: 'the app said it is no longer exact' });
      try { rmSync(discard, { force: true }); } catch { /* left for retention */ }
    }
    if (reuse) {
      // The copy made ahead, compared with the data as it is now.
      say({ type: 'progress', phase: 'check', path: reuse });
      const checkStarted = Date.now();
      stale = await preparedSnapshotProblem({ path: reuse, stamp: reuseStamp, folderPath, service, dataHome, databasePath });
      if (!stale) {
        snapshot = { path: reuse, name: basename(reuse), stamp: reuseStamp, timings: { check: Date.now() - checkStarted } };
        reused = true;
        say({ type: 'progress', phase: 'reuse', path: reuse });
      } else {
        say({ type: 'progress', phase: 'stale', reason: stale });
        // A snapshot of an earlier moment: its room goes to the new one (it is never a user's file: the name and the
        // folder are SynaBun's own).
        if (removable(reuse)) {
          try { rmSync(reuse, { force: true }); } catch { /* left for retention */ }
        }
      }
    }
    if (!snapshot) {
      const taken = await service.createUpgradeSnapshot({
        dataHome,
        databasePath,
        folderPath,
        kind: 'pre-update',
        appVersion: current,
        onProgress: (detail) => say({ type: 'progress', ...detail }),
        now,
      });
      snapshot = { path: taken.path, name: taken.name, stamp: taken.stamp, sizeBytes: taken.sizeBytes, database: taken.database, timings: taken.timings };
    }
    if (prepare) {
      return say({ type: 'done', prepared: true, reused, stale, path: snapshot.path, stamp: snapshot.stamp, sizeBytes: snapshot.sizeBytes ?? null, timings: snapshot.timings ?? null });
    }

    // Older snapshots go by the usual rules; the one just made is the newest, and so kept.
    try { service.applyBackupRetention({ folderPath }); } catch { /* housekeeping never stops an update */ }
    const handoff = {
      version: 1,
      status: 'prepared',
      source: 'desktop',
      preparedAt: now().toISOString(),
      current,
      target,
      installId,
      snapshotPath: snapshot.path,
      verifiedStamp: snapshot.stamp,
      verifiedAt: now().toISOString(),
      reused,
    };
    writeJsonAtomic(handoffPathFor(dataHome), handoff);
    return say({ type: 'done', prepared: false, reused, stale, path: snapshot.path, stamp: snapshot.stamp, handoff: handoffPathFor(dataHome), timings: snapshot.timings ?? null });
  } catch (error) {
    return say({
      type: 'failed',
      code: error?.code === 'ENOSPC' ? 'NO_SPACE' : error?.code === 'EBACKUPDRIVE' ? 'NO_DRIVE' : error?.code === 'EINTEGRITY' ? 'INTEGRITY' : 'SNAPSHOT_FAILED',
      message: String(error?.message || error).split('\n')[0].slice(0, 400),
    });
  }
}

/** The handoff as it is now, or null. */
export function readUpdateHandoff(dataHome) {
  return readJson(handoffPathFor(dataHome));
}

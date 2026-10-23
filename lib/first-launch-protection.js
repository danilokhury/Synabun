// The protection user state gets before a new SynaBun version runs for the
// first time: a verified snapshot of the data home, taken by setup.js before
// the server (and so any data migration) starts.
//
// The snapshot is a promise, so its failure stops the launch. setup.js exits
// with SNAPSHOT_FAILED_EXIT_CODE and the message from describeSnapshotFailure();
// there is no flag or environment variable to launch anyway. A fresh install
// with no user state, and a launch of the version that already ran, need no
// snapshot and are not affected.
//
// The launcher also leaves its stop message in the server's stderr log
// (recordLauncherFailure), because a detached launch has no terminal: the
// updater's relaunch reads it back to tell the user why SynaBun did not start.
//
// The snapshot is the backup service's upgrade snapshot (createUpgradeSnapshot):
// a consistent copy of each database (a clone where the file system clones)
// that passed SQLite's integrity check, stored uncompressed, checksummed as it
// is written and read back once. The desktop app takes it itself before it
// replaces its own files (lib/update-snapshot.js) and hands it over; this start
// uses it only when the data home is still what it was taken from
// (checkUpgradeSnapshotFreshness), whatever process wrote since: an AI tool's
// own MCP server may have saved a memory while the app swapped itself. Then it
// takes a new one, here, before the server and so any migration runs.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_HOME_MANIFEST, dataHomeHasState } from './data-home-migration.js';

/** setup.js exits with this when the pre-update snapshot could not be created. */
export const SNAPSHOT_FAILED_EXIT_CODE = 3;

/** First line of a launcher stop record. updater.mjs looks for the same text. */
export const LAUNCHER_STOP_MARKER = '===== launcher stopped ';

const noop = () => {};

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

/**
 * Why the snapshot an in-app update handed over cannot stand in for a fresh
 * one, or null when it can. It can only when the updater recorded that it
 * installed exactly the version now launching, the archive passes verification
 * and its database copy passed SQLite's integrity check, and (the desktop app's
 * snapshot, which records what it was taken from) nothing it protects changed
 * since it was taken. A `prepared` update is not enough: its updater may never
 * have run while the old server went on changing data.
 */
async function handoffSnapshotProblem({ handoff, version, backupService, dataHome }) {
  if (handoff.status !== 'installed') return 'that update was prepared but never recorded as installed';
  if (typeof handoff.target !== 'string' || handoff.target !== version) return 'it belongs to an update to another version';
  if (typeof handoff.snapshotPath !== 'string' || !handoff.snapshotPath) return 'it names no snapshot';
  if (!existsSync(handoff.snapshotPath)) return 'its snapshot file is gone';
  try {
    const service = await backupService();
    let manifest;
    // The desktop app read its snapshot back once, right after writing it, and
    // recorded which file that was. The very same file, untouched since (device,
    // inode, size, modification time), is not read a second time: only its
    // manifest. Any other file is read in full.
    if (handoff.verifiedStamp && typeof service.sameBackupFile === 'function' && typeof service.readBackupArchiveManifest === 'function'
      && service.sameBackupFile(handoff.snapshotPath, handoff.verifiedStamp)) {
      manifest = await service.readBackupArchiveManifest(handoff.snapshotPath);
      if (manifest?.verified !== true) return 'its file is not a verified snapshot';
    } else {
      manifest = await service.verifyBackupArchive(handoff.snapshotPath);
    }
    if (manifest?.kind !== 'pre-update') return 'its file is not a pre-update snapshot';
    // The restore runs SQLite's integrity check on the database it puts back: a copy that never passed it is no copy.
    if (manifest.database && manifest.database.integrity !== 'ok') return 'its database copy was not checked with SQLite\'s integrity check';
    // The data as it is now, before anything of this version touches it. The desktop app's snapshot says what it was
    // taken from; the npm updater's (taken by the old server right before it stopped) does not, and is used as before.
    if (handoff.source === 'desktop' || manifest.inputs) {
      if (typeof service.checkUpgradeSnapshotFreshness !== 'function') return 'this version cannot tell whether the data changed since';
      const freshness = await service.checkUpgradeSnapshotFreshness({ dataHome, manifest, databasePath: resolve(dataHome, 'mcp-data', 'memory.db') });
      if (!freshness?.fresh) return `the data changed after it was taken (${freshness?.reason || 'unknown'})`;
    }
  } catch (error) {
    return `its snapshot did not pass verification (${error?.message || error})`;
  }
  return null;
}

/**
 * Makes sure a verified snapshot exists before `version` runs on a data home
 * that last ran another version (or that an in-app update just handed over).
 *
 * @param {object} input
 * @param {string} input.dataHome
 * @param {string} input.version  the version about to launch
 * @param {() => Promise<{createVerifiedBackup: Function, verifyBackupArchive: Function, applyBackupRetention: Function}>} [input.loadBackupService]
 * @param {{info?: Function, ok?: Function, warn?: Function}} [input.log]
 * @param {(detail: {step?: string, files?: number, bytes?: number, skippedFiles?: number}) => void} [input.onProgress]  called when a snapshot starts and at each of its steps
 * @returns {Promise<
 *   {status: 'not-due', reason: 'current-version' | 'no-state'} |
 *   {status: 'protected', snapshotPath: string, created: boolean, recorded: boolean} |
 *   {status: 'failed', error: Error, previousVersion: string|null, backupFolder: string}
 * >} `failed` means no snapshot exists: the caller must not start the server.
 */
export async function protectFirstLaunchAfterUpdate({
  dataHome,
  version,
  loadBackupService = () => import('../neural-interface/lib/backup-service.js'),
  log = {},
  onProgress = noop,
} = {}) {
  const info = log.info || noop;
  const ok = log.ok || noop;
  const warn = log.warn || noop;
  const progress = (detail) => { try { onProgress(detail); } catch { /* reporting never stops a snapshot */ } };

  const manifestPath = resolve(dataHome, DATA_HOME_MANIFEST);
  const handoffPath = resolve(dataHome, 'data', 'update-handoff.json');
  const manifest = readJson(manifestPath, {}) || {};
  const handoff = readJson(handoffPath, null);
  const pendingHandoff = !!handoff && ['prepared', 'installed'].includes(handoff.status);
  if (manifest.lastAppVersion === version && !pendingHandoff) return { status: 'not-due', reason: 'current-version' };
  if (!dataHomeHasState(dataHome)) return { status: 'not-due', reason: 'no-state' };

  let loaded = null;
  const backupService = async () => (loaded ||= await loadBackupService());

  // An in-app update takes the snapshot before it replaces the code. It is
  // reused only when it is provably the snapshot for this launch.
  let snapshotPath = null;
  if (pendingHandoff) {
    info('Checking the snapshot taken by the updater...');
    // The desktop app's splash says it: the copy made before the update is compared with the data (supervisor phase
    // `snapshot`, step `check`).
    progress({ step: 'check' });
    const problem = await handoffSnapshotProblem({ handoff, version, backupService, dataHome });
    if (problem) info(`The updater's snapshot is not used: ${problem}. Taking a new one.`);
    else {
      snapshotPath = handoff.snapshotPath;
      ok('Verified the snapshot taken by the updater');
    }
  }
  const created = !snapshotPath;

  if (!snapshotPath) {
    const folderPath = resolve(dataHome, 'backups', 'updates');
    let service;
    let lastPhase = null;
    try {
      info(`Protecting user state before first launch of v${version}...`);
      progress({});
      service = await backupService();
      // The upgrade snapshot where the service has it (every SynaBun since 2026-10-21); the full backup otherwise.
      const takeSnapshot = typeof service.createUpgradeSnapshot === 'function'
        ? options => service.createUpgradeSnapshot(options)
        : options => service.createVerifiedBackup(options);
      const snapshot = await takeSnapshot({
        dataHome,
        databasePath: resolve(dataHome, 'mcp-data', 'memory.db'),
        folderPath,
        kind: 'pre-update',
        appVersion: manifest.lastAppVersion || null,
        // Without this the checksum and archive phases run silently for minutes
        // on a large data home, which users read as a hang and kill.
        onProgress: ({ phase, files, bytes, skippedFiles, skippedBytes, done, total, method, state }) => {
          progress({ step: phase, files, bytes, skippedFiles, done, total, ...(state ? { state } : {}) });
          // Each phase is said once, when it begins; the steps within it only reach the progress bar.
          if (phase === lastPhase) return;
          lastPhase = phase;
          const size = bytes ? ` (${(bytes / 1024 / 1024).toFixed(0)} MB)` : '';
          if (phase === 'collect') {
            info(`  ${files} files to protect${size}`);
            if (skippedFiles) {
              info(`  Skipping ${skippedFiles} generated media files (${(skippedBytes / 1024 / 1024).toFixed(0)} MB) — an upgrade never touches them`);
            }
          } else if (phase === 'copy') info(`  Copying the databases${method === 'clone' ? ' (a file system clone)' : ''}...`);
          else if (phase === 'checksum') info(`  Checksumming ${files} files...`);
          else if (phase === 'archive') info(total ? `  Writing the archive (${(total / 1024 / 1024).toFixed(0)} MB)...` : `  Compressing${size}...`);
          else if (phase === 'verify') info('  Verifying archive integrity...');
          else if (phase === 'integrity') info('  Finishing SQLite\'s integrity check of the database copies...');
        },
      });
      snapshotPath = snapshot.path;
      ok(`Verified upgrade snapshot: ${snapshot.name}`);
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        // The version to go back to: what the in-app update replaced, else what
        // last ran on this data home. Never the version being launched.
        previousVersion: [pendingHandoff ? handoff.current : null, manifest.lastAppVersion]
          .find(value => typeof value === 'string' && value && value !== version) || null,
        backupFolder: folderPath,
      };
    }
    // The snapshot exists and is verified. Pruning older ones is housekeeping.
    try { service.applyBackupRetention({ folderPath }); } catch (error) {
      warn(`Could not prune older upgrade snapshots: ${error.message}`);
    }
  }

  // Record the protected launch. The snapshot is already safe, so a failure
  // here does not stop the launch: the next one takes a snapshot again.
  try {
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
      // Closed either way: a handoff whose snapshot was not used is superseded
      // by the one taken here.
      writeFileSync(handoffPath, JSON.stringify({
        ...handoff,
        status: 'verified',
        verifiedAt: new Date().toISOString(),
        launchedVersion: version,
        snapshotPath,
        snapshotReused: !created,
      }, null, 2) + '\n', 'utf-8');
    }
  } catch (error) {
    warn(`The upgrade snapshot is safe at ${snapshotPath}, but recording it failed: ${error.message}`);
    info('A new snapshot will be taken at the next launch.');
    return { status: 'protected', snapshotPath, created, recorded: false };
  }
  return { status: 'protected', snapshotPath, created, recorded: true };
}

/**
 * What to tell the user when the snapshot failed: what failed, what state the
 * data is in, where it is, and the two ways forward.
 * @returns {{headline: string, lines: string[]}}
 */
export function describeSnapshotFailure({ error, dataHome, version, previousVersion = null, backupFolder = null } = {}) {
  const folder = backupFolder || resolve(dataHome, 'backups', 'updates');
  // Without a recorded previous version (a data home older than the record, or
  // one this version has not recorded yet) there may be nothing to go back to.
  const goBack = previousVersion
    ? `Or go back to the version you had: npm i -g synabun@${previousVersion}`
    : 'Or, if you just updated, go back to the version you had: npm i -g synabun@<that version>';
  return {
    headline: `SynaBun v${version} did not start: the snapshot that protects your data before this version runs on it for the first time could not be created.`,
    lines: [
      `What failed: ${error?.message || 'unknown error'}`,
      // Only what is true of the whole launch: an earlier step may have copied
      // data from an old checkout into the data home (a verified copy; the
      // source is kept), so "nothing was changed" would say too much.
      `The server was not started, so v${version} has not converted or deleted any of your memories or settings.`,
      `Data home: ${dataHome}`,
      `Snapshot folder: ${folder}`,
      `To continue: free disk space or fix the permissions of the snapshot folder, then run "synabun" again.`,
      goBack,
      'Run "synabun doctor" to inspect the data home.',
    ],
  };
}

/** Where the launcher leaves its stop message: the log the server's stderr goes to. */
export function launcherLogPath(dataHome) {
  return resolve(dataHome, 'data', 'server-stderr.log');
}

/**
 * Appends why the launcher stopped to launcherLogPath(). Best effort and never
 * throws: the disk may be the reason for the stop. It creates no folder, so a
 * data home that does not exist yet stays that way.
 * @returns {string|null} the log path when the record was written
 */
export function recordLauncherFailure({ dataHome, exitCode, headline, lines = [], now = () => new Date() } = {}) {
  try {
    if (!dataHome || !existsSync(resolve(dataHome, 'data'))) return null;
    const path = launcherLogPath(dataHome);
    const record = [
      '',
      `${LAUNCHER_STOP_MARKER}${now().toISOString()} (pid ${process.pid}, exit ${exitCode}) =====`,
      headline,
      ...lines,
      '',
    ].join('\n');
    appendFileSync(path, record, 'utf-8');
    return path;
  } catch {
    return null;
  }
}

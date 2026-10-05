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
 * installed exactly the version now launching, and the archive still passes
 * verification. A `prepared` update is not enough: its updater may never have
 * run while the old server went on changing data.
 */
async function handoffSnapshotProblem({ handoff, version, backupService }) {
  if (handoff.status !== 'installed') return 'that update was prepared but never recorded as installed';
  if (typeof handoff.target !== 'string' || handoff.target !== version) return 'it belongs to an update to another version';
  if (typeof handoff.snapshotPath !== 'string' || !handoff.snapshotPath) return 'it names no snapshot';
  if (!existsSync(handoff.snapshotPath)) return 'its snapshot file is gone';
  try {
    const service = await backupService();
    const archive = await service.verifyBackupArchive(handoff.snapshotPath);
    if (archive?.kind !== 'pre-update') return 'its file is not a pre-update snapshot';
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
} = {}) {
  const info = log.info || noop;
  const ok = log.ok || noop;
  const warn = log.warn || noop;

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
    const problem = await handoffSnapshotProblem({ handoff, version, backupService });
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
    try {
      info(`Protecting user state before first launch of v${version}...`);
      service = await backupService();
      const snapshot = await service.createVerifiedBackup({
        dataHome,
        databasePath: resolve(dataHome, 'mcp-data', 'memory.db'),
        folderPath,
        kind: 'pre-update',
        appVersion: manifest.lastAppVersion || null,
        // Without this the checksum and archive phases run silently for minutes
        // on a large data home, which users read as a hang and kill.
        onProgress: ({ phase, files, bytes, skippedFiles, skippedBytes }) => {
          const size = bytes ? ` (${(bytes / 1024 / 1024).toFixed(0)} MB)` : '';
          if (phase === 'collect') {
            info(`  ${files} files to protect${size}`);
            if (skippedFiles) {
              info(`  Skipping ${skippedFiles} generated media files (${(skippedBytes / 1024 / 1024).toFixed(0)} MB) — an upgrade never touches them`);
            }
          } else if (phase === 'checksum') info(`  Checksumming ${files} files...`);
          else if (phase === 'archive') info(`  Compressing${size}...`);
          else if (phase === 'verify') info('  Verifying archive integrity...');
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

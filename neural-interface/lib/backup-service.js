import {
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  constants as FS_CONSTANTS,
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path';
import * as nodeSqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, Worker, workerData } from 'node:worker_threads';
import archiver from 'archiver';
import { markActivity } from './loop-stall.js';
import { openZipArchive, readZipEntry, verifyBackupChecksums } from './backup-zip-reader.js';
import { writeZipArchive } from './backup-zip-writer.js';
import { authKeyOf, BACKUP_ENC_EXTENSION, BackupEncryptionError, isEncryptedBackupFile, readBackupHeaderFile, snapshotRecordDigest } from './backup-crypto.js';
import { sweepRestoreStages } from './backup-restore-stage.js';
import { createEncryptedBackupWriter, openEncryptedBackupSource } from './backup-crypto-io.js';
import { backupRecipientFor } from './backup-encryption.js';
import { hashFileSync, walkDataHomeTree } from '../../lib/data-home-files.js';
import { LOCK_FILE_NAME } from './rulesets/lock.js';
import {
  BACKUP_GROUP_IDS, backupGroupOf, checkManifestGroups, dataDirsOfGroup, estimateArchivedBytes, isNeverBackedUp,
  isNeverBackedUpDir, manifestGroups, selectedBackupGroups,
} from './backup-groups.js';

export const BACKUP_MANIFEST_VERSION = 3;
export const BACKUP_PREFIX = 'synabun-auto-backup';
export const BACKUP_FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_BACKUP_RETENTION = Object.freeze({
  recentHours: 24,
  dailyDays: 30,
  weeklyWeeks: 12,
  maxBytes: 10 * 1024 * 1024 * 1024,
  // How many pre-update/pre-migration snapshots this generic sweep keeps in a shared folder; the
  // dedicated pruner for the updater's own folder (lib/update-snapshot.js prunePreUpdateSnapshots)
  // reads the same retention.preUpdateKeep through the settings mechanism (GET/PUT
  // /api/system/auto-backup), with its own PRE_UPDATE_KEEP_ENV override.
  preUpdateKeep: 1,
});

/** The DATA_HOME folders every backup copies (createVerifiedBackup); DATA_HOME/.env goes too, as a file. */
export const BACKUP_DATA_DIRS = Object.freeze(['data', 'mcp-data']);

/**
 * Every folder a backup copies from: BACKUP_DATA_DIRS under `dataHome`, then
 * the folders of the caller's `additionalEntries` (server.js: skills, agents,
 * skins). A secret that must never be archived (the WhatsApp session keys)
 * has to live outside all of them.
 */
export function backupRoots(dataHome, additionalEntries = []) {
  const roots = BACKUP_DATA_DIRS.map((dir) => resolve(dataHome, dir));
  for (const entry of Array.isArray(additionalEntries) ? additionalEntries : []) {
    const diskPath = typeof entry === 'string' ? entry : entry?.diskPath;
    if (diskPath) roots.push(resolve(diskPath));
  }
  return [...new Set(roots)];
}

const TRANSIENT_DATA_NAMES = new Set([
  'server-stdout.log',
  'server-stderr.log',
  'restart-requested',
  'opencode-managed.pid',
]);

/**
 * Files in a data folder that are operating-system locks, not data: the rules
 * installer's writer lock (lib/rulesets/lock.js). A backup never opens, reads
 * or copies one (closing any descriptor on the file drops this process's lock
 * on it), and a restore never extracts one over the live file (that would put
 * two servers on two different files): system-restore.js reads this list.
 */
export const LOCK_ONLY_DATA_FILES = Object.freeze([LOCK_FILE_NAME]);
const SQLITE_SIDE_FILES = ['', '-journal', '-wal', '-shm'];

/** True for a lock-only file and for the journal, WAL and shm names SQLite could put beside it. Case does not count. */
export function isLockOnlyDataFile(name) {
  const lower = String(name).toLowerCase();
  return LOCK_ONLY_DATA_FILES.some(file => SQLITE_SIDE_FILES.some(suffix => lower === `${file}${suffix}`));
}

const IMMUTABLE_BACKUP_EXTENSIONS = new Set([
  '.avif', '.gif', '.ico', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.ogg',
  '.pdf', '.png', '.svg', '.webm', '.webp', '.woff', '.woff2', '.zip',
]);

// Re-downloadable bulk media under data/. These are pipeline caches, not user
// state: including them made a pre-update snapshot spend minutes deflating
// hundreds of MB of video with no progress output, which reads as a hang and
// gets killed. A restore re-fetches them.
const EXCLUDED_DATA_DIRS = new Set([
  'youtube-downloads',
]);

// Payloads that are already compressed. DEFLATE spends full CPU on every byte
// of these for no meaningful size gain, so they are stored verbatim instead.
const INCOMPRESSIBLE_EXTENSIONS = new Set([
  '.avif', '.gif', '.ico', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.ogg',
  '.png', '.webm', '.webp', '.woff', '.woff2', '.zip',
]);

// Generated media. An upgrade snapshot exists to roll back *state* if a new
// version misbehaves; it never rewrites these, and they survive a rollback on
// disk regardless. Archiving them put multi-GB data homes through several
// minutes of compression on the npm update path, so upgrade snapshots skip
// them. Scheduled and manual backups still capture everything.
const BULK_MEDIA_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.m4a', '.m4v', '.mkv',
  '.mov', '.mp3', '.mp4', '.ogg', '.png', '.tiff', '.wav', '.webm', '.webp',
]);

// Snapshot kinds taken while the user is blocked on a version change.
const UPGRADE_BACKUP_KINDS = new Set(['pre-update', 'pre-migration']);

// Irreplaceable state: the memory database, UI state databases, and the JSON
// that configures them. Everything a rollback actually needs lives here.
const ESSENTIAL_STATE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3', '.json']);

// Above this, an upgrade snapshot stops trying to be comprehensive and keeps
// only irreplaceable state. Dropping media is not enough on its own — a data
// home can reach multiple GB in ordinary files, and compressing that on the
// npm update path is what made upgrades look broken.
const UPGRADE_SNAPSHOT_SOFT_LIMIT_BYTES = 1024 * 1024 * 1024;

// For estimates only (what a snapshot leaves out, a progress hint): any file it cannot stat counts as 0 bytes. A
// decision about what to archive uses backupFileSize, where only a missing file is 0 and any other error is thrown.
function fileBytes(path) {
  reportBackupWorkerProgress();
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * Pick what an upgrade snapshot archives. Generated media always goes; if the
 * remainder is still oversized, fall back to irreplaceable state only. Returns
 * the kept files plus what was dropped, so the caller can say so out loud.
 */
function selectUpgradeSnapshotFiles(files, { softLimitBytes = UPGRADE_SNAPSHOT_SOFT_LIMIT_BYTES } = {}) {
  const excluded = { reason: 'generated-media', files: 0, bytes: 0 };
  const kept = [];
  for (const file of files) {
    if (BULK_MEDIA_EXTENSIONS.has(extname(file.archivePath).toLowerCase())) {
      excluded.files += 1;
      excluded.bytes += fileBytes(file.diskPath);
      continue;
    }
    kept.push(file);
  }

  const keptBytes = kept.reduce((total, file) => total + fileBytes(file.diskPath), 0);
  if (keptBytes <= softLimitBytes) return { files: kept, excluded };

  const essential = [];
  for (const file of kept) {
    const isEnv = file.archivePath === 'env.bak';
    const isMcpState = file.archivePath.startsWith('mcp-data/');
    const isStateFile = ESSENTIAL_STATE_EXTENSIONS.has(extname(file.archivePath).toLowerCase());
    if (isEnv || isMcpState || isStateFile) { essential.push(file); continue; }
    excluded.files += 1;
    excluded.bytes += fileBytes(file.diskPath);
  }
  return { files: essential, excluded: { ...excluded, reason: 'oversized-data-home' } };
}

export class BackupStorageError extends Error {
  constructor({ availableBytes, requiredBytes, folderPath }) {
    const availableMiB = Math.floor(availableBytes / 1024 / 1024);
    const requiredMiB = Math.ceil(requiredBytes / 1024 / 1024);
    super(`Insufficient disk space for backup: ${availableMiB} MB available, ${requiredMiB} MB required`);
    this.name = 'BackupStorageError';
    this.code = 'ENOSPC';
    this.availableBytes = availableBytes;
    this.requiredBytes = requiredBytes;
    this.folderPath = folderPath;
    this.retryable = true;
  }
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function archiveNameFor(kind, createdAt, encrypted = false) {
  return `synabun-${kind}-${safeTimestamp(createdAt)}.zip${encrypted ? BACKUP_ENC_EXTENSION : ''}`;
}

// ── Encryption (lib/backup-encryption.js, docs/backup-encryption.md) ──
//
// Every function that makes a backup asks here who it is for, by itself: a caller that says nothing gets what the
// data home's key file says, so a new caller cannot forget it. There is no way to ask for a plain backup while the
// owner has encryption on, and no fallback to one: when the key file is there and cannot be used, the lookup throws
// and the backup fails.

/**
 * Who a backup of `dataHome` is encrypted for: null (the owner has not turned encryption on) or
 * { recipient, chunkSize? }. `encryption`: what the caller passed; undefined means "what the owner set".
 */
function backupEncryptionFor(dataHome, encryption) {
  if (encryption === undefined) {
    const recipient = backupRecipientFor(dataHome);
    return recipient ? { recipient } : null;
  }
  if (encryption && typeof encryption === 'object' && encryption.recipient) return encryption;
  throw new BackupEncryptionError('BACKUP_ENC_OPTION', 'createVerifiedBackup: `encryption` is { recipient } or left out', { status: 500 });
}

/** Where an encrypted backup stages its plaintext copies: inside the data home, never in the destination folder. */
export function privateBackupStagingRoot(dataHome) {
  return resolve(dataHome, 'backups', 'encrypt-staging');
}

/**
 * The staging folder of an encrypted backup, made private (0700): the copies in it are plaintext, and the
 * destination may be a drive without permissions or a folder another program uploads. Removed with the backup.
 */
async function makePrivateStage(dataHome) {
  const root = privateBackupStagingRoot(dataHome);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(root, 0o700);
  const stage = await mkdtemp(resolve(root, `.synabun-files-${process.pid}-`));
  if (process.platform !== 'win32') await chmod(stage, 0o700);
  return stage;
}

/** The sidecar of an encrypted upgrade snapshot: what a later start reads without the password (see writeSnapshotInfo). */
export function backupInfoPath(path) {
  return `${path}.info.json`;
}

/** Removes a backup file and what belongs to it (an encrypted upgrade snapshot's sidecar). */
export async function removeBackupFile(path) {
  await unlink(path);
  await rm(backupInfoPath(path), { force: true }).catch(() => {});
}

function pathInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Room on two volumes: the archive in the destination, the staged copies in the data home's private folder. */
function checkSplitWorkingSpace(folderPath, stageRoot, estimate, getAvailableBytes, reserveBytes) {
  let sameVolume = true;
  try { sameVolume = statSync(folderPath).dev === statSync(stageRoot).dev; } catch { /* one check, as before */ }
  if (sameVolume) return checkWorkingSpace(folderPath, estimate, getAvailableBytes);
  const reserve = Math.max(0, Number(reserveBytes) || 0);
  const staged = estimate.stagedMutableBytes + estimate.sqliteSnapshotBytes;
  checkWorkingSpace(stageRoot, { ...estimate, requiredBytes: reserve + staged }, getAvailableBytes);
  return checkWorkingSpace(folderPath, { ...estimate, requiredBytes: Math.max(0, estimate.requiredBytes - staged) }, getAvailableBytes);
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(digest.digest('hex')));
  });
}

function escapeSqliteString(value) {
  return String(value).replace(/'/g, "''");
}

// SQLite rollback journals, including the ones left beside migration copies
// (memory.db.pre-v4-….bak-journal). They are only meaningful next to the file
// they belonged to, and that file is snapshotted consistently or not at all.
const SQLITE_JOURNAL_RE = /\.(?:db|bak)-journal$/i;

/**
 * True for what lies inside a local browser profile's folder (data/local-profiles/<id>/…, lib/local-profiles.js): a
 * whole Chrome profile, which Chrome locks and rewrites while it runs, as large as a browser gets, and holding the
 * profile's cookies and logins. No archive of any kind holds it (a copy taken under a running Chrome would not be a
 * profile anyway). The profiles' definitions, data/local-profiles/profiles.json, are a plain file of that folder and
 * stay in every backup and upgrade snapshot, so a rollback brings the list back; that file holds the proxy passwords
 * as typed (docs/browser-v2.md).
 */
export function isLocalProfileFolderPath(relativePath) {
  const parts = String(relativePath).replace(/\\/g, '/').split('/');
  return parts[0] === 'local-profiles' && parts.length > 2;
}

// What no archive of any kind holds: one list, in backup-groups.js (isNeverBackedUp), asked by the full backup, the
// upgrade snapshot and the size estimate. It names what the three lists above name, and since 2026-11-21 also every
// log (a rotated server-stdout.log.1 was 50 MB of a backup), the launcher's and supervisor's records, the hooks' lock
// file, the automation browser's Chromium profiles, imports left in staging, and the system's own .DS_Store files.
function shouldSkipDataPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const name = parts.at(-1);
  if (isNeverBackedUp(normalized)) return true;
  if (isLocalProfileFolderPath(normalized)) return true;
  if (parts.length > 1 && EXCLUDED_DATA_DIRS.has(parts[0])) return true;
  if (TRANSIENT_DATA_NAMES.has(name)) return true;
  if (isLockOnlyDataFile(name)) return true;
  return false;
}

/**
 * mcp-data holds full copies of memory.db written by schema migrations and
 * manual repairs (memory.db.pre-v7-….bak, memory.db.backup-….bak). Each is as
 * large as the live database, and the archive already carries a consistent
 * snapshot of that, so six of them grew a 1.3 GB data home into a 3 GB archive.
 */
export function isDatabaseCopyArtifact(relativePath) {
  const name = relativePath.replace(/\\/g, '/').split('/').at(-1);
  return /^memory\.db\../i.test(name) || SQLITE_JOURNAL_RE.test(name);
}

/**
 * A destination on a removable drive that is not mounted. mkdir -p would try
 * to create the mount point itself and fail with a baffling
 * `EACCES: mkdir '/Volumes/<drive>'` (or, worse, succeed as root and fill the
 * system disk), so it is reported as the drive being absent instead.
 */
export function missingBackupVolume(folderPath, { volumesRoot = '/Volumes' } = {}) {
  if (!folderPath) return null;
  const target = resolve(folderPath);
  const root = parsePath(target).root;
  // Windows: an unplugged drive letter has no root at all.
  if (root && !existsSync(root)) return { name: root.replace(/[\\/]+$/, ''), mountPoint: root };
  const volumes = resolve(volumesRoot);
  if (!target.startsWith(volumes + sep)) return null;
  const name = target.slice(volumes.length + 1).split(sep)[0];
  if (!name) return null;
  const mountPoint = join(volumes, name);
  return existsSync(mountPoint) ? null : { name, mountPoint };
}

export class BackupDestinationUnavailableError extends Error {
  constructor({ name, mountPoint, folderPath }) {
    super(`Backup drive "${name}" is not connected (${mountPoint}). Connect it or choose another backup folder.`);
    this.name = 'BackupDestinationUnavailableError';
    this.code = 'EBACKUPDRIVE';
    this.mountPoint = mountPoint;
    this.folderPath = folderPath;
    this.retryable = true;
  }
}

export function assertBackupDestinationMounted(folderPath, options) {
  const missing = missingBackupVolume(folderPath, options);
  if (missing) throw new BackupDestinationUnavailableError({ ...missing, folderPath });
}

// De-duplicate as files are discovered. Later additional entries take precedence,
// as before, without constructing an argument list or a second subtree listing.
// `skipDirs[dir]`: a folder of that data folder (relative path) the walk does not enter, because the filter would
// drop every file in it anyway.
function collectBackupFiles(dataHome, filters, additionalEntries, skipDirs = {}) {
  const entries = new Map();
  const add = (diskPath, archivePath) => entries.set(archivePath.replace(/\\/g, '/'), { diskPath, archivePath });
  const envPath = resolve(dataHome, '.env');
  if (existsSync(envPath)) add(envPath, 'env.bak');

  function collect(root, archiveRoot, filter, skipDir = null) {
    const descend = skipDir ? (path) => !skipDir(relative(root, path).replace(/\\/g, '/')) : null;
    for (const { path, stat } of walkDataHomeTree(root, { descend })) {
      reportBackupWorkerProgress();
      if (!stat.isFile()) continue;
      const rel = relative(root, path).replace(/\\/g, '/');
      if (!filter || filter(rel)) add(path, rel ? `${archiveRoot}/${rel}` : archiveRoot);
    }
  }
  for (const dir of BACKUP_DATA_DIRS) collect(resolve(dataHome, dir), dir, filters[dir], skipDirs[dir]);
  for (const entry of additionalEntries) {
    if (entry?.diskPath && entry?.archivePath) collect(entry.diskPath, entry.archivePath);
  }
  return Array.from(entries.values());
}

function backupFileSize(file) {
  reportBackupWorkerProgress();
  try { return statSync(file.diskPath).size; }
  catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function isSqliteBackupInput(file) {
  return /\.(?:db|sqlite|sqlite3)$/i.test(file.archivePath);
}

function isMutableBackupInput(file) {
  if (isSqliteBackupInput(file)) return false;
  return !IMMUTABLE_BACKUP_EXTENSIONS.has(extname(file.archivePath).toLowerCase());
}

export function backupAvailableBytes(folderPath) {
  let probe = resolve(folderPath);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const stats = statfsSync(probe);
  return Number(stats.bavail) * Number(stats.bsize);
}

function estimateBackupWorkingSpace({
  files = [],
  databasePath = null,
  expectedArchiveBytes = 0,
  freeSpaceReserveBytes = BACKUP_FREE_SPACE_RESERVE_BYTES,
} = {}) {
  const primaryDatabaseBytes = databasePath && existsSync(databasePath) ? statSync(databasePath).size : 0;
  let inputBytes = primaryDatabaseBytes;
  let stagedMutableBytes = 0;
  let sqliteSnapshotBytes = primaryDatabaseBytes;
  for (const file of files) {
    const size = backupFileSize(file);
    inputBytes += size;
    if (isSqliteBackupInput(file)) sqliteSnapshotBytes += size;
    else if (isMutableBackupInput(file)) stagedMutableBytes += size;
  }
  const archiveBytes = Math.max(Number(expectedArchiveBytes) || 0, inputBytes);
  const requiredBytes = Math.max(0, Number(freeSpaceReserveBytes) || 0)
    + stagedMutableBytes
    + sqliteSnapshotBytes
    + archiveBytes;
  return { requiredBytes, archiveBytes, stagedMutableBytes, sqliteSnapshotBytes };
}

function checkWorkingSpace(folderPath, estimate, getAvailableBytes) {
  const availableBytes = Number(getAvailableBytes(folderPath));
  if (Number.isFinite(availableBytes) && availableBytes < estimate.requiredBytes) {
    throw new BackupStorageError({ availableBytes, requiredBytes: estimate.requiredBytes, folderPath });
  }
  return { availableBytes, ...estimate };
}

export function assertBackupWorkingSpace({ folderPath, getAvailableBytes = backupAvailableBytes, ...inputs } = {}) {
  return checkWorkingSpace(folderPath, estimateBackupWorkingSpace(inputs), getAvailableBytes);
}

/**
 * Remove archive temps, SQLite temps, and stage dirs abandoned by an earlier
 * run. A backup interrupted with Ctrl-C never reaches its own catch/finally,
 * so its partial archive is orphaned forever — a killed pre-update snapshot
 * left hundreds of MB behind with nothing to reclaim it.
 */
export function cleanupStaleBackupArtifacts(folderPath, { maxAgeMs = 60 * 60 * 1000, now = Date.now, ownerGone = null } = {}) {
  if (!existsSync(folderPath)) return [];
  const removed = [];
  let entries;
  try { entries = readdirSync(folderPath); }
  catch { return removed; }
  for (const name of entries) {
    reportBackupWorkerProgress();
    const archiveTemp = name.match(/\.zip(?:\.enc)?(?:\.info\.json)?\.(\d+)\.tmp$/);
    const isSqliteTemp = /^\.synabun-(?:db|extra-db)-.*\.tmp$/.test(name);
    const stageDir = name.match(/^\.synabun-files-(\d+)-/);
    // A sidecar whose snapshot is gone (its removal was interrupted) describes nothing.
    const orphanInfo = /\.zip\.enc\.info\.json$/.test(name) && !entries.includes(name.slice(0, -'.info.json'.length));
    if (!archiveTemp && !isSqliteTemp && !stageDir && !orphanInfo) continue;
    const path = resolve(folderPath, name);
    try {
      // The process that made it is named in it. One that is gone will never finish or remove it: it goes now,
      // whatever its age (a staged copy is plaintext). One that still runs keeps its files for `maxAgeMs`.
      const owner = Number((archiveTemp || stageDir)?.[1]) || 0;
      const abandoned = !!ownerGone && owner > 0 && owner !== process.pid && ownerGone(owner);
      if (!abandoned && now() - statSync(path).mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch { /* another process may be mid-cleanup; leave it */ }
  }
  return removed;
}

/**
 * cleanupCrashedBackupArtifacts on a worker thread: the server calls it once as it starts, and a backup folder can
 * be a drive that answers slowly. `before` defaults to when this process started.
 */
export function sweepCrashedBackupArtifacts({ dataHome, folders = [], scratchFolders = [], before = Date.now() - Math.round(process.uptime() * 1000), workerOptions = {} } = {}) {
  if (!dataHome) throw new Error('dataHome is required');
  return runBackupTask('sweep', { dataHome, folders, scratchFolders, before }, workerOptions);
}

/** True when no process has this id any more. A process this one may not signal (EPERM) is there. */
export function processIsGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

/**
 * What a backup that never finished left behind (a crash, a kill, a power cut): the partial archives, the staged
 * plaintext copies and the uploads of a restore. The server calls this once as it starts, for every folder a backup
 * can have worked in; `folders` that do not exist are skipped. Working files of a process that is gone are removed
 * at once, the rest after an hour, as before a backup. Returns the names removed, by folder.
 * @param {{ dataHome: string, folders?: string[], scratchFolders?: string[] }} o  `scratchFolders`: folders that hold
 *        nothing but working files of this server (restore uploads, the browser download's staging): emptied.
 */
export function cleanupCrashedBackupArtifacts({ dataHome, folders = [], scratchFolders = [], ownerGone = processIsGone, before = Date.now() } = {}) {
  const removed = {};
  const sweep = [...new Set([privateBackupStagingRoot(dataHome), resolve(dataHome, 'backups', 'updates'), ...folders.filter(Boolean).map(folder => resolve(folder))])];
  for (const folder of sweep) {
    let names = [];
    try { names = cleanupStaleBackupArtifacts(folder, { ownerGone }); } catch { /* a drive that is not there */ }
    if (names.length) removed[folder] = names;
  }
  // The command-line restore stages next to the data home; a killed one leaves decrypted files there.
  try {
    const stages = sweepRestoreStages(dataHome, { ownerGone });
    if (stages.length) removed[dirname(resolve(dataHome))] = stages;
  } catch { /* a parent folder that cannot be read */ }
  for (const folder of scratchFolders.filter(Boolean).map(item => resolve(item))) {
    let names = [];
    try { names = readdirSync(folder); } catch { continue; }
    const gone = [];
    for (const name of names) {
      // `before`: when this server started. What was written since belongs to a request it is serving now.
      try {
        if (statSync(resolve(folder, name)).mtimeMs >= before) continue;
        rmSync(resolve(folder, name), { recursive: true, force: true });
        gone.push(name);
      } catch { /* in use */ }
    }
    if (gone.length) removed[folder] = [...(removed[folder] || []), ...gone];
  }
  return removed;
}

/** Raised when a backup is cancelled (createVerifiedBackup `signal`): nothing is published, its working files are removed. */
export class BackupCancelledError extends Error {
  constructor() {
    super('The backup was cancelled.');
    this.name = 'BackupCancelledError';
    this.code = 'BACKUP_CANCELLED';
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new BackupCancelledError();
}

/**
 * Start a worker task and await it, stopping its thread when `signal` aborts (the task then rejects, and this throws
 * cancelled). `start` is called only when the backup is not already cancelled: a thread started for a cancelled backup
 * would run on against working files its caller is removing.
 */
async function cancellable(start, signal) {
  throwIfCancelled(signal);
  const task = start();
  if (!signal) return task;
  const stop = () => { try { task.cancel?.(); } catch { /* already over */ } };
  signal.addEventListener('abort', stop, { once: true });
  try { return await task; }
  catch (error) {
    // The thread's own end is kept on the error: the caller's cleanup tries again once native I/O has let go.
    if (signal.aborted) throw Object.assign(new BackupCancelledError(), { workerTermination: error?.workerTermination });
    throw error;
  } finally { signal.removeEventListener('abort', stop); }
}

// `privateFiles`: the copies are made readable by their owner alone (an encrypted backup's staging).
async function snapshotMutableBackupFiles(files, stageDir, signal = null, { privateFiles = false } = {}) {
  const snapshots = [];
  for (const [index, file] of files.entries()) {
    throwIfCancelled(signal);
    if (!isMutableBackupInput(file)) {
      snapshots.push(file);
      continue;
    }
    const diskPath = resolve(stageDir, String(index));
    try {
      await copyFile(file.diskPath, diskPath);
      if (privateFiles && process.platform !== 'win32') await chmod(diskPath, 0o600);
      snapshots.push({ ...file, diskPath });
    } catch (error) {
      // A runtime file deleted since enumeration is no longer part of the backup.
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return snapshots;
}

// `output`: where the archive goes instead of a new file at `tempPath` (the encrypted writer's stream).
async function writeArchive({ tempPath, files, manifest, level = 6, signal = null, output: givenOutput = null }) {
  const { createWriteStream } = await import('node:fs');
  throwIfCancelled(signal);
  let onAbort = null;
  try {
    await new Promise((resolveWrite, reject) => {
    const output = givenOutput || createWriteStream(tempPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level } });
    const remaining = files.values();
    let failure;
    function fail(error) {
      if (failure) return;
      failure = error;
      archive.abort();
      output.destroy();
    }
    onAbort = () => fail(new BackupCancelledError());
    signal?.addEventListener('abort', onAbort, { once: true });
    // Archiver queues a stat and a lazy stream for each file handed to it.
    // Feed one member after the preceding entry has finished.
    function appendNext() {
      const next = remaining.next();
      if (next.done) {
        archive.finalize().catch(fail);
        return;
      }
      const file = next.value;
      const store = INCOMPRESSIBLE_EXTENSIONS.has(extname(file.archivePath).toLowerCase());
      archive.file(file.diskPath, { name: `${BACKUP_PREFIX}/${file.archivePath}`, store });
    }
    output.on('close', () => failure ? reject(failure) : resolveWrite());
    output.on('error', fail);
    archive.on('warning', error => error.code === 'ENOENT' ? appendNext() : fail(error));
    archive.on('error', fail);
    archive.on('entry', appendNext);
    archive.pipe(output);
    archive.append(JSON.stringify(manifest, null, 2), { name: `${BACKUP_PREFIX}/manifest.json` });
    });
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Reopen a finished archive and stream every manifest-listed entry through
 * sha256. Streaming matters: reading the archive into memory failed every
 * backup over 2 GiB, which is when a backup matters most.
 *
 * An archive whose manifest records its groups (backup-groups.js) is also held to them: it holds exactly the groups
 * it names, the memory database exactly when `memories` is one of them, and no entry its manifest does not list.
 * `signal`: stops between two entries (BackupCancelledError).
 */
/**
 * A backup file opened as a ZIP, encrypted or not (told by how the file begins, never by its name). An encrypted
 * one needs `fileKey` (the backup just written) or `password`; without either it throws BACKUP_PASSWORD_REQUIRED,
 * with a wrong password WRONG_PASSWORD, and nothing of its contents is read. The ZIP inside is read through the
 * decrypting source: no plaintext copy of the archive is written. `zip.encrypted` says which it was.
 */
export async function openBackupArchive(path, { fileKey = null, authKey = null, password = null, inline = false } = {}) {
  if (!(await isEncryptedBackupFile(path))) return openZipArchive(path);
  const source = await openEncryptedBackupSource(path, { fileKey, authKey, password, inline });
  return openZipArchive(path, { source });
}

/**
 * For an encrypted archive (`fileKey` with `authKey`, or `password`, as openBackupArchive) the check also opens every part of the
 * file the ZIP's entries did not reach, so that every byte of it has passed its authentication.
 */
export async function verifyBackupArchive(path, { onBytes = null, signal = null, fileKey = null, authKey = null, password = null, inline = false } = {}) {
  const zip = await openBackupArchive(path, { fileKey, authKey, password, inline });
  try {
    const manifestEntry = zip.getEntry(`${BACKUP_PREFIX}/manifest.json`);
    if (!manifestEntry) throw new Error('Backup verification failed: manifest is missing');
    const manifest = JSON.parse((await readZipEntry(zip, manifestEntry)).toString('utf-8'));
    assertBackupGroups(zip, manifest, BACKUP_PREFIX, 'Backup verification failed');
    await verifyBackupChecksums(zip, { prefix: BACKUP_PREFIX, manifest, onBytes, signal });
    throwIfCancelled(signal);
    if (zip.encrypted) await zip.source.authenticateRest({ signal });
    throwIfCancelled(signal);
    return manifest;
  } catch (error) {
    if (signal?.aborted) throw new BackupCancelledError();
    throw error;
  } finally {
    await zip.close();
  }
}

/**
 * Refuse an archive that does not hold what its manifest says it holds (checkManifestGroups). The restore paths call
 * it before they write anything; a manifest from before groups passes (it promised nothing about them).
 */
export function assertBackupGroups(zip, manifest, prefix, label = 'Invalid backup') {
  const problems = checkManifestGroups(manifest, zip.entries.filter(entry => !entry.isDirectory).map(entry => entry.name), prefix);
  if (problems.length) throw Object.assign(new Error(`${label}: ${problems[0]}`), { code: 'BACKUP_GROUPS_MISMATCH' });
}

/**
 * What an encrypted upgrade snapshot says about itself outside its ciphertext: `<archive>.info.json`, beside it.
 * The start after an update decides without a password whether the snapshot still stands for the data
 * (checkUpgradeSnapshotFreshness), and that needs what the snapshot was taken from: its manifest without the file
 * list and its checksums. A plain SHA-256 of `.env` beside the ciphertext would let anybody test a guess at it, so the
 * checksums are kept keyed by the authentication key (`keyedChecksums`): the next start, which has the key file, can
 * compare them and nobody else can read them. The sidecar names the archive's own header (a hash of it), so it
 * describes that file and no other. It is written only for a snapshot inside the data home.
 */
async function writeSnapshotInfo(tempInfoPath, archivePath, manifest, authKey) {
  const header = await readBackupHeaderFile(archivePath);
  const { files, checksums, ...rest } = manifest;
  const info = {
    version: 2,
    header: createHash('sha256').update(header.start).update(header.mac).digest('hex'),
    manifest: { ...rest, fileCount: Array.isArray(files) ? files.length : 0 },
    keyedChecksums: Object.fromEntries(Object.entries(checksums || {}).map(([entry, value]) => [entry, snapshotRecordDigest(authKey, `${entry}\0${value}`)])),
  };
  await writeFile(tempInfoPath, `${JSON.stringify(info)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function readSnapshotInfo(path) {
  let info;
  try { info = JSON.parse(await readFile(backupInfoPath(path), 'utf8')); }
  catch { throw new BackupEncryptionError('BACKUP_PASSWORD_REQUIRED', 'This backup is encrypted: its password is needed to read it.', { status: 401 }); }
  const header = await readBackupHeaderFile(path);
  const actual = createHash('sha256').update(header.start).update(header.mac).digest('hex');
  if (info?.version !== 2 || info.header !== actual || !info.manifest || typeof info.manifest !== 'object' || !info.keyedChecksums || typeof info.keyedChecksums !== 'object') {
    throw new Error('Backup verification failed: the record beside this encrypted snapshot is not its own');
  }
  return { ...info.manifest, keyedChecksums: info.keyedChecksums };
}

/**
 * The manifest of a backup archive, read without reading anything else (its central directory and the manifest entry).
 * An encrypted one is opened with `fileKey` and `authKey`, or `password`; without them, an encrypted upgrade snapshot answers
 * with the record beside it (writeSnapshotInfo: the manifest without its file list), any other encrypted backup
 * with BACKUP_PASSWORD_REQUIRED.
 */
export async function readBackupArchiveManifest(path, { fileKey = null, authKey = null, password = null, inline = false } = {}) {
  if (!fileKey && password == null && await isEncryptedBackupFile(path)) return readSnapshotInfo(path);
  const zip = await openBackupArchive(path, { fileKey, authKey, password, inline });
  try {
    const manifestEntry = zip.getEntry(`${BACKUP_PREFIX}/manifest.json`);
    if (!manifestEntry) throw new Error('Backup verification failed: manifest is missing');
    return JSON.parse((await readZipEntry(zip, manifestEntry)).toString('utf-8'));
  } finally {
    await zip.close();
  }
}

// What a full backup takes from data/ and mcp-data/: everything but what no archive holds, the migration copies of
// memory.db, and memory.db itself (archived as database/memory.db, from a consistent copy).
const fullBackupFilters = () => ({
  data: rel => !shouldSkipDataPath(rel),
  'mcp-data': rel => !shouldSkipDataPath(rel)
    && !isDatabaseCopyArtifact(rel)
    && !/^memory\.db(?:-wal|-shm)?$/i.test(rel)
    && !/\.db-(?:wal|shm)$/i.test(rel),
});

// The folders of data/ a walk can leave unread: what no archive holds, and the folders a left-out group owns.
function dataDirsToSkip(groups) {
  const left = groups ? BACKUP_GROUP_IDS.filter(id => !groups.includes(id)).flatMap(dataDirsOfGroup) : [];
  return { data: rel => isNeverBackedUpDir(rel) || left.includes(rel), 'mcp-data': rel => isNeverBackedUpDir(rel) };
}

// The tree walk, space estimate and stale-directory removal can touch every file in a data home.
// `groups`: the ids of the groups to archive (backup-groups.js), or null for everything a full backup holds.
function collectVerifiedBackupInputs({ dataHome, folderPath, additionalEntries, leanSnapshot, upgradeSoftLimitBytes, groups = null, ...space }) {
  cleanupStaleBackupArtifacts(folderPath);
  const chosen = groups ? new Set(groups) : null;
  const deduped = collectBackupFiles(dataHome, fullBackupFilters(), additionalEntries, dataDirsToSkip(groups))
    .filter((file) => {
      const group = backupGroupOf(file.archivePath);
      return group !== null && (!chosen || chosen.has(group));
    });

  // Keep the upgrade path bounded: state is archived, generated media is not.
  const selection = leanSnapshot
    ? selectUpgradeSnapshotFiles(deduped, { softLimitBytes: upgradeSoftLimitBytes })
    : { files: deduped, excluded: null };
  const includeDatabase = !chosen || chosen.has('memories');
  return {
    ...selection, includeDatabase,
    estimate: estimateBackupWorkingSpace({ ...space, databasePath: includeDatabase ? space.databasePath : null, files: selection.files }),
  };
}

/**
 * How much each group holds right now: { groups: { id: { files, bytes, archiveBytes } }, never: { files, bytes } }.
 * `bytes` is what the files take on disk, `archiveBytes` about what they take in the ZIP (estimateArchivedBytes).
 * `never`: what no backup holds, as far as it is cheap to count (the folders the walk never enters are not read).
 * Every group is measured whatever the selection, so the page can show what switching one on would add. Only names
 * and sizes are read, no file is opened; it runs on a worker thread (runBackupTask 'measure').
 */
function measureBackupGroups({ dataHome, databasePath, additionalEntries = [] }) {
  const groups = Object.fromEntries(BACKUP_GROUP_IDS.map(id => [id, { files: 0, bytes: 0, archiveBytes: 0 }]));
  const never = { files: 0, bytes: 0 };
  const count = (archivePath, bytes) => {
    const group = backupGroupOf(archivePath);
    if (group === null) { never.files += 1; never.bytes += bytes; return; }
    groups[group].files += 1;
    groups[group].bytes += bytes;
    groups[group].archiveBytes += estimateArchivedBytes(archivePath, bytes);
  };
  // Everything a walk reaches, the never-archived files too (they are counted as such, not dropped unseen).
  const everything = { data: () => true, 'mcp-data': rel => !isDatabaseCopyArtifact(rel) && !/^memory\.db(?:-wal|-shm|-journal)?$/i.test(rel) };
  for (const file of collectBackupFiles(dataHome, everything, additionalEntries, dataDirsToSkip(null))) count(file.archivePath, fileBytes(file.diskPath));
  if (databasePath) {
    const bytes = fileBytes(databasePath) + fileBytes(`${databasePath}-wal`);
    if (bytes > 0) count('database/memory.db', bytes);
  }
  return { groups, never };
}

// A dead mount can also wedge cleanup. After a worker timeout, try each cleanup for at most a second;
// the async removal continues and the worker's eventual termination schedules another attempt.
async function waitForBackupCleanup(cleaning, workerTimedOut) {
  if (!workerTimedOut) return cleaning;
  let timer;
  try { await Promise.race([cleaning, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
  finally { clearTimeout(timer); }
}

/** Create, reopen, checksum-verify, and atomically publish one immutable ZIP. */
export async function createVerifiedBackup({
  dataHome,
  databasePath = resolve(dataHome, 'mcp-data', 'memory.db'),
  folderPath,
  kind = 'scheduled',
  appVersion = null,
  dataSchemaVersion = 1,
  sourceFingerprint = null,
  additionalEntries = [],
  expectedArchiveBytes = 0,
  freeSpaceReserveBytes = BACKUP_FREE_SPACE_RESERVE_BYTES,
  getAvailableBytes = backupAvailableBytes,
  checkIntegrity = checkSqliteIntegrity,
  workerOptions = {},
  onBeforeArchive = null,
  onProgress = null,
  upgradeSoftLimitBytes = UPGRADE_SNAPSHOT_SOFT_LIMIT_BYTES,
  // Which groups go in (backup-groups.js): ids, or a { id: boolean } selection; null is everything. The manifest
  // records them, and the archive is verified against them before it is published.
  groups = null,
  // An AbortSignal: aborting stops the backup at its next step (BackupCancelledError); nothing is published and the
  // archive under way and the staged copies are removed, as after any failure.
  signal = null,
  // Left out: the backup is encrypted when the owner turned encryption on (the data home's key file), and fails
  // when that key cannot be used. { recipient } names the key directly (tests). There is no value for "plain".
  encryption = undefined,
  now = () => new Date(),
} = {}) {
  // A large data home spends minutes in checksum/archive with no output. Phase
  // reporting is what stops that from reading as a hang to the caller.
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  if (!dataHome || !folderPath) throw new Error('dataHome and folderPath are required');
  const chosenGroups = groups == null ? null : selectedBackupGroups(groups);
  if (chosenGroups && !chosenGroups.length) {
    throw Object.assign(new Error('Nothing is selected for this backup: switch on at least one group.'), { code: 'BACKUP_NOTHING_SELECTED', status: 400 });
  }
  throwIfCancelled(signal);
  // Before anything is written: a key file that cannot be used fails the backup here.
  const encrypt = backupEncryptionFor(dataHome, encryption);
  const createdAt = now();
  assertBackupDestinationMounted(folderPath);
  await mkdir(folderPath, { recursive: true });
  const destination = resolve(folderPath, archiveNameFor(kind, createdAt, !!encrypt));
  const tempPath = `${destination}.${process.pid}.tmp`;
  if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);

  let stageDir = null;
  let workerTimedOut = false;
  // The encrypted writer and this file's key, while they exist: both are gone before this function returns.
  let writer = null;
  try {
    const leanSnapshot = UPGRADE_BACKUP_KINDS.has(kind);
    markActivity('backup:collect');
    const { files, excluded, estimate, includeDatabase } = await cancellable(() => runBackupTask('collect', {
      dataHome, folderPath, additionalEntries, leanSnapshot, upgradeSoftLimitBytes, groups: chosenGroups,
      databasePath, expectedArchiveBytes, freeSpaceReserveBytes,
    }, workerOptions.collect), signal);
    if (encrypt) cleanupStaleBackupArtifacts(privateBackupStagingRoot(dataHome));
    const workingSpace = encrypt
      ? checkSplitWorkingSpace(folderPath, existsSync(privateBackupStagingRoot(dataHome)) ? privateBackupStagingRoot(dataHome) : dataHome, estimate, getAvailableBytes, freeSpaceReserveBytes)
      : checkWorkingSpace(folderPath, estimate, getAvailableBytes);
    report({
      phase: 'collect',
      files: files.length,
      bytes: workingSpace.archiveBytes,
      skippedFiles: excluded?.files ?? 0,
      skippedBytes: excluded?.bytes ?? 0,
      skippedReason: excluded?.reason ?? null,
    });

    // Own all staged files, including partial database copies and their SQLite sidecars. They are plaintext: an
    // encrypted backup stages them in the data home's private folder, never in the destination.
    stageDir = encrypt ? await makePrivateStage(dataHome) : await mkdtemp(resolve(folderPath, `.synabun-files-${process.pid}-`));
    const databases = files.filter(file => /\.db$/i.test(file.archivePath));
    markActivity('backup:copy');
    // The memory database is copied only when the memories are part of this backup.
    const copied = await cancellable(() => runBackupTask('copy', { databasePath: includeDatabase === false ? null : databasePath, databases, stageDir, privateFiles: !!encrypt }, {
      inputBytes: estimate.sqliteSnapshotBytes, ...workerOptions.copy,
    }), signal);
    // An empty extra database (and its sidecars) is left out of the archive, the manifest and the checks.
    const skippedDatabases = new Set(copied.filter(copy => copy.skipped).map(copy => copy.archivePath.replace(/\\/g, '/')));
    const copies = copied.filter(copy => !copy.skipped);
    const sqliteSnapshot = copies.find(copy => copy.primary);
    const byEntry = new Map(files.map(file => [file.archivePath.replace(/\\/g, '/'), file])
      .filter(([entry]) => !skippedDatabases.has(entry.replace(/-(?:wal|shm|journal)$/i, ''))));
    // The phases from here on count what is archived. Collect counted every collected file: these say what of it the
    // copy found empty and left out (the databases, and them with their sidecars), so the two counts add up.
    const skippedEmpty = { skippedEmptyDatabases: skippedDatabases.size, skippedEmptyDatabaseFiles: files.length - byEntry.size };
    for (const { archivePath, path } of copies) byEntry.set(archivePath.replace(/\\/g, '/'), { archivePath, diskPath: path });

    let results;
    try {
      markActivity('backup:integrity');
      results = await cancellable(() => checkIntegrity(copies.map(copy => copy.path), {
        inputBytes: copies.reduce((sum, copy) => sum + copy.sizeBytes, 0), ...workerOptions.integrity,
      }), signal);
    } catch (cause) {
      if (cause.code === 'BACKUP_WORKER_TIMEOUT' || cause.code === 'BACKUP_CANCELLED') throw cause;
      throw Object.assign(new Error(`SQLite's integrity check of the copies could not run: ${cause.message}`, { cause }), { code: 'EINTEGRITY' });
    }
    for (const copy of copies) {
      const verdict = results?.find(result => result?.path === copy.path);
      if (verdict?.ok !== true) throw new SnapshotIntegrityError(copy.archivePath, verdict?.lines || []);
    }
    markActivity('backup:snapshot-files');
    const finalFiles = await snapshotMutableBackupFiles([...byEntry.values()], stageDir, signal, { privateFiles: !!encrypt });
    finalFiles.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
    markActivity('backup:checksum');
    report({ phase: 'checksum', files: finalFiles.length, ...skippedEmpty });
    const checksums = {};
    for (const file of finalFiles) {
      throwIfCancelled(signal);
      checksums[file.archivePath] = `sha256:${await hashFile(file.diskPath)}`;
    }
    // What this archive holds, by group. `absent`: a group that was asked for and had nothing to give (a data home
    // without a memory database), so a reader does not take the missing database for damage.
    const recordedGroups = leanSnapshot ? null : manifestGroups(chosenGroups);
    if (recordedGroups && recordedGroups.included.includes('memories') && !sqliteSnapshot) recordedGroups.absent = ['memories'];

    const manifest = {
      version: BACKUP_MANIFEST_VERSION,
      created: createdAt.toISOString(),
      kind,
      appVersion,
      dataSchemaVersion,
      sourceFingerprint,
      storage: 'sqlite',
      database: sqliteSnapshot ? {
        file: sqliteSnapshot.archivePath,
        sizeBytes: sqliteSnapshot.sizeBytes,
        memoryCount: sqliteSnapshot.memoryCount,
        integrity: 'ok',
      } : null,
      files: finalFiles.map(file => file.archivePath),
      checksums,
      // A lean snapshot is not a whole-data-home backup, and neither is one the owner left groups out of. Recording
      // that here keeps a restore from silently presenting it as one.
      scope: leanSnapshot ? 'state-only' : recordedGroups.excluded.length ? 'selected' : 'complete',
      ...(recordedGroups ? { groups: recordedGroups } : {}),
      excluded,
      verified: true,
      verification: { algorithm: 'sha256', publication: 'verify-before-atomic-rename' },
    };
    if (typeof onBeforeArchive === 'function') await onBeforeArchive({ files: finalFiles, manifest });
    throwIfCancelled(signal);
    markActivity('backup:archive');
    // tempPath: where the archive grows, for a caller that shows how much is written (lib/backup-download.js).
    report({ phase: 'archive', files: finalFiles.length, bytes: workingSpace.archiveBytes, tempPath, ...skippedEmpty });
    // Level 1 on the blocking upgrade path: the remaining payload is mostly
    // SQLite and JSON, where fast deflate still shrinks well.
    // Encrypted: the archive never exists in plaintext. Its bytes go from archiver through the encrypting thread
    // into the file, and the file is then read back with this file's key, which nothing else ever holds.
    if (encrypt) writer = createEncryptedBackupWriter(tempPath, encrypt.recipient, { chunkSize: encrypt.chunkSize, now });
    await writeArchive({ tempPath, files: finalFiles, manifest, level: leanSnapshot ? 1 : 6, signal, output: writer ? writer.stream() : null });
    markActivity('backup:verify');
    report({ phase: 'verify', files: finalFiles.length, tempPath, ...skippedEmpty });
    const publishedManifest = await verifyBackupArchive(tempPath, { signal, fileKey: writer ? writer.fileKey : null, authKey: writer ? writer.authKey : null });
    throwIfCancelled(signal);
    // No downgrade, checked on the file itself: with encryption on, what is published begins as an encrypted backup.
    if (encrypt && !(await isEncryptedBackupFile(tempPath))) throw new BackupEncryptionError('BACKUP_ENC_NOT_ENCRYPTED', 'The backup was not encrypted: it is not published.', { status: 500 });
    // rename replaces: a file that took the name while this archive was built is kept, and this one is not published.
    if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);
    await rename(tempPath, destination);
    return {
      path: destination,
      name: basename(destination),
      kind,
      createdAt: createdAt.toISOString(),
      sizeBytes: (await stat(destination)).size,
      manifest: publishedManifest,
      encrypted: !!encrypt,
      ...(writer ? { keyId: writer.keyId } : {}),
    };
  } catch (error) {
    workerTimedOut = error.code === 'BACKUP_WORKER_TIMEOUT';
    // Native I/O may outlive terminate(). Retry cleanup when it finally releases its files (notably on Windows).
    error.workerTermination?.then(async () => {
      await rm(tempPath, { force: true }).catch(() => {});
      if (stageDir) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }).catch(() => {});
    // The encrypting thread lets go of the file before it is removed.
    if (writer) await writer.abort().catch(() => {});
    await waitForBackupCleanup(rm(tempPath, { force: true }).catch(() => {}), workerTimedOut);
    throw error;
  } finally {
    if (writer) writer.wipe();
    if (stageDir) await waitForBackupCleanup(rm(stageDir, { recursive: true, force: true }).catch(() => {}), workerTimedOut);
  }
}

// ── The pre-update snapshot: quick at any size ──
//
// The full backup deflates database copies and reads them back through inflate. The pre-update snapshot
// is taken while SynaBun restarts into a new version, with the user waiting.
// createUpgradeSnapshot() keeps what that snapshot promises (the state as of one commit, every byte in a ZIP the
// restore paths read, every database copy passing the integrity check the restore runs, read back once and checked
// before it is published) and avoids deflating the database and inflating it again.
// Its integrity check runs on a thread of its own while the archive is written.
//
// The snapshot also records what it was taken from (`inputs` in its manifest): checkUpgradeSnapshotFreshness()
// tells later, from any process, whether it still stands for the data as it is (lib/update-snapshot.js before the
// desktop app replaces itself, lib/first-launch-protection.js before the new version's server starts).

/** statfs type of APFS (macOS): a file there can be cloned in constant time. */
const APFS_STATFS_TYPE = 26;

/**
 * How `source` can be cloned (copy on write, in constant time) into the folder `targetDir`, or null: APFS on
 * macOS (/bin/cp -c, which is clonefile), a reflink on Linux (FICLONE; a file system without one refuses it, and
 * the copy falls back). Windows has neither. Only within one volume.
 */
export function cloneMethodFor(source, targetDir, { platform = process.platform, statfs = statfsSync, stat = statSync } = {}) {
  try {
    if (stat(source).dev !== stat(targetDir).dev) return null;
    if (platform === 'darwin') return Number(statfs(targetDir).type) === APFS_STATFS_TYPE ? 'clone' : null;
    if (platform === 'linux') return 'reflink';
  } catch { /* no clone: SQLite's backup copies */ }
  return null;
}

function cloneFileNow(source, target, method) {
  // A worker thread shares the server's POSIX locks. Closing a raw descriptor for the live database
  // in this process can release SQLite's locks, so let cp open and close its own descriptors.
  const cloneFlag = method === 'clone' ? '-c' : '--reflink=always';
  execFileSync('/bin/cp', [cloneFlag, resolve(source), resolve(target)], { stdio: 'ignore', timeout: 60_000 });
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** Up to `length` bytes from the start of the file at `path`. */
function readHead(path, length) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(length);
    const read = readSync(fd, head, 0, length, 0);
    return head.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * True when the file at `path` begins with SQLite's 16-byte header: a database, whatever its name says. False for
 * anything else and for a file that is gone (nothing to copy); any other error is thrown.
 */
export function isSqliteDatabaseFile(path) {
  try {
    return readHead(path, SQLITE_HEADER.length).equals(SQLITE_HEADER);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * What tells a later reader, in any process, whether the SQLite database at `path` was written since: its file
 * (device, inode, size, modification and change times, and its first 100 bytes, where a rollback-journal database
 * counts every commit) and the content of its WAL, which every commit of a WAL database changes. An empty WAL counts
 * as none: the last connection to close deletes it, and changes nothing else when it is empty. The fingerprint is
 * physical, so a checkpoint changes it without a commit: that costs a needless new snapshot, never a missed write.
 */
export function sqliteFingerprint(path) {
  const stat = statSync(path, { bigint: true });
  let wal = null;
  const walPath = `${path}-wal`;
  try {
    const walSize = statSync(walPath).size;
    if (walSize > 0) wal = { size: walSize, sha256: hashFileSync(walPath) };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    head: createHash('sha256').update(readHead(path, 100)).digest('hex'),
    wal,
  };
}

/** True when two fingerprints (sqliteFingerprint) say the database was not written in between. */
export function sameSqliteFingerprint(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  for (const key of ['dev', 'ino', 'mtimeNs', 'ctimeNs', 'head']) if (String(a[key]) !== String(b[key])) return false;
  if (Number(a.size) !== Number(b.size)) return false;
  if (!a.wal || !b.wal) return !a.wal && !b.wal;
  return Number(a.wal.size) === Number(b.wal.size) && a.wal.sha256 === b.wal.sha256;
}

/**
 * A consistent copy of the SQLite database `sourcePath` at `targetPath`: the database as of one commit, in one
 * self-contained file (journal_mode DELETE, nothing beside it). As fast as the file system allows:
 *
 *   clone    APFS or a reflink: the database file and its WAL are cloned while this connection holds the write
 *            lock (BEGIN IMMEDIATE: a writer waits a moment, readers go on), then the copy folds its WAL in.
 *            Constant time whatever the size. Nothing can go missing between the two clones: a checkpoint may
 *            still copy frames into the database file, but the WAL keeps every one of them, because no writer
 *            can reset it while the lock is held.
 *   backup   anywhere else (or when the lock is not free within `busyTimeoutMs`), SQLite's online backup in
 *            one step: one sequential read and write, from one read transaction, and no writer ever waits.
 *   vacuum   a Node without the backup API (before 22.16): VACUUM INTO.
 *
 * For an upgrade freshness fingerprint, try a TRUNCATE checkpoint (waiting up to a second for older readers)
 * so the fingerprint survives the close of the last connection. Take it under the write lock for a clone or
 * immediately before the copy otherwise. Full backups need only the copy and can leave the live WAL alone.
 * The copy is then opened read-only once: its header must account for its whole size,
 * and the memories of the `primary` database are counted (a query that fails there fails the copy). Resolves
 * { method, path, sizeBytes, memoryCount, pageCount, fingerprint }, or null when there is no database.
 */
export async function copySqliteDatabase(sourcePath, targetPath, {
  platform = process.platform, method: forced = null, busyTimeoutMs = 15_000, clone = cloneFileNow, primary = false,
  captureFingerprint = true, skipEmpty = false,
} = {}) {
  if (!existsSync(sourcePath)) return null;
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${targetPath}${suffix}`, { force: true });
  const fallback = typeof nodeSqlite.backup === 'function' ? 'backup' : 'vacuum';
  let method = forced || cloneMethodFor(sourcePath, dirname(targetPath), { platform }) || fallback;
  let fingerprint = null;
  const readFingerprint = () => captureFingerprint ? sqliteFingerprint(sourcePath) : null;
  const source = new DatabaseSync(sourcePath);
  try {
    // Only an upgrade freshness check needs a stable fingerprint. A full backup can copy the WAL as it is.
    if (captureFingerprint) {
      try {
        source.exec('PRAGMA busy_timeout = 1000');
        source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      } catch { /* busy or not a WAL database */ }
    }
    source.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    // An extra database nothing ever initialized (no page on disk or in its WAL) holds nothing to keep.
    if (skipEmpty && Number(source.prepare('PRAGMA page_count').get().page_count) === 0) {
      return { skipped: true, reason: 'empty', path: null };
    }
    // A zero-byte, uninitialized database is valid SQLite. Cloning it leaves an empty file; SQLite's
    // backup/VACUUM materializes its header. Read logical pages (including WAL) BEFORE BEGIN IMMEDIATE,
    // which gives an empty database a virtual first page without writing it to disk.
    if ((method === 'clone' || method === 'reflink') && Number(source.prepare('PRAGMA page_count').get().page_count) === 0) {
      method = fallback;
    }
    if (method === 'clone' || method === 'reflink') {
      let locked = false;
      let cloned = false;
      try {
        source.exec('BEGIN IMMEDIATE');
        locked = true;
        fingerprint = readFingerprint();
        clone(sourcePath, targetPath, method);
        const wal = `${sourcePath}-wal`;
        if (existsSync(wal) && statSync(wal).size > 0) clone(wal, `${targetPath}-wal`, method);
        cloned = true;
      } catch {
        for (const suffix of ['', '-wal']) rmSync(`${targetPath}${suffix}`, { force: true });
      } finally {
        // Nothing was written: the lock is only let go.
        if (locked) { try { source.exec('ROLLBACK'); } catch {} }
      }
      if (!cloned) method = fallback;
    }
    if (method === 'backup') {
      fingerprint = readFingerprint();
      // One step holds one read transaction for the whole copy: no restart, whatever the server writes.
      await nodeSqlite.backup(source, targetPath, { rate: 1_000_000_000 });
    } else if (method === 'vacuum') {
      fingerprint = readFingerprint();
      source.exec(`VACUUM INTO '${escapeSqliteString(targetPath)}'`);
    }
  } finally {
    try { source.close(); } catch {}
  }
  const copy = new DatabaseSync(targetPath);
  try {
    copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copy.exec('PRAGMA journal_mode = DELETE');
  } finally {
    try { copy.close(); } catch {}
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${targetPath}${suffix}`, { force: true });
  const check = new DatabaseSync(targetPath, { readOnly: true });
  try {
    const pageCount = Number(check.prepare('PRAGMA page_count').get()?.page_count);
    const pageSize = Number(check.prepare('PRAGMA page_size').get()?.page_size);
    const sizeBytes = statSync(targetPath).size;
    if (!(pageCount > 0) || pageCount * pageSize !== sizeBytes) {
      throw new Error(`The copy of ${basename(sourcePath)} is incomplete: ${pageCount} pages of ${pageSize} bytes in a file of ${sizeBytes} bytes`);
    }
    let memoryCount = null;
    if (primary) {
      // A memory database that was never set up has no memories table; any other failure is the copy's.
      const hasMemories = check.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get();
      memoryCount = hasMemories ? Number(check.prepare('SELECT COUNT(*) AS count FROM memories').get().count) : 0;
    }
    return { method, path: targetPath, sizeBytes, memoryCount, pageCount, fingerprint };
  } finally {
    try { check.close(); } catch {}
  }
}

// Even the online-copy path can wait synchronously for locks, checkpoint a large WAL or use VACUUM on old Node.
// `databasePath` null: a backup without the memories. The memory database is then not opened at all.
async function copyVerifiedDatabases({ databasePath, databases, stageDir, privateFiles = false }) {
  const copies = [];
  const primary = databasePath ? { archivePath: 'database/memory.db', diskPath: databasePath, primary: true } : null;
  for (const [index, file] of [...(primary ? [primary] : []), ...databases].entries()) {
    const isPrimary = file === primary;
    if (!isPrimary && file.archivePath.replace(/\\/g, '/') === 'database/memory.db') continue;
    // A single online backup/VACUUM has no intermediate progress; give this database room to finish.
    reportBackupWorkerProgress(fileBytes(file.diskPath) + fileBytes(`${file.diskPath}-wal`), true);
    const target = resolve(stageDir, `db-${index}.tmp`);
    let copy;
    try {
      copy = await copySqliteDatabase(file.diskPath, target, { primary: isPrimary, captureFingerprint: false, skipEmpty: !isPrimary });
    } catch (cause) {
      throw Object.assign(new Error(`Could not copy ${file.archivePath}: ${cause.message}`, { cause }), { code: cause.code });
    }
    if (!copy) {
      if (isPrimary) continue;
      throw Object.assign(new Error(`SQLite backup input disappeared: ${file.archivePath}`), { code: 'ENOENT' });
    }
    if (copy.skipped) { copies.push({ archivePath: file.archivePath, skipped: copy.reason }); continue; }
    if (privateFiles && process.platform !== 'win32') chmodSync(copy.path, 0o600);
    copies.push({ archivePath: file.archivePath, path: copy.path, sizeBytes: copy.sizeBytes, memoryCount: copy.memoryCount, primary: isPrimary });
  }
  return copies;
}

/**
 * How much each backup group holds right now, measured on a worker thread (names and sizes only; no file is opened
 * and the server's own thread does nothing but wait). Resolves { groups: { id: { files, bytes, archiveBytes } },
 * never: { files, bytes } }; `cancel()` on the promise stops the thread.
 */
export function measureBackupContents({ dataHome, databasePath = resolve(dataHome, 'mcp-data', 'memory.db'), additionalEntries = [], workerOptions = {} } = {}) {
  if (!dataHome) throw new Error('dataHome is required');
  return runBackupTask('measure', { dataHome, databasePath, additionalEntries }, workerOptions);
}

// Early Node 22 releases gate node:sqlite on a flag. File-backed workers cannot inherit --input-type or --eval.
const sqliteWorkerArgs = process.execArgv.filter(arg => arg === '--experimental-sqlite' || arg === '--disable-warning=ExperimentalWarning');

// Collection reports actual filesystem progress, never a heartbeat that could mask a stuck operation.
let lastBackupWorkerProgress = 0;
function reportBackupWorkerProgress(inputBytes, force = false) {
  if (!parentPort || !workerData?.verifiedBackupTask) return;
  const now = Date.now();
  if (!force && now - lastBackupWorkerProgress < 1000) return;
  lastBackupWorkerProgress = now;
  parentPort.postMessage({ progress: true, inputBytes });
}

/** Inactivity budgets: two minutes per collection operation; 10 min + 5 min/GiB per native database operation. */
export function backupWorkerTimeoutMs(task, inputBytes = 0) {
  if (task === 'collect' || task === 'measure' || task === 'sweep') return 2 * 60_000;
  return Math.min(2_147_000_000, 10 * 60_000 + Math.ceil(Math.max(0, Number(inputBytes) || 0) / 1024 ** 3) * 5 * 60_000);
}

function watchBackupWorker(task, data, {
  spawnWorker, timeoutMs = null, inputBytes = 0, terminationGraceMs = 1000,
} = {}) {
  let cancel = () => {};
  const checking = new Promise((resolveTask, reject) => {
    let worker;
    let timer;
    let grace;
    let settled = false;
    let stopping = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      fn(value);
    };
    const stop = (error) => {
      if (settled || stopping) return;
      stopping = error;
      clearTimeout(timer);
      // Usually termination is immediate. A thread stuck in native I/O may not exit until the OS returns:
      // still settle the caller after a bounded grace period, and let its cleanup retry after that exit.
      try { error.workerTermination = Promise.resolve(worker.terminate()); }
      catch { error.workerTermination = Promise.resolve(); }
      error.workerTermination.then(() => settle(reject, error), () => settle(reject, error));
      grace = setTimeout(() => { worker.unref?.(); settle(reject, error); }, terminationGraceMs);
    };
    const reset = (bytes = inputBytes) => {
      inputBytes = bytes;
      clearTimeout(timer);
      const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : backupWorkerTimeoutMs(task, inputBytes);
      timer = setTimeout(() => stop(Object.assign(
        new Error(`Backup ${task} worker timed out after ${limit} ms without progress`),
        { code: 'BACKUP_WORKER_TIMEOUT', task, timeoutMs: limit },
      )), limit);
    };
    try { worker = spawnWorker(data); }
    catch (error) { settle(reject, error); return; }
    worker.on('message', (message) => {
      if (settled || stopping) return;
      if (message?.progress === true) { reset(message.inputBytes); return; }
      if (message?.error) settle(reject, Object.assign(message.error, { code: message.code }));
      else settle(resolveTask, Array.isArray(message) ? message : message.result);
    });
    worker.once('error', (error) => settle(reject, stopping || error));
    worker.once('exit', (code) => settle(reject, stopping || Object.assign(
      new Error(`Backup ${task} worker exited (${code}) without a result`), { code: 'BACKUP_WORKER_EXIT', task },
    )));
    cancel = () => stop(Object.assign(new Error(`Backup ${task} worker cancelled`), { code: 'BACKUP_WORKER_CANCELLED', task }));
    reset();
  });
  checking.cancel = () => cancel();
  return checking;
}

export function runBackupTask(task, options, {
  spawnWorker = (data) => new Worker(new URL(import.meta.url), { workerData: data, execArgv: sqliteWorkerArgs }),
  ...watchdog
} = {}) {
  return watchBackupWorker(task, { verifiedBackupTask: task, options }, { ...watchdog, spawnWorker });
}

/**
 * SQLite's PRAGMA integrity_check, the one `synabun restore-backup` runs, on each file in `paths`, on a thread of
 * its own (sqlite-integrity-worker.js): a 3.9 GB memory.db takes about 28 s, spent while the archive is written.
 * Resolves [{ path, ok, lines, ms }] (`lines`: SQLite's first findings when a file is not ok); `cancel()` on the
 * promise stops the thread (it then rejects). Each database gets a size-based inactivity budget.
 */
export function checkSqliteIntegrity(paths, {
  spawnWorker = (data) => new Worker(new URL('./sqlite-integrity-worker.js', import.meta.url), { workerData: data, execArgv: sqliteWorkerArgs }),
  ...watchdog
} = {}) {
  if (!paths.length) return Object.assign(Promise.resolve([]), { cancel: () => {} });
  return watchBackupWorker('integrity', { paths }, { ...watchdog, spawnWorker });
}

/** Raised when a database copy fails SQLite's integrity check: the snapshot is not published. */
export class SnapshotIntegrityError extends Error {
  constructor(file, lines) {
    super(`The copy of ${file} did not pass SQLite's integrity check: ${lines.slice(0, 3).join('; ') || 'no answer'}`);
    this.name = 'SnapshotIntegrityError';
    this.code = 'EINTEGRITY';
    this.file = file;
    this.lines = lines;
  }
}

/** Which file this is, as far as a later reader can tell without reading it: device, inode, size, modified. */
export function backupFileStamp(path) {
  const stat = statSync(path, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs) };
}

/** True when `path` is still the very file `stamp` describes (nothing rewrote or replaced it). */
export function sameBackupFile(path, stamp) {
  if (!stamp || typeof stamp !== 'object') return false;
  try {
    const now = backupFileStamp(path);
    return now.dev === String(stamp.dev) && now.ino === String(stamp.ino) && now.size === Number(stamp.size) && now.mtimeNs === String(stamp.mtimeNs);
  } catch {
    return false;
  }
}

// ── What an upgrade snapshot protects ──

// What lives in data/ and mcp-data/ without being state to roll back, and is rewritten by itself all the time (a
// snapshot that held it could never stay exact): logs; the start launcher's and the supervisor's records, the
// update's own handoff, the resume heartbeat of terminal sessions (rewritten every 30 s), the hooks' per-session flags
// and transcript captures, the MCP tool counters; the caches the server rebuilds from the memories (the map's layout,
// the links); and the automation browser's Chromium profiles, which Chromium locks and rewrites while it runs (the
// "attach" one even when SynaBun does not), and which no SynaBun update touches. Upgrade snapshots leave them out;
// the full backups keep everything. (The folders of the local browser profiles, data/local-profiles/<id>/, are in no
// archive at all: shouldSkipDataPath. Their definitions, data/local-profiles/profiles.json, are in every one.)
const UPGRADE_RUNTIME_FILES = Object.freeze({
  data: new Set(['supervisor.json', 'start-launcher.lock', 'update-handoff.json', 'last-session.json', 'memory-map.json', 'links-cache.json']),
  'mcp-data': new Set(['tool-usage.json']),
});
const UPGRADE_RUNTIME_DIRS = Object.freeze({
  data: new Set(['pending-remember', 'pending-compact', 'precompact', 'chrome-profile', 'chrome-attach', 'browser-profiles']),
  'mcp-data': new Set(),
});

/** True for what no upgrade snapshot holds (the list above): `relativePath` inside data/ or mcp-data/ (`dir`). */
export function isUpgradeRuntimeFile(dir, relativePath) {
  const parts = String(relativePath).replace(/\\/g, '/').split('/');
  if (/\.log(?:\.\d+)?$/i.test(parts.at(-1))) return true;
  if (parts.length === 1) return !!UPGRADE_RUNTIME_FILES[dir]?.has(parts[0]);
  return !!UPGRADE_RUNTIME_DIRS[dir]?.has(parts[0]);
}

/**
 * What an upgrade snapshot protects, as it is now, besides the memory database: `.env` and the state files of data/
 * and mcp-data/ (selectUpgradeSnapshotFiles' choice, without the runtime records above). Each is { archivePath,
 * diskPath, sqlite }: a file that begins with SQLite's header is a database whatever its name, and its journal, WAL
 * and shared-memory files belong to it (never archived on their own).
 */
function collectUpgradeInputs({ dataHome, additionalEntries = [], softLimitBytes = UPGRADE_SNAPSHOT_SOFT_LIMIT_BYTES }) {
  const dataDirFilters = {
    data: rel => !shouldSkipDataPath(rel) && !isUpgradeRuntimeFile('data', rel),
    'mcp-data': rel => !shouldSkipDataPath(rel)
      && !isUpgradeRuntimeFile('mcp-data', rel)
      && !isDatabaseCopyArtifact(rel)
      && !/^memory\.db(?:-wal|-shm|-journal)?$/i.test(rel),
  };
  const deduped = collectBackupFiles(dataHome, dataDirFilters, additionalEntries);
  const { files: kept, excluded } = selectUpgradeSnapshotFiles(deduped, { softLimitBytes });
  // An extra .db nothing initialized (0 bytes, no WAL with content) is skipped with its sidecars, as in a full backup.
  // Only a file that is not there is 0 bytes here (backupFileSize): one whose size cannot be read fails the snapshot
  // instead of passing for empty and dropping out of it.
  const empty = new Set(kept.filter(file => /\.db$/i.test(file.archivePath)
    && backupFileSize(file) === 0 && backupFileSize({ diskPath: `${file.diskPath}-wal` }) === 0).map(file => file.archivePath.toLowerCase()));
  const marked = kept.filter(file => !empty.has(file.archivePath.toLowerCase()))
    .map(file => ({ ...file, sqlite: isSqliteDatabaseFile(file.diskPath) }));
  const databases = new Set([...empty, ...marked.filter(file => file.sqlite).map(file => file.archivePath.toLowerCase())]);
  // The database a journal, WAL or shared-memory file belongs to (lower case), or null for a file of its own.
  const ownerOf = (archivePath) => {
    const lower = archivePath.toLowerCase();
    const suffix = SQLITE_SIDE_FILES.find(item => item && lower.endsWith(item) && databases.has(lower.slice(0, -item.length)));
    return suffix ? lower.slice(0, -suffix.length) : null;
  };
  const inputs = [];
  // What the empty-database rule left out, for the progress report: the databases and every file that went with them.
  const skippedEmpty = { databases: kept.length - marked.length, files: kept.length - marked.length };
  for (const file of marked) {
    const owner = ownerOf(file.archivePath);
    if (!owner) inputs.push(file);
    else if (empty.has(owner)) skippedEmpty.files += 1;
  }
  return { inputs, excluded, skippedEmpty };
}

/** Where an input is, as the manifest records it: relative to the data home (forward slashes), absolute outside it. */
function inputPath(dataHome, diskPath) {
  const rel = relative(resolve(dataHome), resolve(diskPath));
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : resolve(diskPath);
}

/**
 * Whether the upgrade snapshot whose manifest is `manifest` still stands for the data home as it is now, whichever
 * process wrote since: the same protected files (none new, none gone), every database with the fingerprint it had
 * when it was copied (sqliteFingerprint), every other file with the very content that was archived (its SHA-256 in
 * the manifest). Resolves { fresh, reason, changed: [{ entry, path, why }] }; it stops at the third difference. A
 * snapshot that does not record what it was taken from is never fresh.
 */
export async function checkUpgradeSnapshotFreshness({
  dataHome, manifest, databasePath = resolve(dataHome, 'mcp-data', 'memory.db'), upgradeSoftLimitBytes = UPGRADE_SNAPSHOT_SOFT_LIMIT_BYTES,
} = {}) {
  const recorded = manifest?.inputs?.entries;
  if (!dataHome || !Array.isArray(recorded)) return { fresh: false, reason: 'it does not record what it was taken from', changed: [] };
  // An encrypted snapshot's record keeps its checksums keyed: they are compared with this installation's key. A new
  // password keeps that key; one that did change since (encryption turned off and on, a key file replaced) cannot
  // match, and a new snapshot is taken.
  let recordKey = null;
  if (manifest.keyedChecksums) {
    try { const recipient = backupRecipientFor(dataHome); recordKey = recipient ? authKeyOf(recipient) : null; } catch { /* below */ }
    if (!recordKey) return { fresh: false, reason: 'its record needs the backup key, which is not here', changed: [] };
  }
  const sameContent = (entry, actual) => {
    if (actual === null) return false;
    if (recordKey) return manifest.keyedChecksums[entry] === snapshotRecordDigest(recordKey, `${entry}\0${actual}`);
    return actual === manifest.checksums?.[entry];
  };
  const current = new Map(collectUpgradeInputs({ dataHome, softLimitBytes: upgradeSoftLimitBytes }).inputs.map(file => [file.archivePath, file]));
  if (existsSync(databasePath)) current.set('database/memory.db', { archivePath: 'database/memory.db', diskPath: databasePath, sqlite: true });
  const before = new Map(recorded.filter(item => item && typeof item.entry === 'string').map(item => [item.entry, item]));
  const changed = [];
  const differs = (entry, path, why) => changed.push({ entry, path, why }) >= 3;
  scan: {
    for (const [entry, file] of current) {
      if (!before.has(entry) && differs(entry, inputPath(dataHome, file.diskPath), 'is new')) break scan;
    }
    for (const [entry, item] of before) {
      const file = current.get(entry);
      const path = typeof item.path === 'string' && item.path ? item.path : entry;
      if (!file) { if (differs(entry, path, 'is gone')) break scan; continue; }
      if (!!item.sqlite !== !!file.sqlite) { if (differs(entry, path, 'changed')) break scan; continue; }
      if (item.sqlite) {
        let now = null;
        try { now = sqliteFingerprint(file.diskPath); } catch { /* gone or unreadable: written */ }
        if (!sameSqliteFingerprint(item.sqlite, now) && differs(entry, path, 'was written')) break scan;
        continue;
      }
      let actual = null;
      try { actual = `sha256:${await hashFile(file.diskPath)}`; } catch { /* gone or unreadable: changed */ }
      if (!sameContent(entry, actual) && differs(entry, path, 'changed')) break scan;
    }
  }
  return changed.length
    ? { fresh: false, reason: changed.map(item => `${item.path} ${item.why}`).join(', '), changed }
    : { fresh: true, reason: null, changed };
}

/**
 * The snapshot SynaBun takes before a new version first runs on the data (kinds pre-update and pre-migration),
 * built for the moment it is taken: a restart into an update, with the user waiting.
 *
 *   what       collectUpgradeInputs: .env, the memory database and the state files of data/ and mcp-data/
 *              (generated media, logs and runtime records, the copies of memory.db that migrations leave, and the
 *              backups folder are never in it)
 *   databases  memory.db and every other SQLite file, known by its header whatever its name, each as of one commit
 *              (copySqliteDatabase: a clone under the write lock where the file system clones, SQLite's online
 *              backup elsewhere). A database that cannot be copied that way fails the snapshot: it is never
 *              archived as a plain file, which could lose committed rows or mix two moments
 *   integrity  every database copy passes PRAGMA integrity_check (checkSqliteIntegrity, on a thread of its own while
 *              the archive is written and read back), the check `synabun restore-backup` runs
 *   archive    one ZIP (backup-zip-writer.js): databases stored as they are, small files deflated, each entry's
 *              CRC-32 and SHA-256 computed as it is written; the manifest lists every SHA-256 and, in `inputs`,
 *              what each entry was taken from (a database's fingerprint) for checkUpgradeSnapshotFreshness
 *   verified   the finished ZIP is read back once (every entry's CRC-32, size and SHA-256 against the manifest);
 *              it is published, with a rename, only when that and the integrity check have passed
 *
 * The same archive layout and manifest as createVerifiedBackup(), so Settings > restore and `synabun
 * restore-backup` restore it as they restore any backup.
 *
 * onProgress({ phase: 'collect' | 'copy' | 'archive' | 'verify' | 'integrity', ... }): collect says how much (files,
 * bytes, skipped; `files` already leaves out the empty extra databases: skippedEmptyDatabases counts them,
 * skippedEmptyDatabaseFiles them and their sidecars), archive and verify say how far (done, total, in bytes);
 * integrity says that the archive is ready and the integrity check still runs (state 'running'), then that it passed
 * (state 'ok').
 */
export async function createUpgradeSnapshot({
  dataHome,
  databasePath = resolve(dataHome, 'mcp-data', 'memory.db'),
  folderPath,
  kind = 'pre-update',
  appVersion = null,
  dataSchemaVersion = 1,
  sourceFingerprint = null,
  additionalEntries = [],
  freeSpaceReserveBytes = BACKUP_FREE_SPACE_RESERVE_BYTES,
  getAvailableBytes = backupAvailableBytes,
  onProgress = null,
  upgradeSoftLimitBytes = UPGRADE_SNAPSHOT_SOFT_LIMIT_BYTES,
  copyDatabase = copySqliteDatabase,
  checkIntegrity = checkSqliteIntegrity,
  // As for createVerifiedBackup: left out, the snapshot is encrypted when the owner turned encryption on.
  encryption = undefined,
  now = () => new Date(),
} = {}) {
  const report = (detail) => { markActivity(`backup:${detail.phase}`); try { if (typeof onProgress === 'function') onProgress(detail); } catch { /* reporting never stops a snapshot */ } };
  if (!dataHome || !folderPath) throw new Error('dataHome and folderPath are required');
  if (!UPGRADE_BACKUP_KINDS.has(kind)) throw new Error(`An upgrade snapshot is ${[...UPGRADE_BACKUP_KINDS].join(' or ')}, not ${kind}`);
  const started = Date.now();
  // Before anything is written: a key file that cannot be used fails the snapshot here.
  const encrypt = backupEncryptionFor(dataHome, encryption);
  const createdAt = now();
  assertBackupDestinationMounted(folderPath);
  mkdirSync(folderPath, { recursive: true });
  cleanupStaleBackupArtifacts(folderPath);
  const destination = resolve(folderPath, archiveNameFor(kind, createdAt, !!encrypt));
  if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);
  const tempPath = `${destination}.${process.pid}.tmp`;
  const tempInfoPath = `${backupInfoPath(destination)}.${process.pid}.tmp`;
  // Everything this snapshot copies lives here until the archive is published (an abandoned one is swept after an
  // hour). The copies are plaintext: an encrypted snapshot keeps them in the data home's private folder.
  if (encrypt) cleanupStaleBackupArtifacts(privateBackupStagingRoot(dataHome));
  const work = encrypt ? await makePrivateStage(dataHome) : mkdtempSync(resolve(folderPath, `.synabun-files-${process.pid}-`));
  let writer = null;
  const timings = {};
  const mark = (name, since) => { timings[name] = Date.now() - since; };
  // The integrity check of the database copies, once they exist: { results, ms } or { error, ms }, never a rejection.
  let integrity = null;
  let workerTimedOut = false;
  try {
    let since = Date.now();
    const { inputs: kept, excluded, skippedEmpty } = collectUpgradeInputs({ dataHome, additionalEntries, softLimitBytes: upgradeSoftLimitBytes });
    const databaseBytes = existsSync(databasePath) ? statSync(databasePath).size : 0;
    const walBytes = existsSync(`${databasePath}-wal`) ? statSync(`${databasePath}-wal`).size : 0;
    const keptBytes = kept.reduce((sum, file) => sum + backupFileSize(file), 0);
    report({
      phase: 'collect',
      files: kept.length + (databaseBytes ? 1 : 0),
      bytes: keptBytes + databaseBytes,
      skippedFiles: excluded?.files ?? 0,
      skippedBytes: excluded?.bytes ?? 0,
      skippedReason: excluded?.reason ?? null,
      skippedEmptyDatabases: skippedEmpty.databases,
      skippedEmptyDatabaseFiles: skippedEmpty.files,
    });

    // Room for it: the archive holds everything once; a database that cannot be cloned is copied first.
    const cloned = !!cloneMethodFor(databasePath, work);
    const sqliteBytes = kept.filter(file => file.sqlite).reduce((sum, file) => sum + backupFileSize(file), 0);
    const stagedBytes = kept.filter(file => !file.sqlite && !IMMUTABLE_BACKUP_EXTENSIONS.has(extname(file.archivePath).toLowerCase()))
      .reduce((sum, file) => sum + backupFileSize(file), 0);
    const requiredBytes = Math.max(0, Number(freeSpaceReserveBytes) || 0)
      + keptBytes + databaseBytes + walBytes
      + (cloned ? walBytes : databaseBytes + walBytes) + sqliteBytes + stagedBytes;
    const availableBytes = Number(getAvailableBytes(folderPath));
    if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) throw new BackupStorageError({ availableBytes, requiredBytes, folderPath });
    mark('collect', since);

    since = Date.now();
    report({ phase: 'copy', bytes: databaseBytes, method: cloned ? 'clone' : 'copy' });
    const entries = [];
    // What each entry was taken from: checkUpgradeSnapshotFreshness compares the data home with it later.
    const recorded = [];
    const copies = [];
    const database = await copyDatabase(databasePath, resolve(work, 'memory.db'), { primary: true });
    if (database) {
      entries.push({ diskPath: database.path, archivePath: 'database/memory.db', store: true });
      recorded.push({ entry: 'database/memory.db', path: inputPath(dataHome, databasePath), sqlite: database.fingerprint });
      copies.push({ entry: 'database/memory.db', path: database.path });
    }
    for (const [index, file] of kept.entries()) {
      if (file.sqlite) {
        let copied;
        try { copied = await copyDatabase(file.diskPath, resolve(work, `db-${index}.db`)); }
        catch (error) {
          throw Object.assign(new Error(`${file.archivePath} could not be copied as of one commit: ${error?.message || error}`), { cause: error, code: error?.code });
        }
        if (!copied) continue;   // gone since it was listed
        entries.push({ diskPath: copied.path, archivePath: file.archivePath, store: true });
        recorded.push({ entry: file.archivePath, path: inputPath(dataHome, file.diskPath), sqlite: copied.fingerprint });
        copies.push({ entry: file.archivePath, path: copied.path });
        continue;
      }
      const store = INCOMPRESSIBLE_EXTENSIONS.has(extname(file.archivePath).toLowerCase());
      if (IMMUTABLE_BACKUP_EXTENSIONS.has(extname(file.archivePath).toLowerCase())) {
        entries.push({ diskPath: file.diskPath, archivePath: file.archivePath, store });
        recorded.push({ entry: file.archivePath, path: inputPath(dataHome, file.diskPath) });
        continue;
      }
      // A moment's copy, so the bytes archived and the bytes checksummed are the same bytes.
      const staged = resolve(work, `file-${index}`);
      try { copyFileSync(file.diskPath, staged); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (encrypt && process.platform !== 'win32') chmodSync(staged, 0o600);
      entries.push({ diskPath: staged, archivePath: file.archivePath, store });
      recorded.push({ entry: file.archivePath, path: inputPath(dataHome, file.diskPath) });
    }
    entries.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
    recorded.sort((a, b) => a.entry.localeCompare(b.entry));
    mark('copy', since);

    // From now on, beside the archive: SQLite's integrity check of every copy, as the restore runs it.
    const integrityStarted = Date.now();
    let integrityDone = false;
    const checking = checkIntegrity(copies.map(copy => copy.path));
    integrity = Promise.resolve(checking).then(
      (results) => ({ results, ms: Date.now() - integrityStarted }),
      (error) => ({ error, ms: Date.now() - integrityStarted }),
    ).finally(() => { integrityDone = true; });
    integrity.cancel = () => { try { checking?.cancel?.(); } catch {} };

    since = Date.now();
    const total = entries.reduce((sum, entry) => sum + statSync(entry.diskPath).size, 0);
    report({ phase: 'archive', done: 0, total });
    const manifestFor = (written) => {
      const checksums = {};
      for (const item of written) checksums[item.name.slice(BACKUP_PREFIX.length + 1)] = `sha256:${item.sha256}`;
      return JSON.stringify({
        version: BACKUP_MANIFEST_VERSION,
        created: createdAt.toISOString(),
        kind,
        appVersion,
        dataSchemaVersion,
        sourceFingerprint,
        storage: 'sqlite',
        database: database ? {
          file: 'database/memory.db',
          sizeBytes: database.sizeBytes,
          memoryCount: database.memoryCount,
          // The archive is published only once this check has passed on every database copy in it.
          integrity: 'ok',
          copy: database.method,
        } : null,
        files: entries.map(entry => entry.archivePath),
        checksums,
        scope: 'state-only',
        excluded,
        inputs: { version: 1, entries: recorded },
        verified: true,
        verification: { algorithm: 'sha256', publication: 'verify-before-atomic-rename', writer: 'one-pass', integrity: 'integrity_check' },
      }, null, 2);
    };
    // Encrypted: the ZIP goes through the encrypting thread as it is written and never exists in plaintext.
    if (encrypt) writer = createEncryptedBackupWriter(tempPath, encrypt.recipient, { chunkSize: encrypt.chunkSize, now });
    await writeZipArchive(tempPath, [
      ...entries.map(entry => ({ name: `${BACKUP_PREFIX}/${entry.archivePath}`, diskPath: entry.diskPath, store: entry.store })),
      { name: `${BACKUP_PREFIX}/manifest.json`, data: manifestFor },
    ], { now, sink: writer, onProgress: ({ bytes, totalBytes }) => report({ phase: 'archive', done: bytes, total: Math.max(total, totalBytes) }) });
    mark('archive', since);

    since = Date.now();
    let checked = 0;
    let reportedAt = 0;
    report({ phase: 'verify', done: 0, total });
    const publishedManifest = await verifyBackupArchive(tempPath, {
      fileKey: writer ? writer.fileKey : null,
      authKey: writer ? writer.authKey : null,
      onBytes: (bytes) => {
        checked += bytes;
        if (checked - reportedAt >= 64 * 1024 * 1024 || checked >= total) { reportedAt = checked; report({ phase: 'verify', done: checked, total }); }
      },
    });
    mark('verify', since);

    since = Date.now();
    if (!integrityDone) report({ phase: 'integrity', state: 'running' });
    const verdict = await integrity;
    timings.integrity = verdict.ms;
    mark('integrityWait', since);
    if (verdict.error) {
      if (verdict.error.code === 'BACKUP_WORKER_TIMEOUT') throw verdict.error;
      throw Object.assign(new Error(`SQLite's integrity check of the copies could not run: ${verdict.error?.message || verdict.error}`), { code: 'EINTEGRITY' });
    }
    for (const [index, result] of copies.entries()) {
      const found = (verdict.results || []).find(item => item?.path === result.path) || verdict.results?.[index];
      if (!found?.ok) throw new SnapshotIntegrityError(result.entry, found?.lines || []);
    }
    report({ phase: 'integrity', state: 'ok' });
    // The copies are in the archive and checked: their room goes back.
    try { rmSync(work, { recursive: true, force: true }); } catch {}
    if (encrypt && !(await isEncryptedBackupFile(tempPath))) throw new BackupEncryptionError('BACKUP_ENC_NOT_ENCRYPTED', 'The snapshot was not encrypted: it is not published.', { status: 500 });
    // What the next start reads without the password, for a snapshot that stays inside the data home.
    const withInfo = !!encrypt && pathInside(folderPath, dataHome);
    if (withInfo) await writeSnapshotInfo(tempInfoPath, tempPath, publishedManifest, writer.authKey);
    renameSync(tempPath, destination);
    if (withInfo) renameSync(tempInfoPath, backupInfoPath(destination));
    return {
      path: destination,
      name: basename(destination),
      kind,
      createdAt: createdAt.toISOString(),
      sizeBytes: statSync(destination).size,
      manifest: publishedManifest,
      encrypted: !!encrypt,
      stamp: backupFileStamp(destination),
      database: database ? { method: database.method, sizeBytes: database.sizeBytes, memoryCount: database.memoryCount, integrity: 'ok' } : null,
      timings: { ...timings, total: Date.now() - started },
    };
  } catch (error) {
    workerTimedOut = error.code === 'BACKUP_WORKER_TIMEOUT';
    error.workerTermination?.then(async () => {
      await rm(tempPath, { force: true }).catch(() => {});
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }).catch(() => {});
    if (writer) await writer.abort().catch(() => {});
    try { rmSync(tempInfoPath, { force: true }); } catch {}
    if (workerTimedOut) await waitForBackupCleanup(rm(tempPath, { force: true }).catch(() => {}), true);
    else { try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {} }
    throw error;
  } finally {
    if (writer) writer.wipe();
    // Cancel a check still reading the copies before cleanup; a native I/O timeout also retries on exit.
    if (integrity) {
      integrity.cancel();
      await integrity;
    }
    if (workerTimedOut) await waitForBackupCleanup(rm(work, { recursive: true, force: true }).catch(() => {}), true);
    else { try { rmSync(work, { recursive: true, force: true }); } catch {} }
  }
}

function dateFromSnapshotName(name, stat) {
  const match = name.match(/^synabun-[a-z-]+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.zip(?:\.enc)?$/i);
  if (!match) return stat.mtime;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? stat.mtime : value;
}

function kindFromName(name) {
  const match = name.match(/^synabun-(scheduled|pre-update|pre-migration|manual)-/i);
  return match?.[1]?.toLowerCase() || (name === 'synabun-auto-backup.zip' ? 'legacy' : 'unknown');
}

export async function listBackupSnapshots(folderPath) {
  if (!folderPath) return [];
  let names;
  try { names = await readdir(folderPath); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const snapshots = [];
  // Metadata only: never open or inflate an archive. Sequential awaits keep filesystem work bounded.
  for (const name of names) {
    // A backup, plain (.zip) or encrypted (.zip.enc): told by the name here, by its first bytes when it is opened.
    const encrypted = name.endsWith(`.zip${BACKUP_ENC_EXTENSION}`);
    if ((!name.endsWith('.zip') && !encrypted) || !name.startsWith('synabun-')) continue;
    const path = resolve(folderPath, name);
    let info;
    try { info = await stat(path); }
    catch (error) {
      if (error.code === 'ENOENT') continue; // another retention pass/download may have removed it
      throw error;
    }
    const created = dateFromSnapshotName(name, info);
    snapshots.push({
      name, path, kind: kindFromName(name), pinned: name === 'synabun-auto-backup.zip',
      createdAt: created.toISOString(), createdMs: created.getTime(), sizeBytes: info.size, encrypted,
    });
  }
  return snapshots.sort((a, b) => b.createdMs - a.createdMs);
}

function utcDay(dateMs) {
  return new Date(dateMs).toISOString().slice(0, 10);
}

function utcWeek(dateMs) {
  const date = new Date(dateMs);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

export async function applyBackupRetention({
  folderPath,
  retention = DEFAULT_BACKUP_RETENTION,
  incomingBytes = 0,
  now = () => new Date(),
  remove = path => removeBackupFile(path),
} = {}) {
  const policy = { ...DEFAULT_BACKUP_RETENTION, ...(retention || {}) };
  const snapshots = await listBackupSnapshots(folderPath);
  const currentMs = now().getTime();
  const recentCutoff = currentMs - policy.recentHours * 60 * 60 * 1000;
  const dailyCutoff = currentMs - policy.dailyDays * 24 * 60 * 60 * 1000;
  const weeklyCutoff = currentMs - policy.weeklyWeeks * 7 * 24 * 60 * 60 * 1000;
  const keep = new Set(snapshots.filter(item => item.pinned).map(item => item.path));
  const protectedPaths = new Set(keep);
  const scheduled = snapshots.filter(item => item.kind === 'scheduled');
  if (scheduled[0]) {
    keep.add(scheduled[0].path);
    protectedPaths.add(scheduled[0].path);
  }
  const latestPreUpdate = snapshots.find(item => item.kind === 'pre-update');
  if (latestPreUpdate) {
    keep.add(latestPreUpdate.path);
    protectedPaths.add(latestPreUpdate.path);
  }
  for (const item of snapshots.filter(item => ['pre-update', 'pre-migration'].includes(item.kind)).slice(0, Math.max(0, Number(policy.preUpdateKeep) || 0))) keep.add(item.path);

  const daily = new Set();
  const weekly = new Set();
  for (const item of scheduled) {
    if (item.createdMs >= recentCutoff) {
      keep.add(item.path);
    } else if (item.createdMs >= dailyCutoff) {
      const bucket = utcDay(item.createdMs);
      if (!daily.has(bucket)) { daily.add(bucket); keep.add(item.path); }
    } else if (item.createdMs >= weeklyCutoff) {
      const bucket = utcWeek(item.createdMs);
      if (!weekly.has(bucket)) { weekly.add(bucket); keep.add(item.path); }
    }
  }

  const removed = [];
  for (const item of snapshots) {
    if (keep.has(item.path) || item.kind === 'manual' || item.kind === 'unknown') continue;
    await remove(item.path);
    removed.push(item.path);
  }

  let retained = await listBackupSnapshots(folderPath);
  let totalBytes = retained.reduce((sum, item) => sum + item.sizeBytes, 0);
  const normalizedIncomingBytes = Math.max(0, Number(incomingBytes) || 0);
  const targetBytes = Math.max(0, policy.maxBytes - normalizedIncomingBytes);
  if (totalBytes > targetBytes) {
    const removable = [...retained]
      .filter(item => !protectedPaths.has(item.path) && item.kind !== 'manual' && item.kind !== 'unknown')
      .sort((a, b) => a.createdMs - b.createdMs);
    for (const item of removable) {
      if (totalBytes <= targetBytes) break;
      await remove(item.path);
      removed.push(item.path);
      totalBytes -= item.sizeBytes;
    }
    retained = await listBackupSnapshots(folderPath);
  }
  return {
    retention: policy,
    retained,
    removed,
    incomingBytes: normalizedIncomingBytes,
    projectedTotalBytes: retained.reduce((sum, item) => sum + item.sizeBytes, normalizedIncomingBytes),
    totalBytes: retained.reduce((sum, item) => sum + item.sizeBytes, 0),
    capExceeded: retained.reduce((sum, item) => sum + item.sizeBytes, normalizedIncomingBytes) > policy.maxBytes,
  };
}

export function normalizeBackupConfig(value = {}) {
  const config = value && typeof value === 'object' ? value : {};
  const lastVerifiedBackup = config.lastVerifiedBackup
    || (!config.lastBackupError ? config.lastBackup : null)
    || null;
  return {
    version: 2,
    configured: config.configured !== false,
    enabled: config.enabled === true,
    intervalMinutes: Number.isFinite(config.intervalMinutes) && config.intervalMinutes >= 1 ? config.intervalMinutes : 360,
    folderPath: typeof config.folderPath === 'string' ? config.folderPath : '',
    retention: { ...DEFAULT_BACKUP_RETENTION, ...(config.retention || {}) },
    lastAttemptAt: config.lastAttemptAt || config.lastBackup || null,
    lastVerifiedBackup,
    lastBackup: lastVerifiedBackup,
    lastBackupPath: config.lastBackupPath || null,
    lastBackupSize: Number(config.lastBackupSize || 0),
    lastBackupError: config.lastBackupError || null,
    retentionWarning: config.retentionWarning || null,
  };
}

/**
 * When the scheduler fires next. After a failure it waits one interval from
 * the failed attempt, not from the last success; health reads this same
 * function so it cannot advertise a due date weeks in the past.
 */
export function nextBackupDueMs(configValue, { lastAttemptMs = 0, now = () => new Date() } = {}) {
  const config = normalizeBackupConfig(configValue);
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const baseline = config.lastBackupError
    ? new Date(config.lastAttemptAt || 0).getTime()
    : new Date(config.lastVerifiedBackup || 0).getTime();
  const effective = Math.max(Number.isFinite(baseline) ? baseline : 0, Number(lastAttemptMs) || 0);
  return effective > 0 ? effective + intervalMs : now().getTime();
}

export function getBackupHealth(configValue, { now = () => new Date(), snapshots = null } = {}) {
  const config = normalizeBackupConfig(configValue);
  const lastMs = config.lastVerifiedBackup ? new Date(config.lastVerifiedBackup).getTime() : null;
  const nextDueMs = nextBackupDueMs(config, { now });
  let status = 'healthy';
  let reason = null;
  let destinationError = null;
  const missingVolume = config.folderPath ? missingBackupVolume(config.folderPath) : null;
  if (missingVolume) {
    destinationError = new BackupDestinationUnavailableError({ ...missingVolume, folderPath: config.folderPath }).message;
  } else if (config.folderPath) {
    try {
      let probe = resolve(config.folderPath);
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
      if (existsSync(config.folderPath) && !statSync(config.folderPath).isDirectory()) {
        throw new Error('Backup destination is not a directory.');
      }
      accessSync(probe, FS_CONSTANTS.W_OK);
    } catch (error) {
      destinationError = error.message;
    }
  }
  if (!config.configured) { status = 'unconfigured'; reason = 'Backups have not been configured yet.'; }
  else if (!config.enabled) { status = 'disabled'; reason = 'Scheduled backups are disabled.'; }
  else if (!config.folderPath) { status = 'unconfigured'; reason = 'No backup destination is configured.'; }
  else if (destinationError) { status = 'destination-unavailable'; reason = destinationError; }
  else if (config.lastBackupError) { status = 'failed'; reason = config.lastBackupError; }
  else if (config.retentionWarning) { status = 'cap-exceeded'; reason = config.retentionWarning; }
  else if (!lastMs || now().getTime() >= nextDueMs) { status = 'overdue'; reason = 'A scheduled backup is due.'; }
  return {
    status,
    reason,
    nextDueAt: config.enabled && config.folderPath ? new Date(nextDueMs).toISOString() : null,
    latestVerifiedAt: config.lastVerifiedBackup,
    retainedCount: snapshots?.length ?? null,
    totalBytes: snapshots?.reduce((sum, item) => sum + item.sizeBytes, 0) ?? null,
  };
}

export function loadBackupConfig(path) {
  try { return normalizeBackupConfig({ ...JSON.parse(readFileSync(path, 'utf-8')), configured: true }); }
  catch { return normalizeBackupConfig({ configured: false }); }
}

export function saveBackupConfig(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const config = normalizeBackupConfig({ ...value, configured: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    renameSync(temp, path);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch {}
    throw error;
  }
  return config;
}

if (parentPort && workerData?.verifiedBackupTask) {
  const tasks = { collect: collectVerifiedBackupInputs, copy: copyVerifiedDatabases, measure: measureBackupGroups, sweep: cleanupCrashedBackupArtifacts };
  Promise.resolve().then(() => tasks[workerData.verifiedBackupTask](workerData.options)).then(
    result => parentPort.postMessage({ result }),
    error => parentPort.postMessage({ error, code: error.code }),
  );
}

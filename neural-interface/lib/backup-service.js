import {
  accessSync,
  closeSync,
  copyFileSync,
  constants as FS_CONSTANTS,
  createReadStream,
  existsSync,
  lstatSync,
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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path';
import * as nodeSqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import archiver from 'archiver';
import { openZipArchive, readZipEntry, verifyBackupChecksums } from './backup-zip-reader.js';
import { writeZipArchive } from './backup-zip-writer.js';
import { LOCK_FILE_NAME } from './rulesets/lock.js';

export const BACKUP_MANIFEST_VERSION = 3;
export const BACKUP_PREFIX = 'synabun-auto-backup';
export const BACKUP_FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_BACKUP_RETENTION = Object.freeze({
  recentHours: 24,
  dailyDays: 30,
  weeklyWeeks: 12,
  maxBytes: 10 * 1024 * 1024 * 1024,
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

function fileBytes(path) {
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

function archiveNameFor(kind, createdAt) {
  return `synabun-${kind}-${safeTimestamp(createdAt)}.zip`;
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

function createConsistentSqliteSnapshot(sourcePath, snapshotPath) {
  if (!existsSync(sourcePath)) return null;
  try { if (existsSync(snapshotPath)) unlinkSync(snapshotPath); } catch {}
  let source;
  let snapshot;
  try {
    source = new DatabaseSync(sourcePath);
    source.exec('PRAGMA busy_timeout = 10000');
    source.exec(`VACUUM INTO '${escapeSqliteString(snapshotPath)}'`);
    snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    const integrityRow = snapshot.prepare('PRAGMA integrity_check').get();
    const integrity = integrityRow?.integrity_check || integrityRow?.integrity || 'unknown';
    if (integrity !== 'ok') throw new Error(`SQLite snapshot integrity check returned: ${integrity}`);
    let memoryCount = null;
    try { memoryCount = Number(snapshot.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count || 0); } catch {}
    return { path: snapshotPath, integrity, memoryCount, sizeBytes: statSync(snapshotPath).size };
  } finally {
    try { snapshot?.close(); } catch {}
    try { source?.close(); } catch {}
  }
}

// SQLite rollback journals, including the ones left beside migration copies
// (memory.db.pre-v4-….bak-journal). They are only meaningful next to the file
// they belonged to, and that file is snapshotted consistently or not at all.
const SQLITE_JOURNAL_RE = /\.(?:db|bak)-journal$/i;

function shouldSkipDataPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const name = parts.at(-1);
  if (parts[0] === 'updater') return true;
  if (parts[0] === 'logs') return true;
  if (parts.length > 1 && EXCLUDED_DATA_DIRS.has(parts[0])) return true;
  if (TRANSIENT_DATA_NAMES.has(name)) return true;
  if (isLockOnlyDataFile(name)) return true;
  if (name.endsWith('.tmp') || name.endsWith('.pid')) return true;
  if (/\.db-(?:wal|shm)$/i.test(name)) return true;
  if (SQLITE_JOURNAL_RE.test(name)) return true;
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

function collectFiles(root, archiveRoot, { filter = () => true } = {}) {
  const files = [];
  function walk(current) {
    if (!existsSync(current)) return;
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      const rel = relative(root, current).replace(/\\/g, '/');
      if (filter(rel, current)) files.push({ diskPath: current, archivePath: `${archiveRoot}/${rel}` });
      return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try { entries = readdirSync(current).sort(); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) walk(join(current, entry));
  }
  walk(root);
  return files;
}

function backupFileSize(file) {
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

export function assertBackupWorkingSpace({
  folderPath,
  files = [],
  databasePath = null,
  expectedArchiveBytes = 0,
  freeSpaceReserveBytes = BACKUP_FREE_SPACE_RESERVE_BYTES,
  getAvailableBytes = backupAvailableBytes,
} = {}) {
  const primaryDatabaseBytes = databasePath && existsSync(databasePath) ? statSync(databasePath).size : 0;
  const inputBytes = files.reduce((sum, file) => sum + backupFileSize(file), primaryDatabaseBytes);
  const stagedMutableBytes = files
    .filter(isMutableBackupInput)
    .reduce((sum, file) => sum + backupFileSize(file), 0);
  const sqliteSnapshotBytes = files
    .filter(isSqliteBackupInput)
    .reduce((sum, file) => sum + backupFileSize(file), primaryDatabaseBytes);
  const archiveBytes = Math.max(Number(expectedArchiveBytes) || 0, inputBytes);
  const requiredBytes = Math.max(0, Number(freeSpaceReserveBytes) || 0)
    + stagedMutableBytes
    + sqliteSnapshotBytes
    + archiveBytes;
  const availableBytes = Number(getAvailableBytes(folderPath));
  if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
    throw new BackupStorageError({ availableBytes, requiredBytes, folderPath });
  }
  return {
    availableBytes,
    requiredBytes,
    archiveBytes,
    stagedMutableBytes,
    sqliteSnapshotBytes,
  };
}

/**
 * Remove archive temps, SQLite temps, and stage dirs abandoned by an earlier
 * run. A backup interrupted with Ctrl-C never reaches its own catch/finally,
 * so its partial archive is orphaned forever — a killed pre-update snapshot
 * left hundreds of MB behind with nothing to reclaim it.
 */
export function cleanupStaleBackupArtifacts(folderPath, { maxAgeMs = 60 * 60 * 1000, now = Date.now } = {}) {
  if (!existsSync(folderPath)) return [];
  const removed = [];
  let entries;
  try { entries = readdirSync(folderPath); }
  catch { return removed; }
  for (const name of entries) {
    const isArchiveTemp = /\.zip\.\d+\.tmp$/.test(name);
    const isSqliteTemp = /^\.synabun-(?:db|extra-db)-.*\.tmp$/.test(name);
    const isStageDir = /^\.synabun-files-/.test(name);
    if (!isArchiveTemp && !isSqliteTemp && !isStageDir) continue;
    const path = resolve(folderPath, name);
    try {
      if (now() - statSync(path).mtimeMs < maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch { /* another process may be mid-cleanup; leave it */ }
  }
  return removed;
}

function snapshotMutableBackupFiles(files, folderPath) {
  if (!files.some(isMutableBackupInput)) return { files, stageDir: null };
  const stageDir = mkdtempSync(resolve(folderPath, `.synabun-files-${process.pid}-`));
  const snapshots = [];
  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!isMutableBackupInput(file)) {
        snapshots.push(file);
        continue;
      }
      const diskPath = resolve(stageDir, String(index));
      try {
        copyFileSync(file.diskPath, diskPath);
        snapshots.push({ ...file, diskPath });
      } catch (error) {
        // A runtime file deleted between enumeration and snapshotting is no
        // longer part of the state being backed up. Other failures are fatal.
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return { files: snapshots, stageDir };
  } catch (error) {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function normalizeAdditionalEntries(entries = []) {
  const result = [];
  for (const entry of entries) {
    if (!entry?.diskPath || !entry?.archivePath || !existsSync(entry.diskPath)) continue;
    let stat;
    try { stat = lstatSync(entry.diskPath); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) result.push(...collectFiles(entry.diskPath, entry.archivePath));
    else if (stat.isFile()) result.push({ diskPath: entry.diskPath, archivePath: entry.archivePath });
  }
  return result;
}

async function writeArchive({ tempPath, files, manifest, level = 6 }) {
  const { createWriteStream } = await import('node:fs');
  await new Promise((resolveWrite, reject) => {
    const output = createWriteStream(tempPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level } });
    output.on('close', resolveWrite);
    output.on('error', reject);
    archive.on('warning', error => error.code === 'ENOENT' ? null : reject(error));
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of files) {
      const store = INCOMPRESSIBLE_EXTENSIONS.has(extname(file.archivePath).toLowerCase());
      archive.file(file.diskPath, { name: `${BACKUP_PREFIX}/${file.archivePath}`, store });
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: `${BACKUP_PREFIX}/manifest.json` });
    archive.finalize().catch(reject);
  });
}

/**
 * Reopen a finished archive and stream every manifest-listed entry through
 * sha256. Streaming matters: reading the archive into memory failed every
 * backup over 2 GiB, which is when a backup matters most.
 */
export async function verifyBackupArchive(path, { onBytes = null } = {}) {
  const zip = await openZipArchive(path);
  try {
    const manifestEntry = zip.getEntry(`${BACKUP_PREFIX}/manifest.json`);
    if (!manifestEntry) throw new Error('Backup verification failed: manifest is missing');
    const manifest = JSON.parse((await readZipEntry(zip, manifestEntry)).toString('utf-8'));
    await verifyBackupChecksums(zip, { prefix: BACKUP_PREFIX, manifest, onBytes });
    return manifest;
  } finally {
    await zip.close();
  }
}

/** The manifest of a backup archive, read without reading anything else (its central directory and the manifest entry). */
export async function readBackupArchiveManifest(path) {
  const zip = await openZipArchive(path);
  try {
    const manifestEntry = zip.getEntry(`${BACKUP_PREFIX}/manifest.json`);
    if (!manifestEntry) throw new Error('Backup verification failed: manifest is missing');
    return JSON.parse((await readZipEntry(zip, manifestEntry)).toString('utf-8'));
  } finally {
    await zip.close();
  }
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
  onBeforeArchive = null,
  onProgress = null,
  upgradeSoftLimitBytes = UPGRADE_SNAPSHOT_SOFT_LIMIT_BYTES,
  now = () => new Date(),
} = {}) {
  // A large data home spends minutes in checksum/archive with no output. Phase
  // reporting is what stops that from reading as a hang to the caller.
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  if (!dataHome || !folderPath) throw new Error('dataHome and folderPath are required');
  const createdAt = now();
  assertBackupDestinationMounted(folderPath);
  mkdirSync(folderPath, { recursive: true });
  cleanupStaleBackupArtifacts(folderPath);
  const destination = resolve(folderPath, archiveNameFor(kind, createdAt));
  const tempPath = `${destination}.${process.pid}.tmp`;
  const sqliteTemp = resolve(folderPath, `.synabun-db-${process.pid}-${Date.now()}.tmp`);
  const extraSqliteTemps = [];
  if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);

  let sqliteSnapshot = null;
  let stageDir = null;
  try {
    const files = [];
    const envPath = resolve(dataHome, '.env');
    if (existsSync(envPath)) files.push({ diskPath: envPath, archivePath: 'env.bak' });
    // BACKUP_DATA_DIRS is the list other modules read (backupRoots): every folder copied here is on it.
    const dataDirFilters = {
      data: rel => !shouldSkipDataPath(rel),
      'mcp-data': rel => !shouldSkipDataPath(rel)
        && !isDatabaseCopyArtifact(rel)
        && !/^memory\.db(?:-wal|-shm)?$/i.test(rel)
        && !/\.db-(?:wal|shm)$/i.test(rel),
    };
    for (const dir of BACKUP_DATA_DIRS) files.push(...collectFiles(resolve(dataHome, dir), dir, { filter: dataDirFilters[dir] }));
    files.push(...normalizeAdditionalEntries(additionalEntries));

    // De-duplicate before estimating work space so explicit additional entries
    // cannot inflate the preflight or create ambiguous ZIP members.
    const deduped = [...new Map(files.map(file => [
      file.archivePath.replace(/\\/g, '/'),
      file,
    ])).values()];

    // Keep the upgrade path bounded: state is archived, generated media is not.
    const leanSnapshot = UPGRADE_BACKUP_KINDS.has(kind);
    const selection = leanSnapshot
      ? selectUpgradeSnapshotFiles(deduped, { softLimitBytes: upgradeSoftLimitBytes })
      : { files: deduped, excluded: null };
    const sourceFiles = selection.files;
    const excluded = selection.excluded;

    const workingSpace = assertBackupWorkingSpace({
      folderPath,
      files: sourceFiles,
      databasePath,
      expectedArchiveBytes,
      freeSpaceReserveBytes,
      getAvailableBytes,
    });
    report({
      phase: 'collect',
      files: sourceFiles.length,
      bytes: workingSpace.archiveBytes,
      skippedFiles: excluded?.files ?? 0,
      skippedBytes: excluded?.bytes ?? 0,
      skippedReason: excluded?.reason ?? null,
    });

    sqliteSnapshot = createConsistentSqliteSnapshot(databasePath, sqliteTemp);
    files.length = 0;
    files.push(...sourceFiles);
    if (sqliteSnapshot) files.push({ diskPath: sqliteSnapshot.path, archivePath: 'database/memory.db' });

    // UI blob/state databases also use WAL. Snapshot every additional SQLite
    // file rather than pairing an arbitrary main file with a moving WAL.
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!/\.db$/i.test(file.archivePath) || file.archivePath === 'database/memory.db') continue;
      const temp = resolve(folderPath, `.synabun-extra-db-${process.pid}-${Date.now()}-${index}.tmp`);
      const consistent = createConsistentSqliteSnapshot(file.diskPath, temp);
      if (!consistent) continue;
      extraSqliteTemps.push(temp);
      files[index] = { ...file, diskPath: temp };
    }

    // De-duplicate archive paths so explicit additional entries cannot create
    // ambiguous ZIP members.
    const unique = new Map(files.map(file => [file.archivePath.replace(/\\/g, '/'), file]));
    const stableInputs = snapshotMutableBackupFiles([...unique.values()], folderPath);
    stageDir = stableInputs.stageDir;
    const finalFiles = stableInputs.files.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
    report({ phase: 'checksum', files: finalFiles.length });
    const checksums = {};
    for (const file of finalFiles) checksums[file.archivePath] = `sha256:${await hashFile(file.diskPath)}`;

    const manifest = {
      version: BACKUP_MANIFEST_VERSION,
      created: createdAt.toISOString(),
      kind,
      appVersion,
      dataSchemaVersion,
      sourceFingerprint,
      storage: 'sqlite',
      database: sqliteSnapshot ? {
        file: 'database/memory.db',
        sizeBytes: sqliteSnapshot.sizeBytes,
        memoryCount: sqliteSnapshot.memoryCount,
        integrity: sqliteSnapshot.integrity,
      } : null,
      files: finalFiles.map(file => file.archivePath),
      checksums,
      // A lean snapshot is not a whole-data-home backup. Recording that here
      // keeps a restore from silently presenting it as one.
      scope: leanSnapshot ? 'state-only' : 'complete',
      excluded,
      verified: true,
      verification: { algorithm: 'sha256', publication: 'verify-before-atomic-rename' },
    };
    if (typeof onBeforeArchive === 'function') await onBeforeArchive({ files: finalFiles, manifest });
    report({ phase: 'archive', files: finalFiles.length, bytes: workingSpace.archiveBytes });
    // Level 1 on the blocking upgrade path: the remaining payload is mostly
    // SQLite and JSON, where fast deflate still shrinks well.
    await writeArchive({ tempPath, files: finalFiles, manifest, level: leanSnapshot ? 1 : 6 });
    report({ phase: 'verify', files: finalFiles.length });
    const publishedManifest = await verifyBackupArchive(tempPath);
    renameSync(tempPath, destination);
    return {
      path: destination,
      name: basename(destination),
      kind,
      createdAt: createdAt.toISOString(),
      sizeBytes: statSync(destination).size,
      manifest: publishedManifest,
    };
  } catch (error) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
    throw error;
  } finally {
    try { if (existsSync(sqliteTemp)) unlinkSync(sqliteTemp); } catch {}
    for (const path of extraSqliteTemps) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
    }
    if (stageDir) {
      try { rmSync(stageDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ── The pre-update snapshot: quick at any size ──
//
// createVerifiedBackup() is the full backup (scheduled, manual, the npm updater's): VACUUM INTO, an integrity
// check, deflate, and a re-read through inflate. On a 3.9 GB memory.db that is 81 s on an Apple M-series SSD,
// and the pre-update snapshot is taken while SynaBun restarts into a new version, with the user waiting.
// createUpgradeSnapshot() keeps what that snapshot promises (the state as of one commit, every byte in a ZIP the
// restore paths read, every database copy passing the integrity check the restore runs, read back once and checked
// before it is published) and drops what made it slow: VACUUM INTO, deflating the database and inflating it again.
// The integrity check runs on a thread of its own while the archive is written (about 28 s for that 3.9 GB file).
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
  if (method === 'clone') execFileSync('/bin/cp', ['-c', source, target], { stdio: 'ignore', timeout: 60_000 });
  else copyFileSync(source, target, FS_CONSTANTS.COPYFILE_FICLONE_FORCE);
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

/** SHA-256 (hex) of a file, read in one pass on this thread (WAL files: small, and read while a lock is held). */
function hashFileNow(path) {
  const digest = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      digest.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
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
    if (walSize > 0) wal = { size: walSize, sha256: hashFileNow(walPath) };
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
 *   vacuum   a Node without the backup API (before 22.16): VACUUM INTO, as the full backups do.
 *
 * First the WAL is emptied when nothing holds an older snapshot (a TRUNCATE checkpoint, waiting a second at most),
 * so the source's fingerprint (sqliteFingerprint) survives the close of its last connection; it is taken under the
 * write lock for a clone, right before the copy otherwise (a commit in between makes a later check find it written:
 * never the other way round). The copy is then opened read-only once: its header must account for its whole size,
 * and the memories of the `primary` database are counted (a query that fails there fails the copy). Resolves
 * { method, path, sizeBytes, memoryCount, pageCount, fingerprint }, or null when there is no database.
 */
export async function copySqliteDatabase(sourcePath, targetPath, {
  platform = process.platform, method: forced = null, busyTimeoutMs = 15_000, clone = cloneFileNow, primary = false,
} = {}) {
  if (!existsSync(sourcePath)) return null;
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${targetPath}${suffix}`, { force: true });
  const fallback = typeof nodeSqlite.backup === 'function' ? 'backup' : 'vacuum';
  let method = forced || cloneMethodFor(sourcePath, dirname(targetPath), { platform }) || fallback;
  let fingerprint = null;
  const source = new DatabaseSync(sourcePath);
  try {
    // Readers that hold an older snapshot keep the WAL as it is: the copy is right either way.
    try {
      source.exec('PRAGMA busy_timeout = 1000');
      source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch { /* busy or not a WAL database */ }
    source.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    if (method === 'clone' || method === 'reflink') {
      let locked = false;
      let cloned = false;
      try {
        source.exec('BEGIN IMMEDIATE');
        locked = true;
        fingerprint = sqliteFingerprint(sourcePath);
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
      fingerprint = sqliteFingerprint(sourcePath);
      // One step holds one read transaction for the whole copy: no restart, whatever the server writes.
      await nodeSqlite.backup(source, targetPath, { rate: 1_000_000_000 });
    } else if (method === 'vacuum') {
      fingerprint = sqliteFingerprint(sourcePath);
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

/**
 * SQLite's PRAGMA integrity_check, the one `synabun restore-backup` runs, on each file in `paths`, on a thread of
 * its own (sqlite-integrity-worker.js): a 3.9 GB memory.db takes about 28 s, spent while the archive is written.
 * Resolves [{ path, ok, lines, ms }] (`lines`: SQLite's first findings when a file is not ok); `cancel()` on the
 * promise stops the thread (it then rejects).
 */
export function checkSqliteIntegrity(paths, { spawnWorker = (workerData) => new Worker(new URL('./sqlite-integrity-worker.js', import.meta.url), { workerData }) } = {}) {
  if (!paths.length) return Object.assign(Promise.resolve([]), { cancel: () => {} });
  let worker = null;
  const checking = new Promise((resolveCheck, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    try { worker = spawnWorker({ paths }); }
    catch (error) { reject(error); return; }
    worker.once('message', (results) => settle(resolveCheck, results));
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => settle(reject, new Error(`the integrity check ended (exit ${code}) without a result`)));
  });
  checking.cancel = () => { try { worker?.terminate(); } catch { /* already gone */ } };
  return checking;
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
// the full backups keep everything.
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
  const files = [];
  const envPath = resolve(dataHome, '.env');
  if (existsSync(envPath)) files.push({ diskPath: envPath, archivePath: 'env.bak' });
  const dataDirFilters = {
    data: rel => !shouldSkipDataPath(rel) && !isUpgradeRuntimeFile('data', rel),
    'mcp-data': rel => !shouldSkipDataPath(rel)
      && !isUpgradeRuntimeFile('mcp-data', rel)
      && !isDatabaseCopyArtifact(rel)
      && !/^memory\.db(?:-wal|-shm|-journal)?$/i.test(rel),
  };
  for (const dir of BACKUP_DATA_DIRS) files.push(...collectFiles(resolve(dataHome, dir), dir, { filter: dataDirFilters[dir] }));
  files.push(...normalizeAdditionalEntries(additionalEntries));
  const deduped = [...new Map(files.map(file => [file.archivePath.replace(/\\/g, '/'), file])).values()];
  const { files: kept, excluded } = selectUpgradeSnapshotFiles(deduped, { softLimitBytes });
  const marked = kept.map(file => ({ ...file, sqlite: isSqliteDatabaseFile(file.diskPath) }));
  const databases = new Set(marked.filter(file => file.sqlite).map(file => file.archivePath.toLowerCase()));
  const sideFile = (archivePath) => {
    const lower = archivePath.toLowerCase();
    return SQLITE_SIDE_FILES.some(suffix => suffix && lower.endsWith(suffix) && databases.has(lower.slice(0, -suffix.length)));
  };
  return { inputs: marked.filter(file => !sideFile(file.archivePath)), excluded };
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
      if (actual !== manifest.checksums?.[entry] && differs(entry, path, 'changed')) break scan;
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
 * bytes, skipped), archive and verify say how far (done, total, in bytes); integrity says that the archive is ready
 * and the integrity check still runs (state 'running'), then that it passed (state 'ok').
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
  now = () => new Date(),
} = {}) {
  const report = (detail) => { try { if (typeof onProgress === 'function') onProgress(detail); } catch { /* reporting never stops a snapshot */ } };
  if (!dataHome || !folderPath) throw new Error('dataHome and folderPath are required');
  if (!UPGRADE_BACKUP_KINDS.has(kind)) throw new Error(`An upgrade snapshot is ${[...UPGRADE_BACKUP_KINDS].join(' or ')}, not ${kind}`);
  const started = Date.now();
  const createdAt = now();
  assertBackupDestinationMounted(folderPath);
  mkdirSync(folderPath, { recursive: true });
  cleanupStaleBackupArtifacts(folderPath);
  const destination = resolve(folderPath, archiveNameFor(kind, createdAt));
  if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);
  const tempPath = `${destination}.${process.pid}.tmp`;
  // Everything this snapshot copies lives here until the archive is published (an abandoned one is swept after an hour).
  const work = mkdtempSync(resolve(folderPath, `.synabun-files-${process.pid}-`));
  const timings = {};
  const mark = (name, since) => { timings[name] = Date.now() - since; };
  // The integrity check of the database copies, once they exist: { results, ms } or { error, ms }, never a rejection.
  let integrity = null;
  try {
    let since = Date.now();
    const { inputs: kept, excluded } = collectUpgradeInputs({ dataHome, additionalEntries, softLimitBytes: upgradeSoftLimitBytes });
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
    await writeZipArchive(tempPath, [
      ...entries.map(entry => ({ name: `${BACKUP_PREFIX}/${entry.archivePath}`, diskPath: entry.diskPath, store: entry.store })),
      { name: `${BACKUP_PREFIX}/manifest.json`, data: manifestFor },
    ], { now, onProgress: ({ bytes, totalBytes }) => report({ phase: 'archive', done: bytes, total: Math.max(total, totalBytes) }) });
    mark('archive', since);

    since = Date.now();
    let checked = 0;
    let reportedAt = 0;
    report({ phase: 'verify', done: 0, total });
    const publishedManifest = await verifyBackupArchive(tempPath, {
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
      throw Object.assign(new Error(`SQLite's integrity check of the copies could not run: ${verdict.error?.message || verdict.error}`), { code: 'EINTEGRITY' });
    }
    for (const [index, result] of copies.entries()) {
      const found = (verdict.results || []).find(item => item?.path === result.path) || verdict.results?.[index];
      if (!found?.ok) throw new SnapshotIntegrityError(result.entry, found?.lines || []);
    }
    report({ phase: 'integrity', state: 'ok' });
    // The copies are in the archive and checked: their room goes back.
    try { rmSync(work, { recursive: true, force: true }); } catch {}
    renameSync(tempPath, destination);
    return {
      path: destination,
      name: basename(destination),
      kind,
      createdAt: createdAt.toISOString(),
      sizeBytes: statSync(destination).size,
      manifest: publishedManifest,
      stamp: backupFileStamp(destination),
      database: database ? { method: database.method, sizeBytes: database.sizeBytes, memoryCount: database.memoryCount, integrity: 'ok' } : null,
      timings: { ...timings, total: Date.now() - started },
    };
  } catch (error) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
    throw error;
  } finally {
    // A check still running reads the copies: it ends first (its thread is stopped), then they go.
    if (integrity) {
      integrity.cancel();
      await integrity;
    }
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

function dateFromSnapshotName(name, stat) {
  const match = name.match(/^synabun-[a-z-]+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.zip$/i);
  if (!match) return stat.mtime;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? stat.mtime : value;
}

function kindFromName(name) {
  const match = name.match(/^synabun-(scheduled|pre-update|pre-migration|manual)-/i);
  return match?.[1]?.toLowerCase() || (name === 'synabun-auto-backup.zip' ? 'legacy' : 'unknown');
}

export function listBackupSnapshots(folderPath) {
  if (!folderPath || !existsSync(folderPath)) return [];
  return readdirSync(folderPath)
    .filter(name => name.endsWith('.zip') && (name.startsWith('synabun-') || name === 'synabun-auto-backup.zip'))
    .map(name => {
      const path = resolve(folderPath, name);
      const stat = statSync(path);
      const created = dateFromSnapshotName(name, stat);
      return {
        name,
        path,
        kind: kindFromName(name),
        pinned: name === 'synabun-auto-backup.zip',
        createdAt: created.toISOString(),
        createdMs: created.getTime(),
        sizeBytes: stat.size,
      };
    })
    .sort((a, b) => b.createdMs - a.createdMs);
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

export function applyBackupRetention({
  folderPath,
  retention = DEFAULT_BACKUP_RETENTION,
  incomingBytes = 0,
  now = () => new Date(),
  remove = path => unlinkSync(path),
} = {}) {
  const policy = { ...DEFAULT_BACKUP_RETENTION, ...(retention || {}) };
  const snapshots = listBackupSnapshots(folderPath);
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
  for (const item of snapshots.filter(item => ['pre-update', 'pre-migration'].includes(item.kind)).slice(0, 5)) keep.add(item.path);

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
    remove(item.path);
    removed.push(item.path);
  }

  let retained = listBackupSnapshots(folderPath);
  let totalBytes = retained.reduce((sum, item) => sum + item.sizeBytes, 0);
  const normalizedIncomingBytes = Math.max(0, Number(incomingBytes) || 0);
  const targetBytes = Math.max(0, policy.maxBytes - normalizedIncomingBytes);
  if (totalBytes > targetBytes) {
    const removable = [...retained]
      .filter(item => !protectedPaths.has(item.path) && item.kind !== 'manual' && item.kind !== 'unknown')
      .sort((a, b) => a.createdMs - b.createdMs);
    for (const item of removable) {
      if (totalBytes <= targetBytes) break;
      remove(item.path);
      removed.push(item.path);
      totalBytes -= item.sizeBytes;
    }
    retained = listBackupSnapshots(folderPath);
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

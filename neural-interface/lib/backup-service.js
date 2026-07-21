import {
  accessSync,
  constants as FS_CONSTANTS,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import archiver from 'archiver';
import AdmZip from 'adm-zip';

export const BACKUP_MANIFEST_VERSION = 3;
export const BACKUP_PREFIX = 'synabun-auto-backup';
export const DEFAULT_BACKUP_RETENTION = Object.freeze({
  recentHours: 24,
  dailyDays: 30,
  weeklyWeeks: 12,
  maxBytes: 10 * 1024 * 1024 * 1024,
});

const TRANSIENT_DATA_NAMES = new Set([
  'server-stdout.log',
  'server-stderr.log',
  'restart-requested',
  'opencode-managed.pid',
]);

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function archiveNameFor(kind, createdAt) {
  return `synabun-${kind}-${safeTimestamp(createdAt)}.zip`;
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
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

function shouldSkipDataPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const name = parts.at(-1);
  if (parts[0] === 'updater') return true;
  if (TRANSIENT_DATA_NAMES.has(name)) return true;
  if (name.endsWith('.tmp') || name.endsWith('.pid')) return true;
  if (/\.db-(?:wal|shm)$/i.test(name)) return true;
  return false;
}

function collectFiles(root, archiveRoot, { filter = () => true } = {}) {
  const files = [];
  function walk(current) {
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      const rel = relative(root, current).replace(/\\/g, '/');
      if (filter(rel, current)) files.push({ diskPath: current, archivePath: `${archiveRoot}/${rel}` });
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(current).sort()) walk(join(current, entry));
  }
  walk(root);
  return files;
}

function normalizeAdditionalEntries(entries = []) {
  const result = [];
  for (const entry of entries) {
    if (!entry?.diskPath || !entry?.archivePath || !existsSync(entry.diskPath)) continue;
    const stat = lstatSync(entry.diskPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) result.push(...collectFiles(entry.diskPath, entry.archivePath));
    else if (stat.isFile()) result.push({ diskPath: entry.diskPath, archivePath: entry.archivePath });
  }
  return result;
}

async function writeArchive({ tempPath, files, manifest }) {
  const { createWriteStream } = await import('node:fs');
  await new Promise((resolveWrite, reject) => {
    const output = createWriteStream(tempPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolveWrite);
    output.on('error', reject);
    archive.on('warning', error => error.code === 'ENOENT' ? null : reject(error));
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of files) archive.file(file.diskPath, { name: `${BACKUP_PREFIX}/${file.archivePath}` });
    archive.append(JSON.stringify(manifest, null, 2), { name: `${BACKUP_PREFIX}/manifest.json` });
    archive.finalize().catch(reject);
  });
}

export function verifyBackupArchive(path) {
  const zip = new AdmZip(path);
  const manifestEntry = zip.getEntry(`${BACKUP_PREFIX}/manifest.json`);
  if (!manifestEntry) throw new Error('Backup verification failed: manifest is missing');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
  for (const [archivePath, expected] of Object.entries(manifest.checksums || {})) {
    const entry = zip.getEntry(`${BACKUP_PREFIX}/${archivePath}`);
    if (!entry) throw new Error(`Backup verification failed: ${archivePath} is missing`);
    const actual = `sha256:${hashBuffer(entry.getData())}`;
    if (actual !== expected) throw new Error(`Backup verification failed: checksum mismatch for ${archivePath}`);
  }
  return manifest;
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
  now = () => new Date(),
} = {}) {
  if (!dataHome || !folderPath) throw new Error('dataHome and folderPath are required');
  const createdAt = now();
  mkdirSync(folderPath, { recursive: true });
  const destination = resolve(folderPath, archiveNameFor(kind, createdAt));
  const tempPath = `${destination}.${process.pid}.tmp`;
  const sqliteTemp = resolve(folderPath, `.synabun-db-${process.pid}-${Date.now()}.tmp`);
  const extraSqliteTemps = [];
  if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);

  let sqliteSnapshot = null;
  try {
    sqliteSnapshot = createConsistentSqliteSnapshot(databasePath, sqliteTemp);
    const files = [];
    const envPath = resolve(dataHome, '.env');
    if (existsSync(envPath)) files.push({ diskPath: envPath, archivePath: 'env.bak' });
    files.push(...collectFiles(resolve(dataHome, 'data'), 'data', { filter: rel => !shouldSkipDataPath(rel) }));
    files.push(...collectFiles(resolve(dataHome, 'mcp-data'), 'mcp-data', {
      filter: rel => !/^memory\.db(?:-wal|-shm)?$/i.test(rel) && !/\.db-(?:wal|shm)$/i.test(rel),
    }));
    files.push(...normalizeAdditionalEntries(additionalEntries));
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
    const finalFiles = [...unique.values()].sort((a, b) => a.archivePath.localeCompare(b.archivePath));
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
      verified: true,
      verification: { algorithm: 'sha256', publication: 'verify-before-atomic-rename' },
    };
    await writeArchive({ tempPath, files: finalFiles, manifest });
    const publishedManifest = verifyBackupArchive(tempPath);
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
  if (totalBytes > policy.maxBytes) {
    const removable = [...retained]
      .filter(item => !protectedPaths.has(item.path) && item.kind !== 'manual' && item.kind !== 'unknown')
      .sort((a, b) => a.createdMs - b.createdMs);
    for (const item of removable) {
      if (totalBytes <= policy.maxBytes) break;
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
    totalBytes: retained.reduce((sum, item) => sum + item.sizeBytes, 0),
    capExceeded: retained.reduce((sum, item) => sum + item.sizeBytes, 0) > policy.maxBytes,
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

export function getBackupHealth(configValue, { now = () => new Date(), snapshots = null } = {}) {
  const config = normalizeBackupConfig(configValue);
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const lastMs = config.lastVerifiedBackup ? new Date(config.lastVerifiedBackup).getTime() : null;
  const nextDueMs = Number.isFinite(lastMs) ? lastMs + intervalMs : now().getTime();
  let status = 'healthy';
  let reason = null;
  let destinationError = null;
  if (config.folderPath) {
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
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  renameSync(temp, path);
  return config;
}

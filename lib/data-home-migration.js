/**
 * Safe migration of mutable SynaBun state out of a code checkout.
 *
 * Migrations are staged beside the destination, verified by SHA-256, and then
 * activated with a rename. The source is never deleted automatically.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DATA_HOME_MIGRATION_MARKER = '.synabun-data-home-migration.json';
export const DATA_HOME_MANIFEST = '.synabun-data-home.json';
export const DATA_HOME_MIGRATION_ITEMS = ['.env', 'data', 'mcp-data'];

// These files are created opportunistically by clients before the main app has
// completed its first-launch migration. They do not contain durable user data
// and must not turn an otherwise empty destination into a divergent data root.
const MIGRATION_RUNTIME_ONLY_FILES = new Set([
  'data/active-profile.json',
  'mcp-data/active-profile.json',
  'mcp-data/tool-usage.json',
]);

function normalize(path) {
  return path.replace(/\\/g, '/');
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isRuntimeOnlyMigrationFile(relativePath) {
  const normalized = normalize(relativePath);
  const name = normalized.split('/').at(-1);
  return name === '.DS_Store'
    || MIGRATION_RUNTIME_ONLY_FILES.has(normalized)
    || /(?:^|\/)server-(?:stdout|stderr)\.log(?:\.1)?$/i.test(normalized)
    || /(?:^|\/)(?:restart-requested|opencode-managed\.pid)$/i.test(normalized);
}

function walkFiles(root, current = root, files = [], skipped = []) {
  if (!existsSync(current)) return { files, skipped };
  const stat = lstatSync(current);
  const rel = normalize(relative(root, current));
  if (stat.isSymbolicLink()) {
    skipped.push(rel || basename(current));
    return { files, skipped };
  }
  if (stat.isFile()) {
    files.push({ absolute: current, relative: rel });
    return { files, skipped };
  }
  if (!stat.isDirectory()) return { files, skipped };
  for (const entry of readdirSync(current).sort()) {
    walkFiles(root, join(current, entry), files, skipped);
  }
  return { files, skipped };
}

function listMigrationFiles(root, items = DATA_HOME_MIGRATION_ITEMS) {
  const files = [];
  const skipped = [];
  for (const item of items) {
    const itemPath = resolve(root, item);
    if (!existsSync(itemPath)) continue;
    const stat = lstatSync(itemPath);
    if (stat.isSymbolicLink()) {
      skipped.push(item);
      continue;
    }
    if (stat.isFile()) {
      if (!isRuntimeOnlyMigrationFile(item)) files.push({ absolute: itemPath, relative: item });
      continue;
    }
    const walked = walkFiles(itemPath);
    files.push(...walked.files
      .map(file => ({
        absolute: file.absolute,
        relative: normalize(join(item, file.relative)),
      }))
      .filter(file => !isRuntimeOnlyMigrationFile(file.relative)));
    skipped.push(...walked.skipped.map(path => normalize(join(item, path))));
  }
  return { files, skipped };
}

function listingFingerprint(listing) {
  const digest = createHash('sha256');
  for (const file of [...listing.files].sort((a, b) => a.relative.localeCompare(b.relative))) {
    digest.update(file.relative).update('\0').update(hashFile(file.absolute)).update('\n');
  }
  return `sha256:${digest.digest('hex')}`;
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}

function countLoopState(dataDir) {
  const totals = { schedules: 0, templates: 0, groups: 0 };
  if (!existsSync(dataDir)) return totals;
  for (const name of readdirSync(dataDir)) {
    const path = resolve(dataDir, name);
    if (/^loop-schedules(?:-[^.]+)?\.json$/i.test(name)) {
      const value = readJson(path);
      if (Array.isArray(value)) totals.schedules += value.length;
      else if (value && typeof value === 'object') {
        if (Array.isArray(value.schedules)) totals.schedules += value.schedules.length;
        if (Array.isArray(value.groups)) totals.groups += value.groups.length;
      }
    } else if (/^loop-templates(?:-[^.]+)?\.json$/i.test(name)) {
      const value = readJson(path);
      if (Array.isArray(value)) totals.templates += value.length;
      else if (Array.isArray(value?.templates)) totals.templates += value.templates.length;
    }
  }
  return totals;
}

function inspectMemoryDatabase(path) {
  if (!existsSync(path)) return { exists: false, integrity: 'missing', memoryCount: 0 };
  const result = {
    exists: true,
    sizeBytes: statSync(path).size,
    modifiedAt: statSync(path).mtime.toISOString(),
    integrity: 'unknown',
    memoryCount: null,
  };
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    result.integrity = integrityRow?.integrity_check || integrityRow?.integrity || 'unknown';
    try { result.memoryCount = Number(db.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count || 0); } catch {}
  } catch (error) {
    result.integrity = 'error';
    result.error = error.message;
  } finally {
    try { db?.close(); } catch {}
  }
  return result;
}

/**
 * Read-only summary used by first-launch conflict reports and `synabun doctor`.
 */
export function inspectDataHome(root, items = DATA_HOME_MIGRATION_ITEMS) {
  const resolvedRoot = resolve(root);
  const listing = listMigrationFiles(resolvedRoot, items);
  let latestModifiedAt = null;
  for (const file of listing.files) {
    try {
      const mtime = statSync(file.absolute).mtime;
      if (!latestModifiedAt || mtime > latestModifiedAt) latestModifiedAt = mtime;
    } catch {}
  }
  const dataDir = resolve(resolvedRoot, 'data');
  const backupConfig = readJson(resolve(dataDir, 'auto-backup-config.json'));
  const backupLastSuccess = backupConfig?.lastVerifiedBackup
    || (!backupConfig?.lastBackupError ? backupConfig?.lastBackup : null)
    || null;
  const backupIntervalMs = Number(backupConfig?.intervalMinutes || 360) * 60 * 1000;
  let backupStatus = 'unconfigured';
  if (backupConfig) {
    if (backupConfig.enabled !== true) backupStatus = 'disabled';
    else if (!backupConfig.folderPath) backupStatus = 'unconfigured';
    else if (backupConfig.lastBackupError) backupStatus = 'failed';
    else if (!backupLastSuccess || Date.now() >= new Date(backupLastSuccess).getTime() + backupIntervalMs) backupStatus = 'overdue';
    else backupStatus = 'healthy';
  }
  const uiStatePath = resolve(dataDir, 'ui-state.json');
  return {
    root: resolvedRoot,
    hasState: dataHomeHasState(resolvedRoot),
    fileCount: listing.files.length,
    fingerprint: listingFingerprint(listing),
    latestModifiedAt: latestModifiedAt?.toISOString() || null,
    ...countLoopState(dataDir),
    uiState: existsSync(uiStatePath) ? {
      exists: true,
      sizeBytes: statSync(uiStatePath).size,
      modifiedAt: statSync(uiStatePath).mtime.toISOString(),
    } : { exists: false },
    memory: inspectMemoryDatabase(resolve(resolvedRoot, 'mcp-data', 'memory.db')),
    backup: backupConfig ? {
      configured: true,
      enabled: backupConfig.enabled === true,
      folderPath: backupConfig.folderPath || '',
      status: backupStatus,
      lastBackup: backupLastSuccess,
      lastBackupError: backupConfig.lastBackupError || null,
    } : { configured: false, enabled: false, status: backupStatus },
    skippedSymlinks: listing.skipped,
  };
}

export function dataHomeHasState(root) {
  if (!existsSync(root)) return false;
  return listMigrationFiles(resolve(root)).files.length > 0;
}

export function planDataHomeMigration({
  sourceRoot,
  targetRoot,
  items = DATA_HOME_MIGRATION_ITEMS,
} = {}) {
  if (!sourceRoot || !targetRoot) throw new Error('sourceRoot and targetRoot are required');
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  if (source === target) throw new Error('Source and destination data homes are the same');

  const sourceListing = listMigrationFiles(source, items);
  const targetListing = listMigrationFiles(target, items);
  const sourceByRelative = new Map(sourceListing.files.map(file => [file.relative, file.absolute]));
  const targetByRelative = new Map(targetListing.files.map(file => [file.relative, file.absolute]));
  const files = sourceListing.files.map(file => {
    const targetPath = targetByRelative.get(file.relative);
    if (!targetPath) return { relative: file.relative, status: 'new' };
    return {
      relative: file.relative,
      status: hashFile(file.absolute) === hashFile(targetPath) ? 'same' : 'conflict',
    };
  });
  const targetOnlyFiles = targetListing.files
    .filter(file => !sourceByRelative.has(file.relative))
    .map(file => file.relative);
  const sourceFingerprint = listingFingerprint(sourceListing);
  const targetFingerprint = listingFingerprint(targetListing);

  return {
    sourceRoot: source,
    targetRoot: target,
    sourceHasState: dataHomeHasState(source),
    targetHasState: dataHomeHasState(target),
    files,
    newFiles: files.filter(file => file.status === 'new').length,
    sameFiles: files.filter(file => file.status === 'same').length,
    conflicts: files.filter(file => file.status === 'conflict').map(file => file.relative),
    targetOnlyFiles,
    sourceFingerprint,
    targetFingerprint,
    identical: sourceListing.files.length === targetListing.files.length
      && sourceFingerprint === targetFingerprint,
    skippedSymlinks: sourceListing.skipped,
    sourceSummary: inspectDataHome(source, items),
    targetSummary: inspectDataHome(target, items),
  };
}

function copyMigrationItems(source, target, items) {
  for (const item of items) {
    const from = resolve(source, item);
    if (!existsSync(from)) continue;
    const to = resolve(target, item);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, force: true, dereference: false });
  }
}

function verifyCopiedFiles(source, target, items) {
  const sourceListing = listMigrationFiles(source, items);
  const digest = createHash('sha256');
  for (const file of sourceListing.files) {
    const targetPath = resolve(target, file.relative);
    if (!existsSync(targetPath)) throw new Error(`Migration verification failed: missing ${file.relative}`);
    const sourceHash = hashFile(file.absolute);
    const targetHash = hashFile(targetPath);
    if (sourceHash !== targetHash) throw new Error(`Migration verification failed: checksum mismatch for ${file.relative}`);
    digest.update(file.relative).update('\0').update(targetHash).update('\n');
  }
  return { fileCount: sourceListing.files.length, digest: digest.digest('hex') };
}

/**
 * Rewrite path-valued settings after a verified copy. The source checksum in
 * the migration marker still proves what was copied; normalizedEnvKeys records
 * the deliberate destination-specific changes made before activation.
 */
function normalizeDataHomeEnv(stageRoot, targetRoot) {
  const envPath = resolve(stageRoot, '.env');
  if (!existsSync(envPath)) return [];

  const required = new Map([
    ['SYNABUN_DATA_HOME', resolve(targetRoot)],
    ['MEMORY_DATA_DIR', resolve(targetRoot, 'mcp-data')],
  ]);
  const updateIfPresent = new Map([
    ['SQLITE_DB_PATH', resolve(targetRoot, 'mcp-data', 'memory.db')],
    ['DOTENV_PATH', resolve(targetRoot, '.env')],
  ]);
  const replacements = new Map([...required, ...updateIfPresent]);
  const seen = new Set();
  const normalized = new Set();
  const lines = readFileSync(envPath, 'utf-8').split(/\r?\n/).map(line => {
    const match = line.match(/^(\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*)(.*)$/);
    if (!match || !replacements.has(match[2])) return line;
    const key = match[2];
    seen.add(key);
    normalized.add(key);
    return `${match[1]}${replacements.get(key)}`;
  });

  for (const [key, value] of required) {
    if (seen.has(key)) continue;
    lines.push(`${key}=${value}`);
    normalized.add(key);
  }

  while (lines.length > 1 && lines.at(-1) === '' && lines.at(-2) === '') lines.pop();
  writeFileSync(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
  return [...normalized].sort();
}

function writeDataHomeManifest(root, details, now = () => new Date()) {
  const existing = readJson(resolve(root, DATA_HOME_MANIFEST), {});
  const manifest = {
    version: 1,
    installationId: existing.installationId || cryptoRandomId(),
    dataSchemaVersion: 1,
    activatedAt: now().toISOString(),
    ...details,
  };
  writeFileSync(resolve(root, DATA_HOME_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}

export function acknowledgeLegacyDataRoot({ targetRoot, sourceRoot, reason = 'identical-legacy-root', now = () => new Date() } = {}) {
  if (!targetRoot || !sourceRoot) throw new Error('targetRoot and sourceRoot are required');
  const target = resolve(targetRoot);
  const source = resolve(sourceRoot);
  const existing = readJson(resolve(target, DATA_HOME_MANIFEST), {});
  const acknowledgedLegacyRoots = [...new Set([
    ...(Array.isArray(existing.acknowledgedLegacyRoots) ? existing.acknowledgedLegacyRoots : []),
    source,
  ].map(value => resolve(value)))];
  return writeDataHomeManifest(target, {
    ...existing,
    acknowledgedLegacyRoots,
    lastAcknowledgedLegacyRoot: source,
    activationReason: existing.activationReason || reason,
  }, now);
}

function cryptoRandomId() {
  return createHash('sha256')
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 32);
}

function snapshotResolutionRoots(sourceRoot, targetRoot, now = () => new Date()) {
  const timestamp = now().toISOString().replace(/[:.]/g, '-');
  const parent = dirname(targetRoot);
  const targetName = basename(targetRoot).replace(/^\.+/, '') || 'synabun';
  const recoveryRoot = resolve(parent, `.${targetName}.resolution-${timestamp}`);
  mkdirSync(recoveryRoot, { recursive: true });
  if (dataHomeHasState(sourceRoot)) copyMigrationItems(sourceRoot, resolve(recoveryRoot, 'legacy'), DATA_HOME_MIGRATION_ITEMS);
  if (dataHomeHasState(targetRoot)) copyMigrationItems(targetRoot, resolve(recoveryRoot, 'external'), DATA_HOME_MIGRATION_ITEMS);
  const report = {
    version: 1,
    createdAt: now().toISOString(),
    source: inspectDataHome(sourceRoot),
    target: inspectDataHome(targetRoot),
  };
  writeFileSync(resolve(recoveryRoot, 'resolution-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');
  return recoveryRoot;
}

export function migrateDataHome({
  sourceRoot,
  targetRoot,
  items = DATA_HOME_MIGRATION_ITEMS,
  merge = false,
  dryRun = false,
  now = () => new Date(),
} = {}) {
  const plan = planDataHomeMigration({ sourceRoot, targetRoot, items });
  if (!plan.sourceHasState) throw new Error(`No SynaBun state found at ${plan.sourceRoot}`);
  if (merge) {
    throw new Error('Automatic merge is disabled because it can overwrite newer user state. Use an explicit data-home choice.');
  }
  if (plan.targetHasState) {
    throw new Error(`Destination already contains SynaBun state: ${plan.targetRoot}. Use --choose external or --choose legacy after reviewing synabun doctor.`);
  }
  if (dryRun) return { ...plan, applied: false };

  const timestamp = now().toISOString().replace(/[:.]/g, '-');
  const parent = dirname(plan.targetRoot);
  const targetName = basename(plan.targetRoot).replace(/^\.+/, '') || 'synabun';
  const stage = resolve(parent, `.${targetName}.migration-${process.pid}-${Date.now()}`);
  const backup = resolve(parent, `.${targetName}.pre-migration-${timestamp}`);
  let targetMoved = false;

  mkdirSync(parent, { recursive: true });
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  try {
    copyMigrationItems(plan.sourceRoot, stage, items);
    const verification = verifyCopiedFiles(plan.sourceRoot, stage, items);
    const normalizedEnvKeys = normalizeDataHomeEnv(stage, plan.targetRoot);
    const marker = {
      version: 1,
      migratedAt: now().toISOString(),
      sourceRoot: plan.sourceRoot,
      targetRoot: plan.targetRoot,
      choice: 'legacy',
      sourceFileCount: verification.fileCount,
      sourceDigest: `sha256:${verification.digest}`,
      conflictsOverwritten: plan.conflicts,
      skippedSymlinks: plan.skippedSymlinks,
      normalizedEnvKeys,
      sourceDeleted: false,
    };
    writeFileSync(resolve(stage, DATA_HOME_MIGRATION_MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf-8');
    writeDataHomeManifest(stage, {
      sourceRoot: plan.sourceRoot,
      sourceFingerprint: plan.sourceFingerprint,
      activationReason: 'legacy-migration',
      acknowledgedLegacyRoots: [plan.sourceRoot],
    }, now);

    if (existsSync(plan.targetRoot)) {
      renameSync(plan.targetRoot, backup);
      targetMoved = true;
    }
    renameSync(stage, plan.targetRoot);
    return { ...plan, applied: true, backupRoot: targetMoved ? backup : null, marker };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (targetMoved && !existsSync(plan.targetRoot) && existsSync(backup)) renameSync(backup, plan.targetRoot);
    throw error;
  }
}

/**
 * Resolve a divergent pair only after an explicit user choice. Both roots are
 * copied to a timestamped recovery directory before either choice is applied.
 */
export function resolveDataHomeConflict({ sourceRoot, targetRoot, choice, now = () => new Date() } = {}) {
  if (!['external', 'legacy'].includes(choice)) {
    throw new Error('choice must be "external" or "legacy"');
  }
  const plan = planDataHomeMigration({ sourceRoot, targetRoot });
  if (!plan.sourceHasState || !plan.targetHasState) {
    throw new Error('Conflict resolution requires state in both the legacy and external roots.');
  }
  const recoveryRoot = snapshotResolutionRoots(plan.sourceRoot, plan.targetRoot, now);
  if (choice === 'external') {
    const manifest = writeDataHomeManifest(plan.targetRoot, {
      sourceRoot: plan.sourceRoot,
      sourceFingerprint: plan.sourceFingerprint,
      targetFingerprint: plan.targetFingerprint,
      activationReason: 'explicit-external-choice',
      recoveryRoot,
      acknowledgedLegacyRoots: [
        ...((readJson(resolve(plan.targetRoot, DATA_HOME_MANIFEST), {})?.acknowledgedLegacyRoots) || []),
        plan.sourceRoot,
      ],
    }, now);
    return { ...plan, applied: true, choice, recoveryRoot, manifest };
  }

  const parent = dirname(plan.targetRoot);
  const targetName = basename(plan.targetRoot).replace(/^\.+/, '') || 'synabun';
  const timestamp = now().toISOString().replace(/[:.]/g, '-');
  const displacedTarget = resolve(parent, `.${targetName}.displaced-${timestamp}`);
  renameSync(plan.targetRoot, displacedTarget);
  try {
    const result = migrateDataHome({ sourceRoot: plan.sourceRoot, targetRoot: plan.targetRoot, now });
    writeDataHomeManifest(plan.targetRoot, {
      sourceRoot: plan.sourceRoot,
      sourceFingerprint: plan.sourceFingerprint,
      targetFingerprint: plan.targetFingerprint,
      activationReason: 'explicit-legacy-choice',
      recoveryRoot,
      displacedTarget,
      acknowledgedLegacyRoots: [plan.sourceRoot],
    }, now);
    return { ...result, choice, recoveryRoot, displacedTarget };
  } catch (error) {
    if (!existsSync(plan.targetRoot) && existsSync(displacedTarget)) renameSync(displacedTarget, plan.targetRoot);
    throw error;
  }
}

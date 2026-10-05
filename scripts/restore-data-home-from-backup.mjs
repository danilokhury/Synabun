#!/usr/bin/env node

/**
 * Restore durable SynaBun state from a verified v2/v3 backup.
 *
 * The archive is fully checksum-verified before extraction. Restore happens in
 * a sibling staging directory; the existing target is renamed (never deleted)
 * immediately before the staged tree is atomically activated.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Streaming reader: AdmZip buffered the whole archive, which Node refuses past
// 2 GiB, so large data homes could be backed up but never restored.
import {
  extractZipEntry,
  openZipArchive,
  readBackupManifest,
  verifyBackupChecksums,
} from '../neural-interface/lib/backup-zip-reader.js';

function pathIsInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function timestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Open the archive and stream-verify every checksum before anything is extracted. */
async function parseArchive(backupPath) {
  const zip = await openZipArchive(backupPath);
  try {
    const found = await readBackupManifest(zip);
    if (!found || !found.prefix) throw new Error('Invalid backup: manifest.json is missing');
    const { manifest, prefix } = found;
    if (![2, 3].includes(manifest.version)) {
      throw new Error(`Unsupported backup version: ${manifest.version}. Expected v2 or v3.`);
    }
    await verifyBackupChecksums(zip, { prefix, manifest, label: 'Invalid backup' });
    return { zip, entries: zip.entries, manifest, prefix };
  } catch (error) {
    await zip.close().catch(() => {});
    throw error;
  }
}

function restoredRelativePath(entryName, prefix) {
  const rel = entryName.slice(`${prefix}/`.length);
  if (rel === 'env.bak') return '.env';
  if (rel === 'database/memory.db') return 'mcp-data/memory.db';
  if (rel.startsWith('data/') || rel.startsWith('mcp-data/')) return rel;
  return null;
}

async function writeSelectedEntries({ zip, entries, prefix, stageRoot }) {
  const selected = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.startsWith(`${prefix}/`)) continue;
    const rel = restoredRelativePath(entry.name, prefix);
    if (!rel) continue;
    const target = resolve(stageRoot, rel);
    if (!pathIsInside(target, stageRoot) || target === resolve(stageRoot)) throw new Error(`Unsafe backup path: ${entry.name}`);
    selected.push({ entry, rel, target });
  }
  for (const { entry, target } of selected) await extractZipEntry(zip, entry, target);
  return [...new Set(selected.map(item => item.rel))].sort();
}

function normalizeEnv(stageRoot, targetRoot) {
  const envPath = resolve(stageRoot, '.env');
  const values = new Map([
    ['SYNABUN_DATA_HOME', resolve(targetRoot)],
    ['MEMORY_DATA_DIR', resolve(targetRoot, 'mcp-data')],
    ['SQLITE_DB_PATH', resolve(targetRoot, 'mcp-data', 'memory.db')],
    ['DOTENV_PATH', resolve(targetRoot, '.env')],
  ]);
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const seen = new Set();
  const lines = original.split(/\r?\n/).map(line => {
    const match = line.match(/^(\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*)(.*)$/);
    if (!match || !values.has(match[2])) return line;
    seen.add(match[2]);
    return `${match[1]}${values.get(match[2])}`;
  });
  for (const [key, value] of values) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  writeFileSync(envPath, `${lines.join('\n').replace(/^\n+|\n+$/g, '')}\n`, 'utf-8');
}

function walkJson(root, current = root, result = []) {
  if (!existsSync(current)) return result;
  const stat = statSync(current);
  if (stat.isFile()) {
    if (current.endsWith('.json')) result.push(current);
    return result;
  }
  for (const name of readdirSync(current)) walkJson(root, resolve(current, name), result);
  return result;
}

/**
 * JSON that does not parse is restored exactly as it was backed up and
 * reported. The checksums already proved these bytes match the archive, so a
 * bad file here was bad in the source. One torn hook-state write
 * (data/pending-remember/*.json) used to refuse the restore of a whole data home.
 */
function findInvalidJson(stageRoot) {
  const invalid = [];
  for (const path of walkJson(stageRoot)) {
    try { JSON.parse(readFileSync(path, 'utf-8')); }
    catch (error) { invalid.push({ path: relative(stageRoot, path), error: error.message }); }
  }
  return invalid;
}

function validateStage(stageRoot) {
  const dbPath = resolve(stageRoot, 'mcp-data', 'memory.db');
  if (!existsSync(dbPath)) throw new Error('Backup does not contain database/memory.db');
  let database;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const integrityRow = database.prepare('PRAGMA integrity_check').get();
    const integrity = integrityRow?.integrity_check || integrityRow?.integrity || 'unknown';
    if (integrity !== 'ok') throw new Error(`SQLite integrity check returned: ${integrity}`);
    const memories = Number(database.prepare('SELECT COUNT(*) AS count FROM memories').get()?.count || 0);
    let categories = null;
    try { categories = Number(database.prepare('SELECT COUNT(*) AS count FROM categories').get()?.count || 0); } catch {}
    return { integrity, memories, categories, sizeBytes: statSync(dbPath).size };
  } finally {
    try { database?.close(); } catch {}
  }
}

export async function restoreDataHomeFromBackup({
  backupPath,
  targetRoot,
  legacyRoot = null,
  apply = false,
  now = () => new Date(),
} = {}) {
  if (!backupPath || !targetRoot) throw new Error('backupPath and targetRoot are required');
  const backup = resolve(backupPath);
  const target = resolve(targetRoot);
  if (!existsSync(backup)) throw new Error(`Backup not found: ${backup}`);

  const parsed = await parseArchive(backup);
  const createdAt = now();
  const targetName = basename(target).replace(/^\.+/, '') || 'synabun';
  const parent = dirname(target);
  const stage = resolve(parent, `.${targetName}.restore-stage-${process.pid}-${Date.now()}`);
  const displacedTarget = resolve(parent, `.${targetName}.pre-restore-${timestamp(createdAt)}`);
  let activated = false;
  let targetMoved = false;
  try {
    mkdirSync(parent, { recursive: true });
    mkdirSync(stage, { recursive: true });
    const restoredFiles = await writeSelectedEntries({ ...parsed, stageRoot: stage });
    normalizeEnv(stage, target);
    const database = validateStage(stage);
    const invalidJson = findInvalidJson(stage);
    const existingManifest = existsSync(resolve(target, '.synabun-data-home.json'))
      ? JSON.parse(readFileSync(resolve(target, '.synabun-data-home.json'), 'utf-8'))
      : {};
    const acknowledgedLegacyRoots = legacyRoot ? [resolve(legacyRoot)] : [];
    const manifest = {
      version: 1,
      installationId: existingManifest.installationId || createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32),
      dataSchemaVersion: 1,
      activatedAt: createdAt.toISOString(),
      activationReason: 'verified-backup-restore',
      restoredFrom: backup,
      restoredBackupVersion: parsed.manifest.version,
      restoredBackupCreatedAt: parsed.manifest.created || parsed.manifest.createdAt || null,
      acknowledgedLegacyRoots,
    };
    writeFileSync(resolve(stage, '.synabun-data-home.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    const result = {
      applied: false,
      backupPath: backup,
      targetRoot: target,
      displacedTarget: existsSync(target) ? displacedTarget : null,
      manifest: parsed.manifest,
      database,
      invalidJson,
      restoredFiles,
    };
    if (!apply) return result;

    if (existsSync(target)) {
      renameSync(target, displacedTarget);
      targetMoved = true;
    }
    renameSync(stage, target);
    activated = true;
    return { ...result, applied: true };
  } catch (error) {
    if (targetMoved && !existsSync(target) && existsSync(displacedTarget)) renameSync(displacedTarget, target);
    throw error;
  } finally {
    await parsed.zip.close().catch(() => {});
    if (!activated) rmSync(stage, { recursive: true, force: true });
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await restoreDataHomeFromBackup({
      backupPath: option('--backup') || option('--from'),
      targetRoot: option('--target'),
      legacyRoot: option('--legacy-root'),
      apply: process.argv.includes('--apply'),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

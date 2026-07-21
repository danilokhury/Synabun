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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromNeuralInterface = createRequire(new URL('../neural-interface/package.json', import.meta.url));
const AdmZip = requireFromNeuralInterface('adm-zip');

function pathIsInside(candidate, parent) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function timestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function hashBuffer(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function parseArchive(backupPath) {
  const zip = new AdmZip(backupPath);
  const entries = zip.getEntries();
  const manifestEntry = entries.find(entry => entry.entryName.endsWith('/manifest.json'));
  if (!manifestEntry) throw new Error('Invalid backup: manifest.json is missing');
  const prefix = manifestEntry.entryName.slice(0, -'/manifest.json'.length);
  const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
  if (![2, 3].includes(manifest.version)) {
    throw new Error(`Unsupported backup version: ${manifest.version}. Expected v2 or v3.`);
  }
  const byName = new Map(entries.map(entry => [entry.entryName, entry]));
  for (const [archivePath, expected] of Object.entries(manifest.checksums || {})) {
    const entry = byName.get(`${prefix}/${archivePath}`);
    if (!entry) throw new Error(`Invalid backup: ${archivePath} is missing`);
    const actual = hashBuffer(entry.getData());
    if (actual !== expected) throw new Error(`Invalid backup: checksum mismatch for ${archivePath}`);
  }
  return { zip, entries, manifest, prefix };
}

function restoredRelativePath(entryName, prefix) {
  const rel = entryName.slice(`${prefix}/`.length);
  if (rel === 'env.bak') return '.env';
  if (rel === 'database/memory.db') return 'mcp-data/memory.db';
  if (rel.startsWith('data/') || rel.startsWith('mcp-data/')) return rel;
  return null;
}

function writeSelectedEntries({ entries, prefix, stageRoot }) {
  const restored = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.startsWith(`${prefix}/`)) continue;
    const rel = restoredRelativePath(entry.entryName, prefix);
    if (!rel) continue;
    const target = resolve(stageRoot, rel);
    if (!pathIsInside(target, stageRoot)) throw new Error(`Unsafe backup path: ${entry.entryName}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.getData());
    restored.push(rel);
  }
  return [...new Set(restored)].sort();
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

function validateStage(stageRoot) {
  const dbPath = resolve(stageRoot, 'mcp-data', 'memory.db');
  if (!existsSync(dbPath)) throw new Error('Backup does not contain database/memory.db');
  for (const path of walkJson(stageRoot)) JSON.parse(readFileSync(path, 'utf-8'));
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

export function restoreDataHomeFromBackup({
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

  const parsed = parseArchive(backup);
  const createdAt = now();
  const targetName = basename(target).replace(/^\.+/, '') || 'synabun';
  const parent = dirname(target);
  const stage = resolve(parent, `.${targetName}.restore-stage-${process.pid}-${Date.now()}`);
  const displacedTarget = resolve(parent, `.${targetName}.pre-restore-${timestamp(createdAt)}`);
  mkdirSync(parent, { recursive: true });
  mkdirSync(stage, { recursive: true });

  let activated = false;
  let targetMoved = false;
  try {
    const restoredFiles = writeSelectedEntries({ ...parsed, stageRoot: stage });
    normalizeEnv(stage, target);
    const database = validateStage(stage);
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
    if (!activated) rmSync(stage, { recursive: true, force: true });
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = restoreDataHomeFromBackup({
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

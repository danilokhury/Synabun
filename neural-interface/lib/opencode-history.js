// OpenCode history maintenance.
//
// This module deliberately owns a very small allowlist of history tables and
// artifact directories. Provider credentials, account state, project records,
// OpenCode configuration, user project files, and git repositories outside the
// OpenCode data directory are never touched.

// The server runs the destructive operation in a worker so VACUUM can reclaim
// a large history database without freezing SynaBun's HTTP/WebSocket loop.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

export const OPENCODE_HISTORY_CONFIRMATION = 'DELETE OPENCODE HISTORY';

const HISTORY_TABLES_CHILD_FIRST = [
  'part',
  'message',
  'todo',
  'session_share',
  'session_input',
  'session_message',
  'session_context_epoch',
  'event',
  'event_sequence',
  'session',
];

const HISTORY_ARTIFACT_PATHS = [
  ['snapshot'],
  ['repos'],
  ['storage', 'session_diff'],
  ['tool-output'],
];

function fileBytes(path) {
  try {
    return statSync(path).size || 0;
  } catch {
    return 0;
  }
}

function databaseBytes(dbPath) {
  return fileBytes(dbPath) + fileBytes(`${dbPath}-wal`) + fileBytes(`${dbPath}-shm`);
}

function entryBytes(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size || 0;
  let total = 0;
  for (const name of readdirSync(path)) total += entryBytes(resolve(path, name));
  return total;
}

function assertSafePaths(dbPath, dataRoot) {
  const root = resolve(dataRoot);
  const database = resolve(dbPath);
  if (root === parse(root).root) throw new Error('Refusing to clear an unsafe OpenCode data root');
  if (basename(root).toLowerCase() !== 'opencode') {
    throw new Error('Refusing to clear a data root that is not the OpenCode directory');
  }
  if (database !== resolve(root, 'opencode.db')) {
    throw new Error('OpenCode database must be the opencode.db file inside its data root');
  }
  return { database, root };
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((row) => String(row?.name || '')));
}

function countRows(db, table, tables) {
  if (!tables.has(table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get();
  return Number(row?.count || 0);
}

function artifactStats(dataRoot) {
  let bytes = 0;
  let entries = 0;
  for (const segments of HISTORY_ARTIFACT_PATHS) {
    const path = resolve(dataRoot, ...segments);
    if (!existsSync(path)) continue;
    bytes += entryBytes(path);
    entries += 1;
  }
  return { bytes, entries };
}

export function getOpenCodeHistoryStats({ dbPath, dataRoot = dirname(dbPath) }) {
  const { database, root } = assertSafePaths(dbPath, dataRoot);
  const artifacts = artifactStats(root);
  const stats = {
    sessions: 0,
    databaseBytes: databaseBytes(database),
    artifactBytes: artifacts.bytes,
  };
  if (!existsSync(database)) return stats;

  let db;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000');
    const tables = tableNames(db);
    stats.sessions = countRows(db, 'session', tables);
  } finally {
    try { db?.close(); } catch {}
  }
  return stats;
}

function clearArtifactDirectory(path, warnings) {
  if (!existsSync(path)) return { files: 0, bytes: 0 };
  const stat = lstatSync(path);

  // Never traverse a symlink out of the OpenCode data directory. Removing the
  // link still detaches it from OpenCode, but the external target is retained.
  if (stat.isSymbolicLink()) {
    const bytes = stat.size || 0;
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });
    warnings.push(`Removed linked artifact directory ${path} without following its external target`);
    return { files: 1, bytes };
  }
  if (!stat.isDirectory()) {
    const bytes = stat.size || 0;
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });
    return { files: 1, bytes };
  }

  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(path)) {
    const target = resolve(path, name);
    if (target !== path && !target.startsWith(`${path}${sep}`)) {
      throw new Error(`Refusing to clear unsafe artifact path: ${target}`);
    }
    bytes += entryBytes(target);
    rmSync(target, { recursive: true, force: true });
    files += 1;
  }
  return { files, bytes };
}

export function clearOpenCodeHistory({ dbPath, dataRoot = dirname(dbPath), vacuum = true }) {
  const { database, root } = assertSafePaths(dbPath, dataRoot);
  const warnings = [];
  const result = {
    sessionsDeleted: 0,
    messagesDeleted: 0,
    partsDeleted: 0,
    databaseBytesBefore: databaseBytes(database),
    databaseBytesAfter: 0,
    artifactEntriesDeleted: 0,
    artifactBytesDeleted: 0,
    vacuumed: false,
    warnings,
  };

  if (existsSync(database)) {
    let db;
    try {
      db = new DatabaseSync(database);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 10000');
      const tables = tableNames(db);
      result.sessionsDeleted = countRows(db, 'session', tables);
      result.messagesDeleted = countRows(db, 'message', tables);
      result.partsDeleted = countRows(db, 'part', tables);

      db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of HISTORY_TABLES_CHILD_FIRST) {
          if (tables.has(table)) db.exec(`DELETE FROM "${table}"`);
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }

      if (vacuum) {
        try {
          try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
          db.exec('VACUUM');
          try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
          result.vacuumed = true;
        } catch (error) {
          warnings.push(`History was deleted, but database compaction failed: ${error.message}`);
        }
      }
    } finally {
      try { db?.close(); } catch {}
    }
  }

  for (const segments of HISTORY_ARTIFACT_PATHS) {
    const artifactPath = resolve(root, ...segments);
    if (artifactPath !== root && !artifactPath.startsWith(`${root}${sep}`)) {
      throw new Error(`Refusing to clear unsafe artifact path: ${artifactPath}`);
    }
    try {
      const cleared = clearArtifactDirectory(artifactPath, warnings);
      result.artifactEntriesDeleted += cleared.files;
      result.artifactBytesDeleted += cleared.bytes;
    } catch (error) {
      warnings.push(`Could not clear ${artifactPath}: ${error.message}`);
    }
  }

  result.databaseBytesAfter = databaseBytes(database);
  return result;
}

export function clearOpenCodeHistoryInWorker(options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { operation: 'clear-opencode-history', options },
    });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      if (message?.ok) resolvePromise(message.result);
      else rejectPromise(new Error(message?.error || 'OpenCode history worker failed'));
    });
    worker.once('error', (error) => {
      settled = true;
      rejectPromise(error);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) rejectPromise(new Error(`OpenCode history worker exited with code ${code}`));
      else if (!settled) rejectPromise(new Error('OpenCode history worker exited before returning a result'));
    });
  });
}

if (!isMainThread && workerData?.operation === 'clear-opencode-history') {
  try {
    parentPort?.postMessage({ ok: true, result: clearOpenCodeHistory(workerData.options) });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error?.message || String(error) });
  }
}

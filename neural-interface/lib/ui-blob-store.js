// ═══════════════════════════════════════════
// SynaBun Neural Interface — UI Blob Store
// ═══════════════════════════════════════════
// Per-entry storage for the fat UI-state keys (rendered transcript snapshots,
// graph node positions). These used to live inside ui-state.json, which made
// every state PATCH re-serialize and rewrite multiple megabytes. Here each
// entry is its own SQLite row, so a streaming session persists only its own
// ~100-300KB snapshot.
//
// Deliberately a SEPARATE database file from memory.db: memory.db is shared
// cross-process with the MCP server and gets backed up — multi-MB transcript
// HTML churn would bloat its WAL and backups for no benefit.

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

let db = null;
let dbPath = null;

export function initBlobStore(path) {
  dbPath = path;
  return getBlobDb();
}

function getBlobDb() {
  if (!db) {
    if (!dbPath) throw new Error('ui-blob-store: initBlobStore(path) not called');
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
CREATE TABLE IF NOT EXISTS ui_blobs (
  ns         TEXT NOT NULL,
  id         TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, id)
);`);
  }
  return db;
}

export function blobGetNamespace(ns) {
  const d = getBlobDb();
  const rows = d.prepare('SELECT id, value FROM ui_blobs WHERE ns = ?').all(ns);
  const out = {};
  for (const row of rows) {
    try { out[row.id] = JSON.parse(row.value); } catch { /* skip corrupt row */ }
  }
  return out;
}

export function blobGet(ns, id) {
  const d = getBlobDb();
  const row = d.prepare('SELECT value FROM ui_blobs WHERE ns = ? AND id = ?').get(ns, id);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function blobPut(ns, id, value) {
  const d = getBlobDb();
  d.prepare(`
    INSERT INTO ui_blobs (ns, id, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(ns, id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(ns, id, JSON.stringify(value), Date.now());
}

export function blobDelete(ns, id) {
  const d = getBlobDb();
  d.prepare('DELETE FROM ui_blobs WHERE ns = ? AND id = ?').run(ns, id);
}

export function blobClearNamespace(ns) {
  const d = getBlobDb();
  const result = d.prepare('DELETE FROM ui_blobs WHERE ns = ?').run(ns);
  return Number(result?.changes || 0);
}

// Evict oldest entries beyond maxEntries and/or beyond maxTotalChars of
// cumulative value length (newest kept). Returns the evicted ids.
export function blobPrune(ns, { maxEntries = 0, maxTotalChars = 0 } = {}) {
  const d = getBlobDb();
  const rows = d.prepare(
    'SELECT id, LENGTH(value) AS len FROM ui_blobs WHERE ns = ? ORDER BY updated_at DESC'
  ).all(ns);
  const evicted = [];
  let totalChars = 0;
  rows.forEach((row, i) => {
    totalChars += row.len;
    const overCount = maxEntries > 0 && i >= maxEntries;
    const overChars = maxTotalChars > 0 && totalChars > maxTotalChars && i > 0;
    if (overCount || overChars) evicted.push(row.id);
  });
  if (evicted.length) {
    const del = d.prepare('DELETE FROM ui_blobs WHERE ns = ? AND id = ?');
    for (const id of evicted) del.run(ns, id);
  }
  return evicted;
}

export function closeBlobStore() {
  if (db) { try { db.close(); } catch {} db = null; }
}

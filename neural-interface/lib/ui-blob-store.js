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

// ── Which of a page's requests for one entry is the newer ──
// A page numbers what it asks for (public/shared/blob-store.js: `rev`, counted up, and `writer`, the page's own
// id). The requests it sends while it is being left (a keepalive fetch, a beacon) reach the server in any order:
// a delete may arrive before the write it was meant to follow, an older write after a newer one. So what the
// store last did for a page is remembered here, entry by entry, a deletion too, and a request of that page with
// a number that is not higher is not applied.
//
// Remembered per namespace, entry and page. A request of another page, and one without a number, is applied as
// it arrives, as it always was, and takes nothing away from what is remembered: a page that deleted an entry
// with its request 2 does not get its request 1 applied because somebody else wrote in between. And remembered
// only once the store has done what was asked (`stale()` asks, `applied()` records): a write that failed has used
// up no number, and is applied when the page sends it again.
//
// Kept in memory for a quarter of an hour, far longer than a request of a page that is gone can still be on its
// way, and for at most BLOB_ORDER_MAX marks (those applied longest ago go first); a restart forgets all of it.
export const BLOB_ORDER_TTL_MS = 15 * 60_000;
const BLOB_ORDER_MAX = 5000;
const WRITER_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The revision a request carries in its query (`?rev=<n>&writer=<id>`), or null when it carries none that counts. */
export function blobRevision(query) {
  const rev = Number(typeof query?.rev === 'string' ? query.rev : NaN);
  const writer = query?.writer;
  if (!Number.isSafeInteger(rev) || rev < 1 || typeof writer !== 'string' || !WRITER_RE.test(writer)) return null;
  return { writer, rev };
}

/**
 * The memory of what the store last did for each page, entry by entry.
 * @param {{ now?: () => number, ttlMs?: number, max?: number }} [o]
 * @returns {{
 *   stale: (ns: string, id: string, revision: { writer: string, rev: number } | null) => boolean,
 *   applied: (ns: string, id: string, revision: { writer: string, rev: number } | null) => void,
 *   size: () => number,
 * }}
 *   `stale`: is this request older than (or the same as) what was last applied for its page and entry? It only
 *   asks: nothing is remembered of a request until `applied` is told that the store has done it. Both take a
 *   request without a revision (null): never stale, never remembered.
 */
export function createBlobOrder({ now = Date.now, ttlMs = BLOB_ORDER_TTL_MS, max = BLOB_ORDER_MAX } = {}) {
  const marks = new Map();   // namespace, entry and page → { rev, at }, the one applied longest ago first
  // Three parts that cannot run into one another: the first two are written with their lengths.
  const keyOf = (ns, id, writer) => `${String(ns).length}:${ns}${String(id).length}:${id}${writer}`;
  return {
    stale(ns, id, revision) {
      if (!revision) return false;
      const mark = marks.get(keyOf(ns, id, revision.writer));
      return !!mark && now() - mark.at < ttlMs && revision.rev <= mark.rev;
    },
    applied(ns, id, revision) {
      if (!revision) return;
      const at = now();
      const key = keyOf(ns, id, revision.writer);
      const mark = marks.get(key);
      const rev = mark && at - mark.at < ttlMs ? Math.max(mark.rev, revision.rev) : revision.rev;
      marks.delete(key);
      marks.set(key, { rev, at });
      // What has expired goes (it lies at the old end), then whatever is over the bound.
      for (const [oldest, value] of marks) {
        if (at - value.at < ttlMs) break;
        marks.delete(oldest);
      }
      while (marks.size > max) marks.delete(marks.keys().next().value);
    },
    size: () => marks.size,
  };
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

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
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { setTimeout, clearTimeout } from 'node:timers';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

const MAX_TRIM_ROWS = 128;
const DELETE_BATCH = 32;
const DEFAULT_BACKFILL_BATCH = 16;
const NAMESPACE_READ_PAGE = 25;
const WORKER_IDLE_MS = 5000;

let db = null;
let dbPath = null;
let backfillTimer = null;
let recountThrough = 0;
let readerState = null;
let readerJobSeq = 0;

function terminateReaderWorker(reason = 'ui-blob-store closed') {
  const current = readerState;
  if (!current) return;
  readerState = null;
  if (current.idleTimer) { clearTimeout(current.idleTimer); current.idleTimer = null; }
  if (current.jobs.size) {
    const err = new Error(reason);
    for (const job of current.jobs.values()) job.reject(err);
    current.jobs.clear();
  }
  try { void current.worker.terminate(); } catch {}
}

function ensureSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS ui_blobs (
      ns TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
      value_chars INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, id)
    );
    CREATE TABLE IF NOT EXISTS ui_blob_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
  `);
  if (!d.prepare('PRAGMA table_info(ui_blobs)').all().some(col => col.name === 'value_chars')) {
    d.exec('ALTER TABLE ui_blobs ADD COLUMN value_chars INTEGER');
  }
  d.exec(`
    DROP TRIGGER IF EXISTS trg_ui_blobs_ai_chars;
    DROP TRIGGER IF EXISTS trg_ui_blobs_au_chars;
    DROP TRIGGER IF EXISTS trg_ui_blobs_au_rev;
    DROP INDEX IF EXISTS idx_ui_blobs_ns_updated;
    DROP INDEX IF EXISTS idx_ui_blobs_null_chars;
    CREATE INDEX IF NOT EXISTS idx_ui_blobs_trim ON ui_blobs(ns, updated_at DESC, id DESC, value_chars);
    INSERT OR IGNORE INTO ui_blob_meta (k, v)
      SELECT 'recount_through', COALESCE(MAX(rowid), 0) FROM ui_blobs;
  `);
  return d.prepare("SELECT v FROM ui_blob_meta WHERE k = 'recount_through'").get().v;
}

// Recount pre-upgrade rows (both NULL and old UTF-16 counts). The rowid keyset and
// its checkpoint commit together. New writes already use SQLite LENGTH().
export function backfillBlobValueCharsBatch(limit = DEFAULT_BACKFILL_BATCH) {
  if (!db || !recountThrough) return 0;
  const batch = Math.max(1, Math.min(DEFAULT_BACKFILL_BATCH, Math.trunc(limit) || DEFAULT_BACKFILL_BATCH));
  const rows = db.prepare('SELECT rowid FROM ui_blobs WHERE rowid <= ? ORDER BY rowid DESC LIMIT ?')
    .all(recountThrough, batch);
  const next = rows.length === batch ? Math.max(0, rows.at(-1).rowid - 1) : 0;
  db.exec('BEGIN');
  try {
    if (rows.length) {
      db.prepare('UPDATE ui_blobs SET value_chars = LENGTH(value) WHERE rowid BETWEEN ? AND ?')
        .run(rows.at(-1).rowid, rows[0].rowid);
    }
    db.prepare("UPDATE ui_blob_meta SET v = ? WHERE k = 'recount_through'").run(next);
    db.exec('COMMIT');
    recountThrough = next;
    return rows.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function scheduleBackfill() {
  if (!recountThrough) return;
  backfillTimer = setTimeout(() => {
    try {
      backfillBlobValueCharsBatch();
    } catch (err) {
      console.warn('[ui-blobs] Character recount paused until next open:', err.message);
      return;
    }
    scheduleBackfill();
  }, 25);
  backfillTimer.unref();
}

export function initBlobStore(path) {
  if (db && dbPath !== path) closeBlobStore();
  dbPath = path;
  return getBlobDb();
}

function getBlobDb() {
  if (!db) {
    if (!dbPath) throw new Error('ui-blob-store: initBlobStore(path) not called');
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const opened = new DatabaseSync(dbPath);
    try {
      if (dbPath !== ':memory:') opened.exec('PRAGMA journal_mode = WAL');
      opened.exec('PRAGMA busy_timeout = 5000');
      opened.exec('BEGIN');
      recountThrough = ensureSchema(opened);
      opened.exec('COMMIT');
    } catch (err) {
      try { opened.close(); } catch {}
      throw err;
    }
    // Publish the connection only after PRAGMAs and ensureSchema() succeed.
    db = opened;
    scheduleBackfill();
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

function buildNamespaceJsonSync(d, ns, pageSize = NAMESPACE_READ_PAGE) {
  const firstStmt = d.prepare('SELECT id, value FROM ui_blobs WHERE ns = ? ORDER BY id ASC LIMIT ?');
  const nextStmt = d.prepare('SELECT id, value FROM ui_blobs WHERE ns = ? AND id > ? ORDER BY id ASC LIMIT ?');
  let lastId = null;
  const parts = ['{'];
  let first = true;
  for (;;) {
    const rows = lastId === null ? firstStmt.all(ns, pageSize) : nextStmt.all(ns, lastId, pageSize);
    if (!rows.length) break;
    for (const row of rows) {
      lastId = row.id;
      try {
        const parsed = JSON.parse(row.value);
        const encoded = JSON.stringify(parsed);
        if (encoded === undefined) continue;
        parts.push(`${first ? '' : ','}${JSON.stringify(row.id)}:${encoded}`);
        first = false;
      } catch { /* skip corrupt row */ }
    }
    if (rows.length < pageSize) break;
  }
  parts.push('}');
  return parts.join('');
}

function getOrCreateReaderWorker(targetPath) {
  if (readerState && readerState.path !== targetPath) {
    terminateReaderWorker('ui-blob-store path changed');
  }
  if (!readerState) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { uiBlobReader: true },
      execArgv: process.execArgv.filter((arg) => arg === '--experimental-sqlite'),
    });
    const state = { worker, path: targetPath, jobs: new Map(), idleTimer: null };
    readerState = state;
    worker.on('message', (msg) => {
      const job = state.jobs.get(msg.id);
      if (!job) return;
      state.jobs.delete(msg.id);
      if (state.jobs.size === 0 && readerState === state) {
        worker.unref();
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => {
          state.idleTimer = null;
          if (readerState === state && state.jobs.size === 0) {
            terminateReaderWorker('idle');
          }
        }, WORKER_IDLE_MS);
        state.idleTimer.unref?.();
      }
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(Buffer.from(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength));
    });
    const onWorkerEnd = (err) => {
      if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
      if (readerState === state) readerState = null;
      if (state.jobs.size) {
        const error = err || new Error('ui-blob reader worker exited before replying');
        for (const job of state.jobs.values()) job.reject(error);
        state.jobs.clear();
      }
    };
    worker.once('error', onWorkerEnd);
    worker.once('exit', () => onWorkerEnd());
  }
  return readerState;
}

/**
 * Read and serialize an entire namespace as a UTF-8 JSON Buffer off the event loop
 * (in a short-lived worker thread for file-backed DBs).
 * Preserves the exact `{ [id]: value }` response contract for GET /api/ui-blobs/:ns.
 */
export async function blobGetNamespaceJsonAsync(ns) {
  const d = getBlobDb();
  if (!dbPath || dbPath === ':memory:') {
    return Buffer.from(buildNamespaceJsonSync(d, ns));
  }
  const targetPath = dbPath;
  const state = getOrCreateReaderWorker(targetPath);
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  state.worker.ref();
  const id = ++readerJobSeq;
  return new Promise((resolve, reject) => {
    state.jobs.set(id, { resolve, reject });
    try {
      state.worker.postMessage({ id, dbPath: targetPath, ns });
    } catch (err) {
      state.jobs.delete(id);
      reject(err);
    }
  });
}

export async function blobGetNamespaceAsync(ns) {
  const buf = await blobGetNamespaceJsonAsync(ns);
  return JSON.parse(buf.toString('utf8'));
}

export function blobGet(ns, id) {
  const d = getBlobDb();
  const row = d.prepare('SELECT value FROM ui_blobs WHERE ns = ? AND id = ?').get(ns, id);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function blobPut(ns, id, value) {
  const d = getBlobDb();
  const serialized = JSON.stringify(value);
  // Keep the last write newest through millisecond ties and backwards clock steps.
  d.prepare(`
    INSERT INTO ui_blobs (ns, id, value, value_chars, updated_at)
    VALUES (?, ?, ?, LENGTH(?), MAX(?, COALESCE((
      SELECT updated_at + 1 FROM ui_blobs WHERE ns = ? ORDER BY updated_at DESC LIMIT 1
    ), 0)))
    ON CONFLICT(ns, id) DO UPDATE SET
      value = excluded.value, value_chars = excluded.value_chars, updated_at = excluded.updated_at
  `).run(ns, id, serialized, serialized, Date.now(), ns);
}

export function blobDelete(ns, id) {
  getBlobDb().prepare('DELETE FROM ui_blobs WHERE ns = ? AND id = ?').run(ns, id);
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
  return getBlobDb().prepare('DELETE FROM ui_blobs WHERE ns = ?').run(ns).changes;
}

// Keep the newest entry even if it alone exceeds the character budget.
export function blobPrune(ns, { maxEntries = 0, maxTotalChars = 0 } = {}) {
  if (!(maxEntries > 0 || maxTotalChars > 0)) return [];
  const d = getBlobDb();
  let cutoff;
  if (maxTotalChars > 0) {
    // Only an uncounted legacy value needs a table lookup. Normal writes trim
    // straight from the covering index and stop as soon as either cap is reached.
    const rows = d.prepare(`
      SELECT id, updated_at, CASE WHEN rowid <= ? OR value_chars IS NULL
        THEN (SELECT LENGTH(legacy.value) FROM ui_blobs AS legacy WHERE legacy.rowid = b.rowid)
        ELSE value_chars END AS chars
      FROM ui_blobs AS b WHERE ns = ? ORDER BY updated_at DESC, id DESC LIMIT ?
    `).iterate(recountThrough, ns, MAX_TRIM_ROWS);
    let total = 0;
    let count = 0;
    for (const row of rows) {
      total += row.chars;
      if (count && total > maxTotalChars) break;
      cutoff = row;
      count++;
      if (total >= maxTotalChars || count === maxEntries) break;
      if (count === MAX_TRIM_ROWS) {
        console.debug('[ui-blobs] Character trim reached the row budget for', ns);
        // No character cutoff proven in this scan. A separate count cap still applies.
        cutoff = null;
      }
    }
  }
  if (!cutoff && maxEntries > 0) {
    cutoff = d.prepare(`
      SELECT updated_at, id FROM ui_blobs WHERE ns = ?
      ORDER BY updated_at DESC, id DESC LIMIT 1 OFFSET ?
    `).get(ns, Math.min(Number.MAX_SAFE_INTEGER, maxEntries) - 1);
  }
  if (!cutoff) return [];
  const victims = d.prepare(`
    SELECT id FROM ui_blobs WHERE ns = ? AND (updated_at, id) < (?, ?)
    ORDER BY updated_at, id LIMIT ?
  `).all(ns, cutoff.updated_at, cutoff.id, MAX_TRIM_ROWS + 1);
  if (victims.length > MAX_TRIM_ROWS) {
    victims.pop();
    console.debug('[ui-blobs] Remaining evictions deferred to next write for', ns);
  }
  const ids = victims.map(row => row.id);
  if (ids.length) {
    d.exec('BEGIN');
    try {
      for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        const batch = ids.slice(i, i + DELETE_BATCH);
        const params = batch.map(() => '?').join(',');
        d.prepare(`DELETE FROM ui_blobs WHERE ns = ? AND id IN (${params})`).run(ns, ...batch);
      }
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
  return ids;
}

export function closeBlobStore() {
  clearTimeout(backfillTimer);
  backfillTimer = null;
  recountThrough = 0;
  terminateReaderWorker('ui-blob-store closed');
  if (db) { db.close(); db = null; }
}

// ── Worker thread entrypoint for off-event-loop namespace reads ──
if (!isMainThread && workerData?.uiBlobReader && parentPort) {
  const encoder = new TextEncoder();
  parentPort.on('message', ({ id, dbPath: targetPath, ns }) => {
    let reader = null;
    try {
      reader = new DatabaseSync(targetPath);
      reader.exec('PRAGMA query_only = ON');
      reader.exec('PRAGMA busy_timeout = 5000; BEGIN');
      const json = buildNamespaceJsonSync(reader, ns, NAMESPACE_READ_PAGE);
      reader.exec('COMMIT');
      // Close before replying so an idle worker never pins the DB file (critical on Windows).
      reader.close();
      reader = null;
      const bytes = encoder.encode(json);
      parentPort.postMessage({ id, bytes }, [bytes.buffer]);
    } catch (err) {
      if (reader) { try { reader.close(); } catch {} }
      parentPort.postMessage({ id, error: err?.message || String(err) });
    }
  });
}

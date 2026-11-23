// What Settings → Memory shows beside the recall controls (GET /api/recall-impact), read off the server's thread.
//
// The route ran two aggregates on the server's own connection: memories grouped by importance with the average
// length of content, tags and related files, and the count and average lengths of every session chunk. Both read
// every row whole, because in a row the vector and the content come before the columns they measure: on the owner's
// store (2.6 GB, 35k memories, about 150k session chunks) the second one held the only thread for 5,287 ms
// (2026-11-21; the stall line named `timer:memory-maintenance`, the label that had marked last, not the cause).
//
// Here the same numbers are read on the retrieval reader's thread (mcp-server retrieval-reader.ts: a read-only
// connection of its own) in slices of `sliceRows` rows by rowid, each a statement of a few milliseconds:
//   - recall's own reads on that thread take their turn between two slices instead of waiting for a whole scan;
//   - a shutdown never waits for a long native call;
//   - when the reader cannot serve a slice, readRows runs that one slice on the caller's connection: still short,
//     and the event loop gets a turn before the next one.
// The sums are added here and divided once, which is exactly CAST(AVG(x) AS INTEGER) of the old statements: SQLite
// averages integers as their exact sum over the count, and the cast drops the fraction.
//
// The slices are not one snapshot: a row written while the read is under way is counted if its rowid is still
// ahead, and every row is counted at most once. The answer is kept for `freshMs` (a minute) per open connection, so
// a count or an average on the Settings page can be up to a minute behind the store, plus the length of one read.
// Nothing decides anything from these numbers: they are the token estimate the page shows. Requests that arrive
// while a read is under way share it; a failed read is never kept.
import { readRows } from '../../mcp-server/dist/services/retrieval-reader.js';
import { getDb } from './db.js';
import { isMemoryStoreRefusal } from './memory-store-gate.js';

const MEMORY_SLICE = `
  SELECT importance, live, COUNT(*) AS cnt, SUM(len) AS len, SUM(tags_len) AS tags_len, SUM(files_len) AS files_len, MAX(r) AS last
  FROM (SELECT rowid AS r, importance, trashed_at IS NULL AS live, LENGTH(content) AS len,
               CASE WHEN tags IS NOT NULL AND tags != '[]' THEN LENGTH(tags) ELSE 0 END AS tags_len,
               CASE WHEN related_files IS NOT NULL AND related_files != '[]' THEN LENGTH(related_files) ELSE 0 END AS files_len
        FROM memories WHERE rowid > ? ORDER BY rowid LIMIT ?)
  GROUP BY importance, live`;

const CHUNK_SLICE = `
  SELECT COUNT(*) AS count, MAX(r) AS last, COUNT(summary_len) AS summaries, SUM(summary_len) AS summary_len, SUM(details_len) AS details_len
  FROM (SELECT rowid AS r, LENGTH(summary) AS summary_len,
               COALESCE(LENGTH(tools_used), 0) + COALESCE(LENGTH(files_modified), 0) + COALESCE(LENGTH(related_memory_ids), 0) AS details_len
        FROM session_chunks WHERE rowid > ? ORDER BY rowid LIMIT ?)`;

/** CAST(AVG(x) AS INTEGER) from the sum and the count of the values that were not NULL; NULL when there were none. */
const average = (sum, count) => (count > 0 ? Math.trunc(Number(sum) / count) : null);

// Between two slices the event loop gets a turn of its own. A slice the reader served already gave it one; a slice
// that ran on the caller's connection (the reader's fallback) resolved in the same turn, and the next one would
// follow it at once: the whole scan in one turn again, a slice at a time.
const turn = () => new Promise((resolve) => { setImmediate(resolve); });

/** Memories that are not in the trash, by importance: the old GROUP BY, slice by slice. */
async function memoryRows(read, sliceRows) {
  const groups = new Map();
  for (let after = 0; ;) {
    const slice = await read(MEMORY_SLICE, [after, sliceRows]);
    let seen = 0;
    for (const row of slice) {
      seen += row.cnt;
      after = Math.max(after, row.last);
      if (!row.live) continue;
      const group = groups.get(row.importance) ?? { cnt: 0, len: 0, tags_len: 0, files_len: 0 };
      group.cnt += row.cnt; group.len += Number(row.len ?? 0); group.tags_len += row.tags_len; group.files_len += row.files_len;
      groups.set(row.importance, group);
    }
    if (seen < sliceRows) break;
    await turn();
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([importance, group]) => ({
    importance, cnt: group.cnt,
    avg_len: average(group.len, group.cnt), avg_tags_len: average(group.tags_len, group.cnt), avg_files_len: average(group.files_len, group.cnt),
  }));
}

/** Count and average lengths of every session chunk: the old single aggregate, slice by slice. */
async function chunkStats(read, sliceRows) {
  const total = { count: 0, summaries: 0, summary_len: 0, details_len: 0 };
  for (let after = 0; ;) {
    const [slice] = await read(CHUNK_SLICE, [after, sliceRows]);
    if (!slice?.count) break;
    total.count += slice.count; total.summaries += slice.summaries;
    total.summary_len += slice.summary_len ?? 0; total.details_len += slice.details_len ?? 0;
    after = slice.last;
    if (slice.count < sliceRows) break;
    await turn();
  }
  return { count: total.count, avg_summary_len: average(total.summary_len, total.summaries), avg_details_len: average(total.details_len, total.count) };
}

/**
 * @param {{
 *   read?: (sql: string, params: any[]) => Promise<object[]>,  one read-only statement, off this thread
 *   store?: () => object,   the open store's connection; throws while the store is closed or migrating
 *   sliceRows?: number, freshMs?: number, now?: () => number,
 * }} [options]
 */
export function createRecallImpact({ read = readRows, store = getDb, sliceRows = 1000, freshMs = 60_000, now = Date.now } = {}) {
  let kept = null;   // { connection, data, at }: the last answer, for the connection it was read for
  let flight = null; // { connection, promise }: the read under way

  async function load() {
    const rows = await memoryRows(read, sliceRows);
    // A store without the table answers zeros, as the route always did; a store that closed meanwhile does not.
    let sessionStats = { count: 0, avg_summary_len: 0, avg_details_len: 0 };
    try { sessionStats = await chunkStats(read, sliceRows); }
    catch (error) { if (isMemoryStoreRefusal(error)) throw error; }
    return { rows, sessionStats };
  }

  /** `{ rows, sessionStats }` as the route answers it. Rejects with the store's refusal while it is closed. */
  async function get() {
    const connection = store();
    if (kept && kept.connection === connection && now() - kept.at < freshMs) return kept.data;
    if (flight?.connection !== connection) {
      const started = { connection, promise: null };
      started.promise = load()
        .then((data) => { if (flight === started) kept = { connection, data, at: now() }; return data; })
        .finally(() => { if (flight === started) flight = null; });
      flight = started;
    }
    return flight.promise;
  }

  return { get, forget() { kept = null; } };
}

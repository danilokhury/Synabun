// What the page's first memory list (`GET /api/memories?links=false`) depends on, as one short string, and
// the ETag made from it.
//
// The 3D map asks for every memory on every load: about 32 MB of JSON for 24,000 memories. Answering meant
// reading every row, building every node and serialising all of it, half a second of the server doing
// nothing else, right when the page also wants its style sheet and four hundred modules; and that was done
// even when the browser already held the very same answer, because only the finished body said whether it
// had changed. The stamp says it first, from two small queries: a page that still holds the list gets
// `304 Not Modified` before a single row is read.
//
// The stamp changes whenever the answer would:
//  - `memory_changes` (filled by triggers on the memories table, whoever writes: this server, an MCP server,
//    a hook) has a row for every insert and delete and for every update of a column the list carries, the
//    trash included;
//  - the three columns no trigger watches are read straight from the table: the number of live memories,
//    the sum of access counts and the newest `accessed_at` / `updated_at` (a recall changes those and
//    nothing else).
// A stamp that cannot be made (an older database, a busy one) is null: the route then answers as it always
// did.

import { createHash } from 'node:crypto';

const CHANGE_SEQ = "SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_changes WHERE entity IN ('memories', 'memory_filters')";
const LIVE_ROWS = "SELECT COUNT(*) AS n, COALESCE(SUM(access_count), 0) AS accesses, COALESCE(MAX(accessed_at), '') AS accessed, "
  + "COALESCE(MAX(updated_at), '') AS updated FROM memories WHERE trashed_at IS NULL";

/**
 * The stamp of the live memories in `db` (a node:sqlite database), or null when it cannot be read.
 * @param {{ prepare(sql: string): { get(): any } }} db
 */
export function memoryListStamp(db) {
  try {
    const { seq } = db.prepare(CHANGE_SEQ).get();
    const row = db.prepare(LIVE_ROWS).get();
    return [seq, row.n, row.accesses, row.accessed, row.updated].join('|');
  } catch {
    return null;
  }
}

/**
 * The ETag of a memory list: the stamp plus whatever else shapes the answer (the slim form, the bridge's
 * nodes). Weak: it names what the answer is made from, not its bytes. null when any part is unknown.
 * @param {Array<string | number | boolean | null | undefined>} parts
 */
export function memoryListEtag(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.some((part) => part === null || part === undefined)) return null;
  return `W/"ml-${createHash('sha1').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 24)}"`;
}

/** Does an `If-None-Match` header name this ETag? Weak comparison (RFC 9110): a `W/` prefix is ignored. */
export function etagMatches(header, etag) {
  if (!header || !etag) return false;
  const bare = (value) => String(value).trim().replace(/^W\//, '');
  const wanted = bare(etag);
  return String(header).split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || bare(value) === wanted;
  });
}

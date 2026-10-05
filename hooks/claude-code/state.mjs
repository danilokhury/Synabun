import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getDataHome } from '../../lib/paths.js';

let depth = 0;

// A single small coordination database serializes the short file updates,
// including updates to the same session by different hook processes. SQLite
// releases the lock on process death: no PID leases or stale marker cleanup.
// This database contains no memories or event receipts. Do not await network
// work while holding it. The JSON files remain the public state interface.
export function withStateLock(update, { timeoutMs = 1500 } = {}) {
  if (depth) return update();
  const dir = join(getDataHome(), 'data');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'hook-state-lock.sqlite'));
  try {
    const waitMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 1500;
    db.exec(`PRAGMA busy_timeout = ${waitMs}; BEGIN IMMEDIATE`);
    depth++;
    try {
      const result = update();
      if (result?.then) throw new Error('Hook state transactions must be synchronous');
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally { depth--; }
  } finally { db.close(); }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or not created */ }
  }
}

export function updateJsonState(file, update, initial, lockOptions) {
  return withStateLock(() => {
    let state;
    try { state = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error; // Never overwrite unreadable state.
      state = initial === undefined ? undefined : structuredClone(initial);
    }
    const next = update(state);
    if (next === null) {
      try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else if (next !== undefined) writeJsonAtomic(file, next);
    return next;
  }, lockOptions);
}

export function compactionSourceRef(sessionId, generation) {
  return `synabun-compaction:${sessionId}:${generation}`;
}

export function clearCompaction(sessionId, sourceRef) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId || '')) return;
  const file = join(getDataHome(), 'data', 'pending-compact', `${sessionId}.json`);
  return updateJsonState(file, flag => {
    if (!flag || (flag.session_id && flag.session_id !== sessionId)) return;
    // Legacy flags have no generation: clear only this session's legacy file.
    if (!flag.generation || sourceRef === compactionSourceRef(sessionId, flag.generation)) return null;
  });
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// SQLITE_DB_PATH is honored only when it resolves to a file that exists: the
// repo's .env ships a stale path, and silently reading an empty database would
// make every plan look unstored.
function memoryDbPath() {
  const configured = process.env.SQLITE_DB_PATH;
  if (configured && existsSync(configured)) return configured;
  return join(getDataHome(), 'mcp-data/memory.db');
}

// A plan is identified by its TEXT, never by the file it happens to sit in.
// post-plan.mjs only ever sees SynaBun's own copy under
// data/plans/<date>/<slug>.md, while stop.mjs reads Claude Code's
// ~/.claude/plans/<slug>-<random>.md out of the transcript. A path-derived key
// meant neither hook could ever recognize the other's write, so post-plan stored
// the plan and stop.mjs still demanded it — forever, one duplicate per attempt.
export function planMemoryKey(project, content) {
  return 'plan:' + sha256(JSON.stringify([project, sha256(content)]));
}

// Authoritative answer to "is this plan already in memory?".
// memory_metadata.content_hash is sha256(content), written by the same writer
// post-plan.mjs uses, so this sees post-plan's write regardless of which path
// either hook was looking at. Any error returns `false`, leaving the verdict to
// the receipt check below: the cost of a database hiccup is one recoverable nag
// for a plan that was in fact stored, never a genuinely lost plan going unnoticed.
export function planStoredInDb(project, content) {
  // Trailing-newline tolerance, measured not theoretical: the ExitPlanMode
  // payload ends in "\n" while a plan file written by the agent does not, so the
  // two hooks can hash strings that differ by exactly one byte. Matching any of
  // the three spellings costs one extra index-free comparison.
  const trimmed = content.replace(/\s+$/, '');
  const candidates = [...new Set([content, trimmed, `${trimmed}\n`])].map(sha256);
  let db;
  try {
    db = new DatabaseSync(memoryDbPath(), { readOnly: true });
    return !!db.prepare(`SELECT 1 AS ok FROM memory_metadata md JOIN memories m ON m.id = md.memory_id
      WHERE md.content_hash IN (${candidates.map(() => '?').join(',')})
        AND m.project = ? AND m.category LIKE 'plans-%' AND m.trashed_at IS NULL
      LIMIT 1`).get(...candidates, project);
  } catch { return false; }
  finally { db?.close(); }
}

/**
 * Category of a live memory, read-only; null for a malformed id, a missing or
 * trashed memory, or any database error. post-remember uses it to tell a
 * `reflect` on a communication-style memory (which satisfies user learning)
 * from a reflect on anything else. Call it outside withStateLock.
 */
export function memoryCategory(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(typeof id === 'string' ? id : '')) return null;
  let db;
  try {
    const path = memoryDbPath();
    if (!existsSync(path)) return null;
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare('SELECT category FROM memories WHERE id=? AND trashed_at IS NULL').get(id);
    return row && row.category ? String(row.category) : null;
  } catch { return null; }
  finally { db?.close(); }
}

// Older hook trackers lacked a hash. Verify those UUIDs against the database
// instead of trusting a filename or a pre-emptive "pending-remember" marker.
//
// `strict` guards BASENAME lookups: Claude Code reuses one plan file path across
// re-plans within a session, so a stale basename receipt must not suppress a
// different plan. Lookups by the content key pass `strict: false` — that key
// already encodes the content, and demanding a byte-identical contentHash there
// is what made the Stop nag impossible to clear (the agent is shown a truncated
// excerpt, so its `remember` never hashes the same).
export function planReceiptMatches(receipt, project, content, { strict = true } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(receipt?.memoryId || '')) return false;
  if (receipt.project && receipt.project !== project) return false;
  if (receipt.contentHash === sha256(content)) return true;
  if (strict && receipt.contentHash) return false;
  let db;
  try {
    db = new DatabaseSync(memoryDbPath(), { readOnly: true });
    const row = db.prepare('SELECT content, project, category FROM memories WHERE id=? AND trashed_at IS NULL')
      .get(receipt.memoryId);
    if (!row || row.project !== project) return false;
    if (row.content === content) return true;
    // Non-strict: a live plan memory filed under this plan's own identity key.
    // The agent stored it in its own words; accept that. An obligation the agent
    // cannot possibly discharge is worse than a paraphrase.
    return !strict && String(row.category || '').startsWith('plans-');
  } catch { return false; }
  finally { db?.close(); }
}

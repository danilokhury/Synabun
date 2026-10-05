// ── What SynaBun itself keeps about a Claude Code session ──
// deleteSession (the Agent SDK) removes the transcript. SynaBun holds four more
// records keyed by the same id: the per-session cost row, the indexed chunks,
// the session list / search cache, and the panel's rendered snapshot. A deleted
// session must not leave them behind. The host passes one function per record
// (server.js owns the stores); a step that fails is reported and never stops
// the others, and none of them can undo the delete that already happened.

import { isSessionId } from './path-confine.js';

/**
 * @param o.steps { name: (sessionId) => any } one function per record to drop
 * @param o.log   (message) => void
 * @returns (sessionId) => { name: 'ok' | 'failed: …' }
 */
export function createSessionCleanup({ steps = {}, log = () => {} } = {}) {
  const entries = Object.entries(steps).filter(([, fn]) => typeof fn === 'function');
  return function cleanupSession(sessionId) {
    const report = {};
    if (!isSessionId(sessionId)) return report;
    for (const [name, fn] of entries) {
      try { fn(sessionId); report[name] = 'ok'; }
      catch (err) {
        report[name] = `failed: ${err?.message || err}`;
        try { log(`[claude-session] cleanup of ${name} for ${sessionId} failed: ${err?.message || err}`); } catch {}
      }
    }
    return report;
  };
}

/** The steps of a cleanup report that failed (their names), in order. */
export function cleanupFailures(report) {
  if (!report || typeof report !== 'object') return [];
  return Object.entries(report).filter(([, v]) => typeof v === 'string' && v.startsWith('failed')).map(([k]) => k);
}

/** Drop the per-session cost row. The month's totals stay: the money was spent. */
export function dropSessionCost(data, sessionId) {
  if (!data?.sessionCosts || !(sessionId in data.sessionCosts)) return false;
  delete data.sessionCosts[sessionId];
  return true;
}

/**
 * Drop the rows derived from one session in memory.db: its indexed chunks and
 * its session list / search cache entries. Memories are never touched.
 * A table that does not exist is nothing to drop (session_chunks belongs to the
 * MCP server's schema: absent on a store that never indexed). Any other
 * database error is thrown after every table was tried, with what was dropped
 * in `partial`: rows left behind are a failed cleanup, not a clean one.
 * @param db a node:sqlite database handle
 */
export function deleteSessionRows(db, sessionId, provider) {
  const out = { chunks: 0, cache: 0, fts: 0 };
  if (!isSessionId(sessionId)) return out;
  const failures = [];
  const drop = (key, table, sql, ...params) => {
    try { out[key] = Number(db.prepare(sql).run(...params).changes) || 0; }
    catch (err) {
      const message = String(err?.message || err);
      if (/no such table/i.test(message)) return;
      failures.push(`${table}: ${message}`);
    }
  };
  drop('chunks', 'session_chunks', 'DELETE FROM session_chunks WHERE session_id = ?', sessionId);
  drop('fts', 'session_fts', 'DELETE FROM session_fts WHERE session_id = ? AND provider = ?', sessionId, provider);
  drop('cache', 'session_cache', 'DELETE FROM session_cache WHERE session_id = ? AND provider = ?', sessionId, provider);
  if (failures.length) throw Object.assign(new Error(failures.join('; ')), { partial: out });
  return out;
}

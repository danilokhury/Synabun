// ═══════════════════════════════════════════
// SynaBun — Assistant judgments (Jev tokens of a task)
// ═══════════════════════════════════════════
//
// The usage ledger (assistant-usage.js) counts the Jev judgments a task caused
// as one more agent. It asks a SYNC function for them and freezes the answer
// of a closed task, so the first read has to be the real one: the reader opens
// its own read-only handle on the memory database and sums `typesafe_log`,
// which is indexed by session_id (well under a millisecond).
//
// Node built-ins only. Never writes, never migrates, never throws.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const CACHE_TTL_MS = 5000;
const CACHE_MAX = 500;
const BUSY_TIMEOUT_MS = 50;

/**
 * The file the judgment log is written to: the live handle's own main database
 * when there is one, else the configured path the way getDbPath resolves it
 * (SQLITE_DB_PATH wins while its folder exists, then the default).
 * @param {object} options
 * @param {() => object} [options.getDb] the process's live handle (node:sqlite DatabaseSync)
 * @param {string} [options.defaultPath]
 * @param {object} [options.env]
 */
export function judgmentDbPath({ getDb = null, defaultPath = '', env = process.env } = {}) {
  try {
    const file = getDb?.()?.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
    if (file) return String(file);
  } catch {}
  const envPath = env?.SQLITE_DB_PATH;
  if (envPath && existsSync(dirname(envPath))) return String(envPath);
  return String(defaultPath || '');
}

/**
 * The ledger's `judgments` function.
 *   ({ sessionId, taskId, runIds, sinceMs, untilMs }) → { input, output, calls, costUsd } | null
 * Sums the judgment-log rows of the assistant session, the task's runs and
 * those runs' provider sessions, inside the task's window [sinceMs, untilMs).
 * Only real calls count: a cache hit cost nothing and a failed call returned
 * nothing. costUsd is those tokens at Jev's rates (`rates`, $ per million
 * input / output tokens; 0 without them). One answer per task is kept for 5 s.
 * null when the log cannot be read; the failure is logged once.
 * @param {object} options
 * @param {() => string} options.dbPath the memory database (asked on every read: it can move)
 * @param {(runId: string) => ({ providerSessionId?: string } | null)} [options.runInfo]
 * @param {() => ({ input?: number, output?: number } | null)} [options.rates] asked on every read (a live knob)
 * @param {(event: string, detail: string) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createJudgmentReader({ dbPath, runInfo = () => null, rates = () => null, log = () => {}, now = Date.now } = {}) {
  const cache = new Map(); // session + task → { at, key, value }
  let failed = false;

  function fail(error) {
    if (failed) return;
    failed = true;
    try { log('assistant:judgments-error', error?.message || String(error)); } catch {}
  }

  function read(ids, sinceMs, untilMs) {
    const path = typeof dbPath === 'function' ? dbPath() : dbPath;
    if (!path) throw new Error('no memory database path');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      // A writer holding the file must not hold the server thread.
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const row = db.prepare(`SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COUNT(*) AS calls
        FROM typesafe_log
        WHERE session_id IN (${ids.map(() => '?').join(',')}) AND created_at >= ? AND created_at < ?
          AND COALESCE(cached, 0) = 0 AND error IS NULL`).get(...ids, new Date(sinceMs).toISOString(), new Date(untilMs).toISOString());
      return { input: Number(row?.input) || 0, output: Number(row?.output) || 0, calls: Number(row?.calls) || 0 };
    } finally {
      try { db.close(); } catch {}
    }
  }

  return function judgments({ sessionId, taskId, runIds = [], sinceMs = 0, untilMs = null } = {}) {
    try {
      const at = now();
      const runs = Array.isArray(runIds) ? runIds.filter(Boolean).map(String) : [];
      const providerIds = runs.map((runId) => { try { return runInfo(runId)?.providerSessionId || null; } catch { return null; } });
      const ids = [...new Set([sessionId, ...runs, ...providerIds].filter(Boolean).map(String))];
      if (!ids.length) return null;
      const since = Number(sinceMs) > 0 ? Number(sinceMs) : 0;
      // An open window ends now: the key leaves it open so the 5 s answer is reused.
      const until = Number(untilMs) > 0 ? Number(untilMs) : null;
      const slot = `${sessionId}\n${taskId}`;
      const key = JSON.stringify([ids, since, until]);
      const cached = cache.get(slot);
      if (cached && cached.key === key && at - cached.at < CACHE_TTL_MS) return cached.value;
      const counted = read(ids, since, until ?? at + 1);
      let rate = null;
      try { rate = rates() || null; } catch { rate = null; }
      const perMillion = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
      const value = { ...counted, costUsd: Number(((counted.input * perMillion(rate?.input) + counted.output * perMillion(rate?.output)) / 1e6).toFixed(8)) };
      cache.delete(slot);
      cache.set(slot, { at, key, value });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return value;
    } catch (error) {
      fail(error);
      return null;
    }
  };
}

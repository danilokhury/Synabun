import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

/** Acquire the WAL writer without sleeping in SQLite on the event loop. Only
 * acquisition is retried. The synchronous callback and its commit run once,
 * in the same turn, with the connection's original timeout restored. */
export async function withMemoryWrite<T>(db: DatabaseSync, write: () => T): Promise<T> {
  const timeout = Number(db.prepare('PRAGMA busy_timeout').get()!.timeout);
  const deadline = performance.now() + timeout;
  for (;;) {
    let busy = false;
    db.exec('PRAGMA busy_timeout = 0');
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if ((Number((error as { errcode?: number }).errcode) & 0xff) !== 5 || performance.now() >= deadline) throw error;
      busy = true;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
    if (!busy) break;
    await delay(Math.min(5, Math.max(1, deadline - performance.now())));
  }
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // A constraint with ON CONFLICT ROLLBACK can already have ended the transaction.
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original SQLite error. */ }
    throw error;
  }
}

/**
 * For writes nobody waits on (diagnostic rows, outcome notes) that callers make synchronously. Writes at once when
 * the WAL writer is free, exactly as a plain run() would. When another connection holds it (the session-cache worker
 * capturing a transcript), the write is retried through withMemoryWrite() in the background instead of sleeping in
 * SQLite's busy handler on the event loop for up to busy_timeout.
 * Returns the write's result when it ran now, undefined when it was deferred or failed. Never throws.
 */
export function writeNowOrSoon<T>(db: DatabaseSync, write: () => T, onDeferred?: (later: Promise<T | undefined>) => void): T | undefined {
  // Inside the caller's own transaction there is no lock to take: write as before.
  if (db.isTransaction) { try { return write(); } catch { return undefined; } }
  let began = false;
  try {
    const timeout = Number(db.prepare('PRAGMA busy_timeout').get()!.timeout);
    db.exec('PRAGMA busy_timeout = 0');
    try { db.exec('BEGIN IMMEDIATE'); began = true; }
    catch (error) { if ((Number((error as { errcode?: number }).errcode) & 0xff) !== 5) return undefined; }
    finally { db.exec(`PRAGMA busy_timeout = ${timeout}`); }
  } catch { return undefined; }
  if (began) {
    try { const result = write(); db.exec('COMMIT'); return result; }
    catch { try { db.exec('ROLLBACK'); } catch { /* ended already */ } return undefined; }
  }
  const later = withMemoryWrite(db, write).catch(() => undefined);
  onDeferred?.(later);
  return undefined;
}

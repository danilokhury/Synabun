// ═══════════════════════════════════════════
// SynaBun — one rules writer per data home
// ═══════════════════════════════════════════
//
// Two SynaBun servers can share one data home (two ports, a dev checkout next
// to an installed release). Every change the rules installer makes runs inside
// one critical section per data home, held by the operating system:
//
//   <dataHome>/data/rulesets-lock.db
//
// is an empty SQLite database, and a write transaction on it (BEGIN IMMEDIATE)
// is the lock. Nothing is ever written to it: the transaction is rolled back to
// leave. SQLite keeps that lock as an OS file lock, so it goes away with the
// process that held it, however the process ended. There is no stale state to
// clean up, and nothing here looks at pids or ages: a holder that is suspended
// keeps the lock, and everyone else times out (BUSY).
//
// The binding is `node:sqlite`, the one the Neural Interface already loads for
// the memory store (server.js, lib/db.js). The journal mode stays the default
// (never WAL) and the locking mode stays normal (never EXCLUSIVE).
//
// NOTHING ELSE MAY EVER OPEN, READ, COPY OR BACK UP THAT FILE. On POSIX a
// process loses every lock it holds on a file the moment it closes any
// descriptor on that file, so a second look at it from inside the server (a
// backup that streams it, a checksum, a copy) can silently drop the lock while
// a writer is still inside. SQLite's own connections are safe from that; plain
// file access is not. lib/backup-service.js skips the file by name, and a
// restore never extracts it (lib/system-restore.js): both read LOCK_FILE_NAME
// through LOCK_ONLY_DATA_FILES of backup-service.js.
//
// The file can still be deleted or replaced under a running server (a restore,
// a cleanup tool, the user). A connection that stayed on the old, unlinked file
// would lock something nobody else looks at, and two processes would each
// believe they hold the lock. So the connection remembers which file it is on
// (device and inode, by stat alone: never by opening the file a second time)
// and checks the path against that before and after every BEGIN IMMEDIATE: a
// path that leads to another file, or to none, means a new connection.

import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_LOCK_TIMEOUT_MS = 2000;
/** The lock file's name inside <dataHome>/data. Spelled here and nowhere else. */
export const LOCK_FILE_NAME = 'rulesets-lock.db';

const SQLITE_BUSY = 5;

function lockError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.retryable = code === 'BUSY';
  if (cause) error.cause = cause;
  return error;
}

function isBusy(error) {
  // The primary result code: extended codes (SQLITE_BUSY_SNAPSHOT, ...) keep it in the low byte.
  return (Number(error?.errcode) & 0xff) === SQLITE_BUSY || /database is locked/i.test(String(error?.errstr || error?.message || ''));
}

/**
 * The writer lock at `path`. `enter()` returns once this process holds it, or
 * throws: BUSY when another holder kept it for `timeoutMs`, or when the lock
 * file kept being replaced while it was taken (retryable), and
 * LOCK_UNAVAILABLE when the lock file cannot be opened, is not an SQLite
 * database (an empty file is one), or is one in WAL mode. A valid database
 * that holds something is accepted: nothing is ever read from it or written
 * to it. Either way the caller must change nothing. `leave()`
 * gives it back. One connection, opened on the first `enter()` and kept for as
 * long as `path` still leads to the file it is on. `afterBegin` runs right
 * after the lock was taken, before the file is checked again (a seam for tests).
 */
export function createWriterLock(path, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, afterBegin = null } = {}) {
  const wait = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : DEFAULT_LOCK_TIMEOUT_MS;
  let db = null;
  let file = null; // which file the connection is on: "<dev>:<ino>"
  let held = false;

  /** The file `path` leads to right now, as "<dev>:<ino>", or null when there is none. By stat alone. */
  function identity() {
    try {
      const info = statSync(path, { bigint: true });
      return `${info.dev}:${info.ino}`;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    }
  }
  function close() {
    const handle = db;
    db = null;
    file = null;
    held = false;
    try { handle?.close(); } catch { /* closed already */ }
  }
  function open() {
    if (db) return db;
    mkdirSync(dirname(path), { recursive: true });
    const before = identity();
    const handle = new DatabaseSync(path);
    try {
      handle.exec(`PRAGMA busy_timeout=${wait}`);
      const mode = handle.prepare('PRAGMA journal_mode').get()?.journal_mode;
      if (String(mode).toLowerCase() === 'wal') throw new Error('it is in WAL mode, which SynaBun never sets');
      file = identity();
      // A file that was there before the open and is another one after it was replaced in between: which of the
      // two this connection is on cannot be told by stat, so it is not used.
      if (file === null || (before !== null && before !== file)) throw Object.assign(new Error('the lock file was replaced while it was being opened'), { moved: true });
    } catch (error) {
      file = null;
      try { handle.close(); } catch { /* nothing to close */ }
      throw error;
    }
    db = handle;
    return db;
  }
  function unavailable(cause) {
    return lockError('LOCK_UNAVAILABLE', `SynaBun could not use its rules lock (${path}): ${cause?.message || cause}. Nothing was changed.`, cause);
  }

  function enter() {
    if (held) throw lockError('LOCK_UNAVAILABLE', `The rules lock (${path}) is already held by this installer.`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      let handle;
      try {
        // Deleted or replaced since this connection was opened: it is on a file nobody else locks. It holds no
        // transaction here, so it is simply dropped and a new one is opened on the file that is there now.
        if (db && identity() !== file) close();
        handle = open();
      } catch (cause) {
        close();
        if (cause?.moved) continue; // replaced under the open itself: once more, then BUSY
        throw unavailable(cause);
      }
      try {
        handle.exec('BEGIN IMMEDIATE');
      } catch (cause) {
        if (isBusy(cause)) throw lockError('BUSY', 'Another SynaBun process is working on the rules right now, so nothing was changed. Try again in a moment.', cause);
        close(); // not a lock this connection can use: the next call opens it afresh
        throw unavailable(cause);
      }
      let same = false;
      try {
        if (afterBegin) afterBegin(path);
        // Replaced between the look above and the lock: what was just locked is the old file. Give it back.
        same = identity() === file;
      } catch (cause) {
        try { handle.exec('ROLLBACK'); } catch { /* closed below either way */ }
        close();
        throw unavailable(cause);
      }
      if (same) {
        held = true;
        return;
      }
      try { handle.exec('ROLLBACK'); } catch { /* closed below either way */ }
      close();
    }
    throw lockError('BUSY', 'The rules lock file was replaced while SynaBun was taking it, so nothing was changed. Try again in a moment.');
  }
  function leave() {
    if (!held) return;
    held = false;
    // A rollback that fails leaves the connection in doubt: closing it gives the lock back for certain.
    try { db.exec('ROLLBACK'); } catch { close(); }
  }

  return { path, timeoutMs: wait, enter, leave, close };
}

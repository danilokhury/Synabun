/**
 * The safety copy a memory schema migration is made behind, and who may make it.
 *
 * 2026-11-21, migration v8 on a 2.6 GB store: every process that started ran `VACUUM INTO memory.db.pre-v8-….bak`
 * by itself, on its own thread, before anything serialized them. 13 processes wrote 23.4 GB in 41 minutes; 12 of them
 * were stopped by their MCP clients (the server could not answer `initialize` while it copied) and left a partial
 * `.bak` with a `.bak-journal` that nothing ever removed. This module is what stands in front of that now:
 *
 *   one copy       a lock held by the operating system, an empty SQLite file beside the database
 *                  (`<db>.migrate-lock`, taken with BEGIN IMMEDIATE; nothing is ever stored in it, and SQLite keeps
 *                  a 512-byte `-journal` beside it while it is held, which the next holder clears when the last one
 *                  was killed). It is released when its holder ends, however it ends, so there is no owner record
 *                  to go stale and no pid to be reused. Never delete that file: a process that waits on the old one
 *                  and a process that creates a new one would both hold "the" lock (the sweep below still spares a
 *                  file whose writer is alive, and a copy that lost its file fails its check: nothing is migrated).
 *   whole or not   the copy is written as `<db>.pre-v<N>-<ms>-<pid>.bak.partial`, read back (journal gone, SQLite
 *                  header, quick_check, the tables it must hold), flushed, and only then renamed to `….bak`. A name
 *                  that ends in `.bak` with no journal beside it is a complete copy.
 *   leftovers      whoever holds the lock removes every `.partial` and every copy of the old naming that still has
 *                  its `.bak-journal`, when the process its name carries is provably gone. A complete copy, a copy
 *                  `memory_migrations` names, and a file whose writer may be alive are left alone, and the log says
 *                  which and why.
 *   room           the copy is not started unless the disk has room for it plus a margin.
 *
 * Node built-ins only, on purpose: the migration worker (memory-migration-worker.ts) loads this file as it is.
 */
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type MemoryMigrationErrorCode =
  | 'MEMORY_MIGRATION_NO_SPACE'
  | 'MEMORY_MIGRATION_BUSY'
  | 'MEMORY_MIGRATION_COPY_FAILED'
  | 'MEMORY_MIGRATION_LOCK_UNAVAILABLE';

/** A migration that was not started, or was stopped before the schema changed. The database is as it was. */
export class MemoryMigrationError extends Error {
  readonly code: MemoryMigrationErrorCode;
  constructor(code: MemoryMigrationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'MemoryMigrationError';
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export type MigrationLog = (line: string) => void;
export const defaultMigrationLog: MigrationLog = line => console.error(`[SynaBun] memory migration: ${line}`);

/** How long a process waits for another one's copy and migration before it gives up (the database is then as it was). */
export const LOCK_WAIT_MS = 30 * 60_000;
const LOCK_POLL_MS = 200;
const LOCK_NOTE_EVERY_MS = 15_000;
/** Room asked for beyond the copy itself: a tenth of it, and never less than this. */
export const MIN_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
/** A complete copy nobody recorded (its maker ended before the migration committed) is used again while this fresh. */
export const REUSE_COPY_MAX_AGE_MS = 10 * 60_000;

const mb = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MB`;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isBusy = (error: unknown) => (Number((error as { errcode?: number })?.errcode) & 0xff) === 5;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

// --- The lock ---

export const migrationLockPath = (dbPath: string) => `${dbPath}.migrate-lock`;

export interface MigrationLock { readonly path: string; release(): void }

/** Which file `file` leads to right now ("<dev>:<ino>"), or null when there is none. */
function identity(file: string): string | null {
  try { const info = fs.statSync(file, { bigint: true }); return `${info.dev}:${info.ino}`; }
  catch { return null; }
}

/**
 * The migration lock of `dbPath`, when nobody holds it; null when another connection does (this process's too).
 * Throws LOCK_UNAVAILABLE when the lock file cannot be used at all: the caller must then change nothing.
 */
export function tryMigrationLock(dbPath: string): MigrationLock | null {
  const lockPath = migrationLockPath(dbPath);
  const unavailable = (cause: unknown) => new MemoryMigrationError('MEMORY_MIGRATION_LOCK_UNAVAILABLE',
    `The memory database was not upgraded: its migration lock (${lockPath}) cannot be used: ${reason(cause)}. Nothing was changed.`, cause);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = identity(lockPath);
    let handle: DatabaseSync;
    try { handle = new DatabaseSync(lockPath); } catch (cause) { throw unavailable(cause); }
    try {
      handle.exec('PRAGMA busy_timeout = 0');
      handle.exec('BEGIN IMMEDIATE');
    } catch (cause) {
      try { handle.close(); } catch { /* nothing to close */ }
      if (isBusy(cause)) return null;
      throw unavailable(cause);
    }
    // Replaced or removed between the open and the lock: what was just locked is a file nobody else will look at.
    const after = identity(lockPath);
    if (after !== null && (before === null || before === after)) {
      let held = true;
      return {
        path: lockPath,
        release() {
          if (!held) return;
          held = false;
          try { handle.exec('ROLLBACK'); } catch { /* the close below lets go of it either way */ }
          try { handle.close(); } catch { /* closed already */ }
        },
      };
    }
    try { handle.exec('ROLLBACK'); } catch { /* closed next */ }
    try { handle.close(); } catch { /* closed already */ }
  }
  return null;
}

export interface LockWait {
  timeoutMs?: number;
  pollMs?: number;
  /** Asked between attempts: false ends the wait with null (the holder did the work). */
  stillNeeded?: () => boolean;
  log?: MigrationLog;
}

/**
 * The migration lock, waited for. Null when `stillNeeded` turned false while another process held it. Throws BUSY
 * when the holder kept it for `timeoutMs`. The wait sleeps on the calling thread: servers call this from the
 * migration worker (sqlite.ts ensureDatabase), never from the thread that answers requests.
 */
export function acquireMigrationLock(dbPath: string, { timeoutMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS, stillNeeded, log = defaultMigrationLog }: LockWait = {}): MigrationLock | null {
  const started = Date.now();
  let told = 0;
  for (;;) {
    const lock = tryMigrationLock(dbPath);
    if (lock) return lock;
    if (stillNeeded && !stillNeeded()) return null;
    const waited = Date.now() - started;
    if (waited >= timeoutMs) {
      throw new MemoryMigrationError('MEMORY_MIGRATION_BUSY',
        `The memory database was not upgraded: another SynaBun process has been upgrading it for more than ${Math.round(waited / 1000)} s. ` +
        'This process made no copy and changed nothing. Start it again once the other one is done.');
    }
    if (!told || Date.now() - told >= LOCK_NOTE_EVERY_MS) {
      told = Date.now();
      log(`another SynaBun process is copying or upgrading ${path.basename(dbPath)}; waiting for it (no second copy is made)`);
    }
    sleepSync(pollMs);
  }
}

// --- Names ---

interface CopyName { file: string; version: number; ms: number; pid: number; partial: boolean; suffix: '' | '-journal' | '-wal' | '-shm' }

/** `<db>.pre-v<N>-<ms>-<pid>.bak`, its `.partial`, and what SQLite puts beside either; null for any other name. */
function parseCopyName(dbPath: string, name: string): CopyName | null {
  const match = new RegExp(`^${escapeRe(path.basename(dbPath))}\\.pre-v(\\d+)-(\\d+)-(\\d+)\\.bak(\\.partial)?(-journal|-wal|-shm)?$`).exec(name);
  if (!match) return null;
  return { file: path.join(path.dirname(dbPath), name), version: Number(match[1]), ms: Number(match[2]), pid: Number(match[3]), partial: Boolean(match[4]), suffix: (match[5] ?? '') as CopyName['suffix'] };
}

function listCopyNames(dbPath: string): CopyName[] {
  let names: string[];
  try { names = fs.readdirSync(path.dirname(dbPath)); } catch { return []; }
  const prefix = `${path.basename(dbPath)}.pre-v`;
  return names.filter(name => name.startsWith(prefix)).map(name => parseCopyName(dbPath, name)).filter((entry): entry is CopyName => entry !== null);
}

/** True when the folder holds something sweepInterruptedCopies might remove (a cheap look, no lock needed). */
export function hasInterruptedCopies(dbPath: string): boolean {
  return listCopyNames(dbPath).some(entry => entry.partial || entry.suffix === '-journal');
}

// --- Leftovers ---

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as { code?: string })?.code === 'EPERM'; }
}

/** When process `pid` started, in ms, or null when that cannot be read (Windows, a sandbox that refuses ps). */
function pidStartedMs(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    if (out.status !== 0 || !out.stdout) return null;
    const at = Date.parse(out.stdout.trim());
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}

export interface SweepOptions {
  /** The `backup` values of memory_migrations: a file one of them names is never removed. */
  recorded?: Iterable<string>;
  log?: MigrationLog;
  isAlive?: (pid: number) => boolean;
  startedMs?: (pid: number) => number | null;
}
export interface SweepResult { removed: string[]; kept: Array<{ file: string; why: string }> }

/**
 * Remove what interrupted copies left beside `dbPath`. ONLY while holding the migration lock: that is what says no
 * current build is writing a `.partial`. A `.partial`, and a copy of the old naming (`….bak` with a `….bak-journal`
 * beside it, written in place by a build from before the lock), is removed when the process its name carries is
 * gone, or is another process that started after the copy did (a reused pid). Nothing else is touched: no complete
 * copy, no copy `memory_migrations` names, no file whose writer cannot be shown to be gone (a pid that is in use
 * where `ps` cannot be asked: it stays, and the log says so at every start).
 */
export function sweepInterruptedCopies(dbPath: string, { recorded = [], log = defaultMigrationLog, isAlive = pidAlive, startedMs = pidStartedMs }: SweepOptions = {}): SweepResult {
  const result: SweepResult = { removed: [], kept: [] };
  const named = new Set([...recorded].filter(Boolean).map(value => path.basename(String(value))));
  const entries = listCopyNames(dbPath);
  const remove = (file: string) => {
    try { fs.rmSync(file, { force: true }); result.removed.push(file); }
    catch (error) { result.kept.push({ file, why: `could not be removed: ${reason(error)}` }); }
  };
  const copyOf = (entry: CopyName) => entry.file.slice(0, entry.file.length - entry.suffix.length);
  // Is the process a name carries provably not writing that file any more? This process is not (it holds the lock and
  // is here, not copying). A pid nobody has is not. A pid somebody has is the writer only when that process was
  // already running when the name was made: the writer was. Each pid is asked once.
  const alive = new Map<number, boolean>();
  const starts = new Map<number, number | null>();
  const writerGone = (entry: CopyName): boolean => {
    if (entry.pid === process.pid) return true;
    if (!alive.has(entry.pid)) alive.set(entry.pid, isAlive(entry.pid));
    if (!alive.get(entry.pid)) return true;
    if (!starts.has(entry.pid)) starts.set(entry.pid, startedMs(entry.pid));
    const started = starts.get(entry.pid) ?? null;
    return started !== null && started > entry.ms + 5000;
  };

  // Partial copies. The lock already says nobody is writing one; the pid in the name is asked as well, so that a
  // lock file somebody deleted under its holder (two "holders") still costs no file that is being written.
  const keptPartials = new Set<string>();
  for (const entry of entries) {
    if (!entry.partial) continue;
    const copy = copyOf(entry);
    if (named.has(path.basename(copy)) || named.has(path.basename(copy).replace(/\.partial$/, ''))) { result.kept.push({ file: entry.file, why: 'memory_migrations names it' }); continue; }
    if (!writerGone(entry)) {
      if (!keptPartials.has(copy)) { keptPartials.add(copy); result.kept.push({ file: copy, why: `process ${entry.pid}, which was writing it, may still be running` }); }
      continue;
    }
    remove(entry.file);
  }
  for (const journal of entries) {
    if (journal.partial || journal.suffix !== '-journal') continue;
    const copy = copyOf(journal);
    if (named.has(path.basename(copy))) { result.kept.push({ file: journal.file, why: 'it lies beside a copy memory_migrations names' }); continue; }
    if (!writerGone(journal)) { result.kept.push({ file: copy, why: `process ${journal.pid}, which was writing it, may still be running` }); continue; }
    if (fs.existsSync(copy)) remove(copy);
    remove(journal.file);
  }
  if (result.removed.length) log(`removed ${result.removed.length} file(s) an interrupted copy left behind: ${result.removed.map(file => path.basename(file)).join(', ')}`);
  for (const kept of result.kept) log(`left ${path.basename(kept.file)} in place: ${kept.why}`);
  return result;
}

// --- Room ---

export interface SpaceOptions {
  /** Free bytes of the folder's disk for an unprivileged process; null when it cannot be told. */
  freeBytes?: (dir: string) => number | null;
}

function diskFreeBytes(dir: string): number | null {
  try {
    const info = fs.statfsSync(dir, { bigint: true });
    return Number(info.bavail * info.bsize);
  } catch { return null; }
}

/**
 * Refuse a copy the disk has no room for. The copy is at most the database and its write-ahead log; the margin on top
 * (a tenth, at least 64 MB) is for the migration's own writes and for everything else that uses the disk meanwhile.
 * A disk whose free space cannot be read is not held against the migration: the copy itself then fails cleanly if it
 * does not fit (makeVerifiedCopy removes what it wrote).
 */
export function assertRoomForCopy(dbPath: string, { freeBytes = diskFreeBytes }: SpaceOptions = {}): { needed: number; margin: number; free: number | null } {
  const size = (file: string) => { try { return fs.statSync(file).size; } catch { return 0; } };
  const needed = size(dbPath) + size(`${dbPath}-wal`);
  const margin = Math.max(MIN_SPACE_MARGIN_BYTES, Math.ceil(needed / 10));
  const dir = path.dirname(dbPath);
  const free = freeBytes(dir);
  if (free !== null && free < needed + margin) {
    throw new MemoryMigrationError('MEMORY_MIGRATION_NO_SPACE',
      `The memory database was not upgraded: there is no room for its safety copy. The copy needs about ${mb(needed)} plus a ${mb(margin)} margin, ` +
      `and ${mb(free)} are free in ${dir}. Nothing was copied and nothing was changed; free ${mb(needed + margin - free)} and start SynaBun again.`);
  }
  return { needed, margin, free };
}

// --- The copy ---

/** Throws with the reason when `file` is not a complete, readable SQLite database holding `tables`. */
export function verifyCopy(file: string, tables: readonly string[] = []): void {
  if (fs.existsSync(`${file}-journal`)) throw new Error('its rollback journal is still there (the copy did not finish)');
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('it is not an SQLite database');
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const check = String(Object.values(copy.prepare('PRAGMA quick_check(1)').get() ?? {})[0]);
    if (check !== 'ok') throw new Error(`quick_check answered ${check}`);
    const present = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
    const missing = tables.filter(table => !present.has(table));
    if (missing.length) throw new Error(`it lacks the table(s) ${missing.join(', ')}`);
  } finally { copy.close(); }
}

function flush(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export interface CopyOptions {
  /** Tables the copy must hold to count as one of this database. */
  tables?: readonly string[];
  log?: MigrationLog;
  now?: () => number;
  /** Test seam: called with the partial file once it is written and before it is checked and published. */
  written?: (partial: string) => void;
}

/**
 * Copy the database `d` (open on `dbPath`) and return the published copy's path. ONLY while holding the migration
 * lock. VACUUM INTO writes a consistent copy that includes committed WAL pages. It is written under a `.partial`
 * name, so a process that ends anywhere before the rename leaves a name the next sweep removes, never a `.bak`.
 */
export function makeVerifiedCopy(d: DatabaseSync, dbPath: string, version: number, { tables = [], log = defaultMigrationLog, now = Date.now, written }: CopyOptions = {}): string {
  const published = `${dbPath}.pre-v${version}-${now()}-${process.pid}.bak`;
  const partial = `${published}.partial`;
  const discard = () => { for (const suffix of ['', '-journal', '-wal', '-shm']) { try { fs.rmSync(partial + suffix, { force: true }); } catch { /* the next sweep removes it */ } } };
  const started = Date.now();
  try {
    if (fs.existsSync(published) || fs.existsSync(partial)) throw new Error(`${path.basename(published)} already exists`);
    d.prepare('VACUUM INTO ?').run(partial);
    written?.(partial);
    verifyCopy(partial, tables);
    flush(partial);
    fs.renameSync(partial, published);
  } catch (error) {
    discard();
    if (error instanceof MemoryMigrationError) throw error;
    throw new MemoryMigrationError('MEMORY_MIGRATION_COPY_FAILED',
      `The memory database was not upgraded: its safety copy could not be made (${reason(error)}). What was written of it was removed and nothing was changed.`, error);
  }
  try { const dir = fs.openSync(path.dirname(published), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* not every system flushes a folder */ }
  let size = 0;
  try { size = fs.statSync(published).size; } catch { /* reported without its size */ }
  log(`copied ${path.basename(dbPath)} to ${path.basename(published)} (${mb(size)}, ${((Date.now() - started) / 1000).toFixed(1)} s), checked`);
  return published;
}

export interface ReuseOptions {
  recorded?: Iterable<string>;
  tables?: readonly string[];
  maxAgeMs?: number;
  log?: MigrationLog;
  now?: () => number;
  /**
   * What the database holds, as one comparable value (null: it cannot be told). With `current`, a copy is used only
   * when it answers the same as the database does now: a copy from before a later write is not the copy of what is
   * about to be migrated.
   */
  position?: (database: DatabaseSync) => string | null;
  /** The open database the copy must match (with `position`). */
  current?: DatabaseSync;
}

/**
 * A complete copy for `version` that no migration recorded, that is still fresh, and that holds what the database
 * holds now: its maker ended between publishing it and committing the migration (or a build from before the lock
 * made it and lost the race). Using it is what keeps a process that dies at that step from costing a second copy.
 * A copy that fails any of this is left where it is (it is complete) and another is made. ONLY while holding the
 * migration lock.
 */
export function findReusableCopy(dbPath: string, version: number, { recorded = [], tables = [], maxAgeMs = REUSE_COPY_MAX_AGE_MS, log = defaultMigrationLog, now = Date.now, position, current }: ReuseOptions = {}): string | null {
  const named = new Set([...recorded].filter(Boolean).map(value => path.basename(String(value))));
  const at = now();
  const candidates = listCopyNames(dbPath)
    .filter(entry => !entry.partial && entry.suffix === '' && entry.version === version && !named.has(path.basename(entry.file)))
    .filter(entry => entry.ms <= at + 60_000 && at - entry.ms <= maxAgeMs)
    .sort((a, b) => b.ms - a.ms);
  if (!candidates.length) return null;
  let wanted: string | null = null;
  if (position && current) {
    try { wanted = position(current); } catch { wanted = null; }
    if (wanted === null) {
      log(`${candidates.map(entry => path.basename(entry.file)).join(', ')}: not used as the safety copy, because what the database holds now cannot be compared with it; another copy is made`);
      return null;
    }
  }
  for (const entry of candidates) {
    const name = path.basename(entry.file);
    try { verifyCopy(entry.file, tables); }
    catch (error) { log(`${name} is not used as the safety copy: ${reason(error)}`); continue; }
    if (position && current) {
      let held: string | null = null;
      try {
        const copy = new DatabaseSync(entry.file, { readOnly: true });
        try { held = position(copy); } finally { copy.close(); }
      } catch { held = null; }
      if (held === null || held !== wanted) {
        log(`${name} is not used as the safety copy: the database was written to after it was made. It is complete and stays where it is; another copy is made`);
        continue;
      }
    }
    log(`using ${path.basename(entry.file)}, a complete copy made ${Math.round((at - entry.ms) / 1000)} s ago that no migration recorded, instead of making another`);
    return entry.file;
  }
  return null;
}

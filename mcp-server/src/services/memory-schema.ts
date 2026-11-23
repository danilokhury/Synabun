import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  MemoryMigrationError, acquireMigrationLock, assertRoomForCopy, defaultMigrationLog, findReusableCopy, hasInterruptedCopies,
  makeVerifiedCopy, sweepInterruptedCopies, tryMigrationLock,
  type MigrationLock, type MigrationLog, type SpaceOptions, type SweepOptions,
} from './memory-migration-copy.js';

// Published migration numbers are immutable. Later additions must run even if
// an earlier build already marked its own schema version complete.
// `optional`: this build reads and writes correctly without it (an index, nothing it selects by name). Only such a
// migration is put off when its safety copy cannot be made for lack of disk space; any other stops the open.
const migrations: Array<{ version: number; apply: (d: DatabaseSync) => void; optional?: boolean }> = [
  { version: 2, apply: migrateV2 },
  { version: 3, apply: migrateV3 },
  { version: 4, apply: migrateV4 },
  { version: 5, apply: migrateV5 },
  { version: 6, apply: migrateV6 },
  { version: 7, apply: migrateV7 },
  { version: 8, apply: migrateV8, optional: true },
];

/** What a database of this store holds: a file without them is not a copy of it. */
const COPY_TABLES = ['memories', 'session_chunks'] as const;

export interface MigrateMemoryOptions extends SpaceOptions, Pick<SweepOptions, 'isAlive' | 'startedMs'> {
  log?: MigrationLog;
  /** How long to wait for another process that is copying or migrating (default 30 minutes). */
  lockTimeoutMs?: number;
  now?: () => number;
  /** Test seam: called on the migrating thread as each step of a copied migration is reached. */
  step?: (step: 'locked' | 'written' | 'published' | 'applied', file?: string) => void;
  /**
   * Put optional migrations off without looking: no lock, no copy, no log line. For the thread of a server whose
   * migration worker already answered that they wait (sqlite.ts getDb): it must not start the copy itself.
   */
  deferOptional?: boolean;
  /**
   * This thread never makes the copy (sqlite.ts setMemoryMigrationHost: a host migrates the store elsewhere). What is
   * still pending and cannot be put off is refused, with the database as it was.
   */
  neverCopy?: boolean;
}

export interface MigrateMemoryResult {
  /** The versions this call applied. */
  applied: number[];
  /** The safety copy they were applied behind; null when none was needed (an empty or in-memory store). */
  backup: string | null;
  /** Optional versions left for a later start, with the reason (no room for the copy, another process at it, a failure). */
  deferred?: { versions: number[]; reason: string };
}

const optionalOnly = (versions: number[]) => versions.length > 0 && versions.every(version => migrations.find(migration => migration.version === version)?.optional === true);

/** The versions `d` has not applied, in order. Creates nothing: a store without the record has applied none. */
export function pendingMemoryMigrations(d: DatabaseSync): number[] {
  let applied: Set<number>;
  try { applied = new Set(d.prepare('SELECT version FROM memory_migrations').all().map(row => Number(row.version))); }
  catch { applied = new Set(); }
  return migrations.filter(migration => !applied.has(migration.version)).map(migration => migration.version);
}

/** True when `d` holds memories or session evidence, or ever migrated: migrating it needs a safety copy first. */
export function memoryStorePopulated(d: DatabaseSync): boolean {
  try { if (d.prepare('SELECT 1 FROM memory_migrations LIMIT 1').get()) return true; }
  catch { /* no record yet */ }
  try { return Boolean(d.prepare('SELECT EXISTS(SELECT 1 FROM memories) OR EXISTS(SELECT 1 FROM session_chunks) AS populated').get()?.populated); }
  catch { return false; }
}

const recordedCopies = (d: DatabaseSync) => d.prepare('SELECT backup FROM memory_migrations WHERE backup IS NOT NULL').all().map(row => String(row.backup));

/**
 * What a store holds, as one value a copy can be compared by: where its change journal stands (every insert, update
 * and delete of a memory, a session chunk or a passage moves it: the triggers of v2), how many of each there are, and
 * which migrations it has. Null for a store without the journal (from before v2): nothing says what it holds.
 */
function storePosition(d: DatabaseSync): string | null {
  try {
    if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_changes'").get()) return null;
    const journal = Number(d.prepare("SELECT seq FROM sqlite_sequence WHERE name='memory_changes'").get()?.seq ?? 0);
    const counts = d.prepare('SELECT (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM session_chunks) AS chunks').get();
    const versions = d.prepare('SELECT version FROM memory_migrations ORDER BY version').all().map(row => Number(row.version));
    return JSON.stringify([journal, Number(counts?.memories), Number(counts?.chunks), versions]);
  } catch { return null; }
}

/**
 * Additive migrations. Triggers also cover legacy/direct SQL writers.
 *
 * A populated store is migrated only behind a complete, checked copy of itself, and across every process on the
 * machine one process makes that copy (memory-migration-copy.ts): this call takes the migration lock. The lock is held
 * from the copy to the commit; a holder that ends anywhere in between gives it up with its process, and the next one
 * removes its unfinished copy or uses its finished one. BEGIN IMMEDIATE still serializes the DDL itself, also against
 * builds from before the lock.
 *
 * A process that finds the lock held makes no copy. What it does then depends on what is pending:
 *   - a migration this build needs: it waits (lockTimeoutMs, 30 minutes by default), then finds nothing left to do,
 *     or takes over when the holder ended without finishing;
 *   - only `optional` ones (indexes): it does not wait. They are put off (`deferred`), the store is used on the
 *     schema it has, and the holder applies them for everybody.
 *
 * Synchronous: it holds its thread for as long as the copy takes. A server calls ensureDatabase() (sqlite.ts), which
 * runs this on the migration worker; a script or a test may call it directly.
 *
 * Throws MemoryMigrationError, with the database as it was, when a migration this build needs cannot be made: the
 * copy has no room (NO_SPACE), cannot be made or checked (COPY_FAILED), the lock cannot be used (LOCK_UNAVAILABLE),
 * or another process kept it too long (BUSY). When everything pending is optional none of these stops the open, and
 * neither does a failure of the migration itself (it is rolled back): they are put off, with the reason.
 */
export function migrateMemory(d: DatabaseSync, dbPath: string, options: MigrateMemoryOptions = {}): MigrateMemoryResult {
  const log = options.log ?? defaultMigrationLog;
  d.exec('CREATE TABLE IF NOT EXISTS memory_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, backup TEXT)');
  const onDisk = dbPath !== ':memory:';
  const sweep = () => sweepInterruptedCopies(dbPath, { recorded: recordedCopies(d), log, isAlive: options.isAlive, startedMs: options.startedMs });
  if (!pendingMemoryMigrations(d).length) {
    // Nothing to migrate: still the moment to remove what an interrupted copy left, unless somebody is migrating now.
    if (onDisk && hasInterruptedCopies(dbPath)) {
      let lock: MigrationLock | null = null;
      try { lock = tryMigrationLock(dbPath); }
      catch (error) { log(`what interrupted copies left was not looked at: ${error instanceof Error ? error.message : error}`); }
      if (lock) {
        try { sweep(); }
        catch (error) { log(`what interrupted copies left was not removed: ${error instanceof Error ? error.message : error}`); }
        finally { lock.release(); }
      }
    }
    return { applied: [], backup: null };
  }
  if (!onDisk || !memoryStorePopulated(d)) return { applied: applyPending(d, null), backup: null };

  /** Leave what is pending (all of it optional) for a later start. */
  const putOff = (why: string, quiet = false): MigrateMemoryResult => {
    const versions = pendingMemoryMigrations(d);
    if (!versions.length) return { applied: [], backup: null };
    const reason = `${why} Migration(s) ${versions.join(', ')} only add indexes: the store is used as it is and they are tried again at the next start.`;
    if (!quiet) log(reason);
    return { applied: [], backup: null, deferred: { versions, reason } };
  };
  const optional = optionalOnly(pendingMemoryMigrations(d));
  if (optional && options.deferOptional) return putOff('Put off earlier in this process.', true);
  if (options.neverCopy) {
    throw new MemoryMigrationError('MEMORY_MIGRATION_COPY_FAILED',
      `The memory database was not opened: migration(s) ${pendingMemoryMigrations(d).join(', ')} are pending and are not made on this thread. Nothing was changed.`);
  }

  let lock: MigrationLock | null;
  try {
    lock = optional
      ? tryMigrationLock(dbPath)
      : acquireMigrationLock(dbPath, { timeoutMs: options.lockTimeoutMs, log, stillNeeded: () => pendingMemoryMigrations(d).length > 0 });
  } catch (error) {
    if (optional && error instanceof MemoryMigrationError) return putOff(error.message);
    throw error;
  }
  // Held by another process. A needed migration was waited for and is applied now; an optional one is not waited for.
  if (!lock) return optional ? putOff('Another SynaBun process is copying or upgrading the memory database; this one makes no copy and does not wait for it.') : { applied: [], backup: null };
  try {
    const pending = pendingMemoryMigrations(d);
    if (!pending.length) return { applied: [], backup: null };
    options.step?.('locked');
    sweep();
    let backup = findReusableCopy(dbPath, pending[0], { recorded: recordedCopies(d), tables: COPY_TABLES, log, now: options.now, position: storePosition, current: d });
    if (!backup) {
      assertRoomForCopy(dbPath, { freeBytes: options.freeBytes });
      backup = makeVerifiedCopy(d, dbPath, pending[0], { tables: COPY_TABLES, log, now: options.now, written: file => options.step?.('written', file) });
    }
    options.step?.('published', backup);
    const applied = applyPending(d, backup);
    options.step?.('applied', backup);
    if (applied.length) log(`applied migration(s) ${applied.join(', ')} to ${dbPath}; the copy from before is ${backup}`);
    else log(`${backup} was not needed: another process applied the migration meanwhile. It is a complete copy and was left in place.`);
    return { applied, backup: applied.length ? backup : null };
  } catch (error) {
    // The database is as it was: the copy is made beside it, and a migration that fails is rolled back.
    if (!optionalOnly(pendingMemoryMigrations(d))) throw error;
    return putOff(error instanceof MemoryMigrationError ? error.message : `The memory database was not upgraded: ${error instanceof Error ? error.message : error}. Nothing was changed.`);
  } finally { lock.release(); }
}

/** Apply what is still pending, in one transaction, and record each version with `backup`. Returns what it applied. */
function applyPending(d: DatabaseSync, backup: string | null): number[] {
  const applied: number[] = [];
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of migrations) {
      if (d.prepare('SELECT 1 FROM memory_migrations WHERE version = ?').get(migration.version)) continue;
      migration.apply(d);
      d.prepare('INSERT INTO memory_migrations(version,applied_at,backup) VALUES(?,?,?)')
        .run(migration.version, new Date().toISOString(), backup);
      applied.push(migration.version);
    }
    d.exec('COMMIT');
  } catch (error) { d.exec('ROLLBACK'); throw error; }
  return applied;
}

const columns = ['content','category','subcategory','project','tags','importance','source','created_at','updated_at',
  'accessed_at','access_count','related_files','related_memory_ids','file_checksums','trashed_at','source_session_chunks'];
const payload = (alias: string) => `json_object(${columns.map(c => `'${c}',${alias}.${c}`).join(',')})`;

function migrateV2(d: DatabaseSync): void {
    d.exec(`
      CREATE TABLE memory_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, id TEXT NOT NULL);
      CREATE INDEX memory_changes_entity ON memory_changes(entity, seq);
      CREATE INDEX idx_memory_project_lower ON memories(lower(project));
      CREATE INDEX idx_chunk_project_lower ON session_chunks(lower(project));
      CREATE TABLE memory_revisions (memory_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
        vector BLOB NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(memory_id, revision));
      CREATE TABLE memory_metadata (memory_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'note',
        source_ref TEXT, content_hash TEXT, idempotency_key TEXT, project TEXT, category TEXT, request_hash TEXT,
        verification TEXT, verified_revision INTEGER, checked_at TEXT);
      CREATE UNIQUE INDEX memory_idempotency ON memory_metadata(project, category, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE memory_relations (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('duplicate_of','supersedes','conflicts_with','possible_conflict','similar')),
        automatic INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        UNIQUE(from_id, to_id, kind));
      CREATE INDEX memory_relations_from ON memory_relations(from_id, active);
      CREATE INDEX memory_relations_to ON memory_relations(to_id, active);
      CREATE TABLE memory_feedback (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE memory_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL, UNIQUE(kind, entity_id));
      CREATE TABLE memory_passages (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        position INTEGER NOT NULL, content TEXT NOT NULL, vector BLOB NOT NULL, model TEXT NOT NULL);
      CREATE INDEX memory_passages_parent ON memory_passages(memory_id);
      CREATE TABLE memory_session_sources (host TEXT NOT NULL, session_id TEXT NOT NULL, source_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, chunk_id TEXT NOT NULL, PRIMARY KEY(host, session_id, source_id));
      CREATE TABLE memory_capture_files (host TEXT NOT NULL, session_id TEXT NOT NULL, file_path TEXT NOT NULL,
        project TEXT NOT NULL, cwd TEXT, byte_offset INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
        error TEXT, PRIMARY KEY(host,session_id));
      CREATE VIRTUAL TABLE memory_search USING fts5(id UNINDEXED, content, category, project, tags, files, tokenize='unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE chunk_search USING fts5(id UNINDEXED, content, summary, project, files, tokenize='unicode61 remove_diacritics 2');
    `);
    // Repair the old external-content index and keep it valid for old readers.
    d.exec(`DROP TABLE memories_fts;
      CREATE VIRTUAL TABLE memories_fts USING fts5(content,category,project,tags,content=memories,content_rowid=rowid,tokenize='porter unicode61');
      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
      INSERT INTO memory_search SELECT id,content,category,project,tags,related_files FROM memories WHERE trashed_at IS NULL;
      INSERT INTO chunk_search SELECT id,content,summary,project,files_modified FROM session_chunks;
      INSERT INTO memory_revisions SELECT m.id,1,${payload('m')},m.vector,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM memories m;
      INSERT INTO memory_jobs(id,kind,entity_id,updated_at) SELECT 'index:'||id,'index',id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM memories;
    `);
    installMemoryTriggers(d);
}

/** Repair stores opened by early v2 builds, without replaying their migration. */
function migrateV3(d: DatabaseSync): void {
  const metadataColumns = new Set(d.prepare('PRAGMA table_info(memory_metadata)').all().map(row => String(row.name)));
  for (const [name, type] of Object.entries({ request_hash: 'TEXT', verification: 'TEXT', verified_revision: 'INTEGER', checked_at: 'TEXT' })) {
    if (!metadataColumns.has(name)) d.exec(`ALTER TABLE memory_metadata ADD COLUMN ${name} ${type}`);
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS memory_capture_files (host TEXT NOT NULL, session_id TEXT NOT NULL, file_path TEXT NOT NULL,
      project TEXT NOT NULL, cwd TEXT, byte_offset INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      error TEXT, PRIMARY KEY(host,session_id));
    CREATE INDEX IF NOT EXISTS idx_memory_project_lower ON memories(lower(project));
    CREATE INDEX IF NOT EXISTS idx_chunk_project_lower ON session_chunks(lower(project));
  `);
  // Early retry keys predate request_hash. Recover the original request from
  // its first revision, since later indexing may have replaced content_hash.
  const retryRequests = d.prepare(`SELECT md.memory_id, COALESCE((
    SELECT json_extract(r.payload,'$.content') FROM memory_revisions r
    WHERE r.memory_id=md.memory_id ORDER BY r.revision LIMIT 1),m.content) AS content
    FROM memory_metadata md JOIN memories m ON m.id=md.memory_id
    WHERE md.idempotency_key IS NOT NULL AND md.request_hash IS NULL`).all();
  const updateHash = d.prepare('UPDATE memory_metadata SET request_hash=? WHERE memory_id=?');
  for (const row of retryRequests) {
    updateHash.run(createHash('sha256').update(String(row.content)).digest('hex'), row.memory_id);
  }
  installMemoryTriggers(d);
  // A running client may already have cached filters before these triggers
  // existed. Invalidate that epoch once, without touching content or vectors.
  d.exec("INSERT INTO memory_changes(entity,id) VALUES('memory_filters','schema:3')");
}

/**
 * Room for TypeSafe's judgments beside the stored values, never replacing them.
 * The caller's stated importance stays authoritative in `memories.importance`;
 * `importance_judged` records what the model would have said, so agreement can
 * be measured on real data before anything starts trusting it.
 */
function migrateV4(d: DatabaseSync): void {
  const metadataColumns = new Set(d.prepare('PRAGMA table_info(memory_metadata)').all().map(row => String(row.name)));
  for (const [name, type] of Object.entries({
    importance_judged: 'REAL', importance_confidence: 'REAL',
    kind_judged: 'TEXT', kind_confidence: 'REAL', judged_at: 'TEXT',
  })) {
    if (!metadataColumns.has(name)) d.exec(`ALTER TABLE memory_metadata ADD COLUMN ${name} ${type}`);
  }
}

/**
 * A log of every TypeSafe judgment (bounded by the writer, see
 * typesafe-config.ts), the jobs index the judge backfill needs, room for the
 * category check beside the other judged columns, and the duplicate_of
 * direction repair. Nothing here touches stored content or vectors.
 */
function migrateV5(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS typesafe_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      surface TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'live',
      entity_id TEXT,
      model TEXT,
      question_count INTEGER,
      state_preview TEXT,
      answers TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached INTEGER DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_typesafe_log_created ON typesafe_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_typesafe_log_surface ON typesafe_log(surface, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_typesafe_log_entity ON typesafe_log(entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_kind ON memory_jobs(status, kind, updated_at);
  `);
  const metadataColumns = new Set(d.prepare('PRAGMA table_info(memory_metadata)').all().map(row => String(row.name)));
  for (const [name, type] of Object.entries({ category_judged: 'TEXT', category_confidence: 'REAL' })) {
    if (!metadataColumns.has(name)) d.exec(`ALTER TABLE memory_metadata ADD COLUMN ${name} ${type}`);
  }
  repairDuplicateDirection(d);
}

/**
 * Trash triage's expendability score beside the other judged columns, so a
 * repeat triage reads it instead of asking again; the basis fingerprints what
 * was judged, and a mismatch means ask again. The content_hash index turns the
 * exact-copy lookups (triage discovery, the index job's duplicate check) from
 * a per-row project scan into an index probe.
 */
function migrateV6(d: DatabaseSync): void {
  const metadataColumns = new Set(d.prepare('PRAGMA table_info(memory_metadata)').all().map(row => String(row.name)));
  for (const [name, type] of Object.entries({ expendability: 'REAL', expendability_at: 'TEXT', expendability_basis: 'TEXT' })) {
    if (!metadataColumns.has(name)) d.exec(`ALTER TABLE memory_metadata ADD COLUMN ${name} ${type}`);
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_memory_metadata_content_hash ON memory_metadata(content_hash)');
}

/**
 * Attribution for the judgment log (which session and project asked, which
 * riders shared the request, what the caller did with the answer), and room
 * beside each memory for the edit-time stale verdicts. Additive DDL only: old
 * rows keep NULL sessions and their `live` origin.
 */
function migrateV7(d: DatabaseSync): void {
  const logColumns = new Set(d.prepare('PRAGMA table_info(typesafe_log)').all().map(row => String(row.name)));
  for (const [name, type] of Object.entries({ session_id: 'TEXT', project: 'TEXT', surfaces: 'TEXT', outcome: 'TEXT' })) {
    if (!logColumns.has(name)) d.exec(`ALTER TABLE typesafe_log ADD COLUMN ${name} ${type}`);
  }
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_typesafe_log_session ON typesafe_log(session_id, id) WHERE session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_typesafe_log_project ON typesafe_log(project, created_at DESC) WHERE project IS NOT NULL;
  `);
  const metadataColumns = new Set(d.prepare('PRAGMA table_info(memory_metadata)').all().map(row => String(row.name)));
  for (const [name, type] of Object.entries({ stale_verdicts: 'TEXT', stale_checked_at: 'TEXT' })) {
    if (!metadataColumns.has(name)) d.exec(`ALTER TABLE memory_metadata ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Indexes for statements that ran on the server's one thread for seconds each (2026-11-21, [loop-stall] lines of
 * 0.6 to 2.8 s while a backup kept the disk busy). Each of them walked the memories table itself, whose rows carry
 * the vectors, or scanned memory_metadata from end to end. With these they read a few small index pages instead:
 *
 *   idx_mem_live          every statement that asks about the live memories only: their count, their ids
 *                         (JOIN memory_metadata ... WHERE m.trashed_at IS NULL) and the list stamp
 *                         (COUNT, SUM(access_count), MAX(accessed_at), MAX(updated_at))
 *   idx_mem_project_live  the live ids of a project (the duplicate gate before every remember)
 *   idx_memory_metadata_source_ref  the memories of one run or conversation (WHERE source_ref = ?)
 *
 * Additive: nothing is rewritten, and a build without them still reads the same answers, slower.
 */
function migrateV8(d: DatabaseSync): void {
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mem_live ON memories(trashed_at, id, access_count, accessed_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_mem_project_live ON memories(lower(project), trashed_at, id);
    CREATE INDEX IF NOT EXISTS idx_memory_metadata_source_ref ON memory_metadata(source_ref) WHERE source_ref IS NOT NULL;
  `);
}

/**
 * `duplicate_of` is directional: the NEWER memory points at the older one, so
 * a pair judged from either end collides on one row. Earlier builds relied on
 * every caller computing that direction itself; this makes stored rows match
 * the rule `setRelation` now enforces. When both directions exist, the
 * canonical row survives and inherits an explicit undo (active=0) from either
 * side; lone rows pointing the wrong way are flipped in place.
 */
export function repairDuplicateDirection(d: DatabaseSync): { collapsed: number; flipped: number } {
  const older = '(f.created_at<t.created_at OR (f.created_at=t.created_at AND f.id<t.id))';
  const newer = '(f.created_at>t.created_at OR (f.created_at=t.created_at AND f.id>t.id))';
  d.exec(`UPDATE memory_relations SET active=0 WHERE kind='duplicate_of' AND active=1 AND id IN (
    SELECT a.id FROM memory_relations a
    JOIN memory_relations b ON b.kind='duplicate_of' AND b.from_id=a.to_id AND b.to_id=a.from_id AND b.active=0
    JOIN memories f ON f.id=a.from_id JOIN memories t ON t.id=a.to_id
    WHERE a.kind='duplicate_of' AND ${newer})`);
  const collapsed = d.prepare(`DELETE FROM memory_relations WHERE kind='duplicate_of' AND id IN (
    SELECT a.id FROM memory_relations a
    JOIN memory_relations b ON b.kind='duplicate_of' AND b.from_id=a.to_id AND b.to_id=a.from_id
    JOIN memories f ON f.id=a.from_id JOIN memories t ON t.id=a.to_id
    WHERE a.kind='duplicate_of' AND ${older})`).run().changes;
  const flipped = d.prepare(`UPDATE memory_relations SET from_id=to_id, to_id=from_id WHERE kind='duplicate_of' AND id IN (
    SELECT r.id FROM memory_relations r JOIN memories f ON f.id=r.from_id JOIN memories t ON t.id=r.to_id
    WHERE r.kind='duplicate_of' AND ${older})`).run().changes;
  return { collapsed: Number(collapsed), flipped: Number(flipped) };
}

function installMemoryTriggers(d: DatabaseSync): void {
    for (const name of ['memory_insert','memory_update','memory_reindex','memory_vector_update','memory_delete']) {
      d.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    const revision = (alias: string) => `INSERT INTO memory_revisions SELECT ${alias}.id,
      COALESCE((SELECT MAX(revision) FROM memory_revisions WHERE memory_id=${alias}.id),0)+1,
      ${payload(alias)},${alias}.vector,strftime('%Y-%m-%dT%H:%M:%fZ','now');`;
    const enqueue = `INSERT INTO memory_jobs(id,kind,entity_id,updated_at) VALUES('index:'||new.id,'index',new.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(kind,entity_id) DO UPDATE SET status='pending',attempts=0,error=NULL,updated_at=excluded.updated_at;`;
    const insertSearch = `INSERT INTO memory_search(id,content,category,project,tags,files)
      SELECT new.id,new.content,new.category,new.project,new.tags,new.related_files WHERE new.trashed_at IS NULL;`;
    d.exec(`CREATE TRIGGER memory_insert AFTER INSERT ON memories BEGIN
        DELETE FROM memory_search WHERE id=new.id; ${insertSearch}
        INSERT INTO memories_fts(rowid,content,category,project,tags) VALUES(new.rowid,new.content,new.category,new.project,new.tags);
        INSERT INTO memory_changes(entity,id) VALUES('memories',new.id);
        INSERT INTO memory_changes(entity,id) VALUES('memory_filters',new.id);
        ${revision('new')} ${enqueue}
      END;
      CREATE TRIGGER memory_update AFTER UPDATE OF content,category,subcategory,project,tags,importance,source,created_at,related_files,related_memory_ids,file_checksums,trashed_at,source_session_chunks ON memories BEGIN
        DELETE FROM memory_search WHERE id=new.id; ${insertSearch}
        INSERT INTO memories_fts(memories_fts,rowid,content,category,project,tags) VALUES('delete',old.rowid,old.content,old.category,old.project,old.tags);
        INSERT INTO memories_fts(rowid,content,category,project,tags) VALUES(new.rowid,new.content,new.category,new.project,new.tags);
        INSERT INTO memory_changes(entity,id) VALUES('memory_filters',new.id);
        ${revision('new')}
      END;
      CREATE TRIGGER memory_reindex AFTER UPDATE OF content,project,category,source ON memories BEGIN ${enqueue} END;
      CREATE TRIGGER memory_vector_update AFTER UPDATE OF vector,trashed_at ON memories BEGIN
        INSERT INTO memory_changes(entity,id) VALUES('memories',new.id);
      END;
      CREATE TRIGGER memory_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memory_search WHERE id=old.id;
        INSERT INTO memories_fts(memories_fts,rowid,content,category,project,tags) VALUES('delete',old.rowid,old.content,old.category,old.project,old.tags);
        INSERT INTO memory_changes(entity,id) VALUES('memories',old.id);
        INSERT INTO memory_changes(entity,id) VALUES('memory_filters',old.id);
        DELETE FROM memory_passages WHERE memory_id=old.id;
        DELETE FROM memory_jobs WHERE entity_id=old.id;
      END;
    `);
    for (const table of ['session_chunks', 'memory_passages']) {
      for (const event of ['INSERT','UPDATE','DELETE']) {
        const alias = event === 'DELETE' ? 'old' : 'new';
        d.exec(`DROP TRIGGER IF EXISTS ${table}_${event.toLowerCase()};
          CREATE TRIGGER ${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
          INSERT INTO memory_changes(entity,id) VALUES('${table}',${alias}.id);
          ${table === 'session_chunks' ? `DELETE FROM chunk_search WHERE id=${alias}.id;
            ${event !== 'DELETE' ? 'INSERT INTO chunk_search(id,content,summary,project,files) VALUES(new.id,new.content,new.summary,new.project,new.files_modified);' : ''}` : ''}
        END;`);
      }
    }
}

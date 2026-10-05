import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Published migration numbers are immutable. Later additions must run even if
// an earlier build already marked its own schema version complete.
const migrations = [
  { version: 2, apply: migrateV2 },
  { version: 3, apply: migrateV3 },
  { version: 4, apply: migrateV4 },
  { version: 5, apply: migrateV5 },
  { version: 6, apply: migrateV6 },
  { version: 7, apply: migrateV7 },
];

/** Additive migrations. Triggers also cover legacy/direct SQL writers. */
export function migrateMemory(d: DatabaseSync, dbPath: string): void {
  d.exec('CREATE TABLE IF NOT EXISTS memory_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, backup TEXT)');
  const applied = new Set(d.prepare('SELECT version FROM memory_migrations').all().map(row => Number(row.version)));
  const pending = migrations.filter(migration => !applied.has(migration.version));
  if (!pending.length) return;
  // VACUUM INTO makes a consistent copy including committed WAL pages. Two
  // migrating processes may make backups; BEGIN IMMEDIATE serializes the DDL.
  const populated = applied.size > 0 || Boolean(d.prepare('SELECT EXISTS(SELECT 1 FROM memories) OR EXISTS(SELECT 1 FROM session_chunks) AS populated').get()?.populated);
  const backup = populated && dbPath !== ':memory:' ? `${dbPath}.pre-v${pending[0].version}-${Date.now()}-${process.pid}.bak` : null;
  if (backup) d.prepare('VACUUM INTO ?').run(backup);
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of pending) {
      if (d.prepare('SELECT 1 FROM memory_migrations WHERE version = ?').get(migration.version)) continue;
      migration.apply(d);
      d.prepare('INSERT INTO memory_migrations(version,applied_at,backup) VALUES(?,?,?)')
        .run(migration.version, new Date().toISOString(), backup);
    }
    d.exec('COMMIT');
  } catch (error) { d.exec('ROLLBACK'); throw error; }
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

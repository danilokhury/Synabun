-- Frozen schema from the early v2 build that skipped later schema additions.
-- Structural SQL only: no user data. Do not regenerate from the latest schema.

CREATE TABLE memory_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, backup TEXT);

CREATE TABLE memory_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, id TEXT NOT NULL);

CREATE TABLE memory_revisions (memory_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
        vector BLOB NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(memory_id, revision));

CREATE TABLE memory_metadata (memory_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'note',
        source_ref TEXT, content_hash TEXT, idempotency_key TEXT, project TEXT, category TEXT);

CREATE TABLE memory_relations (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('duplicate_of','supersedes','conflicts_with','possible_conflict','similar')),
        automatic INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
        UNIQUE(from_id, to_id, kind));

CREATE TABLE memory_feedback (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE memory_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL, UNIQUE(kind, entity_id));

CREATE TABLE memory_passages (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        position INTEGER NOT NULL, content TEXT NOT NULL, vector BLOB NOT NULL, model TEXT NOT NULL);

CREATE TABLE memory_session_sources (host TEXT NOT NULL, session_id TEXT NOT NULL, source_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, chunk_id TEXT NOT NULL, PRIMARY KEY(host, session_id, source_id));

CREATE VIRTUAL TABLE memory_search USING fts5(id UNINDEXED, content, category, project, tags, files, tokenize='unicode61 remove_diacritics 2');

CREATE VIRTUAL TABLE chunk_search USING fts5(id UNINDEXED, content, summary, project, files, tokenize='unicode61 remove_diacritics 2');

CREATE INDEX memory_changes_entity ON memory_changes(entity, seq);

CREATE UNIQUE INDEX memory_idempotency ON memory_metadata(project, category, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX memory_passages_parent ON memory_passages(memory_id);

CREATE INDEX memory_relations_from ON memory_relations(from_id, active);

CREATE INDEX memory_relations_to ON memory_relations(to_id, active);

CREATE TRIGGER memory_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memory_search WHERE id=old.id;
        INSERT INTO memories_fts(memories_fts,rowid,content,category,project,tags) VALUES('delete',old.rowid,old.content,old.category,old.project,old.tags);
        INSERT INTO memory_changes(entity,id) VALUES('memories',old.id);
        DELETE FROM memory_passages WHERE memory_id=old.id;
        DELETE FROM memory_jobs WHERE entity_id=old.id;
      END;

CREATE TRIGGER memory_insert AFTER INSERT ON memories BEGIN
        DELETE FROM memory_search WHERE id=new.id; INSERT INTO memory_search(id,content,category,project,tags,files)
      SELECT new.id,new.content,new.category,new.project,new.tags,new.related_files WHERE new.trashed_at IS NULL;
        INSERT INTO memories_fts(rowid,content,category,project,tags) VALUES(new.rowid,new.content,new.category,new.project,new.tags);
        INSERT INTO memory_changes(entity,id) VALUES('memories',new.id);
        INSERT INTO memory_revisions SELECT new.id,
      COALESCE((SELECT MAX(revision) FROM memory_revisions WHERE memory_id=new.id),0)+1,
      json_object('content',new.content,'category',new.category,'subcategory',new.subcategory,'project',new.project,'tags',new.tags,'importance',new.importance,'source',new.source,'created_at',new.created_at,'updated_at',new.updated_at,'accessed_at',new.accessed_at,'access_count',new.access_count,'related_files',new.related_files,'related_memory_ids',new.related_memory_ids,'file_checksums',new.file_checksums,'trashed_at',new.trashed_at,'source_session_chunks',new.source_session_chunks),new.vector,strftime('%Y-%m-%dT%H:%M:%fZ','now'); INSERT INTO memory_jobs(id,kind,entity_id,updated_at) VALUES('index:'||new.id,'index',new.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(kind,entity_id) DO UPDATE SET status='pending',attempts=0,error=NULL,updated_at=excluded.updated_at;
      END;

CREATE TRIGGER memory_passages_delete AFTER DELETE ON memory_passages BEGIN
          INSERT INTO memory_changes(entity,id) VALUES('memory_passages',old.id);

        END;

CREATE TRIGGER memory_passages_insert AFTER INSERT ON memory_passages BEGIN
          INSERT INTO memory_changes(entity,id) VALUES('memory_passages',new.id);

        END;

CREATE TRIGGER memory_passages_update AFTER UPDATE ON memory_passages BEGIN
          INSERT INTO memory_changes(entity,id) VALUES('memory_passages',new.id);

        END;

CREATE TRIGGER memory_reindex AFTER UPDATE OF content,project,category,source ON memories BEGIN INSERT INTO memory_jobs(id,kind,entity_id,updated_at) VALUES('index:'||new.id,'index',new.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(kind,entity_id) DO UPDATE SET status='pending',attempts=0,error=NULL,updated_at=excluded.updated_at; END;

CREATE TRIGGER memory_update AFTER UPDATE OF content,category,subcategory,project,tags,importance,source,related_files,related_memory_ids,file_checksums,trashed_at,source_session_chunks ON memories BEGIN
        DELETE FROM memory_search WHERE id=new.id; INSERT INTO memory_search(id,content,category,project,tags,files)
      SELECT new.id,new.content,new.category,new.project,new.tags,new.related_files WHERE new.trashed_at IS NULL;
        INSERT INTO memories_fts(memories_fts,rowid,content,category,project,tags) VALUES('delete',old.rowid,old.content,old.category,old.project,old.tags);
        INSERT INTO memories_fts(rowid,content,category,project,tags) VALUES(new.rowid,new.content,new.category,new.project,new.tags);
        INSERT INTO memory_revisions SELECT new.id,
      COALESCE((SELECT MAX(revision) FROM memory_revisions WHERE memory_id=new.id),0)+1,
      json_object('content',new.content,'category',new.category,'subcategory',new.subcategory,'project',new.project,'tags',new.tags,'importance',new.importance,'source',new.source,'created_at',new.created_at,'updated_at',new.updated_at,'accessed_at',new.accessed_at,'access_count',new.access_count,'related_files',new.related_files,'related_memory_ids',new.related_memory_ids,'file_checksums',new.file_checksums,'trashed_at',new.trashed_at,'source_session_chunks',new.source_session_chunks),new.vector,strftime('%Y-%m-%dT%H:%M:%fZ','now');
      END;

CREATE TRIGGER memory_vector_update AFTER UPDATE OF vector,trashed_at ON memories BEGIN
        INSERT INTO memory_changes(entity,id) VALUES('memories',new.id);
      END;

CREATE TRIGGER session_chunks_delete AFTER DELETE ON session_chunks BEGIN
          INSERT INTO memory_changes(entity,id) VALUES('session_chunks',old.id);
          DELETE FROM chunk_search WHERE id=old.id;

        END;

CREATE TRIGGER session_chunks_insert AFTER INSERT ON session_chunks BEGIN
          INSERT INTO memory_changes(entity,id) VALUES('session_chunks',new.id);
          DELETE FROM chunk_search WHERE id=new.id;
            INSERT INTO chunk_search(id,content,summary,project,files) VALUES(new.id,new.content,new.summary,new.project,new.files_modified);
        END;

CREATE TRIGGER session_chunks_update AFTER UPDATE ON session_chunks BEGIN
          INSERT INTO memory_changes(entity,id) VALUES('session_chunks',new.id);
          DELETE FROM chunk_search WHERE id=new.id;
            INSERT INTO chunk_search(id,content,summary,project,files) VALUES(new.id,new.content,new.summary,new.project,new.files_modified);
        END;

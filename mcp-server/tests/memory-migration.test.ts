import { describe, expect, it, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateMemory } from '../src/services/memory-schema.js';
import { getDb, closeDatabase } from '../src/services/sqlite.js';
import { maintenanceStatus } from '../src/services/memory-maintenance.js';
import { retrieveMemory } from '../src/services/memory-retrieval.js';
afterAll(()=>closeDatabase());
function legacy(path:string) {
  const d=new DatabaseSync(path);
  for(const table of ['memories','session_chunks','memories_fts'])d.exec(String(getDb().prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table)?.sql));
  d.prepare('INSERT INTO memories(id,vector,content,project,category,created_at,updated_at,accessed_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('original',new Uint8Array(384*4),'original content','project','category','2026-01-01','2026-01-01','2026-01-01');
  return d;
}
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
function earlyV2(path: string) {
  const d = legacy(path);
  d.exec(readFileSync(new URL('./fixtures/memory-v2-early.sql', import.meta.url), 'utf8'));
  d.exec(`
    INSERT INTO memory_migrations VALUES(2,'2026-09-06T04:41:27.454Z',NULL);
    INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    UPDATE memories SET content=content WHERE id='original';
    UPDATE memories SET content='edited content' WHERE id='original';
    INSERT INTO memory_metadata(memory_id,kind,source_ref,idempotency_key,project,category)
      VALUES('original','decision','old-session','retry-key','project','category');
    INSERT INTO session_chunks(id,vector,content,session_id,project)
      VALUES('original-chunk',zeroblob(1536),'session evidence','codex:old-session','project');
    INSERT INTO memory_session_sources VALUES('codex','old-session','event','source-hash','original-chunk');
  `);
  d.prepare('UPDATE memory_metadata SET content_hash=?').run(hash('edited content'));
  return d;
}
function snapshot(d: DatabaseSync) {
  return Object.fromEntries(['memories','session_chunks','memory_revisions','memory_jobs','memory_session_sources']
    .map(table => [table, d.prepare(`SELECT * FROM ${table}`).all()]));
}
describe('versioned migration',()=>{
  it('backs up a populated legacy database, preserves UUIDs and reopens idempotently',()=>{
    const dir=mkdtempSync(join(tmpdir(),'synabun-migration-'));const path=join(dir,'old.db');const d=legacy(path);
    try {
      migrateMemory(d,path);migrateMemory(d,path);
      const records=d.prepare('SELECT * FROM memory_migrations ORDER BY version').all();
      expect(records.map(row=>row.version)).toEqual([2,3,4,5,6,7]);
      expect(existsSync(String(records[0].backup))).toBe(true);
      const backup=new DatabaseSync(String(records[0].backup),{readOnly:true});
      try{expect(backup.prepare('SELECT id,content FROM memories').get()).toMatchObject({id:'original',content:'original content'});}
      finally{backup.close();}
      expect(d.prepare('SELECT memory_id,revision FROM memory_revisions').get()).toMatchObject({memory_id:'original',revision:1});
      expect(d.prepare("SELECT id FROM memory_search WHERE memory_search MATCH 'original'").get()?.id).toBe('original');
    }finally{d.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('rolls back partial schema work without modifying originals on failure',()=>{
    const dir=mkdtempSync(join(tmpdir(),'synabun-migration-failure-'));const path=join(dir,'old.db');const d=legacy(path);
    try {
      d.exec('CREATE TABLE memory_metadata(conflicting TEXT)');
      expect(()=>migrateMemory(d,path)).toThrow();
      expect(d.prepare("SELECT name FROM sqlite_master WHERE name='memory_changes'").get()).toBeUndefined();
      expect(d.prepare('SELECT content FROM memories WHERE id=?').get('original')?.content).toBe('original content');
      expect(d.prepare('SELECT * FROM memory_migrations').all()).toEqual([]);
      d.exec('DROP TABLE memory_metadata');migrateMemory(d,path);
      expect(d.prepare('SELECT version FROM memory_migrations ORDER BY version').all()).toEqual([{version:2},{version:3},{version:4},{version:5},{version:6},{version:7}]);
    }finally{d.close();rmSync(dir,{recursive:true,force:true});}
  });

  it('upgrades the early v2 schema without replaying revisions, jobs or source intake', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synabun-early-v2-'));
    const path = join(dir, 'old.db');
    const d = earlyV2(path);
    const peer = new DatabaseSync(path);
    try {
      const before = snapshot(d);
      migrateMemory(d, path);
      expect(snapshot(d)).toEqual(before);
      const migration = d.prepare('SELECT * FROM memory_migrations WHERE version=3').get()!;
      expect(String(migration.backup)).toContain('.pre-v3-');
      const backup = new DatabaseSync(String(migration.backup), {readOnly:true});
      try {
        expect(snapshot(backup)).toEqual(before);
        expect(backup.prepare('SELECT version FROM memory_migrations').all()).toEqual([{version:2}]);
      } finally { backup.close(); }
      expect(d.prepare('SELECT * FROM memory_metadata WHERE memory_id=?').get('original')).toMatchObject({
        kind:'decision', source_ref:'old-session', idempotency_key:'retry-key',
        request_hash:hash('original content'), content_hash:hash('edited content'),
        verification:null, verified_revision:null, checked_at:null,
      });
      // Connections already held by MCP/Neural Interface see transactional DDL.
      peer.prepare('INSERT INTO memory_capture_files(host,session_id,file_path,project) VALUES(?,?,?,?)')
        .run('codex','capture-session','/test/transcript.jsonl','project');
      expect(peer.prepare('SELECT byte_offset,status FROM memory_capture_files').get()).toEqual({byte_offset:0,status:'pending'});
      const epoch = () => Number(d.prepare("SELECT max(seq) AS n FROM memory_changes WHERE entity='memory_filters'").get()?.n);
      const initialEpoch = epoch();
      const revisions = d.prepare('SELECT * FROM memory_revisions').all();
      peer.exec("UPDATE memories SET access_count=access_count+1 WHERE id='original'");
      expect(epoch()).toBe(initialEpoch);
      expect(d.prepare('SELECT * FROM memory_revisions').all()).toEqual(revisions);
      peer.exec("UPDATE memories SET created_at='2026-09-07' WHERE id='original'");
      expect(epoch()).toBeGreaterThan(initialEpoch);
      expect(d.prepare("SELECT max(revision) AS n FROM memory_revisions WHERE memory_id='original'").get()?.n).toBe(3);
      expect(d.prepare("SELECT id FROM memory_search WHERE memory_search MATCH 'edited'").get()?.id).toBe('original');
      const state = snapshot(d);
      const markers = d.prepare('SELECT * FROM memory_migrations ORDER BY version').all();
      migrateMemory(peer, path);
      expect(snapshot(d)).toEqual(state);
      expect(d.prepare('SELECT * FROM memory_migrations ORDER BY version').all()).toEqual(markers);
    } finally { peer.close(); d.close(); rmSync(dir, {recursive:true, force:true}); }
  });

  it.each(['partial','complete'])('preserves %s v2 metadata and capture checkpoints', variant => {
    const dir = mkdtempSync(join(tmpdir(), 'synabun-later-v2-'));
    const path = join(dir, 'old.db');
    const d = earlyV2(path);
    try {
      d.exec(`ALTER TABLE memory_metadata ADD COLUMN request_hash TEXT;
        ALTER TABLE memory_metadata ADD COLUMN verification TEXT;
        UPDATE memory_metadata SET request_hash='saved-original-hash',verification='stale';`);
      if (variant === 'complete') {
        d.exec(`ALTER TABLE memory_metadata ADD COLUMN verified_revision INTEGER;
          ALTER TABLE memory_metadata ADD COLUMN checked_at TEXT;
          UPDATE memory_metadata SET verified_revision=2,checked_at='2026-09-06';
          CREATE INDEX idx_memory_project_lower ON memories(lower(project));
          CREATE INDEX idx_chunk_project_lower ON session_chunks(lower(project));`);
      }
      d.exec(String(getDb().prepare("SELECT sql FROM sqlite_master WHERE name='memory_capture_files'").get()?.sql));
      d.exec(`INSERT INTO memory_capture_files(host,session_id,file_path,project,byte_offset,status)
        VALUES('claude-code','old-capture','/test/claude.jsonl','project',1234,'complete');`);
      const before = snapshot(d);
      migrateMemory(d, path);
      expect(snapshot(d)).toEqual(before);
      expect(d.prepare('SELECT request_hash,verification,verified_revision,checked_at FROM memory_metadata').get()).toEqual({
        request_hash:'saved-original-hash', verification:'stale',
        verified_revision:variant === 'complete' ? 2 : null, checked_at:variant === 'complete' ? '2026-09-06' : null,
      });
      expect(d.prepare('SELECT byte_offset,status FROM memory_capture_files').get()).toEqual({byte_offset:1234,status:'complete'});
    } finally { d.close(); rmSync(dir, {recursive:true, force:true}); }
  });

  it('rolls back a failed forward migration and can retry it without losing v2 state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synabun-v3-failure-'));
    const path = join(dir, 'old.db');
    const d = earlyV2(path);
    try {
      d.exec('CREATE TABLE idx_chunk_project_lower(conflicting TEXT)');
      const before = snapshot(d);
      const columns = d.prepare('PRAGMA table_info(memory_metadata)').all();
      const triggers = d.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
      expect(() => migrateMemory(d, path)).toThrow();
      expect(snapshot(d)).toEqual(before);
      expect(d.prepare('PRAGMA table_info(memory_metadata)').all()).toEqual(columns);
      expect(d.prepare("SELECT name FROM sqlite_master WHERE name='memory_capture_files'").get()).toBeUndefined();
      expect(d.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).toEqual(triggers);
      expect(d.prepare('SELECT version FROM memory_migrations').all()).toEqual([{version:2}]);
      d.exec('DROP TABLE idx_chunk_project_lower');
      migrateMemory(d, path);
      expect(snapshot(d)).toEqual(before);
      expect(d.prepare('SELECT version FROM memory_migrations ORDER BY version').all()).toEqual([{version:2},{version:3},{version:4},{version:5},{version:6},{version:7}]);
    } finally { d.close(); rmSync(dir, {recursive:true, force:true}); }
  });

  it('repairs early v2 on normal database open before maintenance and recall', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synabun-v3-startup-'));
    const path = join(dir, 'old.db');
    earlyV2(path).close();
    const previousPath = process.env.SQLITE_DB_PATH;
    closeDatabase();
    process.env.SQLITE_DB_PATH = path;
    try {
      expect(() => maintenanceStatus()).not.toThrow();
      const result = await retrieveMemory({query:'edited content',project:'project',include_sessions:false,engine:'hybrid'},
        async () => { throw new Error('offline'); });
      expect(result.results[0].id).toBe('original');
      expect(getDb().prepare('SELECT version FROM memory_migrations ORDER BY version').all()).toEqual([{version:2},{version:3},{version:4},{version:5},{version:6},{version:7}]);
    } finally {
      closeDatabase(); process.env.SQLITE_DB_PATH = previousPath;
      rmSync(dir, {recursive:true, force:true});
    }
  });

  describe('v5', () => {
    // Re-arm v5 on a store that already ran it, so the repair can be exercised
    // against seeded rows exactly as it will run on a real v4 store.
    function v4Store(path: string) {
      const d = legacy(path);
      migrateMemory(d, path);
      d.exec(`DELETE FROM memory_migrations WHERE version=5; DROP TABLE typesafe_log;
        INSERT INTO memories(id,vector,content,project,category,created_at,updated_at,accessed_at) VALUES
          ('older',zeroblob(1536),'same fact','project','category','2026-01-01','2026-01-01','2026-01-01'),
          ('newer',zeroblob(1536),'same fact again','project','category','2026-02-01','2026-02-01','2026-02-01');`);
      return d;
    }
    const relation = (d: DatabaseSync, id: string, from: string, to: string, active = 1) =>
      d.prepare("INSERT INTO memory_relations(id,from_id,to_id,kind,automatic,active,created_at) VALUES(?,?,?,'duplicate_of',1,?,'2026-03-01')").run(id, from, to, active);

    it('creates the judgment log, the jobs index and the category columns', () => {
      const dir = mkdtempSync(join(tmpdir(), 'synabun-v5-'));
      const path = join(dir, 'old.db');
      const d = legacy(path);
      try {
        migrateMemory(d, path);
        expect(d.prepare("SELECT name FROM sqlite_master WHERE name IN ('typesafe_log','idx_typesafe_log_surface','idx_memory_jobs_status_kind') ORDER BY name").all().map(r => r.name))
          .toEqual(['idx_memory_jobs_status_kind', 'idx_typesafe_log_surface', 'typesafe_log']);
        const columns = d.prepare('PRAGMA table_info(memory_metadata)').all().map(r => String(r.name));
        expect(columns).toEqual(expect.arrayContaining(['category_judged', 'category_confidence', 'importance_judged']));
        // Reopening applies nothing twice.
        migrateMemory(d, path);
        expect(d.prepare('SELECT count(*) AS n FROM memory_migrations WHERE version=5').get()?.n).toBe(1);
      } finally { d.close(); rmSync(dir, { recursive: true, force: true }); }
    });

    it('collapses a mirrored duplicate_of pair onto newer→older and keeps an explicit undo', () => {
      const dir = mkdtempSync(join(tmpdir(), 'synabun-v5-mirror-'));
      const path = join(dir, 'old.db');
      const d = v4Store(path);
      try {
        relation(d, 'wrong-way', 'older', 'newer', 0); // the user undid the grouping from this side
        relation(d, 'right-way', 'newer', 'older', 1);
        migrateMemory(d, path);
        const rows = d.prepare("SELECT id,from_id,to_id,active FROM memory_relations WHERE kind='duplicate_of'").all();
        expect(rows).toEqual([{ id: 'right-way', from_id: 'newer', to_id: 'older', active: 0 }]);
      } finally { d.close(); rmSync(dir, { recursive: true, force: true }); }
    });

    it('flips a lone older→newer duplicate_of row in place', () => {
      const dir = mkdtempSync(join(tmpdir(), 'synabun-v5-flip-'));
      const path = join(dir, 'old.db');
      const d = v4Store(path);
      try {
        relation(d, 'lone', 'older', 'newer', 1);
        migrateMemory(d, path);
        expect(d.prepare("SELECT from_id,to_id,active FROM memory_relations WHERE id='lone'").get()).toEqual({ from_id: 'newer', to_id: 'older', active: 1 });
      } finally { d.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  });

  describe('v6', () => {
    it('adds the triage score columns and the content_hash index, once', () => {
      const dir = mkdtempSync(join(tmpdir(), 'synabun-v6-'));
      const path = join(dir, 'old.db');
      const d = legacy(path);
      try {
        migrateMemory(d, path);
        const scoreColumns = () => d.prepare('PRAGMA table_info(memory_metadata)').all().map(r => String(r.name)).filter(name => name.startsWith('expendability'));
        expect(scoreColumns()).toEqual(['expendability', 'expendability_at', 'expendability_basis']);
        expect(d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_metadata_content_hash'").get()?.name).toBe('idx_memory_metadata_content_hash');
        // Re-armed on a store that already has them, the guard skips the columns.
        d.exec('DELETE FROM memory_migrations WHERE version=6');
        migrateMemory(d, path);
        expect(d.prepare('SELECT count(*) AS n FROM memory_migrations WHERE version=6').get()?.n).toBe(1);
        expect(scoreColumns()).toHaveLength(3);
      } finally { d.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  });

  describe('v7', () => {
    it('adds judgment-log attribution and the stale verdict columns, once', () => {
      const dir = mkdtempSync(join(tmpdir(), 'synabun-v7-'));
      const path = join(dir, 'old.db');
      const d = legacy(path);
      try {
        migrateMemory(d, path);
        const logColumns = () => d.prepare('PRAGMA table_info(typesafe_log)').all().map(r => String(r.name)).filter(name => ['session_id', 'project', 'surfaces', 'outcome'].includes(name));
        const staleColumns = () => d.prepare('PRAGMA table_info(memory_metadata)').all().map(r => String(r.name)).filter(name => name.startsWith('stale_'));
        expect(logColumns()).toEqual(['session_id', 'project', 'surfaces', 'outcome']);
        expect(staleColumns()).toEqual(['stale_verdicts', 'stale_checked_at']);
        const indexes = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_typesafe_log_session','idx_typesafe_log_project') ORDER BY name").all().map(r => String(r.name));
        expect(indexes).toEqual(['idx_typesafe_log_project', 'idx_typesafe_log_session']);
        // Re-armed on a store that already has them, the guards skip the columns.
        d.exec('DELETE FROM memory_migrations WHERE version=7');
        migrateMemory(d, path);
        expect(d.prepare('SELECT count(*) AS n FROM memory_migrations WHERE version=7').get()?.n).toBe(1);
        expect(logColumns()).toHaveLength(4);
        expect(staleColumns()).toHaveLength(2);
      } finally { d.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  });

  it('backs up legacy stores that contain session evidence but no ordinary memories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synabun-session-migration-'));
    const path = join(dir, 'old.db');
    const d = legacy(path);
    try {
      d.exec("DELETE FROM memories; INSERT INTO session_chunks(id,vector,content,session_id) VALUES('session-only',zeroblob(1536),'evidence','session')");
      migrateMemory(d, path);
      const backupPath = String(d.prepare('SELECT backup FROM memory_migrations WHERE version=2').get()?.backup);
      expect(existsSync(backupPath)).toBe(true);
      const backup = new DatabaseSync(backupPath, {readOnly:true});
      try { expect(backup.prepare('SELECT id FROM session_chunks').get()?.id).toBe('session-only'); }
      finally { backup.close(); }
    } finally { d.close(); rmSync(dir, {recursive:true, force:true}); }
  });
});

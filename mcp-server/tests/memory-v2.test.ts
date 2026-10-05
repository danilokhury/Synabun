import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../src/services/local-embeddings.js',()=>({
  generateEmbedding:vi.fn(async()=>[1,0,0]), EMBEDDING_VERSION:'test:3',
  embedPassages:vi.fn(async(content:string)=>[{content,vector:[1,0,0]}]),
}));
import { getDb, getDbPath, closeDatabase, upsertMemory, updatePayload, deleteMemory, memoryVectors, scrollMemories } from '../src/services/sqlite.js';
import { retrieveMemory, compactRecall, estimateTokens, resetPassageCache } from '../src/services/memory-retrieval.js';
import { memoryRevision, undoRevision, setRelation, runMaintenanceBatch, pauseMaintenance } from '../src/services/memory-maintenance.js';
import { handleReflect } from '../src/tools/reflect.js';
import { handleRemember } from '../src/tools/remember.js';
import { runWithIdentity, obtainIdentity } from '../src/services/identity.js';
import { detectProject, projectAliases } from '../src/config.js';
import type { MemoryPayload } from '../src/types.js';
import { verifyMemorySources } from '../src/services/memory-verification.js';

function add(content:string, overrides:Partial<MemoryPayload>={}, vector=[1,0,0]) {
  const id = randomUUID();
  upsertMemory(id,vector,{content,project:'synabun',category:'development',tags:['memory'],importance:5,
    source:'self-discovered',created_at:'2026-09-01T00:00:00.000Z',updated_at:'2026-09-01T00:00:00.000Z',
    accessed_at:'2026-09-01T00:00:00.000Z',access_count:0,...overrides});
  return id;
}
const none = async()=>{throw new Error('offline');};
beforeAll(()=>getDb());
beforeEach(()=>{
  getDb().exec('DELETE FROM memories; DELETE FROM session_chunks; DELETE FROM memory_relations; DELETE FROM memory_metadata; DELETE FROM memory_revisions; DELETE FROM memory_jobs; DELETE FROM kv_config;');
  memoryVectors.invalidate(); resetPassageCache();
});
afterAll(()=>closeDatabase());

describe('transactional storage compatibility',()=>{
  it('keeps keyword indexes current for content, metadata, deletion and restoration',()=>{
    const id=add('initial', {tags:['oldtag']});
    updatePayload(id,{content:'replacement',tags:['newtag'],category:'newcategory'});
    const search=(q:string)=>getDb().prepare('SELECT id FROM memory_search WHERE memory_search MATCH ?').all(q);
    expect(search('initial')).toEqual([]);
    expect(search('oldtag')).toEqual([]);
    expect(search('replacement')).toHaveLength(1);
    expect(search('newtag')).toHaveLength(1);
    expect(getDb().prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'newcategory'").all()).toHaveLength(1);
    updatePayload(id,{trashed_at:new Date().toISOString()}); expect(search('replacement')).toEqual([]);
    updatePayload(id,{trashed_at:null}); expect(search('replacement')).toHaveLength(1);
    deleteMemory(id); expect(search('replacement')).toEqual([]);
  });
  it('revisions survive upserts and metadata edits; access counters do not create revisions',()=>{
    const id=add('v1'); updatePayload(id,{content:'v2'});
    updatePayload(id,{access_count:90}); expect(memoryRevision(id)).toBe(2);
    expect(()=>undoRevision(id,1,1)).toThrow(/conflict/);
    expect(undoRevision(id,1,2)).toBe(3);
    expect(getDb().prepare('SELECT content FROM memories WHERE id=?').get(id)?.content).toBe('v1');
  });
  it('updates vector caches incrementally across connections, ignoring access writes',()=>{
    const id=add('cached'); memoryVectors.topK([1,0,0],1,0);
    const before=memoryVectors.reloadCount;
    const other=new DatabaseSync(getDbPath());
    try {
      other.prepare('UPDATE memories SET access_count=access_count+1 WHERE id=?').run(id);
      memoryVectors.topK([1,0,0],1,0); expect(memoryVectors.reloadCount).toBe(before);
      other.prepare('UPDATE memories SET vector=? WHERE id=?').run(new Uint8Array(new Float32Array([0,1,0]).buffer),id);
      expect(memoryVectors.topK([0,1,0],1,0)[0].score).toBeCloseTo(1);
      expect(memoryVectors.reloadCount).toBe(before);
      other.prepare('UPDATE memories SET trashed_at=? WHERE id=?').run('2026-09-06',id);
      expect(memoryVectors.topK([0,1,0],1,0)).toEqual([]);
    } finally {other.close();}
  });
  it('orders recent records before limiting',async()=>{
    add('old',{created_at:'2020-01-01'}); const id=add('new',{created_at:'2026-09-06'});
    expect((await scrollMemories(undefined,1)).points[0].id).toBe(id);
  });
});
describe('retrieval and evidence budgets',()=>{
  it('never treats unrelated non-Latin project labels as aliases of an empty slug',()=>{
    const directory=join(process.env.SYNABUN_DATA_HOME!,'data');mkdirSync(directory,{recursive:true});
    const registry=join(directory,'claude-code-projects.json');
    writeFileSync(registry,JSON.stringify([{label:'日本語',path:'/tmp/japanese-project'},{label:'中文',path:'/tmp/chinese-project'}]));
    try{expect(projectAliases('日本語')).not.toContain('中文');expect(projectAliases('日本語')).not.toContain('');}
    finally{rmSync(registry);}
  });
  it('finds an exact identifier even when semantic candidates are full',async()=>{
    for(let n=0;n<12;n++)add('generic cache architecture');
    const id=add('Fix ERR_VECTOR_42 in src/cache.ts',{},[0,1,0]);
    const r=await retrieveMemory({query:'ERR_VECTOR_42',engine:'hybrid',limit:5},async()=>[1,0,0]);
    expect(r.results[0].id).toBe(id);
  });
  it('honors any/all tags and explicit project boundaries in offline fallback',async()=>{
    const a=add('sqlite cache',{tags:['one']});
    const b=add('sqlite cache',{tags:['two']});
    add('sqlite cache',{tags:['one','two'],project:'other'});
    const args={query:'sqlite',project:'SynaBun',tags:['one','two'],engine:'hybrid' as const};
    expect((await retrieveMemory(args,none)).results.map(h=>h.id).sort()).toEqual([a,b].sort());
    expect((await retrieveMemory({...args,tag_match:'all'},none)).results).toEqual([]);
    await expect(retrieveMemory({query:'sqlite',scope:'project'},none)).rejects.toThrow(/requires/);
  });
  it('retrieves sessions without any memory hits and collapses mirrored UUIDs',async()=>{
    const id=randomUUID();
    getDb().prepare('INSERT INTO session_chunks(id,vector,content,summary,session_id,project,start_timestamp) VALUES(?,?,?,?,?,?,?)')
      .run(id,new Uint8Array(new Float32Array([1,0,0]).buffer),'SQLite rollback procedure','Rollback procedure','s','synabun','2026-09-05');
    const r=await retrieveMemory({query:'SQLite rollback',include_sessions:true,engine:'hybrid'},none);
    expect(r.results[0].id).toBe(id); expect(r.results[0].type).toBe('session');
    const mirror=add('SQLite rollback procedure',{source:'auto-saved',subcategory:'session-chunk'});
    getDb().prepare('UPDATE memories SET id=? WHERE id=?').run(id,mirror);
    expect((await retrieveMemory({query:'SQLite rollback',include_sessions:true,engine:'hybrid'},none)).results.filter(h=>h.id===id)).toHaveLength(1);
    updatePayload(id,{trashed_at:new Date().toISOString()});
    expect((await retrieveMemory({query:'SQLite rollback',include_sessions:true,engine:'hybrid'},none)).results).toHaveLength(0);
  });
  it('preserves negative evidence and full UUIDs within estimated budget',async()=>{
    const id=add('Unrelated introduction.\n'.repeat(100)+'Do not enable WAL checkpoint truncation during backup.\n'+'Other notes.\n'.repeat(50));
    const r=await retrieveMemory({query:'WAL checkpoint',engine:'hybrid'},none);
    const out=compactRecall(r,'WAL checkpoint',200);
    expect(estimateTokens(out)).toBeLessThanOrEqual(200);
    expect(out).toContain(id); expect(out).toContain('Do not enable WAL');
  });
  it('never boosts an irrelevant memory solely because of many accesses',async()=>{
    add('irrelevant',{access_count:999999},[0,1,0]);
    const id=add('rollback',{access_count:0});
    const r=await retrieveMemory({query:'rollback',engine:'hybrid'},async()=>[1,0,0]);
    expect(r.results.map(h=>h.id)).toEqual([id]);
  });
  it('supports dates and surfaces conflicts without rewriting evidence',async()=>{
    const a=add('Use WAL',{created_at:'2026-01-01'}); const b=add('Do not use WAL',{created_at:'2026-09-01'});
    setRelation(a,b,'conflicts_with');
    const r=await retrieveMemory({query:'WAL',after:'2026-08-01',engine:'hybrid'},none);
    expect(r.results).toHaveLength(1); expect(r.results[0].id).toBe(b); expect(r.results[0].flags).toContain('conflicts_with');
  });
});
describe('agent writes and reversible maintenance',()=>{
  it('returns the same UUID for a retried save and rejects key reuse with different content',async()=>{
    const input={content:'retry this record',category:'development',project:'synabun',idempotency_key:'turn-123'};
    const a=await handleRemember(input); const b=await handleRemember(input);
    const id=a.content[0].text.match(/\[([0-9a-f-]+)\]/)![1];
    expect(b.content[0].text).toContain(id);
    expect((await handleRemember({...input,content:'different'})) as any).toHaveProperty('isError',true);
  });
  it('rejects stale updates without changing the stored content',async()=>{
    const id=add('original'); updatePayload(id,{content:'concurrent edit'});
    const response=await handleReflect({memory_id:id,content:'overwrite',expected_revision:1});
    expect(response).toHaveProperty('isError',true);
    expect(getDb().prepare('SELECT content FROM memories WHERE id=?').get(id)?.content).toBe('concurrent edit');
  });
  it('preserves verification baseline on metadata-only edits',async()=>{
    const id=add('verified',{file_checksums:{'/missing':'known-hash'},related_files:['/missing']});
    await handleReflect({memory_id:id,importance:7});
    expect(getDb().prepare('SELECT file_checksums FROM memories WHERE id=?').get(id)?.file_checksums).toContain('known-hash');
  });
  it('flags changed source files without altering the original checksum or memory text',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'synabun-source-check-'));
    const file=join(dir,'source.txt');writeFileSync(file,'original file');
    const checksum=createHash('sha256').update('original file').digest('hex');
    const id=add('verified source evidence',{related_files:[file],file_checksums:{[file]:checksum}});
    try {
      await verifyMemorySources(getDb(),id);
      expect(getDb().prepare('SELECT verification FROM memory_metadata WHERE memory_id=?').get(id)?.verification).toBe('current');
      writeFileSync(file,'changed file');await verifyMemorySources(getDb(),id);
      const result=await retrieveMemory({query:'verified source evidence',engine:'hybrid'},none);
      expect(result.results[0].flags).toContain('source needs recheck');
      expect(getDb().prepare('SELECT content,file_checksums FROM memories WHERE id=?').get(id)).toMatchObject({content:'verified source evidence',file_checksums:JSON.stringify({[file]:checksum})});
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('stores duplicate_of as newer→older whichever way it is called',()=>{
    const older=add('same fact',{created_at:'2026-01-01T00:00:00.000Z'});
    const newer=add('same fact, restated',{created_at:'2026-02-01T00:00:00.000Z'});
    setRelation(older,newer,'duplicate_of',true);
    setRelation(newer,older,'duplicate_of',true);
    expect(getDb().prepare("SELECT from_id,to_id FROM memory_relations WHERE kind='duplicate_of'").all()).toEqual([{from_id:newer,to_id:older}]);
    // Symmetric kinds still collapse on the lexical order.
    setRelation(newer,older,'similar',true);setRelation(older,newer,'similar',true);
    expect(getDb().prepare("SELECT count(*) AS n FROM memory_relations WHERE kind='similar'").get()?.n).toBe(1);
  });
  it('backfills passages resumably and groups exact duplicates without removing originals',async()=>{
    const a=add('same'); const b=add('same'); pauseMaintenance(false);
    const embed=async(content:string)=>[{content,vector:[1,0,0]}];
    await runMaintenanceBatch(embed); await runMaintenanceBatch(embed);
    expect(getDb().prepare('SELECT * FROM memory_passages').all()).toHaveLength(2);
    expect(getDb().prepare("SELECT * FROM memory_relations WHERE kind='duplicate_of'").all()).toHaveLength(1);
    expect(getDb().prepare('SELECT id FROM memories WHERE id IN (?,?)').all(a,b)).toHaveLength(2);
    expect((await retrieveMemory({query:'same',engine:'hybrid'},none)).results).toHaveLength(1);
    getDb().prepare("UPDATE memory_relations SET active=0 WHERE kind='duplicate_of'").run();
    expect((await retrieveMemory({query:'same',engine:'hybrid'},none)).results).toHaveLength(2);
  });
  it('isolates concurrent caller projects and never uses the HTTP server cwd',async()=>{
    const a=obtainIdentity('a',{source:'mcp-session'}); a.memoryContext={project:'alpha'};
    const b=obtainIdentity('b',{source:'mcp-session'}); b.memoryContext={project:'beta'};
    const results=await Promise.all([runWithIdentity(a,async()=>{await Promise.resolve();return detectProject();}),runWithIdentity(b,async()=>detectProject())]);
    expect(results).toEqual(['alpha','beta']);
  });
});


describe('hook relevance admission',()=>{
  it('keeps keyword-only results for explicit recall but gates automatic context before limiting',async()=>{
    const weak=add('Claude effort thinking in an unrelated social reply',{},[0,1,0]);
    const good=add('Claude effort thinking controls reasoning depth',{},[0.6,0.8,0]);
    const query={query:'Claude effort thinking',project:'synabun',engine:'hybrid' as const,min_score:0.4,include_sessions:false,limit:5};
    const manual=await retrieveMemory(query,async()=>[1,0,0]);
    expect(manual.results.map(h=>h.id)).toContain(weak);
    const auto=await retrieveMemory({...query,min_semantic_score:0.4,limit:1},async()=>[1,0,0]);
    expect(auto.results.map(h=>h.id)).toEqual([good]);
    expect(auto.results[0].semantic_score).toBeCloseTo(0.6);
    expect(auto.results[0].keyword_coverage).toBe(1);
    expect(auto.results[0].fusion_score).toBe(auto.results[0].score);
    expect(manual.results.find(h=>h.id===weak)?.semantic_score).toBe(0);
  });
});

import { beforeEach, afterAll, expect, it } from 'vitest';
import { getDb, closeDatabase } from '../src/services/sqlite.js';
import { normalizeMemoryEvents, ingestMemoryEvents } from '../src/services/memory-sessions.js';

const context={session_id:'session-1',project:'test'};
beforeEach(()=>getDb().exec('DELETE FROM session_chunks; DELETE FROM memory_session_sources; DELETE FROM memory_jobs;'));
afterAll(()=>closeDatabase());
it('normalizes visible Claude, Codex and OpenCode content and excludes reasoning',()=>{
  const claude=normalizeMemoryEvents('claude-code',[{type:'assistant',message:{content:[{type:'thinking',thinking:'private'},{type:'text',text:'visible Claude'}]}}],context);
  const codex=normalizeMemoryEvents('codex',[{type:'response_item',payload:{type:'reasoning',summary:'private'}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'visible Codex'}]}}],context);
  const opencode=normalizeMemoryEvents('opencode',[{info:{role:'assistant'},parts:[{type:'reasoning',text:'private'},{type:'text',text:'visible OpenCode'}]}],context);
  expect([claude,codex,opencode].map(events=>events.length)).toEqual([1,1,1]);
  expect(JSON.stringify([claude,codex,opencode])).not.toContain('private');
});
it('replays intake idempotently while preserving IDs for edited source events',()=>{
  const first=normalizeMemoryEvents('codex',[{id:'m1',type:'agentMessage',text:'first evidence'}],context);
  expect(ingestMemoryEvents(first).indexed).toBe(1);
  const id=getDb().prepare('SELECT id FROM session_chunks').get()?.id;
  expect(ingestMemoryEvents(first).indexed).toBe(0);
  expect(ingestMemoryEvents([{...first[0],text:'updated evidence'}]).indexed).toBe(1);
  expect(getDb().prepare('SELECT id,content FROM session_chunks').get()).toMatchObject({id,content:'updated evidence'});
  expect(getDb().prepare("SELECT id FROM chunk_search WHERE chunk_search MATCH 'first'").all()).toEqual([]);
  expect(getDb().prepare('SELECT * FROM memories').all()).toEqual([]);
});
it('namespaces source identifiers across hosts and sessions',()=>{
  for(const host of ['claude-code','codex','opencode'] as const)ingestMemoryEvents([{...context,host,source_id:'1',role:'user',text:'shared text',timestamp:'2026-09-06'}]);
  expect(getDb().prepare('SELECT DISTINCT id FROM session_chunks').all()).toHaveLength(3);
});

import { describe, expect, it, vi, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
vi.mock('../src/services/local-embeddings.js',()=>({generateEmbedding:async()=>[1,0,0],embedPassages:async()=>[],EMBEDDING_VERSION:'test:3'}));
import { createMcpServer } from '../src/index.js';
import { closeDatabase, getDb } from '../src/services/sqlite.js';
afterAll(()=>closeDatabase());
describe('memory client contracts',()=>{
  for(const name of ['claude-code','codex','opencode','generic-mcp-client'])it(`preserves existing calls for ${name}`,async()=>{
    const server=createMcpServer('core',{catalogMode:name==='codex' ? 'deferred':'profiled'});
    const client=new Client({name,version:'test'},{capabilities:{}});
    const [a,b]=InMemoryTransport.createLinkedPair();
    await server.connect(b);await client.connect(a);
    const call=async(tool:string,args:Record<string,unknown>)=>{
      const r=await client.callTool({name:tool,arguments:args});
      expect(r.isError).not.toBe(true);return (r.content as {text:string}[])[0].text;
    };
    try {
      const list=(await client.listTools()).tools;
      expect(list.find(t=>t.name==='remember')?.inputSchema.required).toEqual(['content','category','project']);
      const saved=await call('remember',{content:`${name} unique memory contract`,project:name,category:'conversations'});
      const id=saved.match(/\[([0-9a-f-]{36})\]/)![1];
      expect(await call('recall',{query:'unique memory contract',project:name,include_sessions:false})).toContain(id);
      expect(await call('memories',{action:'get',id})).toContain(`${name} unique memory contract`);
      expect(await call('reflect',{memory_id:id,content:'updated memory contract'})).toContain('Updated');
      await call('forget',{memory_id:id});
      expect(await call('recall',{query:'updated memory contract',project:name,include_sessions:false})).toContain('No memories');
      await call('restore',{memory_id:id});
      expect(await call('memories',{action:'get-batch',ids:[id]})).toContain(id);
      expect(getDb().prepare('SELECT id FROM memories WHERE id=?').get(id)?.id).toBe(id);
    }finally{await client.close();await server.close();}
  });
});

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { getDataHome } from '../lib/paths.js';

const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
const database=option('--database') || join(getDataHome(),'mcp-data/memory.db');
const db=new DatabaseSync(database,{readOnly:true});
db.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY');
const hash=s=>createHash('sha256').update(s).digest('hex');
const summary=r=>({id:r.id,project:r.project,category:r.category,source:r.source,created_at:r.created_at,preview:r.content.slice(0,140)});
try {
  const rows=db.prepare('SELECT id,content,project,category,source,created_at FROM memories WHERE trashed_at IS NULL').all();
  rows.sort((a,b)=>a.created_at.localeCompare(b.created_at));
  const groups=new Map(),recent=new Map(),near=[];
  for(const row of rows) {
    const digest=hash(row.content);row.hash=digest;
    if(!groups.has(digest))groups.set(digest,[]);groups.get(digest).push(row);
    const key=JSON.stringify([row.project,row.category,row.source]);
    const now=Date.parse(row.created_at),normalized=row.content.toLowerCase().replace(/\s+/g,' ').trim();
    const bucket=(recent.get(key)||[]).filter(r=>now-r.time<=300000);
    if(normalized.length>=100) {
      const words=normalized.match(/[\p{L}\p{N}_]+/gu)||[];
      const shingles=new Set(words.slice(0,-4).map((_,i)=>words.slice(i,i+5).join(' ')));
      for(const previous of bucket) {
        if(previous.row.hash===digest || Math.min(previous.length,normalized.length)/Math.max(previous.length,normalized.length)<0.8)continue;
        let overlap=0;for(const shingle of shingles)if(previous.shingles.has(shingle))overlap++;
        const score=overlap/(shingles.size+previous.shingles.size-overlap);
        if(score>=0.9)near.push({left:summary(previous.row),right:summary(row),seconds_apart:(now-previous.time)/1000,five_word_jaccard:score});
      }
      bucket.push({row,time:now,length:normalized.length,shingles});
    }
    recent.set(key,bucket);
  }
  const exact=[...groups].filter(([,g])=>g.length>1).map(([content_sha256,g])=>({content_sha256,rows:g.map(summary),adjacent_seconds:g.slice(1).map((r,i)=>(Date.parse(r.created_at)-Date.parse(g[i].created_at))/1000)}));
  const report={generated_at:new Date().toISOString(),database,active_rows:rows.length,
    method:{exact:'SHA-256 of unmodified content, all active rows; metadata retained for review',near:'Same project/category/source; distinct exact hashes; <=300 seconds; >=100 characters; length ratio >=0.8; five-word Jaccard >=0.9'},
    summary:{exact_groups:exact.length,excess_exact_rows:exact.reduce((n,g)=>n+g.rows.length-1,0),near_pairs:near.length},exact,near,
    action:'Review candidates only. No rows were changed or removed.'};
  const output=option('--output');
  if(output){mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify({output:output || null,active_rows:report.active_rows,...report.summary,action:report.action},null,2));
} finally {db.close();}

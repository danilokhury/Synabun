import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRoot } from '../config.js';
import { surfaceConfig } from './typesafe-config.js';

/** One file's edit-time stale verdict, stored per memory in memory_metadata.stale_verdicts. */
export interface StaleVerdictRecord { p: number; hash: string | null; rev: number; at: string; session?: string | null }

export function readStaleVerdicts(raw: unknown): Record<string, StaleVerdictRecord> {
  try {
    const value = JSON.parse(String(raw || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, StaleVerdictRecord> : {};
  } catch { return {}; }
}

/**
 * File checks are asynchronous and bounded, never on the recall request path.
 *
 * Relative paths resolve against the memory's registered project root — the
 * process running this job may be the Neural Interface or any stdio server, so
 * its own cwd says nothing about where the file lives. A relative path that
 * cannot be anchored, or that is missing once anchored, is `unknown` rather
 * than `stale`: the base may be wrong, and "stale" makes recall say so.
 *
 * A changed checksum counts as current when an edit-time judgment of this
 * exact file content and this revision found the memory still accurate.
 */
export async function verifyMemorySources(d: DatabaseSync,id:string) {
  const row=d.prepare('SELECT file_checksums,project FROM memories WHERE id=?').get(id);
  if(!row)return;
  const revision=Number(d.prepare('SELECT MAX(revision) AS n FROM memory_revisions WHERE memory_id=?').get(id)?.n || 1);
  let checks: Record<string,string>;
  try {checks=JSON.parse(String(row.file_checksums || '{}'));}catch{checks={};}
  const files=Object.entries(checks);
  const base=projectRoot(String(row.project || ''));
  const verdicts=readStaleVerdicts(d.prepare('SELECT stale_verdicts FROM memory_metadata WHERE memory_id=?').get(id)?.stale_verdicts);
  const floor=surfaceConfig('edit-stale').minProbability ?? 0.4;
  let unknown=!files.length || files.length>10;
  let stale=false;
  for(const [file,expected] of files.slice(0,10)) {
    const relative=!isAbsolute(file);
    const target=relative ? (base ? resolve(base,file) : null) : file;
    if(!target){unknown=true;continue;}
    const hash=createHash('sha256');
    const stream=createReadStream(target,{highWaterMark:64*1024});
    let bytes=0;
    try {
      for await(const chunk of stream) {
        bytes+=chunk.length;
        if(bytes>4*1024*1024){unknown=true;break;}
        hash.update(chunk);
      }
      if(bytes<=4*1024*1024) {
        const digest=hash.digest('hex');
        const judged=verdicts[file];
        const judgedAccurate=judged && judged.hash===digest && judged.rev===revision && judged.p>=floor;
        if(digest!==expected && !judgedAccurate)stale=true;
      }
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){if(relative)unknown=true;else stale=true;}else unknown=true;}
    finally{stream.destroy();}
  }
  if(Number(d.prepare('SELECT MAX(revision) AS n FROM memory_revisions WHERE memory_id=?').get(id)?.n || 0)!==revision)return;
  d.prepare(`INSERT INTO memory_metadata(memory_id,verification,verified_revision,checked_at) VALUES(?,?,?,?)
    ON CONFLICT(memory_id) DO UPDATE SET verification=excluded.verification,verified_revision=excluded.verified_revision,checked_at=excluded.checked_at`)
    .run(id,stale ? 'stale' : unknown ? 'unknown' : 'current',revision,new Date().toISOString());
}

import { open } from 'node:fs/promises';
import { getDb } from '../../mcp-server/dist/services/sqlite.js';
import { detectProject } from '../../mcp-server/dist/config.js';
import { normalizeMemoryEvents, ingestMemoryEvents } from '../../mcp-server/dist/services/memory-sessions.js';
import { maintenancePaused } from './memory-timers.js';

export function queueMemoryCapture({host,sessionId,filePath,project,cwd}) {
  if(!filePath || !sessionId || !['claude-code','codex'].includes(host))return;
  getDb().prepare(`INSERT INTO memory_capture_files(host,session_id,file_path,project,cwd) VALUES(?,?,?,?,?)
    ON CONFLICT(host,session_id) DO UPDATE SET file_path=excluded.file_path,project=excluded.project,cwd=excluded.cwd,status='pending',error=NULL`)
    .run(host,sessionId,filePath,cwd ? detectProject(cwd) : project || 'global',cwd || null);
}

let running=false;
let timer=null;
export async function captureMemoryFileBatch(target) {
  if(running)return {busy:true};
  if(maintenancePaused())return {paused:true};
  running=true;
  const d=getDb();
  const job=target ? d.prepare("SELECT * FROM memory_capture_files WHERE host=? AND session_id=? AND status='pending'").get(target.host,target.sessionId)
    : d.prepare("SELECT * FROM memory_capture_files WHERE status='pending' ORDER BY byte_offset LIMIT 1").get();
  let file;
  try {
    if(!job)return;
    file=await open(job.file_path,'r');
    const stat=await file.stat();
    const offset=stat.size<job.byte_offset ? 0 : job.byte_offset;
    // Bounded file reads keep large transcripts off the UI request path.
    let buffer=Buffer.alloc(256*1024);
    let {bytesRead}=await file.read(buffer,0,buffer.length,offset);
    if(!bytesRead){d.prepare("UPDATE memory_capture_files SET status='complete' WHERE host=? AND session_id=?").run(job.host,job.session_id);return;}
    while(buffer.subarray(0,bytesRead).lastIndexOf(10)<0 && bytesRead===buffer.length && buffer.length<8*1024*1024) {
      buffer=Buffer.alloc(buffer.length*2);
      ({bytesRead}=await file.read(buffer,0,buffer.length,offset));
    }
    const bytes=buffer.subarray(0,bytesRead);
    const newline=bytes.lastIndexOf(10);
    let consumed=newline+1;
    if(newline<0) {
      if(bytesRead===buffer.length)throw new Error('Transcript record exceeds 8 MiB; original source retained.');
      // A valid final JSON record need not end in a newline. Incomplete tails
      // remain pending until the writer finishes them.
      try{JSON.parse(bytes.toString('utf8'));consumed=bytesRead;}catch{return;}
    }
    const records=[];
    let position=offset;
    for(const line of bytes.subarray(0,consumed).toString('utf8').split('\n')) {
      if(line.trim()) {try {const record=JSON.parse(line);records.push({...record,id:record.id || record.uuid || `byte:${position}`});}catch{}}
      position+=Buffer.byteLength(line)+1;
    }
    const sourceCwd=job.cwd || records.find(r=>r.cwd)?.cwd || records.find(r=>r.type==='session_meta')?.payload?.cwd;
    const project=sourceCwd ? detectProject(sourceCwd) : job.project;
    const events=normalizeMemoryEvents(job.host,records,{session_id:job.session_id,project,cwd:sourceCwd});
    if(maintenancePaused())return;
    ingestMemoryEvents(events);
    // Replaying after a crash between intake and checkpoint is idempotent.
    d.prepare("UPDATE memory_capture_files SET byte_offset=?,status=?,error=NULL WHERE host=? AND session_id=?")
      .run(offset+consumed,offset+consumed>=stat.size ? 'complete':'pending',job.host,job.session_id);
  }catch(error){if(job)d.prepare("UPDATE memory_capture_files SET status='failed',error=? WHERE host=? AND session_id=?").run(error.message,job.host,job.session_id);}
  finally{await file?.close();running=false;}
}
let startTimer=null;
// offsetMs keeps this tick out of phase with the 2 s maintenance timer so the
// two never stack on the same event-loop turn.
export function startMemoryCapture({offsetMs=1000,intervalMs=2000}={}) {
  if(timer||startTimer)return;
  const tick=()=>captureMemoryFileBatch().catch(error=>console.error('[memory capture]',error.message));
  startTimer=setTimeout(()=>{
    startTimer=null;
    timer=setInterval(tick,intervalMs);
    timer.unref();
  },offsetMs);
  startTimer.unref();
}
export function stopMemoryCapture(){
  if(startTimer)clearTimeout(startTimer);
  if(timer)clearInterval(timer);
  startTimer=null;
  timer=null;
}

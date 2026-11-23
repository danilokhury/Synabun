import { createHash } from 'node:crypto';
import { getDb } from './sqlite.js';

export interface MemoryEvent {
  host: 'claude-code'|'codex'|'opencode'|'antigravity'; session_id: string; source_id: string;
  project: string; timestamp: string; role: 'user'|'assistant'|'tool'; text: string;
  cwd?: string; tools?: string[]; files?: string[];
}
function stableId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function visibleText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b=>['text','input_text','output_text'].includes(b?.type)).map(b=>b.text || '').join('\n');
}
function clean(text: string) {
  return text.replace(/<(system-reminder|environment_context|permissions|INSTRUCTIONS)>[\s\S]*?<\/\1>/g,'').trim();
}
// SynaBun's greeting note in an Antigravity prompt (neural-interface/public/shared/agy/agy-greeting.js, same markers).
const AGY_GREETING_NOTE = /\[SYNABUN_GREETING_START\][\s\S]*?\[SYNABUN_GREETING_END\][ \t]*(?:\r?\n)*/g;
const AGY_META_BLOCKS = /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_MESSAGE)>[\s\S]*?<\/\1>/g;
/** What a person typed, out of Antigravity's USER_INPUT step (agy wraps it in <USER_REQUEST> with blocks of its own). */
function antigravityUserWords(content: unknown) {
  const text = String(content ?? '');
  const request = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/.exec(text);
  return (request ? request[1] : text.replace(AGY_META_BLOCKS, '')).replace(AGY_GREETING_NOTE, '').trim();
}
/** Normalize only visible provider records, never reasoning or system text. */
export function normalizeMemoryEvents(host: MemoryEvent['host'], records: any[], context: {session_id:string;project:string;cwd?:string}): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  for (const [index,record] of records.entries()) {
    let role: MemoryEvent['role']|undefined;
    let text = '';
    let tools: string[] = [];
    let sourceId: string|undefined;
    if (host === 'claude-code') {
      if (record.isMeta || record.isSidechain) continue;
      if (record.type === 'user' && !record.toolUseResult && !record.sourceToolAssistantUUID) role='user';
      if (record.type === 'assistant') role='assistant';
      text = visibleText(record.message?.content);
      tools = (Array.isArray(record.message?.content) ? record.message.content : []).filter((b:any)=>b.type==='tool_use').map((b:any)=>String(b.name));
    } else if (host === 'codex') {
      const p = record.type === 'response_item' ? record.payload : record;
      if (p?.type === 'message' && ['user','assistant'].includes(p.role)) { role=p.role; text=visibleText(p.content); }
      if (p?.type === 'userMessage') { role='user'; text=visibleText(p.content); }
      if (p?.type === 'agentMessage') { role='assistant'; text=String(p.text || ''); }
      if (p?.type === 'commandExecution') { role='tool'; text=String(p.aggregatedOutput || ''); tools=['commandExecution']; }
      if (p?.type === 'function_call_output') {role='tool';text=String(p.output || '');}
    } else if (host === 'antigravity') {
      // agy's transcript.jsonl (brain/<id>/.system_generated/logs): one line per step, keyed by its index (a
      // re-read of the file, from any offset, gives every step the same source id). The person's words and the
      // model's answers only: never its `thinking`, agy's own system messages, or tool output.
      if (Number.isInteger(record.step_index)) sourceId = `step:${record.step_index}`;
      if (record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') { role='user'; text=antigravityUserWords(record.content); }
      if (record.type === 'PLANNER_RESPONSE' && record.source === 'MODEL') {
        role='assistant';
        text=typeof record.content === 'string' ? record.content : '';
        tools=(Array.isArray(record.tool_calls) ? record.tool_calls : []).map((c:any)=>String(c?.name || '')).filter(Boolean);
      }
    } else {
      const info = record.info || record;
      if (['user','assistant'].includes(info.role)) role=info.role;
      text=visibleText(record.parts || record.content);
      tools=(record.parts || []).filter((p:any)=>p.type==='tool').map((p:any)=>String(p.tool));
    }
    text=clean(text);
    if (!role || !text || text.startsWith('# AGENTS.md')) continue;
    const timestamp = record.timestamp || record.info?.time?.created || record.createdAt || record.created_at;
    events.push({...context,host,source_id:sourceId ?? String(record.uuid || record.id || record.info?.id || `${index}`),role,text,tools,
      timestamp: timestamp && Number.isFinite(new Date(timestamp).getTime()) ? new Date(timestamp).toISOString() : '1970-01-01T00:00:00.000Z'});
  }
  return events;
}

/** Durable intake: immediately keyword searchable, semantic work queued.
 * Stable source keys make replay and partial imports idempotent. */
/**
 * How the session-cache worker paces its intake (lib/memory-session-capture.js, lib/session-cache-builder.js).
 * Every other writer of the store waits for the one SQLite write lock, and the Neural Interface's synchronous writes
 * wait for it on the event loop, polling every 1-25 ms at first and then every 50-100 ms (SQLite's busy handler).
 * A capture that held the lock for 25 whole events (20-100+ ms each, more with long tool output) and let go of it for
 * 8 ms kept such a writer, and the whole server, waiting for seconds. A transaction now ends after
 * CAPTURE_TRANSACTION_MS (whole events: one long event can still exceed it), and the lock stays free for
 * CAPTURE_PAUSE_MS, longer than the busy handler's polling interval for the first 128 ms of a wait.
 */
export const CAPTURE_TRANSACTION_MS = 20;
export const CAPTURE_PAUSE_MS = 25;

/**
 * `maxTransactionMs`: commit once a transaction has run this long and return; `consumed` says how many of `events`
 * were handled (the caller passes the rest again after a pause). Without it every event is handled.
 */
export function ingestMemoryEvents(events: MemoryEvent[], { maxTransactionMs }: { maxTransactionMs?: number } = {}) {
  const d = getDb();
  if (!events.length) return { indexed: 0, consumed: 0 };
  const priorSource = d.prepare('SELECT content_hash,chunk_id FROM memory_session_sources WHERE host=? AND session_id=? AND source_id=?');
  const putChunk = d.prepare(`INSERT INTO session_chunks(id,vector,content,summary,session_id,project,cwd,start_timestamp,end_timestamp,tools_used,files_modified,indexed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET vector=excluded.vector,content=excluded.content,summary=excluded.summary,
    project=excluded.project,cwd=excluded.cwd,start_timestamp=excluded.start_timestamp,end_timestamp=excluded.end_timestamp,
    tools_used=excluded.tools_used,files_modified=excluded.files_modified,indexed_at=excluded.indexed_at`);
  const putSource = d.prepare(`INSERT INTO memory_session_sources VALUES(?,?,?,?,?) ON CONFLICT(host,session_id,source_id)
    DO UPDATE SET content_hash=excluded.content_hash`);
  const queue = d.prepare(`INSERT INTO memory_jobs(id,kind,entity_id,updated_at) VALUES(?,'session',?,?)
    ON CONFLICT(kind,entity_id) DO UPDATE SET status='pending',attempts=0,error=NULL,updated_at=excluded.updated_at`);
  const emptyVector = new Uint8Array(384 * 4);
  let indexed = 0;
  for (let offset = 0; offset < events.length; offset += 50) {
    // Prepare statements and hash/encode the batch before taking SQLite's single writer lock.
    const batch = events.slice(offset, offset + 50).map(event => ({
      event,
      hash: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
      id: stableId(`${event.host}:${event.session_id}:${event.source_id}`),
      tools: JSON.stringify(event.tools || []),
      files: JSON.stringify(event.files || []),
    }));
    d.exec('BEGIN IMMEDIATE');
    const began = performance.now();
    let handled = batch.length;
    try {
      for (const [index, item] of batch.entries()) {
        const { event, hash } = item;
        const prior = priorSource.get(event.host, event.session_id, event.source_id);
        if (prior?.content_hash !== hash) {
          const id = prior?.chunk_id ? String(prior.chunk_id) : item.id;
          const now = new Date().toISOString();
          putChunk.run(id, emptyVector, event.text, `${event.role}: ${event.text.slice(0,500)}`, `${event.host}:${event.session_id}`,
            event.project, event.cwd || null, event.timestamp, event.timestamp, item.tools, item.files, now);
          putSource.run(event.host, event.session_id, event.source_id, hash, id);
          queue.run(`session:${id}`, id, now);
          indexed++;
        }
        if (maxTransactionMs !== undefined && index < batch.length - 1 && performance.now() - began >= maxTransactionMs) { handled = index + 1; break; }
      }
      d.exec('COMMIT');
    } catch (error) {d.exec('ROLLBACK');throw error;}
    if (handled < batch.length || (maxTransactionMs !== undefined && offset + 50 < events.length)) return { indexed, consumed: offset + handled };
  }
  return { indexed, consumed: events.length };
}

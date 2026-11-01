// ═══════════════════════════════════════════
// SynaBun — Antigravity's conversations, read where agy keeps them (never written)
// ═══════════════════════════════════════════
//
// agy (1.4.x) keeps each conversation under <gemini dir>/antigravity-cli/:
//   brain/<conversation id>/.system_generated/logs/transcript.jsonl
//       one JSON line per step, appended as the steps happen: { step_index, source, type, status, created_at,
//       content, thinking?, tool_calls?, input_tokens?, output_tokens? }. A person's message is USER_EXPLICIT /
//       USER_INPUT, its words inside <USER_REQUEST> (agy adds <ADDITIONAL_METADATA> and <USER_SETTINGS_CHANGE>
//       blocks around them); the model's answer is MODEL / PLANNER_RESPONSE (`content`; `thinking` is its
//       reasoning and is never read; `tool_calls` [{ name, args }]); a tool's output is MODEL / GENERIC; SYSTEM /
//       SYSTEM_MESSAGE is agy's own.
//   conversation_summaries.db
//       SQLite, one row per conversation: its title, its folders (`workspace_uris`, a JSON list of file: URIs, the
//       first being where it runs), when it changed, and its parent when it is a subagent's.
//   conversations/<id>.db  the steps again, as protobuf (no schema: never read).
// Measured on agy 1.4.12 (docs/antigravity-sidepanel.md → Conversations in SynaBun).
//
// The index is opened read-only with SQLite's immutable flag: nothing is created beside it (no -wal or -shm), and a
// change agy has not checkpointed yet is simply not seen until it has. A conversation the index does not name yet
// has no folder: memory keeps it without a project, and Resume shows it once the index names it.
//
// Where: the user's own gemini dir (~/.gemini: the side panel's and a terminal agy's; Resume lists these and the
// panel can load them again) and every SynaBun home (lib/antigravity/home.js: an Assistant brain's or a dispatched
// run's; kept for memory only, since only the gemini dir that holds a conversation can load it). A folder or a
// transcript that is a link is never followed, and a transcript is read only up to MAX_TRANSCRIPT_BYTES.

import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { stripGreetingNote } from '../../public/shared/agy/agy-greeting.js';

/** agy's own folder inside a gemini dir (`--gemini-dir <dir>` keeps it there too). */
export const AGY_DATA_DIR = 'antigravity-cli';
/** A transcript bigger than this is read up to here (its first steps; the rest is left out). */
export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
/** What a conversation id may look like (agy's are UUIDs); anything else in brain/ is not a conversation. */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/;
/** The SynaBun homes that hold conversations of their own (a model-list home holds none worth keeping). */
const HOME_RE = /^(?:brain|run)-[A-Za-z0-9_-]+$/;

/** The transcript of a conversation in a gemini dir. */
export function transcriptPath(geminiDir, sessionId) {
  return join(geminiDir, AGY_DATA_DIR, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

const isDir = (path) => { try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } };

/**
 * The gemini dirs whose conversations SynaBun reads: the user's (`kind: 'user'`), then each SynaBun home under
 * `homesRoot` (`kind: 'synabun'`). A missing folder is simply not there.
 */
export function antigravityStores({ home = homedir(), homesRoot = null } = {}) {
  const stores = [];
  const user = join(home, '.gemini');
  if (isDir(join(user, AGY_DATA_DIR))) stores.push({ dir: user, kind: 'user' });
  if (homesRoot && isDir(homesRoot)) {
    let names = [];
    try { names = readdirSync(homesRoot).sort(); } catch { names = []; }
    for (const name of names) {
      const dir = join(homesRoot, name);
      // A home is SynaBun's own folder: one that is a link (to anywhere) is not one.
      if (HOME_RE.test(name) && isDir(dir) && isDir(join(dir, AGY_DATA_DIR))) stores.push({ dir, kind: 'synabun' });
    }
  }
  return stores;
}

/** A folder from a file: URI (agy's workspace_uris), or null. */
export function folderOfUri(uri) {
  try {
    const url = new URL(String(uri || ''));
    if (url.protocol !== 'file:') return null;
    const path = fileURLToPath(url);
    return path || null;
  } catch { return null; }
}

/** agy's time ("2026-10-31 07:08:50.511446+00:00", the zero time for none) as ISO, or null. */
export function indexTime(value) {
  const text = String(value || '').trim();
  if (!text || text.startsWith('0001-01-01')) return null;
  const at = Date.parse(text.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * conversation_summaries.db of one agy folder, as `Map(id → { title, cwd, folders, updatedAt, parentId, steps })`.
 * Empty when there is none or it cannot be read (a title and a folder are extras: the transcript is the record).
 */
export function readAntigravityIndex(dataDir, { Database = DatabaseSync } = {}) {
  const index = new Map();
  const file = join(dataDir, 'conversation_summaries.db');
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) return index; } catch { return index; }
  let db = null;
  try {
    db = new Database(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    const rows = db.prepare(`SELECT conversation_id, title, workspace_uris, last_modified_time, parent_conversation_id, step_count
      FROM conversation_summaries`).all();
    for (const row of rows) {
      const id = String(row.conversation_id || '');
      if (!CONVERSATION_ID_RE.test(id)) continue;
      let uris = [];
      try { const parsed = JSON.parse(String(row.workspace_uris || '[]')); if (Array.isArray(parsed)) uris = parsed; } catch { uris = []; }
      const folders = uris.map(folderOfUri).filter(Boolean);
      index.set(id, {
        title: String(row.title || '').trim(),
        cwd: folders[0] || null,
        folders,
        updatedAt: indexTime(row.last_modified_time),
        parentId: String(row.parent_conversation_id || '') || null,
        steps: Number(row.step_count) || 0,
      });
    }
  } catch { /* an index being written, an older layout: no extras */ }
  finally { try { db?.close(); } catch { /* closed */ } }
  return index;
}

/**
 * Every conversation with a transcript in these stores: `{ sessionId, store, geminiDir, transcript, size, mtimeMs,
 * title, cwd, folders, updatedAt, parentId }`. A subagent's conversation (one with a parent) is its parent's work
 * and is left out, as Claude Code's sidechains are.
 */
export function listAntigravityConversations(stores, { readIndex = readAntigravityIndex } = {}) {
  const out = [];
  const seen = new Set();
  for (const store of Array.isArray(stores) ? stores : []) {
    const dataDir = join(store.dir, AGY_DATA_DIR);
    const brain = join(dataDir, 'brain');
    if (!isDir(brain)) continue;
    let ids = [];
    try { ids = readdirSync(brain).filter((name) => CONVERSATION_ID_RE.test(name)); } catch { ids = []; }
    if (!ids.length) continue;
    const index = readIndex(dataDir);
    for (const id of ids) {
      if (seen.has(id) || !isDir(join(brain, id))) continue;
      const meta = index.get(id) || null;
      if (meta?.parentId) continue;
      const transcript = transcriptPath(store.dir, id);
      let stat;
      try { stat = lstatSync(transcript); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) continue;
      seen.add(id);
      out.push({
        sessionId: id, store: store.kind, geminiDir: store.dir, transcript, size: stat.size, mtimeMs: stat.mtimeMs,
        title: meta?.title || '', cwd: meta?.cwd || null, folders: meta?.folders || [], updatedAt: meta?.updatedAt || null, parentId: null,
      });
    }
  }
  return out;
}

/** One conversation of the user's own store by id (the panel's and Resume's), or null. */
export function findUserConversation(sessionId, { home = homedir(), readIndex = readAntigravityIndex } = {}) {
  if (!CONVERSATION_ID_RE.test(String(sessionId || ''))) return null;
  const stores = antigravityStores({ home }).filter((store) => store.kind === 'user');
  const dir = stores[0]?.dir;
  if (!dir) return null;
  const transcript = transcriptPath(dir, sessionId);
  let stat;
  try { stat = lstatSync(transcript); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink() || !isDir(join(dir, AGY_DATA_DIR, 'brain', sessionId))) return null;
  const meta = readIndex(join(dir, AGY_DATA_DIR)).get(sessionId) || null;
  return { sessionId, store: 'user', geminiDir: dir, transcript, size: stat.size, mtimeMs: stat.mtimeMs, title: meta?.title || '', cwd: meta?.cwd || null, folders: meta?.folders || [], updatedAt: meta?.updatedAt || null, parentId: meta?.parentId || null };
}

/**
 * A transcript's text, read without following a link and up to `maxBytes` (a cut line at the end is left out by
 * the parser). '' when it cannot be read.
 */
export function readTranscriptText(path, { maxBytes = MAX_TRANSCRIPT_BYTES } = {}) {
  let fd = null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    fd = openSync(path, 'r');
    const size = Math.min(fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (!n) break;
      read += n;
    }
    return buffer.subarray(0, read).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
}

const META_BLOCKS = /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_MESSAGE)>[\s\S]*?<\/\1>/g;

/** What a person typed, out of agy's USER_INPUT `content` (its own blocks and SynaBun's greeting note left out). */
export function antigravityUserWords(content) {
  const text = String(content ?? '');
  const request = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/.exec(text);
  const words = request ? request[1] : text.replace(META_BLOCKS, '');
  return stripGreetingNote(words).trim();
}

/** One transcript line as a message: { role: 'user' | 'assistant' | 'tool_result', text, at, step, tools } or null. */
export function antigravityStepMessage(record) {
  if (!record || typeof record !== 'object') return null;
  const at = typeof record.created_at === 'string' && Number.isFinite(Date.parse(record.created_at)) ? new Date(record.created_at).toISOString() : null;
  const step = Number.isInteger(record.step_index) ? record.step_index : null;
  if (record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') {
    const text = antigravityUserWords(record.content);
    return text ? { role: 'user', text, at, step, tools: [] } : null;
  }
  if (record.type === 'PLANNER_RESPONSE' && record.source === 'MODEL') {
    const tools = (Array.isArray(record.tool_calls) ? record.tool_calls : [])
      .filter((call) => call && typeof call.name === 'string' && call.name)
      .map((call) => ({ name: call.name, input: call.args ?? {} }));
    const text = typeof record.content === 'string' ? record.content.trim() : '';
    return text || tools.length ? { role: 'assistant', text, at, step, tools } : null;
  }
  if (record.type === 'GENERIC' && record.source === 'MODEL' && typeof record.content === 'string' && record.content.trim()) {
    return { role: 'tool_result', text: record.content, at, step, tools: [], error: record.status === 'ERROR' };
  }
  return null;
}

/**
 * A transcript's text as the conversation: `{ records, messages, firstPrompt, messageCount, created, modified }`.
 * `records` are the parsed lines (for memory capture); `messages` the person's and the model's turns and the tool
 * output, in order; `messageCount` counts the person's and the model's messages that say something.
 */
export function parseAntigravityTranscript(text) {
  const records = [];
  const messages = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    records.push(record);
    const message = antigravityStepMessage(record);
    if (message) messages.push(message);
  }
  const said = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text);
  const times = messages.map((m) => m.at).filter(Boolean).sort();
  return {
    records,
    messages,
    firstPrompt: said.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').slice(0, 200) || '',
    messageCount: said.length,
    created: times[0] || null,
    modified: times[times.length - 1] || null,
  };
}

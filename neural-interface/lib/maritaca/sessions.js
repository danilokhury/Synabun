// ═══════════════════════════════════════════
// SynaBun — Maritaca AI: the conversation store
// ═══════════════════════════════════════════
//
// Maritaca keeps no conversation on its side: every request carries the whole history. SynaBun keeps
// each conversation as one JSON file, DATA_HOME/data/maritaca/sessions/<id>.json ({ id, title, model,
// project, createdAt, updatedAt, messages: [{ role, content, reasoning?, usage?, costBrl?, mode?, at }] }),
// bounded in messages and bytes; an id is SynaBun's own (never from a page), a project is a plain
// string the page shows (no file is read from it). Pure helpers first, then the store.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const MARITACA_SESSION_LIMITS = Object.freeze({
  maxMessages: 400,
  maxMessageChars: 200_000,
  maxTitleChars: 120,
  maxSessions: 500,
  maxHistoryChars: 1_500_000, // what one request may carry; older turns are dropped first (the system prompt stays)
  pruneGraceMs: 60_000,       // a conversation updated this recently is never pruned to make room for a new one
});
const ID_RE = /^[a-f0-9]{32}$/;

export function newSessionId() { return randomUUID().replace(/-/g, ''); }
export function isSessionId(id) { return typeof id === 'string' && ID_RE.test(id); }

/** The title a first prompt gives a conversation: its first line, trimmed and bounded. */
export function titleFromPrompt(text, max = MARITACA_SESSION_LIMITS.maxTitleChars) {
  const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * The messages a request carries for a conversation: the system prompt (when any) and the newest
 * turns that fit `maxChars`, oldest dropped first, never a tool message left without its call. An assistant row
 * with no content (a failed or stopped turn) stays in the stored conversation for display but is left out of a
 * request: some OpenAI-compatible servers refuse an empty assistant message with 400.
 */
export function historyForRequest(messages, { systemPrompt = '', maxChars = MARITACA_SESSION_LIMITS.maxHistoryChars } = {}) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .filter((m) => m.role !== 'assistant' || m.content.trim());
  const out = [];
  let used = systemPrompt.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i];
    if (used + m.content.length > maxChars && out.length) break;
    used += m.content.length;
    out.unshift({ role: m.role, content: m.role === 'user' && m.images?.length ? [{ type: 'text', text: m.content }, ...m.images] : m.content });
  }
  return systemPrompt.trim() ? [{ role: 'system', content: systemPrompt }, ...out] : out;
}

/** The summary row a list shows. */
export function sessionSummary(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const last = messages[messages.length - 1] || null;
  return {
    id: session.id, title: session.title || '', model: session.model || null, project: session.project || null,
    createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: messages.length,
    preview: last ? String(last.content || '').slice(0, 160) : '',
    costBrl: (Number(session.priorCostBrl) || 0) + messages.reduce((sum, m) => sum + (Number(m.costBrl) || 0), 0),
  };
}

export function createMaritacaSessionStore({ dir, limits = MARITACA_SESSION_LIMITS, now = () => new Date().toISOString() } = {}) {
  if (!dir) throw new Error('createMaritacaSessionStore needs dir');
  const pathOf = (id) => { if (!isSessionId(id)) throw Object.assign(new Error('Unknown conversation.'), { code: 'SESSION_INVALID', status: 400 }); return join(dir, `${id}.json`); };

  function write(session) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = pathOf(session.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(session), { mode: 0o600, flag: 'wx' }); renameSync(temp, target); }
    finally { rmSync(temp, { force: true }); }
    return session;
  }

  function get(id) {
    const path = pathOf(id);
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const session = JSON.parse(raw);
      if (!session || session.id !== id || !Array.isArray(session.messages)) return null;
      return session;
    } catch { return null; }
  }

  function create({ title = '', model = null, project = null } = {}) {
    const at = now();
    const existing = list({ limit: 1000 });
    if (existing.length >= limits.maxSessions) {
      // The oldest conversations make room, never one updated within the grace (a turn may be streaming into it);
      // when every candidate is that fresh nothing is pruned and the cap is exceeded for a while.
      const grace = Number.isFinite(limits.pruneGraceMs) ? limits.pruneGraceMs : MARITACA_SESSION_LIMITS.pruneGraceMs;
      const fresh = (row) => Date.parse(at) - Date.parse(row.updatedAt) < grace;
      let excess = existing.length - (limits.maxSessions - 1);
      for (let i = existing.length - 1; i >= 0 && excess > 0; i--) {
        if (fresh(existing[i])) continue;
        rmSync(join(dir, `${existing[i].id}.json`), { force: true });
        excess--;
      }
    }
    const session = {
      id: newSessionId(), title: String(title || '').slice(0, limits.maxTitleChars), model: model ? String(model).slice(0, 80) : null,
      project: project ? String(project).slice(0, 1000) : null, createdAt: at, updatedAt: at, messages: [],
    };
    return write(session);
  }

  function update(id, patch = {}) {
    const session = get(id);
    if (!session) return null;
    if (typeof patch.title === 'string') session.title = patch.title.trim().slice(0, limits.maxTitleChars);
    if (patch.model !== undefined) session.model = patch.model ? String(patch.model).slice(0, 80) : null;
    if (patch.project !== undefined) session.project = patch.project ? String(patch.project).slice(0, 1000) : null;
    session.updatedAt = now();
    return write(session);
  }

  /** Appends one message ({ role, content, reasoning?, usage?, costBrl?, model? }); the oldest go when the list is full. */
  function append(id, message) {
    const session = get(id);
    if (!session) return null;
    const role = ['user', 'assistant'].includes(message?.role) ? message.role : null;
    if (!role) throw Object.assign(new Error('A message is a user or assistant message.'), { code: 'MESSAGE_INVALID', status: 400 });
    const content = String(message.content ?? '').slice(0, limits.maxMessageChars);
    const entry = { role, content, at: now() };
    if (role === 'user') {
      if (typeof message.displayText === 'string') entry.displayText = message.displayText.slice(0, limits.maxMessageChars);
      if (typeof message.attachmentText === 'string') entry.attachmentText = message.attachmentText.slice(0, limits.maxMessageChars);
      if (Array.isArray(message.attachments)) entry.attachments = message.attachments.slice(0, 5);
      if (Array.isArray(message.images) && message.images.length) entry.images = message.images.slice(0, 5);
    }
    if (typeof message.reasoning === 'string' && message.reasoning) entry.reasoning = message.reasoning.slice(0, limits.maxMessageChars);
    if (message.usage && typeof message.usage === 'object') entry.usage = message.usage;
    if (message.costBrl != null && Number.isFinite(Number(message.costBrl))) entry.costBrl = Number(message.costBrl);
    if (message.model) entry.model = String(message.model).slice(0, 80);
    if (message.turnId) entry.turnId = String(message.turnId).slice(0, 80);
    if (message.finishReason) entry.finishReason = String(message.finishReason).slice(0, 40);
    if (message.error) entry.error = String(message.error).slice(0, 400);
    // Only a plan turn is marked (lib/maritaca/modes.js); a message without `mode` is a chat message.
    if (message.mode === 'plan') entry.mode = 'plan';
    session.messages.push(entry);
    while (session.messages.length > limits.maxMessages) {
      const removed = session.messages.shift();
      session.priorCostBrl = (Number(session.priorCostBrl) || 0) + (Number(removed.costBrl) || 0);
    }
    if (!session.title && role === 'user') session.title = titleFromPrompt(message.displayText || content, limits.maxTitleChars);
    session.updatedAt = entry.at;
    write(session);
    return entry;
  }

  function remove(id) {
    const path = pathOf(id);
    try { statSync(path); } catch { return false; }
    rmSync(path, { force: true });
    return true;
  }

  /** Rewind to a user prompt for regenerate/edit. Preserve the cost of discarded replies. `mode` re-marks the prompt. */
  function rewind(id, messageIndex, text = undefined, { mode } = {}) {
    const session = get(id);
    if (!session) return null;
    const prompt = session.messages[messageIndex];
    if (!Number.isInteger(messageIndex) || prompt?.role !== 'user') throw Object.assign(new Error('Choose a user message to retry.'), { code: 'PROMPT_UNKNOWN', status: 400 });
    const next = text === undefined ? prompt.content : [text, prompt.attachmentText].filter(Boolean).join('\n\n');
    if (next.length > limits.maxMessageChars) throw Object.assign(new Error('The message including files is too long.'), { code: 'PROMPT_TOO_LONG', status: 400 });
    const removed = session.messages.slice(messageIndex + 1);
    session.priorCostBrl = (Number(session.priorCostBrl) || 0) + removed.reduce((sum, m) => sum + (Number(m.costBrl) || 0), 0);
    session.messages = session.messages.slice(0, messageIndex + 1);
    if (text !== undefined) { prompt.displayText = text; prompt.content = next; }
    if (mode === 'plan') prompt.mode = 'plan';
    else if (mode !== undefined) delete prompt.mode;
    session.updatedAt = now();
    return write(session);
  }

  /** Every conversation's summary, newest first; `project` narrows to one project. */
  function list({ project = null, limit = 200 } = {}) {
    let names = [];
    try { names = readdirSync(dir).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)); } catch { return []; }
    const rows = [];
    for (const name of names) {
      const session = get(name.slice(0, 32));
      if (!session) continue;
      if (project && session.project !== project) continue;
      rows.push(sessionSummary(session));
    }
    rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return rows.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));
  }

  return { dir, create, get, update, append, rewind, remove, list };
}

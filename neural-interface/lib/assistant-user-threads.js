// ═══════════════════════════════════════════
// SynaBun — Assistant threads (pure)
// ═══════════════════════════════════════════
//
// One memory per Assistant conversation (category `assistant-threads`, kind
// `session`), rewritten in place. Its content is assembled from what the
// runtime saw, never written by a model:
//
//   Assistant conversation: Fix the login redirect
//   Project synabun · 2026-10-11 21:31 → 22:05 UTC · 4 prompts
//   Asks:
//   - Fix the login redirect on Safari
//   Runs:
//   - Safari redirect fix (codex): done
//   Open:
//   - follow-up (Safari redirect fix): add a regression test
//   Session assistant-1234
//
// Open items are a worker's follow_ups, a run that ended blocked, needs_input,
// failed or interrupted, and a card left unanswered. No I/O.

import { NUDGES, THREAD } from './assistant-user-context-budgets.js';
import { clipText } from './assistant-user-knowledge.js';

const HEAD = 'Assistant conversation: ';
const OPEN_OUTCOMES = new Set(['blocked', 'needs_input', 'failed', 'interrupted']);

const minute = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : null;
};
const oneLine = (value, max) => clipText(String(value ?? '').split(/\r?\n/).find((line) => line.trim()) || '', max);

/** A new working thread for a conversation. */
export function newThread({ sessionId, title = '', project = 'global', at = null } = {}) {
  return { sessionId: String(sessionId || ''), memoryId: null, title: String(title || ''), project: String(project || 'global'), startedAt: at, lastAt: at, prompts: 0, asks: [], runs: {}, hash: '', writtenAt: null, dirty: false };
}

/** A typed prompt: its first line joins the asks (the last `THREAD.asks` are kept). */
export function noteAsk(thread, { text, at = null, title = null, project = null } = {}) {
  const ask = oneLine(text, THREAD.askClip);
  thread.prompts = (Number(thread.prompts) || 0) + 1;
  if (ask) thread.asks = [...(thread.asks || []), { at, text: ask }].slice(-THREAD.asks);
  if (at) { thread.startedAt ||= at; if (!thread.lastAt || at > thread.lastAt) thread.lastAt = at; }
  if (title) thread.title = String(title);
  if (project) thread.project = String(project);
  thread.dirty = true;
  return thread;
}

/** The outcome word of a dispatch event: the worker's own status, else the run's, else the event's reason. */
export function runOutcome(run = {}, reason = '') {
  const status = String(run.lastResult?.status || '').toLowerCase();
  if (reason === 'failed' || reason === 'interrupted') return reason;
  if (reason === 'stopped') return 'stopped';
  if (status) return status;
  const outcome = String(run.outcome || '').toLowerCase();
  if (outcome) return outcome;
  return reason === 'completed' ? 'done' : String(run.status || reason || 'running').toLowerCase();
}

/** A dispatch event of the conversation: the run's title, outcome, follow-ups and question. */
export function noteRun(thread, run = {}, reason = '', at = null) {
  if (!run?.runId) return thread;
  const id = String(run.runId);
  const previous = thread.runs?.[id] || {};
  const followUps = Array.isArray(run.lastResult?.follow_ups)
    ? run.lastResult.follow_ups.map((item) => oneLine(item, THREAD.itemClip)).filter((item) => item && !/^none\.?$/i.test(item)).slice(0, 4)
    : previous.followUps || [];
  const next = {
    title: oneLine(run.title || run.task || previous.title || id.slice(0, 8), 80),
    provider: run.provider ? String(run.provider) : previous.provider || null,
    outcome: runOutcome(run, reason),
    followUps,
    note: oneLine(run.lastResult?.question || run.error || previous.note || '', THREAD.itemClip),
    at: at || previous.at || null,
  };
  if (JSON.stringify(previous) === JSON.stringify(next)) return thread;
  thread.runs = { ...(thread.runs || {}), [id]: next };
  // Bounded: the oldest runs go first.
  const ids = Object.keys(thread.runs);
  for (const old of ids.slice(0, Math.max(0, ids.length - THREAD.runs * 3))) delete thread.runs[old];
  if (at && (!thread.lastAt || at > thread.lastAt)) thread.lastAt = at;
  thread.dirty = true;
  return thread;
}

/** A run that left the conversation (cleared by the user): it is not an open item any more. */
export function dropRun(thread, runId) {
  if (!thread?.runs?.[String(runId)]) return thread;
  const next = { ...thread.runs };
  delete next[String(runId)];
  thread.runs = next;
  thread.dirty = true;
  return thread;
}

/**
 * What is still open: [{ key, kind, text }] with stable keys, newest runs first.
 * `cards`: the cards left unanswered right now ([{ id, kind, title }]).
 */
export function openItems(thread, { cards = [] } = {}) {
  const items = [];
  const runs = Object.entries(thread?.runs || {}).reverse();
  for (const [id, run] of runs) {
    if (OPEN_OUTCOMES.has(run.outcome)) {
      items.push({ key: `run:${id}:${run.outcome}`, kind: run.outcome, text: clipText(`${run.outcome.replace('_', ' ')}: ${run.title}${run.note ? ` (${run.note})` : ''}`, THREAD.itemClip) });
    }
    (run.followUps || []).forEach((text, index) => {
      items.push({ key: `follow:${id}:${index}`, kind: 'follow_up', text: clipText(`follow-up (${run.title}): ${text}`, THREAD.itemClip) });
    });
  }
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card?.id) continue;
    items.push({ key: `card:${card.id}`, kind: 'card', text: clipText(`unanswered ${card.kind || 'question'} card${card.title ? `: ${card.title}` : ''}`, THREAD.itemClip) });
  }
  return items.slice(0, THREAD.openItems);
}

/** The memory content. Deterministic: the same thread and cards give the same text. */
export function threadContent(thread, { cards = [] } = {}) {
  const lines = [`${HEAD}${clipText(thread.title || 'Untitled', 80)}`];
  const start = minute(thread.startedAt);
  const end = minute(thread.lastAt);
  const span = start ? (end && end !== start ? `${start} → ${end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end} UTC` : `${start} UTC`) : null;
  const prompts = Number(thread.prompts) || 0;
  lines.push([`Project ${thread.project || 'global'}`, span, `${prompts} ${prompts === 1 ? 'prompt' : 'prompts'}`].filter(Boolean).join(' · '));
  if (thread.asks?.length) { lines.push('Asks:'); for (const ask of thread.asks.slice(-THREAD.asks)) lines.push(`- ${ask.text}`); }
  const runs = Object.values(thread.runs || {}).slice(-THREAD.runs);
  if (runs.length) { lines.push('Runs:'); for (const run of runs) lines.push(`- ${run.title}${run.provider ? ` (${run.provider})` : ''}: ${String(run.outcome || 'running').replace('_', ' ')}`); }
  const open = openItems(thread, { cards });
  if (open.length) { lines.push('Open:'); for (const item of open) lines.push(`- ${item.text}`); }
  lines.push(`Session ${thread.sessionId}`);
  return lines.join('\n');
}

/** A thread memory's content read back: { title, project, endedAt, prompts, asks, runs, open, sessionId } or null. */
export function parseThread(content, { updatedAt = null } = {}) {
  const lines = String(content ?? '').split(/\r?\n/).map((line) => line.trimEnd());
  if (!lines[0]?.startsWith(HEAD)) return null;
  const out = { title: lines[0].slice(HEAD.length).trim(), project: 'global', startedAt: null, endedAt: updatedAt, prompts: 0, asks: [], runs: [], open: [], sessionId: null };
  let section = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith('Project ')) {
      const parts = line.split(' · ');
      out.project = parts[0].slice('Project '.length).trim() || 'global';
      const span = parts.find((part) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(part));
      if (span) {
        const [from, to] = span.replace(/ UTC$/, '').split(' → ');
        out.startedAt = `${from.replace(' ', 'T')}:00.000Z`;
        const end = to ? (to.length <= 5 ? `${from.slice(0, 10)} ${to}` : to) : from;
        out.endedAt = `${end.replace(' ', 'T')}:00.000Z`;
      }
      const count = parts.find((part) => /^\d+ prompts?$/.test(part));
      if (count) out.prompts = Number.parseInt(count, 10) || 0;
      continue;
    }
    if (line === 'Asks:' || line === 'Runs:' || line === 'Open:') { section = line.slice(0, -1).toLowerCase(); continue; }
    if (line.startsWith('Session ')) { out.sessionId = line.slice('Session '.length).trim() || null; section = null; continue; }
    if (line.startsWith('- ') && section) (section === 'open' ? out.open : out[section]).push(line.slice(2).trim());
  }
  return out;
}

/** "5 min ago", "3 h ago", "2 days ago". */
export function ago(fromMs, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - fromMs) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Is a past thread worth a word at session open: the same project, or recent enough? */
export function threadIsRecent(parsed, { project = 'global', now = Date.now(), hours = NUDGES.lastThreadHours } = {}) {
  if (!parsed) return false;
  const same = String(parsed.project || 'global').toLowerCase() === String(project || 'global').toLowerCase() && String(project || 'global').toLowerCase() !== 'global';
  const ended = Date.parse(parsed.endedAt ?? '');
  const recent = Number.isFinite(ended) && now - ended <= hours * 3_600_000;
  return same || recent;
}

/** The session-open line for the last thread. `open`: the open item texts still to be said. */
export function lastThreadLine(parsed, { now = Date.now(), open = parsed?.open || [], shown = NUDGES.openItemsShown } = {}) {
  if (!parsed?.title) return '';
  const ended = Date.parse(parsed.endedAt ?? '');
  const when = Number.isFinite(ended) ? ago(ended, now) : null;
  const where = parsed.project && parsed.project !== 'global' ? parsed.project : null;
  const head = `Last conversation${when || where ? ` (${[when, where].filter(Boolean).join(', ')})` : ''}: "${clipText(parsed.title, 70)}".`;
  const items = (Array.isArray(open) ? open : []).slice(0, shown);
  return items.length ? `${head} Still open: ${items.join('; ')}.` : head;
}

const STOPWORDS = new Set(('about after again also because been before being could does doing done each from have having here into just more most much only other over same should some such than that their them then there these they this those through under until very want were what when where which while will with would your yours '
  + 'para como mais muito também quando onde porque sobre depois antes ainda esse essa isso este esta isto aquele aquela pelo pela pelos pelas você voce vocês nosso nossa então entao fazer feito pode podem precisa').split(' '));

/** The significant words of a text: lowercase, four letters or more, no stopwords. */
export function significantWords(text) {
  const words = String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  return new Set(words);
}

/** How many significant words two texts share. */
export function overlap(a, b) {
  const left = significantWords(a);
  let shared = 0;
  for (const word of significantWords(b)) if (left.has(word)) shared += 1;
  return shared;
}

// Unicode-aware word edges: \b does not see "é" or "ó" as letters.
const EDGE_L = '(?<![\\p{L}\\p{N}])';
const EDGE_R = '(?![\\p{L}\\p{N}])';
const CLOSING_RE = new RegExp(`${EDGE_L}(?:${[
  "that(?:'s| is|s) (?:all|it)", 'all for (?:now|today|tonight)', 'done for (?:now|today|the day)', 'good ?night',
  'see you', 'bye', 'wrap(?:ping)? (?:it |this |things )?up', "we(?:'re| are) done", 'call it a (?:day|night)', 'signing off',
  '(?:é|e) isso', 'por hoje (?:é|e) s[óo]', 's[óo] isso', 'era isso', 'boa noite', 'at[ée] (?:amanh[ãa]|mais|logo)',
  'tchau', 'por hoje chega', 'terminamos', 'encerr(?:ar|amos|ando)',
].join('|')})${EDGE_R}`, 'iu');

/** A turn that closes the conversation ("that's all for today", "por hoje é só"). */
export function isClosingTurn(prompt) {
  const text = String(prompt ?? '').trim();
  return text.length <= 200 && CLOSING_RE.test(text);
}

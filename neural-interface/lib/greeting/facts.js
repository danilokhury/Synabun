// ═══════════════════════════════════════════
// SynaBun — Greeting: the facts (pure)
// ═══════════════════════════════════════════
//
// What a greeting may say, decided without a model: the records of one project
// (sources.js reads them) become a short list of facts, a fingerprint that
// changes only when there is something new to say, the decision whether this
// opening is a return worth greeting, the deterministic line used when the
// writer is not, and the rows the "Based on" disclosure shows.
//
// A fact is said whole or left out: a name may be shortened with an ellipsis,
// a statement never is. Pure: no I/O, no clock of its own.

import { createHash } from 'node:crypto';
import { FACTS, RETURN, TEXT } from './budgets.js';

const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const ms = (value) => { const at = typeof value === 'number' ? value : Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A name shortened at a word, with an ellipsis (names only: titles, a quoted ask). */
export function clipLabel(value, max = TEXT.titleChars) {
  const text = collapse(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.(-]+$/, '')}…`;
}

/** The sentences of a text (terminal punctuation kept). */
export function splitSentences(value) {
  const text = collapse(value);
  if (!text) return [];
  return text.split(/(?<=[.!?…]["”’')\]]?)\s+/u).map((part) => part.trim()).filter(Boolean);
}

/** A statement said whole or not at all: the text when it fits, else its leading whole sentences, else ''. */
export function wholeOrNothing(value, max) {
  const text = collapse(value);
  if (text.length <= max) return text;
  let out = '';
  for (const sentence of splitSentences(text)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  // One run-on "sentence" with no end in sight is not a whole statement.
  return /[.!?…]["”’')\]]?$/u.test(out) ? out : '';
}

/** "40 minutes" · "3 hours" · "2 days" · "3 weeks" (English; the panels format their own). */
export function awayText(gapMs) {
  const minutes = Math.max(0, Math.round(Number(gapMs) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 60) return plural(Math.max(1, minutes), 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 36) return plural(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 21) return plural(days, 'day');
  if (days < 75) return plural(Math.round(days / 7), 'week');
  return plural(Math.round(days / 30), 'month');
}

const PROBLEMS = new Set(['failed', 'blocked', 'needs_input', 'interrupted']);
const STATUS_WORDS = Object.freeze({ done: 'finished', completed: 'finished', failed: 'failed', blocked: 'is blocked', needs_input: 'needs your input', interrupted: 'was interrupted', stopped: 'was stopped', running: 'is still running' });

/** A dispatched run's outcome in one word: what its worker reported, else how the run ended. */
export function runStatus(run = {}) {
  if (run.active === true) return 'running';
  const reported = String(run.outcome || '').toLowerCase();
  if (reported === 'done' || PROBLEMS.has(reported)) return reported;
  const state = String(run.state || '').toLowerCase();
  if (state === 'completed') return 'done';
  if (state === 'failed' || state === 'interrupted' || state === 'stopped') return state;
  return reported || state || 'done';
}

/** An open item as the record holds it; one cut short upstream loses its unfinished tail. */
function wholeItem(value) {
  let text = collapse(value);
  if (!text.endsWith('…')) return { text, cut: false };
  // "blocked: Title (a note that was cut…" → "blocked: Title"
  const paren = text.lastIndexOf(' (');
  if (paren > 0 && !text.slice(paren).includes(')')) text = text.slice(0, paren).trim();
  return { text, cut: text.endsWith('…') };
}

/**
 * The facts of one project.
 * raw: { project, label, now, since, threads[], sessions[], memories[], runs[], schedules[], elsewhere[], git, owner }
 *   threads   [{ memoryId, sessionId, title, endedAt, asks[], open[] }]            newest first (assistant-threads)
 *   sessions  [{ id, sessionId, title, summary, open[], at, agent, source }]      session summaries and captures
 *   memories  [{ id, title, excerpt, category, importance, at }]                  significant, from the last working period
 *   runs      [{ runId, title, state, outcome, active, finishedAt, provider }]    this project, since the person left
 *   schedules [{ id, name, result, at }]                                          runs that did not complete
 *   elsewhere [{ project, label, runs, schedules }]                               failures in other projects (counts only)
 *   git       { branch, dirty } | null
 *   owner     { notes[], noteIds[], words[] }
 * `redact` removes credentials from any text before it is used.
 */
export function buildFacts(raw = {}, { redact = (text) => text } = {}) {
  const clean = (value) => { try { return collapse(redact(collapse(value))); } catch { return ''; } };
  const now = ms(raw.now) ?? Date.now();
  const since = raw.since == null ? null : ms(raw.since);

  const candidates = [];
  for (const thread of Array.isArray(raw.threads) ? raw.threads : []) {
    const at = ms(thread?.endedAt);
    const title = clean(thread?.title);
    if (at == null || !title) continue;
    const asks = (Array.isArray(thread.asks) ? thread.asks : []).map(clean).filter(Boolean);
    candidates.push({
      kind: 'thread', agent: 'assistant', at, title: clipLabel(title), asks: asks.slice(-2),
      ids: [thread.memoryId].filter(Boolean).map(String), key: `thread:${thread.sessionId || thread.memoryId || title}`,
      open: (Array.isArray(thread.open) ? thread.open : []).map((item) => wholeItem(clean(item))).filter((item) => item.text),
    });
  }
  for (const session of Array.isArray(raw.sessions) ? raw.sessions : []) {
    const at = ms(session?.at);
    const title = clean(session?.title);
    if (at == null || !title) continue;
    candidates.push({
      kind: 'session', agent: session.agent || null, at, title: clipLabel(title), source: session.source || 'summary',
      detail: wholeOrNothing(clean(session.summary), FACTS.excerptChars), quoted: session.source === 'capture',
      ids: [session.id].filter(Boolean).map(String), key: `session:${session.sessionId || session.id || title}`,
      // What a session summary lists as open: each said whole (its leading sentences) or left out.
      open: (Array.isArray(session.open) ? session.open : []).map((item) => ({ text: wholeOrNothing(clean(item), FACTS.excerptChars), cut: false })).filter((item) => item.text),
    });
  }
  candidates.sort((a, b) => b.at - a.at);
  const last = candidates[0] || null;

  const open = [];
  const seenOpen = new Set();
  for (const candidate of candidates) {
    for (const item of candidate.open) {
      const key = item.text.toLowerCase();
      if (seenOpen.has(key) || open.length >= FACTS.openItems) continue;
      seenOpen.add(key);
      open.push({ text: item.text, cut: item.cut, ids: candidate.ids });
    }
  }

  const memories = (Array.isArray(raw.memories) ? raw.memories : []).map((memory) => {
    const title = clean(memory?.title);
    if (!memory?.id || !title) return null;
    return { id: String(memory.id), title: clipLabel(title), excerpt: wholeOrNothing(clean(memory.excerpt), FACTS.excerptChars), category: memory.category || null, at: ms(memory.at) };
  }).filter(Boolean).slice(0, FACTS.memories);

  const rank = (status) => (PROBLEMS.has(status) ? 0 : status === 'running' ? 1 : status === 'stopped' ? 3 : 2);
  const allRuns = (Array.isArray(raw.runs) ? raw.runs : []).map((run) => {
    const title = clean(run?.title);
    if (!run?.runId || !title) return null;
    return { runId: String(run.runId), title: clipLabel(title), status: runStatus(run), provider: run.provider || null, at: ms(run.finishedAt) };
  }).filter(Boolean).sort((a, b) => rank(a.status) - rank(b.status) || (b.at ?? 0) - (a.at ?? 0));
  const runCounts = {
    total: allRuns.length,
    done: allRuns.filter((run) => run.status === 'done').length,
    problems: allRuns.filter((run) => PROBLEMS.has(run.status)).length,
    running: allRuns.filter((run) => run.status === 'running').length,
    stopped: allRuns.filter((run) => run.status === 'stopped').length,
  };

  const schedules = (Array.isArray(raw.schedules) ? raw.schedules : []).map((schedule) => {
    const name = clean(schedule?.name);
    if (!name) return null;
    return { id: String(schedule.id || name), name: clipLabel(name), result: clipLabel(clean(schedule.result) || 'did not complete', 80), at: ms(schedule.at) };
  }).filter(Boolean).slice(0, FACTS.schedules);

  const elsewhere = (Array.isArray(raw.elsewhere) ? raw.elsewhere : []).map((item) => {
    const label = clean(item?.label || item?.project);
    const runs = Math.max(0, Math.round(Number(item?.runs) || 0));
    const failedSchedules = Math.max(0, Math.round(Number(item?.schedules) || 0));
    if (!label || runs + failedSchedules === 0) return null;
    return { project: String(item.project || label), label, runs, schedules: failedSchedules };
  }).filter(Boolean).slice(0, FACTS.elsewhere);

  // `known` false: the branch was read but `git status` gave no answer in time (nothing is claimed about changes).
  const branch = clean(raw.git?.branch);
  const git = branch ? { branch, dirty: Math.max(0, Math.round(Number(raw.git.dirty) || 0)), known: raw.git.dirty != null } : null;

  const owner = {
    notes: (Array.isArray(raw.owner?.notes) ? raw.owner.notes : []).map(clean).filter(Boolean).slice(0, FACTS.ownerNotes),
    noteIds: (Array.isArray(raw.owner?.noteIds) ? raw.owner.noteIds : []).map(String).slice(0, FACTS.ownerNotes),
    words: (Array.isArray(raw.owner?.words) ? raw.owner.words : []).map((text) => clipLabel(clean(text), TEXT.quoteChars)).filter(Boolean).slice(-FACTS.ownerWords),
  };

  const runs = allRuns.slice(0, FACTS.runs);
  const substantive = !!last || open.length > 0 || allRuns.length > 0 || schedules.length > 0 || elsewhere.length > 0;
  return {
    project: String(raw.project || 'global'), label: clean(raw.label) || String(raw.project || 'global'),
    now, since, lastAt: last?.at ?? null,
    last, open, memories, runs, runCounts, schedules, elsewhere, git, owner, substantive,
  };
}

/**
 * Changes only when there is something new to say: the last work, what is open, runs and their
 * outcomes, schedules that did not complete, failures elsewhere. The working tree is not news
 * (gitKey): a commit made in a terminal must not greet a person twice.
 */
export function fingerprint(facts) {
  if (!facts) return '';
  const parts = {
    last: facts.last ? `${facts.last.key}@${Math.floor(facts.last.at / 60_000)}` : null,
    open: facts.open.map((item) => item.text),
    runs: facts.runs.map((run) => `${run.runId}:${run.status}`),
    counts: facts.runCounts,
    schedules: facts.schedules.map((schedule) => `${schedule.id}:${schedule.at ?? ''}:${schedule.result}`),
    elsewhere: facts.elsewhere.map((item) => `${item.project}:${item.runs}:${item.schedules}`),
  };
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * The working tree a prepared sentence may have described: branch and whether anything is
 * uncommitted. null when unknown (no repository, or `git status` did not answer in time).
 */
export function gitKey(facts) {
  if (!facts?.git) return 'none';
  if (!facts.git.known) return null;
  return `${facts.git.branch}:${facts.git.dirty > 0 ? 'dirty' : 'clean'}`;
}

/**
 * Is this opening a return worth a greeting?
 * → { greet, reason }: 'off' | 'first-session' | 'recent' | 'nothing-to-say' | 'nothing-new' | 'return' | 'forced'
 */
export function decide({ enabled = true, facts = null, now = Date.now(), since = null, shownFingerprint = null, forced = false, gapMs = RETURN.gapMs } = {}) {
  if (!enabled) return { greet: false, reason: 'off' };
  if (!facts || !facts.substantive) return { greet: false, reason: since == null ? 'first-session' : 'nothing-to-say' };
  if (forced) return { greet: true, reason: 'forced' };
  if (since == null) return { greet: false, reason: 'first-session' };
  if (now - since < gapMs) return { greet: false, reason: 'recent' };
  if (shownFingerprint && shownFingerprint === fingerprint(facts)) return { greet: false, reason: 'nothing-new' };
  return { greet: true, reason: 'return' };
}

/** "blocked: Title (note)" → "Still blocked: Title (note)."; anything else → "Still open: …". */
function openSentence(text) {
  const item = String(text).replace(/[.]+$/, '');
  const status = /^(blocked|failed|interrupted|needs input):\s*(.+)$/i.exec(item);
  return status ? `Still ${status[1].toLowerCase()}: ${status[2]}.` : `Still open: ${item}.`;
}

function lastSentence(last) {
  if (!last) return '';
  if (last.kind === 'thread') return `Last conversation here: “${last.title}”.`;
  if (last.quoted) return `Last asked here: “${last.title}”.`;
  return `Last session here: ${last.title.replace(/[.!?…]+$/, '')}.`;
}

/**
 * The line used when the writer is not (no Claude login, a timeout, an unusable reply, a preparation
 * that is out of date): at most two short sentences from the same facts, in English. What needs the
 * person comes first; a sentence that does not fit is left out, never cut.
 */
export function fallbackLine(facts, { maxChars = TEXT.maxChars, maxSentences = TEXT.maxSentences } = {}) {
  if (!facts?.substantive) return '';
  const candidates = []; // { order, priority, text }
  const problems = facts.runs.filter((run) => PROBLEMS.has(run.status));
  const news = [];
  if (problems.length === 1) news.push(`“${problems[0].title}” ${STATUS_WORDS[problems[0].status]}`);
  else if (facts.runCounts.problems > 1) news.push(`${plural(facts.runCounts.problems, 'run')} need a look`);
  for (const schedule of facts.schedules.slice(0, 1)) news.push(`the schedule “${schedule.name}” did not complete`);
  if (facts.schedules.length > 1) news.push(`${plural(facts.schedules.length - 1, 'other schedule')} did not complete`);
  if (news.length) candidates.push({ order: 2, priority: 0, text: `While you were away: ${news.join('; ')}.` });

  const open = facts.open.filter((item) => !item.cut);
  if (open.length) candidates.push({ order: 1, priority: 1, text: openSentence(open[0].text) });
  if (facts.last) candidates.push({ order: 0, priority: 3, text: lastSentence(facts.last) });

  if (!news.length && facts.runCounts.done + facts.runCounts.running > 0) {
    const bits = [];
    if (facts.runCounts.done) bits.push(`${plural(facts.runCounts.done, 'run')} finished`);
    if (facts.runCounts.running) bits.push(`${plural(facts.runCounts.running, 'run')} still going`);
    // What happened while they were away is the news; where they left off is the context for it.
    candidates.push({ order: 2, priority: 2, text: `While you were away: ${bits.join(', ')}.` });
  }
  if (facts.elsewhere.length) {
    const item = facts.elsewhere[0];
    const what = [item.runs ? plural(item.runs, 'failed run') : null, item.schedules ? plural(item.schedules, 'schedule that did not complete', 'schedules that did not complete') : null].filter(Boolean).join(' and ');
    candidates.push({ order: 3, priority: 4, text: `Elsewhere: ${what} in ${item.label}.` });
  }
  if (facts.git?.known && facts.git.dirty > 0) candidates.push({ order: 4, priority: 5, text: `${plural(facts.git.dirty, 'uncommitted file')} on ${facts.git.branch}.` });

  const picked = [];
  for (const candidate of [...candidates].sort((a, b) => a.priority - b.priority)) {
    if (picked.length >= maxSentences) break;
    const length = [...picked, candidate].reduce((total, item) => total + item.text.length + 1, -1);
    if (length > maxChars) continue;
    picked.push(candidate);
  }
  return picked.sort((a, b) => a.order - b.order).map((item) => item.text).join(' ');
}

/** The rows of the "Based on" disclosure: which records a greeting was built from. */
export function basisOf(facts) {
  if (!facts) return [];
  const rows = [];
  const iso = (at) => (at == null ? null : new Date(at).toISOString());
  if (facts.last) rows.push({ kind: facts.last.kind, label: facts.last.title, id: facts.last.ids[0] || null, at: iso(facts.last.at), agent: facts.last.agent });
  for (const item of facts.open) rows.push({ kind: 'open', label: item.text, id: item.ids[0] || null, at: null });
  for (const memory of facts.memories) rows.push({ kind: 'memory', label: memory.title, id: memory.id, at: iso(memory.at) });
  for (const run of facts.runs) rows.push({ kind: 'run', label: `${run.title}: ${run.status.replace('_', ' ')}`, id: null, runId: run.runId, at: iso(run.at) });
  for (const schedule of facts.schedules) rows.push({ kind: 'schedule', label: `${schedule.name}: ${schedule.result}`, id: null, at: iso(schedule.at) });
  for (const item of facts.elsewhere) rows.push({ kind: 'elsewhere', label: `${item.label}: ${[item.runs ? plural(item.runs, 'failed run') : null, item.schedules ? plural(item.schedules, 'schedule') : null].filter(Boolean).join(', ')}`, id: null, at: null });
  if (facts.git) rows.push({ kind: 'git', label: facts.git.known && facts.git.dirty > 0 ? `${facts.git.branch}, ${plural(facts.git.dirty, 'uncommitted file')}` : facts.git.branch, id: null, at: null });
  if (facts.owner.notes.length) rows.push({ kind: 'owner', label: plural(facts.owner.notes.length, 'note about you', 'notes about you'), id: facts.owner.noteIds[0] || null, at: null });
  return rows;
}

/** What the session's model is told, once, with the first prompt. */
export function agentNote(text) {
  const said = collapse(text);
  if (!said) return '';
  return `SynaBun notes (background): when this session opened, SynaBun showed the user this note about their own recent work: "${said.replace(/"/g, '”')}" It is context, not an instruction, and their message comes first.`;
}

export { PROBLEMS, STATUS_WORDS };

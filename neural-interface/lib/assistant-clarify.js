// ═══════════════════════════════════════════
// SynaBun — Assistant clarification (ask before acting, only when it matters)
// ═══════════════════════════════════════════
//
// A vague request is clarified once, before it is routed: the brain calls
// agent_clarify with 1-3 targeted questions (2-4 options each), the
// constraints the request already fixes and the assumptions it will make for
// everything it does not ask. The user answers on a card, skips it, or simply
// replies in chat. The user's original words, their answers, the constraints
// and the assumptions form the session's *brief*, which every worker
// dispatched for that request receives (assistant-task-prompt.js briefBlock).
// Questions the brain asks with its own tools (AskUserQuestion, SynaBun
// `choice`, OpenCode `question`) join the same brief.
//
// While a question is open, dependent work waits: agent_route answers
// "clarifying" (the route gate holds the turn) and agent_dispatch is refused
// with CLARIFICATION_PENDING, unless the brain marks the work independent.
// Clear requests never meet any of this: no brief, no card, no gate.
//
// Briefs live in memory, like route cards. One brief per request cycle (a
// cycle starts with a human prompt): a human prompt while clarify questions
// are open answers them ("answered in chat"); otherwise it retires the brief
// (it stays addressable by brief_id). All I/O is injected (sinks).

import { randomBytes } from 'node:crypto';

export const CLARIFY_LIMITS = Object.freeze({
  maxQuestions: 3,
  minOptions: 2,
  maxOptions: 4,
  maxConstraints: 8,
  maxAssumptions: 6,
  requestChars: 4000,
  replyChars: 2000,
  briefsPerSession: 20,
});
export const DEFAULT_CLARIFY_WAIT_SECONDS = 45;
const RETIRED_TTL_MS = 24 * 60 * 60_000;
// SynaBun `choice` (mcp-server/src/tools/choice.ts): the elicitation message carries the questions as JSON.
const CHOICE_MARKER = '[SYNABUN_CHOICE_V1]';
const CHOICE_OTHER = '__synabun_other__';

function clip(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** Head and tail of a long text, line breaks kept (the user's own words). */
function clipBlock(value, max) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length <= max) return text;
  const marker = '\n[…]\n';
  const head = Math.floor((max - marker.length) * 0.7);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (max - marker.length - head))}`;
}
function obj(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function iso(ms) { return ms ? new Date(ms).toISOString() : null; }

export class ClarifyError extends Error {
  constructor(code, message, { status = 400, ...extra } = {}) {
    super(message);
    this.name = 'ClarifyError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

function slugId(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}
function cleanOptions(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const label = clip(typeof raw === 'string' ? raw : (raw?.label ?? raw?.value ?? raw?.title), 80);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, description: typeof raw === 'string' ? '' : clip(raw?.description ?? raw?.desc, 200) });
  }
  return out;
}
function cleanList(list, max, chars = 240) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : (typeof list === 'string' && list.trim() ? [list] : [])) {
    const text = clip(raw, chars);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}
function mergeInto(target, items, max) {
  for (const item of items) {
    if (target.length >= max) break;
    if (!target.some((existing) => existing.toLowerCase() === item.toLowerCase())) target.push(item);
  }
}

/**
 * agent_clarify's body → { summary, questions, constraints, assumptions }.
 * Keeps it light: 1-3 questions, each with 2-4 options (the user can always
 * type their own answer); duplicates are dropped. Throws ClarifyError 400.
 */
export function normalizeClarifyRequest(body = {}) {
  const raw = Array.isArray(body?.questions) ? body.questions.filter(Boolean) : [];
  const { maxQuestions, minOptions, maxOptions } = CLARIFY_LIMITS;
  if (!raw.length) throw new ClarifyError('CLARIFY_INVALID', 'Give 1-3 questions. If nothing material is unclear, do not clarify: act, and state what you assumed.');
  if (raw.length > maxQuestions) {
    throw new ClarifyError('CLARIFY_TOO_MANY', `Ask at most ${maxQuestions} questions, only the ones whose answer changes the result. Put everything else in assumptions.`);
  }
  const questions = [];
  const ids = new Set();
  const texts = new Set();
  raw.forEach((q, index) => {
    const question = clip(q?.question ?? q?.text, 300);
    if (!question) throw new ClarifyError('CLARIFY_INVALID', `Question ${index + 1} has no text.`);
    if (texts.has(question.toLowerCase())) return;
    texts.add(question.toLowerCase());
    const options = cleanOptions(q?.options);
    if (options.length < minOptions || options.length > maxOptions) {
      throw new ClarifyError('CLARIFY_INVALID', `Question ${index + 1} needs ${minOptions}-${maxOptions} distinct options, recommended first (the user can always type their own answer).`);
    }
    let id = slugId(q?.id) || `q${index + 1}`;
    while (ids.has(id)) id = `${id}_${index + 1}`;
    ids.add(id);
    questions.push({
      id,
      header: clip(q?.header, 40) || clip(question.replace(/\?+$/, ''), 40),
      question,
      options,
      multiSelect: q?.multi_select === true || q?.multiSelect === true,
    });
  });
  return {
    summary: clip(body?.summary, 200),
    questions,
    constraints: cleanList(body?.constraints, CLARIFY_LIMITS.maxConstraints),
    assumptions: cleanList(body?.assumptions, CLARIFY_LIMITS.maxAssumptions),
  };
}

/** Questions a brain asked with its own tool, from its control_request's `request` ([] for anything else). */
export function questionsFromControl(request = {}) {
  const req = obj(request) || {};
  const input = obj(req.input) || {};
  const message = typeof input.message === 'string' ? input.message : (typeof req.params?.message === 'string' ? req.params.message : '');
  let list = null;
  if (message.startsWith(CHOICE_MARKER)) {
    try { list = JSON.parse(message.slice(CHOICE_MARKER.length))?.questions; } catch { list = null; }
  } else if (String(req.tool_name || req.toolName || '') === 'AskUserQuestion' || req.kind === 'question') {
    list = Array.isArray(input.questions) ? input.questions : (Array.isArray(req.questions) ? req.questions : null);
  }
  if (!Array.isArray(list)) return [];
  return list.filter(Boolean).slice(0, 6).map((q, index) => {
    const question = clip(q?.question ?? q?.text ?? q?.prompt, 300);
    return {
      id: String(q?.id ?? '').trim() || question || `q${index + 1}`,
      header: clip(q?.header ?? q?.title, 40),
      question,
      options: cleanOptions(q?.options),
      multiSelect: q?.multiSelect === true || q?.multiple === true,
    };
  }).filter((q) => q.question || q.header);
}

function answerList(value) {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(answerList);
  const nested = obj(value);
  if (nested) return Array.isArray(nested.answers) ? nested.answers.flatMap(answerList) : [];
  return [clip(value, 500)].filter(Boolean);
}

/**
 * A card or tool reply → { declined, answers: [{ id, header, question, answers[] }], note }.
 * Reads every reply shape the assistant panel builds: per-question lists
 * (clarify cards, OpenCode), Claude's `updatedInput.answers` keyed by question
 * text, Codex `answers` keyed by id ({answers:[…]}), and MCP elicitation
 * `content` (SynaBun `choice`, with its "Other" companion fields).
 */
export function answersFromResponse(questions = [], response = {}) {
  const r = obj(response) || {};
  const action = r.result?.action || r.action || null;
  const note = clip(r.message ?? r.note ?? '', 500) || null;
  if (r.behavior === 'deny' || r.decline === true || r.skip === true || r.cancel === true || r.reject === true || action === 'decline' || action === 'cancel') {
    return { declined: true, answers: [], note };
  }
  const lists = Array.isArray(r.answers) ? r.answers : null;
  // Keys compared without case or spacing differences (Claude keys answers by the question's own text).
  const norm = (key) => String(key ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const maps = [obj(r.answers), obj(r.updatedInput?.answers), obj(r.result?.answers), obj(r.content), obj(r.result?.content)]
    .filter(Boolean)
    .map((map) => ({ map, keys: new Map(Object.keys(map).map((key) => [norm(key), key])) }));
  const blank = (value) => value === undefined || value === null || value === '';
  const answers = questions.map((q, index) => {
    let value = lists ? lists[index] : undefined;
    for (const { map, keys } of maps) {
      if (!blank(value)) break;
      for (const key of [q.id, q.question, q.header, String(index)]) {
        const hit = key !== undefined && key !== null && key !== '' ? keys.get(norm(key)) : undefined;
        if (hit !== undefined) { value = map[hit]; break; }
      }
      if (value === CHOICE_OTHER) value = map[`${q.id}__other`];
    }
    return { id: q.id, header: q.header, question: q.question, answers: answerList(value).filter((a) => a !== CHOICE_OTHER).slice(0, 8) };
  });
  // Nothing matched by key, and one map has exactly one entry per question: read it in order.
  if (!answers.some((a) => a.answers.length)) {
    const ordered = maps.find(({ map }) => Object.keys(map).length === questions.length);
    if (ordered) Object.values(ordered.map).forEach((value, index) => { answers[index].answers = answerList(value).filter((a) => a !== CHOICE_OTHER).slice(0, 8); });
  }
  return { declined: !answers.some((a) => a.answers.length), answers, note };
}

/**
 * @param {object} deps
 * @param {(sessionId:string)=>({lastPrompt, cycle}|null)} deps.getSession  the runtime's view of the session
 * @param {()=>({enabled?, waitSeconds?})} [deps.settings]  read live (assistant-config.json `clarify`)
 * @param {object} deps.sinks { sendCard(sessionId, packet), cancelCard(sessionId, requestId, reason),
 *                              event(sessionId, phase, view), mailbox(sessionId, item), gate(sessionId, result) }
 */
export function createAssistantClarifier({
  getSession = () => null,
  settings = () => ({}),
  sinks = {},
  now = Date.now,
  randomId = () => randomBytes(6).toString('hex'),
  log = () => {},
} = {}) {
  const states = new Map();     // sessionId → { activeId, briefs: Map<briefId, brief> }
  const byRequest = new Map();  // clarify card requestId → { sessionId, briefId, roundId }
  const byNative = new Map();   // `${sessionId}:${requestId}` → { briefId, roundId } (native ids repeat per brain)
  const call = (name, ...args) => { try { return sinks[name]?.(...args); } catch (error) { log('clarify:sink-error', `${name}: ${error?.message || error}`); return undefined; } };

  function config() {
    let raw = {};
    try { raw = settings() || {}; } catch { raw = {}; }
    const wait = Number(raw.waitSeconds);
    return {
      enabled: raw.enabled !== false,
      waitSeconds: Number.isFinite(wait) && wait >= 0 ? Math.min(110, wait) : DEFAULT_CLARIFY_WAIT_SECONDS,
    };
  }
  function stateOf(sessionId, create = false) {
    let state = states.get(sessionId);
    if (!state && create) { state = { activeId: null, briefs: new Map() }; states.set(sessionId, state); }
    return state || null;
  }
  function activeBrief(sessionId) {
    const state = stateOf(sessionId);
    return state?.activeId ? state.briefs.get(state.activeId) || null : null;
  }
  function pendingRound(brief) { return brief?.rounds.find((round) => round.status === 'pending') || null; }
  function prune(state) {
    const cutoff = now() - RETIRED_TTL_MS;
    for (const [id, brief] of state.briefs) {
      if (id !== state.activeId && !pendingRound(brief) && brief.updatedAt < cutoff) state.briefs.delete(id);
    }
    const settled = [...state.briefs.values()].filter((b) => b.briefId !== state.activeId && !pendingRound(b)).sort((a, b) => a.updatedAt - b.updatedAt);
    while (state.briefs.size > CLARIFY_LIMITS.briefsPerSession && settled.length) state.briefs.delete(settled.shift().briefId);
  }
  function retire(state, brief) {
    if (!brief) return;
    brief.active = false;
    if (state.activeId === brief.briefId) state.activeId = null;
  }
  /** The active brief of this request cycle, or a new one. */
  function briefFor(sessionId, { cycle = 0, request = '', summary = '' } = {}) {
    const state = stateOf(sessionId, true);
    let brief = activeBrief(sessionId);
    if (brief && brief.cycle !== cycle && !pendingRound(brief)) { retire(state, brief); brief = null; }
    if (!brief) {
      brief = {
        briefId: `brief-${randomId()}`, sessionId, cycle, request: clipBlock(request || summary, CLARIFY_LIMITS.requestChars),
        summary: clip(summary, 200), rounds: [], constraints: [], assumptions: [], createdAt: now(), updatedAt: now(), active: true,
      };
      state.briefs.set(brief.briefId, brief);
      state.activeId = brief.briefId;
      prune(state);
    } else if (summary && !brief.summary) brief.summary = clip(summary, 200);
    return brief;
  }
  function findRound(sessionId, briefId, roundId) {
    const brief = stateOf(sessionId)?.briefs.get(briefId) || null;
    return { brief, round: brief?.rounds.find((round) => round.roundId === roundId) || null };
  }

  // ── views ──────────────────────────────────────────────────────────────────
  function decisionsOf(brief) {
    const out = [];
    for (const round of brief.rounds) {
      if (round.status !== 'answered') continue;
      for (const answer of round.answers || []) {
        if (answer.answers?.length) out.push({ header: answer.header || '', question: answer.question || '', answers: [...answer.answers] });
      }
    }
    return out;
  }
  function statusOf(brief) {
    if (pendingRound(brief)) return 'pending';
    const settled = brief.rounds.filter((round) => round.status !== 'cancelled');
    if (settled.some((round) => round.status === 'answered')) return 'answered';
    if (settled.length) return 'declined';
    return brief.rounds.length ? 'cancelled' : 'empty';
  }
  function roundView(round) {
    return {
      roundId: round.roundId, requestId: round.requestId, source: round.source, status: round.status, via: round.via || null,
      questions: round.questions.map((q) => ({ id: q.id, header: q.header, question: q.question })),
      answers: (round.answers || []).map((a) => ({ id: a.id, header: a.header, answers: [...(a.answers || [])] })),
      reply: round.reply ? clip(round.reply, 300) : null, note: round.note || null,
      createdAt: iso(round.createdAt), settledAt: iso(round.settledAt),
    };
  }
  /** Public view: events, mailbox items, REST. */
  function briefView(brief, { round = null } = {}) {
    if (!brief) return null;
    return {
      briefId: brief.briefId, status: statusOf(brief), summary: brief.summary || '', request: clip(brief.request, 600),
      decisions: decisionsOf(brief), constraints: [...brief.constraints], assumptions: [...brief.assumptions],
      rounds: brief.rounds.map(roundView), round: round ? roundView(round) : null, active: !!brief.active,
      createdAt: iso(brief.createdAt), updatedAt: iso(brief.updatedAt),
    };
  }
  /** What a dispatched worker receives (assistant-task-prompt.js briefBlock): plain, JSON-safe. */
  function snapshot(brief) {
    const settled = brief.rounds.filter((round) => round.status === 'answered' || round.status === 'declined');
    const replies = settled.map((round) => round.reply).filter(Boolean).map((text) => clipBlock(text, CLARIFY_LIMITS.replyChars));
    const decisions = decisionsOf(brief);
    return {
      briefId: brief.briefId, request: brief.request, summary: brief.summary || '',
      decisions, replies,
      skipped: settled.length > 0 && !decisions.length && !replies.length,
      notes: settled.map((round) => round.note).filter(Boolean),
      constraints: [...brief.constraints], assumptions: [...brief.assumptions],
      clarifiedAt: iso(Math.max(0, ...settled.map((round) => round.settledAt || 0)) || null),
    };
  }
  function cardPacket(brief, round) {
    return {
      type: 'control_request',
      request_id: round.requestId,
      request: {
        subtype: 'clarify', kind: 'clarify', provider: 'synabun', briefId: brief.briefId, sessionId: brief.sessionId,
        summary: brief.summary || '', questions: round.questions, assumptions: [...brief.assumptions], constraints: [...brief.constraints],
        createdAt: iso(round.createdAt),
      },
    };
  }

  // ── results for the brain ──────────────────────────────────────────────────
  function nextText(status, brief, { again = false, round = null } = {}) {
    const id = brief.briefId;
    if (status === 'answered') {
      return `The user answered. Route the task now (agent_route), then agent_dispatch with brief_id "${id}": SynaBun adds the user's original request, these answers, your constraints and assumptions to the worker's context and marks the answers as binding, so do not paste them; write the task in line with the answers. Doing it here yourself: follow them.`;
    }
    if (status === 'declined') {
      return `The user skipped the questions${round?.note ? ` (their note: "${clip(round.note, 200)}")` : ''}. Proceed on your stated assumptions (they reach the worker with brief_id "${id}"), or ask in chat only if the task cannot be done without an answer.`;
    }
    if (status === 'pending') {
      return `${again ? `Your questions (brief ${id}) are already on screen: do not ask again. ` : 'The user has not answered yet. '}End your turn now with one short line; the card shows the questions, so do not repeat them. Nothing that depends on the answers may start: agent_route answers "clarifying" and agent_dispatch is refused until the user answers. The answers arrive as a [SynaBun Mailbox] clarify_answered event, or as the user's next message. Work that does not depend on them: route and dispatch it with independent:true.`;
    }
    return 'The questions were cancelled. Do not start the task; ask the user how to proceed.';
  }
  function resultFor(brief, status, { round = null, again = false } = {}) {
    return {
      ok: true, status, briefId: brief.briefId, summary: brief.summary || '',
      questions: round ? round.questions.map((q) => ({ id: q.id, header: q.header })) : [],
      decisions: decisionsOf(brief), reply: round?.reply ? clip(round.reply, 400) : null, note: round?.note || null,
      constraints: [...brief.constraints], assumptions: [...brief.assumptions],
      next: nextText(status, brief, { again, round }),
    };
  }
  function pendingError(brief) {
    const what = brief.summary || clip(brief.request, 80);
    const ref = `brief ${brief.briefId}${what ? `: "${what}"` : ''}`;
    const native = pendingRound(brief)?.source === 'native';
    return new ClarifyError('CLARIFICATION_PENDING', native
      ? `A question you asked the user is still open (${ref}). Do not dispatch work that depends on it before its answer comes back. If this work does not depend on it, send it again with independent:true.`
      : `The user has not answered your questions yet (${ref}). Do not dispatch work that depends on them: end your turn; the answers arrive as a [SynaBun Mailbox] clarify_answered event or as the user's next message. If this work does not depend on them, send it again with independent:true.`,
    { status: 409, briefId: brief.briefId });
  }

  // ── settling a round ───────────────────────────────────────────────────────
  function settleRound(brief, round, status, { via = null, answers = [], reply = null, note = null, reason = null } = {}) {
    if (round.status !== 'pending') return;
    round.status = status;
    round.via = via;
    round.answers = answers;
    round.reply = reply;
    round.note = note;
    round.settledAt = now();
    brief.updatedAt = round.settledAt;
    const inCall = round.waiters.size > 0;
    for (const waiter of [...round.waiters]) { try { waiter(true); } catch {} }
    round.waiters.clear();
    if (round.source !== 'clarify') { byNative.delete(`${brief.sessionId}:${round.requestId}`); return; }
    byRequest.delete(round.requestId);
    if (status === 'cancelled') call('cancelCard', brief.sessionId, round.requestId, reason || 'cancelled');
    const phase = status === 'answered' && via === 'chat' ? 'chat' : status;
    call('event', brief.sessionId, phase, briefView(brief, { round }));
    // The brain ended its turn on "pending": the answer is news it has to act on.
    if (!inCall && round.mailbox && (status === 'answered' || status === 'declined') && via !== 'chat') {
      call('mailbox', brief.sessionId, {
        kind: status === 'declined' ? 'clarify_declined' : 'clarify_answered',
        brief: briefView(brief, { round }),
        text: nextText(status, brief, { round }),
      });
    }
    log('clarify:settled', `${brief.briefId}/${round.roundId} ${status}${via ? ` via ${via}` : ''}`);
  }
  function waitFor(round, ms, signal) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        round.waiters.delete(finish);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), ms);
      timer.unref?.();
      round.waiters.add(finish);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  // ── agent_clarify ──────────────────────────────────────────────────────────
  /**
   * Show the user the questions and wait up to `clarify.waitSeconds` (never
   * past the caller's deadline) → answered | declined | pending. One open card
   * per session: asking again while it waits returns its pending result.
   */
  async function ask({ sessionId, body = {}, waitMs = null, signal = null } = {}) {
    if (!sessionId) throw new ClarifyError('SESSION_REQUIRED', 'assistant_session_id is required');
    const ctx = getSession(sessionId);
    if (!ctx) throw new ClarifyError('SESSION_NOT_FOUND', `Unknown assistant session ${sessionId}`, { status: 404 });
    const cfg = config();
    if (!cfg.enabled) {
      return { ok: false, status: 'disabled', code: 'CLARIFY_DISABLED', next: 'Clarification is switched off for this assistant. Act on your stated assumptions, or ask in chat.' };
    }
    const input = normalizeClarifyRequest(body);
    const brief = briefFor(sessionId, { cycle: Number(ctx.cycle) || 0, request: ctx.lastPrompt || '', summary: input.summary });
    const open = pendingRound(brief);
    if (open) {
      const result = resultFor(brief, 'pending', { round: open, again: true });
      call('gate', sessionId, result);
      return result;
    }
    mergeInto(brief.constraints, input.constraints, CLARIFY_LIMITS.maxConstraints);
    mergeInto(brief.assumptions, input.assumptions, CLARIFY_LIMITS.maxAssumptions);
    const round = {
      roundId: `r${brief.rounds.length + 1}`, requestId: `clarify-${randomId()}`, source: 'clarify', status: 'pending', via: null,
      questions: input.questions, answers: [], reply: null, note: null, createdAt: now(), settledAt: null, waiters: new Set(), mailbox: false,
    };
    brief.rounds.push(round);
    brief.updatedAt = round.createdAt;
    byRequest.set(round.requestId, { sessionId, briefId: brief.briefId, roundId: round.roundId });
    call('sendCard', sessionId, cardPacket(brief, round));
    // A host can close the card while it is being sent (the user had already written something
    // else): no "card" event after its "cancelled", and no wait on a round that is settled.
    if (round.status === 'pending') call('event', sessionId, 'card', briefView(brief, { round }));
    const configured = cfg.waitSeconds * 1000;
    const budget = waitMs === null || waitMs === undefined ? configured : Math.min(configured, Number(waitMs));
    const wait = Math.max(0, Math.min(Number.isFinite(budget) ? budget : 0, 110_000));
    if (wait > 0 && round.status === 'pending') await waitFor(round, wait, signal);
    if (round.status === 'pending') {
      round.mailbox = true;
      const result = resultFor(brief, 'pending', { round });
      call('gate', sessionId, result);
      return result;
    }
    return resultFor(brief, round.status, { round });
  }

  /**
   * The user answered (or skipped) a clarify card. `sessionId`: the session the
   * answer came in on; a card of another session is refused (CLARIFY_NOT_FOUND).
   */
  function answer(requestId, response = {}, { origin = 'ui', sessionId = null } = {}) {
    const ref = byRequest.get(String(requestId));
    if (!ref || (sessionId !== null && sessionId !== undefined && ref.sessionId !== String(sessionId))) {
      throw new ClarifyError('CLARIFY_NOT_FOUND', `Unknown or already answered clarification ${requestId}`, { status: 404 });
    }
    const { brief, round } = findRound(ref.sessionId, ref.briefId, ref.roundId);
    if (!brief || !round || round.status !== 'pending') {
      byRequest.delete(String(requestId));
      throw new ClarifyError('CLARIFY_ALREADY_ANSWERED', 'These questions were already answered.', { status: 409 });
    }
    const parsed = answersFromResponse(round.questions, response);
    settleRound(brief, round, parsed.declined ? 'declined' : 'answered', { via: origin === 'rest' ? 'rest' : 'card', answers: parsed.declined ? [] : parsed.answers, note: parsed.note });
    return resultFor(brief, round.status, { round });
  }

  /**
   * A human prompt reached the session. Open clarify questions: the prompt is
   * the user's reply (→ a note for the brain's turn). Otherwise a settled brief
   * retires: a new request starts without it.
   */
  function onUserPrompt(sessionId, { text = '', cycle = 0 } = {}) {
    const state = stateOf(sessionId);
    const brief = activeBrief(sessionId);
    if (!state || !brief) return null;
    // A slash command is neither a reply nor a new request.
    if (/^\/[\w:.-]+/.test(String(text || '').trim())) return null;
    const open = brief.rounds.filter((round) => round.status === 'pending' && round.source === 'clarify');
    if (!open.length) {
      if (!pendingRound(brief)) retire(state, brief);
      return null;
    }
    const reply = clipBlock(text, CLARIFY_LIMITS.replyChars);
    for (const round of open) settleRound(brief, round, 'answered', { via: 'chat', reply });
    brief.cycle = cycle;
    const what = brief.summary ? `: "${clip(brief.summary, 80)}"` : '';
    return {
      briefId: brief.briefId,
      note: `[SynaBun Clarify] The user's message below replies to your open questions (brief ${brief.briefId}${what}). Treat it as their answers and continue; agent_dispatch attaches this brief. If it is a different request instead, route and dispatch that with independent:true.`,
    };
  }

  // ── questions asked with the brain's own tools ─────────────────────────────
  function onNativeQuestion(sessionId, { requestId, request = {}, cycle = null, prompt = '' } = {}) {
    if (!sessionId || requestId === undefined || requestId === null || !config().enabled) return null;
    const questions = questionsFromControl(request);
    if (!questions.length) return null;
    const key = `${sessionId}:${requestId}`;
    if (byNative.has(key)) return byNative.get(key).briefId;
    const ctx = getSession(sessionId) || {};
    const brief = briefFor(sessionId, { cycle: Number(cycle ?? ctx.cycle) || 0, request: prompt || ctx.lastPrompt || '' });
    const round = {
      roundId: `r${brief.rounds.length + 1}`, requestId: String(requestId), source: 'native', status: 'pending', via: null,
      questions, answers: [], reply: null, note: null, createdAt: now(), settledAt: null, waiters: new Set(), mailbox: false,
    };
    brief.rounds.push(round);
    brief.updatedAt = round.createdAt;
    byNative.set(key, { briefId: brief.briefId, roundId: round.roundId });
    return brief.briefId;
  }
  function onNativeAnswer(sessionId, { requestId, response = {} } = {}) {
    const ref = byNative.get(`${sessionId}:${requestId}`);
    if (!ref) return null;
    const { brief, round } = findRound(sessionId, ref.briefId, ref.roundId);
    if (!brief || !round) { byNative.delete(`${sessionId}:${requestId}`); return null; }
    const parsed = answersFromResponse(round.questions, response);
    settleRound(brief, round, parsed.declined ? 'declined' : 'answered', { via: 'native', answers: parsed.declined ? [] : parsed.answers, note: parsed.note });
    return brief.briefId;
  }
  /** The native question closed without an answer (timeout, turn ended, brain gone). */
  function onNativeSettled(sessionId, requestId, reason = 'cancelled') {
    const ref = byNative.get(`${sessionId}:${requestId}`);
    if (!ref) return;
    const { brief, round } = findRound(sessionId, ref.briefId, ref.roundId);
    if (brief && round) settleRound(brief, round, 'cancelled', { via: 'native', reason });
    byNative.delete(`${sessionId}:${requestId}`);
  }

  // ── what depends on the answers ────────────────────────────────────────────
  /**
   * agent_route: { briefId, summary } while a clarify card waits for the user,
   * else null. The brain's own question tools block its turn by themselves.
   */
  function blocking(sessionId, { briefId = null, independent = false } = {}) {
    if (!sessionId || independent === true || !config().enabled) return null;
    const state = stateOf(sessionId);
    const brief = briefId ? state?.briefs.get(String(briefId)) || null : activeBrief(sessionId);
    const open = brief?.rounds.find((round) => round.status === 'pending' && round.source === 'clarify');
    if (!open) return null;
    return { briefId: brief.briefId, summary: brief.summary || clip(brief.request, 120), source: open.source };
  }
  /**
   * agent_dispatch: the brief to hand the worker (snapshot) or null; throws
   * CLARIFICATION_PENDING (409) while its questions are open and BRIEF_UNKNOWN
   * (400) for a brief_id this session does not have. Without a brief_id the
   * active brief of the request applies, unless the work is independent.
   */
  function forDispatch(sessionId, { briefId = null, independent = false } = {}) {
    if (!sessionId || !config().enabled) return null;
    const state = stateOf(sessionId);
    if (briefId) {
      const brief = state?.briefs.get(String(briefId)) || null;
      if (!brief) {
        throw new ClarifyError('BRIEF_UNKNOWN', `Unknown brief_id "${briefId}" for this session (briefs are kept in memory; a server restart drops them). Dispatch again without brief_id and restate the user's answers in context.`, { status: 400 });
      }
      if (pendingRound(brief)) throw pendingError(brief);
      return snapshot(brief);
    }
    if (independent === true) return null;
    const brief = activeBrief(sessionId);
    if (!brief || !brief.rounds.length) return null;
    if (pendingRound(brief)) throw pendingError(brief);
    return snapshot(brief);
  }

  // ── bookkeeping ────────────────────────────────────────────────────────────
  /** A request id of an open clarify card; with `sessionId`, only a card of that session. */
  function owns(requestId, sessionId = null) {
    const ref = byRequest.get(String(requestId));
    if (!ref) return false;
    return sessionId === null || sessionId === undefined || ref.sessionId === String(sessionId);
  }
  function pendingCards(sessionId) {
    const state = stateOf(sessionId);
    if (!state) return [];
    const out = [];
    for (const brief of state.briefs.values()) {
      for (const round of brief.rounds) if (round.source === 'clarify' && round.status === 'pending') out.push(cardPacket(brief, round));
    }
    return out;
  }
  function get(briefId, { sessionId = null } = {}) {
    for (const [sid, state] of states) {
      if (sessionId && sid !== sessionId) continue;
      const brief = state.briefs.get(String(briefId));
      if (brief) return briefView(brief);
    }
    return null;
  }
  /**
   * Close one open clarify card of a session without an answer (the user wrote
   * something else instead: the WhatsApp bridge) → true when it was open.
   * `sessionId` is required: a card of another session is never closed here.
   * The round is cancelled, not declined: nothing starts on the brain's
   * assumptions, and no mailbox event follows.
   */
  function cancel(requestId, reason = 'cancelled', { sessionId = null } = {}) {
    const ref = byRequest.get(String(requestId));
    if (!ref) return false;
    if (!sessionId || ref.sessionId !== String(sessionId)) return false;
    const { brief, round } = findRound(ref.sessionId, ref.briefId, ref.roundId);
    if (!brief || !round || round.status !== 'pending') { byRequest.delete(String(requestId)); return false; }
    settleRound(brief, round, 'cancelled', { via: 'card', reason });
    return true;
  }
  /** Session closed (or removed): open questions close as cancelled. */
  function cancelForSession(sessionId, reason = 'session_closed') {
    const state = stateOf(sessionId);
    if (!state) return;
    for (const brief of state.briefs.values()) {
      for (const round of brief.rounds) if (round.status === 'pending') settleRound(brief, round, 'cancelled', { via: round.source === 'clarify' ? 'card' : 'native', reason });
    }
    if (reason === 'session_closed') states.delete(sessionId);
  }
  function shutdown() {
    for (const state of states.values()) {
      for (const brief of state.briefs.values()) {
        for (const round of brief.rounds) { for (const waiter of [...round.waiters]) { try { waiter(false); } catch {} } round.waiters.clear(); }
      }
    }
    states.clear();
    byRequest.clear();
    byNative.clear();
  }

  return {
    ask, answer, onUserPrompt, onNativeQuestion, onNativeAnswer, onNativeSettled,
    blocking, forDispatch, owns, pendingCards, get, cancel, cancelForSession, shutdown,
    _internals: { states, byRequest, byNative, config },
  };
}

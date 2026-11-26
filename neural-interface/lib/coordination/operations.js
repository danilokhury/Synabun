// ═══════════════════════════════════════════
// SynaBun — Coordination service
// ═══════════════════════════════════════════
//
// The one place that owns the coordination store (store.js) while the server runs, and what the Assistant's
// dispatcher and runtime say to each other through it:
//
//   run events   every lifecycle event of a dispatched run (assistant-dispatch.js `emit`) is appended to the log in
//                the step that changed the run, under an id that is the same however often it is recorded, with a
//                priority, and addressed to the Assistant session that owns the run when its brain must hear it.
//   the mailbox  what a session's brain has not been told yet: the open events addressed to `session:<id>`. The
//                runtime composes a turn from them and acknowledges them only once that turn was started. Nothing
//                is dropped for being many: critical events go first, low-priority progress is folded by the store.
//   run waits    agent_wait until:"event" reads typed events of the log after a cursor.
//   follow-ups   text sent to a run while it works, or while a server restart has it away, waits in the store's
//                outbox until the run's provider is handed it (assistant-dispatch.js).
//   team         a channel per team for the phase that adds worker-to-worker messages: post, read with a cursor,
//                wait and acknowledge, scoped by team and run. Nothing here exposes it to a worker yet.
//
// The worker runs these operations. The public asynchronous facade is in service.js.

import {
  COORDINATION_LIMITS, CoordinationError, EVENT_KINDS, KIND_PRIORITY,
  runRecipient, sessionRecipient, teamRecipient,
} from './contract.js';

export const COORDINATION_SERVICE_LIMITS = Object.freeze({
  // Events one mailbox message carries. More than that stay open and follow in the next message (none is dropped).
  mailboxItems: 30,
  // A run's follow-ups that may wait at once (the admission bound of its queue).
  followUpsPerRun: 20,
  // Events settled this long ago leave the log (an event somebody has not acknowledged never does).
  pruneAfterMs: 14 * 24 * 60 * 60 * 1000,
  pruneEveryMs: 6 * 60 * 60 * 1000,
  // What a run event's payload keeps of the run and its result (the brain reads the rest with agent_read).
  summaryChars: 400, questionChars: 2000, textChars: 600, errorChars: 600, titleChars: 120, files: 50, followUps: 10, media: 12,
  // A pinned agent ref is `<scope>:<id>@<revision>` (lib/agents/schema.js formatAgentRef): never near this long.
  agentRefChars: 160,
  teamText: 8000, teamRecipients: COORDINATION_LIMITS.recipients,
});

/**
 * Why a stopped run is told to its brain: a stop by the user, a budget, or its work time (time_cap: max_minutes
 * used up; agent_send is refused from then on). Any other stop was the brain's own, or needs no reaction.
 */
export const MAILBOX_STOP_REASONS = Object.freeze(new Set(['user', 'budget_cap', 'session_budget_cap', 'budget_unpriced', 'budget_share', 'time_cap']));

const K = EVENT_KINDS;
/**
 * The dispatcher's emit reasons: the kind each is logged as, and whether the owning session's brain is told
 * (`mailbox`). A reason that is not listed is progress, logged and told to nobody.
 */
export const RUN_EVENT_REASONS = Object.freeze({
  turn_completed: { kind: K.RUN_RESULT, mailbox: true, item: 'result' },
  needs_input: { kind: K.RUN_NEEDS_INPUT, mailbox: true },
  permission_request: { kind: K.RUN_PERMISSION, mailbox: true },
  failed: { kind: K.RUN_FAILED, mailbox: true },
  interrupted: { kind: K.RUN_INTERRUPTED, mailbox: true },
  stalled: { kind: K.RUN_STALLED, mailbox: true },
  budget_exceeded: { kind: K.RUN_BUDGET, mailbox: true, priority: 'critical' },
  budget_warning: { kind: K.RUN_BUDGET, mailbox: true },
  budget_unpriced: { kind: K.RUN_BUDGET, mailbox: true },
  stopped: { kind: K.RUN_STOPPED, mailbox: true },
  completed: { kind: K.RUN_COMPLETED, mailbox: false },
  user_intervened: { kind: K.RUN_NOTICE, mailbox: true },
  // A steer (assistant-dispatch.js steerRun): logged as a notice; the brain hears the user's own steer as user_intervened.
  steered: { kind: K.RUN_NOTICE, mailbox: false },
  queue_started: { kind: K.RUN_PROGRESS, mailbox: true },
  suspended: { kind: K.RUN_PROGRESS, mailbox: true },
  resumed: { kind: K.RUN_PROGRESS, mailbox: true },
});

/** A mailbox item's own kind (what the brain and the panel read) → the event kind it is stored as. */
export const MAILBOX_ITEM_KINDS = Object.freeze({
  result: K.RUN_RESULT, needs_input: K.RUN_NEEDS_INPUT, permission_request: K.RUN_PERMISSION, failed: K.RUN_FAILED,
  interrupted: K.RUN_INTERRUPTED, stalled: K.RUN_STALLED, stopped: K.RUN_STOPPED, user_intervened: K.RUN_NOTICE,
  budget_warning: K.RUN_BUDGET, budget_exceeded: K.RUN_BUDGET, budget_unpriced: K.RUN_BUDGET,
  queue_started: K.RUN_PROGRESS, suspended: K.RUN_PROGRESS, resumed: K.RUN_PROGRESS,
  memory_due: K.SESSION_MEMORY_DUE,
  route_decided: K.ROUTE_DECIDED, route_expired: K.ROUTE_EXPIRED, route_declined: K.ROUTE_DECLINED,
  clarify_answered: K.CLARIFY_ANSWERED, clarify_declined: K.CLARIFY_DECLINED,
});
const ITEM_PRIORITY = Object.freeze({ budget_exceeded: 'critical' });
/** A mailbox item of a kind nothing above names. */
export const SESSION_NOTICE_KIND = 'session.notice';

/** What agent_wait until:"event" waits for when the caller names no kinds: everything but progress. */
export const RUN_WAIT_KINDS = Object.freeze([
  K.RUN_RESULT, K.RUN_NEEDS_INPUT, K.RUN_PERMISSION, K.RUN_FAILED, K.RUN_STALLED, K.RUN_STOPPED, K.RUN_INTERRUPTED,
  K.RUN_COMPLETED, K.RUN_BUDGET, K.RUN_NOTICE, K.RUN_MESSAGE,
]);
/** Every kind a run's events are logged as (agent_wait's `kinds` takes these). */
export const RUN_EVENT_KINDS = Object.freeze([...RUN_WAIT_KINDS, K.RUN_PROGRESS]);

const SESSION_PREFIX = 'session:';
const clip = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** The recipient name of one member of a team: its messages on that team's channel, and nothing else. */
export const teamMemberRecipient = (teamId, runId) => `team:${teamId}:run:${runId}`;

/**
 * A run as an event carries it: what a mailbox line, a wait and the panel's chip need, never the worker's text or
 * its turns (a run view is tens of kilobytes; this is a few hundred bytes).
 */
export function runBrief(run, limits = COORDINATION_SERVICE_LIMITS) {
  if (!isObject(run)) return null;
  const escalation = isObject(run.escalation) ? {
    kind: run.escalation.kind ?? null, reason: run.escalation.reason ?? null, cause: run.escalation.cause ?? null,
    needs: run.escalation.needs ? clip(run.escalation.needs, 200) : null,
    to: isObject(run.escalation.to) ? { provider: run.escalation.to.provider ?? null, model: run.escalation.to.model ?? null, tier: run.escalation.to.tier ?? null } : null,
  } : null;
  const out = {
    runId: String(run.runId || ''),
    provider: run.provider ?? null,
    model: run.model ?? null,
    title: run.title ? clip(run.title, limits.titleChars) : null,
    state: run.state ?? null,
    outcome: run.outcome ?? run.lastResult?.status ?? null,
  };
  if (!out.title && run.task) out.task = clip(run.task, limits.titleChars);
  if (run.completionReason) out.completionReason = String(run.completionReason);
  if (run.stopProvenance) out.stopProvenance = run.stopProvenance;
  if (Number.isFinite(Number(run.costUsd)) && Number(run.costUsd) > 0) out.costUsd = Number(run.costUsd);
  if (typeof run.memoryStored === 'boolean') out.memoryStored = run.memoryStored;
  if (run.workflowId) out.workflowId = String(run.workflowId);
  if (run.assistantSessionId) out.assistantSessionId = String(run.assistantSessionId);
  // The agent the run runs as (lib/agents/resolve.js stampAgentRun): the pinned ref and its revision. A plain
  // worker's brief has neither key.
  if (run.agentRef) {
    out.agentRef = clip(run.agentRef, limits.agentRefChars);
    if (Number.isInteger(Number(run.agentRevision)) && Number(run.agentRevision) > 0) out.agentRevision = Number(run.agentRevision);
  }
  if (isObject(run.limit)) out.limit = { resetsAt: run.limit.resetsAt ?? null };
  if (escalation) out.escalation = escalation;
  if (run.error) out.error = clip(run.error, limits.errorChars);
  return out;
}

/** A mailbox item with its run cut down to a brief (a route's or a brief's own fields stay as they are). */
export function compactItem(item, limits = COORDINATION_SERVICE_LIMITS) {
  if (!isObject(item)) return {};
  const out = { ...item };
  if (isObject(item.run)) {
    // The task the item's turn worked for is read from the run before its turns are left out.
    if (out.taskId === undefined) {
      const turn = Number(item.turn);
      const record = Number.isFinite(turn) && Array.isArray(item.run.turns) ? item.run.turns.find((row) => row?.n === turn) : null;
      out.taskId = record?.taskId || item.run.taskId || null;
    }
    out.run = runBrief(item.run, limits);
  }
  if (typeof item.summary === 'string') out.summary = clip(item.summary, limits.summaryChars);
  if (typeof item.question === 'string') out.question = clip(item.question, limits.questionChars);
  if (Array.isArray(item.files)) out.files = item.files.slice(0, limits.files);
  if (Array.isArray(item.follow_ups)) out.follow_ups = item.follow_ups.slice(0, limits.followUps);
  if (Array.isArray(item.media)) out.media = item.media.slice(0, limits.media);
  delete out.at;
  return out;
}

/**
 * The id a run event is stored under: the same for the same event however often it is recorded (the dispatcher in
 * the step that changed the run, the runtime when it hears of it), so the second append stores nothing.
 * A turn's result and its question are named by the turn; a relayed request by its request id; everything else by
 * the run's version and time of that change. null when the payload carries nothing that could name it.
 */
export function runEventId(payload) {
  const run = payload?.run;
  const reason = String(payload?.reason || '');
  if (!run?.runId || !reason) return null;
  const base = `run:${run.runId}`;
  const requestId = payload.request?.requestId;
  if ((reason === 'needs_input' || reason === 'permission_request') && requestId) return `${base}:request:${requestId}`;
  const turn = Number(payload.turn);
  if (Number.isInteger(turn) && turn > 0) {
    if (reason === 'turn_completed') return `${base}:turn:${turn}:result`;
    if (reason === 'needs_input') return `${base}:turn:${turn}:needs_input`;
  }
  const version = Number(run.version);
  if (!Number.isFinite(version) || !run.updatedAt) return null;
  const id = `${base}:${reason}:v${version}:${run.updatedAt}`;
  return id.length > COORDINATION_LIMITS.id ? null : id;
}

/** What a run event carries: the mailbox item of that reason, as the brain will read it. */
function runEventPayload(payload, spec, limits) {
  const run = payload.run;
  const reason = String(payload.reason);
  const kind = spec?.item || reason;
  const carriesResult = kind === 'result' || kind === 'needs_input';
  const result = isObject(run.lastResult) ? run.lastResult : null;
  const turn = Number.isFinite(Number(payload.turn)) ? Number(payload.turn) : null;
  const turnRecord = turn !== null && Array.isArray(run.turns) ? run.turns.find((row) => row?.n === turn) : null;
  const item = {
    kind, reason, run: runBrief(run, limits), turn,
    taskId: turnRecord?.taskId || run.taskId || null,
    summary: result?.summary ? clip(result.summary, limits.summaryChars) : null,
    question: result?.question ? clip(result.question, limits.questionChars) : (payload.question ? clip(payload.question, limits.questionChars) : null),
    files: Array.isArray(result?.files) ? result.files.slice(0, limits.files) : [],
    follow_ups: Array.isArray(result?.follow_ups) ? result.follow_ups.slice(0, limits.followUps) : [],
    request: payload.request || null,
    error: run.error ? clip(run.error, limits.errorChars) : null,
    text: payload.text ? clip(payload.text, limits.textChars) : null,
    // Jev's reading of the result: a "done" its own output does not show, and a status read without a ## Result block.
    unverified: carriesResult ? (result?.unverifiedClaim?.evidence || null) : null,
    resultSource: carriesResult ? (result?.source || null) : null,
    // Image / video creation: the files this turn generated ({ kind, path, url, mime, bytes }).
    media: carriesResult && Array.isArray(result?.media) ? result.media.slice(0, limits.media) : [],
  };
  // Progress (a queued follow-up, a memory, a permission answered): the few words that say what moved.
  for (const key of ['queued', 'position', 'memoryId', 'requestId', 'behavior', 'resolvedBy', 'routeId', 'childRunId', 'resumes', 'sinceMs']) {
    if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'object') item[key] = payload[key];
  }
  return item;
}

/** An event as a wait returns it: enough to decide what to do next, with the seq to continue from. */
export function eventBrief(event) {
  const payload = isObject(event?.payload) ? event.payload : {};
  const out = { seq: event.seq, id: event.id, kind: event.kind, priority: event.priority, runId: event.runId ?? null, at: event.createdAt };
  if (event.teamId) out.teamId = event.teamId;
  for (const key of ['reason', 'turn', 'summary', 'question', 'error', 'text', 'from']) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') out[key] = payload[key];
  }
  if (isObject(payload.run)) {
    if (payload.run.state) out.state = payload.run.state;
    if (payload.run.outcome) out.outcome = payload.run.outcome;
    // Which agent says it (absent for a plain worker).
    if (payload.run.agentRef) out.agentRef = payload.run.agentRef;
  }
  if (isObject(payload.request)) out.request = { requestId: payload.request.requestId ?? null, kind: payload.request.kind ?? null, toolName: payload.request.toolName ?? null };
  return out;
}

/** A mailbox event as the runtime composes a turn from it (the item, with the event it came from). */
export function itemOf(event) {
  const payload = isObject(event.payload) ? event.payload : {};
  const item = { ...payload, eventId: event.id, seq: event.seq, eventKind: event.kind, priority: event.priority, at: event.createdAt };
  if (!item.kind) item.kind = event.kind;
  if (event.delivery?.merged) item.merged = event.delivery.merged;
  if (event.delivery?.redelivered) item.redelivered = true;
  return item;
}

export function dispatchEvent(payload, limits) {
  const run = payload?.run;
  const reason = String(payload?.reason || '');
  if (!run?.runId || !reason) return null;
  const spec = RUN_EVENT_REASONS[reason] || { kind: K.RUN_PROGRESS, mailbox: false };
  const sessionId = run.assistantSessionId ? String(run.assistantSessionId) : null;
  let delivered = spec.mailbox === true && !!sessionId;
  // A stop the brain asked for itself, or one that needs no reaction, is not news to it.
  if (reason === 'stopped' && !MAILBOX_STOP_REASONS.has(run.completionReason)) delivered = false;
  // needs_input already carries the question; its turn_completed twin would hand the brain the same event twice.
  if (reason === 'turn_completed' && run.lastResult?.status === 'needs_input') delivered = false;
  const priority = spec.priority || KIND_PRIORITY[spec.kind] || 'normal';
  return {
    id: runEventId(payload) || undefined,
    kind: spec.kind, priority, sessionId, runId: String(run.runId), teamId: run.teamId ? String(run.teamId) : null,
    payload: runEventPayload(payload, spec, limits),
    to: delivered ? [sessionRecipient(sessionId)] : [],
  };
}

/** Composite service operations execute within a single worker turn. */
export function coordinationOperations(store, { now = Date.now, limits: limitOverrides } = {}) {
  const limits = { ...COORDINATION_SERVICE_LIMITS, ...limitOverrides };
  /**
   * Events of runs after a position in the log, oldest first, as a wait returns them. Delivers and acknowledges
   * nothing, so asking again from the same position gives the same events (a lost answer is simply asked again).
   * @param {{ runIds: string[], afterSeq?: number, kinds?: string[]|null, limit?: number }} query
   */
  function runEvents({ runIds, afterSeq = 0, kinds = null, limit = 100 } = {}) {
    const ids = [...new Set((Array.isArray(runIds) ? runIds : [runIds]).filter(Boolean).map(String))];
    if (!ids.length) return [];
    const out = [];
    // The log filter takes a bounded list: a large workflow is asked in parts and merged by seq.
    for (let at = 0; at < ids.length; at += COORDINATION_LIMITS.runIds) {
      out.push(...store.events({ runIds: ids.slice(at, at + COORDINATION_LIMITS.runIds), afterSeq, kinds: kinds && kinds.length ? kinds : null, limit }));
    }
    return out.sort((a, b) => a.seq - b.seq).slice(0, Math.max(1, Math.min(COORDINATION_LIMITS.readLimit, Number(limit) || 100))).map(eventBrief);
  }

  // ── the mailbox of an Assistant session ────────────────────────────────────
  const mailbox = Object.freeze({
    /**
     * Something the session's brain must hear that is not a run's own event: a memory reminder, a route card's
     * outcome, the answers to its questions. `item.kind` is what the brain reads; it decides the event kind and
     * priority unless `kind` / `priority` say otherwise.
     * @returns {{ id: string, seq: number, duplicate: boolean, kind: string, priority: string }}
     */
    post(sessionId, item, { id = null, kind = null, priority = null, runId = null, coalesceKey = null } = {}) {
      const session = String(sessionId || '');
      if (!session) throw new CoordinationError('FIELD_REQUIRED', 'sessionId is required.', { field: 'sessionId' });
      const body = compactItem(item, limits);
      const eventKind = kind || MAILBOX_ITEM_KINDS[body.kind] || SESSION_NOTICE_KIND;
      const level = priority || ITEM_PRIORITY[body.kind] || KIND_PRIORITY[eventKind] || 'normal';
      const run = runId || body.run?.runId || body.runId || null;
      const out = store.append({
        id: id || undefined, kind: eventKind, priority: level, sessionId: session, runId: run ? String(run) : null,
        payload: body, coalesceKey: coalesceKey || undefined, to: [sessionRecipient(session)],
      });
      return { ...out, kind: eventKind, priority: level };
    },
    /**
     * What the session has not been told, in the order to tell it: critical first, then the rest oldest first, with
     * low-priority progress folded. At most `limit` items; `more` says how many stay for the next message. Handing
     * them out acknowledges nothing: call `ack` once the turn that carries them was started.
     * @returns {{ items: object[], more: number }}
     */
    pending(sessionId, { limit = limits.mailboxItems, peek = false } = {}) {
      const recipient = sessionRecipient(String(sessionId));
      const max = Math.max(1, Math.min(COORDINATION_LIMITS.readLimit, Math.floor(Number(limit)) || limits.mailboxItems));
      const events = store.pending(recipient, { limit: max, peek, coalesce: !peek });
      const open = events.length < max ? events.length : store.openCount(recipient);
      return { items: events.map(itemOf), more: Math.max(0, open - events.length) };
    },
    /** How many events the session has not been told (`priority` narrows it, e.g. 'critical'). */
    count(sessionId, { priority = null } = {}) {
      return store.openCount(sessionRecipient(String(sessionId)), priority ? { priority } : {});
    },
    /** The session's brain was handed these events (a turn that carries them started): never again. */
    ack(sessionId, eventIds) {
      return store.ack(sessionRecipient(String(sessionId)), eventIds);
    },
    /** Every session that has something open (after a restart: whose brain still has to hear of it). */
    sessions() {
      return store.recipients({ prefix: SESSION_PREFIX }).map((row) => ({ sessionId: row.recipient.slice(SESSION_PREFIX.length), open: row.open, oldestSeq: row.oldestSeq }));
    },
  });

  // ── follow-ups for runs (the outbox) ───────────────────────────────────────
  const followUpView = (row) => ({
    id: row.id, runId: row.runId, kind: 'follow-up', text: row.text, origin: row.meta?.origin || 'assistant', taskId: row.meta?.taskId || null,
    at: row.meta?.at || row.createdAt, attempts: row.attempts,
  });
  const followUps = Object.freeze({
    /**
     * Queue text for a run. It waits, in order, across restarts, until `markSent` says the run's provider got it.
     * @throws {CoordinationError} `OUTBOX_FULL` (409) when the run already has `followUpsPerRun` waiting
     * @returns {{ id: string, duplicate: boolean, position: number }}
     */
    enqueue({ runId, text, sessionId = null, origin = 'assistant', taskId = null, at = null, id = null } = {}) {
      const out = store.outbox.enqueue({
        id: id || undefined, runId, text, sessionId: sessionId || null,
        meta: { origin: String(origin || 'assistant'), taskId: taskId || null, at: at || new Date(now()).toISOString() },
        maxQueued: limits.followUpsPerRun,
      });
      return { ...out, position: store.outbox.count(runId) };
    },
    /** The run's oldest follow-up that was not sent yet, or null. Taking it marks nothing. */
    next(runId) {
      const [row] = store.outbox.take(runId, { limit: 1 });
      return row ? followUpView(row) : null;
    },
    /** These follow-ups were handed to their run's provider. */
    markSent(ids) { return store.outbox.markSent(ids); },
    count(runId) { return store.outbox.count(runId); },
    /** The run ended, or was stopped, before it took them: they leave the queue. → the items, oldest first. */
    cancel(runId, ids = null) { return store.outbox.cancel({ runId, ids }).cancelled.map(followUpView); },
    /** The runs that have follow-ups waiting. */
    runs() { return store.outbox.runs(); },
  });

  // ── a team's channel ───────────────────────────────────────────────────────
  function teamMembers(teamId) {
    const state = store.journal.state(teamId);
    return [...new Set(Object.values(state.slices).map((entry) => entry.runId).filter(Boolean))];
  }
  const team = Object.freeze({
    recipient: teamMemberRecipient,
    leadRecipient: teamRecipient,
    /**
     * The runs that work a team's slices now, by the journal (each slice's newest entry that names a run).
     */
    members: teamMembers,
    /**
     * Say something on a team's channel.
     * @param {object} message
     * @param {string} message.teamId
     * @param {string} [message.fromRunId]     who says it (a member's run id; none: the lead)
     * @param {'all'|'lead'|string|string[]} [message.to] 'all' (default): every other member and the lead; 'lead': the
     *   team's lead only; a run id or a list: those members
     * @param {string[]} [message.members]     the team's runs, when the caller knows them (default: the journal's)
     * @param {string} [message.kind]          default `team.message`
     * @param {string} [message.text]          at most 8000 characters
     * @param {any} [message.payload]          more than text (merged into the event's payload)
     * @param {string} [message.id]            the caller's own id (posting it again stores nothing)
     * @returns {{ id: string, seq: number, duplicate: boolean, recipients: string[] }}
     */
    post({ teamId, fromRunId = null, to = 'all', members = null, kind = K.TEAM_MESSAGE, text = null, payload = null, priority = null, id = null, sessionId = null } = {}) {
      if (!teamId) throw new CoordinationError('FIELD_REQUIRED', 'teamId is required.', { field: 'teamId' });
      if (text !== null && text !== undefined) {
        if (typeof text !== 'string' || !text.trim()) throw new CoordinationError('FIELD_REQUIRED', 'text is required: what is said.', { field: 'text' });
        if (text.length > limits.teamText) throw new CoordinationError('FIELD_INVALID', `text is at most ${limits.teamText} characters.`, { field: 'text' });
      }
      const from = fromRunId ? String(fromRunId) : null;
      const known = (Array.isArray(members) ? members.map(String) : teamMembers(teamId)).filter((runId) => runId !== from);
      let recipients;
      if (to === 'lead') recipients = [teamRecipient(teamId)];
      else if (to === 'all' || to === null || to === undefined) recipients = [...known.map((runId) => teamMemberRecipient(teamId, runId)), ...(from ? [teamRecipient(teamId)] : [])];
      else recipients = (Array.isArray(to) ? to : [to]).map(String).filter((runId) => runId !== from).map((runId) => teamMemberRecipient(teamId, runId));
      recipients = [...new Set(recipients)];
      if (recipients.length > limits.teamRecipients) throw new CoordinationError('RECIPIENTS_TOO_MANY', `A team message reaches at most ${limits.teamRecipients} recipients.`, { field: 'to' });
      const body = { ...(isObject(payload) ? payload : (payload === null || payload === undefined ? {} : { value: payload })), from: from || 'lead' };
      if (typeof text === 'string') body.text = text;
      const out = store.append({ id: id || undefined, kind, priority: priority || undefined, teamId: String(teamId), runId: from, sessionId: sessionId || null, payload: body, to: recipients });
      return { ...out, recipients };
    },
    /**
     * A member's messages on its team's channel after a position (default: its cursor), oldest first. Reading
     * acknowledges nothing: an event comes back until `ack` names it.
     * @param {{ teamId: string, runId?: string, afterSeq?: number, kinds?: string[], limit?: number, peek?: boolean }} query
     *   no `runId`: the lead's mailbox
     */
    read({ teamId, runId = null, afterSeq = null, kinds = null, limit = null, peek = false } = {}) {
      return store.read({ recipient: runId ? teamMemberRecipient(teamId, runId) : teamRecipient(teamId), afterSeq, kinds, limit, peek });
    },
    /** The member dealt with these events (`eventIds`), or with everything up to a seq (`throughSeq`). */
    ack({ teamId, runId = null, eventIds = null, throughSeq = null } = {}) {
      const recipient = runId ? teamMemberRecipient(teamId, runId) : teamRecipient(teamId);
      return throughSeq !== null && throughSeq !== undefined ? store.ackThrough(recipient, throughSeq) : store.ack(recipient, eventIds || []);
    },
    /** The channel itself: every event of the team after a position, whoever it was addressed to. Delivers nothing. */
    log({ teamId, afterSeq = 0, kinds = null, limit = null } = {}) {
      return store.events({ teamId, afterSeq, kinds, limit });
    },
    cursor({ teamId, runId = null } = {}) {
      return store.cursor(runId ? teamMemberRecipient(teamId, runId) : teamRecipient(teamId));
    },
  });

  return { runEvents, mailbox, followUps, team };
}

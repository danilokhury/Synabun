// ═══════════════════════════════════════════
// SynaBun — Assistant run waits (agent_wait)
// ═══════════════════════════════════════════
//
// The barrier behind agent_wait: block until one run, several runs or a whole workflow are idle, terminal, or
// have something to say. The dispatcher calls `notify()` after every state change (its emit); nothing polls.
//
//   until 'idle' / 'terminal'   read the runs' state, as they always did.
//   until 'event'               waits on typed events of the coordination log (lib/coordination/service.js):
//                               run.result, run.needs_input, run.permission, run.failed, run.stalled, … It used to
//                               fire on any change of a run's version (a turn starting, a tool list, a memory).
//                               The answer carries the events with their seq and a `cursor`; a caller that passes
//                               the cursor back as `afterSeq` gets exactly what came after it, also when an
//                               answer was lost on the way (the log is read, nothing is consumed).
//
// A workflow's wait follows the workflow: its runs are looked up at every check, so a run dispatched into it after
// the wait began is waited for too.

import { RUN_EVENT_KINDS, RUN_WAIT_KINDS } from './coordination/service.js';

export const RUN_WAIT_LIMITS = Object.freeze({
  // Runs one wait follows (it used to stop at 20 and silently ignore the rest).
  maxRuns: 200,
  // Events one answer carries; more are read with the cursor.
  maxEvents: 50,
});

/**
 * @param {object} deps
 * @param {Map<string, object>} deps.entries      the dispatcher's registry (runId → entry)
 * @param {(entry: object) => object} deps.view   an entry as callers see it
 * @param {(entry: object) => boolean} deps.isTerminal  ended, and its cause is no longer being judged
 * @param {object} deps.coordination              createCoordinationService()
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.waitCapMs]         the longest one call may block
 * @param {(code: string, message: string, extra?: object) => Error} deps.fail
 */
export function createRunWaits({ entries, view, isTerminal, coordination, now = Date.now, waitCapMs = () => 120_000, fail }) {
  const waiters = new Set(); // { check(): boolean, resolve() }

  /** A run changed: every wait looks again. */
  function notify() {
    for (const waiter of [...waiters]) {
      waiter.wake();
    }
  }

  function satisfies(entry, until) {
    if (!entry) return true;
    // A failed run whose cause is still being judged is not final yet: its 'failed' event (with the cause and the
    // matching escalation) follows within the surface timeout.
    const terminal = isTerminal(entry);
    if (until === 'terminal') return terminal;
    // 'idle' (default): the run is not busy — idle, awaiting a decision (a permission or the user's model choice),
    // or finished.
    return entry.state === 'idle' || entry.state === 'awaiting_permission' || entry.state === 'awaiting_route' || terminal;
  }

  function kindsOf(kinds) {
    if (kinds === null || kinds === undefined) return [...RUN_WAIT_KINDS];
    const list = [...new Set((Array.isArray(kinds) ? kinds : [kinds]).map((kind) => String(kind || '').trim()).filter(Boolean))];
    if (!list.length) return [...RUN_WAIT_KINDS];
    const unknown = list.filter((kind) => !RUN_EVENT_KINDS.includes(kind));
    if (unknown.length) throw fail('INVALID_KINDS', `Unknown event kind${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}. Use: ${RUN_EVENT_KINDS.join(', ')}.`, { status: 400, kinds: RUN_EVENT_KINDS });
    return list;
  }

  /**
   * @param {object} options
   * @param {string} [options.runId]
   * @param {string[]} [options.runIds]
   * @param {string} [options.workflowId]          every run of the workflow, also those added while this waits
   * @param {string} [options.assistantSessionId]  narrows a workflow to that session's runs
   * @param {'idle'|'terminal'|'event'} [options.until]
   * @param {'all'|'any'} [options.mode]              default: 'any' for until 'event' (the next event of any of the runs), else 'all'
   * @param {number} [options.timeoutMs]
   * @param {number} [options.afterSeq]            until 'event': only events after this seq (a cursor from an earlier answer)
   * @param {string[]} [options.kinds]             until 'event': only these kinds (default: everything but progress)
   * @param {string} [options.unseenFor]           until 'event', no afterSeq: start at the oldest event of these runs
   *                                               this Assistant session has not been told yet (its brain is asking)
   */
  async function wait({ runId = null, runIds = null, workflowId = null, assistantSessionId = null, until = 'idle', mode: askedMode = null, timeoutMs = 30_000, afterSeq = null, kinds = null, unseenFor = null } = {}) {
    // An event wait asks for the next event of any of its runs unless it says "all"; a state wait is a barrier.
    const mode = askedMode === 'any' || askedMode === 'all' ? askedMode : (until === 'event' ? 'any' : 'all');
    const explicit = [...new Set([...(Array.isArray(runIds) ? runIds : []), ...(runId ? [runId] : [])].filter(Boolean).map(String))];
    if (explicit.length > RUN_WAIT_LIMITS.maxRuns) throw fail('TOO_MANY_RUNS', `One wait follows at most ${RUN_WAIT_LIMITS.maxRuns} runs; wait for a workflow_id instead of listing them.`, { status: 400, limit: RUN_WAIT_LIMITS.maxRuns });
    let overflow = 0;
    // Looked up at every check: a run dispatched into the workflow after the wait began belongs to it.
    const members = () => {
      if (!workflowId) return explicit;
      const flow = [];
      for (const entry of entries.values()) {
        if (entry.workflowId === workflowId && (!assistantSessionId || entry.assistantSessionId === assistantSessionId)) flow.push(entry.runId);
      }
      const all = [...new Set([...explicit, ...flow])];
      overflow = Math.max(0, all.length - RUN_WAIT_LIMITS.maxRuns);
      return all.slice(0, RUN_WAIT_LIMITS.maxRuns);
    };
    let ids = members();
    if (!ids.length) throw fail('RUN_IDS_REQUIRED', 'runId, runIds or workflowId is required');
    for (const id of ids) if (!entries.has(id)) throw fail('RUN_NOT_FOUND', `Unknown run ${id}`, { status: 404 });
    const started = now();
    const budget = Math.max(1000, Math.min(Number(waitCapMs()) || 120_000, Number(timeoutMs) || 30_000));

    const typed = until === 'event';
    const cursorGiven = typed && afterSeq !== null && afterSeq !== undefined;
    const wanted = typed ? kindsOf(kinds) : null;
    let from = 0;
    if (typed) {
      if (cursorGiven) {
        from = Number(afterSeq);
        if (!Number.isInteger(from) || from < 0) throw fail('INVALID_CURSOR', 'after_seq is a whole number from 0: the cursor of an earlier agent_wait answer.', { status: 400 });
      } else {
        from = await lastSeq();
        // The brain itself asks: what it has not been told yet counts, though it happened before this call.
        if (unseenFor) from = Math.min(from, await unseenStart(String(unseenFor), ids, from));
      }
    }
    const eventsNow = async () => {
      if (!typed) return [];
      return coordination.runEvents({ runIds: ids, afterSeq: from, kinds: wanted, limit: RUN_WAIT_LIMITS.maxEvents });
    };
    const satisfied = (events) => ids.filter((id) => {
      const entry = entries.get(id);
      if (!typed) return satisfies(entry, until);
      if (!entry || isTerminal(entry)) return true;
      // Without a cursor a run that waits for a decision answers at once, as it always did; with one, only what is
      // new does (the request the caller already saw must not make every call return).
      if (!cursorGiven && (entry.state === 'awaiting_permission' || entry.state === 'awaiting_route')) return true;
      return events.some((event) => event.runId === id);
    });
    const check = async () => {
      ids = members();
      const done = satisfied(await eventsNow());
      return mode === 'any' ? done.length > 0 : done.length === ids.length;
    };
    // Subscribe before the first read. Coalesce notifications while a read is
    // outstanding so an event between that read and its reply still wakes us.
    await new Promise((resolveWait, rejectWait) => {
      let checking = false, again = false;
      function finish(error) {
        if (!waiters.delete(waiter)) return;
        clearTimeout(timer);
        if (error) rejectWait(error); else resolveWait();
      }
      const waiter = { async wake() {
        if (checking) { again = true; return; }
        checking = true;
        try {
          do {
            again = false;
            if (await check()) { finish(); break; }
          } while (again && waiters.has(waiter));
        } catch (error) { finish(error); }
        checking = false;
      } };
      const timer = setTimeout(finish, budget);
      timer.unref?.();
      waiters.add(waiter);
      waiter.wake();
    });
    ids = members();
    // Sample the watermark before fetching the rows. A later commit must
    // appear in this answer or remain above the returned cursor.
    const watermark = await lastSeq();
    const events = await eventsNow();
    const done = satisfied(events);
    const pendingIds = ids.filter((id) => !done.includes(id));
    const timedOut = !(mode === 'any' ? done.length > 0 : done.length === ids.length);
    const out = {
      ok: true, timedOut, waitedMs: now() - started, until, mode,
      done: done.map((id) => view(entries.get(id))),
      pending: pendingIds.map((id) => view(entries.get(id))),
      needsInput: ids.map((id) => entries.get(id)).filter((e) => e?.lastResult?.status === 'needs_input' && e.state === 'idle').map((e) => ({ runId: e.runId, question: e.lastResult.question })),
      permissions: ids.flatMap((id) => (entries.get(id)?.pending || []).map((request) => ({ runId: id, ...request }))),
    };
    if (typed) {
      out.events = events;
      // Pass it back as after_seq to go on from here. A full page stops at its last event: more may follow.
      out.cursor = events.length >= RUN_WAIT_LIMITS.maxEvents ? events[events.length - 1].seq : Math.max(from, watermark, events.at(-1)?.seq || 0);
    } else {
      out.cursor = watermark;
    }
    if (overflow) out.notWaitedFor = overflow;
    return out;
  }

  async function lastSeq() {
    return Number(await coordination.lastSeq()) || 0;
  }
  /** Just before the oldest event of these runs the session's brain was not told yet (`fallback` when there is none). */
  async function unseenStart(sessionId, ids, fallback) {
    const wantedRuns = new Set(ids);
    const { items } = await coordination.mailbox.pending(sessionId, { limit: 1000, peek: true });
    const seqs = items.filter((item) => item.run?.runId && wantedRuns.has(String(item.run.runId))).map((item) => Number(item.seq)).filter((seq) => Number.isFinite(seq));
    return seqs.length ? Math.min(...seqs) - 1 : fallback;
  }

  return { wait, notify, satisfies, pending: () => waiters.size };
}

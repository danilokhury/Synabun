// ── A Claude Code turn that waits for its own background work (DOM-free) ──
//
// An unattended run (a native loop iteration, a dispatched worker turn) drives one streaming Agent SDK query and
// counted the iteration over at the first `result`. A turn that ends while a background shell or a Monitor it
// started still runs is not over: the CLI comes back by itself when that work settles (a `task_notification`
// queued to the idle session starts a new turn, beginning with a `system/init`), and the work continues there.
// Ending the iteration at the first result disposed the query, the CLI killed the waits, and the run stopped
// mid-task while its panel showed the waits "running" forever (a Bluesky schedule waiting out a pacing gap).
//
// This module decides, from the SDK's own events, when such a turn is really over:
//  - a result with none of the session's background tasks live (and none just reported that would start another
//    turn) ends it at once, exactly as before;
//  - a result while tasks are live is held: later results join it (cost and usage summed, the last text wins);
//  - when the tasks drain and the CLI does not come back within `resumeGraceMs`, the host pushes one continuation
//    prompt (`nudge`);
//  - `idleMs` without any event from the CLI, or the run's own deadline, ends the hold with the last result.
//
// The host (lib/native-loop-providers.js) feeds every SDK message to `onEvent` and asks `onResult` what to do
// with each result of the active turn. Clock and timers are injected, so the tests run it on a fake clock.

export const BACKGROUND_HOLD_DEFAULTS = Object.freeze({
  // How long a held turn waits with no event at all from the CLI (a background task that never ends, a CLI that
  // never comes back) before the iteration ends with the last result. Pacing gaps are a few minutes at most.
  idleMs: 10 * 60_000,
  // After the last background task ended: how long the CLI has to start its own turn before the host nudges it.
  resumeGraceMs: 15_000,
  // A task reported during the turn that just ended may still start a turn of its own: this long is waited for it.
  followGraceMs: 4_000,
});

const RESULT_BLOCK_RE = /^#{1,3}\s*Result\b/m;

/** A dispatched worker that wrote its ## Result block has said it is done: its turn is never held. */
export function resultDeclaresDone(text) {
  return RESULT_BLOCK_RE.test(String(text || ''));
}

const NUMERIC_USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

/** The usage of two results of one held turn, added up (unknown fields: the later one's). */
export function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a, ...b };
  for (const key of NUMERIC_USAGE_KEYS) {
    const x = Number(a[key]) || 0;
    const y = Number(b[key]) || 0;
    if (x || y) out[key] = x + y;
  }
  return out;
}

/** The live background tasks of one CLI session, from its level signal and its bookends. */
export function createBackgroundTasks() {
  const live = new Map();     // task_id → { id, type, description, ambient }
  const started = new Map();  // task_id → tool_use_id (set when a tool call of the model started it)
  const excused = new Set();  // tasks a hold already gave up on (never ending): they hold no later turn
  let notifiedAt = 0;         // last task_notification (ms, host clock)
  return {
    /** @returns true when the event was a task event */
    apply(event, now) {
      if (event?.type !== 'system') return false;
      switch (event.subtype) {
        case 'background_tasks_changed': {
          live.clear();
          for (const task of Array.isArray(event.tasks) ? event.tasks : []) {
            if (!task?.task_id) continue;
            const id = String(task.task_id);
            live.set(id, { id, type: String(task.task_type || ''), description: String(task.description || ''), ambient: task.ambient === true });
          }
          return true;
        }
        case 'task_started':
          if (event.task_id) started.set(String(event.task_id), event.tool_use_id ? String(event.tool_use_id) : '');
          return true;
        case 'task_notification':
          if (event.task_id) live.delete(String(event.task_id));
          notifiedAt = now;
          return true;
        case 'task_updated': {
          const status = event.patch?.status;
          if (event.task_id && ['completed', 'failed', 'killed', 'stopped'].includes(status)) live.delete(String(event.task_id));
          return true;
        }
        default:
          return false;
      }
    },
    /**
     * What a turn waits for: every live task, except ambient housekeeping nothing of the model started
     * (a watcher the CLI runs by itself would otherwise hold every turn to its limit).
     */
    holdable() {
      return [...live.values()].filter((task) => !excused.has(task.id) && (!task.ambient || !!started.get(task.id)));
    },
    /** A hold ended without these tasks (idle, deadline): a later turn does not wait for them again. */
    excuse(list) { for (const task of Array.isArray(list) ? list : []) if (task?.id) excused.add(String(task.id)); },
    live: () => [...live.values()],
    notifiedAt: () => notifiedAt,
    /** The CLI process is gone: nothing of it runs any more. */
    clear() { live.clear(); started.clear(); excused.clear(); },
  };
}

/**
 * One turn's hold. `onResult(event, value)` is called for each result of the active turn and answers 'resolve'
 * (the turn is over: resolve it with `value()`) or 'hold' (keep waiting). Every other SDK message goes to
 * `onEvent`. `onRelease(reason)` is the host's: called when the hold ends by itself ('drained': the CLI did not
 * come back after its work ended, 'idle_timeout', 'deadline'); `nudge()` is the host's too: push one continuation
 * prompt, answer whether it was sent. `shouldHold(value)` says whether a result may wait at all (a dispatched
 * worker that wrote its ## Result block is done).
 */
export function createTurnHold({
  tasks,
  now = Date.now,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t),
  idleMs = BACKGROUND_HOLD_DEFAULTS.idleMs,
  resumeGraceMs = BACKGROUND_HOLD_DEFAULTS.resumeGraceMs,
  followGraceMs = BACKGROUND_HOLD_DEFAULTS.followGraceMs,
  deadlineAt = null,
  shouldHold = () => true,
  onRelease = () => {},
  nudge = () => false,
  onState = () => {},
} = {}) {
  let value = null;           // the turn's result so far (several results merged while held)
  let holding = false;
  let inTurn = true;          // the CLI is in a turn of this hold (the host's prompt, or one it started itself)
  let turnStartedAt = now();
  let drainedWhileIdle = false; // the work it waited for ended after its last result, and no turn started since
  let nudged = false;
  let done = false;
  let idleTimer = null;
  let graceTimer = null;
  let deadlineTimer = null;

  const clearAll = () => {
    clearTimer(idleTimer); idleTimer = null;
    clearTimer(graceTimer); graceTimer = null;
    clearTimer(deadlineTimer); deadlineTimer = null;
  };
  const finish = () => { done = true; holding = false; clearAll(); return 'resolve'; };
  const release = (reason) => {
    if (done || !holding) return;
    const live = tasks.holdable();
    finish();
    onState({ state: 'released', reason, tasks: live });
    onRelease(reason, live);
  };
  const armIdle = () => {
    clearTimer(idleTimer);
    idleTimer = setTimer(() => release('idle_timeout'), Math.max(1, idleMs));
  };
  const armDeadline = () => {
    if (deadlineTimer || !(Number(deadlineAt) > 0)) return;
    deadlineTimer = setTimer(() => release('deadline'), Math.max(1, Number(deadlineAt) - now()));
  };
  /** Between turns with nothing holdable live: the CLI should come back by itself; nudge it once if it does not. */
  const armGrace = () => {
    clearTimer(graceTimer);
    graceTimer = null;
    if (done || !holding || inTurn || tasks.holdable().length) return;
    const waitMs = drainedWhileIdle ? resumeGraceMs : Math.min(followGraceMs, resumeGraceMs);
    graceTimer = setTimer(() => {
      graceTimer = null;
      if (done || inTurn || tasks.holdable().length) return;
      if (drainedWhileIdle && !nudged && nudge()) {
        nudged = true;
        inTurn = true;
        drainedWhileIdle = false;
        turnStartedAt = now();
        onState({ state: 'nudged', tasks: [] });
        return;
      }
      release('drained');
    }, Math.max(1, waitMs));
  };

  return {
    get held() { return holding && !done; },
    get done() { return done; },
    /** Any SDK message that is not a result of this turn (task events included: the host applied them first). */
    onEvent(event) {
      if (done) return;
      if (holding) armIdle();
      // Every turn the CLI starts by itself begins with system/init.
      if (event?.type === 'system' && event.subtype === 'init') {
        if (holding && !inTurn) {
          inTurn = true;
          drainedWhileIdle = false;
          turnStartedAt = now();
          clearTimer(graceTimer); graceTimer = null;
          onState({ state: 'resumed', tasks: tasks.holdable() });
        }
        return;
      }
      if (!holding || inTurn) return;
      if (!tasks.holdable().length && !graceTimer) {
        drainedWhileIdle = true;
        armGrace();
      }
    },
    /** A result of this turn. `turnValue` is what the turn resolves with if this is its last result. */
    onResult(event, turnValue) {
      if (done) return 'resolve';
      inTurn = false;
      value = mergeTurnValues(value, turnValue);
      const more = Number(event?.queued_turn_count) > 0;
      const live = tasks.holdable();
      // A task that reported during this turn may start a turn of its own (the CLI queues it): a short wait.
      const reportedInTurn = tasks.notifiedAt() > turnStartedAt;
      if (!more && !live.length && !reportedInTurn) return finish();
      if (!shouldHold(value)) return finish();
      holding = true;
      drainedWhileIdle = false;
      if (live.length) onState({ state: 'holding', tasks: live });
      armIdle();
      armDeadline();
      armGrace();
      return 'hold';
    },
    value: () => value,
    cancel() { if (!done) finish(); },
  };
}

/** Two results of one held turn: the later one's text and event, the charges added up. */
export function mergeTurnValues(earlier, later) {
  if (!earlier) return later;
  if (!later) return earlier;
  const cost = (Number(earlier.costUsd) || 0) + (Number(later.costUsd) || 0);
  return {
    ...later,
    costUsd: Number(cost.toFixed(8)),
    usage: addUsage(earlier.usage, later.usage),
    heldResults: (Number(earlier.heldResults) || 1) + 1,
  };
}

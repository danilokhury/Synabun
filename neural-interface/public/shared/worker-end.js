// ═══════════════════════════════════════════
// SynaBun Neural Interface — how a dispatched worker's tab ends
// ═══════════════════════════════════════════
//
// A worker the Assistant dispatched (agent_dispatch) runs as an automation tab
// in the Claude Code, Codex or OpenCode sidepanel. When its work is over, the
// tab ends on one card that says how it ended: the task is complete, it is
// blocked or waits for input, it failed (with the reason) or it was stopped
// (with who or what stopped it), and a button back to the Assistant session
// that dispatched it. This module decides what that card says, from two
// readings of the run:
//   - `run`: the runtime descriptor the sidepanel router attaches with
//     (lib/native-loop-runtime.js cleanDescriptor: status, turnState,
//     stoppedReason, error, runMode, assistantSessionId), and
//   - `dispatch`: the dispatcher's view of the same run (GET
//     /api/assistant/runs/:runId, or an `assistant:dispatch` event: state,
//     outcome, lastResult, completionReason, error, costUsd, turns).
// The runtime status alone cannot tell a finished task from a stopped one: a
// warm worker that reported done is released by an idle timeout, by the
// Assistant's agent_stop or by its tab closing, and each of those ends the
// runtime run as "stopped". The worker's own `## Result` (the dispatcher's
// `outcome`) says whether the task was done.
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/worker-end.test.mjs). WORKER_END_COPY is the English of every
// sentence; `workerEnd.*` in i18n/en.json must equal it and i18n/pt-BR.json
// must have the same keys (the test checks both). The page side is
// ui-worker-end.js.

export const WORKER_END_COPY = Object.freeze({
  complete: 'Task complete',
  blocked: 'Blocked',
  needsInput: 'Needs input',
  failed: 'Task failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  back: 'Back to Assistant',
  backHint: 'Close this tab and open the Assistant session that dispatched it',
  warmNote: 'The worker is still open for follow-ups. Going back closes it.',
  failedNoReason: 'The run ended with an error.',
  reasonUser: 'Stopped by you.',
  reasonAssistant: 'Stopped by the Assistant.',
  reasonAssistantSaid: 'Stopped by the Assistant: {reason}',
  reasonTimeCap: 'The run reached its time limit.',
  reasonBudget: 'The run reached its budget limit.',
  reasonBudgetShare: 'This provider used up its share of the session budget.',
  reasonMaxTurns: 'The run reached its turn limit.',
  reasonIdle: 'The worker waited for a follow-up that did not come, and closed.',
  reasonRestart: 'The server restarted while the run was open.',
  reasonRestartNotResumed: 'The server restarted while the run was open, and it could not continue: {reason}',
  reasonKillAll: 'Stopped together with every other run.',
  reasonCleared: 'The run\'s state was removed.',
  reasonOther: 'Stopped ({reason}).',
  durationSeconds: '{s}s',
  durationMinutes: '{m}m {s}s',
  durationHours: '{h}h {m}m',
});

/** Marks the card in a transcript: snapshot writers and restorers leave it out (it is drawn again from the run). */
export const WORKER_END_CLASS = 'worker-end-card';

/** The run states (runtime and dispatcher alike) after which nothing more happens. */
export const TERMINAL_STATES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const TERMINAL = TERMINAL_STATES;
// Dispatcher states in which a turn is in progress (or about to be): the card waits. A run a server restart cut off
// (suspended) and one the next start resumes (resuming) are not over either.
const WORKING = new Set(['queued', 'awaiting_route', 'starting', 'running', 'awaiting_permission', 'suspended', 'resuming']);
const SUMMARY_CHARS = 320;

/** A WORKER_END_COPY sentence with its `{params}` filled in: the translator when the page gives none. */
export function fillWorkerEndCopy(key, params = {}) {
  return String(WORKER_END_COPY[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? params[name] : whole));
}

/** A run the Assistant dispatched (task mode), as opposed to a loop or a schedule the user started. */
export function isDispatchedRun(run, dispatch = null) {
  return !!(dispatch?.runId || run?.assistantSessionId || run?.runMode === 'task');
}

/**
 * A turn of the run is in progress (or the run has not started one yet). The
 * dispatcher's state wins over the runtime's: it is the one that knows a warm
 * worker between turns is idle.
 */
export function isRunWorking(run, dispatch = null) {
  const state = String(dispatch?.state || '');
  if (TERMINAL.has(state) || TERMINAL.has(String(run?.status || ''))) return false;
  if (state) return WORKING.has(state);
  const status = String(run?.status || '');
  if (status === 'suspended') return true;
  if (status !== 'starting' && status !== 'running') return false;
  return run?.turnState !== 'idle' && run?.turnState !== 'terminal';
}

/** The runtime descriptor says the run may have something to show: it ended, or it waits between turns. */
export function mayHaveEnded(run) {
  return TERMINAL.has(String(run?.status || '')) || run?.turnState === 'idle';
}

/**
 * The Claude Agent SDK's own words for a query SynaBun aborted: what its
 * stream throws when the runtime disposes a worker, which happens to every run
 * that ends, however it ended. Never a failure the user has to read.
 */
export function isEndOfRunAbort(message) {
  const text = String(message || '').trim();
  return /^(Claude Code process aborted by user|Connection aborted by user|Operation aborted|disposed)\.?$/i.test(text);
}

/** "4m 12s": how long a run took. */
export function formatDuration(ms, t = fillWorkerEndCopy) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return t('durationHours', { h, m });
  if (m) return t('durationMinutes', { m, s });
  return t('durationSeconds', { s });
}

/** "$0.42"; under a cent is "<$0.01"; nothing for a run that cost nothing or was not priced. */
export function formatCost(usd) {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

/** A worker's summary as one plain paragraph: no Markdown emphasis or heading marks, clipped. */
function plain(text, max = SUMMARY_CHARS) {
  const flat = String(text || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function time(value) {
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? at : null;
}

/** How long the work took: to the end of its last turn when the task got that far, else to the end of the run. */
function elapsedOf(run, dispatch, untilLastTurn) {
  const startedAt = time(dispatch?.startedAt) ?? time(dispatch?.createdAt) ?? time(run?.startedAt);
  const turns = Array.isArray(dispatch?.turns) ? dispatch.turns : [];
  const lastTurnEnd = untilLastTurn ? time(turns.at(-1)?.endedAt) : null;
  const end = lastTurnEnd ?? time(dispatch?.completedAt) ?? time(dispatch?.finishedAt) ?? time(run?.completedAt);
  if (startedAt != null && end != null && end >= startedAt) return end - startedAt;
  const ms = Number(dispatch?.elapsedMs);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function stopReason(reason, t) {
  const code = String(reason || '').trim();
  switch (code) {
    case 'user': return t('reasonUser');
    case 'assistant': case 'complete': return t('reasonAssistant');
    case 'time_cap': return t('reasonTimeCap');
    case 'budget_cap': case 'session_budget_cap': case 'budget_unpriced': return t('reasonBudget');
    case 'budget_share': return t('reasonBudgetShare');
    case 'max_turns': return t('reasonMaxTurns');
    case 'idle_timeout': return t('reasonIdle');
    case 'server_restart': case 'server_shutdown': case 'resume_failed': return t('reasonRestart');
    case 'kill_all': return t('reasonKillAll');
    case 'state_removed': case 'state_inactive': return t('reasonCleared');
    case '': return '';
    default:
      // The Assistant's agent_stop reason is its own sentence; anything else is a code.
      return /\s/.test(code) || code.length > 40
        ? t('reasonAssistantSaid', { reason: plain(code, 200) })
        : t('reasonOther', { reason: code });
  }
}

/**
 * What the end card of a dispatched worker's tab shows, or null when there is
 * no card (not a dispatched run, a turn still in progress, background work
 * still running, or a warm worker that has not reported its task done).
 *
 * @param {object | null} run the runtime descriptor (sidepanel router)
 * @param {object | null} dispatch the dispatcher's view of the run, when known
 * @param {object} [o]
 * @param {(key: string, params?: object) => string} [o.t] a key of WORKER_END_COPY → the sentence in the page's language
 * @param {boolean} [o.busy] background work of the run is still going (a warm worker only: an ended run has none)
 * @param {boolean} [o.stoppedMidTurn] the run was seen working right before it was stopped: a done
 *   report from an earlier turn does not make it complete
 * @returns {null | {
 *   kind: 'complete' | 'blocked' | 'needs_input' | 'failed' | 'stopped' | 'interrupted',
 *   tone: 'ok' | 'warn' | 'err' | 'off',
 *   title: string, detail: string, meta: string, note: string,
 *   warm: boolean,
 *   assistantSessionId: string | null, backLabel: string, backHint: string,
 *   sig: string,
 * }}
 */
export function workerEndView(run, dispatch = null, { t = fillWorkerEndCopy, busy = false, stoppedMidTurn = false } = {}) {
  if (!run && !dispatch) return null;
  if (!isDispatchedRun(run, dispatch)) return null;
  if (isRunWorking(run, dispatch)) return null;

  const state = String(dispatch?.state || '');
  const status = String(run?.status || '');
  const endState = TERMINAL.has(state) ? state : (TERMINAL.has(status) ? status : '');
  const result = dispatch?.lastResult && typeof dispatch.lastResult === 'object' ? dispatch.lastResult : null;
  const outcome = String(dispatch?.outcome || result?.status || '');
  const assistantSessionId = dispatch?.assistantSessionId || run?.assistantSessionId || null;

  let kind = null;
  let detail = '';
  let warm = false;
  if (!endState) {
    // A warm worker between turns: only a task it reported done ends on a card.
    // Background work it started may still be running (and report again).
    if (outcome !== 'done' || busy) return null;
    kind = 'complete';
    warm = true;
  } else if (endState === 'failed') {
    kind = 'failed';
    detail = plain(dispatch?.error || run?.error || '', 400) || t('failedNoReason');
  } else if (outcome === 'done' && !(stoppedMidTurn && endState !== 'completed')) {
    kind = 'complete';
  } else if ((outcome === 'blocked' || outcome === 'needs_input') && !stoppedMidTurn) {
    kind = outcome;
  } else if (endState === 'completed') {
    // Completed without a done report: the Assistant completed it (agent_complete).
    kind = 'complete';
  } else {
    kind = endState === 'interrupted' ? 'interrupted' : 'stopped';
    detail = stopReason(dispatch?.completionReason || run?.stoppedReason || '', t);
    // A Claude Code worker the server could not resume after a restart says why (lib/worker-resume.js; a resume that
    // failed to start has the reason resume_failed and the error).
    const notResumed = dispatch?.resumeRefused || (dispatch?.completionReason === 'resume_failed' ? (dispatch?.error || run?.error || '') : '');
    if (kind === 'interrupted' && notResumed) detail = t('reasonRestartNotResumed', { reason: plain(notResumed, 200) });
  }

  if (kind === 'complete' || kind === 'blocked') detail = plain(result?.summary || '');
  if (kind === 'needs_input') detail = plain(result?.question || result?.summary || '');

  const titles = { complete: 'complete', blocked: 'blocked', needs_input: 'needsInput', failed: 'failed', stopped: 'stopped', interrupted: 'interrupted' };
  const tones = { complete: 'ok', blocked: 'warn', needs_input: 'warn', failed: 'err', stopped: 'off', interrupted: 'off' };
  const elapsed = elapsedOf(run, dispatch, kind === 'complete' || kind === 'blocked' || kind === 'needs_input');
  const meta = [elapsed != null ? formatDuration(elapsed, t) : '', formatCost(dispatch?.costUsd)].filter(Boolean).join(' · ');
  const view = {
    kind,
    tone: tones[kind],
    title: t(titles[kind]),
    detail,
    meta,
    note: warm && assistantSessionId ? t('warmNote') : '',
    warm,
    assistantSessionId,
    backLabel: assistantSessionId ? t('back') : '',
    backHint: assistantSessionId ? t('backHint') : '',
    sig: '',
  };
  view.sig = JSON.stringify([view.kind, view.title, view.detail, view.meta, view.note, view.assistantSessionId, view.backLabel]);
  return view;
}

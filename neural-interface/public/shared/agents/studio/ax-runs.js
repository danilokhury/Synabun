// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the runs of an agent, and a test run
// ═══════════════════════════════════════════
//
// GET /agents/:id/runs lists the dispatcher's records that ran as an agent (lib/agents-studio-api.js `runRow`): the
// title, the state (the dispatcher's own: queued … completed / failed / stopped / interrupted), the model, the
// times, the cost, and whether it was a test of a draft. This module says what a row shows and follows one test
// run among them until it has ended. No DOM and no imports.

/** The dispatcher's states (lib/assistant-dispatch.js ACTIVE_STATES, TERMINAL_STATES). */
export const ACTIVE_STATES = Object.freeze(['queued', 'awaiting_route', 'starting', 'running', 'idle', 'awaiting_permission', 'suspended', 'resuming']);
export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'stopped', 'interrupted']);
const TONES = { queued: 'idle', awaiting_route: 'warn', starting: 'active', running: 'active', idle: 'ok', awaiting_permission: 'warn', suspended: 'warn', resuming: 'active', completed: 'done', failed: 'err', stopped: 'off', interrupted: 'err' };

const text = (value, max = 600) => (typeof value === 'string' ? value.slice(0, max) : '');

/** idle / active / ok / done / warn / err / off for a run state (an unknown one is idle). */
export const runTone = (state) => TONES[state] || 'idle';
export const isActive = (state) => ACTIVE_STATES.includes(state);
export const isTerminal = (state) => TERMINAL_STATES.includes(state);

/** A cost in dollars as text: "$0.00", "$0.042", "$1.20"; '' for nothing. */
export function costText(usd) {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${value.toFixed(2)}`;
}

/** A duration as text: "42 s", "3 min", "1 h 05 min"; '' for nothing. */
export function durationText(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** One run as a row of the list. */
export function runRow(run) {
  const r = run && typeof run === 'object' ? run : {};
  const state = text(r.state, 40);
  return {
    runId: text(r.runId, 128),
    title: text(r.title, 200),
    state, tone: runTone(state), active: r.active === true || isActive(state),
    outcome: text(r.outcome || r.status, 40),
    summary: text(r.summary, 600),
    provider: text(r.provider, 40), model: text(r.model, 200), effort: text(r.effort, 40),
    revision: Number.isInteger(r.agentRevision) ? r.agentRevision : null,
    agentRef: text(r.agentRef, 200),
    test: r.test === true,
    corrections: Array.isArray(r.corrections) ? r.corrections.filter((c) => c && typeof c === 'object').map((c) => ({ field: text(c.field, 60), text: text(c.text, 600), reason: text(c.reason, 80) })) : [],
    project: text(r.project || r.cwd, 1024),
    at: text(r.startedAt || r.createdAt, 40),
    finishedAt: text(r.finishedAt, 40),
    duration: durationText(r.elapsedMs),
    cost: costText(r.costUsd),
  };
}

/** The list, newest first. */
export function runRows(runs) {
  return (Array.isArray(runs) ? runs : []).map(runRow).filter((row) => row.runId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * Where a test run stands, from the answer of POST /test-run and then from the runs list:
 *   { phase: 'starting' | 'running' | 'ended' | 'lost', run }
 * `lost`: the run is no longer in the list (removed), so nothing more can be said.
 */
export function testRunState(runId, rows, started = null) {
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.runId === runId) || null;
  if (!row) return started ? { phase: 'starting', run: runRow(started) } : { phase: 'lost', run: null };
  if (isTerminal(row.state)) return { phase: 'ended', run: row };
  // A worker that has answered and waits for a follow-up (idle) has given its result: the test is read.
  if (row.state === 'idle' && row.summary) return { phase: 'ended', run: row };
  return { phase: 'running', run: row };
}

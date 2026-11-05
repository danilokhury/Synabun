// OpenCode automation sessions are still normal provider sessions, but their
// internal Task/Agent children must stay inside the automation's single UI tab.
// This registry is populated both by native event metadata (race-safe) and by
// persisted panel ownership (reload-safe).

const _runBySession = new Map();
const _registeredListeners = new Set();
// The automation sessions whose run is live (starting, running, or suspended by a server restart and
// resumed on the next start): the panel's own book of them (ocp-v2-panel.js `_automationRunning`), kept
// here so the socket layer can read it without importing the panel.
const _liveRuns = new Set();

/** The set of automation sessions whose run is live. The panel adds and deletes; everyone else reads. */
export function liveAutomationSessions() {
  return _liveRuns;
}

/**
 * True when the run that drives `sessionId` answers that session's own permission asks by itself: an
 * automation's root session while its run is live. Its native adapter replies to every ask (by the
 * worker's confinement, or "once" when it has none; lib/native-loop-providers.js policyReply), and the
 * asks it hands to a person go to the Assistant's own card. A protected worker's OpenCode rules ask for
 * every shell call, so such an ask is a step of the run, not news. A sub-agent's ask is not answered by
 * the run (the adapter keeps to its own session), and an ended run answers nothing.
 */
export function automationRunAnswersAsks(sessionId) {
  const sid = clean(sessionId);
  return !!sid && _runBySession.has(sid) && _liveRuns.has(sid);
}

function clean(value) {
  return String(value || '').trim();
}

export function registerAutomationSession(sessionId, runId = '') {
  const sid = clean(sessionId);
  if (!sid) return false;
  const rid = clean(runId);
  const previous = _runBySession.get(sid);
  if (previous === rid && _runBySession.has(sid)) return false;
  _runBySession.set(sid, rid);
  for (const listener of _registeredListeners) {
    try { listener({ sessionId: sid, runId: rid, previousRunId: previous || '' }); }
    catch (error) { console.warn('[ocp-v2-automation] ownership listener failed', error); }
  }
  return true;
}

export function unregisterAutomationSession(sessionId, runId = null) {
  const sid = clean(sessionId);
  if (!sid || !_runBySession.has(sid)) return false;
  const expectedRunId = runId == null ? null : clean(runId);
  if (expectedRunId != null && _runBySession.get(sid) !== expectedRunId) return false;
  _liveRuns.delete(sid);
  return _runBySession.delete(sid);
}

export function isAutomationSession(sessionId) {
  const sid = clean(sessionId);
  return !!sid && _runBySession.has(sid);
}

export function automationRunIdForSession(sessionId) {
  return _runBySession.get(clean(sessionId)) || '';
}

export function onAutomationSessionRegistered(listener) {
  if (typeof listener !== 'function') return () => {};
  _registeredListeners.add(listener);
  return () => _registeredListeners.delete(listener);
}

export function shouldMaterializeChildPanel(parentSessionId, childSessionId) {
  const parent = clean(parentSessionId);
  const child = clean(childSessionId);
  return !!parent && !!child && parent !== child && !isAutomationSession(parent);
}

/**
 * Stop the native loop that drives `sessionId` (Stop pressed in a session an
 * automation is running). `sessionId` is passed by value, read before anything
 * is awaited: the bookkeeping updated after the stop request is that
 * session's, wherever the panel is by then.
 *   books   { runIds: Map(sessionId → runId), running: Set(sessionId) }
 *   stop    async (runId) → the request that stops the loop
 * Resolves true when a loop was stopped (the caller's turn is over).
 */
export async function stopAutomationRun(sessionId, books, stop) {
  const sid = clean(sessionId);
  const runId = sid ? books?.runIds?.get(sid) : null;
  if (!runId || !books.running.has(sid)) return false;
  await stop(runId);
  books.running.delete(sid);
  return true;
}

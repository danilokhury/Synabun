// OpenCode automation sessions are still normal provider sessions, but their
// internal Task/Agent children must stay inside the automation's single UI tab.
// This registry is populated both by native event metadata (race-safe) and by
// persisted panel ownership (reload-safe).

const _runBySession = new Map();
const _registeredListeners = new Set();

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

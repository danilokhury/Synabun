/**
 * Per-tab state factory + lifecycle helpers for the OpenCode sidepanel.
 *
 * Replaces the 22 ad-hoc `tab._*` field assignments and three duplicated
 * reset blocks scattered across ocp-tabs.js. One canonical setter for plan
 * content (with a lock so the 13+ write sites can't fight each other) and
 * one canonical endTurn() so the three finalization handlers
 * (message.updated / message.completed / session.status:idle) share a
 * single idempotent funnel.
 *
 * This module is a leaf — it imports nothing from siblings.
 */

const _turnSeq = { id: 0 };

/**
 * Allocate the runtime fields (the ones that today appear as ad-hoc
 * tab._foo in ocp-tabs.js) on a freshly-built tab object. Pure overlay —
 * does not own the tab object identity, so existing code that references
 * `tab.foo` keeps working.
 */
export function attachStateFields(tab) {
  if (!tab || tab.__stateAttached) return tab;
  tab.__stateAttached = true;

  // Plan-mode capture state. Only `setPlanContent` writes `planContent`.
  tab.planContent = tab.planContent || '';
  tab.planFilePath = tab.planFilePath || '';
  tab.editedPlanContent = tab.editedPlanContent || '';
  tab.showPostPlanActions = !!tab.showPostPlanActions;
  tab.postPlanHeader = tab.postPlanHeader || 'PLAN COMPLETE';
  tab._planContentLocked = false;
  tab._planContentSource = '';

  // Turn lifecycle.
  tab._turnId = 0;
  tab._turnEndedFor = -1;
  tab._turnRunning = false;

  // Per-turn flags (cleared by resetTurnFlags).
  tab._exitPlanDetected = false;
  tab._questionToolUsedThisTurn = false;
  tab._pendingPostPlanCheck = false;

  // Watchdog handles (single tiered watchdog, see ocp-plan.js).
  tab._planWatchdogId = null;
  tab._planWatchdogTier = null;
  tab._planWatchdogLastEventAt = 0;

  // Question / permission queues.
  tab._questionQueue = tab._questionQueue || [];
  tab._activeQuestionToolId = tab._activeQuestionToolId || null;
  tab._activePermissionId = tab._activePermissionId || null;

  // Event diagnostics.
  tab._eventCount = 0;
  tab._lastEventAt = 0;
  tab._lastEventName = '';

  return tab;
}

// --- Plan content (single source of truth) ---

/**
 * Write tab.planContent. After lockPlanContent() is called, subsequent
 * setPlanContent() calls are silent no-ops unless `force: true` is passed.
 *
 * Returns true if the value changed.
 */
export function setPlanContent(tab, text, source = 'unknown', { force = false } = {}) {
  if (!tab) return false;
  attachStateFields(tab);
  if (typeof text !== 'string' || !text) return false;
  if (tab._planContentLocked && !force) return false;
  if (tab.planContent === text) return false;
  tab.planContent = text;
  tab._planContentSource = source;
  return true;
}

export function lockPlanContent(tab, source = 'lock') {
  if (!tab) return;
  attachStateFields(tab);
  tab._planContentLocked = true;
  if (source) tab._planContentSource = `${tab._planContentSource}+${source}`;
}

export function unlockPlanContent(tab) {
  if (!tab) return;
  attachStateFields(tab);
  tab._planContentLocked = false;
}

export function getPlanContent(tab) {
  return tab?.planContent || '';
}

export function isPlanLocked(tab) {
  return !!tab?._planContentLocked;
}

// --- Turn lifecycle ---

export function beginTurn(tab) {
  if (!tab) return -1;
  attachStateFields(tab);
  tab._turnId = ++_turnSeq.id;
  tab._turnRunning = true;
  resetTurnFlags(tab);
  return tab._turnId;
}

/**
 * Mark the current turn ended. Idempotent — repeated calls for the same
 * turn return false. Returns true on the first call, false on later
 * calls. Handlers should branch on this so finalize work runs once.
 */
export function endTurn(tab, reason = '') {
  if (!tab) return false;
  attachStateFields(tab);
  if (tab._turnEndedFor === tab._turnId) return false;
  tab._turnEndedFor = tab._turnId;
  tab._turnRunning = false;
  tab._lastEndReason = reason || 'unknown';
  return true;
}

export function isTurnEnded(tab) {
  return !!tab && tab._turnEndedFor === tab._turnId;
}

export function isTurnRunning(tab) {
  return !!tab && tab._turnRunning && tab._turnEndedFor !== tab._turnId;
}

export function resetTurnFlags(tab) {
  if (!tab) return;
  attachStateFields(tab);
  tab._exitPlanDetected = false;
  tab._questionToolUsedThisTurn = false;
  tab._pendingPostPlanCheck = false;
  tab._planContentLocked = false;
  // showPostPlanActions stays — it's per-plan-mode-arc, not per-turn
}

// --- Event tracking (diagnostic) ---

export function recordEvent(tab, eventName) {
  if (!tab) return;
  attachStateFields(tab);
  tab._eventCount = (tab._eventCount || 0) + 1;
  tab._lastEventAt = Date.now();
  tab._lastEventName = eventName || '';
}

// --- Question state passthroughs ---

export function setQuestionToolUsedThisTurn(tab, value = true) {
  if (!tab) return;
  attachStateFields(tab);
  tab._questionToolUsedThisTurn = !!value;
}

export function wasQuestionToolUsedThisTurn(tab) {
  return !!tab?._questionToolUsedThisTurn;
}

export function setExitPlanDetected(tab, value = true) {
  if (!tab) return;
  attachStateFields(tab);
  tab._exitPlanDetected = !!value;
}

export function wasExitPlanDetected(tab) {
  return !!tab?._exitPlanDetected;
}

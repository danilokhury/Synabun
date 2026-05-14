/**
 * Single SDK event router.
 *
 * Sits in front of the existing event handler in ocp-tabs.js and runs
 * per-event side effects through the focused modules:
 *
 *   - streamModule    — finalize tracking (replaces _renderedAssistantMsgIds
 *                       Set; markFinalized only fires on explicit terminal
 *                       events, not on first ExitPlanMode tool detection,
 *                       which is what truncated plan output today).
 *   - planModule      — single watchdog re-arm point per event arrival,
 *                       single onTurnTerminal entry, single ExitPlanMode
 *                       capture+lock via onToolStart.
 *   - questionsModule — queue housekeeping (active id, queue) on
 *                       question.asked / permission.asked events.
 *   - state           — turn diagnostics (event count, last event name).
 *
 * Returns false if the event was consumed and should NOT propagate to the
 * legacy ocp-tabs handler. Native question/permission events are already
 * module-owned; legacy rendering still handles message/tool stream events.
 */

import * as streamModule from './ocp-stream.js';
import * as planModule from './ocp-plan.js';
import * as questionsModule from './ocp-questions.js';
import {
  attachStateFields,
  recordEvent,
  setQuestionToolUsedThisTurn,
} from './ocp-state.js';
import { trace } from './ocp-trace.js';

const _deps = {
  getActiveTab: () => null,
  getTabBySessionId: () => null,
  panelEl: () => null,
};

export function configure(deps = {}) {
  Object.assign(_deps, deps);
}

/**
 * The single dispatch entry. Wire from ocp-tabs.js's WS event handler:
 *
 *   onWsMessage((msg) => {
 *     if (msg.type === 'event') routeSdkEvent(msg.eventType, msg.event);
 *   });
 *
 * Idempotent — calling it before the legacy handler is fine.
 */
export function routeSdkEvent(eventType, event) {
  if (!eventType) return;
  const sid = eventSessionId(event);
  const tab = pickTab(sid);
  if (!tab) {
    trace('event:in', { type: eventType, sid, dropped: 'no-tab' });
    return;
  }
  attachStateFields(tab);

  recordEvent(tab, eventType);
  const partType = event?.part?.type || event?.partType || '';
  const toolName = event?.tool?.name || event?.toolName || event?.part?.tool || '';
  trace('event:in', { type: eventType, sid, mode: tab.mode, partType, toolName });

  // Plan-mode: every event re-arms the tiered watchdog (silence8/soft60/...)
  // because the model is alive and emitting.
  if (tab.mode === 'plan') planModule.noteEventArrival(tab);

  const container = _deps.panelEl('#ocp-messages');
  const isActiveTab = tab === _deps.getActiveTab();
  const activeContainer = isActiveTab ? container : null;

  switch (eventType) {
    case 'message.part.delta':
      // Stream module handles partial-text accumulation. Renderer's
      // O(1) text-node append is preserved verbatim inside ocp-render.
      // (Stream module's onPartDelta is opt-in — currently the legacy
      // handler still drives the actual DOM append; we just record the
      // event for diagnostics here.)
      break;
    case 'message.part.updated':
      // Stream module: full-snapshot adoption with length-gated
      // anti-clobber inside ocp-render. Same as above — recording only.
      if (isQuestionPart(event)) {
        setQuestionToolUsedThisTurn(tab, true);
        questionsModule.scheduleQuestionListBackstop(tab, { reason: 'message.part.updated:question' });
        return false;
      }
      break;
    case 'message.completed':
      // The one place that flips finalize state. ocp-stream.markFinalized
      // gates re-render so duplicate message.updated echoes (Windows
      // timing) don't blow away the rendered output.
      if (activeContainer) streamModule.onMessageCompleted(tab, activeContainer, event);
      // ocp-plan.onTurnTerminal collapses the original 6-gates pattern
      // into a single idempotent entry point.
      planModule.onTurnTerminal(tab, 'message.completed');
      break;
    case 'session.status': {
      const stat = event?.status?.type || event?.status || '';
      if (stat === 'idle') {
        if (activeContainer) streamModule.onSessionIdle(tab, activeContainer, event);
        planModule.onTurnTerminal(tab, 'session.status:idle');
      } else if (stat === 'running' && tab.mode === 'plan') {
        planModule.armWatchdog(tab);
      }
      break;
    }
    case 'session.idle':
      if (activeContainer) streamModule.onSessionIdle(tab, activeContainer, event);
      planModule.onTurnTerminal(tab, 'session.idle');
      break;
    case 'session.error':
      if (activeContainer) streamModule.onAbort(tab, activeContainer, 'error');
      planModule.clearWatchdogs(tab);
      break;
    case 'tool.start': {
      // Track question-tool usage for the prose-question guard (this is
      // what disambiguates "model called question tool" from "model wrote
      // questions as prose"). Reading via state setter so the gate at
      // line 1260 vs 1291 of ocp-tabs.js reads the same field today.
      const toolName = event?.tool?.name || event?.toolName || event?.tool || event?.name || '';
      if (/^question$/i.test(toolName)) {
        setQuestionToolUsedThisTurn(tab, true);
        questionsModule.scheduleQuestionListBackstop(tab, { reason: 'tool.start:question' });
        return false;
      }
      // ExitPlanMode: single detection + lock. Replaces the original
      // 3 competing detection paths.
      if (tab.mode === 'plan' && planModule.detectExitPlan(toolName)) {
        const input = event?.input || event?.tool?.input || {};
        planModule.onToolStart(tab, { toolName, input });
        planModule.armWatchdog(tab);
      }
      break;
    }
    case 'question.asked': {
      const reqId = event?.id || event?.requestID || '';
      if (!reqId) {
        trace('q:asked:no-reqId', { sid });
        return false;
      }
      const qCount = Array.isArray(event.questions) ? event.questions.length : 1;
      trace('q:asked', { sid, reqId, count: qCount });
      setQuestionToolUsedThisTurn(tab, true);
      questionsModule.clearQuestionListBackstop(tab);
      if (questionsModule.activeQuestionToolId(tab) === reqId) {
        trace('q:already-active', { sid, reqId });
        if (activeContainer) questionsModule.ensurePendingQuestionVisible(tab, activeContainer);
        return false;
      }
      if (questionsModule.hasActiveQuestion(tab) || !activeContainer) {
        if (!questionsModule.hasQueuedQuestion(tab, reqId)) {
          questionsModule.queueQuestion(tab, { eventType, event, reqId });
          trace('q:queued', { sid, reqId, reason: !activeContainer ? 'no-container' : 'active-question-busy' });
        }
        return false;
      }
      trace('q:render', { sid, reqId, count: qCount });
      questionsModule.renderOpencodeQuestion(tab, activeContainer, event, reqId);
      return false;
    }
    case 'question.replied': {
      const reqId = event?.requestID || event?.id || '';
      questionsModule.handleQuestionResolved(tab, activeContainer, reqId);
      return false;
    }
    case 'question.rejected': {
      const reqId = event?.requestID || event?.id || '';
      questionsModule.handleQuestionResolved(tab, activeContainer, reqId);
      return false;
    }
    case 'permission.asked':
    case 'permission.updated': {
      const permId = event?.id || event?.permissionID || '';
      if (!permId) return false;
      const status = String(event?.status || event?.state || '').toLowerCase();
      if (status === 'replied' || status === 'resolved' || status === 'approved' || status === 'rejected') {
        if (activeContainer) questionsModule.lockPermissionCard(activeContainer, permId);
        if (questionsModule.activePermissionId(tab) === permId) questionsModule.setActivePermissionId(tab, null);
        return false;
      }
      if (questionsModule.activePermissionId(tab) === permId) return false;
      if (activeContainer) questionsModule.renderOpencodePermission(tab, activeContainer, event, permId);
      return false;
    }
    case 'permission.replied':
    case 'permission.rejected': {
      const permId = event?.id || event?.permissionID || '';
      if (permId && activeContainer) questionsModule.lockPermissionCard(activeContainer, permId);
      if (questionsModule.activePermissionId(tab) === permId) questionsModule.setActivePermissionId(tab, null);
      return false;
    }
    default:
      // No router-specific behavior; legacy handler in ocp-tabs takes over.
      break;
  }

  return true;
}

function pickTab(sessionId) {
  if (sessionId) {
    const tab = _deps.getTabBySessionId(sessionId);
    if (tab) return tab;
  }
  return _deps.getActiveTab();
}

function eventSessionId(event) {
  return event?.sessionID
    || event?.sessionId
    || event?.session?.id
    || event?.part?.sessionID
    || event?.part?.sessionId
    || event?.message?.sessionID
    || event?.message?.sessionId
    || event?.tool?.sessionID
    || event?.tool?.sessionId
    || event?.info?.sessionID
    || event?.info?.sessionId
    || event?.info?.session?.id
    || '';
}

function isQuestionPart(event) {
  const part = event?.part || event;
  const partType = String(part?.type || '').toLowerCase();
  if (!partType.includes('tool')) return false;
  const toolName = part?.tool || part?.toolName || part?.name || '';
  return /^question$/i.test(String(toolName));
}

/**
 * Convenience: install the router as a WS message listener. Pass the
 * same `onWsMessage` from ocp-ws.js. Returns the unsubscribe.
 */
export function installEventRouter(onWsMessage) {
  if (typeof onWsMessage !== 'function') return () => {};
  return onWsMessage((msg) => {
    if (msg?.type !== 'event') return;
    routeSdkEvent(msg.eventType, msg.event);
  });
}

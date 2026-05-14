/**
 * sendMessage / abortTab / abortMessage / injectContext — the chat-send
 * pipeline lifted out of ocp-tabs.js (1681-1977).
 *
 * Why the giant deps object: this function sits at the center of the
 * sidepanel and touches state, render, plan-mode, question-queue, and
 * websocket layers. Rather than a circular import maze, every external
 * symbol is injected once via configure().
 *
 * The body is preserved verbatim so behavior matches today byte-for-byte;
 * the only consolidation is that the post-plan handoff at sendMessage
 * resolve/catch now goes through `planModule.onTurnTerminal` (set on
 * `_deps.maybeShowPostPlanUI` by the controller). That collapses two of
 * the six historical post-plan card render gates.
 */

import { requestWs, sendWs, rejectPending } from './ocp-ws.js';
import {
  showThinking,
  removeThinking,
  renderUserPayload,
  renderAssistantPayload,
  finalizeStreamingMessage,
  renderErrorMessage,
  removePostPlanCards,
  removeProseQuestionRecoveryCards,
  removePlanStallSoftCards,
} from './ocp-render.js';
import * as questionsModule from './ocp-questions.js';
import * as planModule from './ocp-plan.js';
import { trace, traceTimer, setTraceContext } from './ocp-trace.js';

const _deps = {
  activeTab: () => null,
  getTabs: () => [],
  panelEl: () => null,
  reconcileTabMode: () => {},
  setTurnStatus: () => {},
  tabStatusDetail: () => '',
  thinkingActivity: () => ({}),
  resetTurnNotif: () => {},
  beginTurn: () => {},
  endTurn: () => {},
  modelObj: (s) => ({ providerID: '', modelID: s }),
  partTypes: (tab) => tab?._partTypes || new Map(),
  markAssistantRendered: () => {},
  markCurrentTurnAssistantContent: () => {},
  currentTurnHasAssistantContent: () => false,
  payloadHasAssistantText: () => false,
  normalizeThreadTokenUsage: () => null,
  notifyOpenCodeOutcome: () => {},
  NOTIF_TYPE: { DONE: 'done', ERROR: 'error' },
  createSession: () => Promise.resolve(null),
  update: () => {},
  setActiveSendRequestId: () => {},
  settleRunningToolCards: () => {},
};

export function configure(deps = {}) {
  Object.assign(_deps, deps);
}

export async function sendMessage(content, options = {}) {
  const tab = _deps.activeTab();
  const text = String(content || '').trim();
  const images = Array.isArray(options.images) ? options.images.filter(Boolean) : [];
  if (!tab || (!options.force && tab.running) || (!text && !images.length)) {
    trace('send:noop', { reason: !tab ? 'no-tab' : tab.running ? 'already-running' : 'empty-content' });
    return false;
  }
  if (tab.showPostPlanActions) {
    trace('send:blocked:postPlan', { sid: tab.sessionId });
    console.warn('[ocp-send] send blocked: choose Continue with implementation / Continue planning / Compact context / Edit plan first');
    return false;
  }
  setTraceContext({ tabId: tab.id, sessionId: tab.sessionId, mode: tab.mode, model: tab.model, agent: tab.agent });
  trace('send:start', {
    sid: tab.sessionId,
    mode: tab.mode,
    model: tab.model,
    agent: tab.agent,
    textBytes: text.length,
    images: images.length,
    force: !!options.force,
  });
  _deps.reconcileTabMode(tab);
  if (options.clearQueue !== false) {
    questionsModule.clearQuestionQueue(tab);
  }

  const msgContainer = _deps.panelEl('#ocp-messages');
  if (msgContainer) {
    removePostPlanCards(msgContainer);
    removeProseQuestionRecoveryCards(msgContainer);
    try { removePlanStallSoftCards(msgContainer); } catch {}
  }
  tab._planStallSoftCardOpen = false;
  tab.showPostPlanActions = false;
  // Reset per-turn plan-detection state so multi-turn plan mode stays
  // idempotent. Without this the second plan-mode turn would short-circuit
  // every fallback that gates on !_exitPlanDetected.
  tab._exitPlanDetected = false;
  tab._questionToolUsedThisTurn = false;
  tab._pendingPostPlanCheck = false;
  // Plan-mode watchdog: cleared on send, re-armed by ocp-plan.onToolStart
  // when ExitPlanMode is detected.
  planModule.clearWatchdogs(tab);
  questionsModule.clearQuestionReplyWatchdog(tab);

  const turnStartedAt = Date.now();
  tab.running = true;
  tab.turnStartedAt = turnStartedAt;
  tab._lastEventAt = turnStartedAt;
  tab._lastEventName = '';
  tab._eventCount = 0;
  _deps.resetTurnNotif(tab);
  _deps.setTurnStatus(tab, 'Thinking…', _deps.tabStatusDetail(tab));
  // Plan-mode tiered watchdog (silence8/soft60/hard180/kill480) is armed
  // by ocp-plan.onToolStart when ExitPlanMode tool fires; on send we just
  // reset the timestamps via clearWatchdogs above. Live watchdog is
  // optional — ocp-plan.armWatchdog() can be called here if desired.
  if (tab.mode === 'plan') planModule.armWatchdog(tab);
  _deps.update();

  const container = _deps.panelEl('#ocp-messages');
  _deps.beginTurn(tab, container);
  if (container) {
    const userParts = [];
    if (text) userParts.push({ type: 'text', text });
    for (const image of images) {
      userParts.push({
        type: 'file',
        mime: image.mime || image.mediaType || 'image/png',
        filename: image.name || 'attachment',
        url: image.dataUrl || image.url || '',
      });
    }
    renderUserPayload(container, userParts);
    showThinking(container, {
      title: 'Thinking…',
      detail: _deps.tabStatusDetail(tab),
      startedAt: turnStartedAt,
      waiting: true,
      ..._deps.thinkingActivity(tab),
    });
  }

  if (!tab.sessionId) {
    const session = await _deps.createSession();
    if (!session) {
      if (container) {
        removeThinking(container);
        renderErrorMessage(container, 'Could not create OpenCode session');
      }
      tab.running = false;
      tab.turnStartedAt = 0;
      _deps.endTurn(tab);
      _deps.setTurnStatus(tab);
      _deps.update();
      return false;
    }
  }

  try {
    const body = { parts: [] };
    if (text) body.parts.push({ type: 'text', text });
    for (const image of images) {
      body.parts.push({
        type: 'file',
        mime: image.mime || image.mediaType || 'image/png',
        filename: image.name || 'attachment',
        url: image.dataUrl || image.url || '',
      });
    }
    if (tab.model) body.model = _deps.modelObj(tab.model);
    if (tab.agent) body.agent = tab.agent;
    if (tab.mode) body.mode = tab.mode;
    // Tool-permission enforcement is delegated to OpenCode's built-in agent
    // config: the `plan` agent already has write/edit/patch/bash disabled
    // and read/grep/glob/question enabled. Sending a per-message body.tools
    // restriction was previously needed to "force" plan-mode read-only, but
    // it caused a session-level cache where every subsequent build/chat turn
    // had to explicitly re-enable mutating tools — and worse, on some models
    // (deepseek v4-pro, Kimi K2.6) the partial body.tools object suppressed
    // the `question` tool entirely, so plan-mode runs would emit narration
    // text ("Let me ask clarifying questions...") and then silently never
    // call the tool. Trust the agent config: don't override per message.
    const cwd = tab.project || '';
    const endFetch = traceTimer('send:fetch', { sid: tab.sessionId, mode: tab.mode });
    const sendPromise = requestWs('message:send', {
      sessionId: tab.sessionId,
      body,
      ...(cwd ? { cwd } : {}),
    }, 1800000); // 30 min timeout — Plan agent + subagents can run long.
    _deps.setActiveSendRequestId(sendPromise.requestId);
    tab._activeSendRequestId = sendPromise.requestId;
    const resp = await sendPromise;
    endFetch({ status: resp?.status || 200 });
    _deps.setActiveSendRequestId(null);
    tab._activeSendRequestId = null;
    if (tab.running && resp?.data) {
      const info = resp.data.info || resp.data;
      const parts = resp.data.parts || info.parts || info.content;
      const assistantMid = info.id || resp.data.messageID || resp.data.messageId || '';
      const hasCurrentTurnContent = _deps.currentTurnHasAssistantContent(tab, container, assistantMid);
      if (container) {
        const streamingEl = container.querySelector('.ocp-msg-assistant.streaming');
        if (parts && streamingEl) {
          renderAssistantPayload(container, parts, { textMode: 'merge' });
          if (_deps.payloadHasAssistantText(parts)) {
            _deps.markCurrentTurnAssistantContent(tab, container, assistantMid);
          }
        } else if (parts && !hasCurrentTurnContent) {
          removeThinking(container);
          renderAssistantPayload(container, parts, { textMode: 'stream' });
          if (_deps.payloadHasAssistantText(parts)) {
            _deps.markCurrentTurnAssistantContent(tab, container, assistantMid);
          }
        }
        removeThinking(container);
        finalizeStreamingMessage(container);
        _deps.settleRunningToolCards(container, "complete");
      } else if (parts) {
        tab._needsHistoryRefresh = true;
      }
      if (assistantMid) _deps.markAssistantRendered(tab, assistantMid);
      _deps.partTypes(tab).clear();
      tab.running = false;
      tab.turnStartedAt = 0;
      if (info.tokens || info.usage) {
        const raw = info.tokens || info.usage || {};
        tab.threadTokenUsage = _deps.normalizeThreadTokenUsage(raw);
        tab.inputTokens = raw.input || raw.inputTokens || raw.input_tokens || 0;
        tab.outputTokens = raw.output || raw.outputTokens || raw.output_tokens || 0;
      }
      _deps.setTurnStatus(tab);
      planModule.clearWatchdogs(tab);
      // Single post-plan entry point — collapses sendMessage:resolved gate
      // into the plan module's onTurnTerminal (one of the six original sites).
      planModule.onTurnTerminal(tab, 'sendMessage:resolved');
      _deps.notifyOpenCodeOutcome(_deps.NOTIF_TYPE.DONE, tab, info.id || tab.sessionId || tab.id);
      _deps.endTurn(tab);
      trace('send:turn:end', { sid: tab.sessionId, reason: 'resolved' });
      _deps.update();
    }
    return true;
  } catch (e) {
    _deps.setActiveSendRequestId(null);
    tab._activeSendRequestId = null;
    const isAbort = e.message === 'Aborted by user';
    const isWsTimeout = /^Request\s+message:send\s+timed out$/i.test(String(e?.message || ''));
    const sseRecentlyActive = isWsTimeout
      && tab._lastEventAt
      && (Date.now() - tab._lastEventAt) < 60000;
    const isRecoveryReject = /(?:Plan|Question)\s+stall\s+recovery/i.test(String(e?.message || ''));
    trace('send:error', {
      sid: tab.sessionId,
      err: e?.message || String(e),
      isAbort,
      isWsTimeout,
      sseRecentlyActive,
      isRecoveryReject,
    });
    if (isRecoveryReject) {
      console.warn('[ocp-send] sendMessage rejected by stall recovery:', e?.message || e);
    }
    if (container && !isAbort && !sseRecentlyActive && !isRecoveryReject) {
      removeThinking(container);
      renderErrorMessage(container, e.message);
    }
    if (!isAbort && !sseRecentlyActive) {
      tab.running = false;
      tab.turnStartedAt = 0;
      _deps.endTurn(tab);
      _deps.setTurnStatus(tab);
      _deps.notifyOpenCodeOutcome(_deps.NOTIF_TYPE.ERROR, tab, tab.sessionId || tab.id);
      planModule.clearWatchdogs(tab);
      // CLI parity: send failure does NOT surface PLAN COMPLETE unless
      // ExitPlanMode was already detected. The plan module gates this.
      if (tab.mode === 'plan' && !tab.showPostPlanActions && tab._exitPlanDetected && !isRecoveryReject) {
        planModule.onTurnTerminal(tab, 'sendMessage:catch', { force: true });
      }
      _deps.update();
    }
    return false;
  }
}

export function anyTabRunning() {
  return _deps.getTabs().some((t) => t?.running);
}

export async function abortMessage() {
  const tab = _deps.activeTab();
  if (!tab?.running) return false;
  const container = _deps.panelEl('#ocp-messages');
  const stopped = abortTab(tab, container);
  if (stopped) _deps.update();
  return stopped;
}

export function abortTab(tab, container = null) {
  if (!tab?.running) return false;
  if (tab.sessionId) {
    try { sendWs({ type: 'message:abort', sessionId: tab.sessionId }); } catch {}
  }
  if (tab._activeSendRequestId) {
    rejectPending(tab._activeSendRequestId, 'Aborted by user');
    _deps.setActiveSendRequestId(null);
    tab._activeSendRequestId = null;
  }
  if (container) {
    removeThinking(container);
    finalizeStreamingMessage(container);
    _deps.settleRunningToolCards(container, "aborted");
    try { removePlanStallSoftCards(container); } catch {}
  }
  tab._planStallSoftCardOpen = false;
  tab.running = false;
  tab.turnStartedAt = 0;
  _deps.endTurn(tab);
  _deps.setTurnStatus(tab);
  planModule.clearWatchdogs(tab);
  questionsModule.clearQuestionReplyWatchdog(tab);
  return true;
}

export async function abortAllTabs() {
  let stoppedAny = false;
  const activeContainer = _deps.panelEl('#ocp-messages');
  const active = _deps.activeTab();
  for (const tab of _deps.getTabs()) {
    stoppedAny = abortTab(tab, tab === active ? activeContainer : null) || stoppedAny;
  }
  _deps.setActiveSendRequestId(null);
  if (stoppedAny) _deps.update();
  return stoppedAny;
}

export async function injectContext(content) {
  const tab = _deps.activeTab();
  if (!tab || !tab.sessionId) return false;
  const text = String(content || '').trim();
  if (!text) return false;
  try {
    await requestWs('message:send', {
      sessionId: tab.sessionId,
      body: {
        parts: [{ type: 'text', text }],
        noReply: true,
      },
    }, 30000);
    return true;
  } catch (e) {
    console.error('[ocp-send] injectContext failed:', e);
    return false;
  }
}

/**
 * Plan-mode flow consolidated.
 *
 * Replaces three competing plan-exit detection paths (tool.start at
 * ocp-tabs.js:2839, message.part.updated at 2649, message.updated at 2549),
 * six idempotent post-plan-card render gates, and two overlapping stall
 * watchdogs with one detector, one entry-point, and one tiered timer.
 *
 * Keys to the consolidation:
 *  - One regex (`EXIT_PLAN_REGEX`) for ExitPlanMode / plan_exit detection.
 *  - One captured-content lock — once `setPlanContent` lands the canonical
 *    plan text, later sites can't overwrite it, so the 13+ writers no
 *    longer race.
 *  - One `onTurnTerminal(tab, reason)` — the only path that renders the
 *    post-plan card. All terminal events (message.completed,
 *    session.status:idle, sendMessage resolve/catch, error, watchdog) feed
 *    in here.
 *  - One tiered watchdog — silence8 → soft60 → hard180 → kill480, re-armed
 *    on every event arrival via `recordEvent()`.
 *
 * Dependencies are injected via `configure({ ... })` so this module
 * stays free of circular imports with ocp-tabs.js.
 */

import {
  attachStateFields,
  setPlanContent,
  lockPlanContent,
  getPlanContent,
  isPlanLocked,
  setExitPlanDetected,
  wasExitPlanDetected,
  wasQuestionToolUsedThisTurn,
} from './ocp-state.js';
import {
  removePostPlanCards,
  renderPostPlanCard,
  renderProseQuestionRecoveryCard,
  removeProseQuestionRecoveryCards,
  renderPlanStallSoftCard,
  removePlanStallSoftCards,
  removeThinking,
} from './ocp-render.js';
import { trace } from './ocp-trace.js';

export const EXIT_PLAN_REGEX = /^(ExitPlanMode|plan[_-]exit)$/i;
const EXIT_PLAN_LOOSE_REGEX = /exit\s*plan|plan[\s_-]?exit/i;

const _deps = {
  panelEl: () => null,
  sendMessage: () => {},
  setTabMode: () => {},
  compactSession: () => {},
  saveTabs: () => {},
  update: () => {},
  abortTab: () => {},
  ensurePlanFile: () => Promise.resolve(''),
  onEditPlan: null,
  todosToMarkdown: () => '',
  hasActiveQuestion: () => false,
  activePermissionId: () => null,
  backfillPendingQuestions: () => Promise.resolve(false),
  finalizeStreamingMessage: () => {},
  settleRunningToolCards: () => {},
  notifyOpenCodeOutcome: () => {},
  endTurn: () => {},
  setTurnStatus: () => {},
};

/** Inject dependencies (called once from ocp-tabs.js at module init). */
export function configure(deps = {}) {
  Object.assign(_deps, deps);
}

// --- Detection ---

export function detectExitPlan(toolName) {
  if (!toolName) return false;
  return EXIT_PLAN_REGEX.test(String(toolName).trim());
}

// --- Capture ---

/**
 * Called from the `tool.start` SDK event router when an ExitPlanMode tool
 * fires. Captures `event.input.plan` (or fallback fields) once and locks
 * the plan content so later sites can't overwrite it.
 */
export function onToolStart(tab, event) {
  if (!tab) return;
  attachStateFields(tab);
  const toolName = event?.toolName || event?.tool?.name || event?.name || '';
  if (!detectExitPlan(toolName)) return;
  setExitPlanDetected(tab, true);
  const input = event?.input || event?.tool?.input || {};
  const planText = String(input?.plan || input?.markdown || input?.content || input?.text || '').trim();
  trace('plan:exitPlanMode', { sid: tab.sessionId, toolName, planLen: planText.length });
  if (planText) {
    setPlanContent(tab, planText, 'tool.exitPlanMode', { force: true });
    lockPlanContent(tab, 'tool.exitPlanMode');
  }
  // Mid-turn — don't render the post-plan card yet. Wait for terminal event.
}

/**
 * Cascade-extract plan content from the DOM. Used by onTurnTerminal when
 * the ExitPlanMode tool input was empty or never fired but plan-mode hit
 * a terminal state. Order: ExitPlanMode tool args → todowrite todos →
 * final assistant text bubble → standalone reasoning blocks → subagent
 * tool result → any assistant bubble (last resort).
 *
 * Sets tab.planContent as a side effect, respecting the lock.
 */
export function captureFromDom(tab) {
  if (!tab) return '';
  if (isPlanLocked(tab) && getPlanContent(tab)) return getPlanContent(tab);
  const container = _deps.panelEl('#ocp-messages');
  if (!container) return getPlanContent(tab);

  const toolCards = Array.from(container.querySelectorAll('.ocp-tool-card'));

  // 1. ExitPlanMode tool cards.
  for (let i = toolCards.length - 1; i >= 0; i--) {
    const nameEl = toolCards[i].querySelector('.ocp-tool-name');
    const name = (nameEl?.textContent || '').trim();
    if (!EXIT_PLAN_LOOSE_REGEX.test(name)) continue;
    const argsPre = toolCards[i].querySelector('.ocp-tool-args');
    const argsRaw = (argsPre?.textContent || '').trim();
    if (!argsRaw) continue;
    try {
      const parsed = JSON.parse(argsRaw);
      const planText = String(parsed?.plan || parsed?.markdown || parsed?.content || parsed?.text || '').trim();
      if (planText) { setPlanContent(tab, planText, 'dom.exitPlanMode', { force: true }); return planText; }
    } catch {
      if (argsRaw.length > 40) { setPlanContent(tab, argsRaw, 'dom.exitPlanMode-raw', { force: true }); return argsRaw; }
    }
  }

  // 1b. Tasks (todowrite) tool cards.
  for (let i = toolCards.length - 1; i >= 0; i--) {
    const nameEl = toolCards[i].querySelector('.ocp-tool-name');
    const name = (nameEl?.textContent || '').trim();
    if (!/^tasks?$|todo[_-]?write/i.test(name)) continue;
    const argsPre = toolCards[i].querySelector('.ocp-tool-args');
    const argsRaw = (argsPre?.textContent || '').trim();
    if (!argsRaw) continue;
    try {
      const parsed = JSON.parse(argsRaw);
      const todos = Array.isArray(parsed?.todos) ? parsed.todos : [];
      const planMd = _deps.todosToMarkdown(todos);
      if (planMd && planMd.length > 40) { setPlanContent(tab, planMd, 'dom.todowrite', { force: false }); return planMd; }
    } catch {}
  }

  // 2. Final assistant text bubble.
  const assistantEls = container.querySelectorAll('.ocp-msg-assistant');
  if (assistantEls.length) {
    const lastEl = assistantEls[assistantEls.length - 1];
    const clone = lastEl.cloneNode(true);
    for (const tb of clone.querySelectorAll('.ocp-think-block')) tb.remove();
    const text = (clone.textContent || '').trim();
    if (text.length > 40) { setPlanContent(tab, text, 'dom.assistant', { force: false }); return text; }
  }

  // 3. Standalone reasoning blocks.
  const thinkBlocks = container.querySelectorAll('.ocp-think-block .ocp-think-content');
  if (thinkBlocks.length) {
    const lastThink = thinkBlocks[thinkBlocks.length - 1];
    const text = (lastThink.textContent || '').trim();
    if (text.length > 40) { setPlanContent(tab, text, 'dom.reasoning', { force: false }); return text; }
  }

  // 4. Subagent tool result.
  for (let i = toolCards.length - 1; i >= 0; i--) {
    const nameEl = toolCards[i].querySelector('.ocp-tool-name');
    const name = (nameEl?.textContent || '').trim().toLowerCase();
    if (!(name === 'agent' || name === 'task' || name.includes('agent'))) continue;
    const resultPre = toolCards[i].querySelector('.ocp-tool-result');
    const resultRaw = (resultPre?.textContent || '').trim();
    if (resultRaw.length > 40) { setPlanContent(tab, resultRaw, 'dom.subagent', { force: false }); return resultRaw; }
  }

  // Last resort: any assistant bubble at all.
  if (assistantEls.length) {
    const lastEl = assistantEls[assistantEls.length - 1];
    const text = (lastEl.textContent || '').trim();
    if (text) { setPlanContent(tab, text, 'dom.lastresort', { force: false }); return text; }
  }
  return getPlanContent(tab);
}

// --- Validation guards ---

export function isRealPlanContent(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 80) return false;
  const lower = trimmed.toLowerCase();
  const thinkingArtifacts = [
    'thought›', 'thought >', 'let me re-read', 'let me first recall',
    'but wait', 'wait —', 'wait -', 'actually, let me',
    'this seems like they want',
  ];
  if (thinkingArtifacts.some((m) => lower.includes(m))) return false;
  const hasHeading = /(^|\n)#{1,3}\s+\S/.test(trimmed);
  const hasList = /(^|\n)(?:[-*]|\d+\.)\s+\S/.test(trimmed);
  // Narration guard only applies when the body is short/unstructured. Once
  // the model produces a substantial structured plan (>=300 chars with a
  // heading or list), a "Let me think…" / "I need to…" preamble is just a
  // preamble — non-Anthropic models (GPT, Kimi) routinely open this way
  // without calling ExitPlanMode, and a strict guard suppressed real plans.
  if (!(trimmed.length >= 300 && (hasHeading || hasList))) {
    const head = lower.slice(0, 200);
    const narrationMarkers = [
      "i'm in plan mode", "im in plan mode", "the user is in plan mode",
      "the user wants", "let me ask", "let me think", "let me plan",
      "let me understand", "before i ", "i need to ", "i'll need to",
      "i need more", "to plan this", "to test the flow",
    ];
    if (narrationMarkers.some((m) => head.includes(m))) return false;
  }
  return hasHeading || hasList;
}

export function looksLikeProseQuestions(content) {
  if (!content) return false;
  const tail = String(content).slice(-500);
  // "Before I proceed, a couple of quick questions:" / "Two quick questions:"
  if (/(^|\n)\s*(quick |a couple of |before i proceed,?\s*|two\s+).*?questions?:?\s*$/im.test(tail)) return true;
  // "let me ask you a few clarifying questions" / "i'll ask a few questions"
  if (/(let me ask|i'?ll ask|let'?s ask|i need to ask|i'?d like to ask|allow me to ask)\b[^\n]{0,80}questions?[:.]?\s*$/im.test(tail)) return true;
  // "Here are a few clarifying questions:" / "I have some questions:"
  if (/(^|\n)\s*(here are|i have|i've got)\s+(a few|some|several|\d+)\s+(clarifying\s+|quick\s+)?questions?[:.]?\s*$/im.test(tail)) return true;
  // "to test the flow, let me ask you a few clarifying questions as if..."
  if (/\b(a few|some|several)\s+(clarifying|quick)\s+questions?\b[^\n]{0,80}[:.]\s*$/im.test(tail)) return true;
  // "Question 1:" / "Q2."
  if (/(^|\n)\s*(question|q)\s*\d+\s*[:.]/im.test(tail)) return true;
  // 2+ trailing question marks across last 500 chars
  const qMarks = (tail.match(/\?\s*(\n|$)/g) || []).length;
  if (qMarks >= 2) return true;
  return false;
}

// --- Post-plan UI (single entry point) ---

/**
 * THE one entry point for post-plan card rendering.
 *
 * Replaces the six scattered `maybeShowPostPlanUI` callsites and their
 * idempotent re-checks (resolved/catch in sendMessage, message.completed,
 * session.status:idle, session.idle, watchdog). Always idempotent —
 * callers don't need to gate.
 *
 * `reason` is a short tag like 'message.completed', 'idle', 'sendMessage:done',
 * 'watchdog:silence8'. Used for diagnostic logs only.
 *
 * `force` skips the 80-char min-length / prose-question / narration guards.
 * Set true only when ExitPlanMode tool was explicitly detected (we know
 * the plan is intentional even if the captured text is short).
 */
export function onTurnTerminal(tab, reason = '', { force = false } = {}) {
  if (!tab || tab.mode !== 'plan') return false;
  if (tab.showPostPlanActions) return true;
  attachStateFields(tab);

  trace('plan:onTurnTerminal', { sid: tab.sessionId, reason, force, exitPlanDetected: wasExitPlanDetected(tab) });

  // Lock-aware capture: if already locked + content present, skip cascade.
  if (!isPlanLocked(tab) || !getPlanContent(tab)) {
    captureFromDom(tab);
  }

  const planContent = getPlanContent(tab);
  const exitPlanForce = force || wasExitPlanDetected(tab);

  // Prose-question guard (skip if forced or exit-plan detected). If the model
  // actually used OpenCode's native question flow but the sidepanel missed the
  // SSE render, the question:list backstop will surface the pending card.
  if (!exitPlanForce && looksLikeProseQuestions(planContent)) {
    trace('plan:proseDetected', { sid: tab.sessionId, reason, planLen: planContent.length, qToolUsed: wasQuestionToolUsedThisTurn(tab) });
    try { _deps.backfillPendingQuestions(tab, { reason: 'plan-terminal-prose-question' }); } catch {}
    if (!wasQuestionToolUsedThisTurn(tab)) showProseQuestionRecoveryUI(tab);
    return false;
  }

  // Min-length / structure guard.
  const realPlan = isRealPlanContent(planContent);
  if (!exitPlanForce && !realPlan && planContent.length < 40) return false;
  if (!exitPlanForce && !realPlan) {
    // Captured something but it doesn't look structured — still surface the
    // card under exit-plan force only. Bare preambles get suppressed.
    return false;
  }

  trace('plan:postUI:show', { sid: tab.sessionId, reason, planLen: planContent.length, force: exitPlanForce });
  showPostPlanUI(tab);
  clearWatchdogs(tab);
  return true;
}

export function showPostPlanUI(tab, headerText = null) {
  if (!tab) return;
  const container = _deps.panelEl('#ocp-messages');
  if (!container) return;
  removePostPlanCards(container);
  tab.showPostPlanActions = true;
  tab.postPlanHeader = headerText || tab.postPlanHeader || 'PLAN COMPLETE';
  if (typeof _deps.ensurePlanFile === 'function') _deps.ensurePlanFile(tab);
  _deps.saveTabs();
  renderPostPlanCard(container, {
    headerText: tab.postPlanHeader,
    onContinue: () => {
      tab.showPostPlanActions = false;
      _deps.saveTabs();
      _deps.setTabMode('build');
      const prompt = tab.editedPlanContent
        ? `Implement the following plan:\n\n${tab.editedPlanContent}`
        : 'The plan has been approved. Please proceed with implementation.';
      _deps.sendMessage(prompt);
    },
    onCompact: () => {
      if (tab.sessionId) _deps.compactSession(tab.sessionId);
    },
    onEditPlan: (card) => {
      if (typeof _deps.onEditPlan === 'function') _deps.onEditPlan(tab, card);
    },
    onContinuePlanning: () => {
      tab.showPostPlanActions = false;
      _deps.saveTabs();
      _deps.update();
    },
  });
}

function showProseQuestionRecoveryUI(tab) {
  const container = _deps.panelEl('#ocp-messages');
  if (!container) return;
  try {
    const pending = _deps.backfillPendingQuestions(tab, { reason: 'prose-question-recovery' });
    if (pending && typeof pending.then === 'function') {
      pending.then((found) => {
        if (found) removeProseQuestionRecoveryCards(container);
      }).catch(() => {});
    }
  } catch {}
  removePostPlanCards(container);
  removeProseQuestionRecoveryCards(container);
  renderProseQuestionRecoveryCard(container, {
    onReplyDirectly: () => {
      // Reply directly must unblock the composer — clearing showPostPlanActions
      // is defensive (the prose-recovery path never sets it, but a parallel
      // session.idle could). Without this the input stays disabled.
      tab.showPostPlanActions = false;
      removeProseQuestionRecoveryCards(container);
      const inputEl = _deps.panelEl('#ocp-input');
      if (inputEl) { try { inputEl.focus(); } catch {} }
      _deps.update();
    },
    onForceQuestionTool: () => {
      removeProseQuestionRecoveryCards(container);
      trace('plan:proseRecovery:force', { sid: tab.sessionId });
      // Hard prompt with a one-shot example so models like Kimi K2.6 can
      // pattern-match the tool-call shape. We reuse sendMessage so the turn
      // is properly tracked and the watchdog re-arms.
      _deps.sendMessage(
        'STRICT INSTRUCTION: Re-emit your previous clarifying questions ONLY by calling the `question` tool — do not write any prose this turn. ' +
        'Example shape: question({ questions: [{ question: "What scope?", options: [{ label: "Small" }, { label: "Large" }], multiSelect: false }] }). ' +
        'After the tool call, stop. Do not continue the plan until I answer.'
      );
    },
    onReAskInteractive: () => {
      removeProseQuestionRecoveryCards(container);
      trace('plan:proseRecovery:reask', { sid: tab.sessionId });
      _deps.sendMessage('Please re-ask those clarifying questions using the `question` tool so I can answer them with interactive options. Do not proceed with the plan until I answer.');
    },
    onDismiss: () => {
      tab.showPostPlanActions = false;
      removeProseQuestionRecoveryCards(container);
      _deps.update();
    },
  });
}

// --- Single tiered watchdog ---

const TIERS = [
  { name: 'silence8', delayMs: 8_000 },
  { name: 'soft60', delayMs: 60_000 },
  { name: 'hard180', delayMs: 180_000 },
  { name: 'kill480', delayMs: 480_000 },
];
const TIER_BY_NAME = Object.fromEntries(TIERS.map((t) => [t.name, t]));

/**
 * Re-arm the watchdog. Called once on plan-mode turn start, and then on
 * every event arrival to push the silence timer back to silence8. Hard cap
 * tiers (hard180/kill480) only advance when their target absolute time is
 * crossed without a terminal — they DON'T re-arm.
 *
 * Implementation: we keep the absolute time when the turn started in
 * `_planTurnStartedAt`, and the absolute time of the last event in
 * `_planWatchdogLastEventAt`. The watchdog tick recomputes the next firing
 * tier from these timestamps so re-arm logic is just timestamp updates,
 * not clearTimeout/setTimeout chains.
 */
export function armWatchdog(tab) {
  if (!tab || tab.mode !== 'plan') return;
  attachStateFields(tab);
  const now = Date.now();
  if (!tab._planTurnStartedAt) tab._planTurnStartedAt = now;
  tab._planWatchdogLastEventAt = now;
  scheduleNextWatchdogTick(tab);
}

export function clearWatchdogs(tab) {
  if (!tab) return;
  if (tab._planWatchdogId) {
    clearTimeout(tab._planWatchdogId);
    tab._planWatchdogId = null;
  }
  tab._planWatchdogTier = null;
  tab._planWatchdogLastEventAt = 0;
  tab._planTurnStartedAt = 0;
  if (tab._planStallSoftCardOpen) {
    const container = _deps.panelEl('#ocp-messages');
    if (container) { try { removePlanStallSoftCards(container); } catch {} }
    tab._planStallSoftCardOpen = false;
  }
}

function scheduleNextWatchdogTick(tab) {
  if (!tab || tab.mode !== 'plan') return;
  if (tab.showPostPlanActions) { clearWatchdogs(tab); return; }
  if (_deps.hasActiveQuestion(tab) || _deps.activePermissionId(tab)) {
    // Suppressed — don't fire while user input is pending.
    if (tab._planWatchdogId) clearTimeout(tab._planWatchdogId);
    tab._planWatchdogId = setTimeout(() => scheduleNextWatchdogTick(tab), 5000);
    return;
  }
  const now = Date.now();
  const sinceLastEvent = now - (tab._planWatchdogLastEventAt || now);
  const sinceStart = now - (tab._planTurnStartedAt || now);

  // Determine the next tier to fire.
  let nextTier = null;
  let nextDelayMs = 0;
  for (const tier of TIERS) {
    // hard180/kill480 measure from start; silence8/soft60 measure from last event.
    const measure = (tier.name === 'hard180' || tier.name === 'kill480') ? sinceStart : sinceLastEvent;
    if (measure >= tier.delayMs) continue;
    nextTier = tier;
    nextDelayMs = tier.delayMs - measure;
    break;
  }
  if (tab._planWatchdogId) clearTimeout(tab._planWatchdogId);
  if (!nextTier) {
    // All tiers passed — kill480 fires immediately.
    fireWatchdog(tab, 'kill480');
    return;
  }
  tab._planWatchdogTier = nextTier.name;
  tab._planWatchdogId = setTimeout(() => {
    tab._planWatchdogId = null;
    fireWatchdog(tab, nextTier.name);
  }, Math.max(50, nextDelayMs));
}

function fireWatchdog(tab, tierName) {
  if (!tab || tab.mode !== 'plan' || tab.showPostPlanActions) return;
  if (_deps.hasActiveQuestion(tab) || _deps.activePermissionId(tab)) {
    scheduleNextWatchdogTick(tab);
    return;
  }
  const tier = TIER_BY_NAME[tierName] || { name: tierName };
  const sinceStart = Date.now() - (tab._planTurnStartedAt || Date.now());
  trace('plan:watchdog:fire', { sid: tab.sessionId, tier: tier.name, sinceStartMs: sinceStart });
  console.warn(`[ocp-plan] watchdog fired tier=${tier.name}`);

  if (tier.name === 'silence8') {
    // Soft: try to terminal the turn with whatever's captured.
    onTurnTerminal(tab, 'watchdog:silence8', { force: wasExitPlanDetected(tab) });
    scheduleNextWatchdogTick(tab);
    return;
  }
  if (tier.name === 'soft60') {
    showSoftStallPrompt(tab);
    scheduleNextWatchdogTick(tab);
    return;
  }
  if (tier.name === 'hard180') {
    runStallRecovery(tab, 'hard180');
    return;
  }
  if (tier.name === 'kill480') {
    runStallRecovery(tab, 'kill480');
    return;
  }
}

function showSoftStallPrompt(tab) {
  const container = _deps.panelEl('#ocp-messages');
  if (!container) return;
  if (tab._planStallSoftCardOpen) return;
  tab._planStallSoftCardOpen = true;
  try { removeThinking(container); } catch {}
  renderPlanStallSoftCard(container, {
    onAbort: () => {
      tab._planStallSoftCardOpen = false;
      try { removePlanStallSoftCards(container); } catch {}
      runStallRecovery(tab, 'soft-abort');
    },
    onWait: () => {
      tab._planStallSoftCardOpen = false;
      try { removePlanStallSoftCards(container); } catch {}
      tab._planWatchdogLastEventAt = Date.now();
      scheduleNextWatchdogTick(tab);
      _deps.update();
    },
    onCancel: () => {
      tab._planStallSoftCardOpen = false;
      try { removePlanStallSoftCards(container); } catch {}
      _deps.abortTab(tab, container);
      _deps.update();
    },
  });
  _deps.update();
}

function runStallRecovery(tab, reason) {
  if (!tab || tab.mode !== 'plan' || tab.showPostPlanActions) return;
  clearWatchdogs(tab);
  try { captureFromDom(tab); } catch {}
  console.log(`[ocp-plan] plan-stall recovery (${reason}): captured ${getPlanContent(tab).length} chars`);

  const live = _deps.panelEl('#ocp-messages');
  if (live) {
    try { removeThinking(live); } catch {}
    try { _deps.finalizeStreamingMessage(live); } catch {}
    try { _deps.settleRunningToolCards(live, 'complete'); } catch {}
  }

  if (tab.sessionId) {
    try { _deps.abortTab(tab, live); } catch {}
  }

  tab.running = false;
  tab.turnStartedAt = 0;
  _deps.endTurn(tab, `watchdog:${reason}`);
  _deps.setTurnStatus(tab);

  const realPlan = isRealPlanContent(getPlanContent(tab));
  onTurnTerminal(tab, `watchdog:${reason}`, {
    force: wasExitPlanDetected(tab) || realPlan,
  });
  try { _deps.notifyOpenCodeOutcome('done', tab, tab.sessionId || tab.id); } catch {}
  _deps.update();
}

// --- Event hooks (called on every SDK event by ocp-events.js) ---

/** Called on EVERY SDK event arrival in plan mode — re-arms the watchdog. */
export function noteEventArrival(tab) {
  if (!tab || tab.mode !== 'plan') return;
  if (tab.showPostPlanActions) return;
  tab._planWatchdogLastEventAt = Date.now();
  scheduleNextWatchdogTick(tab);
}

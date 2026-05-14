/**
 * AskUserQuestion / permission-card queue and render lifecycle.
 *
 * Lifted from ocp-tabs.js (470-552, 1598-1622, 3127-3393) with deps
 * injected so this module imports nothing from the slim controller.
 *
 * Single responsibility: serialize question+permission cards so two
 * tools firing in the same turn don't race the user. The queue itself
 * lives on the tab object (tab._questionQueue, tab._activeQuestionToolId),
 * matching the existing wire format so the migration is transparent.
 */

import { attachStateFields } from './ocp-state.js';
import {
  removeThinking,
  removeProseQuestionRecoveryCards,
  renderQuestionCard,
  lockQuestionCard,
} from './ocp-render.js';
import { TOOL_ICONS } from './ocp-icons.js';
import { trace, traceTimer } from './ocp-trace.js';

const _deps = {
  requestWs: () => Promise.reject(new Error('ocp-questions not configured')),
  sendMessage: () => Promise.resolve(),
  panelEl: () => null,
  getActiveTab: () => null,
  setTurnStatus: () => {},
  tabStatusDetail: () => '',
  thinkingActivity: () => ({}),
  showThinking: () => {},
  ensureNotifState: () => null,
  notifyOpenCode: () => {},
  endTurn: () => {},
  update: () => {},
  renderErrorMessage: () => {},
  escHtml: (s) => String(s ?? ''),
  NOTIF_TYPE: { ASK: 'ask' },
};

export function configure(deps = {}) {
  Object.assign(_deps, deps);
}

// --- Queue primitives ---

export function activeQuestionToolId(tab) {
  return tab ? (tab._activeQuestionToolId || null) : null;
}

export function setActiveQuestionToolId(tab, toolId) {
  if (!tab) return;
  tab._activeQuestionToolId = toolId || null;
  if (!toolId) tab._activeQuestionEvent = null;
}

export function tabQuestionQueue(tab) {
  if (!tab) return [];
  if (!Array.isArray(tab._questionQueue)) tab._questionQueue = [];
  return tab._questionQueue;
}

export function hasActiveQuestion(tab) {
  return activeQuestionToolId(tab) !== null;
}

export function queueQuestion(tab, event) {
  attachStateFields(tab);
  const reqId = event?.reqId || event?.requestID || event?.event?.id || event?.event?.requestID || '';
  if (reqId && hasQueuedQuestion(tab, reqId)) return;
  tabQuestionQueue(tab).push(event);
}

export function hasQueuedQuestion(tab, requestID) {
  if (!tab || !requestID) return false;
  const req = String(requestID);
  return tabQuestionQueue(tab).some((entry) => {
    const id = entry?.reqId || entry?.requestID || entry?.event?.id || entry?.event?.requestID || '';
    return String(id || '') === req;
  });
}

export function dequeueNextQuestion(tab) {
  const q = tabQuestionQueue(tab);
  if (q.length === 0) {
    setActiveQuestionToolId(tab, null);
    return null;
  }
  return q.shift();
}

export function clearQuestionQueue(tab) {
  if (!tab) return;
  tab._questionQueue = [];
  tab._activeQuestionToolId = null;
  tab._activeQuestionEvent = null;
  clearQuestionListBackstop(tab);
}

// --- Permission state ---

export function activePermissionId(tab) {
  return tab ? (tab._activePermissionId || null) : null;
}

export function setActivePermissionId(tab, permId) {
  if (tab) tab._activePermissionId = permId || null;
}

// --- Reply payload builders ---

/**
 * Convert {questionText: answerString} or string into OpenCode's
 * `{ answers: string[][] }` shape with one string[] per question.
 */
export function buildQuestionReplyPayload(questions, answers) {
  const asArray = (val) => {
    if (val == null) return [];
    if (Array.isArray(val)) return val.map((entry) => String(entry).trim()).filter(Boolean);
    const text = String(val).trim();
    return text ? [text] : [];
  };
  if (typeof answers === 'string') {
    const list = [asArray(answers)];
    while (list.length < questions.length) list.push([]);
    return { answers: list };
  }
  if (answers && typeof answers === 'object') {
    return {
      answers: questions.map((q, idx) => {
        const key = q.id || q.question || q.header || `question_${idx}`;
        const v = answers[key] ?? answers[q.question] ?? answers[q.header] ?? answers[q.id] ?? answers[`question_${idx}`] ?? '';
        return asArray(v);
      }),
    };
  }
  return { answers: questions.map(() => []) };
}

export function buildAnswerSyntheticMessage(questions, answers) {
  const fmt = (v) => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean).join(', ') : String(v ?? '').trim();
  if (typeof answers === 'string') return answers.trim();
  if (!answers || typeof answers !== 'object') return '';
  const entries = Object.entries(answers).filter(([, v]) => fmt(v));
  if (entries.length === 0) return '';
  if (entries.length === 1) return fmt(entries[0][1]);
  const lines = entries.map(([q, a]) => `- ${q}: ${fmt(a)}`);
  return `Here are my answers:\n${lines.join('\n')}`;
}

// --- Queue processing ---

/**
 * Pull the next queued question and render it. Called after the user
 * answers the active card (sendMessage resolves) — chains through the
 * queue until empty.
 *
 * Two queued shapes coexist: native `question.asked` SSE events
 * (`{ eventType, event, reqId }`) and legacy tool-based questions
 * (`{ toolName, toolInput, toolId }`). Match the original ocp-tabs.js
 * flow byte-for-byte.
 */
export function processQuestionQueue(tab, container) {
  const next = dequeueNextQuestion(tab);
  if (!next) return;

  // Native question.asked path.
  if (next.eventType === 'question.asked' && next.event && next.reqId) {
    renderOpencodeQuestion(tab, container, next.event, next.reqId);
    return;
  }

  // Legacy tool-based path.
  const { toolName, toolInput, toolId } = next;
  if (!toolId) return;
  setActiveQuestionToolId(tab, toolId);
  removeThinking(container);
  renderQuestionCard(container, toolName, toolInput, toolId, {
    onAnswer: (answers) => {
      lockQuestionCard(container, toolId);
      _replyAfterAnswer(tab, container, answers);
    },
  });
  _deps.setTurnStatus(tab, 'Waiting for input…', 'Question');
  const notifState = _deps.ensureNotifState(tab);
  const questionKey = String(toolId || `${toolName}:${tab.sessionId || tab.id}`);
  if (notifState && !notifState.questionIds.has(questionKey)) {
    notifState.questionIds.add(questionKey);
    _deps.notifyOpenCode(_deps.NOTIF_TYPE.ASK, tab);
  }
  _deps.update();
}

function _replyAfterAnswer(tab, container, answers) {
  const sendOpts = { force: true, clearQueue: false };
  if (typeof answers === 'string') {
    _deps.sendMessage(answers, sendOpts).then(() => processQuestionQueue(tab, container));
    return;
  }
  if (answers && typeof answers === 'object') {
    const entries = Object.entries(answers);
    if (entries.length === 1) {
      _deps.sendMessage(entries[0][1], sendOpts).then(() => processQuestionQueue(tab, container));
    } else {
      const lines = entries.map(([q, a]) => `- ${q}: ${a}`);
      _deps.sendMessage(`Here are my answers:\n${lines.join('\n')}`, sendOpts)
        .then(() => processQuestionQueue(tab, container));
    }
  }
}

// --- Native question.asked render ---

export function renderOpencodeQuestion(tab, container, event, requestID) {
  if (!tab || !container || !requestID) return;
  const existing = container.querySelector(`.ocp-question-card[data-tool-id="${CSS.escape(String(requestID))}"]`);
  if (existing) {
    setActiveQuestionToolId(tab, requestID);
    tab._activeQuestionEvent = { eventType: 'question.asked', event, reqId: requestID };
    return;
  }
  setActiveQuestionToolId(tab, requestID);
  tab._activeQuestionEvent = { eventType: 'question.asked', event, reqId: requestID };
  const questions = Array.isArray(event.questions) ? event.questions : [event];
  const toolInput = { questions };

  removeProseQuestionRecoveryCards(container);
  removeThinking(container);
  trace('q:render:start', { sid: tab.sessionId, reqId: requestID, count: questions.length });
  renderQuestionCard(container, 'question', toolInput, requestID, {
    onAnswer: (answers) => {
      lockQuestionCard(container, requestID);
      const payload = buildQuestionReplyPayload(questions, answers);
      const endTimer = traceTimer('q:reply', { sid: tab.sessionId, reqId: requestID });
      _deps.requestWs('question:reply', { requestID, body: payload }, 15000)
        .then((resp) => {
          endTimer({ status: resp?.status || 200 });
          if (activeQuestionToolId(tab) === requestID) {
            setActiveQuestionToolId(tab, null);
          }
          if (!resp?.status || resp.status < 400) {
            trace('q:reply:ok', { sid: tab.sessionId, reqId: requestID });
            _deps.setTurnStatus(tab, 'Thinking…', _deps.tabStatusDetail(tab));
            _deps.showThinking(container, {
              title: 'Thinking…',
              detail: _deps.tabStatusDetail(tab),
              startedAt: Date.now(),
              waiting: true,
              ..._deps.thinkingActivity(tab),
            });
            processQuestionQueue(tab, container);
            _deps.update();
          }
          if (resp?.status && resp.status >= 400) {
            const body = resp.data?.error || resp.data?.message || `HTTP ${resp.status}`;
            trace('q:reply:rejected', { sid: tab.sessionId, reqId: requestID, status: resp.status, err: body });
            _deps.renderErrorMessage(container, `Question reply rejected: ${body}. Try sending a regular message to retry.`);
          }
        })
        .catch((err) => {
          endTimer({ err: err?.message || String(err) });
          // CRITICAL: do NOT terminal the turn on reply error. The card stays
          // editable, the user can press the answer button again, and the
          // running session continues. This was the "fetch failed → frozen UI"
          // symptom: the previous catch flipped tab.running=false and ended
          // the turn even when the SDK retry would have succeeded.
          trace('q:reply:fail', { sid: tab.sessionId, reqId: requestID, err: err?.message || String(err) });
          console.error('[ocp-questions] question:reply failed:', err);
          // Re-enable the card so the user can retry without re-typing.
          const cardEl = container.querySelector(`.ocp-question-card[data-tool-id="${CSS.escape(String(requestID))}"]`);
          if (cardEl) {
            cardEl.dataset.locked = '';
            cardEl.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          }
          _deps.renderErrorMessage(container, `Question reply failed: ${err?.message || err}. Click an answer again to retry.`);
        });
    },
  });
  _deps.setTurnStatus(tab, 'Waiting for input…', 'Question');
  const notifState = _deps.ensureNotifState(tab);
  if (notifState && !notifState.questionIds.has(requestID)) {
    notifState.questionIds.add(requestID);
    _deps.notifyOpenCode(_deps.NOTIF_TYPE.ASK, tab);
  }
  _deps.update();
}

export function handleQuestionResolved(tab, container, requestID) {
  if (!tab) return;
  const reqId = String(requestID || '');
  if (reqId && container) lockQuestionCard(container, reqId);
  if (!reqId || activeQuestionToolId(tab) === reqId) {
    setActiveQuestionToolId(tab, null);
  }
  if (reqId && tab._activeQuestionEvent?.reqId === reqId) {
    tab._activeQuestionEvent = null;
  }
  if (container && !hasActiveQuestion(tab)) {
    processQuestionQueue(tab, container);
  }
  _deps.update();
}

export function ensurePendingQuestionVisible(tab, container) {
  if (!tab || !container) return false;
  const activeId = activeQuestionToolId(tab);
  if (activeId && tab._activeQuestionEvent) {
    const selector = `.ocp-question-card[data-tool-id="${CSS.escape(String(activeId))}"]`;
    if (!container.querySelector(selector)) {
      renderOpencodeQuestion(tab, container, tab._activeQuestionEvent.event, tab._activeQuestionEvent.reqId);
      return true;
    }
  }
  if (!activeId && tabQuestionQueue(tab).length) {
    processQuestionQueue(tab, container);
    return true;
  }
  return false;
}

export function scheduleQuestionListBackstop(tab, { delayMs = 700, reason = '' } = {}) {
  if (!tab?.sessionId) return;
  clearQuestionListBackstop(tab);
  tab._questionListBackstopId = setTimeout(() => {
    tab._questionListBackstopId = null;
    backfillPendingQuestions(tab, { reason }).catch((err) => {
      console.warn('[ocp-questions] question:list backstop failed:', err?.message || err);
    });
  }, Math.max(0, delayMs));
}

// ── Plan-turn question:list poll fallback ──
//
// Some OpenCode SDK versions drop the `question.asked` SSE event mid-turn,
// even though `question.list()` still returns the pending request. Poll every
// QUESTION_POLL_INTERVAL_MS while a plan turn is active and no question card
// is visible — the first hit calls `backfillPendingQuestions` which renders
// or queues the card. Stops automatically when the turn ends or a card lands.

const QUESTION_POLL_INTERVAL_MS = 2500;

export function startQuestionPolling(tab) {
  if (!tab) return;
  if (tab._questionPollId) return;
  trace('q:poll:start', { sid: tab.sessionId });
  const tick = async () => {
    if (!tab._questionPollId) return; // stopped
    if (!tab.running || tab.mode !== 'plan' || tab.showPostPlanActions) {
      stopQuestionPolling(tab);
      return;
    }
    if (hasActiveQuestion(tab)) {
      // Card already visible — no need to poll.
      tab._questionPollId = setTimeout(tick, QUESTION_POLL_INTERVAL_MS);
      return;
    }
    try {
      const found = await backfillPendingQuestions(tab, { reason: 'plan-poll' });
      if (found) trace('q:poll:hit', { sid: tab.sessionId });
    } catch (err) {
      trace('q:poll:err', { sid: tab.sessionId, err: err?.message || String(err) });
    }
    if (tab._questionPollId) {
      tab._questionPollId = setTimeout(tick, QUESTION_POLL_INTERVAL_MS);
    }
  };
  tab._questionPollId = setTimeout(tick, QUESTION_POLL_INTERVAL_MS);
}

export function stopQuestionPolling(tab) {
  if (!tab) return;
  if (tab._questionPollId) {
    clearTimeout(tab._questionPollId);
    tab._questionPollId = null;
    trace('q:poll:stop', { sid: tab.sessionId });
  }
}

export function clearQuestionListBackstop(tab) {
  if (tab?._questionListBackstopId) {
    clearTimeout(tab._questionListBackstopId);
    tab._questionListBackstopId = null;
  }
}

export async function backfillPendingQuestions(tab, { reason = '' } = {}) {
  if (!tab?.sessionId) return false;
  trace('q:list:start', { sid: tab.sessionId, reason });
  const resp = await _deps.requestWs('question:list', {}, 10000);
  const pending = normalizePendingQuestionList(resp?.data)
    .filter((request) => String(request.sessionID || request.sessionId || '') === String(tab.sessionId));
  trace('q:list:result', { sid: tab.sessionId, reason, total: normalizePendingQuestionList(resp?.data).length, mineCount: pending.length });
  if (!pending.length) return false;

  let surfaced = false;
  const activeTab = _deps.getActiveTab();
  const container = activeTab === tab ? _deps.panelEl('#ocp-messages') : null;
  for (const request of pending) {
    const reqId = request.id || request.requestID || '';
    if (!reqId) continue;
    if (activeQuestionToolId(tab) === reqId) {
      ensurePendingQuestionVisible(tab, container);
      continue;
    }
    if (hasQueuedQuestion(tab, reqId)) continue;
    if (activeQuestionToolId(tab) || !container) {
      queueQuestion(tab, { eventType: 'question.asked', event: request, reqId });
      notifyQueuedQuestion(tab, reqId);
      surfaced = true;
      continue;
    }
    renderOpencodeQuestion(tab, container, request, reqId);
    surfaced = true;
  }
  if (surfaced) {
    console.log(`[ocp-questions] surfaced pending question via question:list${reason ? ` (${reason})` : ''}`);
    _deps.update();
  }
  return surfaced;
}

function normalizePendingQuestionList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.questions)) return data.questions;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function notifyQueuedQuestion(tab, requestID) {
  const notifState = _deps.ensureNotifState(tab);
  if (notifState && !notifState.questionIds.has(requestID)) {
    notifState.questionIds.add(requestID);
    _deps.notifyOpenCode(_deps.NOTIF_TYPE.ASK, tab);
  }
}

// --- Permission cards ---

export function renderOpencodePermission(tab, container, event, permissionID) {
  trace('perm:render', { sid: tab?.sessionId, permId: permissionID, type: event?.permission?.permission || event?.permission || event?.type });
  setActivePermissionId(tab, permissionID);
  const sessionID = event.sessionID || event.sessionId || tab?.sessionId || '';

  const perm = (event.permission && typeof event.permission === 'object') ? event.permission : event;
  const permType = String(perm.permission || perm.type || '').toLowerCase();
  const patterns = Array.isArray(perm.patterns) ? perm.patterns.filter(Boolean) : (perm.pattern ? [perm.pattern] : []);
  const metadata = (perm.metadata && typeof perm.metadata === 'object') ? perm.metadata : {};
  const callID = perm.tool?.callID || perm.tool?.callId || '';

  const info = describePermission(permType, patterns, metadata, callID, container);

  removeThinking(container);

  const card = document.createElement('div');
  card.className = 'ocp-permission-card';
  card.dataset.permissionId = permissionID;

  const esc = _deps.escHtml;
  const targetHtml = info.target
    ? `<div class="ocp-permission-target"><code>${esc(info.target)}</code></div>`
    : '';
  const patternsHtml = (info.patternsOut && info.patternsOut.length)
    ? `<div class="ocp-permission-patterns"><span class="ocp-permission-patterns-label">Matches</span>${info.patternsOut.map(p => `<code>${esc(p)}</code>`).join('')}</div>`
    : '';
  const diffHtml = info.diff
    ? `<details class="ocp-permission-diff"><summary>Show diff</summary><pre>${esc(info.diff)}</pre></details>`
    : '';

  card.innerHTML = `
    <div class="ocp-permission-head">
      <span class="ocp-permission-icon">${info.icon}</span>
      <span class="ocp-permission-head-text">
        <span class="ocp-permission-kind">${esc(info.kind)}</span>
        <span class="ocp-permission-action">${esc(info.action)}</span>
      </span>
    </div>
    <div class="ocp-permission-body">
      ${targetHtml}
      ${patternsHtml}
      ${diffHtml}
      <div class="ocp-permission-actions">
        <button class="ocp-permission-btn ocp-permission-allow" data-response="once">Allow once</button>
        <button class="ocp-permission-btn ocp-permission-always" data-response="always">Always allow</button>
        <button class="ocp-permission-btn ocp-permission-reject" data-response="reject">Reject</button>
      </div>
    </div>
  `;

  const respond = (response) => {
    if (card.dataset.locked === '1') return;
    card.dataset.locked = '1';
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const endTimer = traceTimer('perm:respond', { sid: sessionID, permId: permissionID, response });
    _deps.requestWs('permission:respond', { sessionID, permissionID, response }, 15000)
      .then((resp) => {
        endTimer({ status: resp?.status || 200 });
        if (activePermissionId(tab) === permissionID) setActivePermissionId(tab, null);
        if (!resp?.status || resp.status < 400) {
          _deps.setTurnStatus(tab, 'Thinking…', _deps.tabStatusDetail(tab));
          _deps.showThinking(container, {
            title: 'Thinking…',
            detail: _deps.tabStatusDetail(tab),
            startedAt: Date.now(),
            waiting: true,
            ..._deps.thinkingActivity(tab),
          });
        }
      })
      .catch((err) => {
        endTimer({ err: err?.message || String(err) });
        trace('perm:respond:fail', { sid: sessionID, permId: permissionID, err: err?.message || String(err) });
        console.error('[ocp-questions] permission:respond failed:', err);
        card.dataset.locked = '';
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      });
  };

  card.querySelectorAll('button[data-response]').forEach(btn => {
    btn.addEventListener('click', () => respond(btn.dataset.response));
  });

  container.appendChild(card);
  _deps.setTurnStatus(tab, 'Waiting for permission…', `${info.kind}: ${info.action}`);
  const notifState = _deps.ensureNotifState(tab);
  if (notifState && !notifState.questionIds.has(`perm:${permissionID}`)) {
    notifState.questionIds.add(`perm:${permissionID}`);
    _deps.notifyOpenCode(_deps.NOTIF_TYPE.ASK, tab);
  }
  _deps.update();
}

function describePermission(permType, patterns, metadata, callID, container) {
  const firstPattern = patterns[0] || '';
  const diff = typeof metadata.diff === 'string' ? metadata.diff : '';
  const icons = {
    bash: TOOL_ICONS.bash,
    edit: TOOL_ICONS.edit,
    write: TOOL_ICONS.write,
    read: TOOL_ICONS.read,
    webfetch: TOOL_ICONS.fetch,
    fetch: TOOL_ICONS.fetch,
  };
  const fallbackIcon = `<svg viewBox="0 0 24 24"><path d="M12 2L2 7v6c0 5 4 9 10 11 6-2 10-6 10-11V7l-10-5z"/></svg>`;
  const icon = icons[permType] || fallbackIcon;

  if (permType === 'bash') {
    const cmd = readToolCommand(container, callID) || firstPattern || '';
    return {
      icon, kind: 'Run command', action: 'Execute shell command',
      target: cmd,
      patternsOut: patterns.length && patterns[0] !== cmd ? patterns : [],
      diff: '',
    };
  }
  if (permType === 'edit') {
    const fp = metadata.filepath || metadata.filePath || metadata.file_path || firstPattern || '';
    return {
      icon, kind: 'Edit file', action: patterns.length > 1 ? `Modify ${patterns.length} files` : 'Modify file',
      target: fp,
      patternsOut: patterns.length > 1 ? patterns : [],
      diff,
    };
  }
  if (permType === 'write') {
    const fp = metadata.filepath || metadata.filePath || firstPattern || '';
    return { icon, kind: 'Write file', action: 'Create or overwrite file', target: fp, patternsOut: [], diff };
  }
  if (permType === 'read') {
    const fp = metadata.filepath || metadata.filePath || firstPattern || '';
    return { icon, kind: 'Read file', action: 'Access file contents', target: fp, patternsOut: [], diff: '' };
  }
  if (permType === 'webfetch' || permType === 'fetch') {
    const url = metadata.url || firstPattern || '';
    return { icon, kind: 'Fetch URL', action: 'Make a web request', target: url, patternsOut: [], diff: '' };
  }
  const kind = permType ? permType.charAt(0).toUpperCase() + permType.slice(1) : 'Tool';
  return {
    icon, kind, action: 'Requires your approval',
    target: firstPattern,
    patternsOut: patterns.length > 1 ? patterns.slice(1) : [],
    diff: '',
  };
}

function readToolCommand(container, callID) {
  if (!container || !callID) return '';
  const cards = container.querySelectorAll('.ocp-tool-card');
  for (const card of cards) {
    if (card.dataset.toolId !== callID) continue;
    const args = card.querySelector('.ocp-tool-args');
    if (args && args.textContent) {
      try {
        const parsed = JSON.parse(args.textContent);
        if (parsed?.command) return String(parsed.command);
      } catch { /* not JSON */ }
      return args.textContent.trim();
    }
    const summary = card.querySelector('.ocp-tool-summary');
    if (summary && summary.textContent) return summary.textContent.trim();
  }
  return '';
}

export function lockPermissionCard(container, permissionID) {
  const card = container.querySelector(`.ocp-permission-card[data-permission-id="${CSS.escape(String(permissionID))}"]`);
  if (!card) return;
  card.dataset.locked = '1';
  card.querySelectorAll('button').forEach(b => { b.disabled = true; });
}

// --- Reply watchdog (currently a no-op — preserved for API parity) ---

export function scheduleQuestionReplyWatchdog(_tab, _syntheticMessage) {
  // Intentional no-op. The original watchdog was disabled because the
  // synthetic auto-resend created a recovery cascade that trapped the
  // user behind a fake PLAN COMPLETE card. Server-side auto-abort
  // handles real stalls.
}

export function clearQuestionReplyWatchdog(tab) {
  if (tab?._questionReplyWatchdogId) {
    clearTimeout(tab._questionReplyWatchdogId);
    tab._questionReplyWatchdogId = null;
  }
  if (tab) tab._questionReplyAnswerSnapshot = null;
}

// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel: Tab System + Session Management
// Multi-tab with per-tab session isolation, provider/model management
// ═══════════════════════════════════════════

import { requestWs, sendWs, onWsMessage, rejectPending } from './ocp-ws.js';
import { fetchBlobNamespace, putBlob, deleteBlob } from '../blob-store.js';
import {
  renderHistory, renderEmptyState, renderUserPayload,
  renderAssistantPayload, renderAssistantMessage,
  appendStreamChunk, appendThinkChunk, finalizeStreamingMessage,
  setStreamRawText, setStreamThinkText,
  showThinking, updateThinking, removeThinking, repositionThinking, bumpThinkingActivity,
  renderToolCard, updateToolCard, renderErrorMessage,
  isQuestionTool, renderQuestionCard, lockQuestionCard,
  renderPostPlanCard, removePostPlanCards,
  renderProseQuestionRecoveryCard, removeProseQuestionRecoveryCards,
  renderPlanStallSoftCard, removePlanStallSoftCards,
  describeTool,
} from './ocp-render.js';
import { ICON_X, TOOL_ICONS } from './ocp-icons.js';
import { storage } from '../storage.js';
import { notify, NOTIF_TYPE } from '../ui-notifications.js';
import * as planModule from './ocp-plan.js';
import * as streamModule from './ocp-stream.js';
import * as questionsModule from './ocp-questions.js';
import * as sendModule from './ocp-send.js';
import * as eventsModule from './ocp-events.js';
import { trace as _trace, setTraceContext as _setTraceContext } from './ocp-trace.js';

// Browser-tab visibility / focus diagnostics. Streaming pauses are typically
// caused by browser throttling background-tab setTimeouts to 1Hz — we log
// every visibility transition so the trace correlates pauses with hidden=true.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    try { _trace('doc:visibility', { hidden: document.hidden, state: document.visibilityState }); } catch {}
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => { try { _trace('win:focus', {}); } catch {} });
  window.addEventListener('blur', () => { try { _trace('win:blur', {}); } catch {} });
}
import {
  attachStateFields as _attachState,
  setExitPlanDetected as _setExitPlanDetected,
  setQuestionToolUsedThisTurn as _setQuestionToolUsedThisTurn,
  setPlanContent as _setPlanContent,
  lockPlanContent as _lockPlanContent,
  recordEvent as _recordEvent,
} from './ocp-state.js';

const MAX_TABS = 10;

/** Convert "provider/model" string → { providerID, modelID } object for the OpenCode API. */
function modelObj(modelStr) {
  if (!modelStr) return undefined;
  const idx = modelStr.indexOf('/');
  if (idx < 0) return { providerID: modelStr, modelID: modelStr };
  return { providerID: modelStr.slice(0, idx), modelID: modelStr.slice(idx + 1) };
}
const OPENCODE_ICON = '<svg viewBox="0 0 24 30" fill="currentColor"><path d="M18 6H6V24H18V6ZM24 30H0V0H24V30Z"/></svg>';

const _windowId = sessionStorage.getItem('ocp-window-id') || (() => {
  const id = crypto.randomUUID();
  sessionStorage.setItem('ocp-window-id', id);
  return id;
})();

export const STOR = {
  tabs:     `synabun-ocp-tabs-${_windowId}`,
  mode:     'synabun-ocp-mode',
  model:    'synabun-ocp-model',
  agent:    'synabun-ocp-agent',
  project:  'synabun-ocp-project',
  activity: 'synabun-ocp-activity-open',
  sessionSnapshots: 'synabun-ocp-session-snapshots', // global, per-sessionId rendered HTML cache
  windowRegistry: 'synabun-ocp-windows',             // JSON map of windowId → lastSeen — used by stale-window GC
};

const OCP_STALE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — matches Claude registry

// ── Window registry: tracks active windows for stale-key cleanup ──
function _updateOcpWindowRegistry() {
  try {
    const raw = storage.getItem(STOR.windowRegistry);
    const reg = raw ? JSON.parse(raw) : {};
    reg[_windowId] = Date.now();
    storage.setItem(STOR.windowRegistry, JSON.stringify(reg));
  } catch {}
}

function _cleanStaleOcpWindows() {
  try {
    const raw = storage.getItem(STOR.windowRegistry);
    if (!raw) return;
    const reg = JSON.parse(raw);
    const now = Date.now();
    let mutated = false;
    for (const [wid, ts] of Object.entries(reg)) {
      if (wid === _windowId) continue;
      if (now - ts > OCP_STALE_WINDOW_MS) {
        storage.removeItem(`synabun-ocp-tabs-${wid}`);
        delete reg[wid];
        mutated = true;
      }
    }
    // Also drop tabs entries whose windowId isn't in the registry at all
    // (covers legacy entries created before the registry existed).
    for (const k of (storage.keys?.() || [])) {
      if (!k.startsWith('synabun-ocp-tabs-')) continue;
      const wid = k.slice('synabun-ocp-tabs-'.length);
      if (wid === _windowId) continue;
      if (!(wid in reg)) {
        storage.removeItem(k);
        mutated = true;
      }
    }
    if (mutated) storage.setItem(STOR.windowRegistry, JSON.stringify(reg));
  } catch {}
}

_cleanStaleOcpWindows();
_updateOcpWindowRegistry();

// ── Session HTML snapshot cache ──
// Mirrors the Codex/Claude snapshot pattern: every render fills a per-session
// HTML cache so a fresh browser load can blit the exact transcript back into
// the DOM instead of rebuilding from upstream `messages:list`, which loses
// streaming state, MCP card formatting, and intermediate UI cards.
const MAX_OCP_SESSION_SNAPSHOTS = 24;
const MAX_OCP_SESSION_SNAPSHOT_CHARS = 2_500_000;
// Snapshots live in the per-entry blob store (see blob-store.js); hydration is
// async and a pre-hydration miss falls back to the upstream messages rebuild.
let _sessionSnapshots = {};
const _snapshotsReady = fetchBlobNamespace('ocp-snapshots')
  .then((map) => {
    _sessionSnapshots = { ...map, ..._sessionSnapshots };
    try { if (storage.getItem('synabun-ocp-session-snapshots')) storage.removeItem('synabun-ocp-session-snapshots'); } catch {}
  })
  .catch(() => {});
let _snapshotObserver = null;
let _snapshotObserverContainer = null;
let _snapshotDebounceTimer = null;
let _snapshotRestoring = false;

const ACTIVITY_MAX = 500;

function ensureNotifState(tab) {
  if (!tab) return null;
  if (!tab._notifState) {
    tab._notifState = {
      outcomeKey: '',
      questionIds: new Set(),
    };
  }
  return tab._notifState;
}

function resetTurnNotif(tab) {
  const state = ensureNotifState(tab);
  if (state) state.outcomeKey = '';
}

function notifyOpenCode(type, tab, extra = {}) {
  if (!tab) return false;
  notify('panel', type, tab.sessionTitle || 'OpenCode', {
    panel: 'opencode',
    provider: 'opencode',
    tabId: tab.id,
    ...extra,
  });
  return true;
}

function notifyOpenCodeOutcome(type, tab, key = tab?.sessionId || tab?.id || 'turn') {
  const state = ensureNotifState(tab);
  if (!state) return false;
  if (state.outcomeKey === type || state.outcomeKey === NOTIF_TYPE.ERROR) return false;
  state.outcomeKey = type;
  return notifyOpenCode(type, tab);
}

const DEFAULT_MODE = 'build';
const MODE_LABELS = {
  chat: 'Chat',
  build: 'Build',
  plan: 'Plan',
};

// ── State ──

let _tabs = [];
let _activeTabIdx = -1;
let _providers = [];
let _connectedProviders = new Set();
let _agents = [];
let _primaryAgents = new Set();
let _sessions = [];
const _userMsgIds = new Set(); // track user messageIDs to filter echoed SSE events
const _partTypes = new Map(); // track partID → type (reasoning/text) from part.updated events
const _renderedAssistantMsgIds = new Set(); // prevents double-render when message.updated re-fires after finalize (Windows timing)
let _activeSendRequestId = null; // WS request id of the in-flight message:send (for abort cancellation)
let _renderSeq = 0; // guard against stale async renders overwriting fresh ones
// Question / permission gating is per-tab so concurrent OpenCode sessions don't
// hijack each other's UX. Each tab owns: tab._activeQuestionToolId,
// tab._questionQueue, tab._activePermissionId. Helpers read/write through the
// activeQuestionToolId / questionQueue / activePermissionId accessors below.
let _panelEl = null;    // set by ocp-panel.js
let _onUpdate = null;   // callback to refresh UI
let _panelVisible = false;
let _showPanel = null;  // callback to show panel from tray pill click
let _hidePanel = null;  // callback to close panel (last-tab-close)

export function getTabs() { return _tabs; }
export function getActiveTabIdx() { return _activeTabIdx; }
export function activeTab() { return _tabs[_activeTabIdx] || null; }
export function getProviders() { return _providers; }
export function getConnectedProviders() { return _connectedProviders; }
export function getSessions() { return _sessions; }
export function getAgents() { return _agents; }

let _onEditPlan = null;  // callback for "Edit plan" button in post-plan card

export function setPanelEl(el) { _panelEl = el; }
export function setOnUpdate(fn) { _onUpdate = fn; }
export function setPanelVisible(v) {
  const next = !!v;
  if (next !== _panelVisible) {
    try { _trace('panel:visible', { from: _panelVisible, to: next, hasActiveTab: !!activeTab(), running: !!activeTab()?.running }); } catch {}
  }
  _panelVisible = next;
}
export function setOnShow(fn) { _showPanel = fn; }
export function setOnHide(fn) { _hidePanel = fn; }
export function setOnEditPlan(fn) {
  _onEditPlan = fn;
  // Refresh injected dep so the plan module's onEditPlan reflects this update.
  planModule.configure({ onEditPlan: _onEditPlan });
}

// Wire all extracted modules with the dependencies they need from this
// controller. Each module consumes ONE deps object so we avoid circular
// imports. Forward references (sendMessage, panelEl, etc.) are wrapped
// in arrow funcs so hoisting is irrelevant — bindings resolve at call
// time, not at module-init time.
planModule.configure({
  panelEl: (sel) => panelEl(sel),
  sendMessage: (...args) => sendMessage(...args),
  setTabMode: (mode) => setTabMode(mode),
  compactSession: (sid) => compactSession(sid),
  saveTabs: () => saveTabs(),
  update: () => update(),
  abortTab: (tab, container) => abortTab(tab, container),
  ensurePlanFile: (tab) => ensurePlanFile(tab),
  onEditPlan: null,
  todosToMarkdown: (todos) => todosToMarkdown(todos),
  hasActiveQuestion: (tab) => hasActiveQuestion(tab),
  activePermissionId: (tab) => activePermissionId(tab),
  backfillPendingQuestions: (tab, opts) => questionsModule.backfillPendingQuestions(tab, opts),
  finalizeStreamingMessage: (live) => finalizeStreamingMessage(live),
  settleRunningToolCards: (live, status) => settleRunningToolCards(live, status),
  notifyOpenCodeOutcome: (type, tab, key) => notifyOpenCodeOutcome(type, tab, key),
  endTurn: (tab) => endTurn(tab),
  setTurnStatus: (tab, text, detail) => setTurnStatus(tab, text, detail),
});

questionsModule.configure({
  requestWs,
  sendMessage: (...args) => sendMessage(...args),
  panelEl: (sel) => panelEl(sel),
  getActiveTab: () => activeTab(),
  setTurnStatus: (tab, text, detail) => setTurnStatus(tab, text, detail),
  tabStatusDetail: (tab) => tabStatusDetail(tab),
  thinkingActivity: (tab) => thinkingActivity(tab),
  showThinking: (container, opts) => showThinking(container, opts),
  ensureNotifState: (tab) => ensureNotifState(tab),
  notifyOpenCode: (type, tab) => notifyOpenCode(type, tab),
  endTurn: (tab) => endTurn(tab),
  update: () => update(),
  renderErrorMessage: (container, msg) => renderErrorMessage(container, msg),
  escHtml: (s) => escHtml(s),
  NOTIF_TYPE,
});

sendModule.configure({
  activeTab: () => activeTab(),
  getTabs: () => _tabs,
  panelEl: (sel) => panelEl(sel),
  reconcileTabMode: (tab) => reconcileTabMode(tab),
  setTurnStatus: (tab, text, detail) => setTurnStatus(tab, text, detail),
  tabStatusDetail: (tab) => tabStatusDetail(tab),
  thinkingActivity: (tab) => thinkingActivity(tab),
  resetTurnNotif: (tab) => resetTurnNotif(tab),
  beginTurn: (tab, container) => beginTurn(tab, container),
  endTurn: (tab) => endTurn(tab),
  modelObj: (s) => modelObj(s),
  partTypes: (tab) => partTypes(tab),
  markAssistantRendered: (tab, mid) => markAssistantRendered(tab, mid),
  markCurrentTurnAssistantContent: (tab, container, mid) => markCurrentTurnAssistantContent(tab, container, mid),
  currentTurnHasAssistantContent: (tab, container, mid) => currentTurnHasAssistantContent(tab, container, mid),
  payloadHasAssistantText: (parts) => payloadHasAssistantText(parts),
  normalizeThreadTokenUsage: (raw) => normalizeThreadTokenUsage(raw),
  notifyOpenCodeOutcome: (type, tab, key) => notifyOpenCodeOutcome(type, tab, key),
  NOTIF_TYPE,
  createSession: () => createSession(),
  update: () => update(),
  setActiveSendRequestId: (id) => { _activeSendRequestId = id; },
  settleRunningToolCards: (container, status) => settleRunningToolCards(container, status),
});

eventsModule.configure({
  getActiveTab: () => activeTab(),
  getTabBySessionId: (sid) => findTabBySessionId(sid),
  panelEl: (sel) => panelEl(sel),
});

// The SDK event router is invoked directly from handleSSEEvent so it can
// consume native question/permission events before the legacy renderer sees
// them. Keep this no-op shim for older imports that still call it.
let _eventsRouterInstalled = false;
function ensureEventsRouterInstalled() {
  if (_eventsRouterInstalled) return;
  _eventsRouterInstalled = true;
}
ensureEventsRouterInstalled();
function update() { if (_onUpdate) _onUpdate(); }

// Coalesced chrome refresh for the streaming hot path. onUpdate() repaints
// runtime status, image strip, mode toggle, send button, action bar, tokens,
// project bar, model label, pills, and the activity dock — far too heavy to
// run per token. Throttle to ~5 Hz during streaming so token counters stay
// live without burning the main thread.
let _streamUpdateTimer = null;
let _streamTickCount = 0;
let _streamScheduledAt = 0;
function scheduleStreamUpdate() {
  if (_streamUpdateTimer) return;
  _streamScheduledAt = Date.now();
  _streamUpdateTimer = setTimeout(() => {
    _streamUpdateTimer = null;
    _streamTickCount++;
    const lag = Date.now() - _streamScheduledAt;
    // Browsers throttle background-tab setTimeouts to ~1Hz; lag>1000 here is
    // strong evidence that the tab is backgrounded and the streaming "pause"
    // is browser throttling, not our render code being broken.
    if (lag > 600 || _streamTickCount % 25 === 0) {
      try { _trace('stream:tick', { count: _streamTickCount, lagMs: lag, panelVisible: _panelVisible, hidden: typeof document !== 'undefined' ? document.hidden : null }); } catch {}
    }
    if (_onUpdate) _onUpdate();
  }, 200);
}

// ── Token usage normalization ──

function normalizeThreadTokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const total = normalizeTokenBreakdown(value.total || value);
  const last = normalizeTokenBreakdown(value.last || value);
  const parsedWindow = Number(value.modelContextWindow);
  const modelContextWindow = Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : null;
  return { total, last, modelContextWindow };
}

function normalizeTokenBreakdown(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    inputTokens: Number(value.inputTokens) || Number(value.input_tokens) || 0,
    outputTokens: Number(value.outputTokens) || Number(value.output_tokens) || 0,
    cachedInputTokens: Number(value.cachedInputTokens) || Number(value.cache_read_input_tokens) || 0,
    cacheCreationInputTokens: Number(value.cacheCreationInputTokens) || Number(value.cache_creation_input_tokens) || 0,
    reasoningOutputTokens: Number(value.reasoningOutputTokens) || Number(value.reasoning_output_tokens) || 0,
  };
}

export function resolveContextInputTokens(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return 0;
  return (Number(breakdown.inputTokens) || 0)
    + (Number(breakdown.cachedInputTokens) || 0)
    + (Number(breakdown.cacheCreationInputTokens) || 0);
}

function getModelContextWindow(modelStr) {
  if (!modelStr) return null;
  // Common model context windows
  const windows = {
    'gpt-4': 8192, 'gpt-4-32k': 32768, 'gpt-4-turbo': 128000,
    'gpt-4o': 128000, 'gpt-4o-mini': 128000,
    'claude-3-opus': 200000, 'claude-3-sonnet': 200000, 'claude-3-haiku': 200000,
    'claude-3-5-sonnet': 200000, 'claude-3-5-haiku': 200000,
    'gemini-pro': 128000, 'gemini-1.5-pro': 128000, 'gemini-1.5-flash': 128000,
  };
  const modelId = modelStr.split('/').pop()?.toLowerCase() || '';
  for (const [key, window] of Object.entries(windows)) {
    if (modelId.includes(key)) return window;
  }
  return null;
}

function panelEl(sel) { return _panelEl?.querySelector(sel) || null; }

function runtimeSet(tab, key) {
  if (!tab) return new Set();
  if (!(tab[key] instanceof Set)) tab[key] = new Set();
  return tab[key];
}

function runtimeMap(tab, key) {
  if (!tab) return new Map();
  if (!(tab[key] instanceof Map)) tab[key] = new Map();
  return tab[key];
}

function userMsgIds(tab) {
  return runtimeSet(tab, '_userMsgIds');
}

function partTypes(tab) {
  return runtimeMap(tab, '_partTypes');
}

function renderedAssistantMsgIds(tab) {
  return runtimeSet(tab, '_renderedAssistantMsgIds');
}

function currentTurn(tab) {
  if (!tab) return null;
  if (!tab._currentTurn) {
    tab._currentTurn = {
      id: '',
      startAssistantCount: 0,
      streamedText: false,
      assistantIds: new Set(),
    };
  }
  if (!(tab._currentTurn.assistantIds instanceof Set)) {
    tab._currentTurn.assistantIds = new Set(tab._currentTurn.assistantIds || []);
  }
  return tab._currentTurn;
}

function beginTurn(tab, container) {
  const turn = currentTurn(tab);
  turn.id = (globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random()}`);
  turn.startAssistantCount = container?.querySelectorAll('.ocp-msg-assistant').length || 0;
  turn.streamedText = false;
  turn.assistantIds.clear();
  return turn;
}

function markAssistantRendered(tab, messageId) {
  if (!tab || !messageId) return;
  renderedAssistantMsgIds(tab).add(messageId);
  _renderedAssistantMsgIds.add(messageId);
}

function hasAssistantRendered(tab, messageId) {
  if (!messageId) return false;
  return renderedAssistantMsgIds(tab).has(messageId) || _renderedAssistantMsgIds.has(messageId);
}

function tagLatestAssistant(container, tab, messageId = '') {
  if (!container || !tab) return null;
  const els = container.querySelectorAll('.ocp-msg-assistant');
  const el = els[els.length - 1] || null;
  if (!el) return null;
  const turn = currentTurn(tab);
  if (turn?.id) el.dataset.turnId = turn.id;
  if (messageId) el.dataset.messageId = String(messageId);
  return el;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function markCurrentTurnAssistantContent(tab, container, messageId = '') {
  const turn = currentTurn(tab);
  if (!turn) return;
  turn.streamedText = true;
  if (messageId) turn.assistantIds.add(messageId);
  tagLatestAssistant(container, tab, messageId);
}

function currentTurnHasAssistantContent(tab, container, messageId = '') {
  const turn = currentTurn(tab);
  if (!turn) return false;
  if (messageId && turn.assistantIds.has(messageId)) return true;
  if (turn.streamedText) return true;
  if (!container) return false;
  if (turn.id && container.querySelector(`.ocp-msg-assistant[data-turn-id="${cssEscape(turn.id)}"]`)) return true;
  // Walk new-this-turn bubbles for actual response content. A streaming bubble
  // that contains only a Thought block (rawText empty, only an .ocp-think-block
  // child) is the placeholder for a reasoning part — the real text response
  // may still be missing, so the POST/message.updated fallback should run.
  // The previous bare count check returned a false positive in that case.
  const all = container.querySelectorAll('.ocp-msg-assistant');
  const startCount = turn.startAssistantCount || 0;
  for (let i = startCount; i < all.length; i++) {
    const el = all[i];
    if (el.dataset.rawText && el.dataset.rawText.trim()) return true;
    const hasNonThinkContent = Array.from(el.children).some((child) => {
      if (child.classList?.contains('ocp-think-block')) return false;
      return Boolean(child.textContent && child.textContent.trim());
    });
    if (hasNonThinkContent) return true;
  }
  return false;
}

function endTurn(tab) {
  if (!tab) return;
  const turn = currentTurn(tab);
  turn.id = '';
  turn.startAssistantCount = 0;
  turn.streamedText = false;
  turn.assistantIds.clear();
  // Flush any pending coalesced stream update so the panel chrome reflects
  // the final token count / status the moment the turn ends.
  if (_streamUpdateTimer) {
    clearTimeout(_streamUpdateTimer);
    _streamUpdateTimer = null;
  }
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

function normalizeSdkEventForLegacy(eventType, event) {
  const type = String(eventType || '').replace(/\.\d+$/, '');
  if (!type.startsWith('session.next.')) return null;
  const sid = event?.sessionID || event?.sessionId || '';

  if (type === 'session.next.text.delta') {
    return {
      eventType: 'message.part.delta',
      event: {
        ...event,
        sessionID: sid,
        delta: event?.delta || '',
        part: { type: 'text', sessionID: sid },
        _sdkEventType: type,
      },
    };
  }
  if (type === 'session.next.reasoning.delta') {
    return {
      eventType: 'message.part.delta',
      event: {
        ...event,
        sessionID: sid,
        delta: event?.delta || '',
        partID: event?.reasoningID || '',
        part: { id: event?.reasoningID || '', type: 'reasoning', sessionID: sid },
        _sdkEventType: type,
      },
    };
  }
  if (type === 'session.next.text.ended') {
    return {
      eventType: 'message.part.updated',
      event: {
        ...event,
        sessionID: sid,
        part: {
          id: `next-text:${sid}`,
          type: 'text',
          text: event?.text || '',
          sessionID: sid,
        },
        _sdkEventType: type,
      },
    };
  }
  if (type === 'session.next.reasoning.ended') {
    return {
      eventType: 'message.part.updated',
      event: {
        ...event,
        sessionID: sid,
        part: {
          id: event?.reasoningID || `next-reasoning:${sid}`,
          type: 'reasoning',
          text: event?.text || '',
          sessionID: sid,
        },
        _sdkEventType: type,
      },
    };
  }
  if (type === 'session.next.tool.called') {
    return {
      eventType: 'tool.start',
      event: {
        ...event,
        sessionID: sid,
        tool: event?.tool || event?.name || 'tool',
        name: event?.tool || event?.name || 'tool',
        toolCallId: event?.callID || event?.callId || event?.id || '',
        id: event?.callID || event?.callId || event?.id || '',
        input: event?.input || {},
        args: event?.input || {},
        _sdkEventType: type,
      },
    };
  }
  if (type === 'session.next.tool.success' || type === 'session.next.tool.failed') {
    const isError = type === 'session.next.tool.failed';
    return {
      eventType: 'tool.result',
      event: {
        ...event,
        sessionID: sid,
        toolCallId: event?.callID || event?.callId || event?.id || '',
        id: event?.callID || event?.callId || event?.id || '',
        result: isError ? '' : formatNextToolResult(event),
        output: isError ? '' : formatNextToolResult(event),
        error: isError ? formatNextToolError(event) : '',
        _sdkEventType: type,
      },
    };
  }
  if (type === 'session.next.step.failed') {
    return {
      eventType: 'session.error',
      event: {
        ...event,
        sessionID: sid,
        error: event?.error || { message: 'OpenCode step failed' },
        _sdkEventType: type,
      },
    };
  }
  return null;
}

function formatNextToolResult(event) {
  if (event?.structured && Object.keys(event.structured).length) return event.structured;
  const content = Array.isArray(event?.content) ? event.content : [];
  const text = content
    .map((entry) => {
      if (!entry) return '';
      if (entry.type === 'text') return entry.text || '';
      if (entry.type === 'file') return entry.uri || entry.name || '';
      return String(entry.text || entry.uri || entry.name || '');
    })
    .filter(Boolean)
    .join('\n');
  return text;
}

function formatNextToolError(event) {
  const err = event?.error || {};
  if (typeof err === 'string') return err;
  return err.message || err.data?.message || err.type || 'Tool failed';
}

function payloadHasAssistantText(value) {
  if (value == null) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(payloadHasAssistantText);
  if (typeof value !== 'object') return false;
  const type = String(value.type || '').toLowerCase();
  if (type.includes('tool')) return false;
  if (['text', 'reasoning', 'thinking', 'thought'].includes(type)) {
    return payloadHasAssistantText(value.text ?? value.content ?? value.value ?? value.message ?? value.reasoning ?? '');
  }
  return payloadHasAssistantText(value.content)
    || payloadHasAssistantText(value.parts)
    || payloadHasAssistantText(value.text)
    || payloadHasAssistantText(value.value)
    || payloadHasAssistantText(value.message);
}

// Backstop: after `session.idle`, fetch the canonical message list and verify
// the latest assistant message's text is rendered. Catches the Kimi K2.6 /
// DeepSeek case where the text part SSE never reaches the panel due to timing
// races but the message exists in OpenCode's DB. Uses the same `messages:list`
// WS proxy the Edit-plan flow uses; no extra server work.
function reconcileMissingAssistantText(tab, container) {
  if (!tab?.sessionId || !container) return;
  const sid = tab.sessionId;
  const seq = ++_renderSeq;
  requestWs('messages:list', { sessionId: sid }, 8000)
    .then((resp) => {
      if (seq !== _renderSeq) return; // newer turn already running
      if (!container.isConnected) return;
      const raw = resp?.data?.messages || resp?.data || [];
      const messages = Array.isArray(raw) ? raw : [];
      if (!messages.length) return;
      let lastAssistantText = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] || {};
        const info = m.info || (typeof m.data === 'string' ? safeJSON(m.data) : null) || m;
        const role = info?.role || m?.role;
        if (role !== 'assistant') continue;
        const parts = Array.isArray(m.parts) ? m.parts : [];
        const textJoined = parts
          .map((p) => (typeof p?.data === 'string' ? safeJSON(p.data) : p))
          .filter((p) => String(p?.type || '').toLowerCase() === 'text')
          .map((p) => String(p?.text || p?.content || '').trim())
          .filter(Boolean)
          .join('\n\n')
          .trim();
        if (textJoined) { lastAssistantText = textJoined; break; }
      }
      if (!lastAssistantText) return;
      const probe = lastAssistantText.slice(0, Math.min(80, lastAssistantText.length));
      const bubbles = container.querySelectorAll('.ocp-msg-assistant');
      const found = Array.from(bubbles).some((b) => (b.textContent || '').includes(probe));
      if (found) return;
      renderAssistantMessage(container, lastAssistantText);
    })
    .catch(() => {});
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function findTabBySessionId(sessionId) {
  if (!sessionId) return null;
  const sid = String(sessionId);
  return _tabs.find((tab) => tab?.sessionId === sid)
    || _tabs.find((tab) => tab?.toolActivityChildSessions && tab.toolActivityChildSessions[sid])
    || null;
}

// Per-tab question gating. Each tab owns its own active toolId + queue so two
// concurrent OpenCode sessions don't share state (a question raised on tab B
// must never be processed in tab A's container — and clearing tab B's queue
// when tab A sends a message would silently drop user-facing prompts).
function activeQuestionToolId(tab) {
  return questionsModule.activeQuestionToolId(tab);
}

function setActiveQuestionToolId(tab, toolId) {
  questionsModule.setActiveQuestionToolId(tab, toolId);
}

function tabQuestionQueue(tab) {
  if (!tab) return [];
  if (!Array.isArray(tab._questionQueue)) tab._questionQueue = [];
  return tab._questionQueue;
}

function hasActiveQuestion(tab) {
  return questionsModule.hasActiveQuestion(tab);
}

function queueQuestion(tab, event) {
  questionsModule.queueQuestion(tab, event);
}

function dequeueNextQuestion(tab) {
  const q = tabQuestionQueue(tab);
  if (q.length === 0) {
    setActiveQuestionToolId(tab, null);
    return null;
  }
  return q.shift();
}

function clearQuestionQueue(tab) {
  questionsModule.clearQuestionQueue(tab);
}

function activePermissionId(tab) {
  return questionsModule.activePermissionId(tab);
}

function setActivePermissionId(tab, permId) {
  questionsModule.setActivePermissionId(tab, permId);
}

function processQuestionQueue(tab, container) {
  questionsModule.processQuestionQueue(tab, container);
}

function normalizeSessionTitle(value, fallback = 'New session') {
  const text = String(value || '').trim();
  return text || fallback;
}

function shortModelLabel(modelStr) {
  if (!modelStr) return '';
  const idx = modelStr.lastIndexOf('/');
  return idx >= 0 ? modelStr.slice(idx + 1) : modelStr;
}

function normalizeMode(value) {
  const next = String(value || '').trim().toLowerCase();
  return next === 'chat' || next === 'build' || next === 'plan' ? next : '';
}

function modeLabel(mode) {
  return MODE_LABELS[normalizeMode(mode)] || '';
}

function deriveModeFromAgent(agent) {
  const next = String(agent || '').trim().toLowerCase();
  if (next === 'plan' || next === 'build' || next === 'chat') return next;
  return '';
}

function defaultMode() {
  const storedMode = normalizeMode(storage.getItem(STOR.mode));
  if (storedMode) return storedMode;
  const legacyAgentMode = deriveModeFromAgent(storage.getItem(STOR.agent));
  return legacyAgentMode || DEFAULT_MODE;
}

function resolveAgentForMode(mode) {
  const next = normalizeMode(mode) || DEFAULT_MODE;
  if (next === 'plan' || next === 'build') return next;
  return _primaryAgents.has('chat') ? 'chat' : '';
}

function reconcileTabMode(tab, { persistDefault = false } = {}) {
  if (!tab) return;
  const nextMode = normalizeMode(tab.mode) || deriveModeFromAgent(tab.agent) || defaultMode();
  tab.mode = nextMode;
  tab.agent = resolveAgentForMode(nextMode);
  if (persistDefault) storage.setItem(STOR.mode, nextMode);
}

function tabStatusDetail(tab) {
  return shortModelLabel(tab?.model) || modeLabel(tab?.mode) || tab?.agent || '';
}

function thinkingActivity(tab) {
  return {
    lastEventAt: tab?._lastEventAt || 0,
    lastEventName: tab?._lastEventName || '',
    events: tab?._eventCount || 0,
  };
}

function setTurnStatus(tab, text = '', detail = '') {
  if (!tab) return;
  tab.statusText = text || '';
  tab.statusDetail = detail || '';
}

function updateSessionTitleState(sessionId, nextTitle) {
  if (!sessionId) return;
  const title = normalizeSessionTitle(nextTitle);
  _sessions = _sessions.map((session) => {
    const sid = session?.id || session?.sessionID;
    return sid === sessionId ? { ...session, title } : session;
  });
  for (const tab of _tabs) {
    if (tab?.sessionId === sessionId) tab.sessionTitle = title;
  }
}

// ── Tab CRUD ──

export function createTab(opts = {}) {
  if (_tabs.length >= MAX_TABS) return null;

  const prev = activeTab();
  const mode = normalizeMode(opts.mode) || prev?.mode || defaultMode();
  const tab = {
    id: opts.id || crypto.randomUUID(),
    sessionId: opts.sessionId || null,
    sessionTitle: opts.sessionTitle || 'New session',
    model: opts.model || prev?.model || storage.getItem(STOR.model) || '',
    mode,
    agent: opts.agent || '',
    project: opts.project || prev?.project || storage.getItem(STOR.project) || '',
    running: false,
    draft: opts.draft || '',
    attachedImages: Array.isArray(opts.attachedImages) ? [...opts.attachedImages] : [],
    messages: [],       // local message elements container
    threadTokenUsage: null,
    inputTokens: 0,
    outputTokens: 0,
    turnStartedAt: 0,
    statusText: '',
    statusDetail: '',
    pillEl: null,
    planContent: opts.planContent || '',
    planFilePath: opts.planFilePath || '',
    editedPlanContent: opts.editedPlanContent || '',
    showPostPlanActions: opts.showPostPlanActions || false,
    postPlanHeader: opts.postPlanHeader || 'PLAN COMPLETE',
    pendingTitle: opts.pendingTitle || null,  // user-named before server session exists; applied via renameSession once sessionId assigned
    toolActivity: [],
    toolActivityChildSessions: {},
    toolActivityVisible: storage.getItem(STOR.activity) === '1',
  };
  reconcileTabMode(tab);

  _tabs.push(tab);
  createPillEl(tab, _tabs.length - 1);
  if (opts.autoSwitch !== false) switchTab(_tabs.length - 1);
  saveTabs();
  update();
  return tab;
}

export function switchTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;

  // Save current draft
  const prev = activeTab();
  const input = panelEl('#ocp-input');
  if (prev && input) prev.draft = input.value;
  if (prev) flushSessionSnapshotSave(prev);

  _activeTabIdx = idx;

  // Restore draft
  const tab = activeTab();
  reconcileTabMode(tab);
  if (input && tab) input.value = tab.draft || '';

  if (tab) {
    try { _setTraceContext({ tabId: tab.id, sessionId: tab.sessionId, mode: tab.mode, model: tab.model, agent: tab.agent }); } catch {}
    try { _trace('tab:switch', { sid: tab.sessionId, mode: tab.mode, idx }); } catch {}
  }
  renderTabMessages();
  renderPills();
  saveTabs();
  update();
}

export function closeTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const tab = _tabs[idx];
  clearPlanFinalizationWatchdog(tab);
  clearQuestionReplyWatchdog(tab);
  flushSessionSnapshotSave(tab);
  if (tab.pillEl) tab.pillEl.remove();
  if (tab.trayPillEl) tab.trayPillEl.remove();
  _tabs.splice(idx, 1);

  if (_tabs.length === 0) {
    _activeTabIdx = -1;
    saveTabs();
    renderPills();
    if (_hidePanel) _hidePanel();
    return;
  }
  if (_activeTabIdx >= _tabs.length) _activeTabIdx = _tabs.length - 1;
  if (_activeTabIdx === idx || idx < _activeTabIdx) {
    _activeTabIdx = Math.max(0, _activeTabIdx - (idx < _activeTabIdx ? 1 : 0));
  }
  switchTab(_activeTabIdx);
}

// ── Active project ──
//
// OpenCode binds each session to the cwd it was created with — there is no
// per-message cwd override. Mutating only tab.project leaves any existing
// session running at the OLD project's directory, so the agent never sees the
// new path. When the active project actually changes for a tab that already
// has a session, drop the session here so the next sendMessage() creates a
// fresh one at the new cwd.
export function setActiveProject(projectPath) {
  const tab = activeTab();
  if (!tab) {
    console.warn('[ocp] setActiveProject: no active tab', { projectPath });
    return;
  }
  const next = projectPath || '';
  const prev = tab.project || '';
  console.log('[ocp] setActiveProject', { prev, next, hadSession: !!tab.sessionId, tabId: tab.id });

  tab.project = next;
  storage.setItem(STOR.project, next);

  if (next !== prev && tab.sessionId) {
    clearPlanFinalizationWatchdog(tab);
    clearQuestionReplyWatchdog(tab);
    clearQuestionQueue(tab);
    flushSessionSnapshotSave(tab);

    tab.sessionId = null;
    tab.sessionTitle = 'New session';
    tab.toolActivity = [];
    tab.toolActivityChildSessions = {};
    tab.threadTokenUsage = null;
    tab.inputTokens = 0;
    tab.outputTokens = 0;
    tab.statusText = '';
    tab.statusDetail = '';
    tab.planContent = '';
    tab.planFilePath = '';
    tab.editedPlanContent = '';
    tab.showPostPlanActions = false;
    tab.postPlanHeader = 'PLAN COMPLETE';
    tab.pendingTitle = null;
    tab._exitPlanDetected = false;
    tab._questionToolUsedThisTurn = false;
    tab._pendingPostPlanCheck = false;
    tab.running = false;
    tab.turnStartedAt = 0;

    const container = panelEl('#ocp-messages');
    if (container) {
      container.innerHTML = '';
      renderEmptyState(container);
    }
  }

  const projectDd = panelEl('#ocp-project-dd');
  if (projectDd) {
    const lbl = projectDd.querySelector('.ocp-dd-label');
    if (lbl) {
      lbl.textContent = next ? (next.split('/').pop() || next) : (projectDd.dataset.placeholder || 'project...');
    }
  }

  saveTabs();
  renderPills();
  update();
}

// ── Tab pills ──

function createPillEl(tab, idx) {
  const pill = document.createElement('button');
  pill.className = 'ocp-tab-pill';
  pill.innerHTML = `
    <span class="ocp-tab-pill-dot"></span>
    <span class="ocp-tab-pill-label">${escHtml(tab.sessionTitle)}</span>
    <button class="ocp-tab-pill-close" title="Close tab">${ICON_X}</button>
  `;
  pill.addEventListener('click', (e) => {
    if (e.target.closest('.ocp-tab-pill-close')) {
      closeTab(_tabs.indexOf(tab));
      return;
    }
    switchTab(_tabs.indexOf(tab));
  });
  tab.pillEl = pill;

  const tabBar = panelEl('.ocp-tab-bar');
  if (tabBar) tabBar.appendChild(pill);
}

export function renderPills() {
  const active = activeTab();
  for (const tab of _tabs) {
    // In-panel tab pills
    if (tab.pillEl) {
      tab.pillEl.classList.toggle('active', tab === active);
      const label = tab.pillEl.querySelector('.ocp-tab-pill-label');
      if (label) label.textContent = tab.sessionTitle || 'New session';
    }
    // Tray pills
    if (!tab.trayPillEl?.isConnected) tab.trayPillEl = createTrayPill(tab);
    if (tab.trayPillEl) {
      const lbl = tab.trayPillEl.querySelector('.term-minimized-pill-label');
      if (lbl) lbl.textContent = tab.sessionTitle || 'New session';
      tab.trayPillEl.classList.toggle('ocp-pill-running', !!tab.running);
      tab.trayPillEl.style.display = (!_panelVisible || tab !== active) ? '' : 'none';
    }
  }
}

function createTrayPill(tab) {
  const tray = document.getElementById('term-minimized-tray');
  if (!tray) return null;
  const pill = document.createElement('div');
  pill.className = 'term-minimized-pill ocp-session-pill';
  pill.dataset.tabId = tab.id;
  pill.innerHTML = `
    <span class="term-minimized-pill-icon">${OPENCODE_ICON}</span>
    <span class="term-minimized-pill-label">${escHtml(tab.sessionTitle || 'New session')}</span>
    <button class="term-minimized-pill-close" data-tooltip="Close">&times;</button>
  `;
  pill.addEventListener('click', () => {
    const idx = _tabs.indexOf(tab);
    if (idx < 0) return;
    if (_showPanel) _showPanel();
    switchTab(idx);
  });
  pill.querySelector('.term-minimized-pill-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = _tabs.indexOf(tab);
    if (idx >= 0) closeTab(idx);
  });
  pill.style.display = 'none';
  tray.appendChild(pill);
  return pill;
}

// ── Tab persistence ──

export function saveTabs() {
  try {
    const data = _tabs.map(t => ({
      id: t.id, sessionId: t.sessionId, sessionTitle: t.sessionTitle,
      model: t.model, mode: t.mode, agent: t.agent, project: t.project, draft: t.draft,
      planContent: t.planContent, planFilePath: t.planFilePath, editedPlanContent: t.editedPlanContent,
      showPostPlanActions: t.showPostPlanActions, postPlanHeader: t.postPlanHeader,
      threadTokenUsage: t.threadTokenUsage,
    }));
    storage.setItem(STOR.tabs, JSON.stringify({ activeIdx: _activeTabIdx, tabs: data }));
    _updateOcpWindowRegistry();
  } catch {}
}

export function restoreTabs() {
  try {
    const raw = storage.getItem(STOR.tabs);
    if (!raw) return false;
    const { activeIdx, tabs } = JSON.parse(raw);
    if (!Array.isArray(tabs) || !tabs.length) return false;
    for (const saved of tabs) {
      const restored = normalizeThreadTokenUsage(saved.threadTokenUsage);
      const sanitized = { ...saved, threadTokenUsage: restored };
      // Clear trapped post-plan state if the persisted plan content is
      // thinking/preamble (would 422 on /api/create-plan). Prevents a prior
      // bad turn from surviving a page reload as a phantom PLAN COMPLETE.
      if (sanitized.showPostPlanActions && !isRealPlanContent(sanitized.planContent)) {
        sanitized.showPostPlanActions = false;
        sanitized.planContent = '';
        sanitized.editedPlanContent = '';
        sanitized.planFilePath = '';
      }
      createTab({ ...sanitized, autoSwitch: false });
    }
    switchTab(typeof activeIdx === 'number' ? activeIdx : 0);
    return true;
  } catch { return false; }
}

// ── Session management ──

export async function loadSessions() {
  try {
    const resp = await requestWs('session:list');
    _sessions = Array.isArray(resp.data) ? resp.data : (resp.data?.sessions || []);
    update();
  } catch (e) {
    console.error('[ocp-tabs] loadSessions failed:', e);
  }
}

export async function createSession() {
  try {
    const tab = activeTab();
    reconcileTabMode(tab);
    const body = {};
    if (tab?.pendingTitle) body.title = tab.pendingTitle;
    // NOTE: we previously tried passing agent + model at session create time
    // (CLI parity hypothesis). OpenCode v1.14.41 server REJECTED those fields
    // and the panel showed "Could not create OpenCode session". Reverted to
    // pass agent/model per-prompt instead — see ocp-send.js sendMessage.
    const cwd = tab?.project || '';
    console.log('[ocp] createSession sending', { cwd, tabId: tab?.id, title: body.title });
    const resp = await requestWs('session:create', { body, ...(cwd ? { cwd } : {}) });
    const session = resp.data;
    console.log('[ocp] createSession response', { id: session?.id, directory: session?.directory });
    if (tab && session) {
      tab.sessionId = session.id || session.sessionID;
      tab.sessionTitle = session.title || 'New session';
      tab.toolActivity = [];
      tab.toolActivityChildSessions = {};
      if (tab.pendingTitle) {
        const pending = tab.pendingTitle;
        tab.pendingTitle = null;
        renameSession(tab.sessionId, pending).catch(() => {});
      }
      saveTabs();
      update();
    }
    return session;
  } catch (e) {
    console.error('[ocp-tabs] createSession failed:', e);
    return null;
  }
}

export async function renameSession(sessionId, title) {
  const nextTitle = normalizeSessionTitle(title);
  if (!sessionId || !nextTitle) return null;
  try {
    const resp = await requestWs('session:update', {
      sessionId,
      body: { title: nextTitle },
    });
    const session = resp.data;
    updateSessionTitleState(
      session?.id || session?.sessionID || sessionId,
      session?.title || nextTitle,
    );
    saveTabs();
    update();
    return session;
  } catch (e) {
    console.error('[ocp-tabs] renameSession failed:', e);
    throw e;
  }
}

export async function loadMessages(sessionId) {
  if (!sessionId) return [];
  try {
    const resp = await requestWs('messages:list', { sessionId });
    return Array.isArray(resp.data) ? resp.data : (resp.data?.messages || []);
  } catch (e) {
    console.error('[ocp-tabs] loadMessages failed:', e);
    return [];
  }
}

export async function deleteSession(sessionId) {
  try {
    await requestWs('session:delete', { sessionId });
    _sessions = _sessions.filter(s => (s.id || s.sessionID) !== sessionId);
    update();
  } catch (e) {
    console.error('[ocp-tabs] deleteSession failed:', e);
  }
}

export async function revertSession(sessionId) {
  try {
    await requestWs('session:revert', { sessionId });
  } catch (e) {
    console.error('[ocp-tabs] revertSession failed:', e);
  }
}

export async function compactSession(sessionId) {
  try {
    await requestWs('session:summarize', { sessionId });
  } catch (e) {
    console.error('[ocp-tabs] compactSession failed:', e);
  }
}

export async function shareSession(sessionId) {
  try {
    const resp = await requestWs('session:share', { sessionId });
    if (resp.data?.url) {
      await navigator.clipboard.writeText(resp.data.url);
    }
    return resp.data;
  } catch (e) {
    console.error('[ocp-tabs] shareSession failed:', e);
    return null;
  }
}

export async function executeCommand(sessionId, command, args = '') {
  try {
    const resp = await requestWs('session:command', {
      sessionId,
      body: { command, arguments: args },
    });
    return resp;
  } catch (e) {
    console.error('[ocp-tabs] executeCommand failed:', e);
    return null;
  }
}

// ── Plan mode helpers ──

// Render a TodoWrite/Tasks `todos` array into markdown plan text. Each todo
// becomes a checklist item using its `content`/`activeForm` and status.
function todosToMarkdown(todos) {
  if (!Array.isArray(todos) || !todos.length) return '';
  const lines = ['# Plan', ''];
  todos.forEach((t, idx) => {
    const text = String(t?.content || t?.activeForm || t?.text || t?.title || '').trim();
    if (!text) return;
    const status = String(t?.status || '').toLowerCase();
    const mark = status === 'completed' || status === 'done' ? 'x' : ' ';
    lines.push(`${idx + 1}. [${mark}] ${text}`);
  });
  return lines.join('\n').trim();
}

function capturePlanContent(tab) {
  if (!tab || tab.mode !== 'plan') return tab?.planContent || '';
  const container = panelEl('#ocp-messages');
  if (!container) return tab.planContent || '';
  const assistantEls = container.querySelectorAll('.ocp-msg-assistant');
  if (!assistantEls.length) return tab.planContent || '';
  const lastEl = assistantEls[assistantEls.length - 1];
  const clone = lastEl.cloneNode(true);
  for (const tb of clone.querySelectorAll('.ocp-think-block')) {
    tb.remove();
  }
  const text = (clone.textContent || '').trim();
  if (text.length > 80) tab.planContent = text;
  return tab.planContent || '';
}

// Relaxed extractor for the Edit plan flow — ignores mode and min-length guards.
// Order: cached tab.planContent → ExitPlanMode tool args → assistant text bubble
// → standalone Thought block (reasoning-only output) → subagent (Agent/task)
// tool result. OpenCode's Plan agent often emits plan text via reasoning parts
// or subagent results rather than a final assistant text bubble, so DOM
// extraction has to cover all four layers.
export function extractPlanTextLoose(tab) {
  if (!tab) return '';
  if (tab.planContent) return tab.planContent;
  const container = panelEl('#ocp-messages');
  if (!container) return '';

  const toolCards = Array.from(container.querySelectorAll('.ocp-tool-card'));

  // 1. ExitPlanMode tool cards — plan args are JSON, parse for input.plan.
  for (let i = toolCards.length - 1; i >= 0; i--) {
    const nameEl = toolCards[i].querySelector('.ocp-tool-name');
    const name = (nameEl?.textContent || '').trim();
    if (!/exit\s*plan|plan[\s_-]?exit/i.test(name)) continue;
    const argsPre = toolCards[i].querySelector('.ocp-tool-args');
    const argsRaw = (argsPre?.textContent || '').trim();
    if (!argsRaw) continue;
    try {
      const parsed = JSON.parse(argsRaw);
      const planText = String(parsed?.plan || parsed?.markdown || parsed?.content || parsed?.text || '').trim();
      if (planText) { tab.planContent = planText; return planText; }
    } catch {
      if (argsRaw.length > 40) { tab.planContent = argsRaw; return argsRaw; }
    }
  }

  // 1b. Tasks (todowrite) tool cards — plan steps live in the todos array.
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
      const planMd = todosToMarkdown(todos);
      if (planMd && planMd.length > 40) { tab.planContent = planMd; return planMd; }
    } catch {}
  }

  // 2. Final assistant text bubble.
  const assistantEls = container.querySelectorAll('.ocp-msg-assistant');
  if (assistantEls.length) {
    const lastEl = assistantEls[assistantEls.length - 1];
    const text = (lastEl.textContent || '').trim();
    if (text.length > 40) { tab.planContent = text; return text; }
  }

  // 3. Standalone Thought / reasoning blocks (rendered as siblings, not inside
  //    .ocp-msg-assistant). Some plan agents emit the entire plan as reasoning.
  const thinkBlocks = container.querySelectorAll('.ocp-think-block .ocp-think-content');
  if (thinkBlocks.length) {
    const lastThink = thinkBlocks[thinkBlocks.length - 1];
    const text = (lastThink.textContent || '').trim();
    if (text.length > 40) { tab.planContent = text; return text; }
  }

  // 4. Subagent (Agent/task) tool result — Plan agent delegates discovery to a
  //    subagent and the aggregated plan text comes back as the tool result.
  for (let i = toolCards.length - 1; i >= 0; i--) {
    const nameEl = toolCards[i].querySelector('.ocp-tool-name');
    const name = (nameEl?.textContent || '').trim().toLowerCase();
    if (!(name === 'agent' || name === 'task' || name.includes('agent'))) continue;
    const resultPre = toolCards[i].querySelector('.ocp-tool-result');
    const resultRaw = (resultPre?.textContent || '').trim();
    if (resultRaw.length > 40) { tab.planContent = resultRaw; return resultRaw; }
  }

  // Last resort: any assistant bubble at all, even if short.
  if (assistantEls.length) {
    const lastEl = assistantEls[assistantEls.length - 1];
    const text = (lastEl.textContent || '').trim();
    if (text) { tab.planContent = text; return text; }
  }
  return '';
}

export async function ensurePlanFile(tab) {
  if (!tab) return '';
  if (tab.planFilePath) return tab.planFilePath;
  if (tab._planFilePromise) return tab._planFilePromise;
  const planText = tab.planContent || capturePlanContent(tab);
  if (!planText) return '';

  tab._planFilePromise = fetch('/api/create-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: planText, cwd: tab.project || '' }),
  })
    .then(async (res) => {
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result?.ok || !result.path) {
        throw new Error(result?.error || 'create-plan failed');
      }
      tab.planFilePath = result.path;
      saveTabs();
      return result.path;
    })
    .catch((err) => {
      console.error('[ocp-tabs] create-plan failed:', err);
      return '';
    })
    .finally(() => {
      tab._planFilePromise = null;
    });

  return tab._planFilePromise;
}

export function showPostPlanUI(tab, headerText = null) {
  if (!tab) return;
  const container = panelEl('#ocp-messages');
  if (!container) return;
  // Remove any existing post-plan cards before appending a new one
  removePostPlanCards(container);
  tab.showPostPlanActions = true;
  tab.postPlanHeader = headerText || tab.postPlanHeader || 'PLAN COMPLETE';
  ensurePlanFile(tab);
  saveTabs();
  renderPostPlanCard(container, {
    headerText: tab.postPlanHeader,
    onContinue: () => {
      tab.showPostPlanActions = false;
      saveTabs();
      setTabMode('build');
      const prompt = tab.editedPlanContent
        ? `Implement the following plan:\n\n${tab.editedPlanContent}`
        : 'The plan has been approved. Please proceed with implementation.';
      sendMessage(prompt);
    },
    onCompact: () => {
      if (tab.sessionId) compactSession(tab.sessionId);
    },
    onEditPlan: (card) => {
      if (typeof _onEditPlan === 'function') _onEditPlan(tab, card);
    },
    onContinuePlanning: () => {
      tab.showPostPlanActions = false;
      saveTabs();
      update();
    },
  });
}

// Recovery card for the case where the model trailed off in prose questions
// without calling the `question` tool and without ExitPlanMode. The "plan"
// text is incomplete, so we deliberately do NOT set tab.showPostPlanActions —
// the user can keep sending messages once they pick a recovery action.
function showProseQuestionRecoveryUI(tab) {
  const container = panelEl('#ocp-messages');
  if (!container) return;
  removePostPlanCards(container);
  removeProseQuestionRecoveryCards(container);
  renderProseQuestionRecoveryCard(container, {
    onReplyDirectly: () => {
      removeProseQuestionRecoveryCards(container);
      const inputEl = panelEl('#ocp-input');
      if (inputEl) {
        try { inputEl.focus(); } catch {}
      }
      update();
    },
    onReAskInteractive: () => {
      removeProseQuestionRecoveryCards(container);
      sendMessage('Please re-ask those clarifying questions using the `question` tool so I can answer them with interactive options. Do not proceed with the plan until I answer.');
    },
    onDismiss: () => {
      removeProseQuestionRecoveryCards(container);
      update();
    },
  });
}

// Idempotent post-plan trigger. Safe to call from any quasi-terminal signal
// in plan mode — short-circuits if the card is already visible or there is
// no captured plan content yet (would otherwise render an empty PLAN COMPLETE
// box that confuses the user).
//
// `force` skips the 40-char min-length guard — used when ExitPlanMode tool
// was detected (we have explicit signal that the plan is complete, even if
// the captured text is short).
function maybeShowPostPlanUI(tab, { source = '', forceRecapture = false, force = false } = {}) {
  // Delegate to the consolidated plan module — single entry point for the
  // 6 idempotent gates. forceRecapture is implicit (the module checks the
  // lock and recaptures from DOM if needed).
  return planModule.onTurnTerminal(tab, source || 'maybeShow', { force });
}

// Watchdog for two stall classes:
//   1) Deepseek-style: planning subagent fired its own session.idle but the
//      parent never finalized (no parent session.idle, no WS resolve, no
//      message.completed). Default 8000 ms.
//   2) ExitPlanMode-detected, no terminal event: tool returned, plan content
//      captured, but no session.idle/message.completed arrives — user is
//      stuck in "Thinking…" until they press STOP. 5000 ms (tool already
//      returned; terminal should be fast). Pass `{ timeoutMs: 5000 }`.
// Force-finalizes the turn and surfaces the post-plan card.
function schedulePlanFinalizationWatchdog(tab, { timeoutMs = 8000 } = {}) {
  if (!tab || tab.mode !== 'plan') return;
  // Gate on the rendered card only — _exitPlanDetected flag no longer implies
  // the card is up (we defer rendering until terminal events). Watchdog must
  // still fire so a stalled session doesn't strand the user without the card.
  if (tab.showPostPlanActions) return;
  if (tab._planFinalizationWatchdogId) return;
  tab._planFinalizationWatchdogId = setTimeout(() => {
    tab._planFinalizationWatchdogId = null;
    if (!tab || tab.mode !== 'plan') return;
    if (tab.showPostPlanActions) return;
    capturePlanContent(tab);
    if (!tab._exitPlanDetected && (!tab.planContent || tab.planContent.length < 40)) return;
    const live = panelEl('#ocp-messages');
    if (live) {
      finalizeStreamingMessage(live);
      settleRunningToolCards(live, 'complete');
      removeThinking(live);
    }
    tab.running = false;
    tab.turnStartedAt = 0;
    endTurn(tab);
    setTurnStatus(tab);
    maybeShowPostPlanUI(tab, { source: 'watchdog:plan-finalize', force: tab._exitPlanDetected });
    update();
  }, timeoutMs);
}

function clearPlanFinalizationWatchdog(tab) {
  if (tab?._planFinalizationWatchdogId) {
    clearTimeout(tab._planFinalizationWatchdogId);
    tab._planFinalizationWatchdogId = null;
  }
  // Plan-mode terminal/abort sites should also drop the stall watchdog —
  // both are plan-mode lifetime timers and should always be cleared together.
  if (tab) clearPlanStallTimers(tab);
}

// ── Plan-mode stall watchdog (tiered) ──────────────────────────────────
//
// Catches the non-Anthropic plan-mode hang (e.g. opencode-go/kimi-k2.6).
// These models often never call ExitPlanMode and never let the OpenCode
// server reach a terminal state, so the user sits in "Thinking…" until they
// press STOP. We re-arm a single-shot silence timer on every SSE event; a
// separate hard-cap timer enforces a maximum total turn duration.
//
// Tiered behavior:
//   - PLAN_STALL_SOFT_MS (60s) of SSE silence  → render soft prompt
//   - PLAN_STALL_AUTO_MS (180s) of silence     → auto-recover
//   - PLAN_STALL_HARD_CAP_MS (8 min) total turn → force-recover
//
// Suppressed while a question card is awaiting user input.
const PLAN_STALL_SOFT_MS = 60000;
const PLAN_STALL_AUTO_MS = 180000;
const PLAN_STALL_HARD_CAP_MS = 480000;

function clearPlanStallTimers(tab) {
  if (!tab) return;
  if (tab._planStallSilenceTimer) {
    clearTimeout(tab._planStallSilenceTimer);
    tab._planStallSilenceTimer = null;
  }
  if (tab._planStallHardCapTimer) {
    clearTimeout(tab._planStallHardCapTimer);
    tab._planStallHardCapTimer = null;
  }
  tab._planStallSoftFired = false;
}

function dismissPlanStallSoftCard(tab) {
  if (!tab) return;
  const container = panelEl('#ocp-messages');
  if (container) {
    try { removePlanStallSoftCards(container); } catch {}
  }
  tab._planStallSoftCardOpen = false;
}

function schedulePlanStallWatchdog(tab) {
  // Disabled — CLI behavior: stalls are handled by server-side auto-abort
  // (90s silence → real abort), not by fabricating a PLAN COMPLETE card on
  // unfinalized content.
  if (!tab) return;
  if (tab._planStallSilenceTimer) {
    clearTimeout(tab._planStallSilenceTimer);
    tab._planStallSilenceTimer = null;
  }
  if (tab._planStallHardCapTimer) {
    clearTimeout(tab._planStallHardCapTimer);
    tab._planStallHardCapTimer = null;
  }
}

function _legacyPlanStallWatchdog_disabled(tab) {
  if (!tab || tab.mode !== 'plan' || !tab.running) return;
  if (tab.showPostPlanActions) return;
  if (hasActiveQuestion(tab)) return;

  if (tab._planStallSilenceTimer) {
    clearTimeout(tab._planStallSilenceTimer);
    tab._planStallSilenceTimer = null;
  }
  const nextDelay = tab._planStallSoftFired
    ? Math.max(PLAN_STALL_AUTO_MS - PLAN_STALL_SOFT_MS, 30000)
    : PLAN_STALL_SOFT_MS;
  tab._planStallSilenceTimer = setTimeout(() => {
    tab._planStallSilenceTimer = null;
    if (!tab || tab.mode !== 'plan' || !tab.running || tab.showPostPlanActions) return;
  if (hasActiveQuestion(tab)) return;
  if (activePermissionId(tab)) return;
    if (!tab._planStallSoftFired) {
      tab._planStallSoftFired = true;
      showPlanStallSoftPrompt(tab);
      schedulePlanStallWatchdog(tab);
    } else {
      executePlanStallRecovery(tab, 'silence-auto');
    }
  }, nextDelay);

  if (!tab._planStallHardCapTimer) {
    tab._planStallHardCapTimer = setTimeout(() => {
      tab._planStallHardCapTimer = null;
      if (!tab || tab.mode !== 'plan' || !tab.running || tab.showPostPlanActions) return;
      executePlanStallRecovery(tab, 'hard-cap');
    }, PLAN_STALL_HARD_CAP_MS);
  }
}

function showPlanStallSoftPrompt(tab) {
  const container = panelEl('#ocp-messages');
  if (!container) return;
  if (tab._planStallSoftCardOpen) return;
  tab._planStallSoftCardOpen = true;
  try { removeThinking(container); } catch {}
  renderPlanStallSoftCard(container, {
    onAbort: () => {
      dismissPlanStallSoftCard(tab);
      executePlanStallRecovery(tab, 'soft-abort');
    },
    onWait: () => {
      dismissPlanStallSoftCard(tab);
      tab._planStallSoftFired = false;
      tab._lastEventAt = Date.now();
      if (tab.running) {
        showThinking(container, {
          title: 'Thinking…',
          detail: tabStatusDetail(tab),
          startedAt: tab.turnStartedAt || Date.now(),
          waiting: true,
          ...thinkingActivity(tab),
        });
      }
      schedulePlanStallWatchdog(tab);
      update();
    },
    onCancel: () => {
      dismissPlanStallSoftCard(tab);
      abortTab(tab, container);
      update();
    },
  });
  update();
}

async function executePlanStallRecovery(tab, reason) {
  if (!tab || tab.mode !== 'plan') return;
  if (tab.showPostPlanActions) return;
  clearPlanStallTimers(tab);
  dismissPlanStallSoftCard(tab);
  // extractPlanTextLoose covers the full extraction surface: existing
  // tab.planContent → ExitPlanMode tool args → todowrite todos → final
  // assistant text bubble → standalone Thought / reasoning blocks (live
  // thinking content for kimi-k2.6 etc.) → subagent (Agent/task) result.
  // Sets tab.planContent as a side effect.
  try { extractPlanTextLoose(tab); } catch {}
  console.log(`[ocp-tabs] plan-stall recovery (${reason}): captured ${tab.planContent?.length || 0} chars`);

  const live = panelEl('#ocp-messages');
  if (live) {
    const msg = reason === 'hard-cap'
      ? 'Plan mode timed out (8 min) — model did not finalize. Showing captured plan content.'
      : reason === 'soft-abort'
        ? 'Aborting stalled plan turn — showing captured plan content.'
        : 'Model went silent during plan mode — auto-finalizing with captured plan content.';
    console.warn('[ocp-tabs] plan-stall recovery:', msg);
    try { removeThinking(live); } catch {}
    try { finalizeStreamingMessage(live); } catch {}
    try { settleRunningToolCards(live, 'complete'); } catch {}
  }

  if (tab._activeSendRequestId) {
    try { rejectPending(tab._activeSendRequestId, 'Plan stall recovery'); } catch {}
    if (_activeSendRequestId === tab._activeSendRequestId) _activeSendRequestId = null;
    tab._activeSendRequestId = null;
  }
  if (tab.sessionId) {
    try { sendWs({ type: 'message:abort', sessionId: tab.sessionId }); } catch {}
  }

  tab.running = false;
  tab.turnStartedAt = 0;
  endTurn(tab);
  setTurnStatus(tab);
  clearPlanFinalizationWatchdog(tab);

  // CLI-like stall behavior: only surface PLAN COMPLETE when there's actual
  // plan content. Bare preambles ("I'm in plan mode. Let me ask…") would
  // otherwise produce a fake card that 422s on /api/create-plan. Drop force
  // so the existing prose-question + 40-char guards in maybeShowPostPlanUI
  // gate the card. ExitPlanMode-detected stalls keep force:true so a real
  // captured plan still surfaces.
  const realPlan = isRealPlanContent(tab.planContent);
  maybeShowPostPlanUI(tab, {
    source: `stall:${reason}`,
    force: tab._exitPlanDetected || realPlan,
  });
  try { notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, tab.sessionId || tab.id); } catch {}
  update();
}

// Mirrors the server-side /api/create-plan validator. Returns false for
// preamble/narration text that would 422 on the server. Used by the
// plan-stall recovery path to avoid showing a fake PLAN COMPLETE card
// when the model only emitted "I'm in plan mode. Let me ask…" before stalling.
function isRealPlanContent(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 80) return false;
  const lower = trimmed.toLowerCase();
  // Strong rejects: any thinking-block leakage anywhere in the content.
  const thinkingArtifacts = [
    'thought›',
    'thought >',
    'let me re-read',
    'let me first recall',
    'but wait',
    'wait —',
    'wait -',
    'actually, let me',
    'this seems like they want',
  ];
  if (thinkingArtifacts.some((m) => lower.includes(m))) return false;
  // Narration markers in the head — model started preamble instead of plan.
  const head = lower.slice(0, 200);
  const narrationMarkers = [
    "i'm in plan mode",
    "im in plan mode",
    "the user is in plan mode",
    "the user wants",
    "let me ask",
    "let me think",
    "let me plan",
    "let me understand",
    "before i ",
    "i need to ",
    "i'll need to",
    "i need more",
    "to plan this",
    "to test the flow",
  ];
  if (narrationMarkers.some((m) => head.includes(m))) return false;
  const hasHeading = /(^|\n)#{1,3}\s+\S/.test(trimmed);
  const hasList = /(^|\n)(?:[-*]|\d+\.)\s+\S/.test(trimmed);
  return hasHeading || hasList;
}

// Heuristic: did the captured plan content end with prose-style clarification
// questions instead of a finalized plan? Used to block premature PLAN COMPLETE
// when the model wrote questions as text instead of calling the `question`
// tool. Only the LAST ~400 chars are inspected — earlier prose-questions are
// fine if the tail is a clean ExitPlanMode-ready plan.
function looksLikeProseQuestions(content) {
  if (!content) return false;
  const tail = String(content).slice(-400);
  // "Before I proceed, a couple of quick questions:" / "Two quick questions:"
  if (/(^|\n)\s*(quick |a couple of |before i proceed,?\s*|two\s+).*?questions?:?\s*$/im.test(tail)) return true;
  // "Question 1:" / "Q2."
  if (/(^|\n)\s*(question|q)\s*\d+\s*[:.]/im.test(tail)) return true;
  // 2+ trailing question marks across last 400 chars
  const qMarks = (tail.match(/\?\s*(\n|$)/g) || []).length;
  if (qMarks >= 2) return true;
  return false;
}

// Watchdog for the kimi-for-coding/k2p6 + OpenCode 1.14.30 deadlock: POST
// /question/<id> returns 200 but session.processor never resumes — no second
// LLM stream call, no message.part.delta, no session.idle. Without this, the
// user sits in "Thinking…" until they manually Stop. After QUESTION_REPLY_WATCHDOG_MS
// of total SSE silence post-reply, abort the stuck turn and resend the answer
// as a regular `message:send` (which works fine — the bug is specific to the
// question-tool resolve path, not normal message turns). Watchdog is cleared
// in `handleSSEEvent` on any SSE event for this tab, in `abortTab`, and at the
// start of `sendMessage`.
const QUESTION_REPLY_WATCHDOG_MS = 75000;

function buildAnswerSyntheticMessage(questions, answers) {
  const fmt = (v) => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean).join(', ') : String(v ?? '').trim();
  if (typeof answers === 'string') return answers.trim();
  if (!answers || typeof answers !== 'object') return '';
  const entries = Object.entries(answers).filter(([, v]) => fmt(v));
  if (entries.length === 0) return '';
  if (entries.length === 1) return fmt(entries[0][1]);
  const lines = entries.map(([q, a]) => `- ${q}: ${fmt(a)}`);
  return `Here are my answers:\n${lines.join('\n')}`;
}

function scheduleQuestionReplyWatchdog(_tab, _syntheticMessage) {
  // Disabled — CLI behavior: model didn't resume after answering = user
  // hits Stop or waits. Server-side auto-abort handles real stalls. The
  // synthetic auto-resend created a recovery cascade that trapped the user
  // behind a fake PLAN COMPLETE.
}

function clearQuestionReplyWatchdog(tab) {
  if (tab?._questionReplyWatchdogId) {
    clearTimeout(tab._questionReplyWatchdogId);
    tab._questionReplyWatchdogId = null;
  }
  if (tab) tab._questionReplyAnswerSnapshot = null;
}

async function executeQuestionReplyRecovery(tab, syntheticMessage) {
  // sendMessage operates on activeTab(); if the user switched away while
  // waiting, switch back so the synthetic recovery lands in the right tab.
  if (tab !== activeTab()) {
    const idx = _tabs.indexOf(tab);
    if (idx >= 0) switchTab(idx);
  }
  console.warn("[ocp-tabs] question stall recovery: Model didn't resume after answering — auto-resending answer as a regular message");
  const live = panelEl('#ocp-messages');
  if (live) {
    removeThinking(live);
    finalizeStreamingMessage(live);
  }
  if (tab._activeSendRequestId) {
    try { rejectPending(tab._activeSendRequestId, 'Question stall recovery'); } catch {}
    if (_activeSendRequestId === tab._activeSendRequestId) _activeSendRequestId = null;
    tab._activeSendRequestId = null;
  }
  setActiveQuestionToolId(tab, null);
  tab.running = false;
  tab.turnStartedAt = 0;
  endTurn(tab);
  setTurnStatus(tab);
  update();
  // Await the abort so the stuck message is closed server-side before we
  // start a fresh turn — prevents a late `session.idle` from the abort
  // racing into the new turn and flipping `tab.running` back to false.
  if (tab.sessionId) {
    try { await requestWs('message:abort', { sessionId: tab.sessionId }, 5000); } catch {}
  }
  try {
    await sendMessage(syntheticMessage);
  } catch (err) {
    console.error('[ocp-tabs] question stall recovery sendMessage failed:', err);
  }
}

export function applySavedPlan(tab, content, filePath = '') {
  if (!tab || !content) return;
  tab.planContent = content;
  tab.editedPlanContent = content;
  tab.showPostPlanActions = true;
  tab.postPlanHeader = 'PLAN UPDATED';
  if (filePath) tab.planFilePath = filePath;

  const container = panelEl('#ocp-messages');
  if (container && tab === activeTab()) {
    removePostPlanCards(container);
    renderAssistantPayload(container, content, { textMode: 'render' });
    showPostPlanUI(tab, 'PLAN UPDATED');
  } else {
    saveTabs();
  }
}

// ── Send message ──
//
// The send pipeline lives in ocp-send.js. Thin proxies preserved here so
// in-file callers and ocp-panel.js consumers (which import sendMessage etc.
// from this module) keep working unchanged.

export async function sendMessage(...args) { return sendModule.sendMessage(...args); }
export function anyTabRunning() { return sendModule.anyTabRunning(); }
export async function abortMessage() { return sendModule.abortMessage(); }
function abortTab(tab, container = null) { return sendModule.abortTab(tab, container); }
export async function abortAllTabs() { return sendModule.abortAllTabs(); }
export async function injectContext(content) { return sendModule.injectContext(content); }


// ── Tool activity tracking (agents only) ──

const AGENT_TOOL_NAMES = new Set(['task', 'agent', 'Task', 'Agent']);
const AGENT_STEP_MAX = 50;

function isAgentTool(name) {
  return AGENT_TOOL_NAMES.has(String(name || ''));
}

function activityKey(tab, toolId, toolName) {
  if (toolId) return String(toolId);
  if (!tab._activitySynthIdx) tab._activitySynthIdx = 0;
  return `synth:${toolName}:${++tab._activitySynthIdx}`;
}

function findActivityEntry(tab, key) {
  if (!tab || !Array.isArray(tab.toolActivity)) return null;
  return tab.toolActivity.find(e => e.key === key) || null;
}

function parseChildSessionId(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    const meta = value.metadata || value;
    const sid = meta?.sessionId || meta?.sessionID || meta?.session_id;
    if (sid) return String(sid);
    const txt = typeof value.output === 'string'
      ? value.output
      : (typeof value.text === 'string' ? value.text : '');
    if (txt) {
      const m = txt.match(/task_id:\s*(\S+)/);
      if (m) return m[1];
    }
    return '';
  }
  if (typeof value === 'string') {
    const m = value.match(/task_id:\s*(\S+)/);
    return m ? m[1] : '';
  }
  return '';
}

function linkChildSession(tab, entry, childSid) {
  if (!tab || !entry || !childSid) return;
  if (!tab.toolActivityChildSessions) tab.toolActivityChildSessions = {};
  tab.toolActivityChildSessions[childSid] = entry.key;
  entry.childSessionId = childSid;
}

export function findAgentEntryByChildSession(tab, sessionId) {
  if (!tab || !sessionId) return null;
  const map = tab.toolActivityChildSessions;
  const key = map && map[sessionId];
  if (!key) return null;
  return findActivityEntry(tab, key);
}

export function findAgentEntryByToolId(tab, toolId) {
  if (!tab || !toolId || !Array.isArray(tab.toolActivity)) return null;
  return tab.toolActivity.find(e => e.toolId === String(toolId) && e.status === 'running') || null;
}

export function recordToolStart(tab, rawName, toolId, toolInput) {
  if (!tab) return;
  const name = String(rawName || 'tool');
  if (!isAgentTool(name)) return;
  if (!Array.isArray(tab.toolActivity)) tab.toolActivity = [];
  const key = activityKey(tab, toolId, name);
  const existing = findActivityEntry(tab, key);
  const desc = describeTool(name, toolInput) || {};
  const subagentType = String(toolInput?.subagent_type || toolInput?.agent || '').trim();
  const description = String(toolInput?.description || toolInput?.prompt || '').trim();
  const now = Date.now();
  if (existing) {
    existing.displayName = desc.displayName || existing.displayName || name;
    existing.summary = desc.summary || existing.summary || '';
    if (subagentType) existing.subagentType = subagentType;
    if (description) existing.description = description;
    existing.status = 'running';
    existing.updatedAt = now;
    return;
  }
  tab.toolActivity.push({
    key,
    toolId: toolId || '',
    rawName: name,
    displayName: desc.displayName || 'Agent',
    summary: desc.summary || '',
    subagentType,
    description,
    childSessionId: '',
    steps: [],
    activeStep: null,
    toolsUsed: 0,
    isSynaBun: false,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    endedAt: 0,
  });
  if (tab.toolActivity.length > ACTIVITY_MAX) {
    tab.toolActivity.splice(0, tab.toolActivity.length - ACTIVITY_MAX);
  }
}

export function recordToolResult(tab, rawName, toolId, toolInput, result, isError) {
  if (!tab) return;
  const name = String(rawName || 'tool');
  if (!isAgentTool(name)) return;
  if (!Array.isArray(tab.toolActivity)) tab.toolActivity = [];
  const key = activityKey(tab, toolId, name);
  const existing = findActivityEntry(tab, key);
  const desc = describeTool(name, toolInput) || {};
  const subagentType = String(toolInput?.subagent_type || toolInput?.agent || '').trim();
  const description = String(toolInput?.description || toolInput?.prompt || '').trim();
  const childSid = parseChildSessionId(result);
  const now = Date.now();
  if (existing) {
    existing.status = isError ? 'error' : 'complete';
    existing.updatedAt = now;
    existing.endedAt = now;
    existing.activeStep = null;
    if (subagentType && !existing.subagentType) existing.subagentType = subagentType;
    if (description && !existing.description) existing.description = description;
    if (childSid && !existing.childSessionId) linkChildSession(tab, existing, childSid);
    for (const step of existing.steps) {
      if (step.status === 'running') {
        step.status = 'complete';
        step.updatedAt = now;
      }
    }
    return;
  }
  const entry = {
    key,
    toolId: toolId || '',
    rawName: name,
    displayName: desc.displayName || 'Agent',
    summary: desc.summary || '',
    subagentType,
    description,
    childSessionId: '',
    steps: [],
    activeStep: null,
    toolsUsed: 0,
    isSynaBun: false,
    status: isError ? 'error' : 'complete',
    startedAt: now,
    updatedAt: now,
    endedAt: now,
  };
  tab.toolActivity.push(entry);
  if (childSid) linkChildSession(tab, entry, childSid);
}

export function recordAgentChildEvent(tab, entry, eventType, event) {
  if (!tab || !entry) return false;
  // Ignore child-session events once the user has aborted this agent.
  if (entry.status === 'aborted') return false;
  const now = Date.now();
  entry.updatedAt = now;

  if (eventType === 'tool.start' || eventType === 'message.part.updated') {
    let toolName = '';
    let toolId = '';
    let toolInput = null;
    if (eventType === 'tool.start') {
      toolName = event?.tool || event?.name || '';
      toolId = event?.toolCallId || event?.id || '';
      toolInput = event?.input || event?.args || null;
    } else {
      const part = event?.part || event;
      const ptype = String(part?.type || '').toLowerCase();
      if (!ptype.includes('tool')) return false;
      toolName = part?.tool || part?.toolName || part?.name || '';
      toolId = part?.toolCallId || part?.callID || part?.tool_use_id || part?.id || '';
      toolInput = part?.args || part?.input || null;
    }
    if (!toolName) return false;
    if (isQuestionTool(toolName)) return false;
    const desc = describeTool(toolName, toolInput) || {};
    const stepKey = String(toolId || `${toolName}:${now}`);
    const existingStep = entry.steps.find(s => s.key === stepKey);
    if (existingStep) {
      existingStep.status = 'running';
      existingStep.updatedAt = now;
      if (desc.summary && !existingStep.summary) existingStep.summary = desc.summary;
    } else {
      entry.steps.push({
        key: stepKey,
        rawName: String(toolName),
        name: desc.displayName || toolName,
        summary: desc.summary || '',
        isSynaBun: !!desc.isSynaBun,
        status: 'running',
        startedAt: now,
        updatedAt: now,
      });
      entry.toolsUsed = (entry.toolsUsed || 0) + 1;
      if (entry.steps.length > AGENT_STEP_MAX) entry.steps.splice(0, entry.steps.length - AGENT_STEP_MAX);
    }
    entry.activeStep = stepKey;
    return true;
  }

  if (eventType === 'tool.result') {
    const toolId = event?.toolCallId || event?.id || '';
    const isError = !!event?.error;
    const stepKey = String(toolId || '');
    const step = stepKey ? entry.steps.find(s => s.key === stepKey) : null;
    if (step) {
      step.status = isError ? 'error' : 'complete';
      step.updatedAt = now;
    }
    if (entry.activeStep === stepKey) entry.activeStep = null;
    return true;
  }

  if (eventType === 'session.idle'
      || (eventType === 'session.status' && (event?.status?.type || event?.type) === 'idle')) {
    for (const step of entry.steps) {
      if (step.status === 'running') {
        step.status = 'complete';
        step.updatedAt = now;
      }
    }
    entry.activeStep = null;
    // Subagent went idle. Arm a watchdog: if the parent's own terminal signal
    // doesn't fire within ~8s, render the post-plan card defensively. This is
    // the Deepseek case — child idles, parent never finalizes, no spinner but
    // dock stays "active" because parent never received the task tool result.
    schedulePlanFinalizationWatchdog(tab);
    return true;
  }
  return false;
}

function toolStatusDetail(rawName, toolInput) {
  const name = String(rawName || 'tool');
  const desc = describeTool(name, toolInput) || {};
  const display = desc.displayName || name;
  const summary = desc.summary || '';
  return summary && summary !== display ? `${display} · ${summary}` : display;
}

function activeAgentStep(tab) {
  const entries = Array.isArray(tab?.toolActivity) ? tab.toolActivity : [];
  let latest = null;
  for (const entry of entries) {
    if (entry?.status !== 'running') continue;
    const steps = Array.isArray(entry.steps) ? entry.steps : [];
    const activeKey = entry.activeStep || '';
    const active = activeKey ? steps.find((step) => step.key === activeKey && step.status === 'running') : null;
    const fallback = active || [...steps].reverse().find((step) => step.status === 'running');
    if (!fallback) continue;
    const latestAt = latest ? (latest.updatedAt || latest.startedAt || 0) : 0;
    const fallbackAt = fallback.updatedAt || fallback.startedAt || 0;
    if (!latest || fallbackAt >= latestAt) latest = fallback;
  }
  return latest;
}

function agentStepStatusDetail(step) {
  if (!step) return '';
  const name = step.name || step.rawName || 'tool';
  const summary = step.summary || '';
  return summary && summary !== name ? `${name} · ${summary}` : name;
}

function syncActingIndicator(container, tab, options = {}) {
  if (!container || !tab?.running) return;
  if (hasActiveQuestion(tab) || activePermissionId(tab)) return;
  const step = options.ignoreActiveStep ? null : activeAgentStep(tab);
  const title = options.title || (step ? 'Using tool…' : (tab.statusText || 'Thinking…'));
  const detail = options.detail !== undefined
    ? options.detail
    : (step ? agentStepStatusDetail(step) : (tab.statusDetail || tabStatusDetail(tab)));
  updateThinking(container, {
    title,
    detail,
    startedAt: tab.turnStartedAt || Date.now(),
    waiting: options.waiting !== undefined ? !!options.waiting : title !== 'Using tool…',
    ...thinkingActivity(tab),
  });
}

function syncAgentChildIndicator(container, tab, eventType, event) {
  if (!tab?.running) return;
  if (eventType === 'tool.result') {
    setTurnStatus(tab, 'Thinking…', 'Processing tool result');
    syncActingIndicator(container, tab, {
      title: 'Thinking…',
      detail: 'Processing tool result',
      waiting: true,
      ignoreActiveStep: true,
    });
    return;
  }
  if (eventType === 'session.idle'
      || (eventType === 'session.status' && (event?.status?.type || event?.type) === 'idle')) {
    setTurnStatus(tab, 'Thinking…', 'Agent completed');
    syncActingIndicator(container, tab, {
      title: 'Thinking…',
      detail: 'Agent completed',
      waiting: true,
      ignoreActiveStep: true,
    });
    return;
  }
  const step = activeAgentStep(tab);
  if (!step) return;
  const detail = agentStepStatusDetail(step);
  setTurnStatus(tab, 'Using tool…', detail);
  syncActingIndicator(container, tab, {
    title: 'Using tool…',
    detail,
  });
}

function hasToolResultValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function extractToolPartState(part) {
  const type = String(part?.type || '').trim().toLowerCase();
  const state = (part?.state && typeof part.state === 'object') ? part.state : null;
  const rawStatus = String(part?.status || state?.status || (typeof part?.state === 'string' ? part.state : '') || '').trim().toLowerCase();
  const result = part?.result
    ?? part?.output
    ?? part?.response
    ?? part?.error
    ?? state?.output
    ?? state?.result
    ?? state?.response
    ?? state?.error
    ?? ((type === 'tool_result' || type === 'tool-result' || rawStatus === 'result') ? (part?.content ?? part?.text ?? '') : undefined);
  const isError = Boolean(part?.error || state?.error || part?.success === false || rawStatus === 'error' || rawStatus === 'failed' || rawStatus === 'failure');
  const hasResult = hasToolResultValue(result);
  const isComplete = isError
    || hasResult
    || rawStatus === 'done'
    || rawStatus === 'complete'
    || rawStatus === 'completed'
    || rawStatus === 'success'
    || rawStatus === 'finished'
    || rawStatus === 'result';
  return {
    status: isError ? 'error' : (isComplete ? 'complete' : 'running'),
    isComplete,
    hasResult,
    isError,
    result,
  };
}

function settleRunningToolCards(container, status = 'complete') {
  if (!container) return;
  container.querySelectorAll('.ocp-tool-card[data-status="running"]').forEach((card) => {
    card.dataset.status = status;
    const pill = card.querySelector('.ocp-tool-pill');
    if (pill) pill.textContent = status;
  });
}

export function markStuckActivityAsAborted(tab) {
  if (!tab || !Array.isArray(tab.toolActivity)) return;
  const now = Date.now();
  for (const entry of tab.toolActivity) {
    if (entry.status === 'running') {
      entry.status = 'aborted';
      entry.updatedAt = now;
      entry.endedAt = now;
      entry.activeStep = null;
      for (const step of entry.steps || []) {
        if (step.status === 'running') {
          step.status = 'aborted';
          step.updatedAt = now;
        }
      }
    }
  }
}

export function setActivityVisible(tab, visible) {
  if (!tab) return;
  tab.toolActivityVisible = !!visible;
  storage.setItem(STOR.activity, visible ? '1' : '0');
  update();
}

export function toggleActivityExpanded(tab, key) {
  if (!tab || !key) return;
  if (!tab.toolActivityExpanded) tab.toolActivityExpanded = {};
  tab.toolActivityExpanded[key] = !tab.toolActivityExpanded[key];
  update();
}

export function abortAgent(tab, key) {
  if (!tab || !key || !Array.isArray(tab.toolActivity)) return false;
  const entry = tab.toolActivity.find(e => e.key === key);
  if (!entry || entry.status !== 'running') return false;
  const childSid = entry.childSessionId;
  if (childSid) {
    try { sendWs({ type: 'message:abort', sessionId: childSid }); } catch {}
  }
  const now = Date.now();
  entry.status = 'aborted';
  entry.updatedAt = now;
  entry.endedAt = now;
  entry.activeStep = null;
  for (const step of entry.steps || []) {
    if (step.status === 'running') {
      step.status = 'aborted';
      step.updatedAt = now;
    }
  }
  update();
  return true;
}

// ── SSE Event handling ──

function isIdleEvent(eventType, event) {
  return eventType === 'session.idle'
    || (eventType === 'session.status' && (event?.status?.type || event?.type) === 'idle');
}

function handleBackgroundEvent(tab, eventType, event) {
  if (!tab) return;
  tab._needsHistoryRefresh = true;
  if (eventType === 'message.updated') {
    const info = event.info || event;
    const mid = info.id || event.messageID;
    if (info.role === 'user') {
      if (mid) {
        userMsgIds(tab).add(mid);
        _userMsgIds.add(mid);
      }
    } else if (info.tokens || info.usage) {
      const raw = info.tokens || info.usage || {};
      tab.threadTokenUsage = normalizeThreadTokenUsage(raw);
      tab.inputTokens = raw.input || raw.inputTokens || raw.input_tokens || 0;
      tab.outputTokens = raw.output || raw.outputTokens || raw.output_tokens || 0;
      if (mid) markAssistantRendered(tab, mid);
    }
  } else if (eventType === 'session.updated') {
    if (event.session?.title || event.title) {
      const sid = event.session?.id || event.sessionID || event.sessionId || tab.sessionId;
      updateSessionTitleState(sid, event.session?.title || event.title);
      renderPills();
      saveTabs();
    }
  } else if (isIdleEvent(eventType, event)) {
    tab.running = false;
    tab.turnStartedAt = 0;
    endTurn(tab);
    setTurnStatus(tab);
    markStuckActivityAsAborted(tab);
    clearPlanFinalizationWatchdog(tab);
    // CLI parity: PLAN COMPLETE only surfaces when the model actually called
    // the ExitPlanMode tool. A plain session.idle in plan mode means the
    // model finished its turn without finalizing — just like the CLI, just
    // return to the prompt. No fake card, no trap.
    notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, tab.sessionId || tab.id);
  } else if (eventType === 'session.error' || eventType === 'error') {
    const isAutoAbort = event.reason === 'auto-abort';
    tab.running = false;
    tab.turnStartedAt = 0;
    endTurn(tab);
    setTurnStatus(tab, isAutoAbort ? '' : 'Error', '');
    if (!isAutoAbort) {
      notifyOpenCodeOutcome(NOTIF_TYPE.ERROR, tab, event.id || event.messageID || tab.sessionId || tab.id);
    }
  }
  update();
}

export function handleSSEEvent(eventType, event) {
  // session.created for a child (subagent) session — link it to the parent's
  // running task entry so subsequent child events route to the activity card.
  if (eventType === 'session.created') {
    const child = event?.session || event?.info || event;
    const childSid = child?.id || child?.sessionID || child?.sessionId || '';
    const parentSid = child?.parentID || child?.parentId || child?.parent_id || '';
    if (childSid && parentSid) {
      const parentTab = findTabBySessionId(parentSid);
      if (parentTab) {
        const entry = (parentTab.toolActivity || []).find(
          e => e.status === 'running' && isAgentTool(e.rawName) && !e.childSessionId,
        );
        if (entry) linkChildSession(parentTab, entry, childSid);
      }
    }
    return;
  }

  const normalized = normalizeSdkEventForLegacy(eventType, event);
  if (normalized) {
    eventType = normalized.eventType;
    event = normalized.event;
  }

  // Native OpenCode question/permission events are module-owned. Let the
  // router consume those before the legacy renderer can create duplicate or
  // non-replyable cards.
  if (eventsModule.routeSdkEvent(eventType, event) === false) return;

  let tab = eventSessionId(event) ? findTabBySessionId(eventSessionId(event)) : activeTab();
  if (!tab) tab = activeTab();
  if (!tab) return;

  // Mark recent SSE activity so a stale `message:send` WS timeout can be
  // distinguished from a truly dead session (sendMessage uses this to suppress
  // the red error toast when SSE is still streaming).
  tab._lastEventAt = Date.now();
  // Heartbeats/keepalives prove the SSE pipe is alive but the model is NOT
  // producing output — they must NOT bump the thinking pulse, otherwise a
  // stalled turn looks fresh forever while the upstream LLM has actually died.
  const isNoopEvent = eventType === 'heartbeat' || eventType === 'ping' || eventType === 'keepalive' || eventType === 'message';
  if (!isNoopEvent) {
    tab._lastEventName = eventType;
    tab._eventCount = (tab._eventCount || 0) + 1;
    if (tab === activeTab()) {
      const _ctr = panelEl('#ocp-messages');
      if (_ctr) bumpThinkingActivity(_ctr, eventType);
    }
  }
  // Only clear the post-question watchdog on events that prove the model
  // actually resumed (streaming delta, assistant update, tool activity,
  // or terminal events). The mere `question.replied` confirmation does NOT
  // mean the LLM resumed — without this guard the watchdog is cancelled
  // prematurely and the turn hangs forever.
  if (
    eventType === 'message.part.delta' ||
    eventType === 'message.part.updated' ||
    eventType === 'message.updated' ||
    eventType === 'message.completed' ||
    eventType === 'session.idle' ||
    eventType === 'session.status' ||
    eventType === 'tool.start' ||
    eventType === 'tool.result'
  ) {
    clearQuestionReplyWatchdog(tab);
  }
  // Re-arm the plan-mode stall silence timer on every SSE event. The hard-cap
  // timer (set once per turn in sendMessage) is left untouched.
  if (tab.mode === 'plan' && tab.running && !tab.showPostPlanActions) {
    schedulePlanStallWatchdog(tab);
  }

  const isActiveTab = tab === activeTab();
  const container = isActiveTab ? panelEl('#ocp-messages') : null;

  // Filter events to current session (OpenCode uses sessionID). When the active
  // tab has no sessionId yet (freshly created via "+"), drop any session-scoped
  // event so the still-running previous session doesn't render into it.
  const eventSid = eventSessionId(event);
  const isAgentEvent = (eventType === 'tool.start' || eventType === 'tool.result' || eventType === 'message.part.updated');
  const isAgentLifecycleEvent = eventType === 'session.idle' || eventType === 'session.status';

  // Helper to extract toolId from event or its part field
  function extractToolId(evt) {
    return evt?.toolCallId || evt?.id ||
      (evt?.part ? (evt.part?.toolCallId || evt.part?.callID || evt.part?.tool_use_id || evt.part?.id) : '');
  }

  // Route agent tool events to the running agent entry by toolId — events may arrive
  // under the parent session ID even when they're for the child agent's tool loop.
  if (isAgentEvent) {
    const toolId = extractToolId(event);
    if (toolId) {
      const agentEntry = findAgentEntryByToolId(tab, toolId);
      if (agentEntry && recordAgentChildEvent(tab, agentEntry, eventType, event)) {
        if (container) syncAgentChildIndicator(container, tab, eventType, event);
        update();
        return;
      }
    }
    // eventSid is falsy or matches tab.sessionId — fall through to normal switch
  }
  if (eventSid && eventSid !== tab.sessionId) {
    // Route tracked child-agent events, then drop all other session-scoped
    // events so another OpenCode session cannot mutate the active render area.
    if (isAgentEvent || isAgentLifecycleEvent) {
      const agentEntry = findAgentEntryByChildSession(tab, eventSid);
      if (agentEntry && recordAgentChildEvent(tab, agentEntry, eventType, event)) {
        if (container) syncAgentChildIndicator(container, tab, eventType, event);
        update();
        return;
      }
    }
    return;
  }

  if (!container) {
    handleBackgroundEvent(tab, eventType, event);
    return;
  }

  switch (eventType) {
    // Message updated — fires for both user and assistant messages
    case 'message.updated': {
      const info = event.info || event;
      // Track user messages so their parts don't echo in the chat
      if (info.role === 'user') {
        const mid = info.id || event.messageID;
        if (mid) {
          userMsgIds(tab).add(mid);
          _userMsgIds.add(mid);
        }
        break;
      }
      // Guard: once we've rendered this assistant message's final payload, ignore
      // re-emitted message.updated events (OpenCode on Windows sometimes fires a
      // late duplicate after finalize, which would otherwise re-stream the whole
      // response into a brand-new assistant bubble).
      const assistantMid = info.id || event.messageID;
      if (assistantMid && hasAssistantRendered(tab, assistantMid)) {
        update();
        break;
      }
      // If no streaming element was built by prior deltas, render the
      // assistant's content directly from the event (non-streaming path)
      const hasStreaming = container.querySelector('.ocp-msg-assistant.streaming');
      const status = String(info.status || info.state || '').toLowerCase();
      const explicitTerminal = ['done', 'complete', 'completed', 'finished', 'success'].includes(status);
      const hasToolCards = !!container.querySelector('.ocp-tool-card');
      // 'merge' (vs the previous 'skip') augments the streaming bubble with
      // any missing thinking/text from this payload. 'skip' silently dropped
      // text segments from message.updated when a thinking-only streaming
      // bubble existed — see ocp-render.js renderAssistantPayload merge mode.
      const rendered = renderAssistantPayload(container, info.content ?? info.parts ?? info.text ?? '', {
        textMode: hasStreaming ? 'merge' : 'stream',
      });
      if (rendered && !hasStreaming && payloadHasAssistantText(info.content ?? info.parts ?? info.text ?? '')) {
        markCurrentTurnAssistantContent(tab, container, assistantMid);
      }
      // Only finalize on a terminal signal (tokens/usage/explicitTerminal) or when
      // we just rendered fallback content. Mid-turn message.updated events with no
      // payload would otherwise strip the .streaming class while part.updated
      // events are still streaming the reasoning/text bubble — causing later
      // setStreamRawText calls to spawn a duplicate sibling bubble.
      const hasTerminalSignal = explicitTerminal || info.tokens || info.usage || info?.time?.completed;
      if (rendered || (hasTerminalSignal && (hasToolCards || hasStreaming))) {
        removeThinking(container);
        finalizeStreamingMessage(container);
        partTypes(tab).clear();
        // Only mark the ID as rendered at the terminal signal (tokens/usage
        // arrived or status is explicitly terminal). Mid-turn message.updated
        // events may fire before streaming starts and shouldn't lock out later
        // part.delta / part.updated events.
        if (assistantMid && hasTerminalSignal) {
          markAssistantRendered(tab, assistantMid);
        }
        if (info.tokens || info.usage) {
          const raw = info.tokens || info.usage || {};
          tab.threadTokenUsage = normalizeThreadTokenUsage(raw);
          tab.inputTokens = raw.input || raw.inputTokens || raw.input_tokens || 0;
          tab.outputTokens = raw.output || raw.outputTokens || raw.output_tokens || 0;
        }
        // Do NOT clear tab.running / turnStartedAt / status here.
        // message.updated fires mid-turn during agentic tool loops; clearing
        // running here hides the Stop button while OpenCode is still working.
        // Authoritative end-of-turn: session.idle, session.status:idle, or the
        // synchronous POST /message response returning.
        syncActingIndicator(container, tab);
      } else if (tab.running) {
        setTurnStatus(tab, 'Waiting for response…', tabStatusDetail(tab));
        syncActingIndicator(container, tab, {
          title: 'Waiting for response…',
          detail: tabStatusDetail(tab),
          waiting: true,
        });
      }
      update();
      break;
    }
    // Streaming text delta — the primary streaming event from OpenCode
    case 'message.part.delta': {
      if (userMsgIds(tab).has(event.messageID) || _userMsgIds.has(event.messageID)) break; // skip user message echoes
      // Skip deltas for assistant messages already finalized (late echoes).
      if (event.messageID && hasAssistantRendered(tab, event.messageID)) break;
      if (event.delta) {
        const partType = String(event.part?.type || event.partType || partTypes(tab).get(event.partID) || '').trim().toLowerCase();
        const isReasoning = partType === 'reasoning' || partType === 'thinking' || partType === 'thought';
        if (isReasoning) {
          appendThinkChunk(container, event.delta);
          setTurnStatus(tab, 'Thinking…', tabStatusDetail(tab));
        } else {
          appendStreamChunk(container, event.delta);
          markCurrentTurnAssistantContent(tab, container, event.messageID || '');
          setTurnStatus(tab, 'Writing response…', tabStatusDetail(tab));
        }
        if (tab.running) repositionThinking(container);
        // Coalesced chrome refresh — running update() per token would repaint
        // the entire panel header on every delta and stall the stream.
        scheduleStreamUpdate();
      }
      break;
    }
    // Part updated — full part state (text finalized, tool state change, etc.)
    case 'message.part.updated': {
      const part = event.part || event;
      if (userMsgIds(tab).has(part.messageID) || _userMsgIds.has(part.messageID)) break; // skip user message echoes
      const updatedType = String(part?.type || '').trim().toLowerCase();
      // Track part type so message.part.delta can look it up by partID
      if (part.id && updatedType) partTypes(tab).set(part.id, updatedType);
      if (updatedType === 'reasoning' || updatedType === 'thinking' || updatedType === 'thought') {
        // Live capture (plan mode): if the model emits its plan output as a
        // reasoning part rather than a text part, cache it on the tab so the
        // Edit-plan flow can find it after the post-plan card shows.
        if (tab.mode === 'plan') {
          const incoming = String(part?.text || part?.reasoning || part?.content || '').trim();
          if (incoming.length > (tab.planContent?.length || 0)) {
            tab.planContent = incoming;
          }
        }
        const partMsgId = part.messageID || part.messageId;
        if (!(partMsgId && hasAssistantRendered(tab, partMsgId))) {
          const fullText = String(part?.text || part?.reasoning || part?.content || '');
          if (fullText) {
            setStreamThinkText(container, fullText);
            // Don't mark turn as having assistant content yet — reasoning alone
            // shouldn't suppress POST-response fallback rendering of the text part.
          }
        }
        setTurnStatus(tab, 'Thinking…', tabStatusDetail(tab));
        scheduleStreamUpdate();
      } else if (updatedType === 'text') {
        // Live capture for the Edit-plan flow: cache the streamed text on the
        // tab so post-plan extraction has authoritative content even when the
        // bubble was rendered into a Thought/reasoning block elsewhere.
        if (tab.mode === 'plan') {
          const incoming = String(part?.text || part?.content || '').trim();
          if (incoming.length > (tab.planContent?.length || 0)) {
            tab.planContent = incoming;
          }
        }
        const partMsgId = part.messageID || part.messageId;
        if (!(partMsgId && hasAssistantRendered(tab, partMsgId))) {
          const fullText = String(part?.text || part?.content || '');
          if (fullText) {
            setStreamRawText(container, fullText);
            markCurrentTurnAssistantContent(tab, container, partMsgId || '');
          }
        }
        setTurnStatus(tab, 'Writing response…', tabStatusDetail(tab));
        if (tab.running) {
          updateThinking(container, {
            title: 'Writing response…',
            detail: tabStatusDetail(tab),
            startedAt: tab.turnStartedAt || Date.now(),
            ...thinkingActivity(tab),
          });
        }
        scheduleStreamUpdate();
      } else if (String(part?.type || '').toLowerCase().includes('tool')) {
        const toolName = part.tool || part.toolName || part.name || 'tool';
        const toolId = part.toolCallId || part.callID || part.tool_use_id || part.id || '';
        const toolInput = part.args || part.input || part.arguments || {};

        if (isQuestionTool(toolName)) {
          tab._questionToolUsedThisTurn = true;
          // OpenCode emits a dedicated question.asked SSE event with the full question
          // payload; the interactive card is rendered from that handler. Suppress the
          // raw tool card here so we don't show a "running" placeholder alongside it.
          if (hasActiveQuestion(tab)) {
            removeThinking(container);
            setTurnStatus(tab, 'Waiting for input…', 'Question');
          }
          update();
          break;
        }

        // Plan exit detection (modern SSE path) — single source of truth via
        // ocp-plan.js. The plan module locks tab.planContent so this can't
        // race with the legacy tool.start path or the DOM cascade.
        if (tab.mode === 'plan' && planModule.detectExitPlan(toolName)) {
          planModule.onToolStart(tab, { toolName, input: toolInput });
          planModule.armWatchdog(tab);
        }

        const toolState = extractToolPartState(part);
        renderToolCard(container, toolName, toolInput, toolId, {
          status: toolState.status,
          result: toolState.hasResult || toolState.isError ? toolState.result : undefined,
          isError: toolState.isError,
        });

        if (toolState.isComplete) {
          recordToolResult(tab, toolName, toolId, toolInput, toolState.result, toolState.isError);
        } else {
          recordToolStart(tab, toolName, toolId, toolInput);
        }
        // Fallback: link child session id from task tool's part.state.metadata
        // when session.created didn't arrive first.
        if (!toolState.isComplete && isAgentTool(toolName)) {
          const childSidFromPart = part?.state?.metadata?.sessionId
            || part?.state?.metadata?.sessionID
            || part?.metadata?.sessionId
            || '';
          if (childSidFromPart) {
            const entry = findAgentEntryByToolId(tab, toolId);
            if (entry && !entry.childSessionId) linkChildSession(tab, entry, String(childSidFromPart));
          }
        }
        const detail = toolStatusDetail(toolName, toolInput);
        if (tab.running && toolState.isComplete) {
          setTurnStatus(tab, 'Thinking…', 'Processing tool result');
          syncActingIndicator(container, tab, {
            title: 'Thinking…',
            detail: 'Processing tool result',
            waiting: true,
            ignoreActiveStep: true,
          });
        } else if (tab.running) {
          setTurnStatus(tab, 'Using tool…', detail);
          syncActingIndicator(container, tab, {
            title: 'Using tool…',
            detail,
          });
        }
        update();
      }
      break;
    }
    case 'message.part.removed': {
      break;
    }
    // Legacy event names (keep for backwards compatibility)
    case 'message.part.completed': {
      finalizeStreamingMessage(container);
      break;
    }
    case 'message.completed': {
      removeThinking(container);
      const completedMid = event.messageID || event.id;
      if (completedMid && hasAssistantRendered(tab, completedMid)) {
        settleRunningToolCards(container, 'complete');
        tab.running = false;
        tab.turnStartedAt = 0;
        endTurn(tab);
        setTurnStatus(tab);
        clearPlanFinalizationWatchdog(tab);
        if (tab.mode === 'plan' && !tab.showPostPlanActions) {
          maybeShowPostPlanUI(tab, { source: 'message.completed:rendered', force: tab._exitPlanDetected });
        }
        update();
        break;
      }
      // Fallback: render content if no streaming element was built.
      // 'merge' augments an existing streaming bubble with any missing
      // thinking/text — preserves SSE-streamed content while recovering
      // anything that didn't make it through (Kimi K2.6 et al).
      const hasStreamingLegacy = container.querySelector('.ocp-msg-assistant.streaming');
      renderAssistantPayload(container, event.content ?? event.parts ?? event.text ?? '', {
        textMode: hasStreamingLegacy ? 'merge' : 'stream',
      });
      if (!hasStreamingLegacy) markCurrentTurnAssistantContent(tab, container, completedMid || '');
      finalizeStreamingMessage(container);
      settleRunningToolCards(container, 'complete');
      partTypes(tab).clear();
      if (completedMid) markAssistantRendered(tab, completedMid);
      tab.running = false;
      tab.turnStartedAt = 0;
      endTurn(tab);
      setTurnStatus(tab);
      if (event.usage) {
        const raw = event.usage || {};
        tab.threadTokenUsage = normalizeThreadTokenUsage(raw);
        tab.inputTokens = raw.inputTokens || raw.input_tokens || raw.input || 0;
        tab.outputTokens = raw.outputTokens || raw.output_tokens || raw.output || 0;
      }
      notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, event.messageID || event.id || tab.sessionId || tab.id);
      clearPlanFinalizationWatchdog(tab);
      if (tab.mode === 'plan' && !tab.showPostPlanActions) {
        maybeShowPostPlanUI(tab, { source: 'message.completed:fallback', force: tab._exitPlanDetected });
      }
      update();
      break;
    }
    case 'tool.start': {
      const toolName = event.tool || event.name || 'tool';
      const toolId = event.toolCallId || event.id || '';
      const toolInput = event.input || event.args || {};

      if (isQuestionTool(toolName)) {
        tab._questionToolUsedThisTurn = true;
        // If a question is already active for THIS tab, queue this one for
        // later. Per-tab queue so concurrent OpenCode tabs don't interleave.
        if (hasActiveQuestion(tab)) {
          queueQuestion(tab, { event, tab, toolName, toolId, toolInput });
          update();
          break;
        }
        removeThinking(container);
        setActiveQuestionToolId(tab, toolId);
        renderQuestionCard(container, toolName, toolInput, toolId, {
          onAnswer: (answers) => {
            lockQuestionCard(container, toolId);
            // Format batched answers as structured text
            if (typeof answers === 'string') {
              sendMessage(answers, { force: true, clearQueue: false }).then(() => processQuestionQueue(tab, container));
            } else if (answers && typeof answers === 'object') {
              const entries = Object.entries(answers);
              if (entries.length === 1) {
                sendMessage(entries[0][1], { force: true, clearQueue: false }).then(() => processQuestionQueue(tab, container));
              } else {
                const lines = entries.map(([q, a]) => `- ${q}: ${a}`);
                sendMessage(`Here are my answers:\n${lines.join('\n')}`, { force: true, clearQueue: false }).then(() => processQuestionQueue(tab, container));
              }
            }
          },
        });
        setTurnStatus(tab, 'Waiting for input…', 'Question');
        const notifState = ensureNotifState(tab);
        const questionKey = String(toolId || `${toolName}:${event.messageID || tab.sessionId || tab.id}`);
        if (notifState && !notifState.questionIds.has(questionKey)) {
          notifState.questionIds.add(questionKey);
          notifyOpenCode(NOTIF_TYPE.ASK, tab);
        }
        update();
        break;
      }

      renderToolCard(container, toolName, toolInput, toolId, { status: 'running' });
      recordToolStart(tab, toolName, toolId, toolInput);
      // Fallback: link child session id from tool.start metadata when
      // session.created didn't arrive first (parent task → child session).
      if (isAgentTool(toolName)) {
        const childSidFromEvent = event?.metadata?.sessionId
          || event?.metadata?.sessionID
          || event?.state?.metadata?.sessionId
          || '';
        if (childSidFromEvent) {
          const entry = findAgentEntryByToolId(tab, toolId);
          if (entry && !entry.childSessionId) linkChildSession(tab, entry, String(childSidFromEvent));
        }
      }
      // Plan exit detection — Anthropic models call ExitPlanMode/plan_exit.
      // The plan text lives on the tool input (input.plan), not in the assistant
      // message bubble — capture it so the Edit-plan handler has content to work
      // with even when the assistant produced no separate prose. DEFER
      // showPostPlanUI to the terminal event so continuation text can't slip in
      // below the card.
      if (tab.mode === 'plan' && planModule.detectExitPlan(toolName)) {
        // Single capture+lock+detect path. Replaces the old triple-write to
        // tab._exitPlanDetected / tab.planContent / capturePlanContent and the
        // 5s watchdog re-arm. The plan module's tiered watchdog handles stalls.
        planModule.onToolStart(tab, { toolName, input: toolInput });
        planModule.armWatchdog(tab);
      }
      // OpenCode's Plan agent often communicates the plan via a `todowrite`
      // (Tasks) tool call instead of a final assistant text bubble — each
      // todo IS a plan step. Synthesize markdown from the todos array.
      if (tab.mode === 'plan' && /^(todo[_-]?write|tasks?|todos?)$/i.test(toolName)) {
        const todos = Array.isArray(toolInput?.todos) ? toolInput.todos : [];
        if (todos.length) {
          const planMd = todosToMarkdown(todos);
          if (planMd && planMd.length > (tab.planContent?.length || 0)) {
            tab.planContent = planMd;
          }
        }
      }
      const detail = toolStatusDetail(toolName, toolInput);
      setTurnStatus(tab, 'Using tool…', detail);
      syncActingIndicator(container, tab, {
        title: 'Using tool…',
        detail,
      });
      update();
      break;
    }
    case 'tool.result': {
      const toolName = event.tool || event.name || 'tool';
      const toolId = event.toolCallId || event.id || '';

      if (isQuestionTool(toolName)) {
        lockQuestionCard(container, toolId);
        break;
      }

      // Soft-fail tool denials in plan mode: when the server rejects a write
      // tool (Edit/Write/Patch/Bash) because plan mode forbids it, render the
      // card as a neutral "skipped" tile rather than a red error so the user
      // doesn't read the rejection as a regression.
      const errStr = String(event.error || '').toLowerCase();
      const isPlanDenial = tab.mode === 'plan'
        && !!event.error
        && /permission|not allowed|forbidden|read[- ]?only|disabled|disallow|file_edit|edit not|write not|patch not|bash not/i.test(errStr);

      updateToolCard(
        container,
        toolId,
        isPlanDenial ? 'Skipped — plan mode is read-only.' : (event.result ?? event.output ?? event.error ?? ''),
        isPlanDenial ? false : !!event.error,
        {
          status: isPlanDenial ? 'complete' : (event.error ? 'error' : 'complete'),
          toolName,
          toolInput: event.input ?? event.args,
        }
      );
      recordToolResult(tab, toolName, toolId, event.input ?? event.args, event.result ?? event.output ?? event.error, !!event.error);
      if (tab.running) {
        setTurnStatus(tab, 'Thinking…', 'Processing tool result');
        syncActingIndicator(container, tab, {
          title: 'Thinking…',
          detail: 'Processing tool result',
          waiting: true,
          ignoreActiveStep: true,
        });
        update();
      }
      break;
    }
    case 'session.updated': {
      if (event.session?.title || event.title) {
        const sid = event.session?.id || event.sessionID || event.sessionId || tab.sessionId;
        updateSessionTitleState(sid, event.session?.title || event.title);
        renderPills();
        saveTabs();
        update();
      }
      break;
    }
    case 'session.status': {
      const statusType = event.status?.type || event.type || '';
      if (statusType === 'idle') {
        finalizeStreamingMessage(container);
        settleRunningToolCards(container, 'complete');
        tab.running = false;
        tab.turnStartedAt = 0;
        endTurn(tab);
        setTurnStatus(tab);
        removeThinking(container);
        markStuckActivityAsAborted(tab);
        clearPlanFinalizationWatchdog(tab);
        // Single render funnel — covers both ExitPlanMode (deferred from tool
        // detection) and OpenCode plan agents that don't call ExitPlanMode.
        // maybeShowPostPlanUI no-ops if the card is already visible.
        if (tab.mode === 'plan' && !tab.showPostPlanActions) {
          maybeShowPostPlanUI(tab, { source: 'session.status:idle', force: tab._exitPlanDetected });
        }
        notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, tab.sessionId || tab.id);
        reconcileMissingAssistantText(tab, container);
      }
      update();
      break;
    }
    case 'session.idle': {
      finalizeStreamingMessage(container);
      settleRunningToolCards(container, 'complete');
      tab.running = false;
      tab.turnStartedAt = 0;
      endTurn(tab);
      setTurnStatus(tab);
      removeThinking(container);
      markStuckActivityAsAborted(tab);
      clearPlanFinalizationWatchdog(tab);
      if (tab.mode === 'plan' && !tab.showPostPlanActions) {
        maybeShowPostPlanUI(tab, { source: 'session.idle', force: tab._exitPlanDetected });
      }
      notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, tab.sessionId || tab.id);
      reconcileMissingAssistantText(tab, container);
      update();
      break;
    }
    case 'question.asked': {
      const reqId = event.id || event.requestID || '';
      if (!reqId) break;
      tab._questionToolUsedThisTurn = true;
      if (hasActiveQuestion(tab)) {
        queueQuestion(tab, { eventType, event, tab, reqId });
        update();
        break;
      }
      renderOpencodeQuestion(tab, container, event, reqId);
      break;
    }
    case 'question.replied': {
      const reqId = event.requestID || event.id || '';
      if (reqId) lockQuestionCard(container, reqId);
      // Do NOT clear activeQuestionToolId here — the WS reply handler is
      // responsible for restoring Thinking and arming the no-resume watchdog.
      break;
    }
    case 'question.rejected': {
      const reqId = event.requestID || event.id || '';
      if (reqId) lockQuestionCard(container, reqId);
      if (activeQuestionToolId(tab) === reqId) {
        setActiveQuestionToolId(tab, null);
        processQuestionQueue(tab, container);
      }
      break;
    }
    case 'permission.asked':
    case 'permission.updated': {
      const permId = event.id || event.permissionID || '';
      if (!permId) break;
      const status = String(event.status || event.state || '').toLowerCase();
      if (status === 'replied' || status === 'resolved' || status === 'approved' || status === 'rejected') {
        lockPermissionCard(container, permId);
        if (activePermissionId(tab) === permId) setActivePermissionId(tab, null);
        break;
      }
      if (activePermissionId(tab) === permId) break;
      renderOpencodePermission(tab, container, event, permId);
      break;
    }
    case 'permission.replied': {
      const permId = event.id || event.permissionID || '';
      if (permId) lockPermissionCard(container, permId);
      // Leave activePermissionId to the WS success handler so Thinking
      // is restored and the no-resume watchdog stays armed.
      break;
    }
    case 'permission.rejected': {
      const permId = event.id || event.permissionID || '';
      if (permId) lockPermissionCard(container, permId);
      if (activePermissionId(tab) === permId) setActivePermissionId(tab, null);
      break;
    }
    case 'session.error':
    case 'error': {
      removeThinking(container);
      const err = event.error || event;
      const msg = (typeof err === 'string') ? err
        : err?.data?.message || err?.message || (typeof err?.error === 'string' ? err.error : null)
          || JSON.stringify(err);
      const isAutoAbort = event.reason === 'auto-abort';
      if (isAutoAbort) {
        console.warn('[ocp-tabs] auto-abort:', msg);
      } else {
        renderErrorMessage(container, msg);
      }
      settleRunningToolCards(container, 'error');
      tab.running = false;
      tab.turnStartedAt = 0;
      endTurn(tab);
      setTurnStatus(tab, isAutoAbort ? '' : 'Error', isAutoAbort ? '' : msg);
      if (!isAutoAbort) {
        notifyOpenCodeOutcome(NOTIF_TYPE.ERROR, tab, event.id || event.messageID || tab.sessionId || tab.id);
      }
      clearPlanFinalizationWatchdog(tab);
      if (tab.mode === 'plan' && !tab.showPostPlanActions && !isAutoAbort) {
        maybeShowPostPlanUI(tab, { source: 'session.error', forceRecapture: true, force: tab._exitPlanDetected });
      }
      update();
      break;
    }
  }
}

// Render an OpenCode /question.asked event as an interactive card and wire up
// reply/reject via the dedicated /question endpoint.
function renderOpencodeQuestion(tab, container, event, requestID) {
  return questionsModule.renderOpencodeQuestion(tab, container, event, requestID);
}

// Render an OpenCode /permission.asked event as an interactive card with
// Allow once / Always allow / Reject buttons. Posts reply via WS proxy.
function renderOpencodePermission(tab, container, event, permissionID) {
  setActivePermissionId(tab, permissionID);
  const sessionID = event.sessionID || event.sessionId || tab?.sessionId || '';

  // OpenCode Permission.Request schema: { id, sessionID, permission, patterns[], metadata, always[], tool?:{messageID,callID} }
  // `event.permission` is the type STRING (e.g. "bash"); older envelopes nest the object under `event.permission`.
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

  const targetHtml = info.target
    ? `<div class="ocp-permission-target"><code>${escHtml(info.target)}</code></div>`
    : '';
  const patternsHtml = (info.patternsOut && info.patternsOut.length)
    ? `<div class="ocp-permission-patterns"><span class="ocp-permission-patterns-label">Matches</span>${info.patternsOut.map(p => `<code>${escHtml(p)}</code>`).join('')}</div>`
    : '';
  const diffHtml = info.diff
    ? `<details class="ocp-permission-diff"><summary>Show diff</summary><pre>${escHtml(info.diff)}</pre></details>`
    : '';

  card.innerHTML = `
    <div class="ocp-permission-head">
      <span class="ocp-permission-icon">${info.icon}</span>
      <span class="ocp-permission-head-text">
        <span class="ocp-permission-kind">${escHtml(info.kind)}</span>
        <span class="ocp-permission-action">${escHtml(info.action)}</span>
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
    requestWs('permission:respond', { sessionID, permissionID, response }, 15000)
      .then((resp) => {
        if (activePermissionId(tab) === permissionID) setActivePermissionId(tab, null);
        if (!resp?.status || resp.status < 400) {
          setTurnStatus(tab, 'Thinking…', tabStatusDetail(tab));
          showThinking(container, {
            title: 'Thinking…',
            detail: tabStatusDetail(tab),
            startedAt: Date.now(),
            waiting: true,
            ...thinkingActivity(tab),
          });
        }
      })
      .catch((err) => {
        console.error('[ocp-tabs] permission:respond failed:', err);
        card.dataset.locked = '';
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      });
  };

  card.querySelectorAll('button[data-response]').forEach(btn => {
    btn.addEventListener('click', () => respond(btn.dataset.response));
  });

  container.appendChild(card);
  setTurnStatus(tab, 'Waiting for permission…', `${info.kind}: ${info.action}`);
  const notifState = ensureNotifState(tab);
  if (notifState && !notifState.questionIds.has(`perm:${permissionID}`)) {
    notifState.questionIds.add(`perm:${permissionID}`);
    notifyOpenCode(NOTIF_TYPE.ASK, tab);
  }
  update();
}

// Build display info for a permission request from OpenCode's native schema.
// Pulls command/file/url from metadata or patterns; falls back to tool card text for bash.
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
    // Bash metadata is empty in OpenCode — try to read the actual command from the tool card by callID.
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
  // Unknown permission type — show the raw type + first pattern.
  const kind = permType ? permType.charAt(0).toUpperCase() + permType.slice(1) : 'Tool';
  return {
    icon, kind, action: 'Requires your approval',
    target: firstPattern,
    patternsOut: patterns.length > 1 ? patterns.slice(1) : [],
    diff: '',
  };
}

// Look up the tool card by its callID and extract the arguments text (command for Bash).
function readToolCommand(container, callID) {
  if (!container || !callID) return '';
  const cards = container.querySelectorAll('.ocp-tool-card');
  for (const card of cards) {
    if (card.dataset.toolId !== callID) continue;
    const args = card.querySelector('.ocp-tool-args');
    if (args && args.textContent) {
      // args is JSON like {"command":"..."} — try parsing to get command field.
      try {
        const parsed = JSON.parse(args.textContent);
        if (parsed?.command) return String(parsed.command);
      } catch { /* not JSON — fall through */ }
      return args.textContent.trim();
    }
    const summary = card.querySelector('.ocp-tool-summary');
    if (summary && summary.textContent) return summary.textContent.trim();
  }
  return '';
}

function lockPermissionCard(container, permissionID) {
  const card = container.querySelector(`.ocp-permission-card[data-permission-id="${CSS.escape(String(permissionID))}"]`);
  if (!card) return;
  card.dataset.locked = '1';
  card.querySelectorAll('button').forEach(b => { b.disabled = true; });
}

// Convert the question card's answer payload (string | {questionText: answerString})
// into OpenCode's expected shape: { answers: string[][] } with one string[] per question.
function buildQuestionReplyPayload(questions, answers) {
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

// ── Provider/model management ──

export async function loadProviders() {
  try {
    const resp = await requestWs('providers:full');
    const raw = resp.data;
    _providers = raw?.all || (Array.isArray(raw) ? raw : []);
    _connectedProviders = new Set(raw?.connected || []);
    update();
  } catch (e) {
    console.error('[ocp-tabs] loadProviders failed:', e);
  }
}

function agentName(entry) {
  return String(entry?.name || entry?.id || '').trim();
}

export async function loadAgents() {
  try {
    const resp = await requestWs('agents:list');
    const raw = Array.isArray(resp.data) ? resp.data : [];
    _agents = raw;
    _primaryAgents = new Set(
      raw
        .filter((entry) => String(entry?.mode || '').toLowerCase() !== 'subagent')
        .map(agentName)
        .filter(Boolean),
    );
    for (const tab of _tabs) reconcileTabMode(tab);
    saveTabs();
    update();
  } catch (e) {
    console.error('[ocp-tabs] loadAgents failed:', e);
  }
}

export function setTabMode(mode) {
  const tab = activeTab();
  if (!tab) return;
  const nextMode = normalizeMode(mode) || DEFAULT_MODE;
  if (nextMode === 'plan') {
    tab._exitPlanDetected = false;
    tab._questionToolUsedThisTurn = false;
    if (tab.mode !== 'plan' || !tab._planModeStartedAt) {
      tab._planModeStartedAt = Date.now();
    }
  }
  // Leaving plan mode invalidates any pending post-plan card — clear the flag
  // so a later renderTabMessages (tab switch, WS reconnect) can't resurrect it.
  if (tab.mode === 'plan' && nextMode !== 'plan') {
    tab.showPostPlanActions = false;
    tab._pendingPostPlanCheck = false;
    clearPlanFinalizationWatchdog(tab);
    dismissPlanStallSoftCard(tab);
    const container = panelEl('#ocp-messages');
    if (container) {
      removePostPlanCards(container);
      removeProseQuestionRecoveryCards(container);
      try { removePlanStallSoftCards(container); } catch {}
    }
  }
  tab.mode = nextMode;
  tab.agent = resolveAgentForMode(nextMode);
  storage.setItem(STOR.mode, nextMode);
  saveTabs();
  update();
}

export function getActiveTabMode() {
  return normalizeMode(activeTab()?.mode) || DEFAULT_MODE;
}

const CAP_BADGES = [
  { key: 'reasoning',    test: c => c?.reasoning,     label: 'Reason', abbr: 'R',  color: '#c084fc', bg: 'rgba(192,132,252,0.12)', description: 'Stronger at multi-step reasoning, planning, and hard problem solving.' },
  { key: 'toolcall',     test: c => c?.toolcall,      label: 'Tools',  abbr: 'T',  color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  description: 'Can call external tools and functions during a task.' },
  { key: 'input.image',  test: c => c?.input?.image,  label: 'Vision', abbr: 'V',  color: '#4ade80', bg: 'rgba(74,222,128,0.12)',  description: 'Can understand images and screenshots you attach.' },
  { key: 'input.audio',  test: c => c?.input?.audio,  label: 'Audio',  abbr: 'A',  color: '#fb923c', bg: 'rgba(251,146,60,0.12)', description: 'Can understand audio input.' },
  { key: 'input.video',  test: c => c?.input?.video,  label: 'Video',  abbr: 'Vi', color: '#f87171', bg: 'rgba(248,113,113,0.12)', description: 'Can understand video input.' },
  { key: 'input.pdf',    test: c => c?.input?.pdf,    label: 'PDF',    abbr: 'P',  color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', description: 'Can read PDF documents directly.' },
  { key: 'output.image', test: c => c?.output?.image, label: 'ImgGen', abbr: 'I',  color: '#f472b6', bg: 'rgba(244,114,182,0.12)', description: 'Can generate images.' },
  { key: 'output.audio', test: c => c?.output?.audio, label: 'TTS',    abbr: 'S',  color: '#2dd4bf', bg: 'rgba(45,212,191,0.12)', description: 'Can generate spoken audio.' },
  { key: 'attachment',   test: c => c?.attachment,    label: 'Files',  abbr: 'F',  color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', description: 'Can accept file attachments as input.' },
];

function escAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capTooltip(badge) {
  return `${badge.label}\n${badge.description || ''}`;
}

const ALL_CAP_HELP = {
  key: '',
  label: 'All',
  description: 'Showing every visible model.',
};

function capBadgesHtml(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') return '';
  const caps = modelObj.capabilities;
  if (!caps) return '';
  return CAP_BADGES
    .filter(b => b.test(caps))
    .map(b => `<span class="ocp-cap" data-cap-key="${escAttr(b.key)}" data-tooltip="${escAttr(capTooltip(b))}" data-tooltip-pos="above">${b.label}</span>`)
    .join('');
}

function capBadgesText(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') return '';
  const caps = modelObj.capabilities;
  if (!caps) return '';
  const labels = CAP_BADGES.filter(b => b.test(caps)).map(b => b.label);
  return labels.length ? '  ' + labels.join(' ') : '';
}

export { CAP_BADGES, capBadgesHtml, capBadgesText };

export function populateModelDropdown(ddEl) {
  if (!ddEl) return;
  const menu = ddEl.querySelector('.ocp-dd-menu');
  if (!menu) return;
  menu.innerHTML = '';

  // Search input — sticky at top for filtering
  const searchInput = document.createElement('input');
  searchInput.className = 'ocp-model-search';
  searchInput.placeholder = 'Search models…';
  searchInput.setAttribute('autocomplete', 'off');
  searchInput.addEventListener('mousedown', e => e.stopPropagation());
  searchInput.addEventListener('click', e => e.stopPropagation());
  menu.appendChild(searchInput);

  const tab = activeTab();
  const currentModel = tab?.model || '';

  // Favorites
  const FAV_KEY = 'ocp-model-favorites';
  let favorites;
  try { favorites = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { favorites = new Set(); }
  const saveFavorites = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch {} };

  // Hidden models from settings
  const HIDDEN_KEY = 'ocp-hidden-models';
  let hiddenModels;
  try { hiddenModels = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch { hiddenModels = new Set(); }

  // Group by provider — only connected providers, skip hidden models
  const groups = {};
  for (const p of _providers) {
    const provId = p.id || 'unknown';
    const provName = p.name || provId;
    if (!_connectedProviders.has(provId)) continue;
    const modelArr = Array.isArray(p.models) ? p.models : Object.values(p.models || {});
    if (!groups[provId]) groups[provId] = { name: provName, models: [] };
    for (const m of modelArr) {
      const modelId = typeof m === 'string' ? m : (m.id || m.name || '');
      if (modelId && !hiddenModels.has(`${provId}/${modelId}`)) {
        groups[provId].models.push({ id: modelId, _obj: typeof m === 'object' ? m : null });
      }
    }
    // Remove empty groups (all models hidden)
    if (groups[provId] && groups[provId].models.length === 0) delete groups[provId];
  }

  const sortedEntries = Object.entries(groups).sort((a, b) =>
    a[1].name.localeCompare(b[1].name)
  );
  const hasAnyModel = sortedEntries.some(([, group]) => group.models.length > 0);

  function makeOption(provId, modelId, entry) {
    const fullId = `${provId}/${modelId}`;
    const badges = capBadgesHtml(entry._obj);
    const isFav = favorites.has(fullId);
    const opt = document.createElement('div');
    opt.className = 'ocp-dd-option' + (fullId === currentModel ? ' selected' : '');
    opt.dataset.modelName = modelId.toLowerCase();
    opt.dataset.fullId = fullId;
    if (entry._obj?.capabilities) opt.dataset.caps = JSON.stringify(entry._obj.capabilities);
    opt.innerHTML = `<span class="ocp-dd-model-name">${escHtml(modelId)}</span>${badges ? `<span class="ocp-dd-caps">${badges}</span>` : ''}`;
    const starBtn = document.createElement('button');
    starBtn.className = 'ocp-dd-star' + (isFav ? ' active' : '');
    starBtn.type = 'button';
    starBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
    starBtn.textContent = '★';
    starBtn.addEventListener('mousedown', e => e.stopPropagation());
    starBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (favorites.has(fullId)) favorites.delete(fullId); else favorites.add(fullId);
      saveFavorites();
      populateModelDropdown(ddEl);
      menu.classList.add('open');
    });
    opt.appendChild(starBtn);
    opt.addEventListener('click', () => {
      if (tab) { tab.model = fullId; storage.setItem(STOR.model, fullId); saveTabs(); }
      menu.classList.remove('open');
      const labelEl = ddEl.querySelector('.ocp-dd-label');
      if (labelEl) labelEl.textContent = modelId;
      menu.querySelectorAll('.ocp-dd-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
    return opt;
  }

  // Favorites group at top
  if (favorites.size > 0) {
    const favLabel = document.createElement('div');
    favLabel.className = 'ocp-dd-group-label ocp-dd-fav-label';
    favLabel.textContent = `Favorites (${favorites.size})`;
    menu.appendChild(favLabel);
    for (const [provId, group] of sortedEntries) {
      for (const entry of group.models) {
        if (favorites.has(`${provId}/${entry.id}`)) menu.appendChild(makeOption(provId, entry.id, entry));
      }
    }
    const sep = document.createElement('div');
    sep.className = 'ocp-dd-sep';
    menu.appendChild(sep);
  }

  // Provider groups
  for (const [provId, group] of sortedEntries) {
    if (!group.models.length) continue;
    const label = document.createElement('div');
    label.className = 'ocp-dd-group-label';
    label.textContent = `${group.name} (${group.models.length})`;
    menu.appendChild(label);
    for (const entry of group.models) menu.appendChild(makeOption(provId, entry.id, entry));
    const sep = document.createElement('div');
    sep.className = 'ocp-dd-sep';
    menu.appendChild(sep);
  }

  const emptyState = document.createElement('div');
  emptyState.className = 'ocp-dd-empty';
  emptyState.style.display = 'none';
  const emptyText = document.createElement('span');
  emptyText.className = 'ocp-dd-empty-text';
  const emptyClear = document.createElement('button');
  emptyClear.className = 'ocp-dd-empty-clear';
  emptyClear.type = 'button';
  emptyClear.textContent = 'Clear filter';
  emptyClear.addEventListener('mousedown', e => e.stopPropagation());
  emptyState.append(emptyText, emptyClear);
  menu.appendChild(emptyState);

  // Capability filter pills
  const filterBar = document.createElement('div');
  filterBar.className = 'ocp-cap-filter-bar';
  let activeCapKey = '';
  const filterPills = new Map();

  // Toggle button — declared before pill loop so pill handlers can reference it
  const filterToggle = document.createElement('button');
  filterToggle.className = 'ocp-cap-filter-toggle';
  filterToggle.type = 'button';
  filterToggle.setAttribute('data-tooltip', 'Capability filters\nShow or hide model capability chips.');
  filterToggle.setAttribute('data-tooltip-pos', 'left');
  filterToggle.innerHTML = '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M0.5 2h8M2 4.5h5M3.5 7h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  filterToggle.addEventListener('mousedown', e => e.stopPropagation());
  filterToggle.addEventListener('click', e => {
    e.stopPropagation();
    const collapsed = filterBar.classList.toggle('ocp-cap-filter-bar--hidden');
    filterToggle.classList.toggle('collapsed', collapsed);
    capHelp.classList.toggle('ocp-cap-help--collapsed', collapsed);
    if (!collapsed) restoreCapHelp();
    try { localStorage.setItem('ocp-cap-filter-expanded', collapsed ? '0' : '1'); } catch {}
  });

  function syncFilterPills() {
    for (const [key, pill] of filterPills) {
      const active = key === activeCapKey || (!activeCapKey && key === '');
      pill.classList.toggle('active', active);
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    filterToggle.classList.toggle('has-active', !!activeCapKey);
  }

  function setActiveCap(key) {
    activeCapKey = activeCapKey === key ? '' : key;
    syncFilterPills();
    applyFilters();
    restoreCapHelp();
  }

  const capHelp = document.createElement('div');
  capHelp.className = 'ocp-cap-help';
  const capHelpTitle = document.createElement('span');
  capHelpTitle.className = 'ocp-cap-help-title';
  const capHelpText = document.createElement('span');
  capHelpText.className = 'ocp-cap-help-text';
  capHelp.append(capHelpTitle, capHelpText);
  let lastHelpKey = null;

  function applyCapHelp(badge) {
    const target = badge || ALL_CAP_HELP;
    if (lastHelpKey !== target.key) {
      capHelpTitle.textContent = target.label;
      capHelpText.textContent = target.description;
      lastHelpKey = target.key;
      // restart swap animation for smooth text transition
      capHelp.classList.remove('ocp-cap-help--swap');
      void capHelp.offsetWidth;
      capHelp.classList.add('ocp-cap-help--swap');
    }
    capHelp.classList.toggle('ocp-cap-help--active', !!(badge && badge.key));
  }

  function showCapHelp(badge) {
    applyCapHelp(badge);
  }

  function restoreCapHelp() {
    applyCapHelp(activeCapKey ? CAP_BADGES.find(b => b.key === activeCapKey) : null);
  }

  function bindCapHelp(pill, badge) {
    pill.addEventListener('mouseenter', () => showCapHelp(badge));
    pill.addEventListener('focus', () => showCapHelp(badge));
    pill.addEventListener('mouseleave', restoreCapHelp);
    pill.addEventListener('blur', restoreCapHelp);
  }

  applyCapHelp(null);

  const allPill = document.createElement('button');
  allPill.className = 'ocp-cap-filter ocp-cap-filter-all active';
  allPill.type = 'button';
  allPill.dataset.capKey = '';
  allPill.textContent = 'All';
  allPill.setAttribute('aria-pressed', 'true');
  allPill.addEventListener('mousedown', e => e.stopPropagation());
  allPill.addEventListener('click', e => {
    e.stopPropagation();
    activeCapKey = '';
    syncFilterPills();
    applyFilters();
    restoreCapHelp();
  });
  bindCapHelp(allPill, ALL_CAP_HELP);
  filterPills.set('', allPill);
  filterBar.appendChild(allPill);

  for (const b of CAP_BADGES) {
    const pill = document.createElement('button');
    pill.className = 'ocp-cap-filter';
    pill.type = 'button';
    pill.dataset.capKey = b.key;
    pill.innerHTML = `<span class="ocp-cap-filter-letter">${escHtml(b.abbr || b.label.slice(0, 1))}</span><span class="ocp-cap-filter-label">${escHtml(b.label)}</span>`;
    pill.setAttribute('aria-pressed', 'false');
    pill.addEventListener('mousedown', e => e.stopPropagation());
    pill.addEventListener('click', e => {
      e.stopPropagation();
      setActiveCap(b.key);
    });
    bindCapHelp(pill, b);
    filterPills.set(b.key, pill);
    filterBar.appendChild(pill);
  }
  menu.insertBefore(filterBar, searchInput.nextSibling);

  // Wrap search + filter bar in a single sticky header — eliminates the pixel-gap problem
  const header = document.createElement('div');
  header.className = 'ocp-dd-header';
  menu.insertBefore(header, searchInput);
  header.appendChild(searchInput);
  header.appendChild(filterBar);
  header.appendChild(capHelp);
  header.appendChild(filterToggle);

  // Restore collapsed state from localStorage
  try {
    if (localStorage.getItem('ocp-cap-filter-expanded') === '0') {
      filterBar.classList.add('ocp-cap-filter-bar--hidden');
      filterToggle.classList.add('collapsed');
    }
  } catch {}

  // Combined search + capability filter
  emptyClear.addEventListener('click', e => {
    e.stopPropagation();
    activeCapKey = '';
    syncFilterPills();
    applyFilters();
    searchInput.focus();
  });

  function updateEmptyState(visibleOptionCount) {
    if (visibleOptionCount > 0) {
      emptyState.style.display = 'none';
      return;
    }
    const term = searchInput.value.trim();
    const activeBadge = activeCapKey ? CAP_BADGES.find(b => b.key === activeCapKey) : null;
    if (!hasAnyModel) {
      emptyText.textContent = 'No connected models available';
    } else if (activeBadge && term) {
      emptyText.textContent = `No ${activeBadge.label} models match "${term}"`;
    } else if (activeBadge) {
      emptyText.textContent = `No models with ${activeBadge.label}`;
    } else if (term) {
      emptyText.textContent = `No models match "${term}"`;
    } else {
      emptyText.textContent = 'No models available';
    }
    emptyClear.style.display = activeCapKey ? '' : 'none';
    emptyState.style.display = 'flex';
  }

  function applyFilters() {
    const term = searchInput.value.toLowerCase();
    const activeBadge = activeCapKey ? CAP_BADGES.find(b => b.key === activeCapKey) : null;
    let visibleOptionCount = 0;
    let prevLabel = null, prevLabelVisible = false, labelTextMatch = false;
    for (const el of menu.children) {
      if (el === header) continue;
      if (el === emptyState) continue;
      if (el.classList.contains('ocp-dd-group-label')) {
        if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
        prevLabel = el;
        labelTextMatch = !term || el.textContent.toLowerCase().includes(term);
        prevLabelVisible = false; // set true only when a model actually matches
      } else if (el.classList.contains('ocp-dd-option')) {
        const nameMatch = !term || (el.dataset.modelName || '').includes(term) || labelTextMatch;
        let capMatch = true;
        if (activeBadge && el.dataset.caps) {
          try {
            const caps = JSON.parse(el.dataset.caps);
            capMatch = activeBadge.test(caps);
          } catch { capMatch = false; }
        } else if (activeBadge) {
          capMatch = false;
        }
        const match = nameMatch && capMatch;
        el.style.display = match ? '' : 'none';
        if (match) {
          prevLabelVisible = true;
          visibleOptionCount += 1;
        }
      } else if (el.classList.contains('ocp-dd-sep')) {
        el.style.display = prevLabelVisible ? '' : 'none';
        if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
        prevLabel = null; prevLabelVisible = false; labelTextMatch = false;
      }
    }
    if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
    updateEmptyState(visibleOptionCount);
  }
  searchInput.addEventListener('input', applyFilters);
  applyFilters();

  // Update label from current model
  const labelEl = ddEl.querySelector('.ocp-dd-label');
  if (labelEl && currentModel) {
    labelEl.textContent = currentModel.split('/').pop() || currentModel;
  }
}

// ── Session HTML snapshot helpers ──

function _normalizeSnapshotEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const html = typeof entry.html === 'string' ? entry.html : '';
  if (!html) return null;
  return {
    html,
    updatedAt: Number(entry.updatedAt) || 0,
    title: typeof entry.title === 'string' ? entry.title : '',
    itemCount: Number(entry.itemCount) || 0,
    threadTokenUsage: entry.threadTokenUsage || null,
  };
}

function _persistSessionSnapshots(changedSid) {
  try {
    const source = (_sessionSnapshots && typeof _sessionSnapshots === 'object' && !Array.isArray(_sessionSnapshots))
      ? _sessionSnapshots : {};
    const entries = Object.entries(source)
      .map(([sid, e]) => [sid, _normalizeSnapshotEntry(e)])
      .filter(([, e]) => !!e)
      .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const next = {};
    let totalChars = 0;
    for (const [sid, entry] of entries) {
      const size = entry.html.length;
      if (Object.keys(next).length >= MAX_OCP_SESSION_SNAPSHOTS) break;
      if (totalChars + size > MAX_OCP_SESSION_SNAPSHOT_CHARS && Object.keys(next).length) continue;
      totalChars += size;
      next[sid] = entry;
    }
    // Locally-evicted entries also leave the server store.
    for (const sid of Object.keys(source)) {
      if (!next[sid]) deleteBlob('ocp-snapshots', sid);
    }
    _sessionSnapshots = next;
    // Upload ONLY the changed session's entry (server enforces the same caps).
    if (changedSid && next[changedSid]) {
      putBlob('ocp-snapshots', changedSid, next[changedSid], {
        maxEntries: MAX_OCP_SESSION_SNAPSHOTS,
        maxChars: MAX_OCP_SESSION_SNAPSHOT_CHARS,
      });
    }
  } catch {}
}

export function getSessionSnapshot(sid) {
  if (!sid) return null;
  return _normalizeSnapshotEntry(_sessionSnapshots?.[sid]);
}

export function writeSessionSnapshot(tab) {
  const sid = tab?.sessionId || null;
  const container = panelEl('#ocp-messages');
  if (!sid || !container) return;
  // Only snapshot when this tab is the one currently rendered in #ocp-messages.
  if (tab !== activeTab()) return;
  const html = container.innerHTML || '';
  if (!html.trim()) return;
  // Skip empty-state placeholder
  const onlyChild = container.children.length === 1 ? container.firstElementChild : null;
  if (onlyChild?.classList?.contains('ocp-empty')) return;
  if (onlyChild?.classList?.contains('ocp-thinking') && container.children.length === 1) return;
  if (!_sessionSnapshots || typeof _sessionSnapshots !== 'object' || Array.isArray(_sessionSnapshots)) {
    _sessionSnapshots = {};
  }
  const itemCount = [...container.children].filter(n =>
    !n.classList?.contains('ocp-empty') && !n.classList?.contains('ocp-thinking')
  ).length;
  _sessionSnapshots[sid] = {
    html,
    updatedAt: Date.now(),
    title: tab.sessionTitle || '',
    itemCount,
    threadTokenUsage: tab.threadTokenUsage || null,
  };
  _persistSessionSnapshots(sid);
}

export function scheduleSessionSnapshotSave(tab, ms = 350) {
  if (!tab?.sessionId) return;
  if (_snapshotDebounceTimer) clearTimeout(_snapshotDebounceTimer);
  _snapshotDebounceTimer = setTimeout(() => {
    _snapshotDebounceTimer = null;
    writeSessionSnapshot(tab);
  }, ms);
}

export function flushSessionSnapshotSave(tab) {
  if (!tab) return;
  if (_snapshotDebounceTimer) { clearTimeout(_snapshotDebounceTimer); _snapshotDebounceTimer = null; }
  writeSessionSnapshot(tab);
}

export function flushAllSessionSnapshots() {
  // Only the active tab is rendered into #ocp-messages, so flush just that one.
  flushSessionSnapshotSave(activeTab());
}

function _installSnapshotObserver(container) {
  if (!container || _snapshotObserverContainer === container) return;
  if (_snapshotObserver) try { _snapshotObserver.disconnect(); } catch {}
  _snapshotObserverContainer = container;
  _snapshotObserver = new MutationObserver(() => {
    if (_snapshotRestoring) return;
    const tab = activeTab();
    if (tab?.sessionId) scheduleSessionSnapshotSave(tab);
  });
  _snapshotObserver.observe(container, { childList: true, subtree: true, characterData: true });
}

function _renderStoredSession(snapshot, container) {
  const norm = _normalizeSnapshotEntry(snapshot);
  if (!norm || !container) return false;
  _snapshotRestoring = true;
  try {
    container.innerHTML = norm.html;
    // Restored DOM has no event handlers and any mid-turn UI (permission cards,
    // ask cards, post-plan, thinking dots) is stale — disable / strip.
    container.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = true; });
    container.querySelectorAll('.ocp-thinking, .ocp-permission-card, .ocp-question-card.active, .ocp-post-plan-card').forEach(n => n.remove());
  } finally {
    _snapshotRestoring = false;
  }
  return true;
}

// ── Render current tab's messages ──

export async function renderTabMessages() {
  const container = panelEl('#ocp-messages');
  if (!container) return;
  _installSnapshotObserver(container);
  const tab = activeTab();
  const seq = ++_renderSeq;

  if (!tab || !tab.sessionId) {
    renderEmptyState(container);
    return;
  }

  // Try local snapshot first — exact replay of the live render. Skip while
  // a turn is actively running so streaming state isn't masked by a stale snapshot.
  if (!tab.running) {
    // Snapshot hydration is async (blob store) — settle it before deciding
    // between snapshot blit and full rebuild.
    try { await _snapshotsReady; } catch {}
    if (seq !== _renderSeq) return;
    const snap = getSessionSnapshot(tab.sessionId);
    if (snap && _renderStoredSession(snap, container)) {
      // Background refresh: pull latest messages and rebuild only if upstream
      // is materially ahead of the snapshot, otherwise the cheap restore wins.
      try {
        const messages = await loadMessages(tab.sessionId);
        if (seq !== _renderSeq) return;
        const upstreamCount = Array.isArray(messages) ? messages.length : 0;
        if (upstreamCount > (snap.itemCount || 0) + 1) {
          renderHistory(container, messages);
          writeSessionSnapshot(tab);
        }
      } catch {}
      if (tab.mode === 'plan' && (tab.showPostPlanActions || tab._pendingPostPlanCheck)) {
        if (!tab.planContent || tab._pendingPostPlanCheck) capturePlanContent(tab);
        tab._pendingPostPlanCheck = false;
        if (tab.planContent) showPostPlanUI(tab);
      }
      questionsModule.ensurePendingQuestionVisible(tab, container);
      return;
    }
  }

  container.innerHTML = '<div class="ocp-thinking"><span class="ocp-thinking-dots"><span></span><span></span><span></span></span> Loading…</div>';

  try {
    const messages = await loadMessages(tab.sessionId);
    if (seq !== _renderSeq) return; // stale render — a newer one took over
    renderHistory(container, messages);
    writeSessionSnapshot(tab);
    // Restore post-plan card only while still in plan mode — leaving plan
    // mode must not allow the card to resurrect on tab switch / WS reconnect.
    if (tab.mode === 'plan' && (tab.showPostPlanActions || tab._pendingPostPlanCheck)) {
      if (!tab.planContent || tab._pendingPostPlanCheck) capturePlanContent(tab);
      tab._pendingPostPlanCheck = false;
      if (tab.planContent) showPostPlanUI(tab);
    }
    questionsModule.ensurePendingQuestionVisible(tab, container);
    // Re-show thinking indicator if the tab is mid-turn — history render wipes it,
    // and SSE events may not fire again for a while.
    if (tab.running) {
      syncActingIndicator(container, tab);
    }
  } catch {
    if (seq !== _renderSeq) return;
    renderEmptyState(container);
  }
}

// ── Helpers ──

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

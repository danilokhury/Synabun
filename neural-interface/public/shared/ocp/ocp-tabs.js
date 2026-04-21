// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel: Tab System + Session Management
// Multi-tab with per-tab session isolation, provider/model management
// ═══════════════════════════════════════════

import { requestWs, sendWs, onWsMessage, rejectPending } from './ocp-ws.js';
import {
  renderHistory, renderEmptyState, renderUserPayload,
  renderAssistantPayload,
  appendStreamChunk, appendThinkChunk, finalizeStreamingMessage,
  showThinking, updateThinking, removeThinking, repositionThinking,
  renderToolCard, updateToolCard, renderErrorMessage,
  isQuestionTool, renderQuestionCard, lockQuestionCard,
  renderPostPlanCard, removePostPlanCards,
  describeTool,
} from './ocp-render.js';
import { ICON_X, TOOL_ICONS } from './ocp-icons.js';
import { storage } from '../storage.js';
import { notify, NOTIF_TYPE } from '../ui-notifications.js';

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
};

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
let _activeQuestionToolId = null; // toolId of the currently active (unanswered) question card
let _questionQueue = []; // queue of pending question events waiting for the active question to be answered
let _activePermissionId = null; // permissionID of the currently displayed (unresponded) permission card
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
export function setPanelVisible(v) { _panelVisible = !!v; }
export function setOnShow(fn) { _showPanel = fn; }
export function setOnHide(fn) { _hidePanel = fn; }
export function setOnEditPlan(fn) { _onEditPlan = fn; }
function update() { if (_onUpdate) _onUpdate(); }

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

function hasActiveQuestion() {
  return _activeQuestionToolId !== null;
}

function queueQuestion(event) {
  _questionQueue.push(event);
}

function dequeueNextQuestion() {
  if (_questionQueue.length === 0) {
    _activeQuestionToolId = null;
    return null;
  }
  return _questionQueue.shift();
}

function clearQuestionQueue() {
  _questionQueue = [];
  _activeQuestionToolId = null;
}

function processQuestionQueue(tab, container) {
  const next = dequeueNextQuestion();
  if (!next) return;
  // New path: queued question.asked SSE events
  if (next.eventType === 'question.asked' && next.event && next.reqId) {
    renderOpencodeQuestion(tab, container, next.event, next.reqId);
    return;
  }
  // Legacy path: queued tool-based questions (tool.start fallback)
  const { toolName, toolInput, toolId } = next;
  if (!toolId) return;
  _activeQuestionToolId = toolId;
  removeThinking(container);
  renderQuestionCard(container, toolName, toolInput, toolId, {
    onAnswer: (answers) => {
      lockQuestionCard(container, toolId);
      if (typeof answers === 'string') {
        sendMessage(answers).then(() => processQuestionQueue(tab, container));
      } else if (answers && typeof answers === 'object') {
        const entries = Object.entries(answers);
        if (entries.length === 1) {
          sendMessage(entries[0][1]).then(() => processQuestionQueue(tab, container));
        } else {
          const lines = entries.map(([q, a]) => `- ${q}: ${a}`);
          sendMessage(`Here are my answers:\n${lines.join('\n')}`).then(() => processQuestionQueue(tab, container));
        }
      }
    },
  });
  setTurnStatus(tab, 'Waiting for input…', 'Question');
  const notifState = ensureNotifState(tab);
  const questionKey = String(toolId || `${toolName}:${tab.sessionId || tab.id}`);
  if (notifState && !notifState.questionIds.has(questionKey)) {
    notifState.questionIds.add(questionKey);
    notifyOpenCode(NOTIF_TYPE.ASK, tab);
  }
  update();
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

  _activeTabIdx = idx;

  // Restore draft
  const tab = activeTab();
  reconcileTabMode(tab);
  if (input && tab) input.value = tab.draft || '';

  renderTabMessages();
  renderPills();
  saveTabs();
  update();
}

export function closeTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const tab = _tabs[idx];
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
      planContent: t.planContent, planFilePath: t.planFilePath, showPostPlanActions: t.showPostPlanActions,
      threadTokenUsage: t.threadTokenUsage,
    }));
    storage.setItem(STOR.tabs, JSON.stringify({ activeIdx: _activeTabIdx, tabs: data }));
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
      createTab({ ...saved, autoSwitch: false, threadTokenUsage: restored });
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
    if (tab?.model) body.model = modelObj(tab.model);
    if (tab?.agent) body.agent = tab.agent;
    const cwd = tab?.project || '';
    const resp = await requestWs('session:create', { body, ...(cwd ? { cwd } : {}) });
    const session = resp.data;
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

function capturePlanContent(tab) {
  if (!tab || tab.mode !== 'plan') return;
  const container = panelEl('#ocp-messages');
  if (!container) return;
  const assistantEls = container.querySelectorAll('.ocp-msg-assistant');
  if (!assistantEls.length) return;
  const lastEl = assistantEls[assistantEls.length - 1];
  const text = (lastEl.textContent || '').trim();
  if (text.length > 80) tab.planContent = text;
}

function showPostPlanUI(tab) {
  if (!tab) return;
  const container = panelEl('#ocp-messages');
  if (!container) return;
  // Remove any existing post-plan cards before appending a new one
  removePostPlanCards(container);
  tab.showPostPlanActions = true;
  saveTabs();
  renderPostPlanCard(container, {
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
    onEditPlan: () => {
      if (typeof _onEditPlan === 'function') _onEditPlan(tab);
    },
  });
}

// ── Send message ──

export async function sendMessage(content, options = {}) {
  const tab = activeTab();
  const text = String(content || '').trim();
  const images = Array.isArray(options.images) ? options.images.filter(Boolean) : [];
  if (!tab || tab.running || (!text && !images.length)) return false;
  reconcileTabMode(tab);
  // Clear any pending question queue when user sends a new message
  clearQuestionQueue();

  // Clear any post-plan action card when sending a new message
  const msgContainer = panelEl('#ocp-messages');
  if (msgContainer) removePostPlanCards(msgContainer);
  tab.showPostPlanActions = false;

  const turnStartedAt = Date.now();
  tab.running = true;
  tab.turnStartedAt = turnStartedAt;
  resetTurnNotif(tab);
  setTurnStatus(tab, 'Thinking…', tabStatusDetail(tab));
  update();

  const container = panelEl('#ocp-messages');
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
      detail: tabStatusDetail(tab),
      startedAt: turnStartedAt,
      waiting: true,
    });
  }

  // Ensure session exists after the in-flight UI is visible.
  if (!tab.sessionId) {
    const session = await createSession();
    if (!session) {
      if (container) {
        removeThinking(container);
        renderErrorMessage(container, 'Could not create OpenCode session');
      }
      tab.running = false;
      tab.turnStartedAt = 0;
      setTurnStatus(tab);
      update();
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
    if (tab.model) body.model = modelObj(tab.model);
    if (tab.agent) body.agent = tab.agent;
    const cwd = tab.project || '';
    const sendPromise = requestWs('message:send', {
      sessionId: tab.sessionId,
      body,
      ...(cwd ? { cwd } : {}),
    }, 360000); // 6 min timeout — OpenCode endpoint blocks until LLM finishes
    _activeSendRequestId = sendPromise.requestId;
    tab._activeSendRequestId = sendPromise.requestId;
    const resp = await sendPromise;
    _activeSendRequestId = null;
    tab._activeSendRequestId = null;
    // OpenCode's POST /session/{id}/message is synchronous: it blocks until
    // the LLM response is complete and returns the full message. SSE events
    // may have already streamed deltas during the wait, but if they didn't
    // (or were missed), use the POST response as the authoritative result.
    if (tab.running && resp?.data) {
      const info = resp.data.info || resp.data;
      const parts = resp.data.parts || info.parts || info.content;
      // Only render from POST if SSE didn't already stream content
      const hasStreamed = container?.querySelector('.ocp-msg-assistant.streaming')
        || container?.querySelector('.ocp-msg-assistant');
      if (parts && !hasStreamed) {
        removeThinking(container);
        renderAssistantPayload(container, parts, { textMode: 'stream' });
        finalizeStreamingMessage(container);
      } else {
        removeThinking(container);
        finalizeStreamingMessage(container);
      }
      tab.running = false;
      tab.turnStartedAt = 0;
      if (info.tokens || info.usage) {
        const raw = info.tokens || info.usage || {};
        tab.threadTokenUsage = normalizeThreadTokenUsage(raw);
        tab.inputTokens = raw.input || raw.inputTokens || raw.input_tokens || 0;
        tab.outputTokens = raw.output || raw.outputTokens || raw.output_tokens || 0;
      }
      setTurnStatus(tab);
      notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, info.id || tab.sessionId || tab.id);
      update();
    }
    return true;
  } catch (e) {
    _activeSendRequestId = null;
    tab._activeSendRequestId = null;
    // Don't render error for user-initiated aborts — abortMessage() already cleaned up
    const isAbort = e.message === 'Aborted by user';
    if (container && !isAbort) {
      removeThinking(container);
      renderErrorMessage(container, e.message);
    }
    if (!isAbort) {
      tab.running = false;
      tab.turnStartedAt = 0;
      setTurnStatus(tab);
      notifyOpenCodeOutcome(NOTIF_TYPE.ERROR, tab, tab.sessionId || tab.id);
      update();
    }
    return false;
  }
}

export function anyTabRunning() {
  return _tabs.some((t) => t?.running);
}

export async function abortMessage() {
  return abortAllTabs();
}

export async function abortAllTabs() {
  let stoppedAny = false;
  const activeContainer = panelEl('#ocp-messages');
  const active = activeTab();
  for (const tab of _tabs) {
    if (!tab?.running) continue;
    stoppedAny = true;
    if (tab.sessionId) {
      try { sendWs({ type: 'message:abort', sessionId: tab.sessionId }); } catch {}
    }
    if (tab._activeSendRequestId) {
      rejectPending(tab._activeSendRequestId, 'Aborted by user');
      tab._activeSendRequestId = null;
    }
    if (tab === active && activeContainer) {
      removeThinking(activeContainer);
      finalizeStreamingMessage(activeContainer);
    }
    tab.running = false;
    tab.turnStartedAt = 0;
    setTurnStatus(tab);
  }
  _activeSendRequestId = null;
  if (stoppedAny) update();
  return stoppedAny;
}

export async function injectContext(content) {
  const tab = activeTab();
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
    console.error('[ocp-tabs] injectContext failed:', e);
    return false;
  }
}

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
    return true;
  }
  return false;
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

export function handleSSEEvent(eventType, event) {
  const tab = activeTab();
  if (!tab) return;

  const container = panelEl('#ocp-messages');
  if (!container) return;

  // Filter events to current session (OpenCode uses sessionID). When the active
  // tab has no sessionId yet (freshly created via "+"), drop any session-scoped
  // event so the still-running previous session doesn't render into it.
  const eventSessionId = event?.sessionID || event?.sessionId || event?.session?.id;
  if (eventSessionId && eventSessionId !== tab.sessionId) {
    // Route events from tracked subagent child sessions into their parent agent entry.
    const agentEntry = findAgentEntryByChildSession(tab, eventSessionId);
    if (agentEntry && recordAgentChildEvent(tab, agentEntry, eventType, event)) {
      update();
    }
    return;
  }

  switch (eventType) {
    // Message updated — fires for both user and assistant messages
    case 'message.updated': {
      const info = event.info || event;
      // Track user messages so their parts don't echo in the chat
      if (info.role === 'user') {
        const mid = info.id || event.messageID;
        if (mid) _userMsgIds.add(mid);
        break;
      }
      // Guard: once we've rendered this assistant message's final payload, ignore
      // re-emitted message.updated events (OpenCode on Windows sometimes fires a
      // late duplicate after finalize, which would otherwise re-stream the whole
      // response into a brand-new assistant bubble).
      const assistantMid = info.id || event.messageID;
      if (assistantMid && _renderedAssistantMsgIds.has(assistantMid)) {
        update();
        break;
      }
      // If no streaming element was built by prior deltas, render the
      // assistant's content directly from the event (non-streaming path)
      const hasStreaming = container.querySelector('.ocp-msg-assistant.streaming');
      const status = String(info.status || info.state || '').toLowerCase();
      const explicitTerminal = ['done', 'complete', 'completed', 'finished', 'success'].includes(status);
      const hasToolCards = !!container.querySelector('.ocp-tool-card');
      const rendered = renderAssistantPayload(container, info.content ?? info.parts ?? info.text ?? '', {
        textMode: hasStreaming ? 'skip' : 'stream',
      });
      if (rendered || hasStreaming || (explicitTerminal && hasToolCards) || (info.tokens && hasToolCards)) {
        removeThinking(container);
        finalizeStreamingMessage(container);
        _partTypes.clear();
        if (assistantMid && (explicitTerminal || info.tokens || info.usage)) {
          _renderedAssistantMsgIds.add(assistantMid);
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
      } else if (tab.running) {
        setTurnStatus(tab, 'Waiting for response…', tabStatusDetail(tab));
        updateThinking(container, {
          title: 'Waiting for response…',
          detail: tabStatusDetail(tab),
          startedAt: tab.turnStartedAt || Date.now(),
          waiting: true,
        });
      }
      update();
      break;
    }
    // Streaming text delta — the primary streaming event from OpenCode
    case 'message.part.delta': {
      if (_userMsgIds.has(event.messageID)) break; // skip user message echoes
      if (event.delta) {
        const partType = String(event.part?.type || event.partType || _partTypes.get(event.partID) || '').trim().toLowerCase();
        const isReasoning = partType === 'reasoning' || partType === 'thinking' || partType === 'thought';
        if (isReasoning) {
          appendThinkChunk(container, event.delta);
          setTurnStatus(tab, 'Thinking…', tabStatusDetail(tab));
        } else {
          appendStreamChunk(container, event.delta);
          setTurnStatus(tab, 'Writing response…', tabStatusDetail(tab));
        }
        if (tab.running) repositionThinking(container);
        update();
      }
      break;
    }
    // Part updated — full part state (text finalized, tool state change, etc.)
    case 'message.part.updated': {
      const part = event.part || event;
      if (_userMsgIds.has(part.messageID)) break; // skip user message echoes
      const updatedType = String(part?.type || '').trim().toLowerCase();
      // Track part type so message.part.delta can look it up by partID
      if (part.id && updatedType) _partTypes.set(part.id, updatedType);
      if (updatedType === 'reasoning' || updatedType === 'thinking' || updatedType === 'thought') {
        // Reasoning part finalized — mark think block as complete (not partial)
        const streamingEl = container.querySelector('.ocp-msg-assistant.streaming');
        if (streamingEl && streamingEl.dataset.thinkText !== undefined) {
          const thinkHtml = `<details class="ocp-think-block"><summary><span class="ocp-think-icon"><svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5L4 9h4l-1 5.5L12 7H8l1-5.5z"/></svg></span><span class="ocp-think-label">Thought</span><span class="ocp-think-chevron">&#x203A;</span></summary><div class="ocp-think-content">${streamingEl.dataset.thinkText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}</div></details>`;
          const responseHtml = streamingEl.dataset.rawText ? streamingEl.innerHTML.replace(/<details class="ocp-think-block"[\s\S]*?<\/details>/, '') : '';
          streamingEl.innerHTML = thinkHtml + responseHtml;
        }
        setTurnStatus(tab, 'Writing response…', tabStatusDetail(tab));
        update();
      } else if (updatedType === 'text') {
        const hasStreaming = container.querySelector('.ocp-msg-assistant.streaming');
        if (!hasStreaming) {
          renderAssistantPayload(container, part, { textMode: 'stream' });
        }
        setTurnStatus(tab, 'Writing response…', tabStatusDetail(tab));
        if (tab.running) {
          updateThinking(container, {
            title: 'Writing response…',
            detail: tabStatusDetail(tab),
            startedAt: tab.turnStartedAt || Date.now(),
          });
        }
        update();
      } else if (String(part?.type || '').toLowerCase().includes('tool')) {
        const toolName = part.tool || part.toolName || part.name || 'tool';
        const toolId = part.toolCallId || part.callID || part.tool_use_id || part.id || '';
        const toolInput = part.args || part.input || part.arguments || {};

        if (isQuestionTool(toolName)) {
          // OpenCode emits a dedicated question.asked SSE event with the full question
          // payload; the interactive card is rendered from that handler. Suppress the
          // raw tool card here so we don't show a "running" placeholder alongside it.
          if (hasActiveQuestion()) {
            removeThinking(container);
            setTurnStatus(tab, 'Waiting for input…', 'Question');
          }
          update();
          break;
        }

        renderAssistantPayload(container, part, { textMode: 'skip' });
        recordToolStart(tab, toolName, toolId, toolInput);
        setTurnStatus(tab, 'Using tool…', toolName);
        updateThinking(container, {
          title: 'Using tool…',
          detail: toolName,
          startedAt: tab.turnStartedAt || Date.now(),
        });
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
      if (completedMid && _renderedAssistantMsgIds.has(completedMid)) {
        tab.running = false;
        tab.turnStartedAt = 0;
        setTurnStatus(tab);
        update();
        break;
      }
      // Fallback: render content if no streaming element was built
      const hasStreamingLegacy = container.querySelector('.ocp-msg-assistant.streaming');
      renderAssistantPayload(container, event.content ?? event.parts ?? event.text ?? '', {
        textMode: hasStreamingLegacy ? 'skip' : 'stream',
      });
      finalizeStreamingMessage(container);
      _partTypes.clear();
      if (completedMid) _renderedAssistantMsgIds.add(completedMid);
      tab.running = false;
      tab.turnStartedAt = 0;
      setTurnStatus(tab);
      if (event.usage) {
        const raw = event.usage || {};
        tab.threadTokenUsage = normalizeThreadTokenUsage(raw);
        tab.inputTokens = raw.inputTokens || raw.input_tokens || raw.input || 0;
        tab.outputTokens = raw.outputTokens || raw.output_tokens || raw.output || 0;
      }
      notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, event.messageID || event.id || tab.sessionId || tab.id);
      update();
      break;
    }
    case 'tool.start': {
      const toolName = event.tool || event.name || 'tool';
      const toolId = event.toolCallId || event.id || '';
      const toolInput = event.input || event.args || {};

      if (isQuestionTool(toolName)) {
        // If a question is already active, queue this one for later
        if (hasActiveQuestion()) {
          queueQuestion({ event, tab, toolName, toolId, toolInput });
          update();
          break;
        }
        removeThinking(container);
        _activeQuestionToolId = toolId;
        renderQuestionCard(container, toolName, toolInput, toolId, {
          onAnswer: (answers) => {
            lockQuestionCard(container, toolId);
            // Format batched answers as structured text
            if (typeof answers === 'string') {
              sendMessage(answers).then(() => processQuestionQueue(tab, container));
            } else if (answers && typeof answers === 'object') {
              const entries = Object.entries(answers);
              if (entries.length === 1) {
                sendMessage(entries[0][1]).then(() => processQuestionQueue(tab, container));
              } else {
                const lines = entries.map(([q, a]) => `- ${q}: ${a}`);
                sendMessage(`Here are my answers:\n${lines.join('\n')}`).then(() => processQuestionQueue(tab, container));
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
      // Plan exit detection — Anthropic models call ExitPlanMode/plan_exit
      if (tab.mode === 'plan' && /^(ExitPlanMode|plan[_-]exit)$/i.test(toolName)) {
        tab._exitPlanDetected = true;
        capturePlanContent(tab);
        showPostPlanUI(tab);
      }
      setTurnStatus(tab, 'Using tool…', toolName);
      updateThinking(container, {
        title: 'Using tool…',
        detail: toolName,
        startedAt: tab.turnStartedAt || Date.now(),
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

      updateToolCard(
        container,
        toolId,
        event.result ?? event.output ?? event.error ?? '',
        !!event.error,
        {
          status: event.error ? 'error' : 'complete',
          toolName,
          toolInput: event.input ?? event.args,
        }
      );
      recordToolResult(tab, toolName, toolId, event.input ?? event.args, event.result ?? event.output ?? event.error, !!event.error);
      if (tab.running) {
        setTurnStatus(tab, 'Thinking…', 'Processing tool result');
        updateThinking(container, {
          title: 'Thinking…',
          detail: 'Processing tool result',
          startedAt: tab.turnStartedAt || Date.now(),
          waiting: true,
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
        tab.running = false;
        tab.turnStartedAt = 0;
        setTurnStatus(tab);
        removeThinking(container);
        markStuckActivityAsAborted(tab);
        // Fallback plan completion for non-Anthropic models that don't call ExitPlanMode
        if (tab.mode === 'plan' && !tab._exitPlanDetected) {
          capturePlanContent(tab);
          showPostPlanUI(tab);
        }
        notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, tab.sessionId || tab.id);
      }
      update();
      break;
    }
    case 'session.idle': {
      tab.running = false;
      tab.turnStartedAt = 0;
      setTurnStatus(tab);
      removeThinking(container);
      markStuckActivityAsAborted(tab);
      if (tab.mode === 'plan' && !tab._exitPlanDetected) {
        capturePlanContent(tab);
        showPostPlanUI(tab);
      }
      notifyOpenCodeOutcome(NOTIF_TYPE.DONE, tab, tab.sessionId || tab.id);
      update();
      break;
    }
    case 'question.asked': {
      const reqId = event.id || event.requestID || '';
      if (!reqId) break;
      if (hasActiveQuestion()) {
        queueQuestion({ eventType, event, tab, reqId });
        update();
        break;
      }
      renderOpencodeQuestion(tab, container, event, reqId);
      break;
    }
    case 'question.replied':
    case 'question.rejected': {
      const reqId = event.requestID || event.id || '';
      if (reqId) lockQuestionCard(container, reqId);
      if (_activeQuestionToolId === reqId) {
        _activeQuestionToolId = null;
        processQuestionQueue(tab, container);
      }
      break;
    }
    case 'permission.asked': {
      const permId = event.id || event.permissionID || '';
      if (!permId) break;
      if (_activePermissionId === permId) break;
      renderOpencodePermission(tab, container, event, permId);
      break;
    }
    case 'permission.replied':
    case 'permission.rejected': {
      const permId = event.id || event.permissionID || '';
      if (permId) lockPermissionCard(container, permId);
      if (_activePermissionId === permId) _activePermissionId = null;
      break;
    }
    case 'session.error':
    case 'error': {
      removeThinking(container);
      // OpenCode errors: { error: { name, data: { message } } } or flat { message }
      const err = event.error || event;
      const msg = (typeof err === 'string') ? err
        : err?.data?.message || err?.message || (typeof err?.error === 'string' ? err.error : null)
          || JSON.stringify(err);
      renderErrorMessage(container, msg);
      tab.running = false;
      tab.turnStartedAt = 0;
      setTurnStatus(tab, 'Error', msg);
      notifyOpenCodeOutcome(NOTIF_TYPE.ERROR, tab, event.id || event.messageID || tab.sessionId || tab.id);
      update();
      break;
    }
  }
}

// Render an OpenCode /question.asked event as an interactive card and wire up
// reply/reject via the dedicated /question endpoint.
function renderOpencodeQuestion(tab, container, event, requestID) {
  _activeQuestionToolId = requestID;
  const questions = Array.isArray(event.questions) ? event.questions : [event];
  const toolInput = { questions };

  removeThinking(container);
  renderQuestionCard(container, 'question', toolInput, requestID, {
    onAnswer: (answers) => {
      lockQuestionCard(container, requestID);
      const payload = buildQuestionReplyPayload(questions, answers);
      requestWs('question:reply', { requestID, body: payload }, 15000)
        .catch((err) => console.error('[ocp-tabs] question:reply failed:', err));
    },
  });
  setTurnStatus(tab, 'Waiting for input…', 'Question');
  const notifState = ensureNotifState(tab);
  if (notifState && !notifState.questionIds.has(requestID)) {
    notifState.questionIds.add(requestID);
    notifyOpenCode(NOTIF_TYPE.ASK, tab);
  }
  update();
}

// Render an OpenCode /permission.asked event as an interactive card with
// Allow once / Always allow / Reject buttons. Posts reply via WS proxy.
function renderOpencodePermission(tab, container, event, permissionID) {
  _activePermissionId = permissionID;
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
      .catch((err) => {
        console.error('[ocp-tabs] permission:respond failed:', err);
        card.dataset.locked = '';
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      });
    if (_activePermissionId === permissionID) _activePermissionId = null;
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
  const asArray = (val) => (val == null ? [] : String(val).split(',').map((s) => s.trim()).filter(Boolean));
  if (typeof answers === 'string') {
    const list = [asArray(answers)];
    while (list.length < questions.length) list.push([]);
    return { answers: list };
  }
  if (answers && typeof answers === 'object') {
    return {
      answers: questions.map((q) => {
        const key = q.question || q.header || '';
        const v = answers[key] ?? answers[q.header] ?? '';
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
  if (nextMode === 'plan') tab._exitPlanDetected = false;
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
  { key: 'reasoning',    test: c => c?.reasoning,          label: 'Reason', color: '#c084fc', bg: 'rgba(192,132,252,0.12)' },
  { key: 'toolcall',     test: c => c?.toolcall,           label: 'Tools',  color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  { key: 'input.image',  test: c => c?.input?.image,       label: 'Vision', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
  { key: 'input.audio',  test: c => c?.input?.audio,       label: 'Audio',  color: '#fb923c', bg: 'rgba(251,146,60,0.12)' },
  { key: 'input.video',  test: c => c?.input?.video,       label: 'Video',  color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  { key: 'input.pdf',    test: c => c?.input?.pdf,         label: 'PDF',    color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  { key: 'output.image', test: c => c?.output?.image,      label: 'ImgGen', color: '#f472b6', bg: 'rgba(244,114,182,0.12)' },
  { key: 'output.audio', test: c => c?.output?.audio,      label: 'TTS',    color: '#2dd4bf', bg: 'rgba(45,212,191,0.12)' },
  { key: 'attachment',   test: c => c?.attachment,          label: 'Files',  color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
];

function capBadgesHtml(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') return '';
  const caps = modelObj.capabilities;
  if (!caps) return '';
  return CAP_BADGES
    .filter(b => b.test(caps))
    .map(b => `<span class="ocp-cap" style="color:${b.color};background:${b.bg}">${b.label}</span>`)
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

  function makeOption(provId, modelId, entry) {
    const fullId = `${provId}/${modelId}`;
    const badges = capBadgesHtml(entry._obj);
    const isFav = favorites.has(fullId);
    const opt = document.createElement('div');
    opt.className = 'ocp-dd-option' + (fullId === currentModel ? ' selected' : '');
    opt.dataset.modelName = modelId.toLowerCase();
    opt.dataset.fullId = fullId;
    if (entry._obj?.capabilities) opt.dataset.caps = JSON.stringify(entry._obj.capabilities);
    opt.innerHTML = `<span class="ocp-dd-model-name">${modelId}</span>${badges ? `<span class="ocp-dd-caps">${badges}</span>` : ''}`;
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

  // Capability filter pills
  const filterBar = document.createElement('div');
  filterBar.className = 'ocp-cap-filter-bar';
  const activeCaps = new Set();

  // Toggle button — declared before pill loop so pill handlers can reference it
  const filterToggle = document.createElement('button');
  filterToggle.className = 'ocp-cap-filter-toggle';
  filterToggle.type = 'button';
  filterToggle.title = 'Toggle capability filters';
  filterToggle.innerHTML = '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M0.5 2h8M2 4.5h5M3.5 7h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  filterToggle.addEventListener('mousedown', e => e.stopPropagation());
  filterToggle.addEventListener('click', e => {
    e.stopPropagation();
    const collapsed = filterBar.classList.toggle('ocp-cap-filter-bar--hidden');
    filterToggle.classList.toggle('collapsed', collapsed);
    try { localStorage.setItem('ocp-cap-filter-expanded', collapsed ? '0' : '1'); } catch {}
  });

  for (const b of CAP_BADGES) {
    const pill = document.createElement('span');
    pill.className = 'ocp-cap-filter';
    pill.dataset.capKey = b.key;
    pill.textContent = b.label;
    pill.style.color = b.color;
    pill.style.background = b.bg;
    pill.addEventListener('click', e => {
      e.stopPropagation();
      if (activeCaps.has(b.key)) {
        activeCaps.delete(b.key);
        pill.classList.remove('active');
      } else {
        activeCaps.add(b.key);
        pill.classList.add('active');
      }
      filterToggle.classList.toggle('has-active', activeCaps.size > 0);
      applyFilters();
    });
    filterBar.appendChild(pill);
  }
  menu.insertBefore(filterBar, searchInput.nextSibling);

  // Wrap search + filter bar in a single sticky header — eliminates the pixel-gap problem
  const header = document.createElement('div');
  header.className = 'ocp-dd-header';
  menu.insertBefore(header, searchInput);
  header.appendChild(searchInput);
  header.appendChild(filterBar);
  header.appendChild(filterToggle);

  // Restore collapsed state from localStorage
  try {
    if (localStorage.getItem('ocp-cap-filter-expanded') === '0') {
      filterBar.classList.add('ocp-cap-filter-bar--hidden');
      filterToggle.classList.add('collapsed');
    }
  } catch {}

  // Combined search + capability filter
  function applyFilters() {
    const term = searchInput.value.toLowerCase();
    let prevLabel = null, prevLabelVisible = false, labelTextMatch = false;
    for (const el of menu.children) {
      if (el === header) continue;
      if (el.classList.contains('ocp-dd-group-label')) {
        if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
        prevLabel = el;
        labelTextMatch = !term || el.textContent.toLowerCase().includes(term);
        prevLabelVisible = false; // set true only when a model actually matches
      } else if (el.classList.contains('ocp-dd-option')) {
        const nameMatch = !term || (el.dataset.modelName || '').includes(term) || labelTextMatch;
        let capMatch = true;
        if (activeCaps.size > 0 && el.dataset.caps) {
          try {
            const caps = JSON.parse(el.dataset.caps);
            for (const key of activeCaps) {
              const badge = CAP_BADGES.find(b => b.key === key);
              if (badge && !badge.test(caps)) { capMatch = false; break; }
            }
          } catch { capMatch = false; }
        } else if (activeCaps.size > 0) {
          capMatch = false;
        }
        const match = nameMatch && capMatch;
        el.style.display = match ? '' : 'none';
        if (match) prevLabelVisible = true;
      } else if (el.classList.contains('ocp-dd-sep')) {
        el.style.display = prevLabelVisible ? '' : 'none';
        if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
        prevLabel = null; prevLabelVisible = false; labelTextMatch = false;
      }
    }
    if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
  }
  searchInput.addEventListener('input', applyFilters);

  // Update label from current model
  const labelEl = ddEl.querySelector('.ocp-dd-label');
  if (labelEl && currentModel) {
    labelEl.textContent = currentModel.split('/').pop() || currentModel;
  }
}

// ── Render current tab's messages ──

export async function renderTabMessages() {
  const container = panelEl('#ocp-messages');
  if (!container) return;
  const tab = activeTab();
  const seq = ++_renderSeq;

  if (!tab || !tab.sessionId) {
    renderEmptyState(container);
    return;
  }

  container.innerHTML = '<div class="ocp-thinking"><span class="ocp-thinking-dots"><span></span><span></span><span></span></span> Loading…</div>';

  try {
    const messages = await loadMessages(tab.sessionId);
    if (seq !== _renderSeq) return; // stale render — a newer one took over
    renderHistory(container, messages);
    // Restore post-plan card if it was active
    if (tab.showPostPlanActions && tab.planContent) {
      showPostPlanUI(tab);
    }
    // Re-show thinking indicator if the tab is mid-turn — history render wipes it,
    // and SSE events may not fire again for a while.
    if (tab.running) {
      updateThinking(container, {
        title: tab.statusText || 'Thinking…',
        detail: tab.statusDetail || '',
        startedAt: tab.turnStartedAt || Date.now(),
      });
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

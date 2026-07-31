// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Panel container
// Mounts a slide-in sidepanel on the right edge. Owns the lifecycle:
//   first toggle  → inject styles, build DOM, connect WS, ensure session
//   subsequent    → just slide in/out; state persists
// Exposes toggleOpencodePanel / isOpencodePanelOpen / openOpencodeWithPrompt
// / attachPathToOpencode to match the surface shared UI modules bind against.
// ─────────────────────────────────────────────────────────────────────────────

import { state, emit, on } from '../state.js';
import { storage } from '../storage.js';
import { fetchProjects } from '../api.js';
import { injectStyles } from './ocp-v2-styles.js';
import { connect, api } from './ocp-v2-ws.js';
import {
  getState, subscribe, setSession, setServerStatus, setCwd, clearMessages, pushError, clearErrors, setHealing,
  upsertMessage, upsertPart, addAttachedImage, getDefaultStore, setRunning,
} from './ocp-v2-state.js';
import { mountContextGauge } from './ocp-v2-context-gauge.js';
import { mountCompactButton } from './ocp-v2-compact-button.js';
import { mountRenderer } from './ocp-v2-render.js';
import { mountCompose, focusCompose, appendPathToCompose } from './ocp-v2-send.js';
import { mountProjectBar, unmountProjectBar } from './ocp-v2-projectbar.js';
import { reserveRightPanelLayout, clearRightPanelLayout, setRightPanelResizing } from '../ui-sidepanel-layout.js';
import { isClaudePanelOpen, toggleClaudePanel } from '../ui-claude-panel.js';
import { isCodexPanelOpen, toggleCodexPanel } from '../ui-codex-panel.js';
import { nativeLoopWindowId } from '../ui-native-window-id.js';
import { requestGeneratedSessionTitle } from '../session-title.js';
import {
  registerAutomationSession, unregisterAutomationSession,
} from './ocp-v2-automation-ownership.js';
import {
  registerPrimaryPanel, bindPrimarySession, isActiveChildPanelOpen, hideActiveChildPanel,
} from './ocp-v2-manager.js';

const PANEL_ID = 'ocp-v2-panel';
const PANEL_OWNER = 'ocp-v2-panel';
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 700;

const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_MINIMIZE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12"/></svg>';
const ICON_SLIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_X_SMALL = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const OPENCODE_ICON = '<svg viewBox="0 0 24 30" fill="currentColor"><path d="M18 6H6V24H18V6ZM24 30H0V0H24V30Z"/></svg>';

const STOR_PROJECT = 'opencode-v2-project';
let OCP_WINDOW_ID = (() => {
  let value = sessionStorage.getItem('ocp-window-id');
  if (!value) { value = crypto.randomUUID(); sessionStorage.setItem('ocp-window-id', value); }
  return value;
})();
let STOR_TABS = `opencode-v2-tabs-${OCP_WINDOW_ID}`;
let STOR_AUTOMATIONS = `opencode-v2-automations-${OCP_WINDOW_ID}`;
let STOR_TITLE_STATES = `opencode-v2-title-states-${OCP_WINDOW_ID}`;
const STOR_WINDOW_REGISTRY = 'opencode-v2-windows';
const HEAL_DEBOUNCE_MS = 800;
const HEAL_RETRY_MAX_MS = 30000;

let _panelEl = null;
let _statusEl = null;
let _titleEl = null;
let _tabSessionIds = [];        // ordered session IDs that own a tray pill
let _tabPills = new Map();      // sessionId -> pill element
let _tabInfoCache = new Map();  // sessionId -> last-known session info (title, etc.)
const _automationRunIds = new Map(); // sessionId -> native loop runId
const _automationRunning = new Set();
const _automationContinuedManually = new Set();
const _automationManualSendInFlight = new Set();
const _foreignActiveAutomationSessions = new Set();
let _visible = false;
let _booted = false;
let _bootPromise = null;
let _pendingAutomationAttach = null;
let _unsubHeader = null;
let _trayClickWired = false;
let _projects = [];
let _projectsLoaded = false;
let _projectsLoadPromise = null;
let _sessionMenuEl = null;
let _sessionBtnEl = null;
let _sessionLabelEl = null;
let _renameBtnEl = null;
let _docClickWired = false;
let _healTimer = null;
let _healingPromise = null;
let _healRetryCount = 0;
const _sessionTitleState = new Map(); // sessionId -> { state, title, requestId, controller }
const _titleReassertTimers = new Map();

function forkClonedOpenCodePersistence() {
  try {
    const rows = JSON.parse(storage.getItem(STOR_AUTOMATIONS) || '[]');
    const foreignActiveIds = new Set((Array.isArray(rows) ? rows : [])
      .filter((row) => row?.running && row?.sessionId && row.ownerId !== nativeLoopWindowId)
      .map((row) => row.sessionId));
    if (!foreignActiveIds.size) return;
    const savedTabs = JSON.parse(storage.getItem(STOR_TABS) || '[]');
    const transferableTabs = (Array.isArray(savedTabs) ? savedTabs : [])
      .filter((sessionId) => !foreignActiveIds.has(sessionId));
    const transferableRows = (Array.isArray(rows) ? rows : [])
      .filter((row) => !foreignActiveIds.has(row?.sessionId));
    let transferableTitleStates = {};
    try {
      const savedTitleStates = JSON.parse(storage.getItem(STOR_TITLE_STATES) || '{}');
      transferableTitleStates = Object.fromEntries(Object.entries(savedTitleStates)
        .filter(([sessionId]) => transferableTabs.includes(sessionId)));
    } catch {}
    OCP_WINDOW_ID = crypto.randomUUID();
    sessionStorage.setItem('ocp-window-id', OCP_WINDOW_ID);
    STOR_TABS = `opencode-v2-tabs-${OCP_WINDOW_ID}`;
    STOR_AUTOMATIONS = `opencode-v2-automations-${OCP_WINDOW_ID}`;
    STOR_TITLE_STATES = `opencode-v2-title-states-${OCP_WINDOW_ID}`;
    if (transferableTabs.length) storage.setItem(STOR_TABS, JSON.stringify(transferableTabs));
    if (transferableRows.length) storage.setItem(STOR_AUTOMATIONS, JSON.stringify(transferableRows));
    if (Object.keys(transferableTitleStates).length) storage.setItem(STOR_TITLE_STATES, JSON.stringify(transferableTitleStates));
  } catch {}
}

function cleanStaleOpenCodeWindows() {
  try {
    const registry = JSON.parse(storage.getItem(STOR_WINDOW_REGISTRY) || '{}');
    const now = Date.now();
    for (const [windowId, lastSeen] of Object.entries(registry)) {
      if (windowId === OCP_WINDOW_ID || now - Number(lastSeen) <= 24 * 60 * 60 * 1000) continue;
      storage.removeItem(`opencode-v2-tabs-${windowId}`);
      storage.removeItem(`opencode-v2-automations-${windowId}`);
      storage.removeItem(`opencode-v2-title-states-${windowId}`);
      delete registry[windowId];
    }
    registry[OCP_WINDOW_ID] = now;
    storage.setItem(STOR_WINDOW_REGISTRY, JSON.stringify(registry));
  } catch {}
}

function touchOpenCodeWindow() {
  try {
    const registry = JSON.parse(storage.getItem(STOR_WINDOW_REGISTRY) || '{}');
    registry[OCP_WINDOW_ID] = Date.now();
    storage.setItem(STOR_WINDOW_REGISTRY, JSON.stringify(registry));
  } catch {}
}

forkClonedOpenCodePersistence();
cleanStaleOpenCodeWindows();

function loadTitleStates() {
  try {
    const raw = JSON.parse(storage.getItem(STOR_TITLE_STATES) || '{}');
    for (const [sid, entry] of Object.entries(raw)) {
      if (!sid || !entry || typeof entry !== 'object') continue;
      _sessionTitleState.set(sid, {
        state: entry.state === 'generating' ? 'default' : (entry.state || 'manual'),
        title: entry.title || '',
        requestId: null,
        controller: null,
      });
    }
  } catch {}
}

function saveTitleStates() {
  try {
    const rows = {};
    for (const [sid, entry] of _sessionTitleState) {
      rows[sid] = {
        state: entry.state === 'generating' ? 'default' : (entry.state || 'default'),
        title: entry.title || '',
      };
    }
    if (Object.keys(rows).length) storage.setItem(STOR_TITLE_STATES, JSON.stringify(rows));
    else storage.removeItem(STOR_TITLE_STATES);
  } catch {}
}

loadTitleStates();

function saveAutomationTabs() {
  try {
    const localRows = [..._automationRunIds].map(([sessionId, runId]) => ({
      sessionId,
      runId,
      running: _automationRunning.has(sessionId),
      ownerId: nativeLoopWindowId,
      continuedManually: _automationContinuedManually.has(sessionId),
    }));
    const localSessionIds = new Set(localRows.map((row) => row.sessionId));
    let foreignRows = [];
    try {
      const existing = JSON.parse(storage.getItem(STOR_AUTOMATIONS) || '[]');
      foreignRows = (Array.isArray(existing) ? existing : []).filter((row) => (
        row?.sessionId
        && row?.runId
        && row.ownerId !== nativeLoopWindowId
        && !localSessionIds.has(row.sessionId)
      ));
    } catch {}
    const rows = [...localRows, ...foreignRows];
    if (rows.length) storage.setItem(STOR_AUTOMATIONS, JSON.stringify(rows));
    else storage.removeItem(STOR_AUTOMATIONS);
    touchOpenCodeWindow();
  } catch {}
}

try {
  const rows = JSON.parse(storage.getItem(STOR_AUTOMATIONS) || '[]');
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.sessionId || !row?.runId) continue;
    if (row.running && row.ownerId !== nativeLoopWindowId) {
      _foreignActiveAutomationSessions.add(row.sessionId);
      continue;
    }
    _automationRunIds.set(row.sessionId, row.runId);
    registerAutomationSession(row.sessionId, row.runId);
    if (row.running) _automationRunning.add(row.sessionId);
    if (row.continuedManually) _automationContinuedManually.add(row.sessionId);
  }
} catch {}

function buildPanel() {
  injectStyles();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'ocpv2-panel';

  // ── Resize handle (left edge) ─────────────────────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'ocpv2-resize-handle';
  panel.appendChild(resizeHandle);
  wireResize(panel, resizeHandle);

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'ocpv2-header';

  // Session button + rename group (acts as title + dropdown trigger)
  const sessionBtn = document.createElement('button');
  sessionBtn.className = 'ocpv2-session-btn';
  sessionBtn.type = 'button';
  const sessionLabel = document.createElement('span');
  sessionLabel.className = 'ocpv2-session-label';
  sessionLabel.textContent = 'OpenCode';
  const arrow = document.createElement('span');
  arrow.className = 'ocpv2-dd-arrow';
  arrow.innerHTML = '&#x25BE;';
  sessionBtn.appendChild(sessionLabel);
  sessionBtn.appendChild(arrow);
  sessionBtn.addEventListener('click', (event) => {
    if (event.target.closest('.ocpv2-rename-input')) return;
    toggleSessionMenu();
  });
  header.appendChild(sessionBtn);
  _sessionBtnEl = sessionBtn;
  _sessionLabelEl = sessionLabel;
  _titleEl = sessionLabel;

  const renameBtn = document.createElement('button');
  renameBtn.className = 'ocpv2-header-rename';
  renameBtn.type = 'button';
  renameBtn.title = 'Rename';
  renameBtn.setAttribute('data-tooltip', 'Rename');
  renameBtn.innerHTML = ICON_EDIT;
  renameBtn.addEventListener('mousedown', (event) => {
    if (sessionLabel.querySelector('.ocpv2-rename-input')) event.preventDefault();
  });
  renameBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    closeSessionMenu();
    beginRenameSession();
  });
  header.appendChild(renameBtn);
  _renameBtnEl = renameBtn;

  const status = document.createElement('div');
  status.className = 'ocpv2-header-status';
  status.textContent = '…';
  _statusEl = status;
  header.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'ocpv2-actions';

  const newBtn = document.createElement('button');
  newBtn.className = 'ocpv2-btn';
  newBtn.type = 'button';
  newBtn.title = 'New session';
  newBtn.setAttribute('data-tooltip', 'New session');
  newBtn.setAttribute('data-tooltip-pos', 'bottom');
  newBtn.innerHTML = ICON_PLUS;
  newBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    beginNewSession();
  });
  actions.appendChild(newBtn);

  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = 'ocpv2-btn';
  minimizeBtn.type = 'button';
  minimizeBtn.title = 'Minimize';
  minimizeBtn.setAttribute('data-tooltip', 'Minimize');
  minimizeBtn.setAttribute('data-tooltip-pos', 'bottom');
  minimizeBtn.innerHTML = ICON_MINIMIZE;
  minimizeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setVisible(false);
  });
  actions.appendChild(minimizeBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ocpv2-btn ocpv2-btn-danger';
  closeBtn.type = 'button';
  closeBtn.title = 'Close session';
  closeBtn.setAttribute('data-tooltip', 'Close session');
  closeBtn.setAttribute('data-tooltip-pos', 'bottom');
  closeBtn.innerHTML = ICON_X;
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    closeCurrentSession();
  });
  actions.appendChild(closeBtn);

  const slideBtn = document.createElement('button');
  slideBtn.className = 'ocpv2-btn ocpv2-btn-slide';
  slideBtn.type = 'button';
  slideBtn.title = 'Slide';
  slideBtn.setAttribute('data-tooltip', 'Slide');
  slideBtn.setAttribute('data-tooltip-pos', 'bottom');
  slideBtn.innerHTML = ICON_SLIDE;
  slideBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setVisible(false);
  });
  actions.appendChild(slideBtn);

  header.appendChild(actions);

  // Session menu (anchored to header via absolute positioning)
  const sessionMenu = document.createElement('div');
  sessionMenu.className = 'ocpv2-session-menu';
  header.appendChild(sessionMenu);
  _sessionMenuEl = sessionMenu;

  panel.appendChild(header);

  const contextBar = document.createElement('div');
  contextBar.className = 'ocpv2-contextbar';
  mountContextGauge(contextBar, getDefaultStore());
  mountCompactButton(contextBar, getDefaultStore());
  panel.appendChild(contextBar);

  // ── Messages scroll area (card wrapper + absolute scroll list) ──────────
  const messagesContainer = document.createElement('div');
  messagesContainer.className = 'ocpv2-messages-container';
  const messages = document.createElement('div');
  messages.className = 'ocpv2-messages';
  messagesContainer.appendChild(messages);
  panel.appendChild(messagesContainer);

  // ── Compose footer ───────────────────────────────────────────────────────
  const compose = document.createElement('div');
  compose.className = 'ocpv2-compose';
  panel.appendChild(compose);

  document.body.appendChild(panel);
  _panelEl = panel;

  const renderer = mountRenderer(messages);
  mountCompose(compose, getDefaultStore(), {
    onBeforeSend: () => renderer.scrollToBottom({ force: true }),
    canSend: (session) => !_automationRunning.has(session?.sessionId),
    onManualSend: (session, phase, meta) => {
      const sessionId = session?.sessionId;
      if (phase === 'started') requestOpenCodeSessionTitle(session, meta);
      if (!sessionId || !_automationRunIds.has(sessionId) || _automationRunning.has(sessionId)) return;
      if (phase === 'started') _automationManualSendInFlight.add(sessionId);
      if (phase === 'failed') _automationManualSendInFlight.delete(sessionId);
      if (phase === 'succeeded') {
        _automationManualSendInFlight.delete(sessionId);
        _automationContinuedManually.add(sessionId);
        saveAutomationTabs();
      }
    },
    onAbort: async (session) => {
      const runId = _automationRunIds.get(session?.sessionId);
      if (!runId || !_automationRunning.has(session?.sessionId)) return false;
      await fetch('/api/loop/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      }).catch(() => {});
      _automationRunning.delete(session.sessionId);
      saveAutomationTabs();
      return true;
    },
  });

  // Project + branch dropdowns — mounted INSIDE the compose card, above input-area.
  mountProjectBar(compose, {
    getProjects: () => _projects,
    ensureProjectsLoaded: () => loadProjectsOnce(),
    setActiveProject,
  });

  // Header reflects state
  _unsubHeader = subscribe(handleStoreEvent);
  syncHeader();
}

function handleStoreEvent(event, stateSnapshot) {
  const nextState = stateSnapshot || getState();
  if (event?.type === 'running:set' && !nextState.running && nextState.sessionId) {
    _titleNeedsReassert(nextState.sessionId);
  }
  syncHeader();
  maybeScheduleAutoHeal(event, nextState);
}

function syncHeader() {
  if (!_statusEl) return;
  const s = getState();
  _statusEl.className = 'ocpv2-header-status';
  if (s.healing) {
    _statusEl.classList.add('ocpv2-status-healing');
    _statusEl.textContent = 'healing';
  } else if (s.pendingPermission) {
    _statusEl.classList.add('ocpv2-status-awaiting');
    _statusEl.textContent = 'awaiting permission';
  } else if (s.running) {
    _statusEl.classList.add('ocpv2-status-running');
    _statusEl.textContent = 'running';
  } else if (s.serverStatus === 'reconnecting') {
    _statusEl.classList.add('ocpv2-status-reconnecting');
    _statusEl.textContent = 'reconnecting';
  } else if (s.serverStatus === 'error' || s.errors.length) {
    _statusEl.classList.add('ocpv2-status-error');
    _statusEl.textContent = 'error';
  } else if (s.serverStatus === 'offline') {
    _statusEl.textContent = 'offline';
  } else {
    _statusEl.classList.add('ocpv2-status-ready');
    _statusEl.textContent = 'idle';
  }
  // Skip label update while user is mid-rename (input is mounted in the label).
  if (_sessionLabelEl && !_sessionLabelEl.querySelector('.ocpv2-rename-input')) {
    _sessionLabelEl.textContent = sessionTitleFor(s);
  }
  if (_renameBtnEl) {
    _renameBtnEl.disabled = !s.sessionId;
  }
  renderPill();
}

function maybeScheduleAutoHeal(event, s) {
  if (!event || !_panelEl) return;
  if (event.type === 'server:status') {
    if (s.serverStatus === 'offline' || s.serverStatus === 'reconnecting' || s.serverStatus === 'error') {
      scheduleAutoHeal(`server:${s.serverStatus}`);
    }
    return;
  }
  if (event.type === 'error:push') {
    const lastError = s.errors[s.errors.length - 1];
    if (isRecoverablePanelError(lastError)) scheduleAutoHeal('recoverable-error');
  }
}

function scheduleAutoHeal(reason, delayMs = HEAL_DEBOUNCE_MS) {
  if (_healingPromise || _healTimer) return;
  _healTimer = setTimeout(() => {
    _healTimer = null;
    runAutoHeal(reason).catch((err) => {
      console.warn('[ocp-v2-panel] auto-heal failed', err);
    });
  }, Math.max(0, delayMs));
}

async function runAutoHeal(reason) {
  if (_healingPromise) return _healingPromise;
  _healingPromise = (async () => {
    let retryDelay = 0;
    setHealing(true);
    try {
      await connect();
      const init = await api.init();
      if (!init?.ready) throw new Error('OpenCode server is not ready');
      setServerStatus({
        status: 'ready',
        port: init.port,
        version: init.version,
        managed: init.managed,
      });
      await rehydrateActiveSession();
      clearErrors();
      _booted = true;
      _healRetryCount = 0;
    } catch (err) {
      console.warn('[ocp-v2-panel] auto-heal attempt failed', { reason, message: err?.message || String(err) });
      setServerStatus({ status: 'error' });
      _healRetryCount += 1;
      retryDelay = Math.min(HEAL_RETRY_MAX_MS, 1000 * Math.pow(2, Math.min(_healRetryCount, 5)));
    } finally {
      setHealing(false);
      _healingPromise = null;
      if (retryDelay) scheduleAutoHeal('retry', retryDelay);
    }
  })();
  return _healingPromise;
}

async function rehydrateActiveSession() {
  const sid = getState().sessionId;
  if (sid) {
    try {
      const res = await api.sessionGet(sid);
      if (res?.error || (res?.status && res.status >= 400) || !res?.data) {
        throw new Error(res?.error || res?.data?.error || `Session ${sid.slice(0, 8)} is unavailable`);
      }
      setSession(sid, res.data);
      ensureTab(sid, res.data);
      try { await refreshSessionMessages(sid); }
      catch (err) { console.warn('[ocp-v2-panel] auto-heal messages refresh failed', err); }
      return;
    } catch (err) {
      console.warn('[ocp-v2-panel] auto-heal session refresh failed', err);
      removeTab(sid);
    }
  }
  const cwd = getState().cwd || storage.getItem(STOR_PROJECT) || undefined;
  await startFreshSession({ cwd });
}

async function refreshSessionMessages(sessionId) {
  const list = await api.sessionMessages(sessionId);
  if (list?.error || (list?.status && list.status >= 400)) {
    throw new Error(list?.error || list?.data?.error || 'Session messages unavailable');
  }
  const items = list?.data || [];
  for (const { info: msgInfo, parts } of items) {
    if (!msgInfo?.id) continue;
    upsertMessage(msgInfo);
    for (const part of (parts || [])) upsertPart(part);
  }
  syncRunningFromHydration(items);
}

// After hydrating a session's transcript, decide whether the server is still
// streaming. Without this, switching to (or reloading into) a session with an
// in-flight turn leaves the header stuck on "idle" until the next event.
function syncRunningFromHydration(items) {
  if (!Array.isArray(items) || !items.length) {
    if (getState().running) setRunning(false);
    return;
  }
  let inFlight = false;
  for (const item of items) {
    const info = item?.info;
    if (info?.role === 'assistant') {
      const completed = info?.time?.completed;
      if (completed == null || completed === 0) { inFlight = true; break; }
    }
    for (const part of (item?.parts || [])) {
      const status = part?.state?.status || part?.status;
      if (status === 'running' || status === 'pending') { inFlight = true; break; }
    }
    if (inFlight) break;
  }
  if (inFlight && !getState().running) setRunning(true);
  if (!inFlight && getState().running) setRunning(false);
}

function isRecoverablePanelError(err) {
  const msg = String(err?.message || err?.error || err || '').trim();
  if (!msg) return true;
  if (/choose continue|question reply failed|plan action failed|could not create plan file|rename failed/i.test(msg)) return false;
  return /websocket|closed|disconnect|offline|reconnect|request timeout|timeout|network|failed|server|session|opencode|send|boot|no session|not connected/i.test(msg);
}

// ── Session picker + rename ─────────────────────────────────────────────────

function sessionTitleFor(stateOrSession) {
  const info = stateOrSession?.sessionInfo || stateOrSession?.info || stateOrSession || {};
  const id = stateOrSession?.sessionId || info?.id || info?.sessionID || '';
  const candidates = [info?.title, info?.description, info?.slug];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return id ? id.slice(0, 8) : 'New session';
}

function ensureOpenCodeTitleState(sessionId, info = null, { fresh = false, manual = false } = {}) {
  if (!sessionId) return null;
  let entry = _sessionTitleState.get(sessionId);
  if (!entry) {
    entry = {
      state: fresh && !manual ? 'default' : 'manual',
      title: manual ? sessionTitleFor({ sessionId, sessionInfo: info }) : '',
      requestId: null,
      controller: null,
    };
    _sessionTitleState.set(sessionId, entry);
    saveTitleStates();
  }
  return entry;
}

function updateOpenCodeTitleLocally(sessionId, title) {
  if (!sessionId || !title) return;
  const active = getState();
  const current = sessionId === active.sessionId
    ? active.sessionInfo
    : _tabInfoCache.get(sessionId);
  const updated = { ...(current || {}), id: sessionId, title };
  _tabInfoCache.set(sessionId, updated);
  if (sessionId === active.sessionId) setSession(sessionId, updated);
  ensureTab(sessionId, updated);
  renderPill();
}

function markOpenCodeTitleManual(sessionId, title = '') {
  if (!sessionId) return;
  const entry = ensureOpenCodeTitleState(sessionId);
  entry.controller?.abort();
  entry.controller = null;
  entry.requestId = null;
  entry.state = 'manual';
  entry.title = title || sessionTitleFor({ sessionId, sessionInfo: _tabInfoCache.get(sessionId) });
  saveTitleStates();
  _titleNeedsReassert(sessionId);
}

function _titleNeedsReassert(sessionId) {
  const entry = _sessionTitleState.get(sessionId);
  if (!entry || !['auto', 'manual'].includes(entry.state) || !entry.title) return;
  const existing = _titleReassertTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _titleReassertTimers.delete(sessionId);
    const latest = _sessionTitleState.get(sessionId);
    if (!latest || !['auto', 'manual'].includes(latest.state) || !latest.title) return;
    api.sessionUpdate(sessionId, { title: latest.title }).then(() => {
      updateOpenCodeTitleLocally(sessionId, latest.title);
    }).catch(() => {});
  }, 150);
  _titleReassertTimers.set(sessionId, timer);
}

function requestOpenCodeSessionTitle(session, meta = {}) {
  const sessionId = session?.sessionId;
  if (!sessionId || _automationRunIds.has(sessionId)) return;
  const entry = ensureOpenCodeTitleState(sessionId);
  if (!entry || entry.state !== 'default') return;
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  entry.state = 'generating';
  entry.requestId = requestId;
  entry.controller = controller;
  saveTitleStates();

  requestGeneratedSessionTitle({
    provider: 'opencode',
    prompt: meta.prompt || '',
    paths: meta.paths || [],
    hasImages: !!meta.hasImages,
    cwd: session.cwd || undefined,
    model: session.model || undefined,
    mode: meta.mode || session.mode || 'build',
    agent: meta.agent || session.agent || undefined,
    variant: session.variant || undefined,
  }, { signal: controller.signal }).then(({ title }) => {
    const current = _sessionTitleState.get(sessionId);
    if (!title || !current || current.state !== 'generating' || current.requestId !== requestId) return;
    current.state = 'auto';
    current.title = title;
    current.requestId = null;
    current.controller = null;
    saveTitleStates();
    updateOpenCodeTitleLocally(sessionId, title);
    _titleNeedsReassert(sessionId);
  }).finally(() => {
    const current = _sessionTitleState.get(sessionId);
    if (!current || current.requestId !== requestId) return;
    current.requestId = null;
    current.controller = null;
    if (current.state === 'generating') current.state = 'default';
    saveTitleStates();
  });
}

function sessionMatchesProject(session, projectPath) {
  if (!projectPath) return true;
  const dir = session?.directory || '';
  if (!dir) return false;
  const trimmed = projectPath.replace(/\/+$/, '');
  return dir === trimmed || dir.startsWith(trimmed + '/');
}

function toggleSessionMenu() {
  if (!_sessionMenuEl) return;
  if (_sessionMenuEl.classList.contains('open')) {
    closeSessionMenu();
  } else {
    openSessionMenu();
  }
}

function openSessionMenu() {
  if (!_sessionMenuEl) return;
  _sessionMenuEl.classList.add('open');
  wireOutsideClick();
  renderSessionMenu();
}

function closeSessionMenu() {
  _sessionMenuEl?.classList.remove('open');
}

function wireOutsideClick() {
  if (_docClickWired) return;
  _docClickWired = true;
  document.addEventListener('mousedown', (event) => {
    if (!_sessionMenuEl?.classList.contains('open')) return;
    if (event.target.closest('.ocpv2-session-menu')) return;
    if (event.target.closest('.ocpv2-session-btn')) return;
    closeSessionMenu();
  });
}

async function renderSessionMenu() {
  if (!_sessionMenuEl) return;
  _sessionMenuEl.innerHTML = '<div class="ocpv2-session-menu-empty">Loading…</div>';

  let sessions = [];
  try {
    const res = await api.sessionList();
    sessions = Array.isArray(res?.data) ? res.data : (res?.data?.sessions || []);
  } catch (err) {
    console.warn('[ocp-v2-panel] sessionList failed', err);
    _sessionMenuEl.innerHTML = '<div class="ocpv2-session-menu-empty">Failed to load sessions</div>';
    return;
  }

  const s = getState();
  const cwd = s.cwd || storage.getItem(STOR_PROJECT) || '';
  // Show ALL sessions from EVERY project so users can resume sessions
  // from other registered projects (e.g. CriticalPixel, EllaCred).
  // Sessions from the current project are still prioritized visually.
  const all = sessions;
  all.sort((a, b) => {
    const ta = a?.time?.updated || a?.time?.created || 0;
    const tb = b?.time?.updated || b?.time?.created || 0;
    return tb - ta;
  });

  _sessionMenuEl.innerHTML = '';

  const newItem = document.createElement('div');
  newItem.className = 'ocpv2-session-item';
  newItem.innerHTML = '<span class="ocpv2-session-item-label" style="opacity:0.55">+ New session</span>';
  newItem.addEventListener('click', () => {
    closeSessionMenu();
    beginNewSession();
  });
  _sessionMenuEl.appendChild(newItem);

  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'ocpv2-session-menu-empty';
    empty.textContent = 'No sessions yet.';
    _sessionMenuEl.appendChild(empty);
    return;
  }

  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin:4px 8px';
  _sessionMenuEl.appendChild(sep);

  for (const sess of all) {
    const sid = sess.id || sess.sessionID;
    if (!sid) continue;
    const title = sessionTitleFor({ sessionInfo: sess, sessionId: sid });
    const isActive = sid === s.sessionId;
    const isOtherProject = cwd && sess.directory && !sessionMatchesProject(sess, cwd);
    const projectName = isOtherProject && sess.directory
      ? (sess.directory.split('/').filter(Boolean).pop() || sess.directory.split('/').pop() || sess.directory)
      : '';

    const item = document.createElement('div');
    item.className = 'ocpv2-session-item' + (isActive ? ' active' : '');
    if (title && title.length > 8) {
      const tip = (isOtherProject ? projectName + ' · ' : '') + title;
      const displayTip = tip.length > 200 ? tip.slice(0, 200) + '\u2026' : tip;
      item.setAttribute('data-tooltip', displayTip);
      item.setAttribute('data-tooltip-pos', 'left');
    }

    const labelEl = document.createElement('span');
    labelEl.className = 'ocpv2-session-item-label';
    labelEl.textContent = title;
    item.appendChild(labelEl);

    if (isOtherProject && projectName) {
      const projectEl = document.createElement('span');
      projectEl.className = 'ocpv2-session-item-project';
      projectEl.textContent = projectName;
      projectEl.style.cssText = 'font-size:9px;opacity:0.45;margin-left:6px;';
      labelEl.appendChild(projectEl);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'ocpv2-session-item-delete';
    delBtn.type = 'button';
    delBtn.setAttribute('data-tooltip', 'Delete');
    delBtn.innerHTML = ICON_X_SMALL;
    delBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasRunning = sid === getState().sessionId && !!getState().running;
      const deletePromise = closeSessionBackend(sid, {
        wasRunning,
        context: 'session menu delete',
      });
      item.remove();
      handlePillClose(sid).catch((err) => {
        console.warn('[ocp-v2-panel] local session menu delete failed', err);
      }).finally(() => {
        deletePromise.finally(() => {
          if (_sessionMenuEl?.classList.contains('open')) renderSessionMenu();
        });
      });
    });
    item.appendChild(delBtn);

    labelEl.addEventListener('click', () => {
      closeSessionMenu();
      switchToSession(sid, sess);
    });
    _sessionMenuEl.appendChild(item);
  }
}

async function switchToSession(sid, info = null) {
  if (!sid) return;
  if (sid === getState().sessionId) return;
  ensureOpenCodeTitleState(sid, info, { manual: true });
  // Keep the previously-active session as a tab pill before swapping — but only
  // if it's still in the tab list. handlePillClose removes the tab BEFORE
  // calling us; without this guard the just-deleted session would resurrect.
  const prevSid = getState().sessionId;
  if (prevSid && _tabSessionIds.includes(prevSid)) {
    ensureTab(prevSid, getState().sessionInfo);
  }
  clearMessages();
  setSession(sid, info);
  ensureTab(sid, info);
  bindPrimarySession(getDefaultStore(), sid);
  // Sync state.cwd to the picked session's directory so the projectbar + agent
  // both reflect where this session actually runs.
  const dirFromInfo = info?.directory;
  if (dirFromInfo && dirFromInfo !== getState().cwd) {
    setCwd(dirFromInfo);
    storage.setItem(STOR_PROJECT, dirFromInfo);
  }
  // Best-effort hydrate of full transcript
  try {
    const list = await api.sessionMessages(sid);
    const items = list?.data || [];
    for (const { info: msgInfo, parts } of items) {
      if (!msgInfo?.id) continue;
      upsertMessage(msgInfo);
      for (const part of (parts || [])) upsertPart(part);
    }
    syncRunningFromHydration(items);
  } catch (err) {
    console.warn('[ocp-v2-panel] sessionMessages failed', err);
  }
  // Refresh session info from server so title stays correct after switch
  if (!info) {
    try {
      const res = await api.sessionGet(sid);
      if (res?.data) {
        setSession(sid, res.data);
        ensureTab(sid, res.data);
        const dir = res.data.directory;
        if (dir && dir !== getState().cwd) {
          setCwd(dir);
          storage.setItem(STOR_PROJECT, dir);
        }
      }
    } catch {}
  }
  renderPill();
}

function beginRenameSession() {
  const s = getState();
  if (!s.sessionId || !_sessionLabelEl) return;
  if (_sessionLabelEl.querySelector('.ocpv2-rename-input')) {
    _sessionLabelEl.querySelector('.ocpv2-rename-input').focus();
    return;
  }

  const currentTitle = sessionTitleFor(s);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ocpv2-rename-input';
  input.value = currentTitle === 'New session' ? '' : currentTitle;
  input.placeholder = 'Session name…';
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('mousedown', (event) => event.stopPropagation());
  _sessionLabelEl.textContent = '';
  _sessionLabelEl.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const restoreLabel = () => {
    if (_sessionLabelEl.contains(input)) {
      _sessionLabelEl.textContent = sessionTitleFor(getState());
    }
  };
  const finish = async (cancel = false) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    if (cancel || !next || next === currentTitle) {
      restoreLabel();
      return;
    }
    markOpenCodeTitleManual(s.sessionId, next);
    try {
      await api.sessionUpdate(s.sessionId, { title: next });
      const updated = { ...(s.sessionInfo || {}), id: s.sessionId, title: next };
      setSession(s.sessionId, updated);
    } catch (err) {
      console.warn('[ocp-v2-panel] rename failed', err);
      pushError({ message: err?.message || 'Rename failed' });
      restoreLabel();
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(false); }
    if (event.key === 'Escape') { event.preventDefault(); finish(true); }
  });
  input.addEventListener('blur', () => finish(false));
}

async function boot() {
  if (_booted) return;
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    try {
      // 1. Ensure server up + WS open
      const init = await api.init();
      setServerStatus({
        status: init?.ready ? 'ready' : 'offline',
        port: init?.port,
        version: init?.version,
        managed: init?.managed,
      });
      // 2. Register with the multi-panel manager so child sub-agent sessions
      //    get auto-spawned panels.
      registerPrimaryPanel({
        panelId: PANEL_OWNER,
        store: getDefaultStore(),
        getSessionId: () => getState().sessionId,
      });
      // 3. Kick off project load in parallel — used by promptNameNewSession modal
      loadProjectsOnce().catch(() => {});
      // 4. Restore last-used project as default cwd
      const lastProject = storage.getItem(STOR_PROJECT) || '';
      if (lastProject) setCwd(lastProject);
      // 5. Restore tab sessions from previous run (drop ones the server lost)
      const savedTabs = loadTabSessions();
      const liveTabs = [];
      if (savedTabs.length) {
        let serverSessions = [];
        try {
          const res = await api.sessionList();
          serverSessions = Array.isArray(res?.data) ? res.data : (res?.data?.sessions || []);
        } catch (err) {
          console.warn('[ocp-v2-panel] sessionList failed during tab restore', err);
        }
        const byId = new Map(serverSessions.map((s) => [s?.id || s?.sessionID, s]));
        for (const sid of savedTabs) {
          const info = byId.get(sid);
          if (info) {
            liveTabs.push(sid);
            _tabInfoCache.set(sid, info);
            ensureOpenCodeTitleState(sid, info, { manual: true });
          }
        }
        _tabSessionIds = liveTabs;
        saveTabSessions();
      }
      if (!liveTabs.length && _pendingAutomationAttach?.sessionId) {
        const { sessionId, info } = _pendingAutomationAttach;
        liveTabs.push(sessionId);
        _tabInfoCache.set(sessionId, info || { id: sessionId });
        ensureOpenCodeTitleState(sessionId, info, { manual: true });
        _tabSessionIds = [...liveTabs];
        saveTabSessions();
      }
      // 6. If we have a restorable tab, switch to the most recent; otherwise
      //    auto-create one fresh session.
      if (liveTabs.length) {
        const targetSid = liveTabs[liveTabs.length - 1];
        const targetInfo = _tabInfoCache.get(targetSid) || null;
        setSession(targetSid, targetInfo);
        bindPrimarySession(getDefaultStore(), targetSid);
        try {
          const list = await api.sessionMessages(targetSid);
          const items = list?.data || [];
          for (const { info: msgInfo, parts } of items) {
            if (!msgInfo?.id) continue;
            upsertMessage(msgInfo);
            for (const part of (parts || [])) upsertPart(part);
          }
          // Detect in-flight turns surviving page reload — header should not
          // display "idle" while the server is still streaming.
          syncRunningFromHydration(items);
        } catch (err) {
          console.warn('[ocp-v2-panel] sessionMessages failed on boot', err);
        }
        renderPill();
      } else {
        await startFreshSession({ cwd: lastProject || undefined });
      }
      _booted = true;
      // Tell ui-sidepanel-tray we own opencode pills now — it drops any
      // placeholder pills it was rendering from storage.
      try {
        window.dispatchEvent(new CustomEvent('sidepanel-tray:provider-loaded', {
          detail: { provider: 'opencode' },
        }));
      } catch {}
    } catch (err) {
      console.error('[ocp-v2-panel] boot failed:', err);
      pushError({ message: err?.message || 'Boot failed' });
    } finally {
      _bootPromise = null;
    }
  })();
  return _bootPromise;
}

// Mirrors Claude/Codex: create the new session immediately, then surface the
// rename modal as an optional follow-up. Skipping the modal still leaves the
// fresh session in place.
function beginNewSession() {
  const cwd = getState().cwd || storage.getItem(STOR_PROJECT) || undefined;
  // Preserve the current session as a tab pill before spawning the new one.
  const prevSid = getState().sessionId;
  if (prevSid) ensureTab(prevSid, getState().sessionInfo);
  startFreshSession({ cwd })
    .catch((err) => pushError({ message: err?.message || 'New session failed' }))
    .finally(() => {
      loadProjectsOnce().catch(() => {}).finally(() => promptNameNewSession());
    });
}

async function startFreshSession({ title, cwd } = {}) {
  // Reset local message state so we don't show stale parts from a previous session
  clearMessages();
  const body = title ? { title } : {};
  const projectCwd = cwd || getState().cwd || undefined;
  const res = await api.sessionCreate(body, projectCwd);
  const sess = res?.data;
  if (!sess?.id) throw new Error('session create returned no id');
  const titleState = ensureOpenCodeTitleState(sess.id, sess, { fresh: true, manual: !!title });
  if (title && titleState) {
    titleState.title = title;
    saveTitleStates();
  }
  setSession(sess.id, sess);
  bindPrimarySession(getDefaultStore(), sess.id);
  if (cwd) setCwd(cwd);
  // SDK may ignore title at create-time; rename as fallback so the label shows.
  if (title && sess.title !== title) {
    try { await api.sessionUpdate(sess.id, { title }); }
    catch (err) { console.warn('[ocp-v2-panel] sessionUpdate failed', err); }
  }
  renderPill();
}

// Switching the active project on a live session is a hard cut for OpenCode:
// the session is bound to the cwd at creation, so we drop it and start fresh.
async function setActiveProject(path) {
  const next = String(path || '');
  const prev = getState().cwd || '';
  if (next === prev) return;

  // Persist the new project as the default cwd
  setCwd(next);
  if (next) storage.setItem(STOR_PROJECT, next);
  else      storage.removeItem(STOR_PROJECT);

  // If a turn is in flight, abort it before yanking the session
  const sBefore = getState();
  if (sBefore.running && sBefore.sessionId) {
    try { await api.abort(sBefore.sessionId); }
    catch (err) { console.warn('[ocp-v2-panel] abort before project change failed', err); }
  }

  // Drop any existing session — next send will run on the new cwd
  if (sBefore.sessionId) {
    clearMessages();
    setSession(null, null);
    bindPrimarySession(getDefaultStore(), null);
  }

  // Eagerly create a fresh session at the new cwd so the user can send immediately
  try {
    await startFreshSession({ cwd: next || undefined });
  } catch (err) {
    pushError({ message: err?.message || 'New session failed' });
  }

  // Re-scope the session menu to the new project if it was open
  if (_sessionMenuEl?.classList.contains('open')) {
    try { renderSessionMenu(); } catch {}
  }
}

async function loadProjectsOnce() {
  if (_projectsLoaded) return _projects;
  if (_projectsLoadPromise) return _projectsLoadPromise;
  _projectsLoadPromise = (async () => {
    try {
      const res = await fetchProjects();
      _projects = Array.isArray(res) ? res : (res?.projects || []);
      _projectsLoaded = true;
    } catch (err) {
      console.warn('[ocp-v2-panel] fetchProjects failed', err);
      _projects = [];
    } finally {
      _projectsLoadPromise = null;
    }
    return _projects;
  })();
  return _projectsLoadPromise;
}

async function fetchBranchesForModal(path) {
  if (!path) return { branches: [], current: null };
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(path)}`);
    return await res.json();
  } catch { return { branches: [], current: null }; }
}

function promptNameNewSession() {
  if (!_panelEl) return;
  if (_panelEl.querySelector('.ocpv2-name-modal-overlay')) return;

  const projectOptions = (_projects || []).map((p) => {
    const path = (p && (p.path || p)) || '';
    const name = typeof path === 'string' ? path.split('/').pop() : '';
    return { path: String(path || ''), name: name || String(path || '') };
  }).filter((p) => p.path);

  const overlay = document.createElement('div');
  overlay.className = 'ocpv2-name-modal-overlay';
  overlay.innerHTML = `
    <div class="ocpv2-name-modal" role="dialog" aria-modal="true">
      <div class="ocpv2-name-modal-title">Name this session</div>
      <div class="ocpv2-name-modal-row">
        <label class="ocpv2-name-modal-label">Project</label>
        <select class="ocpv2-name-modal-select" data-role="project">
          <option value="">(none)</option>
          ${projectOptions.map((p) => `<option value="${p.path.replace(/"/g, '&quot;')}">${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="ocpv2-name-modal-row">
        <label class="ocpv2-name-modal-label">Branch</label>
        <select class="ocpv2-name-modal-select" data-role="branch" disabled>
          <option value="">(loading...)</option>
        </select>
      </div>
      <input type="text" class="ocpv2-name-modal-input" placeholder="Session name..." maxlength="120" />
      <div class="ocpv2-name-modal-actions">
        <button type="button" class="ocpv2-name-modal-btn skip">Skip</button>
        <button type="button" class="ocpv2-name-modal-btn save">Save</button>
      </div>
    </div>
  `;
  _panelEl.appendChild(overlay);

  const input = overlay.querySelector('.ocpv2-name-modal-input');
  const saveBtn = overlay.querySelector('.ocpv2-name-modal-btn.save');
  const skipBtn = overlay.querySelector('.ocpv2-name-modal-btn.skip');
  const projectSel = overlay.querySelector('select[data-role="project"]');
  const branchSel = overlay.querySelector('select[data-role="branch"]');

  const initialProject = getState().cwd || storage.getItem(STOR_PROJECT) || '';
  if (projectSel && initialProject) projectSel.value = initialProject;

  let branchOriginal = null;
  async function refreshBranches(path) {
    branchSel.disabled = true;
    branchSel.innerHTML = '<option value="">(loading...)</option>';
    if (!path) {
      branchSel.innerHTML = '<option value="">(none)</option>';
      branchSel.disabled = true;
      branchOriginal = null;
      return;
    }
    const data = await fetchBranchesForModal(path);
    branchOriginal = data.current || null;
    const branches = data.branches || [];
    if (!branches.length) {
      branchSel.innerHTML = '<option value="">(none)</option>';
      branchSel.disabled = true;
    } else {
      branchSel.innerHTML = branches.map((b) => `<option value="${b.replace(/"/g, '&quot;')}">${b}</option>`).join('');
      if (branchOriginal) branchSel.value = branchOriginal;
      branchSel.disabled = false;
    }
  }
  refreshBranches(projectSel?.value || initialProject);

  projectSel?.addEventListener('change', () => refreshBranches(projectSel.value));

  setTimeout(() => { input.focus(); input.select(); }, 10);

  let done = false;
  const close = () => { if (!done) { done = true; overlay.remove(); } };

  const commit = async (cancel) => {
    if (done) return;
    const nextTitle = input.value.trim();
    const chosenProject = projectSel?.value || '';
    const chosenBranch = branchSel?.value || '';
    close();
    // Skip leaves the freshly-created session in place — same as Claude/Codex
    // where dismissing the rename modal keeps the empty new tab.
    if (cancel) return;

    const projectChanged = chosenProject && chosenProject !== (getState().cwd || '');

    if (chosenProject && chosenBranch && branchOriginal && chosenBranch !== branchOriginal) {
      try {
        await fetch('/api/terminal/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: chosenProject, branch: chosenBranch }),
        });
      } catch (err) {
        console.error('[ocp-v2-panel] checkout failed:', err);
      }
    }

    if (projectChanged) {
      setCwd(chosenProject);
      storage.setItem(STOR_PROJECT, chosenProject);
      // Preserve the just-created session as a tab before swapping to a new cwd.
      const prevSid = getState().sessionId;
      if (prevSid) ensureTab(prevSid, getState().sessionInfo);
      try {
        await startFreshSession({ title: nextTitle || undefined, cwd: chosenProject });
      } catch (err) {
        pushError({ message: err?.message || 'New session failed' });
      }
      return;
    }

    const sid = getState().sessionId;
    if (sid && nextTitle) {
      markOpenCodeTitleManual(sid, nextTitle);
      try {
        await api.sessionUpdate(sid, { title: nextTitle });
        const updated = { ...(getState().sessionInfo || {}), id: sid, title: nextTitle };
        setSession(sid, updated);
      } catch (err) {
        console.warn('[ocp-v2-panel] rename failed', err);
      }
    }
  };

  saveBtn.addEventListener('click', () => commit(false));
  skipBtn.addEventListener('click', () => commit(true));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(false); }
    if (event.key === 'Escape') { event.preventDefault(); commit(true); }
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) commit(true);
  });
}

async function closeCurrentSession() {
  // Update the UI first; server cleanup is best-effort and must not block the
  // only visible tab from closing.
  const s = getState();
  const sid = s.sessionId;
  const wasRunning = !!s.running;
  const backendClose = closeSessionBackend(sid, { wasRunning, context: 'close' });
  const closePromise = handlePillClose(sid);
  backendClose.catch(() => {});
  try { await closePromise; }
  catch (err) { console.warn('[ocp-v2-panel] local close failed', err); }
}

function deleteSessionBestEffort(sessionId, { abort = false, context = 'delete' } = {}) {
  if (!sessionId) return Promise.resolve();
  return (async () => {
    if (abort) {
      try { await api.abort(sessionId); }
      catch (err) { console.warn(`[ocp-v2-panel] abort before ${context} failed`, err); }
    }
    try { await api.sessionDelete(sessionId); }
    catch (err) { console.warn(`[ocp-v2-panel] ${context} sessionDelete failed`, err); }
  })();
}

// ── Resize ───────────────────────────────────────────────────────────────────

function wireResize(panel, handle) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    let pendingW = startW;
    let rafId = 0;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    setRightPanelResizing(true);
    const applyWidth = () => {
      rafId = 0;
      pendingW = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, pendingW));
      panel.style.width = pendingW + 'px';
      // Reserve using the known width (numeric) to avoid a getBoundingClientRect
      // forced reflow every frame during the drag.
      if (_visible) reserveRightPanelLayout(PANEL_OWNER, pendingW + 20, 20);
    };
    const onMove = (ev) => {
      const diff = startX - ev.clientX;
      pendingW = startW + diff;
      if (!rafId) rafId = requestAnimationFrame(applyWidth);
    };
    const onUp = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      applyWidth();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = '';
      setRightPanelResizing(false);
      window.dispatchEvent(new Event('resize'));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Visibility ───────────────────────────────────────────────────────────────

async function minimizeForegroundAgentPanels() {
  if (isClaudePanelOpen()) {
    try {
      await toggleClaudePanel();
    } catch (err) {
      console.warn('[ocp-v2-panel] Failed to minimize Claude panel:', err);
    }
  }
  if (isCodexPanelOpen()) {
    try {
      await toggleCodexPanel();
    } catch (err) {
      console.warn('[ocp-v2-panel] Failed to minimize Codex panel:', err);
    }
  }
}

async function showPrimaryOpencodePanel() {
  if (!_panelEl) buildPanel();
  wireTrayMutualExclusion();
  if (_visible) {
    renderPill();
    return true;
  }

  hideActiveChildPanel();
  await minimizeForegroundAgentPanels();
  setVisible(true);

  // Lazy connect and boot on first open
  try {
    await connect();
    await boot();
    setTimeout(() => focusCompose(), 60);
  } catch (err) {
    console.warn('[ocp-v2-panel] open failed', err);
  }
  return true;
}

function setVisible(nextVisible) {
  if (!_panelEl) return;
  const next = !!nextVisible;
  if (next === _visible) {
    renderPill();
    return;
  }
  _visible = next;
  _panelEl.classList.toggle('ocpv2-open', _visible);
  if (_visible) {
    reserveRightPanelLayout(PANEL_OWNER, _panelEl, 20);
    state.lastActivePanel = 'opencode';
  } else {
    clearRightPanelLayout(PANEL_OWNER);
  }
  emit('opencode-panel:visibility', _visible);
  renderPill();
  window.dispatchEvent(new Event('resize'));
}

// ── Tray pills (one per session "tab") ──────────────────────────────────────
// Mirrors Claude/Codex panel behavior: every open session gets a tray pill.
// The active session's pill is hidden while the panel is open (because the
// panel IS that session). Inactive pills are clickable to switch.

function getTray() {
  return document.getElementById('term-minimized-tray');
}

function loadTabSessions() {
  try {
    const raw = storage.getItem(STOR_TABS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s) => typeof s === 'string' && s && !_foreignActiveAutomationSessions.has(s))
      : [];
  } catch { return []; }
}

function saveTabSessions() {
  try {
    const existingIds = JSON.parse(storage.getItem(STOR_TABS) || '[]');
    const automationRows = JSON.parse(storage.getItem(STOR_AUTOMATIONS) || '[]');
    const foreignSessionIds = new Set((Array.isArray(automationRows) ? automationRows : [])
      .filter((row) => row?.sessionId && row.ownerId !== nativeLoopWindowId)
      .map((row) => row.sessionId));
    const preserved = (Array.isArray(existingIds) ? existingIds : [])
      .filter((sessionId) => foreignSessionIds.has(sessionId) && !_tabSessionIds.includes(sessionId));
    storage.setItem(STOR_TABS, JSON.stringify([..._tabSessionIds, ...preserved]));
    touchOpenCodeWindow();
  } catch {}
}

function ensureTab(sessionId, info = null) {
  if (!sessionId) return;
  if (info) _tabInfoCache.set(sessionId, info);
  if (!_tabSessionIds.includes(sessionId)) {
    _tabSessionIds.push(sessionId);
    saveTabSessions();
  }
}

function dismissAutomationSession(sessionId) {
  const runId = _automationRunIds.get(sessionId);
  if (!runId) return false;
  window.dispatchEvent(new CustomEvent('native-loop:dismissed', { detail: { runId } }));
  if (_automationRunning.has(sessionId)) {
    fetch('/api/loop/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    }).catch(() => {});
  }
  return true;
}

function closeSessionBackend(sessionId, { wasRunning = false, context = 'close' } = {}) {
  const runId = _automationRunIds.get(sessionId);
  if (!runId) return deleteSessionBestEffort(sessionId, { abort: wasRunning, context });
  dismissAutomationSession(sessionId);
  if (_automationContinuedManually.has(sessionId) || _automationManualSendInFlight.has(sessionId)) {
    return deleteSessionBestEffort(sessionId, { abort: wasRunning, context });
  }
  return Promise.resolve();
}

function removeTab(sessionId) {
  if (!sessionId) return;
  const before = _tabSessionIds.length;
  _tabSessionIds = _tabSessionIds.filter((s) => s !== sessionId);
  if (_tabSessionIds.length !== before) saveTabSessions();
  _tabInfoCache.delete(sessionId);
  const titleState = _sessionTitleState.get(sessionId);
  titleState?.controller?.abort();
  _sessionTitleState.delete(sessionId);
  saveTitleStates();
  const titleTimer = _titleReassertTimers.get(sessionId);
  if (titleTimer) clearTimeout(titleTimer);
  _titleReassertTimers.delete(sessionId);
  _automationRunIds.delete(sessionId);
  unregisterAutomationSession(sessionId);
  _automationRunning.delete(sessionId);
  _automationContinuedManually.delete(sessionId);
  _automationManualSendInFlight.delete(sessionId);
  saveAutomationTabs();
  const pill = _tabPills.get(sessionId);
  if (pill?.isConnected) pill.remove();
  _tabPills.delete(sessionId);
}

function tabLabelFor(sessionId) {
  const activeSid = getState().sessionId;
  const info = sessionId === activeSid
    ? (getState().sessionInfo || _tabInfoCache.get(sessionId))
    : _tabInfoCache.get(sessionId);
  const title = info?.title || info?.slug;
  if (title) return title;
  return `OpenCode · ${sessionId.slice(0, 8)}`;
}

function createTabPill(sessionId) {
  const tray = getTray();
  if (!tray) return null;
  const pill = document.createElement('div');
  pill.className = 'term-minimized-pill ocpv2-session-pill';
  pill.dataset.owner = PANEL_OWNER;
  pill.dataset.sessionId = sessionId;
  pill.innerHTML = `
    <span class="term-minimized-pill-icon">${OPENCODE_ICON}</span>
    <span class="term-minimized-pill-label">${escapeHtml(tabLabelFor(sessionId))}</span>
    <button class="term-minimized-pill-close" data-tooltip="Close" data-tooltip-pos="top">&times;</button>
  `;
  pill.addEventListener('click', (event) => {
    if (event.target.closest('.term-minimized-pill-close')) return;
    handlePillClick(sessionId);
  });
  pill.querySelector('.term-minimized-pill-close')?.addEventListener('click', async (event) => {
    event.stopPropagation();
    // Mirror header X. Native transcripts are preserved unless the user has
    // continued the terminal automation manually; backend cleanup is best-effort.
    const wasRunning = sessionId === getState().sessionId && !!getState().running;
    closeSessionBackend(sessionId, { wasRunning, context: 'pill close' }).catch(() => {});
    try { await handlePillClose(sessionId); }
    catch (err) { console.warn('[ocp-v2-panel] local pill close failed', err); }
  });
  tray.appendChild(pill);
  return pill;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPill() {
  const tray = getTray();
  if (!tray) return;
  const activeSid = getState().sessionId;
  if (activeSid) ensureTab(activeSid, getState().sessionInfo);

  // Drop pills for sessions no longer in the tab list
  for (const [sid, pill] of Array.from(_tabPills.entries())) {
    if (!_tabSessionIds.includes(sid)) {
      if (pill?.isConnected) pill.remove();
      _tabPills.delete(sid);
    }
  }

  for (const sid of _tabSessionIds) {
    let pill = _tabPills.get(sid);
    if (!pill || !pill.isConnected) {
      pill = createTabPill(sid);
      if (!pill) continue;
      _tabPills.set(sid, pill);
    }
    const labelEl = pill.querySelector('.term-minimized-pill-label');
    if (labelEl) labelEl.textContent = tabLabelFor(sid);
    const isActive = sid === activeSid;
    pill.classList.toggle('ocpv2-pill-active', isActive);
    pill.classList.toggle('ocpv2-pill-running', _automationRunning.has(sid) || (isActive && !!getState().running));
    pill.style.display = (isActive && _visible) ? 'none' : '';
  }
}

async function handlePillClick(sessionId) {
  if (!sessionId) return;
  const activeSid = getState().sessionId;
  if (sessionId === activeSid) {
    if (_visible) setVisible(false);
    else await showPrimaryOpencodePanel();
    return;
  }
  if (!_panelEl) buildPanel();
  if (!_visible) await showPrimaryOpencodePanel();
  const info = _tabInfoCache.get(sessionId) || null;
  await switchToSession(sessionId, info);
  renderPill();
}

async function handlePillClose(sessionId) {
  if (!sessionId) {
    if (_tabSessionIds.length > 1) {
      const next = _tabSessionIds[_tabSessionIds.length - 1];
      const info = _tabInfoCache.get(next) || null;
      await switchToSession(next, info);
    } else {
      for (const sid of Array.from(_tabSessionIds)) removeTab(sid);
      clearMessages();
      setSession(null, null);
      bindPrimarySession(getDefaultStore(), null);
      if (_visible) setVisible(false);
      renderPill();
    }
    return;
  }
  const wasActive = sessionId === getState().sessionId;
  if (wasActive) {
    // Clear active session FIRST so downstream renderPill / switchToSession
    // can't resurrect the tab via their ensureTab(prevSid) guards.
    setSession(null, null);
  }
  removeTab(sessionId);
  if (wasActive) {
    const next = _tabSessionIds[_tabSessionIds.length - 1];
    if (next) {
      const info = _tabInfoCache.get(next) || null;
      await switchToSession(next, info);
    } else {
      clearMessages();
      bindPrimarySession(getDefaultStore(), null);
      if (_visible) setVisible(false);
    }
  }
  renderPill();
}

function wireTrayMutualExclusion() {
  if (_trayClickWired) return;
  const tray = getTray();
  if (!tray) return;
  tray.addEventListener('click', (event) => {
    if (!_visible) return;
    const otherPill = event.target.closest('.cp-session-pill, .cxp-session-pill');
    if (otherPill && !event.target.closest('.term-minimized-pill-close')) setVisible(false);
  });
  _trayClickWired = true;
}

// React to other panels' visibility events: if another opens, hide us.
on('claude-panel:show', () => { if (_visible) setVisible(false); });
on('codex-panel:visibility', (visible) => { if (visible && _visible) setVisible(false); });

// Sub-agent child panel coordination ─────────────────────────────────────────
on('opencode-panel:show', async () => {
  try {
    await showPrimaryOpencodePanel();
  } catch (err) {
    console.warn('[ocp-v2-panel] show request failed', err);
  }
});

// Child panel asks to be shown the primary → open + focus.
on('opencode-panel:request-show', async () => {
  try {
    await showPrimaryOpencodePanel();
  } catch (err) {
    console.warn('[ocp-v2-panel] request-show failed', err);
  }
});

// Child panel asks for a brand-new top-level session.
on('opencode-panel:request-new-session', () => { beginNewSession(); });

// Child panel announced visibility — hide us so they're mutually exclusive.
on('opencode-child:show', () => { if (_visible) setVisible(false); });

// Whiteboard "Send to Panel" → attach image to compose footer if OCP v2 is the
// active sidepanel. Mirrors the gating used by Claude/Codex/OCP v1 so the event
// is consumed by exactly one panel.
on('wb:send-to-panel', async ({ dataUrl }) => {
  if (!dataUrl) return;
  if (!_visible && state.lastActivePanel !== 'opencode') return;
  const match = dataUrl.match(/^data:(image\/[-+.\w]+);base64,/);
  if (!match) return;
  if (!_panelEl) buildPanel();
  if (!_visible) {
    await showPrimaryOpencodePanel();
  }
  addAttachedImage({
    name: `whiteboard-${Date.now()}.png`,
    mime: match[1],
    dataUrl,
  });
});

// ── Public API ───────────────────────────────────────────────────────────────

export function isOpencodePanelOpen() { return _visible || isActiveChildPanelOpen(); }

export async function toggleOpencodePanel() {
  if (_visible || isActiveChildPanelOpen()) {
    if (_visible) setVisible(false);
    hideActiveChildPanel();
    return false;
  }
  return showPrimaryOpencodePanel();
}

export async function attachOpenCodeAutomation(run, { focus = !!run?.focus, isCancelled = () => false } = {}) {
  const sessionId = run?.providerSessionId;
  if (!run?.runId || !sessionId) return { ok: false, reason: 'identity_pending' };
  // Establish ownership before connect()/boot(): native provider events use a
  // separate socket and may report a Task child while this attach is awaiting.
  const previousRunId = _automationRunIds.get(sessionId);
  _automationRunIds.set(sessionId, run.runId);
  registerAutomationSession(sessionId, run.runId);
  const running = run.status === 'starting' || run.status === 'running';
  if (running || previousRunId !== run.runId) {
    _automationContinuedManually.delete(sessionId);
    _automationManualSendInFlight.delete(sessionId);
  }
  if (running) _automationRunning.add(sessionId);
  else _automationRunning.delete(sessionId);
  saveAutomationTabs();
  const info = {
    id: sessionId,
    title: run.title || 'Automation',
    directory: run.cwd || '',
    mcpProfile: run.mcpProfile || null,
    time: { updated: Date.now() },
  };
  if (!_booted) _pendingAutomationAttach = { sessionId, info };
  if (!_panelEl) buildPanel();
  await connect();
  await boot();
  _pendingAutomationAttach = null;
  if (isCancelled()) {
    await handlePillClose(sessionId).catch(() => {});
    return { ok: false, reason: 'dismissed' };
  }
  ensureTab(sessionId, info);
  if (focus) {
    if (!_visible) await showPrimaryOpencodePanel();
    await switchToSession(sessionId, info);
  } else if (getState().sessionId === sessionId) {
    setRunning(running);
    await rehydrateActiveSession().catch(() => {});
  }
  if (getState().sessionId === sessionId) setRunning(running);
  if (run.status === 'failed' && run.error && getState().sessionId === sessionId
    && _tabInfoCache.get(sessionId)?._automationLifecycleError !== run.error) {
    const cachedInfo = _tabInfoCache.get(sessionId) || info;
    cachedInfo._automationLifecycleError = run.error;
    _tabInfoCache.set(sessionId, cachedInfo);
    pushError({ message: run.error });
  }
  renderPill();
  return { ok: true, sessionId };
}

export async function detachOpenCodeAutomation(runId) {
  const entry = [..._automationRunIds].find(([, value]) => value === runId);
  if (!entry) return false;
  const [sessionId] = entry;
  _automationRunIds.delete(sessionId);
  _automationRunning.delete(sessionId);
  _automationContinuedManually.delete(sessionId);
  _automationManualSendInFlight.delete(sessionId);
  saveAutomationTabs();
  await handlePillClose(sessionId);
  return true;
}

export async function openOpencodeWithPrompt(text) {
  // Open panel, wait for boot, drop the text into the compose box.
  if (!_visible) await showPrimaryOpencodePanel();
  // Otherwise ensure we're booted
  await boot();
  // Find the compose textarea and prefill (don't auto-send — let user confirm)
  const ta = _panelEl?.querySelector('.ocpv2-compose-input');
  if (ta) {
    ta.value = String(text || '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }
}

export async function attachPathToOpencode(filePath) {
  const path = String(filePath || '').trim();
  if (!path) return false;
  if (!_panelEl) buildPanel();
  if (!_visible) {
    await showPrimaryOpencodePanel();
  } else {
    await boot();
  }
  const added = appendPathToCompose(path);
  setTimeout(() => focusCompose(), 30);
  return added;
}

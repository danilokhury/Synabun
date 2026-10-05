import { hostedSidepanelId, sidepanelHost } from '../ui-sidepanel-runtime.js';
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
import { connect, api, hasSessionStore, onSessionCompacted, onEvent, supports, isDescendantSession } from './ocp-v2-ws.js';
import {
  menuSessions, pickReusableEmptySession, shareView, SHARE_CONFIRM_TEXT, createPendingRenames, createStoppedShares,
} from './ocp-v2-sessions-logic.js';
import {
  forkSession, shareSession, unshareSession, undoLastTurn, restoreReverted,
  loadSelectedSession, applySessionSelections, restoreDraftAttachments,
  readTranscriptExport, stopForNavigation, createSessionForNavigation, renameSession,
  navigateAfter, adoptReusableSession, landWithoutTabs, shouldNameCreatedSession, renameBox,
} from './ocp-v2-session-actions.js';
import { captureBinding, latestOnly, latestFor, createNavigation } from './ocp-v2-binding.js';
import { createConfirmations } from './ocp-v2-confirm-logic.js';
import { syncConfirmRow } from './ocp-v2-confirm.js';
import { closeWithPromptsConfirm, prefilledDraft, samePrompts } from './ocp-v2-composer-logic.js';
import { setSelectOptions, projectOptionRows } from './ocp-v2-select.js';
import { replyFailed, replyError } from './ocp-v2-caps.js';
import { rehydratePanelSession, recoveredErrorSweep } from './ocp-v2-rehydrate.js';
import { headerStatus } from './ocp-v2-render-logic.js';
import {
  getState, subscribe, setSession, setServerStatus, setCwd, clearMessages, pushError, clearErrors, setHealing,
  addAttachedImage, getDefaultStore, setRunning,
} from './ocp-v2-state.js';
import { trackContextGauge } from './ocp-v2-context-gauge.js';
import { mountContextMenu } from './ocp-v2-context-menu.js';
import { createCompactControl } from './ocp-v2-compact-button.js';
import { createAutoAcceptControl } from './ocp-v2-autoaccept-button.js';
import { mountTodoWidget } from './ocp-v2-session-widgets.js';
import { mountChangesBar } from './ocp-v2-changes.js';
import { mountEnvironmentPopover } from './ocp-v2-status.js';
import { watchWorktree, newSessionPlan, checkoutOutcome } from './ocp-v2-changes-logic.js';
import { mountRenderer } from './ocp-v2-render.js';
import { mountCompose, focusCompose, appendPathToCompose } from './ocp-v2-send.js';
import { mountProjectBar, unmountProjectBar } from './ocp-v2-projectbar.js';
import { registerSidepanel, syncSidepanelLayout, focusSidepanel, openAnotherSidepanelSession, isHostedSessionFocused } from '../ui-sidepanel-windows.js';
import { nativeLoopWindowId } from '../ui-native-window-id.js';
import { requestGeneratedSessionTitle } from '../session-title.js';
import {
  registerAutomationSession, unregisterAutomationSession, stopAutomationRun,
} from './ocp-v2-automation-ownership.js';
import {
  registerPrimaryPanel, bindPrimarySession, isChildPanelOpen, getVisibleChildPanel, openChildSession,
  registerMainView, requestOpencodeView, MAIN_VIEW, releaseSubagentPanels, subagentPromptsWaiting, syncSubagentTray,
} from './ocp-v2-manager.js';

const PANEL_ID = 'ocp-v2-panel';
const PANEL_OWNER = 'ocp-v2-panel';

const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_MINIMIZE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>';
const ICON_SLIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_X_SMALL = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
const OPENCODE_ICON = '<svg viewBox="0 0 24 30" fill="currentColor"><path d="M18 6H6V24H18V6ZM24 30H0V0H24V30Z"/></svg>';

const STOR_PROJECT = 'opencode-v2-project';
let OCP_WINDOW_ID = (() => {
  if (hostedSidepanelId) return hostedSidepanelId;
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
let _projects = [];
let _projectsLoaded = false;
let _projectsLoadPromise = null;
let _sessionMenuEl = null;
let _contextMenu = null;
let _sessionBtnEl = null;
let _sessionLabelEl = null;
let _renameBtnEl = null;
let _docClickWired = false;
let _healTimer = null;
let _healingPromise = null;
let _healRetryCount = 0;
const _sessionTitleState = new Map(); // sessionId -> { state, title, requestId, controller }
const _titleReassertTimers = new Map();
// Renames whose request is out. Until the server has answered, the title a
// rename carries is not the session's: nothing shows it or pushes it again.
const _pendingRenames = createPendingRenames();
let _composer = null;           // the primary panel's composer (mountCompose)
// Where the panel goes. Every choice of the user (a tab, a session in the
// menu, New session, a project, a worktree) begins an intent, and a navigation
// binds the panel only while its intent is the latest one: a later choice wins
// over an older one that is still in flight (ocp-v2-binding.js). What the
// panel starts by itself (boot, the recovery, an automation asking for focus)
// only observes: it never overtakes a choice of the user.
const _nav = createNavigation(getDefaultStore());
// What publishes or destroys is asked in the panel, in two steps, never with a
// native dialog (ocp-v2-confirm-logic.js). `surface` says where the question
// is drawn: 'menu' under its row of the session menu, 'panel' above the
// compose box, 'dialog' in the naming dialog.
const _confirms = createConfirmations({ store: getDefaultStore() });
let _confirmSlotEl = null;
const _menuConfirmAnchors = new Map();   // question key -> the menu row it is asked under
_confirms.onChange(() => { syncSessionMenuConfirm(); syncPanelConfirm(); });
// Share links whose sharing this panel stopped. OpenCode goes on reporting
// them (createStoppedShares in ocp-v2-sessions-logic.js), so the store takes
// such a link out of any session info it is handed, and so do the session
// menu and the tab cache. One list for every window, kept across reloads.
const STOR_STOPPED_SHARES = 'opencode-v2-stopped-shares';
const _stoppedShares = createStoppedShares({
  load: () => JSON.parse(storage.getItem(STOR_STOPPED_SHARES) || '{}'),
  save: (entries) => storage.setItem(STOR_STOPPED_SHARES, JSON.stringify(entries)),
});
getDefaultStore().setSessionInfoFilter?.((info) => _stoppedShares.clean(info));

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

  // ── Header ────────────────────────────────────────────────────────────────
  // Same order as the other side panels: the session button, the rename
  // pencil joined to it, the action buttons on the right edge, the menu.
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

  // The session's state. Not a header piece: it is mounted in the footer
  // toolbar below, once the composer has built that row.
  const status = document.createElement('div');
  status.className = 'ocpv2-footer-status';
  status.textContent = '…';
  _statusEl = status;

  const actions = document.createElement('div');
  actions.className = 'ocpv2-actions';

  const newBtn = document.createElement('button');
  newBtn.className = 'ocpv2-btn ocpv2-btn-new';
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
  minimizeBtn.className = 'ocpv2-btn ocpv2-btn-minimize';
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

  // Context settings: the cog in the header and its popover (the context
  // window and Compact, the connected tools, the versions, the session and
  // its auto-accept switch). The gauge only keeps the store's reading current.
  trackContextGauge(getDefaultStore());
  const environment = mountEnvironmentPopover(panel, getDefaultStore(), {
    // A reference's "Attach": a referenced path on the prompt being written.
    onAttachPath: (path) => appendPathToCompose(path),
  });
  _contextMenu = mountContextMenu(actions, panel, getDefaultStore(), {
    compact: createCompactControl(getDefaultStore()),
    autoAccept: createAutoAcceptControl(getDefaultStore()),
    onManage: () => environment.open(),
    onOpen: () => { closeSessionMenu(); environment.close(); },
  });

  // ── Messages scroll area (card wrapper + absolute scroll list) ──────────
  const messagesContainer = document.createElement('div');
  messagesContainer.className = 'ocpv2-messages-container';
  const messages = document.createElement('div');
  messages.className = 'ocpv2-messages';
  messagesContainer.appendChild(messages);
  panel.appendChild(messagesContainer);

  // ── What the session changed on disk (session.diff) ─────────────────────
  mountChangesBar(panel, getDefaultStore());

  // ── Todo list of the running work (session.todo / todo.updated) ─────────
  mountTodoWidget(panel, getDefaultStore());

  // ── The question before a tab is closed or a message is deleted ─────────
  _confirmSlotEl = document.createElement('div');
  _confirmSlotEl.className = 'ocpv2-confirm-slot';
  panel.appendChild(_confirmSlotEl);

  // ── Compose footer ───────────────────────────────────────────────────────
  const compose = document.createElement('div');
  compose.className = 'ocpv2-compose';
  panel.appendChild(compose);

  document.body.appendChild(panel);
  _panelEl = panel;
  registerSidepanel({
    owner: PANEL_OWNER, provider: 'opencode', element: panel,
    header, actions, buttonClass: 'ocpv2-btn', dockHandle: resizeHandle, applyVisibility,
  });

  let composer = null;
  const renderer = mountRenderer(messages, getDefaultStore(), {
    onOpenSession: (session, extra) => openCreatedSession(session, extra),
    // Fork is a navigation: its intent begins at the click, and the fork takes
    // the panel only while that click is still the user's latest choice.
    onNavigate: () => _nav.begin(),
    onOpenChild: (childSessionId) => openChildSession(getState().sessionId, childSessionId),
    // Undo hands the prompt back: its text, and what was attached to it.
    onComposeText: (text, extra) => putPromptInComposer(composer, text, extra),
    // Retry sends the original prompt with its own file parts; `images: []`
    // marks the attachments as the prompt's own, so the draft in the strips
    // is neither sent nor cleared.
    // `binding` is the one Retry was clicked on: the composer refuses the
    // prompt once the panel has left it.
    onSendText: (text, extra) => composer?.sendTextMessage(text, {
      images: [], paths: [], mentions: extra?.files || [], allowEmptyText: true, binding: extra?.binding,
    }),
    // Deleting a message is asked above the compose box; the second click deletes.
    confirm: (question) => _confirms.ask({ surface: 'panel', ...question }),
  });
  // Slash commands that act on the session itself (ocp-v2-composer-logic.js
  // names them; the composer calls these).
  // `moved`: the panel was bound to another session while the action was out
  // (ocp-v2-session-actions.js). Its result is dropped, without a banner.
  const failIfRefused = (result, fallback) => {
    if (result && result.ok === false && !result.cancelled && !result.moved) pushError({ message: result.error || fallback });
    return result;
  };
  const slashActions = {
    new: () => beginNewSession(),
    sessions: () => openSessionMenu(),
    export: () => exportActiveTranscript(),
    undo: async () => {
      const result = failIfRefused(await undoLastTurn(getDefaultStore(), api), 'Undo failed');
      if (result?.ok) putPromptInComposer(composer, result.text, result);
    },
    redo: async () => { failIfRefused(await restoreReverted(getDefaultStore(), api), 'Restore failed'); },
    fork: async () => {
      const nav = _nav.begin();
      const result = failIfRefused(await forkSession(getDefaultStore(), api), 'Fork failed');
      if (result?.ok) await openCreatedSession(result.session, { activate: !result.moved, nav });
    },
    // Asked every time, in the session menu: /share only opens the question
    // there, and its button publishes the transcript at a public URL.
    share: () => shareActiveSession(),
    unshare: () => stopSharingActiveSession(),
  };
  composer = _composer = mountCompose(compose, getDefaultStore(), {
    slashActions,
    // Nothing is parked for a session that has no tab to come back to.
    hasTab: (sessionId) => _tabSessionIds.includes(sessionId),
    onBeforeSend: () => renderer.scrollToBottom({ force: true }),
    // `session` in these three callbacks is the composer's binding snapshot
    // (ocp-v2-binding.js): the session the prompt or the Stop was for, frozen
    // before the first await. It is never the live state.
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
      // The session Stop was pressed in, by value: its bookkeeping is what the
      // stop request updates, also when another session is selected meanwhile.
      const stopped = await stopAutomationRun(
        session?.sessionId,
        { runIds: _automationRunIds, running: _automationRunning },
        (runId) => fetch('/api/loop/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        }).catch(() => {}),
      );
      if (stopped) saveAutomationTabs();
      return stopped;
    },
  });

  // Project + branch dropdowns — mounted INSIDE the compose card, above input-area.
  mountProjectBar(compose, {
    getProjects: () => _projects,
    ensureProjectsLoaded: () => loadProjectsOnce(),
    setActiveProject,
  });

  // The session's state reads in the footer toolbar's left group, after the
  // agent buttons (the compose card itself when that row is not there).
  (compose.querySelector('.ocpv2-footer-left') || compose).appendChild(status);

  // Header reflects state
  _unsubHeader = subscribe(handleStoreEvent);
  syncHeader();

  // Sessions change outside this panel too (another window, the CLI, a title
  // OpenCode generated): keep the open menu and the tab list in step.
  onEvent((eventType, ev) => {
    if (eventType !== 'session.updated' && eventType !== 'session.deleted' && eventType !== 'session.created') return;
    if (eventType === 'session.deleted') {
      const sid = ev?.info?.id || ev?.sessionID || ev?.sessionId;
      if (sid) _stoppedShares.resume(sid);
      if (sid && _tabSessionIds.includes(sid)) {
        handlePillClose(sid).catch((err) => console.warn('[ocp-v2-panel] close of a deleted session failed', err));
      }
    }
    scheduleSessionMenuRefresh();
  });

  // A compaction rewrites what the model sees: re-read the transcript so the
  // marker and the summary show up even when it ran without this panel asking.
  onSessionCompacted((store) => {
    if (store !== getDefaultStore()) return;
    const sid = getState().sessionId;
    if (sid) refreshSessionMessages(sid).catch((err) => console.warn('[ocp-v2-panel] post-compaction refresh failed', err));
  });
}

// A reverted prompt goes back into the composer with what it carried, each
// thing as what it was: pasted files in the strip, referenced paths as chips,
// @ mentions (a symbol's line range, an MCP resource) as mentions again. A
// draft the user is already writing is left alone, attachments included.
function putPromptInComposer(composer, text, prompt = {}) {
  if (!composer) return false;
  const files = Array.isArray(prompt?.files) ? prompt.files : [];
  const resources = Array.isArray(prompt?.resources) ? prompt.resources : [];
  if (!text && !files.length) return false;
  if (text && !composer.setText(text)) return false;
  if (files.length || resources.length) {
    const { lost } = restoreDraftAttachments(
      getDefaultStore(),
      { text, files, resources, resourceList: prompt?.resourceList },
      { addMentions: (items) => composer.restoreMentions(items) },
    );
    if (lost.length) {
      pushError({ message: `Could not put back ${lost.join(', ')}. Attach ${lost.length === 1 ? 'it' : 'them'} again before you send.` });
    }
  }
  return true;
}

function handleStoreEvent(event, stateSnapshot) {
  const nextState = stateSnapshot || getState();
  if (event?.type === 'running:set' && !nextState.running && nextState.sessionId) {
    _titleNeedsReassert(nextState.sessionId);
  }
  if (event?.type === 'session:info') keepOwnSessionTitle(nextState);
  syncHeader();
  maybeScheduleAutoHeal(event, nextState);
}

function syncHeader() {
  if (!_statusEl) return;
  const s = getState();
  _statusEl.className = 'ocpv2-footer-status';
  const status = headerStatus(s);
  if (status.cls) _statusEl.classList.add(`ocpv2-status-${status.cls}`);
  _statusEl.textContent = status.text;
  // The footer row gives the text only the room that is left: the tooltip
  // says it in full when just the dot fits.
  _statusEl.setAttribute('data-tooltip', status.text);
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
    // The errors this recovery may clear are those of the session it starts
    // on. When the user is on another session by the time it is done, that
    // session's errors are its own and stay.
    const recovered = recoveredErrorSweep(getDefaultStore());
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
      recovered.clear();
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
    const out = await hydrateBoundSession(sid, { refreshInfo: true, requireInfo: true });
    // The user switched session while this was out: that switch reads its own
    // session, and this one must not be put back on screen.
    if (out.moved) return;
    if (!out.unavailable) {
      ensureTab(sid, getState().sessionInfo);
      if (!out.transcript) console.warn('[ocp-v2-panel] auto-heal messages refresh failed', out.error);
      return;
    }
    console.warn('[ocp-v2-panel] auto-heal session refresh failed', out.error);
    removeTab(sid);
  }
  // The session is gone (or there was none) and the panel is still on it: a
  // new one takes its place, unless the panel is taken somewhere else while
  // it is created (then it is kept as a tab). This is the panel's own
  // rebinding, not a choice of the user (repair): it overtakes nothing, and a
  // session the user asked for meanwhile still takes the panel when it arrives.
  const cwd = getState().cwd || storage.getItem(STOR_PROJECT) || undefined;
  await startFreshSession({ cwd, nav: _nav.repair() });
}

// Every transcript read of the primary panel (boot, tab switch, auto-heal,
// after a compaction) goes through the guarded recovery the sub-agent panel
// uses: the answer is applied only while the panel is still on the session it
// was asked for, a snapshot never ends a turn an event has just reported
// running, and run state, approvals and todos follow with their own guards.
function hydrateBoundSession(sessionId, { refreshInfo = false, requireInfo = false } = {}) {
  return rehydratePanelSession(getDefaultStore(), api, {
    sessionId,
    refreshInfo,
    requireInfo,
    hasPanel: hasSessionStore,
    isDescendant: isDescendantSession,
  });
}

async function refreshSessionMessages(sessionId) {
  const out = await hydrateBoundSession(sessionId);
  if (!out.moved && !out.transcript) throw new Error(out.error || 'Session messages unavailable');
}

function isRecoverablePanelError(err) {
  // A notice tells the user something; there is nothing to recover from.
  if (err?.notice) return false;
  const msg = String(err?.message || err?.error || err || '').trim();
  if (!msg) return true;
  if (/choose continue|question reply failed|plan action failed|could not create plan file|could not read the plan|rename failed|could not delete|could not unarchive|not queued/i.test(msg)) return false;
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
  _tabInfoCache.set(sessionId, _stoppedShares.clean(updated));
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

// For a rename that is on its way: the rename itself carries the title, and
// a second request for it must not succeed where the rename was refused.
function cancelTitleReassert(sessionId) {
  const timer = _titleReassertTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  _titleReassertTimers.delete(sessionId);
}

// A rename marks its title as the panel's own before the request leaves (so
// no generated title lands over it meanwhile). When the server refuses the
// rename, that mark is taken back: the panel must not go on showing, and
// pushing, a title the session never got. `before` is titleStateBefore().
function titleStateBefore(sessionId) {
  const entry = _sessionTitleState.get(sessionId);
  return entry ? { state: entry.state, title: entry.title } : null;
}
function takeBackRenamedTitle(sessionId, before, attempted) {
  const entry = _sessionTitleState.get(sessionId);
  // Only what this rename wrote: a later rename's title is not this one's.
  if (!entry || entry.state !== 'manual' || entry.title !== attempted) return;
  cancelTitleReassert(sessionId);
  if (before) {
    // (A title that was being generated was cancelled by the rename: it may be asked for again.)
    entry.state = before.state === 'generating' ? 'default' : before.state;
    entry.title = before.title;
  } else {
    _sessionTitleState.delete(sessionId);
  }
  saveTitleStates();
  // The title the panel held before is its own again, on screen too (what
  // OpenCode reported while the rename was out was shown as it came).
  if (sessionId === getState().sessionId) { keepOwnSessionTitle(getState()); syncHeader(); }
}

// A rename was answered (`rename` is what _pendingRenames.begin returned
// before its request left). A refused one takes its title back.
function settleRename(rename, ok) {
  if (!_pendingRenames.end(rename, ok) || ok) return;
  takeBackRenamedTitle(rename.sessionId, rename.before, rename.title);
}

// session.updated now reaches the header live. While this panel has its own
// title for the session (generated by SynaBun or typed by the user) that one
// stays on screen and is pushed back; until then OpenCode's title shows.
function keepOwnSessionTitle(s) {
  // A rename of this session is out: its title is not the session's yet.
  if (_pendingRenames.isPending(s.sessionId)) return;
  const entry = _sessionTitleState.get(s.sessionId);
  if (!entry || !['auto', 'manual'].includes(entry.state) || !entry.title) return;
  if (!s.sessionInfo || s.sessionInfo.title === entry.title) return;
  s.sessionInfo.title = entry.title;
  _titleNeedsReassert(s.sessionId);
}

function _titleNeedsReassert(sessionId) {
  // A rename of this session is out: it carries the title itself.
  if (_pendingRenames.isPending(sessionId)) return;
  const entry = _sessionTitleState.get(sessionId);
  if (!entry || !['auto', 'manual'].includes(entry.state) || !entry.title) return;
  const existing = _titleReassertTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _titleReassertTimers.delete(sessionId);
    const latest = _sessionTitleState.get(sessionId);
    if (!latest || !['auto', 'manual'].includes(latest.state) || !latest.title) return;
    api.sessionUpdate(sessionId, { title: latest.title }).then((res) => {
      // A push the server refused relabels nothing; neither does one for a
      // title that is no longer the panel's own for this session.
      if (replyFailed(res) || _sessionTitleState.get(sessionId)?.title !== latest.title) return;
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
  // A question that was asked in the menu has nowhere to show: it is off.
  _confirms.cancel((view) => view.surface === 'menu');
}

// The question of the session menu, under the row it was asked on (or on top
// of the list while that row is not there), also after the list was refilled.
// (A question is asked in the menu only while it is open, and closing it takes
// the question, and its row, away.)
function syncSessionMenuConfirm() {
  syncConfirmRow(_confirms, _sessionMenuBodyEl, 'menu', (key) => _menuConfirmAnchors.get(key));
}

// The question above the compose box (closing a tab, deleting a message).
function syncPanelConfirm() {
  syncConfirmRow(_confirms, _confirmSlotEl, 'panel');
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

// Menu state that outlives one render: the search text and which list shows.
let _sessionMenuSearch = '';
let _sessionMenuArchived = false;
let _sessionMenuBodyEl = null;
let _sessionMenuRefreshTimer = null;
let _sharePolicy = null;            // OpenCode's `share` setting, read once per menu open
const _sharePolicyReads = latestOnly();
// The list under the search box: the newest read wins, and only for the
// filters (search text, archived or not) the menu still shows.
const _sessionMenuReads = latestFor();
const SESSION_MENU_LIMIT = 200;

function scheduleSessionMenuRefresh(delayMs = 250) {
  if (!_sessionMenuEl?.classList.contains('open')) return;
  if (_sessionMenuRefreshTimer) clearTimeout(_sessionMenuRefreshTimer);
  _sessionMenuRefreshTimer = setTimeout(() => {
    _sessionMenuRefreshTimer = null;
    refreshSessionMenuBody().catch((err) => console.warn('[ocp-v2-panel] session menu refresh failed', err));
  }, delayMs);
}

function menuItem(label, onClick, { meta = '', muted = false } = {}) {
  const item = document.createElement('div');
  item.className = 'ocpv2-session-item';
  const labelEl = document.createElement('span');
  labelEl.className = 'ocpv2-session-item-label';
  if (muted) labelEl.style.opacity = '0.55';
  labelEl.textContent = label;
  if (meta) {
    const metaEl = document.createElement('span');
    metaEl.className = 'ocpv2-session-item-meta';
    metaEl.textContent = meta;
    labelEl.appendChild(metaEl);
  }
  item.appendChild(labelEl);
  item.addEventListener('click', onClick);
  return item;
}

function menuSeparator() {
  const sep = document.createElement('div');
  sep.className = 'ocpv2-session-menu-sep';
  return sep;
}

// The menu's frame (search box) is built once per open; the list under it is
// refilled on every search keystroke and session event, so the box keeps focus.
async function renderSessionMenu() {
  if (!_sessionMenuEl) return;
  _sessionMenuEl.innerHTML = '';
  _sessionMenuSearch = '';
  _sessionMenuArchived = false;

  const searchRow = document.createElement('div');
  searchRow.className = 'ocpv2-session-search';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ocpv2-session-search-input';
  input.placeholder = 'Search sessions…';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  input.addEventListener('input', () => {
    _sessionMenuSearch = input.value;
    scheduleSessionMenuRefresh(180);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeSessionMenu(); }
  });
  searchRow.appendChild(input);
  _sessionMenuEl.appendChild(searchRow);

  _sessionMenuBodyEl = document.createElement('div');
  _sessionMenuBodyEl.innerHTML = '<div class="ocpv2-session-menu-empty">Loading…</div>';
  _sessionMenuEl.appendChild(_sessionMenuBodyEl);
  _menuConfirmAnchors.clear();

  // Whether sharing is allowed at all (D2: hidden when the config disables it).
  // The policy is the project's: an answer for an earlier opening of the menu,
  // or for the session the panel has left, is not this menu's.
  _sharePolicy = null;
  const policyIsFresh = _sharePolicyReads.begin();
  const policyAt = captureBinding(getDefaultStore());
  api.sessionSharePolicy({ cwd: policyAt.cwd || undefined }).then((res) => {
    if (!policyIsFresh() || !policyAt.isCurrent()) return;
    if (!replyFailed(res)) {
      _sharePolicy = res.data?.share || 'manual';
      scheduleSessionMenuRefresh(0);
    }
  }).catch(() => {});

  await refreshSessionMenuBody();
  setTimeout(() => input.focus(), 0);
}

async function refreshSessionMenuBody() {
  const body = _sessionMenuBodyEl;
  if (!body || !_sessionMenuEl?.classList.contains('open')) return;
  const filters = supports('feature:session-list-filters');
  const search = _sessionMenuSearch.trim();
  const archived = filters && _sessionMenuArchived;
  // An answer (rows or a failure) is painted only when it is the newest read,
  // for the menu body that asked, with the filters the menu still shows: an
  // older "live" list never lands under "Archived", and an old failure never
  // replaces a newer list.
  const asked = _sessionMenuReads.begin({ search, archived });
  const fresh = () => body === _sessionMenuBodyEl
    && asked({ search: _sessionMenuSearch.trim(), archived: supports('feature:session-list-filters') && _sessionMenuArchived });

  let sessions = [];
  try {
    const res = await api.sessionList(filters ? { search, archived, roots: true, limit: SESSION_MENU_LIMIT } : undefined);
    sessions = Array.isArray(res?.data) ? res.data : (res?.data?.sessions || []);
  } catch (err) {
    console.warn('[ocp-v2-panel] sessionList failed', err);
    if (!fresh()) return;
    body.innerHTML = '<div class="ocpv2-session-menu-empty">Failed to load sessions</div>';
    body.appendChild(menuItem('Retry', () => scheduleSessionMenuRefresh(0), { muted: true }));
    _menuConfirmAnchors.clear();
    syncSessionMenuConfirm();
    return;
  }
  if (!fresh()) return; // a newer refresh is on its way

  const s = getState();
  const cwd = s.cwd || storage.getItem(STOR_PROJECT) || '';
  // Sessions of every project are listed, so one from another registered
  // project can be resumed; sub-agent sessions open from their parent instead.
  // (A link whose sharing the panel stopped is not a share: the row says so.)
  const all = menuSessions(sessions, { search }).slice(0, SESSION_MENU_LIMIT).map((row) => _stoppedShares.clean(row));

  body.innerHTML = '';
  _menuConfirmAnchors.clear();
  if (!archived && !search) {
    body.appendChild(menuItem('+ New session', () => {
      closeSessionMenu();
      beginNewSession();
    }, { muted: true }));
    appendActiveSessionActions(body, s);
  }

  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'ocpv2-session-menu-empty';
    empty.textContent = search ? 'No session matches.' : (archived ? 'No archived sessions.' : 'No sessions yet.');
    body.appendChild(empty);
  } else {
    if (body.children.length) body.appendChild(menuSeparator());
    if (archived) {
      const note = document.createElement('div');
      note.className = 'ocpv2-session-menu-note';
      note.textContent = 'Archived';
      body.appendChild(note);
    }
    for (const sess of all) body.appendChild(buildSessionMenuItem(sess, s, cwd, { archived, filters }));
    if (sessions.length >= SESSION_MENU_LIMIT) {
      const more = document.createElement('div');
      more.className = 'ocpv2-session-menu-empty';
      more.textContent = `Showing the ${SESSION_MENU_LIMIT} most recent. Search to find older sessions.`;
      body.appendChild(more);
    }
  }

  if (filters) {
    body.appendChild(menuSeparator());
    body.appendChild(menuItem(archived ? 'Back to sessions' : 'Show archived', () => {
      _sessionMenuArchived = !archived;
      scheduleSessionMenuRefresh(0);
    }, { muted: true }));
  }
  // The list was built again: a question that is armed goes back under its row.
  syncSessionMenuConfirm();
}

// Publishing is two steps, both in the panel. "Share session…" (or /share)
// only asks: the question under it says what becomes public, and its button
// shares. Nothing is published by one click, and never by a native dialog.
async function shareActiveSession() {
  const sid = getState().sessionId;
  if (!sid) return null;
  if (!_sessionMenuEl?.classList.contains('open')) openSessionMenu();
  const result = await shareSession(getDefaultStore(), api, () => _confirms.ask({
    key: `share:${sid}`, surface: 'menu', text: SHARE_CONFIRM_TEXT, confirmLabel: 'Share publicly',
  }), { stopped: _stoppedShares });
  if (result && result.ok === false && !result.cancelled && !result.moved) pushError({ message: result.error || 'Share failed' });
  if (result?.ok && result.url) {
    try { await navigator.clipboard.writeText(result.url); } catch {}
    if (_sessionMenuEl?.classList.contains('open')) scheduleSessionMenuRefresh(0);
    else openSessionMenu();
  }
  return result;
}

// Stop sharing: the link goes from everything the panel holds of that
// session (the store, the tab cache, the menu), also when the panel was on
// another session by the time OpenCode answered.
async function stopSharingActiveSession() {
  const sid = getState().sessionId;
  const result = await unshareSession(getDefaultStore(), api, { stopped: _stoppedShares });
  if (result && result.ok === false && !result.moved) pushError({ message: result.error || 'Could not stop sharing' });
  if (sid) forgetStoppedShare(sid);
  return result;
}

function forgetStoppedShare(sessionId) {
  const cached = _tabInfoCache.get(sessionId);
  if (cached) _tabInfoCache.set(sessionId, _stoppedShares.clean(cached));
  const known = getState().knownSessions;
  if (known?.has?.(sessionId)) known.set(sessionId, _stoppedShares.clean(known.get(sessionId)));
  scheduleSessionMenuRefresh(0);
}

// Share / export / fork for the session that is open.
function appendActiveSessionActions(body, s) {
  if (!s.sessionId) return;
  const share = shareView(s.sessionInfo, _sharePolicy, supports);
  const report = (result, fallback) => {
    if (result && result.ok === false && !result.cancelled && !result.moved) pushError({ message: result.error || fallback });
    return result;
  };

  // Asked every time, under this item: the click only opens the question.
  // (The item is there while its question is armed, whatever the policy read
  // says by then: /share asks before that read is back.)
  const shareKey = `share:${s.sessionId}`;
  if ((share.canShare && _sharePolicy) || _confirms.isArmed(shareKey)) {
    const shareItem = menuItem('Share session…', () => {
      shareActiveSession().catch((err) => pushError({ message: err?.message || 'Share failed' }));
    }, { muted: true });
    _menuConfirmAnchors.set(shareKey, shareItem);
    body.appendChild(shareItem);
  }
  if (share.showLink) {
    body.appendChild(menuItem('Copy share link', async () => {
      // A failed copy is reported in the session whose link it was.
      const at = captureBinding(getDefaultStore());
      try { await navigator.clipboard.writeText(share.url); } catch (err) {
        if (at.isCurrent()) pushError({ message: err?.message || 'Copy failed' });
      }
    }, { muted: true, meta: 'public' }));
    const url = document.createElement('div');
    url.className = 'ocpv2-session-share-url';
    url.textContent = share.url;
    body.appendChild(url);
  }
  if (share.canUnshare) {
    body.appendChild(menuItem('Stop sharing', () => {
      stopSharingActiveSession().catch((err) => pushError({ message: err?.message || 'Could not stop sharing' }));
    }, { muted: true }));
  }
  if (s.messageOrder.length) {
    body.appendChild(menuItem('Export transcript', () => {
      closeSessionMenu();
      exportActiveTranscript().catch((err) => pushError({ message: err?.message || 'Export failed' }));
    }, { muted: true }));
    if (supports('session:fork')) {
      body.appendChild(menuItem('Fork session', async () => {
        closeSessionMenu();
        const nav = _nav.begin();
        const result = report(await forkSession(getDefaultStore(), api), 'Fork failed');
        if (result?.ok) await openCreatedSession(result.session, { activate: !result.moved, nav });
      }, { muted: true }));
    }
  }
}

function buildSessionMenuItem(sess, s, cwd, { archived, filters }) {
  const sid = sess.id || sess.sessionID;
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
    const displayTip = tip.length > 200 ? tip.slice(0, 200) + '…' : tip;
    item.setAttribute('data-tooltip', displayTip);
    item.setAttribute('data-tooltip-pos', 'left');
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'ocpv2-session-item-label';
  labelEl.textContent = title;
  item.appendChild(labelEl);

  const meta = [projectName, sess.share?.url ? 'shared' : ''].filter(Boolean).join(' · ');
  if (meta) {
    const metaEl = document.createElement('span');
    metaEl.className = 'ocpv2-session-item-meta';
    metaEl.textContent = meta;
    labelEl.appendChild(metaEl);
  }

  if (filters && !isActive) {
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'ocpv2-session-item-action';
    archiveBtn.textContent = archived ? 'Unarchive' : 'Archive';
    archiveBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      // Archiving closes the session's tab: asked first, under this row, when
      // prompts are still waiting there (before anything is sent).
      const closesTab = !archived && _tabSessionIds.includes(sid);
      // (Asked in the menu while it is open, else above the compose box.)
      const question = () => ({
        key: `session-archive:${sid}`, confirmLabel: 'Archive and discard',
        surface: _sessionMenuEl?.classList.contains('open') ? 'menu' : 'panel',
      });
      if (closesTab && !(await mayCloseTab(sid, question()))) return;
      // What the user agreed to lose: mayCloseTab answers for exactly these.
      const confirmed = closesTab ? promptsWaitingFor(sid) : [];
      // OpenCode keeps the session; `time.archived = 0` brings it back.
      const res = await api.sessionUpdate(sid, { time: { archived: archived ? 0 : Date.now() } }).catch((err) => ({ ok: false, error: err?.message }));
      if (replyFailed(res)) { pushError({ message: replyError(res, archived ? 'Unarchive failed' : 'Archive failed') }); return; }
      // The tab closes now. What is waiting for the session may no longer be
      // what the user agreed to lose (a send of it failed while the archive
      // was out, or they opened the tab and queued something else): unless it
      // is exactly that, they are asked again, and the tab stays when they
      // decline.
      const mayClose = closesTab && (samePrompts(promptsWaitingFor(sid), confirmed) || await mayCloseTab(sid, question()));
      if (mayClose && _tabSessionIds.includes(sid)) await handlePillClose(sid, { byUser: true }).catch(() => {});
      scheduleSessionMenuRefresh(0);
    });
    item.appendChild(archiveBtn);
  }
  _menuConfirmAnchors.set(`session-archive:${sid}`, item);
  _menuConfirmAnchors.set(`session-delete:${sid}`, item);

  const delBtn = document.createElement('button');
  delBtn.className = 'ocpv2-session-item-delete';
  delBtn.type = 'button';
  delBtn.setAttribute('data-tooltip', 'Delete');
  delBtn.innerHTML = ICON_X_SMALL;
  delBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    // One question, under this row: the deletion, and the prompts still
    // waiting to be sent in that session, when there are any (they go with
    // it). This click only asks; the button of the question deletes.
    const lead = `Delete "${title}"? The session and its history are removed from OpenCode.`;
    if (!(await mayCloseTab(sid, { key: `session-delete:${sid}`, surface: 'menu', lead, confirmLabel: 'Delete session' }))) return;
    const wasRunning = sid === getState().sessionId && !!getState().running;
    const deletePromise = closeSessionBackend(sid, {
      wasRunning,
      context: 'session menu delete',
    });
    // The row promised a deletion: a refusal is said (the list is read again
    // below and shows the session still there).
    deletePromise.then((out) => {
      if (out && out.ok === false) pushError({ message: `Could not delete “${title}”: ${out.error || 'no answer'}` });
    }).catch(() => {});
    item.remove();
    handlePillClose(sid, { byUser: true }).catch((err) => {
      console.warn('[ocp-v2-panel] local session menu delete failed', err);
    }).finally(() => {
      deletePromise.finally(() => scheduleSessionMenuRefresh(0));
    });
  });
  item.appendChild(delBtn);

  labelEl.addEventListener('click', async () => {
    closeSessionMenu();
    // The click is a navigation: it takes the panel, also after the unarchive
    // it may have to wait for, only while it is the user's latest choice.
    const nav = _nav.begin();
    let unarchived = null;
    const went = await navigateAfter(
      nav,
      async () => {
        if (archived) unarchived = await api.sessionUpdate(sid, { time: { archived: 0 } }).catch((err) => ({ ok: false, error: err?.message }));
      },
      () => switchToSession(sid, sess, { nav }),
    );
    if (!went) { ensureTab(sid, sess); renderPill(); }
    // The session opens either way (it can be read and continued). A refused
    // unarchive is said in it: it is still in the archive.
    if (archived && replyFailed(unarchived) && getState().sessionId === sid) {
      pushError({ message: `Could not unarchive “${title}”: ${replyError(unarchived, 'no answer')}` });
    }
  });
  return item;
}

// A session this panel just created from another one (fork): keep the current
// one as a tab and move to the new one.
// `activate: false`: the session was made while the user moved on to another
// one (the action that made it reports `moved`). It gets a tab; what is on
// screen stays.
// `nav`: the intent of the click that made it. Once a newer navigation began,
// the session is a tab too.
async function openCreatedSession(session, { activate = true, nav } = {}) {
  if (!session?.id) return;
  if (!activate || (nav && !nav.isCurrent())) {
    ensureOpenCodeTitleState(session.id, session, { manual: true });
    ensureTab(session.id, session);
    renderPill();
    return;
  }
  const prevSid = getState().sessionId;
  if (prevSid) ensureTab(prevSid, getState().sessionInfo);
  await switchToSession(session.id, session, { nav });
}

async function exportActiveTranscript() {
  if (!getState().sessionId) return;
  // Session id, metadata and file name are captured before the transcript is
  // read (readTranscriptExport): the download is one session's, whole, also
  // when another one is selected while it is being read.
  const out = await readTranscriptExport(getDefaultStore(), api);
  if (!out.ok) {
    if (out.moved) return;
    throw new Error(out.error || 'Could not read the transcript');
  }
  const { filename, json } = out;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// `nav` is the intent of the gesture this switch is the last step of (a tab
// click that waited for the panel to open, a fork). Without one the switch is
// the gesture itself and begins its own. A switch whose intent was overtaken
// binds nothing: the session stays (or becomes) a tab.
async function switchToSession(sid, info = null, { nav } = {}) {
  if (!sid) return;
  const intent = nav || _nav.begin();
  if (sid === getState().sessionId) return;
  ensureOpenCodeTitleState(sid, info, { manual: true });
  // Keep the previously-active session as a tab pill before swapping — but only
  // if it's still in the tab list. handlePillClose removes the tab BEFORE
  // calling us; without this guard the just-deleted session would resurrect.
  const prevSid = getState().sessionId;
  if (prevSid && _tabSessionIds.includes(prevSid)) {
    ensureTab(prevSid, getState().sessionInfo);
  }
  const bound = intent.apply(() => {
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
  });
  if (!bound) { ensureTab(sid, info); renderPill(); return; }
  // Continue on what the session last ran with. The menu and the saved tabs
  // hand over list rows, which carry no model: read the whole session.
  const detailed = restoreSessionSelections(sid, info);
  // Best-effort hydrate of the transcript, run state and approvals. An answer
  // that comes back after the user moved on again is dropped.
  const hydrated = await hydrateBoundSession(sid);
  if (!hydrated.moved && !hydrated.transcript) console.warn('[ocp-v2-panel] sessionMessages failed', hydrated.error);
  await detailed;
  renderPill();
}

// Model, variant and agent follow the session on screen (Session.model /
// .agent). Resolves once applied. The answer is for the selection that asked:
// a session the panel left meanwhile is skipped, and so is an earlier visit to
// the same session (A → B → A), whose answer may be older than the one the
// newer selection gets (loadSelectedSession checks the binding, not the id).
async function restoreSessionSelections(sid, info) {
  return loadSelectedSession(getDefaultStore(), api, sid, info, (full) => {
    // The directory first: it decides which agent list the session's agent is
    // checked against (ocp-v2-send.js).
    const dir = full.directory;
    if (dir && dir !== getState().cwd) {
      setCwd(dir);
      storage.setItem(STOR_PROJECT, dir);
    }
    applySessionSelections(getDefaultStore(), full);
    // Fresh metadata too: keeps the title right after a switch.
    getDefaultStore().setSessionInfo(full);
    _tabInfoCache.set(sid, _stoppedShares.clean({ ...(_tabInfoCache.get(sid) || {}), ...full }));
    if (!info) ensureTab(sid, full);
  });
}

function beginRenameSession() {
  const s = getState();
  if (!s.sessionId || !_sessionLabelEl) return;
  if (_sessionLabelEl.querySelector('.ocpv2-rename-input')) {
    _sessionLabelEl.querySelector('.ocpv2-rename-input').focus();
    return;
  }

  // The session this box renames: the one on screen when it was opened. The
  // box stays in the header while the user switches session, so the target is
  // captured here and never read from the live state afterwards.
  const target = captureBinding(getDefaultStore());
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

  const restoreLabel = () => {
    if (_sessionLabelEl.contains(input)) {
      _sessionLabelEl.textContent = sessionTitleFor(getState());
    }
  };
  // The box is gone once it has been answered, also after a rename that
  // worked: left in the header it would be a finished box, and the next
  // Rename would focus it and do nothing (renameBox).
  let rename = null;
  const finish = renameBox({
    currentTitle,
    read: () => input.value,
    rename: (next) => {
      // Pending from here until it is answered (settleRename): nothing
      // re-asserts this title meanwhile.
      rename = _pendingRenames.begin(target.sessionId, next, titleStateBefore(target.sessionId));
      markOpenCodeTitleManual(target.sessionId, next);
      cancelTitleReassert(target.sessionId);
      return renameSession(getDefaultStore(), api, next, { binding: target });
    },
    after: (result, next) => {
      // Refused, or never answered: the session keeps the title it had, here too.
      settleRename(rename, result.ok);
      if (result.ok) {
        // On another binding the title still belongs to its session: its tab
        // (and the store, should the panel be back on it) gets it by id. The
        // header then shows the title of the session that is on screen.
        if (!result.applied) updateOpenCodeTitleLocally(result.sessionId, next);
        return;
      }
      console.warn('[ocp-v2-panel] rename failed', result.error);
      // The banner is for the session that was renamed, not for the one on screen now.
      if (result.current) pushError({ message: result.error || 'Rename failed' });
    },
    restore: restoreLabel,
  });
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
      // Boot binds the panel to a session unless the user chose one while it
      // was starting (a tab click, New session): captured before the first
      // wait, and never overtaking a choice (observe).
      const bootNav = _nav.observe();
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
        // The sub-agents of every tab get their panels here (one set per tab).
        ownsSession: (sessionId) => _tabSessionIds.includes(sessionId),
        // Prompts of a sub-agent panel that went away with its session.
        keepPrompts: (items, label) => _composer?.keep?.(items, label),
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
            _tabInfoCache.set(sid, _stoppedShares.clean(info));
            ensureOpenCodeTitleState(sid, info, { manual: true });
          }
        }
        _tabSessionIds = liveTabs;
        saveTabSessions();
      }
      if (!liveTabs.length && _pendingAutomationAttach?.sessionId) {
        const { sessionId, info } = _pendingAutomationAttach;
        liveTabs.push(sessionId);
        _tabInfoCache.set(sessionId, _stoppedShares.clean(info || { id: sessionId }));
        ensureOpenCodeTitleState(sessionId, info, { manual: true });
        _tabSessionIds = [...liveTabs];
        saveTabSessions();
      }
      // 6. If we have a restorable tab, switch to the most recent; otherwise
      //    auto-create one fresh session.
      if (!bootNav.isCurrent()) {
        // Another navigation bound the panel meanwhile: the tabs are restored,
        // the session on screen stays.
        renderPill();
      } else if (liveTabs.length) {
        const targetSid = liveTabs[liveTabs.length - 1];
        const targetInfo = _tabInfoCache.get(targetSid) || null;
        bootNav.apply(() => {
          setSession(targetSid, targetInfo);
          bindPrimarySession(getDefaultStore(), targetSid);
        });
        const detailed = restoreSessionSelections(targetSid, targetInfo);
        detailed.catch((err) => console.warn('[ocp-v2-panel] session selections restore failed', err));
        // Transcript, run state and approvals. An in-flight turn that survived
        // the reload shows as running, not "idle".
        const hydrated = await hydrateBoundSession(targetSid);
        if (!hydrated.moved && !hydrated.transcript) console.warn('[ocp-v2-panel] sessionMessages failed on boot', hydrated.error);
        renderPill();
      } else {
        // No tab to restore: an untouched session of the project, else a new
        // one, and neither once the user chose something meanwhile (also when
        // the lookup failed).
        await landWithoutTabs(bootNav, {
          adopt: (nav) => adoptEmptySession(lastProject, nav),
          create: (nav) => startFreshSession({ cwd: lastProject || undefined, nav }),
        });
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

// Tabs of the other SynaBun windows: a session open over there is theirs.
function otherWindowTabIds() {
  const ids = [];
  try {
    const registry = JSON.parse(storage.getItem(STOR_WINDOW_REGISTRY) || '{}');
    for (const windowId of Object.keys(registry)) {
      if (windowId === OCP_WINDOW_ID) continue;
      const tabs = JSON.parse(storage.getItem(`opencode-v2-tabs-${windowId}`) || '[]');
      if (Array.isArray(tabs)) ids.push(...tabs);
    }
  } catch {}
  return ids;
}

// Opening the panel with no tab to restore used to create one more empty
// session every time. Take the newest untouched session of this project
// instead, when there is one nobody else has open.
// Resolves 'adopted', 'none' (the caller may create one) or 'moved' (another
// navigation took the panel while the list was read, or failed to be read:
// nothing is adopted, and the caller creates nothing either).
async function adoptEmptySession(cwd, nav = _nav.observe()) {
  if (!cwd) return 'none';
  const filters = supports('feature:session-list-filters');
  const out = await adoptReusableSession(nav, {
    list: async () => {
      const res = await api.sessionList(filters ? { roots: true, limit: 50 } : undefined);
      return Array.isArray(res?.data) ? res.data : [];
    },
    pick: (sessions) => pickReusableEmptySession(sessions, cwd, { excludeIds: otherWindowTabIds() }),
    bind: (reusable) => {
      ensureOpenCodeTitleState(reusable.id, reusable, { fresh: true });
      setSession(reusable.id, reusable);
      bindPrimarySession(getDefaultStore(), reusable.id);
    },
  });
  if (out === 'adopted') renderPill();
  return out;
}

// Mirrors Claude/Codex: create the new session immediately, then surface the
// rename modal as an optional follow-up. Skipping the modal still leaves the
// fresh session in place.
function beginNewSession() {
  if (openAnotherSidepanelSession(PANEL_OWNER, 'opencode', { project: getState().cwd || '' })) return;
  const cwd = getState().cwd || storage.getItem(STOR_PROJECT) || undefined;
  // Preserve the current session as a tab pill before spawning the new one.
  const prevSid = getState().sessionId;
  if (prevSid) ensureTab(prevSid, getState().sessionInfo);
  // The click is a navigation of its own: the session it creates takes the
  // panel, and gets the naming dialog, only while no newer choice was made.
  const nav = _nav.begin();
  let created = null;
  startFreshSession({ cwd, nav })
    .then((out) => { created = out; })
    .catch((err) => pushError({ message: err?.message || 'New session failed' }))
    .finally(() => {
      loadProjectsOnce().catch(() => {}).finally(() => {
        // The dialog names the session this click created, and only while
        // that session is what the panel shows: not after the user went
        // elsewhere (during the creation or during the project list), and
        // not when the creation failed (there is nothing to name).
        if (!shouldNameCreatedSession(getDefaultStore(), nav, created)) return;
        promptNameNewSession(created.sessionId);
      });
    });
}

// Creates a session and binds the panel to it. `nav` is the intent of the
// navigation that asked for it (a click, a project change, boot); without one
// it begins here. The navigation owns the panel only while it is the latest:
// when the user chose something else while the new session was being created,
// the new one is kept as a tab and nothing on screen is cleared or replaced.
// Resolves `{ sessionId, activated }`.
async function startFreshSession({ title, cwd, nav } = {}) {
  const owner = nav || _nav.begin();
  // Reset local message state so we don't show stale parts from a previous session
  if (owner.isCurrent()) clearMessages();
  const projectCwd = cwd || getState().cwd || undefined;
  const { session: sess, activate } = await createSessionForNavigation(getDefaultStore(), api, { title, cwd: projectCwd, nav: owner });
  const titleState = ensureOpenCodeTitleState(sess.id, sess, { fresh: true, manual: !!title });
  if (title && titleState) {
    titleState.title = title;
    saveTitleStates();
  }
  const activated = activate && owner.apply(() => {
    // The store stayed subscribed to the session being left while the new one
    // was created: messages that arrived meanwhile are that session's. (Its
    // pending approvals and questions are dropped by setSession itself.)
    if (getState().messageOrder.length) clearMessages();
    setSession(sess.id, sess);
    bindPrimarySession(getDefaultStore(), sess.id);
    if (cwd) setCwd(cwd);
  });
  if (!activated) ensureTab(sess.id, sess);
  // SDK may ignore title at create-time; rename as fallback so the label shows.
  if (title && sess.title !== title) {
    // Best effort, as before: nothing here shows the title as set, and the
    // panel's own title for the session is pushed again when OpenCode next
    // reports the session (keepOwnSessionTitle). A refusal is logged like a
    // request that threw.
    try {
      const named = await api.sessionUpdate(sess.id, { title });
      if (replyFailed(named)) console.warn('[ocp-v2-panel] sessionUpdate refused', replyError(named, 'Rename failed'));
    } catch (err) { console.warn('[ocp-v2-panel] sessionUpdate failed', err); }
  }
  renderPill();
  return { sessionId: sess.id, activated };
}

// Switching the active project on a live session is a hard cut for OpenCode:
// the session is bound to the cwd at creation, so we drop it and start fresh.
async function setActiveProject(path) {
  const next = String(path || '');
  const prev = getState().cwd || '';
  if (next === prev) return;

  // This navigation owns the panel from here until its new session is bound,
  // unless the user chooses something else while it waits.
  const nav = _nav.begin();

  // Persist the new project as the default cwd
  setCwd(next);
  if (next) storage.setItem(STOR_PROJECT, next);
  else      storage.removeItem(STOR_PROJECT);

  // If a turn is in flight, abort it before yanking the session. The session
  // that is aborted is the one the project was changed on; when another one
  // was selected while the abort was out, that selection stands: it is not
  // cleared, and no session is created over it.
  if (!(await stopForNavigation(getDefaultStore(), api, nav))) return;

  // Drop any existing session — next send will run on the new cwd
  if (nav.sessionId) {
    nav.apply(() => {
      clearMessages();
      setSession(null, null);
      bindPrimarySession(getDefaultStore(), null);
    });
  }

  // Eagerly create a fresh session at the new cwd so the user can send immediately
  try {
    await startFreshSession({ cwd: next || undefined, nav });
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

// `targetSessionId` is the session the dialog names: the one that was just
// created. It is fixed when the dialog opens (the session on screen then, when
// none is given) and never read from the live state afterwards.
function promptNameNewSession(targetSessionId = null) {
  if (!_panelEl) return;
  if (_panelEl.querySelector('.ocpv2-name-modal-overlay')) return;
  const target = captureBinding(getDefaultStore(), targetSessionId ? { sessionId: targetSessionId } : {});
  // The dialog is for a session, and for the one on screen: there is nothing
  // to name otherwise.
  if (!target.sessionId || !target.isCurrent()) return;

  const overlay = document.createElement('div');
  overlay.className = 'ocpv2-name-modal-overlay';
  overlay.innerHTML = `
    <div class="ocpv2-name-modal" role="dialog" aria-modal="true">
      <div class="ocpv2-name-modal-title">Name this session</div>
      <div class="ocpv2-name-modal-row">
        <label class="ocpv2-name-modal-label">Project</label>
        <select class="ocpv2-name-modal-select" data-role="project"></select>
      </div>
      <div class="ocpv2-name-modal-row">
        <label class="ocpv2-name-modal-label">Branch</label>
        <select class="ocpv2-name-modal-select" data-role="branch" disabled></select>
      </div>
      <div class="ocpv2-name-modal-row ocpv2-name-modal-worktree" hidden>
        <label class="ocpv2-name-modal-label">Worktree</label>
        <label class="ocpv2-name-modal-check">
          <input type="checkbox" data-role="worktree" />
          <span>Run in a new git worktree</span>
        </label>
      </div>
      <div class="ocpv2-name-modal-worktrees" hidden></div>
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

  // Project and branch names are data (a directory or a branch can be named
  // anything): options are built as elements, never as markup.
  setSelectOptions(projectSel, projectOptionRows(_projects), { placeholder: '(none)' });
  setSelectOptions(branchSel, [], { placeholder: '(loading...)' });
  const initialProject = getState().cwd || storage.getItem(STOR_PROJECT) || '';
  if (projectSel && initialProject) projectSel.value = initialProject;

  let branchOriginal = null;
  let branchesKnown = false;
  // A session in a new worktree starts from what the project has checked out
  // now; the project's own checkout is never switched for it.
  const syncBranchLock = () => {
    const locked = !!worktreeCheck?.checked;
    if (locked && branchOriginal) branchSel.value = branchOriginal;
    branchSel.disabled = locked || !branchesKnown;
    branchSel.title = locked ? 'A new worktree starts from the branch the project has checked out.' : '';
  };
  let branchRequest = 0;
  async function refreshBranches(path) {
    const request = ++branchRequest;
    branchesKnown = false;
    branchSel.disabled = true;
    setSelectOptions(branchSel, [], { placeholder: '(loading...)' });
    if (!path) {
      setSelectOptions(branchSel, [], { placeholder: '(none)' });
      branchOriginal = null;
      return;
    }
    const data = await fetchBranchesForModal(path);
    if (request !== branchRequest) return;     // another project was picked meanwhile
    branchOriginal = data.current || null;
    const branches = (Array.isArray(data.branches) ? data.branches : []).filter((b) => typeof b === 'string' && b);
    if (!branches.length) {
      setSelectOptions(branchSel, [], { placeholder: '(none)' });
    } else {
      setSelectOptions(branchSel, branches);
      if (branchOriginal) branchSel.value = branchOriginal;
      branchesKnown = true;
    }
    syncBranchLock();
  }

  // Worktrees: an isolated checkout OpenCode creates for the session, so its
  // edits stay out of the main working tree. Offered only when the server can.
  const worktreeRow = overlay.querySelector('.ocpv2-name-modal-worktree');
  const worktreeCheck = overlay.querySelector('input[data-role="worktree"]');
  const worktreeList = overlay.querySelector('.ocpv2-name-modal-worktrees');
  worktreeCheck?.addEventListener('change', syncBranchLock);
  refreshBranches(projectSel?.value || initialProject);
  const worktreeReads = latestOnly();
  // Removing a worktree is asked in the dialog, under its row.
  const worktreeConfirmAnchors = new Map();
  const dialogQuestion = (view) => view.surface === 'dialog';
  const offWorktreeConfirm = _confirms.onChange(() => {
    syncConfirmRow(_confirms, worktreeList, 'dialog', (key) => worktreeConfirmAnchors.get(key));
  });
  async function refreshWorktrees(path) {
    // The rows are read again: a question about one of them is off.
    _confirms.cancel(dialogQuestion);
    worktreeConfirmAnchors.clear();
    const canCreate = supports('worktree:create') && !!path;
    worktreeRow.hidden = !canCreate;
    if (!canCreate) worktreeCheck.checked = false;
    syncBranchLock();
    worktreeList.hidden = true;
    worktreeList.textContent = '';
    if (!path || !supports('worktree:list', 'worktree:remove')) return;
    const latest = worktreeReads.begin();
    const res = await api.worktreeList({ cwd: path }).catch(() => null);
    // A newer read (another project picked, a worktree removed) owns the list.
    if (!latest() || replyFailed(res) || !Array.isArray(res.data) || !res.data.length || projectSel?.value !== path) return;
    worktreeList.hidden = false;
    for (const tree of res.data) {
      const row = document.createElement('div');
      row.className = 'ocpv2-permission-more';
      const name = document.createElement('code');
      name.textContent = tree.branch ? `${tree.name} (${tree.branch})` : tree.name;
      name.title = tree.directory;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ocpv2-permission-link';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        // This click only asks; the button of the question removes it.
        const key = `worktree-remove:${tree.directory}`;
        worktreeConfirmAnchors.set(key, row);
        const agreed = await _confirms.ask({
          key, surface: 'dialog', confirmLabel: 'Remove worktree',
          text: `Remove the worktree "${tree.name}"? Its directory and uncommitted changes are deleted.`,
        });
        if (!agreed) return;
        const removed = await api.worktreeRemove({ cwd: path, directory: tree.directory }).catch((err) => ({ ok: false, error: err?.message }));
        // The failure is about the worktree, not about a session: it is shown
        // wherever the panel is. The list is this dialog's: it is read again
        // only while the dialog is open and still on that project.
        if (replyFailed(removed)) { pushError({ message: replyError(removed, 'Could not remove the worktree') }); return; }
        if (done || projectSel?.value !== path) return;
        refreshWorktrees(path);
      });
      row.append(name, remove);
      worktreeList.appendChild(row);
    }
  }
  refreshWorktrees(projectSel?.value || initialProject);

  projectSel?.addEventListener('change', () => {
    refreshBranches(projectSel.value);
    refreshWorktrees(projectSel.value);
  });

  setTimeout(() => { input.focus(); input.select(); }, 10);

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    offWorktreeConfirm();
    _confirms.cancel(dialogQuestion);
    overlay.remove();
  };

  const commit = async (cancel) => {
    if (done) return;
    const nextTitle = input.value.trim();
    const chosenProject = projectSel?.value || '';
    const chosenBranch = branchSel?.value || '';
    const wantsWorktree = !!worktreeCheck?.checked && !!chosenProject;
    close();
    // Skip leaves the freshly-created session in place — same as Claude/Codex
    // where dismissing the rename modal keeps the empty new tab.
    if (cancel) return;

    const plan = newSessionPlan({
      project: chosenProject, branch: chosenBranch, currentBranch: branchOriginal || '',
      wantsWorktree, cwd: getState().cwd || '',
    });
    const projectChanged = plan.projectChanged;
    // What Save starts is a navigation of its own when it creates a session
    // (in a worktree, in another project): it owns the panel from this click
    // on, unless the user chooses something else while it waits. A Save that
    // only names the session navigates nowhere and begins no intent.
    const nav = (plan.worktree || projectChanged) ? _nav.begin() : null;

    // The worktree first: an isolated session never switches the branch of the
    // project's own checkout.
    if (plan.worktree) {
      await startSessionInNewWorktree(chosenProject, nextTitle, nav);
      return;
    }

    if (plan.checkout) {
      // A session started after a failed switch would run on the wrong base.
      let outcome;
      try {
        const res = await fetch('/api/terminal/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(plan.checkout),
        });
        outcome = checkoutOutcome(res.status, await res.json().catch(() => null));
      } catch (err) {
        outcome = { ok: false, error: `Could not switch branch: ${err?.message || 'request failed'}` };
      }
      if (!outcome.ok) {
        pushError({ message: outcome.error });
        return;
      }
    }

    if (projectChanged) {
      if (nav.isCurrent()) {
        setCwd(chosenProject);
        storage.setItem(STOR_PROJECT, chosenProject);
        // Preserve the just-created session as a tab before swapping to a new cwd.
        const prevSid = getState().sessionId;
        if (prevSid) ensureTab(prevSid, getState().sessionInfo);
      }
      try {
        await startFreshSession({ title: nextTitle || undefined, cwd: chosenProject, nav });
      } catch (err) {
        pushError({ message: err?.message || 'New session failed' });
      }
      return;
    }

    // Name the session this dialog was opened for, wherever the panel is now.
    const sid = target.sessionId;
    if (sid && nextTitle) {
      const rename = _pendingRenames.begin(sid, nextTitle, titleStateBefore(sid));
      markOpenCodeTitleManual(sid, nextTitle);
      cancelTitleReassert(sid);
      const result = await renameSession(getDefaultStore(), api, nextTitle, { binding: target });
      // Refused, or never answered: the session was not named.
      settleRename(rename, result.ok);
      if (result.ok) {
        if (!result.applied) updateOpenCodeTitleLocally(sid, nextTitle);
      } else {
        console.warn('[ocp-v2-panel] rename failed', result.error);
        // The dialog is closed by now: without a banner the name typed into
        // it would be gone without a word. (In the session it was for.)
        if (result.current) pushError({ message: `Rename failed for “${nextTitle}”: ${result.error || 'no answer'}` });
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

// "Run in a new git worktree": OpenCode creates the worktree (and runs the
// project's start command in it), then the session is created inside it. The
// project stays the remembered default; only this session lives in the worktree.
async function startSessionInNewWorktree(projectPath, title, nav = _nav.begin()) {
  // Subscribe before creating: the ready event can beat the reply. Events are
  // held until the reply names this worktree, so another creation finishing
  // (or failing) first is not mistaken for this one.
  const watch = watchWorktree(onEvent, { timeoutMs: 60_000 });
  const created = await api.worktreeCreate({ cwd: projectPath }).catch((err) => ({ ok: false, error: err?.message }));
  if (replyFailed(created) || !created.data?.directory) {
    watch.cancel();
    pushError({ message: replyError(created, 'Could not create the worktree') });
    return;
  }
  watch.identify(created.data.name);
  const state = await watch.result;
  if (!state.ok) {
    pushError({ message: state.error });
    return;
  }
  // Up to a minute has passed. The session is created in the worktree either
  // way; it takes the panel only when the user did not navigate meanwhile
  // (`nav`), and is a tab otherwise.
  if (nav.isCurrent()) {
    const prevSid = getState().sessionId;
    if (prevSid) ensureTab(prevSid, getState().sessionInfo);
  }
  try {
    await startFreshSession({ title: title || undefined, cwd: created.data.directory, nav });
  } catch (err) {
    pushError({ message: err?.message || 'New session failed' });
  }
}

async function closeCurrentSession() {
  // Update the UI first; server cleanup is best-effort and must not block the
  // only visible tab from closing.
  const sid = getState().sessionId;
  // The tab this closes (with no session on screen and one tab left, that
  // tab): asked first when prompts are still waiting there. Declined: nothing
  // is closed and nothing is deleted.
  const closing = sid ? [sid] : (_tabSessionIds.length > 1 ? [] : [..._tabSessionIds]);
  for (const id of closing) { if (!(await mayCloseTab(id))) return; }
  // (Read after the question: the turn may have ended while it was up.)
  const wasRunning = !!sid && sid === getState().sessionId && !!getState().running;
  const backendClose = closeSessionBackend(sid, { wasRunning, context: 'close' });
  const closePromise = handlePillClose(sid, { byUser: true });
  backendClose.catch(() => {});
  try { await closePromise; }
  catch (err) { console.warn('[ocp-v2-panel] local close failed', err); }
}

// Best effort: closing a tab never waits for, or depends on, the server
// cleanup. Resolves `{ ok, error? }` for the one caller that promised a
// deletion (the session menu's Delete); a refusal is logged like a throw.
function deleteSessionBestEffort(sessionId, { abort = false, context = 'delete' } = {}) {
  if (!sessionId) return Promise.resolve({ ok: true });
  return (async () => {
    if (abort) {
      try { await api.abort(sessionId); }
      catch (err) { console.warn(`[ocp-v2-panel] abort before ${context} failed`, err); }
    }
    let res;
    try { res = await api.sessionDelete(sessionId); }
    catch (err) { res = { ok: false, error: err?.message || String(err) }; }
    if (!replyFailed(res)) return { ok: true };
    const error = replyError(res, 'Delete failed');
    console.warn(`[ocp-v2-panel] ${context} sessionDelete failed`, error);
    return { ok: false, error };
  })();
}

async function showPrimaryOpencodePanel() {
  if (!_panelEl) buildPanel();
  if (_visible) {
    focusSidepanel(PANEL_OWNER);
    renderPill();
    return true;
  }

  setVisible(true);

  // Lazy connect and boot on first open
  try {
    await connect();
    await boot();
    setTimeout(() => { if (_visible && state.lastActivePanel === 'opencode') focusCompose(); }, 60);
  } catch (err) {
    console.warn('[ocp-v2-panel] open failed', err);
  }
  return true;
}

// Which OpenCode panel is on screen (this one or a sub-agent's) is decided in
// one place: decideVisibility, applied by the manager.
registerMainView({ owner: PANEL_OWNER, isVisible: () => _visible });
function setVisible(nextVisible) {
  requestOpencodeView(nextVisible ? { show: MAIN_VIEW } : { hide: MAIN_VIEW });
}

function applyVisibility(nextVisible) {
  if (!_panelEl) return;
  const next = !!nextVisible;
  if (next === _visible) {
    renderPill();
    return;
  }
  _visible = next;
  _panelEl.classList.toggle('ocpv2-open', _visible);
  if (_visible) {
    state.lastActivePanel = 'opencode';
  } else {
    // The popover is a child of <body>: it does not go with the panel by itself.
    _contextMenu?.close();
  }
  syncSidepanelLayout(PANEL_OWNER);
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
  if (info) _tabInfoCache.set(sessionId, _stoppedShares.clean(info));
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
  // An automation's transcript is kept: nothing was asked of the server.
  return Promise.resolve({ ok: true, kept: true });
}

// Prompts still waiting to be sent in `sessionId`: its queue when it is on
// screen, and what is parked for it (a queue the panel left, a prompt that
// could not be delivered).
// (And what is still unsent in the panels of its sub-agents: closing the tab
// deletes the session, and its sub-agents' panels go with it.)
function promptsWaitingFor(sessionId) {
  return [...(_composer?.waitingFor?.(sessionId) || []), ...subagentPromptsWaiting(sessionId)];
}

// Closing a tab discards the prompts that are waiting for its session, so the
// user is asked first, in the panel, and shown which. Resolves true when
// nothing is waiting, or the user agreed with the second click (the button of
// the question; never a native dialog). Every close the user starts goes
// through here before anything is closed or deleted; it is the only place the
// question is asked.
//   lead     asked also when nothing is waiting (the session menu's Delete)
//   surface  where the question shows: above the compose box, or in the menu
// The answer is about the prompts the question listed: when others are
// waiting by the time the user agrees, they are asked again.
async function mayCloseTab(sessionId, { key = `tab-close:${sessionId}`, surface = 'panel', lead = '', confirmLabel = 'Close and discard' } = {}) {
  for (;;) {
    const waiting = promptsWaitingFor(sessionId);
    const text = closeWithPromptsConfirm({ items: waiting, label: tabLabelFor(sessionId), lead }) || lead;
    if (!text) return true;
    // A tab can be closed from the tray while the panel is hidden: the
    // question is shown, not asked into a closed panel.
    if (surface === 'panel' && _panelEl && !_visible) setVisible(true);
    if (!(await _confirms.ask({ key, surface, text, confirmLabel }))) return false;
    if (samePrompts(promptsWaitingFor(sessionId), waiting)) return true;
  }
}

// `byUser`: the user closed the tab (and was asked, when prompts were
// waiting). Without it the session went away by itself (deleted somewhere
// else, lost by OpenCode, an automation that detached): there was no moment
// to ask, and what was waiting for it is kept for the user.
function removeTab(sessionId, { byUser = false } = {}) {
  if (!sessionId) return;
  // The session is leaving the panel for good. Prompts that were still
  // waiting for it (its queue, a send that failed while the panel was
  // elsewhere) cannot be delivered there any more. The composer drops them
  // for a tab the user closed, and keeps each one on a notice otherwise
  // (Put back / Discard).
  _composer?.forgetSession?.(sessionId, { lost: !byUser, label: tabLabelFor(sessionId) });
  // Its sub-agents' panels and pills belong to it and go with it. What was
  // unsent in them is kept on notices when nobody was asked (the composer's rule).
  releaseSubagentPanels(sessionId, { lost: !byUser });
  _pendingRenames.forget(sessionId);
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
    // Asked first when prompts are still waiting in that session; declined:
    // the tab stays and nothing is deleted.
    if (!(await mayCloseTab(sessionId))) return;
    const wasRunning = sessionId === getState().sessionId && !!getState().running;
    closeSessionBackend(sessionId, { wasRunning, context: 'pill close' }).catch(() => {});
    try { await handlePillClose(sessionId, { byUser: true }); }
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
  // The sub-agent pills of the session on screen sit under its pill.
  syncSubagentTray();
}

async function handlePillClick(sessionId) {
  if (!sessionId) return;
  // A click on a tab is the user's choice of where the panel goes. It may
  // have to wait for the panel to open (connect, boot); a newer click made
  // meanwhile wins, and this one then switches nothing.
  const nav = _nav.begin();
  const activeSid = getState().sessionId;
  if (sessionId === activeSid) {
    if (_visible) setVisible(false);
    else await showPrimaryOpencodePanel();
    return;
  }
  if (!_panelEl) buildPanel();
  const went = await navigateAfter(
    nav,
    () => (_visible ? null : showPrimaryOpencodePanel()),
    () => switchToSession(sessionId, _tabInfoCache.get(sessionId) || null, { nav }),
  );
  if (went) focusSidepanel(PANEL_OWNER);
  renderPill();
}

async function handlePillClose(sessionId, { byUser = false } = {}) {
  if (!sessionId) {
    if (_tabSessionIds.length > 1) {
      const next = _tabSessionIds[_tabSessionIds.length - 1];
      const info = _tabInfoCache.get(next) || null;
      await switchToSession(next, info);
    } else {
      for (const sid of Array.from(_tabSessionIds)) removeTab(sid, { byUser });
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
  removeTab(sessionId, { byUser });
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

// Whiteboard "Send to Panel" → attach image to compose footer if OCP v2 is the
// active sidepanel. Mirrors the gating used by Claude/Codex/OCP v1 so the event
// is consumed by exactly one panel.
on('wb:send-to-panel', async ({ dataUrl }) => {
  if (!dataUrl) return;
  if (state.lastActivePanel !== 'opencode' || isHostedSessionFocused()) return;
  const match = dataUrl.match(/^data:(image\/[-+.\w]+);base64,/);
  if (!match) return;
  const child = getVisibleChildPanel();
  if (child) {
    child.store.addAttachedImage({ name: `whiteboard-${Date.now()}.png`, mime: match[1], dataUrl });
    child.focus();
    return;
  }
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

export async function endHostedOpenCodeSessions() {
  for (const sessionId of [..._tabSessionIds]) {
    await closeSessionBackend(sessionId, { wasRunning: true, context: 'detached window close' });
    await handlePillClose(sessionId);
  }
}

export function isOpencodePanelOpen() { return _visible || isChildPanelOpen(); }

export async function toggleOpencodePanel() {
  if (_visible || isChildPanelOpen()) {
    requestOpencodeView({ hideAll: true });
    return false;
  }
  return showPrimaryOpencodePanel();
}

export async function attachOpenCodeAutomation(run, { focus = !!run?.focus, isCancelled = () => false } = {}) {
  const sessionId = run?.providerSessionId;
  if (!run?.runId || !sessionId) return { ok: false, reason: 'identity_pending' };
  // An automation that asks for focus takes the panel only while the user
  // chose nothing else since the attach began.
  const attachBegan = _nav.latest();
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
  if (focus && _nav.latest() === attachBegan) {
    // (Its own navigation, observed after boot landed: a click made while the
    // panel opens still wins.)
    const nav = _nav.observe();
    if (!_visible) await showPrimaryOpencodePanel();
    await switchToSession(sessionId, info, { nav });
  } else if (getState().sessionId === sessionId) {
    setRunning(running);
    await rehydrateActiveSession().catch(() => {});
  }
  if (getState().sessionId === sessionId) setRunning(running);
  if (run.status === 'failed' && run.error && getState().sessionId === sessionId
    && _tabInfoCache.get(sessionId)?._automationLifecycleError !== run.error) {
    const cachedInfo = _tabInfoCache.get(sessionId) || info;
    cachedInfo._automationLifecycleError = run.error;
    _tabInfoCache.set(sessionId, _stoppedShares.clean(cachedInfo));
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
    ta.value = prefilledDraft(ta.value, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }
}

export async function attachPathToOpencode(filePath) {
  const path = String(filePath || '').trim();
  if (!path) return false;
  const child = getVisibleChildPanel();
  if (child) {
    const added = child.appendPath(path);
    child.focus();
    return added;
  }
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

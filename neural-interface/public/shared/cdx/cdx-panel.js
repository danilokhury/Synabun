// SynaBun — Codex Panel: DOM, Events & Lifecycle
// ═══════════════════════════════════════════

import { storage } from '../storage.js';
import { state, emit, on } from '../state.js';
import { reserveRightPanelLayout, clearRightPanelLayout } from '../ui-sidepanel-layout.js';
import { subscribeCliStatus, recheckCliStatus, getCliDocUrl, getCliInstallCommand, getCliLabel } from '../cli-status.js';
import { isClaudePanelOpen, toggleClaudePanel } from '../ui-claude-panel.js';
import { injectStyles } from './cdx-styles.js';
import { appendAssistantMarkdownMessage, flushCardBody, renderPostPlanActions } from './cdx-render.js';
import {
  OPENAI_ICON, ICON_SPARK, ICON_PLUS, ICON_MINIMIZE, ICON_X, ICON_STOP,
  ICON_EDIT, ICON_SHIELD, ICON_PLAN, ICON_BRAIN, SYNABUN_LOGO_ICON,
  STOR, EFFORT_LEVELS, PANEL_OWNER, STATUS_TONE,
} from './cdx-icons.js';
import {
  setCallbacks, setPanelRef, setPanelState, connectTab, disconnectTab, activeTab, isActiveTab,
  createTab, switchTab, closeTab, closeActiveTab, saveTabs, restoreTabs,
  initContextBridge,
  renderPills, renderProjects, updateActiveTabView,
  sendPrompt, dispatchPrompt, interruptTurn, queueCurrentDraft, steerActiveTurn,
  cycleEffort, togglePlanMode, toggleAutoAccept, syncToolbarState,
  requestModelList, populateModelDropdown,
  setSessionLabel, renameActiveSession, promptNameNewSession, openSettingsPanel, renderSessionMenu,
  addImageFromFile, removeImage, renderImageStrip,
  addPathChip, removePathChip, renderPathStrip,
  initVoiceInput, showSlashHints, selectSlashHint, navigateSlashHints, confirmSlashHint,
  syncQueueTray, editQueueItem, toggleQueuePause, clearQueue,
  startCompaction,
  syncInputEnabled, syncReservedWidth, scheduleThreadSnapshotSave,
  flushAllThreadSnapshots,
  resetStallTimer, stopStallTimer,
  withTab,
  ensureProjectsLoaded,
} from './cdx-tabs.js';

window.addEventListener('beforeunload', () => { try { flushAllThreadSnapshots(); } catch {} });
window.addEventListener('pagehide', () => { try { flushAllThreadSnapshots(); } catch {} });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { try { flushAllThreadSnapshots(); } catch {} }
});

// ═══════════════════════════════════════════
//  Module-level State (panel owns)
// ═══════════════════════════════════════════

let _panel = null;
let _visible = false;
let _resizeBound = false;
let _cliInstalled = null;
let _cliUnsub = null;

// ═══════════════════════════════════════════
//  Bound State (mirrors active tab — managed by cdx-tabs)
// ═══════════════════════════════════════════

let _messagesEl = null;
let _ws = null;
let _connected = false;
let _bootstrapped = false;
let _running = false;
let _activeTurnId = null;
let _freshThread = false;
let _threadId = null;
let _project = '';
let _boundTab = null;
let _tabs = [];
let _activeTabIdx = -1;
let _sessionLabel = 'New session';
let _items = new Map();
let _requestCards = new Map();
let _startingThread = false;
let _statusText = 'Connecting to Codex…';
let _statusTone = 'working';
let _statusDetail = '';
let _slashActiveIdx = -1;
let _planContent = '';
let _editedPlanContent = '';
let _showPostPlanActions = false;
let _postPlanHeader = 'PLAN COMPLETE';
let _planTurnActive = false;
let _planApprovalPending = false;
let _lastPlanTurnId = '';
let _planFilePath = '';

// ═══════════════════════════════════════════
//  Host Callbacks (provided by monolith via setHostCallbacks)
// ═══════════════════════════════════════════

let _host = {};

/**
 * Register host-side callbacks for functions that still live in the
 * monolith and are referenced by wireEvents / ensurePanel.
 *
 * Expected shape:
 *   maybeOpenProjectFileLink(href, event) -> bool
 *   flushCardBody(itemState)
 *   resetThreadState(opts)
 *   appendSystem(text, tone)
 *   sendServerRequestReply(requestId, opts)
 *   getRequestCardEntry(requestId) -> object|null
 *   restoreChangelogButtons(buttons)
 *   syncStatusTicker()
 *   loadBranches(path)
 *   setStatus(text, tone)
 *   syncSessionControls()
 *   renderStatusChrome()
 *   setCompactingUI(on)
 *   clearTranscript(emptyText)
 *   getBoundState() -> object   (returns current bound-state snapshot)
 *   setBoundVar(name, value)
 */
export function setHostCallbacks(callbacks) {
  _host = callbacks || {};
}

/**
 * Sync bound-state variables from the active tab.
 * Called by cdx-tabs whenever the active tab changes or state is committed.
 */
export function syncBoundState(s) {
  if (!s) return;
  _messagesEl = s.messagesEl ?? _messagesEl;
  _ws = s.ws ?? _ws;
  _connected = s.connected ?? _connected;
  _bootstrapped = s.bootstrapped ?? _bootstrapped;
  _running = s.running ?? _running;
  _activeTurnId = s.activeTurnId ?? _activeTurnId;
  _freshThread = s.freshThread ?? _freshThread;
  _threadId = s.threadId ?? _threadId;
  _project = s.project ?? _project;
  _boundTab = s.boundTab ?? _boundTab;
  _tabs = s.tabs ?? _tabs;
  _activeTabIdx = s.activeTabIdx ?? _activeTabIdx;
  _sessionLabel = s.sessionLabel ?? _sessionLabel;
  _items = s.items ?? _items;
  _requestCards = s.requestCards ?? _requestCards;
  _startingThread = s.startingThread ?? _startingThread;
  _statusText = s.statusText ?? _statusText;
  _statusTone = s.statusTone ?? _statusTone;
  _statusDetail = s.statusDetail ?? _statusDetail;
  _planContent = s.planContent ?? _planContent;
  _editedPlanContent = s.editedPlanContent ?? _editedPlanContent;
  _showPostPlanActions = s.showPostPlanActions ?? _showPostPlanActions;
  _postPlanHeader = s.postPlanHeader ?? _postPlanHeader;
  _planTurnActive = s.planTurnActive ?? _planTurnActive;
  _planApprovalPending = s.planApprovalPending ?? _planApprovalPending;
  _lastPlanTurnId = s.lastPlanTurnId ?? _lastPlanTurnId;
  _planFilePath = s.planFilePath ?? _planFilePath;
}

// ═══════════════════════════════════════════
//  Utility — HTML Escape
// ═══════════════════════════════════════════

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseStoredJson(key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// ═══════════════════════════════════════════
//  Dropdown Utilities
// ═══════════════════════════════════════════

function ddSetup(dd) {
  if (!dd) return;
  dd._value = dd._value || '';
  dd.addEventListener('click', (event) => {
    if (event.target.closest('.cxp-dd-item')) return;
    _panel?.querySelectorAll('.cxp-dropdown.open').forEach((node) => {
      if (node !== dd) node.classList.remove('open');
    });
    dd.classList.toggle('open');
  });
}

function ddPopulate(dd, items, selectedValue) {
  if (!dd) return;
  const menu = dd.querySelector('.cxp-dd-menu');
  const label = dd.querySelector('.cxp-dd-label');
  if (!menu || !label) return;
  menu.innerHTML = '';
  dd._value = '';
  label.textContent = dd.dataset.placeholder || 'select...';
  dd.classList.remove('has-value');
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'cxp-dd-item' + (item.value === selectedValue ? ' selected' : '');
    el.textContent = item.label;
    el.dataset.value = item.value;
    el.addEventListener('click', () => {
      dd._value = item.value;
      label.textContent = item.label;
      dd.classList.add('has-value');
      dd.classList.remove('open');
      menu.querySelectorAll('.cxp-dd-item').forEach((node) => node.classList.remove('selected'));
      el.classList.add('selected');
      dd.dispatchEvent(new Event('change'));
    });
    menu.appendChild(el);
  }
  if (selectedValue) {
    const match = items.find((item) => item.value === selectedValue);
    if (match) {
      dd._value = match.value;
      label.textContent = match.label;
      dd.classList.add('has-value');
    }
  }
}

function ddGetValue(dd) {
  return dd?._value || '';
}

// ═══════════════════════════════════════════
//  panelEl — DOM Accessor
// ═══════════════════════════════════════════

export function panelEl(selector) {
  return _panel?.querySelector(selector) || null;
}

// ═══════════════════════════════════════════
//  buildPanel — DOM Construction
// ═══════════════════════════════════════════

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'codex-panel';
  panel.className = 'codex-panel';
  panel.innerHTML = `
    <div class="cxp-resize-handle"></div>
    <div class="cxp-header">
      <button class="cxp-session-btn" id="cxp-session-btn" type="button">
        <span class="cxp-session-label" id="cxp-session-label">${esc(_sessionLabel)}</span>
        <span class="cxp-dd-arrow">&#x25BE;</span>
      </button>
      <button class="cxp-header-rename" id="cxp-header-rename" type="button" title="Rename session">
        ${ICON_EDIT}
      </button>
      <div class="cxp-actions">
        <button class="cxp-btn" id="cxp-new" title="New Codex tab">${ICON_PLUS}</button>
        <button class="cxp-btn" id="cxp-minimize" title="Minimize to pill">${ICON_MINIMIZE}</button>
        <button class="cxp-btn cxp-btn-danger" id="cxp-close" title="Close current tab">${ICON_X}</button>
        <button class="cxp-btn" id="cxp-slide" title="Slide panel"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></button>
      </div>
      <div class="cxp-session-menu" id="cxp-session-menu"></div>
    </div>
    <div class="cxp-contextbar" id="cxp-contextbar">
      <div class="cxp-gauge" id="cxp-gauge">
        <div class="cxp-ctx-fill" id="cxp-ctx-fill"></div>
        <span class="cxp-gauge-label" id="cxp-gauge-label">context pending</span>
      </div>
      <button class="cxp-compact-btn" id="cxp-compact-btn" type="button" title="Compress conversation context to free up space">compact</button>
      <button class="cxp-btn cxp-settings-btn" id="cxp-settings-btn" type="button" title="Codex settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>
    <div class="cxp-messages-container" id="cxp-messages-container"></div>
    <div class="cxp-bottom">
      <div class="cxp-queue-tray" id="cxp-queue-tray" hidden>
        <div class="cxp-queue-header">
          <span class="cxp-queue-title">Queue <span class="cxp-queue-badge" id="cxp-queue-badge">0</span></span>
          <div class="cxp-queue-actions">
            <button class="cxp-btn cxp-btn-sm cxp-queue-pause" id="cxp-queue-pause" title="Pause queue">&#x23F8;</button>
            <button class="cxp-btn cxp-btn-sm cxp-queue-clear" id="cxp-queue-clear" title="Clear queue">&#x2715;</button>
          </div>
        </div>
        <div class="cxp-queue-list" id="cxp-queue-list"></div>
      </div>
      <div class="cxp-projectbar">
        <div class="cxp-dropdown" id="cxp-project" data-placeholder="project..." data-tooltip="Project">
          <span class="cxp-dd-label">project...</span>
          <span class="cxp-dd-arrow">&#x25BE;</span>
          <div class="cxp-dd-menu"></div>
        </div>
        <div class="cxp-dropdown cxp-dropdown-sm" id="cxp-branch" data-placeholder="branch" data-tooltip="Branch">
          <span class="cxp-dd-label">branch</span>
          <span class="cxp-dd-arrow">&#x25BE;</span>
          <div class="cxp-dd-menu"></div>
        </div>
        <div class="cxp-dropdown cxp-dropdown-sm" id="cxp-profile" data-placeholder="profile" data-tooltip="Tool profile">
          <span class="cxp-dd-label">full</span>
          <span class="cxp-dd-arrow">&#x25BE;</span>
          <div class="cxp-dd-menu"></div>
        </div>
        <div class="cxp-dropdown cxp-dropdown-sm" id="cxp-recall" data-placeholder="recall" data-tooltip="Recall profile">
          <span class="cxp-dd-label">recall</span>
          <span class="cxp-dd-arrow">&#x25BE;</span>
          <div class="cxp-dd-menu"></div>
        </div>
        <div class="cxp-projectbar-actions">
          <button class="cxp-bar-action" id="cxp-action-changelog" title="Generate changelog"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h8.5v13H4a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 014 1.5z"/><path d="M5.5 5h5M5.5 7.5h3M5.5 10h4"/></svg></button>
        </div>
      </div>
      <div class="cxp-image-strip" id="cxp-image-strip" hidden></div>
      <div class="cxp-path-strip" id="cxp-path-strip" hidden></div>
      <div class="cxp-input-wrap">
        <div class="cxp-input-shell">
          <input type="file" id="cxp-file-input" accept="image/*" multiple hidden />
          <textarea class="cxp-input" id="cxp-input" rows="1" placeholder="Message Codex…" spellcheck="false"></textarea>
          <button class="cxp-mic-btn" id="cxp-mic-btn" title="Hold to talk" hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4M8 21h8"/></svg>
          </button>
          <button class="cxp-send" id="cxp-send" disabled title="Send">
            <svg class="cxp-send-icon" viewBox="0 0 24 24"><path d="M12 5v14"/><path d="m5 12 7-7 7 7"/></svg>
            <svg class="cxp-stop-icon" viewBox="0 0 24 24" style="display:none"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>
          </button>
        </div>
      </div>
      <div class="cxp-slash-hints" id="cxp-slash-hints" hidden></div>
      <div class="cxp-footer-toolbar">
        <div class="cxp-footer-left">
          <a class="cxp-brand-link" href="https://chatgpt.com/codex/settings/usage" target="_blank" rel="noopener noreferrer" title="Open Codex usage settings">
            <svg class="cxp-brand" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>
          </a>
          <button class="cxp-attach-btn" id="cxp-attach-btn" title="Attach images">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
        </div>
        <div class="cxp-footer-right">
          <button class="cxp-toolbar-toggle" id="cxp-effort-toggle" title="Effort level: off" data-effort="off">${ICON_BRAIN}<span class="cxp-btn-label">Effort</span><span class="cxp-effort-dots"><i></i><i></i><i></i><i></i><i></i></span></button>
          <button class="cxp-toolbar-toggle" id="cxp-plan-toggle" title="Plan mode: off">${ICON_PLAN}<span class="cxp-btn-label">Plan</span></button>
          <button class="cxp-toolbar-toggle" id="cxp-autoaccept-toggle" title="Auto-accept: off">${ICON_SHIELD}<span class="cxp-btn-label">Auto</span></button>
          <div class="cxp-dropdown" id="cxp-model" data-placeholder="model...">
            <span class="cxp-dd-label">model...</span>
            <span class="cxp-dd-arrow">&#x25BE;</span>
            <div class="cxp-dd-menu"></div>
          </div>
          <span class="cxp-cost" id="cxp-cost" title="Estimated cost based on token usage"></span>
        </div>
      </div>
    </div>
  `;
  return panel;
}

// ═══════════════════════════════════════════
//  DOM Helpers
// ═══════════════════════════════════════════

function scrollEnd() {
  const el = activeTab()?.messagesEl;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function autosizeInput() {
  const input = panelEl('#cxp-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  if (input.scrollHeight > input.clientHeight + 2) {
    input.classList.add('scrollable');
  } else {
    input.classList.remove('scrollable');
  }
}

function hideEmpty() {
  const empty = activeTab()?.messagesEl?.querySelector('.cxp-empty');
  if (empty) empty.style.display = 'none';
}

function showEmpty(text) {
  const empty = activeTab()?.messagesEl?.querySelector('.cxp-empty');
  if (!empty) return;
  const statusEl = empty.querySelector('.cxp-empty-status');
  if (statusEl) statusEl.textContent = text;
  empty.style.display = '';
}

function freshThreadText() {
  return '';
}

function startupEmptyText() {
  if (activeTab()?.threadId) return 'Restoring Codex thread…';
  return '';
}

// ── CLI installation status (banner + send-block) ──
let _cliInstallFailureForced = false;

function ensureCliBannerEl() {
  if (!_panel) return null;
  const container = panelEl('#cxp-messages-container');
  if (!container || !container.parentNode) return null;
  let banner = container.parentNode.querySelector(':scope > .cxp-cli-banner');
  if (banner) return banner;
  const label = getCliLabel('codex');
  const cmd = getCliInstallCommand('codex');
  const url = getCliDocUrl('codex');
  banner = document.createElement('div');
  banner.className = 'cxp-cli-banner';
  banner.innerHTML = `
    <div class="cxp-cli-banner-icon">!</div>
    <div class="cxp-cli-banner-text">
      <div class="cxp-cli-banner-title">${label} CLI not installed</div>
      <div class="cxp-cli-banner-body">Run <code>${cmd}</code> or follow the install guide.</div>
    </div>
    <div class="cxp-cli-banner-actions">
      <a class="cxp-cli-banner-link" href="${url}" target="_blank" rel="noopener noreferrer">Install guide</a>
      <button class="cxp-cli-banner-recheck" type="button">Re-check</button>
    </div>
  `;
  container.parentNode.insertBefore(banner, container);
  const btn = banner.querySelector('.cxp-cli-banner-recheck');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try { await recheckCliStatus('codex'); }
    finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = 'Re-check';
      }
    }
  });
  return banner;
}

function removeCliBannerEl() {
  if (!_panel) return;
  const container = panelEl('#cxp-messages-container');
  const banner = container?.parentNode?.querySelector(':scope > .cxp-cli-banner');
  banner?.remove();
}

function refreshCliBanner() {
  if (!_panel) return;
  const missing = _cliInstalled === null || _cliInstallFailureForced;
  _panel.classList.toggle('cxp-cli-blocked', missing);
  if (missing) ensureCliBannerEl();
  else removeCliBannerEl();
  try { syncInputEnabled(); } catch {}
}

export function isCdxCliInstalled() {
  return _cliInstalled !== null && !_cliInstallFailureForced;
}

export function flagCdxCliInstallFailure() {
  _cliInstallFailureForced = true;
  refreshCliBanner();
  recheckCliStatus('codex').catch(() => {});
}

function ensureCliSubscription() {
  if (_cliUnsub) return;
  _cliUnsub = subscribeCliStatus('codex', (info) => {
    _cliInstalled = info?.installed || null;
    if (_cliInstalled) _cliInstallFailureForced = false;
    refreshCliBanner();
  });
}

// ═══════════════════════════════════════════
//  setVisible — Show / Hide Panel
// ═══════════════════════════════════════════

function _cdxDocEscHandler(event) {
  if (event.key !== 'Escape') return;
  if (!_visible) return;
  if (!activeTab()?.running) return;
  const hintsEl = panelEl('#cxp-slash-hints');
  if (hintsEl && !hintsEl.hidden) return; // let input-level handler dismiss hints first
  event.preventDefault();
  event.stopImmediatePropagation();
  interruptTurn();
}

function setVisible(nextVisible) {
  if (!_panel) return;
  if (!nextVisible) {
    const tab = activeTab();
    const input = panelEl('#cxp-input');
    if (tab && input) tab.draft = input.value;
  }
  _visible = !!nextVisible;
  _panel.classList.toggle('open', _visible);
  syncReservedWidth();
  _host.syncStatusTicker?.();
  renderPills();
  emit('codex-panel:visibility', _visible);
  if (_visible) {
    document.addEventListener('keydown', _cdxDocEscHandler, { capture: true });
    if (!_tabs.length) createTab({ project: storage.getItem(STOR.project) || '' });
    state.lastActivePanel = 'codex';
    updateActiveTabView();
    loadCurrentProfile();
    loadRecallProfile();
    panelEl('#cxp-input')?.focus();
    refreshCliBanner();
  } else {
    document.removeEventListener('keydown', _cdxDocEscHandler, { capture: true });
  }
  window.dispatchEvent(new Event('resize'));
}

// ═══════════════════════════════════════════
//  loadBranches — Fetch git branches for project
// ═══════════════════════════════════════════

async function loadBranches(path) {
  const $branch = panelEl('#cxp-branch');
  if (!$branch) return;
  if (!path) { ddPopulate($branch, [], ''); return; }
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(path)}`).then(r => r.json());
    if (res.branches?.length) {
      const items = res.branches.map(b => ({ value: b, label: b }));
      ddPopulate($branch, items, res.current || '');
    }
  } catch {}
}

// ═══════════════════════════════════════════
//  MCP Profile — live profile switching
// ═══════════════════════════════════════════

let _mcpProfiles = [];
let _currentProfile = 'full';

async function loadCurrentProfile() {
  const $profile = panelEl('#cxp-profile');
  if (!$profile) return;
  try {
    const resp = await fetch('/api/mcp/profile');
    const data = await resp.json();
    if (data.ok && data.profile) _currentProfile = data.profile;
    if (data.presets) {
      _mcpProfiles = Object.entries(data.presets).map(([value, p]) => ({
        value, label: p.label || value, hint: `${p.tools} tools`,
      }));
    }
  } catch {}
  populateProfileDropdown($profile);
}

function populateProfileDropdown($dd) {
  const menu = $dd.querySelector('.cxp-dd-menu');
  const label = $dd.querySelector('.cxp-dd-label');
  if (!menu || !label) return;
  menu.innerHTML = '';
  const matched = _mcpProfiles.find(p => p.value === _currentProfile);
  label.textContent = matched ? matched.label : _currentProfile;
  $dd.classList.add('has-value');
  $dd._value = _currentProfile;
  for (const p of _mcpProfiles) {
    const el = document.createElement('div');
    el.className = 'cxp-dd-item' + (p.value === _currentProfile ? ' selected' : '');
    el.dataset.value = p.value;
    el.innerHTML = `<span>${p.label}</span><span style="opacity:0.35;margin-left:auto;font-size:9px">${p.hint}</span>`;
    el.style.display = 'flex'; el.style.gap = '6px';
    el.addEventListener('click', () => {
      if (p.value === _currentProfile) { $dd.classList.remove('open'); return; }
      _currentProfile = p.value;
      $dd._value = p.value;
      label.textContent = p.label;
      $dd.classList.remove('open');
      menu.querySelectorAll('.cxp-dd-item').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      updateMcpProfile(p.value);
    });
    menu.appendChild(el);
  }
}

async function updateMcpProfile(profile) {
  try {
    await fetch('/api/mcp/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
  } catch {}
}

// ═══════════════════════════════════════════
//  Recall Profile — live recall preset switching
// ═══════════════════════════════════════════

const RECALL_PROFILES_META = [
  { value: 'quick',    label: 'Quick',    hint: '3 results' },
  { value: 'balanced', label: 'Balanced', hint: '5 results' },
  { value: 'deep',     label: 'Deep',     hint: '10 results' },
  { value: 'custom',   label: 'Custom',   hint: 'custom' },
];
const RECALL_PROFILE_DEFAULTS = {
  quick:    { limit: 3,  minImportance: 5, minScore: 0.45, maxChars: 300,  includeSessions: 'never',  recencyBoost: false },
  balanced: { limit: 5,  minImportance: 0, minScore: 0.30, maxChars: 0,    includeSessions: 'auto',   recencyBoost: false },
  deep:    { limit: 10, minImportance: 0, minScore: 0.20, maxChars: 0,    includeSessions: 'always', recencyBoost: false },
};

let _recallProfile = 'balanced';

async function loadRecallProfile() {
  const $recall = panelEl('#cxp-recall');
  if (!$recall) return;
  try {
    const data = await fetch('/api/display-settings').then(r => r.json());
    if (data.profile) _recallProfile = data.profile;
  } catch {}
  populateRecallDropdown($recall);
}

function populateRecallDropdown($dd) {
  const menu = $dd.querySelector('.cxp-dd-menu');
  const label = $dd.querySelector('.cxp-dd-label');
  if (!menu || !label) return;
  menu.innerHTML = '';
  const matched = RECALL_PROFILES_META.find(p => p.value === _recallProfile);
  label.textContent = matched ? matched.label : _recallProfile;
  $dd.classList.add('has-value');
  $dd._value = _recallProfile;
  for (const p of RECALL_PROFILES_META) {
    const el = document.createElement('div');
    el.className = 'cxp-dd-item' + (p.value === _recallProfile ? ' selected' : '');
    el.dataset.value = p.value;
    el.innerHTML = `<span>${p.label}</span><span style="opacity:0.35;margin-left:auto;font-size:9px">${p.hint}</span>`;
    el.style.display = 'flex'; el.style.gap = '6px';
    el.addEventListener('click', () => {
      if (p.value === _recallProfile) { $dd.classList.remove('open'); return; }
      _recallProfile = p.value;
      $dd._value = p.value;
      label.textContent = p.label;
      $dd.classList.remove('open');
      menu.querySelectorAll('.cxp-dd-item').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      saveRecallProfile(p.value);
    });
    menu.appendChild(el);
  }
}

async function saveRecallProfile(profile) {
  try {
    const current = await fetch('/api/display-settings').then(r => r.json());
    const defaults = RECALL_PROFILE_DEFAULTS[profile] || current.recallDefaults || RECALL_PROFILE_DEFAULTS.balanced;
    await fetch('/api/display-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...current, profile, recallDefaults: profile !== 'custom' ? defaults : current.recallDefaults }),
    });
  } catch (e) {
    console.error('Failed to save recall profile:', e);
  }
}

// ═══════════════════════════════════════════
//  wireEvents — Attach All Event Handlers
// ═══════════════════════════════════════════

function wireEvents() {
  // Card collapse/expand delegation — covers new cards and snapshot-restored HTML
  const msgContainer = panelEl('#cxp-messages-container');
  if (msgContainer) {
    msgContainer.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (link && msgContainer.contains(link) && _host.maybeOpenProjectFileLink?.(link.getAttribute('href'), e)) return;
      const head = e.target.closest('.cxp-card-head');
      if (!head) return;
      const card = head.parentElement;
      if (!card?.classList.contains('cxp-card')) return;
      if (e.target.closest('button, input, select, textarea, a')) return;
      const wasCollapsed = card.classList.contains('cxp-collapsed');
      card.classList.toggle('cxp-collapsed');
      card.dataset.expanded = wasCollapsed ? '1' : '0';
      // Lazy flush: render body content on first expand
      if (wasCollapsed) {
        const itemId = card.dataset.itemId;
        const itemState = itemId ? activeTab()?.items?.get(itemId) : null;
        if (itemState) flushCardBody(itemState);
      }
      scheduleThreadSnapshotSave(activeTab());
      saveTabs();
    });
  }

  const input = panelEl('#cxp-input');
  const send = panelEl('#cxp-send');
  const minimizeBtn = panelEl('#cxp-minimize');
  const newBtn = panelEl('#cxp-new');
  const closeBtn = panelEl('#cxp-close');
  const compactBtn = panelEl('#cxp-compact-btn');
  const projectDd = panelEl('#cxp-project');
  const sessionBtn = panelEl('#cxp-session-btn');
  const sessionLabelEl = panelEl('#cxp-session-label');
  const sessionMenu = panelEl('#cxp-session-menu');
  const renameBtn = panelEl('#cxp-header-rename');
  const resizeHandle = _panel?.querySelector('.cxp-resize-handle');

  input?.addEventListener('input', () => {
    const tab = activeTab();
    if (tab) tab.draft = input.value;
    autosizeInput();
    syncInputEnabled();
    showSlashHints(input.value.trim());
  });
  input?.addEventListener('keydown', (event) => {
    // Slash hint navigation
    if (event.key === 'ArrowDown' && navigateSlashHints(1)) { event.preventDefault(); return; }
    if (event.key === 'ArrowUp' && navigateSlashHints(-1)) { event.preventDefault(); return; }
    if (event.key === 'Enter' && !event.shiftKey && confirmSlashHint()) { event.preventDefault(); return; }
    if (event.key === 'Escape') {
      const hintsEl = panelEl('#cxp-slash-hints');
      if (hintsEl && !hintsEl.hidden) { hintsEl.hidden = true; _slashActiveIdx = -1; event.preventDefault(); return; }
      if (activeTab()?.running) { event.preventDefault(); interruptTurn(); return; }
    }
    if (event.key === 'Tab' && activeTab()?.running) {
      const tab = activeTab();
      const hasDraft = !!input.value.trim() || !!tab?.attachedImages?.length || !!tab?.pendingPaths?.length;
      if (hasDraft) {
        event.preventDefault();
        queueCurrentDraft();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (activeTab()?.running && !input.value.trim().startsWith('/')) {
        steerActiveTurn();
        return;
      }
      sendPrompt();
    }
  });
  // Image paste
  input?.addEventListener('paste', (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) addImageFromFile(file);
      }
    }
  });
  // File input change
  const fileInput = panelEl('#cxp-file-input');
  const attachBtn = panelEl('#cxp-attach-btn');
  attachBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    if (!fileInput.files) return;
    for (const file of fileInput.files) {
      if (file.type.startsWith('image/')) addImageFromFile(file);
    }
    fileInput.value = '';
  });
  send?.addEventListener('click', () => {
    if (activeTab()?.running) {
      interruptTurn();
      return;
    }
    sendPrompt();
  });
  minimizeBtn?.addEventListener('click', () => setVisible(false));
  newBtn?.addEventListener('click', () => {
    const tab = createTab({ project: activeTab()?.project || storage.getItem(STOR.project) || '' });
    if (!tab) return;
    promptNameNewSession();
  });
  closeBtn?.addEventListener('click', () => closeActiveTab());
  compactBtn?.addEventListener('click', () => startCompaction());
  const settingsBtn = panelEl('#cxp-settings-btn');
  settingsBtn?.addEventListener('click', () => openSettingsPanel());
  const slideBtn = panelEl('#cxp-slide');
  slideBtn?.addEventListener('click', () => setVisible(false));
  const changelogBtn = panelEl('#cxp-action-changelog');
  changelogBtn?.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab || tab.running || !tab.connected || !tab.bootstrapped) return;
    const inp = panelEl('#cxp-input');
    if (!inp) return;
    inp.value = '/synabun changelog';
    autosizeInput();
    sendPrompt();
  });
  ddSetup(projectDd);
  const modelDd = panelEl('#cxp-model');
  ddSetup(modelDd);
  const effortToggle = panelEl('#cxp-effort-toggle');
  const planToggle = panelEl('#cxp-plan-toggle');
  const autoAcceptToggle = panelEl('#cxp-autoaccept-toggle');
  effortToggle?.addEventListener('click', () => cycleEffort());
  planToggle?.addEventListener('click', () => togglePlanMode());
  autoAcceptToggle?.addEventListener('click', () => toggleAutoAccept());
  const queuePauseBtn = panelEl('#cxp-queue-pause');
  const queueClearBtn = panelEl('#cxp-queue-clear');
  queuePauseBtn?.addEventListener('click', () => toggleQueuePause());
  queueClearBtn?.addEventListener('click', () => clearQueue());
  const branchDd = panelEl('#cxp-branch');
  ddSetup(branchDd);
  const profileDd = panelEl('#cxp-profile');
  ddSetup(profileDd);
  const recallDd = panelEl('#cxp-recall');
  ddSetup(recallDd);
  loadRecallProfile();
  projectDd?.addEventListener('change', () => {
    const tab = activeTab();
    const project = ddGetValue(projectDd);
    if (tab) tab.project = project;
    if (project) storage.setItem(STOR.project, project);
    else storage.removeItem(STOR.project);
    loadBranches(project);
    sessionMenu?.classList.remove('open');
    _host.resetThreadState?.({ preserveStatus: !tab?.connected, tone: tab?.connected ? 'ready' : 'working' });
    saveTabs();
  });
  sessionBtn?.addEventListener('click', (event) => {
    if (sessionLabelEl?.querySelector('.cxp-rename-input')) return;
    if (event.target === sessionLabelEl || event.target.closest('#cxp-session-label')) return;
    const isOpen = sessionMenu?.classList.toggle('open');
    if (isOpen) renderSessionMenu();
  });
  sessionLabelEl?.addEventListener('click', (event) => {
    event.stopPropagation();
    sessionMenu?.classList.remove('open');
    renameActiveSession();
  });
  sessionLabelEl?.addEventListener('mousedown', (event) => {
    if (sessionLabelEl.querySelector('.cxp-rename-input')) event.stopPropagation();
  });
  renameBtn?.addEventListener('mousedown', (event) => {
    if (sessionLabelEl?.querySelector('.cxp-rename-input')) event.preventDefault();
  });
  renameBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    sessionMenu?.classList.remove('open');
    renameActiveSession();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.cxp-header')) sessionMenu?.classList.remove('open');
    if (!event.target.closest('.cxp-dropdown')) {
      _panel?.querySelectorAll('.cxp-dropdown.open').forEach((node) => node.classList.remove('open'));
    }
  });

  if (resizeHandle) {
    let dragging = false;
    resizeHandle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      dragging = true;
      _panel.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (event) => {
      if (!dragging || !_panel) return;
      const width = Math.min(700, Math.max(320, window.innerWidth - event.clientX - 20));
      _panel.style.width = `${width}px`;
      syncReservedWidth();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging || !_panel) return;
      dragging = false;
      _panel.style.transition = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.dispatchEvent(new Event('resize'));
    });
  }

  if (!_resizeBound) {
    window.addEventListener('resize', () => syncReservedWidth());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        // Page hidden — pause stall timer to prevent false interrupts from browser throttling
        stopStallTimer();
        return;
      }
      // Page visible — reconnect if needed and resume stall detection
      const tab = activeTab();
      if (!tab || tab.closed) return;
      if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) {
        connectTab(tab);
      }
      if (tab.running) resetStallTimer();
    });
    _resizeBound = true;
  }

  // Drag-drop image support
  _panel?.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!_panel.querySelector('.cxp-drop-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'cxp-drop-overlay';
      overlay.textContent = 'Drop images here';
      _panel.appendChild(overlay);
    }
  });
  _panel?.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && _panel.contains(event.relatedTarget)) return;
    _panel.querySelector('.cxp-drop-overlay')?.remove();
  });
  _panel?.addEventListener('drop', (event) => {
    event.preventDefault();
    _panel.querySelector('.cxp-drop-overlay')?.remove();
    if (!event.dataTransfer?.files) return;
    for (const file of event.dataTransfer.files) {
      if (file.type.startsWith('image/')) addImageFromFile(file);
    }
  });

  // Initialize voice input
  initVoiceInput();

  on('claude-panel:show', () => {
    if (_visible) setVisible(false);
  });

  on('codex-panel:show', (data) => {
    if (!_visible) {
      if (isClaudePanelOpen()) toggleClaudePanel();
      setVisible(true);
    }
    if (data?.tabId) {
      const idx = _tabs.findIndex((entry) => entry.id === data.tabId);
      if (idx >= 0) switchTab(idx);
    }
  });

  on('plan-saved', ({ filePath, content, source, tabId } = {}) => {
    if (source && source !== 'codex') return;
    const tab = _tabs.find((entry) => entry.id === tabId) || activeTab();
    if (!tab) return;
    tab.planContent = content || tab.planContent || '';
    tab.editedPlanContent = content || tab.editedPlanContent || '';
    tab.showPostPlanActions = true;
    tab.postPlanHeader = 'PLAN UPDATED';
    tab.planApprovalPending = true;
    tab.planTurnActive = false;
    tab.lastPlanTurnId = '';
    if (filePath) tab.planFilePath = filePath;
    if (isActiveTab(tab)) {
      _planContent = tab.planContent;
      _editedPlanContent = tab.editedPlanContent;
      _showPostPlanActions = true;
      _postPlanHeader = 'PLAN UPDATED';
      _planApprovalPending = true;
      _planTurnActive = false;
      _lastPlanTurnId = '';
      if (filePath) _planFilePath = filePath;
    }
    appendAssistantMarkdownMessage(tab, content || '');
    renderPostPlanActions(tab, 'PLAN UPDATED');
    saveTabs();
  });

  on('changelog-saved', ({ content }) => {
    const tab = activeTab();
    if (!tab) return;
    const request = tab._changelogRequest || null;
    tab._changelogRequest = null;
    if (request?.buttons?.length) _host.restoreChangelogButtons?.(request.buttons);

    const editedText = `Edit first — here are the edited entries:\n\n${content || ''}`.trim();
    if (request?.requestId != null && request?.answerKey) {
      _host.sendServerRequestReply?.(request.requestId, {
        result: {
          answers: {
            [request.answerKey]: { answers: [editedText] },
          },
        },
        label: 'submitted',
      });
      return;
    }

    const sent = dispatchPrompt(editedText, { tab });
    if (!sent) _host.appendSystem?.('Failed to send edited changelog entries back to Codex.', 'error');
  });

  on('plan-edit-cancelled', ({ source, tabId } = {}) => {
    if (source && source !== 'codex') return;
    const tab = _tabs.find((entry) => entry.id === tabId) || activeTab();
    if (!tab) return;
    tab.showPostPlanActions = true;
    tab.planApprovalPending = true;
    tab.planTurnActive = false;
    tab.postPlanHeader = tab.postPlanHeader || 'PLAN COMPLETE';
    if (isActiveTab(tab)) {
      _showPostPlanActions = true;
      _planApprovalPending = true;
      _planTurnActive = false;
      _postPlanHeader = tab.postPlanHeader;
    }
    renderPostPlanActions(tab, tab.postPlanHeader);
    saveTabs();
  });

  on('changelog-edit-cancelled', () => {
    const tab = activeTab();
    if (!tab) return;
    const request = tab._changelogRequest || null;
    tab._changelogRequest = null;
    if (request?.buttons?.length) _host.restoreChangelogButtons?.(request.buttons);
    if (request?.requestId != null) {
      const entry = _host.getRequestCardEntry?.(request.requestId);
      if (entry?.pillEl) entry.pillEl.textContent = 'waiting';
    }
  });
}

// ═══════════════════════════════════════════
//  ensurePanel — One-time Panel Bootstrap
// ═══════════════════════════════════════════

function ensurePanel() {
  if (_panel) return;
  injectStyles();
  _panel = buildPanel();
  document.body.appendChild(_panel);

  // Wire cdx-tabs with DOM callbacks
  setPanelRef(() => _panel);
  setPanelState({
    getVisible: () => _visible,
    setVisible,
    toggleCodexPanel,
  });
  setCallbacks({
    scrollEnd,
    autosizeInput,
    emit,
    on,
    loadBranches,
  });

  initContextBridge();
  wireEvents();
  autosizeInput();
  restoreTabs();
  syncInputEnabled();
  ensureCliSubscription();
  window.dispatchEvent(new CustomEvent('sidepanel-tray:provider-loaded', { detail: { provider: 'codex' } }));
  // Close Codex when a Claude/OpenCode pill is clicked (mutual exclusion)
  const tray = document.getElementById('term-minimized-tray');
  if (tray) {
    tray.addEventListener('click', (e) => {
      if (!_visible) return;
      const pill = e.target.closest('.cp-session-pill') || e.target.closest('.ocp-session-pill');
      if (pill && !e.target.closest('.term-minimized-pill-close')) {
        setVisible(false);
      }
    }, true);
  }
}

// ═══════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════

export function isCodexPanelOpen() {
  return _visible;
}

export async function toggleCodexPanel() {
  ensurePanel();
  await ensureProjectsLoaded();
  if (_visible) {
    setVisible(false);
    return;
  }
  if (isClaudePanelOpen()) toggleClaudePanel();
  setVisible(true);
}

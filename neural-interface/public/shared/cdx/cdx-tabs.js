// ═══════════════════════════════════════════
// SynaBun — Codex Panel: State, Tabs & Sessions
// ═══════════════════════════════════════════

import { storage } from '../storage.js';
import { fetchBlobNamespace, putBlob, deleteBlob, flushBlobs } from '../blob-store.js';
import { state as appState, on as appOn } from '../state.js';
import { fetchProjects, searchSessions } from '../api.js';
import {
  getCodexModelName,
  mergeCodexModelOptions,
} from '../agent-runtime-options.js';
import { isClaudePanelOpen, toggleClaudePanel } from '../ui-claude-panel.js';
import { isOpencodePanelOpen, toggleOpencodePanel } from '../ui-opencode-panel-v2.js';
import { nativeLoopWindowId } from '../ui-native-window-id.js';
import { reserveRightPanelLayout, clearRightPanelLayout } from '../ui-sidepanel-layout.js';
import { notify, NOTIF_TYPE } from '../ui-notifications.js';
import { createStickyScrollController } from '../ui-scroll-follow.js';
import { requestGeneratedSessionTitle } from '../session-title.js';
import {
  STOR, EFFORT_LEVELS, MAX_THREAD_SNAPSHOTS, MAX_THREAD_SNAPSHOT_CHARS,
  CODEX_GREETING_MARKER_START, CODEX_GREETING_MARKER_END, CODEX_PLAN_MODE_PREFIXES,
  STATUS_TONE, PANEL_OWNER, windowId, STALL_WARN_MS, STALL_KILL_MS,
  forkCodexWindowPersistence,
  OPENAI_ICON, ICON_SPARK, ICON_TERMINAL, ICON_TOOL, ICON_FILES, ICON_PLUS,
  ICON_MINIMIZE, ICON_X, ICON_STOP, ICON_EDIT, ICON_SHIELD, ICON_PLAN, ICON_BRAIN,
  SYNABUN_LOGO_ICON,
} from './cdx-icons.js';
import {
  connectTab as wsConnectTab, disconnectTab as wsDisconnectTab,
  sendSocket as wsSendSocket, scheduleReconnect, clearReconnectTimer,
  startHeartbeat, stopHeartbeat,
} from './cdx-ws.js';
import {
  setRenderContext, esc, md, renderAssistantMarkdown, pretty, basenamePath,
  appendElement, appendSystem, upsertMcpStartupNotice, updateMcpStartupNotice,
  createMessageShell, appendAssistantMarkdownMessage,
  sanitizeCodexUserFacingText, sanitizeStoredTranscriptDom, removePostPlanCards,
  removePostCompactionCards, renderPostPlanActions, renderPostCompactionActions,
  updatePostPlanTranscriptMeta, postProcessRenderedHtml,
  createCard, ensureUserState, ensureAssistantState, ensureReasoningState, ensurePlanState,
  ensureCommandState, ensureToolState, ensureDynamicToolState, ensureFileChangeState,
  ensureCollabAgentState, ensureGenericState, updateItemFromData,
  setCommandInteraction, setGuardianReviewState,
  appendAgentDelta, appendPlanDelta, appendReasoningDelta, appendReasoningSummaryPart,
  appendOutputDelta, appendToolProgress, trackActiveItemStart, trackActiveItemCompletion,
  renderHistory, countRenderableTranscriptNodes, flattenThreadHistoryItems,
  flushCardBody, extractUserText, openChangelogEditorFlow, summarizeCommandExecution,
  normalizeChoiceLabel, isSynaBunChoicePrompt, isChangelogChoiceSet, restoreChangelogButtons,
  renderUserMessageContent,
} from './cdx-render.js';
import {
  setRequestsContext, handleServerRequest, resolveRequestCard, sendServerRequestReply,
  getRequestCardEntry, rememberRequestCard, createRequestButton,
  handleServerRequestResponseResult,
} from './cdx-requests.js';
import {
  CODEX_THREAD_SNAPSHOT_VERSION,
  codexThreadSnapshotHasOwnershipManifest,
  codexTranscriptNodesHaveOwnership,
  detachTerminalCodexAutomation,
  formatCodexConfigWarning,
  isCodexMcpAuthenticationRequired,
  normalizeReasoningEfforts,
  normalizeCodexContextMode,
  registerOwnedThreadFromItem,
  selectedCodexContextModel,
  selectedModelOption,
  shouldCompleteCodexPlan,
  verifyCodexExtendedContext,
} from './cdx-protocol.js';

const SNAPSHOT_IDLE_DELAY_MS = 350;
const SNAPSHOT_RUNNING_DELAY_MS = 1800;
const SNAPSHOT_RUNNING_MIN_INTERVAL_MS = 5000;
const SNAPSHOT_IDLE_TIMEOUT_MS = 2500;
const CODEX_MAX_TRANSCRIPT_CHILDREN = 700;
const CODEX_PRUNE_BATCH = 150;
const CODEX_PERF_DEBUG_KEY = 'synabun-codex-perf-debug';
const AUTOMATION_HISTORY_TIMEOUT_MS = 20_000;

function codexPerfDebugEnabled() {
  try { return storage.getItem(CODEX_PERF_DEBUG_KEY) === '1'; } catch { return false; }
}

function codexPerfLog(label, detail = {}) {
  if (!codexPerfDebugEnabled()) return;
  console.debug(`[codex-perf] ${label}`, detail);
}

function itemOwnershipBelongsToBoundThread(item) {
  const ownership = item?._synabunOwnership;
  const tab = _boundTab;
  let reason = '';
  if (!ownership || !tab) reason = 'missing_item_ownership';
  else if (String(ownership.accountId || 'default') !== String(tab.accountId || 'default')) reason = 'item_account_mismatch';
  else if (!ownership.threadId || String(ownership.threadId) !== String(tab.threadId || '')) reason = 'item_thread_mismatch';
  else if (ownership.source === 'live' && (
    String(ownership.sessionId || '') !== String(tab.id || '')
    || String(ownership.connectionEpoch || '') !== String(tab.connectionEpoch || '')
  )) reason = 'item_connection_mismatch';
  if (!reason) return true;
  if (tab) {
    tab.isolationRejections = tab.isolationRejections || {};
    tab.isolationRejections[reason] = (tab.isolationRejections[reason] || 0) + 1;
  }
  return false;
}

function requestIdleWork(callback, timeout = SNAPSHOT_IDLE_TIMEOUT_MS) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    return { type: 'idle', id: window.requestIdleCallback(callback, { timeout }) };
  }
  return { type: 'timeout', id: setTimeout(callback, Math.min(timeout, 1000)) };
}

function cancelIdleWork(handle) {
  if (!handle) return;
  if (handle.type === 'idle' && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle.id);
  } else {
    clearTimeout(handle.id);
  }
}

// ── Panel ref + callbacks from cdx-panel ──
let _getPanelEl = () => null;
let _getVisible = () => false;
let _setVisible = () => {};
let _toggleCodexPanel = () => {};
let _onScrollEnd = null;
let _onAutosizeInput = null;
let _onEmit = null;
let _onOn = null;
let _onActiveTabChanged = null;

export function setPanelRef(fn) { _getPanelEl = fn; }
export function setPanelState({ getVisible, setVisible, toggleCodexPanel }) {
  _getVisible = getVisible;
  _setVisible = setVisible;
  _toggleCodexPanel = toggleCodexPanel;
}
let _loadBranches = () => {};
export function setCallbacks({ scrollEnd, autosizeInput, emit, on, loadBranches, activeTabChanged }) {
  _onScrollEnd = scrollEnd;
  _onAutosizeInput = autosizeInput;
  _onEmit = emit;
  _onOn = on;
  if (loadBranches) _loadBranches = loadBranches;
  _onActiveTabChanged = activeTabChanged || null;
}

// Branches only change when the project changes — skip the network refetch on
// every panel show / tab-view refresh. `force` re-loads after an explicit
// project switch.
let _lastBranchProject = null;
function loadBranchesIfNeeded(project, force = false) {
  if (!force && project === _lastBranchProject) return;
  _lastBranchProject = project;
  _loadBranches(project);
}

function panelEl(sel) { return _getPanelEl()?.querySelector(sel); }
function scrollEnd(force) { _onScrollEnd?.(force); }
function autosizeInput() { _onAutosizeInput?.(); }
function emit(...args) { _onEmit?.(...args); }

function sendSocket(msg) {
  const packet = msg && _boundTab?.id
    ? {
        ...msg,
        sessionId: _boundTab.id,
        connectionEpoch: _boundTab.connectionEpoch || '',
      }
    : msg;
  return wsSendSocket(packet, _ws);
}

function codexRuntimeSelection(tab = _boundTab || activeTab()) {
  return {
    model: tab?.model || null,
    contextMode: normalizeCodexContextMode(tab?.contextMode),
  };
}

// ── connectTab / disconnectTab wrappers (build callbacks for cdx-ws) ──

export function connectTab(tab, options = {}) {
  if (tab?.automationActive && !options.allowAutomation) return;
  wsConnectTab(tab, buildWsCallbacks(tab, options), { withTab });
}

function tabHasActiveWriterWork(tab) {
  return !!(
    tab?.running
    || tab?.startingThread
    || tab?.compacting
    || tab?.pendingQueryRequestId
    || tab?.expectedThreadId
    || tab?.expectedThreadRequestId
    || tab?.sessionListRequest
    || tab?.threadStartRequest
    || tab?.renameRequests?.size
    || tab?.blockingServerRequests?.size
  );
}

function releaseInactiveIdleTab(tab) {
  if (!tab || tab.closed || activeTab() === tab || tabHasActiveWriterWork(tab)) return false;
  disconnectTab(tab);
  return true;
}

export function disconnectTab(tab, { forceRelease = false } = {}) {
  wsDisconnectTab(tab, {
    releaseWriter: forceRelease || !tabHasActiveWriterWork(tab),
  });
  if (_boundTab === tab) {
    _connected = !!tab.connected;
    _bootstrapped = !!tab.bootstrapped;
  }
}

function closeAutomationHistorySocket(tab) {
  const ws = tab?.ws;
  if (!ws) return;
  wsDisconnectTab(tab, { releaseWriter: true });
  tab.ws = null;
  tab.connected = false;
  tab.bootstrapped = false;
  tab.pendingReattach = false;
  if (_boundTab === tab && _ws === ws) {
    _ws = null;
    _connected = false;
    _bootstrapped = false;
    _pendingReattach = false;
  }
}

function buildWsCallbacks(tab, options = {}) {
  return {
    onConnecting() {
      setStatus('Connecting to Codex…', 'working');
    },

    onOpen(tab, ws, { shouldReattach, wasConnected }) {
      _ws = ws;
      _connected = true;
      if (_boundTab) { _boundTab.ws = ws; _boundTab.connected = true; }
      setStatus('Connected', 'ready');
      syncInputEnabled();
      syncSessionControls();

      if (!options.historyOnly && (shouldReattach || wasConnected)) {
        // Try to reattach to an orphaned server-side process
        sendSocket({
          type: 'reattach',
          windowId: windowId,
          accountId: _accountId || 'default',
          mcpProfile: tab.mcpProfile || null,
          ...codexRuntimeSelection(tab),
        });
      } else {
        // Fresh bootstrap
        sendSocket({
          type: 'bootstrap',
          windowId: windowId,
          threadId: _threadId || null,
          cwd: _project || null,
          accountId: _accountId || 'default',
          mcpProfile: tab.mcpProfile || null,
          ...codexRuntimeSelection(tab),
        });
      }
    },

    onClose(tab, ws, { intentional, reconnectAfterRelease = false }) {
      if (options.historyOnly && !tab._automationHydrated) tab._automationHistoryResolve?.(false);
      if (tab.ws && tab.ws !== ws) return;
      _connected = false;
      _bootstrapped = false;
      _pendingReattach = options.historyOnly || reconnectAfterRelease ? false : !intentional;
      _ws = null;
      if (_boundTab) {
        _boundTab.connected = false;
        _boundTab.bootstrapped = false;
        _boundTab.pendingReattach = _pendingReattach;
        _boundTab.ws = null;
      }
      syncInputEnabled();
      syncSessionControls();
      if (options.historyOnly && tab.automationActive) {
        syncWorkStatus();
      } else if (!options.historyOnly && reconnectAfterRelease && !tab.closed) {
        setStatus('Reconnecting to Codex…', 'working');
        scheduleReconnect(tab, () => connectTab(tab));
      } else if (!options.historyOnly && !intentional && !tab.closed) {
        setStatus('Disconnected — reconnecting…', 'error');
        scheduleReconnect(tab, () => connectTab(tab));
      } else {
        setStatus('Disconnected', 'muted');
      }
    },

    onReleaseRejected(tab, ws) {
      _ws = ws;
      _connected = true;
      _bootstrapped = !!tab.bootstrapped;
      if (_boundTab) {
        _boundTab.ws = ws;
        _boundTab.connected = true;
        _boundTab.bootstrapped = _bootstrapped;
      }
      if (tabHasActiveWriterWork(_boundTab)) syncWorkStatus();
      else setStatus('Ready', 'ready');
      syncInputEnabled();
      syncSessionControls();
    },

    onReattachResult(msg) {
      _pendingReattach = false;
      if (_boundTab) _boundTab.pendingReattach = false;
      if (msg.ok) {
        if (msg.accountId) {
          _accountId = msg.accountId;
          if (_boundTab) _boundTab.accountId = _accountId;
        }
        if (msg.mcpProfile && _boundTab) _boundTab.mcpProfile = msg.mcpProfile;
        // A reattached app-server can still have a different process-active
        // thread. Preserve the tab's displayed thread instead of adopting it.
        _threadId = _threadId || msg.threadId || null;
        if (_boundTab) _boundTab.threadId = _threadId;
        if (msg.running && (!msg.threadId || String(msg.threadId) === String(_threadId || ''))) {
          _running = true;
          if (_boundTab) _boundTab.running = true;
          setStatus('Resuming…', 'working');
          resetStallTimer();
        }
        // After reattach, bootstrap to get latest state
        sendSocket({
          type: 'bootstrap',
          windowId: windowId,
          threadId: _threadId || null,
          cwd: _project || null,
          accountId: _accountId || 'default',
          mcpProfile: tab.mcpProfile || null,
          ...codexRuntimeSelection(tab),
        });
      } else {
        // Nothing to reattach — fresh bootstrap
        sendSocket({
          type: 'bootstrap',
          windowId: windowId,
          threadId: _threadId || null,
          cwd: _project || null,
          accountId: _accountId || 'default',
          mcpProfile: tab.mcpProfile || null,
          ...codexRuntimeSelection(tab),
        });
      }
    },

    onReady(msg) {
      _bootstrapped = true;
      if (_boundTab) _boundTab.bootstrapped = true;
      if (msg.mcpProfile && _boundTab) {
        _boundTab.mcpProfile = msg.mcpProfile;
        if (activeTab() === _boundTab) _onActiveTabChanged?.(_boundTab);
      }
      if (Object.prototype.hasOwnProperty.call(msg, 'threadId')) {
        _threadId = msg.threadId || null;
        if (_boundTab) _boundTab.threadId = _threadId;
      }
      if (_boundTab && (!_boundTab.expectedThreadId || _boundTab.expectedThreadId === _threadId)) {
        _boundTab.expectedThreadId = null;
      }
      setStatus('Ready', 'ready');
      syncInputEnabled();
      syncSessionControls();
      renderContextGauge();
      requestModelList();
      refreshCodexAccounts();
      saveTabs();
      startHeartbeat(_tabs);
      releaseInactiveIdleTab(_boundTab);
    },

    onHistory(msg) {
      if (options.historyOnly
        && (tab._automationHistoryToken !== options.hydrationToken || tab._automationIgnoreHistory)) return;
      if (msg.thread) {
        if (_boundTab) {
          _boundTab.expectedThreadId = null;
          _boundTab.expectedThreadRequestId = null;
        }
        if (msg.historyMode === 'resume' && _boundTab) _boundTab.ownedThreadIds = new Set();
        // Note: thread-snapshot hydration (_threadSnapshotsReady) is async but
        // resolves at page load, long before the codex WS bootstrap completes —
        // and a pre-hydration miss just falls back to the SDK/JSONL rebuild.
        renderHistory(msg.thread, msg.fallbackItems || null);
        applyCodexProviderTitle(getThreadLabel(
          msg.thread,
          _sessionLabel || (msg.thread.id ? 'Saved session' : 'New session'),
        ));
        setThreadContextMeta({
          source: _threadTokenUsage ? 'snapshot' : (msg.historyMode === 'resume' ? 'unknown' : 'read-only'),
          freshness: _threadTokenUsage ? 'last-known' : 'pending',
          isLiveThread: msg.historyMode === 'resume',
          model: activeTab()?.model || _boundTab?.model || '',
          updatedAt: Date.now(),
        }, { merge: false });
        renderContextGauge();
      } else {
        // No thread — show empty state
        clearTranscript();
      }
      if (options.historyOnly) {
        tab._automationHydrated = true;
        closeAutomationHistorySocket(tab);
        tab._automationHistoryResolve?.(true);
      }
    },

    onThreadList(msg) {
      // Store for session menu
      if (msg.requestId && _sessionListRequest?.requestId === msg.requestId) {
        if (msg.error) _sessionListRequest.reject?.(new Error(msg.error));
        else _sessionListRequest.resolve?.(msg);
        _sessionListRequest = null;
      }
      releaseInactiveIdleTab(_boundTab);
    },

    onThreadStarted(msg) {
      if (msg.requestId && _threadStartRequest?.requestId === msg.requestId) {
        _threadStartRequest.resolve?.(msg);
        _threadStartRequest = null;
      }
      if (msg.threadId) {
        _threadId = msg.threadId;
        _freshThread = true;
        if (_boundTab) {
          _boundTab.threadId = _threadId;
          _boundTab.freshThread = true;
          _boundTab.expectedThreadId = null;
          _boundTab.expectedThreadRequestId = null;
        }
        const pending = _boundTab?.pendingSessionLabel;
        setSessionLabel(pending || getThreadLabel(msg.thread, _sessionLabel || 'New session'));
        if (pending && _boundTab) {
          _boundTab.pendingSessionLabel = null;
          requestSocketPayload('thread_rename', { threadId: _threadId, name: pending }).catch(() => {});
        }
        syncSessionControls();
      }
    },

    onThreadRenamed(msg) {
      resolveGenericRequest(msg);
      if (msg.name) applyCodexProviderTitle(msg.name);
    },

    onThread(msg) {
      if (msg.thread?.id) {
        if (_boundTab && _boundTab.threadId && _boundTab.threadId !== msg.thread.id) {
          _boundTab.ownedThreadIds = new Set();
        }
        _threadId = msg.thread.id;
        if (_boundTab) {
          _boundTab.threadId = _threadId;
          _boundTab.expectedThreadId = null;
          _boundTab.expectedThreadRequestId = null;
        }
        applyCodexProviderTitle(getThreadLabel(
          msg.thread,
          _sessionLabel || (msg.thread.id ? 'Saved session' : 'New session'),
        ));
        syncSessionControls();
      }
    },

    onTurn(msg) {
      // Turn updates are handled via notify events
      // Legacy: some servers emit turn wrapper
    },

    onNotify(msg) {
      if (msg.params?.item) {
        msg.params.item._synabunOwnership = {
          accountId: _boundTab?.accountId || 'default',
          sessionId: msg.sessionId || '',
          connectionEpoch: msg.connectionEpoch || '',
          threadId: msg.threadId || msg.params?.threadId || '',
          turnId: msg.turnId || msg.params?.turnId || '',
          source: 'live',
        };
        registerOwnedThreadFromItem(_boundTab, msg.params.item);
      }
      if (shouldBufferSocketMessage('notify', msg)) {
        bufferSocketMessage('notify', msg);
        return;
      }
      if (msg.method && msg.params !== undefined) {
        handleNotify(msg.method, msg.params);
      }
    },

    onServerRequest(msg) {
      handleServerRequest(msg);
    },

    onInterruptAck(msg) {
      _running = false;
      _activeTurnId = null;
      if (_boundTab) {
        _boundTab.running = false;
        _boundTab.activeTurnId = null;
        if (_boundTab._abortRetry) {
          clearTimeout(_boundTab._abortRetry);
          _boundTab._abortRetry = null;
        }
      }
      clearInterruptTimer();
      stopStallTimer();
      setStatus('Interrupted', 'muted');
      syncInputEnabled();
      syncSessionControls();
      releaseInactiveIdleTab(_boundTab);
    },

    onError(msg) {
      if (shouldBufferSocketMessage('error', msg)) {
        bufferSocketMessage('error', msg);
        return;
      }
      applySocketError(msg);
    },

    onModelList(msg) {
      const models = Array.isArray(msg.models) ? msg.models : [];
      resolveGenericRequest(msg);
      const normalized = cacheModelListForTab(_boundTab, models);
      if (isActiveTab(_boundTab)) populateModelDropdown(normalized);
    },

    onGenericResponse(msg) {
      if (msg.type === 'server_request_response_result') {
        handleServerRequestResponseResult(msg);
        return;
      }
      if (msg.type === 'storage_health') {
        const recovered = msg.status === 'healthy';
        appendSystem(
          msg.message || (recovered ? 'Codex request persistence recovered.' : 'Codex request persistence is unavailable.'),
          recovered ? 'muted' : 'error',
        );
        if (!recovered) {
          notify('panel', NOTIF_TYPE.ERROR, msg.message || 'Codex request persistence is unavailable.', {
            panel: 'codex',
            provider: 'codex',
            tabId: _boundTab?.id,
          });
        }
        return;
      }
      if (msg.type === 'codex_config_repaired') {
        appendSystem(msg.message || 'Codex configuration repaired.', 'muted');
        return;
      }
      resolveGenericRequest(msg);
      // Handle config_data, account_info, config_requirements, rate_limits, etc.
      if (msg.type === 'config_data' && msg.config) {
        // Apply config values if needed
      }
      if (msg.type?.startsWith('account_') || msg.type === 'account_info') {
        handleAccountMessage(msg);
      }
      if (msg.type === 'mcp_status' && msg.servers) {
        const previousServers = _mcpServers;
        const entries = Array.isArray(msg.servers)
          ? msg.servers.map((server, index) => [server?.name || `server-${index + 1}`, server])
          : Object.entries(msg.servers);
        _mcpServers = new Map(entries.map(([name, server]) => [name, {
          ...(previousServers.get(name) || {}),
          ...(server || {}),
          name,
        }]));
        if (_boundTab) _boundTab.mcpServers = _mcpServers;
        const statusTab = _boundTab;
        for (const [name, server] of _mcpServers) {
          if (isCodexMcpAuthenticationRequired(server)) {
            updateMcpStartupNotice(name, {
              state: 'failed',
              statusText: 'Authentication required',
              buttonLabel: 'Authenticate',
              buttonDisabled: false,
              buttonHidden: false,
              onAuthenticate: () => { void startMcpOAuthLogin(statusTab, name).catch(() => {}); },
            });
          } else if (server?.serverInfo || ['ready', 'running'].includes(server?.status)) {
            setMcpAuthenticationUi(name, 'ready', 'Connected');
          }
        }
        renderStatusChrome();
      }
      if (msg.type === 'mcp_profile_changed' && msg.profile) {
        if (_boundTab) _boundTab.mcpProfile = msg.profile;
        if (activeTab() === _boundTab) _onActiveTabChanged?.(_boundTab);
        saveTabs();
      }
      if (msg.type === 'mcp_approval_updated' && msg.name) {
        const server = _mcpServers.get(msg.name);
        if (server) {
          server.approvalMode = msg.approvalMode;
          server.alwaysAllowed = !!msg.alwaysAllowed;
        }
      }
    },

    onThreadForked(msg) {
      // Handle thread_forked, thread_archived, thread_unarchived
      resolveGenericRequest(msg);
    },

    onClosed(msg) {
      if (shouldBufferSocketMessage('closed', msg)) {
        bufferSocketMessage('closed', msg);
        return;
      }
      applySocketClosed(msg);
    },

    onMessageError(err, raw) {
      console.error('[cxp-tabs] WS message error:', err, 'raw:', raw);
    },

    onIgnoredMessage(msg, ignoredTab, reason = 'out_of_scope') {
      const targetTab = ignoredTab || tab;
      if (!targetTab.isolationRejections) targetTab.isolationRejections = {};
      targetTab.isolationRejections[reason] = (targetTab.isolationRejections[reason] || 0) + 1;
      if (msg?.type === 'server_request' && msg.requestId != null && tab?.ws?.readyState === WebSocket.OPEN) {
        tab.ws.send(JSON.stringify({
          type: 'server_request_response',
          sessionId: tab.id,
          connectionEpoch: tab.connectionEpoch || '',
          requestId: msg.requestId,
          threadId: msg.threadId || msg.params?.threadId || '',
          turnId: msg.turnId || msg.params?.turnId || '',
          toolCallId: msg.params?.toolCallId || msg.params?.callId || msg.params?.itemId || '',
          error: { code: -32001, message: 'Request no longer belongs to the active Codex thread.' },
        }));
      }
      if (codexPerfDebugEnabled()) {
        console.debug('[cxp-tabs] ignored out-of-scope Codex message', {
          reason,
          type: msg?.type,
          method: msg?.method,
          messageThreadId: msg?.threadId || msg?.params?.threadId || null,
          tabThreadId: targetTab?.threadId || null,
          messageSessionId: msg?.sessionId || null,
          tabSessionId: targetTab?.id || null,
          messageConnectionEpoch: msg?.connectionEpoch || null,
          tabConnectionEpoch: targetTab?.connectionEpoch || null,
        });
      }
    },
  };
}

// ── Module state (lines 59-121 of source, minus panel/ws-owned vars) ──
let _marked = null;
let _projects = [];
let _projectsPromise = null;
let _projectsLoaded = false;
let _projectThreads = parseStoredJson(STOR.projectThreads, {});
// Thread snapshots live in the per-entry blob store (see blob-store.js) —
// the whole-map storage key used to ride every ui-state PATCH. Hydration is
// async; getThreadSnapshot returns null pre-hydration and renderHistory falls
// back to SDK/JSONL items.
let _threadSnapshots = {};
const _threadSnapshotsReady = fetchBlobNamespace('codex-snapshots')
  .then((map) => {
    const valid = {};
    for (const [threadId, entry] of Object.entries(map || {})) {
      if (codexThreadSnapshotHasOwnershipManifest(entry, threadId, entry?.accountId || null)) {
        valid[threadId] = entry;
      } else {
        // v1/v2 snapshots are UI caches and may already contain foreign cards.
        // Authoritative Codex history remains in the rollout/state database.
        deleteBlob('codex-snapshots', threadId);
      }
    }
    _threadSnapshots = { ...valid, ..._threadSnapshots };
    try { if (storage.getItem(STOR.threadSnapshots)) storage.removeItem(STOR.threadSnapshots); } catch {}
  })
  .catch(() => {});
let _tabs = [];
let _activeTabIdx = -1;
let _boundTab = null;
let _messagesEl = null;
let _ws = null;
let _connected = false;
let _bootstrapped = false;
let _running = false;
let _activeTurnId = null;
let _freshThread = false;
let _threadId = null;
let _project = '';
let _accountId = 'default';      // per-tab ChatGPT account (drives server CODEX_HOME)
let _codexAccounts = [];          // cached account registry (global), populated by account_list
let _sessionListRequest = null;
let _threadStartRequest = null;
let _sessionLabel = 'New session';
let _renameRequests = new Map();
let _items = new Map();
let _requestCards = new Map();
let _startingThread = false;
let _trayPill = null;
let _statusText = 'Connecting to Codex…';
let _statusTone = 'working';
let _statusDetail = '';
let _turnStartedAt = null;
let _stepStartedAt = null;
let _currentStepKey = '';
let _statusTicker = null;
let _activeItems = new Map();
let _activePlan = [];
let _mcpServers = new Map();
let _threadActiveFlags = [];
let _threadTokenUsage = null;
let _threadContextMeta = null;
let _transcriptSourceType = '';
let _transcriptItemCount = 0;
let _transcriptSourceUpdatedAt = null;
let _compacting = false;
let _pendingReattach = false;
let _pendingQueryRequestId = null;
let _planFilePath = '';
let _planContent = '';
let _editedPlanContent = '';
let _showPostPlanActions = false;
let _postPlanHeader = 'PLAN COMPLETE';
let _planTurnActive = false;
let _planApprovalPending = false;
let _lastPlanTurnId = '';
let _showPostCompactionPrompt = false;
let _postCompactionPending = false;
let _postCompactionPromptSource = '';
let _manualCompactionPending = false;
let _autoCompactionActive = false;
let _autoCompactionNoticeShown = false;
let _lastAutoCompactionCompleteAt = 0;
let _stallTimer = null;
let _lastMsgTime = 0;
let _interruptTimer = null;
let _interruptRetried = false;
let _prevInputTokens = 0;
let _skillsCache = null;
let _skillsPromise = null;
let _blockingServerRequests = new Map();
let _bufferedSocketMessages = [];

const BLOCKING_SERVER_REQUEST_KINDS = {
  'item/tool/requestUserInput': 'input',
  'tool/requestUserInput': 'input',
  'mcpServer/elicitation/request': 'input',
  'item/tool/call': 'input',
  'item/commandExecution/requestApproval': 'approval',
  'item/fileChange/requestApproval': 'approval',
  'item/permissions/requestApproval': 'approval',
};

function ensureCodexNotifState(tab = _boundTab) {
  if (!tab) return null;
  if (!tab._notifState) {
    tab._notifState = {
      turnOutcomeKey: '',
      requestIds: new Set(),
    };
  }
  return tab._notifState;
}

function resetCodexTurnNotif(tab = _boundTab) {
  const state = ensureCodexNotifState(tab);
  if (state) state.turnOutcomeKey = '';
}

function clearCodexRequestNotif(requestId, tab = _boundTab) {
  const state = ensureCodexNotifState(tab);
  state?.requestIds?.delete(String(requestId));
}

export function notifyCodexPanel(type, tab = _boundTab, extra = {}) {
  if (!tab) return false;
  notify('panel', type, tab.sessionLabel || 'Codex', {
    panel: 'codex',
    provider: 'codex',
    tabId: tab.id,
    ...extra,
  });
  return true;
}

function notifyCodexTurnOutcome(type, tab = _boundTab, turnId = tab?.activeTurnId || _activeTurnId) {
  const state = ensureCodexNotifState(tab);
  if (!state) return false;
  if (state.turnOutcomeKey.endsWith(`:${type}`)) return false;
  if (state.turnOutcomeKey.endsWith(`:${NOTIF_TYPE.ERROR}`)) return false;
  const key = `${turnId || 'turn'}:${type}`;
  state.turnOutcomeKey = key;
  return notifyCodexPanel(type, tab);
}

function getBlockingServerRequestKind(method) {
  return BLOCKING_SERVER_REQUEST_KINDS[method] || '';
}

function isBlockingServerRequest(method) {
  return !!getBlockingServerRequestKind(method);
}

function hasBlockingServerRequests(kind = '') {
  if (!kind) return _blockingServerRequests.size > 0;
  for (const entry of _blockingServerRequests.values()) {
    if (entry?.kind === kind) return true;
  }
  return false;
}

function latestBlockingServerRequest() {
  const values = Array.from(_blockingServerRequests.values());
  return values[values.length - 1] || null;
}

function summarizeBlockingServerRequest(entry) {
  const kind = entry?.kind || 'input';
  const params = entry?.params || {};
  if (kind === 'approval') {
    return {
      title: 'Waiting for approval',
      detail: cleanPreview(params.command || params.reason || params.itemId || 'Review the approval request card'),
    };
  }
  if (Array.isArray(params.questions) && params.questions.length) {
    return {
      title: 'Waiting for input',
      detail: params.questions.length > 1
        ? cleanPreview(`Answer ${params.questions.length} questions, then submit`)
        : cleanPreview((params.questions[0] || {}).question || (params.questions[0] || {}).header || (params.questions[0] || {}).id || 'Answer the question card'),
    };
  }
  return {
    title: 'Waiting for input',
    detail: cleanPreview(params.message || params.tool || params.serverName || 'Answer the request card'),
  };
}

function rememberBlockingServerRequest(requestId, method, params = {}) {
  if (!requestId) return;
  _blockingServerRequests.set(String(requestId), {
    requestId: String(requestId),
    method,
    kind: getBlockingServerRequestKind(method),
    params,
    createdAt: Date.now(),
  });
  if (_boundTab) _boundTab.blockingServerRequests = _blockingServerRequests;
  syncWorkStatus();
  syncInputEnabled();
  saveTabs();
}

function clearBlockingServerRequest(requestId, { flushBuffered = true } = {}) {
  if (!requestId) return;
  if (!_blockingServerRequests.delete(String(requestId))) return;
  if (_boundTab) _boundTab.blockingServerRequests = _blockingServerRequests;
  syncWorkStatus();
  syncInputEnabled();
  saveTabs();
  if (flushBuffered && !hasBlockingServerRequests()) flushBufferedSocketMessages();
  releaseInactiveIdleTab(_boundTab);
}

function clearAllBlockingServerRequests() {
  if (!_blockingServerRequests.size && !_bufferedSocketMessages.length) return;
  _blockingServerRequests = new Map();
  _bufferedSocketMessages = [];
  if (_boundTab) {
    _boundTab.blockingServerRequests = _blockingServerRequests;
    _boundTab.bufferedSocketMessages = _bufferedSocketMessages;
  }
  syncWorkStatus();
  syncInputEnabled();
}

function shouldBufferSocketMessage(kind, payload) {
  if (!hasBlockingServerRequests()) return false;
  if (kind === 'notify' && payload?.method === 'serverRequest/resolved') return false;
  return kind === 'notify' || kind === 'error' || kind === 'closed';
}

function bufferSocketMessage(kind, payload) {
  if (_bufferedSocketMessages.length < 500) {
    _bufferedSocketMessages.push({ kind, payload });
  }
  if (_boundTab) _boundTab.bufferedSocketMessages = _bufferedSocketMessages;
}

function resolveGenericRequest(msg) {
  if (!msg?.requestId) return null;
  const pending = _renameRequests.get(msg.requestId);
  if (!pending) return null;
  if (msg.error) pending.reject?.(new Error(msg.error));
  else pending.resolve?.(msg);
  _renameRequests.delete(msg.requestId);
  syncPendingRequestRefs();
  releaseInactiveIdleTab(_boundTab);
  return pending;
}

function applySocketError(msg) {
  const text = msg.message || 'Unknown error';
  if (_compacting) setCompactingUI(false);
  if (_pendingQueryRequestId && String(msg.requestId || '') === String(_pendingQueryRequestId)) {
    _pendingQueryRequestId = null;
    if (_boundTab) _boundTab.pendingQueryRequestId = null;
  }
  appendSystem(text, 'error');
  setStatus(text, 'error');
  if (/Codex CLI not found|ENOENT|app-server exited before responding|app-server spawn/i.test(text)) {
    import('./cdx-panel.js').then((m) => m.flagCdxCliInstallFailure?.(text)).catch(() => {});
  }
  if (msg.requestId) {
    if (_sessionListRequest?.requestId === msg.requestId) {
      _sessionListRequest.reject?.(new Error(text));
      _sessionListRequest = null;
    }
    if (_threadStartRequest?.requestId === msg.requestId) {
      _threadStartRequest.reject?.(new Error(text));
      _threadStartRequest = null;
    }
    const pending = _renameRequests.get(msg.requestId);
    if (pending) {
      pending.reject?.(new Error(text));
      _renameRequests.delete(msg.requestId);
      syncPendingRequestRefs();
    }
  }
  releaseInactiveIdleTab(_boundTab);
}

function applySocketClosed() {
  appendSystem('Codex session closed', 'muted');
}

function applyBufferedSocketMessage(entry) {
  if (!entry) return;
  if (entry.kind === 'notify') {
    handleNotify(entry.payload.method, entry.payload.params);
    return;
  }
  if (entry.kind === 'error') {
    applySocketError(entry.payload);
    return;
  }
  if (entry.kind === 'closed') applySocketClosed(entry.payload);
}

function flushBufferedSocketMessages() {
  if (hasBlockingServerRequests() || !_bufferedSocketMessages.length) return;
  const queued = _bufferedSocketMessages.splice(0);
  if (_boundTab) _boundTab.bufferedSocketMessages = _bufferedSocketMessages;
  for (const entry of queued) applyBufferedSocketMessage(entry);
}


// ── Storage/Snapshot utils (lines 123-386) ──
export function parseStoredJson(key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeSnapshotSourceType(value) {
  const next = String(value || '').trim().toLowerCase();
  return ['sdk', 'fallback', 'live', 'snapshot'].includes(next) ? next : '';
}

function normalizeContextTrackerSource(value) {
  const next = String(value || '').trim().toLowerCase();
  return ['live', 'snapshot', 'read-only', 'fallback', 'unknown'].includes(next) ? next : 'unknown';
}

function normalizeContextTrackerFreshness(value) {
  const next = String(value || '').trim().toLowerCase();
  return ['authoritative', 'last-known', 'pending', 'stale'].includes(next) ? next : 'pending';
}

function normalizeSnapshotItemCount(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
}

function normalizeContextTrackerMeta(value) {
  const next = value && typeof value === 'object' ? value : {};
  const source = normalizeContextTrackerSource(next.source);
  const freshness = normalizeContextTrackerFreshness(
    next.freshness || (source === 'live'
      ? 'authoritative'
      : (source === 'snapshot' || source === 'fallback' ? 'last-known' : 'pending')),
  );
  const updatedAt = Number(next.updatedAt);
  return {
    source,
    freshness,
    isLiveThread: !!next.isLiveThread,
    model: typeof next.model === 'string' ? next.model : '',
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null,
  };
}

function defaultContextTrackerMeta(overrides = {}) {
  return normalizeContextTrackerMeta({
    source: 'unknown',
    freshness: 'pending',
    isLiveThread: false,
    model: '',
    updatedAt: null,
    ...overrides,
  });
}

export function setThreadContextMeta(next = {}, { merge = true } = {}) {
  const base = merge ? normalizeContextTrackerMeta(_threadContextMeta) : defaultContextTrackerMeta();
  _threadContextMeta = normalizeContextTrackerMeta({ ...base, ...next });
  if (_boundTab) _boundTab.threadContextMeta = _threadContextMeta;
}

export function setTranscriptSourceMeta({
  sourceType = '',
  itemCount = 0,
  sourceUpdatedAt = null,
} = {}) {
  _transcriptSourceType = normalizeSnapshotSourceType(sourceType);
  _transcriptItemCount = normalizeSnapshotItemCount(itemCount);
  const nextUpdatedAt = Number(sourceUpdatedAt);
  _transcriptSourceUpdatedAt = Number.isFinite(nextUpdatedAt) && nextUpdatedAt > 0
    ? nextUpdatedAt
    : null;
  if (_boundTab) {
    _boundTab.transcriptSourceType = _transcriptSourceType;
    _boundTab.transcriptItemCount = _transcriptItemCount;
    _boundTab.transcriptSourceUpdatedAt = _transcriptSourceUpdatedAt;
  }
}

function normalizeThreadSnapshotEntry(entry, expectedThreadId = null, expectedAccountId = null) {
  if (!entry || typeof entry !== 'object') return null;
  const threadId = String(expectedThreadId || entry.threadId || '');
  if (!threadId || !codexThreadSnapshotHasOwnershipManifest(entry, threadId, expectedAccountId)) return null;
  const html = typeof entry.html === 'string' ? entry.html : '';
  if (!html.trim()) return null;
  return {
    version: CODEX_THREAD_SNAPSHOT_VERSION,
    accountId: String(entry.accountId || 'default'),
    threadId,
    html,
    updatedAt: Number(entry.updatedAt) || Date.now(),
    title: normalizeSessionLabel(entry.title || ''),
    threadTokenUsage: normalizeThreadTokenUsage(entry.threadTokenUsage),
    threadContextMeta: normalizeContextTrackerMeta(entry.threadContextMeta),
    sourceType: normalizeSnapshotSourceType(entry.sourceType),
    itemCount: normalizeSnapshotItemCount(entry.itemCount),
    sourceUpdatedAt: Number(entry.sourceUpdatedAt) || null,
    acceptedItemIds: Array.isArray(entry.acceptedItemIds) ? entry.acceptedItemIds.map(String) : [],
    acceptedTurnIds: Array.isArray(entry.acceptedTurnIds) ? entry.acceptedTurnIds.map(String) : [],
    provenance: entry.provenance && typeof entry.provenance === 'object' ? { ...entry.provenance } : {},
  };
}

function persistThreadSnapshots(changedThreadId) {
  const source = (_threadSnapshots && typeof _threadSnapshots === 'object' && !Array.isArray(_threadSnapshots))
    ? _threadSnapshots
    : {};
  const entries = Object.entries(source)
    .map(([threadId, entry]) => [threadId, normalizeThreadSnapshotEntry(entry, threadId, entry?.accountId || null)])
    .filter(([, entry]) => !!entry)
    .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const next = {};
  let totalChars = 0;
  for (const [threadId, entry] of entries) {
    const size = entry.html.length;
    if (Object.keys(next).length >= MAX_THREAD_SNAPSHOTS) break;
    if (totalChars + size > MAX_THREAD_SNAPSHOT_CHARS && Object.keys(next).length) continue;
    totalChars += size;
    next[threadId] = entry;
  }

  const t0 = codexPerfDebugEnabled() ? performance.now() : 0;
  // Locally-evicted entries also leave the server store.
  for (const threadId of Object.keys(source)) {
    if (!next[threadId]) deleteBlob('codex-snapshots', threadId);
  }
  _threadSnapshots = next;
  // Upload ONLY the changed thread's entry (server enforces the same caps).
  if (changedThreadId && next[changedThreadId]) {
    putBlob('codex-snapshots', changedThreadId, next[changedThreadId], {
      maxEntries: MAX_THREAD_SNAPSHOTS,
      maxChars: MAX_THREAD_SNAPSHOT_CHARS,
    });
  }
  if (t0) codexPerfLog('snapshot:persist', {
    ms: Math.round((performance.now() - t0) * 10) / 10,
    threads: Object.keys(next).length,
    chars: totalChars,
  });
}

function getThreadSnapshot(threadId) {
  if (!threadId) return null;
  const entry = normalizeThreadSnapshotEntry(_threadSnapshots?.[threadId], threadId, _accountId || 'default');
  if (!entry && _threadSnapshots?.[threadId]) {
    delete _threadSnapshots[threadId];
    deleteBlob('codex-snapshots', threadId);
  }
  return entry;
}

function invalidateThreadSnapshot(threadId) {
  if (!threadId) return;
  delete _threadSnapshots[threadId];
  deleteBlob('codex-snapshots', threadId);
}

function writeThreadSnapshot(tab, { force = false } = {}) {
  const threadId = tab?.threadId || null;
  const messagesEl = tab?.messagesEl || null;
  if (!threadId || !messagesEl) return;
  if (tab?.items instanceof Map) {
    for (const itemState of tab.items.values()) {
      if (itemState?._bodyDirty) flushCardBody(itemState);
    }
  }
  const t0 = codexPerfDebugEnabled() ? performance.now() : 0;
  pruneTranscriptDom(messagesEl);
  const accountId = String(tab.accountId || 'default');
  const snapshotNodes = [...messagesEl.children].filter((node) => (
    !node.classList?.contains('cxp-empty') && !node.classList?.contains('cxp-thinking')
  ));
  const ownsEveryNode = codexTranscriptNodesHaveOwnership(snapshotNodes, { threadId, accountId });
  if (!ownsEveryNode) {
    tab.isolationRejections = tab.isolationRejections || {};
    tab.isolationRejections.snapshot_ownership_mismatch =
      (tab.isolationRejections.snapshot_ownership_mismatch || 0) + 1;
    return;
  }
  const html = messagesEl.innerHTML || '';
  if (!html.trim()) return;
  const ownedItemNodes = snapshotNodes.filter((node) => node.dataset?.itemId);
  const itemCount = normalizeSnapshotItemCount(tab?.transcriptItemCount)
    || countRenderableTranscriptNodes(messagesEl);
  if (!_threadSnapshots || typeof _threadSnapshots !== 'object' || Array.isArray(_threadSnapshots)) {
    _threadSnapshots = {};
  }
  _threadSnapshots[threadId] = {
    version: CODEX_THREAD_SNAPSHOT_VERSION,
    accountId,
    threadId,
    html,
    updatedAt: Date.now(),
    title: normalizeSessionLabel(tab.sessionLabel || ''),
    threadTokenUsage: normalizeThreadTokenUsage(tab.threadTokenUsage),
    threadContextMeta: normalizeContextTrackerMeta(tab.threadContextMeta),
    sourceType: normalizeSnapshotSourceType(tab?.transcriptSourceType),
    itemCount,
    sourceUpdatedAt: Number(tab?.transcriptSourceUpdatedAt) || null,
    acceptedItemIds: [...new Set(ownedItemNodes.map((node) => node.dataset.itemId).filter(Boolean))],
    acceptedTurnIds: [...new Set(snapshotNodes.map((node) => node.dataset.codexTurnId).filter(Boolean))],
    provenance: {
      sessionId: tab.id || '',
      connectionEpoch: tab.connectionEpoch || '',
      savedAt: Date.now(),
    },
  };
  persistThreadSnapshots(threadId);
  tab._lastSnapshotWriteAt = Date.now();
  if (t0) codexPerfLog('snapshot:write', {
    force,
    ms: Math.round((performance.now() - t0) * 10) / 10,
    chars: html.length,
    children: messagesEl.childElementCount,
    itemCount,
  });
}

export function scheduleThreadSnapshotSave(tab = _boundTab, { force = false } = {}) {
  if (!tab?.threadId || !tab?.messagesEl) return;
  if (tab.snapshotTimer) clearTimeout(tab.snapshotTimer);
  if (tab.snapshotIdleHandle) {
    cancelIdleWork(tab.snapshotIdleHandle);
    tab.snapshotIdleHandle = null;
  }
  const running = !!(tab.running || (tab === _boundTab && _running));
  const sinceLast = Date.now() - (tab._lastSnapshotWriteAt || 0);
  let delay = force ? 0 : (running ? SNAPSHOT_RUNNING_DELAY_MS : SNAPSHOT_IDLE_DELAY_MS);
  if (!force && running && sinceLast < SNAPSHOT_RUNNING_MIN_INTERVAL_MS) {
    delay = Math.max(delay, SNAPSHOT_RUNNING_MIN_INTERVAL_MS - sinceLast);
  }
  tab.snapshotTimer = setTimeout(() => {
    tab.snapshotTimer = null;
    if (force) {
      writeThreadSnapshot(tab, { force: true });
      return;
    }
    tab.snapshotIdleHandle = requestIdleWork(() => {
      tab.snapshotIdleHandle = null;
      writeThreadSnapshot(tab);
    });
  }, delay);
}

export function flushThreadSnapshotSave(tab = _boundTab) {
  if (!tab) return;
  if (tab.snapshotTimer) {
    clearTimeout(tab.snapshotTimer);
    tab.snapshotTimer = null;
  }
  if (tab.snapshotIdleHandle) {
    cancelIdleWork(tab.snapshotIdleHandle);
    tab.snapshotIdleHandle = null;
  }
  writeThreadSnapshot(tab, { force: true });
}

export function flushAllThreadSnapshots() {
  for (const tab of _tabs) {
    try { flushThreadSnapshotSave(tab); } catch {}
  }
}

export function pruneTranscriptDom(messagesEl = _messagesEl) {
  if (!messagesEl || messagesEl.childElementCount <= CODEX_MAX_TRANSCRIPT_CHILDREN) return 0;
  const targetRemove = Math.min(
    CODEX_PRUNE_BATCH,
    messagesEl.childElementCount - (CODEX_MAX_TRANSCRIPT_CHILDREN - CODEX_PRUNE_BATCH)
  );
  const activeIds = new Set(_activeItems?.keys?.() || []);
  let removed = 0;

  for (const child of Array.from(messagesEl.children)) {
    if (removed >= targetRemove) break;
    if (child.classList?.contains('cxp-empty') || child.classList?.contains('cxp-thinking')) continue;
    const itemId = child.dataset?.itemId || child.querySelector?.('[data-item-id]')?.dataset?.itemId || '';
    if (itemId && activeIds.has(itemId)) continue;

    child.remove();
    removed++;
    if (itemId) {
      _items.delete(itemId);
      _requestCards.delete(itemId);
      _activeItems.delete(itemId);
    }
  }

  if (removed) {
    const itemCount = countRenderableTranscriptNodes(messagesEl);
    _transcriptItemCount = itemCount;
    if (_boundTab?.messagesEl === messagesEl) {
      _boundTab.transcriptItemCount = itemCount;
      _boundTab.transcriptSourceUpdatedAt = Date.now();
    }
    codexPerfLog('transcript:prune', {
      removed,
      children: messagesEl.childElementCount,
      itemCount,
    });
  }
  return removed;
}

function normalizeTokenUsageBreakdown(value) {
  if (!value || typeof value !== 'object') return null;
  const cacheWriteInputTokens = Number(
    value.cacheWriteInputTokens ?? value.cacheCreationInputTokens,
  ) || 0;
  return {
    cachedInputTokens: Number(value.cachedInputTokens) || 0,
    cacheWriteInputTokens,
    // Keep the legacy alias for restored snapshots and existing cost code.
    cacheCreationInputTokens: cacheWriteInputTokens,
    inputTokens: Number(value.inputTokens) || 0,
    outputTokens: Number(value.outputTokens) || 0,
    reasoningOutputTokens: Number(value.reasoningOutputTokens) || 0,
    totalTokens: Number(value.totalTokens) || 0,
  };
}

function normalizeThreadTokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const total = normalizeTokenUsageBreakdown(value.total);
  const last = normalizeTokenUsageBreakdown(value.last);
  const parsedWindow = Number(value.modelContextWindow);
  const modelContextWindow = Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : null;
  if (!total && !last) return null;
  return { total, last, modelContextWindow };
}

function resolveContextInputTokens(value) {
  if (!value || typeof value !== 'object') return 0;
  const direct = Number(value.inputTokens);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const totalTokens = Number(value.totalTokens) || 0;
  const outputTokens = Number(value.outputTokens) || 0;
  const reasoningOutputTokens = Number(value.reasoningOutputTokens) || 0;
  const derived = totalTokens - outputTokens - reasoningOutputTokens;
  return Number.isFinite(derived) && derived > 0 ? Math.floor(derived) : 0;
}

function isPlausibleContextBreakdown(value, contextWindow) {
  const inputTokens = resolveContextInputTokens(value);
  if (inputTokens <= 0) return false;
  if (!contextWindow) return true;
  return inputTokens <= Math.max(contextWindow * 1.1, contextWindow + 2048);
}

function resolveContextGaugeBreakdown(usage, contextWindow = null) {
  if (!usage) return { basis: 'unknown', breakdown: null };
  const last = usage.last || null;
  const total = usage.total || null;
  if (last && isPlausibleContextBreakdown(last, contextWindow)) return { basis: 'last', breakdown: last };
  if (total && isPlausibleContextBreakdown(total, contextWindow)) return { basis: 'total', breakdown: total };
  return { basis: 'unknown', breakdown: last || total || null };
}

let _hljs = null;

(async () => {
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js').catch(() => null);
    if (mod) {
      _marked = mod.marked || mod.default;
      if (_marked?.setOptions) _marked.setOptions({ breaks: true, gfm: true });
    }
  } catch {}
})();

(async () => {
  try {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark-dimmed.min.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/highlight.js@11/lib/highlight.min.js';
    script.onload = () => { _hljs = window.hljs || null; };
    document.head.appendChild(script);
  } catch {}
})();


// ── Plan state functions (lines 886-938) ──
function isPlanModePromptText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return /^\[PLAN MODE\b/i.test(value)
    || CODEX_PLAN_MODE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function syncPlanHandoffFlags(tab = _boundTab) {
  if (!tab || !isActiveTab(tab)) return;
  _planTurnActive = !!tab.planTurnActive;
  _planApprovalPending = !!tab.planApprovalPending;
  _lastPlanTurnId = tab.lastPlanTurnId || '';
}

function setPlanTurnActive(tab = _boundTab, value, turnId = '') {
  if (!tab) return;
  tab.planTurnActive = !!value;
  if (turnId !== undefined) tab.lastPlanTurnId = turnId || '';
  syncPlanHandoffFlags(tab);
}

function setPlanApprovalPending(tab = _boundTab, value) {
  if (!tab) return;
  tab.planApprovalPending = !!value;
  syncPlanHandoffFlags(tab);
}

function shouldHoldForPlanApproval(tab = activeTab()) {
  return !!(tab?.showPostPlanActions || tab?.planApprovalPending);
}

function releaseAutomationForManualUse(tab = _boundTab) {
  const runId = detachTerminalCodexAutomation(tab);
  if (!runId) return false;
  window.dispatchEvent(new CustomEvent('native-loop:dismissed', { detail: { runId } }));
  saveTabs();
  return true;
}

function captureCompletedPlanItem(tab = _boundTab, item = null) {
  if (!tab || tab.automationRunId || !tab.planTurnActive || !item) return '';
  const itemType = item.type || '';
  if (itemType !== 'plan' && itemType !== 'agentMessage') return '';
  const state = item.id ? tab.items?.get?.(item.id) : null;
  const text = String(state?.buffer || item.text || '').trim();
  if (text.length <= 80) return '';
  return capturePlanContent(tab, text);
}

export function clearPlanHandoffState(tab = _boundTab, { keepFilePath = false } = {}) {
  if (!tab) return;
  tab.planContent = '';
  tab.editedPlanContent = '';
  tab.planFeedbackDraft = '';
  tab.showPostPlanActions = false;
  tab.postPlanHeader = 'PLAN COMPLETE';
  tab.planTurnActive = false;
  tab.planApprovalPending = false;
  tab.lastPlanTurnId = '';
  if (!keepFilePath) tab.planFilePath = '';
  if (isActiveTab(tab)) {
    _planContent = '';
    _editedPlanContent = '';
    _showPostPlanActions = false;
    _postPlanHeader = 'PLAN COMPLETE';
    _planTurnActive = false;
    _planApprovalPending = false;
    _lastPlanTurnId = '';
    if (!keepFilePath) _planFilePath = '';
  }
  removePostPlanCards(tab.messagesEl);
  updatePostPlanTranscriptMeta(tab);
}

export function clearPostCompactionState(tab = _boundTab, { updateTranscript = true } = {}) {
  if (!tab) return;
  tab.showPostCompactionPrompt = false;
  tab.postCompactionPending = false;
  tab.postCompactionPromptSource = '';
  if (isActiveTab(tab)) {
    _showPostCompactionPrompt = false;
    _postCompactionPending = false;
    _postCompactionPromptSource = '';
  }
  removePostCompactionCards(tab.messagesEl);
  if (updateTranscript) updatePostPlanTranscriptMeta(tab);
}

function syncRuntimeCompactionState(tab = _boundTab) {
  if (!tab) return;
  tab.manualCompactionPending = _manualCompactionPending;
  tab.autoCompactionActive = _autoCompactionActive;
  tab.autoCompactionNoticeShown = _autoCompactionNoticeShown;
  tab.lastAutoCompactionCompleteAt = _lastAutoCompactionCompleteAt;
}

function resetRuntimeCompactionState(tab = _boundTab) {
  _manualCompactionPending = false;
  _autoCompactionActive = false;
  _autoCompactionNoticeShown = false;
  _lastAutoCompactionCompleteAt = 0;
  syncRuntimeCompactionState(tab);
}

function markPostCompactionPrompt(tab = _boundTab, { defer = _running, source = 'manual' } = {}) {
  if (!tab || tab.showPostPlanActions) return;
  if (source !== 'manual') return;
  const shouldDefer = !!defer;
  tab.showPostCompactionPrompt = !shouldDefer;
  tab.postCompactionPending = shouldDefer;
  tab.postCompactionPromptSource = source;
  if (isActiveTab(tab)) {
    _showPostCompactionPrompt = tab.showPostCompactionPrompt;
    _postCompactionPending = tab.postCompactionPending;
    _postCompactionPromptSource = source;
  }
  if (!shouldDefer) renderPostCompactionActions(tab);
  saveTabs();
}

function flushPostCompactionPrompt(tab = _boundTab) {
  if (!tab || tab.showPostPlanActions || !tab.postCompactionPending || tab.postCompactionPromptSource !== 'manual') return;
  tab.postCompactionPending = false;
  tab.showPostCompactionPrompt = true;
  if (isActiveTab(tab)) {
    _postCompactionPending = false;
    _showPostCompactionPrompt = true;
    _postCompactionPromptSource = 'manual';
  }
  renderPostCompactionActions(tab);
  saveTabs();
}

function beginAutoCompactionNotice() {
  if (_manualCompactionPending) {
    setCompactingUI(true);
    return;
  }
  const firstNotice = !_autoCompactionNoticeShown;
  _autoCompactionActive = true;
  _autoCompactionNoticeShown = true;
  syncRuntimeCompactionState();
  setCompactingUI(true);
  setStatus('Auto-compacting context…', 'working');
  setStatusDetail('Summarizing this long turn so Codex can continue', Date.now(), 'compaction:auto');
  updateThinkingState({ title: 'Auto-compacting context…', detail: 'Summarizing the current thread' });
  if (firstNotice) {
    appendSystem('Codex is auto-compacting context so this long turn can continue.', 'working');
  }
}

function finishAutoCompactionNotice({ quiet = false } = {}) {
  const hadActiveAutoCompaction = _autoCompactionActive;
  const now = Date.now();
  const recentlyCompleted = _lastAutoCompactionCompleteAt && (now - _lastAutoCompactionCompleteAt) < 2000;
  _autoCompactionActive = false;
  _autoCompactionNoticeShown = false;
  _lastAutoCompactionCompleteAt = now;
  syncRuntimeCompactionState();
  setCompactingUI(false);
  if (!quiet && !recentlyCompleted && !_showPostCompactionPrompt) {
    appendSystem(hadActiveAutoCompaction
      ? 'Auto-compaction complete. Codex is continuing with summarized context.'
      : 'Context auto-compacted.', 'muted');
  }
  if (_running) syncWorkStatus();
  else if (_connected) setStatus('Ready', 'ready');
}

function finishContextCompaction({ manual = _manualCompactionPending, defer = _running } = {}) {
  setThreadContextMeta({
    freshness: 'pending',
    updatedAt: Date.now(),
  });
  if (manual) {
    _manualCompactionPending = false;
    _autoCompactionActive = false;
    _autoCompactionNoticeShown = false;
    syncRuntimeCompactionState();
    setCompactingUI(false);
    markPostCompactionPrompt(_boundTab, { defer, source: 'manual' });
    return;
  }
  finishAutoCompactionNotice();
}

export function preparePlanModeTurn(tab = _boundTab) {
  if (!tab) return;
  clearPlanHandoffState(tab);
  clearPostCompactionState(tab, { updateTranscript: false });
  saveTabs();
}

export function extractLatestPlanText(tab = _boundTab) {
  if (!tab) return '';
  if (tab.editedPlanContent?.trim()) return tab.editedPlanContent.trim();
  if (tab.planContent?.trim()) return tab.planContent.trim();

  const states = Array.from(tab.items?.values?.() || []);
  for (let i = states.length - 1; i >= 0; i -= 1) {
    const state = states[i];
    if (!state) continue;
    const text = String(state.buffer || '').trim();
    if ((state.type === 'plan' || state.type === 'agentMessage') && text.length > 80) return text;
  }

  const messages = tab.messagesEl?.querySelectorAll('.cxp-msg-assistant .cxp-msg-body') || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = String(messages[i].textContent || '').trim();
    if (text.length > 80) return text;
  }
  return '';
}

export function capturePlanContent(tab = _boundTab, explicitText = '') {
  if (!tab) return '';
  const next = String(explicitText || extractLatestPlanText(tab) || '').trim();
  if (!next) return '';
  tab.planContent = next;
  if (isActiveTab(tab)) _planContent = next;
  return next;
}

export async function ensurePlanFile(tab = _boundTab) {
  if (!tab) return '';
  if (tab.planFilePath) return tab.planFilePath;
  if (tab._planFilePromise) return tab._planFilePromise;
  const planText = capturePlanContent(tab);
  if (!planText) return '';

  tab._planFilePromise = fetch('/api/create-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: planText, cwd: tab.project || _project || '' }),
  })
    .then(async (res) => {
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result?.ok || !result.path) {
        throw new Error(result?.error || 'create-plan failed');
      }
      tab.planFilePath = result.path;
      if (isActiveTab(tab)) _planFilePath = result.path;
      saveTabs();
      return result.path;
    })
    .catch((err) => {
      console.warn('[codex-panel] create-plan failed:', err);
      return '';
    })
    .finally(() => {
      tab._planFilePromise = null;
    });

  return tab._planFilePromise;
}

// ── Formatting & helpers (lines 1148-1421) ──
export function formatStatus(status) {
  if (!status) return 'pending';
  if (typeof status === 'string') return status;
  if (typeof status === 'object') {
    const [key, val] = Object.entries(status)[0] || [];
    if (!key) return 'pending';
    if (val && typeof val === 'object' && val.message) return `${key}: ${val.message}`;
    return key;
  }
  return String(status);
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalSeconds = Math.max(1, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function formatTokenCount(value) {
  const num = Number(value) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(num % 1000000 === 0 ? 0 : 1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num);
}

function formatExactTokenCount(value) {
  const num = Number(value) || 0;
  return Math.round(num).toLocaleString();
}

function formatContextPercent(usedTokens, contextWindow) {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return '0.0%';
  return `${((usedTokens / contextWindow) * 100).toFixed(1)}%`;
}

function formatContextTrackerState(meta) {
  const normalized = normalizeContextTrackerMeta(meta);
  if (normalized.freshness === 'authoritative') return 'live';
  if (normalized.freshness === 'last-known') return 'last known';
  if (normalized.source === 'read-only') return 'read only';
  if (normalized.freshness === 'stale') return 'stale';
  if (normalized.isLiveThread) return 'live pending';
  return 'pending';
}

const CODEX_MODEL_PRICING = {
  'gpt-5.2-codex': { input: 1.75, cachedInput: 0.175, output: 14.00 },
  'gpt-5.1-codex-max': { input: 1.25, cachedInput: 0.125, output: 10.00 },
  'gpt-5.1-codex': { input: 1.25, cachedInput: 0.125, output: 10.00 },
  'gpt-5.1-codex-mini': { input: 0.25, cachedInput: 0.025, output: 2.00 },
  'gpt-5-codex': { input: 1.25, cachedInput: 0.125, output: 10.00 },
};

function getModelPricing(model) {
  const key = String(model || '').trim().toLowerCase();
  return CODEX_MODEL_PRICING[key] || null;
}

function itemHeadline(item) {
  if (!item) return { title: 'Codex is working…', detail: '' };
  const itemType = item.type === 'collabToolCall' ? 'collabAgentToolCall' : item.type;
  switch (itemType) {
    case 'commandExecution':
      {
        const summary = summarizeCommandExecution(item.command || '', item.cwd || '');
      return {
        title: summary.title,
        detail: cleanPreview(summary.detail),
      };
      }
    case 'mcpToolCall':
      return {
        title: `${item.server || 'MCP'} tool call`,
        detail: cleanPreview(`${item.server || 'MCP'} • ${item.tool || 'tool'}`),
      };
    case 'fileChange':
      return {
        title: 'Updating files',
        detail: Array.isArray(item.changes) && item.changes.length
          ? cleanPreview(item.changes.map((change) => change?.path || change?.filePath || change?.targetPath || '').filter(Boolean).join(', '))
          : 'Preparing file changes',
      };
    case 'reasoning':
      {
        const summaryText = Array.isArray(item.summary)
          ? item.summary.map((part) => typeof part === 'string' ? part : (part?.text || part?.summaryText || '')).filter(Boolean).join(' ')
          : (item.summaryText || item.summary_text || item.text || '');
        return {
          title: 'Reasoning summary',
          detail: cleanPreview(summaryText || 'Working through the next step'),
        };
      }
    case 'plan':
      return {
        title: 'Updating plan',
        detail: cleanPreview(item.text || 'Refreshing plan output'),
      };
    case 'agentMessage':
      return {
        title: item.phase === 'commentary' ? 'Writing commentary' : 'Writing response',
        detail: cleanPreview(item.text || 'Preparing the next reply'),
      };
    case 'dynamicToolCall':
      return {
        title: 'Running tool',
        detail: cleanPreview(item.tool || 'Dynamic tool call'),
      };
    case 'collabAgentToolCall':
      return {
        title: 'Delegating agent work',
        detail: cleanPreview(item.tool || 'Collaboration tool call'),
      };
    case 'webSearch':
      return {
        title: 'Searching the web',
        detail: cleanPreview(item.query || 'Web search'),
      };
    case 'imageGeneration':
      return {
        title: 'Generating image',
        detail: cleanPreview(item.revisedPrompt || item.result || 'Image generation'),
      };
    case 'imageView':
      return {
        title: 'Viewing image',
        detail: cleanPreview(item.path || 'Image view'),
      };
    case 'sleep':
      return {
        title: 'Waiting',
        detail: item.durationMs ? `Waiting ${formatElapsed(item.durationMs)}` : 'Waiting for the next step',
      };
    case 'hookPrompt':
      return {
        title: 'Applying hook prompt',
        detail: cleanPreview(Array.isArray(item.fragments) ? item.fragments.map((fragment) => fragment?.text || '').join(' ') : 'Injected hook prompt'),
      };
    case 'enteredReviewMode':
      return {
        title: 'Entered review mode',
        detail: cleanPreview(item.review || 'Review mode enabled'),
      };
    case 'exitedReviewMode':
      return {
        title: 'Exited review mode',
        detail: cleanPreview(item.review || 'Review mode completed'),
      };
    default:
      return {
        title: 'Codex is working…',
        detail: cleanPreview(item.type || ''),
      };
  }
}

export function normalizeSessionLabel(label) {
  return String(label || '').replace(/\s+/g, ' ').trim();
}

export function cleanPreview(text) {
  return normalizeSessionLabel(String(text || '').split('\n')[0] || '');
}

export function getThreadLabel(thread, fallback = 'New session') {
  return normalizeSessionLabel(thread?.name || cleanPreview(sanitizeCodexUserFacingText(thread?.preview)) || fallback);
}

export function projectItems() {
  return _projects.map((project) => ({
    value: project.path,
    label: project.label || basenamePath(project.path),
  }));
}

export function projectItemsForValue(value) {
  const items = projectItems();
  if (value && !items.some((item) => item.value === value)) {
    items.unshift({ value, label: basenamePath(value) || value });
  }
  return items;
}

function persistProjectThreads() {
  storage.setItem(STOR.projectThreads, JSON.stringify(_projectThreads));
}

export function getProjectThreadState(projectPath) {
  return (projectPath && _projectThreads[projectPath]) ? _projectThreads[projectPath] : {};
}

export function activeTab() {
  return _tabs[_activeTabIdx] || null;
}

export function allTabs() {
  return _tabs;
}

export function isActiveTab(tab) {
  return !!tab && activeTab() === tab;
}

export function syncLegacyState() {
  const tab = activeTab();
  if (!tab) return;
  if (tab.project) storage.setItem(STOR.project, tab.project);
  else storage.removeItem(STOR.project);
  if (tab.threadId) storage.setItem(STOR.threadId, tab.threadId);
  else storage.removeItem(STOR.threadId);
  if (tab.threadId && tab.sessionLabel) storage.setItem(STOR.title, tab.sessionLabel);
  else storage.removeItem(STOR.title);
}

export function saveProjectThreadState(projectPath, { threadId, title }) {
  if (!projectPath) return;
  const next = {};
  if (threadId) next.threadId = threadId;
  if (title) next.title = title;
  if (Object.keys(next).length) _projectThreads[projectPath] = next;
  else delete _projectThreads[projectPath];
  persistProjectThreads();
}

export function migrateLegacyThreadState(projectPath) {
  if (!projectPath || _projectThreads[projectPath]?.threadId) return;
  const legacyThreadId = storage.getItem(STOR.threadId);
  const legacyTitle = normalizeSessionLabel(storage.getItem(STOR.title) || '');
  if (!legacyThreadId && !legacyTitle) return;
  saveProjectThreadState(projectPath, {
    threadId: legacyThreadId || null,
    title: legacyTitle || null,
  });
}

function timestampMs(value) {
  if (value == null) return 0;
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num > 1e12 ? num : num * 1000;
}

function relDate(value) {
  const stamp = timestampMs(value);
  if (!stamp) return '';
  const diff = Date.now() - stamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(stamp).toLocaleDateString();
}

function fmtDate(value) {
  const stamp = timestampMs(value);
  if (!stamp) return '';
  const d = new Date(stamp);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    + ' at ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function timeGroup(value) {
  const stamp = timestampMs(value);
  if (!stamp) return 'Older';
  const diff = Date.now() - stamp;
  if (diff <= 0 || diff <= 86_400_000) return 'Today';
  if (diff <= 172_800_000) return 'Yesterday';
  if (diff <= 604_800_000) return 'This Week';
  return 'Older';
}

export function ddSetup(dd) {
  if (!dd) return;
  dd._value = dd._value || '';
  dd.addEventListener('click', (event) => {
    if (event.target.closest('.cxp-dd-item')) return;
    _getPanelEl()?.querySelectorAll('.cxp-dropdown.open').forEach((node) => {
      if (node !== dd) node.classList.remove('open');
    });
    dd.classList.toggle('open');
  });
}

export function ddPopulate(dd, items, selectedValue) {
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

export function ddGetValue(dd) {
  return dd?._value || '';
}

// ── State binding (lines 1423-1643) ──
export function snapshotBoundState() {
  return {
    boundTab: _boundTab,
    messagesEl: _messagesEl,
    ws: _ws,
    connected: _connected,
    bootstrapped: _bootstrapped,
    running: _running,
    activeTurnId: _activeTurnId,
    freshThread: _freshThread,
    threadId: _threadId,
    project: _project,
    accountId: _accountId,
    sessionListRequest: _sessionListRequest,
    threadStartRequest: _threadStartRequest,
    sessionLabel: _sessionLabel,
    renameRequests: _renameRequests,
    items: _items,
    requestCards: _requestCards,
    startingThread: _startingThread,
    trayPill: _trayPill,
    statusText: _statusText,
    statusTone: _statusTone,
    statusDetail: _statusDetail,
    turnStartedAt: _turnStartedAt,
    stepStartedAt: _stepStartedAt,
    currentStepKey: _currentStepKey,
    activeItems: _activeItems,
    activePlan: _activePlan,
    mcpServers: _mcpServers,
    threadActiveFlags: _threadActiveFlags,
    threadTokenUsage: _threadTokenUsage,
    threadContextMeta: _threadContextMeta,
    transcriptSourceType: _transcriptSourceType,
    transcriptItemCount: _transcriptItemCount,
    transcriptSourceUpdatedAt: _transcriptSourceUpdatedAt,
    compacting: _compacting,
    pendingReattach: _pendingReattach,
    pendingQueryRequestId: _pendingQueryRequestId,
    planFilePath: _planFilePath,
    planContent: _planContent,
    editedPlanContent: _editedPlanContent,
    showPostPlanActions: _showPostPlanActions,
    postPlanHeader: _postPlanHeader,
    planTurnActive: _planTurnActive,
    planApprovalPending: _planApprovalPending,
    lastPlanTurnId: _lastPlanTurnId,
    showPostCompactionPrompt: _showPostCompactionPrompt,
    postCompactionPending: _postCompactionPending,
    postCompactionPromptSource: _postCompactionPromptSource,
    manualCompactionPending: _manualCompactionPending,
    autoCompactionActive: _autoCompactionActive,
    autoCompactionNoticeShown: _autoCompactionNoticeShown,
    lastAutoCompactionCompleteAt: _lastAutoCompactionCompleteAt,
    blockingServerRequests: _blockingServerRequests,
    bufferedSocketMessages: _bufferedSocketMessages,
  };
}

export function restoreBoundState(state) {
  _boundTab = state.boundTab;
  _messagesEl = state.messagesEl;
  _ws = state.ws;
  _connected = state.connected;
  _bootstrapped = state.bootstrapped;
  _running = state.running;
  _activeTurnId = state.activeTurnId;
  _freshThread = state.freshThread;
  _threadId = state.threadId;
  _project = state.project;
  _accountId = state.accountId || 'default';
  _sessionListRequest = state.sessionListRequest;
  _threadStartRequest = state.threadStartRequest;
  _sessionLabel = state.sessionLabel;
  _renameRequests = state.renameRequests;
  _items = state.items;
  _requestCards = state.requestCards;
  _startingThread = state.startingThread;
  _trayPill = state.trayPill;
  _statusText = state.statusText;
  _statusTone = state.statusTone;
  _statusDetail = state.statusDetail;
  _turnStartedAt = state.turnStartedAt;
  _stepStartedAt = state.stepStartedAt;
  _currentStepKey = state.currentStepKey;
  _activeItems = state.activeItems;
  _activePlan = state.activePlan;
  _mcpServers = state.mcpServers;
  _threadActiveFlags = state.threadActiveFlags;
  _threadTokenUsage = normalizeThreadTokenUsage(state.threadTokenUsage);
  _threadContextMeta = normalizeContextTrackerMeta(state.threadContextMeta);
  _transcriptSourceType = normalizeSnapshotSourceType(state.transcriptSourceType);
  _transcriptItemCount = normalizeSnapshotItemCount(state.transcriptItemCount);
  _transcriptSourceUpdatedAt = Number(state.transcriptSourceUpdatedAt) || null;
  _compacting = !!state.compacting;
  _pendingReattach = !!state.pendingReattach;
  _pendingQueryRequestId = state.pendingQueryRequestId || null;
  _planFilePath = state.planFilePath || '';
  _planContent = state.planContent || '';
  _editedPlanContent = state.editedPlanContent || '';
  _showPostPlanActions = !!state.showPostPlanActions;
  _postPlanHeader = state.postPlanHeader || 'PLAN COMPLETE';
  _planTurnActive = !!state.planTurnActive;
  _planApprovalPending = !!state.planApprovalPending;
  _lastPlanTurnId = state.lastPlanTurnId || '';
  _showPostCompactionPrompt = !!state.showPostCompactionPrompt;
  _postCompactionPending = !!state.postCompactionPending;
  _postCompactionPromptSource = state.postCompactionPromptSource || '';
  if (_postCompactionPromptSource !== 'manual') {
    _showPostCompactionPrompt = false;
    _postCompactionPending = false;
  }
  _manualCompactionPending = !!state.manualCompactionPending;
  _autoCompactionActive = !!state.autoCompactionActive;
  _autoCompactionNoticeShown = !!state.autoCompactionNoticeShown;
  _lastAutoCompactionCompleteAt = Number(state.lastAutoCompactionCompleteAt) || 0;
  _blockingServerRequests = state.blockingServerRequests || new Map();
  _bufferedSocketMessages = Array.isArray(state.bufferedSocketMessages) ? state.bufferedSocketMessages : [];
}

export function commitBoundState() {
  if (!_boundTab) return;
  _boundTab.messagesEl = _messagesEl;
  _boundTab.ws = _ws;
  _boundTab.connected = _connected;
  _boundTab.bootstrapped = _bootstrapped;
  _boundTab.running = _running;
  _boundTab.activeTurnId = _activeTurnId;
  _boundTab.freshThread = _freshThread;
  _boundTab.threadId = _threadId;
  _boundTab.project = _project;
  _boundTab.accountId = _accountId;
  _boundTab.sessionListRequest = _sessionListRequest;
  _boundTab.threadStartRequest = _threadStartRequest;
  _boundTab.sessionLabel = _sessionLabel;
  _boundTab.renameRequests = _renameRequests;
  _boundTab.items = _items;
  _boundTab.requestCards = _requestCards;
  _boundTab.startingThread = _startingThread;
  _boundTab.pillEl = _trayPill;
  _boundTab.statusText = _statusText;
  _boundTab.statusTone = _statusTone;
  _boundTab.statusDetail = _statusDetail;
  _boundTab.turnStartedAt = _turnStartedAt;
  _boundTab.stepStartedAt = _stepStartedAt;
  _boundTab.currentStepKey = _currentStepKey;
  _boundTab.activeItems = _activeItems;
  _boundTab.activePlan = _activePlan;
  _boundTab.mcpServers = _mcpServers;
  _boundTab.threadActiveFlags = _threadActiveFlags;
  _boundTab.threadTokenUsage = normalizeThreadTokenUsage(_threadTokenUsage);
  _boundTab.threadContextMeta = normalizeContextTrackerMeta(_threadContextMeta);
  _boundTab.transcriptSourceType = _transcriptSourceType;
  _boundTab.transcriptItemCount = _transcriptItemCount;
  _boundTab.transcriptSourceUpdatedAt = _transcriptSourceUpdatedAt;
  _boundTab.compacting = _compacting;
  _boundTab.pendingReattach = _pendingReattach;
  _boundTab.pendingQueryRequestId = _pendingQueryRequestId;
  _boundTab.planFilePath = _planFilePath;
  _boundTab.planContent = _planContent;
  _boundTab.editedPlanContent = _editedPlanContent;
  _boundTab.showPostPlanActions = _showPostPlanActions;
  _boundTab.postPlanHeader = _postPlanHeader;
  _boundTab.planTurnActive = _planTurnActive;
  _boundTab.planApprovalPending = _planApprovalPending;
  _boundTab.lastPlanTurnId = _lastPlanTurnId;
  _boundTab.showPostCompactionPrompt = _showPostCompactionPrompt;
  _boundTab.postCompactionPending = _postCompactionPending;
  _boundTab.postCompactionPromptSource = _postCompactionPromptSource;
  _boundTab.manualCompactionPending = _manualCompactionPending;
  _boundTab.autoCompactionActive = _autoCompactionActive;
  _boundTab.autoCompactionNoticeShown = _autoCompactionNoticeShown;
  _boundTab.lastAutoCompactionCompleteAt = _lastAutoCompactionCompleteAt;
  _boundTab.blockingServerRequests = _blockingServerRequests;
  _boundTab.bufferedSocketMessages = _bufferedSocketMessages;
}

export function bindTabState(tab) {
  _boundTab = tab;
  _messagesEl = tab?.messagesEl || null;
  _ws = tab?.ws || null;
  _connected = !!tab?.connected;
  _bootstrapped = !!tab?.bootstrapped;
  _running = !!tab?.running;
  _activeTurnId = tab?.activeTurnId || null;
  _freshThread = !!tab?.freshThread;
  _threadId = tab?.threadId || null;
  _project = tab?.project || '';
  _accountId = tab?.accountId || 'default';
  _sessionListRequest = tab?.sessionListRequest || null;
  _threadStartRequest = tab?.threadStartRequest || null;
  _sessionLabel = tab?.sessionLabel || 'New session';
  _renameRequests = tab?.renameRequests || new Map();
  _items = tab?.items || new Map();
  _requestCards = tab?.requestCards || new Map();
  _startingThread = !!tab?.startingThread;
  _trayPill = tab?.pillEl || null;
  _statusText = tab?.statusText || 'Connecting to Codex…';
  _statusTone = tab?.statusTone || 'working';
  _statusDetail = tab?.statusDetail || '';
  _turnStartedAt = tab?.turnStartedAt || null;
  _stepStartedAt = tab?.stepStartedAt || null;
  _currentStepKey = tab?.currentStepKey || '';
  _activeItems = tab?.activeItems || new Map();
  _activePlan = Array.isArray(tab?.activePlan) ? tab.activePlan : [];
  _mcpServers = tab?.mcpServers || new Map();
  _threadActiveFlags = Array.isArray(tab?.threadActiveFlags) ? tab.threadActiveFlags : [];
  _threadTokenUsage = normalizeThreadTokenUsage(tab?.threadTokenUsage);
  _threadContextMeta = normalizeContextTrackerMeta(tab?.threadContextMeta);
  _transcriptSourceType = normalizeSnapshotSourceType(tab?.transcriptSourceType);
  _transcriptItemCount = normalizeSnapshotItemCount(tab?.transcriptItemCount);
  _transcriptSourceUpdatedAt = Number(tab?.transcriptSourceUpdatedAt) || null;
  _compacting = !!tab?.compacting;
  _pendingReattach = !!tab?.pendingReattach;
  _pendingQueryRequestId = tab?.pendingQueryRequestId || null;
  _planFilePath = tab?.planFilePath || '';
  _planContent = tab?.planContent || '';
  _editedPlanContent = tab?.editedPlanContent || '';
  _showPostPlanActions = !!tab?.showPostPlanActions;
  _postPlanHeader = tab?.postPlanHeader || 'PLAN COMPLETE';
  _planTurnActive = !!tab?.planTurnActive;
  _planApprovalPending = !!tab?.planApprovalPending;
  _lastPlanTurnId = tab?.lastPlanTurnId || '';
  _showPostCompactionPrompt = !!tab?.showPostCompactionPrompt;
  _postCompactionPending = !!tab?.postCompactionPending;
  _postCompactionPromptSource = tab?.postCompactionPromptSource || '';
  if (_postCompactionPromptSource !== 'manual') {
    _showPostCompactionPrompt = false;
    _postCompactionPending = false;
  }
  _manualCompactionPending = !!tab?.manualCompactionPending;
  _autoCompactionActive = !!tab?.autoCompactionActive;
  _autoCompactionNoticeShown = !!tab?.autoCompactionNoticeShown;
  _lastAutoCompactionCompleteAt = Number(tab?.lastAutoCompactionCompleteAt) || 0;
  _blockingServerRequests = tab?.blockingServerRequests || new Map();
  _bufferedSocketMessages = Array.isArray(tab?.bufferedSocketMessages) ? tab.bufferedSocketMessages : [];
}

export function restoreActiveBinding(fallbackState) {
  const current = activeTab();
  if (current) bindTabState(current);
  else restoreBoundState(fallbackState);
}

export function withTab(tab, fn) {
  const prev = snapshotBoundState();
  bindTabState(tab);
  try {
    return fn();
  } finally {
    commitBoundState();
    restoreActiveBinding(prev);
  }
}

export function setSessionLabel(label, { persist = true } = {}) {
  _sessionLabel = normalizeSessionLabel(sanitizeCodexUserFacingText(label)) || (_threadId ? 'Codex' : 'New session');
  if (_boundTab) _boundTab.sessionLabel = _sessionLabel;
  if (persist && _threadId) {
    saveProjectThreadState(_project, { threadId: _threadId, title: _sessionLabel });
  }
  if (isActiveTab(_boundTab)) {
    const labelEl = panelEl('#cxp-session-label');
    if (labelEl) labelEl.replaceChildren(document.createTextNode(_sessionLabel));
    syncLegacyState();
  }
  updateTrayPillLabel();
  if (_threadId) scheduleThreadSnapshotSave(_boundTab);
  saveTabs();
}

function markCodexSessionTitleManual(tab) {
  if (!tab) return;
  tab.titleRequestController?.abort();
  tab.titleRequestController = null;
  tab.titleRequestId = null;
  tab.titleState = 'manual';
}

function scheduleCodexTitleReassert(tab) {
  const desiredTitle = tab?.pendingSessionLabel || tab?.sessionLabel;
  if (!tab || tab.closed || !tab.threadId || !desiredTitle) return;
  if (!['auto', 'manual'].includes(tab.titleState)) return;
  if (!tab.providerTitleDirty) return;
  if (tab.titleReassertTimer) clearTimeout(tab.titleReassertTimer);
  tab.titleReassertTimer = setTimeout(() => {
    tab.titleReassertTimer = null;
    if (tab.closed || !tab.threadId || !tab.connected) return;
    requestSocketPayloadForTab(tab, 'thread_rename', {
      threadId: tab.threadId,
      name: tab.pendingSessionLabel || tab.sessionLabel,
    }).then(() => { tab.providerTitleDirty = false; }).catch(() => {});
  }, 200);
}

function applyCodexProviderTitle(title) {
  const tab = _boundTab;
  const incoming = normalizeSessionLabel(title || '');
  const desiredTitle = normalizeSessionLabel(tab?.pendingSessionLabel || tab?.sessionLabel || '');
  const authoritative = tab
    && (tab.titleState === 'auto' || (tab.titleState === 'manual' && hasCustomSessionLabel(tab)))
    && desiredTitle;
  if (authoritative && incoming && incoming !== desiredTitle) {
    tab.providerTitleDirty = true;
    scheduleCodexTitleReassert(tab);
    return;
  }
  if (tab) tab.providerTitleDirty = false;
  setSessionLabel(incoming || 'Codex');
  if (tab && tab.pendingSessionLabel === incoming) tab.pendingSessionLabel = null;
}

function requestCodexSessionTitle(tab, prompt, { paths = [], hasImages = false } = {}) {
  if (!tab || tab.closed || tab.automationActive || tab.titleState !== 'default') return;
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  tab.titleState = 'generating';
  tab.titleRequestId = requestId;
  tab.titleRequestController = controller;
  saveTabs();

  requestGeneratedSessionTitle({
    provider: 'codex',
    prompt,
    cwd: tab.project || undefined,
    model: tab.model || undefined,
    effort: tab.effort || undefined,
    accountId: tab.accountId || 'default',
    paths,
    hasImages,
  }, { signal: controller.signal }).then(({ title }) => {
    if (!title || tab.closed || !_tabs.includes(tab)) return;
    if (tab.titleState !== 'generating' || tab.titleRequestId !== requestId) return;
    tab.titleState = 'auto';
    tab.providerTitleDirty = false;
    tab.titleRequestId = null;
    tab.titleRequestController = null;
    tab.pendingSessionLabel = title;
    withTab(tab, () => setSessionLabel(title, { persist: !!tab.threadId }));
    if (tab.threadId && tab.connected) {
      requestSocketPayloadForTab(tab, 'thread_rename', {
        threadId: tab.threadId,
        name: title,
      }).then(() => {
        if (tab.titleState === 'auto' && tab.sessionLabel === title) tab.pendingSessionLabel = null;
      }).catch(() => {});
    }
    saveTabs();
  }).finally(() => {
    if (tab.titleRequestId !== requestId) return;
    tab.titleRequestController = null;
  });
}

// ── Tab CRUD (lines 4409-4710) ──
function createMessagesEl(tab) {
  const container = panelEl('#cxp-messages-container');
  if (!container) return null;
  const messages = document.createElement('div');
  messages.className = 'cxp-messages';
  messages.dataset.tabId = tab.id;
  messages.style.display = 'none';
  container.appendChild(messages);
  tab.scrollController = createStickyScrollController(messages, { active: false });
  return messages;
}

function hasMeaningfulTrayState(tab) {
  if (!tab) return false;
  const draft = normalizeSessionLabel(tab.draft || '');
  return !!(
    tab.threadId
    || hasCustomSessionLabel(tab)
    || tab.running
    || tab.startingThread
    || draft
    || tab.attachedImages?.length
    || tab.pendingPaths?.length
    || tab.pendingMentions?.length
    || tab.queue?.length
  );
}

function hasCustomSessionLabel(tab) {
  const label = normalizeSessionLabel(tab?.pendingSessionLabel || tab?.sessionLabel || '');
  if (!label) return false;
  return !['new session', 'saved session', 'untitled session', 'codex'].includes(label.toLowerCase());
}

function hasMeaningfulTabState(tab) {
  if (!tab) return false;
  return !!(
    hasMeaningfulTrayState(tab)
    || tab.planContent
    || tab.editedPlanContent
    || tab.showPostPlanActions
    || tab.planApprovalPending
    || tab.postCompactionPending
    || tab.items?.size
    || tab.activeItems?.size
    || tab.blockingServerRequests?.size
  );
}

function isDiscardableBlankTab(tab) {
  return !!tab && !hasMeaningfulTabState(tab);
}

function disposeDiscardedTab(tab) {
  if (!tab) return;
  flushThreadSnapshotSave(tab);
  disconnectTab(tab);
  tab.closed = true;
  if (tab.snapshotTimer) {
    clearTimeout(tab.snapshotTimer);
    tab.snapshotTimer = null;
  }
  tab.messagesEl?.remove();
  tab.pillEl?.remove();
}

function pruneDiscardableTabs({ keepTab = activeTab(), persist = false } = {}) {
  // Blank tabs are provisional composer state; inactive blanks have no tray affordance.
  let pruned = false;
  for (let idx = _tabs.length - 1; idx >= 0; idx -= 1) {
    const tab = _tabs[idx];
    if (tab === keepTab || !isDiscardableBlankTab(tab)) continue;
    disposeDiscardedTab(tab);
    _tabs.splice(idx, 1);
    if (_activeTabIdx > idx) _activeTabIdx -= 1;
    else if (_activeTabIdx >= _tabs.length) _activeTabIdx = _tabs.length - 1;
    pruned = true;
  }
  if (_activeTabIdx < 0 && _tabs.length) _activeTabIdx = 0;
  if (pruned) {
    renderPills();
    if (persist) saveTabs();
  }
  return pruned;
}

function isBlankTabRequest(saved = {}) {
  return !saved.threadId
    && !normalizeSessionLabel(saved.title || '')
    && !normalizeSessionLabel(saved.draft || '')
    && !saved.planContent
    && !saved.editedPlanContent
    && !saved.showPostPlanActions
    && !saved.planApprovalPending
    && !saved.showPostCompactionPrompt
    && !saved.postCompactionPending;
}

function createTrayPill(tab) {
  const tray = document.getElementById('term-minimized-tray');
  if (!tray) return null;
  const pill = document.createElement('div');
  pill.className = 'term-minimized-pill cxp-session-pill';
  pill.dataset.tabId = tab.id;
  pill.innerHTML = `
    <span class="term-minimized-pill-icon">${OPENAI_ICON}</span>
    <span class="term-minimized-pill-label">${esc(tab.sessionLabel || 'New session')}</span>
    <button class="term-minimized-pill-close" data-tooltip="Close" data-tooltip-pos="top">&times;</button>
  `;
  pill.addEventListener('click', async () => {
    const idx = _tabs.indexOf(tab);
    if (idx < 0) return;
    if (isClaudePanelOpen()) await toggleClaudePanel();
    if (isOpencodePanelOpen()) { try { await toggleOpencodePanel(); } catch {} }
    if (!_getVisible()) _setVisible(true);
    switchTab(idx);
  });
  pill.querySelector('.term-minimized-pill-close')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const idx = _tabs.indexOf(tab);
    if (idx >= 0) closeTab(idx);
  });
  pill.style.display = 'none';
  tray.appendChild(pill);
  return pill;
}

export function renderPills() {
  const active = activeTab();
  for (const tab of _tabs) {
    if (!tab.pillEl?.isConnected) tab.pillEl = createTrayPill(tab);
    if (!tab.pillEl) continue;
    // Read directly from tab to avoid nested withTab clobbering uncommitted state
    const label = tab.pillEl.querySelector('.term-minimized-pill-label');
    if (label) label.textContent = tab.sessionLabel || 'New session';
    tab.pillEl.classList.toggle('cxp-pill-running', !!(tab.running || tab.startingThread));
    const shouldShow = hasMeaningfulTrayState(tab) && (!_getVisible() || tab !== active);
    tab.pillEl.style.display = shouldShow ? '' : 'none';
  }
}

export function renderProjects() {
  const projectDropdown = panelEl('#cxp-project');
  if (!projectDropdown) return;
  ddPopulate(projectDropdown, projectItemsForValue(_project), _project);
}

export function updateActiveTabView() {
  const tab = activeTab();
  if (!_getPanelEl() || !tab) return;
  bindTabState(tab);
  _onActiveTabChanged?.(tab);
  _tabs.forEach((entry) => {
    if (entry.messagesEl) entry.messagesEl.style.display = entry === tab ? '' : 'none';
    entry.scrollController?.setActive(entry === tab);
  });
  renderProjects();
  loadBranchesIfNeeded(_project);
  setSessionLabel(_sessionLabel, { persist: false });
  setStatus(_statusText, _statusTone);
  const input = panelEl('#cxp-input');
  if (input) {
    input.value = tab.draft || '';
    autosizeInput();
  }
  syncInputEnabled();
  syncSessionControls();
  syncToolbarState();
  syncAccountChip();
  syncQueueTray();
  renderImageStrip();
  renderPathStrip();
  renderPills();
  syncLegacyState();
  if (_getVisible()) connectTab(tab);
}

export function switchTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const previous = activeTab();
  const next = _tabs[idx];
  const input = panelEl('#cxp-input');
  if (previous && input) {
    previous.draft = input.value;
    commitBoundState();
    flushThreadSnapshotSave(previous);
  }
  if (previous && previous !== next && !tabHasActiveWriterWork(previous)) {
    disconnectTab(previous);
  }
  _activeTabIdx = idx;
  updateActiveTabView();
  panelEl('#cxp-session-menu')?.classList.remove('open');
  saveTabs();
}

export function createTab(saved = {}, { autoSwitch = true } = {}) {
  if (autoSwitch && isBlankTabRequest(saved) && isDiscardableBlankTab(activeTab())) {
    return activeTab();
  }
  pruneDiscardableTabs({ keepTab: activeTab(), persist: false });
  const inheritedProject = saved.project ?? activeTab()?.project ?? (storage.getItem(STOR.project) || '');
  const threadId = saved.threadId || null;
  const title = normalizeSessionLabel(saved.title || '');
  const restoredTokenUsage = saved.threadTokenUsageReal === true
    ? normalizeThreadTokenUsage(saved.threadTokenUsage)
    : null;
  const restoredContextMeta = normalizeContextTrackerMeta(
    saved.threadContextMeta || (restoredTokenUsage
      ? { source: 'snapshot', freshness: 'last-known', updatedAt: Date.now() }
      : null),
  );
  const inheritedModel = saved.model ?? activeTab()?.model ?? (storage.getItem(STOR.model) || '');
  const restoredContextMode = normalizeCodexContextMode(saved.contextMode);
  const inheritedAccountId = saved.accountId ?? activeTab()?.accountId ?? 'default';
  const inheritedEffort = saved.effort ?? activeTab()?.effort ?? (storage.getItem(STOR.effort) || 'off');
  const inheritedAutoAccept = saved.autoAccept ?? activeTab()?.autoAccept ?? (storage.getItem(STOR.autoAccept) === 'true');
  const inheritedMcpProfile = saved.mcpProfile ?? null;
  const automationRunId = saved.automationRunId || null;
  const inheritedPlanMode = automationRunId ? false : (saved.planMode ?? activeTab()?.planMode ?? false);
  const hasExplicitTitle = !!title && !['new session', 'saved session', 'untitled session', 'codex'].includes(title.toLowerCase());
  const tab = {
    id: saved.id || crypto.randomUUID(),
    ws: null,
    connectionEpoch: null,
    connected: false,
    bootstrapped: false,
    running: false,
    activeTurnId: null,
    freshThread: !threadId,
    threadId,
    expectedThreadId: threadId,
    expectedThreadRequestId: null,
    reconnectTimer: null,
    project: inheritedProject,
    branch: saved.branch || '',
    accountId: inheritedAccountId,
    model: inheritedModel,
    contextMode: restoredContextMode,
    extendedContextStatus: restoredContextMode === 'extended' ? 'pending' : 'off',
    extendedContextActualWindow: null,
    extendedContextNoticeShown: false,
    extendedContextVerificationArmed: false,
    effort: inheritedEffort,
    autoAccept: inheritedAutoAccept,
    mcpProfile: inheritedMcpProfile,
    planMode: inheritedPlanMode,
    sessionListRequest: null,
    threadStartRequest: null,
    sessionLabel: title || (threadId ? 'Saved session' : 'New session'),
    titleState: saved.titleState === 'generating'
      ? 'default'
      : (saved.titleState || (threadId || hasExplicitTitle || saved.pendingSessionLabel ? 'manual' : 'default')),
    titleRequestId: null,
    titleRequestController: null,
    titleReassertTimer: null,
    providerTitleDirty: false,
    renameRequests: new Map(),
    items: new Map(),
    requestCards: new Map(),
    snapshotTimer: null,
    startingThread: false,
    pillEl: null,
    messagesEl: null,
    draft: saved.draft || '',
    statusText: 'Connecting to Codex…',
    statusTone: 'working',
    statusDetail: '',
    turnStartedAt: null,
    stepStartedAt: null,
    currentStepKey: '',
    activeItems: new Map(),
    activePlan: [],
    mcpServers: new Map(),
    threadActiveFlags: [],
    threadTokenUsage: restoredTokenUsage,
    threadContextMeta: restoredContextMeta,
    transcriptSourceType: '',
    transcriptItemCount: 0,
    transcriptSourceUpdatedAt: null,
    compacting: false,
    pendingReattach: !!saved.id,
    pendingQueryRequestId: null,
    planFilePath: automationRunId ? '' : (saved.planFilePath || ''),
    planContent: automationRunId ? '' : (saved.planContent || ''),
    editedPlanContent: automationRunId ? '' : (saved.editedPlanContent || ''),
    planFeedbackDraft: automationRunId ? '' : (saved.planFeedbackDraft || ''),
    showPostPlanActions: automationRunId ? false : !!saved.showPostPlanActions,
    postPlanHeader: saved.postPlanHeader || 'PLAN COMPLETE',
    planTurnActive: automationRunId ? false : !!saved.planTurnActive,
    planApprovalPending: automationRunId ? false : !!saved.planApprovalPending,
    lastPlanTurnId: automationRunId ? '' : (saved.lastPlanTurnId || ''),
    pendingSessionLabel: saved.pendingSessionLabel || null,  // authoritative name before thread exists; sent via thread_rename once ready
    showPostCompactionPrompt: saved.postCompactionPromptSource === 'manual' && !!saved.showPostCompactionPrompt,
    postCompactionPending: saved.postCompactionPromptSource === 'manual' && !!saved.postCompactionPending,
    postCompactionPromptSource: saved.postCompactionPromptSource === 'manual' ? 'manual' : '',
    manualCompactionPending: false,
    autoCompactionActive: false,
    autoCompactionNoticeShown: false,
    lastAutoCompactionCompleteAt: 0,
    closed: false,
    queue: [],
    queuePaused: false,
    attachedImages: [],
    pendingPaths: Array.isArray(saved.pendingPaths) ? saved.pendingPaths.filter(Boolean) : [],
    pendingMentions: Array.isArray(saved.pendingMentions)
      ? saved.pendingMentions.filter((mention) => mention?.path).map((mention) => ({ path: mention.path, name: mention.name || basenamePath(mention.path) }))
      : [],
    estimatedCost: 0,
    thinkingEl: null,
    thinkTimerInterval: null,
    blockingServerRequests: new Map(),
    bufferedSocketMessages: [],
    isolationRejections: {},
    ownedThreadIds: new Set(),
    automationRunId,
    automationActive: !!saved.automationActive,
    automationOwnerId: saved.automationOwnerId || null,
  };
  tab.messagesEl = createMessagesEl(tab);
  tab.pillEl = createTrayPill(tab);
  _tabs.push(tab);
  withTab(tab, () => {
    clearTranscript(startupEmptyText());
    if (_threadId) setStatus('Restoring Codex thread…', 'working');
    else if (_project) setStatus('Fresh thread ready', 'ready');
    else setStatus('Select a project', 'muted');
  });
  if (autoSwitch) switchTab(_tabs.length - 1);
  else {
    renderPills();
    saveTabs();
  }
  return tab;
}

export function closeActiveTab() {
  if (_activeTabIdx >= 0) closeTab(_activeTabIdx);
}

export function closeTab(idx, { detachAutomation = false } = {}) {
  if (idx < 0 || idx >= _tabs.length) return;
  const tab = _tabs[idx];
  if (tab.automationRunId && !detachAutomation) {
    window.dispatchEvent(new CustomEvent('native-loop:dismissed', {
      detail: { runId: tab.automationRunId },
    }));
    fetch('/api/loop/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: tab.automationRunId }),
    }).catch(() => {});
  }
  wsDisconnectTab(tab, { releaseWriter: !tabHasActiveWriterWork(tab) });
  tab.closed = true;
  tab.titleRequestController?.abort();
  tab.titleRequestController = null;
  if (tab.titleReassertTimer) clearTimeout(tab.titleReassertTimer);
  flushThreadSnapshotSave(tab);
  withTab(tab, () => {
    clearReconnectTimer(tab);
    _sessionListRequest?.reject(new Error('Codex tab closed'));
    _threadStartRequest?.reject(new Error('Codex tab closed'));
    _sessionListRequest = null;
    _threadStartRequest = null;
    for (const pending of _renameRequests.values()) pending.reject(new Error('Codex tab closed'));
    _renameRequests.clear();
    _ws = null;
    _connected = false;
    _bootstrapped = false;
    _running = false;
    _pendingReattach = false;
  });
  if (tab.snapshotTimer) {
    clearTimeout(tab.snapshotTimer);
    tab.snapshotTimer = null;
  }
  tab.scrollController?.destroy();
  tab.scrollController = null;
  tab.messagesEl?.remove();
  tab.pillEl?.remove();
  _tabs.splice(idx, 1);
  if (!_tabs.length) {
    _activeTabIdx = -1;
    saveTabs();
    renderPills();
    _setVisible(false);
    return;
  } else if (_activeTabIdx > idx) {
    _activeTabIdx -= 1;
  } else if (_activeTabIdx >= _tabs.length) {
    _activeTabIdx = _tabs.length - 1;
  }
  updateActiveTabView();
  saveTabs();
}

export function saveTabs() {
  try {
    commitBoundState();
    pruneDiscardableTabs({ keepTab: activeTab(), persist: false });
    const localTabs = _tabs.map((tab) => {
        const persistedTokenUsage = normalizeThreadTokenUsage(tab.threadTokenUsage);
        const persistedContextMeta = normalizeContextTrackerMeta(tab.threadContextMeta);
        return {
          id: tab.id,
          project: tab.project || '',
          branch: tab.branch || '',
          accountId: tab.accountId || 'default',
          threadId: tab.threadId || null,
          title: tab.sessionLabel || 'New session',
          titleState: tab.titleState === 'generating' ? 'default' : (tab.titleState || 'default'),
          pendingSessionLabel: tab.pendingSessionLabel || null,
          threadTokenUsage: persistedTokenUsage,
          threadTokenUsageReal: !!persistedTokenUsage,
          threadContextMeta: persistedContextMeta,
          draft: tab === activeTab()
            ? panelEl('#cxp-input')?.value || tab.draft || ''
            : tab.draft || '',
          pendingPaths: [...(tab.pendingPaths || [])],
          pendingMentions: (tab.pendingMentions || []).map((mention) => ({ path: mention.path, name: mention.name || '' })),
          model: tab.model || '',
          contextMode: normalizeCodexContextMode(tab.contextMode),
          effort: tab.effort || 'off',
          autoAccept: !!tab.autoAccept,
          mcpProfile: tab.mcpProfile || null,
          planMode: !!tab.planMode,
          planFilePath: tab.planFilePath || '',
          planContent: tab.planContent || '',
          editedPlanContent: tab.editedPlanContent || '',
          planFeedbackDraft: tab.planFeedbackDraft || '',
          showPostPlanActions: !!tab.showPostPlanActions,
          postPlanHeader: tab.postPlanHeader || 'PLAN COMPLETE',
          planTurnActive: !!tab.planTurnActive,
          planApprovalPending: !!tab.planApprovalPending,
          lastPlanTurnId: tab.lastPlanTurnId || '',
          showPostCompactionPrompt: tab.postCompactionPromptSource === 'manual' && !!tab.showPostCompactionPrompt,
          postCompactionPending: tab.postCompactionPromptSource === 'manual' && !!tab.postCompactionPending,
          postCompactionPromptSource: tab.postCompactionPromptSource === 'manual' ? 'manual' : '',
          automationRunId: tab.automationRunId || null,
          automationActive: !!tab.automationActive,
          automationOwnerId: tab.automationOwnerId || null,
        };
      });
    const localRunIds = new Set(localTabs.map((tab) => tab.automationRunId).filter(Boolean));
    let foreignAutomationTabs = [];
    try {
      const existing = JSON.parse(storage.getItem(STOR.tabs) || '{}');
      foreignAutomationTabs = (Array.isArray(existing?.tabs) ? existing.tabs : []).filter((tab) => (
        tab?.automationRunId
        && tab.automationOwnerId !== nativeLoopWindowId
        && !localRunIds.has(tab.automationRunId)
      ));
    } catch {}
    const payload = JSON.stringify({
      tabs: [...localTabs, ...foreignAutomationTabs],
      activeIdx: _activeTabIdx,
    });
    storage.setItem(STOR.tabs, payload);
    sessionStorage.removeItem(STOR.tabs);
    _updateCodexWindowRegistry();
  } catch {}
}

const CODEX_STALE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — matches Claude/OpenCode

function _updateCodexWindowRegistry() {
  try {
    const raw = storage.getItem(STOR.windowRegistry);
    const reg = raw ? JSON.parse(raw) : {};
    reg[windowId] = Date.now();
    storage.setItem(STOR.windowRegistry, JSON.stringify(reg));
  } catch {}
}

function _cleanStaleCodexWindows() {
  try {
    const raw = storage.getItem(STOR.windowRegistry);
    const reg = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    let mutated = false;
    for (const [wid, ts] of Object.entries(reg)) {
      if (wid === windowId) continue;
      if (now - ts > CODEX_STALE_WINDOW_MS) {
        storage.removeItem(`synabun-codex-panel-tabs-${wid}`);
        delete reg[wid];
        mutated = true;
      }
    }
    for (const k of (storage.keys?.() || [])) {
      if (!k.startsWith('synabun-codex-panel-tabs-')) continue;
      const wid = k.slice('synabun-codex-panel-tabs-'.length);
      if (wid === windowId) continue;
      if (!(wid in reg)) {
        storage.removeItem(k);
        mutated = true;
      }
    }
    if (mutated) storage.setItem(STOR.windowRegistry, JSON.stringify(reg));
  } catch {}
}

function _forkClonedCodexPersistence() {
  try {
    const data = JSON.parse(storage.getItem(STOR.tabs) || '{}');
    if (!Array.isArray(data?.tabs)) return;
    const isForeignActive = (tab) => tab?.automationActive
      && tab?.automationRunId
      && tab.automationOwnerId !== nativeLoopWindowId;
    if (!data.tabs.some(isForeignActive)) return;
    const transferable = data.tabs.filter((tab) => !isForeignActive(tab));
    const nextTabsKey = forkCodexWindowPersistence();
    if (transferable.length) {
      storage.setItem(nextTabsKey, JSON.stringify({ activeIdx: data.activeIdx || 0, tabs: transferable }));
    }
  } catch {}
}

_forkClonedCodexPersistence();
_cleanStaleCodexWindows();
_updateCodexWindowRegistry();

export function restoreTabs() {
  try {
    const raw = storage.getItem(STOR.tabs) || sessionStorage.getItem(STOR.tabs);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data?.tabs) && data.tabs.length) {
        for (const saved of data.tabs) {
          if (saved.automationActive && saved.automationOwnerId !== nativeLoopWindowId) continue;
          createTab(saved, { autoSwitch: false });
        }
        if (!_tabs.length) throw new Error('No restorable Codex tabs');
        _activeTabIdx = Math.min(Math.max(Number(data.activeIdx) || 0, 0), _tabs.length - 1);
        pruneDiscardableTabs({ keepTab: activeTab(), persist: false });
        if (!_tabs.length) throw new Error('No restorable Codex tabs');
        updateActiveTabView();
        saveTabs();
        return;
      }
    }
  } catch {}

  createTab({
    project: storage.getItem(STOR.project) || '',
    threadId: storage.getItem(STOR.threadId) || null,
    title: storage.getItem(STOR.title) || '',
  }, { autoSwitch: false });
  _activeTabIdx = 0;
  updateActiveTabView();
}

export function updateTrayPillLabel() {
  const label = _trayPill?.querySelector('.term-minimized-pill-label');
  if (label) label.textContent = _sessionLabel;
}

export function updateTrayPillRunning() {
  _trayPill?.classList.toggle('cxp-pill-running', !!(_running || _startingThread));
}


// ── Thread state (lines 4711-5000) ──
function hideEmpty() {
  const empty = _messagesEl?.querySelector('.cxp-empty');
  if (empty) empty.style.display = 'none';
}

function showEmpty(text) {
  const empty = _messagesEl?.querySelector('.cxp-empty');
  if (!empty) return;
  const statusEl = empty.querySelector('.cxp-empty-status');
  if (statusEl) statusEl.textContent = text;
  empty.style.display = '';
}

function freshThreadText() {
  return '';
}

function startupEmptyText() {
  if (_threadId) return 'Restoring Codex thread…';
  return '';
}

export function clearTranscript(emptyText = freshThreadText()) {
  if (!_messagesEl) return;
  _messagesEl.innerHTML = `<div class="cxp-empty"><div class="cxp-empty-logo">${OPENAI_ICON}</div><span class="cxp-empty-name">Codex</span><span class="cxp-empty-status"></span></div>`;
  document.dispatchEvent(new CustomEvent('cdx-empty-rebuilt'));
  _items.clear();
  _requestCards.clear();
  _blockingServerRequests = new Map();
  _bufferedSocketMessages = [];
  _activeItems = new Map();
  _activePlan = [];
  _threadActiveFlags = [];
  _threadTokenUsage = null;
  _threadContextMeta = defaultContextTrackerMeta();
  _transcriptSourceType = '';
  _transcriptItemCount = 0;
  _transcriptSourceUpdatedAt = null;
  _compacting = false;
  resetRuntimeCompactionState();
  _turnStartedAt = null;
  _stepStartedAt = null;
  _currentStepKey = '';
  _statusDetail = '';
  if (_boundTab) {
    _boundTab.activeItems = _activeItems;
    _boundTab.activePlan = _activePlan;
    _boundTab.blockingServerRequests = _blockingServerRequests;
    _boundTab.bufferedSocketMessages = _bufferedSocketMessages;
    _boundTab.threadActiveFlags = _threadActiveFlags;
    _boundTab.threadTokenUsage = _threadTokenUsage;
    _boundTab.threadContextMeta = _threadContextMeta;
    _boundTab.transcriptSourceType = _transcriptSourceType;
    _boundTab.transcriptItemCount = _transcriptItemCount;
    _boundTab.transcriptSourceUpdatedAt = _transcriptSourceUpdatedAt;
    _boundTab.compacting = _compacting;
    _boundTab.turnStartedAt = _turnStartedAt;
    _boundTab.stepStartedAt = _stepStartedAt;
    _boundTab.currentStepKey = _currentStepKey;
    _boundTab.statusDetail = _statusDetail;
  }
  showEmpty(emptyText);
  setCompactingUI(false);
  renderStatusChrome();
}

export function renderStoredTranscript(snapshot, emptyText = freshThreadText()) {
  if (!_messagesEl) return false;
  const normalized = normalizeThreadSnapshotEntry(snapshot, _threadId || null, _accountId || 'default');
  if (!normalized) return false;

  clearTranscript(emptyText);
  _messagesEl.innerHTML = normalized.html;
  const acceptedItemIds = new Set(normalized.acceptedItemIds);
  const acceptedTurnIds = new Set(normalized.acceptedTurnIds);
  const restoredNodes = [..._messagesEl.children].filter((node) => (
    !node.classList?.contains('cxp-empty') && !node.classList?.contains('cxp-thinking')
  ));
  const ownershipValid = codexTranscriptNodesHaveOwnership(restoredNodes, {
    threadId: normalized.threadId,
    accountId: normalized.accountId,
    acceptedItemIds,
    acceptedTurnIds,
  });
  if (!ownershipValid) {
    invalidateThreadSnapshot(normalized.threadId);
    clearTranscript(emptyText);
    return false;
  }
  sanitizeStoredTranscriptDom(_messagesEl);
  removePostPlanCards(_messagesEl);
  removePostCompactionCards(_messagesEl);
  _messagesEl.querySelectorAll('button,input,select,textarea').forEach((node) => { node.disabled = true; });
  // Restore expansion state when present; old snapshots default to collapsed cards.
  _messagesEl.querySelectorAll('.cxp-card').forEach((card) => {
    const expanded = card.dataset.expanded === '1';
    card.classList.toggle('cxp-collapsed', !expanded);
    if (!card.querySelector('.cxp-card-chevron')) {
      const head = card.querySelector('.cxp-card-head');
      if (head) { const ch = document.createElement('div'); ch.className = 'cxp-card-chevron'; head.appendChild(ch); }
    }
  });
  _messagesEl.querySelectorAll('details.cxp-reasoning, details.cxp-fold').forEach((details) => {
    if (details.dataset.expanded === '1') details.open = true;
    else if (details.dataset.expanded === '0') details.open = false;
  });

  if (_boundTab) {
    _boundTab.items = _items;
    _boundTab.requestCards = _requestCards;
  }

  if (_messagesEl.querySelector('.cxp-empty') && _messagesEl.children.length === 1) showEmpty(emptyText);
  else hideEmpty();
  setTranscriptSourceMeta({
    sourceType: 'snapshot',
    itemCount: normalized.itemCount || countRenderableTranscriptNodes(_messagesEl),
    sourceUpdatedAt: normalized.sourceUpdatedAt || normalized.updatedAt || Date.now(),
  });
  scrollEnd(true);
  return true;
}

export function persistThread(threadId) {
  _threadId = threadId || null;
  if (_boundTab) _boundTab.threadId = _threadId;
  if (isActiveTab(_boundTab)) syncLegacyState();
}

export function clearPendingRequests(message = 'Codex state reset') {
  _sessionListRequest?.reject(new Error(message));
  _threadStartRequest?.reject(new Error(message));
  _sessionListRequest = null;
  _threadStartRequest = null;
  _pendingQueryRequestId = null;
  for (const pending of _renameRequests.values()) pending.reject(new Error(message));
  _renameRequests.clear();
  clearAllBlockingServerRequests();
  syncPendingRequestRefs();
}

export function syncSessionControls() {
  if (!isActiveTab(_boundTab)) return;
  const rename = panelEl('#cxp-header-rename');
  if (rename) rename.disabled = false;
}

function syncPendingRequestRefs() {
  if (!_boundTab) return;
  _boundTab.sessionListRequest = _sessionListRequest;
  _boundTab.threadStartRequest = _threadStartRequest;
  _boundTab.renameRequests = _renameRequests;
}

export function resetThreadState({ tone = 'ready', preserveStatus = false } = {}) {
  flushThreadSnapshotSave(_boundTab);
  clearPendingRequests('Codex session reset');
  persistThread(null);
  _freshThread = true;
  _activeTurnId = null;
  _running = false;
  _startingThread = false;
  if (_boundTab) {
    _boundTab.ownedThreadIds = new Set();
    _boundTab.expectedThreadId = null;
    _boundTab.expectedThreadRequestId = null;
    _boundTab.titleRequestController?.abort();
    _boundTab.titleRequestController = null;
    _boundTab.titleRequestId = null;
    _boundTab.titleState = 'default';
    _boundTab.pendingSessionLabel = null;
    _boundTab.providerTitleDirty = false;
  }
  clearPlanHandoffState(_boundTab);
  clearPostCompactionState(_boundTab, { updateTranscript: false });
  setSessionLabel('New session', { persist: false });
  if (!preserveStatus) setStatus(_project ? 'Fresh thread ready' : 'Select a project', tone);
  clearTranscript();
  syncInputEnabled();
  syncSessionControls();
  renderPills();
  saveTabs();
}

export function setActiveProject(projectPath, { reset = true, preserveStatus = false, tone = 'ready' } = {}) {
  const nextProject = typeof projectPath === 'string' ? projectPath : '';
  const tab = activeTab();
  const changed = nextProject !== _project || (tab && tab.project !== nextProject);

  if (changed) releaseAutomationForManualUse(tab);

  _project = nextProject;
  if (tab) tab.project = nextProject;
  if (nextProject) storage.setItem(STOR.project, nextProject);
  else storage.removeItem(STOR.project);

  if (reset) {
    resetThreadState({ preserveStatus, tone });
  } else {
    syncLegacyState();
    syncInputEnabled();
    saveTabs();
  }

  if (changed && _connected && _ws?.readyState === WebSocket.OPEN) {
    sendSocket({ type: 'reset_thread' });
  }
  renderProjects();
  loadBranchesIfNeeded(_project, true);
  return changed;
}

export function restoreSavedThreadState() {
  migrateLegacyThreadState(_project);
  const saved = getProjectThreadState(_project);
  _threadId = saved.threadId || null;
  _freshThread = !_threadId;
  _sessionLabel = normalizeSessionLabel(saved.title) || (_threadId ? 'Saved session' : 'New session');
  setSessionLabel(_sessionLabel, { persist: false });
  syncSessionControls();
}

export function setThread(thread) {
  if (!thread?.id) return;
  persistThread(thread.id);
  _freshThread = false;
  setSessionLabel(getThreadLabel(thread, 'New session'));
  syncSessionControls();
}

export async function ensureProjectsLoaded() {
  if (_projectsLoaded) return;
  if (_projectsPromise) return _projectsPromise;
  _projectsPromise = (async () => {
    try {
      const data = await fetchProjects();
      _projects = Array.isArray(data?.projects) ? data.projects : [];
    } catch {
      _projects = [];
    }

    const items = projectItems();
    const savedProject = storage.getItem(STOR.project) || _project;
    const nextProject = items.find((item) => item.value === savedProject)?.value || items[0]?.value || savedProject || '';
    const tab = activeTab();
    if (tab && !_project && nextProject) {
      _project = nextProject;
      tab.project = nextProject;
      if (_project) storage.setItem(STOR.project, _project);
    }
    renderProjects();
    if (!_threadId && _messagesEl?.children.length === 0) {
      clearTranscript(freshThreadText());
    }
    _projectsLoaded = true;
    syncInputEnabled();
    saveTabs();
  })().finally(() => {
    _projectsPromise = null;
  });
  return _projectsPromise;
}

export function requestSocketPayload(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const packet = { type, requestId, ...payload };
    if (!_connected || _ws?.readyState !== WebSocket.OPEN) {
      reject(new Error('Codex is not connected'));
      return;
    }
    const entry = { requestId, resolve, reject };
    if (type === 'thread_list') {
      _sessionListRequest?.reject(new Error('Superseded by a newer thread list request'));
      _sessionListRequest = entry;
    }
    else if (type === 'thread_start') {
      _threadStartRequest?.reject(new Error('Superseded by a newer thread request'));
      _threadStartRequest = entry;
    }
    else _renameRequests.set(requestId, entry);
    syncPendingRequestRefs();
    if (!sendSocket(packet)) {
      if (type === 'thread_list' && _sessionListRequest?.requestId === requestId) _sessionListRequest = null;
      if (type === 'thread_start' && _threadStartRequest?.requestId === requestId) _threadStartRequest = null;
      _renameRequests.delete(requestId);
      syncPendingRequestRefs();
      reject(new Error('Codex is not connected'));
    }
  });
}

function requestSocketPayloadForTab(tab, type, payload = {}) {
  if (!tab || tab.closed) return Promise.reject(new Error('Codex tab is closed'));
  return withTab(tab, () => requestSocketPayload(type, payload));
}

async function startNewThread(tab = activeTab()) {
  if (!tab) return;
  let requestPromise = null;
  withTab(tab, () => {
    if (_running || _startingThread) return;
    if (!_project) {
      setStatus('Select a project', 'error');
      return;
    }
    if (!_connected || !_bootstrapped || _ws?.readyState !== WebSocket.OPEN) {
      setStatus('Codex is not connected', 'error');
      return;
    }
    _startingThread = true;
    markExtendedContextPending(tab);
    tab.extendedContextVerificationArmed = normalizeCodexContextMode(tab.contextMode) === 'extended';
    syncWorkStatus();
    syncInputEnabled();
    syncToolbarState();
    syncSessionControls();
    requestPromise = requestSocketPayload('thread_start', {
      cwd: _project || null,
      ...codexRuntimeSelection(tab),
    });
  });
  if (!requestPromise) return;
  try {
    const data = await requestPromise;
    if (tab.closed) return;
    withTab(tab, () => {
      releaseAutomationForManualUse(tab);
      clearPostCompactionState(_boundTab, { updateTranscript: false });
      clearTranscript(freshThreadText());
      if (data?.thread) setThread(data.thread);
      if (activeTab() === tab && panelEl('#cxp-session-menu')?.classList.contains('open')) renderSessionMenu();
      if (!_running) setStatus('Ready', 'ready');
    });
  } catch (err) {
    if (!tab.closed) withTab(tab, () => {
      appendSystem(err.message || 'Could not create Codex session', 'error');
      setStatus(err.message || 'Could not create Codex session', 'error');
    });
  } finally {
    if (!tab.closed) withTab(tab, () => {
      _startingThread = false;
      syncInputEnabled();
      syncToolbarState();
      syncSessionControls();
      updateTrayPillRunning();
      renderPills();
      saveTabs();
      releaseInactiveIdleTab(tab);
    });
  }
}

// ── Codex session menu state ──
const CXP_ARCHIVE_PREFIX = 'synabun-session-archived:';
function cxpArchiveStorageKey(id, accountId = 'default') {
  return `${CXP_ARCHIVE_PREFIX}${accountId || 'default'}:${id}`;
}
function cxpIsArchived(id, accountId = 'default') {
  try {
    return storage.getItem(cxpArchiveStorageKey(id, accountId)) === '1'
      || storage.getItem(CXP_ARCHIVE_PREFIX + id) === '1';
  } catch { return false; }
}
function cxpSetArchived(id, val, accountId = 'default') {
  try {
    const key = cxpArchiveStorageKey(id, accountId);
    if (val) storage.setItem(key, '1');
    else {
      storage.removeItem(key);
      storage.removeItem(CXP_ARCHIVE_PREFIX + id);
    }
  } catch {}
}

let _cxpSessSearch = '';
let _cxpSessDebounce = null;
let _cxpSessHideEmpty = false;
let _cxpSessShowArchived = false;
let _cxpSessAllThreads = [];   // all threads from WebSocket
let _cxpSessRendered = 0;      // how many rendered so far (virtual pagination)
let _cxpSessObserver = null;
let _cxpFtsMatchIds = null;    // Set<threadId> of FTS5 body-match hits (null = not queried yet)
let _cxpFtsQuery = '';         // last query used for _cxpFtsMatchIds
const CXP_SESS_PAGE = 20;
const CXP_SESS_FETCH_LIMIT = 250;
const CXP_SESS_FETCH_MAX = 10000;

async function fetchSessionThreads(cwd, tab = activeTab()) {
  if (!tab) throw new Error('Codex tab is unavailable');
  const threads = [];
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const data = await requestSocketPayloadForTab(tab, 'thread_list', {
      cwd,
      limit: CXP_SESS_FETCH_LIMIT,
      cursor,
      includeArchived: true,
    });
    for (const thread of (Array.isArray(data?.threads) ? data.threads : [])) {
      if (!thread?.id) continue;
      const key = `${thread.accountId || 'default'}:${thread.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      threads.push(thread);
      if (threads.length >= CXP_SESS_FETCH_MAX) break;
    }
    cursor = data?.nextCursor || null;
    pages += 1;
  } while (cursor && threads.length < CXP_SESS_FETCH_MAX && pages < 40);
  return threads;
}

function cxpSessApplyFilters(threads) {

// ── Session menu (lines 5000-5428) ──
  return threads.filter(t => {
    const archived = !!t.archived || cxpIsArchived(t.id, t.accountId || 'default');
    if (_cxpSessShowArchived ? !archived : archived) return false;
    if (_cxpSessHideEmpty) {
      const label = getThreadLabel(t, '');
      if (!label || label === 'Untitled session') return false;
    }
    if (_cxpSessSearch) {
      const q = _cxpSessSearch.toLowerCase();
      const label = getThreadLabel(t, '').toLowerCase();
      const source = (typeof t.source === 'string' ? t.source : t.source?.custom || '').toLowerCase();
      const account = String(t.accountLabel || (t.accountId ? accountLabelFor(t.accountId) : '') || '').toLowerCase();
      const labelHit = label.includes(q) || source.includes(q) || account.includes(q) || (t.id || '').toLowerCase().includes(q);
      // FTS5 body match (async-populated) lets us match threads whose title doesn't
      // include the query but whose message body does.
      const ftsHit = _cxpFtsMatchIds && _cxpFtsQuery === _cxpSessSearch && _cxpFtsMatchIds.has(t.id);
      if (!labelHit && !ftsHit) return false;
    }
    return true;
  });
}

function cxpSessRenderItem(thread, tab, menu) {
  const label = getThreadLabel(thread, 'Untitled session') || 'Untitled session';
  const source = typeof thread.source === 'string'
    ? thread.source
    : thread.source?.custom || (thread.source?.subAgent ? 'sub-agent' : 'unknown');
  const rowAccountId = thread.accountId || '';
  const accountLabel = thread.accountLabel || (rowAccountId ? accountLabelFor(rowAccountId) : '');
  const isForeignAccount = rowAccountId && rowAccountId !== (_accountId || 'default');
  const sourceLabel = accountLabel && isForeignAccount
    ? `${source} · ${accountLabel}`
    : source;
  const active = thread.id === _threadId && (!rowAccountId || rowAccountId === (_accountId || 'default')) ? ' active' : '';
  const archived = !!thread.archived || cxpIsArchived(thread.id, rowAccountId || 'default');
  const archivedClass = archived ? ' cxp-sess-item--archived' : '';

  const item = document.createElement('div');
  item.className = `cxp-sess-item${active}${archivedClass}`;
  item.dataset.sid = thread.id;

  // Tooltip: full title + date, positioned left of the dropdown
  if (label && label !== 'Untitled session') {
    const dateStr = fmtDate(thread.updatedAt || thread.createdAt);
    item.setAttribute('data-tooltip', dateStr ? label + '\n' + dateStr : label);
    item.setAttribute('data-tooltip-pos', 'left');
  }

  const archiveBtn = isForeignAccount
    ? ''
    : (archived
        ? `<button class="cxp-sess-unarchive-btn" data-sid="${esc(thread.id)}" title="Unarchive">&#x21A9;</button>`
        : `<button class="cxp-sess-archive-btn" data-sid="${esc(thread.id)}" title="Archive">&#x2716;</button>`);
  const renameBtn = isForeignAccount
    ? ''
    : `<button class="cxp-sess-rename" type="button" data-sid="${esc(thread.id)}" title="Rename session">${ICON_EDIT}</button>`;

  item.innerHTML = `
    <div class="cxp-sess-prompt">${esc(label)}</div>
    <div class="cxp-sess-meta">
      <span>${esc(relDate(thread.updatedAt || thread.createdAt) || 'recent')}</span>
      <span class="cxp-sess-source">${esc(sourceLabel)}</span>
    </div>
    <div class="cxp-sess-actions-inline">
      ${archiveBtn}
      ${renameBtn}
    </div>
  `;

  // Click to resume
  item.addEventListener('click', (event) => {
    if (event.target?.closest('.cxp-sess-actions-inline')) return;
    if (item.querySelector('.cxp-rename-input')) return;
    const threadId = item.dataset.sid;
    if (!threadId) return;
    const targetAccountId = thread.accountId || tab.accountId || 'default';
    const targetCwd = thread.cwd || tab.project || null;
    const resumeToken = crypto.randomUUID();
    tab._sessionResumeToken = resumeToken;
    let shouldSwitchAccount = false;
    const canResume = withTab(tab, () => {
      if (_running) return false;
      menu.classList.remove('open');
      clearPostCompactionState(tab, { updateTranscript: false });
      clearTranscript('Restoring Codex thread…');
      shouldSwitchAccount = targetAccountId !== (_accountId || 'default');
      if (shouldSwitchAccount) {
        const accountLabel = thread.accountLabel || accountLabelFor(targetAccountId);
        setStatus(`Switching to ${accountLabel}…`, 'working');
      }
      return true;
    });
    if (!canResume) return;

    (async () => {
      try {
        if (shouldSwitchAccount) {
          await requestSocketPayloadForTab(tab, 'account_switch', { accountId: targetAccountId });
        }
        if (tab.closed || tab._sessionResumeToken !== resumeToken) return;
        withTab(tab, () => {
          tab.expectedThreadId = threadId;
          markExtendedContextPending(tab);
          tab.extendedContextVerificationArmed = normalizeCodexContextMode(tab.contextMode) === 'extended';
          if (!sendSocket({
            type: 'thread_resume',
            threadId,
            cwd: targetCwd,
            ...codexRuntimeSelection(tab),
          })) {
            tab.expectedThreadId = null;
            setStatus('Codex is not connected', 'error');
            return;
          }
          releaseAutomationForManualUse(tab);
          persistThread(threadId);
          _freshThread = false;
          if (_boundTab) {
            _boundTab.accountId = targetAccountId;
            _boundTab.freshThread = false;
            _boundTab.ownedThreadIds = new Set();
          }
          setSessionLabel(label, { persist: true });
          setStatus('Restoring Codex thread…', 'working');
          saveTabs();
        });
      } catch (err) {
        if (!tab.closed && tab._sessionResumeToken === resumeToken) withTab(tab, () => {
          appendSystem(err.message || 'Could not switch account', 'error');
          setStatus(err.message || 'Could not switch account', 'error');
        });
      }
    })();
  });

  // Archive / unarchive
  const archBtn = item.querySelector('.cxp-sess-archive-btn, .cxp-sess-unarchive-btn');
  archBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await requestSocketPayloadForTab(tab, archived ? 'thread_unarchive' : 'thread_archive', { threadId: thread.id });
      cxpSetArchived(thread.id, !archived, rowAccountId || 'default');
      item.remove();
    } catch (err) {
      if (!tab.closed) withTab(tab, () => appendSystem(`${archived ? 'Restore' : 'Archive'} failed: ${err.message}`, 'error'));
    }
  });

  // Rename
  const renBtn = item.querySelector('.cxp-sess-rename');
  renBtn?.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  renBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    const threadId = renBtn.dataset.sid;
    const promptEl = item.querySelector('.cxp-sess-prompt');
    if (!promptEl || promptEl.querySelector('.cxp-rename-input')) return;
    const currentLabel = normalizeSessionLabel(promptEl.textContent);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cxp-rename-input';
    input.value = currentLabel;
    promptEl.replaceChildren(input);
    renBtn.style.display = 'none';
    input.focus();
    input.select();

    let done = false;
    const finish = async (cancel = false) => {
      if (done) return;
      done = true;
      const nextLabel = normalizeSessionLabel(input.value);
      if (cancel || !nextLabel || nextLabel === currentLabel) {
        promptEl.textContent = currentLabel;
        renBtn.style.display = '';
        return;
      }
      try {
        await requestSocketPayloadForTab(tab, 'thread_rename', { threadId, name: nextLabel });
        if (!tab.closed) withTab(tab, () => {
          promptEl.textContent = nextLabel;
          renBtn.style.display = '';
          if (threadId === _threadId) {
            markCodexSessionTitleManual(tab);
            tab.pendingSessionLabel = nextLabel;
            setSessionLabel(nextLabel);
          }
        });
      } catch (err) {
        promptEl.textContent = currentLabel;
        renBtn.style.display = '';
        withTab(tab, () => appendSystem(err.message || 'Could not rename Codex thread', 'error'));
      }
    };

    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(true); }
    });
  });

  return item;
}

function cxpSessRenderBatch(threads, listEl, tab, menu, startIdx, count) {
  const batch = threads.slice(startIdx, startIdx + count);
  let lastGroup = '';
  // Find the last group header already rendered
  const existingGroups = listEl.querySelectorAll('.cxp-sess-group');
  if (existingGroups.length) lastGroup = existingGroups[existingGroups.length - 1].textContent;

  for (const thread of batch) {
    const group = timeGroup(thread.updatedAt || thread.createdAt);
    if (group !== lastGroup) {
      lastGroup = group;
      const groupEl = document.createElement('div');
      groupEl.className = 'cxp-sess-group';
      groupEl.textContent = group;
      listEl.appendChild(groupEl);
    }
    listEl.appendChild(cxpSessRenderItem(thread, tab, menu));
  }
  return batch.length;
}

export function cxpSessRebuildList(menu, listEl, tab) {
  listEl.innerHTML = '';
  _cxpSessRendered = 0;
  const filtered = cxpSessApplyFilters(_cxpSessAllThreads);
  if (!filtered.length) {
    listEl.innerHTML = '<div class="cxp-sess-empty">No matching sessions</div>';
    const sentinel = menu.querySelector('.cxp-sess-sentinel');
    if (sentinel) sentinel.innerHTML = '';
    return;
  }
  const count = cxpSessRenderBatch(filtered, listEl, tab, menu, 0, CXP_SESS_PAGE);
  _cxpSessRendered = count;
  // Update sentinel
  const sentinel = menu.querySelector('.cxp-sess-sentinel');
  if (sentinel) {
    sentinel.innerHTML = _cxpSessRendered >= filtered.length
      ? (filtered.length > CXP_SESS_PAGE ? '<div class="cxp-sess-no-more">all sessions loaded</div>' : '')
      : '';
  }
}

// ═══════════════════════════════════════════
//  Multi-account (per-tab ChatGPT account)
// ═══════════════════════════════════════════

function accountLabelFor(id) {
  const acct = _codexAccounts.find((a) => a.id === id);
  return acct ? (acct.label || acct.email || (acct.isDefault ? 'Default' : 'account')) : (id === 'default' ? 'Default' : 'account');
}

export function syncAccountChip() {
  const labelEl = panelEl('#cxp-account-label');
  const btn = panelEl('#cxp-account-btn');
  if (!labelEl || !btn) return;
  const tab = activeTab();
  const acctId = tab?.accountId || _accountId || 'default';
  const acct = _codexAccounts.find((a) => a.id === acctId);
  labelEl.textContent = acct
    ? (acct.label || acct.email || (acct.isDefault ? 'Default' : 'Account'))
    : (acctId === 'default' ? 'Default' : 'Account');
  btn.title = acct?.email
    ? `Account: ${acct.email}${acct.planType ? ` (${acct.planType})` : ''} — click to switch`
    : 'Switch ChatGPT account for this tab';
}

export function refreshCodexAccounts() {
  requestSocketPayload('account_list', {})
    .then((msg) => {
      if (Array.isArray(msg?.accounts)) {
        _codexAccounts = msg.accounts;
        syncAccountChip();
      }
    })
    .catch(() => {});
}

function resetViewForAccountChange(label) {
  _threadId = null;
  _freshThread = true;
  if (_boundTab) {
    _boundTab.threadId = null;
    _boundTab.freshThread = true;
    _boundTab.titleRequestController?.abort();
    _boundTab.titleRequestController = null;
    _boundTab.titleRequestId = null;
    _boundTab.titleState = 'default';
    _boundTab.pendingSessionLabel = null;
    _boundTab.providerTitleDirty = false;
  }
  setSessionLabel('New session', { persist: false });
  clearTranscript(freshThreadText());
  if (label) setStatus(label, 'ready');
}

function applyAccountReadToCache(accountId, readResult) {
  const info = readResult?.account || readResult || {};
  const acct = _codexAccounts.find((a) => a.id === accountId);
  if (acct && info.email) {
    acct.email = info.email;
    acct.planType = info.planType || acct.planType;
    if (!acct.label || acct.label === 'New account') acct.label = info.email;
  }
}

function handleAccountMessage(msg) {
  if (Array.isArray(msg.accounts)) _codexAccounts = msg.accounts;
  if (msg.type === 'account_info' && msg.account) {
    applyAccountReadToCache(msg.accountId || _accountId || 'default', msg.account);
  }
  if (msg.type === 'account_switched' && msg.account) {
    applyAccountReadToCache(msg.accountId || _accountId || 'default', msg.account);
  }
  if (msg.type === 'account_switched' && msg.accountId) {
    _accountId = msg.accountId;
    if (_boundTab) _boundTab.accountId = msg.accountId;
    saveTabs();
    resetViewForAccountChange(`Switched to ${accountLabelFor(msg.accountId)}`);
    _modelListCacheByAccount.delete(String(msg.accountId));
    _modelListRequestByAccount.delete(String(msg.accountId));
    requestModelList();
  }
  if (msg.type === 'account_add_started') {
    if (msg.accountId) {
      _accountId = msg.accountId;
      if (_boundTab) _boundTab.accountId = msg.accountId;
      saveTabs();
    }
    resetViewForAccountChange('');
    appendSystem('Opening ChatGPT login in your browser… complete sign-in, then return here. The account name updates automatically once you finish.', 'working');
  }
  syncAccountChip();
  const menu = panelEl('#cxp-account-menu');
  if (menu?.classList.contains('open')) renderAccountMenu();
}

export function toggleAccountMenu() {
  const menu = panelEl('#cxp-account-menu');
  if (!menu) return;
  const isOpen = menu.classList.toggle('open');
  if (isOpen) { renderAccountMenu(); refreshCodexAccounts(); }
}

function renderAccountMenu() {
  const menu = panelEl('#cxp-account-menu');
  if (!menu) return;
  const tab = activeTab();
  const activeAcctId = tab?.accountId || _accountId || 'default';
  menu.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'cxp-account-list';
  if (!_codexAccounts.length) {
    const empty = document.createElement('div');
    empty.className = 'cxp-account-empty';
    empty.textContent = 'Loading accounts…';
    list.appendChild(empty);
  }
  for (const acct of _codexAccounts) {
    const row = document.createElement('div');
    row.className = 'cxp-account-row' + (acct.id === activeAcctId ? ' active' : '');
    const main = document.createElement('button');
    main.className = 'cxp-account-row-main';
    main.type = 'button';
    const sub = acct.email && acct.email !== acct.label
      ? `<span class="cxp-account-row-sub">${esc(acct.email)}${acct.planType ? ` · ${esc(acct.planType)}` : ''}</span>`
      : (acct.planType ? `<span class="cxp-account-row-sub">${esc(acct.planType)}</span>` : '');
    main.innerHTML = `
      <span class="cxp-account-check">${acct.id === activeAcctId ? '&#x2713;' : ''}</span>
      <span class="cxp-account-row-text">
        <span class="cxp-account-row-label">${esc(acct.label || acct.email || (acct.isDefault ? 'Default' : 'Account'))}</span>
        ${sub}
      </span>`;
    main.addEventListener('click', () => { menu.classList.remove('open'); switchToAccount(acct.id); });
    row.appendChild(main);
    if (!acct.isDefault) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'cxp-account-row-remove';
      removeBtn.type = 'button';
      removeBtn.title = 'Remove account';
      removeBtn.innerHTML = '&#x2715;';
      removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeCodexAccount(acct.id); });
      row.appendChild(removeBtn);
    }
    list.appendChild(row);
  }
  menu.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.className = 'cxp-account-add';
  addBtn.type = 'button';
  addBtn.textContent = '+ Add ChatGPT account…';
  addBtn.addEventListener('click', () => { menu.classList.remove('open'); addCodexAccount(); });
  menu.appendChild(addBtn);
}

async function switchToAccount(accountId) {
  const tab = activeTab();
  if (!tab) return;
  if ((tab.accountId || 'default') === accountId) return;
  if (tab.running) { appendSystem('Finish or stop the current turn before switching accounts.', 'error'); return; }
  try {
    setStatus('Switching account…', 'working');
    await requestSocketPayloadForTab(tab, 'account_switch', { accountId });
    // account_switched push (handled in handleAccountMessage) updates the view.
  } catch (err) {
    if (!tab.closed) withTab(tab, () => {
      appendSystem(err.message || 'Could not switch account', 'error');
      setStatus(err.message || 'Switch failed', 'error');
    });
  }
}

async function addCodexAccount() {
  const tab = activeTab();
  if (!tab) return;
  if (tab.running) { appendSystem('Finish or stop the current turn before adding an account.', 'error'); return; }
  try {
    setStatus('Starting ChatGPT login…', 'working');
    const result = await requestSocketPayloadForTab(tab, 'account_add_start', {});
    if (Array.isArray(result?.accounts)) _codexAccounts = result.accounts;
    const authUrl = result?.login?.login?.authUrl || result?.login?.authUrl;
    if (authUrl) window.open(authUrl, '_blank', 'noopener,noreferrer');
    if (isActiveTab(tab)) syncAccountChip();
  } catch (err) {
    if (!tab.closed) withTab(tab, () => {
      appendSystem(err.message || 'Could not start login', 'error');
      setStatus(err.message || 'Login failed', 'error');
    });
  }
}

async function removeCodexAccount(accountId) {
  if (accountId === 'default') return;
  if (!window.confirm('Remove this ChatGPT account from SynaBun? You can re-add it later by signing in again.')) return;
  const tab = activeTab();
  if (!tab) return;
  const wasActive = tab && (tab.accountId || 'default') === accountId;
  try {
    const result = await requestSocketPayloadForTab(tab, 'account_remove', { accountId });
    if (Array.isArray(result?.accounts)) _codexAccounts = result.accounts;
    if (wasActive && !tab.closed) {
      withTab(tab, () => {
        _accountId = 'default';
        tab.accountId = 'default';
        saveTabs();
        resetViewForAccountChange('Switched to Default');
      });
    }
    if (isActiveTab(tab)) syncAccountChip();
    const menu = panelEl('#cxp-account-menu');
    if (menu?.classList.contains('open')) renderAccountMenu();
  } catch (err) {
    if (!tab.closed) withTab(tab, () => appendSystem(err.message || 'Could not remove account', 'error'));
  }
}

export async function renderSessionMenu() {
  const tab = activeTab();
  const menu = panelEl('#cxp-session-menu');
  if (!menu || !tab) return;
  const project = tab.project || '';
  if (!project) {
    menu.innerHTML = '<div class="cxp-sess-empty">Select a project first.</div>';
    return;
  }
  if (!tab.connected || tab.ws?.readyState !== WebSocket.OPEN) {
    menu.innerHTML = '<div class="cxp-sess-empty">Connecting to Codex…</div>';
    return;
  }

  // Disconnect old observer
  if (_cxpSessObserver) { _cxpSessObserver.disconnect(); _cxpSessObserver = null; }

    // Reset virtual pagination
    _cxpSessRendered = 0;

    // Build skeleton
    menu.innerHTML = '';

    // ── Search bar ──
    const searchEl = document.createElement('div');
    searchEl.className = 'cxp-sess-search';
    searchEl.innerHTML = `
      <div class="cxp-sess-search-row">
        <div class="cxp-sess-search-wrap">
          <svg class="cxp-sess-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="cxp-sess-search-input" placeholder="Search sessions..." value="${esc(_cxpSessSearch)}" autocomplete="off" spellcheck="false">
        </div>
        <button class="cxp-sess-refresh-btn" title="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        </button>
      </div>
      <div class="cxp-sess-filters">
        <div class="cxp-sess-filter-pill${_cxpSessHideEmpty ? ' active' : ''}" data-filter="empty">Hide empty</div>
        <div class="cxp-sess-filter-pill${_cxpSessShowArchived ? ' active' : ''}" data-filter="archived">Archived</div>
      </div>
    `;
    menu.appendChild(searchEl);

    // ── New session + fork/archive current ──
    const newBtn = document.createElement('div');
    newBtn.className = 'cxp-sess-new';
    newBtn.textContent = '+ New session';
    newBtn.addEventListener('click', () => { menu.classList.remove('open'); startNewThread(); });
    menu.appendChild(newBtn);

    const currentThreadId = tab.threadId || null;
    const currentSessionLabel = tab.sessionLabel || 'Codex';
    const currentAccountId = tab.accountId || 'default';
    if (currentThreadId) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'cxp-sess-actions';
      actionsEl.innerHTML = `
        <button class="cxp-btn cxp-btn-sm cxp-sess-fork" title="Fork current thread">Fork</button>
        <button class="cxp-btn cxp-btn-sm cxp-sess-archive-current" title="Archive current thread">Archive</button>
      `;
      menu.appendChild(actionsEl);

      actionsEl.querySelector('.cxp-sess-fork')?.addEventListener('click', async () => {
        menu.classList.remove('open');
        if (tab.closed) return;
        withTab(tab, () => appendSystem('Forking thread…', 'working'));
        try {
          const result = await requestSocketPayloadForTab(tab, 'thread_fork', { threadId: currentThreadId });
          const forked = result?.thread;
          if (forked?.id && !tab.closed) withTab(tab, () => {
            createTab({ project, threadId: forked.id, title: `Fork of ${currentSessionLabel}` });
            appendSystem(`Thread forked: ${forked.id}`, 'muted');
          });
        } catch (err) {
          if (!tab.closed) withTab(tab, () => appendSystem(`Fork failed: ${err.message}`, 'error'));
        }
      });

      actionsEl.querySelector('.cxp-sess-archive-current')?.addEventListener('click', async () => {
        menu.classList.remove('open');
        if (tab.closed) return;
        withTab(tab, () => appendSystem('Archiving thread…', 'working'));
        try {
          await requestSocketPayloadForTab(tab, 'thread_archive', { threadId: currentThreadId });
          if (!tab.closed) withTab(tab, () => {
            cxpSetArchived(currentThreadId, true, currentAccountId);
            appendSystem('Thread archived', 'muted');
          });
          if (activeTab() === tab) startNewThread();
        } catch (err) {
          if (!tab.closed) withTab(tab, () => appendSystem(`Archive failed: ${err.message}`, 'error'));
        }
      });
    }

    // ── Session list ──
    const listEl = document.createElement('div');
    listEl.className = 'cxp-sess-list';
    menu.appendChild(listEl);

    // ── Sentinel for infinite scroll ──
    const sentinel = document.createElement('div');
    sentinel.className = 'cxp-sess-sentinel';
    sentinel.innerHTML = '<div class="cxp-sess-sentinel-spinner"></div>';
    menu.appendChild(sentinel);

    // ── Wire search ──
    const searchInput = searchEl.querySelector('.cxp-sess-search-input');
    searchInput.addEventListener('input', () => {
      clearTimeout(_cxpSessDebounce);
      _cxpSessDebounce = setTimeout(() => {
        _cxpSessSearch = searchInput.value.trim();
        cxpSessRebuildList(menu, listEl, tab);
        // Kick off FTS5 body search in parallel — re-render when it returns so
        // threads whose bodies match (but titles don't) appear.
        if (_cxpSessSearch && _cxpSessSearch.length >= 2) {
          const q = _cxpSessSearch;
          searchSessions({ q, provider: 'codex', limit: 100 })
            .then((data) => {
              const ids = new Set();
              for (const proj of (data?.projects || [])) {
                for (const s of (proj.sessions || [])) if (s.sessionId) ids.add(s.sessionId);
              }
              _cxpFtsMatchIds = ids;
              _cxpFtsQuery = q;
              if (_cxpSessSearch === q) cxpSessRebuildList(menu, listEl, tab);
            })
            .catch(() => { /* FTS unavailable — label-only search still works */ });
        } else {
          _cxpFtsMatchIds = null;
          _cxpFtsQuery = '';
        }
      }, 300);
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());
    requestAnimationFrame(() => searchInput.focus());

    // ── Wire refresh ──
    const refreshBtn = searchEl.querySelector('.cxp-sess-refresh-btn');
    refreshBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      refreshBtn.classList.add('spinning');
      listEl.innerHTML = '<div class="cxp-sess-loading">loading sessions...</div>';
      sentinel.innerHTML = '';
      try {
        const threads = await fetchSessionThreads(project, tab);
        if (activeTab() !== tab) return;
        _cxpSessAllThreads = threads;
        cxpSessRebuildList(menu, listEl, tab);
      } catch (err) {
        listEl.innerHTML = `<div class="cxp-sess-empty">${esc(err.message || 'Failed to load')}</div>`;
      }
      refreshBtn.classList.remove('spinning');
    });

    // ── Wire filters ──
    searchEl.querySelectorAll('.cxp-sess-filter-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const filter = pill.dataset.filter;
        if (filter === 'empty') {
          _cxpSessHideEmpty = !_cxpSessHideEmpty;
          pill.classList.toggle('active', _cxpSessHideEmpty);
        } else if (filter === 'archived') {
          _cxpSessShowArchived = !_cxpSessShowArchived;
          pill.classList.toggle('active', _cxpSessShowArchived);
        }
        cxpSessRebuildList(menu, listEl, tab);
      });
    });

    // ── Fetch threads ──
    try {
      const threads = await fetchSessionThreads(project, tab);
      if (activeTab() !== tab) return;
      _cxpSessAllThreads = threads;

      if (!_cxpSessAllThreads.length) {
        listEl.innerHTML = '<div class="cxp-sess-empty">No Codex sessions found for this project.</div>';
        sentinel.innerHTML = '';
        return;
      }

      cxpSessRebuildList(menu, listEl, tab);

      // ── Setup IntersectionObserver for virtual infinite scroll ──
      _cxpSessObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const filtered = cxpSessApplyFilters(_cxpSessAllThreads);
            if (_cxpSessRendered < filtered.length) {
              const added = cxpSessRenderBatch(filtered, listEl, tab, menu, _cxpSessRendered, CXP_SESS_PAGE);
              _cxpSessRendered += added;
              if (_cxpSessRendered >= filtered.length) {
                sentinel.innerHTML = filtered.length > CXP_SESS_PAGE
                  ? '<div class="cxp-sess-no-more">all sessions loaded</div>' : '';
              }
            }
          }
        }
      }, { root: menu, threshold: 0.1 });
      _cxpSessObserver.observe(sentinel);
    } catch (err) {
      if (activeTab() === tab) {
        listEl.innerHTML = `<div class="cxp-sess-empty">${esc(err.message || 'Failed to load sessions')}</div>`;
        sentinel.innerHTML = '';
      }
    }
}

export function renameActiveSession() {
  const tab = activeTab();
  if (!tab) return;
  const labelEl = panelEl('#cxp-session-label');
  if (!labelEl) return;
  const existing = labelEl.querySelector('.cxp-rename-input');
  if (existing) {
    existing.focus();
    existing.select();
    return;
  }
  const currentLabel = _sessionLabel;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cxp-rename-input';
  input.value = currentLabel;
  input.placeholder = 'Session name...';
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  labelEl.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (cancel = false) => {
    if (done) return;
    done = true;
    const nextLabel = normalizeSessionLabel(input.value);
    if (cancel || !nextLabel || nextLabel === currentLabel) {
      if (!tab.closed) withTab(tab, () => setSessionLabel(currentLabel, { persist: false }));
      return;
    }
    markCodexSessionTitleManual(tab);
    tab.pendingSessionLabel = nextLabel;
    if (tab.threadId && tab.connected) {
      const threadId = tab.threadId;
      try {
        await requestSocketPayloadForTab(tab, 'thread_rename', { threadId, name: nextLabel });
        if (!tab.closed) withTab(tab, () => {
          tab.pendingSessionLabel = null;
          setSessionLabel(nextLabel);
        });
        if (activeTab() === tab && panelEl('#cxp-session-menu')?.classList.contains('open')) renderSessionMenu();
      } catch (err) {
        withTab(tab, () => {
          tab.pendingSessionLabel = null;
          setSessionLabel(currentLabel, { persist: false });
          appendSystem(err.message || 'Could not rename Codex thread', 'error');
        });
      }
    } else {
      if (!tab.closed) withTab(tab, () => setSessionLabel(nextLabel));
    }
  };

  input.addEventListener('blur', () => finish(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); finish(true); }
  });
}

async function fetchBranchesForModal(path) {
  if (!path) return { branches: [], current: null };
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(path)}`);
    return await res.json();
  } catch { return { branches: [], current: null }; }
}

export function promptNameNewSession() {
  const panel = _getPanelEl();
  if (!panel) return;
  if (panel.querySelector('.cxp-name-modal-overlay')) return;
  const tab = activeTab();
  if (!tab) return;

  const projectOptions = projectItemsForValue(tab.project || _project || '');

  const overlay = document.createElement('div');
  overlay.className = 'cxp-name-modal-overlay';
  overlay.innerHTML = `
    <div class="cxp-name-modal" role="dialog" aria-modal="true">
      <div class="cxp-name-modal-title">Name this session</div>
      <div class="cxp-name-modal-row">
        <label class="cxp-name-modal-label">Project</label>
        <select class="cxp-name-modal-select" data-role="project">
          ${projectOptions.map(p => `<option value="${String(p.value).replace(/"/g, '&quot;')}">${p.label}</option>`).join('')}
        </select>
      </div>
      <div class="cxp-name-modal-row">
        <label class="cxp-name-modal-label">Branch</label>
        <select class="cxp-name-modal-select" data-role="branch" disabled>
          <option value="">(loading...)</option>
        </select>
      </div>
      <input type="text" class="cxp-name-modal-input" placeholder="Session name..." maxlength="120" />
      <div class="cxp-name-modal-actions">
        <button type="button" class="cxp-name-modal-btn skip">Skip</button>
        <button type="button" class="cxp-name-modal-btn save">Save</button>
      </div>
    </div>
  `;
  panel.appendChild(overlay);

  const input = overlay.querySelector('.cxp-name-modal-input');
  const saveBtn = overlay.querySelector('.cxp-name-modal-btn.save');
  const skipBtn = overlay.querySelector('.cxp-name-modal-btn.skip');
  const projectSel = overlay.querySelector('select[data-role="project"]');
  const branchSel = overlay.querySelector('select[data-role="branch"]');

  const initialProject = tab.project || _project || storage.getItem(STOR.project) || '';
  if (projectSel && initialProject) projectSel.value = initialProject;

  let branchOriginal = null;
  async function refreshBranches(path) {
    branchSel.disabled = true;
    branchSel.innerHTML = '<option value="">(loading...)</option>';
    const data = await fetchBranchesForModal(path);
    branchOriginal = data.current || null;
    const branches = data.branches || [];
    if (!branches.length) {
      branchSel.innerHTML = '<option value="">(none)</option>';
      branchSel.disabled = true;
    } else {
      branchSel.innerHTML = branches.map(b => `<option value="${b.replace(/"/g, '&quot;')}">${b}</option>`).join('');
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
    const nextLabel = normalizeSessionLabel(input.value);
    const chosenProject = projectSel?.value || '';
    const chosenBranch = branchSel?.value || '';
    close();
    if (cancel) return;

    const t = tab;
    if (t.closed || activeTab() !== t) return;

    if (t && chosenProject && chosenProject !== (t.project || '')) {
      setActiveProject(chosenProject, { reset: true, tone: 'ready' });
    }

    if (chosenProject && chosenBranch && branchOriginal && chosenBranch !== branchOriginal) {
      try {
        const statusResponse = await fetch(`/api/git/status?path=${encodeURIComponent(chosenProject)}`);
        const status = statusResponse.ok ? await statusResponse.json() : null;
        const shouldCheckout = !status?.changes?.length || window.confirm(
          `Switch from ${branchOriginal} to ${chosenBranch} with ${status.changes.length} uncommitted change${status.changes.length === 1 ? '' : 's'}? Git will preserve them when possible.`,
        );
        if (!shouldCheckout) {
          _loadBranches(chosenProject);
        } else {
          const response = await fetch('/api/terminal/checkout', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: chosenProject, branch: chosenBranch }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.ok) throw new Error(result.error || 'Branch checkout failed');
          if (t) t.branch = result.branch || chosenBranch;
          _loadBranches(chosenProject);
        }
      } catch (err) {
        if (!t.closed) withTab(t, () => appendSystem(err.message || 'Branch checkout failed', 'error'));
      }
    }

    if (!nextLabel) return;
    markCodexSessionTitleManual(t);
    t.pendingSessionLabel = nextLabel;
    if (t.threadId && t.connected) {
      const rt = t;
      const threadId = t.threadId;
      requestSocketPayloadForTab(rt, 'thread_rename', { threadId, name: nextLabel }).then(() => {
        if (!rt?.closed) withTab(rt, () => {
          setSessionLabel(nextLabel);
          rt.pendingSessionLabel = null;
        });
      }).catch(() => {
        if (!rt?.closed) withTab(rt, () => setSessionLabel(nextLabel));
      });
    } else {
      if (!t.closed) withTab(t, () => setSessionLabel(nextLabel, { persist: false }));
    }
  };

  saveBtn.addEventListener('click', () => commit(false));
  skipBtn.addEventListener('click', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(false); }
    if (e.key === 'Escape') { e.preventDefault(); commit(true); }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) commit(true);
  });
}

export function setStatus(text, tone = 'muted') {

// ── Status/UI (lines 5428-5786) ──
  _statusText = text;
  _statusTone = tone;
  if (tone !== 'working' && !_running && !_startingThread && !_threadActiveFlags.length) {
    _statusDetail = '';
    _currentStepKey = '';
    _stepStartedAt = null;
  }
  if (_boundTab) {
    _boundTab.statusText = _statusText;
    _boundTab.statusTone = _statusTone;
    _boundTab.statusDetail = _statusDetail;
    _boundTab.currentStepKey = _currentStepKey;
    _boundTab.stepStartedAt = _stepStartedAt;
  }
  renderStatusChrome();
}

function latestActiveItem() {
  return [..._activeItems.values()].sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

export function syncStatusTicker() {
  const shouldTick = _getVisible()
    && isActiveTab(_boundTab)
    && !!(_stepStartedAt || _turnStartedAt)
    && (_running || _startingThread || _threadActiveFlags.length > 0);
  if (shouldTick && !_statusTicker) {
    _statusTicker = setInterval(() => renderStatusChrome(), 1000);
  } else if (!shouldTick && _statusTicker) {
    clearInterval(_statusTicker);
    _statusTicker = null;
  }
}

function renderStatusBadges() {
  const badgesEl = panelEl('#cxp-status-badges');
  if (!badgesEl) return;
  badgesEl.replaceChildren();
  const entries = [..._mcpServers.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, entry] of entries) {
    const badge = document.createElement('span');
    badge.className = 'cxp-status-badge';
    badge.dataset.state = entry.status || 'starting';
    badge.textContent = `${name} ${entry.status || 'starting'}`;
    badge.title = entry.error ? `${name}: ${entry.error}` : `${name}: ${entry.status || 'starting'}`;
    badgesEl.appendChild(badge);
  }
}

export function setCompactingUI(on) {
  const next = !!on;
  const changed = _compacting !== next;
  _compacting = next;
  if (_boundTab) _boundTab.compacting = _compacting;
  const gauge = panelEl('#cxp-gauge');
  const label = panelEl('#cxp-gauge-label');
  const button = panelEl('#cxp-compact-btn');
  gauge?.classList.toggle('compacting', _compacting);
  label?.classList.toggle('compacting', _compacting);
  if (button) {
    button.classList.toggle('compacting', _compacting);
    button.textContent = _compacting ? 'compacting' : 'compact';
  }
  if (changed) syncInputEnabled();
}

export function renderContextGauge() {
  const bar = panelEl('#cxp-contextbar');
  const fill = panelEl('#cxp-ctx-fill');
  const label = panelEl('#cxp-gauge-label');
  if (!bar || !fill || !label) return false;

  const usage = normalizeThreadTokenUsage(_threadTokenUsage);
  const meta = normalizeContextTrackerMeta(_threadContextMeta);
  const last = usage?.last || null;
  const contextWindow = usage?.modelContextWindow || null;
  const gaugeUsage = resolveContextGaugeBreakdown(usage, contextWindow);
  const gaugeBreakdown = gaugeUsage.breakdown;
  const cachedInput = Number(gaugeBreakdown?.cachedInputTokens) || 0;
  const cacheCreation = Number(gaugeBreakdown?.cacheCreationInputTokens) || 0;
  const inputTokens = resolveContextInputTokens(gaugeBreakdown);
  const usedTokens = inputTokens;
  const stateLabel = formatContextTrackerState(meta);
  const pctText = formatContextPercent(usedTokens, contextWindow);

  if (!contextWindow || usedTokens === 0) {
    fill.style.width = '0%';
    fill.style.background = 'rgba(232,224,220,0.18)';
    label.textContent = meta.source === 'read-only'
      ? 'ctx pending · read only'
      : `context pending · ${stateLabel}`;
    label.title = [
      `State: ${stateLabel}`,
      `Source: ${meta.source}`,
      `Freshness: ${meta.freshness}`,
      `Gauge basis: ${gaugeUsage.basis === 'last' ? 'last request' : gaugeUsage.basis}`,
      meta.model ? `Model: ${meta.model}` : '',
      meta.updatedAt ? `Updated: ${new Date(meta.updatedAt).toLocaleString()}` : '',
    ].filter(Boolean).join('\n');
    bar.hidden = false;
    setCompactingUI(_compacting);
    return true;
  }

  const pct = Math.min(100, (usedTokens / contextWindow) * 100);
  fill.style.width = pct > 0 ? pct + '%' : '0%';
  fill.style.background = meta.freshness !== 'authoritative'
    ? 'rgba(232,224,220,0.28)'
    : pct > 80
    ? 'rgba(220,80,60,0.45)'
    : pct > 60
      ? 'rgba(220,150,50,0.38)'
      : 'rgba(232,224,220,0.18)';

  label.textContent = `${formatExactTokenCount(usedTokens)} / ${formatExactTokenCount(contextWindow)} · ${pctText}`;
  label.title = [
    `${pctText} context window used`,
    `Source: ${meta.source}`,
    `Freshness: ${meta.freshness}`,
    `Gauge basis: ${gaugeUsage.basis === 'last' ? 'last request input' : gaugeUsage.basis === 'total' ? 'cumulative fallback' : 'unknown'}`,
    meta.model ? `Model: ${meta.model}` : '',
    meta.updatedAt ? `Updated: ${new Date(meta.updatedAt).toLocaleString()}` : '',
    `Input:       ${formatExactTokenCount(inputTokens)}`,
    `Cached read: ${formatExactTokenCount(cachedInput)}`,
    cacheCreation ? `Cache write: ${formatExactTokenCount(cacheCreation)}` : '',
    `Output:      ${formatExactTokenCount(gaugeBreakdown?.outputTokens)}`,
    `Reasoning:   ${formatExactTokenCount(gaugeBreakdown?.reasoningOutputTokens)}`,
    '',
    'Last turn',
    `Input:       ${formatExactTokenCount(resolveContextInputTokens(last))}`,
    `Cached read: ${formatExactTokenCount(last?.cachedInputTokens)}`,
    Number(last?.cacheCreationInputTokens) ? `Cache write: ${formatExactTokenCount(last?.cacheCreationInputTokens)}` : '',
    `Output:      ${formatExactTokenCount(last?.outputTokens)}`,
    `Reasoning:   ${formatExactTokenCount(last?.reasoningOutputTokens)}`,
  ].filter(Boolean).join('\n');
  bar.hidden = false;
  setCompactingUI(_compacting);
  return true;
}

export function updateThreadTokenUsage(tokenUsage, opts = {}) {
  _threadTokenUsage = normalizeThreadTokenUsage(tokenUsage);
  if (_boundTab) _boundTab.threadTokenUsage = _threadTokenUsage;
  if (_boundTab) updateExtendedContextVerification(_boundTab, _threadTokenUsage);
  if (opts?.meta) setThreadContextMeta(opts.meta);
  renderStatusChrome();
  if (_threadId) scheduleThreadSnapshotSave(_boundTab);
  saveTabs();
}

export function renderStatusChrome() {
  if (!isActiveTab(_boundTab)) {
    syncStatusTicker();
    return;
  }
  const bar = panelEl('#cxp-statusbar');
  const label = panelEl('#cxp-status');
  const elapsed = panelEl('#cxp-status-elapsed');
  const meta = panelEl('#cxp-status-meta');
  const step = panelEl('#cxp-status-step');
  if (bar) bar.dataset.tone = STATUS_TONE[_statusTone] || '';
  if (label) label.textContent = _statusText;
  const since = _stepStartedAt || _turnStartedAt;
  if (elapsed) {
    elapsed.textContent = since && (_running || _startingThread || _threadActiveFlags.length)
      ? formatElapsed(Date.now() - since)
      : '';
  }
  if (step) {
    step.textContent = _statusDetail || '';
    step.hidden = !_statusDetail;
  }
  renderStatusBadges();
  renderContextGauge();
  if (meta) meta.hidden = !_statusDetail && _mcpServers.size === 0;
  syncStatusTicker();
}

function setStatusDetail(detail = '', startedAt = null, key = '') {
  _statusDetail = detail || '';
  const nextKey = key || '';
  if (!_statusDetail) {
    _currentStepKey = '';
    _stepStartedAt = null;
  } else if (nextKey !== _currentStepKey) {
    _currentStepKey = nextKey;
    _stepStartedAt = startedAt || Date.now();
  } else if (startedAt != null) {
    _stepStartedAt = startedAt;
  }
  if (_boundTab) {
    _boundTab.statusDetail = _statusDetail;
    _boundTab.stepStartedAt = _stepStartedAt;
    _boundTab.currentStepKey = _currentStepKey;
  }
  renderStatusChrome();
}

export function syncWorkStatus() {
  if (_startingThread) {
    setStatus('Creating new Codex session…', 'working');
    setStatusDetail('Preparing a fresh thread', _stepStartedAt || Date.now(), 'thread:start');
    updateThinkingState({ title: 'Creating session…', detail: 'Preparing a fresh thread' });
    return;
  }
  const blocking = latestBlockingServerRequest();
  if (blocking) {
    const summary = summarizeBlockingServerRequest(blocking);
    setStatus(summary.title, 'working');
    setStatusDetail(summary.detail || summary.title, _stepStartedAt || _turnStartedAt || blocking.createdAt || Date.now(), `request:${blocking.requestId}`);
    updateThinkingState({ title: summary.title, detail: summary.detail || '' });
    return;
  }
  if (!_running && !_threadActiveFlags.length) {
    setStatusDetail('', null, '');
    updateThinkingState({ title: '', detail: '' });
    return;
  }
  if (_threadActiveFlags.includes('waitingOnApproval')) {
    const active = latestActiveItem();
    const summary = itemHeadline(active?.item);
    setStatus('Waiting for approval', 'working');
    setStatusDetail(summary.detail || summary.title, _stepStartedAt || _turnStartedAt || Date.now(), 'thread:waitingOnApproval');
    updateThinkingState({ title: 'Waiting for approval', detail: summary.detail || '' });
    return;
  }
  if (_threadActiveFlags.includes('waitingOnUserInput')) {
    const active = latestActiveItem();
    const summary = itemHeadline(active?.item);
    setStatus('Waiting for input', 'working');
    setStatusDetail(summary.detail || summary.title, _stepStartedAt || _turnStartedAt || Date.now(), 'thread:waitingOnUserInput');
    updateThinkingState({ title: 'Waiting for input', detail: summary.detail || '' });
    return;
  }
  const activePlanStep = _activePlan.find((step) => step?.status === 'inProgress' && step?.step);
  if (activePlanStep) {
    setStatus('Working through plan', 'working');
    setStatusDetail(activePlanStep.step, _currentStepKey === `plan:${activePlanStep.step}` ? _stepStartedAt : Date.now(), `plan:${activePlanStep.step}`);
    updateThinkingState({ title: 'Working through plan', detail: activePlanStep.step });
    return;
  }
  const active = latestActiveItem();
  if (active) {
    const summary = itemHeadline(active.item);
    setStatus(summary.title, 'working');
    setStatusDetail(summary.detail, active.startedAt, `item:${active.id}`);
    updateThinkingState({ title: summary.title, detail: summary.detail || '' });
    return;
  }
  setStatus('Codex is working…', 'working');
  setStatusDetail(_project ? `Project • ${basenamePath(_project)}` : '', _turnStartedAt || Date.now(), 'turn');
  updateThinkingState({ title: 'Codex is working…', detail: _project ? basenamePath(_project) : '' });
}

export function setRunning(next, turnId = null) {
  const wasRunning = _running;
  const previousTurnId = _activeTurnId;
  _running = !!next;
  if (turnId !== null) {
    _activeTurnId = turnId;
    _pendingQueryRequestId = null;
  }
  if (_running && (!wasRunning || (turnId && turnId !== previousTurnId))) {
    _turnStartedAt = Date.now();
    resetStallTimer();
  }
  if (!next) {
    _pendingQueryRequestId = null;
    _activeTurnId = null;
    _turnStartedAt = null;
    stopStallTimer();
    clearInterruptTimer();
    _stepStartedAt = null;
    _currentStepKey = '';
    _statusDetail = '';
    _activeItems = new Map();
    _activePlan = [];
    _threadActiveFlags = [];
    clearAllBlockingServerRequests();
  }
  if (_boundTab) {
    _boundTab.turnStartedAt = _turnStartedAt;
    _boundTab.stepStartedAt = _stepStartedAt;
    _boundTab.currentStepKey = _currentStepKey;
    _boundTab.activeItems = _activeItems;
    _boundTab.activePlan = _activePlan;
    _boundTab.threadActiveFlags = _threadActiveFlags;
  }
  if (_running) { syncWorkStatus(); showThinking(); }
  else { if (_connected) setStatus('Ready', 'ready'); hideThinking(); }
  syncInputEnabled();
  syncToolbarState();
  syncQueueTray();
  updateTrayPillRunning();
  renderPills();
  saveTabs();
}

// ── Instant local user message (renders before Codex echo) ──
export function appendLocalUserMessage(text, images) {
  if (!_messagesEl) return;
  const shell = createMessageShell('user', 'User');
  const content = [];
  if (images?.length) {
    for (const img of images) {
      content.push({ type: 'localImage', name: img.name || 'image', dataUrl: img.dataUrl });
    }
  }
  if (text) content.push({ type: 'text', text });
  renderUserMessageContent(shell.body, content);
  shell.el.classList.add('cxp-local-user-msg');
}

export function hydrateCodexAutomationHistory(tab) {
  if (!tab?.automationActive || !tab.threadId || tab.closed) return Promise.resolve(false);
  if (tab._automationHydrated) return Promise.resolve(true);
  if (tab._automationLiveEvents) return Promise.resolve(false);
  if (tab._automationHydrationPromise) return tab._automationHydrationPromise;

  const token = crypto.randomUUID();
  tab._automationHistoryToken = token;
  tab._automationIgnoreHistory = false;
  tab._automationHydrationPromise = new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const settle = (hydrated) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tab._automationHistoryResolve = null;
      if (!hydrated) tab._automationHydrationPromise = null;
      resolve(hydrated);
    };
    tab._automationHistoryResolve = settle;
    timer = setTimeout(() => {
      if (tab._automationHistoryToken === token) tab._automationIgnoreHistory = true;
      closeAutomationHistorySocket(tab);
      settle(false);
    }, AUTOMATION_HISTORY_TIMEOUT_MS);
    connectTab(tab, { allowAutomation: true, historyOnly: true, hydrationToken: token });
  });
  return tab._automationHydrationPromise;
}

export function showThinking() {
  if (!_messagesEl || !_boundTab) return;
  if (!_turnStartedAt) _turnStartedAt = Date.now();
  if (_boundTab.thinkingEl && _boundTab.thinkingEl.parentNode) {
    repositionThinking();
    return;
  }
  hideThinking();
  const el = document.createElement('div');
  el.className = 'cxp-thinking';
  el.innerHTML = `<div class="cxp-think-avatar">${OPENAI_ICON}</div><div class="cxp-msg-think-dots"><span></span><span></span><span></span></div><span class="cxp-think-title"></span><span class="cxp-think-detail"></span><span class="cxp-think-timer"></span>`;
  _messagesEl.appendChild(el);
  _boundTab.thinkingEl = el;
  _boundTab.thinkTimerInterval = setInterval(() => {
    if (!_turnStartedAt) return;
    const sec = Math.round((Date.now() - _turnStartedAt) / 1000);
    const timer = el.querySelector('.cxp-think-timer');
    if (timer) timer.textContent = sec > 0 ? `${sec}s` : '';
  }, 1000);
  scrollEnd();
}

export function hideThinking() {
  if (!_boundTab) return;
  if (_boundTab.thinkTimerInterval) { clearInterval(_boundTab.thinkTimerInterval); _boundTab.thinkTimerInterval = null; }
  if (_boundTab.thinkingEl) { _boundTab.thinkingEl.remove(); _boundTab.thinkingEl = null; }
}

function updateThinkingState({ title, detail } = {}) {
  if (!_boundTab?.thinkingEl) return;
  const titleEl = _boundTab.thinkingEl.querySelector('.cxp-think-title');
  const detailEl = _boundTab.thinkingEl.querySelector('.cxp-think-detail');
  if (titleEl) titleEl.textContent = title || '';
  if (detailEl) detailEl.textContent = detail || '';
  const isWaiting = (title || '').toLowerCase().startsWith('waiting');
  _boundTab.thinkingEl.classList.toggle('cxp-thinking--waiting', isWaiting);
}

function repositionThinking() {
  if (!_boundTab?.thinkingEl || !_messagesEl) return;
  if (_boundTab.thinkingEl !== _messagesEl.lastElementChild) {
    _messagesEl.appendChild(_boundTab.thinkingEl);
    scrollEnd();
  }
}

export function syncInputEnabled() {
  if (!isActiveTab(_boundTab)) {
    updateTrayPillRunning();
    return;
  }
  const input = panelEl('#cxp-input');
  const send = panelEl('#cxp-send');
  const fresh = panelEl('#cxp-new');
  const close = panelEl('#cxp-close');
  const compact = panelEl('#cxp-compact-btn');
  const tab = activeTab();
  const hasText = !!input?.value.trim();
  const hasImages = !!(tab?.attachedImages?.length);
  const hasPaths = !!(tab?.pendingPaths?.length);
  const hasMentions = !!(tab?.pendingMentions?.length);
  const blockedByRequest = hasBlockingServerRequests();
  if (input) input.disabled = !_connected || !_bootstrapped || _startingThread || blockedByRequest;
  const cliBlocked = document.getElementById('codex-panel')?.classList.contains('cxp-cli-blocked');
  const actionBlockedByCli = cliBlocked && !tab?.automationActive;
  if (send) {
    const isStopMode = !!(tab?.running || _running);
    send.classList.toggle('cxp-send-stopping', !!isStopMode);
    send.title = actionBlockedByCli ? 'Codex CLI not installed' : (isStopMode ? 'Stop' : 'Send');
    send.disabled = actionBlockedByCli || (isStopMode ? false : (!_connected || !_bootstrapped || _running || _startingThread || blockedByRequest || (!hasText && !hasImages && !hasPaths && !hasMentions)));
  }
  if (fresh) {
    pruneDiscardableTabs({ keepTab: tab, persist: true });
    fresh.disabled = false;
    fresh.title = 'New Codex tab';
  }
  if (close) close.disabled = false;
  if (compact) {
    compact.disabled = !_connected || !_bootstrapped || !_threadId || _running || _startingThread || _compacting;
    compact.title = _compacting
      ? 'Compacting current thread context'
      : !_threadId
        ? 'Compaction becomes available after the first Codex turn'
        : (!_connected || !_bootstrapped)
          ? 'Connect Codex to compact this thread'
          : (_running || _startingThread)
            ? 'Cannot compact while Codex is processing'
            : 'Compact current thread context';
  }
  syncSessionControls();
}

// Pass a numeric `knownWidth` during drag-resize to skip the getBoundingClientRect
// measure (we already know the target width) and avoid a forced reflow every frame.
export function syncReservedWidth(knownWidth) {
  if (_getVisible() && _getPanelEl()) {
    reserveRightPanelLayout(PANEL_OWNER, typeof knownWidth === 'number' ? knownWidth + 20 : _getPanelEl(), 20);
  } else {
    clearRightPanelLayout(PANEL_OWNER);
  }
}

// ── Dispatch prompt (lines 5925-5965) ──
export function dispatchPrompt(prompt, { tab = activeTab(), images = null, paths = null, mentions = null, forcePlanModePrefix = null } = {}) {
  const inputText = String(prompt || '').trim();
  const imageList = Array.isArray(images) ? images.map((img) => img?.dataUrl || img).filter(Boolean) : [];
  const pathList = Array.isArray(paths) ? paths.filter(Boolean) : [];
  const mentionList = Array.isArray(mentions) ? mentions.filter((mention) => mention?.path) : [];
  if ((!inputText && !imageList.length && !pathList.length && !mentionList.length) || !_connected || !_bootstrapped) return false;
  if (tab?.automationActive) {
    setStatus('Stop the running automation before sending a manual turn', 'info');
    return false;
  }

  let finalPrompt = inputText;
  if (pathList.length) {
    finalPrompt += `${finalPrompt ? '\n\n' : ''}Referenced files:\n${pathList.map((path) => `- ${path}`).join('\n')}`;
  }

  const explicitPlanPrompt = isPlanModePromptText(finalPrompt);
  const usePlanModePrefix = forcePlanModePrefix == null ? !!tab?.planMode : !!forcePlanModePrefix;
  const sentAsPlanMode = !!usePlanModePrefix || explicitPlanPrompt;
  if (usePlanModePrefix) {
    finalPrompt = `${CODEX_PLAN_MODE_PREFIXES[0]}\n\n${finalPrompt}`;
  }

  const msg = {
    type: 'query',
    requestId: crypto.randomUUID(),
    prompt: finalPrompt,
    planMode: sentAsPlanMode,
    autoAccept: !!tab?.autoAccept,
    threadId: _threadId || null,
    fresh: _freshThread || !_threadId,
    cwd: _project || null,
    contextMode: normalizeCodexContextMode(tab?.contextMode),
  };
  if (tab?.model) msg.model = tab.model;
  if (tab?.effort && tab.effort !== 'off') msg.effort = tab.effort;
  if (imageList.length) {
    msg.images = imageList;
  }
  if (mentionList.length) {
    msg.mentions = mentionList;
  }
  if (tab && msg.fresh) {
    markExtendedContextPending(tab);
    tab.expectedThreadId = null;
    tab.expectedThreadRequestId = msg.requestId;
  }
  if (!sendSocket(msg)) {
    if (tab?.expectedThreadRequestId === msg.requestId) tab.expectedThreadRequestId = null;
    setStatus('Codex is not connected', 'error');
    return false;
  }
  if (tab) {
    tab.extendedContextVerificationArmed = normalizeCodexContextMode(tab.contextMode) === 'extended';
  }
  requestCodexSessionTitle(tab, inputText, {
    paths: [...pathList, ...mentionList.map((mention) => mention.path).filter(Boolean)],
    hasImages: imageList.length > 0,
  });
  releaseAutomationForManualUse(tab);
  // Sending a message re-pins auto-follow even if the user had scrolled up
  if (isActiveTab(tab)) scrollEnd(true);
  if (tab) {
    tab.planTurnActive = sentAsPlanMode;
    tab.planApprovalPending = false;
    tab.lastPlanTurnId = msg.requestId;
    if (isActiveTab(tab)) {
      _planTurnActive = sentAsPlanMode;
      _planApprovalPending = false;
      _lastPlanTurnId = msg.requestId;
    }
  }
  clearPostCompactionState(tab, { updateTranscript: !_freshThread });
  if (_freshThread) clearTranscript('Starting fresh Codex thread…');
  _freshThread = false;
  _pendingQueryRequestId = msg.requestId;
  setRunning(true);
  saveTabs();
  return true;
}


// ── Notification helpers ──
function updateThreadActiveFlags(flags) {
  // Update status with active thread flags (browsing, writing, etc.)
  if (Array.isArray(flags) && flags.length) {
    const label = flags.join(', ');
    setStatus(label, 'working');
  }
}

function applyTurnPlan(plan, explanation) {
  // Apply an updated plan from the Codex SDK turn/plan/updated notification
  _activePlan = Array.isArray(plan) ? plan : [];
  if (_boundTab) _boundTab.activePlan = _activePlan;
  if (explanation) setStatusDetail(explanation, _turnStartedAt || Date.now(), 'turn:plan');
}

function updateMcpServerStatus(name, status, error, failureReason = null) {
  const serverName = String(name || 'MCP');
  const current = _mcpServers.get(serverName) || { name: serverName };
  const next = {
    ...current,
    name: serverName,
    status: status || current.status || 'starting',
    error: error || null,
    failureReason: failureReason || null,
  };
  if (isCodexMcpAuthenticationRequired({ failureReason }, current)) next.requiresOAuth = true;
  if (status === 'ready') next.requiresOAuth = false;
  _mcpServers.set(serverName, next);
  if (_boundTab) _boundTab.mcpServers = _mcpServers;
  renderStatusChrome();
  return next;
}

function setMcpSettingsAuthButtonState(name, state) {
  if (!isActiveTab(_boundTab)) return;
  const serverName = String(name || 'MCP');
  const buttons = [...(_getPanelEl()?.querySelectorAll('.cxp-mcp-oauth-btn') || [])]
    .filter((button) => button.dataset.mcpServer === serverName);
  const labels = {
    opening: 'Opening…',
    waiting: 'Waiting…',
    authenticated: 'Authenticated',
    ready: 'Ready',
    error: 'Authenticate',
  };
  for (const button of buttons) {
    button.textContent = labels[state] || 'Authenticate';
    button.disabled = !['error', 'failed'].includes(state);
  }
}

function setMcpAuthenticationUi(name, state, statusText = '') {
  const serverName = String(name || 'MCP');
  const retryable = state === 'error' || state === 'failed';
  const noticeUpdated = updateMcpStartupNotice(serverName, {
    state,
    title: state === 'ready'
      ? `${serverName} MCP ready`
      : state === 'authenticated'
        ? `${serverName} authenticated`
        : undefined,
    statusText,
    buttonLabel: state === 'opening'
      ? 'Opening…'
      : state === 'waiting'
        ? 'Waiting…'
        : state === 'authenticated'
          ? 'Authenticated'
          : state === 'ready'
            ? 'Ready'
            : retryable
              ? 'Retry authentication'
              : 'Authenticate',
    buttonDisabled: !retryable,
    buttonHidden: state === 'ready',
  });
  setMcpSettingsAuthButtonState(serverName, state);
  return noticeUpdated;
}

function openMcpAuthenticationWindow() {
  try {
    const authWindow = window.open('about:blank', '_blank');
    if (authWindow) authWindow.opener = null;
    return authWindow;
  } catch {
    return null;
  }
}

function normalizeMcpAuthorizationUrl(result) {
  const value = String(result?.authorizationUrl || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

async function startMcpOAuthLogin(tab, name) {
  if (!tab || tab.closed) throw new Error('Codex tab is closed');
  const serverName = String(name || 'MCP');
  const authWindow = openMcpAuthenticationWindow();
  if (!authWindow) {
    withTab(tab, () => setMcpAuthenticationUi(serverName, 'error', 'Allow pop-ups, then try again.'));
    throw new Error('The authorization tab was blocked');
  }

  withTab(tab, () => setMcpAuthenticationUi(serverName, 'opening', 'Requesting an authorization link…'));
  try {
    const result = await requestSocketPayloadForTab(tab, 'mcp_oauth_login', { name: serverName });
    const authorizationUrl = normalizeMcpAuthorizationUrl(result);
    if (!authorizationUrl) throw new Error('Codex did not return a valid authorization URL');
    if (tab.closed) {
      try { authWindow.close(); } catch {}
      return result;
    }
    try { authWindow.location.replace(authorizationUrl); }
    catch { authWindow.location.href = authorizationUrl; }
    withTab(tab, () => setMcpAuthenticationUi(serverName, 'waiting', 'Complete authentication in the new tab.'));
    return result;
  } catch (error) {
    try { authWindow.close(); } catch {}
    if (!tab.closed) {
      withTab(tab, () => setMcpAuthenticationUi(serverName, 'error', error.message || 'Authentication could not start.'));
    }
    throw error;
  }
}

async function refreshMcpAfterAuthentication(tab, name) {
  if (!tab || tab.closed) return;
  const serverName = String(name || 'MCP');
  try {
    await requestSocketPayloadForTab(tab, 'mcp_refresh', { name: serverName });
    await requestSocketPayloadForTab(tab, 'mcp_status', {});
    if (tab.closed) return;
    withTab(tab, () => {
      const server = _mcpServers.get(serverName);
      if (server?.authStatus === 'notLoggedIn' || server?.requiresOAuth) {
        setMcpAuthenticationUi(serverName, 'error', 'Authentication was not accepted. Try again.');
      } else if (server?.serverInfo || ['ready', 'running'].includes(server?.status)) {
        setMcpAuthenticationUi(serverName, 'ready', 'Connected');
      } else {
        setMcpAuthenticationUi(serverName, 'authenticated', 'Authentication complete. MCP is refreshing…');
      }
    });
  } catch (error) {
    if (!tab.closed) withTab(tab, () => {
      setMcpAuthenticationUi(serverName, 'authenticated', `Authenticated, but refresh failed: ${error.message}`);
    });
  }
}

// ── Notification handler (lines 7538-7698) ──
export function handleNotify(method, params) {
  if (_running) resetStallTimer();
  if (!_messagesEl && /^item\/(agentMessage|plan|reasoning|commandExecution|fileChange)/.test(method)) {
    console.warn('[cdx-tabs] handleNotify received item delta but _messagesEl is null', { method, boundTab: !!_boundTab, tabMessagesEl: !!_boundTab?.messagesEl });
  }
  switch (method) {
    case 'thread/name/updated':
      if (params.threadId === _threadId) {
        applyCodexProviderTitle(params.threadName || 'Codex');
      }
      break;
    case 'turn/started':
      _pendingQueryRequestId = null;
      _activeItems = new Map();
      _activePlan = [];
      _threadActiveFlags = [];
      if (_boundTab) {
        _boundTab.activeItems = _activeItems;
        _boundTab.activePlan = _activePlan;
        _boundTab.threadActiveFlags = _threadActiveFlags;
      }
      setThreadContextMeta({
        isLiveThread: true,
        updatedAt: Date.now(),
      });
      setRunning(true, params.turn?.id || null);
      resetCodexTurnNotif(_boundTab);
      break;
    case 'turn/completed':
      if (params.turn?.id && _boundTab) {
        if (!(_boundTab._completedTurnIds instanceof Set)) _boundTab._completedTurnIds = new Set();
        if (_boundTab._completedTurnIds.has(String(params.turn.id))) return;
        _boundTab._completedTurnIds.add(String(params.turn.id));
        if (_boundTab._completedTurnIds.size > 100) {
          _boundTab._completedTurnIds.delete(_boundTab._completedTurnIds.values().next().value);
        }
      }
      if (_autoCompactionActive) finishAutoCompactionNotice();
      else if (_compacting) setCompactingUI(false);
      {
        const tab = _boundTab;
        const wasPlanTurn = shouldCompleteCodexPlan(tab, _planTurnActive);
        setRunning(false);
        if (params.turn?.error?.message) {
          setPlanTurnActive(_boundTab, false, '');
          setPlanApprovalPending(_boundTab, false);
          appendSystem(params.turn.error.message, 'error');
          setStatus(params.turn.error.message, 'error');
          notifyCodexTurnOutcome(NOTIF_TYPE.ERROR, _boundTab, params.turn?.id || _activeTurnId);
        } else if (wasPlanTurn && tab) {
          const capturedPlan = capturePlanContent(tab);
          if (capturedPlan) {
            tab.planMode = false;
            tab.showPostPlanActions = true;
            tab.postPlanHeader = 'PLAN COMPLETE';
            tab.planApprovalPending = true;
            tab.planTurnActive = false;
            _showPostPlanActions = true;
            _postPlanHeader = 'PLAN COMPLETE';
            _planApprovalPending = true;
            _planTurnActive = false;
            _lastPlanTurnId = '';
            tab.lastPlanTurnId = '';
            ensurePlanFile(tab);
            renderPostPlanActions(tab);
            syncToolbarState();
            saveTabs();
          } else {
            setPlanTurnActive(tab, false, '');
            setPlanApprovalPending(tab, false);
          }
          notifyCodexTurnOutcome(NOTIF_TYPE.DONE, tab, params.turn?.id || _activeTurnId);
        } else {
          notifyCodexTurnOutcome(NOTIF_TYPE.DONE, _boundTab, params.turn?.id || _activeTurnId);
        }
        if (_boundTab?.postCompactionPending && !_boundTab?.showPostPlanActions) {
          flushPostCompactionPrompt(_boundTab);
        }
        if (_boundTab?.providerTitleDirty) scheduleCodexTitleReassert(_boundTab);
        if (!shouldHoldForPlanApproval(_boundTab)) advanceQueue();
        releaseInactiveIdleTab(tab);
      }
      break;
    case 'thread/compacted':
      finishContextCompaction({ manual: _manualCompactionPending, defer: _running });
      releaseInactiveIdleTab(_boundTab);
      break;
    case 'thread/status/changed':
      if (params.status?.type === 'active') {
        updateThreadActiveFlags(params.status.activeFlags || []);
      } else {
        updateThreadActiveFlags([]);
        if (!_running && params.status?.type === 'idle') setStatus('Ready', 'ready');
        if (params.status?.type === 'systemError') setStatus('Codex encountered a system error', 'error');
      }
      break;
    case 'item/started':
      if (params.item?.type === 'contextCompaction') {
        setThreadContextMeta({
          freshness: 'pending',
          updatedAt: Date.now(),
        });
        beginAutoCompactionNotice();
      }
      // When Codex echoes back the userMessage, remove local render and inject images
      if (params.item?.type === 'userMessage') {
        const localMsg = _messagesEl?.querySelector('.cxp-local-user-msg');
        if (localMsg) localMsg.remove();
        if (_boundTab?._pendingSendImages?.length) {
          const imgItems = _boundTab._pendingSendImages.map((img) => ({
            type: 'localImage',
            name: img.name || 'image',
            dataUrl: img.dataUrl,
          }));
          params.item.content = [...imgItems, ...(params.item.content || [])];
          _boundTab._pendingSendImages = null;
        }
      }
      trackActiveItemStart(params.item);
      updateItemFromData(params.item);
      break;
    case 'item/autoApprovalReview/started':
      setGuardianReviewState(params.targetItemId, params.review);
      break;
    case 'item/autoApprovalReview/completed':
      setGuardianReviewState(params.targetItemId, params.review);
      break;
    case 'item/completed': {
      const completedItem = params.item?.type === 'reasoning' && params.item.status == null
        ? { ...params.item, status: 'complete' }
        : params.item;
      // Inject pending images into userMessage if not consumed at item/started
      if (completedItem?.type === 'userMessage' && _boundTab?._pendingSendImages?.length) {
        const imgItems = _boundTab._pendingSendImages.map((img) => ({
          type: 'localImage',
          name: img.name || 'image',
          dataUrl: img.dataUrl,
        }));
        completedItem.content = [...imgItems, ...(completedItem.content || [])];
        _boundTab._pendingSendImages = null;
      }
      updateItemFromData(completedItem);
      trackActiveItemCompletion(completedItem);
      captureCompletedPlanItem(_boundTab, completedItem);
      if (completedItem?.type === 'contextCompaction') {
        finishContextCompaction({ manual: _manualCompactionPending, defer: _running });
      }
      // Re-show thinking — Codex is processing between items
      if (_running) showThinking();
      break;
    }
    case 'item/agentMessage/delta':
      appendAgentDelta(params.itemId, params.delta);
      repositionThinking();
      break;
    case 'item/plan/delta':
      appendPlanDelta(params.itemId, params.delta);
      repositionThinking();
      break;
    case 'item/reasoning/textDelta':
      hideThinking();
      appendReasoningDelta(params.itemId, params.delta, false);
      syncWorkStatus();
      break;
    case 'item/reasoning/summaryTextDelta':
      hideThinking();
      appendReasoningDelta(params.itemId, params.delta, true, params.summaryIndex);
      syncWorkStatus();
      break;
    case 'item/reasoning/summaryPartAdded':
      hideThinking();
      appendReasoningSummaryPart(params.itemId, params.summaryIndex);
      syncWorkStatus();
      break;
    case 'item/commandExecution/outputDelta':
      appendOutputDelta(params.itemId, params.delta, 'commandExecution');
      repositionThinking();
      break;
    case 'item/fileChange/outputDelta':
      appendOutputDelta(params.itemId, params.delta, 'fileChange');
      repositionThinking();
      break;
    case 'item/mcpToolCall/progress':
      appendToolProgress(params.itemId, params.message);
      break;
    case 'item/commandExecution/terminalInteraction':
      setCommandInteraction(params.itemId, params.processId);
      break;
    case 'turn/plan/updated':
      applyTurnPlan(params.plan, params.explanation || '');
      break;
    case 'turn/diff/updated':
      if (_running && !_activePlan.length && !_activeItems.size) {
        setStatus('Updating diff', 'working');
        setStatusDetail('Aggregating file changes for this turn', _turnStartedAt || Date.now(), 'turn:diff');
      }
      break;
    case 'thread/tokenUsage/updated':
      if (!params.threadId || !_threadId || params.threadId === _threadId) {
        updateThreadTokenUsage(params.tokenUsage || null, {
          meta: {
            source: 'live',
            freshness: 'authoritative',
            isLiveThread: true,
            model: activeTab()?.model || _boundTab?.model || '',
            updatedAt: Date.now(),
          },
        });
        updateCostEstimate(params.tokenUsage || null);
        checkAutoCompact(params.tokenUsage || null);
      }
      if (!_running) setStatus('Ready', 'ready');
      break;
    case 'mcpServer/startupStatus/updated':
      {
        const server = updateMcpServerStatus(
          params.name,
          params.status,
          params.error || null,
          params.failureReason || null,
        );
        const serverName = server.name;
        if (params.status === 'failed') {
          const canAuthenticate = isCodexMcpAuthenticationRequired(params, server);
          const noticeTab = _boundTab;
          upsertMcpStartupNotice({
            name: serverName,
            error: params.error || 'The MCP server could not start.',
            canAuthenticate,
            onAuthenticate: canAuthenticate
              ? () => { void startMcpOAuthLogin(noticeTab, serverName).catch(() => {}); }
              : null,
          });
        } else if (params.status === 'starting') {
          updateMcpStartupNotice(serverName, {
            state: 'waiting',
            title: `Starting ${serverName} MCP…`,
            statusText: 'Connecting…',
            buttonLabel: 'Waiting…',
            buttonDisabled: true,
            buttonHidden: !server.requiresOAuth,
          });
        } else if (params.status === 'ready') {
          setMcpAuthenticationUi(serverName, 'ready', 'Connected');
        } else if (params.status === 'cancelled') {
          updateMcpStartupNotice(serverName, {
            state: 'error',
            title: `${serverName} MCP startup cancelled`,
            statusText: 'Startup cancelled',
            buttonLabel: 'Authenticate',
            buttonDisabled: false,
            buttonHidden: !server.requiresOAuth,
          });
        }
      }
      break;
    case 'mcpServer/oauthLogin/completed':
      {
        const serverName = params?.name || 'MCP';
        const tab = _boundTab;
        if (params?.success) {
          const current = _mcpServers.get(serverName) || { name: serverName };
          _mcpServers.set(serverName, {
            ...current,
            authStatus: current.authStatus === 'notLoggedIn' ? 'oAuth' : current.authStatus,
            requiresOAuth: false,
          });
          if (_boundTab) _boundTab.mcpServers = _mcpServers;
          const updated = setMcpAuthenticationUi(serverName, 'authenticated', 'Authentication complete. Refreshing MCP…');
          if (!updated) appendSystem(`${serverName} login completed`, 'muted');
          void refreshMcpAfterAuthentication(tab, serverName);
        } else {
          const message = params?.error || 'Authentication failed. Try again.';
          const updated = setMcpAuthenticationUi(serverName, 'error', message);
          if (!updated) appendSystem(`${serverName} login failed: ${message}`, 'error');
        }
      }
      break;
    case 'fuzzyFileSearch/sessionUpdated':
    case 'fuzzyFileSearch/sessionCompleted':
      break;
    case 'windowsSandbox/setupCompleted':
      appendSystem(params?.success
        ? `Windows sandbox setup completed (${params?.mode || 'default'})`
        : `Windows sandbox setup failed${params?.error ? `: ${params.error}` : ''}`, params?.success ? 'muted' : 'error');
      break;
    case 'serverRequest/resolved':
      resolveRequestCard(params.requestId);
      _requestCards.delete(String(params.requestId));
      clearBlockingServerRequest(params.requestId);
      clearCodexRequestNotif(params.requestId, _boundTab);
      syncWorkStatus();
      renderStatusChrome();
      break;
    case 'error': {
      const message = params?.error?.message || 'Codex error';
      if (_compacting && !params?.willRetry) {
        resetRuntimeCompactionState();
        setCompactingUI(false);
      }
      appendSystem(message, params?.willRetry ? 'working' : 'error');
      if (params?.willRetry) {
        setStatus(message, 'working');
        setStatusDetail(params?.error?.additionalDetails || 'Retrying request stream', _turnStartedAt || Date.now(), 'turn:retry');
      } else {
        setRunning(false);
        setStatus(message, 'error');
        notifyCodexTurnOutcome(NOTIF_TYPE.ERROR, _boundTab);
        releaseInactiveIdleTab(_boundTab);
      }
      break;
    }
    case 'configWarning': {
      appendSystem(formatCodexConfigWarning(params, method), 'error');
      break;
    }
    case 'deprecationNotice':
    case 'warning':
      appendSystem(params?.message || params?.summary || method, method === 'warning' ? 'muted' : 'error');
      break;
    case 'model/safetyBuffering/updated':
      if (params?.showBufferingUi) {
        setStatus('Applying model safety checks', 'working');
        setStatusDetail((params?.reasons || []).join(', ') || 'Response buffering is active', _turnStartedAt || Date.now(), 'model:safety');
      }
      break;
    case 'model/verification':
      appendSystem('This Codex turn requires additional account verification.', 'error');
      break;
    case 'model/rerouted':
      appendSystem(params?.message || 'Codex rerouted the model for this turn.', 'working');
      break;
    case 'thread/closed':
      if (params.threadId && params.threadId === _threadId) {
        resetThreadState();
        appendSystem('Codex thread closed', 'muted');
      }
      break;
    case 'thread/archived':
      appendSystem('Codex thread archived', 'muted');
      break;
    case 'thread/unarchived':
      appendSystem('Codex thread restored from archive', 'muted');
      break;
    default:
      break;
  }
}

// ── Settings & toggles (lines 7980-8099) ──
export function cycleEffort(tab = activeTab()) {
  if (!tab) return;
  const options = effortOptionsForTab(tab);
  const curIdx = Math.max(0, options.findIndex((option) => option.id === (tab.effort || 'off')));
  const nextIdx = (curIdx + 1) % options.length;
  tab.effort = options[nextIdx].id;
  storage.setItem(STOR.effort, tab.effort);
  if (isActiveTab(tab)) syncToolbarState();
  saveTabs();
}

function effortOptionsForTab(tab = activeTab()) {
  const model = selectedModelOption(modelListForTab(tab), tab?.model);
  return normalizeReasoningEfforts(model, EFFORT_LEVELS.filter((effort) => effort !== 'off'));
}

export function renderEffortMenu() {
  const menu = panelEl('#cxp-effort-menu');
  const tab = activeTab();
  if (!menu || !tab) return;
  const options = effortOptionsForTab(tab);
  menu.innerHTML = '';
  for (const option of options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `cxp-effort-menu-item${option.id === (tab.effort || 'off') ? ' selected' : ''}`;
    item.dataset.value = option.id;
    const label = document.createElement('span');
    label.className = 'cxp-effort-menu-label';
    label.textContent = option.label;
    const description = document.createElement('span');
    description.className = 'cxp-effort-menu-desc';
    description.textContent = option.description || (option.id === 'off' ? 'Use the model default' : option.id);
    item.append(label, description);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      tab.effort = option.id;
      storage.setItem(STOR.effort, option.id);
      menu.classList.remove('open');
      syncToolbarState();
      saveTabs();
    });
    menu.appendChild(item);
  }
}

export function toggleEffortMenu() {
  const menu = panelEl('#cxp-effort-menu');
  if (!menu) return;
  renderEffortMenu();
  menu.classList.toggle('open');
}

export function togglePlanMode(tab = activeTab()) {
  if (!tab) return;
  tab.planMode = !tab.planMode;
  if (tab.planMode) clearPlanHandoffState(tab);
  if (isActiveTab(tab)) syncToolbarState();
  saveTabs();
}

export function toggleAutoAccept() {
  const tab = activeTab();
  if (!tab) return;
  tab.autoAccept = !tab.autoAccept;
  storage.setItem(STOR.autoAccept, String(tab.autoAccept));
  syncToolbarState();
  saveTabs();
}

function formatContextCapacity(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  if (amount >= 1_000_000) {
    const millions = amount / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2).replace(/0$/, '')}M`;
  }
  return `${Math.round(amount / 1000)}K`;
}

function contextModelForTab(tab = activeTab()) {
  return selectedCodexContextModel(modelListForTab(tab), tab?.model);
}

function markExtendedContextPending(tab) {
  if (!tab) return;
  tab.extendedContextActualWindow = null;
  tab.extendedContextNoticeShown = false;
  tab.extendedContextVerificationArmed = false;
  if (normalizeCodexContextMode(tab.contextMode) !== 'extended') {
    tab.extendedContextStatus = 'off';
    return;
  }
  const model = contextModelForTab(tab);
  tab.extendedContextStatus = model?.supportsExtendedContext ? 'pending' : 'unavailable';
}

function updateExtendedContextVerification(tab, tokenUsage) {
  if (!tab) return;
  const usage = normalizeThreadTokenUsage(tokenUsage);
  const actualWindow = usage?.modelContextWindow || null;
  const model = contextModelForTab(tab);
  if (normalizeCodexContextMode(tab.contextMode) === 'extended'
    && !tab.extendedContextVerificationArmed) {
    tab.extendedContextStatus = model?.supportsExtendedContext ? 'pending' : 'unavailable';
    return;
  }
  const status = verifyCodexExtendedContext({
    contextMode: tab.contextMode,
    model,
    actualWindow,
  });
  tab.extendedContextStatus = status;
  tab.extendedContextActualWindow = actualWindow;
  if (status === 'mismatch' && !tab.extendedContextNoticeShown) {
    tab.extendedContextNoticeShown = true;
    const requested = formatContextCapacity(model?.maxContextWindow) || 'extended';
    const actual = formatContextCapacity(actualWindow) || 'an unknown window';
    appendSystem(`Extended context requested (${requested}), but Codex reported ${actual}. The live context gauge remains authoritative.`, 'error');
  }
  if (isActiveTab(tab)) syncToolbarState();
}

export function toggleContextMode(tab = activeTab()) {
  if (!tab || tab.running || tab.startingThread || tab.compacting) return;
  const current = normalizeCodexContextMode(tab.contextMode);
  if (current === 'extended') {
    tab.contextMode = 'default';
    markExtendedContextPending(tab);
    syncToolbarState();
    saveTabs();
    return;
  }

  const model = contextModelForTab(tab);
  if (!model?.supportsExtendedContext) return;
  if (!tab.model) {
    tab.model = getCodexModelName(model);
    storage.setItem(STOR.model, tab.model);
  }
  tab.contextMode = 'extended';
  markExtendedContextPending(tab);
  syncToolbarState();
  saveTabs();
}

export function syncToolbarState() {
  const tab = activeTab();
  const effortBtn = panelEl('#cxp-effort-toggle');
  const planBtn = panelEl('#cxp-plan-toggle');
  const autoAcceptBtn = panelEl('#cxp-autoaccept-toggle');
  const contextBtn = panelEl('#cxp-context-toggle');
  const modelDd = panelEl('#cxp-model');
  const costEl = panelEl('#cxp-cost');
  if (effortBtn) {
    const effort = tab?.effort || 'off';
    const options = effortOptionsForTab(tab);
    const selected = options.find((option) => option.id === effort) || options[0];
    effortBtn.dataset.effort = effort;
    effortBtn.title = `Reasoning effort: ${selected?.label || effort}`;
    effortBtn.classList.toggle('active', effort !== 'off');
    const label = effortBtn.querySelector('.cxp-btn-label');
    if (label) label.textContent = effort === 'off' ? 'Effort' : (selected?.label || effort);
    const dots = effortBtn.querySelectorAll('.cxp-effort-dots i');
    const litCount = Math.max(0, options.findIndex((option) => option.id === effort));
    dots.forEach((d, i) => d.classList.toggle('lit', i < litCount));
  }
  if (planBtn) {
    planBtn.classList.toggle('active', !!tab?.planMode);
    planBtn.title = `Plan mode: ${tab?.planMode ? 'on' : 'off'}`;
  }
  if (autoAcceptBtn) {
    autoAcceptBtn.classList.toggle('active', !!tab?.autoAccept);
    autoAcceptBtn.title = `Auto-accept: ${tab?.autoAccept ? 'on' : 'off'}`;
  }
  if (contextBtn) {
    const mode = normalizeCodexContextMode(tab?.contextMode);
    const model = contextModelForTab(tab);
    const supportsExtended = !!model?.supportsExtendedContext;
    const status = mode === 'extended'
      ? (tab?.extendedContextStatus || 'pending')
      : 'off';
    const requested = formatContextCapacity(model?.maxContextWindow);
    const expected = formatContextCapacity(model?.expectedEffectiveContextWindow);
    const actual = formatContextCapacity(tab?.extendedContextActualWindow);
    contextBtn.classList.toggle('active', mode === 'extended');
    contextBtn.dataset.contextStatus = status;
    contextBtn.setAttribute('aria-pressed', mode === 'extended' ? 'true' : 'false');
    contextBtn.disabled = !!(tab?.running || tab?.startingThread || tab?.compacting)
      || (mode !== 'extended' && !supportsExtended);
    const label = contextBtn.querySelector('.cxp-btn-label');
    if (label) label.textContent = mode === 'extended' ? 'Extended' : 'Default';
    if (mode !== 'extended') {
      contextBtn.title = supportsExtended
        ? `Use extended context (requests up to ${requested}; Codex reports the effective window live)`
        : 'Extended context is not advertised for the selected model and account';
    } else if (status === 'verified') {
      contextBtn.title = `Extended context verified: ${actual || expected || requested} effective`;
    } else if (status === 'mismatch') {
      contextBtn.title = `Extended context mismatch: requested ${requested || 'runtime maximum'}, Codex reported ${actual || 'unknown'}`;
    } else if (status === 'unavailable') {
      contextBtn.title = 'Extended context is no longer available for the selected model and account';
    } else {
      contextBtn.title = `Extended context requested${requested ? ` up to ${requested}` : ''}; it applies on the next thread activation and is verified from live usage`;
    }
  }
  if (modelDd) {
    const label = modelDd.querySelector('.cxp-dd-label');
    if (label) label.textContent = tab?.model || 'model...';
  }
  if (costEl) {
    const cost = tab?.estimatedCost || 0;
    costEl.textContent = cost > 0 ? `~$${cost.toFixed(2)}` : '';
  }
}

const _modelListCacheByAccount = new Map();
const _modelListRequestByAccount = new Map();

function modelListAccountKey(tab = _boundTab || activeTab()) {
  return String(tab?.accountId || 'default');
}

function modelListForTab(tab = _boundTab || activeTab()) {
  return _modelListCacheByAccount.get(modelListAccountKey(tab)) || [];
}

function cacheModelListForTab(tab, models) {
  const normalized = mergeCodexModelList(models);
  _modelListCacheByAccount.set(modelListAccountKey(tab), normalized);
  if (tab) {
    const canReverify = normalizeCodexContextMode(tab.contextMode) === 'extended'
      && tab.extendedContextVerificationArmed
      && Number(tab.threadTokenUsage?.modelContextWindow) > 0;
    if (canReverify) updateExtendedContextVerification(tab, tab.threadTokenUsage);
    else markExtendedContextPending(tab);
  }
  return normalized;
}

function mergeCodexModelList(models) {
  return mergeCodexModelOptions(models);
}

export function requestModelList(tab = _boundTab || activeTab()) {
  const accountKey = modelListAccountKey(tab);
  const cached = _modelListCacheByAccount.get(accountKey);
  if (cached) return Promise.resolve(cached);
  const pending = _modelListRequestByAccount.get(accountKey);
  if (pending) return pending;
  const requestPromise = requestSocketPayloadForTab(tab, 'model_list', {})
    .then((msg) => {
      const models = cacheModelListForTab(tab, Array.isArray(msg?.models) ? msg.models : []);
      if (isActiveTab(tab)) populateModelDropdown(models);
      return models;
    })
    .catch(() => {
      const models = cacheModelListForTab(tab, []);
      if (isActiveTab(tab)) populateModelDropdown(models);
      return models;
    })
    .finally(() => {
      if (_modelListRequestByAccount.get(accountKey) === requestPromise) {
        _modelListRequestByAccount.delete(accountKey);
      }
    });
  _modelListRequestByAccount.set(accountKey, requestPromise);
  return requestPromise;
}

export function populateModelDropdown(models) {
  const dd = panelEl('#cxp-model');
  if (!dd) return;
  const menu = dd.querySelector('.cxp-dd-menu');
  if (!menu) return;
  menu.innerHTML = '';
  for (const m of models) {
    const name = getCodexModelName(m);
    if (!name) continue;
    const item = document.createElement('div');
    item.className = `cxp-dd-item cxp-model-item${name === activeTab()?.model ? ' selected' : ''}`;
    item.dataset.value = name;
    const copy = document.createElement('span');
    copy.className = 'cxp-model-item-copy';
    const label = document.createElement('span');
    label.className = 'cxp-model-item-label';
    label.textContent = m?.label || name;
    const description = document.createElement('span');
    description.className = 'cxp-model-item-desc';
    const baseContext = formatContextCapacity(m?.contextWindow);
    const extendedContext = m?.supportsExtendedContext ? formatContextCapacity(m?.maxContextWindow) : '';
    const context = [
      baseContext ? `${baseContext} default` : '',
      extendedContext ? `${extendedContext} extended` : '',
    ].filter(Boolean).join(' · ');
    description.textContent = [m?.desc || '', context].filter(Boolean).join(' · ');
    copy.append(label, description);
    item.appendChild(copy);
    item.addEventListener('click', () => {
      const tab = activeTab();
      if (tab) {
        tab.model = name;
        markExtendedContextPending(tab);
        const supported = normalizeReasoningEfforts(m, EFFORT_LEVELS.filter((effort) => effort !== 'off'));
        if (!supported.some((option) => option.id === tab.effort)) tab.effort = 'off';
      }
      storage.setItem(STOR.model, name);
      dd.classList.remove('open');
      renderEffortMenu();
      syncToolbarState();
      saveTabs();
    });
    menu.appendChild(item);
  }
  const tab = activeTab();
  if (tab) {
    const supported = effortOptionsForTab(tab);
    if (!supported.some((option) => option.id === (tab.effort || 'off'))) tab.effort = 'off';
  }
  renderEffortMenu();
  syncToolbarState();
}


// ── Stall/interrupt/compact (lines 8100-8165) ──
export function updateCostEstimate(tokenUsage) {
  if (!tokenUsage?.total) return;
  const tab = activeTab();
  if (!tab) return;
  const total = tokenUsage.total;
  const pricing = getModelPricing(tab.model || _threadContextMeta?.model) || {
    input: 2.50,
    cachedInput: 2.50,
    output: 10.00,
  };
  const uncachedInputTokens = Number(total.inputTokens) || 0;
  const cachedInputTokens = Number(total.cachedInputTokens) || 0;
  const cacheCreationInputTokens = Number(total.cacheCreationInputTokens) || 0;
  const outputTokens = (total.outputTokens || 0) + (total.reasoningOutputTokens || 0);
  tab.estimatedCost = (
    ((uncachedInputTokens + cacheCreationInputTokens) / 1_000_000) * pricing.input
    + (cachedInputTokens / 1_000_000) * pricing.cachedInput
    + (outputTokens / 1_000_000) * pricing.output
  );
  syncToolbarState();
}

// ── Phase 7: Stall detection ──
export function resetStallTimer() {
  const currentTab = activeTab();
  if ((_boundTab && _boundTab !== currentTab) || _boundTab?.automationActive || currentTab?.automationActive) return;
  _lastMsgTime = Date.now();
  clearTimeout(_stallTimer);
  if (!_running) return;
  _stallTimer = setTimeout(() => {
    if (!_running) return;
    const elapsed = Date.now() - _lastMsgTime;
    if (elapsed >= STALL_KILL_MS) {
      appendSystem(`Codex stalled (${Math.round(elapsed / 1000)}s with no messages). Interrupting.`, 'error');
      sendSocket({ type: 'force_kill' });
    } else if (elapsed >= STALL_WARN_MS) {
      appendSystem(`Codex may be stalled (${Math.round(elapsed / 1000)}s since last message).`, 'working');
      _stallTimer = setTimeout(() => resetStallTimer(), STALL_KILL_MS - elapsed);
    }
  }, STALL_WARN_MS);
}

export function stopStallTimer() {
  clearTimeout(_stallTimer);
  _stallTimer = null;
}

export function interruptTab(tab = activeTab()) {
  if (!tab?.running) return false;

  if (tab.automationActive && tab.automationRunId) {
    fetch('/api/loop/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: tab.automationRunId }),
    }).catch(() => {});
    return withTab(tab, () => {
      setRunning(false);
      setStatus('Stopped', 'info');
      appendSystem('Automation stopped.', 'muted');
      return true;
    });
  }

  return withTab(tab, () => {
    const threadId = _threadId || tab.threadId || null;

    // Reset UI immediately; the server interrupt/kill is best-effort cleanup.
    setRunning(false);
    setStatus('Stopped', 'info');
    appendSystem('Stopped.', 'muted');

    clearInterruptTimer();
    if (tab._abortRetry) {
      clearTimeout(tab._abortRetry);
      tab._abortRetry = null;
    }
    sendSocket({ type: 'interrupt', sessionId: tab.id, threadId });
    tab._abortRetry = setTimeout(() => {
      tab._abortRetry = null;
      const ws = tab.ws;
      if (ws?.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({
          type: 'force_kill',
          sessionId: tab.id,
          connectionEpoch: tab.connectionEpoch || '',
          threadId,
        }));
      } catch {}
    }, 2500);
    return true;
  });
}

export function interruptTurn() {
  return interruptTab(activeTab());
}

export function interruptAllTabs() {
  let stoppedAny = false;
  for (const tab of _tabs) {
    if (!tab?.running) continue;
    stoppedAny = true;
    const ws = tab.ws;
    const threadId = tab.threadId || null;
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({
          type: 'interrupt',
          sessionId: tab.id,
          connectionEpoch: tab.connectionEpoch || '',
          threadId,
        }));
      } catch {}
      if (tab._abortRetry) clearTimeout(tab._abortRetry);
      tab._abortRetry = setTimeout(() => {
        tab._abortRetry = null;
        try {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'force_kill',
              sessionId: tab.id,
              connectionEpoch: tab.connectionEpoch || '',
              threadId,
            }));
          }
        } catch {}
      }, 2000);
    }
    withTab(tab, () => {
      setRunning(false);
      clearInterruptTimer();
      appendSystem('Stopped.', 'muted');
    });
    if (Array.isArray(tab.queuedDrafts)) tab.queuedDrafts = [];
  }
  if (stoppedAny) syncInputEnabled();
  return stoppedAny;
}

export function anyTabRunning() {
  return _tabs.some((t) => t?.running);
}

export function clearInterruptTimer() {
  clearTimeout(_interruptTimer);
  _interruptTimer = null;
  _interruptRetried = false;
}

// ── Phase 7: Auto-compact detection ──
export function checkAutoCompact(tokenUsage) {
  if (!tokenUsage?.total) return;
  const inputTokens = resolveContextInputTokens(tokenUsage.total);
  _prevInputTokens = inputTokens;
}

function consumeComposer(input, tab, { clearAttachments = true, value = '' } = {}) {
  const ownsVisibleComposer = !!tab && isActiveTab(tab);
  if (input && ownsVisibleComposer) input.value = value;
  if (tab) tab.draft = value;
  if (clearAttachments && tab) {
    tab.attachedImages = [];
    tab.pendingPaths = [];
    tab.pendingMentions = [];
  }
  if (ownsVisibleComposer) {
    renderImageStrip();
    renderPathStrip();
    autosizeInput();
    syncInputEnabled();
  }
  saveTabs();
}

function currentComposerPayload() {
  const input = panelEl('#cxp-input');
  const tab = activeTab();
  return {
    input,
    tab,
    prompt: String(input?.value || '').trim(),
    images: [...(tab?.attachedImages || [])],
    paths: [...(tab?.pendingPaths || [])],
    mentions: [...(tab?.pendingMentions || [])],
  };
}

function enqueuePayload({ tab, prompt, images, paths, mentions }) {
  if (!tab) return false;
  tab.queue.push({
    id: crypto.randomUUID(),
    text: prompt,
    images: [...(images || [])],
    paths: [...(paths || [])],
    mentions: [...(mentions || [])],
    timestamp: Date.now(),
  });
  syncQueueTray();
  saveTabs();
  return true;
}

function normalizeConfigResult(raw) {
  const values = raw?.values || raw?.config?.values || raw?.config || raw || {};
  const effective = {};
  const layers = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (value && typeof value === 'object' && 'value' in value) {
      effective[key] = value.value;
      layers[key] = value.layer || value.source || '';
    } else {
      effective[key] = value;
    }
  }
  return { effective, layers };
}

function formatPercentage(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${Math.round(num)}%` : 'n/a';
}

function formatResetTime(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 'unknown';
  return new Date(num * 1000).toLocaleString();
}

function rateLimitLines(rateLimits) {
  const buckets = rateLimits?.rateLimitsByLimitId || {};
  const lines = [];
  for (const [bucketId, bucket] of Object.entries(buckets)) {
    if (!bucket) continue;
    lines.push(`- \`${bucket.limitName || bucketId}\`: ${formatPercentage(bucket.primary?.usedPercent)} used, resets ${formatResetTime(bucket.primary?.resetsAt)}`);
  }
  if (!lines.length && rateLimits?.rateLimits) {
    lines.push(`- \`${rateLimits.rateLimits.limitName || rateLimits.rateLimits.limitId || 'default'}\`: ${formatPercentage(rateLimits.rateLimits.primary?.usedPercent)} used, resets ${formatResetTime(rateLimits.rateLimits.primary?.resetsAt)}`);
  }
  return lines;
}

function latestCompletedAssistantText(tab = activeTab()) {
  if (!tab) return '';
  if (tab.editedPlanContent?.trim()) return tab.editedPlanContent.trim();
  if (tab.planContent?.trim()) return tab.planContent.trim();

  const states = Array.from(tab.items?.values?.() || []);
  for (let i = states.length - 1; i >= 0; i -= 1) {
    const state = states[i];
    if (!state || (state.type !== 'agentMessage' && state.type !== 'plan')) continue;
    const text = String(state.buffer || '').trim();
    if (text) return text;
  }

  const messages = tab.messagesEl?.querySelectorAll('.cxp-msg-assistant .cxp-msg-body') || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = String(messages[i].textContent || '').trim();
    if (text) return text;
  }
  return '';
}

async function copyTextToClipboard(text) {
  if (!text) throw new Error('Nothing to copy');
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

async function requestGitDiff(dir) {
  const params = new URLSearchParams({ path: dir, maxLines: '1200' });
  const res = await fetch(`/api/git/diff?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not read Git diff');
  return data;
}

function formatStatusSnapshotMarkdown(snapshot, tab = activeTab()) {
  const runtime = snapshot?.runtime || {};
  const { effective } = normalizeConfigResult(snapshot?.config || {});
  const account = snapshot?.account?.account || null;
  const rateLimits = snapshot?.rateLimits || {};
  const tokenUsage = normalizeThreadTokenUsage(tab?.threadTokenUsage || _threadTokenUsage);
  const inputTokens = resolveContextInputTokens(tokenUsage?.total);
  const outputTokens = Number(tokenUsage?.total?.outputTokens || 0) + Number(tokenUsage?.total?.reasoningOutputTokens || 0);
  const clientIsolationDrops = Object.values(tab?.isolationRejections || {})
    .reduce((total, count) => total + (Number(count) || 0), 0);
  const lines = [
    '## Session status',
    '',
    `- Thread: \`${runtime.displayedThreadId || tab?.threadId || runtime.activeThreadId || 'none'}\`${runtime.activeTurnId ? ` (active turn \`${runtime.activeTurnId}\`)` : ''}`,
    `- Model: \`${tab?.model || effective.model || 'default'}\``,
    `- Reasoning effort: \`${tab?.effort && tab.effort !== 'off' ? tab.effort : (effective.model_reasoning_effort || 'default')}\``,
    `- Reasoning summary: \`${effective.model_reasoning_summary || 'default'}\``,
    `- Response verbosity: \`${effective.model_verbosity || 'default'}\``,
    `- Personality: \`${effective.personality || 'pragmatic'}\``,
    `- Fast mode: \`${effective.service_tier || 'default'}\``,
    `- Approval policy: \`${runtime.approvalPolicy || effective.approval_policy || 'on-request'}\``,
    `- Sandbox mode: \`${effective.sandbox_mode || 'workspace-write'}\``,
    `- Web search: \`${String(effective.web_search ?? false)}\``,
    `- Writable roots: ${Array.isArray(snapshot?.writableRoots) && snapshot.writableRoots.length ? snapshot.writableRoots.map((root) => `\`${root}\``).join(', ') : 'n/a'}`,
    `- Context usage: ${inputTokens ? `~${inputTokens.toLocaleString()} input` : 'n/a'}${outputTokens ? `, ${outputTokens.toLocaleString()} output` : ''}`,
    `- Pending approvals/input: \`${runtime.pendingServerRequests ?? 0}\``,
    `- Isolation drops: \`${runtime.isolation?.rejected ?? 0}\` server, \`${clientIsolationDrops}\` client`,
    `- Runtime: \`${runtime.codexBinSource || 'global'}\`${runtime.sdkInstalled ? ' with local `@openai/codex-sdk` installed' : ''}`,
  ];
  if (account) {
    lines.push(`- Account: \`${account.email || account.name || account.type || 'signed in'}\`${account.planType ? ` (${account.planType})` : ''}`);
  } else {
    lines.push('- Account: signed out');
  }
  const rateLines = rateLimitLines(rateLimits);
  if (rateLines.length) lines.push('', '## Rate limits', '', ...rateLines);
  return lines.join('\n');
}

function formatDebugConfigMarkdown(configResult, requirementsResult = {}) {
  const { effective, layers } = normalizeConfigResult(configResult);
  const requirements = requirementsResult?.requirements?.requirements || requirementsResult?.requirements || {};
  const rows = Object.keys(effective).sort().map((key) => `- \`${key}\`: \`${JSON.stringify(effective[key])}\`${layers[key] ? ` via \`${layers[key]}\`` : ''}`);
  const reqLines = [];
  if (requirements?.allowedApprovalPolicies?.length) {
    reqLines.push(`- Allowed approvals: ${requirements.allowedApprovalPolicies.map((value) => `\`${value}\``).join(', ')}`);
  }
  if (requirements?.allowedSandboxModes?.length) {
    reqLines.push(`- Allowed sandbox modes: ${requirements.allowedSandboxModes.map((value) => `\`${value}\``).join(', ')}`);
  }
  if (requirements?.featureRequirements && typeof requirements.featureRequirements === 'object') {
    reqLines.push(...Object.entries(requirements.featureRequirements).map(([key, value]) => `- Feature \`${key}\`: \`${String(value)}\``));
  }
  return [
    '## Effective config',
    '',
    ...(rows.length ? rows : ['- No config values reported.']),
    '',
    '## Requirements',
    '',
    ...(reqLines.length ? reqLines : ['- No admin requirements reported.']),
  ].join('\n');
}

function formatMcpMarkdown(servers = []) {
  if (!servers.length) return 'No MCP servers are configured.';
  return [
    '## MCP servers',
    '',
    ...servers.map((server) => `- \`${server.name || 'unknown'}\`: \`${server.status || 'unknown'}\`${server.requiresOAuth ? ' (OAuth required)' : ''}${server.error ? ` — ${server.error}` : ''}`),
  ].join('\n');
}

function formatAppMarkdown(appsResult = {}) {
  const apps = Array.isArray(appsResult) ? appsResult : (appsResult?.data || appsResult?.apps || []);
  if (!apps.length) return 'No apps are available for the current session.';
  return [
    '## Apps',
    '',
    ...apps.map((app) => `- \`$${app.name || app.id || 'app'}\`${app.enabled === false ? ' (disabled)' : ''}${app.accessible === false ? ' (inaccessible)' : ''}${app.description ? ` — ${app.description}` : ''}`),
  ].join('\n');
}

function formatPluginMarkdown(pluginResult = {}) {
  const marketplaces = Array.isArray(pluginResult) ? pluginResult : (pluginResult?.marketplaces || pluginResult?.data || []);
  if (!marketplaces.length) return 'No plugin marketplaces were reported.';
  const lines = ['## Plugins', ''];
  for (const marketplace of marketplaces) {
    lines.push(`- \`${marketplace.name || marketplace.path || 'marketplace'}\`${marketplace.error ? ` — ${marketplace.error}` : ''}`);
    const plugins = marketplace.plugins || marketplace.installedPlugins || [];
    for (const plugin of plugins) {
      lines.push(`- \`${marketplace.name || marketplace.path || 'marketplace'}/${plugin.name || plugin.id || 'plugin'}\`${plugin.installed ? ' installed' : ''}${plugin.enabled ? ', enabled' : ''}`);
    }
  }
  return lines.join('\n');
}

function formatExperimentalMarkdown(featureResult = {}) {
  const features = Array.isArray(featureResult) ? featureResult : (featureResult?.data || featureResult?.features || []);
  if (!features.length) return 'No experimental features were reported.';
  return [
    '## Experimental features',
    '',
    ...features.map((feature) => `- \`${feature.name}\`: \`${feature.enabled ? 'enabled' : 'disabled'}\` (${feature.stage || 'unknown'})${feature.description ? ` — ${feature.description}` : ''}`),
  ].join('\n');
}

function formatLoadedThreadsMarkdown(result = {}) {
  const threads = Array.isArray(result) ? result : (result?.threadIds || result?.threads || result?.data || []);
  if (!threads.length) return 'No in-memory agent threads are currently loaded.';
  return [
    '## Loaded threads',
    '',
    ...threads.map((entry) => {
      if (typeof entry === 'string') return `- \`${entry}\``;
      return `- \`${entry.threadId || entry.id || 'unknown'}\`${entry.kind ? ` (${entry.kind})` : ''}${entry.cwd ? ` — \`${entry.cwd}\`` : ''}`;
    }),
  ].join('\n');
}

function formatBackgroundProcessesMarkdown(tab = activeTab()) {
  if (!tab) return 'No active Codex session.';
  const items = Array.from(tab.items?.values?.() || []).filter((item) => item?.type === 'commandExecution');
  const active = items.filter((item) => item.status !== 'complete' && item.status !== 'failed');
  if (!active.length) return 'No background terminals are currently visible in this session.';
  return [
    '## Running commands',
    '',
    ...active.map((item) => {
      const lastLine = String(item.aggregatedOutput || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
      return `- \`${item.command || 'command'}\`${lastLine ? ` — ${lastLine}` : ''}`;
    }),
  ].join('\n');
}

function parseSlashCommand(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: String(match[2] || '').trim(), raw: trimmed };
}

function setModelForTab(tab, model) {
  if (!tab || !model) return;
  tab.model = model;
  markExtendedContextPending(tab);
  storage.setItem(STOR.model, model);
  requestModelList();
  syncToolbarState();
  saveTabs();
}

function setEffortForTab(tab, effort) {
  if (!tab) return false;
  const normalized = String(effort || '').trim().toLowerCase();
  const nextEffort = normalized === 'default' || normalized === 'none' ? 'off' : normalized;
  const supported = effortOptionsForTab(tab);
  if (!supported.some((option) => option.id === nextEffort)) {
    withTab(tab, () => appendSystem(`Unsupported reasoning effort for ${tab.model || 'this model'}: ${effort}. Use ${supported.map((option) => option.id).join(', ')}.`, 'error'));
    return false;
  }
  tab.effort = nextEffort;
  storage.setItem(STOR.effort, nextEffort);
  syncToolbarState();
  saveTabs();
  return true;
}

async function handleLocalSlashCommand(payload = currentComposerPayload()) {
  const parsed = parseSlashCommand(payload.prompt);
  if (!parsed) return false;
  const { input, tab, images, paths, mentions } = payload;
  if (!tab) return true;
  const localCommands = new Set([
    'agent', 'apps', 'clean', 'clear', 'compact', 'copy', 'debug-config', 'diff', 'effort',
    'experimental', 'fast', 'fork', 'init', 'logout', 'mcp', 'mention', 'model',
    'new', 'permissions', 'personality', 'plan', 'plugins', 'ps', 'queue',
    'resume', 'review', 'status', 'stop',
  ]);
  if (!localCommands.has(parsed.name)) return false;

  const appendMarkdown = (markdown) => appendAssistantMarkdownMessage(tab, markdown);
  const appendStatus = (text, tone = 'muted') => withTab(tab, () => appendSystem(text, tone));
  const requestForTab = (type, data = {}) => requestSocketPayloadForTab(tab, type, data);
  const args = parsed.args;
  const sendInlinePrompt = (nextPrompt, options = {}) => {
    const pendingImages = images.length ? [...images] : null;
    const sent = withTab(tab, () => dispatchPrompt(nextPrompt, {
      tab,
      images,
      paths,
      forcePlanModePrefix: options.forcePlanModePrefix ?? tab.planMode,
      mentions: options.mentions || mentions || [],
    }));
    if (!sent) return false;
    if (pendingImages?.length) {
      withTab(tab, () => appendLocalUserMessage(nextPrompt, pendingImages));
      tab._pendingSendImages = pendingImages;
    }
    consumeComposer(input, tab);
    return true;
  };
  const updateConfig = async (config) => requestForTab('config_write', { config });

  switch (parsed.name) {
    case 'compact':
      if (tab.running || tab.startingThread || tab.compacting) {
        appendStatus('Compaction is unavailable while Codex is busy.', 'error');
        break;
      }
      withTab(tab, () => startCompaction());
      consumeComposer(input, tab, { clearAttachments: false });
      break;
    case 'clear':
      if (tab.running) {
        appendStatus('/clear is unavailable while a turn is running.', 'error');
        break;
      }
      consumeComposer(input, tab);
      await startNewThread(tab);
      break;
    case 'new':
      if (tab.running) {
        appendStatus('/new is unavailable while a turn is running.', 'error');
        break;
      }
      consumeComposer(input, tab);
      await startNewThread(tab);
      break;
    case 'resume':
      consumeComposer(input, tab, { clearAttachments: false });
      panelEl('#cxp-session-menu')?.classList.add('open');
      await renderSessionMenu();
      break;
    case 'fork':
      if (!tab.threadId) {
        appendStatus('There is no active thread to fork.', 'error');
        break;
      }
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const result = await requestForTab('thread_fork', { threadId: tab.threadId });
        const forked = result?.thread;
        if (forked?.id) {
          createTab({ project: tab.project, threadId: forked.id, title: forked.name || `Fork of ${tab.sessionLabel}` });
          appendStatus(`Forked current thread into ${forked.id}.`, 'muted');
        }
      }
      break;
    case 'review':
      if (!tab.threadId) {
        appendStatus('Start or resume a Codex thread before running /review.', 'error');
        break;
      }
      consumeComposer(input, tab, { clearAttachments: false });
      await requestForTab('review_start', { threadId: tab.threadId });
      appendStatus('Started working tree review.', 'working');
      break;
    case 'status':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const snapshot = await requestForTab('status_snapshot', { cwd: tab.project || null });
        appendMarkdown(formatStatusSnapshotMarkdown(snapshot.snapshot, tab));
      }
      break;
    case 'debug-config':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const [configData, requirements] = await Promise.all([
          requestForTab('config_read', {}),
          requestForTab('config_requirements', {}),
        ]);
        appendMarkdown(formatDebugConfigMarkdown(configData.config, requirements));
      }
      break;
    case 'permissions':
      consumeComposer(input, tab, { clearAttachments: false });
      if (!args) {
        await openSettingsPanel();
        appendMarkdown('Open the settings panel to adjust approval policy and sandbox mode, or run `/permissions auto`, `/permissions on-request`, `/permissions read-only`, or `/permissions full-access`.');
        break;
      }
      {
        const normalized = args.toLowerCase();
        let config = null;
        if (normalized === 'auto' || normalized === 'never') config = { approval_policy: 'never', sandbox_mode: 'workspace-write' };
        else if (normalized === 'on-request' || normalized === 'ask') config = { approval_policy: 'on-request' };
        else if (normalized === 'unless-trusted' || normalized === 'trusted' || normalized === 'untrusted') config = { approval_policy: 'untrusted' };
        else if (normalized === 'read-only' || normalized === 'readonly') config = { approval_policy: 'on-request', sandbox_mode: 'read-only' };
        else if (normalized === 'full-access' || normalized === 'danger-full-access') config = { sandbox_mode: 'danger-full-access' };
        else if (normalized === 'workspace-write') config = { sandbox_mode: 'workspace-write' };
        if (!config) {
          appendStatus(`Unknown permissions preset: ${args}`, 'error');
          break;
        }
        await updateConfig(config);
        appendMarkdown(`Updated permissions: \`${config.approval_policy || 'unchanged approval'}\`, \`${config.sandbox_mode || 'unchanged sandbox'}\`.`);
      }
      break;
    case 'fast':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const configData = await requestForTab('config_read', {});
        const { effective } = normalizeConfigResult(configData.config);
        const current = String(effective.service_tier || '').toLowerCase();
        let next = current === 'fast' ? 'flex' : 'fast';
        if (args) {
          if (['on', 'fast'].includes(args.toLowerCase())) next = 'fast';
          else if (['off', 'flex', 'default'].includes(args.toLowerCase())) next = 'flex';
          else if (args.toLowerCase() === 'status') {
            appendMarkdown(`Fast mode is currently \`${current || 'default'}\`.`);
            break;
          }
        }
        await updateConfig({ service_tier: next, features: { fast_mode: true } });
        appendMarkdown(`Fast mode set to \`${next}\`.`);
      }
      break;
    case 'personality':
      consumeComposer(input, tab, { clearAttachments: false });
      if (!args) {
        const configData = await requestForTab('config_read', {});
        const { effective } = normalizeConfigResult(configData.config);
        appendMarkdown(`Current personality: \`${effective.personality || 'pragmatic'}\`. Run \`/personality friendly\` or \`/personality pragmatic\`.`);
        break;
      }
      await updateConfig({ personality: args, features: { personality: true } });
      appendMarkdown(`Personality set to \`${args}\`.`);
      break;
    case 'model':
      if (!args) {
        consumeComposer(input, tab, { clearAttachments: false });
        panelEl('#cxp-model')?.classList.toggle('open');
        break;
      }
      consumeComposer(input, tab, { clearAttachments: false });
      setModelForTab(tab, args);
      appendMarkdown(`Active model set to \`${args}\`.`);
      break;
    case 'effort':
      consumeComposer(input, tab, { clearAttachments: false });
      if (!args) {
        cycleEffort(tab);
        break;
      }
      if (setEffortForTab(tab, args)) appendMarkdown(`Reasoning effort set to \`${tab.effort || 'off'}\`.`);
      break;
    case 'mcp':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const result = await requestForTab('mcp_status', {});
        appendMarkdown(formatMcpMarkdown(result.servers || []));
      }
      break;
    case 'apps':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const result = await requestForTab('app_list', { threadId: tab.threadId || null });
        appendMarkdown(formatAppMarkdown(result.apps));
      }
      break;
    case 'plugins':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const result = await requestForTab('plugin_list', {});
        appendMarkdown(formatPluginMarkdown(result.plugins));
      }
      break;
    case 'agent':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const result = await requestForTab('thread_loaded_list', {});
        appendMarkdown(formatLoadedThreadsMarkdown(result.threads));
      }
      break;
    case 'ps':
      consumeComposer(input, tab, { clearAttachments: false });
      appendMarkdown(formatBackgroundProcessesMarkdown(tab));
      break;
    case 'clean':
    case 'stop':
      consumeComposer(input, tab, { clearAttachments: false });
      if (!tab.threadId) {
        appendStatus('There is no active thread to stop background terminals for.', 'error');
        break;
      }
      await requestForTab('background_clean', { threadId: tab.threadId });
      appendMarkdown('Stopped background terminals for the current thread.');
      break;
    case 'copy':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const text = latestCompletedAssistantText(tab);
        if (!text) {
          appendStatus('No completed Codex response is available yet.', 'error');
          break;
        }
        await copyTextToClipboard(text);
        appendStatus('Copied the latest completed Codex output.', 'muted');
      }
      break;
    case 'experimental':
      consumeComposer(input, tab, { clearAttachments: false });
      {
        const result = await requestForTab('experimental_features', {});
        if (args) {
          const match = args.match(/^([A-Za-z0-9_.-]+)\s+(on|off)$/i);
          if (match) {
            const [, featureName, enabled] = match;
            await updateConfig({ features: { [featureName]: enabled.toLowerCase() === 'on' } });
            appendMarkdown(`Experimental feature \`${featureName}\` set to \`${enabled.toLowerCase()}\`.`);
            break;
          }
        }
        appendMarkdown(formatExperimentalMarkdown(result.features));
      }
      break;
    case 'logout':
      consumeComposer(input, tab, { clearAttachments: false });
      await requestForTab('account_logout', {});
      appendMarkdown('Logged out of Codex.');
      break;
    case 'diff':
      consumeComposer(input, tab, { clearAttachments: false });
      if (!tab.project) {
        appendStatus('Select a project before running /diff.', 'error');
        break;
      }
      {
        const diff = await requestGitDiff(tab.project);
        const sections = ['## Working tree diff', '', `- Branch: \`${diff.branch || 'unknown'}\``];
        if (diff.untrackedFiles?.length) sections.push(`- Untracked files: ${diff.untrackedFiles.map((file) => `\`${file}\``).join(', ')}`);
        if (diff.diff) sections.push('', '```diff', diff.diff, '```');
        if (diff.stagedDiff) sections.push('', '## Staged diff', '', '```diff', diff.stagedDiff, '```');
        if (!diff.diff && !diff.stagedDiff && !diff.untrackedFiles?.length) sections.push('', 'Working tree is clean.');
        appendMarkdown(sections.join('\n'));
      }
      break;
    case 'plan':
      if (tab.running) {
        appendStatus('/plan is unavailable while a turn is running.', 'error');
        break;
      }
      if (!tab.planMode) togglePlanMode(tab);
      if (!args) {
        consumeComposer(input, tab, { clearAttachments: false });
        appendStatus('Plan mode enabled.', 'muted');
        break;
      }
      sendInlinePrompt(args, { forcePlanModePrefix: true });
      break;
    case 'queue':
      consumeComposer(input, tab, { clearAttachments: false });
      syncQueueTray();
      break;
    case 'mention':
      consumeComposer(input, tab, { clearAttachments: false });
      if (!args) {
        appendMarkdown('Usage: `/mention path/to/file` to add a structured file mention for the next turn.');
        break;
      }
      {
        const isAbsolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(args);
        const root = String(tab.project || '').replace(/[\\/]+$/, '');
        const relative = args.replace(/^[/\\]+/, '');
        addFileMention({ path: isAbsolute ? args : `${root}/${relative}`, name: relative }, tab);
        appendStatus(`Mentioned ${relative}.`, 'muted');
      }
      break;
    case 'init':
      if (tab.running) {
        appendStatus('/init is unavailable while a turn is running.', 'error');
        break;
      }
      {
        const initPrompt = args || 'Create or update an AGENTS.md file for this repository. Capture build/test commands, code style, safety constraints, review expectations, and any project-specific workflow guidance that Codex should follow in future sessions.';
        sendInlinePrompt(initPrompt, { forcePlanModePrefix: false });
      }
      break;
    default:
      return false;
  }
  return true;
}

// ── Send prompt & queue (lines 8165-8320) ──
export function sendPrompt() {
  const payload = currentComposerPayload();
  const { input, tab, prompt, images, paths, mentions } = payload;
  if (!input || !_connected || !_bootstrapped) return;
  if (!prompt && !images.length && !paths.length && !mentions.length) return;
  // Block when CLI binary missing — banner already informs user.
  const panel = document.getElementById('codex-panel');
  if (panel?.classList.contains('cxp-cli-blocked')) {
    appendSystem('Codex CLI not installed. Install it first, then click Re-check.', 'error');
    return;
  }
  handleLocalSlashCommand(payload).then((handled) => {
    if (handled || !tab || tab.closed) return;
    withTab(tab, () => {
      if (_running) {
        enqueuePayload({ tab, prompt, images, paths, mentions });
        consumeComposer(input, tab);
        return;
      }
      if (shouldHoldForPlanApproval(tab)) {
        appendSystem('Choose Continue with implementation, Compact context, or Edit plan before sending another message.', 'working');
        return;
      }
      if (tab.planMode) {
        preparePlanModeTurn(tab);
      }
      const pendingImages = images.length ? [...images] : null;
      const sent = dispatchPrompt(prompt, {
        tab,
        images,
        paths,
        mentions,
        forcePlanModePrefix: tab.planMode,
      });
      if (!sent) return;
      if (pendingImages?.length) {
        appendLocalUserMessage(prompt, pendingImages);
        tab._pendingSendImages = pendingImages;
      }
      consumeComposer(input, tab);
    });
  }).catch((err) => {
    if (tab && !tab.closed) withTab(tab, () => appendSystem(err.message || 'Command failed', 'error'));
  });
}

export function queueCurrentDraft() {
  const { input, tab, prompt, images, paths, mentions } = currentComposerPayload();
  if (!input || !tab) return false;
  if (tab.automationActive) {
    setStatus('Stop the running automation before queueing a manual turn', 'info');
    return false;
  }
  if (!prompt && !images.length && !paths.length && !mentions.length) return false;
  enqueuePayload({ tab, prompt, images, paths, mentions });
  consumeComposer(input, tab);
  return true;
}

export function steerActiveTurn() {
  const { input, tab, prompt, images, paths, mentions } = currentComposerPayload();
  if (!input || !tab || !_running || !_threadId) return false;
  if (tab.automationActive) {
    setStatus('Stop the running automation before steering a turn', 'info');
    return false;
  }
  if (!prompt && !images.length && !paths.length && !mentions.length) return false;
  let finalPrompt = prompt;
  if (paths.length) {
    finalPrompt += `${finalPrompt ? '\n\n' : ''}Referenced files:\n${paths.map((path) => `- ${path}`).join('\n')}`;
  }
  if (!sendSocket({
    type: 'turn_steer',
    requestId: crypto.randomUUID(),
    threadId: _threadId,
    prompt: finalPrompt,
    images: images.map((img) => img?.dataUrl || img).filter(Boolean),
    mentions,
  })) return false;
  consumeComposer(input, tab);
  return true;
}

export function syncQueueTray() {
  const tab = activeTab();
  if (!tab) return;
  const queue = tab.queue || [];
  const count = queue.length;
  const tray = panelEl('#cxp-queue-tray');
  const badge = panelEl('#cxp-queue-badge');
  const list = panelEl('#cxp-queue-list');
  const pauseBtn = panelEl('#cxp-queue-pause');
  const hint = panelEl('.cxp-hint');

  if (tray) tray.hidden = count === 0;
  if (badge) badge.textContent = String(count);
  if (pauseBtn) pauseBtn.textContent = tab.queuePaused ? '\u25B6' : '\u23F8';
  if (hint) {
    hint.textContent = count > 0
      ? `${count} message${count > 1 ? 's' : ''} queued${tab.queuePaused ? ' (paused)' : ''}. Enter steers. Tab queues the next turn.`
      : _running
        ? 'Enter steers the active turn. Tab queues the next turn. Shift+Enter inserts a newline.'
        : 'Enter sends. Shift+Enter inserts a newline.';
  }
  if (!list) return;
  list.innerHTML = '';
  queue.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'cxp-queue-item';
    row.draggable = true;
    row.dataset.idx = String(idx);
    const text = document.createElement('span');
    text.className = 'cxp-queue-item-text';
    text.textContent = (item.text || '').slice(0, 80) + ((item.text || '').length > 80 ? '…' : '');
    const editBtn = document.createElement('button');
    editBtn.className = 'cxp-btn cxp-btn-sm cxp-queue-edit';
    editBtn.textContent = '\u270E';
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', () => editQueueItem(idx));
    const removeBtn = document.createElement('button');
    removeBtn.className = 'cxp-btn cxp-btn-sm cxp-queue-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => { queue.splice(idx, 1); syncQueueTray(); saveTabs(); });
    row.append(text, editBtn, removeBtn);
    // Drag reorder
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(idx)); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (isNaN(fromIdx) || fromIdx === idx) return;
      const [moved] = queue.splice(fromIdx, 1);
      queue.splice(idx, 0, moved);
      syncQueueTray();
      saveTabs();
    });
    list.appendChild(row);
  });
}

export function editQueueItem(idx) {
  const tab = activeTab();
  if (!tab?.queue?.[idx]) return;
  const item = tab.queue[idx];
  const newText = prompt('Edit queued message:', item.text || '');
  if (newText === null) return;
  item.text = newText;
  syncQueueTray();
  saveTabs();
}

export function toggleQueuePause() {
  const tab = activeTab();
  if (!tab) return;
  tab.queuePaused = !tab.queuePaused;
  syncQueueTray();
  if (!tab.queuePaused) advanceQueue();
  saveTabs();
}

export function clearQueue() {
  const tab = activeTab();
  if (!tab) return;
  tab.queue = [];
  syncQueueTray();
  saveTabs();
}

export function advanceQueue() {
  const tab = activeTab();
  if (!tab || _running || tab.queuePaused || !tab.queue.length || hasBlockingServerRequests() || shouldHoldForPlanApproval(tab)) return;
  const next = tab.queue.shift();
  if (!next) return;
  if (tab.planMode) {
    preparePlanModeTurn(tab);
  }
  const queueImages = next.images?.length ? [...next.images] : null;
  const sent = dispatchPrompt(next.text || '', {
    tab,
    images: next.images || [],
    paths: next.paths || [],
    mentions: next.mentions || [],
    forcePlanModePrefix: tab.planMode,
  });
  if (!sent) return;
  // Render queued user message immediately with images
  if (queueImages?.length) {
    appendLocalUserMessage(next.text || '', queueImages);
    tab._pendingSendImages = queueImages;
  }
  syncQueueTray();
}

// ── Phase 2: Image attachments ──
const MAX_IMAGES = 5;

export function addImageFromFile(file) {

// ── Image/path handling (lines 8320-8420) ──
  const tab = activeTab();
  if (!tab) return;
  if ((tab.attachedImages?.length || 0) >= MAX_IMAGES) return;
  const reader = new FileReader();
  reader.onload = () => {
    tab.attachedImages = tab.attachedImages || [];
    tab.attachedImages.push({ name: file.name, dataUrl: reader.result });
    renderImageStrip();
    syncInputEnabled();
  };
  reader.readAsDataURL(file);
}

export function removeImage(idx) {
  const tab = activeTab();
  if (!tab?.attachedImages) return;
  tab.attachedImages.splice(idx, 1);
  renderImageStrip();
  syncInputEnabled();
}

export function renderImageStrip() {
  const strip = panelEl('#cxp-image-strip');
  if (!strip) return;
  const tab = activeTab();
  const images = tab?.attachedImages || [];
  strip.innerHTML = '';
  strip.hidden = images.length === 0;
  images.forEach((img, idx) => {
    const chip = document.createElement('div');
    chip.className = 'cxp-image-chip';
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    imgEl.alt = img.name;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'cxp-image-chip-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', () => removeImage(idx));
    chip.append(imgEl, removeBtn);
    strip.appendChild(chip);
  });
}

// ── Whiteboard "Send to Panel" — receive image via event bus ──
appOn('wb:send-to-panel', ({ dataUrl }) => {
  if (!dataUrl) return;
  if (!_getVisible() && appState.lastActivePanel !== 'codex') return;
  if (!_getVisible()) _toggleCodexPanel();
  const tab = activeTab();
  if (!tab) return;
  tab.attachedImages = tab.attachedImages || [];
  tab.attachedImages.push({ name: 'whiteboard-image', dataUrl });
  renderImageStrip();
  syncInputEnabled();
});

// ── Phase 2: File path chips ──
export function addPathChip(path) {
  const tab = activeTab();
  if (!tab) return;
  tab.pendingPaths = tab.pendingPaths || [];
  const norm = path.trim();
  if (!norm || tab.pendingPaths.includes(norm)) return;
  tab.pendingPaths.push(norm);
  renderPathStrip();
  syncInputEnabled();
}

export function removePathChip(idx) {
  const tab = activeTab();
  if (!tab?.pendingPaths) return;
  tab.pendingPaths.splice(idx, 1);
  renderPathStrip();
  syncInputEnabled();
}

export function addFileMention(mention, tab = activeTab()) {
  if (!tab || !mention?.path) return;
  tab.pendingMentions = tab.pendingMentions || [];
  const path = String(mention.path).trim();
  if (!path || tab.pendingMentions.some((entry) => entry.path === path)) return;
  tab.pendingMentions.push({
    path,
    name: String(mention.name || basenamePath(path) || path).trim(),
  });
  if (isActiveTab(tab)) {
    renderPathStrip();
    syncInputEnabled();
  }
}

export function removeFileMention(idx) {
  const tab = activeTab();
  if (!tab?.pendingMentions) return;
  tab.pendingMentions.splice(idx, 1);
  renderPathStrip();
  syncInputEnabled();
}

export function renderPathStrip() {
  const strip = panelEl('#cxp-path-strip');
  if (!strip) return;
  const tab = activeTab();
  const paths = tab?.pendingPaths || [];
  const mentions = tab?.pendingMentions || [];
  strip.innerHTML = '';
  strip.hidden = paths.length === 0 && mentions.length === 0;
  const appendChip = (label, remove, className = '') => {
    const chip = document.createElement('span');
    chip.className = `cxp-path-chip${className ? ` ${className}` : ''}`;
    chip.textContent = label;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'cxp-path-chip-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = `Remove ${label}`;
    removeBtn.addEventListener('click', remove);
    chip.appendChild(removeBtn);
    strip.appendChild(chip);
  };
  mentions.forEach((mention, idx) => {
    appendChip(`@${mention.name || basenamePath(mention.path)}`, () => removeFileMention(idx), 'cxp-path-chip--mention');
  });
  paths.forEach((path, idx) => {
    appendChip(path, () => removePathChip(idx));
  });
}

// ── Phase 2: Voice input (hold-to-talk) ──
let _speechRecognition = null;

// ── Voice/slash (lines 8420-8588) ──
export function initVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;
  const micBtn = panelEl('#cxp-mic-btn');
  if (!micBtn) return;
  micBtn.hidden = false;
  let recognition = null;

  micBtn.addEventListener('mousedown', () => {
    if (recognition) return;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => {
      const input = panelEl('#cxp-input');
      if (!input) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const transcript = event.results[i][0].transcript;
          input.value += (input.value ? ' ' : '') + transcript;
          const tab = activeTab();
          if (tab) tab.draft = input.value;
          autosizeInput();
          syncInputEnabled();
        }
      }
    };
    recognition.onerror = () => { recognition = null; micBtn.classList.remove('cxp-mic-active'); };
    recognition.onend = () => { recognition = null; micBtn.classList.remove('cxp-mic-active'); };
    recognition.start();
    micBtn.classList.add('cxp-mic-active');
    _speechRecognition = recognition;
  });

  const stopMic = () => {
    if (recognition) {
      recognition.stop();
      recognition = null;
      _speechRecognition = null;
    }
    micBtn.classList.remove('cxp-mic-active');
  };
  micBtn.addEventListener('mouseup', stopMic);
  micBtn.addEventListener('mouseleave', stopMic);
}

// ── Phase 2: Slash command hints ──
const BUILTIN_SLASH_COMMANDS = [
  { cmd: '/agent', desc: 'List loaded agent threads' },
  { cmd: '/apps', desc: 'List available apps' },
  { cmd: '/compact', desc: 'Compact thread context' },
  { cmd: '/clear', desc: 'Clear the transcript' },
  { cmd: '/copy', desc: 'Copy the latest completed output' },
  { cmd: '/debug-config', desc: 'Show merged config details' },
  { cmd: '/diff', desc: 'Show the Git diff' },
  { cmd: '/experimental', desc: 'Inspect experimental features' },
  { cmd: '/fast', desc: 'Toggle fast mode' },
  { cmd: '/fork', desc: 'Fork the current thread' },
  { cmd: '/init', desc: 'Create or update AGENTS.md guidance' },
  { cmd: '/logout', desc: 'Sign out of Codex' },
  { cmd: '/mcp', desc: 'List MCP server status' },
  { cmd: '/mention', desc: 'Add a file path chip' },
  { cmd: '/model', desc: 'Switch model' },
  { cmd: '/new', desc: 'Start a fresh conversation' },
  { cmd: '/permissions', desc: 'Update approvals and sandboxing' },
  { cmd: '/personality', desc: 'Set the active personality' },
  { cmd: '/plan', desc: 'Toggle or send a plan-mode prompt' },
  { cmd: '/plugins', desc: 'List plugin marketplaces' },
  { cmd: '/ps', desc: 'Inspect running background terminals' },
  { cmd: '/effort', desc: 'Cycle effort level' },
  { cmd: '/queue', desc: 'Show queued messages' },
  { cmd: '/resume', desc: 'Open the session picker' },
  { cmd: '/review', desc: 'Review the current working tree' },
  { cmd: '/status', desc: 'Show active session status' },
  { cmd: '/stop', desc: 'Stop background terminals' },
];

let _slashActiveIdx = -1;
let _fileHintRequest = 0;
let _fileHintTimer = null;
let _fileHintAbort = null;

function activeFileMentionToken(input) {
  if (!input) return null;
  const cursor = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const start = before.lastIndexOf('@');
  return { start, end: cursor, query: match[1] || '' };
}

export function hideComposerHints() {
  const hintsEl = panelEl('#cxp-slash-hints');
  const input = panelEl('#cxp-input');
  if (hintsEl) {
    hintsEl.hidden = true;
    delete hintsEl.dataset.mode;
    hintsEl.removeAttribute('role');
  }
  if (input) input.setAttribute('aria-expanded', 'false');
  _slashActiveIdx = -1;
  _fileHintRequest += 1;
  if (_fileHintTimer) clearTimeout(_fileHintTimer);
  _fileHintTimer = null;
  _fileHintAbort?.abort();
  _fileHintAbort = null;
}

function selectFileHint(item) {
  const input = panelEl('#cxp-input');
  const hintsEl = panelEl('#cxp-slash-hints');
  const tab = activeTab();
  if (!input || !hintsEl || !tab || !item?.dataset.filePath) return;
  const start = Number(hintsEl.dataset.tokenStart);
  const end = Number(hintsEl.dataset.tokenEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  const name = item.dataset.fileName || basenamePath(item.dataset.filePath);
  input.value = `${input.value.slice(0, start)}@${name} ${input.value.slice(end)}`;
  const nextCursor = start + name.length + 2;
  input.setSelectionRange(nextCursor, nextCursor);
  tab.draft = input.value;
  addFileMention({ path: item.dataset.filePath, name });
  hideComposerHints();
  autosizeInput();
  syncInputEnabled();
  input.focus();
}

async function renderFileHints(token, requestId) {
  const hintsEl = panelEl('#cxp-slash-hints');
  const input = panelEl('#cxp-input');
  const tab = activeTab();
  if (!hintsEl || !input || !tab?.project) return hideComposerHints();
  _fileHintAbort?.abort();
  _fileHintAbort = new AbortController();
  const query = token.query.trim();
  try {
    const params = new URLSearchParams({ path: tab.project, recursive: '1', filesOnly: '1' });
    if (query) params.set('search', query);
    const response = await fetch(`/api/project-files?${params}`, { signal: _fileHintAbort.signal });
    const data = response.ok ? await response.json() : null;
    if (requestId !== _fileHintRequest || !data?.items) return;
    const currentToken = activeFileMentionToken(input);
    if (!currentToken || currentToken.start !== token.start || currentToken.query !== token.query) return;
    const projectRoot = String(tab.project).replace(/[\\/]+$/, '');
    const matches = data.items
      .filter((item) => item?.type === 'file')
      .map((item) => {
        const relative = String(item.relativePath || item.path || item.name || '').replace(/^[/\\]+/, '');
        return relative ? {
          relative,
          absolute: `${projectRoot}/${relative}`,
        } : null;
      })
      .filter(Boolean)
      .filter((item) => !query || item.relative.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 30);
    if (!matches.length) return hideComposerHints();

    hintsEl.innerHTML = '';
    hintsEl.hidden = false;
    hintsEl.dataset.mode = 'file';
    hintsEl.dataset.tokenStart = String(token.start);
    hintsEl.dataset.tokenEnd = String(token.end);
    hintsEl.setAttribute('role', 'listbox');
    input.setAttribute('aria-controls', 'cxp-slash-hints');
    input.setAttribute('aria-expanded', 'true');
    _slashActiveIdx = 0;
    matches.forEach((match, idx) => {
      const item = document.createElement('div');
      item.className = `cxp-slash-hint-item${idx === 0 ? ' active' : ''}`;
      item.dataset.filePath = match.absolute;
      item.dataset.fileName = match.relative;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
      const name = document.createElement('span');
      name.className = 'cxp-slash-hint-cmd';
      name.textContent = `@${basenamePath(match.relative)}`;
      const path = document.createElement('span');
      path.className = 'cxp-slash-hint-desc';
      path.textContent = match.relative;
      item.append(name, path);
      item.addEventListener('mousedown', (event) => event.preventDefault());
      item.addEventListener('click', () => selectFileHint(item));
      hintsEl.appendChild(item);
    });
  } catch (error) {
    if (error?.name !== 'AbortError' && requestId === _fileHintRequest) hideComposerHints();
  }
}

function showFileHints(token) {
  const requestId = ++_fileHintRequest;
  if (_fileHintTimer) clearTimeout(_fileHintTimer);
  _fileHintTimer = setTimeout(() => {
    _fileHintTimer = null;
    renderFileHints(token, requestId);
  }, 120);
}

export async function loadSlashCommands() {
  if (_skillsCache) return _skillsCache;
  try {
    const res = await fetch('/api/skills');
    const data = await res.json();
    const seen = new Set(BUILTIN_SLASH_COMMANDS.map((entry) => entry.cmd));
    const skillCommands = (data.skills || [])
      .map((skill) => ({
        cmd: '/' + String(skill.name || skill.dirName || '').trim(),
        desc: String(skill.description || '').trim(),
      }))
      .filter((skill) => skill.cmd !== '/' && !seen.has(skill.cmd))
      .sort((a, b) => a.cmd.localeCompare(b.cmd));
    _skillsCache = [...BUILTIN_SLASH_COMMANDS, ...skillCommands];
  } catch {
    _skillsCache = [...BUILTIN_SLASH_COMMANDS];
  }
  return _skillsCache;
}

export function showSlashHints(text) {
  const hintsEl = panelEl('#cxp-slash-hints');
  if (!hintsEl) return;
  const input = panelEl('#cxp-input');
  const fileToken = activeFileMentionToken(input);
  if (fileToken) {
    showFileHints(fileToken);
    return;
  }
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/') || trimmed.includes(' ') || trimmed.includes('\n')) {
    hideComposerHints();
    return;
  }
  const query = trimmed.toLowerCase();
  if (!_skillsCache) {
    hintsEl.hidden = true;
    _slashActiveIdx = -1;
    if (!_skillsPromise) {
      _skillsPromise = loadSlashCommands().finally(() => { _skillsPromise = null; });
    }
    _skillsPromise.then(() => {
      const input = panelEl('#cxp-input');
      if (input && input.value.trim() === trimmed) showSlashHints(input.value);
    }).catch(() => {});
    return;
  }
  const filtered = _skillsCache.filter((c) => c.cmd.startsWith(query));
  if (!filtered.length) {
    hintsEl.hidden = true;
    _slashActiveIdx = -1;
    return;
  }
  hintsEl.hidden = false;
  hintsEl.dataset.mode = 'slash';
  hintsEl.setAttribute('role', 'listbox');
  input?.setAttribute('aria-controls', 'cxp-slash-hints');
  input?.setAttribute('aria-expanded', 'true');
  hintsEl.innerHTML = '';
  _slashActiveIdx = 0;
  filtered.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = 'cxp-slash-hint-item' + (idx === 0 ? ' active' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
    const cmdSpan = document.createElement('span');
    cmdSpan.className = 'cxp-slash-hint-cmd';
    cmdSpan.textContent = c.cmd;
    const descSpan = document.createElement('span');
    descSpan.className = 'cxp-slash-hint-desc';
    descSpan.textContent = c.desc;
    item.append(cmdSpan, descSpan);
    item.addEventListener('click', () => selectSlashHint(c.cmd));
    hintsEl.appendChild(item);
  });
}

export function selectSlashHint(cmd) {
  const input = panelEl('#cxp-input');
  hideComposerHints();
  if (!input) return;
  switch (cmd) {
    case '/compact':
    case '/clear':
    case '/copy':
    case '/debug-config':
    case '/diff':
    case '/experimental':
    case '/fast':
    case '/fork':
    case '/logout':
    case '/mcp':
    case '/new':
    case '/permissions':
    case '/plugins':
    case '/ps':
    case '/resume':
    case '/review':
    case '/status':
    case '/stop':
      input.value = cmd;
      break;
    case '/model': {
      const dd = panelEl('#cxp-model');
      if (dd) dd.classList.toggle('open');
      input.value = '';
      break;
    }
    case '/plan':
    case '/mention':
    case '/apps':
    case '/agent':
    case '/init':
    case '/effort':
    case '/queue':
    case '/personality':
    default:
      input.value = cmd + ' ';
      break;
  }
  const tab = activeTab();
  if (tab) tab.draft = input.value;
  autosizeInput();
  syncInputEnabled();
}

export function navigateSlashHints(direction) {
  const hintsEl = panelEl('#cxp-slash-hints');
  if (!hintsEl || hintsEl.hidden) return false;
  const items = hintsEl.querySelectorAll('.cxp-slash-hint-item');
  if (!items.length) return false;
  items[_slashActiveIdx]?.classList.remove('active');
  items[_slashActiveIdx]?.setAttribute('aria-selected', 'false');
  _slashActiveIdx = (_slashActiveIdx + direction + items.length) % items.length;
  items[_slashActiveIdx]?.classList.add('active');
  items[_slashActiveIdx]?.setAttribute('aria-selected', 'true');
  items[_slashActiveIdx]?.scrollIntoView({ block: 'nearest' });
  return true;
}

export function confirmSlashHint() {
  const hintsEl = panelEl('#cxp-slash-hints');
  if (!hintsEl || hintsEl.hidden) return false;
  const items = hintsEl.querySelectorAll('.cxp-slash-hint-item');
  if (!items.length || _slashActiveIdx < 0) return false;
  if (hintsEl.dataset.mode === 'file') {
    selectFileHint(items[_slashActiveIdx]);
    return true;
  }
  const cmdEl = items[_slashActiveIdx]?.querySelector('.cxp-slash-hint-cmd');
  if (cmdEl) selectSlashHint(cmdEl.textContent);
  return true;
}

// ── Phase 6: Settings panel ──
export async function openSettingsPanel() {

// ── Settings panel & compaction (lines 8588-8844) ──
  const settingsTab = activeTab();
  if (!settingsTab) return;
  const requestForSettings = (type, data = {}) => requestSocketPayloadForTab(settingsTab, type, data);
  const appendSettingsError = (text) => {
    if (!settingsTab.closed) withTab(settingsTab, () => appendSystem(text, 'error'));
  };
  if (_getPanelEl()?.querySelector('.cxp-settings-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'cxp-settings-overlay';
  overlay.innerHTML = `
    <div class="cxp-settings-panel">
      <div class="cxp-settings-header">
        <span>Codex Settings</span>
        <button class="cxp-settings-close">&times;</button>
      </div>
      <div class="cxp-settings-body">
        <div class="cxp-settings-section">
          <div class="cxp-settings-section-title">Account</div>
          <div class="cxp-settings-loading" id="cxp-settings-account">Loading…</div>
        </div>
        <div class="cxp-settings-section">
          <div class="cxp-settings-section-title">MCP Servers</div>
          <div class="cxp-settings-loading" id="cxp-settings-mcp">Loading…</div>
        </div>
        <div class="cxp-settings-section">
          <div class="cxp-settings-section-title">Always Allowed Folders</div>
          <div class="cxp-settings-loading" id="cxp-settings-permissions">Loading…</div>
        </div>
        <div class="cxp-settings-section">
          <div class="cxp-settings-section-title">Configuration</div>
          <div class="cxp-settings-loading" id="cxp-settings-config">Loading…</div>
        </div>
      </div>
    </div>
  `;
  _getPanelEl().appendChild(overlay);
  overlay.querySelector('.cxp-settings-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Fetch data in parallel
  try {
    const [accountData, mcpData, configData, rateLimitData, permissionData] = await Promise.allSettled([
      requestForSettings('account_read', {}),
      requestForSettings('mcp_status', {}),
      requestForSettings('config_read', {}),
      requestForSettings('rate_limits_read', {}),
      requestForSettings('permission_roots_list', {}),
    ]);
    if (settingsTab.closed) {
      overlay.remove();
      return;
    }

    // Account
    const accountEl = overlay.querySelector('#cxp-settings-account');
    if (accountEl) {
      const acctResult = accountData.status === 'fulfilled' ? (accountData.value?.account || {}) : {};
      const acct = acctResult?.account || null;
      const acctName = acct?.email || acct?.name || acct?.type;
      const limitLines = rateLimitData.status === 'fulfilled'
        ? rateLimitLines(rateLimitData.value?.rateLimits || {})
        : [];
      if (acctName) {
        accountEl.innerHTML = '';
        accountEl.className = '';
        const value = document.createElement('div');
        value.className = 'cxp-settings-value';
        value.textContent = acctName;
        accountEl.appendChild(value);
        if (acct?.planType) {
          const plan = document.createElement('div');
          plan.className = 'cxp-settings-hint';
          plan.textContent = `Plan: ${acct.planType}`;
          accountEl.appendChild(plan);
        }
        if (limitLines.length) {
          const limits = document.createElement('div');
          limits.className = 'cxp-settings-hint';
          limits.innerHTML = limitLines.map((line) => `<div>${esc(line.replace(/^- /, ''))}</div>`).join('');
          accountEl.appendChild(limits);
        }
        const logoutBtn = document.createElement('button');
        logoutBtn.className = 'cxp-settings-login-btn';
        logoutBtn.textContent = 'Logout';
        logoutBtn.addEventListener('click', async () => {
          logoutBtn.disabled = true;
          try {
            await requestForSettings('account_logout', {});
            overlay.remove();
            if (isActiveTab(settingsTab)) openSettingsPanel();
          } catch (err) {
            logoutBtn.disabled = false;
            appendSettingsError(err.message || 'Logout failed');
          }
        });
        accountEl.appendChild(logoutBtn);
      } else {
        accountEl.innerHTML = '';
        accountEl.className = '';
        const hint = document.createElement('div');
        hint.className = 'cxp-settings-hint';
        hint.textContent = 'Not signed in';
        const loginBtn = document.createElement('button');
        loginBtn.className = 'cxp-settings-login-btn';
        loginBtn.textContent = 'Login';
        loginBtn.addEventListener('click', async () => {
          loginBtn.disabled = true;
          loginBtn.textContent = 'Opening…';
          try {
            const result = await requestForSettings('codex_login', {});
            const authUrl = result?.login?.login?.authUrl || result?.login?.authUrl;
            if (authUrl) window.open(authUrl, '_blank', 'noopener,noreferrer');
            loginBtn.textContent = authUrl ? 'Browser opened' : 'Waiting…';
          } catch {
            loginBtn.textContent = 'Login';
            loginBtn.disabled = false;
          }
        });
        accountEl.append(hint, loginBtn);
      }
    }

    // MCP Servers
    const mcpEl = overlay.querySelector('#cxp-settings-mcp');
    if (mcpEl) {
      const servers = mcpData.status === 'fulfilled' ? (mcpData.value?.servers || []) : [];
      if (!servers.length) {
        mcpEl.innerHTML = '';
        mcpEl.className = '';
        const hint = document.createElement('div');
        hint.className = 'cxp-settings-hint';
        hint.textContent = 'Configure in ~/.codex/config.toml under [mcp_servers]';
        mcpEl.appendChild(hint);
      } else {
        mcpEl.innerHTML = '';
        for (const server of servers) {
          const row = document.createElement('div');
          row.className = 'cxp-mcp-row';
          const name = document.createElement('span');
          name.className = 'cxp-mcp-name';
          name.textContent = server.name || 'Unknown';
          const status = document.createElement('span');
          status.className = 'cxp-mcp-status';
          status.textContent = server.status || 'unknown';
          status.dataset.status = server.status || 'unknown';
          const trusted = document.createElement('span');
          trusted.className = 'cxp-mcp-status';
          trusted.dataset.status = 'running';
          trusted.textContent = 'always allowed';
          trusted.hidden = !server.alwaysAllowed;
          const refreshBtn = document.createElement('button');
          refreshBtn.className = 'cxp-btn cxp-btn-sm';
          refreshBtn.textContent = 'Refresh';
          refreshBtn.addEventListener('click', async () => {
            try {
              await requestForSettings('mcp_refresh', { name: server.name });
              refreshBtn.textContent = 'Done';
              setTimeout(() => { refreshBtn.textContent = 'Refresh'; }, 2000);
            } catch (err) {
              appendSettingsError(`MCP refresh failed: ${err.message}`);
            }
          });
          row.append(name, status, trusted, refreshBtn);
          if (server.alwaysAllowed) {
            const revokeBtn = document.createElement('button');
            revokeBtn.className = 'cxp-btn cxp-btn-sm';
            revokeBtn.textContent = 'Revoke';
            revokeBtn.title = 'Require approval for this MCP server again';
            revokeBtn.addEventListener('click', async () => {
              revokeBtn.disabled = true;
              try {
                await requestForSettings('mcp_approval_set', {
                  name: server.name,
                  approvalMode: 'prompt',
                });
                server.approvalMode = 'prompt';
                server.alwaysAllowed = false;
                trusted.hidden = true;
                revokeBtn.remove();
              } catch (err) {
                revokeBtn.disabled = false;
                appendSettingsError(`MCP approval update failed: ${err.message}`);
              }
            });
            row.appendChild(revokeBtn);
          }
          if (server.requiresOAuth) {
            const loginBtn = document.createElement('button');
            loginBtn.className = 'cxp-btn cxp-btn-sm cxp-mcp-oauth-btn';
            loginBtn.dataset.mcpServer = server.name;
            loginBtn.textContent = 'Authenticate';
            loginBtn.addEventListener('click', async () => {
              try {
                await startMcpOAuthLogin(settingsTab, server.name);
              } catch (err) {
                appendSettingsError(`MCP OAuth failed: ${err.message}`);
              }
            });
            row.appendChild(loginBtn);
          }
          mcpEl.appendChild(row);
        }
      }
    }

    const permissionsEl = overlay.querySelector('#cxp-settings-permissions');
    if (permissionsEl) {
      const stored = permissionData.status === 'fulfilled'
        ? permissionData.value?.permissions?.filesystem || {}
        : {};
      const roots = ['write', 'read'].flatMap((access) => (
        (Array.isArray(stored[access]) ? stored[access] : []).map((path) => ({ access, path }))
      ));
      permissionsEl.innerHTML = '';
      permissionsEl.className = '';
      if (!roots.length) {
        const hint = document.createElement('div');
        hint.className = 'cxp-settings-hint';
        hint.textContent = 'None';
        permissionsEl.appendChild(hint);
      } else {
        for (const root of roots) {
          const row = document.createElement('div');
          row.className = 'cxp-mcp-row';
          const path = document.createElement('span');
          path.className = 'cxp-mcp-name cxp-permission-root-path';
          path.textContent = root.path;
          path.title = root.path;
          const access = document.createElement('span');
          access.className = 'cxp-mcp-status';
          access.textContent = root.access;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'cxp-bar-action';
          remove.innerHTML = ICON_X;
          remove.title = 'Revoke folder access';
          remove.setAttribute('aria-label', `Revoke access to ${root.path}`);
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            try {
              await requestForSettings('permission_root_remove', root);
              row.remove();
              if (!permissionsEl.querySelector('.cxp-mcp-row')) {
                const hint = document.createElement('div');
                hint.className = 'cxp-settings-hint';
                hint.textContent = 'None';
                permissionsEl.appendChild(hint);
              }
            } catch (err) {
              remove.disabled = false;
              appendSettingsError(err.message || 'Could not revoke folder access');
            }
          });
          row.append(path, access, remove);
          permissionsEl.appendChild(row);
        }
      }
    }

    // Config — editable fields
    const configEl = overlay.querySelector('#cxp-settings-config');
    if (configEl) {
      const rawCfg = configData.status === 'fulfilled' ? (configData.value?.config || configData.value || {}) : {};
      const { effective: cfg, layers } = normalizeConfigResult(rawCfg);

      // Get dynamic model list (fall back to hardcoded defaults)
      let models;
      try { models = await requestModelList(settingsTab); } catch { models = null; }
      const modelList = mergeCodexModelList(models);

      configEl.innerHTML = '';
      const fieldDefs = [
        { key: 'model', label: 'Model', type: 'select', options: modelList.map(m => ({ value: getCodexModelName(m), label: m?.label || getCodexModelName(m) })) },
        { key: 'review_model', label: 'Review Model', type: 'select', options: [{ value: '', label: '(none)' }, ...modelList.map(m => ({ value: getCodexModelName(m), label: m?.label || getCodexModelName(m) }))] },
        { key: 'model_provider', label: 'Provider', type: 'text', placeholder: 'openai, ollama…' },
        { key: 'approval_policy', label: 'Approval Policy', type: 'select', options: [
          { value: 'never', label: 'Never (No prompts)' },
          { value: 'untrusted', label: 'Untrusted' },
          { value: 'on-request', label: 'On Request' },
        ]},
        { key: 'sandbox_mode', label: 'Sandbox Mode', type: 'select', options: [
          { value: 'workspace-write', label: 'Workspace Write' },
          { value: 'read-only', label: 'Read Only' },
          { value: 'danger-full-access', label: 'Full Access (Dangerous)' },
        ]},
        { key: 'personality', label: 'Personality', type: 'select', options: [
          { value: '', label: '(default)' },
          { value: 'pragmatic', label: 'Pragmatic' },
          { value: 'friendly', label: 'Friendly' },
        ]},
        { key: 'service_tier', label: 'Fast Mode', type: 'select', options: [
          { value: '', label: '(default)' },
          { value: 'flex', label: 'Flex / Default' },
          { value: 'fast', label: 'Fast' },
        ]},
        { key: 'model_reasoning_effort', label: 'Reasoning Effort', type: 'select', options: [
          { value: '', label: '(default)' },
          { value: 'minimal', label: 'Minimal' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra High' },
        ]},
        { key: 'model_reasoning_summary', label: 'Reasoning Summary', type: 'select', options: [
          { value: '', label: '(default)' },
          { value: 'auto', label: 'Auto' },
          { value: 'concise', label: 'Concise' },
          { value: 'detailed', label: 'Detailed' },
          { value: 'none', label: 'None' },
        ]},
        { key: 'model_verbosity', label: 'Response Verbosity', type: 'select', options: [
          { value: '', label: '(default)' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ]},
        { key: 'model_context_window', label: 'Context Window', type: 'number', placeholder: 'tokens' },
        { key: 'model_auto_compact_token_limit', label: 'Auto-Compact', type: 'number', placeholder: 'token limit' },
        { key: 'web_search', label: 'Web Search', type: 'checkbox' },
        { key: 'features.fast_mode', label: 'Enable Fast Toggle', type: 'checkbox' },
        { key: 'features.personality', label: 'Enable Personality', type: 'checkbox' },
        { key: 'features.apps', label: 'Enable Apps', type: 'checkbox' },
        { key: 'features.unified_exec', label: 'Unified Exec', type: 'checkbox' },
      ];
      const form = document.createElement('div');
      form.className = 'cxp-config-form';
      const inputs = {};
      for (const def of fieldDefs) {
        const row = document.createElement('div');
        row.className = 'cxp-config-row';
        const label = document.createElement('label');
        label.className = 'cxp-config-label';
        label.textContent = def.label;
        row.appendChild(label);
        const val = cfg[def.key];
        if (def.type === 'select') {
          const sel = document.createElement('select');
          sel.className = 'cxp-config-input';
          for (const opt of def.options) {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (String(val ?? '') === opt.value) o.selected = true;
            sel.appendChild(o);
          }
          row.appendChild(sel);
          inputs[def.key] = sel;
        } else if (def.type === 'checkbox') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'cxp-config-checkbox';
          cb.checked = !!val;
          row.appendChild(cb);
          inputs[def.key] = cb;
        } else {
          const inp = document.createElement('input');
          inp.type = def.type === 'number' ? 'number' : 'text';
          inp.className = 'cxp-config-input';
          inp.value = val != null ? val : '';
          inp.placeholder = def.placeholder || '';
          row.appendChild(inp);
          inputs[def.key] = inp;
        }
        // Config layer badge
        if (layers[def.key]) {
          const badge = document.createElement('span');
          badge.className = 'cxp-config-layer';
          badge.textContent = `(${layers[def.key]})`;
          row.appendChild(badge);
        }
        form.appendChild(row);
      }
      const saveBtn = document.createElement('button');
      saveBtn.className = 'cxp-btn cxp-config-save';
      saveBtn.textContent = 'Save Configuration';
      saveBtn.addEventListener('click', async () => {
        const newCfg = {};
        for (const def of fieldDefs) {
          const el = inputs[def.key];
          if (def.type === 'checkbox') {
            newCfg[def.key] = el.checked;
          } else if (def.type === 'number') {
            newCfg[def.key] = el.value ? Number(el.value) : null;
          } else {
            newCfg[def.key] = el.value || null;
          }
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          await requestForSettings('config_write', { config: newCfg });
          saveBtn.textContent = 'Saved!';
          _modelListCacheByAccount.clear();
          _modelListRequestByAccount.clear();
          requestModelList();
          setTimeout(() => { saveBtn.textContent = 'Save Configuration'; saveBtn.disabled = false; }, 2000);
        } catch (err) {
          saveBtn.textContent = 'Save Failed';
          appendSettingsError(`Config save failed: ${err.message}`);
          setTimeout(() => { saveBtn.textContent = 'Save Configuration'; saveBtn.disabled = false; }, 2000);
        }
      });
      form.appendChild(saveBtn);
      configEl.appendChild(form);
    }
  } catch {}
}

export function startCompaction() {
  if (_running || _startingThread || _compacting) return;
  if (_boundTab) {
    markExtendedContextPending(_boundTab);
    _boundTab.extendedContextVerificationArmed = normalizeCodexContextMode(_boundTab.contextMode) === 'extended';
  }
  _manualCompactionPending = true;
  _autoCompactionActive = false;
  _autoCompactionNoticeShown = false;
  syncRuntimeCompactionState();
  setCompactingUI(true);
  setStatus('Compacting context…', 'working');
  setStatusDetail('Summarizing the current thread', Date.now(), 'compaction:manual');
  appendSystem('Compacting context…', 'working');
  if (!sendSocket({
    type: 'compact',
    threadId: _threadId,
    cwd: _project || null,
    ...codexRuntimeSelection(_boundTab),
  })) {
    resetRuntimeCompactionState();
    setCompactingUI(false);
    setStatus('Codex is not connected', 'error');
  }
}

// ── Context bridge ──
export function initContextBridge() {
  const ctx = {
    // ── Getters (live state from cdx-tabs module variables) ──
    get items() { return _items; },
    get requestCards() { return _requestCards; },
    get messagesEl() { return _messagesEl; },
    get project() { return _project; },
    get projects() { return _projects; },
    get activeItems() { return _activeItems; },
    get marked() { return _marked; },
    get hljs() { return _hljs; },
    get boundTab() { return _boundTab; },
    get accountId() { return _accountId; },
    get connectionEpoch() { return _boundTab?.connectionEpoch || ''; },
    get activeTurnId() { return _activeTurnId; },
    get threadId() { return _threadId; },
    get transcriptSourceType() { return _transcriptSourceType; },
    get running() { return _running; },
    get startingThread() { return _startingThread; },
    get compacting() { return _compacting; },
    get threadTokenUsage() { return _threadTokenUsage; },
    get threadContextMeta() { return _threadContextMeta; },
    // ── Functions ──
    scrollEnd,
    sendSocket,
    emit,
    activeTab,
    isActiveTab,
    dispatchPrompt,
    capturePlanContent,
    ensurePlanFile,
    saveTabs,
    hideEmpty,
    showEmpty,
    repositionThinking,
    pruneTranscriptDom,
    appendSystem: (...args) => appendSystem(...args),
    scheduleThreadSnapshotSave,
    flushThreadSnapshotSave,
    setTranscriptSourceMeta,
    withTab,
    formatStatus,
    itemHeadline,
    cleanPreview,
    syncToolbarState,
    startCompaction,
    syncWorkStatus,
    clearTranscript,
    setThread,
    renderStoredTranscript,
    updateThreadTokenUsage,
    setThreadContextMeta,
    getThreadSnapshot,
    normalizeThreadSnapshotEntry,
    normalizeSnapshotSourceType,
    normalizeSnapshotItemCount,
    normalizeContextTrackerMeta,
    timestampMs,
    setCompactingUI,
    renderStatusChrome,
    itemOwnershipBelongsToBoundThread,
    createRequestButton,
    isSynaBunChoicePrompt,
    isChangelogChoiceSet,
    openChangelogEditorFlow,
    restoreChangelogButtons,
    isBlockingServerRequest,
    onBlockingServerRequestStart: rememberBlockingServerRequest,
    onBlockingServerRequestAnswered: (requestId) => clearBlockingServerRequest(requestId),
    setPostPlanHeader: (v) => { _postPlanHeader = v; },
    setShowPostPlanActions: (v) => { _showPostPlanActions = v; },
    setPlanFeedbackDraft: (v) => { if (_boundTab) _boundTab.planFeedbackDraft = v || ''; },
    setPlanTurnActive: (v) => { _planTurnActive = !!v; },
    setPlanApprovalPending: (v) => { _planApprovalPending = !!v; },
    setLastPlanTurnId: (v) => { _lastPlanTurnId = v || ''; },
    setShowPostCompactionPrompt: (v) => { _showPostCompactionPrompt = !!v; },
    setPostCompactionPending: (v) => { _postCompactionPending = !!v; },
    setPostCompactionPromptSource: (v) => { _postCompactionPromptSource = v === 'manual' ? 'manual' : ''; },
    setPlanFilePath: (v) => { _planFilePath = v; },
  };
  setRenderContext(ctx);
  setRequestsContext(ctx);
}

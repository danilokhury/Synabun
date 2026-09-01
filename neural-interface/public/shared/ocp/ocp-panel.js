// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel: Main Entry
// buildPanel DOM, wireEvents, resize, visibility, exports
// Imports ui-claude-panel.js + ui-codex-panel.js for mutual exclusion
// ═══════════════════════════════════════════

import { state, emit, on } from '../state.js';
import { storage } from '../storage.js';
import { fetchProjects } from '../api.js';
import { reserveRightPanelLayout, clearRightPanelLayout, setRightPanelResizing } from '../ui-sidepanel-layout.js';
import { subscribeCliStatus, recheckCliStatus, getCliDocUrl, getCliInstallCommand, getCliLabel } from '../cli-status.js';

import { injectStyles } from './ocp-styles.js';
import {
  ICON_PLUS, ICON_X, ICON_MINIMIZE, ICON_EDIT, ICON_SEND, ICON_STOP,
  ICON_REVERT, ICON_COMPACT, ICON_SLIDE, ICON_SETTINGS,
} from './ocp-icons.js';
import { connectWs, disconnectWs, isConnected, onWsMessage, sendWs, requestWs } from './ocp-ws.js';
import { renderEmptyState, esc, renderToolActivityDock, tickActivityDockElapsed, focusActivityToolCard, renderErrorMessage } from './ocp-render.js';
import {
  STOR, getTabs, getActiveTabIdx, activeTab, getProviders, getSessions,
  setPanelEl, setOnUpdate, setPanelVisible, setOnShow, setOnHide, setOnEditPlan,
  createTab, switchTab, closeTab, renderPills, saveTabs, restoreTabs, setActiveProject,
  loadSessions, createSession, renameSession, loadProviders, loadAgents, populateModelDropdown,
  sendMessage, abortMessage, handleSSEEvent,
  revertSession, compactSession, shareSession, executeCommand, renderTabMessages,
  getActiveTabMode, setTabMode, resolveContextInputTokens, setActivityVisible,
  toggleActivityExpanded, abortAgent, ensurePlanFile, showPostPlanUI, applySavedPlan,
  flushAllSessionSnapshots, extractPlanTextLoose,
} from './ocp-tabs.js';

window.addEventListener('beforeunload', () => { try { flushAllSessionSnapshots(); } catch {} });
window.addEventListener('pagehide', () => { try { flushAllSessionSnapshots(); } catch {} });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { try { flushAllSessionSnapshots(); } catch {} }
});
import { isClaudePanelOpen, toggleClaudePanel } from '../ui-claude-panel.js';
import { isCodexPanelOpen, toggleCodexPanel } from '../ui-codex-panel.js';

const PANEL_OWNER = 'opencode-sidepanel';
const OCP_ACCENT = '#E8E0DC';
const ICON_ATTACH = '<svg viewBox="0 0 24 24" fill="none"><path d="M21.44 11.05 12.25 20.24a6 6 0 1 1-8.49-8.49l9.2-9.19a4 4 0 1 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.48-8.48" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MAX_IMAGES = 5;

function getModelContextWindow(modelStr) {
  if (!modelStr) return null;
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

let _panel = null;
let _visible = false;
let _serverReady = false;
let _serverVersion = null;
let _serverManaged = false;
let _projects = [];
let _projectsLoaded = false;
let _cliInstalled = null;
let _cliUnsub = null;

function panelEl(sel) { return _panel?.querySelector(sel) || null; }

function activeTabRunning() {
  return !!activeTab()?.running;
}

function sessionTitleFor(sessionOrTab) {
  const sid = sessionOrTab?.id || sessionOrTab?.sessionID || sessionOrTab?.sessionId || '';
  const candidates = [sessionOrTab?.sessionTitle, sessionOrTab?.title, sessionOrTab?.description, sessionOrTab?.slug];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return sid ? sid.slice(0, 8) : 'New session';
}

function canRenameActiveSession() {
  return !!activeTab();
}

function beginRenameSession() {
  const tab = activeTab();
  const label = panelEl('#ocp-session-label');
  if (!tab || !label) return;

  const existing = label.querySelector('.ocp-rename-input');
  if (existing) {
    existing.focus();
    existing.select();
    return;
  }

  const currentTitle = sessionTitleFor(tab);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ocp-rename-input';
  input.value = currentTitle;
  input.placeholder = 'Session name...';
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('mousedown', (event) => event.stopPropagation());
  input.addEventListener('dblclick', (event) => event.stopPropagation());
  label.textContent = '';
  label.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const restoreLabel = () => {
    if (label.contains(input)) label.textContent = sessionTitleFor(tab);
  };
  const finish = async (cancel = false) => {
    if (finished) return;
    finished = true;
    const nextTitle = input.value.trim();
    if (cancel || !nextTitle || nextTitle === currentTitle) {
      restoreLabel();
      return;
    }
    try {
      if (tab.sessionId && _serverReady && !tab.running) {
        await renameSession(tab.sessionId, nextTitle);
        if (panelEl('#ocp-session-menu')?.classList.contains('open')) await renderSessionMenu();
      } else {
        tab.pendingTitle = nextTitle;
        tab.sessionTitle = nextTitle;
        saveTabs();
      }
    } catch (err) {
      console.error('[ocp] rename failed:', err);
    } finally {
      restoreLabel();
    }
  };

  input.addEventListener('blur', () => { finish(false); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(true);
    }
  });
}

async function fetchBranchesForModal(path) {
  if (!path) return { branches: [], current: null };
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(path)}`);
    return await res.json();
  } catch { return { branches: [], current: null }; }
}

function promptNameNewSession() {
  const tab = activeTab();
  if (!tab || !_panel) return;
  if (_panel.querySelector('.ocp-name-modal-overlay')) return;

  const projectOptions = (_projects || []).map(p => {
    const path = (p && (p.path || p)) || '';
    const name = typeof path === 'string' ? path.split('/').pop() : '';
    return { path, name: name || path };
  }).filter(p => p.path);

  const overlay = document.createElement('div');
  overlay.className = 'ocp-name-modal-overlay';
  overlay.innerHTML = `
    <div class="ocp-name-modal" role="dialog" aria-modal="true">
      <div class="ocp-name-modal-title">Name this session</div>
      <div class="ocp-name-modal-row">
        <label class="ocp-name-modal-label">Project</label>
        <select class="ocp-name-modal-select" data-role="project">
          ${projectOptions.map(p => `<option value="${p.path.replace(/"/g, '&quot;')}">${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="ocp-name-modal-row">
        <label class="ocp-name-modal-label">Branch</label>
        <select class="ocp-name-modal-select" data-role="branch" disabled>
          <option value="">(loading...)</option>
        </select>
      </div>
      <input type="text" class="ocp-name-modal-input" placeholder="Session name..." maxlength="120" />
      <div class="ocp-name-modal-actions">
        <button type="button" class="ocp-name-modal-btn skip">Skip</button>
        <button type="button" class="ocp-name-modal-btn save">Save</button>
      </div>
    </div>
  `;
  _panel.appendChild(overlay);

  const input = overlay.querySelector('.ocp-name-modal-input');
  const saveBtn = overlay.querySelector('.ocp-name-modal-btn.save');
  const skipBtn = overlay.querySelector('.ocp-name-modal-btn.skip');
  const projectSel = overlay.querySelector('select[data-role="project"]');
  const branchSel = overlay.querySelector('select[data-role="branch"]');
  const label = panelEl('#ocp-session-label');

  const initialProject = tab.project || storage.getItem(STOR.project) || '';
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
    const nextTitle = input.value.trim();
    const chosenProject = projectSel?.value || '';
    const chosenBranch = branchSel?.value || '';
    close();
    if (cancel) return;

    if (chosenProject && chosenProject !== (tab.project || '')) {
      setActiveProject(chosenProject);
      loadBranches(chosenProject);
    }

    if (chosenProject && chosenBranch && branchOriginal && chosenBranch !== branchOriginal) {
      try {
        await fetch('/api/terminal/checkout', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: chosenProject, branch: chosenBranch }),
        });
        loadBranches(chosenProject);
      } catch (err) {
        console.error('[ocp] checkout failed:', err);
      }
    }

    if (!nextTitle) return;
    if (tab.sessionId) {
      try {
        await renameSession(tab.sessionId, nextTitle);
        if (panelEl('#ocp-session-menu')?.classList.contains('open')) await renderSessionMenu();
      } catch (err) {
        console.error('[ocp] rename failed:', err);
      }
    } else {
      tab.pendingTitle = nextTitle;
      tab.sessionTitle = nextTitle;
      if (label) label.textContent = nextTitle;
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

// ── Build panel DOM ──

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'ocp-panel';
  panel.className = 'ocp-panel';
  panel.innerHTML = `
    <div class="ocp-resize-handle"></div>
    <div class="ocp-header">
      <button class="ocp-session-btn" id="ocp-session-btn" type="button">
        <span class="ocp-session-label" id="ocp-session-label">New session</span>
        <span class="ocp-dd-arrow">&#x25BE;</span>
      </button>
      <button class="ocp-header-rename" id="ocp-header-rename" type="button" data-tooltip="Rename">
        ${ICON_EDIT}
      </button>
      <div class="ocp-actions">
        <button class="ocp-btn" id="ocp-new" data-tooltip="New tab">${ICON_PLUS}</button>
        <button class="ocp-btn" id="ocp-minimize" data-tooltip="Minimize">${ICON_MINIMIZE}</button>
        <button class="ocp-btn ocp-btn-danger" id="ocp-close" data-tooltip="Close tab">${ICON_X}</button>
        <button class="ocp-btn" id="ocp-slide" data-tooltip="Slide">${ICON_SLIDE}</button>
      </div>
      <div class="ocp-session-menu" id="ocp-session-menu"></div>
    </div>
    <div class="ocp-contextbar" id="ocp-contextbar">
      <span class="ocp-status-dot connecting" id="ocp-status-dot"></span>
      <span class="ocp-status-text" id="ocp-status-text">Connecting…</span>
      <div class="ocp-ctx-gauge" id="ocp-ctx-gauge">
        <div class="ocp-ctx-fill" id="ocp-ctx-fill"></div>
        <span class="ocp-ctx-label" id="ocp-ctx-label">context pending</span>
      </div>
      <button class="ocp-start-btn" id="ocp-start-server" hidden>Start Server</button>
      <button class="ocp-compact-btn" id="ocp-compact" data-tooltip="Compact" disabled>compact</button>
    </div>
    <div class="ocp-messages-container">
      <div class="ocp-messages" id="ocp-messages"></div>
    </div>
    <div class="ocp-bottom">
      <div class="ocp-projectbar">
        <div class="ocp-dropdown" id="ocp-project-dd" data-placeholder="project..." data-tooltip="Project">
          <span class="ocp-dd-label">project...</span>
          <span class="ocp-dd-arrow">&#x25BE;</span>
          <div class="ocp-dd-menu"></div>
        </div>
        <div class="ocp-dropdown ocp-dropdown-sm" id="ocp-branch" data-placeholder="branch" data-tooltip="Branch">
          <span class="ocp-dd-label">branch</span>
          <span class="ocp-dd-arrow">&#x25BE;</span>
          <div class="ocp-dd-menu"></div>
        </div>
        <div class="ocp-dropdown ocp-dropdown-sm" id="ocp-profile-dd" data-placeholder="profile" data-tooltip="Tool profile">
          <span class="ocp-dd-label">full</span>
          <span class="ocp-dd-arrow">&#x25BE;</span>
          <div class="ocp-dd-menu"></div>
        </div>
        <div class="ocp-dropdown ocp-dropdown-sm" id="ocp-recall-dd" data-placeholder="recall" data-tooltip="Recall profile">
          <span class="ocp-dd-label">recall</span>
          <span class="ocp-dd-arrow">&#x25BE;</span>
          <div class="ocp-dd-menu"></div>
        </div>
        <span style="flex:1"></span>
        <div class="ocp-bar-actions">
          <button class="ocp-bar-btn" id="ocp-action-changelog" data-tooltip="Generate changelog"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h8.5v13H4a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 014 1.5z"/><path d="M5.5 5h5M5.5 7.5h3M5.5 10h4"/></svg></button>
          <button class="ocp-bar-btn" id="ocp-revert" data-tooltip="Revert" disabled>${ICON_REVERT}</button>
        </div>
      </div>
      <div class="ocp-input-wrap">
        <div class="ocp-image-strip" id="ocp-image-strip" hidden></div>
        <div class="ocp-input-shell">
          <button class="ocp-attach" id="ocp-attach" data-tooltip="Attach">
            ${ICON_ATTACH}
          </button>
          <textarea class="ocp-input" id="ocp-input" rows="1" placeholder="Message OpenCode…" spellcheck="false"></textarea>
          <button class="ocp-send" id="ocp-send" disabled data-tooltip="Send">
            <span class="ocp-send-icon">${ICON_SEND}</span>
            <span class="ocp-stop-icon">${ICON_STOP}</span>
          </button>
        </div>
        <div class="ocp-slash-browser" id="ocp-slash-hints" hidden></div>
        <input type="file" id="ocp-file-input" accept="image/*" multiple hidden>
      </div>
      <div class="ocp-footer-toolbar">
        <div class="ocp-footer-left">
          <a class="ocp-brand-link" href="https://opencode.ai" target="_blank" rel="noopener noreferrer" data-tooltip="OpenCode">
            <svg class="ocp-brand" viewBox="0 0 240 300" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M0 0h240v300H0V0zm30 30v240h180V30H30z"/><rect x="30" y="150" width="180" height="120" opacity=".45"/></svg>
          </a>
          <button class="ocp-footer-btn" id="ocp-footer-changelog" type="button" data-tooltip="Generate changelog (/synabun changelog)">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h8.5v13H4a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 014 1.5z"/><path d="M5.5 5h5M5.5 7.5h3M5.5 10h4"/></svg>
          </button>
          <div class="ocp-mode-toggle" id="ocp-mode-toggle" role="group" aria-label="OpenCode mode">
            <button class="ocp-mode-btn" type="button" data-mode="chat" data-tooltip="Chat">Chat</button>
            <button class="ocp-mode-btn" type="button" data-mode="build" data-tooltip="Build">Build</button>
            <button class="ocp-mode-btn" type="button" data-mode="plan" data-tooltip="Plan">Plan</button>
          </div>
        </div>
        <div class="ocp-footer-right">
          <div class="ocp-dropdown" id="ocp-model-dd" data-placeholder="model..." data-tooltip="Model">
            <span class="ocp-dd-label">model...</span>
            <span class="ocp-dd-arrow">&#x25BE;</span>
            <div class="ocp-dd-menu"></div>
          </div>
          <span class="ocp-token-counter" id="ocp-tokens"></span>
        </div>
      </div>
    </div>
  `;
  return panel;
}

// ── Wire events ──

function wireEvents() {
  // Resize handle
  const handle = panelEl('.ocp-resize-handle');
  if (handle) {
    let startX, startW;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = _panel.offsetWidth;
      let pendingW = startW;
      let rafId = 0;
      setRightPanelResizing(true);
      const applyWidth = () => {
        rafId = 0;
        if (!_panel) return;
        _panel.style.width = pendingW + 'px';
        syncReservedWidth(pendingW);
      };
      const onMove = (ev) => {
        const diff = startX - ev.clientX;
        pendingW = Math.max(320, Math.min(700, startW + diff));
        if (!rafId) rafId = requestAnimationFrame(applyWidth);
      };
      const onUp = () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        applyWidth();
        setRightPanelResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Header buttons
  panelEl('#ocp-new')?.addEventListener('click', () => { createTab(); promptNameNewSession(); });
  panelEl('#ocp-minimize')?.addEventListener('click', () => setVisible(false));
  panelEl('#ocp-close')?.addEventListener('click', () => {
    const idx = getActiveTabIdx();
    if (idx >= 0) closeTab(idx);
  });
  panelEl('#ocp-slide')?.addEventListener('click', () => setVisible(false));
  panelEl('#ocp-header-rename')?.addEventListener('mousedown', (event) => {
    if (panelEl('#ocp-session-label .ocp-rename-input')) event.preventDefault();
  });
  panelEl('#ocp-header-rename')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelEl('#ocp-session-menu')?.classList.remove('open');
    beginRenameSession();
  });

  // Session button → toggle session menu
  panelEl('#ocp-session-btn')?.addEventListener('click', (event) => {
    if (event.target.closest('.ocp-session-label') || event.target.closest('.ocp-rename-input')) return;
    const menu = panelEl('#ocp-session-menu');
    if (menu) {
      menu.classList.toggle('open');
      if (menu.classList.contains('open')) renderSessionMenu();
    }
  });
  panelEl('#ocp-session-label')?.addEventListener('click', (event) => {
    event.stopPropagation();
    panelEl('#ocp-session-menu')?.classList.remove('open');
    beginRenameSession();
  });
  panelEl('#ocp-session-label')?.addEventListener('mousedown', (event) => {
    if (panelEl('#ocp-session-label .ocp-rename-input')) event.stopPropagation();
  });

  // Action bar
  const triggerChangelog = () => {
    const tab = activeTab();
    if (!tab || tab.running || !_serverReady) return;
    const inp = panelEl('#ocp-input');
    if (!inp) return;
    inp.value = '/synabun changelog';
    autosizeInput();
    handleSend();
  };
  panelEl('#ocp-action-changelog')?.addEventListener('click', triggerChangelog);
  panelEl('#ocp-footer-changelog')?.addEventListener('click', triggerChangelog);
  panelEl('#ocp-revert')?.addEventListener('click', async () => {
    const tab = activeTab();
    if (tab?.sessionId) {
      await revertSession(tab.sessionId);
      renderTabMessages();
    }
  });
  panelEl('#ocp-compact')?.addEventListener('click', async () => {
    const tab = activeTab();
    if (tab?.sessionId) await compactSession(tab.sessionId);
  });

  // Input handling
  const input = panelEl('#ocp-input');
  const sendBtn = panelEl('#ocp-send');

  if (input) {
    input.addEventListener('input', () => {
      autosizeInput();
      syncSendButton();
      refreshSlashTrigger();
    });
    input.addEventListener('keyup', (e) => {
      // Re-detect when caret moves with arrow keys / home/end, but skip when
      // navigating an open browser
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return;
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') return;
      refreshSlashTrigger();
    });
    input.addEventListener('click', () => refreshSlashTrigger());
    input.addEventListener('keydown', (e) => {
      const browser = panelEl('#ocp-slash-hints');
      const browserOpen = !!browser?.classList.contains('open');

      // Browser-open shortcuts take priority
      if (browserOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          navigateSlashHints(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          navigateSlashHints(-1);
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          if (applySlashHint()) {
            e.preventDefault();
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          hideSlashHints();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        // Cycle agent mode: build -> plan -> chat -> build
        const modes = ['build', 'plan', 'chat'];
        const current = getActiveTabMode();
        const idx = modes.indexOf(current);
        const next = modes[(idx + 1) % modes.length];
        setTabMode(next);
        return;
      }
      if (e.key === 'Escape') {
        if (activeTabRunning()) {
          e.preventDefault();
          e.stopPropagation();
          abortMessage();
        }
      }
    });
  }
  // Panel-level Tab — cycle agent mode when not typing in the input
  _panel.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && document.activeElement !== input) {
      e.preventDefault();
      const modes = ['build', 'plan', 'chat'];
      const current = getActiveTabMode();
      const idx = modes.indexOf(current);
      const next = modes[(idx + 1) % modes.length];
      setTabMode(next);
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
      e.preventDefault();
      const tab = activeTab();
      if (tab) setActivityVisible(tab, !tab.toolActivityVisible);
    } else if (e.key === 'Escape') {
      // Let open menus / hints / inline rename swallow Esc first so they close
      // normally. Only fire the global abort if none of them own it.
      const ownsEsc = _panel.querySelector('.ocp-dd-menu.open')
        || _panel.querySelector('#ocp-slash-hints:not([hidden])')
        || _panel.querySelector('.ocp-rename-input')
        || _panel.querySelector('#ocp-session-menu.open');
      if (!ownsEsc && activeTabRunning()) {
        e.preventDefault();
        e.stopPropagation();
        abortMessage();
      }
    }
  });
  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      if (activeTabRunning()) {
        abortMessage();
      } else {
        handleSend();
      }
    });
  }
  const attachBtn = panelEl('#ocp-attach');
  const fileInput = panelEl('#ocp-file-input');
  attachBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (event) => {
    const files = [...(event.target.files || [])];
    files.forEach(addImageFromFile);
    event.target.value = '';
  });
  _panel.querySelectorAll('.ocp-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = activeTab();
      if (!tab || tab.running) return;
      setTabMode(btn.dataset.mode || 'build');
    });
  });

  // Dropdown toggles
  setupDropdownToggle('#ocp-model-dd');
  setupDropdownToggle('#ocp-project-dd');
  setupDropdownToggle('#ocp-branch');
  setupDropdownToggle('#ocp-profile-dd');
  setupDropdownToggle('#ocp-recall-dd');

  // Close dropdowns/menus on outside click
  document.addEventListener('click', (e) => {
    if (!_panel?.contains(e.target)) return;
    // Close session menu if clicking outside it
    const sessionMenu = panelEl('#ocp-session-menu');
    if (sessionMenu?.classList.contains('open') && !e.target.closest('#ocp-session-btn') && !e.target.closest('#ocp-session-menu')) {
      sessionMenu.classList.remove('open');
    }
    // Close dropdown menus
    _panel.querySelectorAll('.ocp-dd-menu.open').forEach(menu => {
      if (!menu.parentElement.contains(e.target)) menu.classList.remove('open');
    });
    // Close slash command browser if clicking outside it and outside the input
    const slashBrowser = panelEl('#ocp-slash-hints');
    if (slashBrowser?.classList.contains('open')
        && !e.target.closest('#ocp-slash-hints')
        && !e.target.closest('#ocp-input')) {
      hideSlashHints();
    }
  });

  // Status bar start button
  _panel.addEventListener('click', (e) => {
    if (e.target.closest('.ocp-start-btn')) {
      sendWs({ type: 'init' });
      setStatus('connecting', 'Starting OpenCode…');
    }
  });

  on('wb:send-to-panel', ({ dataUrl }) => {
    if (!dataUrl) return;
    if (!_visible && state.lastActivePanel !== 'opencode') return;
    if (!_visible) setVisible(true);
    const tab = activeTab();
    if (!tab) return;
    const match = dataUrl.match(/^data:(image\/[-+.\w]+);base64,/);
    if (!match) return;
    if ((tab.attachedImages?.length || 0) >= MAX_IMAGES) return;
    tab.attachedImages = tab.attachedImages || [];
    tab.attachedImages.push({
      name: `whiteboard-${Date.now()}.png`,
      mime: match[1],
      dataUrl,
    });
    renderImageStrip();
    syncSendButton();
  });
}

function addImageFromFile(file) {
  const targetTab = activeTab();
  if (!targetTab || !file || (targetTab.attachedImages?.length || 0) >= MAX_IMAGES) return;
  if (!String(file.type || '').startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    if ((targetTab.attachedImages?.length || 0) >= MAX_IMAGES) return;
    targetTab.attachedImages = targetTab.attachedImages || [];
    targetTab.attachedImages.push({
      name: file.name || `image-${Date.now()}.png`,
      mime: file.type || 'image/png',
      dataUrl: reader.result,
    });
    if (activeTab() === targetTab) {
      renderImageStrip();
      syncSendButton();
    }
  };
  reader.readAsDataURL(file);
}

function removeImage(idx) {
  const tab = activeTab();
  if (!tab?.attachedImages) return;
  tab.attachedImages.splice(idx, 1);
  renderImageStrip();
  syncSendButton();
}

function renderImageStrip() {
  const strip = panelEl('#ocp-image-strip');
  const tab = activeTab();
  if (!strip) return;
  const images = tab?.attachedImages || [];
  strip.innerHTML = '';
  strip.hidden = images.length === 0;
  images.forEach((img, idx) => {
    const chip = document.createElement('div');
    chip.className = 'ocp-image-chip';
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl || img.url || '';
    imgEl.alt = img.name || `Image ${idx + 1}`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'ocp-image-chip-remove';
    removeBtn.type = 'button';
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', () => removeImage(idx));
    chip.append(imgEl, removeBtn);
    strip.appendChild(chip);
  });
}

function setupDropdownToggle(sel) {
  const dd = panelEl(sel);
  if (!dd) return;
  dd.addEventListener('click', (e) => {
    if (e.target.closest('.ocp-dd-menu')) return; // click inside menu handled by options
    const menu = dd.querySelector('.ocp-dd-menu');
    if (menu) {
      const wasOpen = menu.classList.contains('open');
      // Close all others first
      _panel.querySelectorAll('.ocp-dd-menu.open').forEach(m => m.classList.remove('open'));
      if (!wasOpen) {
        if (sel === '#ocp-model-dd') populateModelDropdown(dd);
        if (sel === '#ocp-project-dd') populateProjectDropdown(dd);
        if (sel === '#ocp-branch') {
          const projectPath = activeTab()?.project || '';
          if (projectPath) loadBranches(projectPath);
        }
        if (sel === '#ocp-profile-dd') populateProfileDropdown(dd);
        if (sel === '#ocp-recall-dd') populateRecallDropdown(dd);
        menu.classList.add('open');
        // Auto-focus search input in model dropdown
        if (sel === '#ocp-model-dd') {
          setTimeout(() => menu.querySelector('.ocp-model-search')?.focus(), 50);
        }
      }
    }
  });
}

// ── Slash command parsing ──

const BUILTIN_SLASH_COMMANDS = [
  { name: 'new', description: 'Start a new session', source: 'builtin' },
  { name: 'sessions', description: 'List & switch sessions', source: 'builtin' },
  { name: 'resume', description: 'Resume a session', source: 'builtin' },
  { name: 'continue', description: 'Continue last session', source: 'builtin' },
  { name: 'share', description: 'Share current session', source: 'builtin' },
  { name: 'unshare', description: 'Stop sharing session', source: 'builtin' },
  { name: 'export', description: 'Export session as JSON', source: 'builtin' },
  { name: 'import', description: 'Import session from JSON', source: 'builtin' },
  { name: 'compact', description: 'Compact context', aliases: ['summarize'], source: 'builtin' },
  { name: 'clear', description: 'Clear all messages', source: 'builtin' },
  { name: 'undo', description: 'Undo last message', source: 'builtin' },
  { name: 'redo', description: 'Redo undone message', source: 'builtin' },
  { name: 'models', description: 'Pick a model', source: 'builtin' },
  { name: 'providers', description: 'Manage providers & auth', source: 'builtin' },
  { name: 'agents', description: 'Switch agent', aliases: ['agent'], source: 'builtin' },
  { name: 'themes', description: 'Pick a theme', source: 'builtin' },
  { name: 'init', description: 'Initialize project (AGENTS.md)', source: 'builtin' },
  { name: 'editor', description: 'Open in editor', source: 'builtin' },
  { name: 'tokens', description: 'Token usage stats', source: 'builtin' },
  { name: 'config', description: 'Open config', source: 'builtin' },
  { name: 'login', description: 'Provider login', source: 'builtin' },
  { name: 'logout', description: 'Provider logout', source: 'builtin' },
  { name: 'help', description: 'Show help', source: 'builtin' },
  { name: 'exit', description: 'Exit OpenCode', aliases: ['quit'], source: 'builtin' },
];

let SLASH_COMMANDS = [...BUILTIN_SLASH_COMMANDS];
let _catalogLoaded = false;

async function loadSlashCommandCatalog() {
  if (_catalogLoaded) return;
  _catalogLoaded = true;
  const seen = new Set();
  for (const c of BUILTIN_SLASH_COMMANDS) {
    seen.add(c.name);
    (c.aliases || []).forEach(a => seen.add(a));
  }
  const [skillsRes, userRes] = await Promise.allSettled([
    fetch('/api/skills').then(r => r.json()).catch(() => null),
    fetch('/api/opencode/commands').then(r => r.json()).catch(() => null),
  ]);
  const merged = [...BUILTIN_SLASH_COMMANDS];
  const skills = Array.isArray(skillsRes.value?.skills) ? skillsRes.value.skills : [];
  for (const s of skills) {
    const name = String(s.name || s.dirName || '').trim();
    if (!name || seen.has(name)) continue;
    merged.push({ name, description: String(s.description || '').trim(), source: 'skill' });
    seen.add(name);
  }
  const userCmds = Array.isArray(userRes.value?.commands) ? userRes.value.commands : [];
  for (const c of userCmds) {
    const name = String(c.name || '').trim();
    if (!name || seen.has(name)) continue;
    merged.push({ name, description: String(c.description || '').trim(), source: 'user' });
    seen.add(name);
  }
  SLASH_COMMANDS = merged;
  // Re-render if browser is currently open
  if (panelEl('#ocp-slash-hints')?.classList.contains('open')) {
    showSlashHints(_slashQuery, _activeSlashToken);
  }
}

// Kick off load at module init; browser UI will re-render on demand.
loadSlashCommandCatalog();

let _slashHintIdx = -1;
let _slashQuery = '';
let _slashItems = []; // flat ordered list for keyboard nav
let _activeSlashToken = null; // { start, end } in textarea

function parseSlashCommand(text) {
  const match = text.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2] || '' };
}

// Detect a "/word" token at the cursor position in the input. Returns
// { start, end, query } or null. URL-guard: skip if preceded by `:` (https://).
function detectSlashToken(inputEl) {
  if (!inputEl) return null;
  const pos = inputEl.selectionStart ?? inputEl.value.length;
  const value = inputEl.value;
  const before = value.slice(0, pos);
  let tokenStart = pos;
  while (tokenStart > 0 && !/\s/.test(value[tokenStart - 1])) tokenStart--;
  const token = value.slice(tokenStart, pos);
  if (!token.startsWith('/')) return null;
  // URL guard: `https://example.com` — char before `/` is `:` or another `/`
  if (tokenStart > 0) {
    const prev = value[tokenStart - 1];
    if (prev === ':' || prev === '/') return null;
  }
  // Also bail if the leading slash sits inside a longer URL-like token
  if (/^\/\/+/.test(token)) return null;
  return { start: tokenStart, end: pos, query: token.slice(1) };
}

// Compute match score + matched-char indices for highlighting.
// Returns { score, indices } or null when there is no match.
function scoreSlashMatch(name, query) {
  if (!query) return { score: 1, indices: [] };
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) {
    return { score: 1000, indices: [...q].map((_, i) => i) };
  }
  if (n.startsWith(q)) {
    return { score: 700 - (n.length - q.length), indices: [...q].map((_, i) => i) };
  }
  const idx = n.indexOf(q);
  if (idx !== -1) {
    return { score: 400 - idx, indices: [...q].map((_, i) => idx + i) };
  }
  // Subsequence fuzzy
  let qi = 0, score = 0, lastIdx = -2;
  const indices = [];
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) {
      score += (lastIdx === i - 1) ? 8 : 4;
      indices.push(i);
      lastIdx = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return { score: 100 + score, indices };
}

function rankSlashMatch(cmd, query) {
  let best = scoreSlashMatch(cmd.name, query);
  // Try aliases — keep canonical indices only if alias matches better
  for (const alias of (cmd.aliases || [])) {
    const m = scoreSlashMatch(alias, query);
    if (m && (!best || m.score > best.score)) {
      // No highlight when match is via alias (canonical name shown)
      best = { score: m.score, indices: [] };
    }
  }
  return best;
}

function renderHighlightedName(name, indices) {
  if (!indices?.length) return '/' + esc(name);
  const set = new Set(indices);
  let out = '/';
  for (let i = 0; i < name.length; i++) {
    out += set.has(i) ? `<span class="ocp-slash-hl">${esc(name[i])}</span>` : esc(name[i]);
  }
  return out;
}

const SLASH_GROUP_ORDER = ['builtin', 'skill', 'user'];
const SLASH_GROUP_LABEL = { builtin: 'OpenCode', skill: 'Skills', user: 'Custom' };

function showSlashHints(query, tokenInfo) {
  const browser = panelEl('#ocp-slash-hints');
  if (!browser) return;
  _slashQuery = query || '';
  _activeSlashToken = tokenInfo || _activeSlashToken;

  // Score and rank
  const scored = [];
  for (const cmd of SLASH_COMMANDS) {
    const m = rankSlashMatch(cmd, _slashQuery);
    if (!m) continue;
    scored.push({ cmd, score: m.score, indices: m.indices });
  }
  scored.sort((a, b) => (b.score - a.score) || a.cmd.name.localeCompare(b.cmd.name));

  // Group by source while preserving rank order within each group
  const groups = {};
  for (const entry of scored) {
    const src = entry.cmd.source || 'builtin';
    (groups[src] ||= []).push(entry);
  }

  // Render
  browser.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'ocp-slash-search';
  header.innerHTML = `
    <span class="ocp-slash-search-icon">/</span>
    <span class="ocp-slash-query">${esc(_slashQuery)}</span>
    <span class="ocp-slash-count">${scored.length} result${scored.length === 1 ? '' : 's'}</span>
  `;
  browser.appendChild(header);

  const list = document.createElement('div');
  list.className = 'ocp-slash-list';
  browser.appendChild(list);

  _slashItems = [];
  if (!scored.length) {
    const empty = document.createElement('div');
    empty.className = 'ocp-slash-empty';
    empty.textContent = _slashQuery ? `No commands match /${_slashQuery}` : 'No commands available';
    list.appendChild(empty);
  } else {
    for (const src of SLASH_GROUP_ORDER) {
      const entries = groups[src];
      if (!entries?.length) continue;
      const group = document.createElement('div');
      group.className = 'ocp-slash-group';
      const gh = document.createElement('div');
      gh.className = 'ocp-slash-group-header';
      gh.textContent = SLASH_GROUP_LABEL[src] || src;
      group.appendChild(gh);
      for (const entry of entries) {
        const itemIdx = _slashItems.length;
        const item = document.createElement('div');
        item.className = 'ocp-slash-item' + (itemIdx === 0 ? ' active' : '');
        item.dataset.name = entry.cmd.name;
        item.dataset.source = src;
        item.innerHTML = `
          <span class="ocp-slash-icon" data-source="${src}">${src === 'builtin' ? '▸' : src === 'skill' ? '✦' : '★'}</span>
          <span class="ocp-slash-name">${renderHighlightedName(entry.cmd.name, entry.indices)}</span>
          <span class="ocp-slash-desc">${esc(entry.cmd.description || '')}</span>
        `;
        item.addEventListener('click', () => {
          _slashHintIdx = itemIdx;
          applySlashHint();
        });
        item.addEventListener('mousemove', () => {
          if (_slashHintIdx === itemIdx) return;
          _slashItems[_slashHintIdx]?.el?.classList.remove('active');
          _slashHintIdx = itemIdx;
          item.classList.add('active');
        });
        group.appendChild(item);
        _slashItems.push({ name: entry.cmd.name, el: item });
      }
      list.appendChild(group);
    }
  }

  _slashHintIdx = _slashItems.length ? 0 : -1;
  browser.hidden = false;
  browser.classList.add('open');
}

function hideSlashHints() {
  const browser = panelEl('#ocp-slash-hints');
  if (browser) {
    browser.classList.remove('open');
    browser.innerHTML = '';
    browser.hidden = true;
  }
  _slashHintIdx = -1;
  _slashItems = [];
  _activeSlashToken = null;
  _slashQuery = '';
}

function navigateSlashHints(dir) {
  if (!_slashItems.length) return;
  _slashItems[_slashHintIdx]?.el?.classList.remove('active');
  _slashHintIdx = Math.max(0, Math.min(_slashItems.length - 1, _slashHintIdx + dir));
  const next = _slashItems[_slashHintIdx]?.el;
  if (next) {
    next.classList.add('active');
    next.scrollIntoView({ block: 'nearest' });
  }
}

function applySlashHint() {
  const item = _slashItems[_slashHintIdx];
  if (!item) return false;
  const input = panelEl('#ocp-input');
  const token = _activeSlashToken;
  if (!input || !token) {
    hideSlashHints();
    return false;
  }
  const before = input.value.slice(0, token.start);
  const after = input.value.slice(token.end);
  const insert = '/' + item.name + ' ';
  input.value = before + insert + after;
  const caret = (before + insert).length;
  try { input.setSelectionRange(caret, caret); } catch {}
  input.focus();
  autosizeInput();
  syncSendButton();
  hideSlashHints();
  return true;
}

// Re-evaluate slash trigger from the current cursor position.
function refreshSlashTrigger() {
  const input = panelEl('#ocp-input');
  if (!input) return;
  const token = detectSlashToken(input);
  if (token) showSlashHints(token.query, token);
  else hideSlashHints();
}

async function executeSlashCommand(command, args) {
  // Skill commands are not handled locally — let them flow through sendMessage()
  // so the server's maybeInjectSkillPrompt() can replace them with the SKILL.md body.
  if (_skillNames.has(command)) return false;
  const tab = activeTab();
  if (!tab?.sessionId) {
    if (command === 'new') { createTab(); return true; }
    return false;
  }
  switch (command) {
    case 'new':
      createTab();
      return true;
    case 'undo':
      await executeCommand(tab.sessionId, 'undo');
      return true;
    case 'redo':
      await executeCommand(tab.sessionId, 'redo');
      return true;
    case 'compact':
    case 'summarize':
      await executeCommand(tab.sessionId, 'compact');
      return true;
    case 'share':
      await shareSession(tab.sessionId);
      return true;
    case 'unshare':
      await executeCommand(tab.sessionId, 'unshare');
      return true;
    case 'sessions':
    case 'resume':
    case 'continue':
      await loadSessions();
      return true;
    case 'clear':
      await executeCommand(tab.sessionId, 'clear');
      return true;
    case 'help':
      await sendMessage('Help: OpenCode CLI commands include /new, /undo, /redo, /compact, /share, /sessions, /resume, /continue, /unshare, /clear, /exit');
      return true;
    case 'exit':
    case 'quit':
      await executeCommand(tab.sessionId, 'exit');
      return true;
    default:
      return false;
  }
}

// ── @file reference parsing ──

async function parseFileRefs(text) {
  const refs = [];
  const atMatch = text.matchAll(/@([^\s@]+)/g);
  for (const match of atMatch) {
    const path = match[1];
    if (path) refs.push(path);
  }
  if (!refs.length) return null;
  try {
    const results = await Promise.all(refs.map(async (refPath) => {
      const cleanPath = refPath.replace(/^#L\d+(?:-L\d+)?$/, '').replace(/:L\d+(?:-L\d+)?$/, '');
      const resp = await fetch(`/api/opencode/file?path=${encodeURIComponent(cleanPath)}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      return { path: cleanPath, content: data.content || '' };
    }));
    const valid = results.filter(Boolean);
    if (!valid.length) return null;
    return valid;
  } catch {
    return null;
  }
}

// ── Send handler ──

async function handleSend() {
  const input = panelEl('#ocp-input');
  if (!input) return;
  const tab = activeTab();
  if (!tab) return;
  if (_cliInstalled === null || _cliInstallFailureForced) {
    setStatus('offline', 'OpenCode CLI not installed. Install it first, then click Re-check.');
    return;
  }
  let text = input.value.trim();
  const images = Array.isArray(tab.attachedImages) ? [...tab.attachedImages] : [];
  if (!text && !images.length) return;
  if (tab.showPostPlanActions) {
    setStatus('working', 'Choose Continue, Compact, or Edit plan first.');
    return;
  }

  // Parse and execute slash commands. If executeSlashCommand returns false
  // (e.g. a SynaBun skill that the server will expand), keep `text` in flight
  // so sendMessage() delivers it and the server-side injector takes over.
  const slashCmd = parseSlashCommand(text);
  if (slashCmd) {
    hideSlashHints();
    const handled = await executeSlashCommand(slashCmd.command, slashCmd.args);
    if (handled) {
      input.value = '';
      autosizeInput();
      syncSendButton();
      return;
    }
  }

  // Parse @file references and inject file content
  const fileRefs = await parseFileRefs(text);
  if (fileRefs && fileRefs.length > 0) {
    const refSections = fileRefs.map(({ path, content }) => {
      return `\n\nFile: ${path}\n\`\`\`\n${content}\n\`\`\`\n`;
    }).join('\n');
    text = `${text}${refSections}`;
  }

  input.value = '';
  tab.attachedImages = [];
  autosizeInput();
  if (activeTab() === tab) {
    renderImageStrip();
    syncSendButton();
  }
  const sent = await sendMessage(text, { images });
  if (!sent) {
    tab.attachedImages = images;
    if (activeTab() === tab) {
      renderImageStrip();
      syncSendButton();
    }
  }
}

// ── Input autosize ──

function autosizeInput() {
  const input = panelEl('#ocp-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// ── Status bar ──

function setStatus(statusClass, _text) {
  const dot = panelEl('#ocp-status-dot');
  const text = panelEl('#ocp-status-text');
  const startBtn = panelEl('#ocp-start-server');
  if (dot) dot.className = 'ocp-status-dot ' + statusClass;
  if (text) text.textContent = _text || '';
  if (startBtn) startBtn.hidden = statusClass !== 'offline';
}

function readyStatusText() {
  return `Ready${_serverVersion ? ' v' + _serverVersion : ''}`;
}

function syncRuntimeStatus() {
  const tab = activeTab();
  if (tab?.running) {
    const detail = tab.statusDetail ? ` · ${tab.statusDetail}` : '';
    setStatus('working', `${tab.statusText || 'Working…'}${detail}`);
    return;
  }
  if (isConnected() && !_serverReady) {
    setStatus('connecting', 'Connecting to OpenCode…');
    return;
  }
  if (_serverReady) {
    setStatus('ready', readyStatusText());
    return;
  }
  setStatus('offline', 'Disconnected');
}

// ── Sync UI state ──

function syncSendButton() {
  const sendBtn = panelEl('#ocp-send');
  const input = panelEl('#ocp-input');
  const tab = activeTab();
  if (!sendBtn) return;

  const cliBlocked = _cliInstalled === null || _cliInstallFailureForced;

  if (cliBlocked) {
    sendBtn.classList.remove('running');
    sendBtn.disabled = true;
    sendBtn.setAttribute('data-tooltip', 'OpenCode CLI not installed');
    sendBtn.setAttribute('aria-label', 'OpenCode CLI not installed');
    return;
  }

  if (tab?.running) {
    sendBtn.disabled = false;
    sendBtn.classList.add('running');
    sendBtn.setAttribute('data-tooltip', 'Stop turn (Esc)');
    sendBtn.setAttribute('aria-label', 'Stop turn');
  } else if (tab?.showPostPlanActions) {
    sendBtn.classList.remove('running');
    sendBtn.disabled = true;
    sendBtn.setAttribute('data-tooltip', 'Choose a plan action first');
    sendBtn.setAttribute('aria-label', 'Choose a plan action first');
  } else {
    sendBtn.classList.remove('running');
    sendBtn.disabled = (!input?.value.trim() && !(tab?.attachedImages?.length)) || !_serverReady;
    sendBtn.setAttribute('data-tooltip', 'Send');
    sendBtn.setAttribute('aria-label', 'Send message');
  }
}

function syncModeToggle() {
  const tab = activeTab();
  const mode = getActiveTabMode();
  _panel?.querySelectorAll('.ocp-mode-btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.disabled = !!tab?.running;
    if (btn.dataset.mode === 'chat') btn.title = 'Chat mode';
    if (btn.dataset.mode === 'build') btn.title = 'Build mode';
    if (btn.dataset.mode === 'plan') btn.title = 'Plan mode';
  });
}

function syncActionBar() {
  const tab = activeTab();
  const hasSession = !!tab?.sessionId;
  const notRunning = !tab?.running;

  const revert = panelEl('#ocp-revert');
  const compact = panelEl('#ocp-compact');

  if (revert) revert.disabled = !hasSession || !notRunning;
  if (compact) compact.disabled = !hasSession || !notRunning;

  const rename = panelEl('#ocp-header-rename');
  if (rename) rename.disabled = !canRenameActiveSession();
}

function syncTokens() {
  const tab = activeTab();
  const usage = tab?.threadTokenUsage || null;
  const total = usage?.total || null;
  const contextWindow = usage?.modelContextWindow || getModelContextWindow(tab?.model) || 200000;
  const inputTokens = resolveContextInputTokens(total);
  const outputTokens = Number(total?.outputTokens) || 0;
  const cachedInput = Number(total?.cachedInputTokens) || 0;
  const cacheCreation = Number(total?.cacheCreationInputTokens) || 0;

  const fill = panelEl('#ocp-ctx-fill');
  const label = panelEl('#ocp-ctx-label');
  const tokenEl = panelEl('#ocp-tokens');

  if (fill) {
    const pct = contextWindow > 0 ? Math.min(100, (inputTokens / contextWindow) * 100) : 0;
    fill.style.width = pct > 0 ? pct + '%' : '0%';
    fill.style.background = pct > 80
      ? 'rgba(220,80,60,0.45)'
      : pct > 60
        ? 'rgba(220,150,50,0.38)'
        : 'rgba(232,224,220,0.18)';
  }
  if (label) {
    if (inputTokens > 0 && contextWindow > 0) {
      const usedK = inputTokens >= 1000 ? `${Math.round(inputTokens / 1000)}k` : String(inputTokens);
      const ctxK = contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}k` : String(contextWindow);
      label.textContent = `${usedK} / ${ctxK} ctx`;
    } else {
      label.textContent = 'context pending';
    }
    // Rich tooltip with full breakdown
    if (total) {
      const lines = [
        `${Math.round((inputTokens / contextWindow) * 100)}% context window used`,
        '',
        `Input:       ${Number(total.inputTokens).toLocaleString()}`,
        `Cached read: ${cachedInput.toLocaleString()}`,
        cacheCreation ? `Cache write: ${cacheCreation.toLocaleString()}` : '',
        `Output:      ${outputTokens.toLocaleString()}`,
        total.reasoningOutputTokens ? `Reasoning:   ${Number(total.reasoningOutputTokens).toLocaleString()}` : '',
        '',
        `Context window: ${contextWindow.toLocaleString()}`,
      ];
      label.title = lines.filter(Boolean).join('\n');
    } else {
      label.title = '';
    }
  }
  if (tokenEl && tab) {
    tokenEl.textContent = `${inputTokens}↑ ${outputTokens}↓`;
  }
}

function syncSessionLabel() {
  const label = panelEl('#ocp-session-label');
  const tab = activeTab();
  if (label?.querySelector('.ocp-rename-input')) return;
  if (label) label.textContent = sessionTitleFor(tab);
}

function syncProjectBar() {
  const tab = activeTab();
  const projectPath = tab?.project || '';

  // Sync project label
  const projectDd = panelEl('#ocp-project-dd');
  if (projectDd) {
    const lbl = projectDd.querySelector('.ocp-dd-label');
    if (lbl) {
      lbl.textContent = projectPath ? projectPath.split('/').pop() : (projectDd.dataset.placeholder || 'project...');
    }
  }

  // Sync branch label — trigger load if project is set and branch still shows placeholder
  const branchDd = panelEl('#ocp-branch');
  if (branchDd && projectPath) {
    const branchLbl = branchDd.querySelector('.ocp-dd-label');
    if (branchLbl && branchLbl.textContent === (branchDd.dataset.placeholder || 'branch')) {
      loadBranches(projectPath);
    }
  }
}

function syncModelLabel() {
  const dd = panelEl('#ocp-model-dd');
  if (!dd) return;
  const lbl = dd.querySelector('.ocp-dd-label');
  if (!lbl) return;
  const tab = activeTab();
  const modelStr = tab?.model || '';
  if (modelStr) {
    const idx = modelStr.lastIndexOf('/');
    lbl.textContent = idx >= 0 ? modelStr.slice(idx + 1) : modelStr;
  } else {
    lbl.textContent = dd.dataset.placeholder || 'model...';
  }
}

function onUpdate() {
  syncRuntimeStatus();
  renderImageStrip();
  syncModeToggle();
  syncSendButton();
  syncActionBar();
  syncTokens();
  syncSessionLabel();
  syncProjectBar();
  syncModelLabel();
  renderPills();
  renderToolActivityDock(activeTab(), _panel, {
    onToggle: (visible) => setActivityVisible(activeTab(), visible),
    onToggleExpand: (key) => toggleActivityExpanded(activeTab(), key),
    onAbortAgent: (key) => abortAgent(activeTab(), key),
    onJumpToCard: (toolId) => focusActivityToolCard(_panel, toolId),
  });
  ensureActivityTicker();
}

// Live elapsed ticker — updates the time badges inside the agents drawer
// every 1s while any running entry exists. Cheap per-row DOM writes only.
let _activityTickerHandle = null;
function ensureActivityTicker() {
  if (_activityTickerHandle) return;
  const tab = activeTab();
  const entries = Array.isArray(tab?.toolActivity) ? tab.toolActivity : [];
  const anyRunning = entries.some(e => e?.status === 'running');
  if (!anyRunning) return;
  _activityTickerHandle = setInterval(() => {
    if (!_panel) { stopActivityTicker(); return; }
    if (document.hidden) return;
    const t = activeTab();
    const still = tickActivityDockElapsed(t, _panel);
    if (!still) stopActivityTicker();
  }, 1000);
}
function stopActivityTicker() {
  if (_activityTickerHandle) {
    clearInterval(_activityTickerHandle);
    _activityTickerHandle = null;
  }
}

// ── Session menu ──

function sessionMatchesProject(session, projectPath) {
  const dir = session?.directory || '';
  if (!dir) return false;
  const trimmed = projectPath.replace(/\/+$/, '');
  return dir === trimmed || dir.startsWith(trimmed + '/');
}

async function renderSessionMenu() {
  const menu = panelEl('#ocp-session-menu');
  if (!menu) return;

  menu.innerHTML = '<div class="ocp-session-item" style="opacity:0.4">Loading…</div>';
  await loadSessions();

  const sessions = getSessions();
  const tab = activeTab();
  const projectPath = tab?.project || '';
  const projectScoped = projectPath
    ? sessions.filter((session) => sessionMatchesProject(session, projectPath))
    : sessions;
  const sessionsWithMessages = projectScoped.filter((session) => Number(session?.messageCount || 0) > 0);
  const visibleSessions = sessionsWithMessages.length ? sessionsWithMessages : projectScoped;
  menu.innerHTML = '';

  // Build into a fragment — appending items one by one to the live menu
  // dirties layout once per session row
  const frag = document.createDocumentFragment();

  // New session option
  const newItem = document.createElement('div');
  newItem.className = 'ocp-session-item';
  newItem.innerHTML = `<span style="opacity:0.5">+ New session</span>`;
  newItem.addEventListener('click', async () => {
    menu.classList.remove('open');
    createTab();
  });
  frag.appendChild(newItem);

  if (!visibleSessions.length) {
    menu.appendChild(frag);
    return;
  }

  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin:4px 8px';
  frag.appendChild(sep);

  for (const s of visibleSessions) {
    const sid = s.id || s.sessionID;
    const title = sessionTitleFor(s);
    const isActive = tab?.sessionId === sid;

    const item = document.createElement('div');
    item.className = 'ocp-session-item' + (isActive ? ' active' : '');

    // Tooltip: full title, positioned left of the dropdown
    if (title && title !== 'New session' && title.length > 8) {
      const tipText = title.length > 200 ? title.slice(0, 200) + '…' : title;
      item.setAttribute('data-tooltip', tipText);
      item.setAttribute('data-tooltip-pos', 'left');
    }

    item.innerHTML = `
      <span class="ocp-session-item-label">${esc(title)}</span>
      <button class="ocp-session-item-delete" data-tooltip="Delete">${ICON_X}</button>
    `;
    item.querySelector('.ocp-session-item-label').addEventListener('click', () => {
      menu.classList.remove('open');
      const t = activeTab();
      if (t) {
        t.sessionId = sid;
        t.sessionTitle = title;
        t.toolActivity = [];
        t.toolActivityChildSessions = {};
        saveTabs();
        renderTabMessages();
        onUpdate();
      }
    });
    item.querySelector('.ocp-session-item-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteSession(sid);
      renderSessionMenu();
    });
    frag.appendChild(item);
  }

  menu.appendChild(frag);
}

// ── Project dropdown ──

function populateProjectDropdown(dd) {
  const menu = dd.querySelector('.ocp-dd-menu');
  if (!menu) return;
  menu.innerHTML = '';

  const tab = activeTab();
  const current = tab?.project || '';

  for (const p of _projects) {
    const path = p.path || p;
    const label = typeof path === 'string' ? path.split('/').pop() : '';
    const opt = document.createElement('div');
    opt.className = 'ocp-dd-option' + (path === current ? ' selected' : '');
    opt.textContent = label || path;
    opt.title = path;
    opt.addEventListener('click', () => {
      setActiveProject(path);
      menu.classList.remove('open');
      const lbl = dd.querySelector('.ocp-dd-label');
      if (lbl) lbl.textContent = label || path;
      menu.querySelectorAll('.ocp-dd-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      loadBranches(path);
      if (panelEl('#ocp-session-menu')?.classList.contains('open')) renderSessionMenu();
    });
    menu.appendChild(opt);
  }
}

// ── Branch loader ──

// Tracks the project we last fetched branches for, so the panel-show path can
// skip the network refetch when the project hasn't changed.
let _lastBranchProject = null;
async function loadBranches(projectPath) {
  const dd = panelEl('#ocp-branch');
  if (!dd) return;
  const menu = dd.querySelector('.ocp-dd-menu');
  const lbl = dd.querySelector('.ocp-dd-label');
  if (!menu || !lbl) return;

  if (!projectPath) {
    menu.innerHTML = '';
    lbl.textContent = 'branch';
    return;
  }

  _lastBranchProject = projectPath;
  try {
    const data = await fetch(`/api/terminal/branches?path=${encodeURIComponent(projectPath)}`).then(r => r.json());
    const branches = data.branches || [];
    const currentBranch = data.current || '';
    lbl.textContent = currentBranch || 'branch';
    menu.innerHTML = '';
    for (const name of branches) {
      const opt = document.createElement('div');
      opt.className = 'ocp-dd-option' + (name === currentBranch ? ' selected' : '');
      opt.textContent = name;
      opt.addEventListener('click', () => {
        menu.classList.remove('open');
        lbl.textContent = name;
        menu.querySelectorAll('.ocp-dd-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
      });
      menu.appendChild(opt);
    }
  } catch {
    // silently ignore if branches can't be loaded
  }
}

// ── MCP Profile ──

let _mcpProfiles = [];
let _currentProfile = 'full';

function mcpProfileItemsFromPresets(presets) {
  if (!presets || typeof presets !== 'object') return null;
  return Object.entries(presets).map(([id, p]) => ({
    id,
    label: p?.label || id,
    hint: `${p?.tools || '?'} tools`,
  }));
}

function applyMcpProfileState(profile, presets) {
  if (profile) _currentProfile = profile;
  const items = mcpProfileItemsFromPresets(presets);
  if (items) _mcpProfiles = items;
  const dd = panelEl('#ocp-profile-dd');
  if (dd) populateProfileDropdown(dd);
}

async function loadCurrentProfile() {
  try {
    const resp = await fetch('/api/mcp/profile');
    const data = await resp.json();
    if (data.ok) {
      applyMcpProfileState(data.profile, data.presets);
      return;
    }
  } catch {}
  const dd = panelEl('#ocp-profile-dd');
  if (dd) populateProfileDropdown(dd);
  const lbl = dd?.querySelector('.ocp-dd-label');
  if (lbl) {
    const matched = _mcpProfiles.find(p => p.id === _currentProfile);
    lbl.textContent = matched ? matched.label : _currentProfile;
  }
}

function populateProfileDropdown(dd) {
  const menu = dd.querySelector('.ocp-dd-menu');
  const lbl = dd.querySelector('.ocp-dd-label');
  if (!menu || !lbl) return;
  menu.innerHTML = '';
  const matched = _mcpProfiles.find(p => p.id === _currentProfile);
  lbl.textContent = matched ? matched.label : _currentProfile;
  dd.classList.add('has-value');
  dd._value = _currentProfile;
  for (const p of _mcpProfiles) {
    const opt = document.createElement('div');
    opt.className = 'ocp-dd-option' + (p.id === _currentProfile ? ' selected' : '');
    opt.style.gap = '6px';
    opt.innerHTML = `<span>${p.label}</span><span style="opacity:0.35;margin-left:auto;font-size:9px">${p.hint}</span>`;
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.remove('open');
      if (p.id === _currentProfile) return;
      _currentProfile = p.id;
      lbl.textContent = p.label;
      menu.querySelectorAll('.ocp-dd-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      updateMcpProfile(p.id);
    });
    menu.appendChild(opt);
  }
}

async function updateMcpProfile(profile) {
  // This retired panel used a shared OpenCode serve and therefore cannot
  // provide per-session MCP isolation. Its WebSocket route is disabled; keep
  // this directly served legacy module fail-closed as well so a stale bundle
  // can never rewrite the shared future-runtime default or global MCP config.
  console.warn(`[ocp-legacy] MCP profile switch to ${profile} ignored; reopen the OpenCode V2 sidepanel.`);
}

// ── Recall Profile ──

const RECALL_PROFILES_META = [
  { id: 'quick',    label: 'Quick',    hint: '3 results' },
  { id: 'balanced', label: 'Balanced', hint: '5 results' },
  { id: 'deep',     label: 'Deep',     hint: '10 results' },
  { id: 'custom',   label: 'Custom',   hint: 'custom' },
];
const RECALL_PROFILE_DEFAULTS = {
  quick:    { limit: 3,  minImportance: 5, minScore: 0.45, maxChars: 300,  includeSessions: 'never',  recencyBoost: false },
  balanced: { limit: 5,  minImportance: 0, minScore: 0.30, maxChars: 0,    includeSessions: 'auto',   recencyBoost: false },
  deep:    { limit: 10, minImportance: 0, minScore: 0.20, maxChars: 0,    includeSessions: 'always', recencyBoost: false },
};

let _recallProfile = 'balanced';

async function loadRecallProfile() {
  try {
    const data = await fetch('/api/display-settings').then(r => r.json());
    if (data.profile) _recallProfile = data.profile;
  } catch {}
  const dd = panelEl('#ocp-recall-dd');
  if (dd) populateRecallDropdown(dd);
  const lbl = dd?.querySelector('.ocp-dd-label');
  if (lbl) {
    const matched = RECALL_PROFILES_META.find(p => p.id === _recallProfile);
    lbl.textContent = matched ? matched.label : _recallProfile;
  }
}

function populateRecallDropdown(dd) {
  const menu = dd.querySelector('.ocp-dd-menu');
  const lbl = dd.querySelector('.ocp-dd-label');
  if (!menu || !lbl) return;
  menu.innerHTML = '';
  for (const p of RECALL_PROFILES_META) {
    const opt = document.createElement('div');
    opt.className = 'ocp-dd-option' + (p.id === _recallProfile ? ' selected' : '');
    opt.style.gap = '6px';
    opt.innerHTML = `<span>${p.label}</span><span style="opacity:0.35;margin-left:auto;font-size:9px">${p.hint}</span>`;
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.remove('open');
      if (p.id === _recallProfile) return;
      _recallProfile = p.id;
      lbl.textContent = p.label;
      menu.querySelectorAll('.ocp-dd-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      saveRecallProfile(p.id);
    });
    menu.appendChild(opt);
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

// ── Layout ──

// Pass a numeric `knownWidth` during drag-resize to skip the getBoundingClientRect
// measure (we already know the target width) and avoid a forced reflow every frame.
function syncReservedWidth(knownWidth) {
  if (_visible && _panel) {
    reserveRightPanelLayout(PANEL_OWNER, typeof knownWidth === 'number' ? knownWidth + 20 : _panel, 20);
  } else {
    clearRightPanelLayout(PANEL_OWNER);
  }
}

function _ocpDocEscHandler(event) {
  if (event.key !== 'Escape') return;
  if (!_visible) return;
  if (!activeTabRunning()) return;
  const hintsEl = panelEl('#ocp-slash-hints');
  if (hintsEl && hintsEl.classList.contains('open')) return; // let input handler dismiss hints first
  event.preventDefault();
  event.stopImmediatePropagation();
  abortMessage();
}

// ── CLI installation status (banner + send-block) ──
let _cliInstallFailureForced = false;
let _cliFailureReason = null;

function ensureCliBannerEl() {
  if (!_panel) return null;
  const container = _panel.querySelector('.ocp-messages-container');
  if (!container || !container.parentNode) return null;
  let banner = container.parentNode.querySelector(':scope > .ocp-cli-banner');
  if (banner) { renderCliBannerContent(banner); return banner; }
  const url = getCliDocUrl('opencode');
  banner = document.createElement('div');
  banner.className = 'ocp-cli-banner';
  banner.innerHTML = `
    <div class="ocp-cli-banner-icon">!</div>
    <div class="ocp-cli-banner-text">
      <div class="ocp-cli-banner-title"></div>
      <div class="ocp-cli-banner-body"></div>
    </div>
    <div class="ocp-cli-banner-actions">
      <a class="ocp-cli-banner-link" href="${url}" target="_blank" rel="noopener noreferrer">Install guide</a>
      <button class="ocp-cli-banner-recheck" type="button">Re-check</button>
    </div>
  `;
  container.parentNode.insertBefore(banner, container);
  const btn = banner.querySelector('.ocp-cli-banner-recheck');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try { await recheckCliStatus('opencode'); }
    finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = 'Re-check';
      }
    }
  });
  renderCliBannerContent(banner);
  return banner;
}

// Distinguish "never installed" from "installed but would not launch" —
// telling the user to install something already present sends them chasing a
// reinstall they do not need.
function renderCliBannerContent(banner) {
  const titleEl = banner.querySelector('.ocp-cli-banner-title');
  const bodyEl = banner.querySelector('.ocp-cli-banner-body');
  if (!titleEl || !bodyEl) return;
  const label = getCliLabel('opencode');
  bodyEl.replaceChildren();

  if (_cliInstalled === null) {
    titleEl.textContent = `${label} CLI not installed`;
    bodyEl.append('Run ');
    const code = document.createElement('code');
    code.textContent = getCliInstallCommand('opencode');
    bodyEl.append(code, ' or follow the install guide.');
    return;
  }

  titleEl.textContent = `${label} CLI failed to start`;
  bodyEl.append(`${label} v${_cliInstalled} is installed, but it could not be launched. `);
  if (_cliFailureReason) {
    const code = document.createElement('code');
    code.textContent = _cliFailureReason;
    bodyEl.append(code);
  } else {
    bodyEl.append('Check the CLI path in Settings, then re-check.');
  }
}

function removeCliBannerEl() {
  if (!_panel) return;
  const container = _panel.querySelector('.ocp-messages-container');
  const banner = container?.parentNode?.querySelector(':scope > .ocp-cli-banner');
  banner?.remove();
}

function refreshCliBanner() {
  if (!_panel) return;
  const missing = _cliInstalled === null || _cliInstallFailureForced;
  _panel.classList.toggle('ocp-cli-blocked', missing);
  if (missing) ensureCliBannerEl();
  else removeCliBannerEl();
  syncSendButton();
}

export function flagOcpCliInstallFailure(reason = null) {
  _cliInstallFailureForced = true;
  _cliFailureReason = reason ? String(reason).slice(0, 300) : null;
  refreshCliBanner();
  // Clear from the RETURNED value, not the subscriber callback: the callback
  // only fires when the version string changes, and a launch failure does not
  // change it, so the banner would otherwise latch permanently.
  recheckCliStatus('opencode')
    .then((info) => {
      if (!info?.installed) return;
      _cliInstallFailureForced = false;
      _cliFailureReason = null;
      refreshCliBanner();
    })
    .catch(() => {});
}

function ensureCliSubscription() {
  if (_cliUnsub) return;
  _cliUnsub = subscribeCliStatus('opencode', (info) => {
    _cliInstalled = info?.installed || null;
    if (_cliInstalled) { _cliInstallFailureForced = false; _cliFailureReason = null; }
    refreshCliBanner();
  });
}

function setVisible(nextVisible) {
  if (!_panel) return;
  if (!nextVisible) {
    const tab = activeTab();
    const input = panelEl('#ocp-input');
    if (tab && input) tab.draft = input.value;
  }
  _visible = !!nextVisible;
  setPanelVisible(_visible);
  _panel.classList.toggle('open', _visible);
  syncReservedWidth();
  emit('opencode-panel:visibility', _visible);
  if (_visible) {
    document.addEventListener('keydown', _ocpDocEscHandler, { capture: true });
    // Mutual exclusion — close other panels before showing
    if (isClaudePanelOpen()) toggleClaudePanel();
    if (isCodexPanelOpen()) toggleCodexPanel();
    if (!getTabs().length) createTab({ project: storage.getItem(STOR.project) || '' });
    state.lastActivePanel = 'opencode';
    onUpdate();
    panelEl('#ocp-input')?.focus();
    const _curProject = activeTab()?.project || '';
    if (_curProject && _curProject !== _lastBranchProject) loadBranches(_curProject);
    loadCurrentProfile();
    loadRecallProfile();
    refreshCliBanner();
  } else {
    document.removeEventListener('keydown', _ocpDocEscHandler, { capture: true });
  }
  renderPills();
  window.dispatchEvent(new Event('resize'));
}

// ── WebSocket callbacks ──

function wsCallbacks() {
  return {
    onConnect() {
      setStatus('connecting', 'Connecting to OpenCode…');
    },
    onInit(msg) {
      _serverReady = !!msg.ready;
      _serverVersion = msg.version || null;
      _serverManaged = !!msg.managed;
      if (_serverReady) {
        setStatus('ready', readyStatusText());
        loadProviders();
        loadAgents();
        loadSessions();
        // Re-render active tab messages now that WS is connected (fixes
        // reload/reconnect race where restoreTabs fires before WS is up)
        const tab = activeTab();
        if (tab?.sessionId) renderTabMessages();
      } else {
        setStatus('offline', 'Server offline');
      }
      syncSendButton();
    },
    onServerStatus(msg) {
      _serverReady = msg.status === 'ready';
      _serverVersion = msg.version || _serverVersion;
      _serverManaged = msg.managed ?? _serverManaged;
      if (_serverReady) {
        setStatus('ready', readyStatusText());
        loadProviders();
        loadAgents();
      } else {
        setStatus('offline', 'Server offline');
      }
      syncSendButton();
    },
    onEvent(eventType, event) {
      handleSSEEvent(eventType, event);
    },
    onDisconnect(wasConnected) {
      _serverReady = false;
      setStatus('offline', 'Disconnected');
      syncSendButton();
    },
    onError(msg) {
      console.error('[ocp] Error:', msg.message);
      if (typeof msg.message === 'string' && /opencode.*(not.*found|ENOENT|spawn)|opencode CLI/i.test(msg.message)) {
        flagOcpCliInstallFailure(msg.message);
      }
    },
  };
}

// ── Init ──

async function ensureProjectsLoaded() {
  if (_projectsLoaded) return;
  try {
    const res = await fetchProjects();
    _projects = Array.isArray(res) ? res : (res?.projects || []);
    _projectsLoaded = true;
  } catch {}
}

function ensurePanel() {
  if (_panel) return;
  injectStyles();
  _panel = buildPanel();
  document.body.appendChild(_panel);
  import('./ocp-render.js').then(({ loadHighlightJs }) => loadHighlightJs());

  setPanelEl(_panel);
  setOnUpdate(onUpdate);
  setOnShow(() => setVisible(true));
  setOnHide(() => setVisible(false));
  on('mcp:profile-changed', (msg = {}) => {
    applyMcpProfileState(msg.profile, msg.presets);
  });

  // Wire "Edit plan" button — materializes plan content as a file and opens it.
  // Mirrors the robust handler in ui-claude-panel.js: tries the cached file path
  // first, falls back to capturing assistant text from the DOM (with one rAF
  // retry for late-stream races), then a /api/latest-plan disk lookup. Any
  // failure surfaces a visible error and re-enables the card so the user can
  // retry instead of clicking into a silent void.
  setOnEditPlan(async (tab, card) => {
    const messagesEl = _panel?.querySelector('#ocp-messages');
    const setBusy = (busy) => {
      if (!card) return;
      card.style.opacity = busy ? '0.45' : '1';
      card.style.pointerEvents = busy ? 'none' : 'auto';
    };
    const openPlan = (path) => {
      emit('open-plan-editor', { filePath: path, tabId: tab.id, source: 'opencode' });
    };
    // Diagnostic snapshot: dump exactly what the panel sees at click time so
    // we can pinpoint where the plan content is hiding when extraction fails.
    const diagnosticSnapshot = async () => {
      const diag = {
        sessionId: tab.sessionId || '(none)',
        mode: tab.mode || '(none)',
        agent: tab.agent || '(none)',
        planContentLen: (tab.planContent || '').length,
        planFilePath: tab.planFilePath || '(none)',
        assistantBubbles: messagesEl ? messagesEl.querySelectorAll('.ocp-msg-assistant').length : 0,
        thinkBlocks: messagesEl ? messagesEl.querySelectorAll('.ocp-think-block').length : 0,
        toolCards: [],
        messagesApi: '(not fetched)',
      };
      if (messagesEl) {
        messagesEl.querySelectorAll('.ocp-tool-card').forEach((c) => {
          const name = (c.querySelector('.ocp-tool-name')?.textContent || '').trim();
          const argsLen = (c.querySelector('.ocp-tool-args')?.textContent || '').trim().length;
          const resultLen = (c.querySelector('.ocp-tool-result')?.textContent || '').trim().length;
          diag.toolCards.push({ name, argsLen, resultLen });
        });
      }
      try {
        if (tab.sessionId) {
          const resp = await requestWs('messages:list', { sessionId: tab.sessionId }, 8000);
          const raw = resp?.data?.messages || resp?.data || [];
          const messages = Array.isArray(raw) ? raw : [];
          let lastAssistantParts = '(no assistant message)';
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i] || {};
            if ((m.info?.role || m.role) !== 'assistant') continue;
            lastAssistantParts = (m.parts || []).map(p => ({
              type: p?.type,
              tool: p?.tool || p?.name,
              textLen: String(p?.text || '').length,
              inputKeys: p?.input ? Object.keys(p.input).slice(0, 6) : [],
              stateInputKeys: p?.state?.input ? Object.keys(p.state.input).slice(0, 6) : [],
            }));
            break;
          }
          diag.messagesApi = { count: messages.length, lastAssistantParts };
        }
      } catch (err) {
        diag.messagesApi = `(error: ${err?.message || err})`;
      }
      console.warn('[ocp-panel] Edit plan diagnostic:', JSON.stringify(diag, null, 2));
      return diag;
    };

    const noFile = (reason) => {
      if (reason) console.warn('[ocp-panel] Edit plan fallback:', reason);
      // Console dump preserves full diagnostic for follow-up debugging; user
      // sees a friendly message in the toast.
      diagnosticSnapshot().then(() => {
        if (card && !card._noFileShown) {
          card._noFileShown = true;
          if (messagesEl) renderErrorMessage(messagesEl, 'Plan text was empty — ask OpenCode to re-output the plan, or click Continue with implementation to proceed. (Devtools console has the diagnostic dump.)');
        }
        setBusy(false);
      });
    };
    const materialize = (planText) => {
      // server.js:12011 rejects content with no H1 whose first line starts
      // with a thinking marker (Thought, I'll, Let me, ›, …). Captured
      // reasoning streams almost always start that way. Prepend `# Plan` if
      // there's no existing H1 so the server accepts the content.
      let content = String(planText || '').trim();
      if (!/^#\s+.+$/m.test(content)) {
        content = `# Plan\n\n${content}`;
      }
      fetch('/api/create-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, cwd: tab.project || '' }),
      }).then(r => r.json()).then(result => {
        if (result?.ok && result.path) {
          tab.planFilePath = result.path;
          saveTabs();
          openPlan(result.path);
        } else {
          noFile(result?.error || 'create-plan returned non-ok');
        }
      }).catch(err => noFile(err?.message || 'create-plan request failed'));
    };
    const diskFallback = () => {
      fetch('/api/latest-plan').then(r => r.ok ? r.json() : null).then(result => {
        const p = result?.path;
        const mtime = result?.mtime ? new Date(result.mtime).getTime() : 0;
        const startedAt = tab._planModeStartedAt || 0;
        if (p && mtime && (!startedAt || mtime >= startedAt)) {
          tab.planFilePath = p;
          saveTabs();
          openPlan(p);
        } else {
          noFile('latest-plan not fresh (mtime < plan-mode start)');
        }
      }).catch(err => noFile(err?.message || 'latest-plan request failed'));
    };

    // Authoritative fallback: ask the OpenCode server for this session's
    // message parts directly via the existing `messages:list` WS proxy
    // (server.js:5285 → GET /session/{id}/message). Walk the most recent
    // assistant message, concatenate text parts (then reasoning parts as
    // backup). Bypasses DOM scraping entirely — works regardless of how the
    // model surfaced its output (text bubble, Thought block, subagent result).
    const fetchPlanFromMessagesAPI = async () => {
      if (!tab.sessionId) return '';
      try {
        const resp = await requestWs('messages:list', { sessionId: tab.sessionId }, 15000);
        const raw = resp?.data?.messages || resp?.data || [];
        const messages = Array.isArray(raw) ? raw : [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i] || {};
          const role = m.info?.role || m.role || '';
          if (role !== 'assistant') continue;
          const parts = Array.isArray(m.parts) ? m.parts : [];
          const textParts = parts
            .filter(p => String(p?.type || '').toLowerCase() === 'text')
            .map(p => String(p?.text || '').trim())
            .filter(Boolean)
            .join('\n\n')
            .trim();
          if (textParts.length > 40) return textParts;
          // Tasks tool input — todos array is the plan when emitted as todowrite.
          for (const p of parts.slice().reverse()) {
            const ptype = String(p?.type || '').toLowerCase();
            if (!ptype.includes('tool')) continue;
            const tname = String(p?.tool || p?.name || '').toLowerCase();
            if (!/^tasks?$|todo[_-]?write/i.test(tname)) continue;
            const todoInput = p?.state?.input || p?.input || p?.args || p?.arguments || {};
            const todos = Array.isArray(todoInput?.todos) ? todoInput.todos : [];
            if (!todos.length) continue;
            const lines = ['# Plan', ''];
            todos.forEach((t, idx) => {
              const text = String(t?.content || t?.activeForm || t?.text || t?.title || '').trim();
              if (!text) return;
              const status = String(t?.status || '').toLowerCase();
              const mark = status === 'completed' || status === 'done' ? 'x' : ' ';
              lines.push(`${idx + 1}. [${mark}] ${text}`);
            });
            const planMd = lines.join('\n').trim();
            if (planMd.length > 40) return planMd;
          }
          const reasoningParts = parts
            .filter(p => /reason|think/i.test(String(p?.type || '')))
            .map(p => String(p?.text || p?.reasoning || p?.content || '').trim())
            .filter(Boolean)
            .join('\n\n')
            .trim();
          if (reasoningParts.length > 40) return reasoningParts;
        }
      } catch (err) {
        console.warn('[ocp-panel] messages:list fallback failed:', err?.message || err);
      }
      return '';
    };

    setBusy(true);
    (async () => {
      try {
        if (tab.planFilePath) { openPlan(tab.planFilePath); return; }
        // Authoritative source first: OpenCode's session/{id}/message API has
        // the COMPLETE assistant parts (full reasoning text). Live-capture in
        // ocp-tabs.js often only stores the initial Thought preamble before
        // the reply stream resolves, so the local cache can be drastically
        // shorter than the API. Prefer the longer of the two sources.
        const fromApi = await fetchPlanFromMessagesAPI();
        const fromDom = extractPlanTextLoose(tab);
        const apiLen = (fromApi || '').length;
        const domLen = (fromDom || '').length;
        const best = apiLen >= domLen ? fromApi : fromDom;
        if (best) { materialize(best); return; }
        // Late-stream DOM race: retry once on the next frame.
        requestAnimationFrame(async () => {
          const retry = extractPlanTextLoose(tab);
          if (retry) { materialize(retry); return; }
          const retryApi = await fetchPlanFromMessagesAPI();
          if (retryApi) { tab.planContent = retryApi; materialize(retryApi); }
          else diskFallback();
        });
      } catch (e) {
        noFile(e?.message || 'Edit plan exception');
      }
    })();
  });

  // Listen for edited plan content from file explorer
  on('plan-saved', ({ filePath, content, source, tabId }) => {
    if (source !== 'opencode') return;
    const tab = getTabs().find(t => t.id === tabId) || activeTab();
    if (tab && content) {
      applySavedPlan(tab, content, filePath);
    }
  });

  on('plan-edit-cancelled', ({ source, tabId } = {}) => {
    if (source !== 'opencode') return;
    const tab = getTabs().find(t => t.id === tabId) || activeTab();
    if (!tab) return;
    tab.showPostPlanActions = true;
    showPostPlanUI(tab, tab.postPlanHeader || 'PLAN COMPLETE');
  });

  wireEvents();
  autosizeInput();

  // Restore or create initial tab
  if (!restoreTabs()) {
    createTab({ project: storage.getItem(STOR.project) || '' });
  }
  window.dispatchEvent(new CustomEvent('sidepanel-tray:provider-loaded', { detail: { provider: 'opencode' } }));

  syncSendButton();
  ensureCliSubscription();

  // Connect WebSocket
  connectWs(wsCallbacks());

  // Live refresh when provider auth changes in Settings
  document.addEventListener('ocp-providers-changed', () => {
    if (_serverReady) {
      Promise.all([loadProviders(), loadAgents()]).then(() => {
        const dd = _panel?.querySelector('#ocp-model-dd');
        if (dd) populateModelDropdown(dd);
      });
    }
  });

  // Re-render model dropdown when visibility toggles change in Settings
  document.addEventListener('ocp-hidden-models-changed', () => {
    const dd = _panel?.querySelector('#ocp-model-dd');
    if (dd) populateModelDropdown(dd);
  });

  // Close OpenCode when Claude/Codex pill clicked (mutual exclusion)
  const tray = document.getElementById('term-minimized-tray');
  if (tray) {
    tray.addEventListener('click', (e) => {
      if (!_visible) return;
      const pill = e.target.closest('.cp-session-pill') || e.target.closest('.cxp-session-pill');
      if (pill && !e.target.closest('.term-minimized-pill-close')) setVisible(false);
    }, true);
  }

  // Mutual exclusion with Claude and Codex panels
  on('claude-panel:show', () => { if (_visible) setVisible(false); });
  on('codex-panel:visibility', (visible) => { if (visible && _visible) setVisible(false); });
  on('opencode-panel:show', (data) => {
    if (!_visible) setVisible(true);
    if (data?.tabId) {
      const idx = getTabs().findIndex((entry) => entry.id === data.tabId);
      if (idx >= 0) switchTab(idx);
    }
  });
}

// ── Public API ──

export function isOpencodePanelOpen() {
  return _visible;
}

export async function toggleOpencodePanel() {
  ensurePanel();
  await ensureProjectsLoaded();
  if (_visible) {
    setVisible(false);
    return;
  }
  setVisible(true);
}

export async function openOpencodeWithPrompt(text, opts = {}) {
  ensurePanel();
  await ensureProjectsLoaded();
  if (!_visible) setVisible(true);
  const tab = activeTab() || createTab(opts);
  if (tab && text) {
    const input = panelEl('#ocp-input');
    if (input) {
      input.value = text;
      autosizeInput();
      syncSendButton();
      if (opts.autoSend) handleSend();
    }
  }
}

/** Append a file path to the OpenCode input as a text reference. Used by the
 *  file explorer's "Send to AI" when OpenCode is the active panel. */
export async function attachPathToOpencode(filePath) {
  if (!filePath) return;
  ensurePanel();
  await ensureProjectsLoaded();
  if (!_visible) setVisible(true);
  if (!activeTab()) createTab();
  const input = panelEl('#ocp-input');
  if (!input) return;
  const existing = input.value || '';
  const sep = existing && !existing.endsWith('\n') && !existing.endsWith(' ') ? ' ' : '';
  input.value = existing + sep + filePath;
  autosizeInput();
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  syncSendButton();
}

// ═══════════════════════════════════════════
// SynaBun — OpenCode Panel: Main Entry
// buildPanel DOM, wireEvents, resize, visibility, exports
// Imports ui-claude-panel.js + ui-codex-panel.js for mutual exclusion
// ═══════════════════════════════════════════

import { state, emit, on } from '../state.js';
import { storage } from '../storage.js';
import { fetchProjects } from '../api.js';
import { reserveRightPanelLayout, clearRightPanelLayout } from '../ui-sidepanel-layout.js';
import { subscribeCliStatus, recheckCliStatus, getCliDocUrl, getCliInstallCommand, getCliLabel } from '../cli-status.js';

import { injectStyles } from './ocp-styles.js';
import {
  ICON_PLUS, ICON_X, ICON_MINIMIZE, ICON_EDIT, ICON_SEND, ICON_STOP,
  ICON_REVERT, ICON_COMPACT, ICON_SLIDE, ICON_SETTINGS,
} from './ocp-icons.js';
import { connectWs, disconnectWs, isConnected, onWsMessage, sendWs } from './ocp-ws.js';
import { renderEmptyState, esc, renderToolActivityDock, tickActivityDockElapsed, focusActivityToolCard } from './ocp-render.js';
import {
  STOR, getTabs, getActiveTabIdx, activeTab, getProviders, getSessions,
  setPanelEl, setOnUpdate, setPanelVisible, setOnShow, setOnHide, setOnEditPlan,
  createTab, switchTab, closeTab, renderPills, saveTabs, restoreTabs,
  loadSessions, createSession, renameSession, loadProviders, loadAgents, populateModelDropdown,
  sendMessage, abortMessage, handleSSEEvent,
  revertSession, compactSession, shareSession, executeCommand, renderTabMessages,
  getActiveTabMode, setTabMode, resolveContextInputTokens, setActivityVisible,
  toggleActivityExpanded, abortAgent, ensurePlanFile, showPostPlanUI, applySavedPlan,
  flushAllSessionSnapshots,
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
  const tab = activeTab();
  return !!(tab?.sessionId && !tab.running && _serverReady);
}

function beginRenameSession() {
  const tab = activeTab();
  const label = panelEl('#ocp-session-label');
  if (!tab?.sessionId || !label || tab.running || !_serverReady) return;

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
      await renameSession(tab.sessionId, nextTitle);
      if (panelEl('#ocp-session-menu')?.classList.contains('open')) await renderSessionMenu();
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
      tab.project = chosenProject;
      storage.setItem(STOR.project, chosenProject);
      saveTabs();
      const projectDd = panelEl('#ocp-project-dd');
      if (projectDd) {
        const lbl = projectDd.querySelector('.ocp-dd-label');
        if (lbl) lbl.textContent = chosenProject.split('/').pop() || chosenProject;
      }
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
        <div class="ocp-slash-hints" id="ocp-slash-hints" hidden></div>
        <input type="file" id="ocp-file-input" accept="image/*" multiple hidden>
      </div>
      <div class="ocp-footer-toolbar">
        <div class="ocp-footer-left">
          <a class="ocp-brand-link" href="https://opencode.ai" target="_blank" rel="noopener noreferrer" data-tooltip="OpenCode">
            <svg class="ocp-brand" viewBox="0 0 240 300" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M0 0h240v300H0V0zm30 30v240h180V30H30z"/><rect x="30" y="150" width="180" height="120" opacity=".45"/></svg>
          </a>
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
      const onMove = (ev) => {
        const diff = startX - ev.clientX;
        const w = Math.max(320, Math.min(700, startW + diff));
        _panel.style.width = w + 'px';
        syncReservedWidth();
      };
      const onUp = () => {
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
  panelEl('#ocp-action-changelog')?.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab || tab.running || !_serverReady) return;
    const inp = panelEl('#ocp-input');
    if (!inp) return;
    inp.value = '/synabun changelog';
    autosizeInput();
    handleSend();
  });
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
      // Show slash hints when user types /
      const val = input.value;
      const slashMatch = val.match(/^\/(\w*)$/);
      if (slashMatch) {
        showSlashHints(slashMatch[1]);
      } else {
        hideSlashHints();
      }
    });
    input.addEventListener('keydown', (e) => {
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
        hideSlashHints();
        if (activeTabRunning()) {
          e.preventDefault();
          e.stopPropagation();
          abortMessage();
        }
      }
      // Navigate slash hints with arrow keys
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const hints = panelEl('#ocp-slash-hints');
        if (hints?.classList.contains('open')) {
          e.preventDefault();
          navigateSlashHints(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
      }
      // Apply selected slash hint with Enter
      if (e.key === 'Enter' && !e.shiftKey) {
        const hints = panelEl('#ocp-slash-hints');
        if (hints?.classList.contains('open')) {
          if (applySlashHint()) {
            e.preventDefault();
            return;
          }
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
  { name: 'new', description: 'Start a new session' },
  { name: 'undo', description: 'Undo last message' },
  { name: 'redo', description: 'Redo undone message' },
  { name: 'compact', description: 'Compact context' },
  { name: 'summarize', description: 'Compact context' },
  { name: 'sessions', description: 'List all sessions' },
  { name: 'resume', description: 'Resume a session' },
  { name: 'continue', description: 'Continue session' },
  { name: 'share', description: 'Share current session' },
  { name: 'unshare', description: 'Unshare current session' },
  { name: 'clear', description: 'Clear all messages' },
  { name: 'help', description: 'Show help' },
  { name: 'exit', description: 'Exit OpenCode' },
  { name: 'quit', description: 'Exit OpenCode' },
];

const BUILTIN_NAMES = new Set(BUILTIN_SLASH_COMMANDS.map(c => c.name));
let SLASH_COMMANDS = [...BUILTIN_SLASH_COMMANDS];
let _skillNames = new Set();
let _skillsLoaded = false;

async function loadSkillSlashCommands() {
  if (_skillsLoaded) return;
  _skillsLoaded = true;
  try {
    const res = await fetch('/api/skills');
    const data = await res.json();
    const skills = Array.isArray(data.skills) ? data.skills : [];
    const merged = [...BUILTIN_SLASH_COMMANDS];
    for (const s of skills) {
      const name = String(s.name || s.dirName || '').trim();
      if (!name || BUILTIN_NAMES.has(name)) continue;
      merged.push({ name, description: String(s.description || '').trim(), isSkill: true });
      _skillNames.add(name);
    }
    SLASH_COMMANDS = merged;
  } catch {
    // Fallback: keep builtins only
  }
}

// Kick off load at module init; hint UI will re-render on demand.
loadSkillSlashCommands();

let _slashHintIdx = -1;
let _slashFilter = '';

function parseSlashCommand(text) {
  const match = text.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2] || '' };
}

function showSlashHints(filter) {
  const hints = panelEl('#ocp-slash-hints');
  if (!hints) return;
  _slashFilter = filter;
  const q = filter.toLowerCase();
  const matches = SLASH_COMMANDS.filter(c => c.name.startsWith(q));
  if (!matches.length || !filter) { hideSlashHints(); return; }
  hints.innerHTML = '';
  matches.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'ocp-slash-item' + (i === 0 ? ' active' : '');
    el.innerHTML = `<div class="ocp-slash-name">/${esc(c.name)}</div><div class="ocp-slash-desc">${esc(c.description)}</div>`;
    el.addEventListener('click', () => {
      const input = panelEl('#ocp-input');
      if (input) { input.value = '/' + c.name + ' '; input.focus(); }
      hideSlashHints();
    });
    hints.appendChild(el);
  });
  _slashHintIdx = 0;
  hints.classList.add('open');
}

function hideSlashHints() {
  const hints = panelEl('#ocp-slash-hints');
  if (hints) { hints.classList.remove('open'); hints.innerHTML = ''; }
  _slashHintIdx = -1;
}

function navigateSlashHints(dir) {
  const hints = panelEl('#ocp-slash-hints');
  if (!hints) return;
  const items = hints.querySelectorAll('.ocp-slash-item');
  if (!items.length) return;
  items[_slashHintIdx]?.classList.remove('active');
  _slashHintIdx = Math.max(0, Math.min(items.length - 1, _slashHintIdx + dir));
  items[_slashHintIdx]?.classList.add('active');
}

function applySlashHint() {
  const hints = panelEl('#ocp-slash-hints');
  const items = hints?.querySelectorAll('.ocp-slash-item');
  if (!items || _slashHintIdx < 0) return false;
  const active = items[_slashHintIdx];
  if (!active) return false;
  const name = active.querySelector('.ocp-slash-name')?.textContent?.replace('/', '');
  if (!name) return false;
  const input = panelEl('#ocp-input');
  if (input) { input.value = '/' + name + ' '; input.focus(); }
  hideSlashHints();
  return true;
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
// every 500ms while any running entry exists. Cheap per-row DOM writes only.
let _activityTickerHandle = null;
function ensureActivityTicker() {
  if (_activityTickerHandle) return;
  const tab = activeTab();
  const entries = Array.isArray(tab?.toolActivity) ? tab.toolActivity : [];
  const anyRunning = entries.some(e => e?.status === 'running');
  if (!anyRunning) return;
  _activityTickerHandle = setInterval(() => {
    if (!_panel) { stopActivityTicker(); return; }
    const t = activeTab();
    const still = tickActivityDockElapsed(t, _panel);
    if (!still) stopActivityTicker();
  }, 500);
}
function stopActivityTicker() {
  if (_activityTickerHandle) {
    clearInterval(_activityTickerHandle);
    _activityTickerHandle = null;
  }
}

// ── Session menu ──

async function renderSessionMenu() {
  const menu = panelEl('#ocp-session-menu');
  if (!menu) return;

  menu.innerHTML = '<div class="ocp-session-item" style="opacity:0.4">Loading…</div>';
  await loadSessions();

  const sessions = getSessions();
  const tab = activeTab();
  const sessionsWithMessages = sessions.filter((session) => Number(session?.messageCount || 0) > 0);
  const visibleSessions = sessionsWithMessages.length ? sessionsWithMessages : sessions;
  menu.innerHTML = '';

  // New session option
  const newItem = document.createElement('div');
  newItem.className = 'ocp-session-item';
  newItem.innerHTML = `<span style="opacity:0.5">+ New session</span>`;
  newItem.addEventListener('click', async () => {
    menu.classList.remove('open');
    createTab();
  });
  menu.appendChild(newItem);

  if (!visibleSessions.length) return;

  const sep = document.createElement('div');
  sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin:4px 8px';
  menu.appendChild(sep);

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
    menu.appendChild(item);
  }
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
      if (tab) {
        tab.project = path;
        storage.setItem(STOR.project, path);
        saveTabs();
      }
      menu.classList.remove('open');
      const lbl = dd.querySelector('.ocp-dd-label');
      if (lbl) lbl.textContent = label || path;
      menu.querySelectorAll('.ocp-dd-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      loadBranches(path);
    });
    menu.appendChild(opt);
  }
}

// ── Branch loader ──

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

async function loadCurrentProfile() {
  try {
    const resp = await fetch('/api/mcp/profile');
    const data = await resp.json();
    if (data.ok && data.profile) _currentProfile = data.profile;
    if (data.presets) {
      _mcpProfiles = Object.entries(data.presets).map(([id, p]) => ({
        id, label: p.label || id, hint: `${p.tools} tools`,
      }));
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
  try {
    // Write to active-profile.json via API — MCP server picks up change via file watcher
    await fetch('/api/mcp/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    // Also update OpenCode config.json so profile persists across server restarts
    const statusResp = await fetch('/api/setup/status');
    const statusData = await statusResp.json();
    const mcpPath = statusData.paths?.mcpIndexPath;
    const envPath = statusData.paths?.envPath;
    if (mcpPath) {
      const env = { SYNABUN_PROFILE: profile };
      if (envPath) env.DOTENV_PATH = envPath;
      const config = { type: 'stdio', command: 'node', args: [mcpPath], env };
      await fetch('/api/opencode/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SynaBun', config }),
      });
    }
  } catch {}
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

function syncReservedWidth() {
  if (_visible && _panel) {
    reserveRightPanelLayout(PANEL_OWNER, _panel, 20);
    document.querySelector('.fe-editor-panel')?.classList.add('panel-adjacent');
  } else if (clearRightPanelLayout(PANEL_OWNER)) {
    document.querySelector('.fe-editor-panel')?.classList.remove('panel-adjacent');
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

function ensureCliBannerEl() {
  if (!_panel) return null;
  const container = _panel.querySelector('.ocp-messages-container');
  if (!container) return null;
  let banner = container.querySelector(':scope > .ocp-cli-banner');
  if (banner) return banner;
  const label = getCliLabel('opencode');
  const cmd = getCliInstallCommand('opencode');
  const url = getCliDocUrl('opencode');
  banner = document.createElement('div');
  banner.className = 'ocp-cli-banner';
  banner.innerHTML = `
    <div class="ocp-cli-banner-icon">!</div>
    <div class="ocp-cli-banner-text">
      <div class="ocp-cli-banner-title">${label} CLI not installed</div>
      <div class="ocp-cli-banner-body">Run <code>${cmd}</code> or follow the install guide.</div>
    </div>
    <div class="ocp-cli-banner-actions">
      <a class="ocp-cli-banner-link" href="${url}" target="_blank" rel="noopener noreferrer">Install guide</a>
      <button class="ocp-cli-banner-recheck" type="button">Re-check</button>
    </div>
  `;
  container.insertBefore(banner, container.firstChild);
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
  return banner;
}

function removeCliBannerEl() {
  if (!_panel) return;
  const banner = _panel.querySelector('.ocp-messages-container > .ocp-cli-banner');
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

export function flagOcpCliInstallFailure() {
  _cliInstallFailureForced = true;
  refreshCliBanner();
  recheckCliStatus('opencode').catch(() => {});
}

function ensureCliSubscription() {
  if (_cliUnsub) return;
  _cliUnsub = subscribeCliStatus('opencode', (info) => {
    _cliInstalled = info?.installed || null;
    if (_cliInstalled) _cliInstallFailureForced = false;
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
    if (_curProject) loadBranches(_curProject);
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
        flagOcpCliInstallFailure();
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

  // Wire "Edit plan" button — materializes plan content as a file and opens it
  setOnEditPlan(async (tab) => {
    const openPlan = (path) => emit('open-plan-editor', { filePath: path, tabId: tab.id, source: 'opencode' });
    if (tab.planFilePath) { openPlan(tab.planFilePath); return; }
    if (!tab.planContent) return;
    try {
      const planPath = await ensurePlanFile(tab);
      if (planPath) openPlan(planPath);
    } catch (e) {
      console.error('[ocp-panel] Edit plan failed:', e);
      showPostPlanUI(tab);
    }
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

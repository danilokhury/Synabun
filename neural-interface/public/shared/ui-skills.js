// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio
// Browse, edit, create, import/export Claude Code
// skills, commands, and agents.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { storage } from './storage.js';
import {
  fetchSkillsLibrary, fetchSkillsArtifact, saveSkillsArtifact,
  fetchSkillsSubFile, saveSkillsSubFile, createSkillsSubFile, deleteSkillsSubFile,
  createSkillsArtifact, deleteSkillsArtifact, validateSkillsArtifact,
  installSkillsBundled, uninstallSkillsBundled,
  importSkillsBundle, getSkillsExportUrl,
  getSkillsIconUrl, uploadSkillsIcon, deleteSkillsIcon,
} from './api.js';

const $ = (id) => document.getElementById(id);

// ── Module-local state ──
let _panel = null;
let _backdrop = null;
let _library = [];
let _projects = [];
let _selected = null;      // currently selected artifact
let _selectedContent = null; // loaded content of selected artifact
let _filterType = 'all';
let _filterScope = 'all';
let _searchQuery = '';
let _fetchSeq = 0;         // fetch sequence counter — guards against race conditions
let _view = 'library';     // 'library' | 'editor' | 'wizard'
let _editorDirty = false;
let _wizardStep = 0;
let _wizardData = {};
let _previewMode = false;   // false = raw editor, true = rendered preview
let _wizPreviewMode = false; // wizard step 4 preview mode
let _focusMode = false;     // darkens backdrop fully

// ── Tab system ──
// Each tab: { id, artifactId, artifact, artifactContent, label, path, content, originalContent, dirty }
// Tabs persist across artifact selections — clicking a new skill adds a tab
let _tabs = [];
let _activeTabIdx = 0;

// ── Constants ──
const PANEL_KEY = 'neural-panel-skills-studio';
const TYPE_ICONS = {
  skill: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v2M8 12v2M2 8h2M12 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M11.8 4.2l-1.4 1.4M5.6 10.4l-1.4 1.4"/><circle cx="8" cy="8" r="2.5"/></svg>`,
  command: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 11 7 8 3 5"/><line x1="9" y1="12" x2="13" y2="12"/></svg>`,
  agent: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="10" height="8" rx="2"/><line x1="6" y1="6" x2="6" y2="6.01"/><line x1="10" y1="6" x2="10" y2="6.01"/><path d="M6 14v-3M10 14v-3"/><path d="M1 7h2M13 7h2"/></svg>`,
};
const TYPE_LABELS = { skill: 'Skill', command: 'Command', agent: 'Agent' };
const SCOPE_LABELS = { global: 'Global', project: 'Project', bundled: 'Bundled' };

// ── Tab helpers ──
function activeTab() {
  return _tabs[_activeTabIdx] || _tabs[0] || {
    id: '__empty__', artifactId: null, artifact: null, artifactContent: null,
    label: '', path: null, content: '', originalContent: '', dirty: false
  };
}

/** Find the main (path===null) tab for the given artifact */
function findMainTab(artifactId) { return _tabs.find(t => t.artifactId === artifactId && t.path === null); }

function renderTabBar() {
  const bar = $('ss-tab-bar');
  if (!bar) return;
  bar.innerHTML = _tabs.map((tab, i) => {
    const active = i === _activeTabIdx ? ' active' : '';
    const dirty = tab.dirty ? ' dirty' : '';
    const isMain = tab.path === null;
    const typeClass = isMain ? ` type-${tab.artifact?.type || 'skill'}` : ' subfile';
    const iconSvg = isMain ? `<span class="ss-tab-type-dot ${tab.artifact?.type || 'skill'}"></span>` : '';
    const icon = '';
    const dot = tab.dirty ? '<span class="ss-tab-dot"></span>' : '';
    const close = `<button class="ss-tab-close" data-idx="${i}">\u00d7</button>`;
    return `<div class="ss-tab${active}${dirty}${typeClass}" data-idx="${i}">${dot}${iconSvg}<span class="ss-tab-label">${esc(tab.label)}</span>${close}</div>`;
  }).join('');

  // Wire tab clicks
  bar.querySelectorAll('.ss-tab').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.ss-tab-close')) return;
      switchTab(parseInt(el.dataset.idx));
    });
  });

  // Wire close buttons
  bar.querySelectorAll('.ss-tab-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(parseInt(btn.dataset.idx));
    });
  });
}

function switchTab(idx) {
  if (idx === _activeTabIdx || idx < 0 || idx >= _tabs.length) return;
  storeActiveTabContent();
  captureMetadataIntoContent();

  const prevTab = activeTab();
  _activeTabIdx = idx;
  const newTab = activeTab();
  _previewMode = false;

  // Update artifact context
  _selected = newTab.artifact;
  _selectedContent = newTab.artifactContent;

  // If different artifact, re-render everything (metadata panel changes)
  if (prevTab.artifactId !== newTab.artifactId) {
    renderEditor();
    renderLibrary();
  } else {
    // Same artifact — just swap content
    loadActiveTabContent();
    renderTabBar();
    updateDirtyState();
  }
}

function closeTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const tab = _tabs[idx];
  if (tab.dirty && !confirm(`Discard changes to "${tab.label}"?`)) return;
  _tabs.splice(idx, 1);

  // If no tabs left, go back to library
  if (_tabs.length === 0) {
    _activeTabIdx = 0;
    switchToLibrary();
    return;
  }

  // Adjust active index
  if (_activeTabIdx > idx) _activeTabIdx--;
  else if (_activeTabIdx >= _tabs.length) _activeTabIdx = _tabs.length - 1;

  // Update artifact context from the new active tab
  const newTab = activeTab();
  _selected = newTab.artifact;
  _selectedContent = newTab.artifactContent;

  renderEditor();
  renderLibrary();
}

function storeActiveTabContent() {
  const editor = $('ss-content-editor');
  if (!editor) return;
  const tab = _tabs[_activeTabIdx];
  if (!tab) return;
  tab.content = editor.value;
  // Only ADD dirtiness, never clear it — dirty is cleared explicitly by save/discard
  if (tab.content !== tab.originalContent) tab.dirty = true;
}

/** Merge metadata form values into tab content for the active main tab.
 *  Called before saving and before switching away from a tab. */
function captureMetadataIntoContent() {
  const tab = _tabs[_activeTabIdx];
  if (!tab || tab.path !== null) return; // only for main tabs
  const meta = collectMetadataFromForm();
  if (!meta) return;
  const editor = $('ss-content-editor');
  const raw = editor ? editor.value : tab.content;
  tab.content = mergeMetadataIntoContent(raw, meta);
  if (editor) editor.value = tab.content;
  if (tab.content !== tab.originalContent) tab.dirty = true;
}

function loadActiveTabContent() {
  const editor = $('ss-content-editor');
  const preview = $('ss-md-preview');
  if (!editor) return;
  const tab = activeTab();
  editor.value = tab.content;
  // Reset preview
  if (preview) { preview.classList.remove('visible'); preview.innerHTML = ''; }
  editor.classList.remove('ss-hidden');
  _previewMode = false;
  // Update toggle buttons
  _panel?.querySelectorAll('.ss-view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'raw'));
  // Show/hide toolbar tools
  _panel?.querySelectorAll('#ss-md-toolbar .ss-md-tool').forEach(t => t.style.visibility = '');
}

function updateDirtyState() {
  const anyDirty = _tabs.some(t => t.dirty);
  _editorDirty = anyDirty;
  const saveBtn = $('ss-save');
  const discardBtn = $('ss-discard');
  const tab = activeTab();
  if (saveBtn) { saveBtn.disabled = !tab.dirty; saveBtn.classList.toggle('dirty', tab.dirty); }
  if (discardBtn) discardBtn.disabled = !tab.dirty;
}

async function openFileInTab(path) {
  if (!_selected) return;
  // Check if already open (same artifact + path)
  const existingIdx = _tabs.findIndex(t => t.artifactId === _selected.id && t.path === path);
  if (existingIdx >= 0) { switchTab(existingIdx); return; }
  storeActiveTabContent();
  try {
    const data = await fetchSkillsSubFile(encodeId(_selected.id), path);
    const label = path.includes('/') ? path.split('/').pop() : path;
    _tabs.push({
      id: `${_selected.id}:${path}`, artifactId: _selected.id,
      artifact: _selected, artifactContent: _selectedContent,
      label, path, content: data.content, originalContent: data.content, dirty: false,
    });
    _activeTabIdx = _tabs.length - 1;
    _previewMode = false;
    loadActiveTabContent();
    renderTabBar();
  } catch (err) {
    toast('Failed to load file: ' + err.message, 'error');
  }
}

// ── Helper ──
function esc(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function encodeId(id) { return btoa(id).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `ss-toast ss-toast--${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}

// ═══════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════

export function initSkillsStudio() {
  on('skills:open', () => openPanel());
  on('skills:open-wizard', () => { openPanel(); switchToWizard(); });
  on('skills:import', () => { openPanel(); triggerImport(); });
}

// ═══════════════════════════════════════════
// PANEL LIFECYCLE
// ═══════════════════════════════════════════

async function openPanel() {
  if (_panel) { _panel.focus(); return; }

  // Backdrop
  _backdrop = document.createElement('div');
  _backdrop.className = 'ss-backdrop';
  // No close-on-backdrop-click — panel stays open until explicitly closed
  document.body.appendChild(_backdrop);

  // Panel
  _panel = document.createElement('div');
  _panel.className = 'skills-studio-panel glass resizable';
  _panel.id = 'skills-studio-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  // Restore position
  try {
    const saved = JSON.parse(storage.getItem(PANEL_KEY));
    if (saved) {
      if (saved.x != null) _panel.style.left = saved.x + 'px';
      if (saved.y != null) _panel.style.top = saved.y + 'px';
      if (saved.w) _panel.style.width = saved.w + 'px';
      if (saved.h) _panel.style.height = saved.h + 'px';
    }
  } catch {}

  // Center if no saved position
  if (!_panel.style.left) {
    const vw = window.innerWidth, vh = window.innerHeight;
    _panel.style.left = Math.max(20, (vw - 980) / 2) + 'px';
    _panel.style.top = Math.max(40, (vh - 640) / 2) + 'px';
  }

  wirePanel();
  await loadLibrary();
  renderView();

  requestAnimationFrame(() => _panel.classList.add('open'));
}

function closePanel() {
  if (!_panel) return;
  // Save position
  try {
    const rect = _panel.getBoundingClientRect();
    storage.setItem(PANEL_KEY, JSON.stringify({
      x: Math.round(rect.left), y: Math.round(rect.top),
      w: Math.round(rect.width), h: Math.round(rect.height),
    }));
  } catch {}

  _panel.remove();
  _panel = null;
  if (_backdrop) { _backdrop.remove(); _backdrop = null; }
  _selected = null;
  _selectedContent = null;
  _view = 'library';
  _editorDirty = false;
  _focusMode = false;
  _tabs = [];
  _activeTabIdx = 0;
}

function buildPanelHTML() {
  return `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>

    <div class="ss-header drag-handle" data-drag="skills-studio-panel">
      <div class="ss-header-left">
        <h3>Skills Studio</h3>
        <span class="ss-count" id="ss-total-count"></span>
      </div>
      <div class="ss-header-actions">
        <button class="ss-header-btn" id="ss-new-btn">+ New</button>
        <button class="ss-header-btn" id="ss-import-btn">Import</button>
      </div>
      <button class="ss-focus-btn" id="ss-focus" data-tooltip="Focus mode">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
      <button class="ss-close" id="ss-close">&times;</button>
    </div>

    <div class="ss-body">
      <aside class="ss-sidebar" id="ss-sidebar">
        <div class="ss-search-wrap">
          <input type="text" class="ss-search" id="ss-search" placeholder="Filter..." autocomplete="off" spellcheck="false">
        </div>
        <div class="ss-filters">
          <button class="ss-filter active" data-type="all">All</button>
          <button class="ss-filter" data-type="skill"><span class="ss-filter-dot skill"></span> Skills</button>
          <button class="ss-filter" data-type="command"><span class="ss-filter-dot command"></span> Cmds</button>
          <button class="ss-filter" data-type="agent"><span class="ss-filter-dot agent"></span> Agents</button>
        </div>
        <div class="ss-library" id="ss-library"></div>
      </aside>
      <main class="ss-main" id="ss-main"></main>
    </div>
  `;
}

function wirePanel() {
  // Close button
  $('ss-close')?.addEventListener('click', closePanel);

  // Header buttons
  $('ss-new-btn')?.addEventListener('click', () => switchToWizard());
  $('ss-import-btn')?.addEventListener('click', () => triggerImport());

  // Focus mode
  $('ss-focus')?.addEventListener('click', () => {
    _focusMode = !_focusMode;
    _backdrop?.classList.toggle('focus', _focusMode);
    $('ss-focus')?.classList.toggle('active', _focusMode);
  });

  // Search
  $('ss-search')?.addEventListener('input', (e) => {
    _searchQuery = e.target.value.toLowerCase();
    renderLibrary();
  });

  // Type filter pills
  _panel.querySelectorAll('.ss-filter[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      _filterType = btn.dataset.type;
      _panel.querySelectorAll('.ss-filter[data-type]').forEach(b => b.classList.toggle('active', b === btn));
      renderLibrary();
    });
  });

  // Escape key
  const onEsc = (e) => {
    if (e.key === 'Escape' && _panel) {
      // Close current tab if in editor
      if (_view === 'editor' && _tabs.length > 0) { closeTab(_activeTabIdx); return; }
      if (_view === 'wizard') { switchToLibrary(); return; }
      closePanel();
      document.removeEventListener('keydown', onEsc);
    }
  };
  document.addEventListener('keydown', onEsc);

  // Drag
  initDrag();
}

// ═══════════════════════════════════════════
// DRAG SUPPORT (simplified, panel-specific)
// ═══════════════════════════════════════════

function initDrag() {
  const handle = _panel.querySelector('.drag-handle');
  if (!handle) return;
  let dragging = false, startX, startY, startLeft, startTop;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = _panel.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    _panel.style.left = (startLeft + e.clientX - startX) + 'px';
    _panel.style.top = (startTop + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ═══════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════

async function loadLibrary() {
  try {
    const data = await fetchSkillsLibrary();
    _library = data.artifacts || [];
    _projects = data.projects || [];
    const countEl = $('ss-total-count');
    if (countEl) countEl.textContent = _library.length;
    renderLibrary();
  } catch (err) {
    console.error('Skills Studio: failed to load library', err);
    toast('Failed to load skills library', 'error');
  }
}

// ═══════════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════════

function renderView() {
  if (_view === 'library') renderLibraryMain();
  else if (_view === 'editor') renderEditor();
  else if (_view === 'wizard') renderWizard();
}

function switchToLibrary() {
  _view = 'library';
  _selected = null;
  _selectedContent = null;
  _editorDirty = false;
  // Tabs are already empty when this is called from closeTab
  renderLibrary();
  renderView();
}

async function switchToEditor(artifact) {
  // Check if this artifact already has a main tab open
  const existingIdx = _tabs.findIndex(t => t.artifactId === artifact.id && t.path === null);
  if (existingIdx >= 0) {
    storeActiveTabContent();
    captureMetadataIntoContent();
    _activeTabIdx = existingIdx;
    _selected = _tabs[existingIdx].artifact;
    _selectedContent = _tabs[existingIdx].artifactContent;
    _view = 'editor';
    _previewMode = false;
    renderEditor();
    renderLibrary();
    return;
  }

  // Save current tab content before switching
  if (_tabs.length > 0) {
    storeActiveTabContent();
    captureMetadataIntoContent();
  }

  // Reuse the active main tab if it's clean (not dirty, not a sub-file).
  // This prevents unbounded tab accumulation — only dirty or sub-file tabs persist.
  const curTab = activeTab();
  const reuseIdx = (curTab.path === null && !curTab.dirty && _tabs.length > 0)
    ? _activeTabIdx : -1;

  // Guard against race conditions: if user clicks quickly, only the latest wins
  const seq = ++_fetchSeq;

  _view = 'editor';
  _selected = artifact;   // optimistically set for sidebar highlight
  renderLibrary();
  const main = $('ss-main');
  if (main) main.innerHTML = '<div class="ss-loading">Loading...</div>';
  try {
    const id = encodeId(artifact.id);
    const data = await fetchSkillsArtifact(id);
    // Stale fetch — user already clicked something else
    if (seq !== _fetchSeq) return;

    _selected = artifact;
    _selectedContent = data;

    const tabObj = {
      id: `main:${artifact.id}`, artifactId: artifact.id,
      artifact: artifact, artifactContent: data,
      label: artifact.name, path: null,
      content: data.rawContent || '', originalContent: data.rawContent || '', dirty: false,
    };

    if (reuseIdx >= 0 && reuseIdx < _tabs.length) {
      // Replace the clean main tab in-place
      _tabs[reuseIdx] = tabObj;
      _activeTabIdx = reuseIdx;
    } else {
      _tabs.push(tabObj);
      _activeTabIdx = _tabs.length - 1;
    }
    _previewMode = false;
    renderEditor();
    renderLibrary();
  } catch (err) {
    if (seq !== _fetchSeq) return;
    console.error('Failed to load artifact', err);
    toast('Failed to load artifact', 'error');
    // If we have other tabs, stay on them
    if (_tabs.length > 0) {
      const tab = activeTab();
      _selected = tab.artifact;
      _selectedContent = tab.artifactContent;
      renderEditor();
      renderLibrary();
    } else {
      switchToLibrary();
    }
  }
}

function switchToWizard() {
  _view = 'wizard';
  _wizardStep = 0;
  _wizPreviewMode = false;
  _wizardData = { type: 'skill', scope: 'global', template: 'blank', name: '', description: '', projectPath: '' };
  renderView();
}

// ═══════════════════════════════════════════
// LIBRARY SIDEBAR
// ═══════════════════════════════════════════

function renderLibrary() {
  const container = $('ss-library');
  if (!container) return;

  const filtered = _library.filter(a => {
    if (_filterType !== 'all' && a.type !== _filterType) return false;
    if (_filterScope !== 'all' && a.scope !== _filterScope) return false;
    if (_searchQuery) {
      const hay = `${a.name} ${a.description}`.toLowerCase();
      if (!hay.includes(_searchQuery)) return false;
    }
    return true;
  });

  // Group by scope
  const groups = {};
  for (const a of filtered) {
    const key = a.scope === 'project' ? `project:${a.scopeLabel || 'Project'}` : a.scope;
    if (!groups[key]) groups[key] = [];
    groups[key].push(a);
  }

  // Render order
  const order = ['bundled', 'global'];
  // Add project groups
  for (const key of Object.keys(groups)) {
    if (key.startsWith('project:')) order.push(key);
  }

  let html = '';
  for (const key of order) {
    const items = groups[key];
    if (!items || items.length === 0) continue;
    const label = key.startsWith('project:') ? key.split(':')[1] : SCOPE_LABELS[key] || key;
    html += `<div class="ss-group">
      <div class="ss-group-header"><span class="ss-group-title">${esc(label)}</span><span class="ss-group-count">${items.length}</span></div>
      <div class="ss-group-body">`;
    for (const a of items.sort((x, y) => x.name.localeCompare(y.name))) {
      const active = _selected && _selected.id === a.id ? ' active' : '';
      const bundledBadge = (a.scope === 'bundled' && !a.installed) ? '<span class="ss-badge ss-badge--muted">not installed</span>' : '';
      const installedFromBundled = a.bundledSource ? '<span class="ss-badge ss-badge--blue">bundled</span>' : '';
      const iconHtml = a.hasIcon
        ? `<span class="ss-item-icon ${a.type} has-custom"><img src="${getSkillsIconUrl(encodeId(a.id))}" alt="" class="ss-item-custom-icon"></span>`
        : `<span class="ss-item-icon ${a.type}">${TYPE_ICONS[a.type] || '?'}</span>`;
      html += `<div class="ss-item${active}" data-id="${esc(a.id)}">
        ${iconHtml}
        <div class="ss-item-info">
          <div class="ss-item-name">${esc(a.name)}${bundledBadge}${installedFromBundled}</div>
          <div class="ss-item-desc">${esc(a.description?.substring(0, 100))}</div>
        </div>
      </div>`;
    }
    html += '</div></div>';
  }

  if (!html) html = '<div class="ss-empty">No skills found</div>';
  container.innerHTML = html;

  // Wire click handlers
  container.querySelectorAll('.ss-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const artifact = _library.find(a => a.id === id);
      if (artifact) switchToEditor(artifact);
    });
  });
}

// ═══════════════════════════════════════════
// LIBRARY MAIN (welcome/overview)
// ═══════════════════════════════════════════

function renderLibraryMain() {
  const main = $('ss-main');
  if (!main) return;

  const skillCount = _library.filter(a => a.type === 'skill').length;
  const cmdCount = _library.filter(a => a.type === 'command').length;
  const agentCount = _library.filter(a => a.type === 'agent').length;

  main.innerHTML = `
    <div class="ss-welcome">
      <div class="ss-welcome-hero">
        <img src="synabun.png?v=2" alt="SynaBun" class="ss-welcome-logo">
        <h2>Skills Studio</h2>
      </div>
      <p class="ss-welcome-sub">Browse, edit, and create Claude Code skills, commands, and agents.</p>
      <div class="ss-stats-row">
        <div class="ss-stat ss-stat--skill">
          <span class="ss-stat-num">${skillCount}</span>
          <span class="ss-stat-label"><span class="ss-filter-dot skill"></span> Skills</span>
        </div>
        <div class="ss-stat ss-stat--command">
          <span class="ss-stat-num">${cmdCount}</span>
          <span class="ss-stat-label"><span class="ss-filter-dot command"></span> Commands</span>
        </div>
        <div class="ss-stat ss-stat--agent">
          <span class="ss-stat-num">${agentCount}</span>
          <span class="ss-stat-label"><span class="ss-filter-dot agent"></span> Agents</span>
        </div>
      </div>
      <p class="ss-welcome-hint">Select an item from the sidebar, or create a new one.</p>
    </div>
  `;
}

// ═══════════════════════════════════════════
// EDITOR VIEW
// ═══════════════════════════════════════════

function renderEditor() {
  const main = $('ss-main');
  if (!main || !_selected || !_selectedContent) return;

  const a = _selected;
  const c = _selectedContent;
  const isSkill = a.type === 'skill';
  const isAgent = a.type === 'agent';
  const isCommand = a.type === 'command';
  const isBundled = a.scope === 'bundled';

  main.innerHTML = `
    <div class="ss-editor-header">
      <button class="ss-back-btn" id="ss-back">\u2190 Library</button>
      <span class="ss-editor-name">${esc(a.name)}</span>
      <span class="ss-badge ss-badge--${a.type}"><span class="ss-filter-dot ${a.type}"></span>${TYPE_LABELS[a.type]}</span>
      <span class="ss-badge ss-badge--scope">${a.scopeLabel || SCOPE_LABELS[a.scope]}</span>
      <div class="ss-editor-spacer"></div>
      <button class="ss-header-btn ss-export-btn" id="ss-export">\u2193 Export</button>
      ${isBundled ? `<button class="ss-header-btn ss-install-btn" id="ss-install-btn">Install</button>` : ''}
      <button class="ss-header-btn ss-delete-btn" id="ss-delete-btn">\u2715 Delete</button>
      <button class="ss-header-btn ss-discard-btn" id="ss-discard" disabled>Discard</button>
      <button class="ss-header-btn ss-save-btn" id="ss-save" disabled>Save</button>
    </div>

    <div class="ss-editor-body">
      <div class="ss-editor-meta" id="ss-editor-meta">
        ${buildMetadataForm(a, c.frontmatter)}
        ${isSkill && c.subFiles && c.subFiles.length > 0 ? buildFileTree(c.subFiles) : ''}
        ${isSkill ? '<button class="ss-add-file-btn" id="ss-add-file">+ Add File</button>' : ''}
      </div>
      <div class="ss-editor-content">
        <div class="ss-tab-bar" id="ss-tab-bar"></div>
        <div class="ss-md-toolbar" id="ss-md-toolbar">
          <button class="ss-md-tool" data-cmd="heading" data-tooltip="Heading (Ctrl+H)"><svg viewBox="0 0 24 24"><path d="M4 4v16M20 4v16M4 12h16"/></svg></button>
          <button class="ss-md-tool" data-cmd="bold" data-tooltip="Bold (Ctrl+B)"><b style="font-size:13px">B</b></button>
          <button class="ss-md-tool" data-cmd="italic" data-tooltip="Italic (Ctrl+I)"><i style="font-size:13px">I</i></button>
          <button class="ss-md-tool" data-cmd="strikethrough" data-tooltip="Strikethrough"><s style="font-size:12px">S</s></button>
          <div class="ss-md-toolbar-sep"></div>
          <button class="ss-md-tool" data-cmd="ul" data-tooltip="Bullet list"><svg viewBox="0 0 24 24"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg></button>
          <button class="ss-md-tool" data-cmd="ol" data-tooltip="Numbered list"><svg viewBox="0 0 24 24"><line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="4" y="8" font-size="7" fill="currentColor" stroke="none" font-weight="600">1</text><text x="4" y="14" font-size="7" fill="currentColor" stroke="none" font-weight="600">2</text><text x="4" y="20" font-size="7" fill="currentColor" stroke="none" font-weight="600">3</text></svg></button>
          <button class="ss-md-tool" data-cmd="quote" data-tooltip="Blockquote"><svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h12"/><rect x="1" y="5" width="2" height="14" rx="1" fill="currentColor" stroke="none" opacity="0.4"/></svg></button>
          <div class="ss-md-toolbar-sep"></div>
          <button class="ss-md-tool" data-cmd="code" data-tooltip="Inline code"><svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></button>
          <button class="ss-md-tool" data-cmd="codeblock" data-tooltip="Code block"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 8 5 12 9 16" stroke-width="1.5"/><polyline points="15 8 19 12 15 16" stroke-width="1.5"/></svg></button>
          <button class="ss-md-tool" data-cmd="link" data-tooltip="Link (Ctrl+K)"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
          <button class="ss-md-tool" data-cmd="hr" data-tooltip="Horizontal rule">&mdash;</button>
          <div class="ss-view-toggle">
            <button class="ss-view-toggle-btn${_previewMode ? '' : ' active'}" data-mode="raw">Raw</button>
            <button class="ss-view-toggle-btn${_previewMode ? ' active' : ''}" data-mode="preview">Preview</button>
          </div>
        </div>
        <textarea class="ss-md-editor${_previewMode ? ' ss-hidden' : ''}" id="ss-content-editor" spellcheck="false" autocorrect="off" autocapitalize="off">${esc(activeTab().content)}</textarea>
        <div class="ss-md-preview${_previewMode ? ' visible' : ''}" id="ss-md-preview">${_previewMode ? renderMarkdown(activeTab().content) : ''}</div>
      </div>
    </div>
  `;

  wireEditor();
}

function buildMetadataForm(artifact, fm) {
  const isSkill = artifact.type === 'skill';
  const isAgent = artifact.type === 'agent';
  const isBundled = artifact.scope === 'bundled';
  let html = '<div class="ss-meta-section">';

  // Icon upload (all types, unless bundled/read-only)
  if (!isBundled) {
    const encodedId = encodeId(artifact.id || '');
    const hasIcon = artifact.hasIcon;
    html += `<div class="ss-field ss-icon-field">
      <label>Icon</label>
      <div class="ss-icon-upload" id="ss-icon-upload">
        <div class="ss-icon-preview" id="ss-icon-preview">
          ${hasIcon
            ? `<img src="${getSkillsIconUrl(encodedId)}?t=${Date.now()}" alt="" class="ss-icon-preview-img">`
            : `<div class="ss-icon-placeholder ${artifact.type}">${TYPE_ICONS[artifact.type] || '?'}</div>`
          }
        </div>
        <div class="ss-icon-actions">
          <label class="ss-icon-upload-btn" id="ss-icon-upload-label">
            <input type="file" id="ss-icon-file" accept=".png,.svg,.jpg,.jpeg,.webp,image/png,image/svg+xml,image/jpeg,image/webp" hidden>
            ${hasIcon ? 'Change' : 'Upload'}
          </label>
          ${hasIcon ? '<button class="ss-icon-remove-btn" id="ss-icon-remove" type="button">Remove</button>' : ''}
        </div>
      </div>
    </div>`;
  }

  // Name (skill + agent only)
  if (isSkill || isAgent) {
    html += `<div class="ss-field">
      <label>Name</label>
      <input type="text" class="ss-input" id="ss-f-name" value="${esc(fm.name || '')}" data-fm="name">
    </div>`;
  }

  // Description (all types)
  html += `<div class="ss-field">
    <label>Description</label>
    <textarea class="ss-textarea ss-textarea-sm" id="ss-f-desc" data-fm="description">${esc(fm.description || '')}</textarea>
  </div>`;

  // Argument hint (skill only)
  if (isSkill) {
    html += `<div class="ss-field">
      <label>Argument Hint</label>
      <input type="text" class="ss-input" id="ss-f-arghint" value="${esc(fm['argument-hint'] || '')}" data-fm="argument-hint">
    </div>`;
  }

  // Allowed tools (skill only)
  if (isSkill) {
    const tools = fm['allowed-tools'] || [];
    const allTools = ['Read','Write','Edit','Bash','Grep','Glob','WebFetch','WebSearch','Task','NotebookEdit'];
    html += `<div class="ss-field">
      <label>Allowed Tools</label>
      <div class="ss-tools-list" id="ss-tools-list">
        ${tools.map(t => `<span class="ss-chip">${esc(t)}<button class="ss-chip-x" data-tool="${esc(t)}">\u00d7</button></span>`).join('')}
      </div>
      <div class="ss-dropdown" id="ss-tools-dropdown">
        <button class="ss-dropdown-trigger" id="ss-tools-trigger" type="button">
          <span>Add tool...</span>
          <svg viewBox="0 0 10 6" width="10" height="6"><path d="M0 0l5 6 5-6z" fill="currentColor"/></svg>
        </button>
        <div class="ss-dropdown-menu" id="ss-tools-menu">
          ${allTools.map(t =>
            `<div class="ss-dropdown-item${tools.includes(t) ? ' disabled' : ''}" data-value="${esc(t)}">${esc(t)}</div>`
          ).join('')}
        </div>
      </div>
    </div>`;
  }

  // Options (skill only)
  if (isSkill) {
    html += `<div class="ss-field">
      <label>Options</label>
      <div class="ss-checkbox-row">
        <input type="checkbox" id="ss-f-user-invocable" ${fm['user-invocable'] !== false ? 'checked' : ''}>
        <label for="ss-f-user-invocable">User-invocable</label>
      </div>
      <div class="ss-checkbox-row">
        <input type="checkbox" id="ss-f-disable-model" ${fm['disable-model-invocation'] ? 'checked' : ''}>
        <label for="ss-f-disable-model">Disable model invocation</label>
      </div>
    </div>`;
  }

  // Agent-specific fields
  if (isAgent) {
    html += `<div class="ss-field">
      <label>Model</label>
      <select class="ss-input" id="ss-f-model" data-fm="model">
        <option value="" ${!fm.model ? 'selected' : ''}>inherit (default)</option>
        <option value="sonnet" ${fm.model === 'sonnet' ? 'selected' : ''}>sonnet</option>
        <option value="haiku" ${fm.model === 'haiku' ? 'selected' : ''}>haiku</option>
        <option value="opus" ${fm.model === 'opus' ? 'selected' : ''}>opus</option>
      </select>
    </div>`;

    const toolsStr = fm.tools || '';
    html += `<div class="ss-field">
      <label>Tools <span class="ss-field-hint">(comma-separated)</span></label>
      <input type="text" class="ss-input" id="ss-f-agent-tools" value="${esc(toolsStr)}" data-fm="tools">
    </div>`;

    html += `<div class="ss-field">
      <label>Max Turns</label>
      <input type="number" class="ss-input" id="ss-f-max-turns" value="${fm.maxTurns || ''}" min="0" data-fm="maxTurns" placeholder="0 = unlimited">
    </div>`;

    html += `<div class="ss-field">
      <label>Color</label>
      <input type="text" class="ss-input" id="ss-f-color" value="${esc(fm.color || '')}" data-fm="color" placeholder="e.g. red, blue">
    </div>`;
  }

  html += '</div>';
  return html;
}

function buildFileTree(subFiles) {
  if (!subFiles || subFiles.length === 0) return '';
  let html = '<div class="ss-section-label">Sub-files</div><div class="ss-file-tree" id="ss-file-tree">';
  const folderSvg = `<svg viewBox="0 0 16 16" width="13" height="13" class="ss-file-icon-svg"><path d="M2 3h4l1 1h7a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1z" fill="currentColor" opacity="0.7"/></svg>`;
  const fileSvg = `<svg viewBox="0 0 16 16" width="13" height="13" class="ss-file-icon-svg"><path d="M3 2h7l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" fill="currentColor" opacity="0.6"/><path d="M10 2v2.5a.5.5 0 00.5.5H13" stroke="currentColor" stroke-width="0.8" fill="none" opacity="0.5"/></svg>`;

  function renderItem(item, depth = 0) {
    const pad = depth * 14;
    if (item.type === 'dir') {
      html += `<div class="ss-file-item ss-file-dir" style="padding-left:${pad + 8}px" data-tooltip="${esc(item.name)}/">
        <span class="ss-file-icon">${folderSvg}</span>
        <span class="ss-file-name">${esc(item.name)}/</span>
      </div>`;
      if (item.children) item.children.forEach(c => renderItem(c, depth + 1));
    } else {
      html += `<div class="ss-file-item" style="padding-left:${pad + 8}px" data-path="${esc(item.path)}" data-tooltip="${esc(item.name)}">
        <span class="ss-file-icon">${fileSvg}</span>
        <span class="ss-file-name">${esc(item.name)}</span>
        <span class="ss-file-size">${item.size > 1024 ? Math.round(item.size / 1024) + 'K' : item.size + 'B'}</span>
        <div class="ss-file-actions">
          <button class="ss-file-del-btn" data-path="${esc(item.path)}" data-tooltip="Delete">\u2715</button>
        </div>
      </div>`;
    }
  }
  subFiles.forEach(f => renderItem(f));
  html += '</div>';
  return html;
}

function wireEditor() {
  // Render the tab bar
  renderTabBar();

  // Back button — close current tab
  $('ss-back')?.addEventListener('click', () => {
    closeTab(_activeTabIdx);
  });

  // Content editor — tab-aware input tracking
  const editor = $('ss-content-editor');
  if (editor) {
    editor.addEventListener('input', () => {
      storeActiveTabContent();
      updateDirtyState();
    });
    // Tab key support (indentation)
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        storeActiveTabContent();
        updateDirtyState();
      }
    });
  }

  // Metadata field change tracking — dirties the main tab of the current artifact
  _panel.querySelectorAll('#ss-editor-meta input, #ss-editor-meta textarea, #ss-editor-meta select').forEach(el => {
    el.addEventListener('input', () => {
      const mt = findMainTab(_selected?.id);
      if (mt) mt.dirty = true;
      updateDirtyState();
    });
    el.addEventListener('change', () => {
      const mt = findMainTab(_selected?.id);
      if (mt) mt.dirty = true;
      updateDirtyState();
    });
  });

  // Markdown toolbar
  wireMarkdownToolbar();

  // Preview/Raw toggle
  _panel.querySelectorAll('.ss-view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      _previewMode = mode === 'preview';
      _panel.querySelectorAll('.ss-view-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      const ed = $('ss-content-editor');
      const prev = $('ss-md-preview');
      const toolbar = $('ss-md-toolbar');
      if (ed) ed.classList.toggle('ss-hidden', _previewMode);
      if (prev) {
        prev.classList.toggle('visible', _previewMode);
        if (_previewMode) {
          prev.innerHTML = renderMarkdown(ed?.value || '');
        }
      }
      // Hide formatting tools in preview mode
      if (toolbar) toolbar.querySelectorAll('.ss-md-tool').forEach(t => t.style.visibility = _previewMode ? 'hidden' : '');
    });
  });

  // Ctrl+B/I/K shortcuts in editor
  if (editor) {
    editor.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'b') { e.preventDefault(); mdWrap('**', '**'); }
        else if (e.key === 'i') { e.preventDefault(); mdWrap('*', '*'); }
        else if (e.key === 'k') { e.preventDefault(); mdLink(); }
        else if (e.key === 'h') { e.preventDefault(); mdPrefix('## '); }
      }
    });
  }

  // Save — tab-aware
  $('ss-save')?.addEventListener('click', saveCurrentArtifact);

  // Discard — reset the active tab's content
  $('ss-discard')?.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab.dirty) return;
    if (!confirm(`Discard changes to "${tab.label}"?`)) return;
    tab.content = tab.originalContent;
    tab.dirty = false;
    if (tab.path === null) {
      // Main tab — re-render editor to reset metadata form fields too
      renderEditor();
    } else {
      loadActiveTabContent();
    }
    renderTabBar();
    updateDirtyState();
  });

  // Export
  $('ss-export')?.addEventListener('click', () => {
    if (!_selected) return;
    const url = getSkillsExportUrl(encodeId(_selected.id));
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.click();
  });

  // Delete artifact — also closes all its tabs
  $('ss-delete-btn')?.addEventListener('click', async () => {
    if (!_selected) return;
    if (!confirm(`Delete "${_selected.name}"? This cannot be undone.`)) return;
    try {
      const deletedId = _selected.id;
      await deleteSkillsArtifact(encodeId(deletedId));
      toast(`Deleted "${_selected.name}"`, 'info');
      // Remove all tabs belonging to this artifact
      _tabs = _tabs.filter(t => t.artifactId !== deletedId);
      if (_activeTabIdx >= _tabs.length) _activeTabIdx = Math.max(0, _tabs.length - 1);
      await loadLibrary();
      if (_tabs.length === 0) {
        switchToLibrary();
      } else {
        const tab = activeTab();
        _selected = tab.artifact;
        _selectedContent = tab.artifactContent;
        renderEditor();
        renderLibrary();
      }
    } catch (err) {
      toast('Delete failed: ' + err.message, 'error');
    }
  });

  // Install bundled
  $('ss-install-btn')?.addEventListener('click', async () => {
    if (!_selected) return;
    try {
      await installSkillsBundled(_selected.dirName);
      toast(`Installed "${_selected.name}" — restart Claude Code to use`, 'info');
      await loadLibrary();
    } catch (err) {
      toast('Install failed: ' + err.message, 'error');
    }
  });

  // Tool chips — custom dropdown
  wireToolsDropdown();

  // Remove tool chip (delegated)
  $('ss-tools-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.ss-chip-x');
    if (!btn) return;
    const tool = btn.dataset.tool;
    btn.closest('.ss-chip').remove();
    const menuItem = _panel?.querySelector(`#ss-tools-menu .ss-dropdown-item[data-value="${tool}"]`);
    if (menuItem) menuItem.classList.remove('disabled');
    const mt = findMainTab(_selected?.id);
    if (mt) mt.dirty = true;
    updateDirtyState();
  });

  // Sub-file edit/delete — opens in tab, not modal
  const fileTree = $('ss-file-tree');
  if (fileTree) {
    fileTree.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.ss-file-del-btn');
      if (delBtn) { deleteSubFile(delBtn.dataset.path); return; }
      const row = e.target.closest('.ss-file-item[data-path]');
      if (row) openFileInTab(row.dataset.path);
    });
  }

  // Add file — custom file browser dialog
  $('ss-add-file')?.addEventListener('click', () => openAddFileDialog());

  // Icon upload handler
  const iconFile = $('ss-icon-file');
  if (iconFile) {
    iconFile.addEventListener('change', async () => {
      const file = iconFile.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { toast('Icon must be under 2 MB', 'error'); return; }
      const label = $('ss-icon-upload-label');
      const origText = label?.textContent?.trim();
      if (label) label.textContent = 'Uploading\u2026';
      try {
        const buf = await file.arrayBuffer();
        await uploadSkillsIcon(encodeId(_selected.id), buf, file.type || 'image/png');
        toast('Icon uploaded', 'info');
        _selected.hasIcon = true;
        const libItem = _library.find(a => a.id === _selected.id);
        if (libItem) libItem.hasIcon = true;
        renderEditor();
        renderLibrary();
      } catch (err) {
        toast('Icon upload failed: ' + err.message, 'error');
        if (label) label.textContent = origText || 'Upload';
      }
    });
  }

  // Icon remove handler
  const iconRemove = $('ss-icon-remove');
  if (iconRemove) {
    iconRemove.addEventListener('click', async () => {
      try {
        await deleteSkillsIcon(encodeId(_selected.id));
        toast('Icon removed', 'info');
        _selected.hasIcon = false;
        const libItem = _library.find(a => a.id === _selected.id);
        if (libItem) libItem.hasIcon = false;
        renderEditor();
        renderLibrary();
      } catch (err) {
        toast('Failed to remove icon: ' + err.message, 'error');
      }
    });
  }
}

// ═══════════════════════════════════════════
// ADD FILE — Custom File Browser Dialog
// ═══════════════════════════════════════════

function openAddFileDialog() {
  if (!_selected || !_selectedContent) return;

  // Extract directories from subFiles tree
  const dirs = ['']; // root = '' (skill directory root)
  function collectDirs(items, prefix) {
    for (const item of items) {
      if (item.type === 'dir') {
        const p = prefix ? prefix + '/' + item.name : item.name;
        dirs.push(p);
        if (item.children) collectDirs(item.children, p);
      }
    }
  }
  if (_selectedContent.subFiles) collectDirs(_selectedContent.subFiles, '');

  let selectedDir = '';
  let newFolderMode = false;

  // Build the overlay
  const overlay = document.createElement('div');
  overlay.className = 'ss-file-dialog-overlay';
  overlay.innerHTML = buildFileDialogHTML(dirs, selectedDir, newFolderMode);
  _panel.appendChild(overlay);

  function refresh() {
    overlay.innerHTML = buildFileDialogHTML(dirs, selectedDir, newFolderMode);
    wireFileDialog();
  }

  function wireFileDialog() {
    // Close / Cancel
    overlay.querySelector('#ss-fd-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('.ss-fd-backdrop')?.addEventListener('click', () => overlay.remove());

    // Directory clicks
    overlay.querySelectorAll('.ss-fd-dir').forEach(el => {
      el.addEventListener('click', () => {
        selectedDir = el.dataset.path;
        refresh();
      });
    });

    // New folder toggle
    overlay.querySelector('#ss-fd-new-folder-btn')?.addEventListener('click', () => {
      newFolderMode = true;
      refresh();
      overlay.querySelector('#ss-fd-new-folder-name')?.focus();
    });

    // New folder confirm
    overlay.querySelector('#ss-fd-new-folder-ok')?.addEventListener('click', () => {
      const input = overlay.querySelector('#ss-fd-new-folder-name');
      const name = input?.value.trim();
      if (!name) return;
      const newPath = selectedDir ? selectedDir + '/' + name : name;
      dirs.push(newPath);
      selectedDir = newPath;
      newFolderMode = false;
      refresh();
    });

    // New folder cancel
    overlay.querySelector('#ss-fd-new-folder-cancel')?.addEventListener('click', () => {
      newFolderMode = false;
      refresh();
    });

    // Enter in new folder input
    overlay.querySelector('#ss-fd-new-folder-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') overlay.querySelector('#ss-fd-new-folder-ok')?.click();
      if (e.key === 'Escape') { newFolderMode = false; refresh(); }
    });

    // Create button
    overlay.querySelector('#ss-fd-create')?.addEventListener('click', async () => {
      const nameInput = overlay.querySelector('#ss-fd-filename');
      const filename = nameInput?.value.trim();
      if (!filename) { toast('Filename is required', 'error'); nameInput?.focus(); return; }
      const fullPath = selectedDir ? selectedDir + '/' + filename : filename;
      overlay.remove();
      try {
        await createSkillsSubFile(encodeId(_selected.id), fullPath, '');
        toast('File created', 'info');
        const data = await fetchSkillsArtifact(encodeId(_selected.id));
        _selectedContent = data;
        _tabs.forEach(t => { if (t.artifactId === _selected.id) t.artifactContent = data; });
        renderEditor();
        await openFileInTab(fullPath);
      } catch (err) {
        toast('Failed: ' + err.message, 'error');
      }
    });

    // Enter in filename → create
    overlay.querySelector('#ss-fd-filename')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') overlay.querySelector('#ss-fd-create')?.click();
      if (e.key === 'Escape') overlay.remove();
    });

    // Upload file input
    const uploadInput = overlay.querySelector('#ss-fd-upload-input');
    if (uploadInput) {
      uploadInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        overlay.remove();
        try {
          const content = await file.text();
          const fullPath = selectedDir ? selectedDir + '/' + file.name : file.name;
          await createSkillsSubFile(encodeId(_selected.id), fullPath, content);
          toast(`File uploaded: ${file.name}`, 'info');
          const data = await fetchSkillsArtifact(encodeId(_selected.id));
          _selectedContent = data;
          _tabs.forEach(t => { if (t.artifactId === _selected.id) t.artifactContent = data; });
          renderEditor();
          await openFileInTab(fullPath);
        } catch (err) {
          toast('Failed: ' + err.message, 'error');
        }
      });
    }

    // Upload trigger button
    overlay.querySelector('#ss-fd-upload-btn')?.addEventListener('click', () => {
      overlay.querySelector('#ss-fd-upload-input')?.click();
    });

    // Focus filename input
    if (!newFolderMode) overlay.querySelector('#ss-fd-filename')?.focus();
  }

  wireFileDialog();
}

function buildFileDialogHTML(dirs, selectedDir, newFolderMode = false) {
  const pathPreview = selectedDir ? selectedDir + '/' : '';

  // Build visual tree of dirs
  const tree = [];
  // Root entry
  tree.push({ path: '', name: '/ (root)', depth: 0 });
  // Sort dirs and compute depths
  const sorted = dirs.filter(d => d !== '').sort();
  for (const d of sorted) {
    const parts = d.split('/');
    tree.push({ path: d, name: parts[parts.length - 1], depth: parts.length });
  }

  return `
    <div class="ss-fd-backdrop"></div>
    <div class="ss-file-dialog">
      <div class="ss-fd-body">
        ${dirs.length > 1 ? `
          <div class="ss-fd-section-label">in</div>
          <div class="ss-fd-dirs">
            ${tree.map(d => `
              <div class="ss-fd-dir${d.path === selectedDir ? ' selected' : ''}" data-path="${esc(d.path)}" style="padding-left:${d.depth * 14 + 8}px">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 13.5H2a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h4l1.5 2H14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1z"/></svg>
                <span>${esc(d.name)}</span>
              </div>
            `).join('')}
          </div>
          ${newFolderMode ? `
            <div class="ss-fd-new-folder">
              <input type="text" class="ss-input ss-fd-input" id="ss-fd-new-folder-name" placeholder="folder-name" spellcheck="false">
              <button class="ss-fd-btn ss-fd-btn--ok" id="ss-fd-new-folder-ok">Add</button>
              <button class="ss-fd-btn ss-fd-btn--cancel" id="ss-fd-new-folder-cancel">&times;</button>
            </div>
          ` : `
            <button class="ss-fd-new-folder-trigger" id="ss-fd-new-folder-btn">+ Folder</button>
          `}
        ` : ''}

        <div class="ss-fd-inline-create">
          <div class="ss-fd-filename-row">
            <span class="ss-fd-path-prefix">${esc(pathPreview)}</span>
            <input type="text" class="ss-input ss-fd-input ss-fd-filename-input" id="ss-fd-filename" placeholder="filename.md" spellcheck="false" autocomplete="off">
          </div>
          <button class="ss-fd-create-btn" id="ss-fd-create">Create</button>
        </div>

        <div class="ss-fd-or">or</div>

        <div class="ss-fd-inline-upload">
          <button class="ss-fd-upload-link" id="ss-fd-upload-btn">Upload from computer</button>
          <input type="file" id="ss-fd-upload-input" style="display:none">
        </div>
      </div>

      <div class="ss-fd-footer">
        <button class="ss-header-btn" id="ss-fd-cancel">Cancel</button>
      </div>
    </div>
  `;
}

function wireToolsDropdown() {
  const trigger = $('ss-tools-trigger');
  const menu = $('ss-tools-menu');
  if (!trigger || !menu) return;

  // Toggle menu
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle('open');
    trigger.classList.toggle('open', open);
  });

  // Item click
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ss-dropdown-item');
    if (!item || item.classList.contains('disabled')) return;
    const val = item.dataset.value;
    const list = $('ss-tools-list');
    if (list) {
      list.insertAdjacentHTML('beforeend', `<span class="ss-chip">${esc(val)}<button class="ss-chip-x" data-tool="${esc(val)}">\u00d7</button></span>`);
    }
    item.classList.add('disabled');
    menu.classList.remove('open');
    trigger.classList.remove('open');
    const mt = findMainTab(_selected?.id);
    if (mt) mt.dirty = true;
    updateDirtyState();
  });

  // Close on outside click
  const closeMenu = (e) => {
    if (!trigger.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.remove('open');
      trigger.classList.remove('open');
    }
  };
  document.addEventListener('click', closeMenu);
  // Clean up when panel is destroyed (captured via MutationObserver is overkill — just leave it)
}

// ── Metadata ↔ Frontmatter helpers ──

/** Collect all metadata form values into an object matching frontmatter keys */
function collectMetadataFromForm() {
  if (!_selected) return null;
  const meta = {};
  const type = _selected.type; // skill | command | agent

  // Name (skill + agent)
  const nameEl = $('ss-f-name');
  if (nameEl) meta.name = nameEl.value.trim();

  // Description (all types)
  const descEl = $('ss-f-desc');
  if (descEl) meta.description = descEl.value.trim();

  if (type === 'skill') {
    // Argument hint
    const argEl = $('ss-f-arghint');
    if (argEl && argEl.value.trim()) meta['argument-hint'] = argEl.value.trim();

    // Allowed tools — read from chip list DOM
    const toolsList = $('ss-tools-list');
    if (toolsList) {
      const tools = [...toolsList.querySelectorAll('.ss-chip')].map(chip => {
        const xBtn = chip.querySelector('.ss-chip-x');
        return xBtn ? xBtn.dataset.tool : chip.textContent.replace('\u00d7', '').trim();
      }).filter(Boolean);
      if (tools.length > 0) meta['allowed-tools'] = tools;
    }

    // Options checkboxes
    const uiEl = $('ss-f-user-invocable');
    if (uiEl) meta['user-invocable'] = uiEl.checked;
    const dmEl = $('ss-f-disable-model');
    if (dmEl && dmEl.checked) meta['disable-model-invocation'] = true;
  }

  if (type === 'agent') {
    // Model
    const modelEl = $('ss-f-model');
    if (modelEl && modelEl.value) meta.model = modelEl.value;
    // Tools (comma-separated string)
    const toolsEl = $('ss-f-agent-tools');
    if (toolsEl && toolsEl.value.trim()) meta.tools = toolsEl.value.trim();
    // Max turns
    const maxEl = $('ss-f-max-turns');
    if (maxEl && maxEl.value) meta.maxTurns = parseInt(maxEl.value, 10) || 0;
    // Color
    const colorEl = $('ss-f-color');
    if (colorEl && colorEl.value.trim()) meta.color = colorEl.value.trim();
  }

  return meta;
}

/** Serialize a metadata object to a YAML frontmatter string (with ---) */
function buildFrontmatterYaml(meta) {
  if (!meta || Object.keys(meta).length === 0) return '';
  const lines = ['---'];
  for (const [key, val] of Object.entries(meta)) {
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val)) {
      // YAML list
      if (val.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of val) lines.push(`  - ${item}`);
    } else if (typeof val === 'boolean') {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === 'string' && (val.includes('\n') || (key === 'description' && val.length > 80))) {
      // Multi-line or long description → block scalar
      lines.push(`${key}: >`);
      // Wrap long single-line text into ~78-char lines for readability
      const raw = val.replace(/\r\n/g, '\n');
      if (!raw.includes('\n')) {
        const words = raw.split(' ');
        let line = '';
        for (const w of words) {
          if (line && (line.length + 1 + w.length) > 78) {
            lines.push(`  ${line}`);
            line = w;
          } else {
            line = line ? line + ' ' + w : w;
          }
        }
        if (line) lines.push(`  ${line}`);
      } else {
        for (const l of raw.split('\n')) lines.push(`  ${l}`);
      }
    } else if (typeof val === 'string' && (val.includes(':') || val.includes('#') || val.includes('"'))) {
      // Strings with special chars → quoted
      lines.push(`${key}: "${val.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/** Replace or insert frontmatter in raw content using collected form metadata */
function mergeMetadataIntoContent(rawContent, meta) {
  if (!meta) return rawContent;
  const yaml = buildFrontmatterYaml(meta);
  if (!yaml) return rawContent;
  // Strip existing frontmatter from body
  const body = rawContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return yaml + '\n' + body;
}

function setDirty() {
  // Delegate to tab-based dirty tracking
  storeActiveTabContent();
  updateDirtyState();
}

async function saveCurrentArtifact() {
  const tab = activeTab();
  if (!tab.artifact || !tab.artifactContent) return;

  storeActiveTabContent();
  captureMetadataIntoContent();
  const id = encodeId(tab.artifactId);

  try {
    if (tab.path === null) {
      await saveSkillsArtifact(id, tab.content);
      tab.originalContent = tab.content;
      tab.dirty = false;
      // Sync the textarea with the merged content (metadata may have changed it)
      const editor = $('ss-content-editor');
      if (editor) editor.value = tab.content;
      // Refresh tab.artifactContent so re-renders show correct metadata
      try {
        const freshData = await fetchSkillsArtifact(id);
        tab.artifactContent = freshData;
        _selectedContent = freshData;
        // Also update the artifact reference from the library if available
        _tabs.forEach(t => { if (t.artifactId === tab.artifactId) t.artifactContent = freshData; });
      } catch { /* non-critical — stale artifactContent is cosmetic only */ }
      toast('Saved', 'info');
      await loadLibrary();
    } else {
      await saveSkillsSubFile(id, tab.path, tab.content);
      tab.originalContent = tab.content;
      tab.dirty = false;
      toast(`Saved ${tab.label}`, 'info');
    }
    renderTabBar();
    updateDirtyState();
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

async function deleteSubFile(path) {
  if (!_selected) return;
  if (!confirm(`Delete "${path}"?`)) return;
  try {
    await deleteSkillsSubFile(encodeId(_selected.id), path);
    // Close the tab if this file was open
    const tabIdx = _tabs.findIndex(t => t.artifactId === _selected.id && t.path === path);
    if (tabIdx >= 0) {
      _tabs.splice(tabIdx, 1);
      if (_activeTabIdx > tabIdx) _activeTabIdx--;
      else if (_activeTabIdx >= _tabs.length) _activeTabIdx = Math.max(0, _tabs.length - 1);
    }
    toast('File deleted', 'info');
    // Reload artifact content and update all tabs of this artifact
    const data = await fetchSkillsArtifact(encodeId(_selected.id));
    _selectedContent = data;
    _tabs.forEach(t => { if (t.artifactId === _selected.id) t.artifactContent = data; });
    renderEditor();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════
// MARKDOWN TOOLBAR & PREVIEW
// ═══════════════════════════════════════════

function wireMarkdownToolbar() {
  const toolbar = $('ss-md-toolbar');
  if (!toolbar) return;
  toolbar.querySelectorAll('.ss-md-tool[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      switch (cmd) {
        case 'bold':          mdWrap('**', '**'); break;
        case 'italic':        mdWrap('*', '*'); break;
        case 'strikethrough': mdWrap('~~', '~~'); break;
        case 'code':          mdWrap('`', '`'); break;
        case 'codeblock':     mdWrapBlock('```\n', '\n```'); break;
        case 'heading':       mdPrefix('## '); break;
        case 'ul':            mdPrefix('- '); break;
        case 'ol':            mdPrefix('1. '); break;
        case 'quote':         mdPrefix('> '); break;
        case 'link':          mdLink(); break;
        case 'hr':            mdInsert('\n---\n'); break;
      }
    });
  });
}

/** Wrap selection with before/after strings */
function mdWrap(before, after) {
  const ed = $('ss-content-editor');
  if (!ed) return;
  const start = ed.selectionStart, end = ed.selectionEnd;
  const sel = ed.value.substring(start, end);
  const text = sel || 'text';
  ed.focus();
  // Use execCommand for undo support where available, fallback to manual
  const replacement = before + text + after;
  ed.setRangeText(replacement, start, end, 'select');
  // Move cursor to select just the inner text
  ed.selectionStart = start + before.length;
  ed.selectionEnd = start + before.length + text.length;
  storeActiveTabContent();
  updateDirtyState();
}

/** Wrap selection as a block (ensures newlines) */
function mdWrapBlock(before, after) {
  const ed = $('ss-content-editor');
  if (!ed) return;
  const start = ed.selectionStart, end = ed.selectionEnd;
  const sel = ed.value.substring(start, end);
  const text = sel || 'code here';
  const needNewlineBefore = start > 0 && ed.value[start - 1] !== '\n' ? '\n' : '';
  const needNewlineAfter = end < ed.value.length && ed.value[end] !== '\n' ? '\n' : '';
  const replacement = needNewlineBefore + before + text + after + needNewlineAfter;
  ed.setRangeText(replacement, start, end, 'select');
  ed.focus();
  storeActiveTabContent();
  updateDirtyState();
}

/** Prefix each line in selection (for headings, lists, quotes) */
function mdPrefix(prefix) {
  const ed = $('ss-content-editor');
  if (!ed) return;
  const start = ed.selectionStart, end = ed.selectionEnd;
  // Expand selection to full lines
  const before = ed.value.substring(0, start);
  const lineStart = before.lastIndexOf('\n') + 1;
  const sel = ed.value.substring(lineStart, end);
  const lines = sel.split('\n');
  const prefixed = lines.map(line => {
    // If line already has this prefix, remove it (toggle)
    if (line.startsWith(prefix)) return line.substring(prefix.length);
    // Remove other list-style prefixes before adding new one
    return prefix + line.replace(/^(#{1,6}\s|[-*]\s|\d+\.\s|>\s)/, '');
  }).join('\n');
  ed.setRangeText(prefixed, lineStart, end, 'select');
  ed.focus();
  storeActiveTabContent();
  updateDirtyState();
}

/** Insert a markdown link */
function mdLink() {
  const ed = $('ss-content-editor');
  if (!ed) return;
  const start = ed.selectionStart, end = ed.selectionEnd;
  const sel = ed.value.substring(start, end);
  const text = sel || 'link text';
  const replacement = `[${text}](url)`;
  ed.setRangeText(replacement, start, end, 'select');
  // Select "url" for easy replacement
  ed.selectionStart = start + text.length + 3;
  ed.selectionEnd = start + text.length + 6;
  ed.focus();
  storeActiveTabContent();
  updateDirtyState();
}

/** Insert text at cursor */
function mdInsert(text) {
  const ed = $('ss-content-editor');
  if (!ed) return;
  const pos = ed.selectionStart;
  ed.setRangeText(text, pos, ed.selectionEnd, 'end');
  ed.focus();
  storeActiveTabContent();
  updateDirtyState();
}

/** Simple markdown → HTML renderer (no deps) */
function renderMarkdown(md) {
  // Strip YAML frontmatter
  let text = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

  // Escape HTML first
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks (``` ... ```)
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`;
  });

  // Headers
  text = text.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  text = text.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  text = text.replace(/^---+$/gm, '<hr>');

  // Bold and italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Blockquotes
  text = text.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  text = text.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Tables
  text = text.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, sep, body) => {
    const ths = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const tds = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Unordered lists
  text = text.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Ordered lists
  text = text.replace(/^\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
  text = text.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (match) => {
    return '<ol>' + match.replace(/<\/?oli>/g, (t) => t.replace('oli', 'li')) + '</ol>';
  });

  // Paragraphs — wrap remaining loose lines
  text = text.replace(/^(?!<[a-z/])((?!<).+)$/gm, '<p>$1</p>');

  // Clean up empty paragraphs and double newlines
  text = text.replace(/<p>\s*<\/p>/g, '');

  return text;
}

// ── Mermaid support (lazy-loaded from CDN) ──
let _mermaidLoaded = false;
let _mermaidLoading = false;
let _mermaidId = 0;

async function loadMermaid() {
  if (_mermaidLoaded) return true;
  if (_mermaidLoading) {
    // Wait for in-flight load
    return new Promise(resolve => {
      const check = setInterval(() => { if (_mermaidLoaded) { clearInterval(check); resolve(true); } }, 100);
      setTimeout(() => { clearInterval(check); resolve(false); }, 8000);
    });
  }
  _mermaidLoading = true;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
    mod.default.initialize({ startOnLoad: false, theme: 'dark', themeVariables: {
      darkMode: true, background: 'transparent', primaryColor: '#1e3a5f',
      primaryTextColor: '#e0e0e0', lineColor: '#94a3b8', secondaryColor: '#2a2a4a',
    }});
    window.__mermaid = mod.default;
    _mermaidLoaded = true;
    return true;
  } catch (err) {
    console.error('Failed to load Mermaid:', err);
    _mermaidLoading = false;
    return false;
  }
}

async function processMermaidBlocks(container) {
  if (!container) return;
  const blocks = container.querySelectorAll('.ss-mermaid[data-mermaid]');
  if (blocks.length === 0) return;
  const ok = await loadMermaid();
  if (!ok) {
    blocks.forEach(b => { b.innerHTML = '<div class="ss-mermaid-error">Failed to load Mermaid</div>'; });
    return;
  }
  for (const block of blocks) {
    const src = decodeURIComponent(block.dataset.mermaid);
    try {
      const id = `ss-mmd-${++_mermaidId}`;
      const { svg } = await window.__mermaid.render(id, src);
      block.innerHTML = svg;
      // Make SVG responsive
      const svgEl = block.querySelector('svg');
      if (svgEl) { svgEl.style.maxWidth = '100%'; svgEl.style.height = 'auto'; }
    } catch (err) {
      block.innerHTML = `<div class="ss-mermaid-error">Mermaid error: ${esc(err.message || 'parse error')}</div><pre class="ss-mermaid-src">${esc(src)}</pre>`;
    }
  }
}

// ═══════════════════════════════════════════
// WIZARD VIEW
// ═══════════════════════════════════════════

const SKILL_TEMPLATES = {
  blank: { label: 'Blank', desc: 'Empty starting point',
    gen: (n) => `---\nname: ${n}\ndescription: >\n  Describe when this skill should trigger.\n---\n\n# ${n}\n\nAdd your instructions here.\n` },
  simple: { label: 'Simple', desc: 'Single-task skill with steps',
    gen: (n) => `---\nname: ${n}\ndescription: >\n  This skill handles ${n} tasks.\n  Triggers on: "${n}".\nargument-hint: "[input]"\n---\n\n# ${n}\n\nThe user has invoked \`/${n}\`.\n\n**Input**: $ARGUMENTS\n\n## Steps\n\n1. Parse the input\n2. Perform the task\n3. Report results\n` },
  orchestrator: { label: 'Orchestrator', desc: 'Routes to sub-skills based on arguments',
    gen: (n) => `---\nname: ${n}\ndescription: >\n  ${n} command hub \u2014 routes to sub-commands.\n  Triggers on: "${n}".\nargument-hint: "[subcommand] or leave blank for menu"\n---\n\n# ${n}\n\n## Step 1: Parse Arguments\n\nRead \`$ARGUMENTS\`. If blank, present an interactive menu.\n\n## Subcommands\n\n| Command | Description |\n|---------|-------------|\n| sub1 | Does thing 1 |\n| sub2 | Does thing 2 |\n\n## Step 2: Route\n\nBased on the subcommand, follow the appropriate section below.\n\n### sub1\n...\n\n### sub2\n...\n` },
  modular: { label: 'Modular', desc: 'SKILL.md + reference files loaded on demand',
    gen: (n) => `---\nname: ${n}\ndescription: >\n  This skill provides ${n} capabilities with detailed reference docs.\n  Triggers on: "${n}".\nallowed-tools:\n  - Read\n  - Grep\n  - Glob\n---\n\n# ${n}\n\n## Overview\n\nThis skill uses progressive loading. Core logic is here; detailed references are loaded on demand.\n\n## References\n\n- \`$SKILL_DIR/references/guide.md\` \u2014 Detailed guide\n\n## Steps\n\n1. Read $ARGUMENTS\n2. If detailed info needed, use \`Read\` tool on the reference file\n3. Follow the instructions from the reference\n` },
  expert: { label: 'Expert', desc: 'Full frontmatter with all options configured',
    gen: (n) => `---\nname: ${n}\ndescription: >\n  Expert ${n} skill with comprehensive tool access.\n  Triggers on: "${n}", "${n} help".\nargument-hint: "[task description]"\nallowed-tools:\n  - Read\n  - Write\n  - Edit\n  - Bash\n  - Grep\n  - Glob\n  - WebFetch\n  - WebSearch\n  - Task\n---\n\n# ${n}\n\nYou are an expert ${n} assistant. The user has invoked \`/${n}\`.\n\n## Capabilities\n\n- Full file system access\n- Web search and fetch\n- Sub-agent delegation\n\n## Steps\n\n1. Analyze the request: $ARGUMENTS\n2. Plan the approach\n3. Execute with appropriate tools\n4. Report results\n` },
};

const COMMAND_TEMPLATES = {
  blank: { label: 'Blank', desc: 'Empty command',
    gen: (n) => `---\ndescription: Describe what /${n} does.\n---\n\n# ${n}\n\nAdd your instructions here.\n\n$ARGUMENTS\n` },
  analysis: { label: 'Analysis', desc: 'Code or content analysis pattern',
    gen: (n) => `---\ndescription: Analyze code or content for ${n}.\n---\n\n# ${n} Analysis\n\nAnalyze the following based on user input.\n\n**Target**: $ARGUMENTS\n\n## Steps\n\n1. Read the target file or code\n2. Analyze for patterns, issues, or improvements\n3. Present findings in a structured format\n` },
  workflow: { label: 'Workflow', desc: 'Multi-step workflow with confirmation',
    gen: (n) => `---\ndescription: Execute the ${n} workflow.\n---\n\n# ${n} Workflow\n\n$ARGUMENTS\n\n## Steps\n\n1. **Gather**: Collect necessary information\n2. **Plan**: Design the approach\n3. **Confirm**: Present plan to user for approval\n4. **Execute**: Implement the plan\n5. **Verify**: Check results\n` },
};

const AGENT_TEMPLATES = {
  blank: { label: 'Blank', desc: 'Minimal agent',
    gen: (n) => `---\nname: ${n}\ndescription: >\n  Use this agent when you need ${n} expertise.\n---\n\nYou are a ${n} specialist.\n\nFollow the user's instructions carefully.\n` },
  expert: { label: 'Domain Expert', desc: 'Specialist with deep context',
    gen: (n) => `---\nname: ${n}\ndescription: >\n  Use this agent when you need ${n} expertise.\n  Triggers on database questions, schema design,\n  and performance optimization.\nmodel: sonnet\ntools: Read, Bash, Write, Glob, Grep\n---\n\nYou are an expert ${n} specialist. Your role is to provide deep expertise.\n\n<example>\nContext: User needs help with ${n}.\nuser: "Help me with ${n}"\nassistant: "Let me investigate the ${n} setup and provide recommendations."\n</example>\n\n## Your Approach\n\n1. Understand the current state\n2. Identify issues or opportunities\n3. Provide actionable recommendations\n` },
  researcher: { label: 'Researcher', desc: 'Web + file research pattern',
    gen: (n) => `---\nname: ${n}\ndescription: >\n  Use this agent for ${n} research tasks.\ntools: Read, Grep, Glob, WebFetch, WebSearch\n---\n\nYou are a research agent specializing in ${n}.\n\n## Approach\n\n1. Search the codebase for relevant context\n2. Search the web for current best practices\n3. Synthesize findings into actionable insights\n4. Return a concise summary\n` },
};

// ═══════════════════════════════════════════
// PRESET / SNIPPET SYSTEM
// ═══════════════════════════════════════════

const PRESETS_KEY = 'neural-skills-custom-presets';
const PRESETS_PANEL_KEY = 'neural-skills-presets-open';
const PRESETS_COLLAPSED_KEY = 'neural-skills-preset-collapsed';

const PRESET_CATEGORIES = {
  structural: { label: 'Structural', desc: 'Section building blocks' },
  frontmatter: { label: 'Frontmatter', desc: 'YAML configuration snippets' },
  patterns: { label: 'Patterns', desc: 'Complete reusable flows' },
  custom: { label: 'Custom', desc: 'Your saved presets' },
};

const BUILTIN_PRESETS = [
  // ── Structural ──
  { id: 'structural-role', name: 'Role / Persona', description: 'Define who the AI should be',
    category: 'structural', types: ['skill', 'agent'],
    snippet: '## Role\n\nYou are a [specialization] expert. Your role is to [primary responsibility].\n\n### Personality\n- Tone: [professional / casual / technical]\n- Verbosity: [concise / detailed]\n- Focus: [accuracy / speed / creativity]\n',
    educationalNote: 'The Role section is the most impactful part of your prompt. It sets expectations for tone, expertise level, and behavioral boundaries.' },

  { id: 'structural-steps', name: 'Step-by-Step', description: 'Numbered workflow steps',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## Steps\n\n1. **Gather**: Collect necessary information\n2. **Analyze**: Process and understand the input\n3. **Execute**: Perform the main task\n4. **Verify**: Check results for correctness\n5. **Report**: Present findings to the user\n',
    educationalNote: 'Numbered steps give the AI a clear execution order. Each step should be a distinct, verifiable action.' },

  { id: 'structural-constraints', name: 'Constraints', description: 'Rules and boundaries',
    category: 'structural', types: [],
    snippet: '## Constraints\n\n- **NEVER** modify files outside the project directory\n- **NEVER** delete files without explicit user confirmation\n- **ALWAYS** explain your reasoning before making changes\n- **ALWAYS** check for existing patterns before creating new ones\n- Prefer editing existing files over creating new ones\n',
    educationalNote: 'Constraints prevent the AI from taking unwanted actions. Use NEVER/ALWAYS for hard rules, softer language for preferences.' },

  { id: 'structural-output', name: 'Output Format', description: 'Structure the response format',
    category: 'structural', types: [],
    snippet: '## Output Format\n\nReturn results as:\n\n```\n## Summary\n[1-2 sentence overview]\n\n## Findings\n- [Finding 1]\n- [Finding 2]\n\n## Recommendations\n1. [Action item]\n```\n',
    educationalNote: 'Defining output format ensures consistent, parseable responses. Use markdown templates so the AI knows exactly what structure to follow.' },

  { id: 'structural-examples', name: 'Examples', description: 'Show expected behavior with examples',
    category: 'structural', types: ['skill', 'agent'],
    snippet: '<example>\nContext: [Describe the situation]\nuser: "[Example user message]"\nassistant: "[Expected AI response]"\n</example>\n\n<example>\nContext: [Different situation]\nuser: "[Another example]"\nassistant: "[Expected response for this case]"\n</example>\n',
    educationalNote: 'Examples are the most powerful teaching tool. The AI pattern-matches from examples to understand your intent better than abstract rules.' },

  { id: 'structural-context', name: 'Context Gathering', description: 'Gather info before acting',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## Step 1: Gather Context\n\nBefore proceeding, collect the necessary context:\n\n1. Read the relevant files using `Read` or `Glob`\n2. Search for existing patterns with `Grep`\n3. Check for related configuration\n4. Understand the current state before making changes\n\n**Do not skip this step.** Acting without context leads to errors.\n',
    educationalNote: 'Context gathering prevents the AI from making assumptions. It forces a research-first approach that produces better results.' },

  { id: 'structural-error', name: 'Error Handling', description: 'What to do when things fail',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## Error Handling\n\nIf an error occurs:\n1. Report the error clearly to the user\n2. Explain what was attempted and why it failed\n3. Suggest concrete next steps or alternatives\n4. Do NOT retry the same action without changes\n5. Do NOT silently ignore errors\n',
    educationalNote: 'Error handling instructions prevent the AI from getting stuck in retry loops or silently failing.' },

  { id: 'structural-guard', name: 'Guard Rails', description: 'Safety boundaries for agents',
    category: 'structural', types: ['agent'],
    snippet: '## Guard Rails\n\n- Never modify files outside the specified scope\n- Always confirm destructive operations with the user\n- Stop and report if encountering unexpected state\n- Maximum 3 retries on any failing operation\n- If blocked, report the blocker — do not force through\n',
    educationalNote: 'Guard rails are critical for agents that run autonomously. They prevent runaway behavior and destructive mistakes.' },

  // ── Frontmatter ──
  { id: 'fm-tools-readonly', name: 'Read-Only Tools', description: 'Safe exploration tools only',
    category: 'frontmatter', types: ['skill', 'agent'],
    snippet: 'allowed-tools:\n  - Read\n  - Grep\n  - Glob\n',
    educationalNote: 'Read-only tools make your skill safe. The AI can explore the codebase but cannot modify any files.' },

  { id: 'fm-tools-full', name: 'Full Tool Access', description: 'All tools enabled',
    category: 'frontmatter', types: ['skill', 'agent'],
    snippet: 'allowed-tools:\n  - Read\n  - Write\n  - Edit\n  - Bash\n  - Grep\n  - Glob\n  - WebFetch\n  - WebSearch\n  - Task\n  - NotebookEdit\n',
    educationalNote: 'Full tool access gives maximum capability but less safety. Use this for trusted, well-tested skills.' },

  { id: 'fm-tools-web', name: 'Web Access', description: 'Internet research tools',
    category: 'frontmatter', types: ['skill', 'agent'],
    snippet: 'allowed-tools:\n  - WebFetch\n  - WebSearch\n',
    educationalNote: 'Web tools let the AI search the internet and fetch URLs. Useful for research, documentation lookup, and staying current.' },

  { id: 'fm-tools-task', name: 'Task Delegation', description: 'Sub-agent delegation',
    category: 'frontmatter', types: ['skill'],
    snippet: 'allowed-tools:\n  - Task\n  - Read\n  - Grep\n  - Glob\n# Delegates complex subtasks to specialized sub-agents\n',
    educationalNote: 'The Task tool lets your skill spawn sub-agents for parallel or specialized work. Great for orchestrator skills.' },

  { id: 'fm-model', name: 'Model Selection', description: 'Choose which Claude model to use',
    category: 'frontmatter', types: ['agent'],
    snippet: 'model: sonnet  # Options: haiku (fast/cheap), sonnet (balanced), opus (most capable)\n',
    educationalNote: 'Agents can specify which model to use. Haiku is fast and cheap, Sonnet is balanced, Opus is the most capable.' },

  { id: 'fm-trigger', name: 'Trigger Pattern', description: 'When the skill should activate',
    category: 'frontmatter', types: ['skill'],
    snippet: 'description: >\n  This skill handles [task type].\n  Triggers on: "[keyword1]", "[keyword2]", "[keyword3]".\n',
    educationalNote: 'The description field tells Claude when to auto-detect and invoke your skill. List specific trigger phrases for reliable activation.' },

  { id: 'fm-args', name: 'Argument Hint', description: 'Show expected arguments',
    category: 'frontmatter', types: ['skill', 'command'],
    snippet: 'argument-hint: "[target] [--option]"\n',
    educationalNote: 'The argument hint shows users what to type after the slash command. Use brackets for required args, flags for options.' },

  // ── Patterns ──
  { id: 'pattern-analyze', name: 'Analysis Pattern', description: 'Analyze-then-report flow',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Analysis Workflow\n\n### Step 1: Identify Target\nParse `$ARGUMENTS` to determine what to analyze.\nIf no target specified, ask the user.\n\n### Step 2: Gather Data\n- Read the target files\n- Search for related patterns with `Grep`\n- Note dependencies and connections\n\n### Step 3: Analyze\n- Check for common issues and anti-patterns\n- Evaluate code quality and consistency\n- Identify improvement opportunities\n\n### Step 4: Report\nPresent findings as:\n- **Issues**: Problems that need fixing\n- **Warnings**: Potential concerns\n- **Suggestions**: Optional improvements\n',
    educationalNote: 'The analysis pattern is one of the most useful flows. It follows a gather-analyze-report cycle that works for any review task.' },

  { id: 'pattern-transform', name: 'Transform Pattern', description: 'Read-transform-write pipeline',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Transform Pipeline\n\n### Step 1: Read Source\nRead the input file(s) specified in `$ARGUMENTS`.\n\n### Step 2: Validate\nCheck that the input is in the expected format.\nIf not, report the issue and stop.\n\n### Step 3: Transform\nApply the transformation:\n- [Describe transformation logic]\n- Preserve formatting and style conventions\n- Handle edge cases gracefully\n\n### Step 4: Write Output\nWrite the transformed result.\nReport what changed and why.\n',
    educationalNote: 'Transform patterns are perfect for code generation, format conversion, and automated refactoring tasks.' },

  { id: 'pattern-interactive', name: 'Interactive Menu', description: 'Argument routing with menu fallback',
    category: 'patterns', types: ['skill'],
    snippet: '## Routing\n\nRead `$ARGUMENTS`.\n\n**If arguments provided**, route to the matching subcommand below.\n**If blank**, present this menu to the user:\n\n| Command | Description |\n|---------|-------------|\n| `action1` | Does the first thing |\n| `action2` | Does the second thing |\n| `help` | Shows this menu |\n\nUse `AskUserQuestion` to let them pick.\n\n### action1\n[Instructions for action 1]\n\n### action2\n[Instructions for action 2]\n',
    educationalNote: 'Interactive menus make skills user-friendly. When no arguments are given, show a menu instead of failing.' },

  { id: 'pattern-progressive', name: 'Progressive Loading', description: 'Load reference files on demand',
    category: 'patterns', types: ['skill'],
    snippet: '## References\n\nThis skill uses progressive loading. Detailed docs live in sub-files:\n\n- `$SKILL_DIR/references/guide.md` — Complete usage guide\n- `$SKILL_DIR/references/examples.md` — Code examples\n- `$SKILL_DIR/references/api.md` — API reference\n\n## Instructions\n\n1. Read `$ARGUMENTS` to understand the request\n2. If you need detailed information, use `Read` tool on the reference files above\n3. Do NOT load all references upfront — only load what you need\n4. Follow the instructions from the loaded reference\n',
    educationalNote: 'Progressive loading keeps your main SKILL.md small and fast. Sub-files are loaded on demand via $SKILL_DIR, saving context window space.' },

  { id: 'pattern-review', name: 'Code Review', description: 'Multi-file review with structured findings',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Code Review\n\n### Step 1: Scope\nDetermine files to review from `$ARGUMENTS`.\nIf a directory, find relevant files with `Glob`.\n\n### Step 2: Review Each File\nFor each file, check:\n- [ ] Code correctness and logic errors\n- [ ] Security vulnerabilities (injection, XSS, etc.)\n- [ ] Performance concerns\n- [ ] Style consistency with existing codebase\n- [ ] Missing error handling\n\n### Step 3: Summary\nPresent a severity-ranked list:\n- **Critical**: Must fix before merge\n- **Warning**: Should fix soon\n- **Info**: Nice to have improvements\n',
    educationalNote: 'Code review patterns work great as reusable skills. The checklist format ensures consistent, thorough reviews.' },

  { id: 'pattern-crud', name: 'CRUD Operations', description: 'Create/read/update/delete router',
    category: 'patterns', types: ['skill'],
    snippet: '## Subcommands\n\nRoute based on `$ARGUMENTS`:\n\n### create [name]\nCreate a new [resource]:\n1. Validate the name\n2. Check for duplicates\n3. Generate from template\n4. Write to disk\n5. Report success\n\n### list\nList all [resources]:\n1. Scan the directory\n2. Parse metadata\n3. Display as formatted table\n\n### update [name]\nModify an existing [resource]:\n1. Read current state\n2. Apply changes\n3. Validate result\n4. Write back\n\n### delete [name]\nRemove a [resource]:\n1. Confirm with user\n2. Delete file(s)\n3. Clean up references\n',
    educationalNote: 'CRUD patterns are great for skills that manage collections of things — presets, templates, configurations, etc.' },

  // ── More Structural ──
  { id: 'structural-variables', name: 'Variables Reference', description: 'All available runtime variables',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## Variables\n\n- `$ARGUMENTS` — User input after the slash command\n- `$SKILL_DIR` — Absolute path to this skill\'s directory\n- Dynamic injection: `!`git branch --show-current`` runs at load time\n',
    educationalNote: '$ARGUMENTS contains everything the user typed after /command-name. $SKILL_DIR is the absolute path to the skill folder, useful for loading sub-files.' },

  { id: 'structural-validation', name: 'Input Validation', description: 'Validate arguments before processing',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## Input Validation\n\nBefore proceeding, validate `$ARGUMENTS`:\n\n1. If empty — show usage help and ask for input\n2. If it looks like a file path — verify the file exists with `Read`\n3. If it looks like a URL — validate format\n4. If invalid — explain what\'s expected and give examples\n\n**Never proceed with invalid input.** Always validate first.\n',
    educationalNote: 'Input validation prevents confusing errors downstream. Always check $ARGUMENTS before acting on them.' },

  { id: 'structural-askuser', name: 'Interactive Questions', description: 'Use AskUserQuestion for choices',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## User Interaction\n\nUse `AskUserQuestion` to present choices:\n\n- Provide 2-4 clear options with descriptions\n- Include a recommended option marked with "(Recommended)"\n- Set `multiSelect: true` if multiple choices are valid\n- Users can always type "Other" for custom input\n\nExample: Ask which approach to take before making changes.\n',
    educationalNote: 'AskUserQuestion creates a proper selection UI instead of asking open-ended questions. It supports single/multi-select with descriptions.' },

  { id: 'structural-todowrite', name: 'Progress Tracking', description: 'Track work with TodoWrite',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## Task Tracking\n\nFor multi-step tasks, use `TodoWrite` to track progress:\n\n1. Create a todo list with all planned steps\n2. Mark each task `in_progress` before starting (only ONE at a time)\n3. Mark `completed` immediately after finishing each task\n4. Add new tasks if discovered during work\n\nThis keeps the user informed and ensures nothing is missed.\n',
    educationalNote: 'TodoWrite creates a visible progress tracker. Users can see which steps are done, in progress, and pending.' },

  { id: 'structural-scope', name: 'Scope Definition', description: 'Define what is and isn\'t in scope',
    category: 'structural', types: ['skill', 'agent'],
    snippet: '## Scope\n\n### In Scope\n- [List what this skill/agent handles]\n- [Specific files, directories, or domains]\n- [Types of requests to accept]\n\n### Out of Scope\n- [What to refuse or redirect]\n- [Adjacent tasks that belong to other tools]\n- [Explicitly excluded scenarios]\n\nIf a request is out of scope, explain why and suggest the right tool.\n',
    educationalNote: 'Scope definition prevents scope creep. The AI knows exactly what to handle and what to decline.' },

  { id: 'structural-dynamic-context', name: 'Dynamic Context', description: 'Inject live data at load time',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## Current Context\n\n- **Branch**: !`git branch --show-current`\n- **Status**: !`git status --short | head -20`\n- **Last commit**: !`git log -1 --oneline`\n- **Working directory**: !`pwd`\n',
    educationalNote: 'Backtick-bang syntax (!`command`) runs shell commands when the skill loads. The output is injected as static text into the prompt.' },

  { id: 'structural-reporting', name: 'Report Template', description: 'Structured findings report',
    category: 'structural', types: [],
    snippet: '## Report\n\nPresent findings using this structure:\n\n### Summary\n[1-2 sentence overview of what was found]\n\n### Critical Issues\n- [file:line] Issue description — **Impact**: [what breaks]\n\n### Warnings\n- [file:line] Warning description — **Risk**: [potential problem]\n\n### Recommendations\n1. [Highest priority action]\n2. [Second priority action]\n\n### Stats\n- Files analyzed: [N]\n- Issues found: [N critical, N warnings]\n',
    educationalNote: 'Structured reports make findings actionable. The severity-ranked format helps users prioritize fixes.' },

  { id: 'structural-confirmation', name: 'Confirmation Gate', description: 'Ask before destructive actions',
    category: 'structural', types: ['skill', 'command'],
    snippet: '## Confirmation Required\n\nBefore executing any destructive action:\n\n1. **Show exactly** what will be modified/deleted\n2. **List affected files** with specific changes\n3. **Ask for confirmation** using `AskUserQuestion`\n4. Only proceed after explicit "Yes" confirmation\n5. If user says "No" — explain alternatives\n\n**NEVER** skip confirmation for: file deletion, bulk edits, git operations, or data modifications.\n',
    educationalNote: 'Confirmation gates prevent accidental destructive actions. Always show what will happen before doing it.' },

  { id: 'structural-retry', name: 'Retry Logic', description: 'Handle failures with retries',
    category: 'structural', types: ['skill', 'agent'],
    snippet: '## Retry Strategy\n\nWhen an operation fails:\n\n1. **First failure**: Report the error, analyze the cause\n2. **Adjust approach**: Try a different method or fix the root cause\n3. **Second attempt**: Retry with the adjusted approach\n4. **If still failing**: Stop, report what was tried, and ask for help\n\n**Maximum 2 retries.** Do NOT brute-force or repeat the same action.\nDo NOT silently swallow errors.\n',
    educationalNote: 'Retry logic prevents infinite loops. The key is to change approach between retries, not just repeat the same thing.' },

  { id: 'structural-phased', name: 'Multi-Phase Workflow', description: 'Large task broken into phases',
    category: 'structural', types: ['skill'],
    snippet: '## Phase 1: Discovery\nGather requirements. Read relevant files. Ask clarifying questions.\n\n## Phase 2: Analysis\nAnalyze the codebase. Identify patterns, dependencies, and constraints.\n\n## Phase 3: Planning\nDesign the approach. Present plan to user for approval.\n\n## Phase 4: Implementation\nExecute the plan. Track progress with `TodoWrite`.\n\n## Phase 5: Verification\nRun tests. Check for regressions. Validate the output.\n\n## Phase 6: Summary\nReport what was done, what changed, and any follow-up items.\n',
    educationalNote: 'Multi-phase workflows are the most robust pattern for complex tasks. Each phase has a clear goal and exit criteria.' },

  // ── More Frontmatter ──
  { id: 'fm-tools-filemod', name: 'File Modification Tools', description: 'Read + Write + Edit combo',
    category: 'frontmatter', types: ['skill', 'agent'],
    snippet: 'allowed-tools:\n  - Read\n  - Write\n  - Edit\n  - Glob\n  - Grep\n',
    educationalNote: 'File modification tools let the AI read, create, and edit files. No Bash access keeps it safer than full tool access.' },

  { id: 'fm-tools-git', name: 'Git Operations', description: 'Bash restricted to git commands',
    category: 'frontmatter', types: ['skill'],
    snippet: 'allowed-tools:\n  - Read\n  - Grep\n  - Glob\n  - Bash\n# Note: Instruct the skill to only use Bash for git operations\n',
    educationalNote: 'For git-focused skills, include Bash but instruct the skill to only use it for git commands. Explicit instructions in the body reinforce the restriction.' },

  { id: 'fm-tools-analysis', name: 'Analysis Tools', description: 'Read + search tools for review',
    category: 'frontmatter', types: ['skill', 'agent'],
    snippet: 'allowed-tools:\n  - Read\n  - Grep\n  - Glob\n  - WebSearch\n',
    educationalNote: 'Analysis tools are read-only with web search. Perfect for review, audit, and research skills that should never modify files.' },

  { id: 'fm-disable-auto', name: 'User-Only Invocation', description: 'Disable auto-detection',
    category: 'frontmatter', types: ['skill'],
    snippet: 'disable-model-invocation: true\n# Only triggered by user typing /skill-name, never auto-detected\n',
    educationalNote: 'disable-model-invocation prevents Claude from auto-invoking the skill. The user must explicitly type the slash command.' },

  { id: 'fm-fork-context', name: 'Forked Context', description: 'Run skill in isolated subagent',
    category: 'frontmatter', types: ['skill'],
    snippet: 'context: fork\nagent: Explore\n# Runs in an isolated subagent context to avoid polluting the main conversation\n',
    educationalNote: 'context: fork runs the skill in a separate subagent. Useful for heavy research that would clutter the main context window.' },

  { id: 'fm-agent-fast', name: 'Fast Agent (Haiku)', description: 'Quick, cheap agent for simple tasks',
    category: 'frontmatter', types: ['agent'],
    snippet: 'model: haiku\ntools: Read, Grep, Glob\n# Fast and cheap — ideal for simple checks, linting, quick lookups\n',
    educationalNote: 'Haiku agents are fast and cheap. Use them for simple, repetitive checks where speed matters more than deep reasoning.' },

  { id: 'fm-agent-balanced', name: 'Balanced Agent (Sonnet)', description: 'Default agent for most tasks',
    category: 'frontmatter', types: ['agent'],
    snippet: 'model: sonnet\ntools: Read, Write, Edit, Bash, Grep, Glob\n# Balanced cost/capability — the recommended default for most agents\n',
    educationalNote: 'Sonnet is the recommended default for agents. Good balance of capability and cost for analysis, coding, and research tasks.' },

  { id: 'fm-agent-powerful', name: 'Powerful Agent (Opus)', description: 'Maximum capability agent',
    category: 'frontmatter', types: ['agent'],
    snippet: 'model: opus\ntools: Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch, Task\n# Most capable — use for complex architecture, migrations, and critical decisions\n',
    educationalNote: 'Opus agents are the most capable but expensive. Reserve for complex architecture decisions, large migrations, and critical analysis.' },

  { id: 'fm-trigger-multi', name: 'Multiple Triggers', description: 'Rich trigger phrase list',
    category: 'frontmatter', types: ['skill'],
    snippet: 'description: >\n  Use this skill when the user asks about [topic].\n  Triggers on: "[phrase1]", "[phrase2]", "[phrase3]",\n  "[phrase4]", "[phrase5]".\n  Also triggers when discussing [related-topic] or\n  mentioning [specific-term].\n',
    educationalNote: 'More trigger phrases = more reliable auto-detection. List 5+ phrases covering different ways users might ask for this skill.' },

  // ── More Patterns ──
  { id: 'pattern-parallel-agents', name: 'Parallel Agents', description: 'Spawn multiple specialized agents',
    category: 'patterns', types: ['skill'],
    snippet: '## Parallel Analysis\n\nSpawn 3 specialized agents simultaneously using the `Task` tool:\n\n### Agent 1: [Specialist A]\nFocus on [aspect A]. Report findings.\n\n### Agent 2: [Specialist B]\nFocus on [aspect B]. Report findings.\n\n### Agent 3: [Specialist C]\nFocus on [aspect C]. Report findings.\n\n## Synthesis\n\nAfter all agents return, synthesize their findings:\n1. Identify overlapping concerns\n2. Resolve conflicting recommendations\n3. Present unified action plan\n',
    educationalNote: 'Parallel agents run simultaneously, dramatically speeding up multi-faceted analysis. Each agent gets its own context window.' },

  { id: 'pattern-memory-recall', name: 'Memory-Powered', description: 'Recall context before acting',
    category: 'patterns', types: ['skill'],
    snippet: '## Step 1: Recall Context\n\nBefore doing anything, search memory for relevant context:\n\n1. `recall` with query about the current topic\n2. `recall` with category filter for related decisions\n3. Check for past bugs, patterns, or architecture decisions\n\n## Step 2: Act with Context\n\nUse the recalled context to inform your approach.\nAvoid repeating past mistakes or contradicting past decisions.\n\n## Step 3: Remember Results\n\nAfter completing the task:\n1. `remember` what was done, why, and how\n2. Include related_files, appropriate importance, and 3-5 tags\n3. One task = one memory (do not batch)\n',
    educationalNote: 'Memory-powered skills use SynaBun recall/remember to build on past work. They get smarter over time as context accumulates.' },

  { id: 'pattern-test-gen', name: 'Test Generation', description: 'Generate tests for code',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Test Generation\n\n### Step 1: Analyze Target\nRead the target file(s) from `$ARGUMENTS`.\nIdentify:\n- Public functions and their signatures\n- Edge cases and boundary conditions\n- Dependencies that need mocking\n- Existing test patterns in the project\n\n### Step 2: Generate Tests\nFor each function:\n- Happy path test (expected input → expected output)\n- Edge case tests (empty, null, boundary values)\n- Error case tests (invalid input, failures)\n- Integration test if it calls external services\n\n### Step 3: Verify\nRun the tests with `Bash`. Fix any failures.\nEnsure all tests pass before reporting.\n',
    educationalNote: 'Test generation skills are incredibly useful. They analyze code structure and generate comprehensive test suites following existing project patterns.' },

  { id: 'pattern-security', name: 'Security Review', description: 'Security-focused code analysis',
    category: 'patterns', types: ['skill', 'agent'],
    snippet: '## Security Review\n\n### Check for OWASP Top 10:\n- [ ] **Injection**: SQL, command, XSS, template injection\n- [ ] **Broken Auth**: Hardcoded secrets, weak tokens, missing MFA\n- [ ] **Sensitive Data**: Exposed API keys, PII in logs, unencrypted storage\n- [ ] **XXE/SSRF**: External entity processing, server-side request forgery\n- [ ] **Broken Access**: Missing authorization checks, IDOR vulnerabilities\n- [ ] **Misconfig**: Debug mode on, default credentials, verbose errors\n- [ ] **Dependency Vulns**: Outdated packages with known CVEs\n\n### Report Format\nFor each finding:\n- **Severity**: Critical / High / Medium / Low\n- **Location**: file:line\n- **Description**: What the vulnerability is\n- **Remediation**: How to fix it\n- **Confidence**: percentage (only report >= 80%)\n',
    educationalNote: 'Security review agents should filter by confidence (>= 80%) to avoid false positives. The OWASP checklist ensures comprehensive coverage.' },

  { id: 'pattern-refactor', name: 'Refactoring', description: 'Safe code refactoring workflow',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Refactoring Workflow\n\n### Step 1: Understand Current State\n- Read the target code thoroughly\n- Map all callers and dependencies with `Grep`\n- Identify the refactoring goal\n\n### Step 2: Plan Changes\nPresent the refactoring plan to the user:\n- What will change and why\n- What will NOT change\n- Risks and mitigation\n\n### Step 3: Execute (after approval)\n- Make changes incrementally\n- Update all call sites\n- Preserve existing behavior exactly\n\n### Step 4: Verify\n- Run existing tests\n- Check for type errors\n- Verify no regressions\n',
    educationalNote: 'Refactoring skills should always plan before executing, update all call sites, and verify with tests. Never change behavior during refactoring.' },

  { id: 'pattern-migration', name: 'Migration', description: 'Database or API migration flow',
    category: 'patterns', types: ['skill'],
    snippet: '## Migration Plan\n\n### Step 1: Audit Current State\n- Catalog all usages of the old API/schema\n- Count affected files with `Grep`\n- Identify breaking changes\n\n### Step 2: Create Migration\n- Write migration script (up + down)\n- Handle data transformation\n- Add rollback capability\n\n### Step 3: Update Code\n- Replace old API calls with new ones\n- Update types and interfaces\n- Update tests\n\n### Step 4: Verify\n- Run migration in dry-run mode\n- Run full test suite\n- Check for orphaned references\n\n### Rollback Plan\nIf migration fails:\n1. Run the down migration\n2. Restore from backup\n3. Report what went wrong\n',
    educationalNote: 'Migration skills need rollback plans. Always write both up and down migrations, and verify with dry-run before executing.' },

  { id: 'pattern-documentation', name: 'Documentation Generator', description: 'Auto-generate docs from code',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Documentation Generation\n\n### Step 1: Scan\nIdentify documentation targets:\n- Public APIs and their parameters\n- Configuration options\n- Architecture patterns\n- Setup/installation steps\n\n### Step 2: Analyze\nFor each target:\n- Read the source code\n- Extract function signatures, types, and comments\n- Identify usage examples from tests\n- Note dependencies and prerequisites\n\n### Step 3: Generate\nWrite documentation following project conventions:\n- Clear description of purpose\n- Parameters with types and defaults\n- Usage examples (from real code when possible)\n- Related functions/components\n',
    educationalNote: 'Documentation generators are more useful when they pull real examples from tests and existing code rather than inventing hypothetical ones.' },

  { id: 'pattern-debug', name: 'Debugging', description: 'Systematic debugging workflow',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Debugging Workflow\n\n### Step 1: Reproduce\nUnderstand the bug from `$ARGUMENTS`.\n- What is the expected behavior?\n- What is the actual behavior?\n- What are the reproduction steps?\n\n### Step 2: Investigate\n- Search for the error message with `Grep`\n- Read the relevant source files\n- Trace the execution path\n- Check recent git changes: `git log --oneline -10`\n\n### Step 3: Identify Root Cause\n- Form a hypothesis\n- Verify by reading the code path\n- Check for off-by-one, null checks, async issues, race conditions\n\n### Step 4: Fix\n- Make the minimal change that fixes the root cause\n- Do NOT refactor surrounding code\n- Add a comment if the fix is non-obvious\n\n### Step 5: Verify\n- Run tests\n- Confirm the original reproduction steps no longer fail\n',
    educationalNote: 'Debugging skills follow a systematic approach: reproduce, investigate, hypothesize, fix, verify. The key is finding root cause, not just symptoms.' },

  { id: 'pattern-git-workflow', name: 'Git Workflow', description: 'Branch, commit, PR workflow',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Git Workflow\n\n### Step 1: Branch\n- Create feature branch: `git checkout -b feature/[name]`\n- Verify clean working tree\n\n### Step 2: Make Changes\n- Implement the feature/fix\n- Stage specific files (avoid `git add .`)\n\n### Step 3: Commit\n- Write clear commit message (why, not what)\n- Follow existing commit style from `git log`\n- Never skip pre-commit hooks\n\n### Step 4: Push & PR\n- Push with `-u` flag: `git push -u origin feature/[name]`\n- Create PR with `gh pr create`\n- Include summary, test plan, and checklist\n\n**Safety**: Never force-push to main. Never amend published commits.\n',
    educationalNote: 'Git workflow skills should always follow safety practices: specific file staging, meaningful commits, never force-push to main.' },

  { id: 'pattern-api-client', name: 'API Client', description: 'HTTP API interaction pattern',
    category: 'patterns', types: ['skill'],
    snippet: '## API Integration\n\n### Configuration\n- Base URL: [endpoint]\n- Auth: Bearer token from environment variable\n- Rate limit: [N] requests per [time]\n\n### Request Pattern\n1. Build the request URL and headers\n2. Validate parameters before sending\n3. Use `WebFetch` to make the request\n4. Parse the JSON response\n5. Handle errors (4xx, 5xx, network)\n\n### Error Handling\n- 401: Token expired — report to user\n- 429: Rate limited — wait and retry once\n- 500: Server error — report and don\'t retry\n- Network error: Report connectivity issue\n',
    educationalNote: 'API client skills should always handle auth, rate limits, and errors gracefully. Never hardcode secrets — use environment variables.' },

  { id: 'pattern-scaffold', name: 'Scaffolding / Generator', description: 'Generate files from templates',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Scaffolding\n\nGenerate project files from the input `$ARGUMENTS`:\n\n### Step 1: Parse Input\nExtract: name, type, options from arguments.\n\n### Step 2: Check Conventions\n- Read existing files to match project style\n- Check naming conventions (kebab-case, PascalCase, etc.)\n- Identify import patterns and directory structure\n\n### Step 3: Generate Files\nFor each file to create:\n1. Verify the directory exists\n2. Check for conflicts (don\'t overwrite)\n3. Write the file using project conventions\n4. Add necessary imports/exports\n\n### Step 4: Report\nList all created files and any manual steps needed.\n',
    educationalNote: 'Scaffolding skills should always check existing conventions before generating. The generated code should look like a human wrote it following project style.' },

  { id: 'pattern-lint-fix', name: 'Lint & Fix', description: 'Find and auto-fix code issues',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Lint & Fix\n\n### Step 1: Identify Issues\nRun the project linter:\n- `npm run lint` or equivalent\n- Parse the output for file:line:message\n- Group issues by severity and type\n\n### Step 2: Auto-Fix\nFor each fixable issue:\n- Read the file\n- Apply the fix using `Edit`\n- Verify the fix doesn\'t break other code\n\n### Step 3: Report Unfixable\nFor issues requiring human judgment:\n- List them with file:line references\n- Explain why auto-fix wasn\'t applied\n- Suggest the recommended fix\n\n### Step 4: Re-Run\nRun the linter again to confirm all auto-fixes are clean.\n',
    educationalNote: 'Lint-fix skills should always re-run the linter after fixing to confirm no regressions. Some issues need human judgment — report those separately.' },

  { id: 'pattern-perf-audit', name: 'Performance Audit', description: 'Identify performance bottlenecks',
    category: 'patterns', types: ['skill', 'agent'],
    snippet: '## Performance Audit\n\n### Check for Common Issues:\n- [ ] **N+1 queries**: Loop with individual DB calls\n- [ ] **Missing indexes**: Queries on unindexed columns\n- [ ] **Unnecessary re-renders**: React components re-rendering without prop changes\n- [ ] **Large bundles**: Importing entire libraries for single functions\n- [ ] **Uncached data**: Repeated expensive computations\n- [ ] **Memory leaks**: Event listeners not cleaned up, growing arrays\n- [ ] **Synchronous blocking**: Long-running sync operations on main thread\n\n### For Each Finding:\n- **Impact**: Estimated performance gain from fixing\n- **Location**: file:line\n- **Fix**: Specific code change needed\n- **Priority**: High (user-facing) / Medium / Low\n',
    educationalNote: 'Performance audits should quantify impact when possible. Prioritize user-facing performance (page load, API response time) over theoretical improvements.' },

  { id: 'pattern-config-wizard', name: 'Configuration Wizard', description: 'Interactive setup with questions',
    category: 'patterns', types: ['skill'],
    snippet: '## Configuration Wizard\n\nGuide the user through setup step by step:\n\n### Step 1: Detect Current State\nCheck what\'s already configured:\n- Read existing config files\n- Check for environment variables\n- Identify missing pieces\n\n### Step 2: Ask Questions\nFor each missing configuration:\n- Use `AskUserQuestion` with clear options\n- Provide recommended defaults\n- Explain what each option does\n\n### Step 3: Generate Config\nBased on answers:\n- Create/update config files\n- Set environment variables\n- Generate any needed boilerplate\n\n### Step 4: Validate\n- Verify the configuration works\n- Run a health check if applicable\n- Report success and next steps\n',
    educationalNote: 'Configuration wizards detect existing state first, then only ask about missing pieces. Always provide recommended defaults.' },

  { id: 'pattern-changelog', name: 'Changelog Generator', description: 'Generate changelog from git history',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Changelog Generation\n\n### Step 1: Get Commits\nRead git history since last tag/release:\n- `git log --oneline [last-tag]..HEAD`\n- Parse commit messages for type (feat, fix, refactor, etc.)\n\n### Step 2: Categorize\nGroup commits by type:\n- **Features**: New functionality\n- **Bug Fixes**: Corrections to existing behavior\n- **Breaking Changes**: Incompatible changes\n- **Other**: Refactors, docs, chores\n\n### Step 3: Format\nGenerate markdown changelog:\n```\n## [version] - YYYY-MM-DD\n\n### Features\n- Description (commit hash)\n\n### Bug Fixes\n- Description (commit hash)\n```\n',
    educationalNote: 'Changelog generators work best when the project follows conventional commit format (feat:, fix:, etc.). They parse git history automatically.' },

  { id: 'pattern-search-replace', name: 'Search & Replace', description: 'Project-wide find and replace',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Project-Wide Search & Replace\n\n### Step 1: Find All Occurrences\nUse `Grep` to find every occurrence of the target:\n- Search with regex for variations (imports, usages, references)\n- Count total occurrences and affected files\n- Present the full list to the user\n\n### Step 2: Confirm\nShow the replacement plan:\n- **Find**: `[old pattern]`\n- **Replace**: `[new pattern]`\n- **Files affected**: [N]\n- **Occurrences**: [N]\n\nAsk for confirmation before proceeding.\n\n### Step 3: Replace\nFor each file:\n- Read the file\n- Apply the replacement using `Edit`\n- Verify the replacement is correct\n\n### Step 4: Verify\n- Run `Grep` again to confirm zero remaining occurrences\n- Run tests to check for regressions\n',
    educationalNote: 'Search & replace skills should always show the full scope before executing. Regex helps catch variations (imports, type refs, comments).' },

  { id: 'pattern-dependency', name: 'Dependency Check', description: 'Audit and update dependencies',
    category: 'patterns', types: ['skill', 'command'],
    snippet: '## Dependency Audit\n\n### Step 1: Scan\n- Read package.json (or equivalent)\n- Check for outdated packages\n- Identify security vulnerabilities\n\n### Step 2: Analyze\nFor each outdated/vulnerable dependency:\n- Check the changelog for breaking changes\n- Assess update risk (major vs minor vs patch)\n- Check if the project uses affected APIs\n\n### Step 3: Recommend\nPresent update plan:\n- **Safe updates** (patch/minor, no breaking changes)\n- **Risky updates** (major, has breaking changes)\n- **Do not update** (known incompatibilities)\n\n### Step 4: Update (with approval)\n- Apply safe updates first\n- Run tests after each group\n- Report any failures\n',
    educationalNote: 'Dependency audits should always check changelogs for breaking changes before updating. Group updates by risk level.' },
];

function loadCustomPresets() {
  try {
    return JSON.parse(storage.getItem(PRESETS_KEY) || '[]');
  } catch { return []; }
}

function saveCustomPresets(arr) {
  storage.setItem(PRESETS_KEY, JSON.stringify(arr));
}

function getPresetsForType(type) {
  const builtIn = BUILTIN_PRESETS.filter(p => p.types.length === 0 || p.types.includes(type));
  const custom = loadCustomPresets();
  return { builtIn, custom };
}

function isPresetPanelOpen() {
  return storage.getItem(PRESETS_PANEL_KEY) !== 'false'; // default open
}

function getPresetCollapsed() {
  try { return JSON.parse(storage.getItem(PRESETS_COLLAPSED_KEY) || '{}'); }
  catch { return {}; }
}

// ═══════════════════════════════════════════
// PRESET PANEL RENDERING
// ═══════════════════════════════════════════

function renderPresetPanel() {
  const panel = $('ss-preset-panel');
  if (!panel) return;

  const type = _wizardData.type;
  const { builtIn, custom } = getPresetsForType(type);
  const collapsed = getPresetCollapsed();

  const groups = {
    structural: builtIn.filter(p => p.category === 'structural'),
    frontmatter: builtIn.filter(p => p.category === 'frontmatter'),
    patterns: builtIn.filter(p => p.category === 'patterns'),
    custom: custom,
  };

  panel.innerHTML = Object.entries(groups).map(([catKey, presets]) => {
    const cat = PRESET_CATEGORIES[catKey];
    const isCollapsed = collapsed[catKey] === true;
    const isCustom = catKey === 'custom';

    return `
      <div class="ss-preset-category${isCollapsed ? ' collapsed' : ''}">
        <div class="ss-preset-cat-hdr" data-cat="${catKey}">
          <span class="ss-preset-chevron">${isCollapsed ? '\u25B6' : '\u25BC'}</span>
          <span class="ss-preset-cat-name">${cat.label}</span>
          <span class="ss-preset-cat-count">${presets.length}</span>
          ${isCustom ? `
            <div class="ss-preset-custom-actions">
              <button class="ss-preset-act-btn ss-preset-act-add" data-action="add" data-tooltip="New preset"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
              <button class="ss-preset-act-btn ss-preset-act-import" data-action="import" data-tooltip="Import presets"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="7 10 12 5 17 10"/><line x1="12" y1="5" x2="12" y2="19"/></svg></button>
              <button class="ss-preset-act-btn ss-preset-act-export" data-action="export" data-tooltip="Export presets"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="7 14 12 19 17 14"/><line x1="12" y1="19" x2="12" y2="5"/></svg></button>
            </div>
          ` : ''}
        </div>
        <div class="ss-preset-cat-body">
          ${isCustom ? '<div id="ss-preset-custom-form"></div>' : ''}
          ${presets.map(p => renderPresetCard(p, isCustom)).join('')}
          ${presets.length === 0 && !isCustom ? '<div class="ss-preset-empty">No presets for this type</div>' : ''}
          ${presets.length === 0 && isCustom ? '<div class="ss-preset-empty">Click + to create a preset</div>' : ''}
        </div>
      </div>
    `;
  }).join('');

  wirePresetPanel(panel);
}

function renderPresetCard(preset, isCustom) {
  return `
    <div class="ss-preset-card" draggable="true" data-preset-id="${preset.id}"
         data-tooltip="${esc(preset.educationalNote || preset.description || '')}" data-tooltip-pos="right">
      <div class="ss-preset-card-name">${esc(preset.name)}</div>
      ${preset.description ? `<div class="ss-preset-card-desc">${esc(preset.description)}</div>` : ''}
      ${isCustom ? `
        <div class="ss-preset-card-actions">
          <button class="ss-preset-edit-btn" data-id="${preset.id}" data-tooltip="Edit">&#9998;</button>
          <button class="ss-preset-del-btn" data-id="${preset.id}" data-tooltip="Delete">&times;</button>
        </div>
      ` : ''}
    </div>
  `;
}

function wirePresetPanel(panel) {
  // Accordion toggle
  panel.querySelectorAll('.ss-preset-cat-hdr').forEach(hdr => {
    hdr.addEventListener('click', (e) => {
      if (e.target.closest('.ss-preset-act-btn') || e.target.closest('.ss-preset-custom-actions')) return; // don't toggle on action buttons
      const cat = hdr.dataset.cat;
      const section = hdr.closest('.ss-preset-category');
      section.classList.toggle('collapsed');
      const collapsed = getPresetCollapsed();
      collapsed[cat] = section.classList.contains('collapsed');
      storage.setItem(PRESETS_COLLAPSED_KEY, JSON.stringify(collapsed));
      hdr.querySelector('.ss-preset-chevron').textContent = collapsed[cat] ? '\u25B6' : '\u25BC';
    });
  });

  // Custom action buttons
  panel.querySelectorAll('.ss-preset-act-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'add') showCustomPresetForm();
      else if (action === 'import') importCustomPresets();
      else if (action === 'export') exportCustomPresets();
    });
  });

  // Edit/delete custom preset
  panel.querySelectorAll('.ss-preset-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const customs = loadCustomPresets();
      const preset = customs.find(p => p.id === id);
      if (preset) showCustomPresetForm(preset);
    });
  });
  panel.querySelectorAll('.ss-preset-del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('Delete this preset?')) return;
      const customs = loadCustomPresets().filter(p => p.id !== id);
      saveCustomPresets(customs);
      renderPresetPanel();
      toast('Preset deleted', 'info');
    });
  });

  // Drag-and-drop on preset cards
  panel.querySelectorAll('.ss-preset-card').forEach(card => {
    const presetId = card.dataset.presetId;
    const preset = findPresetById(presetId);
    if (!preset) return;

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', preset.snippet);
      e.dataTransfer.setData('application/x-synabun-preset', JSON.stringify({
        id: preset.id, name: preset.name, snippet: preset.snippet
      }));
      e.dataTransfer.effectAllowed = 'copy';
      const ghost = document.createElement('div');
      ghost.className = 'ss-preset-drag-ghost';
      ghost.textContent = preset.name;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 0, 0);
      requestAnimationFrame(() => ghost.remove());
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));

    // Click to insert
    card.addEventListener('click', (e) => {
      if (e.target.closest('.ss-preset-edit-btn, .ss-preset-del-btn')) return;
      insertPresetSnippet(preset.snippet);
      card.classList.add('ss-preset-inserted');
      setTimeout(() => card.classList.remove('ss-preset-inserted'), 600);
    });
  });
}

function findPresetById(id) {
  const builtIn = BUILTIN_PRESETS.find(p => p.id === id);
  if (builtIn) return builtIn;
  return loadCustomPresets().find(p => p.id === id);
}

function insertPresetSnippet(snippet) {
  const editor = $('ss-wiz-content');
  if (!editor) return;

  // Switch to raw mode if in preview
  if (_wizPreviewMode) {
    _panel?.querySelector('.ss-view-toggle-btn[data-mode="raw"]')?.click();
  }

  const pos = editor.selectionStart;
  const before = editor.value.substring(0, pos);
  const after = editor.value.substring(editor.selectionEnd);
  const pad = before.length > 0 && !before.endsWith('\n\n')
    ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const trail = after.length > 0 && !after.startsWith('\n') ? '\n' : '';

  editor.value = before + pad + snippet + trail + after;
  const newPos = before.length + pad.length + snippet.length;
  editor.selectionStart = editor.selectionEnd = newPos;
  editor.focus();
}

function togglePresetPanel() {
  const panel = $('ss-preset-panel');
  const btn = $('ss-preset-toggle');
  if (!panel || !btn) return;
  const isOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', isOpen);
  btn.classList.toggle('active', !isOpen);
  storage.setItem(PRESETS_PANEL_KEY, !isOpen ? 'true' : 'false');
}

// ── Custom preset CRUD ──

function showCustomPresetForm(existing = null) {
  const container = $('ss-preset-custom-form');
  if (!container) return;
  const editor = $('ss-wiz-content');
  const selection = editor ? editor.value.substring(editor.selectionStart, editor.selectionEnd) : '';

  container.innerHTML = `
    <div class="ss-preset-form">
      <input class="ss-input ss-preset-form-name" id="ss-pf-name" placeholder="Preset name" value="${esc(existing?.name || '')}">
      <input class="ss-input ss-preset-form-desc" id="ss-pf-desc" placeholder="Description (optional)" value="${esc(existing?.description || '')}">
      <textarea class="ss-preset-form-snippet" id="ss-pf-snippet" placeholder="Snippet content">${esc(existing?.snippet || selection)}</textarea>
      <div class="ss-preset-form-actions">
        <button class="ss-header-btn" id="ss-pf-cancel">Cancel</button>
        <button class="ss-header-btn ss-save-btn" id="ss-pf-save">${existing ? 'Update' : 'Save'}</button>
      </div>
    </div>
  `;

  $('ss-pf-cancel')?.addEventListener('click', () => { container.innerHTML = ''; });
  $('ss-pf-save')?.addEventListener('click', () => {
    const name = $('ss-pf-name')?.value.trim();
    const desc = $('ss-pf-desc')?.value.trim();
    const snippet = $('ss-pf-snippet')?.value;
    if (!name) { toast('Name is required', 'error'); return; }
    if (!snippet) { toast('Snippet content is required', 'error'); return; }

    const customs = loadCustomPresets();
    if (existing) {
      const idx = customs.findIndex(p => p.id === existing.id);
      if (idx >= 0) customs[idx] = { ...customs[idx], name, description: desc, snippet };
    } else {
      customs.push({
        id: 'custom-' + Date.now(),
        name, description: desc, snippet,
        category: 'custom', types: [],
      });
    }
    saveCustomPresets(customs);
    renderPresetPanel();
    toast(existing ? 'Preset updated' : 'Preset saved', 'info');
  });

  // Scroll to form and focus
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('ss-pf-name')?.focus();
}

// ── Import / Export ──

function exportCustomPresets() {
  const customs = loadCustomPresets();
  if (customs.length === 0) { toast('No custom presets to export', 'error'); return; }
  const bundle = {
    format: 'synabun-presets-v1',
    exportedAt: new Date().toISOString(),
    presets: customs,
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `skill-presets-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${customs.length} preset(s)`, 'info');
}

function importCustomPresets() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      if (bundle.format !== 'synabun-presets-v1' || !Array.isArray(bundle.presets)) {
        toast('Invalid preset bundle format', 'error'); return;
      }
      const customs = loadCustomPresets();
      const existingIds = new Set(customs.map(p => p.id));
      let imported = 0, skipped = 0;
      for (const p of bundle.presets) {
        if (!p.name || !p.snippet) { skipped++; continue; }
        if (existingIds.has(p.id)) { skipped++; continue; }
        customs.push({ ...p, category: 'custom', id: p.id || ('custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)) });
        imported++;
      }
      saveCustomPresets(customs);
      renderPresetPanel();
      toast(`Imported ${imported} preset(s)${skipped > 0 ? `, skipped ${skipped}` : ''}`, 'info');
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    }
  });
  input.click();
}

function renderWizard() {
  const main = $('ss-main');
  if (!main) return;

  const steps = ['Type', 'Template', 'Details', 'Content'];
  const d = _wizardData;

  main.innerHTML = `
    <div class="ss-wizard">
      <div class="ss-wizard-steps">
        ${steps.map((s, i) => `<div class="ss-wizard-step${i === _wizardStep ? ' active' : ''}${i < _wizardStep ? ' done' : ''}">${i + 1}. ${s}</div>`).join('')}
      </div>
      <div class="ss-wizard-content" id="ss-wizard-content"></div>
      <div class="ss-wizard-nav">
        ${_wizardStep > 0 ? '<button class="ss-header-btn" id="ss-wiz-prev">\u2190 Back</button>' : '<span></span>'}
        ${_wizardStep < 3 ? '<button class="ss-header-btn ss-save-btn" id="ss-wiz-next">Next \u2192</button>' : '<button class="ss-header-btn ss-save-btn" id="ss-wiz-create">Create</button>'}
      </div>
    </div>
  `;

  renderWizardStep();

  $('ss-wiz-prev')?.addEventListener('click', () => { collectWizardData(); _wizardStep--; renderWizard(); });
  $('ss-wiz-next')?.addEventListener('click', () => {
    if (collectWizardData()) { _wizardStep++; renderWizard(); }
  });
  $('ss-wiz-create')?.addEventListener('click', () => {
    if (collectWizardData()) createFromWizard();
  });
}

function renderWizardStep() {
  const container = $('ss-wizard-content');
  if (!container) return;
  const d = _wizardData;

  if (_wizardStep === 0) {
    // Type selection
    container.innerHTML = `
      <h3>What do you want to create?</h3>
      <div class="ss-type-cards">
        <div class="ss-type-card${d.type === 'skill' ? ' selected' : ''}" data-type="skill">
          <div class="ss-type-card-icon skill"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="4"/></svg></div>
          <div class="ss-type-card-name">Skill</div>
          <div class="ss-type-card-desc">Auto-detected by Claude or invoked via /name. Supports sub-files for references and examples.</div>
        </div>
        <div class="ss-type-card${d.type === 'command' ? ' selected' : ''}" data-type="command">
          <div class="ss-type-card-icon command"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></div>
          <div class="ss-type-card-name">Command</div>
          <div class="ss-type-card-desc">User-invoked via /name. Simple single-file format. Project-scoped.</div>
        </div>
        <div class="ss-type-card${d.type === 'agent' ? ' selected' : ''}" data-type="agent">
          <div class="ss-type-card-icon agent"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="12" rx="3"/><line x1="9" y1="9" x2="9" y2="9.01" stroke-width="2"/><line x1="15" y1="9" x2="15" y2="9.01" stroke-width="2"/><path d="M8 20v-4M16 20v-4"/><path d="M1 10h3M20 10h3"/></svg></div>
          <div class="ss-type-card-name">Agent</div>
          <div class="ss-type-card-desc">Specialized subagent delegated via the Task tool. Runs in its own context window.</div>
        </div>
      </div>
    `;
    container.querySelectorAll('.ss-type-card').forEach(card => {
      card.addEventListener('click', () => {
        d.type = card.dataset.type;
        d.template = 'blank';
        container.querySelectorAll('.ss-type-card').forEach(c => c.classList.toggle('selected', c === card));
      });
    });
  } else if (_wizardStep === 1) {
    // Template selection
    const templates = d.type === 'skill' ? SKILL_TEMPLATES : d.type === 'command' ? COMMAND_TEMPLATES : AGENT_TEMPLATES;
    container.innerHTML = `
      <h3>Choose a template</h3>
      <div class="ss-template-list">
        ${Object.entries(templates).map(([key, t]) => `
          <div class="ss-template-item${d.template === key ? ' selected' : ''}" data-tpl="${key}">
            <div class="ss-template-name">${t.label}</div>
            <div class="ss-template-desc">${t.desc}</div>
          </div>
        `).join('')}
      </div>
    `;
    container.querySelectorAll('.ss-template-item').forEach(item => {
      item.addEventListener('click', () => {
        d.template = item.dataset.tpl;
        container.querySelectorAll('.ss-template-item').forEach(i => i.classList.toggle('selected', i === item));
      });
    });
  } else if (_wizardStep === 2) {
    // Details
    container.innerHTML = `
      <h3>Details</h3>
      <div class="ss-field">
        <label>Name <span class="ss-field-hint">Becomes /${d.type === 'skill' ? 'skill-name' : 'command-name'}</span></label>
        <input type="text" class="ss-input" id="ss-wiz-name" value="${esc(d.name)}" placeholder="my-${d.type}" pattern="[a-z][a-z0-9-.]*">
        <div class="ss-wiz-name-preview" id="ss-wiz-name-preview">/${esc(d.name || `my-${d.type}`)}</div>
      </div>
      <div class="ss-field">
        <label>Scope</label>
        <div class="ss-radio-group">
          <label class="ss-radio"><input type="radio" name="wiz-scope" value="global" ${d.scope === 'global' ? 'checked' : ''}> Global (~/.claude/)</label>
          <label class="ss-radio"><input type="radio" name="wiz-scope" value="project" ${d.scope === 'project' ? 'checked' : ''}> Project</label>
        </div>
      </div>
      <div class="ss-field ${d.scope !== 'project' ? 'ss-hidden' : ''}" id="ss-wiz-project-field">
        <label>Project</label>
        <select class="ss-input" id="ss-wiz-project">
          ${_projects.map(p => `<option value="${esc(p.path)}" ${d.projectPath === p.path ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
        </select>
      </div>
      <div class="ss-field">
        <label>Description</label>
        <textarea class="ss-textarea ss-textarea-sm" id="ss-wiz-desc" placeholder="What triggers this ${d.type}...">${esc(d.description)}</textarea>
      </div>
    `;
    $('ss-wiz-name')?.addEventListener('input', (e) => {
      d.name = e.target.value;
      const preview = $('ss-wiz-name-preview');
      if (preview) preview.textContent = '/' + (d.name || `my-${d.type}`);
    });
    _panel.querySelectorAll('input[name="wiz-scope"]').forEach(r => {
      r.addEventListener('change', () => {
        d.scope = r.value;
        const projField = $('ss-wiz-project-field');
        if (projField) projField.classList.toggle('ss-hidden', d.scope !== 'project');
      });
    });
  } else if (_wizardStep === 3) {
    // Content editor with preset side panel
    const templates = d.type === 'skill' ? SKILL_TEMPLATES : d.type === 'command' ? COMMAND_TEMPLATES : AGENT_TEMPLATES;
    const tpl = templates[d.template] || templates.blank;
    const content = d.rawContent || tpl.gen(d.name || `my-${d.type}`);
    const panelOpen = isPresetPanelOpen();
    container.innerHTML = `
      <div class="ss-wiz-step4-hdr">
        <h3>Review & Edit</h3>
        <button class="ss-preset-toggle${panelOpen ? ' active' : ''}" id="ss-preset-toggle">Presets</button>
      </div>
      <p class="ss-wizard-hint">Edit the generated content below. Click or drag presets to insert snippets.</p>
      <div class="ss-wiz-step4-body">
        <div class="ss-wiz-editor-wrap">
          <div class="ss-md-toolbar" id="ss-wiz-toolbar">
            <button class="ss-md-tool" data-cmd="heading" data-tooltip="Heading (Ctrl+H)"><svg viewBox="0 0 24 24"><path d="M4 4v16M20 4v16M4 12h16"/></svg></button>
            <button class="ss-md-tool" data-cmd="bold" data-tooltip="Bold (Ctrl+B)"><b style="font-size:13px">B</b></button>
            <button class="ss-md-tool" data-cmd="italic" data-tooltip="Italic (Ctrl+I)"><i style="font-size:13px">I</i></button>
            <button class="ss-md-tool" data-cmd="strikethrough" data-tooltip="Strikethrough"><s style="font-size:12px">S</s></button>
            <div class="ss-md-toolbar-sep"></div>
            <button class="ss-md-tool" data-cmd="ul" data-tooltip="Bullet list"><svg viewBox="0 0 24 24"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg></button>
            <button class="ss-md-tool" data-cmd="ol" data-tooltip="Numbered list"><svg viewBox="0 0 24 24"><line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="4" y="8" font-size="7" fill="currentColor" stroke="none" font-weight="600">1</text><text x="4" y="14" font-size="7" fill="currentColor" stroke="none" font-weight="600">2</text><text x="4" y="20" font-size="7" fill="currentColor" stroke="none" font-weight="600">3</text></svg></button>
            <button class="ss-md-tool" data-cmd="quote" data-tooltip="Blockquote"><svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h12"/><rect x="1" y="5" width="2" height="14" rx="1" fill="currentColor" stroke="none" opacity="0.4"/></svg></button>
            <div class="ss-md-toolbar-sep"></div>
            <button class="ss-md-tool" data-cmd="code" data-tooltip="Inline code"><svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></button>
            <button class="ss-md-tool" data-cmd="codeblock" data-tooltip="Code block"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 8 5 12 9 16" stroke-width="1.5"/><polyline points="15 8 19 12 15 16" stroke-width="1.5"/></svg></button>
            <button class="ss-md-tool" data-cmd="link" data-tooltip="Link (Ctrl+K)"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
            <button class="ss-md-tool" data-cmd="hr" data-tooltip="Horizontal rule">&mdash;</button>
            <div class="ss-view-toggle">
              <button class="ss-view-toggle-btn${_wizPreviewMode ? '' : ' active'}" data-mode="raw">Raw</button>
              <button class="ss-view-toggle-btn${_wizPreviewMode ? ' active' : ''}" data-mode="preview">Preview</button>
            </div>
          </div>
          <textarea class="ss-md-editor ss-wizard-editor${_wizPreviewMode ? ' ss-hidden' : ''}" id="ss-wiz-content" spellcheck="false" autocorrect="off" autocapitalize="off">${esc(content)}</textarea>
          <div class="ss-md-preview ss-wizard-preview${_wizPreviewMode ? ' visible' : ''}" id="ss-wiz-preview">${_wizPreviewMode ? renderMarkdown(content) : ''}</div>
        </div>
        <div class="ss-preset-panel${panelOpen ? '' : ' hidden'}" id="ss-preset-panel"></div>
      </div>
    `;
    wireWizardEditor();
    renderPresetPanel();
    $('ss-preset-toggle')?.addEventListener('click', togglePresetPanel);
  }
}

function wireWizardEditor() {
  const edId = 'ss-wiz-content';
  const editor = $(edId);
  const toolbar = $('ss-wiz-toolbar');
  if (!editor || !toolbar) return;

  // Helper: get editor element (for md* functions)
  const getEd = () => $(edId);

  // Tab key support (indentation)
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
      editor.selectionStart = editor.selectionEnd = start + 2;
    }
  });

  // Toolbar click handlers
  toolbar.querySelectorAll('.ss-md-tool[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ed = getEd();
      if (!ed) return;
      const cmd = btn.dataset.cmd;
      switch (cmd) {
        case 'bold':          wizMdWrap(ed, '**', '**'); break;
        case 'italic':        wizMdWrap(ed, '*', '*'); break;
        case 'strikethrough': wizMdWrap(ed, '~~', '~~'); break;
        case 'code':          wizMdWrap(ed, '`', '`'); break;
        case 'codeblock':     wizMdWrapBlock(ed, '```\n', '\n```'); break;
        case 'heading':       wizMdPrefix(ed, '## '); break;
        case 'ul':            wizMdPrefix(ed, '- '); break;
        case 'ol':            wizMdPrefix(ed, '1. '); break;
        case 'quote':         wizMdPrefix(ed, '> '); break;
        case 'link':          wizMdLink(ed); break;
        case 'hr':            wizMdInsert(ed, '\n---\n'); break;
      }
    });
  });

  // Ctrl+B/I/K/H shortcuts
  editor.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      const ed = getEd();
      if (!ed) return;
      if (e.key === 'b') { e.preventDefault(); wizMdWrap(ed, '**', '**'); }
      else if (e.key === 'i') { e.preventDefault(); wizMdWrap(ed, '*', '*'); }
      else if (e.key === 'k') { e.preventDefault(); wizMdLink(ed); }
      else if (e.key === 'h') { e.preventDefault(); wizMdPrefix(ed, '## '); }
    }
  });

  // Preview/Raw toggle
  toolbar.querySelectorAll('.ss-view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      _wizPreviewMode = mode === 'preview';
      toolbar.querySelectorAll('.ss-view-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      const ed = getEd();
      const prev = $('ss-wiz-preview');
      if (ed) ed.classList.toggle('ss-hidden', _wizPreviewMode);
      if (prev) {
        prev.classList.toggle('visible', _wizPreviewMode);
        if (_wizPreviewMode) {
          prev.innerHTML = renderMarkdown(ed?.value || '');
        }
      }
      // Hide formatting tools in preview mode
      toolbar.querySelectorAll('.ss-md-tool').forEach(t => t.style.visibility = _wizPreviewMode ? 'hidden' : '');
    });
  });

  // Drag-and-drop target on textarea
  editor.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-synabun-preset') ||
        e.dataTransfer.types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      editor.classList.add('ss-drop-target');
    }
  });
  editor.addEventListener('dragleave', (e) => {
    if (!editor.contains(e.relatedTarget)) {
      editor.classList.remove('ss-drop-target');
    }
  });
  editor.addEventListener('drop', (e) => {
    e.preventDefault();
    editor.classList.remove('ss-drop-target');
    const presetData = e.dataTransfer.getData('application/x-synabun-preset');
    const snippet = presetData
      ? JSON.parse(presetData).snippet
      : e.dataTransfer.getData('text/plain');
    if (!snippet) return;
    insertPresetSnippet(snippet);
  });
}

// ── Wizard markdown helpers (operate on passed editor element) ──

function wizMdWrap(ed, before, after) {
  const start = ed.selectionStart, end = ed.selectionEnd;
  const sel = ed.value.substring(start, end);
  const text = sel || 'text';
  const replacement = before + text + after;
  ed.setRangeText(replacement, start, end, 'select');
  ed.selectionStart = start + before.length;
  ed.selectionEnd = start + before.length + text.length;
  ed.focus();
}

function wizMdWrapBlock(ed, before, after) {
  const start = ed.selectionStart, end = ed.selectionEnd;
  const sel = ed.value.substring(start, end);
  const text = sel || 'code here';
  const needNewlineBefore = start > 0 && ed.value[start - 1] !== '\n' ? '\n' : '';
  const needNewlineAfter = end < ed.value.length && ed.value[end] !== '\n' ? '\n' : '';
  const replacement = needNewlineBefore + before + text + after + needNewlineAfter;
  ed.setRangeText(replacement, start, end, 'select');
  ed.focus();
}

function wizMdPrefix(ed, prefix) {
  const start = ed.selectionStart, end = ed.selectionEnd;
  const before = ed.value.substring(0, start);
  const lineStart = before.lastIndexOf('\n') + 1;
  const sel = ed.value.substring(lineStart, end);
  const lines = sel.split('\n');
  const prefixed = lines.map(line => {
    if (line.startsWith(prefix)) return line.substring(prefix.length);
    return prefix + line.replace(/^(#{1,6}\s|[-*]\s|\d+\.\s|>\s)/, '');
  }).join('\n');
  ed.setRangeText(prefixed, lineStart, end, 'select');
  ed.focus();
}

function wizMdLink(ed) {
  const start = ed.selectionStart, end = ed.selectionEnd;
  const sel = ed.value.substring(start, end);
  const text = sel || 'link text';
  const replacement = `[${text}](url)`;
  ed.setRangeText(replacement, start, end, 'select');
  ed.selectionStart = start + text.length + 3;
  ed.selectionEnd = start + text.length + 6;
  ed.focus();
}

function wizMdInsert(ed, text) {
  const pos = ed.selectionStart;
  ed.setRangeText(text, pos, ed.selectionEnd, 'end');
  ed.focus();
}

function collectWizardData() {
  const d = _wizardData;
  if (_wizardStep === 2) {
    const nameEl = $('ss-wiz-name');
    const descEl = $('ss-wiz-desc');
    const projEl = $('ss-wiz-project');
    if (nameEl) d.name = nameEl.value.trim();
    if (descEl) d.description = descEl.value.trim();
    if (projEl) d.projectPath = projEl.value;
    if (!d.name) { toast('Name is required', 'error'); return false; }
    if (!/^[a-z][a-z0-9-.]*$/.test(d.name)) { toast('Name must be lowercase, start with a letter', 'error'); return false; }
  }
  if (_wizardStep === 3) {
    const contentEl = $('ss-wiz-content');
    if (contentEl) d.rawContent = contentEl.value;
  }
  return true;
}

async function createFromWizard() {
  const d = _wizardData;
  const contentEl = $('ss-wiz-content');
  if (contentEl) d.rawContent = contentEl.value;
  if (!d.rawContent) { toast('Content is required', 'error'); return; }

  try {
    const result = await createSkillsArtifact({
      type: d.type,
      scope: d.scope,
      projectPath: d.projectPath,
      name: d.name,
      rawContent: d.rawContent,
    });
    toast(`Created "${d.name}"!`, 'info');
    await loadLibrary();
    // Find the newly created artifact and open it
    const newArtifact = _library.find(a => a.name === d.name || a.dirName === d.name);
    if (newArtifact) {
      switchToEditor(newArtifact);
    } else {
      switchToLibrary();
    }
  } catch (err) {
    toast('Create failed: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════
// IMPORT
// ═══════════════════════════════════════════

function triggerImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.skill.json,.command.json,.agent.json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      if (bundle.format !== 'synabun-skill-bundle') {
        toast('Invalid bundle format', 'error');
        return;
      }
      // Ask for scope
      const scope = prompt('Import scope (global or project):', 'global');
      if (!scope) return;
      let projectPath = '';
      if (scope === 'project' && _projects.length > 0) {
        projectPath = _projects[0].path; // default to first project
      }
      const result = await importSkillsBundle(bundle, scope, projectPath);
      toast(`Imported "${result.name}"!`, 'info');
      await loadLibrary();
      renderLibrary();
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    }
  });
  input.click();
}

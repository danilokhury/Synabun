// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio
// Browse, edit, create, import/export Claude Code
// skills, commands, and agents.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
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
let _view = 'library';     // 'library' | 'editor' | 'wizard'
let _editorDirty = false;
let _wizardStep = 0;
let _wizardData = {};
let _previewMode = false;   // false = raw editor, true = rendered preview
let _focusMode = false;     // darkens backdrop fully

// ── Tab system ──
// Each tab: { id, artifactId, artifact, artifactContent, label, path, content, originalContent, dirty }
// Tabs persist across artifact selections — clicking a new skill adds a tab
let _tabs = [];
let _activeTabIdx = 0;

// ── Constants ──
const PANEL_KEY = 'neural-panel-skills-studio';
const TYPE_ICONS = {
  skill: `<svg viewBox="0 0 16 16" width="14" height="14"><polygon points="8.7 1.3 2 9.3 8 9.3 7.3 14.7 14 6.7 8 6.7 8.7 1.3" fill="currentColor"/></svg>`,
  command: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 11.5 7 8 3 4.5"/><line x1="8.5" y1="12" x2="13" y2="12"/></svg>`,
  agent: `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="5.5" r="3" fill="currentColor"/><path d="M2.5 14.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" fill="currentColor"/></svg>`,
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
  if (tab) {
    tab.content = editor.value;
    tab.dirty = tab.content !== tab.originalContent;
  }
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
  _backdrop.addEventListener('click', () => closePanel());
  document.body.appendChild(_backdrop);

  // Panel
  _panel = document.createElement('div');
  _panel.className = 'skills-studio-panel glass resizable';
  _panel.id = 'skills-studio-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  // Restore position
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_KEY));
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
    localStorage.setItem(PANEL_KEY, JSON.stringify({
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
    _activeTabIdx = existingIdx;
    _selected = _tabs[existingIdx].artifact;
    _selectedContent = _tabs[existingIdx].artifactContent;
    _view = 'editor';
    _previewMode = false;
    renderEditor();
    renderLibrary();
    return;
  }

  // Save current tab content before adding new tab
  if (_tabs.length > 0) storeActiveTabContent();

  _view = 'editor';
  renderLibrary();
  const main = $('ss-main');
  if (main) main.innerHTML = '<div class="ss-loading">Loading...</div>';
  try {
    const id = encodeId(artifact.id);
    const data = await fetchSkillsArtifact(id);
    _selected = artifact;
    _selectedContent = data;

    // Create a new tab for this artifact's main file
    _tabs.push({
      id: `main:${artifact.id}`, artifactId: artifact.id,
      artifact: artifact, artifactContent: data,
      label: artifact.name, path: null,
      content: data.rawContent || '', originalContent: data.rawContent || '', dirty: false,
    });
    _activeTabIdx = _tabs.length - 1;
    _previewMode = false;
    renderEditor();
  } catch (err) {
    console.error('Failed to load artifact', err);
    toast('Failed to load artifact', 'error');
    // If we have other tabs, stay on them
    if (_tabs.length > 0) {
      const tab = activeTab();
      _selected = tab.artifact;
      _selectedContent = tab.artifactContent;
      renderEditor();
    } else {
      switchToLibrary();
    }
  }
}

function switchToWizard() {
  _view = 'wizard';
  _wizardStep = 0;
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
    loadActiveTabContent();
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
      <div class="ss-fd-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span>Add File</span>
      </div>

      <div class="ss-fd-body">
        <div class="ss-fd-section-label">Location</div>
        <div class="ss-fd-dirs">
          ${tree.map(d => `
            <div class="ss-fd-dir${d.path === selectedDir ? ' selected' : ''}" data-path="${esc(d.path)}" style="padding-left:${d.depth * 16 + 8}px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                ${d.path === selectedDir
                  ? '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="var(--accent-blue)" stroke="var(--accent-blue)" opacity="0.7"/>'
                  : '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'}
              </svg>
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

        <div class="ss-fd-divider"></div>

        <div class="ss-fd-action-group">
          <div class="ss-fd-action">
            <div class="ss-fd-action-label">Create New</div>
            <div class="ss-fd-filename-row">
              <span class="ss-fd-path-prefix">${esc(pathPreview)}</span>
              <input type="text" class="ss-input ss-fd-input ss-fd-filename-input" id="ss-fd-filename" placeholder="my-file.md" spellcheck="false" autocomplete="off">
            </div>
            <button class="ss-fd-action-btn ss-fd-create-btn" id="ss-fd-create">Create</button>
          </div>

          <div class="ss-fd-action">
            <div class="ss-fd-action-label">Or Upload</div>
            <button class="ss-fd-upload-btn" id="ss-fd-upload-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span>Choose File</span>
            </button>
            <input type="file" id="ss-fd-upload-input" style="display:none">
          </div>
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

function setDirty() {
  // Delegate to tab-based dirty tracking
  storeActiveTabContent();
  updateDirtyState();
}

async function saveCurrentArtifact() {
  const tab = activeTab();
  if (!tab.artifact || !tab.artifactContent) return;

  storeActiveTabContent();
  const id = encodeId(tab.artifactId);

  try {
    if (tab.path === null) {
      await saveSkillsArtifact(id, tab.content);
      tab.originalContent = tab.content;
      tab.dirty = false;
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
      primaryTextColor: '#e0e0e0', lineColor: '#4a90d9', secondaryColor: '#2a2a4a',
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

  $('ss-wiz-prev')?.addEventListener('click', () => { _wizardStep--; renderWizard(); });
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
          <div class="ss-type-card-icon skill"><svg viewBox="0 0 24 24" width="28" height="28"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"/></svg></div>
          <div class="ss-type-card-name">Skill</div>
          <div class="ss-type-card-desc">Auto-detected by Claude or invoked via /name. Supports sub-files for references and examples.</div>
        </div>
        <div class="ss-type-card${d.type === 'command' ? ' selected' : ''}" data-type="command">
          <div class="ss-type-card-icon command"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></div>
          <div class="ss-type-card-name">Command</div>
          <div class="ss-type-card-desc">User-invoked via /name. Simple single-file format. Project-scoped.</div>
        </div>
        <div class="ss-type-card${d.type === 'agent' ? ' selected' : ''}" data-type="agent">
          <div class="ss-type-card-icon agent"><svg viewBox="0 0 24 24" width="28" height="28"><circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" fill="currentColor"/></svg></div>
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
    // Content preview
    const templates = d.type === 'skill' ? SKILL_TEMPLATES : d.type === 'command' ? COMMAND_TEMPLATES : AGENT_TEMPLATES;
    const tpl = templates[d.template] || templates.blank;
    const content = tpl.gen(d.name || `my-${d.type}`);
    container.innerHTML = `
      <h3>Review & Edit</h3>
      <p class="ss-wizard-hint">Edit the generated content below before creating.</p>
      <textarea class="ss-md-editor ss-wizard-editor" id="ss-wiz-content" spellcheck="false">${esc(content)}</textarea>
    `;
  }
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

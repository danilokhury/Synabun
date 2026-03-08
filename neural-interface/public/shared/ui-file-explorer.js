// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer
// ═══════════════════════════════════════════
//
// Docked sidebar that shows project files in a tree view.
// Sits adjacent to the Memory Explorer (to its right).

import { KEYS } from './constants.js';
import { registerAction } from './ui-keybinds.js';
import { storage } from './storage.js';

const $ = (id) => document.getElementById(id);

// ─── Local state ────────────────────────
let _visible = false;
let _width = 280;
let _collapsed = new Set();   // set of dir paths that are collapsed
let _filterText = '';
let _sortMode = 'name';       // 'name' | 'size' | 'date'
let _cache = new Map();       // path → items array
let _rootLoaded = false;
let _projects = [];            // [{ path, label }] from API
let _selectedProject = null;   // { path, label } of current project
let _editorOpen = false;
let _editorFilePath = null;
let _editorOriginal = '';
let _editorDirty = false;
let _editorPreviewMode = false;   // false = raw, true = rendered MD
let _editorIsMarkdown = false;
let _findOpen = false;
let _findMatches = [];            // [{ start, end }]
let _findIndex = -1;
let _undoStack = [];              // [{ value, selStart, selEnd }]
let _redoStack = [];
let _undoBurstOpen = false;       // true while user is in a typing burst

const MIN_WIDTH = 240;
const MAX_WIDTH = 500;

// ─── SVG icons ────────────────────────
const FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><polyline points="13 2 13 7 18 7"/></svg>';

// Git status → badge text + class
const GIT_BADGE = {
  modified: ['M', 'fe-git-modified'],
  staged:   ['S', 'fe-git-staged'],
  added:    ['A', 'fe-git-added'],
  deleted:  ['D', 'fe-git-deleted'],
  untracked:['?', 'fe-git-untracked'],
  conflict: ['!', 'fe-git-conflict'],
  renamed:  ['R', 'fe-git-renamed'],
  mixed:    ['M', 'fe-git-mixed'],
};


// ═══════════════════════════════════════════
// CSS VARIABLE — drives layout shift
// ═══════════════════════════════════════════

function applyFileExplorerWidth() {
  const w = _visible ? `${_width}px` : '0px';
  document.documentElement.style.setProperty('--file-explorer-width', w);
}


// ═══════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════

function saveVisible() { try { storage.setItem(KEYS.FILE_EXPLORER_VISIBLE, String(_visible)); } catch {} }
function saveWidth() { try { storage.setItem(KEYS.FILE_EXPLORER_WIDTH, String(_width)); } catch {} }
function saveCollapsed() { try { storage.setItem(KEYS.FILE_EXPLORER_COLLAPSED, JSON.stringify([..._collapsed])); } catch {} }
function saveSort() { try { storage.setItem(KEYS.FILE_EXPLORER_SORT, _sortMode); } catch {} }

function loadPersistedState() {
  const vis = storage.getItem(KEYS.FILE_EXPLORER_VISIBLE);
  if (vis === 'true') _visible = true;

  const w = parseInt(storage.getItem(KEYS.FILE_EXPLORER_WIDTH), 10);
  if (w >= MIN_WIDTH && w <= MAX_WIDTH) _width = w;

  try {
    const col = JSON.parse(storage.getItem(KEYS.FILE_EXPLORER_COLLAPSED) || '[]');
    if (Array.isArray(col)) _collapsed = new Set(col);
  } catch {}

  const sort = storage.getItem(KEYS.FILE_EXPLORER_SORT);
  if (sort === 'name' || sort === 'size' || sort === 'date') _sortMode = sort;
}


// ═══════════════════════════════════════════
// PROJECT SELECTOR
// ═══════════════════════════════════════════

async function fetchProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (data.ok && Array.isArray(data.projects)) {
      _projects = data.projects;
    }
  } catch {}
  return _projects;
}

function selectProject(proj) {
  _selectedProject = proj;
  try { storage.setItem(KEYS.FILE_EXPLORER_PROJECT, proj.path); } catch {}

  // Update label
  const label = $('fe-project-label');
  if (label) label.textContent = proj.label;

  // Close dropdown
  closeProjectDropdown();

  // Reset tree state
  _cache.clear();
  _collapsed.clear();
  saveCollapsed();
  _rootLoaded = false;
  loadDirectory(_selectedProject.path).then(() => {
    _rootLoaded = true;
    buildFileTree();
  });
}

function updateBranchLabel(branch) {
  const btn = $('fe-branch-btn');
  const nameEl = $('fe-branch-btn-name');
  if (!btn) return;

  if (branch) {
    btn.style.display = '';
    if (nameEl) nameEl.textContent = branch;
    refreshGitStatus();
  } else {
    btn.style.display = 'none';
    closeGitPopover();
  }
}


// ═══════════════════════════════════════════
// GIT POPOVER
// ═══════════════════════════════════════════

let _gitChanges = [];
let _gitPopoverOpen = false;

function positionGitPopover() {
  const btn = $('fe-branch-btn');
  const pop = $('fe-git-popover');
  if (!btn || !pop) return;

  const r = btn.getBoundingClientRect();
  const arrow = pop.querySelector('.fe-git-popover-arrow');
  const popHeight = pop.offsetHeight || 200;
  const navbarH = 44;

  // Position to the right of the branch button, vertically centered on button
  let left = r.right + 8;
  let top = r.top + (r.height / 2) - 18; // align arrow with button center

  // If it would overflow the right edge, flip to the left
  let flipped = false;
  if (left + 248 > window.innerWidth) {
    left = r.left - 248 - 8;
    flipped = true;
  }

  // Arrow positioning
  if (arrow) {
    arrow.style.left = flipped ? '' : '-5px';
    arrow.style.right = flipped ? '-5px' : '';
    arrow.style.borderLeft = flipped ? 'none' : '1px solid rgba(255,255,255,0.1)';
    arrow.style.borderBottom = flipped ? 'none' : '1px solid rgba(255,255,255,0.1)';
    arrow.style.borderRight = flipped ? '1px solid rgba(255,255,255,0.1)' : 'none';
    arrow.style.borderTop = flipped ? '1px solid rgba(255,255,255,0.1)' : 'none';
  }

  // Clamp to viewport — respect navbar at top
  if (top + popHeight > window.innerHeight - 8) top = window.innerHeight - popHeight - 8;
  if (top < navbarH + 4) top = navbarH + 4;

  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function openGitPopover() {
  const pop = $('fe-git-popover');
  const btn = $('fe-branch-btn');
  if (!pop) return;

  _gitPopoverOpen = true;
  btn?.classList.add('active');
  positionGitPopover();

  // Reset arrow for default (right-side) positioning
  const arrow = pop.querySelector('.fe-git-popover-arrow');
  if (arrow) {
    arrow.style.left = '-5px';
    arrow.style.right = '';
    arrow.style.borderLeft = '1px solid rgba(255,255,255,0.1)';
    arrow.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
    arrow.style.borderRight = 'none';
    arrow.style.borderTop = 'none';
  }

  requestAnimationFrame(() => pop.classList.add('visible'));
  loadGitBranches();
  refreshGitStatus();
}

function closeGitPopover() {
  const pop = $('fe-git-popover');
  const btn = $('fe-branch-btn');
  if (!pop) return;
  _gitPopoverOpen = false;
  pop.classList.remove('visible');
  btn?.classList.remove('active');
}

function toggleGitPopover() {
  if (_gitPopoverOpen) closeGitPopover();
  else openGitPopover();
}

async function refreshGitStatus() {
  if (!_selectedProject) return;
  try {
    const res = await fetch('/api/git/status?path=' + encodeURIComponent(_selectedProject.path));
    const data = await res.json();
    if (!data.ok || !data.isGit) return;

    _gitChanges = data.changes || [];

    // Update button badge
    const badge = $('fe-branch-btn-badge');
    if (badge) badge.textContent = _gitChanges.length > 0 ? _gitChanges.length : '';

    // Update branch name on button
    const nameEl = $('fe-branch-btn-name');
    if (nameEl && data.branch) nameEl.textContent = data.branch;

    // Update summary in popover
    const summary = $('fe-git-summary');
    if (summary) {
      if (_gitChanges.length === 0) {
        summary.innerHTML = 'Clean working tree';
      } else {
        const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, other: 0 };
        for (const c of _gitChanges) {
          if (c.status === 'modified' || c.status === 'mixed') counts.modified++;
          else if (c.status === 'added' || c.status === 'staged') counts.added++;
          else if (c.status === 'deleted') counts.deleted++;
          else if (c.status === 'untracked') counts.untracked++;
          else counts.other++;
        }
        const parts = [];
        if (counts.modified) parts.push('<span class="gs-m">' + counts.modified + ' modified</span>');
        if (counts.added) parts.push('<span class="gs-a">' + counts.added + ' added</span>');
        if (counts.deleted) parts.push('<span class="gs-d">' + counts.deleted + ' deleted</span>');
        if (counts.untracked) parts.push('<span class="gs-u">' + counts.untracked + ' untracked</span>');
        if (counts.other) parts.push(counts.other + ' other');
        summary.innerHTML = parts.join(' &middot; ');
      }
    }
  } catch {}
}

async function loadGitBranches() {
  if (!_selectedProject) return;
  const sel = $('fe-git-branch-select');
  if (!sel) return;

  try {
    const res = await fetch('/api/terminal/branches?path=' + encodeURIComponent(_selectedProject.path));
    const data = await res.json();
    sel.innerHTML = '';
    for (const b of (data.branches || [])) {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      if (b === data.current) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch {}
}

async function switchBranch(branch) {
  if (!_selectedProject || !branch) return;
  try {
    const res = await fetch('/api/terminal/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _selectedProject.path, branch })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Switched to ' + (data.branch || branch));
      closeGitPopover();
      _cache.clear();
      _rootLoaded = false;
      loadDirectory(_selectedProject.path).then(() => {
        _rootLoaded = true;
        buildFileTree();
      });
    } else {
      showToast(data.error || 'Checkout failed');
      refreshGitStatus();
      loadGitBranches();
    }
  } catch {
    showToast('Checkout failed');
  }
}

async function doGitCommit() {
  const input = $('fe-git-commit-input');
  const btn = $('fe-git-commit-btn');
  if (!input || !_selectedProject) return;

  const message = input.value.trim();
  if (!message) { input.focus(); return; }

  btn?.classList.add('loading');
  try {
    const res = await fetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _selectedProject.path, message })
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      showToast('Committed');
      _cache.clear();
      _rootLoaded = false;
      loadDirectory(_selectedProject.path).then(() => {
        _rootLoaded = true;
        buildFileTree();
      });
      refreshGitStatus();
    } else {
      showToast(data.error || 'Commit failed');
    }
  } catch {
    showToast('Commit failed');
  } finally {
    btn?.classList.remove('loading');
  }
}

async function generateCommitMessage() {
  const input = $('fe-git-commit-input');
  const genBtn = $('fe-git-gen-btn');
  if (!input || !_selectedProject) return;

  genBtn?.classList.add('loading');
  try {
    const res = await fetch('/api/git/diff-summary?path=' + encodeURIComponent(_selectedProject.path));
    const data = await res.json();
    if (data.ok && data.message) {
      input.value = data.message;
      input.focus();
    } else {
      showToast(data.summary || 'No changes');
    }
  } catch {
    showToast('Failed to generate message');
  } finally {
    genBtn?.classList.remove('loading');
  }
}

function createGitPopover() {
  // Build the popover in document.body to escape the file-explorer-panel's
  // transform-based stacking context (which breaks position:fixed)
  const pop = document.createElement('div');
  pop.className = 'fe-git-popover';
  pop.id = 'fe-git-popover';
  pop.innerHTML = `
    <div class="fe-git-popover-arrow"></div>
    <div class="fe-git-pop-section">
      <label class="fe-git-pop-label">Branch</label>
      <select class="fe-git-branch-select" id="fe-git-branch-select"></select>
    </div>
    <div class="fe-git-pop-sep"></div>
    <div class="fe-git-pop-section">
      <label class="fe-git-pop-label">Commit</label>
      <div class="fe-git-commit-area">
        <button class="fe-git-gen-btn" id="fe-git-gen-btn" data-tooltip="Generate message">
          <svg viewBox="0 0 24 24"><path d="M12 2L9.5 8.5 3 10l5 4-1.5 7L12 17.5 17.5 21 16 14l5-4-6.5-1.5z"/></svg>
        </button>
        <input type="text" class="fe-git-commit-input" id="fe-git-commit-input" placeholder="Message..." autocomplete="off" spellcheck="false" maxlength="200">
        <button class="fe-git-commit-btn" id="fe-git-commit-btn">
          <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>
    </div>
    <div class="fe-git-pop-sep"></div>
    <div class="fe-git-pop-section">
      <div class="fe-git-summary" id="fe-git-summary"></div>
    </div>`;
  document.body.appendChild(pop);
  return pop;
}

function initGitPanel() {
  const branchBtn = $('fe-branch-btn');
  const popover = createGitPopover();
  const sel = $('fe-git-branch-select');
  const commitInput = $('fe-git-commit-input');
  const commitBtn = $('fe-git-commit-btn');

  if (branchBtn) {
    branchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGitPopover();
    });
  }

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!_gitPopoverOpen) return;
    if (popover && !popover.contains(e.target) && branchBtn && !branchBtn.contains(e.target)) {
      closeGitPopover();
    }
  });

  // Reposition on scroll/resize
  window.addEventListener('resize', () => { if (_gitPopoverOpen) positionGitPopover(); });

  if (sel) {
    sel.addEventListener('change', () => switchBranch(sel.value));
  }

  const genBtn = $('fe-git-gen-btn');
  if (genBtn) {
    genBtn.addEventListener('click', generateCommitMessage);
  }

  if (commitBtn) {
    commitBtn.addEventListener('click', doGitCommit);
  }

  if (commitInput) {
    commitInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doGitCommit(); }
      e.stopPropagation();
    });
    commitInput.addEventListener('click', (e) => e.stopPropagation());
  }
}

function closeProjectDropdown() {
  const wrap = $('fe-project-selector');
  if (wrap) wrap.classList.remove('open');
}

function toggleProjectDropdown() {
  const wrap = $('fe-project-selector');
  if (!wrap) return;
  wrap.classList.toggle('open');
}

function buildProjectDropdown() {
  const dd = $('fe-project-dropdown');
  if (!dd) return;
  dd.innerHTML = '';

  const folderSvg = '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  const plusSvg = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  for (const p of _projects) {
    const opt = document.createElement('button');
    opt.className = 'fe-project-option' + (_selectedProject && _selectedProject.path === p.path ? ' active' : '');
    opt.innerHTML = folderSvg + '<span class="fe-opt-label">' + escHtml(p.label) + '</span>';
    opt.addEventListener('click', (e) => { e.stopPropagation(); selectProject(p); });
    dd.appendChild(opt);
  }

  // Separator + Add Project
  const sep = document.createElement('div');
  sep.className = 'fe-project-sep';
  dd.appendChild(sep);

  const addBtn = document.createElement('button');
  addBtn.className = 'fe-project-option fe-add-project';
  addBtn.innerHTML = plusSvg + '<span class="fe-opt-label">Add project...</span>';
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); addProjectFlow(); });
  dd.appendChild(addBtn);
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function addProjectFlow() {
  closeProjectDropdown();
  try {
    const res = await fetch('/api/browse-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Select project folder' }) });
    const data = await res.json();
    if (!data.path) return; // User cancelled

    // Register as a project
    const label = data.path.split(/[\\/]/).pop() || data.path;
    await fetch('/api/claude-code/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'project', projectPath: data.path, label }) });

    // Refresh projects list and select the new one
    await fetchProjects();
    const newProj = _projects.find(p => p.path.replace(/\\/g, '/') === data.path.replace(/\\/g, '/'));
    if (newProj) {
      _selectedProject = newProj;
      try { storage.setItem(KEYS.FILE_EXPLORER_PROJECT, newProj.path); } catch {}
    }
    initProjectSelector();
    if (newProj) selectProject(newProj);
    else { _cache.clear(); buildFileTree(); }
  } catch (err) {
    showToast('Failed to add project');
  }
}

function initProjectSelector() {
  const btn = $('fe-project-btn');
  const wrap = $('fe-project-selector');
  if (!btn || !wrap || _projects.length === 0) return;

  // Restore persisted selection
  const saved = storage.getItem(KEYS.FILE_EXPLORER_PROJECT);
  const match = _projects.find(p => p.path === saved);
  _selectedProject = match || _projects[0];

  // Update label
  const label = $('fe-project-label');
  if (label) label.textContent = _selectedProject.label;

  // Build dropdown options
  buildProjectDropdown();

  // Wire toggle (safe to reassign)
  btn.onclick = (e) => { e.stopPropagation(); toggleProjectDropdown(); };

  // Close on outside click
  if (!wrap._outsideHandler) {
    wrap._outsideHandler = (e) => {
      if (!wrap.contains(e.target)) closeProjectDropdown();
    };
    document.addEventListener('click', wrap._outsideHandler);
  }
}


// ═══════════════════════════════════════════
// API
// ═══════════════════════════════════════════

async function loadDirectory(dirPath) {
  const params = new URLSearchParams();
  // Use selected project root when no specific path given
  const target = dirPath || (_selectedProject ? _selectedProject.path : null);
  if (target) params.set('path', target);
  const res = await fetch(`/api/project-files?${params}`);
  const data = await res.json();
  if (data.items) {
    const key = data.path || '';
    _cache.set(key, data);
    // Update branch label when loading the project root
    if (target && _selectedProject && target.replace(/\\/g, '/') === _selectedProject.path.replace(/\\/g, '/')) {
      updateBranchLabel(data.branch || null);
    }
  }
  return data;
}

async function searchFiles(term) {
  const params = new URLSearchParams({ search: term });
  // Scope search to selected project
  if (_selectedProject) params.set('path', _selectedProject.path);
  const res = await fetch(`/api/project-files?${params}`);
  return res.json();
}


// ═══════════════════════════════════════════
// TREE RENDERING
// ═══════════════════════════════════════════

function sortItems(items) {
  const sorted = [...items];
  // Always dirs first
  sorted.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    if (_sortMode === 'size' && a.type === 'file' && b.type === 'file') {
      return (b.size || 0) - (a.size || 0);
    }
    if (_sortMode === 'date' && a.mtime && b.mtime) {
      return b.mtime - a.mtime;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return sorted;
}

function createRow(item, depth) {
  const node = document.createElement('div');
  node.className = 'fe-node';
  node.dataset.path = item.fullPath || item.name;
  node.dataset.type = item.type;
  node.dataset.expanded = 'false';

  const row = document.createElement('div');
  row.className = 'fe-row';
  row.style.paddingLeft = `${depth * 16 + 8}px`;

  if (item.type === 'dir') {
    const chevron = document.createElement('span');
    chevron.className = 'fe-chevron';
    chevron.textContent = '\u25B6'; // ▶
    row.appendChild(chevron);
  } else {
    // Spacer for alignment
    const spacer = document.createElement('span');
    spacer.style.width = '12px';
    spacer.style.flexShrink = '0';
    row.appendChild(spacer);
  }

  const icon = document.createElement('span');
  icon.className = `fe-icon ${item.type === 'dir' ? 'fe-icon--dir' : 'fe-icon--file'}`;
  icon.innerHTML = item.type === 'dir' ? FOLDER_SVG : FILE_SVG;
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'fe-name';
  name.textContent = item.name;
  row.appendChild(name);

  // Git badge
  if (item.git && GIT_BADGE[item.git]) {
    const [text, cls] = GIT_BADGE[item.git];
    const badge = document.createElement('span');
    badge.className = `fe-git-badge ${cls}`;
    badge.textContent = text;
    row.appendChild(badge);
  }

  node.appendChild(row);

  // Children container for dirs
  if (item.type === 'dir') {
    const children = document.createElement('div');
    children.className = 'fe-children';
    node.appendChild(children);
  }

  // Event handlers
  if (item.type === 'dir') {
    row.addEventListener('click', () => {
      const isExpanded = node.dataset.expanded === 'true';
      if (isExpanded) {
        collapseDir(node, item.fullPath);
      } else {
        expandDir(node, item.fullPath, depth + 1);
      }
    });
  } else {
    row.addEventListener('click', (e) => {
      showFileContextMenu(e, item.fullPath, row);
    });
  }

  return node;
}

// ─── File context menu ────────────────────────
let _activeFileMenu = null;

function dismissFileMenu() {
  if (_activeFileMenu) { _activeFileMenu.remove(); _activeFileMenu = null; }
}

function showFileContextMenu(e, filePath, rowEl) {
  e.stopPropagation();
  dismissFileMenu();

  const menu = document.createElement('div');
  menu.className = 'fe-ctx-menu';

  // Copy Path
  const copyBtn = document.createElement('button');
  copyBtn.className = 'fe-ctx-item';
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy Path</span>';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(filePath).then(() => showToast('Path copied'));
    dismissFileMenu();
  });
  menu.appendChild(copyBtn);

  // Edit File
  const editBtn = document.createElement('button');
  editBtn.className = 'fe-ctx-item';
  editBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg><span>Edit File</span>';
  editBtn.addEventListener('click', () => {
    dismissFileMenu();
    openFileEditor(filePath);
  });
  menu.appendChild(editBtn);

  // Position relative to the row
  const panel = $('file-explorer-panel');
  if (panel) panel.appendChild(menu);

  const rowRect = rowEl.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  menu.style.top = `${rowRect.bottom - panelRect.top}px`;
  menu.style.left = `${rowRect.left - panelRect.left + 20}px`;

  // Clamp to panel bounds
  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > panelRect.right - 8) {
      menu.style.left = `${panelRect.width - menuRect.width - 8}px`;
    }
    if (menuRect.bottom > panelRect.bottom - 8) {
      menu.style.top = `${rowRect.top - panelRect.top - menuRect.height}px`;
    }
  });

  _activeFileMenu = menu;

  // Close on outside click
  const onOutside = (ev) => {
    if (!menu.contains(ev.target)) {
      dismissFileMenu();
      document.removeEventListener('click', onOutside, true);
    }
  };
  setTimeout(() => document.addEventListener('click', onOutside, true), 0);
}

function showToast(msg) {
  let toast = document.getElementById('fe-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fe-toast';
    toast.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:rgba(30,30,34,0.95);color:#e0e0e0;padding:6px 16px;border-radius:6px;font-size:12px;font-family:var(--ff-mono);z-index:100000;pointer-events:none;opacity:0;transition:opacity 0.2s;border:1px solid rgba(255,255,255,0.1);';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 1500);
}

// ═══════════════════════════════════════════
// INLINE FILE EDITOR
// ═══════════════════════════════════════════

// File extension → language label
const EXT_LANG = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript',
  json: 'JSON', html: 'HTML', css: 'CSS',
  md: 'Markdown', py: 'Python', sh: 'Shell', bash: 'Shell',
  yml: 'YAML', yaml: 'YAML', toml: 'TOML',
  sql: 'SQL', rs: 'Rust', go: 'Go', rb: 'Ruby',
  env: 'ENV', gitignore: 'Git', dockerignore: 'Docker',
};

const COMMENT_PREFIX = {
  JavaScript: '//', TypeScript: '//', JSON: '//', CSS: '//',
  HTML: '<!--', Python: '#', Shell: '#', YAML: '#', TOML: '#',
  SQL: '--', Rust: '//', Go: '//', Ruby: '#', ENV: '#', Git: '#', Docker: '#',
};

// ─── Syntax Highlighting ────────────────────────

const SH_KEYWORDS = {
  JavaScript: 'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|true|false|null|undefined',
  TypeScript: 'abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|keyof|let|new|of|return|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield|true|false|null|undefined',
  Python: 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None',
  JSON: 'true|false|null',
  Shell: 'if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|exit|local|export|source|set|unset|shift|read|echo|printf|test|eval',
  SQL: 'SELECT|FROM|WHERE|AND|OR|NOT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|ADD|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MIN|MAX|IS|NULL|LIKE|BETWEEN|IN|EXISTS|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CASCADE|VIEW|BEGIN|END|IF|ELSE|THEN|WHILE|DECLARE|COMMIT|ROLLBACK',
  Rust: 'as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while|yield',
  Go: 'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|true|false|nil',
  Ruby: 'alias|and|begin|break|case|class|def|do|else|elsif|end|ensure|false|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|true|undef|unless|until|when|while|yield',
  TOML: 'true|false',
  YAML: 'true|false|null|yes|no|on|off',
};

const SH_MAX_SIZE = 80000;

function _shEsc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _shBuildRules(lang) {
  const rules = [];
  const cStyle = ['JavaScript', 'TypeScript', 'CSS', 'Go', 'Rust'];
  const hashStyle = ['Python', 'Shell', 'YAML', 'TOML', 'Ruby', 'ENV', 'Git', 'Docker'];

  // Comments (highest priority)
  if (cStyle.includes(lang)) rules.push({ p: '\\/\\*[\\s\\S]*?\\*\\/', c: 'sh-cm' });
  if (lang === 'HTML') rules.push({ p: '<!--[\\s\\S]*?-->', c: 'sh-cm' });
  if (cStyle.includes(lang) && lang !== 'CSS') rules.push({ p: '\\/\\/[^\\n]*', c: 'sh-cm' });
  if (hashStyle.includes(lang)) rules.push({ p: '#[^\\n]*', c: 'sh-cm' });
  if (lang === 'SQL') rules.push({ p: '--[^\\n]*', c: 'sh-cm' });

  // JSON property keys (before generic strings so they match first)
  if (lang === 'JSON') {
    rules.push({ p: '"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)', c: 'sh-prop' });
  }

  // Strings
  rules.push({ p: '"(?:[^"\\\\\\n]|\\\\.)*"', c: 'sh-str' });
  rules.push({ p: "'(?:[^'\\\\\\n]|\\\\.)*'", c: 'sh-str' });
  if (['JavaScript', 'TypeScript'].includes(lang)) {
    rules.push({ p: '`(?:[^`\\\\]|\\\\.)*`', c: 'sh-str' });
  }
  if (lang === 'Python') {
    // Triple-quoted strings
    rules.push({ p: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'', c: 'sh-str' });
  }

  // Numbers
  rules.push({ p: '\\b(?:0x[0-9a-fA-F]+|0b[01]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b', c: 'sh-num' });

  // CSS-specific: at-rules, selectors, properties
  if (lang === 'CSS') {
    rules.push({ p: '@[a-zA-Z][a-zA-Z-]*', c: 'sh-kw' });
    rules.push({ p: '!important', c: 'sh-kw' });
    rules.push({ p: '[.#][a-zA-Z_-][a-zA-Z0-9_-]*', c: 'sh-fn' });
    rules.push({ p: ':[a-zA-Z][a-zA-Z-]*', c: 'sh-attr' });
  }

  // HTML-specific: tags and attributes
  if (lang === 'HTML') {
    rules.push({ p: '<\\/?[a-zA-Z][a-zA-Z0-9-]*', c: 'sh-tag' });
    rules.push({ p: '\\/?>', c: 'sh-op' });
    rules.push({ p: '\\b[a-zA-Z][a-zA-Z-]*(?=\\s*=)', c: 'sh-attr' });
  }

  // Keywords
  const kw = SH_KEYWORDS[lang];
  if (kw) {
    const flags = lang === 'SQL' ? 'i' : '';
    rules.push({ p: '\\b(?:' + kw + ')\\b', c: 'sh-kw', flags });
  }

  // Function calls (identifier followed by paren)
  if (!['JSON', 'CSS', 'HTML', 'YAML', 'TOML', 'ENV', 'Markdown'].includes(lang)) {
    rules.push({ p: '\\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\\s*\\()', c: 'sh-fn' });
  }

  // YAML keys (word at line start followed by colon)
  if (lang === 'YAML' || lang === 'TOML') {
    rules.push({ p: '^[ \\t]*[a-zA-Z_][a-zA-Z0-9_.\\-]*(?=\\s*[:=])', c: 'sh-prop' });
  }

  // Shell variables
  if (lang === 'Shell' || lang === 'ENV') {
    rules.push({ p: '\\$[a-zA-Z_][a-zA-Z0-9_]*|\\$\\{[^}]+\\}', c: 'sh-prop' });
  }

  // Brackets
  rules.push({ p: '[{}\\[\\]()]', c: 'sh-br' });

  return rules;
}

// Cache compiled regexes per language
const _shCache = {};

function _shGetRegex(lang) {
  if (_shCache[lang]) return _shCache[lang];
  const rules = _shBuildRules(lang);
  if (rules.length === 0) return null;
  // Combine all rule patterns into one alternation
  const combined = rules.map(r => '(' + r.p + ')').join('|');
  const flags = 'gm' + (rules.some(r => r.flags?.includes('i')) ? 'i' : '');
  _shCache[lang] = { regex: new RegExp(combined, flags), rules };
  return _shCache[lang];
}

function highlightCode(text, lang) {
  if (!text) return '';
  if (text.length > SH_MAX_SIZE || !lang || lang === 'Plain Text' || lang === 'Markdown') {
    return _shEsc(text);
  }

  const compiled = _shGetRegex(lang);
  if (!compiled) return _shEsc(text);

  const { regex, rules } = compiled;
  regex.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Unmatched text before this token
    if (match.index > lastIndex) {
      result += _shEsc(text.slice(lastIndex, match.index));
    }
    // Find which capturing group matched
    for (let i = 0; i < rules.length; i++) {
      if (match[i + 1] !== undefined) {
        result += '<span class="' + rules[i].c + '">' + _shEsc(match[0]) + '</span>';
        break;
      }
    }
    lastIndex = match.index + match[0].length;
    // Guard against zero-length matches
    if (match[0].length === 0) { regex.lastIndex++; lastIndex++; }
  }
  // Remaining text
  if (lastIndex < text.length) result += _shEsc(text.slice(lastIndex));

  return result;
}

let _shLang = '';
let _shLines = null;      // cached line split for large files
let _shViewStart = 0;     // first buffered line
let _shViewEnd = 0;       // last buffered line
const SH_LINE_H = 12 * 1.65;
const SH_BUFFER = 80;     // lines of buffer above/below viewport
const SH_REBUFFER = 30;   // re-render when within this many lines of buffer edge

function updateHighlight() {
  const textarea = $('fe-editor-textarea');
  const code = $('fe-editor-highlight-code');
  if (!textarea || !code) return;

  const text = textarea.value;
  if (!text || !_shLang || _shLang === 'Plain Text' || _shLang === 'Markdown') {
    code.innerHTML = _shEsc(text || '') + '\n';
    _shLines = null;
    return;
  }

  if (text.length <= SH_MAX_SIZE) {
    // Small file: highlight everything
    code.innerHTML = highlightCode(text, _shLang) + '\n';
    _shLines = null;
    return;
  }

  // Large file: viewport-based highlighting
  _shLines = text.split('\n');
  _shRenderViewport(textarea, code, text);
}

function _shRenderViewport(textarea, code, text) {
  if (!_shLines) return;

  const scrollTop = textarea.scrollTop;
  const viewH = textarea.clientHeight;
  const firstVisLine = Math.max(0, Math.floor(scrollTop / SH_LINE_H));
  const visLineCount = Math.ceil(viewH / SH_LINE_H);

  const startLine = Math.max(0, firstVisLine - SH_BUFFER);
  const endLine = Math.min(_shLines.length, firstVisLine + visLineCount + SH_BUFFER);

  _shViewStart = startLine;
  _shViewEnd = endLine;

  // Character offsets for the visible chunk
  let charStart = 0;
  for (let i = 0; i < startLine; i++) charStart += _shLines[i].length + 1;
  let charEnd = charStart;
  for (let i = startLine; i < endLine; i++) charEnd += _shLines[i].length + 1;
  if (charEnd > text.length) charEnd = text.length;

  const chunk = text.slice(charStart, charEnd);
  const highlighted = highlightCode(chunk, _shLang);

  // Use real newlines as spacers — guarantees identical line height to textarea
  code.innerHTML =
    '\n'.repeat(startLine) +
    highlighted +
    '\n'.repeat(Math.max(0, _shLines.length - endLine)) +
    '\n';
}

function syncHighlightScroll() {
  const textarea = $('fe-editor-textarea');
  const code = $('fe-editor-highlight-code');
  if (!textarea || !code) return;
  code.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;

  // Large file: re-render viewport if scrolled near buffer edge
  if (_shLines) {
    const firstVisLine = Math.floor(textarea.scrollTop / SH_LINE_H);
    const lastVisLine = firstVisLine + Math.ceil(textarea.clientHeight / SH_LINE_H);
    if (firstVisLine < _shViewStart + SH_REBUFFER || lastVisLine > _shViewEnd - SH_REBUFFER) {
      _shRenderViewport(textarea, code, textarea.value);
    }
  }
}

function detectLang(filename) {
  const parts = filename.split('.');
  if (parts.length < 2) return 'Plain Text';
  const ext = parts.pop().toLowerCase();
  // Check the full dotfile name first (e.g. .env, .gitignore)
  const dotName = filename.startsWith('.') ? filename.slice(1).toLowerCase() : null;
  return EXT_LANG[dotName] || EXT_LANG[ext] || ext.toUpperCase();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateGutter() {
  const gutter = $('fe-editor-gutter');
  const textarea = $('fe-editor-textarea');
  if (!gutter || !textarea) return;
  const lines = textarea.value.split('\n').length;
  const frags = [];
  for (let i = 1; i <= lines; i++) frags.push(`<div>${i}</div>`);
  gutter.innerHTML = frags.join('');
}

function updateCursorPos() {
  const textarea = $('fe-editor-textarea');
  const el = $('fe-editor-cursor');
  if (!textarea || !el) return;
  const val = textarea.value;
  const pos = textarea.selectionStart;
  const before = val.substring(0, pos);
  const ln = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  el.textContent = `Ln ${ln}, Col ${col}`;
}

function syncGutterScroll() {
  const gutter = $('fe-editor-gutter');
  const textarea = $('fe-editor-textarea');
  if (gutter && textarea) gutter.scrollTop = textarea.scrollTop;
}

function updateLineHighlight() {
  const textarea = $('fe-editor-textarea');
  const hl = $('fe-editor-line-highlight');
  if (!textarea || !hl) return;
  const val = textarea.value;
  const pos = textarea.selectionStart;
  const lineNum = val.substring(0, pos).split('\n').length - 1;
  const lineH = 12 * 1.65;
  hl.style.top = `${10 + lineNum * lineH - textarea.scrollTop}px`;
}

function updateScrollmap() {
  const textarea = $('fe-editor-textarea');
  const thumb = $('fe-editor-scrollmap-thumb');
  const map = $('fe-editor-scrollmap');
  if (!textarea || !thumb || !map) return;
  const sh = textarea.scrollHeight;
  const ch = textarea.clientHeight;
  if (sh <= ch) { thumb.style.display = 'none'; return; }
  thumb.style.display = '';
  const mapH = map.clientHeight;
  const ratio = ch / sh;
  const thumbH = Math.max(12, mapH * ratio);
  const scrollRatio = textarea.scrollTop / (sh - ch);
  thumb.style.height = `${thumbH}px`;
  thumb.style.top = `${scrollRatio * (mapH - thumbH)}px`;
}

// ─── Undo/Redo stack ───────────────────────
function editorPushUndo(ta) {
  _undoStack.push({ value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
  if (_undoStack.length > 200) _undoStack.shift();
  _redoStack = [];
}

function editorInsertText(ta, text) {
  editorPushUndo(ta);
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
  const newPos = start + text.length;
  ta.selectionStart = ta.selectionEnd = newPos;
  ta.dispatchEvent(new Event('input'));
}

function editorReplaceRange(ta, from, to, text) {
  editorPushUndo(ta);
  ta.value = ta.value.substring(0, from) + text + ta.value.substring(to);
  ta.dispatchEvent(new Event('input'));
}

function editorUndo(ta) {
  if (_undoStack.length === 0) return;
  _redoStack.push({ value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
  const state = _undoStack.pop();
  ta.value = state.value;
  ta.selectionStart = state.selStart;
  ta.selectionEnd = state.selEnd;
  updateEditorDirtyState();
  updateGutter();
  updateHighlight();
}

function editorRedo(ta) {
  if (_redoStack.length === 0) return;
  _undoStack.push({ value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
  const state = _redoStack.pop();
  ta.value = state.value;
  ta.selectionStart = state.selStart;
  ta.selectionEnd = state.selEnd;
  updateEditorDirtyState();
  updateGutter();
  updateHighlight();
}

async function openFileEditor(filePath) {
  try {
    const res = await fetch(`/api/file-content?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Cannot open file');
      return;
    }

    _editorOpen = true;
    _editorFilePath = data.path;
    // Normalize line endings — textarea always returns \n, server may send \r\n on Windows
    _editorOriginal = data.content.replace(/\r\n/g, '\n');
    _editorDirty = false;
    _undoStack = [];
    _redoStack = [];
    _undoBurstOpen = false;

    // Slide editor panel open
    dismissFileMenu();
    const editorPanel = $('fe-editor-panel');
    if (editorPanel) editorPanel.classList.add('open');
    document.body.classList.add('fe-editor-open');

    const textarea = $('fe-editor-textarea');
    if (textarea) {
      textarea.value = _editorOriginal;
      textarea.scrollTop = 0;
      textarea.setSelectionRange(0, 0);
      // Push initial state so first Ctrl+Z reverts to original
      _undoStack.push({ value: _editorOriginal, selStart: 0, selEnd: 0 });
    }

    // File path in header (show relative path from project root)
    const fpEl = $('fe-editor-filepath');
    if (fpEl) {
      const rel = _selectedProject ? data.path.replace(_selectedProject.path.replace(/\\/g, '/'), '') : data.path;
      fpEl.textContent = rel.startsWith('/') ? rel.slice(1) : rel;
    }

    // Language detection + markdown check + syntax highlighting
    const lang = detectLang(data.name);
    _shLang = lang;
    const langEl = $('fe-editor-lang');
    if (langEl) langEl.textContent = lang;
    _editorIsMarkdown = lang === 'Markdown';
    _editorPreviewMode = false;
    updateViewToggle();
    // Reset toggle buttons
    const toggleBtns = document.querySelectorAll('.fe-editor-toggle-btn');
    toggleBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === 'raw'));
    setPreviewMode(false);

    // Close find bar + go-to-line on new file
    closeFind();
    closeGoToLine();

    // File size
    const sizeEl = $('fe-editor-size');
    if (sizeEl) sizeEl.textContent = formatSize(data.size || 0);

    updateGutter();
    updateHighlight();
    updateCursorPos();
    updateEditorDirtyState();
    // Defer so the textarea has rendered its scroll dimensions
    requestAnimationFrame(() => { updateLineHighlight(); updateScrollmap(); syncHighlightScroll(); });
  } catch (err) {
    showToast('Failed to open file');
  }
}

function closeFileEditor() {
  if (_editorDirty) {
    if (!confirm('Discard unsaved changes?')) return false;
  }

  _editorOpen = false;
  _editorFilePath = null;
  _editorOriginal = '';
  _editorDirty = false;
  _editorIsMarkdown = false;
  _editorPreviewMode = false;
  _shLang = '';
  _shLines = null;
  _shViewStart = 0;
  _shViewEnd = 0;
  const hlCode = $('fe-editor-highlight-code');
  if (hlCode) hlCode.innerHTML = '';

  // Close find bar and preview
  closeFind();
  setPreviewMode(false);
  updateViewToggle();

  // Slide editor panel closed
  const editorPanel = $('fe-editor-panel');
  if (editorPanel) editorPanel.classList.remove('open');
  document.body.classList.remove('fe-editor-open');

  // Restore footer
  const data = _cache.values().next().value;
  updateCount(data?.items?.length || 0);

  return true;
}

async function saveFileEditor() {
  if (!_editorFilePath) return;
  const textarea = $('fe-editor-textarea');
  if (!textarea) return;

  try {
    const res = await fetch('/api/file-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _editorFilePath, content: textarea.value })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Save failed');
      return;
    }
    _editorOriginal = textarea.value;
    updateEditorDirtyState();
    showToast('Saved');
  } catch {
    showToast('Save failed');
  }
}

function discardFileEditor() {
  if (!confirm('Discard changes?')) return;
  const textarea = $('fe-editor-textarea');
  if (textarea) textarea.value = _editorOriginal;
  updateEditorDirtyState();
}

function updateEditorDirtyState() {
  const textarea = $('fe-editor-textarea');
  _editorDirty = textarea ? textarea.value !== _editorOriginal : false;

  const dot = $('fe-editor-dot');
  if (dot) dot.classList.toggle('dirty', _editorDirty);

  const saveBtn = $('fe-editor-save');
  if (saveBtn) {
    saveBtn.disabled = !_editorDirty;
    saveBtn.classList.toggle('dirty', _editorDirty);
  }

  const discardBtn = $('fe-editor-discard');
  if (discardBtn) discardBtn.disabled = !_editorDirty;
}

// ─── Markdown rendering (same as Skills Studio) ────────────
function renderMarkdown(md) {
  let text = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`;
  });
  text = text.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  text = text.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  text = text.replace(/^---+$/gm, '<hr>');
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  text = text.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  text = text.replace(/<\/blockquote>\n<blockquote>/g, '\n');
  text = text.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, _sep, body) => {
    const ths = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const tds = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });
  text = text.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  text = text.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  text = text.replace(/^\d+\.\s+(.+)$/gm, '<oli>$1</oli>');
  text = text.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (match) => {
    return '<ol>' + match.replace(/<\/?oli>/g, (t) => t.replace('oli', 'li')) + '</ol>';
  });
  text = text.replace(/^(?!<[a-z/])((?!<).+)$/gm, '<p>$1</p>');
  text = text.replace(/<p>\s*<\/p>/g, '');
  return text;
}

function setPreviewMode(preview) {
  _editorPreviewMode = preview;
  const textarea = $('fe-editor-textarea');
  const gutter = $('fe-editor-gutter');
  const previewEl = $('fe-editor-preview');

  if (preview) {
    if (textarea) textarea.style.display = 'none';
    if (gutter) gutter.style.display = 'none';
    if (previewEl) {
      previewEl.innerHTML = renderMarkdown(textarea?.value || '');
      previewEl.classList.add('visible');
    }
  } else {
    if (textarea) textarea.style.display = '';
    if (gutter) gutter.style.display = '';
    if (previewEl) previewEl.classList.remove('visible');
  }
}

function updateViewToggle() {
  const toggle = $('fe-editor-view-toggle');
  const sep = $('fe-editor-sep-preview');
  if (toggle) toggle.style.display = _editorIsMarkdown ? 'flex' : 'none';
  if (sep) sep.style.display = _editorIsMarkdown ? '' : 'none';
}

// ─── Find ─────────────────────────────────
function openFind() {
  _findOpen = true;
  const bar = $('fe-editor-find');
  const input = $('fe-editor-find-input');
  if (bar) bar.classList.add('open');
  if (input) { input.value = ''; input.focus(); }
  _findMatches = [];
  _findIndex = -1;
  updateFindCount();
}

function closeFind() {
  _findOpen = false;
  const bar = $('fe-editor-find');
  if (bar) bar.classList.remove('open');
  _findMatches = [];
  _findIndex = -1;
  updateFindCount();
}

function doFind(query) {
  _findMatches = [];
  _findIndex = -1;
  if (!query) { updateFindCount(); return; }

  const textarea = $('fe-editor-textarea');
  if (!textarea) return;
  const text = textarea.value;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let pos = 0;
  while (true) {
    const idx = lower.indexOf(q, pos);
    if (idx === -1) break;
    _findMatches.push({ start: idx, end: idx + q.length });
    pos = idx + 1;
  }
  if (_findMatches.length > 0) {
    _findIndex = 0;
    selectFindMatch();
  }
  updateFindCount();
}

function findNext() {
  if (_findMatches.length === 0) return;
  _findIndex = (_findIndex + 1) % _findMatches.length;
  selectFindMatch();
  updateFindCount();
}

function findPrev() {
  if (_findMatches.length === 0) return;
  _findIndex = (_findIndex - 1 + _findMatches.length) % _findMatches.length;
  selectFindMatch();
  updateFindCount();
}

function selectFindMatch() {
  const textarea = $('fe-editor-textarea');
  if (!textarea || _findIndex < 0 || _findIndex >= _findMatches.length) return;
  const m = _findMatches[_findIndex];
  textarea.focus();
  textarea.setSelectionRange(m.start, m.end);
  // Scroll match into view
  const text = textarea.value.substring(0, m.start);
  const lineNum = text.split('\n').length;
  const lineHeight = 12 * 1.65; // matches font-size * line-height
  const targetScroll = (lineNum - 5) * lineHeight; // a few lines above
  textarea.scrollTop = Math.max(0, targetScroll);
}

function updateFindCount() {
  const el = $('fe-editor-find-count');
  if (!el) return;
  if (_findMatches.length === 0) {
    const input = $('fe-editor-find-input');
    el.textContent = input?.value ? 'No results' : '';
  } else {
    el.textContent = `${_findIndex + 1} of ${_findMatches.length}`;
  }
}

function doReplace() {
  const textarea = $('fe-editor-textarea');
  const replaceInput = $('fe-editor-replace-input');
  if (!textarea || !replaceInput || _findMatches.length === 0 || _findIndex < 0) return;
  const m = _findMatches[_findIndex];
  const replacement = replaceInput.value;
  editorReplaceRange(textarea, m.start, m.end, replacement);
  textarea.selectionStart = textarea.selectionEnd = m.start + replacement.length;
  updateEditorDirtyState();
  updateGutter();
  doFind($('fe-editor-find-input')?.value || '');
}

function doReplaceAll() {
  const textarea = $('fe-editor-textarea');
  const findInput = $('fe-editor-find-input');
  const replaceInput = $('fe-editor-replace-input');
  if (!textarea || !findInput?.value || !replaceInput) return;
  const query = findInput.value;
  const replacement = replaceInput.value;
  const text = textarea.value;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts = [];
  let pos = 0;
  while (true) {
    const idx = lower.indexOf(q, pos);
    if (idx === -1) break;
    parts.push(text.substring(pos, idx), replacement);
    pos = idx + q.length;
  }
  parts.push(text.substring(pos));
  editorPushUndo(textarea);
  textarea.value = parts.join('');
  updateEditorDirtyState();
  updateGutter();
  doFind(query);
}

// ─── Go to Line ───────────────────────────
function openGoToLine() {
  const bar = $('fe-editor-goto');
  const input = $('fe-editor-goto-input');
  if (bar) bar.classList.add('open');
  if (input) { input.value = ''; input.focus(); }
}

function closeGoToLine() {
  const bar = $('fe-editor-goto');
  if (bar) bar.classList.remove('open');
}

function goToLine(lineNum) {
  const textarea = $('fe-editor-textarea');
  if (!textarea || !lineNum || lineNum < 1) return;
  const lines = textarea.value.split('\n');
  const target = Math.min(lineNum, lines.length);
  let pos = 0;
  for (let i = 0; i < target - 1; i++) pos += lines[i].length + 1;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  const lineHeight = 12 * 1.65;
  textarea.scrollTop = Math.max(0, (target - 5) * lineHeight);
  updateCursorPos();
  updateLineHighlight();
  syncGutterScroll();
  closeGoToLine();
}


async function buildFileTree() {
  const tree = $('fe-tree');
  if (!tree) return;
  tree.innerHTML = '';

  const data = _cache.values().next().value || await loadDirectory();
  if (!data || !data.items) return;

  const items = sortItems(data.items);
  const rootPath = data.path || '';

  for (const item of items) {
    // Apply client-side filter
    if (_filterText && !item.name.toLowerCase().includes(_filterText.toLowerCase())) continue;
    item.fullPath = rootPath + '/' + item.name;
    const node = createRow(item, 0);

    // Restore expanded state
    if (item.type === 'dir' && !_collapsed.has(item.fullPath)) {
      // Only auto-expand if previously expanded (not collapsed)
      // By default dirs start collapsed (not in _collapsed means not explicitly toggled)
    }

    tree.appendChild(node);
  }

  updateCount(items.length);
}

async function expandDir(nodeEl, dirPath, depth) {
  nodeEl.dataset.expanded = 'true';
  _collapsed.delete(dirPath);
  saveCollapsed();

  const childrenEl = nodeEl.querySelector('.fe-children');
  if (!childrenEl) return;

  // If already loaded, just show
  if (childrenEl.children.length > 0) return;

  // Loading indicator
  childrenEl.innerHTML = '<div style="padding:4px 0 4px ' + (depth * 16 + 24) + 'px;font-size:11px;color:rgba(255,255,255,0.25);font-family:var(--ff-mono);">Loading...</div>';

  const data = await loadDirectory(dirPath);
  childrenEl.innerHTML = '';

  if (!data || !data.items) return;

  const items = sortItems(data.items);
  for (const item of items) {
    if (_filterText && !item.name.toLowerCase().includes(_filterText.toLowerCase())) continue;
    item.fullPath = dirPath + '/' + item.name;
    const child = createRow(item, depth);
    childrenEl.appendChild(child);
  }
}

function collapseDir(nodeEl, dirPath) {
  nodeEl.dataset.expanded = 'false';
  if (dirPath) {
    _collapsed.add(dirPath);
    saveCollapsed();
  }
}

function collapseAll() {
  const tree = $('fe-tree');
  if (!tree) return;
  tree.querySelectorAll('.fe-node[data-type="dir"][data-expanded="true"]').forEach(n => {
    n.dataset.expanded = 'false';
    _collapsed.add(n.dataset.path);
  });
  saveCollapsed();
}

async function expandAll() {
  const tree = $('fe-tree');
  if (!tree) return;
  const dirs = tree.querySelectorAll('.fe-node[data-type="dir"][data-expanded="false"]');
  for (const n of dirs) {
    const path = n.dataset.path;
    // Determine depth by counting ancestor fe-children
    let depth = 0;
    let parent = n.parentElement;
    while (parent && parent !== tree) {
      if (parent.classList.contains('fe-children')) depth++;
      parent = parent.parentElement;
    }
    await expandDir(n, path, depth + 1);
  }
}

function updateCount(count) {
  const el = $('fe-count');
  if (el) el.textContent = `${count} items`;
}


// ═══════════════════════════════════════════
// SEARCH (debounced server-side for >2 chars)
// ═══════════════════════════════════════════

let _searchTimer = null;

function onFilterInput(e) {
  _filterText = e.target.value.trim();

  clearTimeout(_searchTimer);

  if (_filterText.length > 2) {
    _searchTimer = setTimeout(async () => {
      const tree = $('fe-tree');
      if (!tree) return;
      tree.innerHTML = '<div style="padding:12px;font-size:11px;color:rgba(255,255,255,0.3);font-family:var(--ff-mono);text-align:center;">Searching...</div>';

      const data = await searchFiles(_filterText);
      tree.innerHTML = '';

      if (!data || !data.items || data.items.length === 0) {
        tree.innerHTML = '<div style="padding:12px;font-size:11px;color:rgba(255,255,255,0.25);font-family:var(--ff-mono);text-align:center;">No results</div>';
        updateCount(0);
        return;
      }

      for (const item of data.items) {
        item.fullPath = item.path;
        const node = createRow(item, 0);
        // Show relative path for search results
        const nameEl = node.querySelector('.fe-name');
        if (nameEl) nameEl.textContent = item.path;
        tree.appendChild(node);
      }
      updateCount(data.items.length);
    }, 300);
  } else {
    // Client-side filter on loaded tree
    buildFileTree();
  }
}


// ═══════════════════════════════════════════
// RESIZE HANDLE
// ═══════════════════════════════════════════

function initResizeHandle() {
  const handle = $('fe-resize-handle');
  const panel = $('file-explorer-panel');
  if (!handle || !panel) return;

  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // The panel left edge starts at --explorer-width
    const explorerWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--explorer-width')) || 0;
    const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX - explorerWidth));
    _width = newWidth;
    panel.style.width = `${_width}px`;
    applyFileExplorerWidth();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveWidth();
    window.dispatchEvent(new Event('resize'));
  });
}


// ═══════════════════════════════════════════
// TOGGLE
// ═══════════════════════════════════════════

export function toggleFileExplorer() {
  const panel = $('file-explorer-panel');
  if (!panel) return;

  // If closing while editor is open + dirty, prompt first
  if (_visible && _editorOpen) {
    if (!closeFileEditor()) return; // User cancelled discard
  }

  _visible = !_visible;
  panel.classList.toggle('open', _visible);
  saveVisible();

  // Toggle unified title bar style (seamless with sidebar, slides under title bar)
  const titleBar = document.getElementById('title-bar');
  if (titleBar) titleBar.classList.toggle('file-explorer-active', _visible);
  document.body.classList.toggle('file-explorer-open', _visible);

  applyFileExplorerWidth();

  // Resize after transition
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 320);

  // Sync menu checkmark
  const menuEl = $('menu-toggle-file-explorer');
  if (menuEl) menuEl.classList.toggle('active', _visible);

  // Build tree on first show
  if (_visible && !_rootLoaded) {
    _rootLoaded = true;
    fetchProjects().then(() => {
      initProjectSelector();
      return loadDirectory();
    }).then(() => buildFileTree());
  }
}


// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

export function initFileExplorer() {
  loadPersistedState();

  const panel = $('file-explorer-panel');
  if (!panel) return;

  // Set width
  panel.style.width = `${_width}px`;

  // Wire filter
  const filterInput = $('fe-filter-input');
  const filterClear = $('fe-filter-clear');
  if (filterInput) filterInput.addEventListener('input', onFilterInput);
  if (filterClear) filterClear.addEventListener('click', () => {
    if (filterInput) filterInput.value = '';
    _filterText = '';
    buildFileTree();
  });

  // Wire toolbar
  const collapseBtn = $('fe-collapse-all');
  const expandBtn = $('fe-expand-all');
  const sortBtn = $('fe-sort-btn');
  const refreshBtn = $('fe-refresh');

  if (collapseBtn) collapseBtn.addEventListener('click', collapseAll);
  if (expandBtn) expandBtn.addEventListener('click', expandAll);

  if (sortBtn) {
    const sortModes = ['name', 'size', 'date'];
    const sortLabels = { name: 'Sort: name', size: 'Sort: size', date: 'Sort: date' };
    sortBtn.addEventListener('click', () => {
      const idx = sortModes.indexOf(_sortMode);
      _sortMode = sortModes[(idx + 1) % sortModes.length];
      sortBtn.dataset.tooltip = sortLabels[_sortMode];
      saveSort();
      buildFileTree();
    });
    sortBtn.dataset.tooltip = `Sort: ${_sortMode}`;
  }

  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    _cache.clear();
    _rootLoaded = false;
    fetchProjects().then(() => {
      initProjectSelector();
      return loadDirectory();
    }).then(() => {
      _rootLoaded = true;
      buildFileTree();
    });
  });

  // Editor buttons + features
  const editorBack = $('fe-editor-back');
  const editorSave = $('fe-editor-save');
  const editorDiscard = $('fe-editor-discard');
  const editorClose = $('fe-editor-close');
  const editorTextarea = $('fe-editor-textarea');
  const wordWrapBtn = $('fe-editor-word-wrap');

  if (editorBack) editorBack.addEventListener('click', closeFileEditor);
  if (editorSave) editorSave.addEventListener('click', saveFileEditor);
  if (editorDiscard) editorDiscard.addEventListener('click', discardFileEditor);
  if (editorClose) editorClose.addEventListener('click', closeFileEditor);

  // Word wrap toggle (enabled by default)
  if (wordWrapBtn) wordWrapBtn.classList.add('active');
  if (wordWrapBtn && editorTextarea) {
    wordWrapBtn.addEventListener('click', () => {
      const wrapped = editorTextarea.style.whiteSpace === 'pre-wrap';
      const newWrap = wrapped ? 'pre' : 'pre-wrap';
      const newOverflow = wrapped ? 'normal' : 'break-word';
      editorTextarea.style.whiteSpace = newWrap;
      editorTextarea.style.overflowWrap = newOverflow;
      const hl = $('fe-editor-highlight');
      if (hl) { hl.style.whiteSpace = newWrap; hl.style.overflowWrap = newOverflow; }
      wordWrapBtn.classList.toggle('active', !wrapped);
    });
  }

  // Keybinds help popover
  const helpBtn = $('fe-editor-help-btn');
  const keybindsPanel = $('fe-editor-keybinds');
  if (helpBtn && keybindsPanel) {
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      keybindsPanel.classList.toggle('open');
    });
    document.addEventListener('click', () => keybindsPanel.classList.remove('open'));
    keybindsPanel.addEventListener('click', (e) => e.stopPropagation());
  }

  // Raw/Preview toggle for markdown files
  document.querySelectorAll('.fe-editor-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      _editorPreviewMode = mode === 'preview';
      document.querySelectorAll('.fe-editor-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      setPreviewMode(_editorPreviewMode);
    });
  });

  // Find & Replace bar
  const findBtn = $('fe-editor-find-btn');
  const findInput = $('fe-editor-find-input');
  const findPrevBtn = $('fe-editor-find-prev');
  const findNextBtn = $('fe-editor-find-next');
  const findCloseBtn = $('fe-editor-find-close');
  const replaceBtn = $('fe-editor-replace');
  const replaceAllBtn = $('fe-editor-replace-all');
  const replaceInput = $('fe-editor-replace-input');

  if (findBtn) findBtn.addEventListener('click', () => {
    if (_findOpen) closeFind(); else openFind();
  });
  if (findCloseBtn) findCloseBtn.addEventListener('click', closeFind);
  if (findNextBtn) findNextBtn.addEventListener('click', findNext);
  if (findPrevBtn) findPrevBtn.addEventListener('click', findPrev);
  if (replaceBtn) replaceBtn.addEventListener('click', doReplace);
  if (replaceAllBtn) replaceAllBtn.addEventListener('click', doReplaceAll);
  if (findInput) {
    findInput.addEventListener('input', () => doFind(findInput.value));
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.shiftKey ? findPrev() : findNext(); }
      if (e.key === 'Escape') closeFind();
    });
  }
  if (replaceInput) {
    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doReplace();
      if (e.key === 'Escape') closeFind();
    });
  }

  // Go to Line
  const gotoInput = $('fe-editor-goto-input');
  if (gotoInput) {
    gotoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { goToLine(parseInt(gotoInput.value, 10)); }
      if (e.key === 'Escape') closeGoToLine();
    });
  }

  // Auto-close bracket/quote pairs
  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };

  if (editorTextarea) {
    editorTextarea.addEventListener('input', () => {
      updateEditorDirtyState();
      updateGutter();
      updateHighlight();
      updateLineHighlight();
    });
    // Scroll sync: gutter follows textarea, update scrollmap + line highlight + syntax
    editorTextarea.addEventListener('scroll', () => {
      syncGutterScroll();
      syncHighlightScroll();
      updateScrollmap();
      updateLineHighlight();
    });
    // Cursor position + line highlight tracking
    editorTextarea.addEventListener('click', () => { updateCursorPos(); updateLineHighlight(); });
    editorTextarea.addEventListener('keyup', () => { updateCursorPos(); updateLineHighlight(); });
    editorTextarea.addEventListener('select', () => { updateCursorPos(); updateLineHighlight(); });

    let _undoBurstTimer = null;

    editorTextarea.addEventListener('keydown', (e) => {
      const ta = e.target;
      const mod = e.ctrlKey || e.metaKey;

      // Typing snapshot — capture pre-edit state on first key of each burst
      const isTypingKey = e.key.length === 1 && !mod;
      const isDeleteKey = (e.key === 'Backspace' || e.key === 'Delete') && !mod;
      if ((isTypingKey || isDeleteKey) && !PAIRS[e.key]) {
        if (!_undoBurstOpen) {
          _undoBurstOpen = true;
          const top = _undoStack.length ? _undoStack[_undoStack.length - 1] : null;
          if (!top || top.value !== ta.value) {
            _undoStack.push({ value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd });
            if (_undoStack.length > 200) _undoStack.shift();
            _redoStack = [];
          }
        }
        clearTimeout(_undoBurstTimer);
        _undoBurstTimer = setTimeout(() => { _undoBurstOpen = false; }, 400);
      }

      // Ctrl+Z → undo
      if (e.key === 'z' && mod && !e.shiftKey) {
        e.preventDefault();
        editorUndo(ta);
        return;
      }

      // Ctrl+Y or Ctrl+Shift+Z → redo
      if ((e.key === 'y' && mod) || (e.key === 'z' && mod && e.shiftKey)) {
        e.preventDefault();
        editorRedo(ta);
        return;
      }

      // Tab → insert 2 spaces
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        editorInsertText(ta, '  ');
        return;
      }

      // Shift+Tab → unindent selected lines
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const val = ta.value;
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = val.indexOf('\n', end);
        const blockEnd = lineEnd === -1 ? val.length : lineEnd;
        const block = val.substring(lineStart, blockEnd);
        const unindented = block.split('\n').map(l => l.startsWith('  ') ? l.slice(2) : l.replace(/^\t/, '')).join('\n');
        editorReplaceRange(ta, lineStart, blockEnd, unindented);
        ta.setSelectionRange(lineStart, lineStart + unindented.length);
        updateEditorDirtyState();
        updateGutter();
        return;
      }

      // Enter → auto-indent
      if (e.key === 'Enter' && !mod) {
        e.preventDefault();
        const pos = ta.selectionStart;
        const val = ta.value;
        const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
        const line = val.substring(lineStart, pos);
        const indent = line.match(/^(\s*)/)[1];
        editorInsertText(ta, '\n' + indent);
        return;
      }

      // Ctrl+D → duplicate line
      if (e.key === 'd' && mod) {
        e.preventDefault();
        const pos = ta.selectionStart;
        const val = ta.value;
        const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
        let lineEnd = val.indexOf('\n', pos);
        if (lineEnd === -1) lineEnd = val.length;
        const line = val.substring(lineStart, lineEnd);
        editorPushUndo(ta);
        ta.value = val.substring(0, lineEnd) + '\n' + line + val.substring(lineEnd);
        const newPos = lineEnd + 1 + line.length;
        ta.selectionStart = ta.selectionEnd = newPos;
        updateEditorDirtyState();
        updateGutter();
        return;
      }

      // Ctrl+/ → toggle line comment
      if (e.key === '/' && mod) {
        e.preventDefault();
        const lang = $('fe-editor-lang')?.textContent || '';
        const prefix = COMMENT_PREFIX[lang] || '//';
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const val = ta.value;
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = val.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = val.length;
        const block = val.substring(lineStart, lineEnd);
        const lines = block.split('\n');
        const allCommented = lines.every(l => l.trimStart().startsWith(prefix));
        const toggled = lines.map(l => {
          if (allCommented) {
            const idx = l.indexOf(prefix);
            return l.substring(0, idx) + l.substring(idx + prefix.length + (l[idx + prefix.length] === ' ' ? 1 : 0));
          }
          return prefix + ' ' + l;
        }).join('\n');
        editorReplaceRange(ta, lineStart, lineEnd, toggled);
        ta.setSelectionRange(lineStart, lineStart + toggled.length);
        updateEditorDirtyState();
        updateGutter();
        return;
      }

      // Ctrl+S → save
      if (e.key === 's' && mod) {
        e.preventDefault();
        saveFileEditor();
        return;
      }

      // Ctrl+F → find
      if (e.key === 'f' && mod) {
        e.preventDefault();
        openFind();
        return;
      }

      // Ctrl+G → go to line
      if (e.key === 'g' && mod) {
        e.preventDefault();
        openGoToLine();
        return;
      }

      // Ctrl+H → focus replace (open find first if needed)
      if (e.key === 'h' && mod) {
        e.preventDefault();
        if (!_findOpen) openFind();
        const ri = $('fe-editor-replace-input');
        if (ri) ri.focus();
        return;
      }

      // Auto-close brackets and quotes
      if (PAIRS[e.key]) {
        const pos = ta.selectionStart;
        const end = ta.selectionEnd;
        editorPushUndo(ta);
        if (pos !== end) {
          const selected = ta.value.substring(pos, end);
          ta.value = ta.value.substring(0, pos) + e.key + selected + PAIRS[e.key] + ta.value.substring(end);
          ta.setSelectionRange(pos + 1, pos + 1 + selected.length);
        } else {
          ta.value = ta.value.substring(0, pos) + e.key + PAIRS[e.key] + ta.value.substring(pos);
          ta.setSelectionRange(pos + 1, pos + 1);
        }
        e.preventDefault();
        updateEditorDirtyState();
        return;
      }

      // Backspace → delete matching pair if cursor is between them
      if (e.key === 'Backspace' && !mod) {
        const pos = ta.selectionStart;
        if (pos > 0 && pos === ta.selectionEnd) {
          const before = ta.value[pos - 1];
          const after = ta.value[pos];
          if (PAIRS[before] === after) {
            e.preventDefault();
            editorPushUndo(ta);
            ta.value = ta.value.substring(0, pos - 1) + ta.value.substring(pos + 1);
            ta.selectionStart = ta.selectionEnd = pos - 1;
            updateEditorDirtyState();
            updateGutter();
            return;
          }
        }
      }
    });
  }

  // Git panel
  initGitPanel();

  // Resize handle
  initResizeHandle();

  // Keybind
  registerAction('toggle-file-explorer', toggleFileExplorer);

  // Menu item
  const menuEl = $('menu-toggle-file-explorer');
  if (menuEl) {
    menuEl.addEventListener('click', toggleFileExplorer);
  }

  // Restore visibility
  if (_visible) {
    panel.classList.add('open');
    const titleBar = document.getElementById('title-bar');
    if (titleBar) titleBar.classList.add('file-explorer-active');
    document.body.classList.add('file-explorer-open');
    applyFileExplorerWidth();
    if (menuEl) menuEl.classList.add('active');
    _rootLoaded = true;
    fetchProjects().then(() => {
      initProjectSelector();
      return loadDirectory();
    }).then(() => buildFileTree());
  }
}

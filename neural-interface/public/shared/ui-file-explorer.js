import { sendToFocusedSession } from './ui-sidepanel-windows.js';
// ═══════════════════════════════════════════
// SynaBun Neural Interface — File Explorer
// ═══════════════════════════════════════════
//
// Docked sidebar that shows project files in a tree view.
// Sits adjacent to the Memory Explorer (to its right).
//
// This file is the panel's shell: it opens and closes it, sizes it, selects the
// project, holds the branch button's popover and the file icons, and wires the
// code editor. The tree and everything it does (keyboard, menu, operations,
// following the disk, git marks) is shared/explorer/, created here and loaded by
// its address: the editor's browser tests run this file without its imports.
// docs/file-explorer.md says what the panel does.

import { KEYS } from './constants.js';
import { registerAction } from './ui-keybinds.js';
import { storage } from './storage.js';
import { sendToPanel as sendToClaudePanel } from './ui-claude-panel.js';
import { attachPathToOpencode } from './ui-opencode-panel-v2.js';
import { isCodexPanelOpen, toggleCodexPanel } from './cdx/cdx-panel.js';
import { addPathChip as addCodexPathChip } from './cdx/cdx-tabs.js';
import { on, emit, state } from './state.js';
import {
  closeEditorPanel, initEditorPanel, isEditorPanelOpen,
  openChangelogInEditor, openFileInEditor, openPlanInEditor, saveEditorPanel,
} from './editor/editor-panel.js';

// What each side panel offers for a path. Every entry names its function only when it is called: a page that
// runs this file without its imports (the editor's tests) has none of them.
const SEND = {
  sendToFocusedSession: (kind, data) => sendToFocusedSession(kind, data),
  lastActive: () => state.lastActivePanel,
  // As a file reference, whatever is in the path (a space would otherwise make it text of the prompt).
  claude: (path) => sendToClaudePanel(path, { asFile: true }),
  codex: async (path) => { if (!isCodexPanelOpen()) await toggleCodexPanel(); addCodexPathChip(path); },
  opencode: (path) => attachPathToOpencode(path),
  assistant: (path) => attachToAssistant('assistant', path),
};
function attachToAssistant(target, filePath) {
  // The Assistant sidepanel: through the bus (a static import would close an import cycle). It marks the request
  // it took; one it did not take (the Assistant is switched off, or is not there) is not said to be sent.
  if (target !== 'assistant') return false;
  const request = { path: filePath };
  emit('assistant:attach-path', request);
  return request.taken === true;
}

const $ = (id) => document.getElementById(id);

// ─── Local state ────────────────────────
let _visible = false;
let _width = 260;
let _rootLoaded = false;
let _projects = [];            // [{ path, label }] from API
let _selectedProject = null;   // { path, label } of current project
let _folderColors = {};           // { "/path/to/folder": "#hex" }
let _customIcons = null;          // { extensions: {}, filenames: {} } from server
let _fx = null;                   // shared/explorer/fx-main.js createExplorer(): the tree and what it does
let _fxLoading = null;
let _guest = false;                // an invited guest's page: the File Explorer is the owner's, and is not offered
let _showing = null;              // the first tree being put up (the projects are read, then the selected one is shown)
let _tr = (key) => key;           // the translator, once shared/explorer/ is loaded
let _git = { isGit: false, branch: '', count: 0 };

const MIN_WIDTH = 240;
const MAX_WIDTH = 500;
const tr = (key, params) => _tr(key, params);
const samePath = (a, b) => String(a || '').replace(/\\/g, '/').replace(/\/+$/, '') === String(b || '').replace(/\\/g, '/').replace(/\/+$/, '');

// ─── SVG icons ────────────────────────
const FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><polyline points="13 2 13 7 18 7"/></svg>';

// ─── File type icons ────────────────────────
// Each shape is stroke-based (fill:none via CSS). Color set via `color` on .fe-icon span.
const FI = {
  code:     '<svg viewBox="0 0 24 24"><path d="M9 3H7C5.3 3 4 4.3 4 6v4c0 1.1-.9 2-2 2 1.1 0 2 .9 2 2v4c0 1.7 1.3 3 3 3h2"/><path d="M15 3h2c1.7 0 3 1.3 3 3v4c0 1.1.9 2 2 2-1.1 0-2 .9-2 2v4c0 1.7-1.3 3-3 3h-2"/></svg>',
  markup:   '<svg viewBox="0 0 24 24"><polyline points="8 6 2 12 8 18"/><polyline points="16 6 22 12 16 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>',
  style:    '<svg viewBox="0 0 24 24"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>',
  image:    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="6 9 10 12 6 15"/><line x1="12" y1="15" x2="18" y2="15"/></svg>',
  doc:      '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>',
  gear:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4M4.2 4.2l2.8 2.8m10 10l2.8 2.8M19.8 4.2l-2.8 2.8M7 17l-2.8 2.8"/></svg>',
  lock:     '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  git:      '<svg viewBox="0 0 24 24"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>',
  db:       '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  file:     FILE_SVG,
};

// Extension → { i: icon key, c: color hex }
const FI_MAP = {
  js: { i:'code', c:'#e8d44d' }, mjs: { i:'code', c:'#e8d44d' }, cjs: { i:'code', c:'#e8d44d' },
  ts: { i:'code', c:'#3178c6' }, mts: { i:'code', c:'#3178c6' }, cts: { i:'code', c:'#3178c6' },
  jsx: { i:'markup', c:'#61dafb' }, tsx: { i:'markup', c:'#61dafb' },
  html: { i:'markup', c:'#e44d26' }, htm: { i:'markup', c:'#e44d26' },
  xml: { i:'markup', c:'#e44d26' }, vue: { i:'markup', c:'#42b883' }, svelte: { i:'markup', c:'#ff3e00' },
  css: { i:'style', c:'#2196f3' }, scss: { i:'style', c:'#cd6799' }, sass: { i:'style', c:'#cd6799' }, less: { i:'style', c:'#6a9ccd' },
  json: { i:'code', c:'#a8b065' }, jsonc: { i:'code', c:'#a8b065' }, json5: { i:'code', c:'#a8b065' },
  py: { i:'code', c:'#3776ab' }, pyw: { i:'code', c:'#3776ab' },
  rb: { i:'code', c:'#cc342d' }, rs: { i:'code', c:'#dea584' }, go: { i:'code', c:'#00add8' },
  java: { i:'code', c:'#e76f00' }, kt: { i:'code', c:'#7f52ff' }, scala: { i:'code', c:'#dc322f' },
  php: { i:'code', c:'#777bb3' }, c: { i:'code', c:'#8a8a8a' }, h: { i:'code', c:'#8a8a8a' },
  cpp: { i:'code', c:'#00599c' }, cc: { i:'code', c:'#00599c' }, hpp: { i:'code', c:'#00599c' },
  cs: { i:'code', c:'#178600' }, swift: { i:'code', c:'#f05138' },
  lua: { i:'code', c:'#4e6faf' }, zig: { i:'code', c:'#f7a41d' }, r: { i:'code', c:'#276dc3' },
  wasm: { i:'code', c:'#654ff0' },
  sql: { i:'db', c:'#e38c00' }, csv: { i:'db', c:'#4eaa25' }, tsv: { i:'db', c:'#4eaa25' },
  md: { i:'doc', c:'#519aba' }, mdx: { i:'doc', c:'#519aba' }, txt: { i:'doc', c:'#9aa7b0' },
  yaml: { i:'gear', c:'#cb171e' }, yml: { i:'gear', c:'#cb171e' },
  toml: { i:'gear', c:'#9aa7b0' }, ini: { i:'gear', c:'#9aa7b0' },
  sh: { i:'terminal', c:'#4eaa25' }, bash: { i:'terminal', c:'#4eaa25' }, zsh: { i:'terminal', c:'#4eaa25' },
  bat: { i:'terminal', c:'#c1f12e' }, cmd: { i:'terminal', c:'#c1f12e' }, ps1: { i:'terminal', c:'#4e73b5' },
  png: { i:'image', c:'#a074c4' }, jpg: { i:'image', c:'#a074c4' }, jpeg: { i:'image', c:'#a074c4' },
  gif: { i:'image', c:'#a074c4' }, webp: { i:'image', c:'#a074c4' }, ico: { i:'image', c:'#a074c4' },
  bmp: { i:'image', c:'#a074c4' }, svg: { i:'image', c:'#ffb13b' },
  lock: { i:'lock', c:'#9aa7b0' }, log: { i:'file', c:'#9aa7b0' }, map: { i:'file', c:'#9aa7b0' },
};

function getFileIcon(filename) {
  const name = filename.toLowerCase();

  // Custom filename override
  if (_customIcons?.filenames?.[name]) {
    return { img: `/custom-icons/${_customIcons.filenames[name].path}`, color: null };
  }

  // Special filenames (check custom ext overrides inline)
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return { svg: FI.terminal, color: '#2496ed' };
  if (name === 'makefile' || name === 'gnumakefile') return { svg: FI.terminal, color: '#6d8086' };
  if (name.startsWith('.git')) return { svg: FI.git, color: '#f05032' };
  if (name === '.env' || name.startsWith('.env.')) return { svg: FI.gear, color: '#ecd53f' };
  if (/^(license|licence|notice)$/i.test(name)) return { svg: FI.doc, color: '#9aa7b0' };
  if (/^(readme|contributing|changelog|security)/i.test(name)) return { svg: FI.doc, color: '#519aba' };

  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';

  // Custom extension override
  if (ext && _customIcons?.extensions?.[ext]) {
    return { img: `/custom-icons/${_customIcons.extensions[ext].path}`, color: null };
  }

  const info = FI_MAP[ext];
  if (info) return { svg: FI[info.i], color: info.c };
  return { svg: FI.file, color: null };
}

// The tree and what it does, loaded when the panel is there.
function loadTree() {
  if (!_fxLoading) {
    _fxLoading = import('/shared/explorer/fx-main.js').catch((error) => {
      console.error('[file-explorer] could not load the tree', error);
      return null;
    });
  }
  return _fxLoading;
}
const whenTree = () => loadTree().then(() => _fx);


// ═══════════════════════════════════════════
// CSS VARIABLE — drives layout shift
// ═══════════════════════════════════════════

function applyFileExplorerWidth() {
  const w = _visible && !_guest ? `${_width}px` : '0px';
  document.documentElement.style.setProperty('--file-explorer-width', w);
}

function calcDefaultWidth() {
  const barLeft = document.querySelector('#title-bar .bar-left');
  if (!barLeft) return _width;
  const seps = barLeft.querySelectorAll('.bar-sep');
  if (seps.length < 2) return _width;
  const titleBar = document.getElementById('title-bar');
  const tbPad = parseFloat(getComputedStyle(titleBar).paddingLeft) || 18;
  const barLeftRect = barLeft.getBoundingClientRect();
  const sepRect = seps[1].getBoundingClientRect();
  const w = Math.round(sepRect.right - barLeftRect.left + tbPad);
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
}


// ═══════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════

function saveVisible() { try { storage.setItem(KEYS.FILE_EXPLORER_VISIBLE, String(_visible)); } catch {} }
function saveWidth() { try { storage.setItem(KEYS.FILE_EXPLORER_WIDTH, String(_width)); } catch {} }
function saveFolderColors() { try { storage.setItem(KEYS.FILE_EXPLORER_FOLDER_COLORS, JSON.stringify(_folderColors)); } catch {} }

function loadPersistedState() {
  const vis = storage.getItem(KEYS.FILE_EXPLORER_VISIBLE);
  if (vis === 'true') _visible = true;

  const w = parseInt(storage.getItem(KEYS.FILE_EXPLORER_WIDTH), 10);
  if (w >= MIN_WIDTH && w <= MAX_WIDTH) _width = w;

  try {
    const fc = JSON.parse(storage.getItem(KEYS.FILE_EXPLORER_FOLDER_COLORS) || '{}');
    if (fc && typeof fc === 'object') _folderColors = fc;
  } catch {}
}

// Folder colours: the first is the folder's own, the one a folder has when none is set.
const FOLDER_COLORS = [
  { hex: '#ffb74d', key: 'amber' },
  { hex: '#64b5f6', key: 'blue' },
  { hex: '#81c784', key: 'green' },
  { hex: '#e57373', key: 'red' },
  { hex: '#ba68c8', key: 'purple' },
  { hex: '#4dd0e1', key: 'cyan' },
  { hex: '#fff176', key: 'yellow' },
  { hex: '#a1887f', key: 'brown' },
  { hex: '#90a4ae', key: 'grey' },
];
const folderColors = {
  all: FOLDER_COLORS,
  of: (path) => _folderColors[path],
  set(path, color) {
    if (color) _folderColors[path] = color; else delete _folderColors[path];
    saveFolderColors();
  },
  // A folder that was renamed or moved keeps its colour, and so do the folders inside it.
  move(from, to) {
    let changed = false;
    for (const path of Object.keys(_folderColors)) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      _folderColors[to + path.slice(from.length)] = _folderColors[path];
      delete _folderColors[path];
      changed = true;
    }
    if (changed) saveFolderColors();
  },
};


// ═══════════════════════════════════════════
// PROJECT SELECTOR
// ═══════════════════════════════════════════

let _projectsFailed = false;

async function fetchProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    _projectsFailed = !(data.ok && Array.isArray(data.projects));
    if (!_projectsFailed) {
      _projects = data.projects;
      // What this server has for the tree (an older one lists nothing: the tree then asks it for nothing new).
      _fx?.api.serverSays(Array.isArray(data.capabilities) ? data.capabilities : []);
    }
  } catch { _projectsFailed = true; }
  return _projects;
}

function showProjectLabel() {
  const label = $('fe-project-label');
  const btn = $('fe-project-btn');
  const name = _selectedProject ? _selectedProject.label : tr('fileExplorer.project.none');
  if (label) label.textContent = name;
  if (btn) {
    btn.title = _selectedProject ? _selectedProject.path : '';
    btn.setAttribute('aria-label', tr('fileExplorer.project.label', { name }));
  }
}

function selectProject(proj) {
  _selectedProject = proj;
  try { storage.setItem(KEYS.FILE_EXPLORER_PROJECT, proj.path); } catch {}
  showProjectLabel();
  closeProjectDropdown();
  buildProjectDropdown();
  // The tree of that project comes back as it was left: what was open, selected and scrolled to.
  return whenTree().then((tree) => tree?.setProject(proj));
}

// The tree of the selected project, or what there is to say when there is none.
async function showTree() {
  const tree = await whenTree();
  if (!tree) return;
  await fetchProjects();
  initProjectSelector();
  await tree.setProject(_selectedProject);
  if (_projectsFailed) {
    tree.notice.show(tr('fileExplorer.error.offline'), { tone: 'error', action: { label: tr('fileExplorer.state.retry'), run: showTree } });
  }
}

function updateBranchLabel(git) {
  _git = git;
  const btn = $('fe-branch-btn');
  const nameEl = $('fe-branch-btn-name');
  const badge = $('fe-branch-btn-badge');
  if (!btn) return;

  if (git.isGit && git.branch) {
    btn.style.display = '';
    if (nameEl) nameEl.textContent = git.branch;
    if (badge) badge.textContent = git.count > 0 ? git.count : '';
    btn.setAttribute('aria-label', tr('fileExplorer.branch.label', { branch: git.branch, count: git.count }));
    btn.dataset.tooltip = tr('fileExplorer.branch.label', { branch: git.branch, count: git.count });
    if (_gitPopoverOpen) renderGitSummary();
  } else {
    btn.style.display = 'none';
    closeGitPopover();
  }
}


// ═══════════════════════════════════════════
// GIT POPOVER
// ═══════════════════════════════════════════

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
  const popWidth = pop.offsetWidth || 248;
  const flipped = left + popWidth > window.innerWidth;
  if (flipped) left = Math.max(8, r.left - popWidth - 8);
  if (arrow) arrow.classList.toggle('flipped', flipped);

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

  resetCommitOutput();
  _gitPopoverOpen = true;
  btn?.classList.add('active');
  btn?.setAttribute('aria-expanded', 'true');
  positionGitPopover();

  requestAnimationFrame(() => pop.classList.add('visible'));
  loadGitBranches();
  renderGitSummary();
  _fx?.refresh();
}

function closeGitPopover() {
  const pop = $('fe-git-popover');
  const btn = $('fe-branch-btn');
  if (!pop) return;
  resetCommitOutput();
  _gitPopoverOpen = false;
  pop.classList.remove('visible');
  btn?.classList.remove('active');
  btn?.setAttribute('aria-expanded', 'false');
}

function toggleGitPopover() {
  if (_gitPopoverOpen) closeGitPopover();
  else openGitPopover();
}

// What changed, in words and counts: from the git state the tree already holds.
function renderGitSummary() {
  const summary = $('fe-git-summary');
  if (!summary) return;
  const changes = _fx?.state.git.changed() || [];
  summary.textContent = '';
  if (changes.length === 0) { summary.textContent = tr('fileExplorer.gitPanel.clean'); return; }
  const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, other: 0 };
  for (const c of changes) {
    if (c.status === 'modified' || c.status === 'mixed') counts.modified++;
    else if (c.status === 'added' || c.status === 'staged') counts.added++;
    else if (c.status === 'deleted') counts.deleted++;
    else if (c.status === 'untracked') counts.untracked++;
    else counts.other++;
  }
  const classes = { modified: 'gs-m', added: 'gs-a', deleted: 'gs-d', untracked: 'gs-u', other: '' };
  let first = true;
  for (const kind of Object.keys(counts)) {
    if (!counts[kind]) continue;
    if (!first) summary.append(' · ');
    first = false;
    const part = document.createElement('span');
    if (classes[kind]) part.className = classes[kind];
    part.textContent = tr(`fileExplorer.gitPanel.count.${kind}`, { count: counts[kind] });
    summary.append(part);
  }
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
      showToast(tr('fileExplorer.gitPanel.switched', { branch: data.branch || branch }));
      closeGitPopover();
      _fx?.refresh();
    } else {
      showToast(data.error || tr('fileExplorer.gitPanel.checkoutFailed'));
      loadGitBranches();
    }
  } catch {
    showToast(tr('fileExplorer.gitPanel.checkoutFailed'));
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
      showCommitOutput(data.output, true);
      _fx?.refresh();
    } else {
      showCommitOutput(data.error || tr('fileExplorer.gitPanel.commitFailed'), false);
    }
  } catch {
    showCommitOutput(tr('fileExplorer.gitPanel.commitFailed'), false);
  } finally {
    btn?.classList.remove('loading');
  }
}

function showCommitOutput(text, isSuccess) {
  const controls = $('fe-git-controls');
  const output = $('fe-git-output');
  const pop = $('fe-git-popover');
  if (!controls || !output || !pop) return;

  controls.style.display = 'none';

  const icon = isSuccess
    ? '<svg viewBox="0 0 24 24" class="fe-git-output-icon ok" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg viewBox="0 0 24 24" class="fe-git-output-icon" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  output.innerHTML =
    `<div class="fe-git-output-header">${icon} ${escHtml(tr(isSuccess ? 'fileExplorer.gitPanel.committed' : 'fileExplorer.gitPanel.failed'))}</div>` +
    `<pre class="fe-git-output-pre${isSuccess ? '' : ' error'}">${escHtml(text)}</pre>`;
  output.style.display = 'block';
  pop.classList.add('fe-git-output-mode');
  positionGitPopover();
}

function resetCommitOutput() {
  const controls = $('fe-git-controls');
  const output = $('fe-git-output');
  const pop = $('fe-git-popover');
  if (controls) controls.style.display = '';
  if (output) { output.innerHTML = ''; output.style.display = 'none'; }
  if (pop) pop.classList.remove('fe-git-output-mode');
}

async function generateCommitMessage() {
  const input = $('fe-git-commit-input');
  const genBtn = $('fe-git-gen-btn');
  if (!input || !_selectedProject) return;

  genBtn?.classList.add('loading');
  try {
    const res = await fetch('/api/git/generate-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _selectedProject.path })
    });
    const data = await res.json();
    if (data.ok && data.message) {
      input.value = data.message;
      input.focus();
    } else {
      showToast(data.summary || tr('fileExplorer.gitPanel.noChanges'));
    }
  } catch {
    showToast(tr('fileExplorer.gitPanel.generateFailed'));
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
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', tr('fileExplorer.gitPanel.label'));
  pop.innerHTML = `
    <div class="fe-git-popover-arrow"></div>
    <div class="fe-git-controls" id="fe-git-controls">
      <div class="fe-git-pop-section">
        <label class="fe-git-pop-label" for="fe-git-branch-select">${escHtml(tr('fileExplorer.gitPanel.branch'))}</label>
        <select class="fe-git-branch-select" id="fe-git-branch-select"></select>
      </div>
      <div class="fe-git-pop-sep"></div>
      <div class="fe-git-pop-section">
        <label class="fe-git-pop-label" for="fe-git-commit-input">${escHtml(tr('fileExplorer.gitPanel.commit'))}</label>
        <div class="fe-git-commit-area">
          <button class="fe-git-gen-btn" id="fe-git-gen-btn" data-tooltip="${escHtml(tr('fileExplorer.gitPanel.generate'))}" aria-label="${escHtml(tr('fileExplorer.gitPanel.generate'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L9.5 8.5 3 10l5 4-1.5 7L12 17.5 17.5 21 16 14l5-4-6.5-1.5z"/></svg>
          </button>
          <input type="text" class="fe-git-commit-input" id="fe-git-commit-input" placeholder="${escHtml(tr('fileExplorer.gitPanel.message'))}" autocomplete="off" spellcheck="false" maxlength="200">
          <button class="fe-git-commit-btn" id="fe-git-commit-btn" data-tooltip="${escHtml(tr('fileExplorer.gitPanel.commitAction'))}" aria-label="${escHtml(tr('fileExplorer.gitPanel.commitAction'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
        </div>
      </div>
      <div class="fe-git-pop-sep"></div>
      <div class="fe-git-pop-section">
        <div class="fe-git-summary" id="fe-git-summary"></div>
      </div>
    </div>
    <div class="fe-git-output" id="fe-git-output"></div>`;
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
    branchBtn.setAttribute('aria-haspopup', 'dialog');
    branchBtn.setAttribute('aria-expanded', 'false');
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
  // Its keys stay in it, and Escape closes it.
  popover.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeGitPopover(); branchBtn?.focus(); }
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
    });
    commitInput.addEventListener('click', (e) => e.stopPropagation());
  }
}

function closeProjectDropdown() {
  const wrap = $('fe-project-selector');
  if (wrap) wrap.classList.remove('open');
  $('fe-project-btn')?.setAttribute('aria-expanded', 'false');
}

function toggleProjectDropdown() {
  const wrap = $('fe-project-selector');
  if (!wrap) return;
  const open = wrap.classList.toggle('open');
  $('fe-project-btn')?.setAttribute('aria-expanded', String(open));
  if (open) ($('fe-project-dropdown')?.querySelector('.fe-project-option.active') || $('fe-project-dropdown')?.querySelector('.fe-project-option'))?.focus();
}

function buildProjectDropdown() {
  const dd = $('fe-project-dropdown');
  if (!dd) return;
  dd.innerHTML = '';
  dd.setAttribute('role', 'listbox');
  dd.setAttribute('aria-label', tr('fileExplorer.project.choose'));

  const folderSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  const plusSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  for (const p of _projects) {
    const active = !!_selectedProject && _selectedProject.path === p.path;
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'fe-project-option' + (active ? ' active' : '');
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', String(active));
    opt.title = p.path;
    opt.innerHTML = folderSvg + '<span class="fe-opt-label">' + escHtml(p.label) + '</span>';
    opt.addEventListener('click', (e) => { e.stopPropagation(); selectProject(p); $('fe-project-btn')?.focus(); });
    dd.appendChild(opt);
  }

  // Separator + Add Project
  const sep = document.createElement('div');
  sep.className = 'fe-project-sep';
  dd.appendChild(sep);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'fe-project-option fe-add-project';
  addBtn.setAttribute('role', 'option');
  addBtn.setAttribute('aria-selected', 'false');
  addBtn.innerHTML = plusSvg + '<span class="fe-opt-label">' + escHtml(tr('fileExplorer.project.add')) + '</span>';
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); addProjectFlow(); });
  dd.appendChild(addBtn);
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;'); }

async function addProjectFlow() {
  closeProjectDropdown();
  try {
    const res = await fetch('/api/browse-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: tr('fileExplorer.project.pickFolder') }) });
    const data = await res.json();
    if (!data.path) return; // User cancelled

    // Register as a project
    const label = data.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || data.path;
    const integRes = await fetch('/api/claude-code/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'project', projectPath: data.path, label }) });
    const integData = await integRes.json().catch(() => ({}));

    // Windows git CVE-2022-24765 safe.directory prompt — only fires when server detected the specific error.
    if (integData && integData.dubiousOwnership && integData.trustPath) {
      await promptTrustWorkspace(integData.trustPath);
    }

    // Refresh projects list and select the new one
    await fetchProjects();
    const newProj = _projects.find(p => samePath(p.path, data.path));
    if (newProj) {
      _selectedProject = newProj;
      try { storage.setItem(KEYS.FILE_EXPLORER_PROJECT, newProj.path); } catch {}
    }
    initProjectSelector();
    if (newProj) selectProject(newProj);
    else showToast(tr('fileExplorer.project.addFailed'));
  } catch (err) {
    showToast(tr('fileExplorer.project.addFailed'));
  }
}

function promptTrustWorkspace(trustPath) {
  return new Promise((resolve) => {
    const existing = document.getElementById('fe-trust-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'fe-trust-modal';
    overlay.className = 'fe-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'fe-modal fe-trust-modal';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'fe-trust-title');
    modal.innerHTML = `
      <div class="fe-modal-title" id="fe-trust-title"></div>
      <div class="fe-modal-body">
        <span id="fe-trust-body"></span>
        <div class="fe-trust-path" id="fe-trust-path"></div>
      </div>
      <div class="fe-modal-actions">
        <button class="fe-modal-btn fe-modal-cancel" id="fe-trust-skip"></button>
        <button class="fe-modal-btn fe-modal-confirm" id="fe-trust-confirm"></button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    modal.querySelector('#fe-trust-title').textContent = tr('fileExplorer.trust.title');
    modal.querySelector('#fe-trust-body').textContent = tr('fileExplorer.trust.body');
    modal.querySelector('#fe-trust-path').textContent = trustPath;
    modal.querySelector('#fe-trust-skip').textContent = tr('fileExplorer.trust.skip');
    modal.querySelector('#fe-trust-confirm').textContent = tr('fileExplorer.trust.confirm');

    requestAnimationFrame(() => overlay.classList.add('fe-modal-overlay--in'));
    modal.querySelector('#fe-trust-skip').focus();

    const done = () => {
      overlay.classList.remove('fe-modal-overlay--in');
      setTimeout(() => overlay.remove(), 150);
      window.removeEventListener('keydown', onKey, true);
      resolve();
    };
    // Taken at the window: the page's own shortcuts listen before a dialog's buttons would.
    const onKey = (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') { ev.preventDefault(); done(); } };
    window.addEventListener('keydown', onKey, true);

    modal.querySelector('#fe-trust-skip').addEventListener('click', done);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) done(); });

    modal.querySelector('#fe-trust-confirm').addEventListener('click', async () => {
      const btn = modal.querySelector('#fe-trust-confirm');
      btn.disabled = true;
      btn.textContent = tr('fileExplorer.trust.trusting');
      try {
        const res = await fetch('/api/terminal/trust-workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: trustPath }),
        });
        const data = await res.json();
        if (data.ok) showToast(tr('fileExplorer.trust.done'));
        else showToast(data.error || tr('fileExplorer.trust.failed'));
      } catch {
        showToast(tr('fileExplorer.trust.failed'));
      }
      done();
    });
  });
}

function initProjectSelector() {
  const btn = $('fe-project-btn');
  const wrap = $('fe-project-selector');
  if (!btn || !wrap) return;

  // Restore persisted selection
  const saved = storage.getItem(KEYS.FILE_EXPLORER_PROJECT);
  const match = _projects.find(p => p.path === saved);
  _selectedProject = match || _projects[0] || null;

  showProjectLabel();

  // Build dropdown options
  buildProjectDropdown();

  // Wire toggle (safe to reassign)
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.onclick = (e) => { e.stopPropagation(); toggleProjectDropdown(); };

  // Close on outside click
  if (!wrap._outsideHandler) {
    wrap._outsideHandler = (e) => {
      if (!wrap.contains(e.target)) closeProjectDropdown();
    };
    document.addEventListener('click', wrap._outsideHandler);
    // Arrows move along the list, Escape closes it; none of its keys reach the page's shortcuts.
    wrap.addEventListener('keydown', (e) => {
      if (!wrap.classList.contains('open')) { if (e.key === 'ArrowDown' && e.target === btn) { e.preventDefault(); e.stopPropagation(); toggleProjectDropdown(); } return; }
      e.stopPropagation();
      const options = [...wrap.querySelectorAll('.fe-project-option')];
      const at = options.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeProjectDropdown(); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); options[(at + 1) % options.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); options[(at - 1 + options.length) % options.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); options[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); options[options.length - 1]?.focus(); }
    });
  }
}


// Show a file in the tree (the editor's "Reveal in tree"): the explorer is opened, the file's project is
// selected when it is another one, its folders are expanded, and its row is selected and marked for a
// moment. Answers whether the file was found.
async function revealFileInTree(filePath) {
  const slashes = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const target = slashes(filePath);
  if (!target) return false;
  if (!_visible) toggleFileExplorer();
  const tree = await whenTree();
  if (!tree) return false;
  // A panel that was just opened is still reading its projects: the file's project is chosen after that.
  syncTree();
  await _showing;
  await tree.whenLoaded();
  if (!_projects.length) await fetchProjects();
  const project = [..._projects].sort((a, b) => b.path.length - a.path.length).find((p) => target.startsWith(slashes(p.path) + '/'));
  if (!project) return false;
  if (!_selectedProject || slashes(_selectedProject.path) !== slashes(project.path)) await selectProject(project);
  return tree.reveal(target);
}

function showToast(msg) {
  let toast = document.getElementById('fe-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'fe-toast';
    toast.setAttribute('role', 'status');
    toast.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:rgba(30,30,34,0.95);color:#e0e0e0;padding:6px 16px;border-radius:6px;font-size:12px;font-family:var(--ff-mono);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.2s;border:1px solid rgba(255,255,255,0.1);';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}


// ═══════════════════════════════════════════
// RESIZE HANDLE
// ═══════════════════════════════════════════

function initResizeHandle() {
  const handle = $('fe-resize-handle');
  const panel = $('file-explorer-panel');
  if (!handle || !panel) return;

  let dragging = false;
  let resizeRaf = 0;
  let pendingWidth = _width;
  let explorerWidth = 0;
  const clamp = (width) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 48), width));

  const applyResize = () => {
    resizeRaf = 0;
    _width = pendingWidth;
    panel.style.width = `${_width}px`;
    handle.setAttribute('aria-valuenow', String(_width));
    applyFileExplorerWidth();
  };
  const scheduleResize = (width) => {
    pendingWidth = width;
    if (!resizeRaf) resizeRaf = requestAnimationFrame(applyResize);
  };
  const flushResize = () => {
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
    }
    applyResize();
  };
  const settle = () => {
    saveWidth();
    window.dispatchEvent(new Event('resize'));
  };

  handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
  handle.setAttribute('aria-valuemax', String(MAX_WIDTH));
  handle.setAttribute('aria-valuenow', String(_width));

  // A mouse, a finger or a pen: the pointer is held by the handle until it is let go.
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    dragging = true;
    explorerWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--explorer-width')) || 0;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // The panel left edge starts at --explorer-width
    scheduleResize(clamp(e.clientX - explorerWidth));
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    flushResize();
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    settle();
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);

  // The arrow keys resize it too.
  handle.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    pendingWidth = clamp(_width + step);
    flushResize();
    settle();
  });
}


// ═══════════════════════════════════════════
// TOGGLE
// ═══════════════════════════════════════════

export function toggleFileExplorer() {
  const panel = $('file-explorer-panel');
  if (!panel || _guest) return;

  // If closing while editor is open + dirty, prompt first
  if (_visible && isEditorPanelOpen()) {
    if (!closeEditorPanel()) return; // User cancelled discard
  }

  _visible = !_visible;
  panel.classList.toggle('open', _visible);
  panel.inert = !_visible;
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
  const tbBtn = $('topright-file-explorer-btn');
  if (tbBtn) tbBtn.classList.toggle('active', _visible);

  if (!_visible) closeGitPopover();
  syncTree();
}

// The tree follows the panel: built when it is first shown, and following the disk only while it is shown.
function syncTree() {
  if (!_fx) return;
  _fx.setVisible(_visible && !_guest);
  if (_visible && !_guest && !_rootLoaded) {
    _rootLoaded = true;
    _showing = showTree();
  }
}


// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

async function loadCustomIcons() {
  try {
    const r = await fetch('/api/file-icons').then(r => r.json());
    if (r.ok) _customIcons = r.custom;
  } catch {}
}

export function initFileExplorer() {
  loadPersistedState();
  loadCustomIcons(); // non-blocking — icons load in background

  // Re-render tree when custom icons change
  on('sync:icons:changed', () => {
    loadCustomIcons().then(() => { _fx?.redraw(); });
  });

  // ── Code editor (shared/editor/) — opened from the tree, and by other panels through the bus ──
  initEditorPanel({
    toast: showToast,
    projectRoot: () => _selectedProject?.path || null,
    beforeOpen: () => _fx?.closeMenus(),
    revealInTree: revealFileInTree,
    fileIcon: getFileIcon,
    // ui-settings.js imports this module: it is loaded when it is asked for, not at the top.
    openSettings: (target) => import('./ui-settings.js').then((settings) => settings.openSettingsModal(target)).catch((error) => console.warn('[editor] could not open Settings', error)),
  });
  // Plan editor — a panel opens its plan file for direct editing
  on('open-plan-editor', (contract = {}) => openPlanInEditor(contract));
  // Changelog editor — the Claude panel opens a changelog draft for direct editing
  on('open-changelog-editor', ({ filePath } = {}) => openChangelogInEditor({ filePath }));
  on('open-file-editor', ({ filePath, line, column } = {}) => openFileInEditor(filePath, { line, column }));

  const panel = $('file-explorer-panel');
  if (!panel) return;

  // The File Explorer is the owner's: its routes refuse an invited guest. A guest's page does not offer it (as it
  // does not offer Share): its button and menu entry are hidden, and so is the panel if the owner left it open.
  // Nothing is stored for that: the state on the server is the owner's.
  on('session:info', ({ isGuest: guest } = {}) => {
    _guest = !!guest;
    for (const id of ['menu-toggle-file-explorer', 'topright-file-explorer-btn']) { const el = $(id); if (el) el.style.display = _guest ? 'none' : ''; }
    panel.hidden = _guest;
    const shown = _visible && !_guest;
    document.getElementById('title-bar')?.classList.toggle('file-explorer-active', shown);
    document.body.classList.toggle('file-explorer-open', shown);
    applyFileExplorerWidth();
    if (_guest) closeGitPopover();
    syncTree();
  });

  // Set width — use navbar-aligned default if no persisted value
  if (!storage.getItem(KEYS.FILE_EXPLORER_WIDTH)) {
    _width = calcDefaultWidth();
  }
  panel.style.width = `${_width}px`;
  panel.inert = !_visible;

  // Resize handle
  initResizeHandle();

  // Keybind
  registerAction('toggle-file-explorer', toggleFileExplorer);

  // Menu item
  const menuEl = $('menu-toggle-file-explorer');
  if (menuEl) {
    menuEl.addEventListener('click', toggleFileExplorer);
  }

  // Toolbar button
  const toolbarBtn = $('topright-file-explorer-btn');
  if (toolbarBtn) {
    toolbarBtn.addEventListener('click', toggleFileExplorer);
  }

  // Restore visibility
  if (_visible) {
    panel.classList.add('open');
    const titleBar = document.getElementById('title-bar');
    if (titleBar) titleBar.classList.add('file-explorer-active');
    document.body.classList.add('file-explorer-open');
    applyFileExplorerWidth();
    if (menuEl) menuEl.classList.add('active');
    if (toolbarBtn) toolbarBtn.classList.add('active');
  }

  // The tree, and what the panel says in the user's language.
  loadTree().then((mod) => {
    if (!mod) {
      // Its own words could not be loaded with it: they are asked for by themselves.
      import('/shared/i18n.js').then((i18n) => { $('fe-tree')?.append(Object.assign(document.createElement('div'), { className: 'fe-note fe-note--error', textContent: i18n.t('fileExplorer.loadFailed') })); }).catch(() => {});
      return;
    }
    _tr = mod.t;
    initGitPanel();
    _fx = mod.createExplorer({
      panel,
      storage,
      KEYS,
      editor: { openFile: (path, at) => openFileInEditor(path, at), save: () => saveEditorPanel() },
      send: SEND,
      fileIcon: getFileIcon,
      folderSvg: FOLDER_SVG,
      colors: folderColors,
      onGit: updateBranchLabel,
      addProject: addProjectFlow,
      readServer: fetchProjects,
    });
    syncTree();
  });
}

// Exports for Settings → Icons tab preview
export { FI, FI_MAP, getFileIcon };

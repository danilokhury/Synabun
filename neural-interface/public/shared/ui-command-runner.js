// ═══════════════════════════════════════════
// SynaBun Neural Interface — Command Runner
// Save and one-click execute terminal commands,
// organized by category groups.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { KEYS, COLOR_PALETTE } from './constants.js';
import { storage } from './storage.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const genId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// ── Module-local state ──
let _panel = null;
let _data = { categories: [], commands: [] };
let _editTarget = null; // { type: 'command'|'category', id: string|null } — null = creating new

const PANEL_KEY = KEYS.PANEL_PREFIX + 'command-runner';
const DATA_KEY = KEYS.COMMAND_RUNNER;

// ── SVGs ──
const SVG_PLAY = `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>`;
const SVG_EDIT = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L5 13l-3 1 1-3z"/></svg>`;
const SVG_DELETE = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="4" x2="13" y2="4"/><path d="M6 4V3a1 1 0 011-1h2a1 1 0 011 1v1"/><path d="M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9"/></svg>`;
const SVG_CHEVRON = `<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 4 10 8 6 12"/></svg>`;
const SVG_CLOSE = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
const SVG_TERMINAL = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

export function initCommandRunner() {
  on('command-runner:open', () => openPanel());
}

// ═══════════════════════════════════════════
// PANEL LIFECYCLE
// ═══════════════════════════════════════════

function openPanel() {
  if (_panel) { _panel.focus(); return; }

  _panel = document.createElement('div');
  _panel.className = 'command-runner-panel glass resizable';
  _panel.id = 'command-runner-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  // Restore saved position
  try {
    const saved = JSON.parse(storage.getItem(PANEL_KEY));
    if (saved) {
      if (saved.x != null) _panel.style.left = saved.x + 'px';
      if (saved.y != null) _panel.style.top = Math.max(48, saved.y) + 'px';
      if (saved.w) _panel.style.width = saved.w + 'px';
      if (saved.h) _panel.style.height = saved.h + 'px';
    }
  } catch {}

  // Center if no saved position
  if (!_panel.style.left) {
    const vw = window.innerWidth, vh = window.innerHeight;
    _panel.style.left = Math.max(20, (vw - 420) / 2) + 'px';
    _panel.style.top = Math.max(48, (vh - 500) / 2) + 'px';
  }

  loadData();
  wirePanel();
  renderBody();

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
  _editTarget = null;
}

// ═══════════════════════════════════════════
// DATA
// ═══════════════════════════════════════════

function loadData() {
  try {
    const raw = storage.getItem(DATA_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      _data = {
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      };
    } else {
      _data = { categories: [], commands: [] };
    }
  } catch {
    _data = { categories: [], commands: [] };
  }
}

function saveData() {
  storage.setItem(DATA_KEY, JSON.stringify(_data));
}

function getCategoryCommands(catId) {
  return _data.commands
    .filter(c => c.categoryId === catId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ═══════════════════════════════════════════
// HTML BUILDERS
// ═══════════════════════════════════════════

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

    <div class="cr-header drag-handle" data-drag="command-runner-panel">
      <div class="cr-header-left">
        <span class="cr-header-icon">${SVG_TERMINAL}</span>
        <h3>Command Runner</h3>
        <span class="cr-count" id="cr-total-count"></span>
      </div>
      <div class="cr-header-actions">
        <button class="cr-header-btn" id="cr-add-cat-btn">+ Group</button>
        <button class="cr-header-btn cr-primary" id="cr-add-cmd-btn">+ Command</button>
      </div>
      <button class="cr-close" id="cr-close-btn">${SVG_CLOSE}</button>
    </div>

    <div class="cr-body" id="cr-body"></div>

    <div class="cr-modal-overlay hidden" id="cr-modal-overlay">
      <div class="cr-modal glass" id="cr-modal"></div>
    </div>
  `;
}

function renderBody() {
  const body = $('cr-body');
  if (!body) return;

  const countEl = $('cr-total-count');
  if (countEl) countEl.textContent = _data.commands.length || '';

  const sorted = [..._data.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (sorted.length === 0) {
    body.innerHTML = `
      <div class="cr-empty">
        <div class="cr-empty-icon">${SVG_TERMINAL}</div>
        <p>No commands yet</p>
        <p class="cr-empty-hint">Click <strong>+ Group</strong> to create a category,<br>then <strong>+ Command</strong> to add commands.</p>
      </div>
    `;
    return;
  }

  let html = '';
  for (const cat of sorted) {
    const cmds = getCategoryCommands(cat.id);
    const collapsed = cat.collapsed ? ' collapsed' : '';
    const dotColor = cat.color || COLOR_PALETTE[0];

    html += `<div class="cr-category${collapsed}" data-cat-id="${esc(cat.id)}">`;
    html += `  <div class="cr-cat-header">`;
    html += `    <span class="cr-cat-chevron">${SVG_CHEVRON}</span>`;
    html += `    <span class="cr-cat-dot" style="background:${esc(dotColor)}"></span>`;
    html += `    <span class="cr-cat-name">${esc(cat.name)}</span>`;
    html += `    <span class="cr-cat-count">${cmds.length}</span>`;
    html += `    <span class="cr-cat-actions">`;
    html += `      <button class="cr-icon-btn" data-action="edit-cat" title="Edit group">${SVG_EDIT}</button>`;
    html += `      <button class="cr-icon-btn cr-icon-btn--danger" data-action="delete-cat" title="Delete group">${SVG_DELETE}</button>`;
    html += `    </span>`;
    html += `  </div>`;
    html += `  <div class="cr-cat-body">`;

    if (cmds.length === 0) {
      html += `<div class="cr-cat-empty">No commands in this group</div>`;
    } else {
      for (const cmd of cmds) {
        html += `<div class="cr-cmd" data-cmd-id="${esc(cmd.id)}">`;
        html += `  <button class="cr-run-btn" title="Run command">${SVG_PLAY}</button>`;
        html += `  <div class="cr-cmd-info">`;
        html += `    <div class="cr-cmd-name">${esc(cmd.name)}</div>`;
        html += `    <div class="cr-cmd-text">${esc(cmd.command)}</div>`;
        if (cmd.cwd) {
          html += `  <div class="cr-cmd-cwd">${esc(cmd.cwd)}</div>`;
        }
        html += `  </div>`;
        html += `  <span class="cr-cmd-actions">`;
        html += `    <button class="cr-icon-btn" data-action="edit-cmd" title="Edit command">${SVG_EDIT}</button>`;
        html += `    <button class="cr-icon-btn cr-icon-btn--danger" data-action="delete-cmd" title="Delete command">${SVG_DELETE}</button>`;
        html += `  </span>`;
        html += `</div>`;
      }
    }

    html += `  </div>`;
    html += `</div>`;
  }

  body.innerHTML = html;
}

// ═══════════════════════════════════════════
// MODAL (Add/Edit forms)
// ═══════════════════════════════════════════

function openModal(type, id) {
  _editTarget = { type, id: id || null };
  const overlay = $('cr-modal-overlay');
  const modal = $('cr-modal');
  if (!overlay || !modal) return;

  if (type === 'category') {
    const existing = id ? _data.categories.find(c => c.id === id) : null;
    modal.innerHTML = buildCategoryForm(existing);
  } else {
    const existing = id ? _data.commands.find(c => c.id === id) : null;
    modal.innerHTML = buildCommandForm(existing);
  }

  overlay.classList.remove('hidden');
}

function closeModal() {
  const overlay = $('cr-modal-overlay');
  if (overlay) overlay.classList.add('hidden');
  _editTarget = null;
}

function buildCategoryForm(existing) {
  const name = existing ? esc(existing.name) : '';
  const activeColor = existing?.color || COLOR_PALETTE[0];

  let swatches = '';
  for (const c of COLOR_PALETTE.slice(0, 16)) {
    const sel = c === activeColor ? ' selected' : '';
    swatches += `<button type="button" class="cr-color-swatch${sel}" data-color="${c}" style="background:${c}"></button>`;
  }

  return `
    <div class="cr-modal-header">
      <h4>${existing ? 'Edit' : 'New'} Group</h4>
      <button class="cr-icon-btn" id="cr-modal-close">${SVG_CLOSE}</button>
    </div>
    <div class="cr-modal-body">
      <label class="cr-form-label">Name</label>
      <input class="cr-form-input" id="cr-cat-name" type="text" value="${name}" placeholder="e.g. Dev Servers" autocomplete="off" />
      <label class="cr-form-label" style="margin-top:12px">Color</label>
      <div class="cr-color-picker" id="cr-cat-color">${swatches}</div>
      <input type="hidden" id="cr-cat-color-val" value="${esc(activeColor)}" />
    </div>
    <div class="cr-modal-footer">
      <button class="cr-modal-btn" id="cr-modal-cancel">Cancel</button>
      <button class="cr-modal-btn cr-modal-btn--primary" id="cr-modal-save">${existing ? 'Save' : 'Create'}</button>
    </div>
  `;
}

function buildCommandForm(existing) {
  const name = existing ? esc(existing.name) : '';
  const command = existing ? esc(existing.command) : '';
  const cwd = existing?.cwd ? esc(existing.cwd) : '';
  const catId = existing?.categoryId || '';

  let catOptions = '';
  const sorted = [..._data.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const cat of sorted) {
    const sel = cat.id === catId ? ' selected' : '';
    catOptions += `<option value="${esc(cat.id)}"${sel}>${esc(cat.name)}</option>`;
  }

  return `
    <div class="cr-modal-header">
      <h4>${existing ? 'Edit' : 'New'} Command</h4>
      <button class="cr-icon-btn" id="cr-modal-close">${SVG_CLOSE}</button>
    </div>
    <div class="cr-modal-body">
      <label class="cr-form-label">Group</label>
      <select class="cr-form-input cr-form-select" id="cr-cmd-cat">${catOptions}</select>

      <label class="cr-form-label" style="margin-top:12px">Name</label>
      <input class="cr-form-input" id="cr-cmd-name" type="text" value="${name}" placeholder="e.g. Start Dev Server" autocomplete="off" />

      <label class="cr-form-label" style="margin-top:12px">Command</label>
      <input class="cr-form-input cr-form-mono" id="cr-cmd-command" type="text" value="${command}" placeholder="e.g. npm run dev" autocomplete="off" />

      <label class="cr-form-label" style="margin-top:12px">Working Directory <span class="cr-form-hint">(optional)</span></label>
      <input class="cr-form-input cr-form-mono" id="cr-cmd-cwd" type="text" value="${cwd}" placeholder="e.g. J:\\Sites\\CriticalPixel" autocomplete="off" />
    </div>
    <div class="cr-modal-footer">
      <button class="cr-modal-btn" id="cr-modal-cancel">Cancel</button>
      <button class="cr-modal-btn cr-modal-btn--primary" id="cr-modal-save">${existing ? 'Save' : 'Create'}</button>
    </div>
  `;
}

// ═══════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════

function saveFromModal() {
  if (!_editTarget) return;

  if (_editTarget.type === 'category') {
    const nameEl = $('cr-cat-name');
    const colorEl = $('cr-cat-color-val');
    const name = nameEl?.value.trim();
    if (!name) { nameEl?.focus(); return; }
    const color = colorEl?.value || COLOR_PALETTE[0];

    if (_editTarget.id) {
      // Update existing
      const cat = _data.categories.find(c => c.id === _editTarget.id);
      if (cat) { cat.name = name; cat.color = color; }
    } else {
      // Create new
      _data.categories.push({
        id: genId('cat'),
        name,
        color,
        collapsed: false,
        order: _data.categories.length,
      });
    }
  } else {
    const catEl = $('cr-cmd-cat');
    const nameEl = $('cr-cmd-name');
    const cmdEl = $('cr-cmd-command');
    const cwdEl = $('cr-cmd-cwd');

    const categoryId = catEl?.value;
    const name = nameEl?.value.trim();
    const command = cmdEl?.value.trim();
    const cwd = cwdEl?.value.trim() || null;

    if (!categoryId) { catEl?.focus(); return; }
    if (!name) { nameEl?.focus(); return; }
    if (!command) { cmdEl?.focus(); return; }

    if (_editTarget.id) {
      // Update existing
      const cmd = _data.commands.find(c => c.id === _editTarget.id);
      if (cmd) {
        cmd.categoryId = categoryId;
        cmd.name = name;
        cmd.command = command;
        cmd.cwd = cwd;
      }
    } else {
      // Create new
      const sibling = getCategoryCommands(categoryId);
      _data.commands.push({
        id: genId('cmd'),
        categoryId,
        name,
        command,
        cwd,
        order: sibling.length,
      });
    }
  }

  saveData();
  closeModal();
  renderBody();
}

function deleteCommand(id) {
  _data.commands = _data.commands.filter(c => c.id !== id);
  saveData();
  renderBody();
}

function deleteCategory(id) {
  const cmds = getCategoryCommands(id);
  if (cmds.length > 0) {
    if (!confirm(`Delete group and its ${cmds.length} command${cmds.length > 1 ? 's' : ''}?`)) return;
  }
  _data.commands = _data.commands.filter(c => c.categoryId !== id);
  _data.categories = _data.categories.filter(c => c.id !== id);
  saveData();
  renderBody();
}

function toggleCategoryCollapse(catId) {
  const cat = _data.categories.find(c => c.id === catId);
  if (cat) {
    cat.collapsed = !cat.collapsed;
    saveData();
    renderBody();
  }
}

// ═══════════════════════════════════════════
// RUN COMMAND
// ═══════════════════════════════════════════

function runCommand(cmdId) {
  const cmd = _data.commands.find(c => c.id === cmdId);
  if (!cmd) return;
  emit('terminal:run-command', {
    command: cmd.command,
    cwd: cmd.cwd || null,
    label: cmd.name,
  });
}

// ═══════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════

function wirePanel() {
  if (!_panel) return;

  // ── Main click delegation ──
  _panel.addEventListener('click', (e) => {
    // Close button
    if (e.target.closest('#cr-close-btn')) return closePanel();

    // Header add buttons
    if (e.target.closest('#cr-add-cat-btn')) return openModal('category');
    if (e.target.closest('#cr-add-cmd-btn')) {
      if (_data.categories.length === 0) {
        // Need at least one category first
        openModal('category');
      } else {
        openModal('command');
      }
      return;
    }

    // Run button
    const runBtn = e.target.closest('.cr-run-btn');
    if (runBtn) {
      const cmdEl = runBtn.closest('.cr-cmd');
      if (cmdEl) return runCommand(cmdEl.dataset.cmdId);
    }

    // Category actions
    const editCat = e.target.closest('[data-action="edit-cat"]');
    if (editCat) {
      const catEl = editCat.closest('.cr-category');
      if (catEl) return openModal('category', catEl.dataset.catId);
    }
    const delCat = e.target.closest('[data-action="delete-cat"]');
    if (delCat) {
      const catEl = delCat.closest('.cr-category');
      if (catEl) return deleteCategory(catEl.dataset.catId);
    }

    // Command actions
    const editCmd = e.target.closest('[data-action="edit-cmd"]');
    if (editCmd) {
      const cmdEl = editCmd.closest('.cr-cmd');
      if (cmdEl) return openModal('command', cmdEl.dataset.cmdId);
    }
    const delCmd = e.target.closest('[data-action="delete-cmd"]');
    if (delCmd) {
      const cmdEl = delCmd.closest('.cr-cmd');
      if (cmdEl) return deleteCommand(cmdEl.dataset.cmdId);
    }

    // Category header click → toggle collapse (but not if clicking actions)
    const catHeader = e.target.closest('.cr-cat-header');
    if (catHeader && !e.target.closest('.cr-cat-actions')) {
      const catEl = catHeader.closest('.cr-category');
      if (catEl) return toggleCategoryCollapse(catEl.dataset.catId);
    }

    // Modal buttons
    if (e.target.closest('#cr-modal-close') || e.target.closest('#cr-modal-cancel')) return closeModal();
    if (e.target.closest('#cr-modal-save')) return saveFromModal();

    // Color swatch selection
    const swatch = e.target.closest('.cr-color-swatch');
    if (swatch) {
      const picker = swatch.closest('.cr-color-picker');
      if (picker) {
        picker.querySelectorAll('.cr-color-swatch').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
        const hidden = $('cr-cat-color-val');
        if (hidden) hidden.value = swatch.dataset.color;
      }
      return;
    }
  });

  // ── Modal overlay background click → close ──
  const overlay = $('cr-modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  // ── Enter key submits modal form ──
  _panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && _editTarget) {
      e.preventDefault();
      saveFromModal();
    }
    if (e.key === 'Escape') {
      if (_editTarget) {
        closeModal();
      } else {
        closePanel();
      }
    }
  });
}

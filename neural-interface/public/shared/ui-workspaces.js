// ═══════════════════════════════════════════
// SynaBun Neural Interface — Workspaces
// ═══════════════════════════════════════════
//
// Save/load full scene snapshots: open cards, graph node positions,
// camera state (3D), active category filters, and selection.
// Floating overlay in top-right of the canvas.
// Export/import as JSON for backup.
//
// Events emitted:
//   workspace:get-scene   — request variant to provide { nodePositions, camera }
//   workspace:restore-scene — tell variant to restore { nodePositions, camera }
//   workspace:loaded       — after a workspace has been fully restored
//   graph:refresh          — re-filter graph after category change
//
// Events listened:
//   panel:close-all-dropdowns — close workspace dropdown
//   viz:toggled               — dim overlay when viz is off

import { state, emit, on } from './state.js';
import { KEYS } from './constants.js';
import { storage } from './storage.js';
import { getVariant } from './registry.js';
import {
  getOpenCardsSnapshot,
  closeAllCards,
  openMemoryCard,
} from './ui-detail.js';
import {
  getTerminalSnapshot,
  restoreTerminalSnapshot,
} from './ui-terminal.js';

const $ = (id) => document.getElementById(id);

let _isOpen = false;


// ═══════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════

function getWorkspaces() {
  try {
    return JSON.parse(storage.getItem(KEYS.WORKSPACES) || '[]');
  } catch {
    return [];
  }
}

function saveWorkspacesToStorage(list) {
  storage.setItem(KEYS.WORKSPACES, JSON.stringify(list));
}

function _readStoredPositions(key) {
  try {
    return JSON.parse(storage.getItem(key) || '{}');
  } catch {
    return {};
  }
}

function getActiveId() {
  try {
    return sessionStorage.getItem(KEYS.ACTIVE_WORKSPACE) || null;
  } catch {
    return null;
  }
}

function setActiveId(id) {
  try {
    if (id) {
      sessionStorage.setItem(KEYS.ACTIVE_WORKSPACE, id);
    } else {
      sessionStorage.removeItem(KEYS.ACTIVE_WORKSPACE);
    }
  } catch {}
}


// ═══════════════════════════════════════════
// CORE — SAVE
// ═══════════════════════════════════════════

function saveWorkspace(name) {
  if (!name || !name.trim()) return;
  name = name.trim();

  const currentVariant = getVariant() || '3d';

  // Request scene data from the active variant
  emit('workspace:get-scene', (sceneData) => {
    const { nodePositions, camera } = sceneData || {};

    const cards = getOpenCardsSnapshot();
    const terminal = getTerminalSnapshot();

    // Check if updating an existing workspace — preserve other variant's positions
    const list = getWorkspaces();
    const existingIdx = list.findIndex(w => w.name === name);
    const existing = existingIdx >= 0 ? list[existingIdx] : null;

    // Store positions per-variant so 2D and 3D layouts are independent.
    // Active variant: captured from scene. Inactive variant: preserved from
    // existing workspace, or read from persistent storage for new workspaces.
    const pos2d = currentVariant === '2d'
      ? (nodePositions || {})
      : (existing?.nodePositions2d || _readStoredPositions(KEYS.NODE_POS_2D));
    const pos3d = currentVariant === '3d'
      ? (nodePositions || {})
      : (existing?.nodePositions3d || _readStoredPositions(KEYS.NODE_POS_3D));

    const workspace = {
      id: String(Date.now()),
      name,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      variant: currentVariant,
      cards,
      terminal,
      nodePositions2d: pos2d,
      nodePositions3d: pos3d,
      camera: currentVariant === '3d' ? (camera || null) : (existing?.camera || null),
      activeCategories: [...state.activeCategories],
      selectedNodeId: state.selectedNodeId,
    };

    if (existingIdx >= 0) {
      workspace.id = existing.id;
      workspace.created = existing.created;
      list[existingIdx] = workspace;
    } else {
      list.unshift(workspace);
    }

    saveWorkspacesToStorage(list);
    setActiveId(workspace.id);
    updateIndicator();
    renderList();

    // Clear input
    const input = $('ws-name-input');
    if (input) input.value = '';
  });
}


// ═══════════════════════════════════════════
// CORE — LOAD
// ═══════════════════════════════════════════

function loadWorkspace(workspace) {
  // Close all current cards
  closeAllCards();

  const currentVariant = getVariant() || '3d';

  // Pick positions for the active variant only.
  // Legacy workspaces have a single nodePositions — use workspace.variant to assign.
  let positions;
  if (currentVariant === '2d') {
    positions = workspace.nodePositions2d
      || (workspace.variant === '2d' ? workspace.nodePositions : null)
      || {};
  } else {
    positions = workspace.nodePositions3d
      || (workspace.variant === '3d' ? workspace.nodePositions : null)
      || {};
  }

  // Wait for close animation, then restore
  setTimeout(() => {
    // Restore scene — only positions matching the active variant
    emit('workspace:restore-scene', {
      nodePositions: positions,
      camera: currentVariant === '3d' ? (workspace.camera || null) : null,
    });

    // Restore active categories
    if (workspace.activeCategories && workspace.activeCategories.length > 0) {
      state.activeCategories = new Set(workspace.activeCategories);
      emit('graph:refresh');
      emit('sidebar:rebuild');
    }

    // Restore open cards
    if (workspace.cards && workspace.cards.length > 0) {
      for (const card of workspace.cards) {
        const node = state.allNodes.find(n => n.id === card.memoryId);
        if (node) {
          openMemoryCard(node, {
            left: card.left,
            top: card.top,
            width: card.width,
            height: card.height,
            isCompact: card.isCompact,
          });
        }
      }
    }

    // Restore selection
    if (workspace.selectedNodeId) {
      state.selectedNodeId = workspace.selectedNodeId;
      storage.setItem(KEYS.SELECTED_NODE, workspace.selectedNodeId);
    }

    // Restore terminal state (position, detached/docked, floating tab positions)
    if (workspace.terminal) {
      restoreTerminalSnapshot(workspace.terminal);
    }

    setActiveId(workspace.id);
    updateIndicator();
    emit('workspace:loaded', workspace);
  }, 250);

  closeDropdown();
}


// ═══════════════════════════════════════════
// CORE — CLEAR WORKSPACE (with confirmation)
// ═══════════════════════════════════════════

function performClear() {
  closeAllCards();
  setActiveId(null);
  updateIndicator();
  emit('layout:reset');
}

function showClearDialog() {
  closeDropdown();

  // Build overlay + modal using the tag-delete pattern
  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';

  const autoName = 'Layout ' + new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  overlay.innerHTML = `
    <div class="tag-delete-modal" style="min-width:300px;">
      <div class="tag-delete-modal-title">Clear workspace?</div>
      <div style="color:var(--t-muted);font-size:12px;margin-bottom:14px;">
        This will close all cards and reset the layout.
      </div>
      <div class="ws-clear-save-row">
        <input type="text" id="ws-clear-name" placeholder="${autoName}" autocomplete="off" spellcheck="false">
        <button id="ws-clear-save-btn" class="ws-clear-action save" title="Save current layout, then clear">Save &amp; Clear</button>
      </div>
      <div class="tag-delete-modal-actions" style="margin-top:10px;">
        <button id="ws-clear-discard" class="ws-clear-action discard">Clear without saving</button>
        <button id="ws-clear-cancel" class="ws-clear-action cancel">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector('#ws-clear-name');
  const saveBtn = overlay.querySelector('#ws-clear-save-btn');
  const discardBtn = overlay.querySelector('#ws-clear-discard');
  const cancelBtn = overlay.querySelector('#ws-clear-cancel');

  const dismiss = () => {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 150);
  };

  // Save & Clear
  saveBtn.addEventListener('click', () => {
    const name = (nameInput.value.trim()) || autoName;
    saveWorkspace(name);
    // Small delay so save completes before clearing
    setTimeout(() => {
      performClear();
      dismiss();
    }, 100);
  });

  // Clear without saving
  discardBtn.addEventListener('click', () => {
    performClear();
    dismiss();
  });

  // Cancel
  cancelBtn.addEventListener('click', dismiss);

  // Overlay click = cancel
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });

  // Keyboard
  const onKey = (e) => {
    if (e.key === 'Escape') {
      dismiss();
      document.removeEventListener('keydown', onKey);
    } else if (e.key === 'Enter' && document.activeElement === nameInput) {
      e.preventDefault();
      saveBtn.click();
    }
  };
  document.addEventListener('keydown', onKey);

  // Focus the name input
  requestAnimationFrame(() => nameInput.focus());
}


// ═══════════════════════════════════════════
// CORE — DELETE / RENAME
// ═══════════════════════════════════════════

function deleteWorkspace(id) {
  const list = getWorkspaces().filter(w => w.id !== id);
  saveWorkspacesToStorage(list);
  if (getActiveId() === id) {
    setActiveId(null);
    updateIndicator();
  }
  renderList();
}

function confirmDeleteWorkspace(id, name) {
  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';

  overlay.innerHTML = `
    <div class="tag-delete-modal" style="min-width:280px;">
      <div class="tag-delete-modal-title">Delete workspace?</div>
      <div style="color:var(--t-bright);font-size:13px;font-weight:600;margin-bottom:6px;">${name}</div>
      <div style="color:var(--t-muted);font-size:12px;margin-bottom:16px;">
        This cannot be undone.
      </div>
      <div class="tag-delete-modal-actions">
        <button class="ws-clear-action discard" id="ws-confirm-delete">Delete</button>
        <button class="ws-clear-action" id="ws-confirm-cancel">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const deleteBtn = overlay.querySelector('#ws-confirm-delete');
  const cancelBtn = overlay.querySelector('#ws-confirm-cancel');

  const dismiss = () => {
    overlay.style.opacity = '0';
    setTimeout(() => overlay.remove(), 150);
  };

  deleteBtn.addEventListener('click', () => {
    dismiss();
    deleteWorkspace(id);
  });

  cancelBtn.addEventListener('click', dismiss);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });

  const onKey = (e) => {
    if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
}

function renameWorkspace(id, newName) {
  if (!newName || !newName.trim()) return;
  const list = getWorkspaces();
  const ws = list.find(w => w.id === id);
  if (ws) {
    ws.name = newName.trim();
    ws.updated = new Date().toISOString();
    saveWorkspacesToStorage(list);
    updateIndicator();
    renderList();
  }
}


// ═══════════════════════════════════════════
// BACKUP — EXPORT / IMPORT
// ═══════════════════════════════════════════

function exportWorkspaces() {
  const workspaces = getWorkspaces();
  if (workspaces.length === 0) return;

  const envelope = {
    version: 1,
    exported: new Date().toISOString(),
    workspaces,
  };

  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `synabun-workspaces-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importWorkspaces(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);

      // Validate structure
      if (!data || !Array.isArray(data.workspaces)) {
        console.warn('SynaBun: Invalid workspace file format');
        return;
      }

      const existing = getWorkspaces();
      const existingNames = new Set(existing.map(w => w.name));

      // Merge imported workspaces
      for (const ws of data.workspaces) {
        // Basic validation
        if (!ws.name || !ws.id) continue;

        // Handle name collisions
        if (existingNames.has(ws.name)) {
          ws.name = ws.name + ' (imported)';
          ws.id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
        }
        existingNames.add(ws.name);
        existing.push(ws);
      }

      saveWorkspacesToStorage(existing);
      renderList();
      updateIndicator();
    } catch (err) {
      console.warn('SynaBun: Failed to parse workspace file', err);
    }
  };
  reader.readAsText(file);
}


// ═══════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════

function renderList() {
  const listEl = $('ws-list');
  if (!listEl) return;

  const workspaces = getWorkspaces();
  const activeId = getActiveId();

  if (workspaces.length === 0) {
    listEl.innerHTML = '<div class="ws-empty">No saved workspaces</div>';
    return;
  }

  listEl.innerHTML = '';

  for (const ws of workspaces) {
    const row = document.createElement('div');
    row.className = 'ws-row' + (ws.id === activeId ? ' active' : '');

    const cardCount = ws.cards ? ws.cards.length : 0;
    const hasTerm = ws.terminal?.visible;
    const date = new Date(ws.updated || ws.created);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const meta = [`${cardCount} cards`];
    if (hasTerm) meta.push('CLI');
    meta.push(dateStr);

    row.innerHTML = `
      <span class="ws-row-name" title="${ws.name}">${ws.name}</span>
      <span class="ws-row-meta">${meta.join(' · ')}</span>
      <button class="ws-row-delete" title="Delete">&times;</button>
    `;

    // Load on click
    row.addEventListener('click', (e) => {
      if (e.target.closest('.ws-row-delete')) return;
      loadWorkspace(ws);
    });

    // Delete button
    row.querySelector('.ws-row-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeleteWorkspace(ws.id, ws.name);
    });

    listEl.appendChild(row);
  }
}

function updateIndicator() {
  const indicator = $('ws-indicator');
  const nameEl = $('ws-active-name');
  if (!indicator || !nameEl) return;

  const activeId = getActiveId();
  if (activeId) {
    const workspaces = getWorkspaces();
    const active = workspaces.find(w => w.id === activeId);
    if (active) {
      nameEl.textContent = active.name;
      indicator.classList.add('has-workspace');
      return;
    }
  }

  nameEl.textContent = 'No workspace';
  indicator.classList.remove('has-workspace');
}


// ═══════════════════════════════════════════
// DROPDOWN TOGGLE
// ═══════════════════════════════════════════

function openDropdown() {
  const dropdown = $('ws-dropdown');
  const indicator = $('ws-indicator');
  if (!dropdown) return;

  _isOpen = true;
  dropdown.style.display = '';
  indicator?.classList.add('open');
  renderList();

  emit('panel:close-all-dropdowns-except', 'workspace');
}

function closeDropdown() {
  const dropdown = $('ws-dropdown');
  const indicator = $('ws-indicator');
  if (!dropdown) return;

  _isOpen = false;
  dropdown.style.display = 'none';
  indicator?.classList.remove('open');
}

function toggleDropdown() {
  if (_isOpen) {
    closeDropdown();
  } else {
    openDropdown();
  }
}


// ═══════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════

export function initWorkspaces() {
  const indicator = $('ws-indicator');
  const saveBtn = $('ws-save-btn');
  const nameInput = $('ws-name-input');
  const exportBtn = $('ws-export-btn');
  const importBtn = $('ws-import-btn');
  const importFile = $('ws-import-file');

  // Toggle dropdown
  if (indicator) {
    indicator.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });
  }

  // Clear workspace (with confirmation dialog)
  const clearBtn = $('ws-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showClearDialog();
    });
  }

  // Save workspace
  if (saveBtn) {
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = nameInput ? nameInput.value.trim() : '';
      if (name) saveWorkspace(name);
    });
  }

  // Enter key in name input
  if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (name) saveWorkspace(name);
      }
    });
    // Stop propagation to prevent dropdown close on clicks inside
    nameInput.addEventListener('click', (e) => e.stopPropagation());
  }

  // Export
  if (exportBtn) {
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportWorkspaces();
    });
  }

  // Import
  if (importBtn) {
    importBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      importFile?.click();
    });
  }

  if (importFile) {
    importFile.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) importWorkspaces(file);
      // Reset so same file can be re-imported
      importFile.value = '';
    });
  }

  // Quick-save button
  const quickSaveBtn = $('ws-quick-save');
  if (quickSaveBtn) {
    quickSaveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const activeId = getActiveId();
      if (!activeId) return;
      const workspaces = getWorkspaces();
      const active = workspaces.find(w => w.id === activeId);
      if (!active) return;
      saveWorkspace(active.name);
      quickSaveBtn.classList.add('saved');
      setTimeout(() => quickSaveBtn.classList.remove('saved'), 800);
    });
  }

  // Grid snap toggle
  const gridBtn = $('ws-grid-toggle');
  if (gridBtn) {
    const saved = storage.getItem(KEYS.GRID_SNAP);
    if (saved === 'true') {
      state.gridSnap = true;
      gridBtn.classList.add('active');
      document.body.classList.add('grid-active');
    }
    gridBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.gridSnap = !state.gridSnap;
      gridBtn.classList.toggle('active', state.gridSnap);
      document.body.classList.toggle('grid-active', state.gridSnap);
      storage.setItem(KEYS.GRID_SNAP, state.gridSnap);
    });
  }

  // Close dropdown on click outside
  document.addEventListener('click', (e) => {
    if (!_isOpen) return;
    const container = $('topright-controls') || $('workspace-overlay');
    if (container && !container.contains(e.target)) {
      closeDropdown();
    }
  });

  // Close on global dropdown close event
  on('panel:close-all-dropdowns', () => closeDropdown());

  // Dim when visualization is toggled off
  on('viz:toggled', (visible) => {
    const container = $('topright-controls');
    if (container) {
      container.classList.toggle('viz-hidden', !visible);
    }
  });

  // Restore indicator state on init
  updateIndicator();
}

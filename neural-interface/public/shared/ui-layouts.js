// ═══════════════════════════════════════════
// SynaBun Neural Interface — Layout Presets
// Toolbar dropdown for saving / loading / applying node layout presets.
// Supports both built-in generative layouts (registered by each variant)
// and user-saved presets stored via server-backed storage.
// ═══════════════════════════════════════════

import { state, emit, on } from './state.js';
import { KEYS } from './constants.js';
import { storage } from './storage.js';
import { getVariant } from './registry.js';

const $ = (id) => document.getElementById(id);

// ── Module state ──
let activePresetId = null;

// Built-in presets are registered by the variant at boot time
// Each entry: { id, name, desc, generate: () => positions|null }
// For 3D: generate() returns { [nodeId]: {x,y,z} }
// For 2D: apply() is called directly (since 2D presets operate on the graph)
let _builtinPresets = [];

// ── Storage key selection ──

function storageKey() {
  return getVariant() === '2d' ? KEYS.LAYOUT_PRESETS_2D : KEYS.LAYOUT_PRESETS_3D;
}

// ── localStorage helpers ──

/**
 * Read user-saved layout presets from localStorage.
 * For 3D: returns Array<{id, name, created, positions, camera}>
 * For 2D: returns Object<name, {[nodeId]: {x,y}}>  (legacy format)
 * @returns {Array|Object}
 */
function getUserPresets() {
  try {
    return JSON.parse(storage.getItem(storageKey()) || (getVariant() === '2d' ? '{}' : '[]'));
  } catch {
    return getVariant() === '2d' ? {} : [];
  }
}

function saveUserPresets(data) {
  storage.setItem(storageKey(), JSON.stringify(data));
}

// ── Built-in preset registration ──

/**
 * Register built-in layout presets for the current variant.
 * Called by the variant boot code before initLayouts().
 *
 * 3D presets: { id, name, desc, generate: () => ({[nodeId]: {x,y,z}}|null) }
 * 2D presets: { id, name, desc, apply: () => void }
 *
 * @param {Array} presets
 */
export function registerBuiltinPresets(presets) {
  _builtinPresets = presets;
}

// ── Public API ──

/**
 * Save the current node positions as a named layout preset.
 * Emits 'layouts:get-positions' which the variant must handle
 * and respond to by calling the provided callback.
 * @param {string} name  Human-readable preset name
 */
export function saveLayout(name) {
  if (!name || !name.trim()) return;

  emit('layouts:save-request', {
    name: name.trim(),
    callback: (result) => {
      if (!result) return;

      const { positions, pinnedCount, camera } = result;

      if (pinnedCount === 0) {
        const warning = $('preset-warning');
        if (warning) {
          warning.classList.add('visible');
          setTimeout(() => warning.classList.remove('visible'), 2500);
        }
        return;
      }

      if (getVariant() === '2d') {
        // 2D stores as { name: { [nodeId]: {x,y} } }
        const userPresets = getUserPresets();
        userPresets[name.trim()] = positions;
        saveUserPresets(userPresets);
      } else {
        // 3D stores as array of preset objects
        const preset = {
          id: String(Date.now()),
          name: name.trim(),
          created: new Date().toISOString(),
          positions,
          camera: camera || null,
        };
        const presets = getUserPresets();
        presets.unshift(preset);
        saveUserPresets(presets);
        activePresetId = preset.id;
      }

      const nameInput = $('preset-name-input');
      if (nameInput) nameInput.value = '';
      const warning = $('preset-warning');
      if (warning) warning.classList.remove('visible');
      renderLayouts();
    }
  });
}

/**
 * Load a saved layout preset and apply it to the graph.
 * @param {Object} preset  The preset object (3D) or { name, positions } (2D)
 */
export function loadLayout(preset) {
  emit('layouts:apply', preset);
  if (preset.id) activePresetId = preset.id;
  renderLayouts();
}

/**
 * Delete a user-saved layout preset.
 * @param {string} idOrName  Preset ID (3D) or name (2D)
 */
export function deleteLayout(idOrName) {
  if (getVariant() === '2d') {
    const userPresets = getUserPresets();
    delete userPresets[idOrName];
    saveUserPresets(userPresets);
  } else {
    const presets = getUserPresets().filter(p => p.id !== idOrName);
    saveUserPresets(presets);
    if (activePresetId === idOrName) activePresetId = null;
  }
  renderLayouts();
}

// ── Dropdown rendering ──

/**
 * Render the list of built-in and user presets inside the dropdown panel.
 */
export function renderLayouts() {
  const listEl = $('preset-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const variant = getVariant() || '3d';

  // ── Built-in presets first ──
  _builtinPresets.forEach(bp => {
    const row = document.createElement('div');
    row.className = 'preset-row builtin' + (bp.id === activePresetId ? ' active' : '');
    row.innerHTML = `
      <span class="preset-name">${bp.name}</span>
      <span class="preset-badge">auto</span>
    `;
    if (bp.desc) row.title = bp.desc;
    row.addEventListener('click', () => {
      // Built-in presets are applied by the variant via event
      emit('layouts:apply-builtin', bp);
      activePresetId = bp.id;
      renderLayouts();
    });
    listEl.appendChild(row);
  });

  // ── User presets ──
  if (variant === '2d') {
    renderUserPresets2D(listEl);
  } else {
    renderUserPresets3D(listEl);
  }
}

function renderUserPresets3D(listEl) {
  const presets = getUserPresets();

  // Divider if user presets exist
  if (presets.length > 0) {
    const div = document.createElement('div');
    div.className = 'preset-divider';
    listEl.appendChild(div);
  }

  presets.forEach(preset => {
    const nodeCount = Object.keys(preset.positions).length;
    const date = new Date(preset.created);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const row = document.createElement('div');
    row.className = 'preset-row' + (preset.id === activePresetId ? ' active' : '');

    row.innerHTML = `
      <span class="preset-name">${preset.name}</span>
      <span class="preset-badge">${nodeCount}</span>
      <span class="preset-date">${dateStr}</span>
      <button class="preset-delete" data-tooltip="Delete">&times;</button>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('preset-delete')) return;
      loadLayout(preset);
    });

    row.querySelector('.preset-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLayout(preset.id);
    });

    listEl.appendChild(row);
  });

  if (presets.length === 0 && _builtinPresets.length === 0) {
    listEl.innerHTML = '<div class="preset-empty">No saved layouts</div>';
  }
}

function renderUserPresets2D(listEl) {
  const userPresets = getUserPresets(); // Object<name, positions>
  const names = Object.keys(userPresets);

  if (names.length > 0 && _builtinPresets.length > 0) {
    const div = document.createElement('div');
    div.className = 'preset-divider';
    listEl.appendChild(div);
  }

  names.forEach(name => {
    const data = userPresets[name];
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <span class="preset-name">${name}</span>
      <button class="preset-delete" data-tooltip="Delete">&times;</button>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.preset-delete')) {
        deleteLayout(name);
        return;
      }
      // Apply user preset positions via event
      emit('layouts:apply', { name, positions: data });
      emit('panel:close-all-dropdowns');
    });
    listEl.appendChild(row);
  });

  if (names.length === 0 && _builtinPresets.length === 0) {
    listEl.innerHTML = '<div class="preset-empty">No saved layouts</div>';
  }
}

// ── Initialization ──

/**
 * Wire up all layout-preset-related event listeners.
 * Call once after the DOM is ready and after registerBuiltinPresets().
 * Open/close is handled by the menubar (ui-menubar.js).
 */
export function initLayouts() {
  const presetNameInput = $('preset-name-input');
  const presetSaveBtn = $('preset-save-btn');

  // Menubar triggers rendering when Layouts menu opens
  on('layouts:render', renderLayouts);

  // Save on Enter key in the name input
  if (presetNameInput) {
    presetNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const name = presetNameInput.value.trim();
        if (name) saveLayout(name);
      }
    });
  }

  // Save button click
  if (presetSaveBtn) {
    presetSaveBtn.addEventListener('click', () => {
      const nameInput = $('preset-name-input');
      const name = nameInput ? nameInput.value.trim() : '';
      if (name) saveLayout(name);
    });
  }
}

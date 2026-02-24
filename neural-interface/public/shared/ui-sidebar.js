// ═══════════════════════════════════════════
// SynaBun Neural Interface — Category Sidebar
// ═══════════════════════════════════════════
//
// Complete category sidebar: build/rebuild, CRUD modals,
// color picker, drag-reorder, category logos, visibility toggle.
//
// Events emitted:
//   categories:changed   — after any category metadata mutation (create/edit/delete/reorder)
//   graph:refresh         — request variant to re-apply graph data
//   sidebar:rebuilt       — after the sidebar DOM has been rebuilt
//   graph:nodeThreeObject — request variant to refresh node visuals (3D only)
//   trash:refresh         — request trash badge update after category delete
//
// Events listened:
//   sidebar:rebuild       — trigger a full sidebar rebuild

import { state, emit, on } from './state.js';
import { KEYS, COLOR_PALETTE } from './constants.js';
import { storage } from './storage.js';
import { normalizeNodes } from './utils.js';
import { catColor, upgradeSelect } from './colors.js';
import {
  fetchCategories,
  createCategory   as apiCreateCategory,
  updateCategory   as apiUpdateCategory,
  patchCategory    as apiPatchCategory,
  deleteCategory   as apiDeleteCategory,
  exportCategory   as apiExportCategory,
  uploadCategoryLogo as apiUploadCategoryLogo,
  deleteCategoryLogo as apiDeleteCategoryLogo,
  fetchMemories,
  updateMemory,
} from './api.js';

const $ = (id) => document.getElementById(id);

// ─── Category logos — preloaded map for parent anchor nodes ──────
const _categoryLogos = new Map();

function preloadCategoryLogos(categories) {
  const names = new Set(categories.map(c => c.name));
  for (const [k] of _categoryLogos) { if (!names.has(k)) _categoryLogos.delete(k); }
  for (const cat of categories) {
    if (!cat.logo) continue;
    const existing = _categoryLogos.get(cat.name);
    if (existing && existing.src === cat.logo) continue;
    const img = new Image();
    const entry = { img, ready: false, src: cat.logo };
    img.onload = () => { entry.ready = true; };
    img.onerror = () => { _categoryLogos.delete(cat.name); };
    img.src = cat.logo;
    _categoryLogos.set(cat.name, entry);
  }
}

/** Expose the logo map so the 3D variant can read it for anchor textures. */
export { _categoryLogos as categoryLogos };

/**
 * Fetch categories from the API and populate state.
 * This mirrors what the legacy monolithic fetchCategories() did —
 * the api.js version is a dumb data fetcher, so we need this wrapper
 * to fill state.allCategoryNames, state.categoryDescriptions, and
 * state.categoryMetadata with parent/color/is_parent/logo data.
 */
export async function loadCategories() {
  try {
    const data = await fetchCategories();
    state.allCategoryNames = data.categories.map(c => c.name);
    state.categoryDescriptions = {};
    state.categoryMetadata = {};
    data.categories.forEach(c => {
      state.categoryDescriptions[c.name] = c.description;
      state.categoryMetadata[c.name] = {
        parent: c.parent,
        color: c.color,
        is_parent: c.is_parent,
        logo: c.logo,
      };
    });
    preloadCategoryLogos(data.categories);
  } catch (e) {
    console.error('loadCategories error:', e);
  }
}

// ─── Graph removal scheduling ────────────────────────────────────
// When a category is toggled off we schedule a delayed removal so the
// fade-out animation plays before nodes are actually removed from the graph.
let graphRemovalTimer = null;

function scheduleGraphRemoval(delay = 600) {
  emit('links:dirty');               // immediately hide links for hidden categories
  if (graphRemovalTimer) clearTimeout(graphRemovalTimer);
  graphRemovalTimer = setTimeout(() => {
    graphRemovalTimer = null;
    emit('graph:refresh');
  }, delay);
}

function cancelScheduledRemoval() {
  if (graphRemovalTimer) {
    clearTimeout(graphRemovalTimer);
    graphRemovalTimer = null;
  }
}

// ─── Saved category order ────────────────────────────────────────

function getCategoryOrder() {
  try { return JSON.parse(storage.getItem(KEYS.CATEGORY_ORDER) || '[]'); }
  catch { return []; }
}

function saveCategoryOrder(order) {
  storage.setItem(KEYS.CATEGORY_ORDER, JSON.stringify(order));
}

// ─── Color picker ────────────────────────────────────────────────

function closeColorPicker() {
  const existing = document.querySelector('.color-edit-picker');
  if (existing) existing.remove();
}

function openColorPicker(cat, chipEl) {
  closeColorPicker();

  const picker = document.createElement('div');
  picker.className = 'color-edit-picker';

  const row = document.createElement('div');
  row.className = 'color-swatch-row';

  const currentColor = catColor(cat);

  COLOR_PALETTE.forEach(color => {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch' + (color === currentColor ? ' selected' : '');
    swatch.style.background = color;
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      applyCategoryColor(cat, color);
      closeColorPicker();
    });
    row.appendChild(swatch);
  });

  picker.appendChild(row);

  // Reset to default button
  const overrides = JSON.parse(storage.getItem(KEYS.CATEGORY_COLORS) || '{}');
  if (overrides[cat]) {
    const resetBtn = document.createElement('button');
    resetBtn.className = 'color-edit-reset';
    resetBtn.textContent = 'Reset to default';
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyCategoryColor(cat, null);
      closeColorPicker();
    });
    picker.appendChild(resetBtn);
  }

  chipEl.after(picker);

  // Close on outside click (deferred so current click doesn't trigger it)
  setTimeout(() => {
    function onOutsideClick(e) {
      if (!picker.contains(e.target)) {
        closeColorPicker();
        document.removeEventListener('click', onOutsideClick);
      }
    }
    document.addEventListener('click', onOutsideClick);
  }, 0);
}

function applyCategoryColor(cat, color) {
  const overrides = JSON.parse(storage.getItem(KEYS.CATEGORY_COLORS) || '{}');
  if (color === null) {
    delete overrides[cat];
  } else {
    overrides[cat] = color;
  }
  storage.setItem(KEYS.CATEGORY_COLORS, JSON.stringify(overrides));

  // Rebuild sidebar to reflect new color on the dot
  const presentCats = new Set(state.allNodes.map(n => n.payload.category));
  buildCategorySidebar(presentCats);

  // Force graph to recreate node objects with new colors
  emit('graph:nodeThreeObject');
}

// ─── Description editor (inline below chip) ─────────────────────

function closeDescEditor() {
  const existing = document.querySelector('.category-desc-editor');
  if (existing) existing.remove();
}

function openDescEditor(cat, chipEl) {
  closeDescEditor();
  closeColorPicker();

  const editor = document.createElement('div');
  editor.className = 'category-desc-editor';
  const currentDesc = state.categoryDescriptions[cat] || '';
  editor.innerHTML = `
    <label>Description for "${cat}"</label>
    <textarea class="desc-textarea">${currentDesc}</textarea>
    <div class="category-desc-actions">
      <button class="action-btn action-btn--ghost desc-cancel-btn">Cancel</button>
      <button class="action-btn action-btn--primary desc-save-btn">Save</button>
    </div>
  `;

  const textarea = editor.querySelector('.desc-textarea');
  const saveBtn = editor.querySelector('.desc-save-btn');
  const cancelBtn = editor.querySelector('.desc-cancel-btn');

  cancelBtn.addEventListener('click', () => closeDescEditor());
  saveBtn.addEventListener('click', () => saveDescription(cat, textarea.value.trim()));

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveDescription(cat, textarea.value.trim());
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDescEditor();
    }
    e.stopPropagation();
  });
  textarea.addEventListener('keyup', (e) => e.stopPropagation());

  chipEl.after(editor);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function saveDescription(cat, description) {
  if (!description) return;
  const saveBtn = document.querySelector('.category-desc-editor .desc-save-btn');
  if (saveBtn) { saveBtn.textContent = 'Saving...'; saveBtn.disabled = true; }

  try {
    const data = await apiPatchCategory(cat, { description });
    state.allCategoryNames = data.categories.map(c => c.name);
    state.categoryDescriptions = {};
    data.categories.forEach(c => state.categoryDescriptions[c.name] = c.description);
    closeDescEditor();
  } catch (e) {
    console.error('saveDescription error:', e);
    if (saveBtn) { saveBtn.textContent = 'Error'; saveBtn.disabled = false; }
  }
}

// ─── Category change modal (move memory to different category) ───

export function openCategoryChangeModal(node) {
  const current = node.payload.category;

  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';

  let listHtml = '';
  state.allCategoryNames.forEach(cat => {
    const desc = state.categoryDescriptions[cat] || '';
    const isActive = cat === current;
    listHtml += `
      <div class="cat-modal-option${isActive ? ' active' : ''}" data-cat="${cat}">
        <div class="cat-opt-dot" style="color:${catColor(cat)}; background:${catColor(cat)}"></div>
        <span class="cat-opt-name">${cat}</span>
        ${desc ? `<span class="cat-opt-desc">${desc}</span>` : ''}
      </div>`;
  });

  overlay.innerHTML = `
    <div class="tag-delete-modal cat-change-modal">
      <div class="cat-change-modal-title">Move to category</div>
      <div class="cat-change-modal-current">
        <div class="cat-dot" style="color:${catColor(current)}; background:${catColor(current)}"></div>
        ${current}
      </div>
      <div class="cat-change-modal-list">${listHtml}</div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelectorAll('.cat-modal-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const cat = opt.dataset.cat;
      overlay.remove();
      if (cat !== current) {
        changeMemoryCategory(node, cat);
      }
    });
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

async function changeMemoryCategory(node, newCategory) {
  const oldCategory = node.payload.category;

  // Optimistic update
  node.payload.category = newCategory;

  // Update detail panel label + color
  const color = catColor(newCategory);
  const headerDot = $('detail-header-dot');
  if (headerDot) { headerDot.style.color = color; headerDot.style.background = color; }
  const label = $('detail-category-label');
  if (label) {
    label.textContent = newCategory + (node.payload.subcategory ? ' / ' + node.payload.subcategory : '');
    label.style.color = color;
  }

  // Rebuild sidebar + graph
  const presentCats = new Set(state.allNodes.map(n => n.payload.category));
  buildCategorySidebar(presentCats);
  emit('graph:nodeThreeObject');

  // Persist to server
  try {
    await updateMemory(node.id, { category: newCategory });
  } catch (e) {
    console.error('changeMemoryCategory error:', e);
    // Rollback
    node.payload.category = oldCategory;
    const rColor = catColor(oldCategory);
    if (headerDot) { headerDot.style.color = rColor; headerDot.style.background = rColor; }
    if (label) {
      label.textContent = oldCategory + (node.payload.subcategory ? ' / ' + node.payload.subcategory : '');
      label.style.color = rColor;
    }
    const rCats = new Set(state.allNodes.map(n => n.payload.category));
    buildCategorySidebar(rCats);
    emit('graph:nodeThreeObject');
  }
}

// ─── Helper: apply API response to local state ──────────────────

function applyApiResponse(data) {
  state.allCategoryNames = data.categories.map(c => c.name);
  state.categoryDescriptions = {};
  state.categoryMetadata = {};
  data.categories.forEach(c => {
    state.categoryDescriptions[c.name] = c.description;
    state.categoryMetadata[c.name] = {
      parent: c.parent,
      color: c.color,
      is_parent: c.is_parent,
      logo: c.logo,
    };
  });
  preloadCategoryLogos(data.categories);
  const presentCats = new Set(state.allNodes.map(n => n.payload.category));
  buildCategorySidebar(presentCats);
  emit('graph:refresh');
}

// ─── Create category ────────────────────────────────────────────

async function createCategoryAction(name, description, color, parent, isParent) {
  const payload = { name, description };
  if (parent) payload.parent = parent;
  if (color) payload.color = color;
  if (isParent) payload.is_parent = true;

  const data = await apiCreateCategory(payload);

  state.allCategoryNames = data.categories.map(c => c.name);
  state.categoryDescriptions = {};
  state.categoryMetadata = {};
  data.categories.forEach(c => {
    state.categoryDescriptions[c.name] = c.description;
    state.categoryMetadata[c.name] = {
      parent: c.parent,
      color: c.color,
      description: c.description,
      is_parent: c.is_parent,
      logo: c.logo,
    };
  });
  preloadCategoryLogos(data.categories);

  // Save chosen color
  if (color) {
    const overrides = JSON.parse(storage.getItem(KEYS.CATEGORY_COLORS) || '{}');
    overrides[name] = color;
    storage.setItem(KEYS.CATEGORY_COLORS, JSON.stringify(overrides));
  }

  // Add to active set & rebuild
  state.activeCategories.add(name);
  const presentCats = new Set(state.allNodes.map(n => n.payload.category));
  buildCategorySidebar(presentCats);
  emit('categories:changed');
}

// ─── Edit category UI (modal) ────────────────────────────────────

async function editCategoryUI(name) {
  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';

  const meta = state.categoryMetadata[name] || {};
  const currentDesc = state.categoryDescriptions[name] || '';
  const currentParent = meta.parent || '';
  const currentColor = meta.color || catColor(name);

  // Get available parent categories (excluding this one and its descendants)
  const getDescendants = (catName) => {
    const directChildren = state.allCategoryNames.filter(c => {
      const m = state.categoryMetadata[c] || {};
      return m.parent === catName;
    });
    const allDescendants = [...directChildren];
    directChildren.forEach(child => {
      allDescendants.push(...getDescendants(child));
    });
    return allDescendants;
  };

  const descendants = getDescendants(name);
  const descendantSet = new Set(descendants);
  const availableParents = state.allCategoryNames.filter(c => c !== name && !descendantSet.has(c));

  overlay.innerHTML = `
    <div class="ecm">
      <div class="ecm-header">
        <span class="ecm-dot" style="background:${currentColor}"></span>
        <span class="ecm-title">${name}</span>
        <button class="ecm-close cat-modal-cancel">&times;</button>
      </div>

      <div class="ecm-body">
        <div class="ecm-name-row">
          <div class="ecm-field ecm-field--name">
            <input type="text" class="edit-cat-name ecm-input" value="${name}" placeholder="Category name">
          </div>
          <button class="ecm-color-btn edit-cat-color-trigger">
            <span class="ecm-color-swatch" style="background:${currentColor}"></span>
          </button>
          <input type="color" class="edit-cat-color ecm-color-hidden" value="${currentColor}">
        </div>

        <div class="ecm-field">
          <label>Description</label>
          <textarea class="edit-cat-desc ecm-input ecm-textarea" rows="2" placeholder="What this category is for...">${currentDesc}</textarea>
        </div>

        <div class="ecm-divider"></div>

        <div class="ecm-grid">
          <div class="ecm-field">
            <label>Parent</label>
            <select class="edit-cat-parent ecm-input ecm-select">
              <option value="">None (top-level)</option>
              ${availableParents.map(c => `<option value="${c}" ${c === currentParent ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="ecm-field ecm-field--toggle edit-cat-isparent-row" ${currentParent ? 'hidden' : ''}>
            <label class="ecm-toggle">
              <input type="checkbox" class="edit-cat-isparent" ${meta.is_parent ? 'checked' : ''}>
              <span class="ecm-toggle-track"><span class="ecm-toggle-thumb"></span></span>
              <span class="ecm-toggle-label">Parent cluster</span>
            </label>
          </div>
        </div>

        <div class="ecm-logo-wrap edit-cat-logo-row" ${!(meta.is_parent && !currentParent) ? 'hidden' : ''}>
          <div class="ecm-logo-left">
            ${meta.logo
              ? `<img class="edit-cat-logo-preview ecm-logo-img" src="${meta.logo}?t=${Date.now()}">`
              : `<span class="edit-cat-logo-preview ecm-logo-empty">No logo</span>`
            }
          </div>
          <div class="ecm-logo-actions">
            <label class="ecm-link-btn">
              ${meta.logo ? 'Replace' : 'Upload'}
              <input type="file" class="edit-cat-logo-file" accept="image/*" hidden>
            </label>
            ${meta.logo ? `<button class="ecm-link-btn ecm-link-btn--danger edit-cat-logo-remove">Remove</button>` : ''}
          </div>
        </div>
      </div>

      <div class="ecm-footer">
        <button class="action-btn action-btn--ghost cat-modal-cancel">Cancel</button>
        <button class="action-btn action-btn--primary cat-modal-confirm">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const $nameInput = overlay.querySelector('.edit-cat-name');
  const $descInput = overlay.querySelector('.edit-cat-desc');
  const $parentSelect = overlay.querySelector('.edit-cat-parent');
  const $colorInput = overlay.querySelector('.edit-cat-color');
  const $isParentCheck = overlay.querySelector('.edit-cat-isparent');
  const $isParentRow = overlay.querySelector('.edit-cat-isparent-row');

  upgradeSelect($parentSelect);

  // Color button opens native picker; live-update dot + swatch
  const $colorBtn = overlay.querySelector('.ecm-color-btn');
  const $colorSwatch = overlay.querySelector('.ecm-color-swatch');
  const $headerDot = overlay.querySelector('.ecm-dot');
  $colorBtn.addEventListener('click', () => $colorInput.click());
  $colorInput.addEventListener('input', () => {
    if ($headerDot) $headerDot.style.background = $colorInput.value;
    if ($colorSwatch) $colorSwatch.style.background = $colorInput.value;
  });

  const $logoRow = overlay.querySelector('.edit-cat-logo-row');
  const $logoFile = overlay.querySelector('.edit-cat-logo-file');
  const $logoRemoveBtn = overlay.querySelector('.edit-cat-logo-remove');

  // Show/hide is_parent checkbox and logo row based on parent selection
  $parentSelect.addEventListener('change', () => {
    if ($parentSelect.value) {
      $isParentRow.hidden = true;
      $isParentCheck.checked = false;
      if ($logoRow) $logoRow.hidden = true;
    } else {
      $isParentRow.hidden = false;
      if ($logoRow) $logoRow.hidden = !$isParentCheck.checked;
    }
  });

  // Show/hide logo row based on is_parent checkbox
  $isParentCheck.addEventListener('change', () => {
    if ($logoRow) $logoRow.hidden = !$isParentCheck.checked;
  });

  // Logo upload — fires immediately on file select
  if ($logoFile) {
    $logoFile.addEventListener('change', async () => {
      const file = $logoFile.files[0];
      if (!file) return;
      const uploadLabel = $logoFile.closest('label');
      const origText = uploadLabel.textContent.trim();
      uploadLabel.childNodes[0].textContent = 'Uploading\u2026 ';
      try {
        const buf = await file.arrayBuffer();
        const data = await apiUploadCategoryLogo(name, buf, file.type || 'image/png');

        // Update preview
        const preview = overlay.querySelector('.edit-cat-logo-preview');
        if (preview.tagName === 'IMG') {
          preview.src = data.logo + '?t=' + Date.now();
        } else {
          const img = document.createElement('img');
          img.className = 'edit-cat-logo-preview ecm-logo-img';
          img.src = data.logo + '?t=' + Date.now();
          preview.replaceWith(img);
        }
        // Add remove button if not present
        if (!overlay.querySelector('.edit-cat-logo-remove')) {
          const rmBtn = document.createElement('button');
          rmBtn.className = 'ecm-link-btn ecm-link-btn--danger edit-cat-logo-remove';
          rmBtn.textContent = 'Remove';
          uploadLabel.after(rmBtn);
          attachLogoRemoveHandler(rmBtn);
        }

        if (state.categoryMetadata[name]) state.categoryMetadata[name].logo = data.logo;
        preloadCategoryLogos(data.categories);
        uploadLabel.childNodes[0].textContent = 'Replace ';
        // Rebuild graph to show new logo on anchor
        emit('graph:nodeThreeObject');
        emit('graph:refresh');
      } catch (err) {
        alert('Logo upload failed: ' + err.message);
        uploadLabel.childNodes[0].textContent = origText + ' ';
      }
    });
  }

  function attachLogoRemoveHandler(btn) {
    btn.addEventListener('click', async () => {
      btn.textContent = 'Removing\u2026';
      btn.disabled = true;
      try {
        await apiDeleteCategoryLogo(name);
        const preview = overlay.querySelector('.edit-cat-logo-preview');
        const span = document.createElement('span');
        span.className = 'edit-cat-logo-preview ecm-logo-empty';
        span.textContent = 'No logo';
        preview.replaceWith(span);
        btn.remove();
        if (state.categoryMetadata[name]) delete state.categoryMetadata[name].logo;
        _categoryLogos.delete(name);
        const uploadLabel = overlay.querySelector('.edit-cat-logo-file')?.closest('label');
        if (uploadLabel) uploadLabel.childNodes[0].textContent = 'Upload ';
        emit('graph:nodeThreeObject');
        emit('graph:refresh');
      } catch (err) {
        alert('Failed to remove logo: ' + err.message);
        btn.textContent = 'Remove';
        btn.disabled = false;
      }
    });
  }

  if ($logoRemoveBtn) attachLogoRemoveHandler($logoRemoveBtn);

  overlay.querySelector('.cat-modal-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.cat-modal-confirm').addEventListener('click', async () => {
    const newName = $nameInput.value.trim();
    const newDesc = $descInput.value.trim();
    const newParent = $parentSelect.value;
    const newColor = $colorInput.value;
    const newIsParent = $isParentCheck.checked;

    if (!newName || !newDesc) {
      alert('Name and description are required');
      return;
    }

    const btn = overlay.querySelector('.cat-modal-confirm');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    const updates = {};
    if (newName !== name) updates.new_name = newName;
    if (newDesc !== currentDesc) updates.description = newDesc;
    if (newParent !== currentParent) updates.parent = newParent;
    if (newColor !== currentColor) updates.color = newColor;
    if (newIsParent !== !!meta.is_parent) updates.is_parent = newIsParent;

    try {
      const data = await apiUpdateCategory(name, updates);

      // Update local state
      state.allCategoryNames = data.categories.map(c => c.name);
      state.categoryDescriptions = {};
      state.categoryMetadata = {};
      data.categories.forEach(c => {
        state.categoryDescriptions[c.name] = c.description;
        state.categoryMetadata[c.name] = { parent: c.parent, color: c.color, is_parent: c.is_parent, logo: c.logo };
      });
      preloadCategoryLogos(data.categories);

      // Update localStorage colors
      try {
        const overrides = JSON.parse(storage.getItem(KEYS.CATEGORY_COLORS) || '{}');
        if (newColor !== currentColor) {
          overrides[newName || name] = newColor;
        }
        if (newName !== name && overrides[name]) {
          overrides[newName] = overrides[name];
          delete overrides[name];
        }
        storage.setItem(KEYS.CATEGORY_COLORS, JSON.stringify(overrides));
      } catch {}

      // If renamed, update activeCategories
      if (newName !== name) {
        if (state.activeCategories.has(name)) {
          state.activeCategories.delete(name);
          state.activeCategories.add(newName);
        }
      }

      const presentCats = new Set(state.allNodes.map(n => n.payload.category));
      buildCategorySidebar(presentCats);
      emit('graph:refresh');
      emit('categories:changed');

      overlay.remove();
    } catch (e) {
      alert('Error updating category: ' + e.message);
      btn.textContent = 'Save Changes';
      btn.disabled = false;
    }
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ─── Delete category UI (modal) ──────────────────────────────────

function deleteCategoryUI(name, count, chipEl) {
  const overlay = document.createElement('div');
  overlay.className = 'tag-delete-overlay';
  const allCats = state.allCategoryNames.filter(c => c !== name);

  // Check if this category has children
  const children = state.allCategoryNames.filter(c => {
    const meta = state.categoryMetadata[c] || {};
    return meta.parent === name;
  });

  const hasChildren = children.length > 0;
  const hasMemories = count > 0;

  // Helper: build children reassignment HTML
  const buildChildrenSelect = () => {
    if (!hasChildren) return '';
    const getDescendants = (catName) => {
      const direct = state.allCategoryNames.filter(c => (state.categoryMetadata[c] || {}).parent === catName);
      const all = [...direct];
      direct.forEach(child => all.push(...getDescendants(child)));
      return all;
    };
    const descendantSet = new Set(getDescendants(name));
    const available = state.allCategoryNames.filter(c => c !== name && !descendantSet.has(c));
    return `
      <div style="font-size:var(--fs-sm);color:var(--t-secondary);margin:12px 0 6px;text-align:left">
        ${children.length} child categor${children.length === 1 ? 'y' : 'ies'}: <strong>${children.join(', ')}</strong><br>Reassign children to:
      </div>
      <select class="cat-modal-select-children modal-select">
        <option value="">-- Make top-level --</option>
        ${available.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select>
    `;
  };

  if (!hasMemories && !hasChildren) {
    // Simple delete — no memories, no children
    overlay.innerHTML = `
      <div class="tag-delete-modal">
        <div class="tag-delete-modal-title">Delete category</div>
        <div class="tag-delete-modal-tag">${name}</div>
        <div class="tag-delete-modal-actions">
          <button class="action-btn action-btn--ghost cat-modal-cancel">Cancel</button>
          <button class="action-btn action-btn--danger cat-modal-confirm">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.cat-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.cat-modal-confirm').addEventListener('click', () => {
      overlay.remove();
      deleteCategoryAction(name);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  } else if (!hasMemories && hasChildren) {
    // Only children to handle, no memories
    overlay.innerHTML = `
      <div class="tag-delete-modal" style="min-width:340px">
        <div class="tag-delete-modal-title">Delete category</div>
        <div class="tag-delete-modal-tag">${name}</div>
        ${buildChildrenSelect()}
        <div class="tag-delete-modal-actions" style="margin-top:14px">
          <button class="action-btn action-btn--ghost cat-modal-cancel">Cancel</button>
          <button class="action-btn action-btn--danger cat-modal-confirm">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const childSel = overlay.querySelector('.cat-modal-select-children');
    if (childSel) upgradeSelect(childSel);
    overlay.querySelector('.cat-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.cat-modal-confirm').addEventListener('click', async () => {
      const targetChildren = overlay.querySelector('.cat-modal-select-children')?.value;
      const btn = overlay.querySelector('.cat-modal-confirm');
      btn.textContent = 'Deleting...';
      btn.disabled = true;
      await deleteCategoryAction(name, null, targetChildren);
      overlay.remove();
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  } else {
    // Has memories — show 3-option flow
    const svgTrash = `<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-.7 12.1a2 2 0 0 1-2 1.9H7.7a2 2 0 0 1-2-1.9L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>`;
    const svgExport = `<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    const svgMigrate = `<svg viewBox="0 0 24 24"><path d="M5 9l4-4 4 4"/><path d="M9 5v10a4 4 0 0 0 4 4h6"/><polyline points="15 15 19 19 15 23"/></svg>`;

    overlay.innerHTML = `
      <div class="tag-delete-modal" style="min-width:380px">
        <div class="tag-delete-modal-title">Delete category</div>
        <div class="tag-delete-modal-tag">${name}</div>
        <div style="font-size:var(--fs-sm);color:var(--t-secondary);margin-bottom:4px">
          ${count} memor${count === 1 ? 'y' : 'ies'} in this category. What would you like to do?
        </div>
        <div class="cat-delete-options">
          <div class="cat-delete-option cat-delete-option--delete" data-action="delete">
            <div class="cat-delete-option-icon">${svgTrash}</div>
            <div class="cat-delete-option-text">
              <div class="cat-delete-option-label">Trash all memories</div>
              <div class="cat-delete-option-desc">Move all ${count} memor${count === 1 ? 'y' : 'ies'} to trash</div>
            </div>
          </div>
          <div class="cat-delete-option cat-delete-option--export" data-action="export">
            <div class="cat-delete-option-icon">${svgExport}</div>
            <div class="cat-delete-option-text">
              <div class="cat-delete-option-label">Export as Markdown</div>
              <div class="cat-delete-option-desc">Download all memories as .md then trash</div>
            </div>
          </div>
          <div class="cat-delete-option cat-delete-option--migrate" data-action="migrate">
            <div class="cat-delete-option-icon">${svgMigrate}</div>
            <div class="cat-delete-option-text">
              <div class="cat-delete-option-label">Migrate to another category</div>
              <div class="cat-delete-option-desc">Move memories before deleting this category</div>
            </div>
          </div>
        </div>
        ${buildChildrenSelect()}
        <div class="cat-delete-step" id="cat-delete-step-area"></div>
        <div class="tag-delete-modal-actions">
          <button class="action-btn action-btn--ghost cat-modal-cancel">Cancel</button>
          <button class="action-btn action-btn--danger cat-modal-confirm" disabled style="opacity:0.4">Continue</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const modal = overlay.querySelector('.tag-delete-modal');
    const stepArea = modal.querySelector('#cat-delete-step-area');
    const confirmBtn = modal.querySelector('.cat-modal-confirm');
    let selectedAction = null;

    // Upgrade children select if present
    const childSel3 = modal.querySelector('.cat-modal-select-children');
    if (childSel3) upgradeSelect(childSel3);

    // Option selection
    modal.querySelectorAll('.cat-delete-option').forEach(opt => {
      opt.addEventListener('click', () => {
        modal.querySelectorAll('.cat-delete-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        selectedAction = opt.dataset.action;
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '1';
        stepArea.innerHTML = '';

        if (selectedAction === 'delete') {
          confirmBtn.textContent = 'Trash all';
          confirmBtn.className = 'action-btn action-btn--danger cat-modal-confirm';
        } else if (selectedAction === 'export') {
          confirmBtn.textContent = 'Export & Trash';
          confirmBtn.className = 'action-btn action-btn--danger cat-modal-confirm';
        } else if (selectedAction === 'migrate') {
          confirmBtn.textContent = 'Migrate & Delete';
          confirmBtn.className = 'action-btn action-btn--danger cat-modal-confirm';
          stepArea.innerHTML = `
            <div style="font-size:var(--fs-sm);color:var(--t-secondary);margin:4px 0 4px;text-align:left">Move memories to:</div>
            <select class="cat-modal-select-memories modal-select">
              ${allCats.map(c => `<option value="${c}">${c}</option>`).join('')}
            </select>
          `;
          const memSel = stepArea.querySelector('.cat-modal-select-memories');
          if (memSel) upgradeSelect(memSel);
        }
      });
    });

    // Cancel
    overlay.querySelector('.cat-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // Confirm
    confirmBtn.addEventListener('click', async () => {
      if (!selectedAction) return;
      const targetChildren = hasChildren ? modal.querySelector('.cat-modal-select-children')?.value : undefined;

      if (selectedAction === 'delete') {
        confirmBtn.textContent = 'Trashing...';
        confirmBtn.disabled = true;
        await deleteCategoryAction(name, null, targetChildren, { deleteMemories: true });
        overlay.remove();

      } else if (selectedAction === 'export') {
        confirmBtn.textContent = 'Exporting...';
        confirmBtn.disabled = true;
        try {
          const blob = await apiExportCategory(name);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${name}-memories.md`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          // Now trash
          confirmBtn.textContent = 'Trashing...';
          await deleteCategoryAction(name, null, targetChildren, { deleteMemories: true });
          overlay.remove();
        } catch (err) {
          console.error('Export failed:', err);
          alert('Export failed: ' + err.message);
          confirmBtn.textContent = 'Export & Trash';
          confirmBtn.disabled = false;
        }

      } else if (selectedAction === 'migrate') {
        const targetMemories = modal.querySelector('.cat-modal-select-memories')?.value;
        if (!targetMemories) return;
        confirmBtn.textContent = 'Migrating...';
        confirmBtn.disabled = true;
        await deleteCategoryAction(name, targetMemories, targetChildren);
        overlay.remove();
      }
    });
  }
}

// ─── Delete category (server call + state update) ────────────────

async function deleteCategoryAction(name, reassignTo, reassignChildrenTo, options = {}) {
  const body = {};
  if (reassignTo) body.reassign_to = reassignTo;
  if (reassignChildrenTo !== undefined) body.reassign_children_to = reassignChildrenTo;
  if (options.deleteMemories) body.delete_memories = true;

  try {
    const data = await apiDeleteCategory(name, body);

    state.allCategoryNames = data.categories.map(c => c.name);
    state.categoryDescriptions = {};
    data.categories.forEach(c => state.categoryDescriptions[c.name] = c.description);
    // Update categoryMetadata
    state.categoryMetadata = {};
    data.categories.forEach(c => {
      state.categoryMetadata[c.name] = { parent: c.parent, color: c.color, is_parent: c.is_parent, logo: c.logo };
    });
    preloadCategoryLogos(data.categories);

    // Remove color override
    try {
      const overrides = JSON.parse(storage.getItem(KEYS.CATEGORY_COLORS) || '{}');
      delete overrides[name];
      storage.setItem(KEYS.CATEGORY_COLORS, JSON.stringify(overrides));
    } catch {}
    state.activeCategories.delete(name);

    // Re-fetch memories if anything changed (reassigned or deleted)
    if (reassignTo || options.deleteMemories || (data.reassigned && data.reassigned > 0) || (data.deleted && data.deleted > 0)) {
      try {
        const memData = await fetchMemories();
        state.allNodes = normalizeNodes(memData.nodes);
        state.allLinks = memData.links;
      } catch {}
    }

    const presentCats = new Set(state.allNodes.map(n => n.payload.category));
    buildCategorySidebar(presentCats);
    emit('graph:refresh');
    emit('categories:changed');

    // Update trash badge if memories were trashed
    if (options.deleteMemories) {
      emit('trash:refresh');
    }
  } catch (e) {
    console.error('deleteCategory error:', e);
    alert('Error deleting category: ' + e.message);
  }
}

// ═══════════════════════════════════════════
// MAIN: buildCategorySidebar
// ═══════════════════════════════════════════

let categoryDragDidMove = false;

/**
 * Rebuild the category sidebar DOM from current state.
 * @param {Set<string>} [presentCats] — categories that have at least one memory node.
 *   If omitted, derived from state.allNodes.
 */
export function buildCategorySidebar(presentCats) {
  const $categoryList = $('category-list');
  if (!$categoryList) return;
  $categoryList.innerHTML = '';

  if (!presentCats) {
    presentCats = new Set(state.allNodes.map(n => n.payload.category));
  }

  // Count per category
  const counts = {};
  state.allNodes.forEach(n => {
    const cat = n.payload.category;
    counts[cat] = (counts[cat] || 0) + 1;
  });

  // Merge present categories with all known categories (including 0-count ones)
  const allCats = new Set(presentCats);
  state.allCategoryNames.forEach(c => allCats.add(c));

  // Group categories by parent
  const categoryGroups = {};
  const orphans = [];

  [...allCats].forEach(cat => {
    const meta = state.categoryMetadata[cat] || {};
    if (meta.parent) {
      if (!categoryGroups[meta.parent]) categoryGroups[meta.parent] = [];
      categoryGroups[meta.parent].push(cat);
    } else {
      orphans.push(cat);
    }
    // Ensure is_parent categories always have an entry in categoryGroups (even if empty)
    if (meta.is_parent && !categoryGroups[cat]) {
      categoryGroups[cat] = [];
    }
  });

  // Apply saved order, then append any new categories at the end sorted by count
  const savedOrder = getCategoryOrder();
  const ordered = savedOrder.filter(c => allCats.has(c));
  const remaining = [...allCats].filter(c => !savedOrder.includes(c))
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  const sorted = [...ordered, ...remaining];

  // Regroup sorted: parent clusters contiguous (header + all children), orphans at end.
  // Prevents orphan categories from interleaving with cluster children (false 3rd nesting level).
  const regrouped = [];
  const _grouped = new Set();
  const _pNames = new Set();
  sorted.forEach(c => {
    const m = state.categoryMetadata[c] || {};
    if (m.is_parent || categoryGroups[c]) _pNames.add(c);
    if (m.parent) _pNames.add(m.parent);
  });
  const _pOrd = [], _pSeen = new Set();
  sorted.forEach(c => {
    const m = state.categoryMetadata[c] || {};
    const p = m.parent || (_pNames.has(c) ? c : null);
    if (p && !_pSeen.has(p)) { _pSeen.add(p); _pOrd.push(p); }
  });
  _pOrd.forEach(p => {
    regrouped.push(p); _grouped.add(p);
    sorted.forEach(c => { if ((state.categoryMetadata[c] || {}).parent === p) { regrouped.push(c); _grouped.add(c); } });
  });
  sorted.forEach(c => { if (!_grouped.has(c)) regrouped.push(c); });

  // Track which parent clusters we've rendered
  const renderedClusters = new Set();

  regrouped.forEach(cat => {
    const meta = state.categoryMetadata[cat] || {};

    // If this category has a parent and we haven't rendered that cluster header yet
    if (meta.parent && !renderedClusters.has(meta.parent)) {
      const clusterHeader = document.createElement('div');
      clusterHeader.className = 'category-cluster-header';
      clusterHeader.style.borderLeft = `3px solid ${catColor(meta.parent)}`;
      clusterHeader.dataset.parent = meta.parent;

      if (!state.activeCategories.has(meta.parent)) {
        clusterHeader.classList.add('inactive');
      }

      const parentMeta = state.categoryMetadata[meta.parent] || {};
      const isEphemeral = !!parentMeta._ephemeral;
      clusterHeader.innerHTML = `
        <span class="cluster-dot" style="background:${catColor(meta.parent)}" data-tooltip="Color"></span>
        <span class="cluster-name">${meta.parent}</span>
        ${isEphemeral
          ? '<span style="margin-left:auto;font-size:10px;opacity:0.5;color:var(--t-muted)">bridge</span>'
          : `<span class="cluster-actions">
              <button class="cluster-edit-btn" data-tooltip="Edit">&#9998;</button>
              <button class="cluster-delete-btn" data-tooltip="Delete">&times;</button>
            </span>`}
      `;

      // Click on cluster header to toggle parent and all children
      clusterHeader.addEventListener('click', (e) => {
        if (categoryDragDidMove) { categoryDragDidMove = false; return; }
        if (e.target.closest('.cluster-actions') || e.target.closest('.cluster-dot')) return;

        const parentCat = meta.parent;
        const childCategories = categoryGroups[parentCat] || [];

        if (state.activeCategories.has(parentCat)) {
          state.activeCategories.delete(parentCat);
          childCategories.forEach(child => state.activeCategories.delete(child));
          clusterHeader.classList.add('inactive');
          childCategories.forEach(child => {
            const childChip = $categoryList.querySelector(`.category-chip[data-cat="${child}"]`);
            if (childChip) childChip.classList.add('inactive');
          });
          scheduleGraphRemoval();
        } else {
          state.activeCategories.add(parentCat);
          childCategories.forEach(child => state.activeCategories.add(child));
          clusterHeader.classList.remove('inactive');
          childCategories.forEach(child => {
            const childChip = $categoryList.querySelector(`.category-chip[data-cat="${child}"]`);
            if (childChip) childChip.classList.remove('inactive');
          });
          cancelScheduledRemoval();
          emit('graph:refresh');
        }
      });

      // Color dot click
      clusterHeader.querySelector('.cluster-dot').addEventListener('click', (e) => {
        e.stopPropagation();
        openColorPicker(meta.parent, clusterHeader);
      });

      // Edit/Delete buttons (not present for ephemeral/bridge categories)
      const clusterEditBtn = clusterHeader.querySelector('.cluster-edit-btn');
      if (clusterEditBtn) {
        clusterEditBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          editCategoryUI(meta.parent);
        });
      }
      const clusterDeleteBtn = clusterHeader.querySelector('.cluster-delete-btn');
      if (clusterDeleteBtn) {
        clusterDeleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const parentCount = counts[meta.parent] || 0;
          deleteCategoryUI(meta.parent, parentCount, clusterHeader);
        });
      }

      $categoryList.appendChild(clusterHeader);
      renderedClusters.add(meta.parent);
    }

    // If this category is a parent (is_parent flag or has children), render its own cluster header
    if ((meta.is_parent || (categoryGroups[cat] && categoryGroups[cat].length > 0)) && !renderedClusters.has(cat)) {
      const clusterHeader = document.createElement('div');
      clusterHeader.className = 'category-cluster-header';
      clusterHeader.style.borderLeft = `3px solid ${catColor(cat)}`;
      clusterHeader.dataset.parent = cat;

      if (!state.activeCategories.has(cat)) {
        clusterHeader.classList.add('inactive');
      }

      const childCount = (categoryGroups[cat] || []).length;
      const isEphemeralCat = !!(state.categoryMetadata[cat] || {})._ephemeral;
      clusterHeader.innerHTML = `
        <span class="cluster-dot" style="background:${catColor(cat)}" data-tooltip="Color"></span>
        <span class="cluster-name">${cat}</span>
        ${isEphemeralCat
          ? '<span style="margin-left:auto;font-size:10px;opacity:0.5;color:var(--t-muted)">bridge</span>'
          : `<span class="cluster-actions">
              <button class="cluster-edit-btn" data-tooltip="Edit">&#9998;</button>
              <button class="cluster-delete-btn" data-tooltip="Delete">&times;</button>
            </span>`}
      `;

      clusterHeader.addEventListener('click', (e) => {
        if (categoryDragDidMove) { categoryDragDidMove = false; return; }
        if (e.target.closest('.cluster-actions') || e.target.closest('.cluster-dot')) return;
        const childCategories = categoryGroups[cat] || [];
        if (state.activeCategories.has(cat)) {
          state.activeCategories.delete(cat);
          childCategories.forEach(child => state.activeCategories.delete(child));
          clusterHeader.classList.add('inactive');
          childCategories.forEach(child => {
            const childChip = $categoryList.querySelector(`.category-chip[data-cat="${child}"]`);
            if (childChip) childChip.classList.add('inactive');
          });
          scheduleGraphRemoval();
        } else {
          state.activeCategories.add(cat);
          childCategories.forEach(child => state.activeCategories.add(child));
          clusterHeader.classList.remove('inactive');
          childCategories.forEach(child => {
            const childChip = $categoryList.querySelector(`.category-chip[data-cat="${child}"]`);
            if (childChip) childChip.classList.remove('inactive');
          });
          cancelScheduledRemoval();
          emit('graph:refresh');
        }
      });

      clusterHeader.querySelector('.cluster-dot').addEventListener('click', (e) => {
        e.stopPropagation();
        openColorPicker(cat, clusterHeader);
      });
      const editBtnStandalone = clusterHeader.querySelector('.cluster-edit-btn');
      if (editBtnStandalone) {
        editBtnStandalone.addEventListener('click', (e) => {
          e.stopPropagation();
          editCategoryUI(cat);
        });
      }
      const deleteBtnStandalone = clusterHeader.querySelector('.cluster-delete-btn');
      if (deleteBtnStandalone) {
        deleteBtnStandalone.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteCategoryUI(cat, counts[cat] || 0, clusterHeader);
        });
      }

      $categoryList.appendChild(clusterHeader);
      renderedClusters.add(cat);

      // Show empty state hint if parent has no children yet
      if (childCount === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'cluster-empty-hint';
        emptyHint.textContent = 'Drag categories here';
        $categoryList.appendChild(emptyHint);
      }
    }

    // Skip rendering chips for parent categories (they only appear as cluster headers)
    if (categoryGroups[cat] !== undefined) {
      return;
    }

    const chip = document.createElement('div');
    chip.className = 'category-chip' + (meta.parent ? ' category-chip-child' : '');
    chip.dataset.cat = cat;

    if (!state.activeCategories.has(cat)) {
      chip.classList.add('inactive');
    }

    const isEphemeralChip = !!(meta._ephemeral || (meta.parent && (state.categoryMetadata[meta.parent] || {})._ephemeral));
    chip.innerHTML = `
      <div class="category-dot" style="color:${catColor(cat)}; background:${catColor(cat)}" data-tooltip="Color"></div>
      <span class="category-label">${cat}${isEphemeralChip ? '' : '<span class="cat-edit-icon" data-tooltip="Edit">&#9998;</span>'}</span>
      <span class="category-count">${counts[cat] || 0}</span>
      ${isEphemeralChip ? '' : '<button class="category-delete" data-tooltip="Delete">&times;</button>'}
    `;

    // Color dot click -> open color picker
    chip.querySelector('.category-dot').addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPicker(cat, chip);
    });

    // Edit icon click -> open full category editor (not for ephemeral)
    const catEditIcon = chip.querySelector('.cat-edit-icon');
    if (catEditIcon) {
      catEditIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        editCategoryUI(cat);
      });
    }

    chip.addEventListener('click', (e) => {
      if (categoryDragDidMove) { categoryDragDidMove = false; return; }
      if (e.target.closest('.category-delete')) return;
      if (e.target.closest('.category-dot')) return;
      if (e.target.closest('.cat-edit-icon')) return;
      if (state.activeCategories.has(cat)) {
        state.activeCategories.delete(cat);
        chip.classList.add('inactive');
        scheduleGraphRemoval();
      } else {
        state.activeCategories.add(cat);
        chip.classList.remove('inactive');
        cancelScheduledRemoval();
        emit('graph:refresh');
      }
    });

    const catDeleteBtn = chip.querySelector('.category-delete');
    if (catDeleteBtn) {
      catDeleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteCategoryUI(cat, counts[cat] || 0, chip);
      });
    }

    $categoryList.appendChild(chip);
  });

  // Wire up drag-to-reorder
  initCategoryDrag();

  emit('sidebar:rebuilt');
}

// ═══════════════════════════════════════════
// DRAG-TO-REORDER
// ═══════════════════════════════════════════

function initCategoryDrag() {
  const $categoryList = $('category-list');
  if (!$categoryList) return;

  let dragEl = null;        // The element being dragged (chip or cluster header)
  let dragType = null;      // 'chip' or 'cluster'
  let startY = 0;
  let startX = 0;
  let cloneEl = null;       // Floating clone that follows cursor
  let initialRect = null;   // Bounding rect captured before drag starts
  let dragElHeight = 0;     // Height of dragged element for gap sizing
  categoryDragDidMove = false;

  const chips = () => [...$categoryList.querySelectorAll('.category-chip')];
  const clusterHeaders = () => [...$categoryList.querySelectorAll('.category-cluster-header')];

  function clearIndicators() {
    chips().forEach(c => c.classList.remove('drag-gap-before', 'drag-gap-after'));
    clusterHeaders().forEach(h => h.classList.remove('drag-over-cluster', 'drag-gap-before', 'drag-gap-after'));
  }

  // Get all DOM elements belonging to a cluster (header + its child chips + empty hints)
  function getClusterElements(headerEl) {
    const els = [headerEl];
    let next = headerEl.nextElementSibling;
    while (next) {
      if (next.classList.contains('category-cluster-header')) break;
      if (next.classList.contains('category-chip') && !next.classList.contains('category-chip-child')) break;
      els.push(next);
      next = next.nextElementSibling;
    }
    return els;
  }

  function getDropTarget(y) {
    const headers = clusterHeaders();

    if (dragType === 'cluster') {
      const dragClusterEls = new Set(getClusterElements(dragEl));

      for (const header of headers) {
        if (dragClusterEls.has(header)) continue;
        const rect = header.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (y >= rect.top - 8 && y <= rect.bottom + 8) {
          return { type: 'reorder-cluster', header, position: y < mid ? 'before' : 'after' };
        }
      }

      for (const chip of chips()) {
        if (chip.classList.contains('category-chip-child')) continue;
        if (dragClusterEls.has(chip)) continue;
        const rect = chip.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (y >= rect.top - 4 && y <= rect.bottom + 4) {
          return { type: 'reorder-cluster', header: chip, position: y < mid ? 'before' : 'after' };
        }
      }

      return null;
    }

    // Dragging a chip: check cluster headers to reparent
    for (const header of headers) {
      const rect = header.getBoundingClientRect();
      if (y >= rect.top - 4 && y <= rect.bottom + 20) {
        const clusterName = header.querySelector('.cluster-name').textContent;
        return { type: 'cluster', header, clusterName };
      }
    }

    // Check empty cluster hints
    for (const hint of [...$categoryList.querySelectorAll('.cluster-empty-hint')]) {
      const rect = hint.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) {
        const header = hint.previousElementSibling;
        if (header && header.classList.contains('category-cluster-header')) {
          const clusterName = header.querySelector('.cluster-name').textContent;
          return { type: 'cluster', header, clusterName };
        }
      }
    }

    // Check top empty area (make top-level)
    const firstChip = chips()[0];
    const firstHeader = headers[0];
    const firstElement = firstChip || firstHeader;
    if (firstElement) {
      const firstRect = firstElement.getBoundingClientRect();
      const listRect = $categoryList.getBoundingClientRect();
      if (y < firstRect.top && y >= listRect.top) {
        return { type: 'make-toplevel' };
      }
    }

    // Reorder among sibling chips
    for (const chip of chips()) {
      if (chip === dragEl) continue;
      const rect = chip.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (y < mid) return { type: 'reorder', chip, position: 'before' };
    }
    const last = chips().filter(c => c !== dragEl).pop();
    return last ? { type: 'reorder', chip: last, position: 'after' } : null;
  }

  // Create a floating clone of the dragged element
  function createDragClone(el) {
    const rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true);
    clone.classList.remove('inactive', 'drag-source');
    clone.classList.add('cat-drag-clone');
    clone.style.width = rect.width + 'px';
    clone.style.left = rect.left + 'px';
    clone.style.top = rect.top + 'px';
    clone.style.transform = 'translate(0px, 0px) scale(1.04) rotate(0.8deg)';
    // Strip interactive elements — clone is purely visual
    clone.querySelectorAll('.category-delete, .cat-edit-icon, .cluster-actions').forEach(n => n.remove());
    document.body.appendChild(clone);
    return clone;
  }

  // Cleanup all drag artifacts
  function cleanupDrag() {
    if (dragEl) {
      dragEl.classList.remove('drag-source');
      if (dragType === 'cluster') {
        getClusterElements(dragEl).forEach(el => el.classList.remove('drag-source'));
      }
    }
    clearIndicators();
    if (cloneEl) { cloneEl.remove(); cloneEl = null; }
    $categoryList.classList.remove('cat-dragging');
    $categoryList.style.removeProperty('--drag-gap');
    dragEl = null;
    dragType = null;
    initialRect = null;
  }

  $categoryList.addEventListener('pointerdown', (e) => {
    // Skip interactive sub-elements
    if (e.target.closest('.category-delete')) return;
    if (e.target.closest('.category-dot')) return;
    if (e.target.closest('.cat-edit-icon')) return;
    if (e.target.closest('.cluster-actions')) return;
    if (e.target.closest('.cluster-dot')) return;

    const chip = e.target.closest('.category-chip');
    const header = e.target.closest('.category-cluster-header');
    const el = chip || header;
    if (!el) return;

    e.preventDefault();
    dragEl = el;
    dragType = chip ? 'chip' : 'cluster';
    startY = e.clientY;
    startX = e.clientX;
    categoryDragDidMove = false;
    el.setPointerCapture(e.pointerId);

    function onMove(ev) {
      if (!dragEl) return;
      if (!categoryDragDidMove && Math.abs(ev.clientY - startY) < 5) return;

      if (!categoryDragDidMove) {
        categoryDragDidMove = true;

        // Capture geometry before any visual changes
        initialRect = dragEl.getBoundingClientRect();
        dragElHeight = initialRect.height + 4;

        // Create floating clone
        cloneEl = createDragClone(dragEl);

        // Ghost the source element(s)
        dragEl.classList.add('drag-source');
        if (dragType === 'cluster') {
          getClusterElements(dragEl).forEach(el => el.classList.add('drag-source'));
        }

        // Enable gap transitions and set dynamic gap size
        $categoryList.classList.add('cat-dragging');
        $categoryList.style.setProperty('--drag-gap', dragElHeight + 'px');
      }

      // Move clone with cursor (GPU-accelerated transform)
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      cloneEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.04) rotate(0.8deg)`;

      // Show animated gap at drop target
      clearIndicators();
      const target = getDropTarget(ev.clientY);
      if (target) {
        if (target.type === 'cluster') {
          target.header.classList.add('drag-over-cluster');
        } else if (target.type === 'reorder' || target.type === 'reorder-cluster') {
          const targetEl = target.chip || target.header;
          targetEl.classList.add(target.position === 'before' ? 'drag-gap-before' : 'drag-gap-after');
        } else if (target.type === 'make-toplevel') {
          const first = chips()[0] || clusterHeaders()[0];
          if (first && first !== dragEl) first.classList.add('drag-gap-before');
        }
      }
    }

    async function onUp(ev) {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);

      if (!dragEl) return;

      const droppedEl = dragEl;
      const droppedType = dragType;
      const didMove = categoryDragDidMove;

      if (didMove) {
        const target = getDropTarget(ev.clientY);

        // ── Spring-snap drop animation ──
        if (cloneEl && target && initialRect) {
          let gapEl = null, gapPosition = null;
          if (target.type === 'reorder' || target.type === 'reorder-cluster') {
            gapEl = target.chip || target.header;
            gapPosition = target.position;
          } else if (target.type === 'make-toplevel') {
            gapEl = chips()[0] || clusterHeaders()[0];
            gapPosition = 'before';
          } else if (target.type === 'cluster') {
            gapEl = target.header;
            gapPosition = 'after';
          }

          if (gapEl) {
            const gapRect = gapEl.getBoundingClientRect();
            const targetTop = gapPosition === 'before'
              ? gapRect.top - dragElHeight
              : gapRect.bottom;
            const targetDy = targetTop - initialRect.top;
            const targetDx = gapRect.left - initialRect.left;

            // Animate clone to landing position with spring overshoot
            cloneEl.style.transition = 'transform 0.22s cubic-bezier(0.22, 1.15, 0.36, 1), opacity 0.14s ease 0.06s';
            cloneEl.style.transform = `translate(${targetDx}px, ${targetDy}px) scale(1) rotate(0deg)`;
            cloneEl.style.opacity = '0';
            await new Promise(r => setTimeout(r, 220));
          }
        } else if (cloneEl && initialRect) {
          // No valid target — animate clone back to origin
          cloneEl.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0, 1), opacity 0.12s ease';
          cloneEl.style.transform = 'translate(0px, 0px) scale(1) rotate(0deg)';
          cloneEl.style.opacity = '0';
          await new Promise(r => setTimeout(r, 200));
        }

        // ── Execute drop action ──
        if (target) {
          if (droppedType === 'cluster' && target.type === 'reorder-cluster') {
            const clusterEls = getClusterElements(droppedEl);
            const refEl = target.header;
            if (target.position === 'before') {
              for (const cel of clusterEls) {
                $categoryList.insertBefore(cel, refEl);
              }
            } else {
              let insertAfter = refEl;
              if (refEl.classList.contains('category-cluster-header')) {
                const targetClusterEls = getClusterElements(refEl);
                insertAfter = targetClusterEls[targetClusterEls.length - 1];
              }
              for (let i = clusterEls.length - 1; i >= 0; i--) {
                insertAfter.after(clusterEls[i]);
              }
            }
            const newOrder = chips().map(c => c.dataset.cat);
            saveCategoryOrder(newOrder);

          } else if (droppedType === 'chip' && target.type === 'cluster') {
            const draggedCat = droppedEl.dataset.cat;
            const newParent = target.clusterName;
            const currentMeta = state.categoryMetadata[draggedCat] || {};

            if (currentMeta.parent !== newParent) {
              try {
                const data = await apiUpdateCategory(draggedCat, { parent: newParent });
                applyApiResponse(data);
              } catch (err) {
                console.error('Error reparenting category:', err);
                alert('Error reparenting category: ' + err.message);
              }
            }

          } else if (droppedType === 'chip' && target.type === 'make-toplevel') {
            const draggedCat = droppedEl.dataset.cat;
            const currentMeta = state.categoryMetadata[draggedCat] || {};

            if (currentMeta.parent) {
              try {
                const data = await apiUpdateCategory(draggedCat, { parent: '' });
                applyApiResponse(data);
              } catch (err) {
                console.error('Error making category top-level:', err);
                alert('Error making category top-level: ' + err.message);
              }
            }

          } else if (droppedType === 'chip' && target.type === 'reorder' && target.chip !== droppedEl) {
            if (target.position === 'before') {
              $categoryList.insertBefore(droppedEl, target.chip);
            } else {
              target.chip.after(droppedEl);
            }
            const newOrder = chips().map(c => c.dataset.cat);
            saveCategoryOrder(newOrder);
          }
        }
      }

      // ── Cleanup ──
      cleanupDrag();

      // ── Settle animation: element pops into place ──
      if (didMove && droppedEl && droppedEl.parentNode) {
        droppedEl.classList.add('just-dropped');
        droppedEl.addEventListener('animationend', () => droppedEl.classList.remove('just-dropped'), { once: true });
      }
    }

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

// ═══════════════════════════════════════════
// CATEGORY CREATE FORM WIRING
// ═══════════════════════════════════════════

function initCreateForm() {
  const $addBtn = $('category-add-btn');
  const $addParentBtn = $('category-add-parent-btn');
  const $form = $('category-create-form');
  const $formTitle = $('cat-form-title');
  const $nameInput = $('cat-name-input');
  const $descInput = $('cat-desc-input');
  const $parentSelect = $('cat-parent-select');
  const $swatchRow = $('color-swatch-row');
  const $error = $('cat-form-error');
  const $createBtn = $('cat-form-create');
  const $cancelBtn = $('cat-form-cancel');

  if (!$addBtn || !$form) return;

  let selectedColor = COLOR_PALETTE[0];
  let formMode = 'child'; // 'child' or 'parent'

  // Build swatches
  COLOR_PALETTE.forEach((color, i) => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch' + (i === 0 ? ' selected' : '');
    btn.style.background = color;
    btn.addEventListener('click', () => {
      $swatchRow.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      btn.classList.add('selected');
      selectedColor = color;
    });
    $swatchRow.appendChild(btn);
  });

  // Populate parent dropdown
  function populateParentDropdown() {
    $parentSelect.innerHTML = '<option value="">(None - standalone category)</option>';
    state.allCategoryNames.forEach(catName => {
      const opt = document.createElement('option');
      opt.value = catName;
      opt.textContent = catName;
      $parentSelect.appendChild(opt);
    });
  }

  function openForm(mode) {
    formMode = mode;
    $form.dataset.mode = mode;
    $form.classList.add('open');

    if (mode === 'parent') {
      $formTitle.textContent = 'CREATE PARENT CATEGORY';
      $nameInput.placeholder = 'parent-category-name';
      $descInput.placeholder = 'What does this group contain?';
    } else {
      $formTitle.textContent = 'CREATE CATEGORY';
      $nameInput.placeholder = 'category-name';
      $descInput.placeholder = 'Short description...';
      populateParentDropdown();
      upgradeSelect($parentSelect);
    }

    $nameInput.focus();
  }

  function closeForm() {
    $form.classList.remove('open');
    $nameInput.value = '';
    $descInput.value = '';
    $parentSelect.value = '';
    $error.textContent = '';
    $createBtn.disabled = true;
    $nameInput.classList.remove('invalid');
  }

  function validateForm() {
    const name = $nameInput.value;
    const desc = $descInput.value.trim();
    if (!name) { $error.textContent = ''; $createBtn.disabled = true; return; }
    if (name.length < 2) { $error.textContent = 'Min 2 characters'; $createBtn.disabled = true; return; }
    if (!/^[a-z][a-z0-9-]*$/.test(name)) { $error.textContent = 'Lowercase, starts with letter, letters/digits/hyphens only'; $createBtn.disabled = true; $nameInput.classList.add('invalid'); return; }
    $nameInput.classList.remove('invalid');
    if (!desc) { $error.textContent = 'Description required'; $createBtn.disabled = true; return; }
    $error.textContent = '';
    $createBtn.disabled = false;
  }

  $nameInput.addEventListener('input', () => {
    $nameInput.value = $nameInput.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    validateForm();
  });
  $descInput.addEventListener('input', validateForm);

  $addBtn.addEventListener('click', () => {
    if ($form.classList.contains('open')) {
      closeForm();
    } else {
      openForm('child');
    }
  });

  $addParentBtn.addEventListener('click', () => {
    if ($form.classList.contains('open')) {
      closeForm();
    } else {
      openForm('parent');
    }
  });

  $cancelBtn.addEventListener('click', () => {
    closeForm();
  });

  $createBtn.addEventListener('click', async () => {
    const name = $nameInput.value;
    const desc = $descInput.value.trim();
    const parent = formMode === 'child' ? ($parentSelect.value || null) : null;
    const isParent = formMode === 'parent';
    $createBtn.disabled = true;
    $createBtn.textContent = 'Creating...';
    try {
      await createCategoryAction(name, desc, selectedColor, parent, isParent);
      closeForm();
    } catch (e) {
      $error.textContent = e.message;
    }
    $createBtn.textContent = 'Create';
    validateForm();
  });
}

// ═══════════════════════════════════════════
// SIDEBAR VISIBILITY TOGGLE + BUTTON WIRING
// ═══════════════════════════════════════════

function initSidebarToggle() {
  const catSidebar = $('category-sidebar');
  const catToggleBtn = $('toggle-categories-btn');
  const catCloseBtn = $('sidebar-close');

  if (!catSidebar) return;

  function setCategoriesVisible(show) {
    catSidebar.style.display = show ? '' : 'none';
    if (catToggleBtn) catToggleBtn.classList.toggle('active', show);
    storage.setItem(KEYS.CATEGORIES_VISIBLE, show ? '1' : '0');
  }

  // Restore saved state (default: visible)
  const saved = storage.getItem(KEYS.CATEGORIES_VISIBLE);
  if (saved === '0') setCategoriesVisible(false);

  if (catToggleBtn) {
    catToggleBtn.addEventListener('click', () => {
      const isVisible = catSidebar.style.display !== 'none';
      setCategoriesVisible(!isVisible);
    });
  }

  if (catCloseBtn) {
    catCloseBtn.addEventListener('click', () => {
      setCategoriesVisible(false);
    });
  }
}

// ═══════════════════════════════════════════
// SELECT-ALL / CLEAR-ALL BUTTONS
// ═══════════════════════════════════════════

function initSelectAllClear() {
  const clearBtn = $('category-clear-btn');
  const selectAllBtn = $('category-select-all-btn');

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.activeCategories.clear();
      document.querySelectorAll('.category-chip').forEach(c => c.classList.add('inactive'));
      document.querySelectorAll('.category-cluster-header').forEach(c => c.classList.add('inactive'));
      scheduleGraphRemoval();
    });
  }

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      const presentCats = new Set(state.allNodes.map(n => n.payload.category));
      state.activeCategories = new Set([...presentCats, ...state.allCategoryNames]);
      document.querySelectorAll('.category-chip').forEach(c => c.classList.remove('inactive'));
      document.querySelectorAll('.category-cluster-header').forEach(c => c.classList.remove('inactive'));
      cancelScheduledRemoval();
      emit('graph:refresh');
    });
  }
}

// ═══════════════════════════════════════════
// INIT — call once at boot
// ═══════════════════════════════════════════

/**
 * Initialise the entire category sidebar system.
 * Call once after the DOM is ready and shared state is populated.
 */
export function initSidebar() {
  initSidebarToggle();
  initSelectAllClear();
  initCreateForm();

  // Listen for rebuild requests from other modules
  on('sidebar:rebuild', (presentCats) => {
    buildCategorySidebar(presentCats);
  });
}

// Re-export helpers that other modules may need
export { preloadCategoryLogos, scheduleGraphRemoval, cancelScheduledRemoval, openColorPicker, editCategoryUI, deleteCategoryUI };

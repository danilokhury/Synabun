// ═══════════════════════════════════════════
// SynaBun Neural Interface — Memory Explorer
// ═══════════════════════════════════════════
//
// Docked sidebar that organizes memories by parent → child
// category hierarchy. Slides in from the left and pushes
// the main content area to the right via --explorer-width.

import { state, emit, on } from './state.js';
import { catColor } from './colors.js';
import { openMemoryCard } from './ui-detail.js';
import { truncate } from './utils.js';
import { scheduleGraphRemoval, cancelScheduledRemoval, buildCategorySidebar, openColorPicker, editCategoryUI, deleteCategoryUI } from './ui-sidebar.js';
import { updateCategory as apiUpdateCategory } from './api.js';
import { KEYS } from './constants.js';
import { registerAction } from './ui-keybinds.js';
import { storage } from './storage.js';

const $ = (id) => document.getElementById(id);

// ─── Local state ────────────────────────
let _sortMode = 'newest';   // 'newest' | 'oldest' | 'alpha'
let _collapsed = new Set();  // category names that are collapsed
let _filterText = '';
let _visible = false;
let _width = 300;            // sidebar width in px
const MIN_WIDTH = 280;
const MAX_WIDTH = 600;

// ─── SVG icons ────────────────────────
const EYE_OPEN  = '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2.06 12c.86-2.15 3.64-7 9.94-7s9.08 4.85 9.94 7c-.86 2.15-3.64 7-9.94 7s-9.08-4.85-9.94-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_SLASH = '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l20 20"/><path d="M6.71 6.71C3.94 8.7 2.5 11.27 2.06 12c.86 2.15 3.64 7 9.94 7 2.08 0 3.82-.6 5.23-1.49"/><path d="M10 5.07A9.77 9.77 0 0 1 12 5c6.3 0 9.08 4.85 9.94 7-.35.87-.85 1.86-1.65 2.82"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/></svg>';
const SVG_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
const SVG_TRASH  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-.7 12.1a2 2 0 0 1-2 1.9H7.7a2 2 0 0 1-2-1.9L5 6"/></svg>';

// ─── Context menu singleton ──────────────
let _activeContextMenu = null;

function dismissContextMenu() {
  if (_activeContextMenu) {
    _activeContextMenu.remove();
    _activeContextMenu = null;
  }
}

function showCategoryContextMenu(btnEl, item, isParent, eyeState) {
  dismissContextMenu();

  const menu = document.createElement('div');
  menu.className = 'explorer-ctx-menu';
  _activeContextMenu = menu;

  const isActive = state.activeCategories.has(item.name);

  // ── Toggle visibility ──
  const toggleItem = document.createElement('button');
  toggleItem.className = 'explorer-ctx-item';
  toggleItem.innerHTML = `<span class="explorer-ctx-icon">${isActive ? EYE_SLASH : EYE_OPEN}</span><span>${isActive ? 'Hide from graph' : 'Show on graph'}</span>`;
  toggleItem.addEventListener('click', () => {
    dismissContextMenu();
    eyeState.toggle();
  });
  menu.appendChild(toggleItem);

  // ── Edit category ──
  const editItem = document.createElement('button');
  editItem.className = 'explorer-ctx-item';
  editItem.innerHTML = `<span class="explorer-ctx-icon">${SVG_PENCIL}</span><span>Edit category</span>`;
  editItem.addEventListener('click', () => {
    dismissContextMenu();
    editCategoryUI(item.name);
  });
  menu.appendChild(editItem);

  // ── Separator ──
  const sep = document.createElement('div');
  sep.className = 'explorer-ctx-sep';
  menu.appendChild(sep);

  // ── Delete category ──
  const memCount = countMemories(item);
  const deleteItem = document.createElement('button');
  deleteItem.className = 'explorer-ctx-item explorer-ctx-item--danger';
  deleteItem.innerHTML = `<span class="explorer-ctx-icon">${SVG_TRASH}</span><span>Delete category</span>`;
  deleteItem.addEventListener('click', () => {
    dismissContextMenu();
    deleteCategoryUI(item.name, memCount);
  });
  menu.appendChild(deleteItem);

  // Position relative to the button
  document.body.appendChild(menu);
  const btnRect = btnEl.getBoundingClientRect();
  let top = btnRect.bottom + 4;
  let left = btnRect.right - menu.offsetWidth;

  // Keep within viewport
  if (top + menu.offsetHeight > window.innerHeight - 8) {
    top = btnRect.top - menu.offsetHeight - 4;
  }
  if (left < 8) left = 8;

  menu.style.top = top + 'px';
  menu.style.left = left + 'px';

  // Dismiss on outside click (next tick so the current click doesn't trigger it)
  requestAnimationFrame(() => {
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        dismissContextMenu();
        document.removeEventListener('pointerdown', dismiss, true);
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
  });
}

// ═══════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════

function loadPersistedState() {
  try {
    const raw = storage.getItem(KEYS.EXPLORER_COLLAPSED);
    if (raw) _collapsed = new Set(JSON.parse(raw));
  } catch {}
  try {
    const s = storage.getItem(KEYS.EXPLORER_SORT);
    if (s && ['newest', 'oldest', 'alpha'].includes(s)) _sortMode = s;
  } catch {}
  try {
    const v = storage.getItem(KEYS.EXPLORER_VISIBLE);
    if (v === 'true') _visible = true;
  } catch {}
  try {
    const w = parseInt(storage.getItem(KEYS.EXPLORER_WIDTH), 10);
    if (w >= MIN_WIDTH && w <= MAX_WIDTH) _width = w;
  } catch {}
}

function saveCollapsed() {
  try { storage.setItem(KEYS.EXPLORER_COLLAPSED, JSON.stringify([..._collapsed])); } catch {}
}

function saveSort() {
  try { storage.setItem(KEYS.EXPLORER_SORT, _sortMode); } catch {}
}

function saveVisible() {
  try { storage.setItem(KEYS.EXPLORER_VISIBLE, String(_visible)); } catch {}
}

function saveWidth() {
  try { storage.setItem(KEYS.EXPLORER_WIDTH, String(_width)); } catch {}
}

// ─── Explorer category order persistence ──
function getExplorerCatOrder() {
  try { return JSON.parse(storage.getItem(KEYS.EXPLORER_CAT_ORDER) || '{}'); }
  catch { return {}; }
}

function saveExplorerCatOrder(order) {
  try { storage.setItem(KEYS.EXPLORER_CAT_ORDER, JSON.stringify(order)); }
  catch {}
}

/**
 * Sort tree items using saved order, appending unseen items alphabetically.
 */
function applySavedOrder(items, savedOrder) {
  if (!savedOrder || !savedOrder.length) return items;
  const inOrder = savedOrder.filter(n => items.some(i => i.name === n));
  const ordered = inOrder.map(n => items.find(i => i.name === n));
  const remaining = items.filter(i => !savedOrder.includes(i.name));
  return [...ordered, ...remaining];
}


// ═══════════════════════════════════════════
// CSS VARIABLE — drives all layout shifts
// ═══════════════════════════════════════════

function applyExplorerWidth() {
  const w = _visible ? `${_width}px` : '0px';
  document.documentElement.style.setProperty('--explorer-width', w);
}


// ═══════════════════════════════════════════
// SORT HELPERS
// ═══════════════════════════════════════════

function sortNodes(nodes) {
  const sorted = [...nodes];
  switch (_sortMode) {
    case 'newest':
      sorted.sort((a, b) => {
        const da = a.payload.updated_at || a.payload.created_at || '';
        const db = b.payload.updated_at || b.payload.created_at || '';
        return db.localeCompare(da);
      });
      break;
    case 'oldest':
      sorted.sort((a, b) => {
        const da = a.payload.created_at || '';
        const db = b.payload.created_at || '';
        return da.localeCompare(db);
      });
      break;
    case 'alpha':
      sorted.sort((a, b) => {
        const la = getMemoryLabel(a).toLowerCase();
        const lb = getMemoryLabel(b).toLowerCase();
        return la.localeCompare(lb);
      });
      break;
  }
  return sorted;
}

function getMemoryLabel(node) {
  const content = node.payload.content || '';
  // Use first meaningful line
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed) return trimmed;
  }
  return node.id.slice(0, 8);
}

function cycleSortMode() {
  const modes = ['newest', 'oldest', 'alpha'];
  const idx = modes.indexOf(_sortMode);
  _sortMode = modes[(idx + 1) % modes.length];
  saveSort();

  // Update tooltip
  const sortBtn = $('explorer-sort-btn');
  if (sortBtn) {
    const labels = { newest: 'Sort: newest first', oldest: 'Sort: oldest first', alpha: 'Sort: A-Z' };
    sortBtn.setAttribute('data-tooltip', labels[_sortMode]);
  }

  buildTree();
}


// ═══════════════════════════════════════════
// TREE DATA
// ═══════════════════════════════════════════

function buildTreeData() {
  const saved = getExplorerCatOrder();

  // Group memories by category
  const byCat = {};
  for (const node of state.allNodes) {
    const cat = node.payload.category || 'uncategorized';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(node);
  }

  const tree = [];
  const usedCats = new Set();

  // Parent categories first
  for (const [name, meta] of Object.entries(state.categoryMetadata)) {
    if (!meta.is_parent) continue;

    const children = [];
    for (const [cName, cMeta] of Object.entries(state.categoryMetadata)) {
      if (cMeta.parent !== name) continue;
      usedCats.add(cName);
      children.push({
        type: 'category',
        name: cName,
        meta: cMeta,
        memories: sortNodes(byCat[cName] || []),
      });
    }
    // Apply saved child order (fallback: alphabetical)
    const childOrder = (saved.children || {})[name];
    if (childOrder && childOrder.length) {
      children.splice(0, children.length, ...applySavedOrder(children, childOrder));
    } else {
      children.sort((a, b) => a.name.localeCompare(b.name));
    }

    usedCats.add(name);
    tree.push({
      type: 'parent',
      name,
      meta,
      children,
      memories: sortNodes(byCat[name] || []),
    });
  }

  // Standalone categories (no parent, not a parent)
  for (const [name, meta] of Object.entries(state.categoryMetadata)) {
    if (usedCats.has(name)) continue;
    usedCats.add(name);
    tree.push({
      type: 'category',
      name,
      meta,
      memories: sortNodes(byCat[name] || []),
    });
  }

  // Orphan memories (category not in metadata)
  for (const [cat, nodes] of Object.entries(byCat)) {
    if (usedCats.has(cat)) continue;
    tree.push({
      type: 'category',
      name: cat,
      meta: { color: null, is_parent: false },
      memories: sortNodes(nodes),
    });
  }

  // Apply saved top-level order (fallback: alphabetical)
  if (saved.topLevel && saved.topLevel.length) {
    tree.splice(0, tree.length, ...applySavedOrder(tree, saved.topLevel));
  } else {
    tree.sort((a, b) => a.name.localeCompare(b.name));
  }

  return tree;
}


// ═══════════════════════════════════════════
// FILTER
// ═══════════════════════════════════════════

function matchesFilter(node) {
  if (!_filterText) return true;
  const q = _filterText.toLowerCase();
  const p = node.payload;
  if ((p.content || '').toLowerCase().includes(q)) return true;
  if ((p.category || '').toLowerCase().includes(q)) return true;
  if (p.tags && p.tags.some(t => t.toLowerCase().includes(q))) return true;
  if ((p.subcategory || '').toLowerCase().includes(q)) return true;
  return false;
}

function countMemories(treeItem) {
  let count = 0;
  if (treeItem.memories) count += treeItem.memories.length;
  if (treeItem.children) {
    for (const child of treeItem.children) count += countMemories(child);
  }
  return count;
}

function countFilteredMemories(treeItem) {
  let count = 0;
  if (treeItem.memories) count += treeItem.memories.filter(matchesFilter).length;
  if (treeItem.children) {
    for (const child of treeItem.children) count += countFilteredMemories(child);
  }
  return count;
}


// ═══════════════════════════════════════════
// DOM RENDERING
// ═══════════════════════════════════════════

function buildTree() {
  const container = $('explorer-tree');
  if (!container) return;

  const treeData = buildTreeData();
  container.innerHTML = '';

  let totalMemories = 0;
  let visibleMemories = 0;

  for (const item of treeData) {
    const { el, total, visible } = renderTreeItem(item, 0);
    if (el) container.appendChild(el);
    totalMemories += total;
    visibleMemories += visible;
  }

  // Update footer
  const countEl = $('explorer-count');
  if (countEl) {
    if (_filterText) {
      countEl.textContent = `${visibleMemories} / ${totalMemories} memories`;
    } else {
      countEl.textContent = `${totalMemories} memories`;
    }
  }

  // Highlight selected node
  if (state.selectedNodeId) {
    highlightNode(state.selectedNodeId, false);
  }

  // Wire drag-and-drop (only once per container element)
  if (!container._dragWired) {
    initExplorerDrag(container);
    container._dragWired = true;
  }
}

function renderTreeItem(item, depth) {
  const isParent = item.type === 'parent';

  // For categories, check if any memories match filter
  const filteredMemories = item.memories ? item.memories.filter(matchesFilter) : [];
  const filteredChildCount = item.children
    ? item.children.reduce((sum, c) => sum + countFilteredMemories(c), 0)
    : 0;
  const totalFiltered = filteredMemories.length + filteredChildCount;

  const totalMemories = countMemories(item);

  // Skip if filter active and nothing matches
  if (_filterText && totalFiltered === 0) {
    return { el: null, total: totalMemories, visible: 0 };
  }

  const el = document.createElement('div');
  el.className = `explorer-node ${isParent ? 'explorer-parent' : 'explorer-category'}`;
  el.dataset.cat = item.name;

  const expanded = !_collapsed.has(item.name);
  el.dataset.expanded = String(expanded);

  // Category row
  const row = document.createElement('div');
  row.className = 'explorer-row';
  row.style.paddingLeft = `${10 + depth * 16}px`;

  // Chevron
  const hasContent = (filteredMemories.length > 0) ||
    (item.children && item.children.some(c => !_filterText || countFilteredMemories(c) > 0));
  const chevron = document.createElement('span');
  chevron.className = 'explorer-chevron';
  chevron.textContent = hasContent ? '\u25B6' : '';
  row.appendChild(chevron);

  // Color dot (click to change color)
  const dot = document.createElement('span');
  dot.className = 'explorer-dot';
  const color = catColor(item.name);
  dot.style.background = color;
  dot.setAttribute('data-tooltip', 'Color');
  dot.setAttribute('data-tooltip-pos', 'right');
  dot.style.cursor = 'pointer';
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    openColorPicker(item.name, el);
  });
  row.appendChild(dot);

  // Label
  const label = document.createElement('span');
  label.className = 'explorer-label';
  label.textContent = item.name;
  label.setAttribute('data-tooltip', item.meta?.description || item.name);
  label.setAttribute('data-tooltip-pos', 'right');
  row.appendChild(label);

  // Badge (count)
  const badge = document.createElement('span');
  badge.className = 'explorer-badge';
  if (_filterText) {
    badge.textContent = `${totalFiltered}/${totalMemories}`;
  } else {
    badge.textContent = String(totalMemories);
  }
  row.appendChild(badge);

  // Visibility state indicator (dimmed row when hidden)
  const isActive = state.activeCategories.has(item.name);
  if (!isActive) el.classList.add('explorer-hidden-cat');

  // "..." context menu button
  const moreBtn = document.createElement('button');
  moreBtn.className = 'explorer-more';
  moreBtn.textContent = '\u22EF'; // ⋯
  moreBtn.setAttribute('data-tooltip', 'Options');
  moreBtn.setAttribute('data-tooltip-pos', 'left');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const eyeState = {
      toggle: () => {
        const catName = item.name;
        const childNames = isParent
          ? Object.entries(state.categoryMetadata)
              .filter(([, m]) => m.parent === catName)
              .map(([n]) => n)
          : [];
        const targets = [catName, ...childNames];

        if (state.activeCategories.has(catName)) {
          targets.forEach(c => state.activeCategories.delete(c));
          el.classList.add('explorer-hidden-cat');
          scheduleGraphRemoval();
        } else {
          targets.forEach(c => state.activeCategories.add(c));
          el.classList.remove('explorer-hidden-cat');
          cancelScheduledRemoval();
          emit('graph:refresh');
        }
        emit('categories-changed');
      }
    };
    showCategoryContextMenu(moreBtn, item, isParent, eyeState);
  });
  row.appendChild(moreBtn);

  el.appendChild(row);

  // Click to toggle collapse
  row.addEventListener('click', (e) => {
    if (e.target.closest('.explorer-more')) return;
    if (e.target.closest('.explorer-dot')) return;
    e.stopPropagation();
    const wasExpanded = el.dataset.expanded === 'true';
    el.dataset.expanded = String(!wasExpanded);
    if (wasExpanded) {
      _collapsed.add(item.name);
    } else {
      _collapsed.delete(item.name);
    }
    saveCollapsed();
  });

  // Children container
  const childrenEl = document.createElement('div');
  childrenEl.className = 'explorer-children';

  let visibleCount = 0;

  // Render child categories
  if (item.children) {
    for (const child of item.children) {
      const { el: childEl, visible } = renderTreeItem(child, depth + 1);
      if (childEl) childrenEl.appendChild(childEl);
      visibleCount += visible;
    }
  }

  // Render memories directly in this category
  for (const mem of filteredMemories) {
    const memEl = renderMemoryItem(mem, depth + 1);
    childrenEl.appendChild(memEl);
    visibleCount++;
  }

  el.appendChild(childrenEl);

  return { el, total: totalMemories, visible: visibleCount };
}

function renderMemoryItem(node, depth) {
  const el = document.createElement('div');
  el.className = 'explorer-node explorer-memory';
  el.dataset.id = node.id;

  if (node.id === state.selectedNodeId) {
    el.classList.add('selected');
  }

  const row = document.createElement('div');
  row.className = 'explorer-row';
  row.style.paddingLeft = `${10 + depth * 16}px`;

  // Memory icon (small dot/circle)
  const icon = document.createElement('span');
  icon.className = 'explorer-memory-icon';
  icon.textContent = '\u25CB'; // ○
  row.appendChild(icon);

  // Label (first line of content)
  const label = document.createElement('span');
  label.className = 'explorer-label';
  const preview = getMemoryLabel(node);
  label.textContent = truncate(preview, 60);
  row.setAttribute('data-tooltip', preview);
  row.setAttribute('data-tooltip-pos', 'right');
  row.appendChild(label);

  // Importance indicator
  if (node.payload.importance && node.payload.importance >= 5) {
    const imp = document.createElement('span');
    imp.className = 'explorer-importance';
    const val = node.payload.importance;
    imp.textContent = '\u25CF'.repeat(Math.min(val, 10));
    imp.setAttribute('data-tooltip', `Importance: ${val}/10`);
    imp.setAttribute('data-tooltip-pos', 'right');
    if (val >= 8) imp.classList.add('explorer-importance--high');
    row.appendChild(imp);
  }

  el.appendChild(row);

  // Click to open detail panel + navigate graph
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    state.selectedNodeId = node.id;
    openMemoryCard(node);
    emit('graph:navigate', { node, zoom: 'close' });
    emit('node-selected', node);
    highlightNode(node.id, false);
  });

  // Drag to terminal — feed memory as context to CLI
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-synabun-memory', node.id);
    e.dataTransfer.effectAllowed = 'copy';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
  });

  return el;
}


// ═══════════════════════════════════════════
// HIGHLIGHT / SCROLL-INTO-VIEW
// ═══════════════════════════════════════════

function highlightNode(nodeId, scrollIntoView = true) {
  const container = $('explorer-tree');
  if (!container) return;

  // Remove previous highlight
  container.querySelectorAll('.explorer-memory.selected').forEach(el => {
    el.classList.remove('selected');
  });

  if (!nodeId) return;

  // Find and highlight
  const memEl = container.querySelector(`.explorer-memory[data-id="${CSS.escape(nodeId)}"]`);
  if (!memEl) return;

  memEl.classList.add('selected');

  if (scrollIntoView) {
    // Expand parent categories if needed
    let parent = memEl.parentElement;
    while (parent && parent !== container) {
      if (parent.classList.contains('explorer-node') && parent.dataset.expanded === 'false') {
        parent.dataset.expanded = 'true';
        _collapsed.delete(parent.dataset.cat);
      }
      parent = parent.parentElement;
    }
    saveCollapsed();

    // Scroll into view
    memEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}


// ═══════════════════════════════════════════
// TOGGLE / SHOW / HIDE
// ═══════════════════════════════════════════

export function toggleExplorer() {
  const panel = $('explorer-panel');
  if (!panel) return;

  _visible = !_visible;
  panel.classList.toggle('open', _visible);
  saveVisible();

  // Toggle unified title bar style + solid containers
  const titleBar = document.getElementById('title-bar');
  if (titleBar) titleBar.classList.toggle('explorer-active', _visible);
  document.body.classList.toggle('explorer-open', _visible);

  // Set CSS variable to push content
  applyExplorerWidth();

  // Tell graphs to resize after transition
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 320);

  // Sync menu checkmark
  const menuEl = $('menu-toggle-explorer');
  if (menuEl) menuEl.classList.toggle('active', _visible);

  // Build tree on first show
  if (_visible && !panel.dataset.built) {
    buildTree();
    panel.dataset.built = '1';
  }
}

// ═══════════════════════════════════════════
// COLLAPSE ALL / EXPAND ALL
// ═══════════════════════════════════════════

function collapseAll() {
  const container = $('explorer-tree');
  if (!container) return;
  container.querySelectorAll('.explorer-node[data-cat]').forEach(el => {
    el.dataset.expanded = 'false';
    _collapsed.add(el.dataset.cat);
  });
  saveCollapsed();
}

function expandAll() {
  const container = $('explorer-tree');
  if (!container) return;
  container.querySelectorAll('.explorer-node[data-cat]').forEach(el => {
    el.dataset.expanded = 'true';
  });
  _collapsed.clear();
  saveCollapsed();
}


// ═══════════════════════════════════════════
// RESIZE HANDLE (right edge drag)
// ═══════════════════════════════════════════

function initResizeHandle() {
  const handle = $('explorer-resize-handle');
  const panel = $('explorer-panel');
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
    const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX));
    _width = newWidth;
    panel.style.width = `${_width}px`;
    applyExplorerWidth();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveWidth();
    // Trigger graph resize
    window.dispatchEvent(new Event('resize'));
  });
}


// ═══════════════════════════════════════════
// DRAG-AND-DROP REORDERING
// ═══════════════════════════════════════════

let _dragEl = null;        // .explorer-node being dragged
let _dragType = null;      // 'parent' | 'category'
let _dragName = null;      // category name from data-cat
let _startY = 0;
let _startX = 0;
let _cloneEl = null;       // floating clone (body-appended)
let _initialRect = null;
let _didDragMove = false;
let _reparenting = false;  // guard for concurrent API calls

function wouldCreateCycle(draggedCat, targetParent) {
  if (draggedCat === targetParent) return true;
  let cur = targetParent;
  while (cur) {
    if (cur === draggedCat) return true;
    cur = (state.categoryMetadata[cur] || {}).parent;
  }
  return false;
}

function clearDragIndicators(container) {
  container.querySelectorAll('.explorer-drop-before, .explorer-drop-after').forEach(el => {
    el.classList.remove('explorer-drop-before', 'explorer-drop-after');
  });
  container.querySelectorAll('.explorer-drop-reparent').forEach(el => {
    el.classList.remove('explorer-drop-reparent');
  });
}

function createExplorerDragClone(row) {
  const rect = row.getBoundingClientRect();
  const clone = document.createElement('div');
  clone.className = 'explorer-drag-clone';
  // Copy relevant children (dot + label)
  const dot = row.querySelector('.explorer-dot');
  const label = row.querySelector('.explorer-label');
  if (dot) clone.appendChild(dot.cloneNode(true));
  if (label) {
    const lbl = label.cloneNode(true);
    lbl.style.maxWidth = '180px';
    clone.appendChild(lbl);
  }
  clone.style.width = Math.min(rect.width, 240) + 'px';
  clone.style.left = rect.left + 'px';
  clone.style.top = rect.top + 'px';
  clone.style.transform = 'translate(0px, 0px) scale(1.04) rotate(0.8deg)';
  document.body.appendChild(clone);
  return clone;
}

function getExplorerDropTarget(container, y) {
  const topLevelNodes = [...container.querySelectorAll(':scope > .explorer-node[data-cat]')];

  if (_dragType === 'parent') {
    // Dragging a parent — reorder among top-level siblings only
    for (const node of topLevelNodes) {
      if (node === _dragEl) continue;
      const row = node.querySelector(':scope > .explorer-row');
      if (!row) continue;
      const rect = row.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (y >= rect.top - 8 && y <= rect.bottom + 8) {
        return { type: 'reorder-toplevel', node, position: y < mid ? 'before' : 'after' };
      }
    }
    return null;
  }

  // Dragging a child category — can reorder among siblings or reparent
  const currentParentEl = _dragEl.parentElement?.closest('.explorer-node[data-cat]');
  const currentParentName = currentParentEl?.dataset.cat || null;

  // Check: is cursor above all top-level items? → make top-level
  if (topLevelNodes.length > 0) {
    const firstRow = topLevelNodes[0]?.querySelector(':scope > .explorer-row');
    if (firstRow) {
      const firstRect = firstRow.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (y < firstRect.top && y >= containerRect.top) {
        return { type: 'make-toplevel' };
      }
    }
  }

  // Check all visible category nodes
  const allCatNodes = [...container.querySelectorAll('.explorer-node[data-cat]')];
  for (const node of allCatNodes) {
    if (node === _dragEl) continue;
    const row = node.querySelector(':scope > .explorer-row');
    if (!row) continue;
    const rect = row.getBoundingClientRect();
    if (y < rect.top - 8 || y > rect.bottom + 8) continue;

    const mid = rect.top + rect.height / 2;
    const nodeCat = node.dataset.cat;
    const nodeMeta = state.categoryMetadata[nodeCat] || {};
    const isParentNode = node.classList.contains('explorer-parent');

    // If hovering a parent node → reparent into it
    if (isParentNode && !wouldCreateCycle(_dragName, nodeCat)) {
      return { type: 'reparent', node, targetName: nodeCat };
    }

    // If hovering a sibling (same parent) → reorder
    const nodeParentEl = node.parentElement?.closest('.explorer-node[data-cat]');
    const nodeParentName = nodeParentEl?.dataset.cat || null;
    if (nodeParentName === currentParentName) {
      return { type: 'reorder-sibling', node, position: y < mid ? 'before' : 'after', parentName: currentParentName };
    }

    // If hovering a category under a different parent → reparent to that parent
    if (nodeParentName && nodeParentName !== currentParentName && !wouldCreateCycle(_dragName, nodeParentName)) {
      return { type: 'reparent', node: nodeParentEl, targetName: nodeParentName };
    }

    // If hovering a top-level standalone category → reorder at top level
    if (!nodeParentName && !isParentNode) {
      return { type: 'reorder-toplevel', node, position: y < mid ? 'before' : 'after' };
    }
  }

  return null;
}

function initExplorerDrag(container) {
  container.addEventListener('pointerdown', (e) => {
    // Only trigger on grip handle
    const gripEl = e.target.closest('.explorer-grip');
    if (!gripEl) return;

    const nodeEl = gripEl.closest('.explorer-node[data-cat]');
    if (!nodeEl) return;
    if (nodeEl.classList.contains('explorer-memory')) return;
    if (_filterText) return;   // no drag during search
    if (_reparenting) return;  // API call in flight

    e.preventDefault();
    e.stopPropagation();

    _dragEl = nodeEl;
    _dragType = nodeEl.classList.contains('explorer-parent') ? 'parent' : 'category';
    _dragName = nodeEl.dataset.cat;
    _startY = e.clientY;
    _startX = e.clientX;
    _didDragMove = false;

    nodeEl.setPointerCapture(e.pointerId);

    function onMove(ev) {
      if (!_dragEl) return;
      if (!_didDragMove && Math.abs(ev.clientY - _startY) < 5 && Math.abs(ev.clientX - _startX) < 5) return;

      if (!_didDragMove) {
        _didDragMove = true;
        _initialRect = _dragEl.getBoundingClientRect();

        // Create floating clone from the row
        const row = _dragEl.querySelector(':scope > .explorer-row');
        _cloneEl = createExplorerDragClone(row);

        // Ghost the source
        _dragEl.classList.add('explorer-drag-source');
        container.classList.add('explorer-dragging');

        // Set gap size based on row height
        const rowH = row.getBoundingClientRect().height + 4;
        container.style.setProperty('--explorer-drag-gap', rowH + 'px');
      }

      // Move clone
      const dx = ev.clientX - _startX;
      const dy = ev.clientY - _startY;
      _cloneEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.04) rotate(0.8deg)`;

      // Show drop indicator
      clearDragIndicators(container);
      const target = getExplorerDropTarget(container, ev.clientY);
      if (target) {
        if (target.type === 'reparent') {
          target.node.classList.add('explorer-drop-reparent');
        } else if (target.type === 'reorder-toplevel' || target.type === 'reorder-sibling') {
          target.node.classList.add(target.position === 'before' ? 'explorer-drop-before' : 'explorer-drop-after');
        } else if (target.type === 'make-toplevel') {
          const first = container.querySelector(':scope > .explorer-node[data-cat]');
          if (first && first !== _dragEl) first.classList.add('explorer-drop-before');
        }
      }
    }

    async function onUp(ev) {
      nodeEl.removeEventListener('pointermove', onMove);
      nodeEl.removeEventListener('pointerup', onUp);
      nodeEl.removeEventListener('pointercancel', onUp);

      if (!_dragEl) return;

      const droppedName = _dragName;
      const didMove = _didDragMove;

      if (didMove) {
        const target = getExplorerDropTarget(container, ev.clientY);

        // ── Spring-snap animation ──
        if (_cloneEl && target && _initialRect) {
          let gapEl = null, gapPosition = null;
          if (target.type === 'reorder-toplevel' || target.type === 'reorder-sibling') {
            gapEl = target.node;
            gapPosition = target.position;
          } else if (target.type === 'make-toplevel') {
            gapEl = container.querySelector(':scope > .explorer-node[data-cat]');
            gapPosition = 'before';
          } else if (target.type === 'reparent') {
            gapEl = target.node;
            gapPosition = 'after';
          }

          if (gapEl) {
            const gapRect = gapEl.getBoundingClientRect();
            const rowH = _initialRect.height + 4;
            const targetTop = gapPosition === 'before'
              ? gapRect.top - rowH
              : gapRect.bottom;
            const targetDy = targetTop - _initialRect.top;
            const targetDx = gapRect.left - _initialRect.left;

            _cloneEl.style.transition = 'transform 0.22s cubic-bezier(0.22, 1.15, 0.36, 1), opacity 0.14s ease 0.06s';
            _cloneEl.style.transform = `translate(${targetDx}px, ${targetDy}px) scale(1) rotate(0deg)`;
            _cloneEl.style.opacity = '0';
            await new Promise(r => setTimeout(r, 220));
          }
        } else if (_cloneEl && _initialRect) {
          // No valid target — snap back
          _cloneEl.style.transition = 'transform 0.2s cubic-bezier(0.2, 0, 0, 1), opacity 0.12s ease';
          _cloneEl.style.transform = 'translate(0px, 0px) scale(1) rotate(0deg)';
          _cloneEl.style.opacity = '0';
          await new Promise(r => setTimeout(r, 200));
        }

        // ── Execute drop action ──
        if (target) {
          const saved = getExplorerCatOrder();

          if (target.type === 'reorder-toplevel') {
            // Read current top-level order from DOM
            const topNames = [...container.querySelectorAll(':scope > .explorer-node[data-cat]')]
              .map(el => el.dataset.cat)
              .filter(n => n !== droppedName);
            const refIdx = topNames.indexOf(target.node.dataset.cat);
            const insertIdx = target.position === 'before' ? refIdx : refIdx + 1;
            topNames.splice(insertIdx, 0, droppedName);
            saved.topLevel = topNames;
            saveExplorerCatOrder(saved);
            buildTree();

          } else if (target.type === 'reorder-sibling' && target.parentName) {
            // Read current child order within the parent
            const parentEl = container.querySelector(`.explorer-node[data-cat="${CSS.escape(target.parentName)}"]`);
            if (parentEl) {
              const childContainer = parentEl.querySelector(':scope > .explorer-children');
              if (childContainer) {
                const childNames = [...childContainer.querySelectorAll(':scope > .explorer-node[data-cat]')]
                  .map(el => el.dataset.cat)
                  .filter(n => n !== droppedName);
                const refIdx = childNames.indexOf(target.node.dataset.cat);
                const insertIdx = target.position === 'before' ? refIdx : refIdx + 1;
                childNames.splice(insertIdx, 0, droppedName);
                if (!saved.children) saved.children = {};
                saved.children[target.parentName] = childNames;
                saveExplorerCatOrder(saved);
                buildTree();
              }
            }

          } else if (target.type === 'reparent') {
            const newParent = target.targetName;
            const currentMeta = state.categoryMetadata[droppedName] || {};
            if (currentMeta.parent !== newParent) {
              _reparenting = true;
              try {
                const data = await apiUpdateCategory(droppedName, { parent: newParent });
                // Apply response to state
                if (data && data.categories) {
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
                }
                const presentCats = new Set(state.allNodes.map(n => n.payload.category));
                buildCategorySidebar(presentCats);
                emit('graph:refresh');
                buildTree();
              } catch (err) {
                console.error('Explorer: error reparenting category:', err);
              } finally {
                _reparenting = false;
              }
            }

          } else if (target.type === 'make-toplevel') {
            const currentMeta = state.categoryMetadata[droppedName] || {};
            if (currentMeta.parent) {
              _reparenting = true;
              try {
                const data = await apiUpdateCategory(droppedName, { parent: '' });
                if (data && data.categories) {
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
                }
                const presentCats = new Set(state.allNodes.map(n => n.payload.category));
                buildCategorySidebar(presentCats);
                emit('graph:refresh');
                buildTree();
              } catch (err) {
                console.error('Explorer: error making category top-level:', err);
              } finally {
                _reparenting = false;
              }
            }
          }
        }
      }

      // ── Cleanup ──
      clearDragIndicators(container);
      if (_dragEl) _dragEl.classList.remove('explorer-drag-source');
      if (_cloneEl) { _cloneEl.remove(); _cloneEl = null; }
      container.classList.remove('explorer-dragging');
      container.style.removeProperty('--explorer-drag-gap');
      _dragEl = null;
      _dragType = null;
      _dragName = null;
      _initialRect = null;

      // ── Settle animation ──
      if (didMove && droppedName) {
        const settled = container.querySelector(`.explorer-node[data-cat="${CSS.escape(droppedName)}"]`);
        if (settled) {
          settled.classList.add('explorer-just-dropped');
          settled.addEventListener('animationend', () => settled.classList.remove('explorer-just-dropped'), { once: true });
        }
      }
    }

    nodeEl.addEventListener('pointermove', onMove);
    nodeEl.addEventListener('pointerup', onUp);
    nodeEl.addEventListener('pointercancel', onUp);
  });
}


// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

export function initExplorer() {
  loadPersistedState();

  // Apply persisted width to the panel
  const panel = $('explorer-panel');
  if (panel) {
    panel.style.width = `${_width}px`;
  }

  // Menu toggle
  const menuEl = $('menu-toggle-explorer');
  if (menuEl) {
    menuEl.addEventListener('click', () => toggleExplorer());
  }

  // Logo click toggles explorer
  const logo = $('titlebar-logo');
  if (logo) {
    logo.addEventListener('click', () => toggleExplorer());
  }

  // Collapse all / expand all
  const collapseAllBtn = $('explorer-collapse-all');
  if (collapseAllBtn) collapseAllBtn.addEventListener('click', collapseAll);

  const expandAllBtn = $('explorer-expand-all');
  if (expandAllBtn) expandAllBtn.addEventListener('click', expandAll);

  // Sort button
  const sortBtn = $('explorer-sort-btn');
  if (sortBtn) {
    // Set initial tooltip
    const labels = { newest: 'Sort: newest first', oldest: 'Sort: oldest first', alpha: 'Sort: A-Z' };
    sortBtn.setAttribute('data-tooltip', labels[_sortMode]);
    sortBtn.addEventListener('click', cycleSortMode);
  }

  // Filter input
  const filterInput = $('explorer-filter-input');
  const filterClear = $('explorer-filter-clear');
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      _filterText = filterInput.value.trim();
      filterClear.style.display = _filterText ? '' : 'none';
      buildTree();
    });
  }
  if (filterClear) {
    filterClear.style.display = 'none';
    filterClear.addEventListener('click', () => {
      _filterText = '';
      if (filterInput) filterInput.value = '';
      filterClear.style.display = 'none';
      buildTree();
    });
  }

  // Label toggle
  const labelToggle = $('explorer-label-toggle');
  if (labelToggle) {
    // Sync initial style
    labelToggle.style.color = state.labelsVisible ? 'var(--t-primary)' : 'var(--t-muted)';
    labelToggle.addEventListener('click', () => {
      state.labelsVisible = !state.labelsVisible;
      labelToggle.style.color = state.labelsVisible ? 'var(--t-primary)' : 'var(--t-muted)';
      emit('graph:refresh');
    });
  }

  // Label size button + slider
  const labelSizeBtn = $('explorer-label-size');
  const sliderRow = $('explorer-label-slider-row');
  const slider = $('explorer-label-slider');
  if (labelSizeBtn && sliderRow && slider) {
    slider.value = state.labelSizeMultiplier;
    labelSizeBtn.addEventListener('click', () => {
      const open = sliderRow.style.display !== 'none';
      sliderRow.style.display = open ? 'none' : '';
    });
    slider.addEventListener('input', () => {
      state.labelSizeMultiplier = parseFloat(slider.value);
      emit('graph:refresh');
    });
  }

  // Select all / deselect all categories
  const selectAllBtn = $('explorer-select-all');
  const deselectAllBtn = $('explorer-deselect-all');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      Object.keys(state.categoryMetadata).forEach(c => state.activeCategories.add(c));
      cancelScheduledRemoval();
      emit('graph:refresh');
      emit('categories-changed');
      buildTree();
    });
  }
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => {
      state.activeCategories.clear();
      scheduleGraphRemoval();
      emit('categories-changed');
      buildTree();
    });
  }

  // Right-edge resize
  initResizeHandle();

  // Keyboard shortcut: toggle explorer (via central keybinds)
  registerAction('toggle-explorer', () => toggleExplorer());

  // ── Event bus listeners ──

  // Rebuild tree when data changes
  on('data-loaded', () => {
    if (_visible) buildTree();
    else {
      if (panel) delete panel.dataset.built;
    }
  });

  on('data:reload', () => {
    if (_visible) buildTree();
    else {
      if (panel) delete panel.dataset.built;
    }
  });

  on('categories-changed', () => {
    if (_visible) buildTree();
    else {
      if (panel) delete panel.dataset.built;
    }
  });

  // Also listen to sidebar's colon-separated event (edit/delete/create)
  on('categories:changed', () => {
    if (_visible) buildTree();
    else {
      if (panel) delete panel.dataset.built;
    }
  });

  // Sync selection from graph click
  on('node-selected', (node) => {
    if (node && _visible) {
      highlightNode(node.id, true);
    }
  });

  // Search integration
  on('search:apply', () => {
    if (_visible) buildTree();
  });

  on('search:clear', () => {
    if (_visible) buildTree();
  });

  // Restore visibility if it was open last time
  if (_visible) {
    if (panel) {
      panel.classList.add('open');
      applyExplorerWidth();
      const titleBar = document.getElementById('title-bar');
      if (titleBar) titleBar.classList.add('explorer-active');
      document.body.classList.add('explorer-open');
      const menuItem = $('menu-toggle-explorer');
      if (menuItem) menuItem.classList.add('active');
    }
  }
}

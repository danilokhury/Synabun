// ═══════════════════════════════════════════
// SynaBun Neural Interface — Bookmarks
// Toolbar dropdown for bookmarking and quick-navigating to memories.
// Works identically in both 3D and 2D variants.
// ═══════════════════════════════════════════

import { state, emit, on } from './state.js';
import { KEYS } from './constants.js';
import { storage } from './storage.js';
import { catColor } from './colors.js';

const $ = (id) => document.getElementById(id);

// ── localStorage helpers ──

/**
 * Read the bookmarks array from localStorage.
 * @returns {Array<{id:string, title:string, category:string, added:number}>}
 */
export function loadBookmarks() {
  try {
    return JSON.parse(storage.getItem(KEYS.BOOKMARKS) || '[]');
  } catch {
    return [];
  }
}

function saveBookmarks(arr) {
  storage.setItem(KEYS.BOOKMARKS, JSON.stringify(arr));
  updateBookmarkCount();
}

// ── Public API ──

/**
 * Check whether a node is bookmarked.
 * @param {string} nodeId
 * @returns {boolean}
 */
export function isBookmarked(nodeId) {
  return loadBookmarks().some(b => b.id === nodeId);
}

/**
 * Toggle bookmark state for a node.
 * If already bookmarked, removes it; otherwise adds it.
 * @param {string} nodeId  The node ID to toggle
 * @returns {boolean} Whether the node is bookmarked after toggling
 */
export function toggleBookmark(nodeId) {
  const node = state.allNodes.find(n => n.id === nodeId);
  if (!node) return false;

  const bookmarks = loadBookmarks();
  const idx = bookmarks.findIndex(b => b.id === node.id);

  if (idx !== -1) {
    bookmarks.splice(idx, 1);
  } else {
    const p = node.payload || {};
    const preview = (p.content || '').replace(/\n/g, ' ').slice(0, 80);
    bookmarks.unshift({
      id: node.id,
      title: preview || node.id,
      category: p.category || 'uncategorized',
      added: Date.now(),
    });
  }

  saveBookmarks(bookmarks);
  updateDetailBookmarkBtn(node.id);
  return isBookmarked(node.id);
}

// ── Count badge ──

function updateBookmarkCount() {
  const badge = $('bookmark-count');
  if (!badge) return;
  const count = loadBookmarks().length;
  badge.textContent = count > 0 ? count : '';
}

// ── Detail-panel bookmark button ──

function updateDetailBookmarkBtn(nodeId) {
  const btn = $('detail-bookmark-btn');
  if (!btn) return;
  const svg = btn.querySelector('svg');
  if (isBookmarked(nodeId)) {
    btn.classList.add('active');
    if (svg) svg.classList.add('filled');
  } else {
    btn.classList.remove('active');
    if (svg) svg.classList.remove('filled');
  }
}

// ── Dropdown rendering ──

/**
 * Render the bookmark list inside the dropdown panel.
 */
export function renderBookmarks() {
  const listEl = $('bookmarks-list');
  if (!listEl) return;

  const bookmarks = loadBookmarks();
  listEl.innerHTML = '';

  if (bookmarks.length === 0) {
    listEl.innerHTML = '<div class="dropdown-empty">No bookmarks yet.<br>Click the bookmark icon on any memory to save it here.</div>';
    return;
  }

  bookmarks.forEach(b => {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    const color = catColor(b.category);
    item.innerHTML = `
      <div class="dropdown-item-dot" style="background:${color}"></div>
      <div class="dropdown-item-text">
        <div class="dropdown-item-title">${b.title}</div>
        <div class="dropdown-item-sub">${b.category}</div>
      </div>
      <button class="icon-btn icon-btn--danger" style="width:22px;height:22px;font-size:13px;border:none" data-tooltip="Remove">&times;</button>
    `;

    // Click item -> navigate to node
    const navToBookmark = () => {
      const node = state.allNodes.find(n => n.id === b.id);
      if (node) {
        emit('panel:close-all-dropdowns');
        emit('graph:navigate', { node, zoom: 'gentle' });
      }
    };
    item.querySelector('.dropdown-item-text').addEventListener('click', navToBookmark);
    item.querySelector('.dropdown-item-dot').addEventListener('click', navToBookmark);

    // Remove button
    item.querySelector('.icon-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const bks = loadBookmarks().filter(x => x.id !== b.id);
      saveBookmarks(bks);
      renderBookmarks();
      if (state.selectedNodeId === b.id) updateDetailBookmarkBtn(b.id);
    });

    listEl.appendChild(item);
  });
}

// ── Initialization ──

/**
 * Wire up all bookmark-related event listeners.
 * Call once after the DOM is ready.
 * Open/close is handled by the menubar (ui-menubar.js).
 */
export function initBookmarks() {
  const detailBookmarkBtn = $('detail-bookmark-btn');

  // Menubar triggers rendering when Bookmarks menu opens
  on('bookmarks:render', renderBookmarks);

  // Detail panel bookmark toggle
  if (detailBookmarkBtn) {
    detailBookmarkBtn.addEventListener('click', () => {
      if (!state.selectedNodeId) return;
      toggleBookmark(state.selectedNodeId);
    });
  }

  // When selection changes, update the detail bookmark button
  on('selection-changed', (nodeId) => {
    if (nodeId) updateDetailBookmarkBtn(nodeId);
  });

  // Initialize count badge on load
  updateBookmarkCount();
}

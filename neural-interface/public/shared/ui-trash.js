// ═══════════════════════════════════════════
// SynaBun Neural Interface — Trash Panel
// Floating window for viewing, restoring, and purging trashed memories.
// Styled after the Skills Studio container.
// ═══════════════════════════════════════════

import { emit, on }                             from './state.js';
import { fetchTrash, restoreFromTrash, purgeTrash, deleteMemoryPermanent } from './api.js';
import { formatTrashAge, formatMemoryContent }  from './utils.js';
import { storage } from './storage.js';

const $ = (id) => document.getElementById(id);

// HTML-escape helper
function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── Module state ────────────────────────

let trashPanelOpen   = false;
let trashItems       = [];
let trashSelectedId  = null;
let trashSearchTerm  = '';
let trashFilterCat   = 'all';     // 'all' or a specific category slug
let trashSortBy      = 'newest';  // 'newest' | 'oldest' | 'category'

// ─── Badge ───────────────────────────────

function updateTrashBadge() {
  const badge = $('titlebar-trash-count');
  if (badge) badge.textContent = trashItems.length > 0 ? trashItems.length : '';
}

// ─── Fetch ───────────────────────────────

async function fetchTrashItems() {
  try {
    const data = await fetchTrash();
    trashItems = data.items;
    updateTrashBadge();
    if (trashPanelOpen) renderTrashList();
  } catch (err) {
    console.error('fetchTrash error:', err);
  }
}

// ─── Helpers ─────────────────────────────

/** Get unique categories from trash items, sorted alphabetically */
function getTrashCategories() {
  const cats = new Set();
  for (const item of trashItems) {
    cats.add(item.payload.category || 'uncategorized');
  }
  return [...cats].sort();
}

/** Apply search + category filter + sort */
function getFilteredItems() {
  let list = trashItems;

  // Category filter
  if (trashFilterCat !== 'all') {
    list = list.filter(i => (i.payload.category || 'uncategorized') === trashFilterCat);
  }

  // Search filter
  if (trashSearchTerm) {
    list = list.filter(item => {
      const p = item.payload;
      const haystack = [
        p.content, p.category, p.subcategory, p.project, ...(p.tags || []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(trashSearchTerm);
    });
  }

  // Sort
  if (trashSortBy === 'oldest') {
    list = [...list].sort((a, b) => (a.payload.trashed_at || '').localeCompare(b.payload.trashed_at || ''));
  } else if (trashSortBy === 'category') {
    list = [...list].sort((a, b) => (a.payload.category || '').localeCompare(b.payload.category || ''));
  } else {
    // newest first (default)
    list = [...list].sort((a, b) => (b.payload.trashed_at || '').localeCompare(a.payload.trashed_at || ''));
  }

  return list;
}

// ─── Open / Close ────────────────────────

function openTrashPanel() {
  const existing = $('trash-window');
  if (existing) { existing.style.zIndex = '301'; return; }

  trashPanelOpen   = true;
  trashSelectedId  = null;
  trashSearchTerm  = '';
  trashFilterCat   = 'all';

  const win = document.createElement('div');
  win.className = 'tw glass resizable';
  win.id        = 'trash-window';

  const saved = JSON.parse(storage.getItem('neural-panel-trash-window') || 'null');
  if (saved) {
    if (saved.left && saved.left !== 'auto') win.style.left = saved.left;
    if (saved.top)    win.style.top    = saved.top;
    if (saved.width)  win.style.width  = saved.width;
    if (saved.height) win.style.height = saved.height;
  } else {
    win.style.left = Math.max(20, (window.innerWidth  - 640) / 2) + 'px';
    win.style.top  = Math.max(20, (window.innerHeight - 480) / 2) + 'px';
  }

  win.innerHTML = `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>

    <!-- Header -->
    <div class="settings-panel-header drag-handle" data-drag="trash-window">
      <h3>Trash</h3>
      <span class="tw-count" id="tw-h-count">0</span>
      <div class="tw-header-actions">
        <button class="tw-header-btn tw-purge-btn" id="tw-purge" data-tooltip="Permanently delete all">Purge All</button>
      </div>
      <button class="settings-panel-close" id="tw-close" data-tooltip="Close">&times;</button>
    </div>

    <!-- Body: sidebar + detail -->
    <div class="tw-body">
      <aside class="tw-sidebar">
        <div class="tw-search-wrap">
          <input type="text" class="tw-search" id="tw-search" placeholder="Filter trash…" autocomplete="off" spellcheck="false">
        </div>
        <div class="tw-filters" id="tw-filters"></div>
        <div class="tw-sort" id="tw-sort-wrap">
          <select class="tw-sort-select" id="tw-sort">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="category">By category</option>
          </select>
        </div>
        <div class="tw-list" id="tw-list"></div>
      </aside>
      <main class="tw-main" id="tw-detail">
        <div class="tw-empty">Select a memory to preview</div>
      </main>
    </div>
  `;

  document.body.appendChild(win);

  // Wire close
  win.querySelector('#tw-close').addEventListener('click', closeTrashPanel);

  // Wire purge
  const purgeBtn = win.querySelector('#tw-purge');
  purgeBtn.addEventListener('click', async () => {
    if (!trashItems.length) return;
    if (!confirm(`Permanently delete all ${trashItems.length} trashed memor${trashItems.length === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;
    purgeBtn.textContent = 'Purging…';
    purgeBtn.disabled    = true;
    try {
      await purgeTrash();
      trashItems      = [];
      trashSelectedId = null;
      updateTrashBadge();
      renderTrashList();
      renderTrashDetail();
      emit('trash:updated');
    } catch (err) { console.error('Purge error:', err); }
    purgeBtn.textContent = 'Purge All';
    purgeBtn.disabled    = false;
  });

  // Wire search
  const searchInput = win.querySelector('#tw-search');
  searchInput.addEventListener('input', () => {
    trashSearchTerm = searchInput.value.toLowerCase().trim();
    renderTrashList();
  });

  // Wire sort
  const sortSelect = win.querySelector('#tw-sort');
  sortSelect.value = trashSortBy;
  sortSelect.addEventListener('change', () => {
    trashSortBy = sortSelect.value;
    renderTrashList();
  });

  // Fetch and render
  fetchTrashItems().then(() => {
    renderTrashFilters();
    renderTrashList();
  });
}

function closeTrashPanel() {
  const win = $('trash-window');
  if (win) win.remove();
  trashPanelOpen  = false;
  trashSelectedId = null;
  trashSearchTerm = '';
  trashFilterCat  = 'all';
}

// ─── Render: Filters ─────────────────────

function renderTrashFilters() {
  const container = $('tw-filters');
  if (!container) return;

  const cats = getTrashCategories();
  let html = `<button class="tw-filter${trashFilterCat === 'all' ? ' active' : ''}" data-cat="all">All</button>`;
  for (const cat of cats) {
    const active = trashFilterCat === cat ? ' active' : '';
    const count  = trashItems.filter(i => (i.payload.category || 'uncategorized') === cat).length;
    html += `<button class="tw-filter${active}" data-cat="${esc(cat)}"><span class="tw-filter-dot"></span>${esc(cat)}<span class="tw-filter-count">${count}</span></button>`;
  }
  container.innerHTML = html;

  // Wire clicks
  container.querySelectorAll('.tw-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      trashFilterCat = btn.dataset.cat;
      container.querySelectorAll('.tw-filter').forEach(b => b.classList.toggle('active', b === btn));
      renderTrashList();
    });
  });
}

// ─── Render: List ────────────────────────

function renderTrashList() {
  const win = $('trash-window');
  if (!win) return;

  const listEl   = win.querySelector('#tw-list');
  const countEl  = win.querySelector('#tw-h-count');
  const purgeBtn = win.querySelector('#tw-purge');

  // Update header count pill
  countEl.textContent    = trashItems.length;
  purgeBtn.style.display = trashItems.length ? '' : 'none';

  if (trashItems.length === 0) {
    listEl.innerHTML = '<div class="tw-empty-list">Trash is empty</div>';
    renderTrashDetail();
    return;
  }

  const filtered = getFilteredItems();

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="tw-empty-list">No matches</div>';
    renderTrashDetail();
    return;
  }

  // Group by category
  const groups = {};
  for (const item of filtered) {
    const cat = item.payload.category || 'uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }

  let html = '';
  const sortedCats = Object.keys(groups).sort();
  for (const cat of sortedCats) {
    const items = groups[cat];
    html += `<div class="tw-group">
      <div class="tw-group-header">
        <span class="tw-group-title">${esc(cat)}</span>
        <span class="tw-group-count">${items.length}</span>
      </div>`;
    for (const item of items) {
      const p       = item.payload;
      const preview = (p.content || '').replace(/\n/g, ' ').slice(0, 80);
      const age     = p.trashed_at ? formatTrashAge(p.trashed_at) : '';
      const active  = item.id === trashSelectedId ? ' active' : '';
      html += `<div class="tw-item${active}" data-id="${item.id}">
        <div class="tw-item-info">
          <div class="tw-item-preview">${esc(preview) || '<span class="tw-faint">(empty)</span>'}</div>
          ${age ? `<div class="tw-item-meta"><span class="tw-item-age">${age}</span></div>` : ''}
        </div>
      </div>`;
    }
    html += '</div>';
  }

  listEl.innerHTML = html;

  // Wire clicks
  listEl.querySelectorAll('.tw-item').forEach(el => {
    el.addEventListener('click', () => {
      trashSelectedId = el.dataset.id;
      listEl.querySelectorAll('.tw-item').forEach(i => i.classList.remove('active'));
      el.classList.add('active');
      renderTrashDetail();
    });
  });
}

// ─── Render: Detail ──────────────────────

function renderTrashDetail() {
  const win = $('trash-window');
  if (!win) return;
  const detailEl = win.querySelector('#tw-detail');
  const item     = trashItems.find(i => i.id === trashSelectedId);
  if (!item) {
    detailEl.innerHTML = '<div class="tw-empty">Select a memory to preview</div>';
    return;
  }

  const p   = item.payload;
  const age = p.trashed_at ? formatTrashAge(p.trashed_at) : '';
  const tags = (p.tags || []);
  const tagHtml = tags.map(t => `<span class="tw-badge tw-badge--tag">${esc(t)}</span>`).join('');

  detailEl.innerHTML = `
    <div class="tw-detail-header">
      <div class="tw-detail-meta-row">
        <span class="tw-badge tw-badge--cat">${esc(p.category || 'uncategorized')}</span>
        ${p.subcategory ? `<span class="tw-badge tw-badge--sub">${esc(p.subcategory)}</span>` : ''}
        ${p.project ? `<span class="tw-badge tw-badge--project">${esc(p.project)}</span>` : ''}
        ${age ? `<span class="tw-detail-age">trashed ${age}</span>` : ''}
      </div>
      <div class="tw-detail-actions">
        <button class="tw-header-btn tw-restore-btn" id="tw-restore">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 6.03A7 7 0 1 1 1.05 10"/></svg>
          Restore
        </button>
        <button class="tw-header-btn tw-delete-btn" id="tw-delete">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 3 14 13 14 13 6"/><line x1="1" y1="4" x2="15" y2="4"/><path d="M6 4V2h4v2"/><line x1="6" y1="8" x2="6" y2="11"/><line x1="10" y1="8" x2="10" y2="11"/></svg>
          Delete
        </button>
      </div>
    </div>
    ${tags.length ? `<div class="tw-detail-tags">${tagHtml}</div>` : ''}
    <div class="tw-detail-body">${formatMemoryContent(p.content || '')}</div>
    ${p.related_files?.length ? `<div class="tw-detail-files"><span class="tw-detail-files-label">Related files</span>${p.related_files.map(f => `<span class="tw-detail-file">${esc(f)}</span>`).join('')}</div>` : ''}
  `;

  // Wire restore
  detailEl.querySelector('#tw-restore').addEventListener('click', async () => {
    const btn = detailEl.querySelector('#tw-restore');
    btn.textContent = 'Restoring…';
    btn.disabled    = true;
    try {
      await restoreFromTrash(item.id);
      trashItems      = trashItems.filter(i => i.id !== item.id);
      trashSelectedId = null;
      updateTrashBadge();
      renderTrashFilters();
      renderTrashList();
      renderTrashDetail();
      emit('graph:reload');
      emit('trash:updated');
    } catch (err) { console.error('Restore error:', err); }
  });

  // Wire permanent delete
  detailEl.querySelector('#tw-delete').addEventListener('click', async () => {
    if (!confirm('Permanently delete this memory? This cannot be undone.')) return;
    const btn = detailEl.querySelector('#tw-delete');
    btn.textContent = 'Deleting…';
    btn.disabled    = true;
    try {
      await deleteMemoryPermanent(item.id);
      trashItems      = trashItems.filter(i => i.id !== item.id);
      trashSelectedId = null;
      updateTrashBadge();
      renderTrashFilters();
      renderTrashList();
      renderTrashDetail();
      emit('trash:updated');
    } catch (err) { console.error('Permanent delete error:', err); }
  });
}

// ─── Toggle (titlebar button) ────────────

function toggleTrashPanel(e) {
  if (e) e.stopPropagation();
  if (trashPanelOpen) closeTrashPanel();
  else openTrashPanel();
}

// ─── Init ────────────────────────────────

/**
 * Wire the titlebar trash button, subscribe to events, and fetch initial count.
 * Call once after DOM is ready.
 */
export function initTrash() {
  // Titlebar / menubar button
  const trashBtn = $('topright-trash-btn') || $('titlebar-trash-btn') || $('menubar-trash-btn');
  if (trashBtn) {
    trashBtn.addEventListener('click', toggleTrashPanel);
  }

  // External open request (e.g. from navbar module)
  on('trash:open', () => {
    if (!trashPanelOpen) openTrashPanel();
  });

  // Fetch initial trash count for badge
  fetchTrashItems();
}

// ─── Public API ──────────────────────────

export {
  openTrashPanel,
  closeTrashPanel,
  fetchTrashItems,
};

/**
 * Check whether the trash panel is currently open.
 * @returns {boolean}
 */
export function isTrashOpen() {
  return trashPanelOpen;
}

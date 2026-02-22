// ═══════════════════════════════════════════
// SynaBun Neural Interface — Trash Panel
// Floating window for viewing, restoring, and purging trashed memories.
// ═══════════════════════════════════════════

import { emit, on }                             from './state.js';
import { fetchTrash, restoreFromTrash, purgeTrash, deleteMemoryPermanent } from './api.js';
import { formatTrashAge, formatMemoryContent }  from './utils.js';

const $ = (id) => document.getElementById(id);

// ─── Module state ────────────────────────

let trashPanelOpen = false;
let trashItems     = [];
let trashSelectedId = null;

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
    if (trashPanelOpen) renderTrashWindow();
  } catch (err) {
    console.error('fetchTrash error:', err);
  }
}

// ─── Open / Close ────────────────────────

function openTrashPanel() {
  const existing = $('trash-window');
  if (existing) { existing.style.zIndex = '301'; return; }

  trashPanelOpen  = true;
  trashSelectedId = null;

  const win = document.createElement('div');
  win.className = 'trash-window glass resizable';
  win.id        = 'trash-window';

  const saved = JSON.parse(localStorage.getItem('neural-panel-trash-window') || 'null');
  if (saved) {
    if (saved.left && saved.left !== 'auto') win.style.left = saved.left;
    if (saved.top)    win.style.top    = saved.top;
    if (saved.width)  win.style.width  = saved.width;
    if (saved.height) win.style.height = saved.height;
  } else {
    win.style.left = Math.max(20, (window.innerWidth  - 560) / 2) + 'px';
    win.style.top  = Math.max(20, (window.innerHeight - 420) / 2) + 'px';
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
    <div class="trash-window-header drag-handle" data-drag="trash-window">
      <h3>Trash <span class="tw-h-count" id="tw-h-count"></span></h3>
      <button class="pin-btn" id="tw-pin" data-pin="trash-window" data-tooltip="Pin"><svg viewBox="0 0 24 24"><path d="M9 4v4.5L7.5 10H6v2h4v7l2 1 2-1v-7h4v-2h-1.5L15 8.5V4H9z" stroke-linejoin="round" stroke-linecap="round"/></svg></button>
      <button class="trash-window-close" id="tw-close" data-tooltip="Close">&times;</button>
    </div>
    <div class="trash-window-body">
      <div class="trash-list-pane">
        <div class="trash-list-header"><span id="tw-count">0 items</span><button class="trash-purge-btn" id="tw-purge">Purge All</button></div>
        <div class="trash-list-scroll" id="tw-list"></div>
      </div>
      <div class="trash-detail-pane" id="tw-detail">
        <div class="trash-detail-empty">Select a memory to preview</div>
      </div>
    </div>
  `;

  document.body.appendChild(win);

  // Wire close
  win.querySelector('#tw-close').addEventListener('click', closeTrashPanel);

  // Wire pin
  const pinBtn = win.querySelector('#tw-pin');
  const pinKey = 'neural-pinned-trash-window';
  if (localStorage.getItem(pinKey) === 'true') {
    win.classList.add('locked');
    pinBtn.classList.add('pinned');
  }
  pinBtn.addEventListener('click', () => {
    const isPinned = win.classList.toggle('locked');
    pinBtn.classList.toggle('pinned', isPinned);
    localStorage.setItem(pinKey, isPinned);
  });

  // Wire purge
  const purgeBtn = win.querySelector('#tw-purge');
  purgeBtn.addEventListener('click', async () => {
    if (!trashItems.length) return;
    if (!confirm(`Permanently delete all ${trashItems.length} trashed memor${trashItems.length === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;
    purgeBtn.textContent = 'Purging...';
    purgeBtn.disabled    = true;
    try {
      await purgeTrash();
      trashItems      = [];
      trashSelectedId = null;
      updateTrashBadge();
      renderTrashWindow();
      emit('trash:updated');
    } catch (err) { console.error('Purge error:', err); }
    purgeBtn.textContent = 'Purge All';
    purgeBtn.disabled    = false;
  });

  // Fetch and render
  fetchTrashItems().then(() => renderTrashWindow());
}

function closeTrashPanel() {
  const win = $('trash-window');
  if (win) win.remove();
  trashPanelOpen  = false;
  trashSelectedId = null;
}

// ─── Render ──────────────────────────────

function renderTrashWindow() {
  const win = $('trash-window');
  if (!win) return;

  const listEl   = win.querySelector('#tw-list');
  const detailEl = win.querySelector('#tw-detail');
  const countEl  = win.querySelector('#tw-count');
  const purgeBtn = win.querySelector('#tw-purge');

  countEl.textContent    = trashItems.length === 0 ? 'Empty' : `${trashItems.length} item${trashItems.length !== 1 ? 's' : ''}`;
  purgeBtn.style.display = trashItems.length ? '' : 'none';

  // Update header count
  const hCount = win.querySelector('#tw-h-count');
  if (hCount) hCount.textContent = trashItems.length ? `(${trashItems.length})` : '';

  if (trashItems.length === 0) {
    listEl.innerHTML  = '<div style="padding:20px;text-align:center;color:var(--t-muted);font-size:var(--fs-xs)">Trash is empty</div>';
    detailEl.innerHTML = '<div class="trash-detail-empty">Nothing here</div>';
    return;
  }

  // Render list
  listEl.innerHTML = trashItems.map(item => {
    const p       = item.payload;
    const preview = (p.content || '').replace(/\n/g, ' ').slice(0, 60);
    const age     = p.trashed_at ? formatTrashAge(p.trashed_at) : '';
    const active  = item.id === trashSelectedId ? ' active' : '';
    return `<div class="trash-item${active}" data-id="${item.id}">
      <div class="trash-item-content">
        <div class="trash-item-preview">${preview || '(empty)'}</div>
        <div class="trash-item-meta">${p.category || 'uncategorized'}${age ? ' \u00b7 ' + age : ''}</div>
      </div>
    </div>`;
  }).join('');

  // Bind list item clicks
  listEl.querySelectorAll('.trash-item').forEach(el => {
    el.addEventListener('click', () => {
      trashSelectedId = el.dataset.id;
      listEl.querySelectorAll('.trash-item').forEach(i => i.classList.remove('active'));
      el.classList.add('active');
      renderTrashDetail();
    });
  });

  // Render detail if something selected
  if (trashSelectedId && trashItems.find(i => i.id === trashSelectedId)) {
    renderTrashDetail();
  } else {
    detailEl.innerHTML = '<div class="trash-detail-empty">Select a memory to preview</div>';
  }
}

function renderTrashDetail() {
  const win = $('trash-window');
  if (!win) return;
  const detailEl = win.querySelector('#tw-detail');
  const item     = trashItems.find(i => i.id === trashSelectedId);
  if (!item) {
    detailEl.innerHTML = '<div class="trash-detail-empty">Select a memory to preview</div>';
    return;
  }

  const p   = item.payload;
  const age = p.trashed_at ? formatTrashAge(p.trashed_at) : '';

  detailEl.innerHTML = `
    <div class="trash-detail-header">
      <span class="trash-detail-cat">${p.category || 'uncategorized'}${age ? ' \u00b7 trashed ' + age : ''}</span>
      <div class="trash-detail-actions">
        <button class="trash-restore-btn" id="tw-restore">Restore</button>
        <button class="trash-delete-btn" id="tw-delete">Delete</button>
      </div>
    </div>
    <div class="trash-detail-body">${formatMemoryContent(p.content || '')}</div>
  `;

  // Wire restore
  detailEl.querySelector('#tw-restore').addEventListener('click', async () => {
    const btn = detailEl.querySelector('#tw-restore');
    btn.textContent = 'Restoring...';
    btn.disabled    = true;
    try {
      await restoreFromTrash(item.id);
      trashItems      = trashItems.filter(i => i.id !== item.id);
      trashSelectedId = null;
      updateTrashBadge();
      renderTrashWindow();
      // Tell the graph to reload data (memory restored back to the collection)
      emit('graph:reload');
      emit('trash:updated');
    } catch (err) { console.error('Restore error:', err); }
  });

  // Wire permanent delete
  detailEl.querySelector('#tw-delete').addEventListener('click', async () => {
    if (!confirm('Permanently delete this memory? This cannot be undone.')) return;
    const btn = detailEl.querySelector('#tw-delete');
    btn.textContent = 'Deleting...';
    btn.disabled    = true;
    try {
      await deleteMemoryPermanent(item.id);
      trashItems      = trashItems.filter(i => i.id !== item.id);
      trashSelectedId = null;
      updateTrashBadge();
      renderTrashWindow();
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
 * (Exported as a function because the boolean is module-private.)
 * @returns {boolean}
 */
export function isTrashOpen() {
  return trashPanelOpen;
}

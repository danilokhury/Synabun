// ═══════════════════════════════════════════
// SynaBun Neural Interface — Image Gallery
// Browse, filter, favorite, and manage images in data/images/.
// Draggable/resizable floating window (Session Monitor pattern).
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { fetchImages, toggleImageFavorite, deleteImage } from './api.js';
import { addImageToWhiteboard } from './ui-whiteboard.js';

const $ = (id) => document.getElementById(id);

// ── State ──
let _panel = null;
let _backdrop = null;
let _images = [];
let _filter = 'all';       // 'all' | 'screenshot' | 'attachment' | 'whiteboard' | 'paste'
let _search = '';
let _sort = 'newest';      // 'newest' | 'oldest' | 'name' | 'size'
let _favOnly = false;
let _lightboxImg = null;    // filename currently in lightbox
let isVisible = false;

// ── Drag state ──
let _dragging = false;
let _dragOff = { x: 0, y: 0 };

// ── Icons ──
const ICON_CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 019.2-4M13.5 8a5.5 5.5 0 01-9.2 4"/><path d="M11.5 2v2.5H14M4.5 14v-2.5H2"/></svg>';
const ICON_HEART = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13.7C4.3 11 2 8.7 2 6.3A3.3 3.3 0 018 4.6a3.3 3.3 0 016 1.7c0 2.4-2.3 4.7-6 7.4z"/></svg>';
const ICON_HEART_FILL = '<svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M8 13.7C4.3 11 2 8.7 2 6.3A3.3 3.3 0 018 4.6a3.3 3.3 0 016 1.7c0 2.4-2.3 4.7-6 7.4z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5 4V2.5h6V4M3.5 4v9.5a1 1 0 001 1h7a1 1 0 001-1V4"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9M5 8l3 3 3-3"/><path d="M2 12v2h12v-2"/></svg>';
const ICON_WHITEBOARD = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="13" height="12" rx="1.5"/><path d="M4 7h8M4 10h5"/></svg>';
const ICON_GALLERY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><circle cx="5.5" cy="6.5" r="1.5"/><path d="M1.5 11l3.5-3.5 2.5 2.5 2-1.5L14.5 13"/></svg>';

const TYPE_LABELS = {
  all: 'All',
  screenshot: 'Screenshots',
  attachment: 'Attachments',
  whiteboard: 'Whiteboard',
  paste: 'Pastes',
};

// ── Helpers ──

function filtered() {
  let list = _images;
  if (_filter !== 'all') list = list.filter(i => i.type === _filter);
  if (_favOnly) list = list.filter(i => i.favorite);
  if (_search) {
    const q = _search.toLowerCase();
    list = list.filter(i => i.filename.toLowerCase().includes(q));
  }
  switch (_sort) {
    case 'oldest': list = [...list].sort((a, b) => a.modifiedAt - b.modifiedAt); break;
    case 'name': list = [...list].sort((a, b) => a.filename.localeCompare(b.filename)); break;
    case 'size': list = [...list].sort((a, b) => b.size - a.size); break;
    default: list = [...list].sort((a, b) => b.modifiedAt - a.modifiedAt); break;
  }
  return list;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return d.toLocaleDateString();
}

function imageUrl(filename) {
  return `/api/images/file/${encodeURIComponent(filename)}`;
}

// ── Build HTML ──

function buildPanelHTML() {
  const list = filtered();
  const counts = { all: _images.length };
  for (const img of _images) counts[img.type] = (counts[img.type] || 0) + 1;

  return `
    <div class="ig-header" id="ig-header">
      <div class="ig-header-left">
        <span class="ig-icon">${ICON_GALLERY}</span>
        <span class="ig-title">Image Gallery</span>
        <span class="ig-count">${list.length}${list.length !== _images.length ? ' / ' + _images.length : ''}</span>
      </div>
      <div class="ig-header-right">
        <button class="ig-btn" id="ig-refresh" data-tooltip="Refresh">${ICON_REFRESH}</button>
        <button class="ig-btn" id="ig-close" data-tooltip="Close">${ICON_CLOSE}</button>
      </div>
    </div>

    <div class="ig-toolbar">
      <input type="text" class="ig-search" id="ig-search" placeholder="Search images..." data-tooltip="Search by filename">
      <select class="ig-filter" id="ig-filter" data-tooltip="Filter by type">
        ${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}"${_filter === k ? ' selected' : ''}>${v}${counts[k] ? ' (' + counts[k] + ')' : ''}</option>`).join('')}
      </select>
      <select class="ig-sort" id="ig-sort" data-tooltip="Sort order">
        <option value="newest"${_sort === 'newest' ? ' selected' : ''}>Newest</option>
        <option value="oldest"${_sort === 'oldest' ? ' selected' : ''}>Oldest</option>
        <option value="name"${_sort === 'name' ? ' selected' : ''}>Name</option>
        <option value="size"${_sort === 'size' ? ' selected' : ''}>Size</option>
      </select>
      <button class="ig-btn ig-fav-toggle${_favOnly ? ' active' : ''}" id="ig-fav-toggle" data-tooltip="Favorites only">${ICON_HEART}</button>
    </div>

    <div class="ig-body" id="ig-body">
      ${list.length === 0
        ? `<div class="ig-empty">${_images.length === 0 ? 'No images yet' : 'No matches'}</div>`
        : `<div class="ig-grid">${list.map(img => buildCard(img)).join('')}</div>`
      }
    </div>
  `;
}

function buildCard(img) {
  return `
    <div class="ig-card" data-filename="${img.filename}">
      <div class="ig-thumb-wrap">
        <img class="ig-thumb" src="${imageUrl(img.filename)}" loading="lazy" alt="${img.filename}">
        <div class="ig-card-actions">
          <button class="ig-card-btn ig-card-fav${img.favorite ? ' active' : ''}" data-action="fav" data-tooltip="${img.favorite ? 'Unfavorite' : 'Favorite'}">${img.favorite ? ICON_HEART_FILL : ICON_HEART}</button>
          <button class="ig-card-btn ig-card-wb" data-action="whiteboard" data-tooltip="Add to Whiteboard">${ICON_WHITEBOARD}</button>
          <button class="ig-card-btn ig-card-dl" data-action="download" data-tooltip="Download">${ICON_DOWNLOAD}</button>
          <button class="ig-card-btn ig-card-del" data-action="delete" data-tooltip="Delete">${ICON_TRASH}</button>
        </div>
      </div>
      <div class="ig-card-info">
        <span class="ig-card-name">${img.filename.length > 30 ? img.filename.slice(0, 27) + '...' : img.filename}</span>
        <span class="ig-card-meta">${formatSize(img.size)} · ${formatDate(img.modifiedAt)}</span>
      </div>
    </div>`;
}

// ── Lightbox ──

function openLightbox(filename) {
  _lightboxImg = filename;
  let lb = document.getElementById('ig-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'ig-lightbox';
    lb.className = 'ig-lightbox';
    document.body.appendChild(lb);
  }
  const img = _images.find(i => i.filename === filename);
  lb.innerHTML = `
    <div class="ig-lb-overlay" id="ig-lb-overlay"></div>
    <div class="ig-lb-content">
      <img class="ig-lb-img" src="${imageUrl(filename)}" alt="${filename}">
      <div class="ig-lb-bar">
        <span class="ig-lb-name">${filename}</span>
        ${img ? `<span class="ig-lb-size">${formatSize(img.size)}</span>` : ''}
        <div class="ig-lb-actions">
          <button class="ig-btn" id="ig-lb-fav" data-tooltip="Toggle favorite">${img?.favorite ? ICON_HEART_FILL : ICON_HEART}</button>
          <button class="ig-btn" id="ig-lb-wb" data-tooltip="Add to Whiteboard">${ICON_WHITEBOARD}</button>
          <button class="ig-btn" id="ig-lb-dl" data-tooltip="Download">${ICON_DOWNLOAD}</button>
          <button class="ig-btn" id="ig-lb-del" data-tooltip="Delete">${ICON_TRASH}</button>
          <button class="ig-btn" id="ig-lb-close" data-tooltip="Close">${ICON_CLOSE}</button>
        </div>
      </div>
      <button class="ig-lb-nav ig-lb-prev" id="ig-lb-prev">&#8249;</button>
      <button class="ig-lb-nav ig-lb-next" id="ig-lb-next">&#8250;</button>
    </div>
  `;
  lb.classList.add('open');
  wireLightbox();
}

function closeLightbox() {
  _lightboxImg = null;
  const lb = document.getElementById('ig-lightbox');
  if (lb) { lb.classList.remove('open'); lb.innerHTML = ''; }
}

function navigateLightbox(dir) {
  const list = filtered();
  const idx = list.findIndex(i => i.filename === _lightboxImg);
  if (idx === -1) return;
  const next = idx + dir;
  if (next >= 0 && next < list.length) openLightbox(list[next].filename);
}

function wireLightbox() {
  const lb = document.getElementById('ig-lightbox');
  if (!lb) return;

  lb.querySelector('#ig-lb-overlay')?.addEventListener('click', closeLightbox);
  lb.querySelector('#ig-lb-close')?.addEventListener('click', closeLightbox);
  lb.querySelector('#ig-lb-prev')?.addEventListener('click', () => navigateLightbox(-1));
  lb.querySelector('#ig-lb-next')?.addEventListener('click', () => navigateLightbox(1));

  lb.querySelector('#ig-lb-fav')?.addEventListener('click', async () => {
    const img = _images.find(i => i.filename === _lightboxImg);
    if (!img) return;
    await toggleImageFavorite(img.filename, !img.favorite);
    img.favorite = !img.favorite;
    render();
    openLightbox(img.filename);
  });

  lb.querySelector('#ig-lb-wb')?.addEventListener('click', () => {
    if (_lightboxImg) {
      addImageToWhiteboard(imageUrl(_lightboxImg));
      closeLightbox();
      closePanel();
    }
  });

  lb.querySelector('#ig-lb-dl')?.addEventListener('click', () => {
    if (_lightboxImg) downloadImage(_lightboxImg);
  });

  lb.querySelector('#ig-lb-del')?.addEventListener('click', async () => {
    if (!_lightboxImg) return;
    if (!confirm(`Delete ${_lightboxImg}?`)) return;
    await deleteImage(_lightboxImg);
    _images = _images.filter(i => i.filename !== _lightboxImg);
    closeLightbox();
    render();
  });
}

// ── Actions ──

function downloadImage(filename) {
  const a = document.createElement('a');
  a.href = imageUrl(filename);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function refreshImages() {
  try {
    const data = await fetchImages();
    _images = data.images || [];
    render();
  } catch (err) {
    console.error('[image-gallery] refresh failed:', err);
  }
}

// ── Render ──

function render() {
  if (!_panel) return;
  const body = _panel.querySelector('#ig-body');
  const countEl = _panel.querySelector('.ig-count');
  const list = filtered();

  if (countEl) {
    countEl.textContent = list.length + (list.length !== _images.length ? ' / ' + _images.length : '');
  }

  if (!body) return;

  if (list.length === 0) {
    body.innerHTML = `<div class="ig-empty">${_images.length === 0 ? 'No images yet' : 'No matches'}</div>`;
    return;
  }

  body.innerHTML = `<div class="ig-grid">${list.map(img => buildCard(img)).join('')}</div>`;
}

// ── Panel lifecycle ──

function wirePanel() {
  _panel.querySelector('#ig-close')?.addEventListener('click', closePanel);
  _panel.querySelector('#ig-refresh')?.addEventListener('click', refreshImages);

  // Search
  const searchInput = _panel.querySelector('#ig-search');
  if (searchInput) {
    let debounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { _search = searchInput.value; render(); }, 200);
    });
  }

  // Filter
  _panel.querySelector('#ig-filter')?.addEventListener('change', (e) => {
    _filter = e.target.value;
    render();
  });

  // Sort
  _panel.querySelector('#ig-sort')?.addEventListener('change', (e) => {
    _sort = e.target.value;
    render();
  });

  // Favorites toggle
  _panel.querySelector('#ig-fav-toggle')?.addEventListener('click', (e) => {
    _favOnly = !_favOnly;
    e.currentTarget.classList.toggle('active', _favOnly);
    render();
  });

  // Grid clicks (delegate)
  _panel.querySelector('#ig-body')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    const card = e.target.closest('.ig-card');
    if (!card) return;

    const filename = card.dataset.filename;
    if (!filename) return;

    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'fav') {
        const img = _images.find(i => i.filename === filename);
        if (!img) return;
        await toggleImageFavorite(filename, !img.favorite);
        img.favorite = !img.favorite;
        render();
      } else if (action === 'whiteboard') {
        addImageToWhiteboard(imageUrl(filename));
        closePanel();
      } else if (action === 'download') {
        downloadImage(filename);
      } else if (action === 'delete') {
        if (!confirm(`Delete ${filename}?`)) return;
        await deleteImage(filename);
        _images = _images.filter(i => i.filename !== filename);
        render();
      }
    } else {
      openLightbox(filename);
    }
  });

  // Drag
  const header = _panel.querySelector('#ig-header');
  if (header) {
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      _dragging = true;
      _panel.classList.add('dragging');
      const rect = _panel.getBoundingClientRect();
      _dragOff = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      e.preventDefault();
    });
  }

  // Keyboard in lightbox
  document.addEventListener('keydown', handleKey);
}

function handleKey(e) {
  if (!_lightboxImg) return;
  if (e.key === 'Escape') { closeLightbox(); e.stopPropagation(); }
  else if (e.key === 'ArrowLeft') navigateLightbox(-1);
  else if (e.key === 'ArrowRight') navigateLightbox(1);
}

function openPanel() {
  if (_panel) { _panel.focus(); return; }

  _backdrop = document.createElement('div');
  _backdrop.className = 'ig-backdrop';
  _backdrop.addEventListener('click', closePanel);
  document.body.appendChild(_backdrop);

  _panel = document.createElement('div');
  _panel.className = 'image-gallery-panel glass resizable';
  _panel.id = 'image-gallery-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  _panel.style.left = Math.max(20, (window.innerWidth - 780) / 2) + 'px';
  _panel.style.top = Math.max(48, (window.innerHeight - 560) / 2) + 'px';

  wirePanel();
  isVisible = true;
  refreshImages();

  // Global mouse handlers for drag
  const onMouseMove = (e) => {
    if (!_dragging) return;
    _panel.style.left = (e.clientX - _dragOff.x) + 'px';
    _panel.style.top = (e.clientY - _dragOff.y) + 'px';
  };
  const onMouseUp = () => {
    _dragging = false;
    if (_panel) _panel.classList.remove('dragging');
  };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Store cleanup ref
  _panel._cleanup = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', handleKey);
  };

  requestAnimationFrame(() => {
    _backdrop.classList.add('open');
    _panel.classList.add('open');
  });
}

function closePanel() {
  if (!_panel) return;
  closeLightbox();
  if (_panel._cleanup) _panel._cleanup();
  if (_backdrop) { _backdrop.remove(); _backdrop = null; }
  _panel.remove();
  _panel = null;
  isVisible = false;
  _search = '';
  _filter = 'all';
  _sort = 'newest';
  _favOnly = false;
  emit('image-gallery:closed');
}

// ── Exports ──

export function toggleImageGallery() {
  if (_panel) closePanel();
  else openPanel();
}

export function initImageGallery() {
  // Nothing needed at init — panel is created on toggle
}

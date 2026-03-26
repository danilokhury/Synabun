// ═══════════════════════════════════════════
// UI-WHITEBOARD — Focus Mode whiteboard
// ═══════════════════════════════════════════
//
// A simple fixed-area whiteboard that activates inside Focus mode.
// Features: text cards (Caveat font), geometric shapes (rect, circle,
// rounded-rect), curvy SVG arrows with anchoring, image paste with
// rounded borders, undo/redo, and full workspace persistence.

import { state, emit, on } from './state.js';
import { KEYS } from './constants.js';
import { storage } from './storage.js';
import { isGuest, hasPermission } from './ui-sync.js';

// ── Helpers ──

const $ = (id) => document.getElementById(id);
const _genId = () => 'wb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);

// ── Internal state ──

let _elements = [];      // Array<{id, type, x, y, width, height, ...}>
let _nextZIndex = 1;
let _activeTool = 'select';   // 'select' | 'text' | 'arrow' | 'shape' | 'pen'
let _selectedId = null;        // Primary selected element (for context menu, editing)
let _selectedIds = new Set();  // All selected element IDs (multi-select)
let _undoStack = [];     // Array<{action, before, after}>
let _redoStack = [];
let _clipboard = null;   // Serialized element for copy/paste

// Drag state
let _drag = null;        // { type, id, startX, startY, origX, origY, ... }

// Marquee (rubber band) selection state
let _marquee = null;     // { startX, startY, rect: DOMElement } while dragging
let _multiSelectMode = false;  // Toggled via toolbar button

// Pen drawing state
let _penPoints = null;   // Array<[x,y]> while drawing, null when idle
let _penLiveEl = null;   // Temp SVG path for live preview
let _arrowCreating = null; // { points: [[x,y],...], startAnchor } — multi-point arrow in progress
let _sectionCreating = null; // { id, originX, originY, sectionType } — drag-to-create section
let _activeSectionType = 'content'; // default section type for new placements
let _shapeCreating = null; // { id, originX, originY } — drag-to-create shape
let _activeShapeType = 'rect'; // default shape type for new placements

// Tool lock (Ctrl-hold keeps tool active)
let _toolLocked = false;

// Active drawing color
let _activeColor = 'rgba(255,255,255,0.85)';
const WB_COLORS = [
  'rgba(255,255,255,0.85)',   // white
  '#ef4444',                   // red
  '#f97316',                   // orange
  '#eab308',                   // yellow
  '#22c55e',                   // green
  '#3b82f6',                   // blue
  '#a855f7',                   // purple
  '#ec4899',                   // pink
  '#06b6d4',                   // cyan
  'rgba(255,255,255,0.3)',     // dim
];

const SECTION_TYPES = {
  navbar:              { label: 'Navbar',       w: 960, h: 56,  color: '#64748b', icon: '\u2261' },
  hero:                { label: 'Hero',         w: 960, h: 340, color: '#6366f1', icon: '\u2606' },
  sidebar:             { label: 'Sidebar',      w: 260, h: 400, color: '#475569', icon: '\u229e' },
  content:             { label: 'Content',      w: 640, h: 360, color: '#737373', icon: '\u00b6' },
  footer:              { label: 'Footer',       w: 960, h: 100, color: '#6b7280', icon: '\u2500' },
  card:                { label: 'Card',         w: 260, h: 180, color: '#14b8a6', icon: '\u25a1' },
  form:                { label: 'Form',         w: 380, h: 280, color: '#f59e0b', icon: '\u2610' },
  'image-placeholder': { label: 'Image',        w: 280, h: 180, color: '#a855f7', icon: '\u229e' },
  button:              { label: 'Button',       w: 140, h: 42,  color: '#22c55e', icon: '\u25b8' },
  'text-block':        { label: 'Text Block',   w: 380, h: 90,  color: '#e2e8f0', icon: 'T' },
  grid:                { label: 'Grid',         w: 640, h: 320, color: '#06b6d4', icon: '\u229e\u229e' },
  modal:               { label: 'Modal',        w: 440, h: 300, color: '#f43f5e', icon: '\u25fb' },
};

// Persist debounce + cross-client sync
let _persistTimer = null;
let _isRemoteUpdate = false; // Suppress WS echo when receiving remote state
const PERSIST_DELAY = 600;
const MAX_UNDO = 50;
const SNAP_DIST = 30;    // px for arrow anchor snapping
const MAX_IMAGE_DIM = 1920;

/** Cross-browser clipboard write with fallback for non-secure contexts. */
function _clipboardWrite(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => _clipboardFallback(text));
  } else {
    _clipboardFallback(text);
  }
}
function _clipboardFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}

/** Snap a value to grid if grid snapping is enabled. */
function _snap(v) {
  if (!state.gridSnap) return v;
  const gs = state.gridSize || 20;
  return Math.round(v / gs) * gs;
}
const IMAGE_QUALITY = 0.8;

// DOM refs (set in init)
let _root, _toolbar, _canvas, _arrowsSvg, _elementsDiv, _arrowPreview, _arrowHint;


// ═══════════════════════════════════════════
// COORDINATE TRANSFORMS
// ═══════════════════════════════════════════

function clientToCanvas(clientX, clientY) {
  const rect = _root.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}


// ═══════════════════════════════════════════
// UNDO / REDO
// ═══════════════════════════════════════════

function pushUndo(action, before, after) {
  _undoStack.push({ action, before, after });
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  _redoStack = [];
  updateUndoButtons();
}

function undo() {
  if (!_undoStack.length) return;
  const entry = _undoStack.pop();
  _redoStack.push(entry);

  if (entry.action === 'add') {
    _elements = _elements.filter(el => el.id !== entry.after.id);
  } else if (entry.action === 'delete') {
    _elements.push({ ...entry.before });
  } else if (entry.action === 'delete-multi') {
    // Restore all deleted elements
    for (const el of entry.before) _elements.push({ ...el });
  } else if (entry.action === 'move-multi') {
    // Restore all elements to their original positions
    for (const snap of entry.before) {
      const idx = _elements.findIndex(el => el.id === snap.id);
      if (idx >= 0) _elements[idx] = { ...snap, points: snap.points ? snap.points.map(p => [...p]) : undefined };
    }
  } else if (entry.action === 'move' || entry.action === 'resize' || entry.action === 'edit') {
    const idx = _elements.findIndex(el => el.id === entry.before.id);
    if (idx >= 0) _elements[idx] = { ...entry.before };
  }

  _selectedId = null;
  _selectedIds.clear();
  renderAll();
  persistDebounced();
  updateUndoButtons();
}

function redo() {
  if (!_redoStack.length) return;
  const entry = _redoStack.pop();
  _undoStack.push(entry);

  if (entry.action === 'add') {
    _elements.push({ ...entry.after });
  } else if (entry.action === 'delete') {
    _elements = _elements.filter(el => el.id !== entry.before.id);
  } else if (entry.action === 'delete-multi') {
    // Re-delete all elements
    const ids = new Set(entry.before.map(el => el.id));
    _elements = _elements.filter(el => !ids.has(el.id));
  } else if (entry.action === 'move-multi') {
    // Apply the after positions
    for (const snap of entry.after) {
      const idx = _elements.findIndex(el => el.id === snap.id);
      if (idx >= 0) _elements[idx] = { ...snap, points: snap.points ? snap.points.map(p => [...p]) : undefined };
      else _elements.push({ ...snap });
    }
  } else if (entry.action === 'move' || entry.action === 'resize' || entry.action === 'edit') {
    const idx = _elements.findIndex(el => el.id === entry.after.id);
    if (idx >= 0) _elements[idx] = { ...entry.after };
    else _elements.push({ ...entry.after });
  }

  _selectedId = null;
  _selectedIds.clear();
  renderAll();
  persistDebounced();
  updateUndoButtons();
}

function updateUndoButtons() {
  const undoBtn = $('wb-undo');
  const redoBtn = $('wb-redo');
  if (undoBtn) undoBtn.classList.toggle('disabled', !_undoStack.length);
  if (redoBtn) redoBtn.classList.toggle('disabled', !_redoStack.length);
}


// ═══════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════

function persistDebounced() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    const snapshot = { elements: _elements, nextZIndex: _nextZIndex };
    storage.setItem(KEYS.WHITEBOARD, JSON.stringify(snapshot));
    // Send to server for cross-client sync (skip if remote update or guest without whiteboard perm)
    if (_ws && _ws.readyState === 1 && !_isRemoteUpdate && !(isGuest() && !hasPermission('whiteboard'))) {
      _ws.send(JSON.stringify({ type: 'state:sync', snapshot }));
    }
  }, PERSIST_DELAY);
}

function loadPersisted() {
  try {
    const raw = storage.getItem(KEYS.WHITEBOARD);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.elements)) _elements = data.elements;
    if (data.nextZIndex) _nextZIndex = data.nextZIndex;
  } catch { /* ignore corrupt data */ }
}


// ═══════════════════════════════════════════
// ARROW MATH
// ═══════════════════════════════════════════

function computeArrowPath(pts) {
  if (!pts || pts.length < 2) return '';
  return pointsToSmoothPath(pts);
}

/** Shorten a points array by pulling the last point back toward the previous one. */
function shortenPoints(pts, amount) {
  if (pts.length < 2) return pts;
  const result = pts.map(p => [...p]);
  const last = result[result.length - 1];
  const prev = result[result.length - 2];
  const dx = last[0] - prev[0];
  const dy = last[1] - prev[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < amount * 2) return result;
  const ratio = (dist - amount) / dist;
  result[result.length - 1] = [
    prev[0] + dx * ratio,
    prev[1] + dy * ratio,
  ];
  return result;
}

/** Get arrow endpoint from an anchored element. Returns edge intersection point. */
function getAnchorPoint(anchorId, fromX, fromY) {
  const el = _elements.find(e => e.id === anchorId);
  if (!el || el.type === 'arrow') return null;
  const cx = el.x + (el.width || 100) / 2;
  const cy = el.y + (el.height || 60) / 2;
  const hw = (el.width || 100) / 2;
  const hh = (el.height || 60) / 2;

  const dx = fromX - cx;
  const dy = fromY - cy;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return { x: cx, y: cy - hh };

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  let scale;
  if (absDx / hw > absDy / hh) {
    scale = hw / absDx;
  } else {
    scale = hh / absDy;
  }
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** Find the nearest element edge center within SNAP_DIST of (cx, cy). */
function findNearestAnchor(cx, cy, excludeId) {
  let best = null;
  let bestDist = SNAP_DIST;
  for (const el of _elements) {
    if (el.type === 'arrow' || el.id === excludeId) continue;
    const ecx = el.x + (el.width || 100) / 2;
    const ecy = el.y + (el.height || 60) / 2;
    const d = Math.sqrt((cx - ecx) ** 2 + (cy - ecy) ** 2);
    if (d < bestDist) {
      bestDist = d;
      best = el.id;
    }
  }
  return best;
}


// ═══════════════════════════════════════════
// IMAGE COMPRESSION
// ═══════════════════════════════════════════

function compressImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width;
      let h = img.height;
      if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
        const ratio = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: c.toDataURL('image/jpeg', IMAGE_QUALITY), width: w, height: h });
    };
    img.onerror = reject;
    img.src = url;
  });
}


// ═══════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════

function renderAll() {
  renderElements();
  renderArrows();
  // Reposition context menu if element(s) selected
  if (_ctxMenu && _selectedIds.size > 0) {
    if (_selectedIds.size === 1) {
      const el = _elements.find(e => e.id === _selectedId);
      if (el) positionContextMenu(el);
    } else {
      positionContextMenuMulti();
    }
  }
}

function renderElements() {
  if (!_elementsDiv) return;
  const existing = new Map();
  for (const child of [..._elementsDiv.children]) {
    existing.set(child.dataset.wbId, child);
  }

  const activeIds = new Set();
  for (const el of _elements) {
    if (el.type === 'arrow' || el.type === 'pen') continue;
    activeIds.add(el.id);
    let dom = existing.get(el.id);
    if (!dom) {
      dom = createElementDOM(el);
      _elementsDiv.appendChild(dom);
    }
    updateElementDOM(dom, el);
  }

  // Remove orphans
  for (const [id, dom] of existing) {
    if (!activeIds.has(id)) dom.remove();
  }
}

function createElementDOM(el) {
  const div = document.createElement('div');
  div.dataset.wbId = el.id;

  if (el.type === 'text') {
    div.className = 'wb-text';
    div.innerHTML = `<div class="wb-text-content" contenteditable="false"></div><div class="wb-resize-handle"></div>`;
  } else if (el.type === 'list') {
    div.className = 'wb-list';
    div.innerHTML = `<ul></ul><div class="wb-resize-handle"></div>`;
  } else if (el.type === 'shape') {
    div.className = 'wb-shape';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('wb-shape-border');
    div.appendChild(svg);
    const handle = document.createElement('div');
    handle.className = 'wb-resize-handle';
    div.appendChild(handle);
  } else if (el.type === 'image') {
    div.className = 'wb-image';
    div.innerHTML = `<img src="" alt=""><span class="wb-copy-path" data-tooltip="Copy image path"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span><div class="wb-resize-handle"></div>`;
    // Wire click-to-copy-path
    const copyBtn = div.querySelector('.wb-copy-path');
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!_ws || _ws.readyState !== WebSocket.OPEN) {
        copyBtn.dataset.tooltip = 'Not connected';
        setTimeout(() => { copyBtn.dataset.tooltip = 'Copy image path'; }, 1500);
        return;
      }
      if (!el.dataUrl) return;
      const match = el.dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) return;
      const handler = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'image_saved' && msg.path) {
            _ws.removeEventListener('message', handler);
            _clipboardWrite(msg.path);
            copyBtn.dataset.tooltip = 'Copied!';
            copyBtn.classList.add('wb-copied');
            setTimeout(() => {
              copyBtn.dataset.tooltip = 'Copy image path';
              copyBtn.classList.remove('wb-copied');
            }, 1500);
          }
        } catch {}
      };
      _ws.addEventListener('message', handler);
      setTimeout(() => _ws.removeEventListener('message', handler), 5000);
      _ws.send(JSON.stringify({ type: 'image_save', data: match[2], mimeType: match[1] }));
    });
  } else if (el.type === 'section') {
    div.className = 'wb-section';
    div.innerHTML = `<div class="wb-section-type-icon"></div><div class="wb-section-label" contenteditable="false"></div><div class="wb-resize-handle"></div>`;
  }
  return div;
}

function updateElementDOM(dom, el) {
  dom.style.left = el.x + 'px';
  dom.style.top = el.y + 'px';
  // Text and list cards auto-size from content; other elements use explicit dimensions
  if (el.type === 'text' || el.type === 'list') {
    dom.style.width = '';
    dom.style.height = 'auto';
  } else {
    if (el.width) dom.style.width = el.width + 'px';
    if (el.height) dom.style.height = el.height + 'px';
  }
  dom.style.zIndex = el.zIndex || 0;
  dom.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : '';
  dom.classList.toggle('selected', _selectedIds.has(el.id));

  if (el.type === 'text') {
    const content = dom.querySelector('.wb-text-content');
    if (content && !content.matches(':focus')) {
      content.innerText = el.content || '';
    }
    if (el.fontSize) dom.style.fontSize = el.fontSize + 'px';
    dom.style.fontWeight = el.bold ? '700' : '400';
    dom.style.fontStyle = el.italic ? 'italic' : 'normal';
    if (el.color) dom.style.color = el.color;
  } else if (el.type === 'list') {
    const ul = dom.querySelector('ul');
    if (ul && !dom.classList.contains('editing')) {
      const items = el.items && el.items.length ? el.items : [''];
      ul.innerHTML = items.map(item =>
        `<li>${item.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</li>`
      ).join('');
    }
    if (el.fontSize) dom.style.fontSize = el.fontSize + 'px';
    if (el.color) dom.style.color = el.color;
  } else if (el.type === 'shape') {
    const shape = el.shape || 'rect';
    dom.dataset.shape = shape;
    dom.style.borderRadius = '0';
    const svg = dom.querySelector('.wb-shape-border');
    if (svg) {
      const w = el.width || 160, h = el.height || 100;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      const sc = el.color || 'rgba(255,255,255,0.8)';
      if (shape === 'drawn-circle') {
        svg.innerHTML = `<path d="${generateDrawnCirclePath(w, h, el.id)}" fill="none" stroke="${sc}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
      } else {
        svg.innerHTML = `<path d="${generateHandDrawnShape(shape, w, h, el.id)}" fill="none" stroke="${sc}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    }
  } else if (el.type === 'image') {
    const img = dom.querySelector('img');
    if (img && img.src !== el.dataUrl) img.src = el.dataUrl;
  } else if (el.type === 'section') {
    const def = SECTION_TYPES[el.sectionType] || SECTION_TYPES.content;
    const color = el.color || def.color;
    dom.style.borderColor = color;
    dom.style.background = color + '0d';
    const iconEl = dom.querySelector('.wb-section-type-icon');
    if (iconEl) {
      iconEl.textContent = def.icon;
      iconEl.style.color = color;
    }
    const labelEl = dom.querySelector('.wb-section-label');
    if (labelEl && !labelEl.matches(':focus')) {
      labelEl.textContent = el.label || def.label;
      labelEl.style.color = color;
    }
  }
}

function renderArrows() {
  if (!_arrowsSvg) return;
  const defs = _arrowsSvg.querySelector('defs');
  _arrowsSvg.innerHTML = '';
  if (defs) _arrowsSvg.appendChild(defs);

  for (const el of _elements) {
    // ── Arrows ──
    if (el.type === 'arrow') {
      const pts = (el.points || []).map(p => [...p]);
      if (pts.length < 2) continue;

      // Apply anchor offsets to first/last points
      if (el.startAnchor) {
        const pt = getAnchorPoint(el.startAnchor, pts[1][0], pts[1][1]);
        if (pt) { pts[0] = [pt.x, pt.y]; }
      }
      if (el.endAnchor) {
        const pt = getAnchorPoint(el.endAnchor, pts[pts.length - 2][0], pts[pts.length - 2][1]);
        if (pt) { pts[pts.length - 1] = [pt.x, pt.y]; }
      }

      const isSel = _selectedIds.has(el.id);
      const d = computeArrowPath(pts);

      // Invisible wide hit target (20px)
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('fill', 'none');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '20');
      hit.dataset.wbId = el.id;
      _arrowsSvg.appendChild(hit);

      // Visible arrow with marker — butt linecap so stroke ends flush at endpoint
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', isSel ? 'var(--accent-blue, #60a5fa)' : 'rgba(255,255,255,0.8)');
      path.setAttribute('stroke-width', isSel ? '3' : '2');
      path.setAttribute('stroke-linecap', 'butt');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('marker-end', isSel ? 'url(#wb-arrowhead-sel)' : 'url(#wb-arrowhead)');
      path.dataset.wbId = el.id;
      path.style.pointerEvents = 'none';
      if (isSel) path.classList.add('selected');
      _arrowsSvg.appendChild(path);
      continue;
    }

    // ── Pen strokes ──
    if (el.type === 'pen') {
      const isSel = _selectedIds.has(el.id);
      const pathD = el.pathD || pointsToSmoothPath(el.points || []);

      // Invisible wide hit target (16px)
      const penHit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      penHit.setAttribute('d', pathD);
      penHit.setAttribute('fill', 'none');
      penHit.setAttribute('stroke', 'transparent');
      penHit.setAttribute('stroke-width', '16');
      penHit.dataset.wbId = el.id;
      _arrowsSvg.appendChild(penHit);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathD);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', isSel ? 'var(--accent-blue, #60a5fa)' : (el.color || 'rgba(255,255,255,0.8)'));
      path.setAttribute('stroke-width', isSel ? '5' : (el.strokeWidth || 3));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.dataset.wbId = el.id;
      path.style.pointerEvents = 'none';
      if (isSel) path.classList.add('selected');
      _arrowsSvg.appendChild(path);
    }
  }
}


// ═══════════════════════════════════════════
// ELEMENT CRUD
// ═══════════════════════════════════════════

function addElement(el, { skipPersist = false } = {}) {
  el.zIndex = _nextZIndex++;
  _elements.push(el);
  pushUndo('add', null, { ...el });
  renderAll();
  if (!skipPersist) persistDebounced();
  return el;
}

function deleteElement(id) {
  const idx = _elements.findIndex(e => e.id === id);
  if (idx < 0) return;
  const el = { ..._elements[idx] };
  _elements.splice(idx, 1);

  // Detach arrows anchored to deleted element
  const cx = el.x + (el.width || 100) / 2;
  const cy = el.y + (el.height || 60) / 2;
  for (const a of _elements) {
    if (a.type !== 'arrow' || !a.points) continue;
    if (a.startAnchor === id) {
      a.points[0] = [cx, cy]; a.startAnchor = null;
    }
    if (a.endAnchor === id) {
      a.points[a.points.length - 1] = [cx, cy]; a.endAnchor = null;
    }
  }

  pushUndo('delete', el, null);
  _selectedIds.delete(id);
  if (_selectedId === id) _selectedId = null;
  hideContextMenu();
  renderAll();
  persistDebounced();
}


function deleteMultipleElements(ids) {
  const deleted = [];
  for (const id of ids) {
    const idx = _elements.findIndex(e => e.id === id);
    if (idx < 0) continue;
    const el = { ..._elements[idx] };
    _elements.splice(idx, 1);
    // Detach arrows anchored to this element
    const cx = el.x + (el.width || 100) / 2;
    const cy = el.y + (el.height || 60) / 2;
    for (const a of _elements) {
      if (a.type !== 'arrow' || !a.points) continue;
      if (a.startAnchor === id) { a.points[0] = [cx, cy]; a.startAnchor = null; }
      if (a.endAnchor === id) { a.points[a.points.length - 1] = [cx, cy]; a.endAnchor = null; }
    }
    deleted.push(el);
  }
  if (deleted.length) {
    pushUndo('delete-multi', deleted, null);
    _selectedId = null;
    _selectedIds.clear();
    hideContextMenu();
    renderAll();
    persistDebounced();
  }
}

function duplicateMultipleElements(ids) {
  const newIds = [];
  for (const id of ids) {
    const src = _elements.find(e => e.id === id);
    if (!src) continue;
    const clone = { ...src, id: _genId() };
    if (clone.x != null) clone.x += 20;
    if (clone.y != null) clone.y += 20;
    if (clone.points) clone.points = clone.points.map(([px, py]) => [px + 20, py + 20]);
    delete clone.zIndex;
    clone.startAnchor = null;
    clone.endAnchor = null;
    if (clone.points) clone.pathD = pointsToSmoothPath(clone.points);
    clone.zIndex = _nextZIndex++;
    _elements.push(clone);
    pushUndo('add', null, { ...clone });
    newIds.push(clone.id);
  }
  selectMultiple(newIds);
  persistDebounced();
}


// ═══════════════════════════════════════════
// SELECTION + CONTEXT MENU
// ═══════════════════════════════════════════

let _ctxMenu = null;   // Floating context menu element
let _rotateEl = null;  // Floating rotation handle element
let _moveEl = null;    // Floating move handle element (text/list)

function selectElement(id, { additive = false } = {}) {
  if (additive) {
    // Shift-click: toggle in/out of selection
    if (_selectedIds.has(id)) {
      _selectedIds.delete(id);
      if (_selectedId === id) _selectedId = _selectedIds.size ? [..._selectedIds][0] : null;
    } else {
      _selectedIds.add(id);
      _selectedId = id;
      const el = _elements.find(e => e.id === id);
      if (el && el.type !== 'arrow' && el.type !== 'pen') el.zIndex = _nextZIndex++;
    }
  } else {
    // Normal click: single select (replaces selection)
    _selectedIds.clear();
    _selectedIds.add(id);
    _selectedId = id;
    const el = _elements.find(e => e.id === id);
    if (el && el.type !== 'arrow' && el.type !== 'pen') el.zIndex = _nextZIndex++;
  }
  renderAll();
  if (_selectedIds.size === 1) {
    showContextMenu(id);
  } else if (_selectedIds.size > 1) {
    showMultiContextMenu();
  } else {
    hideContextMenu();
  }
}

function selectMultiple(ids) {
  _selectedIds = new Set(ids);
  _selectedId = ids.length ? ids[0] : null;
  renderAll();
  if (_selectedIds.size === 1) {
    showContextMenu(_selectedId);
  } else if (_selectedIds.size > 1) {
    showMultiContextMenu();
  } else {
    hideContextMenu();
  }
}

function deselectAll() {
  hideContextMenu();
  if (_selectedIds.size > 0 || _selectedId) {
    _selectedId = null;
    _selectedIds.clear();
    renderAll();
  }
}

function showContextMenu(id) {
  hideContextMenu();
  const el = _elements.find(e => e.id === id);
  if (!el || !_root) return;

  _ctxMenu = document.createElement('div');
  _ctxMenu.className = 'wb-ctx-menu';

  // Text formatting controls (text and list elements)
  const textControls = (el.type === 'text' || el.type === 'list') ? `
    <div class="wb-ctx-divider"></div>
    <button class="wb-ctx-btn" data-action="font-down" data-tooltip="Smaller"><svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
    <span class="wb-ctx-size">${el.fontSize || (el.type === 'list' ? 18 : 22)}</span>
    <button class="wb-ctx-btn" data-action="font-up" data-tooltip="Bigger"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
    ${el.type === 'text' ? `
    <div class="wb-ctx-divider"></div>
    <button class="wb-ctx-btn ${el.bold ? 'wb-ctx-active' : ''}" data-action="bold" data-tooltip="Bold"><svg viewBox="0 0 24 24"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg></button>
    <button class="wb-ctx-btn ${el.italic ? 'wb-ctx-active' : ''}" data-action="italic" data-tooltip="Italic"><svg viewBox="0 0 24 24"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg></button>` : ''}
    <div class="wb-ctx-divider"></div>
  ` : '';

  // "Send to" buttons for image elements
  const sendControls = el.type === 'image' ? `
    <button class="wb-ctx-btn" data-action="send-terminal" data-tooltip="Send to Terminal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></button>
    <button class="wb-ctx-btn" data-action="send-panel" data-tooltip="Send to Panel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
    <div class="wb-ctx-divider"></div>
  ` : '';

  _ctxMenu.innerHTML = `
    ${textControls}
    ${sendControls}
    <button class="wb-ctx-btn" data-action="duplicate" data-tooltip="Duplicate"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    <button class="wb-ctx-btn" data-action="copy" data-tooltip="Copy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    <button class="wb-ctx-btn wb-ctx-danger" data-action="delete" data-tooltip="Delete"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
  `;

  _ctxMenu.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'delete') {
      deleteElement(id);
    } else if (action === 'copy') {
      const src = _elements.find(el2 => el2.id === id);
      if (src) _clipboard = { ...src };
    } else if (action === 'font-up' || action === 'font-down') {
      const src = _elements.find(el2 => el2.id === id);
      if (src) {
        const before = { ...src };
        const step = action === 'font-up' ? 2 : -2;
        const defaultFs = src.type === 'list' ? 18 : 22;
        src.fontSize = Math.max(10, Math.min(72, (src.fontSize || defaultFs) + step));
        pushUndo('edit', before, { ...src });
        renderAll();
        persistDebounced();
        showContextMenu(id); // refresh to update size label
      }
    } else if (action === 'bold') {
      const src = _elements.find(el2 => el2.id === id);
      if (src) {
        const before = { ...src };
        src.bold = !src.bold;
        pushUndo('edit', before, { ...src });
        renderAll();
        persistDebounced();
        showContextMenu(id);
      }
    } else if (action === 'italic') {
      const src = _elements.find(el2 => el2.id === id);
      if (src) {
        const before = { ...src };
        src.italic = !src.italic;
        pushUndo('edit', before, { ...src });
        renderAll();
        persistDebounced();
        showContextMenu(id);
      }
    } else if (action === 'send-terminal') {
      const src = _elements.find(el2 => el2.id === id);
      if (src?.type === 'image' && src.dataUrl) {
        emit('wb:send-to-terminal', { dataUrl: src.dataUrl });
      }
    } else if (action === 'send-panel') {
      const src = _elements.find(el2 => el2.id === id);
      if (src?.type === 'image' && src.dataUrl) {
        emit('wb:send-to-panel', { dataUrl: src.dataUrl });
      }
    } else if (action === 'duplicate') {
      const src = _elements.find(el2 => el2.id === id);
      if (src) {
        const clone = { ...src, id: _genId() };
        if (clone.x != null) clone.x += 20;
        if (clone.y != null) clone.y += 20;
        if (clone.points) clone.points = clone.points.map(([px, py]) => [px + 20, py + 20]);
        delete clone.zIndex;
        clone.startAnchor = null;
        clone.endAnchor = null;
        if (clone.points) clone.pathD = pointsToSmoothPath(clone.points);
        const added = addElement(clone);
        selectElement(added.id);
      }
    }
    ev.stopPropagation();
  });

  // Floating rotation handle (works for all element types including arrows/pen)
  _rotateEl = document.createElement('div');
  _rotateEl.className = 'wb-rotate-float';
  _rotateEl.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M1 4v6h6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  _rotateEl.addEventListener('mousedown', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    const el2 = _elements.find(e2 => e2.id === id);
    if (!el2) return;
    const center = getElementCenter(el2);
    const pt = clientToCanvas(ev.clientX, ev.clientY);
    const dragData = {
      type: 'rotate', id,
      centerX: center.x, centerY: center.y,
      origRotation: el2.rotation || 0,
      startAngle: Math.atan2(pt.y - center.y, pt.x - center.x),
      before: { ...el2, points: el2.points ? el2.points.map(p => [...p]) : undefined },
    };
    // Store original points for point-based rotation (arrows + pen)
    if ((el2.type === 'arrow' || el2.type === 'pen') && el2.points) {
      dragData.origPoints = el2.points.map(p => [...p]);
    }
    _drag = dragData;
  });

  // Floating move handle for text/list elements (lets you drag even in edit mode)
  if (el.type === 'text' || el.type === 'list') {
    _moveEl = document.createElement('div');
    _moveEl.className = 'wb-move-float';
    _moveEl.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>';

    _moveEl.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      exitEditMode();
      exitListEditMode();
      const el2 = _elements.find(e2 => e2.id === id);
      if (!el2) return;
      _drag = {
        type: 'move', id,
        startX: ev.clientX, startY: ev.clientY,
        origX: el2.x, origY: el2.y,
        before: { ...el2 },
      };
    });

    _moveEl.style.zIndex = _nextZIndex + 100;
    _root.appendChild(_moveEl);
  }

  _ctxMenu.style.zIndex = _nextZIndex + 100;
  _rotateEl.style.zIndex = _nextZIndex + 100;
  _root.appendChild(_ctxMenu);
  _root.appendChild(_rotateEl);
  positionContextMenu(el);
}

/** Get the visual center of any element type. */
function getElementCenter(el) {
  if ((el.type === 'arrow' || el.type === 'pen') && el.points?.length) {
    const cx = el.points.reduce((s, p) => s + p[0], 0) / el.points.length;
    const cy = el.points.reduce((s, p) => s + p[1], 0) / el.points.length;
    return { x: cx, y: cy };
  }
  return { x: el.x + (el.width || 0) / 2, y: el.y + (el.height || 0) / 2 };
}

function positionContextMenu(el) {
  const rootRect = _root?.getBoundingClientRect();
  if (!rootRect) return;

  let cx, topY, rightX, bottomY, leftX;
  if ((el.type === 'arrow' || el.type === 'pen') && el.points?.length) {
    const xs = el.points.map(p => p[0]);
    const ys = el.points.map(p => p[1]);
    cx = xs.reduce((s, v) => s + v, 0) / xs.length;
    topY = Math.min(...ys);
    leftX = Math.min(...xs);
    rightX = Math.max(...xs);
    bottomY = Math.max(...ys);
  } else {
    let ew = el.width || 0, eh = el.height || 0;
    // Text/list auto-size: read actual dimensions from DOM
    if ((el.type === 'text' || el.type === 'list') && (!ew || !eh)) {
      const dom = _elementsDiv?.querySelector(`[data-wb-id="${el.id}"]`);
      if (dom) { ew = dom.offsetWidth; eh = dom.offsetHeight; }
    }
    cx = el.x + ew / 2;
    topY = el.y;
    leftX = el.x;
    rightX = el.x + ew;
    bottomY = el.y + eh;
  }

  // Context menu — centered above element
  if (_ctxMenu) {
    const menuW = 110;
    let left = cx - menuW / 2;
    let top = topY - 44;
    left = Math.max(8, Math.min(rootRect.width - menuW - 8, left));
    top = Math.max(8, top);
    _ctxMenu.style.left = left + 'px';
    _ctxMenu.style.top = top + 'px';
  }

  // Rotate handle — right side of element
  if (_rotateEl) {
    const elH = bottomY - topY;
    let rLeft = rightX + 12;
    let rTop = topY + (elH / 2) - 12;
    rLeft = Math.min(rootRect.width - 32, rLeft);
    rTop = Math.max(8, rTop);
    _rotateEl.style.left = rLeft + 'px';
    _rotateEl.style.top = rTop + 'px';
  }

  // Move handle — left side of element (text/list only)
  if (_moveEl) {
    const elH = bottomY - topY;
    let mLeft = leftX - 44;
    let mTop = topY + (elH / 2) - 12;
    mLeft = Math.max(8, mLeft);
    mTop = Math.max(8, mTop);
    _moveEl.style.left = mLeft + 'px';
    _moveEl.style.top = mTop + 'px';
  }
}

/** Get the combined bounding box of all selected elements. */
function getMultiSelectBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of _selectedIds) {
    const el = _elements.find(e => e.id === id);
    if (!el) continue;
    if ((el.type === 'arrow' || el.type === 'pen') && el.points?.length) {
      for (const [px, py] of el.points) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
    } else {
      const ex = el.x || 0, ey = el.y || 0;
      const ew = el.width || 0, eh = el.height || 0;
      if (ex < minX) minX = ex;
      if (ey < minY) minY = ey;
      if (ex + ew > maxX) maxX = ex + ew;
      if (ey + eh > maxY) maxY = ey + eh;
    }
  }
  return { minX, minY, maxX, maxY };
}

function showMultiContextMenu() {
  hideContextMenu();
  if (_selectedIds.size < 2 || !_root) return;

  _ctxMenu = document.createElement('div');
  _ctxMenu.className = 'wb-ctx-menu';

  const count = _selectedIds.size;
  _ctxMenu.innerHTML = `
    <span class="wb-ctx-count">${count}</span>
    <button class="wb-ctx-btn" data-action="duplicate-multi" data-tooltip="Duplicate All"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    <button class="wb-ctx-btn wb-ctx-danger" data-action="delete-multi" data-tooltip="Delete All"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
  `;

  _ctxMenu.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'delete-multi') {
      deleteMultipleElements([..._selectedIds]);
    } else if (action === 'duplicate-multi') {
      duplicateMultipleElements([..._selectedIds]);
    }
    ev.stopPropagation();
  });

  _ctxMenu.style.zIndex = _nextZIndex + 100;
  _root.appendChild(_ctxMenu);
  positionContextMenuMulti();
}

function positionContextMenuMulti() {
  if (!_ctxMenu || _selectedIds.size < 2) return;
  const rootRect = _root?.getBoundingClientRect();
  if (!rootRect) return;

  const bounds = getMultiSelectBounds();
  const cx = (bounds.minX + bounds.maxX) / 2;
  const menuW = 90;
  let left = cx - menuW / 2;
  let top = bounds.minY - 44;
  left = Math.max(8, Math.min(rootRect.width - menuW - 8, left));
  top = Math.max(8, top);
  _ctxMenu.style.left = left + 'px';
  _ctxMenu.style.top = top + 'px';
}

function hideContextMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  if (_rotateEl) { _rotateEl.remove(); _rotateEl = null; }
  if (_moveEl) { _moveEl.remove(); _moveEl = null; }
}


// ═══════════════════════════════════════════
// TOOL SWITCHING
// ═══════════════════════════════════════════

function setTool(name) {
  _activeTool = name;
  _arrowCreating = null;
  _sectionCreating = null;
  clearArrowPreview();
  hideArrowHint();

  if (_toolbar) {
    _toolbar.querySelectorAll('.wb-tool[data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === name);
    });
  }

  if (_root) {
    _root.classList.remove('tool-text', 'tool-list', 'tool-arrow', 'tool-shape', 'tool-pen', 'tool-section');
    if (name === 'text') _root.classList.add('tool-text');
    if (name === 'list') _root.classList.add('tool-list');
    if (name === 'arrow') _root.classList.add('tool-arrow');
    if (name === 'shape') _root.classList.add('tool-shape');
    if (name === 'pen') _root.classList.add('tool-pen');
    if (name === 'section') _root.classList.add('tool-section');
  }

  // Show/hide shape picker
  const shapePicker = document.getElementById('wb-shape-picker');
  if (shapePicker) {
    if (name === 'shape') {
      shapePicker.style.display = 'flex';
      const btn = _toolbar?.querySelector('[data-tool="shape"]');
      if (btn && _toolbar) {
        const btnRect = btn.getBoundingClientRect();
        const toolbarRect = _toolbar.getBoundingClientRect();
        shapePicker.style.top = (btnRect.top - toolbarRect.top) + 'px';
      }
    } else {
      shapePicker.style.display = 'none';
    }
  }

  // Show/hide section picker
  const sectionPicker = document.getElementById('wb-section-picker');
  if (sectionPicker) {
    if (name === 'section') {
      sectionPicker.style.display = 'grid';
      const btn = _toolbar?.querySelector('[data-tool="section"]');
      if (btn && _toolbar) {
        const btnRect = btn.getBoundingClientRect();
        const toolbarRect = _toolbar.getBoundingClientRect();
        sectionPicker.style.top = (btnRect.top - toolbarRect.top) + 'px';
      }
    } else {
      sectionPicker.style.display = 'none';
    }
  }

  updateLockIndicator();
}

/** Toggle multi-select marquee mode on/off. */
function toggleMultiSelectMode(on) {
  _multiSelectMode = on;
  const btn = $('wb-multiselect');
  if (btn) btn.classList.toggle('active', on);
  if (_root) _root.classList.toggle('tool-multiselect', on);
  if (on) {
    setTool('select');
  }
}

/** Auto-revert to select unless Ctrl is held (tool lock). */
function autoRevert() {
  if (!_toolLocked) setTool('select');
}

/** Update the lock badge on the active toolbar button. */
function updateLockIndicator() {
  if (!_toolbar) return;
  _toolbar.querySelectorAll('.wb-tool[data-tool]').forEach(btn => {
    btn.classList.toggle('locked', _toolLocked && btn.dataset.tool === _activeTool && _activeTool !== 'select');
  });
}

/** Track Ctrl key state for tool lock. */
function onCtrlTrack(e) {
  const held = e.ctrlKey || e.metaKey;
  if (held !== _toolLocked) {
    _toolLocked = held;
    updateLockIndicator();
  }
}


// ═══════════════════════════════════════════
// HAND-DRAWN SHAPE GENERATOR
// ═══════════════════════════════════════════

/** Seeded random for consistent wobble per element ID. */
function _seededRand(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return () => {
    h = (h * 16807 + 0) % 2147483647;
    return (h & 0x7fffffff) / 2147483647;
  };
}

/** Generate a hand-drawn SVG path for a shape type. */
function generateHandDrawnShape(shape, w, h, id) {
  const rand = _seededRand(id || 'default');
  const j = (amt = 4) => (rand() - 0.5) * amt;
  const m = 5; // margin from edges

  if (shape === 'triangle') {
    // Wobbly triangle — 3 corners with midpoint wobble
    const pts = [
      [w / 2 + j(3), m + j(2)],           // top center
      [w - m + j(3), h - m + j(2)],        // bottom right
      [m + j(3), h - m + j(2)],            // bottom left
    ];
    return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]} L ${pts[2][0]} ${pts[2][1]} Z`;
  }

  if (shape === 'circle') {
    // Perfect ellipse using two SVG arcs
    const cx = w / 2, cy = h / 2;
    const rx = (w / 2) - m, ry = (h / 2) - m;
    return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`;
  }

  if (shape === 'pill') {
    // Pill/capsule — rounded caps with Catmull-Rom (no sharp corners)
    const r = Math.min(w, h) / 2 - m;
    const pts = [];
    // Top edge (left to right)
    pts.push([m + r + j(), m + j(2)]);
    pts.push([w / 2 + j(), m + j(2)]);
    pts.push([w - m - r + j(), m + j(2)]);
    // Right cap (6 points for smooth semicircle)
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + (i / 5) * Math.PI;
      pts.push([w - m - r + Math.cos(a) * (r + j(2)), h / 2 + Math.sin(a) * (r + j(2))]);
    }
    // Bottom edge (right to left)
    pts.push([w - m - r + j(), h - m + j(2)]);
    pts.push([w / 2 + j(), h - m + j(2)]);
    pts.push([m + r + j(), h - m + j(2)]);
    // Left cap (6 points)
    for (let i = 0; i <= 5; i++) {
      const a = Math.PI / 2 + (i / 5) * Math.PI;
      pts.push([m + r + Math.cos(a) * (r + j(2)), h / 2 + Math.sin(a) * (r + j(2))]);
    }
    return closedSmoothPath(pts);
  }

  // Default: rect — rounded corners
  const r = Math.min(12, Math.min(w, h) / 4); // corner radius, max 12px
  const x1 = m, y1 = m, x2 = w - m, y2 = h - m;

  return `M ${x1 + r} ${y1}`
    + ` L ${x2 - r} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y1 + r}`
    + ` L ${x2} ${y2 - r} A ${r} ${r} 0 0 1 ${x2 - r} ${y2}`
    + ` L ${x1 + r} ${y2} A ${r} ${r} 0 0 1 ${x1} ${y2 - r}`
    + ` L ${x1} ${y1 + r} A ${r} ${r} 0 0 1 ${x1 + r} ${y1}`
    + ` Z`;
}


// ═══════════════════════════════════════════
// PEN SMOOTHING ENGINE
// ═══════════════════════════════════════════

/** Simplify points using Ramer-Douglas-Peucker algorithm. */
/** Smooth points using Laplacian (moving average) — preserves stroke shape, removes jitter. */
function smoothPoints(pts, passes = 5) {
  if (pts.length <= 2) return pts;
  let result = pts;
  for (let p = 0; p < passes; p++) {
    const next = [result[0]]; // anchor first point
    for (let i = 1; i < result.length - 1; i++) {
      const prev = result[i - 1], cur = result[i], nxt = result[i + 1];
      next.push([
        cur[0] * 0.4 + (prev[0] + nxt[0]) * 0.3,
        cur[1] * 0.4 + (prev[1] + nxt[1]) * 0.3,
      ]);
    }
    next.push(result[result.length - 1]); // anchor last point
    result = next;
  }
  // Only thin very dense strokes — keep up to 200 points
  if (result.length > 200) {
    const step = Math.ceil(result.length / 200);
    const thinned = [result[0]];
    for (let i = step; i < result.length - 1; i += step) thinned.push(result[i]);
    thinned.push(result[result.length - 1]);
    return thinned;
  }
  return result;
}

/** Convert points to a smooth SVG path using Catmull-Rom → cubic bezier (open path). */
function pointsToSmoothPath(pts) {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  if (pts.length === 2) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;

  let d = `M ${pts[0][0]} ${pts[0][1]}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[Math.min(pts.length - 1, i + 1)];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];

    const t = 0.4;
    const cp1x = p1[0] + (p2[0] - p0[0]) * t;
    const cp1y = p1[1] + (p2[1] - p0[1]) * t;
    const cp2x = p2[0] - (p3[0] - p1[0]) * t;
    const cp2y = p2[1] - (p3[1] - p1[1]) * t;

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/** Convert points to a smooth CLOSED SVG path — wraps neighbors around for proper closure. */
function closedSmoothPath(pts) {
  if (pts.length < 3) return pointsToSmoothPath(pts) + ' Z';
  const n = pts.length;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;

  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];

    const t = 0.3;
    const cp1x = p1[0] + (p2[0] - p0[0]) * t;
    const cp1y = p1[1] + (p2[1] - p0[1]) * t;
    const cp2x = p2[0] - (p3[0] - p1[0]) * t;
    const cp2y = p2[1] - (p3[1] - p1[1]) * t;

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d + ' Z';
}

// ═══════════════════════════════════════════
// SHAPE DETECTION
// ═══════════════════════════════════════════

/** Generate a drawn-circle path with overshoot tail (reference: hand-drawn circle aesthetic). */
function generateDrawnCirclePath(w, h, id) {
  const rand = _seededRand(id || 'drawn');
  const j = (amt = 3) => (rand() - 0.5) * amt;
  const cx = w / 2, cy = h / 2;
  const rx = (w / 2) - 6, ry = (h / 2) - 6;
  const m = 6; // padding

  // Generate points around more than 360° for overshoot
  const pts = [];
  const n = 16;
  const overshoot = 0.6; // radians past full circle (~35°)
  const totalAngle = Math.PI * 2 + overshoot;

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = -0.2 + t * totalAngle; // start slightly before 0
    // Wobble decreases near the tail (end) for smooth taper
    const wobble = i < n ? j(4) : j(1);
    pts.push([
      cx + Math.cos(a) * (rx + wobble),
      cy + Math.sin(a) * (ry + wobble),
    ]);
  }
  return pointsToSmoothPath(pts); // open path — no Z
}


/** Start drawing a pen stroke — creates a live preview path. */
function penStart(x, y) {
  _penPoints = [[x, y]];
  _penLiveEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  _penLiveEl.setAttribute('fill', 'none');
  _penLiveEl.setAttribute('stroke', _activeColor);
  _penLiveEl.setAttribute('stroke-width', '3');
  _penLiveEl.setAttribute('stroke-linecap', 'round');
  _penLiveEl.setAttribute('stroke-linejoin', 'round');
  _penLiveEl.setAttribute('d', `M ${x} ${y}`);
  _arrowsSvg?.appendChild(_penLiveEl);
}

/** Add a point during drawing — smooth preview in real-time. */
function penMove(x, y) {
  if (!_penPoints) return;
  const last = _penPoints[_penPoints.length - 1];
  const dist = Math.hypot(x - last[0], y - last[1]);
  if (dist < 3) return;  // skip jitter
  _penPoints.push([x, y]);

  // Real-time smooth preview
  if (_penLiveEl) {
    _penLiveEl.setAttribute('d', pointsToSmoothPath(_penPoints));
  }
}

/** Finish the pen stroke — simplify, smooth, and create a permanent element. */
function penEnd() {
  if (!_penPoints || _penPoints.length < 2) {
    // Too short — discard
    if (_penLiveEl) _penLiveEl.remove();
    _penLiveEl = null;
    _penPoints = null;
    return;
  }

  // Remove live preview
  if (_penLiveEl) _penLiveEl.remove();
  _penLiveEl = null;

  // Smooth jitter while preserving stroke shape
  const smoothed = smoothPoints(_penPoints, 3);
  _penPoints = null;

  // Pen stroke — always kept as freehand (no auto-shape correction)
  const pathD = pointsToSmoothPath(smoothed);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of smoothed) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }

  const penEl = addElement({
    id: _genId(),
    type: 'pen',
    points: smoothed,
    pathD,
    x: minX, y: minY,
    width: maxX - minX, height: maxY - minY,
    color: _activeColor,
    strokeWidth: 3,
  });
  selectElement(penEl.id);
  autoRevert();
}


// ═══════════════════════════════════════════
// ARROW PREVIEW (while placing)
// ═══════════════════════════════════════════

function showArrowPreview(placedPts, cursorX, cursorY) {
  if (!_arrowPreview) return;
  // Clear previous preview paths
  while (_arrowPreview.querySelector('path')) _arrowPreview.querySelector('path').remove();

  // Solid path for already-placed segments (2+ placed points)
  if (placedPts.length >= 2) {
    const solid = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    solid.setAttribute('d', computeArrowPath(placedPts));
    solid.setAttribute('fill', 'none');
    solid.setAttribute('stroke', 'rgba(255,255,255,0.5)');
    solid.setAttribute('stroke-width', '5');
    solid.setAttribute('stroke-linecap', 'round');
    solid.setAttribute('stroke-linejoin', 'round');
    _arrowPreview.appendChild(solid);
  }

  // Dashed preview — full path including cursor position
  const previewPts = [...placedPts, [cursorX, cursorY]];
  const dash = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  dash.setAttribute('d', computeArrowPath(previewPts));
  dash.setAttribute('fill', 'none');
  dash.setAttribute('stroke', 'rgba(255,255,255,0.35)');
  dash.setAttribute('stroke-width', '5');
  dash.setAttribute('stroke-dasharray', '10 6');
  dash.setAttribute('stroke-linecap', 'round');
  dash.setAttribute('marker-end', 'url(#wb-arrowhead-preview)');
  _arrowPreview.appendChild(dash);
}

function clearArrowPreview() {
  if (!_arrowPreview) return;
  const path = _arrowPreview.querySelector('path');
  if (path) path.remove();
}


function showArrowHint(x, y) {
  if (!_arrowHint) return;
  _arrowHint.style.left = (x + 16) + 'px';
  _arrowHint.style.top = (y - 32) + 'px';
  _arrowHint.classList.add('visible');
}

function hideArrowHint() {
  if (!_arrowHint) return;
  _arrowHint.classList.remove('visible');
}

function finalizeArrow() {
  hideArrowHint();
  if (!_arrowCreating || _arrowCreating.points.length < 2) {
    _arrowCreating = null;
    clearArrowPreview();
    return;
  }
  const pts = _arrowCreating.points;
  const lastPt = pts[pts.length - 1];
  const endAnchor = findNearestAnchor(lastPt[0], lastPt[1], null);
  const arr = addElement({
    id: _genId(),
    type: 'arrow',
    points: pts.map(p => [...p]),
    startAnchor: _arrowCreating.startAnchor,
    endAnchor: endAnchor || null,
    color: _activeColor,
  });
  _arrowCreating = null;
  clearArrowPreview();
  selectElement(arr.id);
  autoRevert();
}


// ═══════════════════════════════════════════
// TEXT / FORM EDITING
// ═══════════════════════════════════════════

function enterEditMode(dom, elId) {
  const content = dom.querySelector('.wb-text-content');
  if (!content) return;
  content.setAttribute('contenteditable', 'true');
  dom.classList.add('editing');
  content.focus();

  const range = document.createRange();
  range.selectNodeContents(content);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const onBlur = () => {
    content.setAttribute('contenteditable', 'false');
    dom.classList.remove('editing');
    content.removeEventListener('blur', onBlur);

    const el = _elements.find(e => e.id === elId);
    if (el) {
      const before = { ...el };
      el.content = content.innerText.trimEnd() || '';
      pushUndo('edit', before, { ...el });
      persistDebounced();
    }
  };
  content.addEventListener('blur', onBlur);
}

function exitEditMode() {
  const editing = _root?.querySelector('.wb-text.editing .wb-text-content');
  if (editing) editing.blur();
}

function enterListEditMode(dom, elId) {
  const ul = dom.querySelector('ul');
  if (!ul) return;
  dom.classList.add('editing');

  // Make all existing items editable
  [...ul.querySelectorAll('li')].forEach(li => li.setAttribute('contenteditable', 'true'));

  // Focus last item, cursor at end
  const lis = [...ul.querySelectorAll('li')];
  const target = lis[lis.length - 1] || null;
  if (target) {
    target.focus();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }
}

function exitListEditMode() {
  const dom = _root?.querySelector('.wb-list.editing');
  if (!dom) return;
  const ul = dom.querySelector('ul');
  const elId = dom.dataset.wbId;

  dom.classList.remove('editing');
  [...ul.querySelectorAll('li')].forEach(li => li.setAttribute('contenteditable', 'false'));
  // Re-blur in case still focused
  if (document.activeElement?.closest('.wb-list')) document.activeElement.blur();

  const el = _elements.find(e => e.id === elId);
  if (el) {
    const before = { ...el, items: [...(el.items || [])] };
    const rawItems = [...ul.querySelectorAll('li')].map(li => li.innerText.trimEnd());
    el.items = rawItems.filter((t, i, arr) => t !== '' || arr.length === 1);
    if (!el.items.length) el.items = [''];
    pushUndo('edit', before, { ...el, items: [...el.items] });
    renderElements();
    persistDebounced();
  }
}


// ═══════════════════════════════════════════
// MULTI-SELECT HELPERS
// ═══════════════════════════════════════════

/** Start dragging all selected elements together. */
function _startMultiDrag(e) {
  const snapshots = [];
  for (const id of _selectedIds) {
    const el = _elements.find(el2 => el2.id === id);
    if (!el) continue;
    snapshots.push({
      id,
      origX: el.x, origY: el.y,
      origPoints: el.points ? el.points.map(p => [...p]) : null,
      before: { ...el, points: el.points ? el.points.map(p => [...p]) : undefined },
    });
  }
  _drag = {
    type: 'move-multi',
    startX: e.clientX, startY: e.clientY,
    snapshots,
  };
}

/** Check if an element's bounding box intersects a rectangle. */
function _elementIntersectsRect(el, rx, ry, rw, rh) {
  let ex, ey, ew, eh;
  if ((el.type === 'arrow' || el.type === 'pen') && el.points?.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of el.points) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    ex = minX; ey = minY; ew = maxX - minX; eh = maxY - minY;
  } else {
    ex = el.x || 0; ey = el.y || 0;
    ew = el.width || 0; eh = el.height || 0;
    // For text elements with zero width, estimate width from content
    if ((el.type === 'text' || el.type === 'list') && ew === 0) {
      const dom = _elementsDiv?.querySelector(`[data-wb-id="${el.id}"]`);
      if (dom) { ew = dom.offsetWidth; eh = dom.offsetHeight; }
    }
  }
  // AABB intersection test
  return !(ex + ew < rx || ex > rx + rw || ey + eh < ry || ey > ry + rh);
}


// ═══════════════════════════════════════════
// EVENT HANDLERS — MOUSE
// ═══════════════════════════════════════════

function onMouseDown(e) {
  if (!_root || !_root.closest('#static-bg.visible')) return;
  if (e.target.closest('#wb-toolbar')) return;
  if (e.target.closest('.wb-ctx-menu')) return;
  if (e.target.closest('.wb-rotate-float')) return;
  if (e.target.closest('.wb-move-float')) return;
  if (e.target.closest('.wb-drag-to-term')) return;
  if (e.button !== 0) return;
  // Block drawing for guests without whiteboard permission (select/view still allowed)
  if (isGuest() && !hasPermission('whiteboard') && _activeTool !== 'select') return;

  // Steal focus from terminal/other elements so Ctrl+V paste works on whiteboard
  _root.focus({ preventScroll: true });

  const pt = clientToCanvas(e.clientX, e.clientY);

  // Check if clicking on an element
  const targetEl = e.target.closest('[data-wb-id]');
  const targetId = targetEl?.dataset.wbId;

  // Check if clicking on an SVG path (arrow or pen stroke)
  const arrowPath = e.target.closest('path[data-wb-id]');
  const arrowId = arrowPath?.dataset.wbId;

  if (_activeTool === 'select') {
    const additive = e.shiftKey || _multiSelectMode;

    // Resize handle? (only when single-selected)
    if (e.target.closest('.wb-resize-handle') && targetId) {
      const el = _elements.find(e2 => e2.id === targetId);
      if (el) {
        selectElement(targetId);
        _drag = {
          type: 'resize', id: targetId,
          startX: e.clientX, startY: e.clientY,
          origW: el.width || 200, origH: el.height || 80,
          before: { ...el },
        };
        e.preventDefault();
        return;
      }
    }

    // Click on element → select + start drag (or multi-drag)
    if (targetId) {
      const el = _elements.find(e2 => e2.id === targetId);
      if (el && el.type !== 'arrow' && el.type !== 'pen') {
        if (additive) {
          selectElement(targetId, { additive: true });
        } else if (!_selectedIds.has(targetId)) {
          selectElement(targetId);
        }
        // Start multi-drag if multiple selected
        if (_selectedIds.size > 1) {
          _startMultiDrag(e);
        } else {
          _drag = {
            type: 'move', id: targetId,
            startX: e.clientX, startY: e.clientY,
            origX: el.x, origY: el.y,
            before: { ...el },
          };
        }
        e.preventDefault();
        return;
      }
    }

    // Click on arrow/pen stroke → select + start drag
    if (arrowId) {
      const el = _elements.find(e2 => e2.id === arrowId);
      if (el) {
        if (additive) {
          selectElement(arrowId, { additive: true });
        } else if (!_selectedIds.has(arrowId)) {
          selectElement(arrowId);
        }
        // Start multi-drag if multiple selected
        if (_selectedIds.size > 1) {
          _startMultiDrag(e);
        } else if (el.type === 'arrow') {
          _drag = {
            type: 'move-arrow', id: arrowId,
            startX: e.clientX, startY: e.clientY,
            origPoints: el.points.map(p => [...p]),
            before: { ...el, points: el.points.map(p => [...p]) },
          };
        } else if (el.type === 'pen') {
          _drag = {
            type: 'move-pen', id: arrowId,
            startX: e.clientX, startY: e.clientY,
            origX: el.x, origY: el.y,
            origPoints: el.points.map(p => [...p]),
            before: { ...el, points: el.points.map(p => [...p]) },
          };
        }
      }
      e.preventDefault();
      return;
    }

    // Click on empty canvas
    exitEditMode();
    if (_multiSelectMode || additive) {
      // Multi-select mode or Shift held → start marquee drag
      if (!additive) deselectAll();
      _marquee = { startX: pt.x, startY: pt.y, rect: null };
    } else {
      // Normal mode → just deselect
      deselectAll();
    }
    e.preventDefault();
    return;
  }

  if (_activeTool === 'text') {
    exitEditMode();
    const el = addElement({
      id: _genId(),
      type: 'text',
      x: _snap(pt.x),
      y: _snap(pt.y - 10),
      width: 0,
      height: 0,       // auto-size
      content: '',
      fontSize: 22,
      color: _activeColor,
    });
    selectElement(el.id);
    requestAnimationFrame(() => {
      const dom = _elementsDiv?.querySelector(`[data-wb-id="${el.id}"]`);
      if (dom) enterEditMode(dom, el.id);
    });
    autoRevert();
    e.preventDefault();
    return;
  }

  if (_activeTool === 'list') {
    exitEditMode();
    exitListEditMode();
    const el = addElement({
      id: _genId(),
      type: 'list',
      x: _snap(pt.x),
      y: _snap(pt.y - 10),
      width: 0,
      height: 0,
      items: [''],
      ordered: false,
      fontSize: 18,
      color: _activeColor,
    });
    selectElement(el.id);
    requestAnimationFrame(() => {
      const dom = _elementsDiv?.querySelector(`[data-wb-id="${el.id}"]`);
      if (dom) enterListEditMode(dom, el.id);
    });
    autoRevert();
    e.preventDefault();
    return;
  }

  if (_activeTool === 'shape') {
    exitEditMode();
    deselectAll();
    const id = _genId();
    const el = {
      id,
      type: 'shape',
      shape: _activeShapeType,
      x: _snap(pt.x),
      y: _snap(pt.y),
      width: 1,
      height: 1,
      color: _activeColor,
      zIndex: _nextZIndex++,
    };
    _elements.push(el);
    _shapeCreating = { id, originX: pt.x, originY: pt.y };
    renderAll();
    e.preventDefault();
    return;
  }

  if (_activeTool === 'section') {
    exitEditMode();
    deselectAll();
    const id = _genId();
    const def = SECTION_TYPES[_activeSectionType] || SECTION_TYPES.content;
    const el = {
      id,
      type: 'section',
      sectionType: _activeSectionType,
      label: def.label,
      x: _snap(pt.x),
      y: _snap(pt.y),
      width: 1,
      height: 1,
      color: def.color,
      zIndex: _nextZIndex++,
    };
    _elements.push(el);
    _sectionCreating = { id, originX: pt.x, originY: pt.y, sectionType: _activeSectionType };
    const picker = document.getElementById('wb-section-picker');
    if (picker) picker.style.display = 'none';
    renderAll();
    e.preventDefault();
    return;
  }

  if (_activeTool === 'pen') {
    exitEditMode();
    deselectAll();
    penStart(pt.x, pt.y);
    e.preventDefault();
    return;
  }

  if (_activeTool === 'arrow') {
    exitEditMode();
    if (!_arrowCreating) {
      // First click → start multi-point arrow
      const anchorId = findNearestAnchor(pt.x, pt.y, null);
      _arrowCreating = { points: [[pt.x, pt.y]], startAnchor: anchorId || null };
      showArrowHint(pt.x, pt.y);
    } else {
      // Subsequent click — check for double-click (same spot → finalize)
      const pts = _arrowCreating.points;
      const last = pts[pts.length - 1];
      const dist = Math.sqrt((pt.x - last[0]) ** 2 + (pt.y - last[1]) ** 2);
      if (dist < 8 && pts.length >= 2) {
        // Double-click detected → finalize arrow
        finalizeArrow();
        e.preventDefault();
        return;
      }
      // Add waypoint
      pts.push([pt.x, pt.y]);
    }
    e.preventDefault();
    return;
  }
}

function onMouseMove(e) {
  if (!_root) return;

  // Marquee selection drag
  if (_marquee) {
    const pt = clientToCanvas(e.clientX, e.clientY);
    const x = Math.min(_marquee.startX, pt.x);
    const y = Math.min(_marquee.startY, pt.y);
    const w = Math.abs(pt.x - _marquee.startX);
    const h = Math.abs(pt.y - _marquee.startY);

    if (!_marquee.rect && (w > 4 || h > 4)) {
      _marquee.rect = document.createElement('div');
      _marquee.rect.className = 'wb-marquee';
      _root.appendChild(_marquee.rect);
    }
    if (_marquee.rect) {
      _marquee.rect.style.left = x + 'px';
      _marquee.rect.style.top = y + 'px';
      _marquee.rect.style.width = w + 'px';
      _marquee.rect.style.height = h + 'px';
    }
    return;
  }

  // Multi-drag move
  if (_drag?.type === 'move-multi') {
    const rawDx = e.clientX - _drag.startX;
    const rawDy = e.clientY - _drag.startY;
    const dx = state.gridSnap ? (_snap(_drag.snapshots[0]?.origX + rawDx) - _drag.snapshots[0]?.origX) : rawDx;
    const dy = state.gridSnap ? (_snap(_drag.snapshots[0]?.origY + rawDy) - _drag.snapshots[0]?.origY) : rawDy;
    for (const snap of _drag.snapshots) {
      const el = _elements.find(el2 => el2.id === snap.id);
      if (!el) continue;
      if (el.type === 'arrow') {
        el.points = snap.origPoints.map(([px, py]) => [px + dx, py + dy]);
        el.startAnchor = null;
        el.endAnchor = null;
      } else if (el.type === 'pen') {
        el.x = snap.origX + dx;
        el.y = snap.origY + dy;
        el.points = snap.origPoints.map(([px, py]) => [px + dx, py + dy]);
        el.pathD = pointsToSmoothPath(el.points);
      } else {
        el.x = snap.origX + dx;
        el.y = snap.origY + dy;
      }
    }
    renderAll();
    return;
  }

  // Shape drag-to-create
  if (_shapeCreating) {
    const pt = clientToCanvas(e.clientX, e.clientY);
    const el = _elements.find(el2 => el2.id === _shapeCreating.id);
    if (el) {
      const sx = _snap(Math.min(_shapeCreating.originX, pt.x));
      const sy = _snap(Math.min(_shapeCreating.originY, pt.y));
      el.x = sx;
      el.y = sy;
      el.width = Math.max(_snap(Math.abs(pt.x - _shapeCreating.originX)), 2);
      el.height = Math.max(_snap(Math.abs(pt.y - _shapeCreating.originY)), 2);
      renderAll();
    }
    return;
  }

  // Section drag-to-create
  if (_sectionCreating) {
    const pt = clientToCanvas(e.clientX, e.clientY);
    const el = _elements.find(el2 => el2.id === _sectionCreating.id);
    if (el) {
      const sx = _snap(Math.min(_sectionCreating.originX, pt.x));
      const sy = _snap(Math.min(_sectionCreating.originY, pt.y));
      el.x = sx;
      el.y = sy;
      el.width = Math.max(_snap(Math.abs(pt.x - _sectionCreating.originX)), 2);
      el.height = Math.max(_snap(Math.abs(pt.y - _sectionCreating.originY)), 2);
      renderAll();
    }
    return;
  }

  // Pen drawing
  if (_penPoints) {
    const rect = _root.getBoundingClientRect();
    penMove(e.clientX - rect.left, e.clientY - rect.top);
    return;
  }

  // Drag move
  if (_drag?.type === 'move') {
    const dx = e.clientX - _drag.startX;
    const dy = e.clientY - _drag.startY;
    const el = _elements.find(el2 => el2.id === _drag.id);
    if (el) {
      el.x = _snap(_drag.origX + dx);
      el.y = _snap(_drag.origY + dy);
      renderAll();
    }
    return;
  }

  // Drag move arrow (shift all points)
  if (_drag?.type === 'move-arrow') {
    const dx = e.clientX - _drag.startX;
    const dy = e.clientY - _drag.startY;
    const el = _elements.find(el2 => el2.id === _drag.id);
    if (el && el.points) {
      el.points = _drag.origPoints.map(([px, py]) => [px + dx, py + dy]);
      el.startAnchor = null;
      el.endAnchor = null;
      renderAll();
    }
    return;
  }

  // Drag move pen stroke
  if (_drag?.type === 'move-pen') {
    const dx = e.clientX - _drag.startX;
    const dy = e.clientY - _drag.startY;
    const el = _elements.find(el2 => el2.id === _drag.id);
    if (el) {
      el.x = _drag.origX + dx;
      el.y = _drag.origY + dy;
      el.points = _drag.origPoints.map(([px, py]) => [px + dx, py + dy]);
      el.pathD = pointsToSmoothPath(el.points);
      renderAll();
    }
    return;
  }

  // Drag rotate
  if (_drag?.type === 'rotate') {
    const pt2 = clientToCanvas(e.clientX, e.clientY);
    const angle = Math.atan2(pt2.y - _drag.centerY, pt2.x - _drag.centerX);
    const deltaRad = angle - _drag.startAngle;
    const deltaDeg = deltaRad * (180 / Math.PI);
    const el = _elements.find(el2 => el2.id === _drag.id);
    if (el) {
      // For arrows: rotate all points around centroid
      if (el.type === 'arrow' && _drag.origPoints) {
        const cx = _drag.centerX, cy = _drag.centerY;
        const cos = Math.cos(deltaRad), sin = Math.sin(deltaRad);
        el.points = _drag.origPoints.map(([px, py]) => [
          cx + (px - cx) * cos - (py - cy) * sin,
          cy + (px - cx) * sin + (py - cy) * cos,
        ]);
        el.startAnchor = null;
        el.endAnchor = null;
      }
      // For pen strokes: rotate all points around centroid, recalc bounding box
      else if (el.type === 'pen') {
        const cx = _drag.centerX, cy = _drag.centerY;
        const cos = Math.cos(deltaRad), sin = Math.sin(deltaRad);
        el.points = _drag.origPoints.map(([px, py]) => {
          const rx = cx + (px - cx) * cos - (py - cy) * sin;
          const ry = cy + (px - cx) * sin + (py - cy) * cos;
          return [rx, ry];
        });
        el.pathD = pointsToSmoothPath(el.points);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of el.points) {
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }
        el.x = minX; el.y = minY;
        el.width = maxX - minX; el.height = maxY - minY;
      }
      // For DOM elements (text, shape, image): CSS rotation
      else {
        let newRot = _drag.origRotation + deltaDeg;
        // Snap to 0/90/180/270 when within 5°
        const snap = [0, 90, 180, 270, -90, -180, -270, 360];
        for (const s of snap) {
          if (Math.abs(newRot - s) < 5) { newRot = s; break; }
        }
        el.rotation = Math.round(newRot * 10) / 10;
      }
      renderAll();
    }
    return;
  }

  // Drag resize
  if (_drag?.type === 'resize') {
    const dx = e.clientX - _drag.startX;
    const dy = e.clientY - _drag.startY;
    const el = _elements.find(el2 => el2.id === _drag.id);
    if (el) {
      el.width = _snap(Math.max(60, _drag.origW + dx));
      el.height = _snap(Math.max(30, _drag.origH + dy));
      renderAll();
    }
    return;
  }

  // Arrow preview (multi-point)
  if (_activeTool === 'arrow' && _arrowCreating) {
    const pt = clientToCanvas(e.clientX, e.clientY);
    showArrowPreview(_arrowCreating.points, pt.x, pt.y);
    showArrowHint(pt.x, pt.y);
  }
}

function onMouseUp(e) {
  // Finalize marquee selection
  if (_marquee) {
    if (_marquee.rect) {
      const pt = clientToCanvas(e.clientX, e.clientY);
      const rx = Math.min(_marquee.startX, pt.x);
      const ry = Math.min(_marquee.startY, pt.y);
      const rw = Math.abs(pt.x - _marquee.startX);
      const rh = Math.abs(pt.y - _marquee.startY);

      const hitIds = [];
      for (const el of _elements) {
        if (_elementIntersectsRect(el, rx, ry, rw, rh)) {
          hitIds.push(el.id);
        }
      }

      _marquee.rect.remove();
      if (hitIds.length) {
        if (e.shiftKey) {
          // Additive: merge with existing selection
          for (const id of hitIds) _selectedIds.add(id);
          _selectedId = hitIds[0];
        } else {
          selectMultiple(hitIds);
        }
        if (_selectedIds.size === 1) {
          showContextMenu([..._selectedIds][0]);
        } else if (_selectedIds.size > 1) {
          showMultiContextMenu();
        }
        renderAll();
      }
    }
    _marquee = null;
    return;
  }

  // Finalize multi-drag
  if (_drag?.type === 'move-multi') {
    const dx = e.clientX - _drag.startX;
    const dy = e.clientY - _drag.startY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      const befores = _drag.snapshots.map(s => ({ ...s.before }));
      const afters = _drag.snapshots.map(s => {
        const el = _elements.find(el2 => el2.id === s.id);
        return el ? { ...el, points: el.points ? el.points.map(p => [...p]) : undefined } : null;
      }).filter(Boolean);
      pushUndo('move-multi', befores, afters);
    }
    _drag = null;
    persistDebounced();
    return;
  }

  // Finalize shape drag-to-create
  if (_shapeCreating) {
    const el = _elements.find(el2 => el2.id === _shapeCreating.id);
    if (el) {
      // Click without drag → fall back to default size
      if (el.width < 10 && el.height < 10) {
        el.x = _snap(_shapeCreating.originX - 80);
        el.y = _snap(_shapeCreating.originY - 50);
        el.width = 160;
        el.height = 100;
      }
      el.x = _snap(el.x);
      el.y = _snap(el.y);
      el.width = Math.max(el.width, 30);
      el.height = Math.max(el.height, 20);
      pushUndo('add', null, { ...el });
      selectElement(el.id);
      persistDebounced();
      autoRevert();
    }
    _shapeCreating = null;
    return;
  }

  // Finalize section drag-to-create
  if (_sectionCreating) {
    const el = _elements.find(el2 => el2.id === _sectionCreating.id);
    if (el) {
      if (el.width < 10 && el.height < 10) {
        const def = SECTION_TYPES[el.sectionType] || SECTION_TYPES.content;
        el.x = _snap(_sectionCreating.originX - def.w / 2);
        el.y = _snap(_sectionCreating.originY - def.h / 2);
        el.width = def.w;
        el.height = def.h;
      }
      el.x = _snap(el.x);
      el.y = _snap(el.y);
      el.width = Math.max(el.width, 40);
      el.height = Math.max(el.height, 30);
      pushUndo('add', null, { ...el });
      selectElement(el.id);
      persistDebounced();
      autoRevert();
    }
    _sectionCreating = null;
    return;
  }

  // Finalize pen stroke
  if (_penPoints) {
    penEnd();
    return;
  }

  if (_drag) {
    const el = _elements.find(el2 => el2.id === _drag.id);
    if (el && _drag.before) {
      let hasMoved = false;
      if (_drag.type === 'move-arrow') {
        hasMoved = el.points?.[0]?.[0] !== _drag.before.points?.[0]?.[0] || el.points?.[0]?.[1] !== _drag.before.points?.[0]?.[1];
      } else if (_drag.type === 'move-pen') {
        hasMoved = el.x !== _drag.before.x || el.y !== _drag.before.y;
      } else if (_drag.type === 'rotate') {
        if (el.type === 'arrow') {
          hasMoved = el.points?.[0]?.[0] !== _drag.before.points?.[0]?.[0] || el.points?.[0]?.[1] !== _drag.before.points?.[0]?.[1];
        } else if (el.type === 'pen') {
          hasMoved = el.x !== _drag.before.x || el.y !== _drag.before.y;
        } else {
          hasMoved = (el.rotation || 0) !== (_drag.before.rotation || 0);
        }
      } else {
        hasMoved = el.x !== _drag.before.x || el.y !== _drag.before.y
          || el.width !== _drag.before.width || el.height !== _drag.before.height;
      }
      if (hasMoved) {
        const after = { ...el };
        if (el.points) after.points = el.points.map(p => [...p]);
        pushUndo('move', _drag.before, after);
      }
    }
    _drag = null;
    persistDebounced();
  }
}

function onDblClick(e) {
  if (!_root || !_root.closest('#static-bg.visible')) return;
  if (e.target.closest('#wb-toolbar')) return;

  // Double-click text → edit
  const textEl = e.target.closest('.wb-text[data-wb-id]');
  if (textEl && _activeTool === 'select') {
    const id = textEl.dataset.wbId;
    selectElement(id);
    enterEditMode(textEl, id);
    e.preventDefault();
    return;
  }

  // Double-click list → edit
  const listEl = e.target.closest('.wb-list[data-wb-id]');
  if (listEl && _activeTool === 'select') {
    const id = listEl.dataset.wbId;
    selectElement(id);
    enterListEditMode(listEl, id);
    e.preventDefault();
    return;
  }

  // Double-click shape → cycle subtype: rect → pill → circle → triangle → drawn-circle
  const shapeEl = e.target.closest('.wb-shape[data-wb-id]');
  if (shapeEl && _activeTool === 'select') {
    const id = shapeEl.dataset.wbId;
    const el = _elements.find(el2 => el2.id === id);
    if (el) {
      const before = { ...el };
      const cycle = { rect: 'pill', pill: 'circle', circle: 'triangle', triangle: 'drawn-circle', 'drawn-circle': 'rect' };
      el.shape = cycle[el.shape || 'rect'] || 'rect';
      // Circle → enforce square aspect ratio
      if (el.shape === 'circle') {
        const size = Math.max(el.width, el.height);
        el.width = size;
        el.height = size;
      }
      pushUndo('edit', before, { ...el });
      renderElements();
      persistDebounced();
    }
    e.preventDefault();
    return;
  }

  // Double-click section → edit label
  const sectionEl = e.target.closest('.wb-section[data-wb-id]');
  if (sectionEl && _activeTool === 'select') {
    const id = sectionEl.dataset.wbId;
    const el = _elements.find(el2 => el2.id === id);
    if (el) {
      const labelDiv = sectionEl.querySelector('.wb-section-label');
      if (labelDiv) {
        const before = { ...el };
        labelDiv.contentEditable = 'true';
        labelDiv.focus();
        const range = document.createRange();
        range.selectNodeContents(labelDiv);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        const onBlur = () => {
          labelDiv.contentEditable = 'false';
          el.label = labelDiv.textContent.trim() || (SECTION_TYPES[el.sectionType]?.label || 'Section');
          pushUndo('edit', before, { ...el });
          renderAll();
          persistDebounced();
          labelDiv.removeEventListener('blur', onBlur);
        };
        labelDiv.addEventListener('blur', onBlur);
        labelDiv.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') { ke.preventDefault(); labelDiv.blur(); }
          if (ke.key === 'Escape') { labelDiv.textContent = before.label || ''; labelDiv.blur(); }
        });
      }
    }
    e.preventDefault();
    return;
  }
}


// ═══════════════════════════════════════════
// EVENT HANDLERS — KEYBOARD
// ═══════════════════════════════════════════

function isWhiteboardActive() {
  const bg = $('static-bg');
  return bg && bg.classList.contains('visible');
}

function onKeyDown(e) {
  if (!isWhiteboardActive()) return;

  // Don't intercept keys when focus is in inputs outside the whiteboard (e.g. code editor)
  const tag = document.activeElement?.tagName;
  if ((tag === 'INPUT' || tag === 'TEXTAREA') && !document.activeElement.closest('#static-bg')) return;

  const isEditingText = !!document.activeElement?.closest('.wb-text.editing');
  const editingListLi = document.activeElement?.closest('.wb-list.editing li') || null;
  const isEditing = isEditingText || !!editingListLi;

  // List Enter → insert new item
  if (editingListLi && e.key === 'Enter') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const newLi = document.createElement('li');
    newLi.setAttribute('contenteditable', 'true');
    editingListLi.after(newLi);
    newLi.focus();
    return;
  }

  // List Backspace on empty item → remove item (keep at least 1)
  if (editingListLi && e.key === 'Backspace' && editingListLi.textContent === '') {
    const ul = editingListLi.parentElement;
    if (ul && ul.children.length > 1) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const prev = editingListLi.previousElementSibling;
      const next = editingListLi.nextElementSibling;
      editingListLi.remove();
      const focusTarget = prev || next;
      if (focusTarget) {
        focusTarget.focus();
        const range = document.createRange();
        range.selectNodeContents(focusTarget);
        range.collapse(false);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
    }
    return;
  }

  if (!isEditing) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && _selectedIds.size > 0) {
      if (_selectedIds.size > 1) {
        deleteMultipleElements([..._selectedIds]);
      } else {
        deleteElement(_selectedId);
      }
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && _arrowCreating && _arrowCreating.points.length >= 2) {
      finalizeArrow();
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (_shapeCreating) {
        _elements = _elements.filter(el => el.id !== _shapeCreating.id);
        _shapeCreating = null;
        renderAll();
      }
      if (_sectionCreating) {
        _elements = _elements.filter(el => el.id !== _sectionCreating.id);
        _sectionCreating = null;
        renderAll();
      }
      if (_arrowCreating) { _arrowCreating = null; clearArrowPreview(); }
      if (_multiSelectMode) toggleMultiSelectMode(false);
      exitEditMode();
      exitListEditMode();
      deselectAll();
      setTool('select');
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
  }

  // Escape from text editing
  if (isEditingText && e.key === 'Escape') {
    exitEditMode();
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }

  // Escape from list editing
  if (editingListLi && e.key === 'Escape') {
    exitListEditMode();
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }

  // Ctrl combos
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z' && !e.shiftKey) {
      undo();
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    if ((e.key === 'Z' && e.shiftKey) || (e.key === 'y')) {
      redo();
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    if (e.key === 'a' && !isEditing) {
      // Ctrl+A → select all elements
      const allIds = _elements.map(el => el.id);
      if (allIds.length) selectMultiple(allIds);
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    if (e.key === 'c' && !isEditing && _selectedIds.size > 0) {
      if (_selectedIds.size === 1) {
        const el = _elements.find(el2 => el2.id === _selectedId);
        if (el) _clipboard = { ...el };
      } else {
        // Multi-copy: store array
        _clipboard = [..._selectedIds].map(id => {
          const el = _elements.find(el2 => el2.id === id);
          return el ? { ...el, points: el.points ? el.points.map(p => [...p]) : undefined } : null;
        }).filter(Boolean);
      }
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
  }
}


// ═══════════════════════════════════════════
// EVENT HANDLERS — PASTE
// ═══════════════════════════════════════════

async function onPaste(e) {
  if (!isWhiteboardActive()) return;
  // Only process paste when whiteboard (or its children) has focus
  const active = document.activeElement;
  if (active && active !== _root && !_root.contains(active)) return;
  if (active?.closest('.wb-text.editing')) return;
  if (active?.closest('.wb-list.editing')) return;

  const items = e.clipboardData?.items;
  if (!items) return;

  // Check for image
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const blob = item.getAsFile();
      if (!blob) return;

      try {
        const { dataUrl, width, height } = await compressImage(blob);
        const rect = _root.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const dispW = Math.min(width, 400);
        const dispH = Math.round(height * (dispW / width));

        const el = addElement({
          id: _genId(),
          type: 'image',
          x: cx - dispW / 2,
          y: cy - dispH / 2,
          width: dispW,
          height: dispH,
          dataUrl,
        });
        selectElement(el.id);
      } catch (err) {
        console.error('[whiteboard] Image paste failed:', err);
      }
      return;
    }
  }

  // No image — try pasting copied element(s)
  if (_clipboard) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (Array.isArray(_clipboard)) {
      // Multi-paste
      const newIds = [];
      const updated = _clipboard.map(src => {
        const clone = { ...src, id: _genId(), x: (src.x || 0) + 20, y: (src.y || 0) + 20 };
        delete clone.zIndex;
        clone.startAnchor = null;
        clone.endAnchor = null;
        if (clone.points) clone.points = clone.points.map(([px, py]) => [px + 20, py + 20]);
        if (clone.points && clone.type === 'pen') clone.pathD = pointsToSmoothPath(clone.points);
        const added = addElement(clone);
        newIds.push(added.id);
        return { ...clone };
      });
      selectMultiple(newIds);
      _clipboard = updated;
    } else {
      const clone = { ..._clipboard, id: _genId(), x: (_clipboard.x || 0) + 20, y: (_clipboard.y || 0) + 20 };
      delete clone.zIndex;
      if (clone.type === 'arrow') {
        clone.startAnchor = null;
        clone.endAnchor = null;
        if (clone.points) clone.points = clone.points.map(([px, py]) => [px + 20, py + 20]);
      }
      const el = addElement(clone);
      selectElement(el.id);
      _clipboard = { ...clone };
    }
  }
}


// ═══════════════════════════════════════════
// COLOR PICKER
// ═══════════════════════════════════════════

function initColorPicker() {
  const picker = $('wb-color-picker');
  const dot = $('wb-color-dot');
  const btn = $('wb-color-btn');
  if (!picker || !dot || !btn) return;

  // Build swatches
  picker.innerHTML = WB_COLORS.map(c =>
    `<div class="wb-color-swatch${c === _activeColor ? ' active' : ''}" data-color="${c}" style="background:${c}"></div>`
  ).join('');

  // Toggle picker on button click
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = picker.style.display !== 'none';
    picker.style.display = open ? 'none' : 'grid';
    if (!open) {
      // Position next to the color button
      const btnRect = btn.getBoundingClientRect();
      const toolbarRect = _toolbar.getBoundingClientRect();
      picker.style.top = (btnRect.top - toolbarRect.top) + 'px';
    }
  });

  // Select color
  picker.addEventListener('click', (e) => {
    const swatch = e.target.closest('.wb-color-swatch');
    if (!swatch) return;
    _activeColor = swatch.dataset.color;
    dot.style.background = _activeColor;
    picker.querySelectorAll('.wb-color-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    picker.style.display = 'none';

    // Update selected element(s) color
    if (_selectedIds.size > 0) {
      for (const id of _selectedIds) {
        const el = _elements.find(e2 => e2.id === id);
        if (el) el.color = _activeColor;
      }
      renderAll();
      persistDebounced();
    }
  });

  // Close picker on outside click
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#wb-color-picker') && !e.target.closest('#wb-color-btn')) {
      picker.style.display = 'none';
    }
  });
}

function initSectionPicker() {
  const picker = document.getElementById('wb-section-picker');
  const btn = _toolbar?.querySelector('[data-tool="section"]');
  if (!picker || !btn) return;

  picker.innerHTML = Object.entries(SECTION_TYPES).map(([key, def]) =>
    `<button class="wb-section-btn${key === _activeSectionType ? ' active' : ''}" data-section="${key}">
       <span class="wb-section-icon" style="color:${def.color}">${def.icon}</span>
       <span class="wb-section-label-text">${def.label}</span>
     </button>`
  ).join('');

  picker.addEventListener('click', (e2) => {
    const sBtn = e2.target.closest('.wb-section-btn');
    if (!sBtn) return;
    _activeSectionType = sBtn.dataset.section;
    picker.querySelectorAll('.wb-section-btn').forEach(s => s.classList.remove('active'));
    sBtn.classList.add('active');
  });

  document.addEventListener('mousedown', (e2) => {
    if (!e2.target.closest('#wb-section-picker') && !e2.target.closest('[data-tool="section"]')) {
      picker.style.display = 'none';
    }
  });
}

const SHAPE_TYPES = [
  { key: 'rect',     label: 'Rectangle', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/></svg>' },
  { key: 'circle',   label: 'Circle',    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>' },
  { key: 'triangle', label: 'Triangle',  icon: '<svg viewBox="0 0 24 24"><path d="M12 4L22 20H2Z"/></svg>' },
];

function initShapePicker() {
  const picker = document.getElementById('wb-shape-picker');
  const btn = _toolbar?.querySelector('[data-tool="shape"]');
  if (!picker || !btn) return;

  picker.innerHTML = SHAPE_TYPES.map(s =>
    `<button class="wb-shape-btn${s.key === _activeShapeType ? ' active' : ''}" data-shape="${s.key}">
       ${s.icon}
       <span>${s.label}</span>
     </button>`
  ).join('');

  picker.addEventListener('click', (e2) => {
    const sBtn = e2.target.closest('.wb-shape-btn');
    if (!sBtn) return;
    _activeShapeType = sBtn.dataset.shape;
    picker.querySelectorAll('.wb-shape-btn').forEach(s => s.classList.remove('active'));
    sBtn.classList.add('active');
  });

  document.addEventListener('mousedown', (e2) => {
    if (!e2.target.closest('#wb-shape-picker') && !e2.target.closest('[data-tool="shape"]')) {
      picker.style.display = 'none';
    }
  });
}

// ═══════════════════════════════════════════
// TOOLBAR HANDLERS
// ═══════════════════════════════════════════

function onToolbarClick(e) {
  // Don't handle color picker clicks as tool clicks
  if (e.target.closest('#wb-color-btn') || e.target.closest('#wb-color-picker')) return;

  const btn = e.target.closest('.wb-tool');
  if (!btn) return;

  // Block drawing tools for guests without whiteboard permission
  if (isGuest() && !hasPermission('whiteboard') && btn.dataset.tool && btn.dataset.tool !== 'select') return;

  if (btn.dataset.tool) {
    setTool(btn.dataset.tool);
    if (_multiSelectMode) toggleMultiSelectMode(false);
    return;
  }

  const _wbGuestRO = isGuest() && !hasPermission('whiteboard');

  if (btn.id === 'wb-multiselect') {
    if (_wbGuestRO) return;
    toggleMultiSelectMode(!_multiSelectMode);
    return;
  }
  if (btn.id === 'wb-undo') { if (!_wbGuestRO) undo(); return; }
  if (btn.id === 'wb-redo') { if (!_wbGuestRO) redo(); return; }
  if (btn.id === 'wb-delete' && _selectedIds.size > 0) {
    if (_wbGuestRO) return;
    if (_selectedIds.size > 1) deleteMultipleElements([..._selectedIds]);
    else deleteElement(_selectedId);
    return;
  }
  if (btn.id === 'wb-toggle-logo') {
    const logo = document.querySelector('#static-bg .static-bg-logo');
    const breathe = document.querySelector('#static-bg .focus-breathe');
    const hidden = logo?.style.display !== 'none';
    if (logo) logo.style.display = hidden ? 'none' : '';
    if (breathe) breathe.style.display = hidden ? 'none' : '';
    btn.classList.toggle('active', hidden);
    sessionStorage.setItem('wb-logo-hidden', hidden ? '1' : '');
    return;
  }
}


// ═══════════════════════════════════════════
// PUBLIC API — WORKSPACE SNAPSHOTS
// ═══════════════════════════════════════════

export function getWhiteboardElementById(id) {
  return _elements.find(e => e.id === id) || null;
}

export function getWhiteboardSnapshot() {
  // Flush any in-progress edits so content is captured
  const editingText = _root?.querySelector('.wb-text.editing .wb-text-content');
  if (editingText) {
    const dom = editingText.closest('[data-wb-id]');
    if (dom) {
      const el = _elements.find(e => e.id === dom.dataset.wbId);
      if (el) el.content = editingText.textContent || '';
    }
  }
  return {
    elements: _elements.map(el => {
      const copy = { ...el };
      if (copy.points) copy.points = copy.points.map(p => [...p]);
      return copy;
    }),
    nextZIndex: _nextZIndex,
  };
}

export function restoreWhiteboardSnapshot(snap) {
  clearTimeout(_persistTimer);

  if (!snap) {
    clearWhiteboard();
    return;
  }
  _elements = (snap.elements || []).map(el => {
    // Migrate legacy arrow format (startX/endX → points)
    if (el.type === 'arrow' && !el.points && el.startX != null) {
      el.points = [[el.startX, el.startY], [el.endX, el.endY]];
      delete el.startX; delete el.startY; delete el.endX; delete el.endY;
      delete el.curvature;
    }
    return { ...el };
  });
  _nextZIndex = snap.nextZIndex || (_elements.length + 1);
  _undoStack = [];
  _redoStack = [];
  _selectedId = null;
  _selectedIds.clear();
  _arrowCreating = null;
  _sectionCreating = null;
  _clipboard = null;
  renderAll();
  persistDebounced();
}

export function clearWhiteboard() {
  _elements = [];
  _nextZIndex = 1;
  _undoStack = [];
  _redoStack = [];
  _selectedId = null;
  _selectedIds.clear();
  _arrowCreating = null;
  _sectionCreating = null;
  _clipboard = null;
  renderAll();
  persistDebounced();
}


export function addImageToWhiteboard(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const rect = _root?.getBoundingClientRect();
    const vw = rect?.width || 1200;
    const vh = rect?.height || 800;
    const dispW = Math.min(img.width, 400);
    const dispH = Math.round(img.height * (dispW / img.width));
    addElement({
      id: _genId(),
      type: 'image',
      x: (vw - dispW) / 2,
      y: (vh - dispH) / 2,
      width: dispW,
      height: dispH,
      dataUrl,
    });
  };
  img.src = url;
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

export function initWhiteboard() {
  _root = $('wb-root');
  _toolbar = $('wb-toolbar');
  _canvas = $('wb-canvas');
  _arrowsSvg = $('wb-arrows');
  _elementsDiv = $('wb-elements');
  _arrowPreview = $('wb-arrow-preview');

  // Create arrow creation hint element
  _arrowHint = document.createElement('div');
  _arrowHint.className = 'wb-arrow-hint';
  _arrowHint.innerHTML = 'click to add points &middot; <kbd>dbl-click</kbd> or <kbd>Enter</kbd> to finish';

  if (!_root) {
    console.warn('[whiteboard] #wb-root not found, skipping init');
    return;
  }

  // Make focusable so paste events work (and clicks steal focus from terminal)
  _root.setAttribute('tabindex', '-1');
  _root.style.outline = 'none';

  _root.appendChild(_arrowHint);

  // Load persisted state
  loadPersisted();
  renderAll();
  updateUndoButtons();

  // Mouse events
  _root.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  _root.addEventListener('dblclick', onDblClick);

  // Keyboard — capture phase so we fire before global keybinds
  document.addEventListener('keydown', onKeyDown, true);

  // Track Ctrl key for tool lock
  document.addEventListener('keydown', onCtrlTrack);
  document.addEventListener('keyup', onCtrlTrack);
  window.addEventListener('blur', () => { _toolLocked = false; updateLockIndicator(); });

  // Paste — listen on document (not _root) because _root can't receive focus
  // and paste events only fire on the focused element's ancestor chain.
  // The isWhiteboardActive() guard in onPaste prevents firing outside focus mode.
  document.addEventListener('paste', onPaste);

  // Toolbar
  if (_toolbar) _toolbar.addEventListener('click', onToolbarClick);

  // Color picker
  initColorPicker();

  // Shape picker
  initShapePicker();

  // Section picker
  initSectionPicker();

  // Prevent context menu on whiteboard
  _root.addEventListener('contextmenu', e => e.preventDefault());

  // Listen for workspace events
  on('whiteboard:restore', restoreWhiteboardSnapshot);
  on('whiteboard:clear', clearWhiteboard);

  // Auto-focus whiteboard when entering focus mode so Ctrl+V paste works immediately
  on('focus:enter', () => {
    setTimeout(() => _root.focus({ preventScroll: true }), 150);
    // Restore logo hidden state from session
    if (sessionStorage.getItem('wb-logo-hidden') === '1') {
      const logo = document.querySelector('#static-bg .static-bg-logo');
      const breathe = document.querySelector('#static-bg .focus-breathe');
      if (logo) logo.style.display = 'none';
      if (breathe) breathe.style.display = 'none';
      const btn = document.getElementById('wb-toggle-logo');
      if (btn) btn.classList.add('active');
    }
  });

  // Connect to server for external commands (Claude MCP)
  _connectWhiteboardWS();

  // ── Guest permission: disable drawing tools when whiteboard perm is off ──
  function updateWbPermVisual() {
    if (!_toolbar || !_canvas) return;
    const blocked = isGuest() && !hasPermission('whiteboard');
    // Disable all tool buttons except select
    _toolbar.querySelectorAll('.wb-tool[data-tool]').forEach(btn => {
      if (btn.dataset.tool === 'select') return;
      btn.style.opacity = blocked ? '0.35' : '';
      btn.style.pointerEvents = blocked ? 'none' : '';
    });
    // Disable multi-select, undo, redo, delete buttons
    ['wb-multiselect', 'wb-undo', 'wb-redo', 'wb-delete', 'wb-color-btn'].forEach(id => {
      const btn = $(id);
      if (btn) {
        btn.style.opacity = blocked ? '0.35' : '';
        btn.style.pointerEvents = blocked ? 'none' : '';
      }
    });
    // Block canvas interaction for drawing (keep pointer events for panning/viewing)
    if (blocked) {
      _canvas.style.cursor = 'default';
      setTool('select');
      if (_multiSelectMode) toggleMultiSelectMode(false);
    }
  }
  on('session:info', updateWbPermVisual);
  on('permissions:changed', updateWbPermVisual);
}


// ═══════════════════════════════════════════
// EXTERNAL COMMAND CHANNEL (WebSocket — Claude MCP ↔ Whiteboard)
// ═══════════════════════════════════════════

let _ws = null;
let _wsReconnectTimer = null;

function _connectWhiteboardWS() {
  if (_ws && _ws.readyState <= 1) return; // CONNECTING or OPEN

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${protocol}//${location.host}/ws/whiteboard`);

  _ws.onopen = () => {
    console.log('[whiteboard-ws] Connected');
    if (_wsReconnectTimer) { clearInterval(_wsReconnectTimer); _wsReconnectTimer = null; }
    // Report usable viewport dimensions (excluding navbar, toolbar, terminal) for MCP coordinate mapping
    if (_root) {
      const rect = _root.getBoundingClientRect();
      const titleBar = document.getElementById('title-bar');
      const toolbar = document.getElementById('wb-toolbar');
      const navH = titleBar ? titleBar.getBoundingClientRect().height : 0;
      const tbW = toolbar ? toolbar.getBoundingClientRect().right - rect.left + 12 : 60;
      _ws.send(JSON.stringify({ type: 'viewport', width: Math.round(rect.width - tbW), height: Math.round(rect.height - navH), yOffset: Math.round(navH), xOffset: Math.round(tbW) }));
    }
  };

  _ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      _handleExternalCommand(msg);
    } catch { /* ignore malformed */ }
  };

  _ws.onclose = () => {
    console.log('[whiteboard-ws] Disconnected, will reconnect in 5s');
    _ws = null;
    if (!_wsReconnectTimer) {
      _wsReconnectTimer = setInterval(_connectWhiteboardWS, 5000);
    }
  };

  _ws.onerror = () => {}; // onclose fires after
}

// Debounced viewport resize reporting
let _viewportResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_viewportResizeTimer);
  _viewportResizeTimer = setTimeout(() => {
    if (_ws && _ws.readyState === 1 && _root) {
      const rect = _root.getBoundingClientRect();
      const titleBar = document.getElementById('title-bar');
      const toolbar = document.getElementById('wb-toolbar');
      const navH = titleBar ? titleBar.getBoundingClientRect().height : 0;
      const tbW = toolbar ? toolbar.getBoundingClientRect().right - rect.left + 12 : 60;
      _ws.send(JSON.stringify({ type: 'viewport', width: Math.round(rect.width - tbW), height: Math.round(rect.height - navH), yOffset: Math.round(navH), xOffset: Math.round(tbW) }));
    }
  }, 300);
});

function _handleExternalCommand(msg) {
  switch (msg.type) {
    case 'init':
      break;

    case 'add':
      for (const el of (msg.elements || [])) {
        addElement(el, { skipPersist: true });
      }
      break;

    case 'update': {
      const el = _elements.find(e => e.id === msg.id);
      if (!el) break;
      const before = { ...el, points: el.points ? el.points.map(p => [...p]) : undefined };
      for (const [key, value] of Object.entries(msg.updates || {})) {
        if (key === 'id' || key === 'type') continue;
        el[key] = value;
      }
      pushUndo('edit', before, { ...el, points: el.points ? el.points.map(p => [...p]) : undefined });
      renderAll();
      break;
    }

    case 'remove': {
      const idx = _elements.findIndex(e => e.id === msg.id);
      if (idx < 0) break;
      const el = { ..._elements[idx] };
      _elements.splice(idx, 1);
      pushUndo('delete', el, null);
      _selectedIds.delete(msg.id);
      if (_selectedId === msg.id) _selectedId = null;
      renderAll();
      break;
    }

    case 'clear':
      _elements = [];
      _nextZIndex = 1;
      _undoStack = [];
      _redoStack = [];
      _selectedId = null;
      _selectedIds.clear();
      _arrowCreating = null;
      _sectionCreating = null;
      renderAll();
      break;

    case 'state:full':
      // Full state sync from another client — replace local state, save to localStorage only (no WS echo)
      _elements = msg.snapshot?.elements || [];
      _nextZIndex = msg.snapshot?.nextZIndex || 1;
      _selectedId = null;
      _selectedIds.clear();
      renderAll();
      storage.setItem(KEYS.WHITEBOARD, JSON.stringify({ elements: _elements, nextZIndex: _nextZIndex }));
      break;

    case 'screenshot:request':
      _captureScreenshot(msg.requestId);
      break;

    case 'screenshot:auto': {
      // macOS screenshot auto-paste — add image centered in viewport
      if (!msg.dataUrl) break;
      const img = new Image();
      img.onload = () => {
        const rect = _root?.getBoundingClientRect();
        const vw = rect?.width || 1200;
        const vh = rect?.height || 800;
        const dispW = Math.min(img.width, 400);
        const dispH = Math.round(img.height * (dispW / img.width));
        addElement({
          id: _genId(),
          type: 'image',
          x: (vw - dispW) / 2,
          y: (vh - dispH) / 2,
          width: dispW,
          height: dispH,
          dataUrl: msg.dataUrl,
        });
      };
      img.src = msg.dataUrl;
      break;
    }
  }
}

// ── Screenshot capture (renders whiteboard to canvas for Claude) ──

function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function _drawArrowhead(ctx, points) {
  if (points.length < 2) return;
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const angle = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
  const size = 20;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.moveTo(last[0], last[1]);
  ctx.lineTo(last[0] - size * Math.cos(angle - Math.PI / 6), last[1] - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(last[0] - size * Math.cos(angle + Math.PI / 6), last[1] - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

async function _captureScreenshot(requestId) {
  try {
    const canvas = document.createElement('canvas');
    const rootRect = _root.getBoundingClientRect();
    canvas.width = rootRect.width;
    canvas.height = rootRect.height;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Sort by zIndex for correct layering
    const sorted = [..._elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    for (const el of sorted) {
      ctx.save();

      if (el.rotation) {
        const cx = el.x + (el.width || 0) / 2;
        const cy = el.y + (el.height || 0) / 2;
        ctx.translate(cx, cy);
        ctx.rotate(el.rotation * Math.PI / 180);
        ctx.translate(-cx, -cy);
      }

      if (el.type === 'text') {
        const weight = el.bold ? '700' : '400';
        const style = el.italic ? 'italic ' : '';
        ctx.font = `${style}${weight} ${el.fontSize || 22}px Caveat, cursive`;
        ctx.fillStyle = el.color || 'rgba(255,255,255,0.85)';
        ctx.textBaseline = 'top';
        const lines = (el.content || '').split('\n');
        let lineY = el.y + 10;
        for (const line of lines) {
          ctx.fillText(line, el.x + 14, lineY);
          lineY += (el.fontSize || 22) * 1.35;
        }
      } else if (el.type === 'list') {
        const fs = el.fontSize || 18;
        ctx.font = `400 ${fs}px JetBrains Mono, monospace`;
        ctx.fillStyle = el.color || 'rgba(255,255,255,0.85)';
        ctx.textBaseline = 'top';
        const items = el.items && el.items.length ? el.items : [''];
        let lineY = el.y + 10;
        for (const item of items) {
          ctx.fillText('• ' + item, el.x + 14, lineY);
          lineY += fs * 1.5;
        }
      } else if (el.type === 'shape') {
        ctx.strokeStyle = el.color || 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const w = el.width || 160, h = el.height || 100;
        if (el.shape === 'circle' || el.shape === 'drawn-circle') {
          ctx.beginPath();
          ctx.ellipse(el.x + w / 2, el.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else if (el.shape === 'pill') {
          const r = Math.min(w, h) / 2;
          ctx.beginPath();
          ctx.roundRect(el.x, el.y, w, h, r);
          ctx.stroke();
        } else {
          ctx.strokeRect(el.x, el.y, w, h);
        }
      } else if (el.type === 'image' && el.dataUrl) {
        try {
          const img = await _loadImage(el.dataUrl);
          ctx.drawImage(img, el.x, el.y, el.width, el.height);
        } catch { /* skip broken images */ }
      } else if (el.type === 'arrow' && el.points && el.points.length >= 2) {
        ctx.strokeStyle = el.color || 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(el.points[0][0], el.points[0][1]);
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i][0], el.points[i][1]);
        }
        ctx.stroke();
        _drawArrowhead(ctx, el.points);
      } else if (el.type === 'pen' && el.points && el.points.length >= 2) {
        ctx.strokeStyle = el.color || 'rgba(255,255,255,0.7)';
        ctx.lineWidth = el.strokeWidth || 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(el.points[0][0], el.points[0][1]);
        for (let i = 1; i < el.points.length; i++) {
          ctx.lineTo(el.points[i][0], el.points[i][1]);
        }
        ctx.stroke();
      } else if (el.type === 'section') {
        const def = SECTION_TYPES[el.sectionType] || SECTION_TYPES.content;
        const color = el.color || def.color;
        const w = el.width || def.w;
        const h = el.height || def.h;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(el.x, el.y, w, h);
        ctx.setLineDash([]);
        ctx.fillStyle = color + '1a';
        ctx.fillRect(el.x, el.y, w, h);
        ctx.font = '28px sans-serif';
        ctx.fillStyle = color + '33';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.icon, el.x + w / 2, el.y + h / 2);
        ctx.font = '12px JetBrains Mono, monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(el.label || def.label, el.x + 8, el.y + 6);
        ctx.textAlign = 'start';
      }

      ctx.restore();
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];

    if (_ws && _ws.readyState === 1) {
      _ws.send(JSON.stringify({ type: 'screenshot:response', requestId, data: base64 }));
    }
  } catch (err) {
    console.error('[whiteboard] Screenshot capture failed:', err);
    if (_ws && _ws.readyState === 1) {
      _ws.send(JSON.stringify({ type: 'screenshot:error', requestId, error: err.message }));
    }
  }
}

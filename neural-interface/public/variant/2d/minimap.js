// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Minimap
// Small overview canvas with click-to-navigate
// Reads from graph.js viewport/card data
// Canvas: #minimap-canvas, container: #minimap
// ═══════════════════════════════════════════

import { state } from '../../shared/state.js';
import { catColor } from '../../shared/colors.js';
import { getViewport, getAllCards, getGraph } from './graph.js';
import { CARD_W, CARD_H } from './layout.js';

const $ = (id) => document.getElementById(id);

// ── Private state ──
let _minimapVisible = true;
let _minimapThrottle = 0;
let _minimapEl = null;
let _minimapCanvas = null;
let _minimapCtx = null;

// ── Drag state ──
let _dragging = false;
let _dragStartX = 0;
let _dragStartY = 0;
let _dragStartLeft = 0;
let _dragStartTop = 0;
let _dragMoved = false;

const MINIMAP_POS_KEY = 'synabun-2d-minimap-pos';

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the minimap canvas, click-to-navigate handler, and toggle button.
 * @param {object} _graphInstance  Unused — kept for API compatibility with main.js
 */
export function initMinimap(_graphInstance) {
  _minimapEl = $('minimap');
  _minimapCanvas = $('minimap-canvas');
  if (!_minimapCanvas) return;
  _minimapCtx = _minimapCanvas.getContext('2d');

  // Show minimap initially (starts visible)
  if (_minimapEl) {
    _minimapEl.classList.add('visible');
    _restorePosition();
  }

  // Click-to-navigate (only if user didn't drag)
  _minimapCanvas.addEventListener('click', (e) => {
    if (_dragMoved) return; // was a drag, not a click
    _onMinimapClick(e);
  });

  // Drag-to-reposition on the container
  if (_minimapEl) {
    _minimapEl.addEventListener('mousedown', _onDragStart);
    window.addEventListener('mousemove', _onDragMove);
    window.addEventListener('mouseup', _onDragEnd);
  }

  // Toggle button
  const toggleBtn = $('minimap-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      toggleMinimap();
    });
  }
}

// ═══════════════════════════════════════════
// DRAW
// ═══════════════════════════════════════════

/**
 * Draw the minimap showing all cards and the current viewport rectangle.
 * Throttled to max ~10fps (100ms interval).
 */
export function drawMinimap() {
  if (!_minimapVisible || _forcedHidden) return;
  const now = performance.now();
  if (now - _minimapThrottle < 100) return;
  _minimapThrottle = now;

  if (!_minimapCanvas || !_minimapCtx) return;
  const canvas = _minimapCanvas;
  const ctx = _minimapCtx;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cards = getAllCards();
  if (!cards.length) return;

  // Find bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const card of cards) {
    if (card.x < minX) minX = card.x;
    if (card.x > maxX) maxX = card.x;
    if (card.y < minY) minY = card.y;
    if (card.y > maxY) maxY = card.y;
  }

  const pad = 20;
  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;
  const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);

  const offsetX = (w - rangeX * scale) / 2;
  const offsetY = (h - rangeY * scale) / 2;

  // Draw cards as dots
  const selectedId = state.selectedNodeId;
  for (const card of cards) {
    const mx = (card.x - minX) * scale + offsetX;
    const my = (card.y - minY) * scale + offsetY;
    const color = catColor(card.node.payload?.category);
    ctx.fillStyle = card.node.id === selectedId ? '#fff' : color;
    ctx.beginPath();
    ctx.arc(mx, my, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw viewport rectangle (offset is in buffer coords, convert CSS to buffer)
  const vp = getViewport();
  const dpr = vp.dpr || 1;
  const vpWorldCenterX = (window.innerWidth * dpr / 2 - vp.offsetX) / vp.scale;
  const vpWorldCenterY = (window.innerHeight * dpr / 2 - vp.offsetY) / vp.scale;
  const vpW = window.innerWidth * dpr / vp.scale;
  const vpH = window.innerHeight * dpr / vp.scale;
  const vpX = (vpWorldCenterX - vpW / 2 - minX) * scale + offsetX;
  const vpY = (vpWorldCenterY - vpH / 2 - minY) * scale + offsetY;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(vpX, vpY, vpW * scale, vpH * scale);
}

// ═══════════════════════════════════════════
// CLICK-TO-NAVIGATE
// ═══════════════════════════════════════════

function _onMinimapClick(e) {
  if (!_minimapCanvas) return;
  const rect = _minimapCanvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const cards = getAllCards();
  if (!cards.length) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const card of cards) {
    if (card.x < minX) minX = card.x;
    if (card.x > maxX) maxX = card.x;
    if (card.y < minY) minY = card.y;
    if (card.y > maxY) maxY = card.y;
  }

  const w = _minimapCanvas.width, h = _minimapCanvas.height;
  const pad = 20;
  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;
  const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);
  const offsetX = (w - rangeX * scale) / 2;
  const offsetY = (h - rangeY * scale) / 2;

  const worldX = (clickX - offsetX) / scale + minX;
  const worldY = (clickY - offsetY) / scale + minY;

  const g = getGraph();
  if (g) g.centerAt(worldX, worldY, 500);
}

// ═══════════════════════════════════════════
// DRAG-TO-REPOSITION
// ═══════════════════════════════════════════

function _onDragStart(e) {
  // Only drag from the minimap border area or with middle mouse
  // Left-click inside canvas navigates, so drag from edges or holding Ctrl
  if (e.button !== 0) return;

  _dragging = true;
  _dragMoved = false;
  _dragStartX = e.clientX;
  _dragStartY = e.clientY;

  // Get current computed position
  const rect = _minimapEl.getBoundingClientRect();
  _dragStartLeft = rect.left;
  _dragStartTop = rect.top;

  e.preventDefault();
}

function _onDragMove(e) {
  if (!_dragging) return;

  const dx = e.clientX - _dragStartX;
  const dy = e.clientY - _dragStartY;

  // Only count as a drag if moved more than 4px (prevents accidental drag on click)
  if (!_dragMoved && Math.abs(dx) + Math.abs(dy) < 4) return;
  _dragMoved = true;

  const newLeft = _dragStartLeft + dx;
  const newTop = _dragStartTop + dy;

  // Clamp to viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = _minimapEl.offsetWidth;
  const mh = _minimapEl.offsetHeight;

  const clampedLeft = Math.max(0, Math.min(newLeft, vw - mw));
  const clampedTop = Math.max(0, Math.min(newTop, vh - mh));

  // Switch from right/bottom positioning to left/top for drag
  _minimapEl.style.right = 'auto';
  _minimapEl.style.bottom = 'auto';
  _minimapEl.style.left = clampedLeft + 'px';
  _minimapEl.style.top = clampedTop + 'px';
}

function _onDragEnd() {
  if (!_dragging) return;
  _dragging = false;
  if (_dragMoved) _savePosition();
  // _dragMoved stays true so the click handler can check it
  // Reset after a tick so the click event that follows mouseup sees it
  setTimeout(() => { _dragMoved = false; }, 0);
}

// ═══════════════════════════════════════════
// POSITION PERSISTENCE
// ═══════════════════════════════════════════

function _savePosition() {
  if (!_minimapEl) return;
  try {
    localStorage.setItem(MINIMAP_POS_KEY, JSON.stringify({
      left: _minimapEl.style.left,
      top: _minimapEl.style.top,
    }));
  } catch (_) { /* storage full or disabled */ }
}

function _restorePosition() {
  if (!_minimapEl) return;
  try {
    const raw = localStorage.getItem(MINIMAP_POS_KEY);
    if (!raw) return;
    const pos = JSON.parse(raw);
    if (!pos.left || !pos.top) return;

    // Validate the stored position is still within viewport
    const left = parseInt(pos.left, 10);
    const top = parseInt(pos.top, 10);
    if (isNaN(left) || isNaN(top)) return;

    const mw = _minimapEl.offsetWidth;
    const mh = _minimapEl.offsetHeight;
    const clampedLeft = Math.max(0, Math.min(left, window.innerWidth - mw));
    const clampedTop = Math.max(0, Math.min(top, window.innerHeight - mh));

    _minimapEl.style.right = 'auto';
    _minimapEl.style.bottom = 'auto';
    _minimapEl.style.left = clampedLeft + 'px';
    _minimapEl.style.top = clampedTop + 'px';
  } catch (_) { /* corrupted or missing */ }
}

// ═══════════════════════════════════════════
// TOGGLE
// ═══════════════════════════════════════════

export function toggleMinimap() {
  _minimapVisible = !_minimapVisible;
  if (_minimapEl) _minimapEl.classList.toggle('visible', _minimapVisible && !_forcedHidden);
  const btn = $('minimap-toggle-btn');
  if (btn) btn.classList.toggle('active', _minimapVisible);
}

export function isMinimapVisible() {
  return _minimapVisible;
}

// ── Force hide/show (focus mode) ──
// Hides the minimap DOM without changing the user's toggle preference.
// When focus mode exits, the minimap restores to its previous state.
let _forcedHidden = false;

export function forceHideMinimap() {
  _forcedHidden = true;
  if (_minimapEl) _minimapEl.classList.remove('visible');
}

export function restoreMinimap() {
  _forcedHidden = false;
  if (_minimapEl && _minimapVisible) _minimapEl.classList.add('visible');
}

/**
 * Update the graph instance reference (compatibility — no-op in new renderer).
 */
export function setGraph(_graphInstance) {
  // No-op — minimap reads from graph.js exports directly
}

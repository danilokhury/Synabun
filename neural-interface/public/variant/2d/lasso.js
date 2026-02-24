// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Lasso Selection
// Shift+drag rectangle selection on the canvas
// Adds matched cards to state.multiSelected
// Canvas: #lasso-canvas
// ═══════════════════════════════════════════

import { state, emit } from '../../shared/state.js';
import { updateMultiSelectBar } from '../../shared/ui-multiselect.js';
import { screenToWorld, getAllCards } from './graph.js';
import { CARD_W, CARD_H } from './layout.js';

const $ = (id) => document.getElementById(id);

// ── Private state ──
let _lassoActive = false;
let _lassoStart = null;
let _lassoEnd = null;
let _lassoCanvas = null;
let _lassoCtx = null;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize lasso selection system.
 * @param {object} _graphInstance  Unused — kept for API compatibility
 */
export function initLasso(_graphInstance) {
  _lassoCanvas = $('lasso-canvas');
  if (!_lassoCanvas) return;
  _lassoCtx = _lassoCanvas.getContext('2d');

  _lassoCanvas.width = window.innerWidth;
  _lassoCanvas.height = window.innerHeight;

  document.addEventListener('pointerdown', _onPointerDown);
  document.addEventListener('pointermove', _onPointerMove);
  document.addEventListener('pointerup', _onPointerUp);
  window.addEventListener('resize', _onResize);
}

// ═══════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════

function _onPointerDown(e) {
  if (!e.shiftKey || e.button !== 0) return;
  if (e.target.closest('#title-bar, #category-sidebar, .detail-card, #minimap, .glass')) return;
  _lassoActive = true;
  _lassoStart = { x: e.clientX, y: e.clientY };
  _lassoEnd = { x: e.clientX, y: e.clientY };
  e.preventDefault();
}

function _onPointerMove(e) {
  if (!_lassoActive) return;
  _lassoEnd = { x: e.clientX, y: e.clientY };

  // Draw selection rect
  _lassoCtx.clearRect(0, 0, _lassoCanvas.width, _lassoCanvas.height);
  const x = Math.min(_lassoStart.x, _lassoEnd.x);
  const y = Math.min(_lassoStart.y, _lassoEnd.y);
  const w = Math.abs(_lassoEnd.x - _lassoStart.x);
  const h = Math.abs(_lassoEnd.y - _lassoStart.y);
  _lassoCtx.strokeStyle = 'rgba(100, 180, 255, 0.6)';
  _lassoCtx.fillStyle = 'rgba(100, 180, 255, 0.08)';
  _lassoCtx.lineWidth = 1;
  _lassoCtx.fillRect(x, y, w, h);
  _lassoCtx.strokeRect(x, y, w, h);
}

function _onPointerUp() {
  if (!_lassoActive) return;
  _lassoActive = false;
  _lassoCtx.clearRect(0, 0, _lassoCanvas.width, _lassoCanvas.height);

  const x1 = Math.min(_lassoStart.x, _lassoEnd.x);
  const y1 = Math.min(_lassoStart.y, _lassoEnd.y);
  const x2 = Math.max(_lassoStart.x, _lassoEnd.x);
  const y2 = Math.max(_lassoStart.y, _lassoEnd.y);

  // Only select if drag was meaningful (> 10px in either direction)
  if (x2 - x1 < 10 && y2 - y1 < 10) return;

  // Convert screen rectangle corners to world coordinates
  const topLeft = screenToWorld(x1, y1);
  const bottomRight = screenToWorld(x2, y2);

  state.multiSelected.clear();

  const cards = getAllCards();
  for (const card of cards) {
    if (card.x >= topLeft.x && card.x <= bottomRight.x &&
        card.y >= topLeft.y && card.y <= bottomRight.y) {
      state.multiSelected.add(card.node.id);
    }
  }

  updateMultiSelectBar();
  emit('lasso:completed', { count: state.multiSelected.size });
}

// ═══════════════════════════════════════════
// CLEAR
// ═══════════════════════════════════════════

export function clearLasso() {
  _lassoActive = false;
  if (_lassoCtx && _lassoCanvas) {
    _lassoCtx.clearRect(0, 0, _lassoCanvas.width, _lassoCanvas.height);
  }
}

// ═══════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════

function _onResize() {
  if (!_lassoCanvas) return;
  _lassoCanvas.width = window.innerWidth;
  _lassoCanvas.height = window.innerHeight;
}

/**
 * Update the graph instance reference (compatibility — no-op).
 */
export function setGraph(_graphInstance) {
  // No-op
}

export function getLassoCanvas() {
  return _lassoCanvas;
}

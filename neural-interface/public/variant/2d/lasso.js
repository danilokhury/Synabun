// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Lasso Selection
// Shift+drag rectangle selection on the canvas
// Adds matched nodes to state.multiSelected
// Canvas: #lasso-canvas
// ═══════════════════════════════════════════

import { state, emit, on } from '../../shared/state.js';
import { updateMultiSelectBar } from '../../shared/ui-multiselect.js';

const $ = (id) => document.getElementById(id);

// ── Private state ──
let _lassoActive = false;
let _lassoStart = null;
let _lassoEnd = null;
let _lassoCanvas = null;
let _lassoCtx = null;
let _graph = null;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize lasso selection system.
 * Sets up the lasso canvas overlay, pointer event listeners for
 * shift+drag rectangle drawing, and pointerup hit-testing against
 * graph nodes.
 * @param {object} graphInstance  The force-graph 2D instance
 */
export function initLasso(graphInstance) {
  _graph = graphInstance;
  _lassoCanvas = $('lasso-canvas');
  if (!_lassoCanvas) return;
  _lassoCtx = _lassoCanvas.getContext('2d');

  _lassoCanvas.width = window.innerWidth;
  _lassoCanvas.height = window.innerHeight;

  // ── Pointer events ──

  document.addEventListener('pointerdown', _onPointerDown);
  document.addEventListener('pointermove', _onPointerMove);
  document.addEventListener('pointerup', _onPointerUp);

  // Handle window resize
  window.addEventListener('resize', _onResize);
}

// ═══════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════

/**
 * Start lasso on Shift+left-click (skip if clicking UI elements).
 */
function _onPointerDown(e) {
  if (!e.shiftKey || e.button !== 0) return;
  if (e.target.closest('#title-bar, #category-sidebar, .detail-card, #minimap, .glass')) return;
  _lassoActive = true;
  _lassoStart = { x: e.clientX, y: e.clientY };
  _lassoEnd = { x: e.clientX, y: e.clientY };
  e.preventDefault();
}

/**
 * Draw the selection rectangle while dragging.
 */
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

/**
 * Finish lasso: hit-test all visible nodes against the selection
 * rectangle, populate state.multiSelected, and update the bar.
 */
function _onPointerUp(e) {
  if (!_lassoActive) return;
  _lassoActive = false;
  _lassoCtx.clearRect(0, 0, _lassoCanvas.width, _lassoCanvas.height);

  if (!_graph) return;
  const x1 = Math.min(_lassoStart.x, _lassoEnd.x);
  const y1 = Math.min(_lassoStart.y, _lassoEnd.y);
  const x2 = Math.max(_lassoStart.x, _lassoEnd.x);
  const y2 = Math.max(_lassoStart.y, _lassoEnd.y);

  // Only select if drag was meaningful (> 10px in either direction)
  if (x2 - x1 < 10 && y2 - y1 < 10) return;

  const zoom = _graph.zoom();
  const center = _graph.centerAt();
  state.multiSelected.clear();

  const gd = _graph.graphData();
  gd.nodes.forEach(n => {
    if (n.payload._isAnchor || n.payload._isTag) return;
    const sx = (n.x - center.x) * zoom + window.innerWidth / 2;
    const sy = (n.y - center.y) * zoom + window.innerHeight / 2;
    if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) {
      state.multiSelected.add(n.id);
    }
  });

  updateMultiSelectBar();
  emit('lasso:completed', { count: state.multiSelected.size });
}

// ═══════════════════════════════════════════
// CLEAR
// ═══════════════════════════════════════════

/**
 * Clear any active lasso selection and hide the overlay.
 */
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
 * Update the graph instance reference (e.g. after graph rebuild).
 * @param {object} graphInstance
 */
export function setGraph(graphInstance) {
  _graph = graphInstance;
}

/**
 * Get the lasso canvas element (for external resize coordination).
 * @returns {HTMLCanvasElement|null}
 */
export function getLassoCanvas() {
  return _lassoCanvas;
}

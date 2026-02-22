// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Minimap
// Small overview canvas with click-to-navigate
// Canvas: #minimap-canvas, container: #minimap
// ═══════════════════════════════════════════

import { state, emit, on } from '../../shared/state.js';
import { catColor } from '../../shared/colors.js';

const $ = (id) => document.getElementById(id);

// ── Private state ──
let _minimapVisible = true;
let _minimapThrottle = 0;
let _minimapEl = null;
let _minimapCanvas = null;
let _minimapCtx = null;
let _graph = null;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the minimap canvas, click-to-navigate handler, and toggle button.
 * @param {object} graphInstance  The force-graph instance
 */
export function initMinimap(graphInstance) {
  _graph = graphInstance;
  _minimapEl = $('minimap');
  _minimapCanvas = $('minimap-canvas');
  if (!_minimapCanvas) return;
  _minimapCtx = _minimapCanvas.getContext('2d');

  // Click-to-navigate
  _minimapCanvas.addEventListener('click', _onMinimapClick);

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
 * Draw the minimap showing all nodes and the current viewport rectangle.
 * Throttled to max ~10fps (100ms interval).
 * Called from graph's onRenderFramePost callback.
 */
export function drawMinimap() {
  if (!_minimapVisible || !_graph) return;
  const now = performance.now();
  if (now - _minimapThrottle < 100) return; // Max ~10fps
  _minimapThrottle = now;

  if (!_minimapCanvas || !_minimapCtx) return;
  const canvas = _minimapCanvas;
  const ctx = _minimapCtx;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const gd = _graph.graphData();
  if (!gd.nodes.length) return;

  // Find bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  gd.nodes.forEach(n => {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  });

  const pad = 20;
  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;
  const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);

  const offsetX = (w - rangeX * scale) / 2;
  const offsetY = (h - rangeY * scale) / 2;

  // Draw nodes
  const selectedId = state.selectedNodeId;
  gd.nodes.forEach(n => {
    const mx = (n.x - minX) * scale + offsetX;
    const my = (n.y - minY) * scale + offsetY;
    const color = catColor(n.payload.category);
    ctx.fillStyle = n.id === selectedId ? '#fff' : color;
    ctx.beginPath();
    ctx.arc(mx, my, n.payload._isAnchor ? 3 : 1.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Draw viewport rectangle
  const graphCenter = _graph.centerAt();
  const zoom = _graph.zoom();
  const vpW = window.innerWidth / zoom;
  const vpH = window.innerHeight / zoom;
  const vpX = (graphCenter.x - vpW / 2 - minX) * scale + offsetX;
  const vpY = (graphCenter.y - vpH / 2 - minY) * scale + offsetY;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(vpX, vpY, vpW * scale, vpH * scale);

  if (_minimapEl) _minimapEl.classList.toggle('visible', true);
}

// ═══════════════════════════════════════════
// CLICK-TO-NAVIGATE
// ═══════════════════════════════════════════

/**
 * Handle click on the minimap — translate minimap coordinates to graph coordinates
 * and center the graph view at that position.
 * @param {MouseEvent} e
 */
function _onMinimapClick(e) {
  if (!_graph || !_minimapCanvas) return;
  const rect = _minimapCanvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const gd = _graph.graphData();
  if (!gd.nodes.length) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  gd.nodes.forEach(n => {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  });

  const w = _minimapCanvas.width, h = _minimapCanvas.height;
  const pad = 20;
  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;
  const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);
  const offsetX = (w - rangeX * scale) / 2;
  const offsetY = (h - rangeY * scale) / 2;

  const graphX = (clickX - offsetX) / scale + minX;
  const graphY = (clickY - offsetY) / scale + minY;
  _graph.centerAt(graphX, graphY, 500);
}

// ═══════════════════════════════════════════
// TOGGLE
// ═══════════════════════════════════════════

/**
 * Toggle minimap visibility on/off.
 * Updates the container visibility class and the toggle button active state.
 */
export function toggleMinimap() {
  _minimapVisible = !_minimapVisible;
  if (_minimapEl) _minimapEl.classList.toggle('visible', _minimapVisible);
  const btn = $('minimap-toggle-btn');
  if (btn) btn.classList.toggle('active', _minimapVisible);
}

/**
 * Get whether the minimap is currently visible.
 * @returns {boolean}
 */
export function isMinimapVisible() {
  return _minimapVisible;
}

/**
 * Update the graph instance reference (e.g. after graph rebuild).
 * @param {object} graphInstance
 */
export function setGraph(graphInstance) {
  _graph = graphInstance;
}

// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Category Hulls
// Convex hull overlays around category clusters
// Canvas: #hull-canvas
// ═══════════════════════════════════════════

import { gfx } from './gfx.js';
import { state, emit, on } from '../../shared/state.js';
import { catColor, hexAlpha } from '../../shared/colors.js';

const $ = (id) => document.getElementById(id);

// ── Private state ──
let _hullsVisible = true;
let _hullThrottle = 0;
let _hullCanvas = null;
let _hullCtx = null;
let _graph = null;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize hull overlay canvas and toggle button.
 * @param {object} graphInstance  The force-graph instance
 */
export function initHulls(graphInstance) {
  _graph = graphInstance;
  _hullCanvas = $('hull-canvas');
  if (!_hullCanvas) return;
  _hullCtx = _hullCanvas.getContext('2d');

  _hullCanvas.width = window.innerWidth;
  _hullCanvas.height = window.innerHeight;

  // Toggle button
  const toggleBtn = $('hull-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      toggleHulls();
    });
  }

  // Handle window resize
  window.addEventListener('resize', _onResize);
}

// ═══════════════════════════════════════════
// DRAW
// ═══════════════════════════════════════════

/**
 * Draw convex hulls around category clusters.
 * Throttled to max ~2fps (500ms interval).
 * Called from graph's onRenderFramePost callback.
 */
export function drawHulls() {
  if (!_hullsVisible || !_graph) {
    if (_hullCanvas && _hullCtx) {
      _hullCtx.clearRect(0, 0, _hullCanvas.width, _hullCanvas.height);
    }
    return;
  }
  const now = performance.now();
  if (now - _hullThrottle < 500) return;
  _hullThrottle = now;

  if (!_hullCanvas || !_hullCtx) return;

  _hullCanvas.width = window.innerWidth;
  _hullCanvas.height = window.innerHeight;
  const ctx = _hullCtx;
  ctx.clearRect(0, 0, _hullCanvas.width, _hullCanvas.height);

  const gd = _graph.graphData();
  const zoom = _graph.zoom();
  const center = _graph.centerAt();

  // Group nodes by category (skip anchors and tags)
  const catGroups = {};
  gd.nodes.forEach(n => {
    if (n.payload._isAnchor || n.payload._isTag) return;
    const cat = n.payload.category;
    if (!catGroups[cat]) catGroups[cat] = [];
    catGroups[cat].push(n);
  });

  // Convert graph coords to screen coords
  function toScreen(gx, gy) {
    return {
      x: (gx - center.x) * zoom + window.innerWidth / 2,
      y: (gy - center.y) * zoom + window.innerHeight / 2,
    };
  }

  for (const [cat, nodes] of Object.entries(catGroups)) {
    if (nodes.length < 3) continue;
    const color = catColor(cat);

    // Convert to screen points
    const points = nodes.map(n => toScreen(n.x, n.y));

    // Compute convex hull
    const hull = convexHull(points);
    if (hull.length < 3) continue;

    // Draw hull with padding
    ctx.beginPath();
    const pad = 20 * zoom;
    const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length;
    const cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;

    hull.forEach((p, i) => {
      const dx = p.x - cx, dy = p.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const px = p.x + (dx / dist) * pad;
      const py = p.y + (dy / dist) * pad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = hexAlpha(color, gfx.hullOpacity);
    ctx.strokeStyle = hexAlpha(color, gfx.hullOpacity * 2.5);
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // Category label at centroid
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = hexAlpha(color, 0.5);
    ctx.textAlign = 'center';
    ctx.fillText(cat, cx, cy);
  }
}

// ═══════════════════════════════════════════
// CONVEX HULL (Graham scan)
// ═══════════════════════════════════════════

/**
 * Compute the convex hull of a set of 2D points using Graham scan.
 * @param {Array<{x:number, y:number}>} points
 * @returns {Array<{x:number, y:number}>} Hull vertices in order
 */
function convexHull(points) {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// ═══════════════════════════════════════════
// TOGGLE
// ═══════════════════════════════════════════

/**
 * Toggle hull visibility on/off.
 * Updates the toggle button active state and clears the canvas when hiding.
 */
export function toggleHulls() {
  _hullsVisible = !_hullsVisible;
  const btn = $('hull-toggle-btn');
  if (btn) btn.classList.toggle('active', _hullsVisible);
  if (!_hullsVisible && _hullCanvas && _hullCtx) {
    _hullCtx.clearRect(0, 0, _hullCanvas.width, _hullCanvas.height);
  }
}

/**
 * Get whether hulls are currently visible.
 * @returns {boolean}
 */
export function isHullsVisible() {
  return _hullsVisible;
}

// ═══════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════

function _onResize() {
  if (!_hullCanvas) return;
  _hullCanvas.width = window.innerWidth;
  _hullCanvas.height = window.innerHeight;
}

/**
 * Update the graph instance reference (e.g. after graph rebuild).
 * @param {object} graphInstance
 */
export function setGraph(graphInstance) {
  _graph = graphInstance;
}

/**
 * Get the hull canvas element (for external resize coordination).
 * @returns {HTMLCanvasElement|null}
 */
export function getHullCanvas() {
  return _hullCanvas;
}

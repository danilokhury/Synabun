// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Background Canvas
// Dot grid pattern + flow line animations
// Canvas: #bg-canvas
// ═══════════════════════════════════════════

import { gfx } from './gfx.js';
import { state, emit, on } from '../../shared/state.js';

const $ = (id) => document.getElementById(id);

// ── Private state ──
let _bgAnimId = null;
const _flowLines = [];
let _bgCanvas = null;
let _bgCtx = null;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the background canvas, generate flow lines, and start animation.
 * Call once after DOM is ready.
 */
export function initBackground() {
  _bgCanvas = $('bg-canvas');
  if (!_bgCanvas) return;
  _bgCtx = _bgCanvas.getContext('2d');

  _bgCanvas.width = window.innerWidth;
  _bgCanvas.height = window.innerHeight;

  // Generate flow lines
  _flowLines.length = 0;
  for (let i = 0; i < 7; i++) {
    _flowLines.push({
      points: [
        { x: Math.random() * _bgCanvas.width, y: Math.random() * _bgCanvas.height },
        { x: Math.random() * _bgCanvas.width, y: Math.random() * _bgCanvas.height },
        { x: Math.random() * _bgCanvas.width, y: Math.random() * _bgCanvas.height },
        { x: Math.random() * _bgCanvas.width, y: Math.random() * _bgCanvas.height },
      ],
      speed: 0.0002 + Math.random() * 0.0003,
      offset: Math.random() * Math.PI * 2,
    });
  }

  // Start animation loop
  _bgAnimId = requestAnimationFrame(_drawBg);

  // Handle window resize
  window.addEventListener('resize', _onResize);
}

// ═══════════════════════════════════════════
// DRAW
// ═══════════════════════════════════════════

/**
 * Internal animation frame callback — draws background fill, dot grid, and flow lines.
 * @param {number} time  requestAnimationFrame timestamp
 */
function _drawBg(time) {
  if (!_bgCanvas || !_bgCtx) return;
  const ctx = _bgCtx;
  const w = _bgCanvas.width;
  const h = _bgCanvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#050808';
  ctx.fillRect(0, 0, w, h);

  // Dot grid
  if (gfx.bgDotGrid) {
    const spacing = 32;
    ctx.fillStyle = 'rgba(74, 90, 122, 0.07)';
    for (let x = spacing; x < w; x += spacing) {
      for (let y = spacing; y < h; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Flow lines
  ctx.strokeStyle = 'rgba(74, 90, 122, 0.025)';
  ctx.lineWidth = 1;
  for (const line of _flowLines) {
    const t = time * line.speed + line.offset;
    const pts = line.points;
    ctx.beginPath();
    const sx = pts[0].x + Math.sin(t) * 30;
    const sy = pts[0].y + Math.cos(t * 0.7) * 20;
    ctx.moveTo(sx, sy);
    for (let i = 1; i < pts.length; i++) {
      const px = pts[i].x + Math.sin(t + i) * 25;
      const py = pts[i].y + Math.cos(t * 0.8 + i) * 15;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  _bgAnimId = requestAnimationFrame(_drawBg);
}

/**
 * Force a single background redraw (non-looping).
 * Useful after settings change.
 */
export function drawBackground() {
  if (_bgAnimId) return; // already running
  _bgAnimId = requestAnimationFrame(_drawBg);
}

/**
 * Start the background animation loop if not already running.
 */
export function animateBackground() {
  if (_bgAnimId) return;
  _bgAnimId = requestAnimationFrame(_drawBg);
}

/**
 * Stop the background animation loop.
 */
export function stopBackground() {
  if (_bgAnimId) {
    cancelAnimationFrame(_bgAnimId);
    _bgAnimId = null;
  }
}

// ═══════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════

/**
 * Handle window resize — update canvas dimensions.
 */
function _onResize() {
  if (!_bgCanvas) return;
  _bgCanvas.width = window.innerWidth;
  _bgCanvas.height = window.innerHeight;
}

/**
 * Get the background canvas element (for external resize coordination).
 * @returns {HTMLCanvasElement|null}
 */
export function getBgCanvas() {
  return _bgCanvas;
}

// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Background
// Focus Mode aesthetic: dark radial gradient,
// SynaBun logo watermark, breathing animation
// Drawn as first layer in the main canvas render loop
// ═══════════════════════════════════════════

import { gfx } from './gfx.js';

// ── Private state ──
let _logoBitmap = null;
let _logoLoading = false;

// Cached background gradient (recreated only on resize)
let _bgGrad = null;
let _bgGradW = 0;
let _bgGradH = 0;

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the background — preload the SynaBun logo.
 * Call once after DOM is ready.
 */
export function initBackground() {
  if (_logoLoading || _logoBitmap) return;
  _logoLoading = true;

  const img = new Image();
  img.onload = () => {
    _logoBitmap = img;
    _logoLoading = false;
  };
  img.onerror = () => {
    _logoLoading = false;
  };
  img.src = '/synabun.png?v=2';
}

// ═══════════════════════════════════════════
// DRAW (called each frame by graph.js)
// ═══════════════════════════════════════════

/**
 * Draw the background onto the main canvas context.
 * Called in screen-space (before any pan/zoom transforms).
 *
 * @param {CanvasRenderingContext2D} ctx  The main canvas context
 * @param {number} time  requestAnimationFrame timestamp (ms)
 * @param {number} w     Canvas pixel width
 * @param {number} h     Canvas pixel height
 */
export function drawBackground(ctx, time, w, h) {
  // ── 1. Dark radial gradient (cached — recreated only on resize) ──
  if (!_bgGrad || _bgGradW !== w || _bgGradH !== h) {
    const maxDim = Math.max(w, h);
    _bgGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, maxDim * 0.7);
    _bgGrad.addColorStop(0, '#0e1218');
    _bgGrad.addColorStop(1, '#070709');
    _bgGradW = w;
    _bgGradH = h;
  }
  ctx.fillStyle = _bgGrad;
  ctx.fillRect(0, 0, w, h);

  // ── 2. Breathing animation ──
  if (gfx.bgBreathingEnabled) {
    const phase = (Math.sin(time * 0.001 * (2 * Math.PI / 4)) + 1) / 2; // 4-second cycle
    const breatheScale = 1 + phase * 0.15;
    const breatheAlpha = 0.4 + phase * 0.3;
    const breatheR = 150 * breatheScale;

    const breatheGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, breatheR);
    breatheGrad.addColorStop(0, `rgba(100, 140, 200, ${(0.06 * breatheAlpha).toFixed(4)})`);
    breatheGrad.addColorStop(1, 'rgba(100, 140, 200, 0)');
    ctx.fillStyle = breatheGrad;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, breatheR, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── 3. SynaBun logo watermark (disabled for 2D canvas view) ──
  // if (gfx.bgLogoVisible && _logoBitmap) {
  //   const logoH = 80;
  //   const logoW = _logoBitmap.naturalWidth * (logoH / _logoBitmap.naturalHeight);
  //   ctx.save();
  //   ctx.globalAlpha = 0.18;
  //   ctx.filter = 'grayscale(0.3)';
  //   ctx.drawImage(_logoBitmap, w / 2 - logoW / 2, h / 2 - logoH / 2, logoW, logoH);
  //   ctx.restore();
  // }
}

// ═══════════════════════════════════════════
// LIFECYCLE (compatibility with main.js)
// ═══════════════════════════════════════════

/**
 * Stop background (no-op — background is drawn by graph.js render loop).
 */
export function stopBackground() {
  // No-op: background is drawn as part of the main render loop.
  // When viz is toggled off, the render loop stops, stopping the background too.
}

/**
 * Resume background animation (no-op — controlled by render loop).
 */
export function animateBackground() {
  // No-op
}

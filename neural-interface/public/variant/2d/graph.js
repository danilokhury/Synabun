// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Canvas Renderer
// Pure canvas rendering with orbital layout,
// viewport pan/zoom, hit detection, drag system
// ═══════════════════════════════════════════

import { gfx } from './gfx.js';
import { computeLayout, resetLayout, flattenRegions, CARD_W, CARD_H } from './layout.js';
import { drawBackground, initBackground } from './background.js';
import { state, emit, on } from '../../shared/state.js';
import { catColor, hexAlpha } from '../../shared/colors.js';
import { KEYS } from '../../shared/constants.js';
import { storage } from '../../shared/storage.js';
import { truncate, normalizeNodes } from '../../shared/utils.js';

// ═══════════════════════════════════════════
// PRIVATE STATE
// ═══════════════════════════════════════════

let _canvas = null;
let _ctx = null;
let _container = null;
let _animFrameId = null;
let _callbacks = {};

// Layout data
let _regions = [];       // CategoryRegion[] from computeLayout
let _cards = [];         // CardPosition[] from computeLayout
let _cardById = new Map(); // id → CardPosition

// Category logo preload cache
const _categoryLogos = new Map();

// Fallback logo for OpenClaw (hardcoded like 3D variant)
const _openclawLogo = new Image();
_openclawLogo.src = '/openclaw-logo-text.png';
let _openclawLogoReady = false;
_openclawLogo.onload = () => { _openclawLogoReady = true; };

// Graph removal scheduling
let _graphRemovalTimer = null;

// ═══════════════════════════════════════════
// PERFORMANCE CACHES
// ═══════════════════════════════════════════

// Neighbor adjacency map: id → Set<id> — built once in applyGraphData
let _neighborMap = new Map();

// Card text cache: nodeId → { content, lines }
const _textCache = new Map();

// DPR for high-DPI rendering (capped to limit fill rate on high-DPI displays)
const MAX_DPR = 1.5;
let _dpr = 1;

// ═══════════════════════════════════════════
// VIEWPORT (pan/zoom state)
// ═══════════════════════════════════════════

const _viewport = {
  offsetX: 0,
  offsetY: 0,
  scale: 0.4,
  minScale: 0.02,
  maxScale: 3.0,
};

// Animation state
let _animating = false;
let _animStart = 0;
let _animDuration = 0;
let _animFrom = {};
let _animTo = {};

// Smooth zoom state — lerps toward target for fluid feel
const _smoothZoom = {
  targetScale: 0.4,
  anchorX: 0,      // cursor position in buffer coords (zoom pivot)
  anchorY: 0,
  active: false,
};

// ═══════════════════════════════════════════
// INTERACTION STATE
// ═══════════════════════════════════════════

const _pointer = {
  isPanning: false,
  isDragging: false,
  dragTarget: null,      // { type: 'card'|'region', item: CardPosition|Region }
  dragSet: [],           // items moving together (rigid-body)
  dragStartWorld: null,   // world coords at drag start
  lastScreenX: 0,
  lastScreenY: 0,
  downScreenX: 0,
  downScreenY: 0,
  lastMoveTime: 0,       // for velocity tracking
  downTime: 0,
  hasMoved: false,
};

// Position save timer
let _posSaveTimer = null;

// Pan inertia — coasting after mouse release
const _panInertia = {
  vx: 0,
  vy: 0,
  active: false,
};

// ═══════════════════════════════════════════
// COORDINATE TRANSFORMS
// ═══════════════════════════════════════════

export function screenToWorld(sx, sy) {
  return {
    x: (sx * _dpr - _viewport.offsetX) / _viewport.scale,
    y: (sy * _dpr - _viewport.offsetY) / _viewport.scale,
  };
}

export function worldToScreen(wx, wy) {
  return {
    x: (wx * _viewport.scale + _viewport.offsetX) / _dpr,
    y: (wy * _viewport.scale + _viewport.offsetY) / _dpr,
  };
}

/**
 * Get the visible world-space bounding box (with margin for partially visible items).
 * @param {number} margin  Extra world-space pixels around the viewport edges
 * @returns {{ left: number, right: number, top: number, bottom: number }}
 */
function _getVisibleBounds(margin = 0) {
  const invScale = 1 / _viewport.scale;
  const left   = -_viewport.offsetX * invScale - margin;
  const top    = -_viewport.offsetY * invScale - margin;
  const right  = (_canvas.width - _viewport.offsetX) * invScale + margin;
  const bottom = (_canvas.height - _viewport.offsetY) * invScale + margin;
  return { left, right, top, bottom };
}

// ═══════════════════════════════════════════
// PUBLIC API: Viewport accessors
// ═══════════════════════════════════════════

export function getViewport() { return { ..._viewport, dpr: _dpr }; }
export function getAllCards() { return _cards; }
export function getRegions() { return _regions; }


// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

/**
 * Initialize the 2D canvas renderer.
 * @param {HTMLElement} container  The #graph-container element
 * @param {Object} callbacks      { onRenderFramePost }
 * @returns {Object}  Public API shim (centerAt, zoom, etc.)
 */
export function initGraph(container, callbacks = {}) {
  _container = container;
  _callbacks = callbacks;

  // Create or find the main canvas
  _canvas = document.getElementById('canvas-main');
  if (!_canvas) {
    _canvas = document.createElement('canvas');
    _canvas.id = 'canvas-main';
    _canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:1;';
    container.appendChild(_canvas);
  }
  _ctx = _canvas.getContext('2d');

  // Size canvas (DPR-aware, capped for perf)
  _dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  _resizeCanvas();

  // Center viewport
  _viewport.offsetX = _canvas.width / 2;
  _viewport.offsetY = _canvas.height / 2;
  _smoothZoom.targetScale = _viewport.scale;

  // Attach event listeners
  _canvas.addEventListener('pointerdown', _onPointerDown);
  _canvas.addEventListener('pointermove', _onPointerMove);
  _canvas.addEventListener('pointerup', _onPointerUp);
  _canvas.addEventListener('pointerleave', _onPointerLeave);
  _canvas.addEventListener('wheel', _onWheel, { passive: false });
  _canvas.addEventListener('dblclick', _onDblClick);
  _canvas.addEventListener('contextmenu', _onContextMenu);
  window.addEventListener('resize', _resizeCanvas);

  // Start render loop
  _animFrameId = requestAnimationFrame(_renderLoop);

  // Init background (logo preload)
  initBackground();

  return _getPublicAPI();
}

/**
 * Get the public API object (force-graph compatible shim).
 * @returns {Object|null}
 */
export function getGraph() {
  if (!_canvas) return null;
  return _getPublicAPI();
}


// ═══════════════════════════════════════════
// PUBLIC API: Data & Layout
// ═══════════════════════════════════════════

/**
 * Apply graph data: filters by activeCategories, runs layout, updates render state.
 * Call after data load, category change, or search change.
 */
export function applyGraphData() {
  if (!_canvas) return;

  // Filter nodes by active categories
  const visibleNodes = state.allNodes.filter(n => {
    const cat = n.payload?.category;
    return cat && state.activeCategories.has(cat);
  });

  // Compute orbital layout
  const result = computeLayout(visibleNodes, state.categoryMetadata, state.activeCategories);
  _regions = result.regions;
  _cards = result.cards;

  // Build card lookup
  _cardById.clear();
  for (const card of _cards) {
    _cardById.set(card.node.id, card);
  }

  // Build neighbor adjacency map (O(links) once, not O(links) per card per frame)
  _neighborMap.clear();
  for (const link of state.allLinks) {
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    if (!_neighborMap.has(s)) _neighborMap.set(s, new Set());
    if (!_neighborMap.has(t)) _neighborMap.set(t, new Set());
    _neighborMap.get(s).add(t);
    _neighborMap.get(t).add(s);
  }

  // Clear text cache (content may have changed)
  _textCache.clear();

  // Preload category logos
  const cats = [];
  for (const [name, meta] of Object.entries(state.categoryMetadata)) {
    if (meta.logo) cats.push({ name, logo: meta.logo });
  }
  preloadCategoryLogos(cats);

  emit('stats-changed');
}

/**
 * Preload category logo images from metadata.
 * @param {Array<{name:string, logo:string}>} categories
 */
export function preloadCategoryLogos(categories) {
  const names = new Set(categories.map(c => c.name));
  for (const [k] of _categoryLogos) { if (!names.has(k)) _categoryLogos.delete(k); }
  for (const cat of categories) {
    if (!cat.logo) continue;
    const existing = _categoryLogos.get(cat.name);
    if (existing && existing.src === cat.logo) continue;
    const img = new Image();
    const entry = { img, ready: false, src: cat.logo };
    img.onload = () => { entry.ready = true; };
    img.onerror = () => { _categoryLogos.delete(cat.name); };
    img.src = cat.logo;
    _categoryLogos.set(cat.name, entry);
  }
}

/**
 * Re-fetch data from API and re-apply layout.
 */
export async function refreshGraph() {
  const res = await fetch('/api/memories');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.allNodes = normalizeNodes(data.nodes);
  state.allLinks = data.links;
  applyGraphData();
  emit('data-loaded', data);
}

/**
 * Re-compute layout from scratch (replaces reheatSimulation).
 */
export function reheatSimulation() {
  resetLayout();
  applyGraphData();
}

/**
 * Schedule a deferred graph data reapply (after deletion animation).
 */
export function scheduleGraphRemoval(delay = 500) {
  cancelScheduledRemoval();
  _graphRemovalTimer = setTimeout(() => {
    applyGraphData();
    _graphRemovalTimer = null;
  }, delay);
}

export function cancelScheduledRemoval() {
  if (_graphRemovalTimer) {
    clearTimeout(_graphRemovalTimer);
    _graphRemovalTimer = null;
  }
}


// ═══════════════════════════════════════════
// RENDER LOOP
// ═══════════════════════════════════════════

function _renderLoop(time) {
  if (!_canvas || !_ctx) return;
  const w = _canvas.width;
  const h = _canvas.height;
  const ctx = _ctx;

  // Process viewport animation
  if (_animating) {
    const elapsed = time - _animStart;
    const t = Math.min(elapsed / _animDuration, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad

    _viewport.offsetX = _animFrom.offsetX + (_animTo.offsetX - _animFrom.offsetX) * ease;
    _viewport.offsetY = _animFrom.offsetY + (_animTo.offsetY - _animFrom.offsetY) * ease;
    _viewport.scale = _animFrom.scale + (_animTo.scale - _animFrom.scale) * ease;

    if (t >= 1) {
      _animating = false;
      _smoothZoom.targetScale = _viewport.scale;
      _smoothZoom.active = false;
    }
  }

  // Process smooth zoom (lerp toward target scale with cursor as pivot)
  if (_smoothZoom.active) {
    const LERP = 0.18;
    const diff = _smoothZoom.targetScale - _viewport.scale;
    if (Math.abs(diff) < 0.0001) {
      _viewport.scale = _smoothZoom.targetScale;
      _smoothZoom.active = false;
    } else {
      const newScale = _viewport.scale + diff * LERP;
      const mx = _smoothZoom.anchorX;
      const my = _smoothZoom.anchorY;
      _viewport.offsetX = mx - (mx - _viewport.offsetX) * (newScale / _viewport.scale);
      _viewport.offsetY = my - (my - _viewport.offsetY) * (newScale / _viewport.scale);
      _viewport.scale = newScale;
    }
  }

  // Process pan inertia (coasting after mouse release)
  if (_panInertia.active) {
    const FRICTION = 0.92;
    _viewport.offsetX += _panInertia.vx;
    _viewport.offsetY += _panInertia.vy;
    _panInertia.vx *= FRICTION;
    _panInertia.vy *= FRICTION;
    if (Math.abs(_panInertia.vx) < 0.1 && Math.abs(_panInertia.vy) < 0.1) {
      _panInertia.active = false;
    }
  }

  // ── Compute visible world bounds (with margin for partially visible items) ──
  const cardMargin = Math.max(CARD_W, CARD_H);
  const vb = _getVisibleBounds(cardMargin);

  // ── LOD thresholds (card screen-space size in CSS pixels) ──
  const cardScreenW = CARD_W * _viewport.scale / _dpr;
  // LOD 0: full card (cardScreenW >= 25px)
  // LOD 1: simple colored rect (12-25px)
  // LOD 2: tiny dot (< 12px)
  const lod = cardScreenW >= 25 ? 0 : cardScreenW >= 12 ? 1 : 2;

  // ── 1. Background (screen-space) ──
  drawBackground(ctx, time, w, h);

  // ── 2. Apply pan/zoom transform ──
  ctx.save();
  ctx.translate(_viewport.offsetX, _viewport.offsetY);
  ctx.scale(_viewport.scale, _viewport.scale);

  // ── 3. Category region glows (culled, skip at LOD 2) ──
  if (gfx.regionGlowOpacity > 0 && lod < 2) {
    for (const region of _regions) {
      if (_isRegionVisible(region, vb)) _drawRegionGlow(ctx, region);
      for (const child of (region.children || [])) {
        if (_isRegionVisible(child, vb)) _drawRegionGlow(ctx, child);
      }
    }
  }

  // ── 4. Connection lines (batched + culled, skip at LOD 2) ──
  if (state.linkMode !== 'off' && state.allLinks.length > 0 && lod < 2) {
    _drawLinks(ctx, vb);
  }

  // ── 5. Memory cards (LOD-aware + culled) ──
  if (lod === 2) {
    // LOD 2: tiny dots — batch into single path per color for speed
    _drawCardDots(ctx, vb);
  } else if (lod === 1) {
    // LOD 1: simple colored rectangles, no text/shadows
    _drawCardSimple(ctx, vb);
  } else {
    // LOD 0: full detail
    for (const card of _cards) {
      if (card.x + CARD_W / 2 < vb.left || card.x - CARD_W / 2 > vb.right ||
          card.y + CARD_H / 2 < vb.top  || card.y - CARD_H / 2 > vb.bottom) continue;
      _drawCard(ctx, card);
    }
  }

  // ── 6. Category labels (LOD-aware + culled) ──
  // Child labels hidden at LOD >= 1 (zoomed out too far to be useful)
  // Child labels fade near the LOD boundary for smooth transition
  const childLabelOpacity = lod >= 1 ? 0 : Math.min(1, (cardScreenW - 25) / 15); // fade 25→40px
  for (const region of _regions) {
    if (_isRegionVisible(region, vb)) _drawCategoryLabel(ctx, region, true, 1);
    if (childLabelOpacity > 0) {
      for (const child of (region.children || [])) {
        if (_isRegionVisible(child, vb)) _drawCategoryLabel(ctx, child, false, childLabelOpacity);
      }
    }
  }

  ctx.restore();

  // ── 7. Post-render callback (minimap, etc.) ──
  if (_callbacks.onRenderFramePost) {
    _callbacks.onRenderFramePost();
  }
  emit('render-frame-post');

  _animFrameId = requestAnimationFrame(_renderLoop);
}

/** Check if a region's bounding circle is within the visible bounds */
function _isRegionVisible(region, vb) {
  const r = (region.radius || 200) + 100; // extra margin for glow/labels
  return region.cx + r > vb.left && region.cx - r < vb.right &&
         region.cy + r > vb.top  && region.cy - r < vb.bottom;
}


// ═══════════════════════════════════════════
// DRAWING: Region Glow
// ═══════════════════════════════════════════

function _drawRegionGlow(ctx, region) {
  if (!region.radius || region.radius <= 0) return;
  const r = region.radius + 40;
  const grad = ctx.createRadialGradient(region.cx, region.cy, 0, region.cx, region.cy, r);
  grad.addColorStop(0, hexAlpha(region.color, gfx.regionGlowOpacity));
  grad.addColorStop(1, hexAlpha(region.color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(region.cx, region.cy, r, 0, Math.PI * 2);
  ctx.fill();
}


// ═══════════════════════════════════════════
// DRAWING: Category Labels
// ═══════════════════════════════════════════

function _drawCategoryLabel(ctx, region, isParent, labelOpacity = 1) {
  // Respect label visibility toggle
  if (!state.labelsVisible) return;

  const mul = state.labelSizeMultiplier || 1;
  const logoEntry = _categoryLogos.get(region.name);
  // Fall back to hardcoded OpenClaw logo if no uploaded logo
  const hasLogo = (logoEntry && logoEntry.ready) || (region.name === 'openclaw' && _openclawLogoReady);
  const logoImg = (logoEntry && logoEntry.ready) ? logoEntry.img : _openclawLogo;

  // ── Zoom compensation: ensure labels stay readable at any zoom ──
  // Capped at 2.5x to prevent labels from growing larger than the gaps between categories
  const MAX_ZOOM_BOOST = isParent ? 2.5 : 2.0;
  const MIN_SCREEN_PX = isParent ? 18 : 13;
  const baseFontSize = isParent ? 38 : 22;
  const rawFontSize = baseFontSize * mul;
  const screenPx = rawFontSize * _viewport.scale / _dpr;
  const zoomBoost = screenPx < MIN_SCREEN_PX
    ? Math.min(MIN_SCREEN_PX / screenPx, MAX_ZOOM_BOOST)
    : 1;

  // Apply label opacity (for child label fade-out at zoom boundaries)
  const needsOpacity = labelOpacity < 1;
  if (needsOpacity) {
    ctx.save();
    ctx.globalAlpha = labelOpacity;
  }

  if (isParent) {
    // ── PARENT: logo-first if available, clean text otherwise ──
    const fontSize = Math.round(38 * mul * zoomBoost);
    const nameText = region.name.toUpperCase();

    // Subtle glow ring
    ctx.save();
    const glowR = 70 * mul * zoomBoost;
    const grad = ctx.createRadialGradient(region.cx, region.cy, glowR * 0.3, region.cx, region.cy, glowR);
    grad.addColorStop(0, hexAlpha(region.color, 0.12));
    grad.addColorStop(1, hexAlpha(region.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(region.cx, region.cy, glowR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    let cursorY = region.cy; // tracks vertical stacking position

    if (hasLogo) {
      // Logo with its own zoom compensation (independent of text zoomBoost)
      // Logos are the primary identifier so they need a higher cap and their own min screen size
      const BASE_LOGO_H = 64 * mul;
      const MIN_LOGO_SCREEN = 32;  // minimum screen pixels for parent logo
      const logoScreenH = BASE_LOGO_H * _viewport.scale / _dpr;
      const logoBoost = logoScreenH < MIN_LOGO_SCREEN
        ? Math.min(MIN_LOGO_SCREEN / logoScreenH, 5.0)
        : 1;
      const logoH = Math.round(BASE_LOGO_H * logoBoost);
      const aspect = (logoImg.naturalWidth || 1) / (logoImg.naturalHeight || 1);
      const logoW = Math.round(logoH * aspect);
      const logoY = region.cy - logoH / 2;
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.drawImage(logoImg,
        region.cx - logoW / 2, logoY,
        logoW, logoH
      );
      ctx.restore();
      cursorY = logoY + logoH + 6;
    } else {
      // No logo — glass pill behind text
      ctx.font = `bold ${fontSize}px 'Space Grotesk', 'Inter', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Measure text to size the glass pill
      const textW = ctx.measureText(nameText).width;
      const padX = fontSize * 0.6;
      const padY = fontSize * 0.4;

      // Memory count text (compute now so pill can encompass both)
      const count = region.memories ? region.memories.length : 0;
      const childCount = (region.children || []).reduce((sum, c) => sum + (c.memories ? c.memories.length : 0), 0);
      const total = count + childCount;
      const subSize = Math.round(fontSize * 0.45);
      const countText = total > 0 ? `${total} ${total === 1 ? 'memory' : 'memories'}` : '';
      const countH = total > 0 ? subSize + padY * 0.5 : 0;

      const pillW = textW + padX * 2;
      const pillH = fontSize + padY * 2 + countH;
      const pillX = region.cx - pillW / 2;
      const pillY = cursorY - fontSize / 2 - padY;
      const pillR = Math.min(14, pillH / 2);

      // Glass pill — diffuse color-tinted glassmorphic
      ctx.save();
      const col = region.color;

      // Colored diffuse glow behind pill
      ctx.shadowColor = hexAlpha(col, 0.3);
      ctx.shadowBlur = 44;
      _roundRect(ctx, pillX, pillY, pillW, pillH, pillR);
      ctx.fillStyle = 'rgba(4, 5, 8, 0.92)';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Color-tinted inner wash
      _roundRect(ctx, pillX, pillY, pillW, pillH, pillR);
      ctx.fillStyle = hexAlpha(col, 0.1);
      ctx.fill();

      // Top highlight edge
      const hlGrad = ctx.createLinearGradient(pillX, pillY, pillX, pillY + pillH * 0.35);
      hlGrad.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
      hlGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      _roundRect(ctx, pillX, pillY, pillW, pillH * 0.35, pillR);
      ctx.fillStyle = hlGrad;
      ctx.fill();

      // Color-tinted border
      _roundRect(ctx, pillX, pillY, pillW, pillH, pillR);
      ctx.strokeStyle = hexAlpha(col, 0.2);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.restore();

      // Draw name text
      ctx.font = `bold ${fontSize}px 'Space Grotesk', 'Inter', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = region.color;
      ctx.fillText(nameText, region.cx, cursorY);
      cursorY += fontSize * 0.5 + 4;

      // Memory count inside the pill
      if (total > 0) {
        ctx.font = `500 ${subSize}px 'Inter', sans-serif`;
        ctx.fillStyle = hexAlpha(region.color, 0.5);
        ctx.fillText(countText, region.cx, cursorY + subSize * 0.7);
      }
    }

    // Memory count below (only for logo path — text path handles it inside the pill)
    if (hasLogo) {
      const count = region.memories ? region.memories.length : 0;
      const childCount = (region.children || []).reduce((sum, c) => sum + (c.memories ? c.memories.length : 0), 0);
      const total = count + childCount;
      if (total > 0) {
        const fontSize2 = Math.round(38 * mul * zoomBoost);
        const subSize = Math.round(fontSize2 * 0.45);
        ctx.font = `500 ${subSize}px 'Inter', sans-serif`;
        ctx.fillStyle = hexAlpha(region.color, 0.5);
        ctx.fillText(`${total} ${total === 1 ? 'memory' : 'memories'}`, region.cx, cursorY + subSize * 0.7);
      }
    }

  } else {
    // ── CHILD: smaller, simpler ──
    const fontSize = Math.round(22 * mul * zoomBoost);
    const nameText = region.name.toUpperCase();

    let cursorY = region.cy;

    if (hasLogo) {
      // Logo with its own zoom compensation (independent of text zoomBoost)
      const BASE_LOGO_H = 32 * mul;
      const MIN_LOGO_SCREEN = 20;  // minimum screen pixels for child logo
      const logoScreenH = BASE_LOGO_H * _viewport.scale / _dpr;
      const logoBoost = logoScreenH < MIN_LOGO_SCREEN
        ? Math.min(MIN_LOGO_SCREEN / logoScreenH, 4.0)
        : 1;
      const logoH = Math.round(BASE_LOGO_H * logoBoost);
      const aspect = (logoImg.naturalWidth || 1) / (logoImg.naturalHeight || 1);
      const logoW = Math.round(logoH * aspect);
      const logoY = region.cy - logoH / 2;
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.drawImage(logoImg,
        region.cx - logoW / 2, logoY,
        logoW, logoH
      );
      ctx.restore();
      cursorY = logoY + logoH + 4;
    } else {
      // No logo — glass pill behind text
      ctx.font = `600 ${fontSize}px 'Space Grotesk', 'Inter', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const textW = ctx.measureText(nameText).width;
      const padX = fontSize * 0.5;
      const padY = fontSize * 0.35;

      // Count text
      const count = region.memories ? region.memories.length : 0;
      const subSize = Math.round(fontSize * 0.5);
      const countH = count > 0 ? subSize + padY * 0.4 : 0;

      const pillW = textW + padX * 2;
      const pillH = fontSize + padY * 2 + countH;
      const pillX = region.cx - pillW / 2;
      const pillY = cursorY - fontSize / 2 - padY;
      const pillR = Math.min(10, pillH / 2);

      // Glass pill — diffuse color-tinted glassmorphic
      ctx.save();
      const col = region.color;

      // Colored diffuse glow
      ctx.shadowColor = hexAlpha(col, 0.25);
      ctx.shadowBlur = 30;
      _roundRect(ctx, pillX, pillY, pillW, pillH, pillR);
      ctx.fillStyle = 'rgba(4, 5, 8, 0.88)';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Color-tinted inner wash
      _roundRect(ctx, pillX, pillY, pillW, pillH, pillR);
      ctx.fillStyle = hexAlpha(col, 0.08);
      ctx.fill();

      // Color-tinted border
      _roundRect(ctx, pillX, pillY, pillW, pillH, pillR);
      ctx.strokeStyle = hexAlpha(col, 0.18);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      // Name text
      ctx.font = `600 ${fontSize}px 'Space Grotesk', 'Inter', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = hexAlpha(region.color, 0.8);
      ctx.fillText(nameText, region.cx, cursorY);
      cursorY += fontSize * 0.5 + 4;

      // Count inside pill
      if (count > 0) {
        ctx.font = `500 ${subSize}px 'Inter', sans-serif`;
        ctx.fillStyle = hexAlpha(region.color, 0.4);
        ctx.fillText(`${count}`, region.cx, cursorY + subSize * 0.6);
      }
    }

    // Memory count (only for logo path)
    if (hasLogo) {
      const count = region.memories ? region.memories.length : 0;
      if (count > 0) {
        const subSize = Math.round(fontSize * 0.5);
        ctx.font = `500 ${subSize}px 'Inter', sans-serif`;
        ctx.fillStyle = hexAlpha(region.color, 0.4);
        ctx.fillText(`${count}`, region.cx, cursorY + subSize * 0.6);
      }
    }
  }

  if (needsOpacity) ctx.restore();
}


// Pre-computed card background fill style (used by LOD 0, 1, and 2 drawing functions)
const _cardBgFill = `rgba(15, 18, 25, ${gfx.cardOpacity})`;


// ═══════════════════════════════════════════
// DRAWING: LOD 2 — Dots (zoomed far out)
// ═══════════════════════════════════════════

/**
 * Draw all visible cards as tiny colored dots, batched by color.
 * At LOD 2, cards are ~2px circles — no text, no shadows, no borders.
 * Groups by category color for minimal state changes (one fillStyle + fill per color).
 */
function _drawCardDots(ctx, vb) {
  const hasSearch = state.searchResults !== null;
  // Group visible cards by color
  const byColor = new Map();
  for (const card of _cards) {
    if (card.x < vb.left || card.x > vb.right ||
        card.y < vb.top  || card.y > vb.bottom) continue;
    // Skip non-matching cards during search
    if (hasSearch && !state.searchResults.has(card.node.id)) continue;
    const color = catColor(card.node.payload?.category || '');
    let list = byColor.get(color);
    if (!list) { list = []; byColor.set(color, list); }
    list.push(card);
  }

  const TWO_PI = Math.PI * 2;
  for (const [color, cards] of byColor) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const card of cards) {
      const dotR = hasSearch && state.searchResults.has(card.node.id) ? 5 : 3;
      ctx.moveTo(card.x + dotR, card.y);
      ctx.arc(card.x, card.y, dotR, 0, TWO_PI);
    }
    ctx.fill();
  }
}


// ═══════════════════════════════════════════
// DRAWING: LOD 1 — Simple Rects (medium zoom)
// ═══════════════════════════════════════════

/**
 * Draw visible cards as simple colored rectangles — no text, no shadows, no font rendering.
 * Much faster than full cards but still shows shape and color coding.
 */
function _drawCardSimple(ctx, vb) {
  const halfW = CARD_W / 2;
  const halfH = CARD_H / 2;
  const selectedId = state.selectedNodeId;
  const hasSearch = state.searchResults !== null;

  for (const card of _cards) {
    if (card.x + halfW < vb.left || card.x - halfW > vb.right ||
        card.y + halfH < vb.top  || card.y - halfH > vb.bottom) continue;
    // Skip non-matching cards during search
    if (hasSearch && !state.searchResults.has(card.node.id)) continue;

    const isMatch = hasSearch && state.searchResults.has(card.node.id);
    const scale = isMatch ? 1.3 : 1;
    const w = CARD_W * scale;
    const h = CARD_H * scale;
    const x = card.x - w / 2;
    const y = card.y - h / 2;
    const color = catColor(card.node.payload?.category || '');

    // Card background
    ctx.fillStyle = _cardBgFill;
    ctx.fillRect(x, y, w, h);

    // Left color bar (thicker at this LOD for visibility)
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 4, h);

    // Selection or search highlight
    if (card.node.id === selectedId || isMatch) {
      ctx.strokeStyle = color;
      ctx.lineWidth = isMatch ? 1.5 : 2;
      ctx.strokeRect(x, y, w, h);
    }
  }
}


// ═══════════════════════════════════════════
// DRAWING: LOD 0 — Full Detail Cards
// ═══════════════════════════════════════════

function _drawCard(ctx, card) {
  const node = card.node;
  const cat = node.payload?.category || '';
  const color = catColor(cat);
  const importance = node.payload?.importance || 5;
  const content = node.payload?.content || '';
  const isSelected = node.id === state.selectedNodeId;
  const isHovered = node.id === state.hoveredNodeId;
  const isMultiSelected = state.multiSelected.has(node.id);

  // Opacity for search/focus dimming — use pre-built neighbor map (O(1) lookup)
  let opacity = 1;
  const isSearchMatch = state.searchResults && state.searchResults.has(node.id);
  const isSearchMiss = state.searchResults && !isSearchMatch;
  if (isSearchMiss) return; // Vanish non-matching memories during search
  if (isSearchMatch) opacity = 1; // Full brightness for matches
  if (state.focusedNodeId && state.focusedNodeId !== node.id) {
    const neighbors = _neighborMap.get(state.focusedNodeId);
    if (neighbors && neighbors.has(node.id)) opacity = 0.7;
    else opacity = 0.15;
  }
  if (opacity < 0.05) return;

  // Search matches get scaled up
  const searchScale = isSearchMatch ? 1.3 : 1;
  const scaledW = CARD_W * searchScale;
  const scaledH = CARD_H * searchScale;
  const x = card.x - scaledW / 2;
  const y = card.y - scaledH / 2;
  const needsShadow = isHovered || isSelected || isMultiSelected || isSearchMatch;

  // Only save/restore when we actually change global state
  if (opacity < 1 || needsShadow) {
    ctx.save();
    ctx.globalAlpha = opacity;
  }

  // ── Hover glow (shadow) ──
  if (isSearchMatch && !isHovered && !isSelected) {
    ctx.shadowColor = hexAlpha(color, 0.7);
    ctx.shadowBlur = 14;
  } else if (needsShadow) {
    ctx.shadowColor = isSelected ? color : hexAlpha(color, 0.6);
    ctx.shadowBlur = isSelected ? 16 : 10;
  }

  // ── Card background ──
  _roundRect(ctx, x, y, scaledW, scaledH, 8);
  ctx.fillStyle = _cardBgFill;
  ctx.fill();

  // Reset shadow after fill (only if set)
  if (needsShadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }

  // ── Selection/hover border ──
  if (isSelected || isMultiSelected) {
    _roundRect(ctx, x, y, scaledW, scaledH, 8);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (isHovered) {
    _roundRect(ctx, x, y, scaledW, scaledH, 8);
    ctx.strokeStyle = hexAlpha(color, 0.4);
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (isSearchMatch) {
    _roundRect(ctx, x, y, scaledW, scaledH, 8);
    ctx.strokeStyle = hexAlpha(color, 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ── Left color bar (simplified — no clip needed for 3px bar) ──
  ctx.fillStyle = color;
  ctx.fillRect(x, y + 8, 3, scaledH - 16);

  // ── Category label ──
  ctx.font = "bold 8px 'Inter', sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(cat.toUpperCase(), x + 8, y + 6);

  // ── Content preview (cached text wrapping) ──
  ctx.font = "10px 'Inter', sans-serif";
  ctx.fillStyle = 'rgba(200, 206, 220, 0.85)';
  const lines = _getWrappedText(ctx, node.id, content, scaledW - 16, 3);
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + 8, y + 20 + i * 13);
  }

  // ── Importance stars ──
  if (importance > 0) {
    ctx.font = "8px 'Inter', sans-serif";
    ctx.fillStyle = 'rgba(255, 200, 50, 0.6)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const stars = importance <= 5 ? '\u2606'.repeat(importance) : '\u2605'.repeat(Math.min(importance, 10));
    ctx.fillText(stars, x + scaledW - 6, y + scaledH - 4);
  }

  // ── Pin indicator ──
  if (card.pinned) {
    ctx.font = "9px sans-serif";
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('\uD83D\uDCCC', x + scaledW - 4, y + 4);
  }

  if (opacity < 1 || needsShadow) {
    ctx.restore();
  }
}

/**
 * Get cached wrapped text lines for a card.
 * Only re-wraps when content changes.
 */
function _getWrappedText(ctx, nodeId, content, maxWidth, maxLines) {
  const cached = _textCache.get(nodeId);
  if (cached && cached.content === content) return cached.lines;
  const lines = _wrapText(ctx, content, maxWidth, maxLines);
  _textCache.set(nodeId, { content, lines });
  return lines;
}


// ═══════════════════════════════════════════
// DRAWING: Links
// ═══════════════════════════════════════════

function _drawLinks(ctx, vb) {
  ctx.strokeStyle = `rgba(100, 140, 200, ${gfx.linkOpacity})`;
  ctx.lineWidth = 0.5;

  // Batch all visible links into a single path — one stroke() call instead of 43k
  ctx.beginPath();
  const isIntra = state.linkMode === 'intra';

  for (const link of state.allLinks) {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    const sourceCard = _cardById.get(sourceId);
    const targetCard = _cardById.get(targetId);
    if (!sourceCard || !targetCard) continue;

    // Viewport cull: skip if both endpoints are off-screen
    if (vb) {
      const sx = sourceCard.x, sy = sourceCard.y, tx = targetCard.x, ty = targetCard.y;
      if ((sx < vb.left && tx < vb.left) || (sx > vb.right && tx > vb.right) ||
          (sy < vb.top && ty < vb.top)   || (sy > vb.bottom && ty > vb.bottom)) continue;
    }

    // Filter by link mode
    if (isIntra) {
      const sCat = sourceCard.node.payload?.category;
      const tCat = targetCard.node.payload?.category;
      if (sCat !== tCat) continue;
    }

    // Hide links where both endpoints are not search matches
    if (state.searchResults !== null) {
      if (!state.searchResults.has(sourceId) && !state.searchResults.has(targetId)) continue;
    }

    ctx.moveTo(sourceCard.x, sourceCard.y);
    ctx.lineTo(targetCard.x, targetCard.y);
  }
  ctx.stroke();
}


// ═══════════════════════════════════════════
// DRAWING HELPERS
// ═══════════════════════════════════════════

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function _wrapText(ctx, text, maxWidth, maxLines) {
  const words = (text || '').replace(/\n/g, ' ').split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line + (line ? ' ' : '') + word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      if (lines.length >= maxLines) {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/...$/, '') + '\u2026';
        return lines;
      }
      line = word;
    } else {
      line = test;
    }
  }
  if (line) {
    if (lines.length >= maxLines) {
      lines[lines.length - 1] += '\u2026';
    } else {
      lines.push(line);
    }
  }
  return lines;
}


// ═══════════════════════════════════════════
// HIT DETECTION
// ═══════════════════════════════════════════

function _hitTest(screenX, screenY) {
  const { x, y } = screenToWorld(screenX, screenY);

  // Check cards (reverse order = topmost first)
  for (let i = _cards.length - 1; i >= 0; i--) {
    const card = _cards[i];
    if (x >= card.x - CARD_W / 2 && x <= card.x + CARD_W / 2 &&
        y >= card.y - CARD_H / 2 && y <= card.y + CARD_H / 2) {
      return { type: 'card', item: card, node: card.node };
    }
  }

  // Check category labels — hit zone scales with label size + zoom compensation
  const allRegions = flattenRegions(_regions);
  const mul = state.labelSizeMultiplier || 1;
  for (const region of allRegions) {
    if (!state.labelsVisible) {
      // Labels hidden — small dot hit zone so categories are still clickable
      if (x >= region.cx - 30 && x <= region.cx + 30 &&
          y >= region.cy - 30 && y <= region.cy + 30) {
        return { type: 'region', item: region };
      }
    } else {
      // Compute zoom compensation to match rendered size (capped, same as _drawCategoryLabel)
      const MAX_ZOOM_BOOST = region.isParent ? 2.5 : 2.0;
      const baseFontSize = region.isParent ? 38 : 22;
      const MIN_SCREEN_PX = region.isParent ? 18 : 13;
      const rawFontSize = baseFontSize * mul;
      const screenPx = rawFontSize * _viewport.scale / _dpr;
      const zoomBoost = screenPx < MIN_SCREEN_PX
        ? Math.min(MIN_SCREEN_PX / screenPx, MAX_ZOOM_BOOST)
        : 1;

      const fontSize = Math.round(baseFontSize * mul * zoomBoost);
      const hasLogo = _categoryLogos.get(region.name)?.ready || (region.name === 'openclaw' && _openclawLogoReady);

      // Hit zone: logo width or text width + padding
      let labelW, labelH;
      if (hasLogo) {
        // Logo has its own zoom compensation (same as _drawCategoryLabel)
        const baseLogo = (region.isParent ? 64 : 32) * mul;
        const minLogoScreen = region.isParent ? 32 : 20;
        const logoScreen = baseLogo * _viewport.scale / _dpr;
        const logoBoost = logoScreen < minLogoScreen
          ? Math.min(minLogoScreen / logoScreen, region.isParent ? 5.0 : 4.0)
          : 1;
        const logoH = baseLogo * logoBoost;
        const logoW = logoH * 3; // conservative aspect estimate
        labelW = Math.max(logoW, 160) + 20;
        labelH = logoH + fontSize * 0.5 + 30;
      } else {
        // Match glass pill sizing: text width + padX on each side, fontSize + padY*2 + count height
        const nameText = region.name.toUpperCase();
        const approxTextW = fontSize * 0.65 * nameText.length;
        const padX = fontSize * (region.isParent ? 0.6 : 0.5);
        const padY = fontSize * (region.isParent ? 0.4 : 0.35);
        const countH = fontSize * 0.5; // always include count space for hit zone
        labelW = approxTextW + padX * 2 + 20; // extra margin for easier clicking
        labelH = fontSize + padY * 2 + countH + 20;
      }
      if (x >= region.cx - labelW / 2 && x <= region.cx + labelW / 2 &&
          y >= region.cy - labelH / 2 && y <= region.cy + labelH / 2) {
        return { type: 'region', item: region };
      }
    }
  }

  return null;
}


// ═══════════════════════════════════════════
// DRAG SYSTEM
// ═══════════════════════════════════════════

function _buildDragSet(hit) {
  const set = [];

  if (hit.type === 'card') {
    // If this card is part of a multi-selection, drag ALL selected cards
    if (state.multiSelected.size > 0 && state.multiSelected.has(hit.node.id)) {
      for (const card of _cards) {
        if (state.multiSelected.has(card.node.id)) {
          set.push({ type: 'card', ref: card });
        }
      }
    } else {
      // Just this card
      set.push({ type: 'card', ref: hit.item });
    }
  } else if (hit.type === 'region') {
    const region = hit.item;
    // The region label itself
    set.push({ type: 'region', ref: region });

    // All cards directly on this region
    for (const card of _cards) {
      const cat = card.node.payload?.category;
      if (cat === region.name) {
        set.push({ type: 'card', ref: card });
      }
    }

    // If parent, also include children + their cards
    if (region.isParent && region.children) {
      for (const child of region.children) {
        set.push({ type: 'region', ref: child });
        for (const card of _cards) {
          const cat = card.node.payload?.category;
          if (cat === child.name) {
            set.push({ type: 'card', ref: card });
          }
        }
      }
    }
  }

  return set;
}

function _applyDragDelta(dx, dy) {
  for (const item of _pointer.dragSet) {
    if (item.type === 'card') {
      item.ref.x += dx;
      item.ref.y += dy;
      item.ref.pinned = true;
    } else if (item.type === 'region') {
      item.ref.cx += dx;
      item.ref.cy += dy;
    }
  }
}


// ═══════════════════════════════════════════
// POSITION PERSISTENCE
// ═══════════════════════════════════════════

function _savePositions() {
  const positions = {};
  for (const card of _cards) {
    positions[card.node.id] = { x: card.x, y: card.y, pinned: card.pinned };
  }
  for (const region of flattenRegions(_regions)) {
    positions[`_cat_${region.name}`] = { x: region.cx, y: region.cy };
  }
  try { storage.setItem(KEYS.NODE_POS_2D, JSON.stringify(positions)); } catch (_) {}
}

function _schedulePositionSave() {
  if (_posSaveTimer) clearTimeout(_posSaveTimer);
  _posSaveTimer = setTimeout(_savePositions, 2000);
}


// ═══════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════

function _onPointerDown(e) {
  if (e.button !== 0) return; // left-click only
  // Skip if Shift (lasso mode handled by lasso.js)
  if (e.shiftKey) return;

  const hit = _hitTest(e.clientX, e.clientY);

  _pointer.downScreenX = e.clientX;
  _pointer.downScreenY = e.clientY;
  _pointer.lastScreenX = e.clientX;
  _pointer.lastScreenY = e.clientY;
  _pointer.downTime = performance.now();
  _pointer.lastMoveTime = performance.now();
  _pointer.hasMoved = false;
  _panInertia.active = false; // stop coasting on new interaction

  if (hit) {
    _pointer.isDragging = true;
    _pointer.isPanning = false;
    _pointer.dragTarget = hit;
    _pointer.dragSet = _buildDragSet(hit);
    _pointer.dragStartWorld = screenToWorld(e.clientX, e.clientY);
    _canvas.setPointerCapture(e.pointerId);
  } else {
    _pointer.isPanning = true;
    _pointer.isDragging = false;
    _pointer.dragTarget = null;
    _canvas.setPointerCapture(e.pointerId);
  }
}

const DRAG_THRESHOLD = 5; // pixels before drag/pan starts

function _onPointerMove(e) {
  // Check if we've exceeded the drag threshold before actually moving
  if ((_pointer.isPanning || _pointer.isDragging) && !_pointer.hasMoved) {
    const tdx = e.clientX - _pointer.downScreenX;
    const tdy = e.clientY - _pointer.downScreenY;
    if (Math.abs(tdx) < DRAG_THRESHOLD && Math.abs(tdy) < DRAG_THRESHOLD) return;
    _pointer.hasMoved = true;
  }

  if (_pointer.isPanning) {
    const dx = (e.clientX - _pointer.lastScreenX) * _dpr;
    const dy = (e.clientY - _pointer.lastScreenY) * _dpr;
    _viewport.offsetX += dx;
    _viewport.offsetY += dy;
    // Track velocity for inertia
    const now = performance.now();
    const dt = now - _pointer.lastMoveTime || 16;
    _panInertia.vx = dx / dt * 16; // normalize to ~60fps frame
    _panInertia.vy = dy / dt * 16;
    _pointer.lastMoveTime = now;
    _pointer.lastScreenX = e.clientX;
    _pointer.lastScreenY = e.clientY;
    // Kill any active inertia while dragging
    _panInertia.active = false;
  } else if (_pointer.isDragging) {
    const worldNow = screenToWorld(e.clientX, e.clientY);
    const worldPrev = screenToWorld(_pointer.lastScreenX, _pointer.lastScreenY);
    const dx = worldNow.x - worldPrev.x;
    const dy = worldNow.y - worldPrev.y;
    _applyDragDelta(dx, dy);
    _pointer.lastScreenX = e.clientX;
    _pointer.lastScreenY = e.clientY;
  } else {
    // Hover detection
    const hit = _hitTest(e.clientX, e.clientY);
    const newHoverId = (hit && hit.type === 'card') ? hit.node.id : null;
    if (newHoverId !== state.hoveredNodeId) {
      state.hoveredNodeId = newHoverId;
    }
    // Update cursor for both cards and regions
    _canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (newHoverId) emit('node-hover', hit.node);
    else if (!hit) emit('node-hover', null);
  }
}

function _onPointerUp(e) {
  const wasDragging = _pointer.isDragging;
  const wasPanning = _pointer.isPanning;
  const moved = _pointer.hasMoved;
  const elapsed = performance.now() - _pointer.downTime;

  _pointer.isPanning = false;
  _pointer.isDragging = false;
  _canvas.releasePointerCapture(e.pointerId);

  // Start pan inertia if we were panning and had velocity
  if (wasPanning && moved) {
    const speed = Math.sqrt(_panInertia.vx ** 2 + _panInertia.vy ** 2);
    if (speed > 0.5) {
      _panInertia.active = true;
    }
    return;
  }

  if (wasDragging && moved) {
    _schedulePositionSave();
    return;
  }

  // Click (no significant movement)
  if (!moved || elapsed < 200) {
    const hit = _hitTest(e.clientX, e.clientY);

    if (hit && hit.type === 'card') {
      // Ctrl/Cmd+Click: toggle multi-select (same as 3D variant)
      if (e.ctrlKey || e.metaKey) {
        if (state.multiSelected.has(hit.node.id)) {
          state.multiSelected.delete(hit.node.id);
        } else {
          state.multiSelected.add(hit.node.id);
        }
        emit('multiselect:update');
        return;
      }
      // Regular click: clear multi-select, select node
      if (state.multiSelected.size > 0) {
        state.multiSelected.clear();
        emit('multiselect:update');
      }
      state.selectedNodeId = hit.node.id;
      emit('node-selected', hit.node);
    } else if (hit && hit.type === 'region') {
      // Zoom to fit this category region
      _zoomToRegion(hit.item);
    } else {
      // Click background — deselect everything
      if (state.multiSelected.size > 0) {
        state.multiSelected.clear();
        emit('multiselect:update');
      }
      state.selectedNodeId = null;
      emit('background-click');
      emit('node-selected', null);
    }
  }
}

function _onPointerLeave() {
  if (state.hoveredNodeId) {
    state.hoveredNodeId = null;
    _canvas.style.cursor = 'grab';
    emit('node-hover', null);
  }
}

function _onWheel(e) {
  e.preventDefault();
  // Accumulate zoom target — each tick multiplies by factor
  const zoomFactor = e.deltaY > 0 ? 0.88 : 1.12;
  _smoothZoom.targetScale = Math.max(
    _viewport.minScale,
    Math.min(_viewport.maxScale, (_smoothZoom.active ? _smoothZoom.targetScale : _viewport.scale) * zoomFactor)
  );
  // Update anchor to cursor position (buffer coords)
  _smoothZoom.anchorX = e.clientX * _dpr;
  _smoothZoom.anchorY = e.clientY * _dpr;
  _smoothZoom.active = true;
}

function _onDblClick(e) {
  const hit = _hitTest(e.clientX, e.clientY);
  if (hit && hit.type === 'card') {
    // Unpin card
    hit.item.pinned = false;
    _schedulePositionSave();
  } else {
    // Zoom to fit all
    _zoomToFit(400, 60);
  }
}

function _onContextMenu(e) {
  e.preventDefault();
  const hit = _hitTest(e.clientX, e.clientY);
  if (hit && hit.type === 'card') {
    emit('node-context-menu', { node: hit.node, event: e });
  }
}


// ═══════════════════════════════════════════
// VIEWPORT NAVIGATION
// ═══════════════════════════════════════════

function _centerAt(worldX, worldY, duration = 0) {
  const targetOffsetX = _canvas.width / 2 - worldX * _viewport.scale;
  const targetOffsetY = _canvas.height / 2 - worldY * _viewport.scale;

  if (duration <= 0) {
    _viewport.offsetX = targetOffsetX;
    _viewport.offsetY = targetOffsetY;
    return;
  }

  _animFrom = {
    offsetX: _viewport.offsetX,
    offsetY: _viewport.offsetY,
    scale: _viewport.scale,
  };
  _animTo = {
    offsetX: targetOffsetX,
    offsetY: targetOffsetY,
    scale: _viewport.scale,
  };
  _animStart = performance.now();
  _animDuration = duration;
  _animating = true;
}

function _zoomToFit(duration = 400, padding = 60) {
  if (_cards.length === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const card of _cards) {
    if (card.x - CARD_W / 2 < minX) minX = card.x - CARD_W / 2;
    if (card.x + CARD_W / 2 > maxX) maxX = card.x + CARD_W / 2;
    if (card.y - CARD_H / 2 < minY) minY = card.y - CARD_H / 2;
    if (card.y + CARD_H / 2 > maxY) maxY = card.y + CARD_H / 2;
  }

  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const scaledPadding = padding * _dpr;
  const availW = _canvas.width - scaledPadding * 2;
  const availH = _canvas.height - scaledPadding * 2;
  const newScale = Math.min(availW / rangeX, availH / rangeY);
  const clampedScale = Math.max(_viewport.minScale, Math.min(_viewport.maxScale, newScale));

  if (duration <= 0) {
    _viewport.scale = clampedScale;
    _viewport.offsetX = _canvas.width / 2 - centerX * clampedScale;
    _viewport.offsetY = _canvas.height / 2 - centerY * clampedScale;
    return;
  }

  _animFrom = {
    offsetX: _viewport.offsetX,
    offsetY: _viewport.offsetY,
    scale: _viewport.scale,
  };
  _animTo = {
    offsetX: _canvas.width / 2 - centerX * clampedScale,
    offsetY: _canvas.height / 2 - centerY * clampedScale,
    scale: clampedScale,
  };
  _animStart = performance.now();
  _animDuration = duration;
  _animating = true;
}

function _zoomToRegion(region, duration = 400) {
  const padding = 80 * _dpr;
  const regionR = region.radius || 200;

  const rangeX = regionR * 2;
  const rangeY = regionR * 2;

  const availW = _canvas.width - padding * 2;
  const availH = _canvas.height - padding * 2;
  const newScale = Math.min(availW / rangeX, availH / rangeY);
  const clampedScale = Math.max(_viewport.minScale, Math.min(_viewport.maxScale, newScale));

  _animFrom = {
    offsetX: _viewport.offsetX,
    offsetY: _viewport.offsetY,
    scale: _viewport.scale,
  };
  _animTo = {
    offsetX: _canvas.width / 2 - region.cx * clampedScale,
    offsetY: _canvas.height / 2 - region.cy * clampedScale,
    scale: clampedScale,
  };
  _animStart = performance.now();
  _animDuration = duration;
  _animating = true;
}


// ═══════════════════════════════════════════
// RESIZE
// ═══════════════════════════════════════════

function _resizeCanvas() {
  if (!_canvas) return;
  _dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Set canvas buffer size to DPR-scaled resolution for crisp rendering
  _canvas.width = Math.round(w * _dpr);
  _canvas.height = Math.round(h * _dpr);
  // CSS display size stays at viewport dimensions
  _canvas.style.width = w + 'px';
  _canvas.style.height = h + 'px';
}


// ═══════════════════════════════════════════
// PUBLIC API SHIM (force-graph compatible)
// ═══════════════════════════════════════════

function _getPublicAPI() {
  return {
    centerAt: (x, y, duration) => {
      if (x == null && y == null) {
        // getter mode (used by minimap)
        return {
          x: (_canvas.width / 2 - _viewport.offsetX) / _viewport.scale,
          y: (_canvas.height / 2 - _viewport.offsetY) / _viewport.scale,
        };
      }
      _centerAt(x, y, duration);
    },
    zoom: (level, duration) => {
      if (level == null) return _viewport.scale; // getter
      const newScale = Math.max(_viewport.minScale, Math.min(_viewport.maxScale, level));
      if (duration > 0) {
        _animFrom = { offsetX: _viewport.offsetX, offsetY: _viewport.offsetY, scale: _viewport.scale };
        _animTo = { offsetX: _viewport.offsetX, offsetY: _viewport.offsetY, scale: newScale };
        // Zoom from center
        const cx = _canvas.width / 2;
        const cy = _canvas.height / 2;
        _animTo.offsetX = cx - (cx - _viewport.offsetX) * (newScale / _viewport.scale);
        _animTo.offsetY = cy - (cy - _viewport.offsetY) * (newScale / _viewport.scale);
        _animStart = performance.now();
        _animDuration = duration;
        _animating = true;
      } else {
        _viewport.scale = newScale;
      }
    },
    zoomToFit: (duration, padding) => _zoomToFit(duration, padding),
    graphData: () => ({
      nodes: _cards.map(c => ({
        id: c.node.id,
        x: c.x,
        y: c.y,
        payload: c.node.payload,
      })),
      links: state.allLinks,
    }),
    width: (w) => {
      if (w != null) { _canvas.style.width = w + 'px'; _resizeCanvas(); }
      return _canvas ? Math.round(_canvas.width / _dpr) : 0;
    },
    height: (h) => {
      if (h != null) { _canvas.style.height = h + 'px'; _resizeCanvas(); }
      return _canvas ? Math.round(_canvas.height / _dpr) : 0;
    },
    // No-ops for compatibility
    linkVisibility: (fn) => fn,
    d3ReheatSimulation: () => reheatSimulation(),
  };
}

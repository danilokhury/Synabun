// ═══════════════════════════════════════════
// SynaBun Neural Interface — 2D Force Graph
// Core graph initialization, LOD rendering,
// force configuration, and node interactions
// ═══════════════════════════════════════════

import ForceGraph from 'https://esm.sh/force-graph@1.51.0';

import { gfx } from './gfx.js';
import { state, emit, on } from '../../shared/state.js';
import { catColor, hexAlpha, importanceToRadius } from '../../shared/colors.js';
import { KEYS } from '../../shared/constants.js';
import { truncate, normalizeNodes } from '../../shared/utils.js';

// ═══════════════════════════════════════════
// PRIVATE STATE
// ═══════════════════════════════════════════

let _graph = null;

// Visual link arrays (rebuilt on applyGraphData)
let _visualLinks = [];
let _crossCategoryLinks = [];

// Node lookup (id -> node)
let _nodeById = new Map();

// Drag state for rigid-body group movement
const _drag = {
  active: false,
  node: null,
  type: null,        // 'anchor' | 'tag' | 'memory'
  dragSet: new Set(), // Node IDs moving as rigid body
  prevPos: null,
};

// Category logo preload cache
const _categoryLogos = new Map();

// Graph removal scheduling
let _graphRemovalTimer = null;

// ═══════════════════════════════════════════
// POSITION PERSISTENCE (2D)
// ═══════════════════════════════════════════

function _saveNodePositions() {
  if (!_graph) return;
  const gd = _graph.graphData();
  const positions = {};
  for (const n of gd.nodes) {
    if (n.x != null) {
      positions[n.id] = { x: n.x, y: n.y };
    }
  }
  try { localStorage.setItem(KEYS.NODE_POS_2D, JSON.stringify(positions)); } catch (_) {}
}

function _restoreNodePositions(nodes) {
  try {
    const saved = JSON.parse(localStorage.getItem(KEYS.NODE_POS_2D) || '{}');
    if (!Object.keys(saved).length) return false;
    let restored = 0;
    for (const n of nodes) {
      if (saved[n.id]) {
        const pos = saved[n.id];
        n.x = pos.x; n.y = pos.y;
        n.fx = pos.x; n.fy = pos.y;
        restored++;
      }
    }
    return restored > 0;
  } catch (_) { return false; }
}

let _posSaveTimer = null;
function _schedulePositionSave() {
  if (_posSaveTimer) clearTimeout(_posSaveTimer);
  _posSaveTimer = setTimeout(_saveNodePositions, 2000);
}

// ═══════════════════════════════════════════
// CATEGORY LOGO PRELOADING
// ═══════════════════════════════════════════

/**
 * Preload category logo images from metadata.
 * @param {Array<{name:string, logo?:string}>} categories
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

// ═══════════════════════════════════════════
// DRAWING HELPERS
// ═══════════════════════════════════════════

function drawHexagon(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 3 * i - Math.PI / 6;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawDiamond(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
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

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.replace(/\n/g, ' ').split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line + (line ? ' ' : '') + word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      if (lines.length >= maxLines) {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/...$/, '') + '...';
        return lines;
      }
      line = word;
    } else {
      line = test;
    }
  }
  if (line) {
    if (lines.length >= maxLines) {
      lines[lines.length - 1] = lines[lines.length - 1] + '...';
    } else {
      lines.push(line);
    }
  }
  return lines;
}

// ═══════════════════════════════════════════
// NODE CANVAS OBJECT — 3-Level Semantic Zoom
// ═══════════════════════════════════════════

function nodeCanvasObject(node, ctx, globalScale) {
  const isAnchor = node.payload._isAnchor;
  const isTag = node.payload._isTag;
  const cat = node.payload.category;
  const color = catColor(cat);
  const importance = node.payload.importance || 5;
  const radius = importanceToRadius(importance) * gfx.nodeSizeMultiplier;
  const isSelected = node.id === state.selectedNodeId;
  const isHovered = node.id === state.hoveredNodeId;
  const isFocusTarget = node.id === state.focusedNodeId;
  const isMultiSelected = state.multiSelected.has(node.id);

  // Opacity for search/focus dimming
  let opacity = 1;
  if (state.searchResults && !state.searchResults.has(node.id)) opacity = 0.12;
  if (state.focusedNodeId && state.focusedNodeId !== node.id) {
    // Check if neighbor
    const isNeighbor = _visualLinks.some(l => {
      const s = l.source.id || l.source;
      const t = l.target.id || l.target;
      return (s === state.focusedNodeId && t === node.id) || (t === state.focusedNodeId && s === node.id);
    });
    if (!isNeighbor && !isAnchor && !isTag) opacity = 0.15;
    else if (isNeighbor) opacity = 0.7;
  }

  // Skip nearly invisible nodes
  if (opacity < 0.05) return;

  ctx.globalAlpha = opacity;

  // ── LOD 0: Overview (zoom < 0.3) — tiny dots ──
  if (globalScale < 0.3) {
    if (isAnchor) {
      // Anchor: hexagon + category name
      ctx.fillStyle = color;
      drawHexagon(ctx, node.x, node.y, 6);
      ctx.fill();
      ctx.font = `bold ${12 / globalScale}px sans-serif`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(cat, node.x, node.y - 10 / globalScale);
    } else {
      // Dot
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, isSelected ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }

  // ── LOD 1: Navigation (0.3 - 1.5) — circles + selective labels ──
  if (globalScale < 1.5) {
    if (isAnchor) {
      // Anchor hexagon
      const size = 22;
      ctx.fillStyle = hexAlpha(color, 0.3);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      drawHexagon(ctx, node.x, node.y, size);
      ctx.fill();
      ctx.stroke();

      // Logo or name
      const logoEntry = _categoryLogos.get(cat);
      if (logoEntry && logoEntry.ready) {
        const imgSize = size * 1.2;
        ctx.drawImage(logoEntry.img, node.x - imgSize / 2, node.y - imgSize / 2, imgSize, imgSize);
      }

      // Label
      ctx.font = `bold ${14 / globalScale}px sans-serif`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(cat, node.x, node.y + size + 14 / globalScale);

      // Child count badge
      const childCount = state.allNodes.filter(n => n.payload.category === cat || (state.categoryMetadata[n.payload.category]?.parent === cat)).length;
      if (childCount) {
        ctx.font = `${10 / globalScale}px sans-serif`;
        ctx.fillStyle = hexAlpha(color, 0.6);
        ctx.fillText(`${childCount}`, node.x, node.y + size + 26 / globalScale);
      }
    } else if (isTag) {
      // Tag diamond
      const size = 8;
      ctx.fillStyle = hexAlpha(color, 0.4);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      drawDiamond(ctx, node.x, node.y, size);
      ctx.fill();
      ctx.stroke();
      ctx.font = `${11 / globalScale}px sans-serif`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      const tagName = node.payload._tagCategory || cat;
      ctx.fillText(tagName, node.x, node.y + size + 10 / globalScale);
    } else {
      // Memory circle
      const r = radius;

      // Outer glow ring
      if (isSelected || isHovered || isMultiSelected) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = hexAlpha(color, isSelected ? 0.3 : 0.2);
        ctx.fill();
      }

      // Main circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(color, 0.7);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Pin indicator
      if (node.fx != null) {
        ctx.beginPath();
        ctx.arc(node.x + r, node.y - r, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      }

      // Label for high-importance or hovered/selected nodes
      if (state.labelsVisible && (importance >= gfx.labelThreshold || isSelected || isHovered)) {
        const label = truncate(node.payload.content, 40);
        const fontSize = Math.max(3, 10 / globalScale * state.labelSizeMultiplier);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillStyle = isSelected ? '#fff' : hexAlpha('#ffffff', 0.7);
        ctx.textAlign = 'center';
        ctx.fillText(label, node.x, node.y + r + fontSize + 2);
      }
    }
    ctx.globalAlpha = 1;
    return;
  }

  // ── LOD 2: Detail (zoom > 1.5) — full card rendering ──
  if (isAnchor) {
    const size = 30;
    ctx.fillStyle = hexAlpha(color, 0.25);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    drawHexagon(ctx, node.x, node.y, size);
    ctx.fill();
    ctx.stroke();

    // Glow ring
    ctx.beginPath();
    ctx.arc(node.x, node.y, size + 8, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(color, 0.15);
    ctx.lineWidth = 3;
    ctx.stroke();

    const logoEntry = _categoryLogos.get(cat);
    if (logoEntry && logoEntry.ready) {
      const imgSize = size * 1.2;
      ctx.drawImage(logoEntry.img, node.x - imgSize / 2, node.y - imgSize / 2, imgSize, imgSize);
    }

    ctx.font = `bold 14px sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(cat, node.x, node.y + size + 18);
    ctx.globalAlpha = 1;
    return;
  }

  if (isTag) {
    const size = 12;
    ctx.fillStyle = hexAlpha(color, 0.35);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    drawDiamond(ctx, node.x, node.y, size);
    ctx.fill();
    ctx.stroke();
    ctx.font = `bold 12px sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(node.payload._tagCategory || cat, node.x, node.y + size + 14);
    ctx.globalAlpha = 1;
    return;
  }

  // Memory card
  const cardW = 180;
  const cardH = 80;
  const cardX = node.x - cardW / 2;
  const cardY = node.y - cardH / 2;
  const cardR = 8;

  // Card background
  ctx.fillStyle = isSelected ? hexAlpha(color, 0.15) : 'rgba(15, 18, 25, 0.85)';
  ctx.strokeStyle = isSelected ? color : hexAlpha(color, 0.4);
  ctx.lineWidth = isSelected ? 2 : 1;
  roundRect(ctx, cardX, cardY, cardW, cardH, cardR);
  ctx.fill();
  ctx.stroke();

  // Color bar on left
  ctx.fillStyle = color;
  ctx.fillRect(cardX, cardY + cardR, 3, cardH - cardR * 2);

  // Category label
  ctx.font = 'bold 8px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(cat.toUpperCase(), cardX + 10, cardY + 14);

  // Content text (up to 3 lines)
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#c8ccd4';
  const content = node.payload.content || '';
  const lines = wrapText(ctx, content, cardW - 20, 3);
  lines.forEach((line, i) => {
    ctx.fillText(line, cardX + 10, cardY + 28 + i * 13);
  });

  // Importance stars
  const starY = cardY + cardH - 12;
  ctx.font = '9px sans-serif';
  ctx.fillStyle = '#c9a84c';
  ctx.textAlign = 'right';
  const stars = '\u2605'.repeat(Math.min(importance, 10));
  ctx.fillText(stars, cardX + cardW - 8, starY);

  // Pin indicator
  if (node.fx != null) {
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText('\uD83D\uDCCC', cardX + 10, starY);
  }

  ctx.globalAlpha = 1;
}

// ═══════════════════════════════════════════
// NODE POINTER AREA PAINT (hit detection)
// ═══════════════════════════════════════════

function nodePointerAreaPaint(node, color, ctx, globalScale) {
  const isAnchor = node.payload._isAnchor;
  const isTag = node.payload._isTag;
  ctx.fillStyle = color;

  if (globalScale > 1.5 && !isAnchor && !isTag) {
    // Card mode hit area
    const cardW = 180;
    const cardH = 80;
    ctx.fillRect(node.x - cardW / 2, node.y - cardH / 2, cardW, cardH);
  } else {
    // Scale hit area inversely with zoom so anchors/tags stay easy to click when zoomed out
    const zoomBoost = Math.max(1, 2.5 / globalScale);
    const baseR = isAnchor ? 30 : isTag ? 16 : importanceToRadius(node.payload.importance || 5) * gfx.nodeSizeMultiplier + 4;
    const r = baseR * zoomBoost;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ═══════════════════════════════════════════
// LINK CANVAS OBJECT
// ═══════════════════════════════════════════

function linkCanvasObject(link, ctx, globalScale) {
  if (globalScale < 0.3) return; // Hide links at overview zoom

  const src = link.source;
  const tgt = link.target;
  if (!src || !tgt || src.x == null || tgt.x == null) return;

  const srcColor = catColor((src.payload || {}).category || '');
  const strength = link.strength || 0.3;
  const width = 0.5 + strength * 1.5;

  let linkOpacity = gfx.linkOpacity;
  // Highlight links for selected node
  if (state.selectedNodeId) {
    const srcId = src.id || src;
    const tgtId = tgt.id || tgt;
    if (srcId === state.selectedNodeId || tgtId === state.selectedNodeId) {
      linkOpacity = 0.7;
    } else {
      linkOpacity = 0.03;
    }
  }

  ctx.strokeStyle = hexAlpha(srcColor, linkOpacity);
  ctx.lineWidth = width / globalScale;
  ctx.beginPath();
  ctx.moveTo(src.x, src.y);
  ctx.lineTo(tgt.x, tgt.y);
  ctx.stroke();
}

// ═══════════════════════════════════════════
// CLUSTER FORCE (same-category attraction)
// ═══════════════════════════════════════════

function clusterForce() {
  let nodes;
  const strength = 0.03;

  function force(alpha) {
    // Compute centroids per category
    const centroids = {};
    const counts = {};
    for (const n of nodes) {
      if (n.payload._isAnchor || n.payload._isTag) continue;
      const cat = n.payload.category;
      if (!centroids[cat]) { centroids[cat] = { x: 0, y: 0 }; counts[cat] = 0; }
      centroids[cat].x += n.x || 0;
      centroids[cat].y += n.y || 0;
      counts[cat]++;
    }
    for (const cat in centroids) {
      centroids[cat].x /= counts[cat];
      centroids[cat].y /= counts[cat];
    }

    // Apply gentle attraction toward centroid
    for (const n of nodes) {
      if (n.fx != null || n.payload._isAnchor || n.payload._isTag) continue;
      const cat = n.payload.category;
      if (!centroids[cat]) continue;
      n.vx += (centroids[cat].x - (n.x || 0)) * strength * alpha;
      n.vy += (centroids[cat].y - (n.y || 0)) * strength * alpha;
    }
  }

  force.initialize = (_nodes) => { nodes = _nodes; };
  return force;
}

// ═══════════════════════════════════════════
// DRAG SET — determines which nodes move rigidly
// ═══════════════════════════════════════════

function _buildDragSet(node, allGraphNodes) {
  const dragSet = new Set();
  dragSet.add(node.id);

  if (node.payload && node.payload._isAnchor) {
    // Anchor drag: move anchor + all child tags + all memories in this category tree
    const anchorCat = node.payload._anchorCategory;
    const childCats = Object.entries(state.categoryMetadata)
      .filter(([, m]) => m.parent === anchorCat)
      .map(([name]) => name);
    const treeCats = new Set([anchorCat, ...childCats]);
    for (const n of allGraphNodes) {
      if (n === node) continue;
      if (n.payload._isTag && treeCats.has(n.payload._tagCategory)) dragSet.add(n.id);
      if (!n.payload._isAnchor && !n.payload._isTag && treeCats.has(n.payload.category)) dragSet.add(n.id);
    }
    return { type: 'anchor', dragSet };
  }

  if (node.payload && node.payload._isTag) {
    // Tag drag: move tag + all its memories
    const tagCat = node.payload._tagCategory;
    for (const n of allGraphNodes) {
      if (!n.payload._isAnchor && !n.payload._isTag && n.payload.category === tagCat) {
        dragSet.add(n.id);
      }
    }
    return { type: 'tag', dragSet };
  }

  return { type: 'memory', dragSet };
}

// ═══════════════════════════════════════════
// NODE INTERACTION HANDLERS
// ═══════════════════════════════════════════

function _handleNodeHover(node) {
  state.hoveredNodeId = node ? node.id : null;
  emit('node-hover', node);
  document.body.style.cursor = node ? 'pointer' : '';
}

function _handleNodeClick(node, event) {
  if (!node) return;

  // Right-click is handled separately
  if (event && event.button === 2) {
    emit('node-context-menu', { node, event });
    return;
  }

  if (node.payload._isAnchor || node.payload._isTag) {
    const cat = node.payload._anchorCategory || node.payload._tagCategory;
    if (!cat) return;

    // Ensure category is visible
    if (!state.activeCategories.has(cat)) {
      state.activeCategories.add(cat);
      emit('categories-changed');
      applyGraphData();
    }

    // Gather all nodes in this category tree
    const gd = _graph.graphData();
    let treeCats;
    if (node.payload._isAnchor) {
      const childCats = Object.entries(state.categoryMetadata)
        .filter(([, m]) => m.parent === cat)
        .map(([name]) => name);
      treeCats = new Set([cat, ...childCats]);
    } else {
      treeCats = new Set([cat]);
    }

    const treeNodes = gd.nodes.filter(n =>
      n.payload && (treeCats.has(n.payload.category) ||
        n.payload._anchorCategory === cat ||
        (n.payload._tagCategory && treeCats.has(n.payload._tagCategory)))
    );

    if (treeNodes.length === 0) return;

    // Compute bounding box and zoom to fit
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of treeNodes) {
      const x = n.x || 0, y = n.y || 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const spanX = (maxX - minX) || 60;
    const spanY = (maxY - minY) || 60;
    const pad = 80;
    const zoomX = window.innerWidth / (spanX + pad);
    const zoomY = window.innerHeight / (spanY + pad);
    const targetZoom = Math.min(zoomX, zoomY, 3);

    _graph.centerAt(cx, cy, 800);
    _graph.zoom(targetZoom, 800);
    return;
  }

  state.selectedNodeId = node.id;
  localStorage.setItem(KEYS.SELECTED_NODE, node.id);
  emit('node-selected', node);
  _graph.centerAt(node.x, node.y, 500);
}

function _handleBackgroundClick() {
  state.selectedNodeId = null;
  state.focusedNodeId = null;
  localStorage.removeItem(KEYS.SELECTED_NODE);
  emit('background-click');
}

// ═══════════════════════════════════════════
// APPLY GRAPH DATA
// ═══════════════════════════════════════════

/**
 * Build the visible graph data from state and apply to the force-graph.
 * Handles anchor/tag hierarchy injection, focus mode, and position persistence.
 */
export function applyGraphData() {
  if (!_graph) return;

  let visibleNodes = state.allNodes.filter(n => state.activeCategories.has(n.payload.category));
  let visibleIds = new Set(visibleNodes.map(n => n.id));
  const nodeCatMap = {};
  for (const n of visibleNodes) nodeCatMap[n.id] = n.payload.category;

  // Separate same-category links from cross-category
  const sameCatLinks = [];
  _crossCategoryLinks = [];
  for (const l of state.allLinks) {
    const srcId = l.source.id || l.source;
    const tgtId = l.target.id || l.target;
    if (!visibleIds.has(srcId) || !visibleIds.has(tgtId)) continue;
    if (nodeCatMap[srcId] === nodeCatMap[tgtId]) {
      sameCatLinks.push(l);
    } else {
      _crossCategoryLinks.push({ ...l, _crossCategory: true });
    }
  }

  _visualLinks = state.linkMode === 'all'
    ? [...sameCatLinks, ..._crossCategoryLinks]
    : [...sameCatLinks];
  let visibleLinks = [];

  // Anchor / Tag hierarchy injection
  const injectedNodes = [];
  const injectedLinks = [];
  const parentCats = Object.entries(state.categoryMetadata).filter(([, meta]) => meta.is_parent);

  const nodesByCat = new Map();
  for (const n of visibleNodes) {
    const cat = n.payload.category;
    let arr = nodesByCat.get(cat);
    if (!arr) { arr = []; nodesByCat.set(cat, arr); }
    arr.push(n);
  }

  for (const [parentName] of parentCats) {
    const childCats = Object.entries(state.categoryMetadata)
      .filter(([, m]) => m.parent === parentName)
      .map(([name]) => name);

    const parentMems = nodesByCat.get(parentName) || [];
    let hasTreeMemories = parentMems.length > 0;
    if (!hasTreeMemories) {
      for (const c of childCats) { if (nodesByCat.has(c)) { hasTreeMemories = true; break; } }
    }
    if (!hasTreeMemories) continue;

    const anchorId = `_anchor_${parentName}`;
    injectedNodes.push({
      id: anchorId,
      payload: { category: parentName, _isAnchor: true, _anchorCategory: parentName, importance: 10, content: parentName }
    });

    for (const childName of childCats) {
      const childMemories = nodesByCat.get(childName) || [];
      if (childMemories.length === 0) continue;

      const tagId = `_tag_${childName}`;
      injectedNodes.push({
        id: tagId,
        payload: { category: childName, _isTag: true, _tagCategory: childName, _parentAnchor: parentName, importance: 8, content: childName }
      });

      injectedLinks.push({ source: anchorId, target: tagId, strength: 0.3, _isStructural: true });
      for (const mem of childMemories) {
        injectedLinks.push({ source: tagId, target: mem.id, strength: 0.5, _isStructural: true });
      }
    }

    for (const mem of parentMems) {
      injectedLinks.push({ source: anchorId, target: mem.id, strength: 0.4, _isStructural: true });
    }
  }

  visibleNodes = [...injectedNodes, ...visibleNodes];
  visibleIds = new Set(visibleNodes.map(n => n.id));
  visibleLinks = injectedLinks;

  _nodeById = new Map();
  for (const n of visibleNodes) _nodeById.set(n.id, n);

  // Focus mode
  if (state.focusedNodeId && visibleIds.has(state.focusedNodeId)) {
    const neighborIds = new Set([state.focusedNodeId]);
    const allLinksForFocus = [...visibleLinks, ..._visualLinks];
    allLinksForFocus.forEach(l => {
      const srcId = l.source.id || l.source;
      const tgtId = l.target.id || l.target;
      if (srcId === state.focusedNodeId) neighborIds.add(tgtId);
      if (tgtId === state.focusedNodeId) neighborIds.add(srcId);
    });
    visibleNodes = visibleNodes.filter(n => neighborIds.has(n.id));
    visibleIds = neighborIds;
    visibleLinks = visibleLinks.filter(l => {
      const srcId = l.source.id || l.source;
      const tgtId = l.target.id || l.target;
      return neighborIds.has(srcId) && neighborIds.has(tgtId);
    });
    _visualLinks = _visualLinks.filter(l => {
      const srcId = l.source.id || l.source;
      const tgtId = l.target.id || l.target;
      return neighborIds.has(srcId) && neighborIds.has(tgtId);
    });
    _nodeById = new Map();
    for (const n of visibleNodes) _nodeById.set(n.id, n);
  }

  // Restore or let force simulation handle layout
  const hasSaved = _restoreNodePositions(visibleNodes);

  _graph.graphData({ nodes: visibleNodes, links: visibleLinks });

  // Pin restored positions
  if (hasSaved) {
    for (const n of visibleNodes) {
      if (n.fx == null && n.x != null) { n.fx = n.x; n.fy = n.y; }
    }
  }

  _schedulePositionSave();
}

// ═══════════════════════════════════════════
// GRAPH REMOVAL SCHEDULING
// ═══════════════════════════════════════════

/**
 * Schedule a deferred graph data reapply (e.g. after node deletion animation).
 * @param {number} [delay=600]
 */
export function scheduleGraphRemoval(delay = 600) {
  if (_graphRemovalTimer) clearTimeout(_graphRemovalTimer);
  _graphRemovalTimer = setTimeout(() => {
    _graphRemovalTimer = null;
    applyGraphData();
    emit('stats-changed');
  }, delay);
}

/**
 * Cancel a pending graph removal.
 */
export function cancelScheduledRemoval() {
  if (_graphRemovalTimer) {
    clearTimeout(_graphRemovalTimer);
    _graphRemovalTimer = null;
  }
}

// ═══════════════════════════════════════════
// INIT GRAPH
// ═══════════════════════════════════════════

/**
 * Create and configure the ForceGraph 2D instance.
 * @param {HTMLElement} container  DOM element for the graph (e.g. #graph-container)
 * @param {object}      callbacks  External callbacks:
 *   - onRenderFramePost()  — called every frame after rendering (for hulls, minimap)
 * @returns {object} The ForceGraph instance
 */
export function initGraph(container, callbacks = {}) {
  _graph = ForceGraph()(container)
    .backgroundColor('rgba(0,0,0,0)')
    .nodeId('id')
    .nodeLabel(() => '')
    .nodeCanvasObject(nodeCanvasObject)
    .nodePointerAreaPaint(nodePointerAreaPaint)
    .linkSource('source')
    .linkTarget('target')
    .linkCanvasObject(linkCanvasObject)
    .linkCanvasObjectMode(() => 'replace')
    .linkVisibility(l => {
      if (state.linkMode === 'off') return false;
      if (state.linkMode === 'intra' && l._crossCategory) return false;
      if (state.linkTypeFilter !== 'all' && l.types && !l.types.includes(state.linkTypeFilter)) return false;
      return true;
    })
    .onNodeHover(_handleNodeHover)
    .onNodeClick(_handleNodeClick)
    .onBackgroundClick(_handleBackgroundClick)
    .onNodeDrag(node => {
      const gd = _graph.graphData();

      if (!_drag.active) {
        _drag.active = true;
        _drag.node = node;
        const { type, dragSet } = _buildDragSet(node, gd.nodes);
        _drag.type = type;
        _drag.dragSet = dragSet;
        document.body.style.cursor = 'grabbing';
      }

      // Rigid-body translate: move all group members by same delta
      if (_drag.prevPos) {
        const dx = (node.x || 0) - _drag.prevPos.x;
        const dy = (node.y || 0) - _drag.prevPos.y;

        if (dx !== 0 || dy !== 0) {
          for (const n of gd.nodes) {
            if (n === node) continue;
            if (_drag.dragSet.has(n.id)) {
              n.x = (n.x || 0) + dx;
              n.y = (n.y || 0) + dy;
              n.fx = n.x; n.fy = n.y;
            }
          }
        }
      }
      _drag.prevPos = { x: node.x || 0, y: node.y || 0 };
    })
    .onNodeDragEnd(node => {
      if (!_drag.active) {
        node.fx = node.x; node.fy = node.y;
        _schedulePositionSave();
        return;
      }

      // Pin the dragged node
      node.fx = node.x; node.fy = node.y;

      document.body.style.cursor = state.hoveredNodeId ? 'pointer' : '';
      _drag.active = false;
      _drag.node = null;
      _drag.type = null;
      _drag.dragSet = new Set();
      _drag.prevPos = null;
      _schedulePositionSave();
    })
    .onBackgroundRightClick(() => {
      emit('context-menu-hide');
    })
    .onRenderFramePost(() => {
      if (callbacks.onRenderFramePost) callbacks.onRenderFramePost();
    })
    .d3AlphaDecay(gfx.alphaDecay)
    .d3VelocityDecay(gfx.velocityDecay)
    .warmupTicks(50)
    .cooldownTicks(200)
    .width(container.offsetWidth)
    .height(container.offsetHeight);

  // Custom forces
  _graph.d3Force('charge').strength(gfx.chargeStrength);
  _graph.d3Force('link').distance(l => l._isStructural ? gfx.linkDistanceBase : gfx.linkDistanceBase * 1.5);

  // Add cluster force (same-category attraction)
  _graph.d3Force('cluster', clusterForce());

  // Double-click background: zoom to fit
  container.addEventListener('dblclick', (e) => {
    if (e.target.tagName === 'CANVAS' && !state.hoveredNodeId) {
      _graph.zoomToFit(400, 60);
    }
  });

  // Double-click node: unpin
  let lastClickTime = 0;
  let lastClickNode = null;
  const origNodeClick = _handleNodeClick;
  _graph.onNodeClick((node, event) => {
    const now = Date.now();
    if (lastClickNode === node && now - lastClickTime < 400) {
      // Double-click: unpin
      node.fx = undefined;
      node.fy = undefined;
      _graph.d3ReheatSimulation();
      lastClickNode = null;
      return;
    }
    lastClickTime = now;
    lastClickNode = node;
    origNodeClick(node, event);
  });

  // Right-click node: context menu (prevent default)
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Handle window resize (uses container dimensions for explorer sidebar support)
  window.addEventListener('resize', () => {
    if (_graph) _graph.width(container.offsetWidth).height(container.offsetHeight);
  });

  // Apply initial data
  applyGraphData();

  return _graph;
}

// ═══════════════════════════════════════════
// LOAD GRAPH DATA
// ═══════════════════════════════════════════

/**
 * Fetch all memories from the API and populate state.
 * After loading, applies data to the graph and emits 'data-loaded'.
 */
export async function loadGraphData() {
  const res = await fetch('/api/memories');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  state.allNodes = normalizeNodes(data.nodes);
  state.allLinks = data.links;

  applyGraphData();
  emit('data-loaded', data);
  return data;
}

// ═══════════════════════════════════════════
// REFRESH GRAPH
// ═══════════════════════════════════════════

/**
 * Reload data from the API and re-apply to the graph.
 * Preserves current selection if the node still exists.
 */
export async function refreshGraph() {
  const data = await loadGraphData();

  // Re-apply category visibility
  const presentCats = new Set(state.allNodes.map(n => n.payload.category));
  state.activeCategories = new Set([...presentCats, ...state.allCategoryNames]);

  applyGraphData();
  emit('graph-refreshed', data);
  emit('stats-changed');
  return data;
}

// ═══════════════════════════════════════════
// ACCESSORS
// ═══════════════════════════════════════════

/**
 * Get the ForceGraph instance.
 * @returns {object|null}
 */
export function getGraph() {
  return _graph;
}

/**
 * Get the current visual links array (for neighbor checks, etc.).
 * @returns {Array}
 */
export function getVisualLinks() {
  return _visualLinks;
}

/**
 * Get the node-by-ID lookup map.
 * @returns {Map}
 */
export function getNodeById() {
  return _nodeById;
}

/**
 * Trigger a position save (e.g. after external pin/unpin).
 */
export function schedulePositionSave() {
  _schedulePositionSave();
}

/**
 * Reheat the d3 force simulation.
 */
export function reheatSimulation() {
  if (_graph) _graph.d3ReheatSimulation();
}

// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Force Graph
// Core graph initialization, node/link rendering,
// layout computation, animation loop, interactions
// ═══════════════════════════════════════════
//
// THREE, TWEEN, ForceGraph3D, UnrealBloomPass are globals from CDN imports.
// This module owns the ForceGraph3D instance and all related Three.js objects.

import { state, emit, on } from '../../shared/state.js';
import { KEYS } from '../../shared/constants.js';
import { catColor } from '../../shared/colors.js';
import { gfx } from './gfx.js';

// ── Constants ──────────────────────────────
const FLOOR_Y = -200;
const PLEXUS_RADIUS = 200;
const _MULTI_SELECT_BLUE = new THREE.Color(0.4, 0.7, 1.0);
const _MAX_BATCH_LINKS = 15000;
const _posStorageKey = KEYS.NODE_POS_3D;

// ── Module state ───────────────────────────
let graph = null;
let _graphContainer = null;
let animFrameId = null;
let graphRemovalTimer = null;
let _bloomPass = null;

// Frustum culling (reused every frame — zero alloc)
const _worldPos = new THREE.Vector3();
const _mouseDir = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _frustumPadded = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();

// Batch link rendering — single draw call for ALL visible links
let _linkBatch = null;
let _linkBatchGeo = null;
let _linkBatchDirty = true;
let _batchLinks = [];
let _visualLinks = [];
let _nodeById = new Map();
let _linkBatchPositions = new Float32Array(_MAX_BATCH_LINKS * 6);
let _linkBatchColors = new Float32Array(_MAX_BATCH_LINKS * 6);
let _crossCategoryLinks = [];

// Drag state
const _drag = {
  active: false,
  node: null,
  type: null,
  dragSet: new Set(),
  frozenSet: new Set(),
  prevPos: null,
  depthOffset: new THREE.Vector3(),
};

// 3D mouse position tracking via raycasting
const _mouse = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _mousePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _mouse3D = new THREE.Vector3();
let _mouse3DValid = false;
const _dragDepthVec = new THREE.Vector3();

// Node scale boost when links are off
let noLinksScaleBoost = 1.0;

// Pointer-over-UI guard
let _pointerOverUI = false;

// ═══════════════════════════════════════════
// SOFT DOT TEXTURE
// ═══════════════════════════════════════════
let _softDotTex = null;
function getSoftDotTexture() {
  if (_softDotTex) return _softDotTex;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = (px - c) / c, dy = (py - c) / c;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const t = Math.max(0, Math.min(1, (0.5 - dist) / (0.5 - 0.15)));
      const alpha = t * t * (3 - 2 * t);
      const idx = (py * size + px) * 4;
      d[idx] = 255; d[idx + 1] = 255; d[idx + 2] = 255;
      d[idx + 3] = alpha * 255 | 0;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  _softDotTex = new THREE.CanvasTexture(canvas);
  _softDotTex.needsUpdate = true;
  return _softDotTex;
}

// ═══════════════════════════════════════════
// SHARED GEOMETRY POOL (Icosahedron LOD)
// ═══════════════════════════════════════════
let _icoGeoLow = null;
let _icoGeoMed = null;
let _icoGeoHigh = null;
function getIcoGeo(importance) {
  if (importance >= 8) {
    if (!_icoGeoHigh) _icoGeoHigh = new THREE.IcosahedronGeometry(1, 2);
    return _icoGeoHigh;
  }
  if (importance >= 5) {
    if (!_icoGeoMed) _icoGeoMed = new THREE.IcosahedronGeometry(1, 1);
    return _icoGeoMed;
  }
  if (!_icoGeoLow) _icoGeoLow = new THREE.IcosahedronGeometry(1, 0);
  return _icoGeoLow;
}

// ═══════════════════════════════════════════
// CATEGORY LOGOS — preloaded images for anchor nodes
// ═══════════════════════════════════════════
const _categoryLogos = new Map();

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

// Legacy fallback: hardcoded OpenClaw logo
const _openclawLogo = new Image();
_openclawLogo.src = '/openclaw-logo-text.png';
let _openclawLogoReady = false;
_openclawLogo.onload = () => { _openclawLogoReady = true; };

// ═══════════════════════════════════════════
// NODE CREATION — Anchor (parent category)
// ═══════════════════════════════════════════
function createAnchorObject(node) {
  const parentName = node.payload._anchorCategory;
  const color = catColor(parentName);
  const hex = new THREE.Color(color);
  const dotSize = 20;

  const group = new THREE.Group();

  // Label sprite — tightly sized canvas
  const _logoEntry = _categoryLogos.get(parentName);
  const useLogo = (_logoEntry && _logoEntry.ready) || (parentName === 'openclaw' && _openclawLogoReady);
  const logoImage = (_logoEntry && _logoEntry.ready) ? _logoEntry.img : _openclawLogo;

  let contentW, contentH;
  const PAD = 16;

  if (useLogo) {
    const aspect = logoImage.naturalWidth / (logoImage.naturalHeight || 1);
    const maxW = 380, maxH = 100;
    if (aspect >= maxW / maxH) { contentW = maxW; contentH = maxW / aspect; }
    else { contentH = maxH; contentW = maxH * aspect; }
  } else {
    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    measureCtx.font = '600 36px "Space Grotesk", "Inter", system-ui, sans-serif';
    const metrics = measureCtx.measureText(parentName.toUpperCase());
    contentW = Math.ceil(metrics.width);
    contentH = 44;
  }

  const canvasW = Math.ceil(contentW + PAD * 2);
  const canvasH = Math.ceil(contentH + PAD * 2);

  const labelCanvas = document.createElement('canvas');
  const labelCtx = labelCanvas.getContext('2d');
  labelCanvas.width = canvasW;
  labelCanvas.height = canvasH;
  labelCtx.clearRect(0, 0, canvasW, canvasH);

  if (useLogo) {
    labelCtx.globalAlpha = 0.85;
    labelCtx.drawImage(logoImage, PAD, PAD, contentW, contentH);
    labelCtx.globalAlpha = 1.0;
  } else {
    labelCtx.font = '600 36px "Space Grotesk", "Inter", system-ui, sans-serif';
    labelCtx.textAlign = 'center';
    labelCtx.textBaseline = 'middle';
    labelCtx.fillStyle = 'rgba(255,255,255,0.85)';
    labelCtx.fillText(parentName.toUpperCase(), canvasW / 2, canvasH / 2);
  }

  const labelTex = new THREE.CanvasTexture(labelCanvas);
  const labelMat = new THREE.SpriteMaterial({
    map: labelTex,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const label = new THREE.Sprite(labelMat);
  const SCALE = 0.2;
  const labelW = canvasW * SCALE;
  const labelH = canvasH * SCALE;
  label.scale.set(labelW, labelH, 1);
  label.position.set(0, 0, 0.5);
  group.add(label);

  // Flat plane hitbox
  const hitGeo = new THREE.PlaneGeometry(labelW, labelH);
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const hitbox = new THREE.Mesh(hitGeo, hitMat);
  hitbox.position.set(0, 0, 0.5);
  group.add(hitbox);

  group.userData.nodeId = node.id;
  group.userData.isAnchor = true;
  group.userData.anchorCategory = parentName;
  group.userData.dot = null;
  group.userData.label = label;
  group.userData.baseLabelScale = { x: labelW, y: labelH };
  group.userData.baseLabelY = 0;
  group.userData.baseRadius = dotSize;
  group.userData.category = parentName;
  group.userData.phase = parentName.length * 0.7;
  group.userData.importance = 10;
  group.userData.baseOpacity = 0.8;

  group.userData._currentScale = 0.01;
  group.scale.setScalar(0.01);

  return group;
}

// ═══════════════════════════════════════════
// NODE CREATION — Tag (child category)
// ═══════════════════════════════════════════
function createTagObject(node) {
  const catName = node.payload._tagCategory;
  const color = catColor(catName);
  const hex = new THREE.Color(color);
  const dotSize = 10;

  const group = new THREE.Group();

  // Visible dot sprite
  const dotMat = new THREE.SpriteMaterial({
    map: getSoftDotTexture(),
    color: hex,
    transparent: true,
    opacity: 0.35,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });
  const dot = new THREE.Sprite(dotMat);
  dot.scale.set(dotSize, dotSize, 1);
  dot.raycast = () => {};
  group.add(dot);

  // Small text label
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = '500 28px "JetBrains Mono", "Space Grotesk", monospace';
  const tagMetrics = measureCtx.measureText(catName);
  const tagTextW = Math.ceil(tagMetrics.width);
  const tagTextH = 36;
  const tagPad = 12;
  const tagCanvasW = tagTextW + tagPad * 2;
  const tagCanvasH = tagTextH + tagPad * 2;

  const labelCanvas = document.createElement('canvas');
  const labelCtx = labelCanvas.getContext('2d');
  labelCanvas.width = tagCanvasW;
  labelCanvas.height = tagCanvasH;
  labelCtx.clearRect(0, 0, tagCanvasW, tagCanvasH);
  labelCtx.font = '500 28px "JetBrains Mono", "Space Grotesk", monospace';
  labelCtx.textAlign = 'center';
  labelCtx.textBaseline = 'middle';
  labelCtx.fillStyle = color;
  labelCtx.fillText(catName, tagCanvasW / 2, tagCanvasH / 2);

  const labelTex = new THREE.CanvasTexture(labelCanvas);
  const labelMat = new THREE.SpriteMaterial({ map: labelTex, transparent: true, opacity: 0.6, depthWrite: false });
  const label = new THREE.Sprite(labelMat);
  const TAG_SCALE = 0.15;
  const tagLabelW = tagCanvasW * TAG_SCALE;
  const tagLabelH = tagCanvasH * TAG_SCALE;
  label.scale.set(tagLabelW, tagLabelH, 1);
  label.position.set(0, dotSize * 0.8, 0);
  group.add(label);

  // Flat plane hitbox
  const hitW = Math.max(tagLabelW, dotSize);
  const hitH = tagLabelH + dotSize;
  const hitGeo = new THREE.PlaneGeometry(hitW, hitH);
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const hitbox = new THREE.Mesh(hitGeo, hitMat);
  hitbox.position.set(0, dotSize * 0.4, 0);
  group.add(hitbox);

  group.userData.nodeId = node.id;
  group.userData.isTag = true;
  group.userData.tagCategory = catName;
  group.userData.dot = dot;
  group.userData.label = label;
  group.userData.baseLabelScale = { x: tagLabelW, y: tagLabelH };
  group.userData.baseLabelY = dotSize * 0.8;
  group.userData.baseRadius = dotSize;
  group.userData.category = catName;
  group.userData.phase = catName.split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 0.3;
  group.userData.importance = 8;
  group.userData.baseOpacity = 0.6;

  group.userData._currentScale = 0.01;
  group.scale.setScalar(0.01);

  return group;
}

// ═══════════════════════════════════════════
// NODE CREATION — Memory (wireframe geodesic)
// ═══════════════════════════════════════════
function createNodeObject(node) {
  if (node.payload && node.payload._isAnchor) return createAnchorObject(node);
  if (node.payload && node.payload._isTag) return createTagObject(node);

  const color = catColor(node.payload.category);
  const importance = node.payload.importance || 5;
  const hex = new THREE.Color(color);
  const radius = 2 + (importance - 1) * 0.33;
  const baseOpacity = 0.18 + (importance - 1) * 0.022;

  const group = new THREE.Group();

  // Wireframe geodesic sphere
  const mutedHex = hex.clone().lerp(new THREE.Color(0.35, 0.35, 0.35), 0.35);
  const wireMat = new THREE.MeshBasicMaterial({
    color: mutedHex,
    wireframe: true,
    transparent: true,
    opacity: baseOpacity,
    depthWrite: false,
  });
  const wire = new THREE.Mesh(getIcoGeo(importance), wireMat);
  wire.scale.setScalar(radius);
  wire.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
  wire.raycast = () => {};
  group.add(wire);

  // Subtle inner core
  const glowMat = new THREE.SpriteMaterial({
    map: getSoftDotTexture(),
    color: mutedHex,
    transparent: true,
    opacity: baseOpacity * 0.35,
    blending: THREE.NormalBlending,
    depthWrite: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(radius * 0.9, radius * 0.9, 1);
  glow.raycast = () => {};
  group.add(glow);

  // Hitbox
  const hitboxGeo = new THREE.SphereGeometry(radius * 1.1, 6, 6);
  const hitboxMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  group.add(new THREE.Mesh(hitboxGeo, hitboxMat));

  group.userData.nodeId = node.id;
  group.userData.dot = wire;
  group.userData.glow = glow;
  group.userData.baseRadius = radius;
  group.userData.baseOpacity = baseOpacity;
  group.userData.baseColor = mutedHex.clone();
  group.userData.category = node.payload.category;
  group.userData.phase = Math.random() * Math.PI * 2;
  group.userData.importance = importance;

  group.userData._currentScale = 0.01;
  group.scale.setScalar(0.01);

  return group;
}

// ═══════════════════════════════════════════
// MOUSE 3D POSITION — raycasting for plexus
// ═══════════════════════════════════════════

function _initMouseTracking() {
  document.addEventListener('mousemove', (e) => {
    // Use container bounds for correct raycasting when explorer sidebar shifts the graph
    const rect = _graphContainer
      ? _graphContainer.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    _mouse3DValid = true;
  });

  // Wheel-during-drag: move node along camera→node line of sight.
  // Uses capture phase on the container so we intercept BEFORE OrbitControls.
  // Also directly moves the Three.js mesh for immediate visual feedback
  // (onNodeDrag only fires on mousemove, not on wheel scroll).
  const wheelTarget = _graphContainer || document;
  wheelTarget.addEventListener('wheel', (e) => {
    if (!_drag.active || !_drag.node || !graph) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const cam = graph.camera();
    const node = _drag.node;

    // Direction from camera to node
    _dragDepthVec.set(node.x || 0, node.y || 0, node.z || 0)
      .sub(cam.position).normalize();

    // 5% of distance per scroll tick, floor of 5 units
    const camDist = cam.position.distanceTo(node);
    const step = Math.max(5, camDist * 0.05);
    const delta = (e.deltaY < 0 ? 1 : -1) * step;

    // Don't let node pass behind the camera (stop ~30 units in front)
    const MIN_CAM_DIST = 30;
    if (delta < 0 && camDist <= MIN_CAM_DIST) return;
    const clampedDelta = delta < 0 ? Math.max(delta, -(camDist - MIN_CAM_DIST)) : delta;

    // Compute the offset for this tick
    const ox = _dragDepthVec.x * clampedDelta;
    const oy = _dragDepthVec.y * clampedDelta;
    const oz = _dragDepthVec.z * clampedDelta;

    // Accumulate for onNodeDrag (counteracts ForceGraph3D plane snap on next mousemove)
    _drag.depthOffset.x += ox;
    _drag.depthOffset.y += oy;
    _drag.depthOffset.z += oz;

    // Directly move node data + Three.js mesh for immediate visual feedback
    const gd = graph.graphData();

    node.x = (node.x || 0) + ox;
    node.y = (node.y || 0) + oy;
    node.z = (node.z || 0) + oz;
    node.fx = node.x; node.fy = node.y; node.fz = node.z;
    if (node.__threeObj) node.__threeObj.position.set(node.x, node.y, node.z);

    // Move rigid-body group
    for (const n of gd.nodes) {
      if (n === node) continue;
      if (_drag.dragSet.has(n.id)) {
        n.x = (n.x || 0) + ox;
        n.y = (n.y || 0) + oy;
        n.z = (n.z || 0) + oz;
        n.fx = n.x; n.fy = n.y; n.fz = n.z;
        if (n.__threeObj) n.__threeObj.position.set(n.x, n.y, n.z);
      }
    }

    // Keep prevPos in sync
    _drag.prevPos = { x: node.x, y: node.y, z: node.z };
  }, { capture: true, passive: false });
}

function updateMouse3D() {
  if (!graph || !_mouse3DValid) return;
  const cam = graph.camera();
  _raycaster.setFromCamera(_mouse, cam);
  const controls = graph.controls();
  const target = controls && controls.target ? controls.target : _mouseDir.set(0, 0, 0);
  _mousePlane.setFromNormalAndCoplanarPoint(
    cam.getWorldDirection(_mouseDir).negate(),
    target
  );
  _raycaster.ray.intersectPlane(_mousePlane, _mouse3D);
}

// ═══════════════════════════════════════════
// NODE POSITION PERSISTENCE
// ═══════════════════════════════════════════
let _posSaveTimer = null;

export function saveNodePositions() {
  if (!graph) return;
  const gd = graph.graphData();
  const positions = {};
  for (const n of gd.nodes) {
    if (n.x != null) {
      positions[n.id] = { x: n.x, y: n.y, z: n.z };
    }
  }
  try { localStorage.setItem(_posStorageKey, JSON.stringify(positions)); } catch (_) {}
}

function restoreNodePositions(nodes) {
  try {
    const saved = JSON.parse(localStorage.getItem(_posStorageKey) || '{}');
    if (!Object.keys(saved).length) return;
    for (const n of nodes) {
      if (saved[n.id]) {
        const pos = saved[n.id];
        n.x = pos.x; n.y = pos.y; n.z = pos.z;
        n.fx = pos.x; n.fy = pos.y; n.fz = pos.z;
      }
    }
  } catch (_) {}
}

function schedulePositionSave() {
  if (_posSaveTimer) clearTimeout(_posSaveTimer);
  _posSaveTimer = setTimeout(saveNodePositions, 2000);
}

// ═══════════════════════════════════════════
// BATCH LINK RENDERER — single draw call
// ═══════════════════════════════════════════
function initLinkBatch() {
  if (!graph) return;
  _linkBatchGeo = new THREE.BufferGeometry();
  _linkBatchGeo.setAttribute('position', new THREE.BufferAttribute(_linkBatchPositions, 3));
  _linkBatchGeo.setAttribute('color', new THREE.BufferAttribute(_linkBatchColors, 3));
  _linkBatchGeo.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true,
    opacity: gfx.linkOpacity || 0.12, depthWrite: false,
  });
  _linkBatch = new THREE.LineSegments(_linkBatchGeo, mat);
  _linkBatch.frustumCulled = false;
  _linkBatch.renderOrder = -1;
  graph.scene().add(_linkBatch);
}

// ═══════════════════════════════════════════
// DRAG SET BUILDER — determines rigid-body group
// ═══════════════════════════════════════════
function _buildDragSet(node, allNodes) {
  const dragSet = new Set();
  dragSet.add(node.id);

  if (node.payload && node.payload._isAnchor) {
    const anchorCat = node.payload._anchorCategory;
    const childCats = Object.entries(state.categoryMetadata)
      .filter(([, m]) => m.parent === anchorCat)
      .map(([name]) => name);
    const treeCats = new Set([anchorCat, ...childCats]);
    for (const n of allNodes) {
      if (n === node) continue;
      if (n.payload._isTag && treeCats.has(n.payload._tagCategory)) dragSet.add(n.id);
      if (!n.payload._isAnchor && !n.payload._isTag && treeCats.has(n.payload.category)) dragSet.add(n.id);
    }
    return { type: 'anchor', dragSet };
  }

  if (node.payload && node.payload._isTag) {
    const tagCat = node.payload._tagCategory;
    for (const n of allNodes) {
      if (!n.payload._isAnchor && !n.payload._isTag && n.payload.category === tagCat) {
        dragSet.add(n.id);
      }
    }
    return { type: 'tag', dragSet };
  }

  // Multi-select drag
  if (state.multiSelected.size > 0 && state.multiSelected.has(node.id)) {
    for (const id of state.multiSelected) dragSet.add(id);
    return { type: 'multi', dragSet };
  }

  return { type: 'memory', dragSet };
}

// ═══════════════════════════════════════════
// LAYOUT COMPUTATION — geodesic sphere packing
// ═══════════════════════════════════════════
function computeLayout(nodes) {
  const anchors = nodes.filter(n => n.payload._isAnchor);
  const tags = nodes.filter(n => n.payload._isTag);
  const memories = nodes.filter(n => !n.payload._isAnchor && !n.payload._isTag);
  const placed = new Set();

  const GOLDEN = (1 + Math.sqrt(5)) / 2;

  function fibSphere(n, radius, center) {
    const points = [];
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * i + 1) / n;
      const r = Math.sqrt(1 - y * y);
      const theta = 2 * Math.PI * i / GOLDEN;
      points.push({
        x: center.x + Math.cos(theta) * r * radius,
        y: center.y + y * radius,
        z: center.z + Math.sin(theta) * r * radius,
      });
    }
    return points;
  }

  // 1. Anchors in a wide ring
  const anchorRadius = anchors.length > 1 ? 200 + anchors.length * 60 : 0;
  const ANCHOR_Y = 200;
  const TAG_Y = ANCHOR_Y - 120;
  const SPHERE_GAP = 40;

  anchors.forEach((anchor, i) => {
    const angle = (i / anchors.length) * Math.PI * 2 - Math.PI / 2;
    anchor.x = Math.cos(angle) * anchorRadius;
    anchor.y = ANCHOR_Y;
    anchor.z = Math.sin(angle) * anchorRadius;
    anchor.fx = anchor.x; anchor.fy = anchor.y; anchor.fz = anchor.z;
    placed.add(anchor.id);
  });

  // 2. For each anchor: child tags in rings, each with memory sphere
  anchors.forEach(anchor => {
    const cat = anchor.payload._anchorCategory;
    const childTags = tags.filter(t => t.payload._parentAnchor === cat);
    const directMems = memories.filter(m => m.payload.category === cat && !placed.has(m.id));

    if (childTags.length) {
      const tagRingRadius = Math.max(120, childTags.length * 65);

      childTags.forEach((tag, i) => {
        const angle = (i / childTags.length) * Math.PI * 2;
        tag.x = anchor.x + Math.cos(angle) * tagRingRadius;
        tag.y = TAG_Y;
        tag.z = anchor.z + Math.sin(angle) * tagRingRadius;
        tag.fx = tag.x; tag.fy = tag.y; tag.fz = tag.z;
        placed.add(tag.id);

        const tagCat = tag.payload._tagCategory;
        const tagMems = memories.filter(m => m.payload.category === tagCat && !placed.has(m.id));
        if (tagMems.length) {
          const r = 25 + Math.sqrt(tagMems.length) * 8;
          const sphereCenter = { x: tag.x, y: tag.y - r - SPHERE_GAP, z: tag.z };
          const positions = fibSphere(tagMems.length, r, sphereCenter);
          tagMems.forEach((mem, j) => {
            mem.x = positions[j].x;
            mem.y = positions[j].y;
            mem.z = positions[j].z;
            mem.fx = mem.x; mem.fy = mem.y; mem.fz = mem.z;
            placed.add(mem.id);
          });
        }
      });
    }

    // Direct-parent memories
    if (directMems.length) {
      const r = 25 + Math.sqrt(directMems.length) * 8;
      const sphereCenter = { x: anchor.x, y: TAG_Y - r - SPHERE_GAP, z: anchor.z };
      const positions = fibSphere(directMems.length, r, sphereCenter);
      directMems.forEach((mem, i) => {
        mem.x = positions[i].x;
        mem.y = positions[i].y;
        mem.z = positions[i].z;
        mem.fx = mem.x; mem.fy = mem.y; mem.fz = mem.z;
        placed.add(mem.id);
      });
    }
  });

  // 3. Orphan memories
  const orphans = memories.filter(m => !placed.has(m.id));
  if (orphans.length) {
    const catGroups = {};
    orphans.forEach(m => {
      const c = m.payload.category || 'uncategorized';
      if (!catGroups[c]) catGroups[c] = [];
      catGroups[c].push(m);
    });
    const groupNames = Object.keys(catGroups);
    const orphanBase = anchorRadius + 150;

    groupNames.forEach((c, gi) => {
      const angle = (gi / Math.max(groupNames.length, 1)) * Math.PI * 2;
      const cx = Math.cos(angle) * orphanBase;
      const cz = Math.sin(angle) * orphanBase;
      const mems = catGroups[c];
      const r = 25 + Math.sqrt(mems.length) * 8;
      const positions = fibSphere(mems.length, r, { x: cx, y: 0, z: cz });

      mems.forEach((mem, i) => {
        mem.x = positions[i].x;
        mem.y = positions[i].y;
        mem.z = positions[i].z;
        mem.fx = mem.x; mem.fy = mem.y; mem.fz = mem.z;
        placed.add(mem.id);
      });
    });
  }

  // Floor clamp
  const NODE_FLOOR = FLOOR_Y + 10;
  for (const n of nodes) {
    if (n.y < NODE_FLOOR) {
      n.y = NODE_FLOOR;
      if (n.fy !== undefined) n.fy = NODE_FLOOR;
    }
  }
}

// ═══════════════════════════════════════════
// APPLY GRAPH DATA — inject anchors/tags, compute layout
// ═══════════════════════════════════════════
export function applyGraphData() {
  if (!graph) return;

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

  // Build node lookup for batch link renderer
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

  // Restore saved positions or compute layout
  const savedPositions = JSON.parse(localStorage.getItem(_posStorageKey) || '{}');
  const hasSaved = Object.keys(savedPositions).length > 0;

  if (hasSaved) {
    restoreNodePositions(visibleNodes);
  } else {
    computeLayout(visibleNodes);
  }

  graph.graphData({ nodes: visibleNodes, links: visibleLinks });
  _linkBatchDirty = true;

  // Pin any unpositioned nodes
  for (const n of visibleNodes) {
    if (n.fx == null && n.x != null) { n.fx = n.x; n.fy = n.y; n.fz = n.z; }
  }

  schedulePositionSave();
}

// ═══════════════════════════════════════════
// LINK VISIBILITY
// ═══════════════════════════════════════════
export function applyLinkVisibility() {
  _linkBatchDirty = true;
}

export function setLinkMode(mode) {
  state.linkMode = mode;
  if (mode === 'off') {
    noLinksScaleBoost = 1.4;
  } else {
    noLinksScaleBoost = 1.0;
    applyGraphData();
  }
  applyLinkVisibility();
}

export function setLinkTypeFilter(filter) {
  state.linkTypeFilter = filter;
  applyLinkVisibility();
}

// ═══════════════════════════════════════════
// GRAPH REMOVAL SCHEDULING
// ═══════════════════════════════════════════
export function scheduleGraphRemoval(delay = 600) {
  _linkBatchDirty = true;
  if (graphRemovalTimer) clearTimeout(graphRemovalTimer);
  graphRemovalTimer = setTimeout(() => {
    graphRemovalTimer = null;
    applyGraphData();
    emit('stats-changed');
  }, delay);
}

export function cancelScheduledRemoval() {
  if (graphRemovalTimer) {
    clearTimeout(graphRemovalTimer);
    graphRemovalTimer = null;
  }
}

// ═══════════════════════════════════════════
// INTERACTIONS — hover, click, drag
// ═══════════════════════════════════════════

function _initUIGuards() {
  document.querySelectorAll('.glass, #title-bar, #search-container, #stats-bar').forEach(el => {
    el.addEventListener('pointerenter', () => { _pointerOverUI = true; }, true);
    el.addEventListener('pointerleave', () => { _pointerOverUI = false; }, true);
  });
}

function handleNodeHover(node, prevNode) {
  const $tooltip = document.getElementById('tooltip');
  if (_pointerOverUI) {
    $tooltip.classList.remove('visible');
    if ($tooltip._moveHandler) {
      document.removeEventListener('mousemove', $tooltip._moveHandler);
    }
    document.body.style.cursor = 'default';
    return;
  }
  if (_drag.active) {
    document.body.style.cursor = 'grabbing';
  } else {
    document.body.style.cursor = node ? 'grab' : 'default';
  }
  state.hoveredNodeId = node ? node.id : null;

  if (node) {
    const cat = node.payload.category;

    if (node.payload._isAnchor) {
      document.getElementById('tooltip-category').textContent = cat.toUpperCase();
      document.getElementById('tooltip-category').style.color = catColor(cat);
      const childCount = Object.entries(state.categoryMetadata).filter(([, m]) => m.parent === cat).length;
      document.getElementById('tooltip-preview').textContent = `Parent category \u2022 ${childCount} sub-categories`;
      document.getElementById('tooltip-importance').textContent = '\u2606';
    } else if (node.payload._isTag) {
      document.getElementById('tooltip-category').textContent = cat;
      document.getElementById('tooltip-category').style.color = catColor(cat);
      const memCount = state.allNodes.filter(n => n.payload.category === cat).length;
      document.getElementById('tooltip-preview').textContent = `${memCount} memories`;
      document.getElementById('tooltip-importance').textContent = '\u25cf';
    } else {
      const imp = node.payload.importance || 5;
      const preview = (node.payload.content || '').length > 100
        ? node.payload.content.slice(0, 100) + '...'
        : (node.payload.content || '');
      const catText = node.payload._isOpenClaw ? '[OC] ' + cat : cat;
      document.getElementById('tooltip-category').textContent = catText;
      document.getElementById('tooltip-category').style.color = catColor(cat);
      document.getElementById('tooltip-preview').textContent = preview;
      document.getElementById('tooltip-importance').textContent = '\u2605'.repeat(Math.min(imp, 10));
    }

    const moveTooltip = (e) => {
      $tooltip.style.left = (e.clientX + 16) + 'px';
      $tooltip.style.top = (e.clientY + 16) + 'px';
    };
    document.addEventListener('mousemove', moveTooltip);
    $tooltip._moveHandler = moveTooltip;
    $tooltip.classList.add('visible');
  } else {
    $tooltip.classList.remove('visible');
    if ($tooltip._moveHandler) {
      document.removeEventListener('mousemove', $tooltip._moveHandler);
    }
  }
}

function handleNodeClick(node, event) {
  if (!node || _pointerOverUI) return;

  // Anchor nodes: zoom to fit entire category cluster
  if (node.payload._isAnchor) {
    const parentName = node.payload._anchorCategory;
    const gd = graph.graphData();
    const childCats = Object.entries(state.categoryMetadata)
      .filter(([, m]) => m.parent === parentName)
      .map(([name]) => name);
    const treeCats = new Set([parentName, ...childCats]);
    const treeNodes = gd.nodes.filter(n =>
      n.payload && (treeCats.has(n.payload.category) || n.payload._anchorCategory === parentName || (n.payload._tagCategory && treeCats.has(n.payload._tagCategory)))
    );
    if (treeNodes.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const n of treeNodes) {
      const x = n.x || 0, y = n.y || 0, z = n.z || 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 30);
    const dist = span * 1.2 + 40;
    graph.cameraPosition(
      { x: cx + dist * 0.5, y: cy + dist * 0.35, z: cz + dist * 0.5 },
      { x: cx, y: cy, z: cz },
      1500
    );
    return;
  }

  // Tag nodes: zoom to show tag + its memory sphere
  if (node.payload._isTag) {
    const tagCat = node.payload._tagCategory;
    const gd = graph.graphData();
    const tagMems = gd.nodes.filter(n => n.payload && n.payload.category === tagCat && !n.payload._isAnchor && !n.payload._isTag);
    if (tagMems.length > 0) {
      let minX = node.x, maxX = node.x, minY = node.y, maxY = node.y, minZ = node.z, maxZ = node.z;
      for (const n of tagMems) {
        const x = n.x || 0, y = n.y || 0, z = n.z || 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 30);
      const dist = span * 1.1 + 30;
      graph.cameraPosition(
        { x: cx + dist * 0.5, y: cy + dist * 0.3, z: cz + dist * 0.5 },
        { x: cx, y: cy, z: cz },
        1500
      );
    } else {
      const dist = gfx.gentleZoom;
      graph.cameraPosition(
        { x: node.x + dist, y: node.y + dist * 0.4, z: node.z + dist },
        { x: node.x, y: node.y, z: node.z },
        1500
      );
    }
    return;
  }

  // Ctrl+Click: toggle multi-select
  if (event && (event.ctrlKey || event.metaKey)) {
    if (state.multiSelected.has(node.id)) {
      state.multiSelected.delete(node.id);
    } else {
      state.multiSelected.add(node.id);
    }
    emit('multiselect:update');
    return;
  }

  // Regular click: clear multi-select, navigate
  if (state.multiSelected.size > 0) {
    state.multiSelected.clear();
    emit('multiselect:update');
  }
  navigateToNode(node);
}

export function navigateToNode(node, { zoom = 'close' } = {}) {
  if (!node) return;
  if (node.payload && (node.payload._isAnchor || node.payload._isTag)) return;
  state.selectedNodeId = node.id;
  localStorage.setItem(KEYS.SELECTED_NODE, node.id);

  // Ensure category is visible
  if (!state.activeCategories.has(node.payload.category)) {
    state.activeCategories.add(node.payload.category);
    emit('categories-changed');
  }

  // If focus mode is on, switch focus to the new node
  if (state.focusedNodeId !== null) {
    state.focusedNodeId = node.id;
    applyGraphData();
    emit('stats-changed');
  }

  // Camera transition
  const dist = zoom === 'gentle' ? gfx.gentleZoom : gfx.clickZoom;
  graph.cameraPosition(
    { x: node.x + dist, y: node.y + dist * 0.4, z: node.z + dist },
    { x: node.x, y: node.y, z: node.z },
    1500
  );

  emit('node-selected', node);
}

function handleBackgroundClick() {
  // Don't close detail panel on background click
}

// ═══════════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════════
function animate() {
  animFrameId = requestAnimationFrame(animate);
  const time = performance.now() * 0.001;

  TWEEN.update();

  // WASD camera movement — delegated to camera module via event
  emit('camera-tick');

  // Update 3D mouse position via raycasting
  updateMouse3D();

  // Floor effect uniforms (updated by background module listening to 'animate-tick')
  emit('animate-tick', { time, graph });

  // ── Node pass — iterate graph nodes directly ──
  if (graph) {
    const gd = graph.graphData();
    const _cam = graph.camera();

    // Build frustum once per frame
    _cam.updateMatrixWorld();
    _projScreenMatrix.multiplyMatrices(_cam.projectionMatrix, _cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreenMatrix);
    _frustumPadded.copy(_frustum);
    for (let _pi = 0; _pi < 6; _pi++) _frustumPadded.planes[_pi].constant += 60;

    for (let _ni = 0, _nlen = gd.nodes.length; _ni < _nlen; _ni++) {
      const obj = gd.nodes[_ni].__threeObj;
      if (!obj || !obj.userData || !obj.userData.nodeId) continue;

      const dot = obj.userData.dot;
      const label = obj.userData.label;
      const phase = obj.userData.phase || 0;
      const isCatHidden = !state.activeCategories.has(obj.userData.category);
      const isHovered = obj.userData.nodeId === state.hoveredNodeId;
      const isSelected = obj.userData.nodeId === state.selectedNodeId;
      const isMultiSelected = state.multiSelected.has(obj.userData.nodeId);

      // Frustum culling
      obj.getWorldPosition(_worldPos);
      let _cullZone = 0;
      if (!_frustum.containsPoint(_worldPos)) {
        _cullZone = _frustumPadded.containsPoint(_worldPos) ? 1 : 2;
      }
      if (isHovered || isSelected || (_drag.active && _drag.dragSet.has(obj.userData.nodeId))) {
        _cullZone = 0;
      }

      // Zone 2: fully outside — decay to invisible
      if (_cullZone === 2) {
        if (dot) {
          dot.material.opacity *= 0.85;
          if (dot.material.opacity < 0.005) dot.material.opacity = 0;
        }
        if (label) {
          label.material.opacity *= 0.85;
          if (label.material.opacity < 0.005) label.material.opacity = 0;
        }
        const _glowCull = obj.userData.glow;
        if (_glowCull) {
          _glowCull.material.opacity *= 0.85;
          if (_glowCull.material.opacity < 0.005) _glowCull.material.opacity = 0;
        }
        if (obj.userData._currentScale > 0.01) {
          obj.userData._currentScale *= 0.9;
          obj.scale.setScalar(obj.userData._currentScale);
        }
        continue;
      }

      // Mouse proximity
      let mouseProx = 0;
      if (_cullZone === 0 && _mouse3DValid && _mouse3D.lengthSq() > 0) {
        const mouseDist = _mouse3D.distanceTo(_worldPos);
        mouseProx = 1 - Math.min(mouseDist / PLEXUS_RADIUS, 1);
        mouseProx = mouseProx * mouseProx;
      }

      const breathe = 1 + Math.sin(time * 0.5 + phase) * 0.03;

      // ── Anchor nodes ──
      if (obj.userData.isAnchor) {
        const baseOp = obj.userData.baseOpacity;
        let dotTarget = baseOp + mouseProx * 0.2;
        let labelTarget = 0.85;
        if (!state.labelsVisible) labelTarget = 0;
        if (isCatHidden) { dotTarget = 0; labelTarget = 0; }
        else if (state.searchResults !== null && !state.searchResults.has(obj.userData.nodeId)) {
          dotTarget *= 0.4; labelTarget *= 0.4;
        }
        if (_drag.active && !isCatHidden) {
          if (_drag.dragSet.has(obj.userData.nodeId)) dotTarget = Math.max(dotTarget, 0.9);
          else { dotTarget *= 0.5; labelTarget *= 0.4; }
        }
        if (isHovered) { dotTarget = 1.0; labelTarget = 1.0; }
        if (isSelected) dotTarget = 1.0;
        if (_cullZone === 1) { dotTarget *= 0.3; labelTarget *= 0.3; }

        const fade = isCatHidden ? 0.15 : 0.1;
        if (dot) dot.material.opacity += (dotTarget * breathe - dot.material.opacity) * fade;
        if (label) label.material.opacity += (labelTarget - label.material.opacity) * fade;

        if (label && obj.userData.baseLabelScale) {
          const camDist = _cam.position.distanceTo(_worldPos);
          const scaleFactor = Math.max(1.0, Math.min(6.0, camDist / 100)) * state.labelSizeMultiplier;
          const bls = obj.userData.baseLabelScale;
          label.scale.set(bls.x * scaleFactor, bls.y * scaleFactor, 1);
        }

        let targetScale = isCatHidden ? 0 : breathe;
        if (isHovered) targetScale *= 1.15;
        if (obj.userData._currentScale == null) obj.userData._currentScale = 0.01;
        obj.userData._currentScale += (targetScale - obj.userData._currentScale) * 0.1;
        obj.scale.setScalar(obj.userData._currentScale);
        continue;
      }

      // ── Tag nodes ──
      if (obj.userData.isTag) {
        const baseOp = obj.userData.baseOpacity;
        let dotTarget = baseOp + mouseProx * 0.3;
        let labelTarget = 0.6;
        if (!state.labelsVisible) labelTarget = 0;

        if (isCatHidden) { dotTarget = 0; labelTarget = 0; }
        else if (state.searchResults !== null && !state.searchResults.has(obj.userData.nodeId)) {
          dotTarget *= 0.35; labelTarget *= 0.35;
        }
        if (_drag.active && !isCatHidden) {
          if (_drag.dragSet.has(obj.userData.nodeId)) dotTarget = Math.max(dotTarget, 0.8);
          else { dotTarget *= 0.4; labelTarget *= 0.3; }
        }
        if (isHovered) { dotTarget = 0.9; labelTarget = 0.9; }
        if (isSelected) dotTarget = 1.0;
        if (_cullZone === 1) { dotTarget *= 0.3; labelTarget *= 0.3; }

        const fade = isCatHidden ? 0.15 : 0.1;
        if (dot) dot.material.opacity += (dotTarget * breathe - dot.material.opacity) * fade;
        if (label) label.material.opacity += (labelTarget - label.material.opacity) * fade;

        if (label && obj.userData.baseLabelScale) {
          const camDist = _cam.position.distanceTo(_worldPos);
          const scaleFactor = Math.max(0.8, Math.min(4.0, camDist / 80)) * state.labelSizeMultiplier;
          const bls = obj.userData.baseLabelScale;
          label.scale.set(bls.x * scaleFactor, bls.y * scaleFactor, 1);
          label.position.y = (obj.userData.baseLabelY || obj.userData.baseRadius * 1.0) * scaleFactor;
        }

        let targetScale = isCatHidden ? 0 : breathe * (1 + mouseProx * 0.1);
        if (isHovered) targetScale *= 1.1;
        if (obj.userData._currentScale == null) obj.userData._currentScale = 0.01;
        obj.userData._currentScale += (targetScale - obj.userData._currentScale) * 0.1;
        obj.scale.setScalar(obj.userData._currentScale);
        continue;
      }

      // ── Memory nodes — wireframe geodesic ──
      if (!dot) continue;

      const baseOp = obj.userData.baseOpacity;
      let dotTarget = baseOp + mouseProx * 0.15;

      if (state.searchResults !== null) {
        dotTarget = state.searchResults.has(obj.userData.nodeId) ? 0.5 : 0.02;
      }
      if (isCatHidden) dotTarget = 0;
      if (_drag.active && !isCatHidden) {
        if (_drag.dragSet.has(obj.userData.nodeId)) dotTarget = Math.max(dotTarget, 0.35);
        else dotTarget *= 0.35;
      }
      if (isHovered) dotTarget = 0.45;
      if (isSelected) dotTarget = 0.55 + 0.05 * Math.sin(time * 2.5);
      if (isMultiSelected) dotTarget = 0.5;
      if (_cullZone === 1) dotTarget *= 0.3;

      const fadeSpeed = isCatHidden ? 0.18 : 0.12;
      dot.material.opacity += (dotTarget * breathe - dot.material.opacity) * fadeSpeed;

      const glowSprite = obj.userData.glow;
      if (glowSprite) {
        glowSprite.material.opacity += (dotTarget * 0.3 * breathe - glowSprite.material.opacity) * fadeSpeed;
      }

      // Multi-select color tint
      if (isMultiSelected) {
        dot.material.color.lerp(_MULTI_SELECT_BLUE, 0.15);
        if (glowSprite) glowSprite.material.color.lerp(_MULTI_SELECT_BLUE, 0.15);
      } else if (obj.userData.baseColor) {
        dot.material.color.lerp(obj.userData.baseColor, 0.1);
        if (glowSprite) glowSprite.material.color.lerp(obj.userData.baseColor, 0.1);
      }

      // Slow rotation
      const rotSpeed = 0.15 + (obj.userData.importance || 5) * 0.02;
      dot.rotation.y += rotSpeed * 0.016;
      dot.rotation.x += rotSpeed * 0.008;

      // Scale
      let scaleMultiplier = 1 + mouseProx * 0.3;
      if (isCatHidden) scaleMultiplier = 0;
      else if (isSelected) scaleMultiplier = 2.0;
      else if (isMultiSelected) scaleMultiplier = 1.5;
      else if (isHovered) scaleMultiplier = 1.6;
      const targetScale = breathe * scaleMultiplier * noLinksScaleBoost;
      if (obj.userData._currentScale == null) obj.userData._currentScale = 0.01;
      obj.userData._currentScale += (targetScale - obj.userData._currentScale) * 0.12;
      obj.scale.setScalar(obj.userData._currentScale);
    }

    // ── LINK BATCH — single draw call ──
    if (_linkBatch) {
      if (_linkBatchDirty && _nodeById.size > 0) {
        _batchLinks.length = 0;
        if (state.linkMode !== 'off') {
          const grey = { r: 0.45, g: 0.45, b: 0.45 };
          const colorCache = new Map();
          function _getMuted(cat) {
            let c = colorCache.get(cat);
            if (!c) {
              const base = new THREE.Color(catColor(cat));
              c = { r: base.r + (grey.r - base.r) * 0.5, g: base.g + (grey.g - base.g) * 0.5, b: base.b + (grey.b - base.b) * 0.5 };
              colorCache.set(cat, c);
            }
            return c;
          }
          const cols = _linkBatchColors;
          let ci = 0;
          for (let li = 0, ll = _visualLinks.length; li < ll; li++) {
            const link = _visualLinks[li];
            if (state.linkMode === 'intra' && link._crossCategory) continue;
            if (state.linkTypeFilter !== 'all' && (!link.types || !link.types.includes(state.linkTypeFilter))) continue;
            const srcId = link.source.id || link.source;
            const tgtId = link.target.id || link.target;
            const srcNode = _nodeById.get(srcId);
            const tgtNode = _nodeById.get(tgtId);
            if (!srcNode || !tgtNode) continue;
            const srcCat = srcNode.payload ? srcNode.payload.category : null;
            const tgtCat = tgtNode.payload ? tgtNode.payload.category : null;
            if (srcCat && !state.activeCategories.has(srcCat)) continue;
            if (tgtCat && !state.activeCategories.has(tgtCat)) continue;
            if (ci + 6 > cols.length) break;
            link._srcNode = srcNode;
            link._tgtNode = tgtNode;
            _batchLinks.push(link);
            const sc = _getMuted(srcNode.payload ? srcNode.payload.category : '_fallback');
            const tc = _getMuted(tgtNode.payload ? tgtNode.payload.category : '_fallback');
            cols[ci] = sc.r; cols[ci + 1] = sc.g; cols[ci + 2] = sc.b;
            cols[ci + 3] = tc.r; cols[ci + 4] = tc.g; cols[ci + 5] = tc.b;
            ci += 6;
          }
          _linkBatchGeo.attributes.color.needsUpdate = true;
        }
        _linkBatchDirty = false;
      }

      // Update positions every frame
      const bl = _batchLinks;
      const blen = bl.length;
      if (blen > 0) {
        const pos = _linkBatchPositions;
        let pi = 0;
        for (let i = 0; i < blen; i++) {
          const s = bl[i]._srcNode, t = bl[i]._tgtNode;
          pos[pi] = s.x; pos[pi + 1] = s.y; pos[pi + 2] = s.z;
          pos[pi + 3] = t.x; pos[pi + 4] = t.y; pos[pi + 5] = t.z;
          pi += 6;
        }
        _linkBatchGeo.attributes.position.needsUpdate = true;
        _linkBatchGeo.setDrawRange(0, blen * 2);
      } else {
        _linkBatchGeo.setDrawRange(0, 0);
      }

      // Sync opacity from GFX slider
      const targetOp = gfx.linkOpacity || 0.12;
      if (_linkBatch.material.opacity !== targetOp) _linkBatch.material.opacity = targetOp;
    }
  }
}

// ═══════════════════════════════════════════
// GRAPH INITIALIZATION
// ═══════════════════════════════════════════

/**
 * Create the ForceGraph3D instance, configure it, and start the animation loop.
 * @param {HTMLElement} container  The DOM element to render into (e.g. #graph-container)
 * @param {Object} [options]       Optional callbacks
 * @param {Function} [options.onApplyBgTheme]  Called after graph is built to apply background
 * @returns {Object} The ForceGraph3D instance
 */
export function initGraph(container, options = {}) {
  _graphContainer = container;

  // Initialize mouse tracking and UI guards
  _initMouseTracking();
  _initUIGuards();

  graph = ForceGraph3D({ controlType: 'orbit' })(container)
    .backgroundColor('#050505')
    .showNavInfo(false)
    .nodeId('id')
    .nodeLabel(() => '')
    .nodeThreeObject(createNodeObject)
    .nodeThreeObjectExtend(false)
    .linkSource('source')
    .linkTarget('target')
    // Links rendered via batch LineSegments — library link objects disabled
    .linkThreeObject(() => { const o = new THREE.Object3D(); o.visible = false; return o; })
    .linkWidth(0)
    .linkCurvature(0)
    .linkDirectionalParticles(0)
    .linkVisibility(() => false)
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .onBackgroundClick(handleBackgroundClick)
    .onNodeDrag((node) => {
      const gd = graph.graphData();

      if (!_drag.active) {
        _drag.active = true;
        _drag.node = node;

        const { type, dragSet } = _buildDragSet(node, gd.nodes);
        _drag.type = type;
        _drag.dragSet = dragSet;
        _drag.depthOffset.set(0, 0, 0);

        document.body.style.cursor = 'grabbing';
      }

      // Apply accumulated wheel depth offset after ForceGraph3D's plane projection
      node.x = (node.x || 0) + _drag.depthOffset.x;
      node.y = (node.y || 0) + _drag.depthOffset.y;
      node.z = (node.z || 0) + _drag.depthOffset.z;
      node.fx = node.x; node.fy = node.y; node.fz = node.z;

      // Rigid-body translate (delta includes both lateral mouse + depth from wheel)
      if (_drag.prevPos) {
        const dx = node.x - _drag.prevPos.x;
        const dy = node.y - _drag.prevPos.y;
        const dz = node.z - _drag.prevPos.z;

        if (dx !== 0 || dy !== 0 || dz !== 0) {
          for (const n of gd.nodes) {
            if (n === node) continue;
            if (_drag.dragSet.has(n.id)) {
              n.x = (n.x || 0) + dx;
              n.y = (n.y || 0) + dy;
              n.z = (n.z || 0) + dz;
              n.fx = n.x; n.fy = n.y; n.fz = n.z;
            }
          }
        }
      }
      _drag.prevPos = { x: node.x, y: node.y, z: node.z };
    })
    .onNodeDragEnd(node => {
      if (!_drag.active) return;

      node.fx = node.x; node.fy = node.y; node.fz = node.z;

      document.body.style.cursor = state.hoveredNodeId ? 'grab' : 'default';
      _drag.active = false;
      _drag.node = null;
      _drag.type = null;
      _drag.dragSet = new Set();
      _drag.prevPos = null;
      _drag.depthOffset.set(0, 0, 0);
      schedulePositionSave();
    })
    .warmupTicks(1)
    .cooldownTicks(0)
    .d3AlphaDecay(1)
    .d3VelocityDecay(1);

  // Forces disabled — layout is computed by computeLayout()
  graph.d3Force('charge', null);
  graph.d3Force('center', null);
  graph.d3Force('link').strength(0);

  // Enable hardware acceleration
  const renderer = graph.renderer();
  if (renderer) {
    renderer.antialias = true;
    renderer.powerPreference = 'high-performance';
    renderer.precision = 'highp';

    const gl = renderer.getContext();
    if (gl) {
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
    }

    renderer.sortObjects = false;
    renderer.info.autoReset = false;
  }

  // Apply data (layout is computed, positions are pinned)
  applyGraphData();

  // One-time reset: clear saved positions for new layout version
  if (localStorage.getItem(KEYS.LAYOUT_VERSION) !== 'v4-spacing') {
    try { localStorage.removeItem(_posStorageKey); } catch (_) {}
    localStorage.setItem(KEYS.LAYOUT_VERSION, 'v4-spacing');
  }

  // Apply link visibility
  applyLinkVisibility();

  // Bloom post-processing
  _bloomPass = new UnrealBloomPass(
    new THREE.Vector2(container.offsetWidth, container.offsetHeight),
    0.3,   // strength
    0.4,   // radius
    0.45   // threshold
  );
  graph.postProcessingComposer().addPass(_bloomPass);

  // Apply background theme
  if (options.onApplyBgTheme) {
    options.onApplyBgTheme(gfx.bgTheme || 'deep-grid');
  }

  // Init batch link renderer
  initLinkBatch();

  // Start animation loop
  animate();

  return graph;
}

// ═══════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════

/** Returns the ForceGraph3D instance (or null before init). */
export function getGraph() {
  return graph;
}

/** Returns the bloom pass (or null before init). */
export function getBloomPass() {
  return _bloomPass;
}

/** Returns current visual links array. */
export function getVisualLinks() {
  return _visualLinks;
}

/** Returns the node-by-id Map. */
export function getNodeById() {
  return _nodeById;
}

/** Mark the link batch as dirty (force rebuild on next frame). */
export function markLinksDirty() {
  _linkBatchDirty = true;
}

/** Returns the drag state object (read-only). */
export function getDragState() {
  return _drag;
}

/** Stop the animation loop. */
export function stopAnimation() {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

/** Restart the animation loop after stopping. */
export function startAnimation() {
  if (!animFrameId) animate();
}

/** Clear saved node positions from localStorage. */
export function clearSavedPositions() {
  try { localStorage.removeItem(_posStorageKey); } catch (_) {}
}

/** Recompute layout from scratch (no saved positions). */
export function resetLayout() {
  clearSavedPositions();
  applyGraphData();
}

/** Update bloom pass parameters. */
export function setBloomParams(strength, threshold, radius) {
  if (_bloomPass) {
    if (strength !== undefined) _bloomPass.strength = strength;
    if (threshold !== undefined) _bloomPass.threshold = threshold;
    if (radius !== undefined) _bloomPass.radius = radius;
  }
}

/** Returns the noLinksScaleBoost value (used by external animation code). */
export function getNoLinksScaleBoost() {
  return noLinksScaleBoost;
}

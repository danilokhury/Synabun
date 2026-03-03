// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Graph (Raw Three.js)
// Core graph initialization, node/link rendering,
// layout computation, animation loop, interactions
// ═══════════════════════════════════════════
//
// THREE, TWEEN, OrbitControls, EffectComposer, RenderPass, UnrealBloomPass
// are globals from CDN imports. No ForceGraph3D dependency.
console.log('[graph.js] LOADED — v4 polished layout + fresnel orbs');

import { state, emit, on } from '../../shared/state.js';
import { KEYS } from '../../shared/constants.js';
import { storage } from '../../shared/storage.js';
import { catColor } from '../../shared/colors.js';
import { fetchLinks } from '../../shared/api.js';
import { gfx } from './gfx.js';

// ── Constants ──────────────────────────────
const FLOOR_Y = -500;
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
let _linkPosDirty = true;  // positions need update (drag, layout change)
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
let _mouseMoved = false;
const _dragDepthVec = new THREE.Vector3();

// Node scale boost when links are off
let noLinksScaleBoost = 1.0;

// Pointer-over-UI guard
let _pointerOverUI = false;

// ── Raw Three.js objects (replaces ForceGraph3D) ──
let _scene    = null;
let _camera   = null;
let _renderer = null;
let _controls = null;
let _composer = null;

// ── Graph data store (replaces ForceGraph3D's internal data) ──
let _graphNodes = [];
let _graphLinks = [];

// ── Anchor/Tag scene objects (memory nodes have ZERO Three.js objects) ──
const _anchorTagObjects = new Map(); // nodeId → THREE.Group
let _anchorTagArray = [];            // flat array for fast iteration in animate()

// ── Pointer events state for custom raycasting ──
let _pointerDownPos = null;
let _pointerDownTime = 0;
let _pointerDownNode = null;
const _dragPlane = new THREE.Plane();
const _dragHit = new THREE.Vector3();

// ═══════════════════════════════════════════
// GRAPH PROXY — matches ForceGraph3D API surface
// so camera.js, background.js, main.js need zero changes
// ═══════════════════════════════════════════

function _tweenCameraPosition(toPos, toLookAt, durationMs) {
  if (!_camera || !_controls) return;
  if (!durationMs || durationMs <= 0) {
    _camera.position.set(toPos.x, toPos.y, toPos.z);
    if (toLookAt) {
      _controls.target.set(toLookAt.x, toLookAt.y, toLookAt.z);
      _controls.update();
    }
    return;
  }
  new TWEEN.Tween(_camera.position)
    .to({ x: toPos.x, y: toPos.y, z: toPos.z }, durationMs)
    .easing(TWEEN.Easing.Quadratic.Out)
    .start();
  if (toLookAt) {
    new TWEEN.Tween(_controls.target)
      .to({ x: toLookAt.x, y: toLookAt.y, z: toLookAt.z }, durationMs)
      .easing(TWEEN.Easing.Quadratic.Out)
      .onUpdate(() => _controls.update())
      .start();
  }
}

const graphProxy = {
  scene:    () => _scene,
  camera:   () => _camera,
  controls: () => _controls,
  renderer: () => _renderer,
  graphData: (data) => {
    if (data !== undefined) {
      _graphNodes = data.nodes || [];
      _graphLinks = data.links || [];
    } else {
      return { nodes: _graphNodes, links: _graphLinks };
    }
  },
  cameraPosition: (pos, lookAt, ms) => _tweenCameraPosition(pos, lookAt, ms ?? 0),
  postProcessingComposer: () => _composer,
  backgroundColor: (hex) => {
    if (_renderer) _renderer.setClearColor(new THREE.Color(hex));
  },
  d3Force: () => ({ strength: () => ({}) }), // noop — forces are disabled
};

// ═══════════════════════════════════════════
// INSTANCED RENDERING — memory nodes
// ═══════════════════════════════════════════
const _MAX_MEMORY_NODES = 8000;
const _NODE_LIMIT_KEY = 'neural-node-limit';
let _nodeLimit = parseInt(storage.getItem(_NODE_LIMIT_KEY) || '0', 10) || 0; // 0 = no limit

// 3 InstancedMesh for wireframes (one per LOD tier)
let _wireInstLow  = null;  // importance 1-4
let _wireInstMed  = null;  // importance 5-7
let _wireInstHigh = null;  // importance 8+

// 1 Points mesh for glows
let _glowPoints = null;
let _glowPointsGeo = null;

// Index management
let _nodeInstanceMap = new Map(); // nodeId → { tier, index }
let _tierNodes = [[], [], []];    // [lowNodes, medNodes, highNodes]
let _glowNodeOrder = [];          // all memory nodes in global index order

// Per-node state (parallel Float32Arrays — static, updated only on dirty)
const _nodeOpacity     = new Float32Array(_MAX_MEMORY_NODES);
const _nodeGlowOpacity = new Float32Array(_MAX_MEMORY_NODES);
const _nodeScale       = new Float32Array(_MAX_MEMORY_NODES);
const _nodeColorR      = new Float32Array(_MAX_MEMORY_NODES);
const _nodeColorG      = new Float32Array(_MAX_MEMORY_NODES);
const _nodeColorB      = new Float32Array(_MAX_MEMORY_NODES);
const _nodeBaseColorR  = new Float32Array(_MAX_MEMORY_NODES);
const _nodeBaseColorG  = new Float32Array(_MAX_MEMORY_NODES);
const _nodeBaseColorB  = new Float32Array(_MAX_MEMORY_NODES);
const _nodeBaseOpacity = new Float32Array(_MAX_MEMORY_NODES);
const _nodeImportance  = new Float32Array(_MAX_MEMORY_NODES);
const _nodeBaseRadius  = new Float32Array(_MAX_MEMORY_NODES);

// Dirty flag — only recompute + upload GPU buffers when state changes
let _instancesDirty = true;

// Reusable math scratch objects (zero-alloc per frame)
const _instMatrix    = new THREE.Matrix4();
const _instPos       = new THREE.Vector3();
const _instScaleV    = new THREE.Vector3();
const _identityQuat  = new THREE.Quaternion(); // identity — no rotation

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
      const t = Math.max(0, Math.min(1, (0.55 - dist) / (0.55 - 0.1)));
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

// ── Shared hitbox material for anchor/tag PlaneGeometry hitboxes (~50-100 total) ──
let _sharedHitboxMat = null;
function getHitboxMaterial() {
  if (!_sharedHitboxMat) {
    _sharedHitboxMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
  }
  return _sharedHitboxMat;
}

// ═══════════════════════════════════════════
// INSTANCED SHADER MATERIALS
// ═══════════════════════════════════════════

function createWireInstanceMaterial() {
  return new THREE.ShaderMaterial({
    wireframe: false,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0.0 },
    },
    vertexShader: `
      attribute vec3 instanceColor;
      attribute float instanceOpacity;
      varying vec3 vColor;
      varying float vOpacity;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      void main() {
        vColor = instanceColor;
        vOpacity = instanceOpacity;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vViewPos = mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vColor;
      varying float vOpacity;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      void main() {
        if (vOpacity < 0.003) discard;
        // Fresnel rim glow — brighter at edges, subtler at center
        float fresnel = 1.0 - abs(dot(normalize(vNormal), normalize(-vViewPos)));
        fresnel = pow(fresnel, 1.5);
        float rim = 0.7 + fresnel * 0.3;
        // Subtle shimmer
        float shimmer = 1.0 + sin(uTime * 1.5 + vViewPos.x * 0.1) * 0.05;
        gl_FragColor = vec4(vColor * 2.5 * rim * shimmer, 1.0);
      }
    `,
  });
}

function createGlowPointsMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTexture: { value: getSoftDotTexture() },
    },
    vertexShader: `
      attribute vec3 glowColor;
      attribute float glowOpacity;
      attribute float glowSize;
      varying vec3 vColor;
      varying float vOpacity;
      void main() {
        vColor = glowColor;
        vOpacity = glowOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = glowSize * (300.0 / -mvPosition.z);
        gl_PointSize = clamp(gl_PointSize, 1.0, 128.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D uTexture;
      varying vec3 vColor;
      varying float vOpacity;
      void main() {
        if (vOpacity < 0.003) discard;
        vec4 texel = texture2D(uTexture, gl_PointCoord);
        gl_FragColor = vec4(vColor * 2.5, texel.a * vOpacity * 2.5);
      }
    `,
  });
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
// INSTANCED RENDERING — init + index management
// ═══════════════════════════════════════════

function initInstancedRendering() {
  const scene = graph.scene();

  // 3 InstancedMesh for wireframes (one per LOD tier)
  const geoLow  = new THREE.IcosahedronGeometry(1, 0);
  const geoMed  = new THREE.IcosahedronGeometry(1, 1);
  const geoHigh = new THREE.IcosahedronGeometry(1, 2);

  _wireInstLow  = new THREE.InstancedMesh(geoLow,  createWireInstanceMaterial(), _MAX_MEMORY_NODES);
  _wireInstMed  = new THREE.InstancedMesh(geoMed,  createWireInstanceMaterial(), _MAX_MEMORY_NODES);
  _wireInstHigh = new THREE.InstancedMesh(geoHigh, createWireInstanceMaterial(), _MAX_MEMORY_NODES);

  for (const inst of [_wireInstLow, _wireInstMed, _wireInstHigh]) {
    inst.count = 0;
    inst.frustumCulled = false;

    const colorAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(_MAX_MEMORY_NODES * 3), 3
    );
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    inst.geometry.setAttribute('instanceColor', colorAttr);

    const opacityAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(_MAX_MEMORY_NODES), 1
    );
    opacityAttr.setUsage(THREE.DynamicDrawUsage);
    inst.geometry.setAttribute('instanceOpacity', opacityAttr);

    scene.add(inst);
  }

  // 1 Points mesh for glows
  _glowPointsGeo = new THREE.BufferGeometry();

  const posAttr = new THREE.BufferAttribute(new Float32Array(_MAX_MEMORY_NODES * 3), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  _glowPointsGeo.setAttribute('position', posAttr);

  const glowColorAttr = new THREE.BufferAttribute(new Float32Array(_MAX_MEMORY_NODES * 3), 3);
  glowColorAttr.setUsage(THREE.DynamicDrawUsage);
  _glowPointsGeo.setAttribute('glowColor', glowColorAttr);

  const glowOpAttr = new THREE.BufferAttribute(new Float32Array(_MAX_MEMORY_NODES), 1);
  glowOpAttr.setUsage(THREE.DynamicDrawUsage);
  _glowPointsGeo.setAttribute('glowOpacity', glowOpAttr);

  const glowSizeAttr = new THREE.BufferAttribute(new Float32Array(_MAX_MEMORY_NODES), 1);
  glowSizeAttr.setUsage(THREE.DynamicDrawUsage);
  _glowPointsGeo.setAttribute('glowSize', glowSizeAttr);

  _glowPointsGeo.setDrawRange(0, 0);

  _glowPoints = new THREE.Points(_glowPointsGeo, createGlowPointsMaterial());
  _glowPoints.frustumCulled = false;
  scene.add(_glowPoints);
}

function rebuildInstanceMap() {
  _nodeInstanceMap.clear();
  _tierNodes[0].length = 0;
  _tierNodes[1].length = 0;
  _tierNodes[2].length = 0;
  _glowNodeOrder.length = 0;

  if (!graph) return;
  const gd = graph.graphData();

  // First pass: assign nodes to tiers (cap at effective limit to prevent buffer overflow)
  const effectiveLimit = _nodeLimit > 0 ? Math.min(_nodeLimit, _MAX_MEMORY_NODES) : _MAX_MEMORY_NODES;
  let memCount = 0;
  for (let i = 0; i < gd.nodes.length; i++) {
    const node = gd.nodes[i];
    if (!node.payload || node.payload._isAnchor || node.payload._isTag) continue;
    if (memCount >= effectiveLimit) break;

    const importance = node.payload.importance || 5;
    const tier = importance >= 8 ? 2 : importance >= 5 ? 1 : 0;

    _tierNodes[tier].push(node);
    _nodeInstanceMap.set(node.id, { tier, index: _tierNodes[tier].length - 1 });
    memCount++;
  }

  // Build _glowNodeOrder in tier order (tier 0, then tier 1, then tier 2)
  // so global indices match Phase 2's globalOffset mapping
  for (let t = 0; t < 3; t++) {
    for (let i = 0; i < _tierNodes[t].length; i++) {
      _glowNodeOrder.push(_tierNodes[t][i]);
    }
  }

  // Initialize animation state for each node (now in tier order)
  for (let gi = 0; gi < _glowNodeOrder.length; gi++) {
    const node = _glowNodeOrder[gi];
    const importance = node.payload.importance || 5;
    const color = catColor(node.payload.category);
    const hex = new THREE.Color(color);
    const mutedHex = hex.clone();
    const radius = 6 + (importance - 1) * 0.8;
    const baseOpacity = 0.75 + (importance - 1) * 0.03;

    _nodeBaseOpacity[gi] = baseOpacity;
    _nodeBaseColorR[gi] = mutedHex.r;
    _nodeBaseColorG[gi] = mutedHex.g;
    _nodeBaseColorB[gi] = mutedHex.b;
    _nodeColorR[gi] = mutedHex.r;
    _nodeColorG[gi] = mutedHex.g;
    _nodeColorB[gi] = mutedHex.b;
    _nodeOpacity[gi] = baseOpacity;
    _nodeGlowOpacity[gi] = baseOpacity * 0.85;
    _nodeScale[gi] = 1.0;
    _nodeImportance[gi] = importance;
    _nodeBaseRadius[gi] = radius;
  }

  _instancesDirty = true;

  // Set instance counts
  if (_wireInstLow)  _wireInstLow.count  = _tierNodes[0].length;
  if (_wireInstMed)  _wireInstMed.count  = _tierNodes[1].length;
  if (_wireInstHigh) _wireInstHigh.count = _tierNodes[2].length;

  // Set glow draw range
  if (_glowPointsGeo) _glowPointsGeo.setDrawRange(0, _glowNodeOrder.length);
}

// GFX preset resets — handle instanced memory nodes + individual anchor/tag nodes
on('gfx:preset-applied', () => {
  // Reset instanced memory node opacities to base values
  for (let gi = 0; gi < _glowNodeOrder.length; gi++) {
    _nodeOpacity[gi] = _nodeBaseOpacity[gi];
    _nodeGlowOpacity[gi] = _nodeBaseOpacity[gi] * 0.85;
  }
  _instancesDirty = true;
  // Reset individual anchor/tag nodes
  for (const [, obj] of _anchorTagObjects) {
    if (!obj || !obj.userData) continue;
    const dot = obj.userData.dot;
    if (dot && dot.material) {
      dot.material.opacity = obj.userData.baseOpacity || 0.1;
    }
  }
});

// Node limit change — save to storage and rebuild
on('search:apply', () => { _instancesDirty = true; });
on('search:clear', () => { _instancesDirty = true; });
on('categories-changed', () => { _instancesDirty = true; });

on('node-limit-changed', (limit) => {
  _nodeLimit = limit;
  storage.setItem(_NODE_LIMIT_KEY, String(limit));
  if (graph) {
    rebuildInstanceMap();
    _instancesDirty = true;
    emit('graph:refresh');
  }
});


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
    labelCtx.globalAlpha = 1.0;
    labelCtx.drawImage(logoImage, PAD, PAD, contentW, contentH);
    labelCtx.globalAlpha = 1.0;
  } else {
    labelCtx.font = '600 36px "Space Grotesk", "Inter", system-ui, sans-serif';
    labelCtx.textAlign = 'center';
    labelCtx.textBaseline = 'middle';
    labelCtx.fillStyle = 'rgba(255,255,255,1.0)';
    labelCtx.fillText(parentName.toUpperCase(), canvasW / 2, canvasH / 2);
  }

  const labelTex = new THREE.CanvasTexture(labelCanvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;

  // Billboard mesh with custom ShaderMaterial — bypasses SpriteMaterial pipeline entirely
  const SCALE = 0.2;
  const labelW = canvasW * SCALE;
  const labelH = canvasH * SCALE;
  const labelGeo = new THREE.PlaneGeometry(labelW, labelH);
  const labelShaderMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTexture: { value: labelTex },
      uOpacity: { value: 1.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uTexture;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec4 tex = texture2D(uTexture, vUv);
        if (tex.a < 0.01) discard;
        gl_FragColor = vec4(tex.rgb * 3.0, tex.a * uOpacity);
      }
    `,
  });
  const label = new THREE.Mesh(labelGeo, labelShaderMat);
  label.renderOrder = 999;
  label.position.set(0, 0, 0.5);
  group.add(label);

  // Flat plane hitbox (shared material)
  const hitGeo = new THREE.PlaneGeometry(labelW, labelH);
  const hitbox = new THREE.Mesh(hitGeo, getHitboxMaterial());
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
  group.userData.baseOpacity = 1.0;

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
    opacity: 1.0,
    blending: THREE.NormalBlending,
    depthWrite: false,
    fog: false,
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
  labelTex.colorSpace = THREE.SRGBColorSpace;

  // Billboard mesh with custom ShaderMaterial — bypasses SpriteMaterial pipeline
  const TAG_SCALE = 0.15;
  const tagLabelW = tagCanvasW * TAG_SCALE;
  const tagLabelH = tagCanvasH * TAG_SCALE;
  const tagLabelGeo = new THREE.PlaneGeometry(tagLabelW, tagLabelH);
  const tagLabelShaderMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTexture: { value: labelTex },
      uOpacity: { value: 1.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uTexture;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec4 tex = texture2D(uTexture, vUv);
        if (tex.a < 0.01) discard;
        gl_FragColor = vec4(tex.rgb * 3.0, tex.a * uOpacity);
      }
    `,
  });
  const label = new THREE.Mesh(tagLabelGeo, tagLabelShaderMat);
  label.renderOrder = 999;
  label.position.set(0, dotSize * 0.8, 0);
  group.add(label);

  // Flat plane hitbox (shared material)
  const hitW = Math.max(tagLabelW, dotSize);
  const hitH = tagLabelH + dotSize;
  const hitGeo = new THREE.PlaneGeometry(hitW, hitH);
  const hitbox = new THREE.Mesh(hitGeo, getHitboxMaterial());
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
  group.userData.baseOpacity = 1.0;

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
    _mouseMoved = true;
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

    // Accumulate for drag (adds depth offset on next drag move)
    _drag.depthOffset.x += ox;
    _drag.depthOffset.y += oy;
    _drag.depthOffset.z += oz;

    // Directly move node data + Three.js mesh for immediate visual feedback
    const gd = graph.graphData();

    node.x = (node.x || 0) + ox;
    node.y = (node.y || 0) + oy;
    node.z = (node.z || 0) + oz;
    node.fx = node.x; node.fy = node.y; node.fz = node.z;
    const nodeObj = _anchorTagObjects.get(node.id);
    if (nodeObj) nodeObj.position.set(node.x, node.y, node.z);

    // Move rigid-body group
    for (const n of gd.nodes) {
      if (n === node) continue;
      if (_drag.dragSet.has(n.id)) {
        n.x = (n.x || 0) + ox;
        n.y = (n.y || 0) + oy;
        n.z = (n.z || 0) + oz;
        n.fx = n.x; n.fy = n.y; n.fz = n.z;
        const nObj = _anchorTagObjects.get(n.id);
        if (nObj) nObj.position.set(n.x, n.y, n.z);
      }
    }

    // Keep prevPos in sync + mark dirty
    _drag.prevPos = { x: node.x, y: node.y, z: node.z };
    _linkPosDirty = true;
    _instancesDirty = true;
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
  try { storage.setItem(_posStorageKey, JSON.stringify(positions)); } catch (_) {}
}

function restoreNodePositions(nodes) {
  try {
    const saved = JSON.parse(storage.getItem(_posStorageKey) || '{}');
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
  const anchorRadius = anchors.length > 1 ? 500 + anchors.length * 150 : 0;
  const ANCHOR_Y = 400;
  const TAG_Y = ANCHOR_Y - 180;
  const SPHERE_GAP = 120;

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
      const tagRingRadius = Math.max(280, childTags.length * 120);

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
          const r = 70 + Math.sqrt(tagMems.length) * 14;
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
      const r = 70 + Math.sqrt(directMems.length) * 14;
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
    const orphanBase = anchorRadius + 250;

    groupNames.forEach((c, gi) => {
      const angle = (gi / Math.max(groupNames.length, 1)) * Math.PI * 2;
      const cx = Math.cos(angle) * orphanBase;
      const cz = Math.sin(angle) * orphanBase;
      const mems = catGroups[c];
      const r = 70 + Math.sqrt(mems.length) * 14;
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
  const savedPositions = JSON.parse(storage.getItem(_posStorageKey) || '{}');
  const hasSaved = Object.keys(savedPositions).length > 0;

  if (hasSaved) {
    restoreNodePositions(visibleNodes);
  } else {
    computeLayout(visibleNodes);
  }

  graph.graphData({ nodes: visibleNodes, links: visibleLinks });

  // ── Sync anchor/tag Three.js objects with scene ──
  const currentIds = new Set(visibleNodes.map(n => n.id));

  // Remove objects for nodes no longer present
  for (const [id, obj] of _anchorTagObjects) {
    if (!currentIds.has(id)) {
      _scene.remove(obj);
      // Dispose textures from sprites
      obj.traverse(child => {
        if (child.material) {
          if (child.material.map) child.material.map.dispose();
          child.material.dispose();
        }
        if (child.geometry) child.geometry.dispose();
      });
      _anchorTagObjects.delete(id);
    }
  }

  // Add/update anchor/tag objects
  for (const n of visibleNodes) {
    if (!n.payload || (!n.payload._isAnchor && !n.payload._isTag)) continue;

    const existing = _anchorTagObjects.get(n.id);
    if (existing) {
      // Already exists — update position
      existing.position.set(n.x || 0, n.y || 0, n.z || 0);
      n.__threeObj = existing; // keep compat for animate loop
      continue;
    }

    // Create new anchor/tag Three.js object
    let obj;
    if (n.payload._isAnchor) obj = createAnchorObject(n);
    else if (n.payload._isTag) obj = createTagObject(n);

    if (obj) {
      obj.position.set(n.x || 0, n.y || 0, n.z || 0);
      _scene.add(obj);
      _anchorTagObjects.set(n.id, obj);
      n.__threeObj = obj; // compat for animate loop
    }
  }

  // Rebuild flat array for fast iteration in animate()
  _anchorTagArray = Array.from(_anchorTagObjects.values());

  // Rebuild instance mapping for instanced memory node rendering
  rebuildInstanceMap();

  _linkBatchDirty = true;
  _linkPosDirty = true;

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
  _linkPosDirty = true;
}

let _linksFetching = false;
export async function setLinkMode(mode) {
  state.linkMode = mode;
  if (mode === 'off') {
    noLinksScaleBoost = 1.4;
    applyLinkVisibility();
    return;
  }

  noLinksScaleBoost = 1.0;

  // Lazy-load links from server on first enable
  if (state.allLinks.length === 0 && !_linksFetching) {
    _linksFetching = true;
    try {
      const data = await fetchLinks();
      if (data.links) {
        state.allLinks = data.links;
        emit('stats-changed');
      }
    } catch (err) {
      console.error('Failed to fetch links:', err);
    } finally {
      _linksFetching = false;
    }
  }

  applyGraphData();
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
  _linkPosDirty = true;
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

// ═══════════════════════════════════════════
// CUSTOM POINTER EVENTS + RAYCASTING
// Replaces ForceGraph3D's onNodeHover/Click/Drag
// ═══════════════════════════════════════════

function _raycastMemoryNodes(ray) {
  // O(N) ray-sphere intersection against memory node positions.
  // No scene graph objects — pure math. Returns { node, dist } or null.
  let bestDist = Infinity;
  let bestNode = null;
  const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
  const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;

  for (let gi = 0, len = _glowNodeOrder.length; gi < len; gi++) {
    if (_nodeScale[gi] <= 0.01) continue; // hidden
    const node = _glowNodeOrder[gi];
    const radius = _nodeBaseRadius[gi] * _nodeScale[gi] * 1.2; // 1.2 = hit margin
    const cx = node.x || 0, cy = node.y || 0, cz = node.z || 0;

    // Ray-sphere intersection (algebraic form)
    const ecx = ox - cx, ecy = oy - cy, ecz = oz - cz;
    const b = ecx * dx + ecy * dy + ecz * dz;
    const c = ecx * ecx + ecy * ecy + ecz * ecz - radius * radius;
    const disc = b * b - c;
    if (disc < 0) continue;
    const dist = -b - Math.sqrt(disc);
    if (dist < 0 || dist >= bestDist) continue;
    bestDist = dist;
    bestNode = node;
  }
  return bestNode ? { node: bestNode, dist: bestDist } : null;
}

function _pickNode(mouseNDC) {
  // Two-pass picking: anchor/tag objects first (standard Three.js), then memory nodes (ray-sphere)
  _raycaster.setFromCamera(mouseNDC, _camera);
  const ray = _raycaster.ray;

  // Pass 1: anchor/tag objects (~50-100 Three.js Groups with PlaneGeometry hitboxes)
  if (_anchorTagArray.length > 0) {
    const hits = _raycaster.intersectObjects(_anchorTagArray, true);
    if (hits.length > 0) {
      let obj = hits[0].object;
      while (obj && !obj.userData.nodeId) obj = obj.parent;
      if (obj && obj.userData.nodeId) {
        const node = _nodeById.get(obj.userData.nodeId);
        if (node) return { node, dist: hits[0].distance };
      }
    }
  }

  // Pass 2: memory nodes (ray-sphere math — no scene objects)
  return _raycastMemoryNodes(ray);
}

let _prevHoveredNode = null;

function _onPointerMove(e) {
  if (_pointerOverUI) return;

  const rect = _graphContainer
    ? _graphContainer.getBoundingClientRect()
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  if (_drag.active) {
    _handleDragMove(e);
    return;
  }

  // Hover detection
  const hit = _pickNode(_mouse);
  const hoveredNode = hit ? hit.node : null;
  if (hoveredNode !== _prevHoveredNode) {
    handleNodeHover(hoveredNode, _prevHoveredNode);
    _prevHoveredNode = hoveredNode;
  }
}

function _onPointerDown(e) {
  if (e.button !== 0 || _pointerOverUI) return;
  _pointerDownPos = { x: e.clientX, y: e.clientY };
  _pointerDownTime = performance.now();

  const hit = _pickNode(_mouse);
  _pointerDownNode = hit ? hit.node : null;

  if (_pointerDownNode) {
    _startDrag(_pointerDownNode, e);
  }
}

function _onPointerUp(e) {
  if (e.button !== 0) return;

  if (_drag.active) {
    const wasDrag = _pointerDownPos
      ? Math.sqrt(
          (e.clientX - _pointerDownPos.x) ** 2 +
          (e.clientY - _pointerDownPos.y) ** 2
        ) >= 5
      : true;

    _endDrag();

    // If pointer barely moved, treat as click on the originally picked node
    if (!wasDrag && _pointerDownNode) {
      handleNodeClick(_pointerDownNode, e);
    }
    _pointerDownPos = null;
    _pointerDownNode = null;
    return;
  }

  if (!_pointerDownPos) return;
  const dx = e.clientX - _pointerDownPos.x;
  const dy = e.clientY - _pointerDownPos.y;
  const dt = performance.now() - _pointerDownTime;
  const isClick = Math.sqrt(dx * dx + dy * dy) < 5 && dt < 500;

  if (isClick) {
    const hit = _pickNode(_mouse);
    if (hit) {
      handleNodeClick(hit.node, e);
    } else {
      handleBackgroundClick();
    }
  }
  _pointerDownPos = null;
  _pointerDownNode = null;
}

function _startDrag(node, e) {
  // Drag plane: perpendicular to camera, passing through node position
  const nodePos = _dragHit.set(node.x || 0, node.y || 0, node.z || 0);
  const camDir = _camera.getWorldDirection(_mouseDir);
  _dragPlane.setFromNormalAndCoplanarPoint(camDir, nodePos);

  const { type, dragSet } = _buildDragSet(node, _graphNodes);
  _drag.active = true;
  _drag.node = node;
  _drag.type = type;
  _drag.dragSet = dragSet;
  _drag.depthOffset.set(0, 0, 0);
  _drag.prevPos = { x: node.x || 0, y: node.y || 0, z: node.z || 0 };
  _instancesDirty = true;
  document.body.style.cursor = 'grabbing';
  _controls.enabled = false; // Disable orbit during drag
}

function _handleDragMove(e) {
  if (!_drag.active || !_drag.node) return;

  _raycaster.setFromCamera(_mouse, _camera);
  if (!_raycaster.ray.intersectPlane(_dragPlane, _dragHit)) return;

  const newX = _dragHit.x + _drag.depthOffset.x;
  const newY = _dragHit.y + _drag.depthOffset.y;
  const newZ = _dragHit.z + _drag.depthOffset.z;
  const node = _drag.node;

  if (_drag.prevPos) {
    const ddx = newX - _drag.prevPos.x;
    const ddy = newY - _drag.prevPos.y;
    const ddz = newZ - _drag.prevPos.z;

    if (ddx !== 0 || ddy !== 0 || ddz !== 0) {
      for (let i = 0, len = _graphNodes.length; i < len; i++) {
        const n = _graphNodes[i];
        if (n === node || !_drag.dragSet.has(n.id)) continue;
        n.x = (n.x || 0) + ddx;
        n.y = (n.y || 0) + ddy;
        n.z = (n.z || 0) + ddz;
        n.fx = n.x; n.fy = n.y; n.fz = n.z;
        // Move anchor/tag Three.js object if exists
        const obj = _anchorTagObjects.get(n.id);
        if (obj) obj.position.set(n.x, n.y, n.z);
      }
    }
  }

  node.x = newX; node.y = newY; node.z = newZ;
  node.fx = node.x; node.fy = node.y; node.fz = node.z;
  const nodeObj = _anchorTagObjects.get(node.id);
  if (nodeObj) nodeObj.position.set(node.x, node.y, node.z);

  _drag.prevPos = { x: newX, y: newY, z: newZ };
  _linkPosDirty = true;
  _instancesDirty = true;
}

function _endDrag() {
  if (!_drag.active) return;
  const node = _drag.node;
  if (node) { node.fx = node.x; node.fy = node.y; node.fz = node.z; }
  document.body.style.cursor = state.hoveredNodeId ? 'grab' : 'default';
  _drag.active = false;
  _drag.node = null;
  _drag.type = null;
  _drag.dragSet = new Set();
  _drag.prevPos = null;
  _drag.depthOffset.set(0, 0, 0);
  _controls.enabled = true; // Re-enable orbit
  _linkPosDirty = true;
  _instancesDirty = true;
  schedulePositionSave();
}

function _initPointerEvents(canvas) {
  canvas.addEventListener('pointermove', _onPointerMove);
  canvas.addEventListener('pointerdown', _onPointerDown);
  canvas.addEventListener('pointerup', _onPointerUp);
}

// ═══════════════════════════════════════════

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
  _instancesDirty = true;

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
    _instancesDirty = true;
    emit('multiselect:update');
    return;
  }

  // Regular click: clear multi-select, navigate
  if (state.multiSelected.size > 0) {
    state.multiSelected.clear();
    _instancesDirty = true;
    emit('multiselect:update');
  }
  navigateToNode(node);
}

export function navigateToNode(node, { zoom = 'close' } = {}) {
  if (!node) return;
  if (node.payload && (node.payload._isAnchor || node.payload._isTag)) return;
  state.selectedNodeId = node.id;
  _instancesDirty = true;
  storage.setItem(KEYS.SELECTED_NODE, node.id);

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
// INSTANCED MEMORY NODES — static, dirty-flag
// ═══════════════════════════════════════════

function _updateMemoryNodesInstanced() {
  const nodeCount = _glowNodeOrder.length;
  if (nodeCount === 0) return;
  if (!_instancesDirty) return;
  _instancesDirty = false;

  // Phase 1: compute final state directly (no animation, no lerp)
  for (let gi = 0; gi < nodeCount; gi++) {
    const node = _glowNodeOrder[gi];
    const nodeId = node.id;

    const isHovered = nodeId === state.hoveredNodeId;
    const isSelected = nodeId === state.selectedNodeId;
    const isDragMember = _drag.active && _drag.dragSet.has(nodeId);
    const isMultiSelected = state.multiSelected.has(nodeId);
    const isCatHidden = !state.activeCategories.has(node.payload.category);
    const isSearchMatch = state.searchResults !== null && state.searchResults.has(nodeId);
    const isSearchMiss = state.searchResults !== null && !isSearchMatch;

    // Opacity — direct target, no interpolation
    let opacity = _nodeBaseOpacity[gi];
    if (isSearchMatch) opacity = 0.85;
    else if (isSearchMiss) opacity = 0;
    if (isCatHidden) opacity = 0;
    if (_drag.active && !isCatHidden) {
      if (isDragMember) opacity = Math.max(opacity, 0.6);
      else opacity *= 0.35;
    }
    if (isHovered) opacity = 0.75;
    if (isSelected) opacity = 0.85;
    if (isMultiSelected) opacity = 0.7;
    _nodeOpacity[gi] = opacity;

    // Glow opacity
    const glowMult = isSearchMatch ? 0.95 : 0.85;
    _nodeGlowOpacity[gi] = opacity * glowMult;

    // Color — direct set, no interpolation
    if (isMultiSelected) {
      _nodeColorR[gi] = _MULTI_SELECT_BLUE.r;
      _nodeColorG[gi] = _MULTI_SELECT_BLUE.g;
      _nodeColorB[gi] = _MULTI_SELECT_BLUE.b;
    } else {
      _nodeColorR[gi] = _nodeBaseColorR[gi];
      _nodeColorG[gi] = _nodeBaseColorG[gi];
      _nodeColorB[gi] = _nodeBaseColorB[gi];
    }

    // Scale — direct target, no interpolation
    let scale = 1.0;
    if (isCatHidden || isSearchMiss) scale = 0;
    else if (isSearchMatch) scale = 1.8;
    if (isSelected) scale = 2.0;
    else if (isMultiSelected) scale = 1.5;
    else if (isHovered) scale = 1.6;
    scale *= noLinksScaleBoost;
    _nodeScale[gi] = scale;

    // Memory nodes have no Three.js object — raycasting uses _nodeScale[] directly
  }

  // Phase 2: compose instance matrices and upload GPU attributes
  const tiers = [_wireInstLow, _wireInstMed, _wireInstHigh];
  let globalOffset = 0;

  for (let t = 0; t < 3; t++) {
    const inst = tiers[t];
    const tierLen = _tierNodes[t].length;
    if (!inst || tierLen === 0) { globalOffset += tierLen; continue; }

    const colorArr = inst.geometry.attributes.instanceColor.array;
    const opacityArr = inst.geometry.attributes.instanceOpacity.array;

    for (let i = 0; i < tierLen; i++) {
      const gi = globalOffset + i;
      const node = _tierNodes[t][i];
      const scale = _nodeScale[gi] * _nodeBaseRadius[gi];

      // Compose matrix: position + uniform scale (no rotation)
      _instPos.set(node.x || 0, node.y || 0, node.z || 0);
      _instScaleV.set(scale, scale, scale);
      _instMatrix.compose(_instPos, _identityQuat, _instScaleV);
      inst.setMatrixAt(i, _instMatrix);

      // Color
      const ci3 = i * 3;
      colorArr[ci3]     = _nodeColorR[gi];
      colorArr[ci3 + 1] = _nodeColorG[gi];
      colorArr[ci3 + 2] = _nodeColorB[gi];

      // Opacity
      opacityArr[i] = _nodeOpacity[gi];
    }

    inst.instanceMatrix.needsUpdate = true;
    inst.geometry.attributes.instanceColor.needsUpdate = true;
    inst.geometry.attributes.instanceOpacity.needsUpdate = true;

    globalOffset += tierLen;
  }

  // Glow Points: write position + color + opacity + size
  if (_glowPoints && nodeCount > 0) {
    const posArr = _glowPointsGeo.attributes.position.array;
    const colArr = _glowPointsGeo.attributes.glowColor.array;
    const opArr  = _glowPointsGeo.attributes.glowOpacity.array;
    const sizeArr = _glowPointsGeo.attributes.glowSize.array;

    for (let gi = 0; gi < nodeCount; gi++) {
      const node = _glowNodeOrder[gi];
      const gi3 = gi * 3;

      posArr[gi3]     = node.x || 0;
      posArr[gi3 + 1] = node.y || 0;
      posArr[gi3 + 2] = node.z || 0;

      colArr[gi3]     = _nodeColorR[gi];
      colArr[gi3 + 1] = _nodeColorG[gi];
      colArr[gi3 + 2] = _nodeColorB[gi];

      opArr[gi] = _nodeGlowOpacity[gi];
      sizeArr[gi] = _nodeBaseRadius[gi] * _nodeScale[gi] * 1.4;
    }

    _glowPointsGeo.attributes.position.needsUpdate = true;
    _glowPointsGeo.attributes.glowColor.needsUpdate = true;
    _glowPointsGeo.attributes.glowOpacity.needsUpdate = true;
    _glowPointsGeo.attributes.glowSize.needsUpdate = true;
  }
}


// ═══════════════════════════════════════════
// ANIMATION LOOP
// ═══════════════════════════════════════════
function animate() {
  animFrameId = requestAnimationFrame(animate);
  const time = performance.now() * 0.001;

  TWEEN.update();

  // Update wireframe orb shader time uniform (Fresnel shimmer)
  if (_wireInstLow)  _wireInstLow.material.uniforms.uTime.value = time;
  if (_wireInstMed)  _wireInstMed.material.uniforms.uTime.value = time;
  if (_wireInstHigh) _wireInstHigh.material.uniforms.uTime.value = time;

  // WASD camera movement — delegated to camera module via event
  emit('camera-tick');

  // Update 3D mouse position via raycasting (skip when mouse hasn't moved)
  if (_mouseMoved) {
    updateMouse3D();
    _mouseMoved = false;
  }

  // Floor effect uniforms (updated by background module listening to 'animate-tick')
  emit('animate-tick', { time, graph });

  // ── Node pass ──
  if (graph) {
    const _cam = _camera;

    // Build frustum once per frame
    _cam.updateMatrixWorld();
    _projScreenMatrix.multiplyMatrices(_cam.projectionMatrix, _cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreenMatrix);
    _frustumPadded.copy(_frustum);
    for (let _pi = 0; _pi < 6; _pi++) _frustumPadded.planes[_pi].constant += 60;

    // ── Pass 1: Anchor/Tag nodes only (~50-100 objects, not 3500) ──
    for (let _ni = 0, _nlen = _anchorTagArray.length; _ni < _nlen; _ni++) {
      const obj = _anchorTagArray[_ni];
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

      // Zone 2: fully outside — decay to invisible, then skip entirely
      if (_cullZone === 2) {
        // Already fully faded — skip all work
        if (obj.userData._currentScale <= 0.01) {
          const dotOp = dot ? dot.material.opacity : 0;
          const labelOp = label ? (label.material.uniforms ? label.material.uniforms.uOpacity.value : label.material.opacity) : 0;
          const glowOp = obj.userData.glow ? obj.userData.glow.material.opacity : 0;
          if (dotOp === 0 && labelOp === 0 && glowOp === 0) continue;
        }
        if (dot) {
          dot.material.opacity *= 0.85;
          if (dot.material.opacity < 0.005) dot.material.opacity = 0;
        }
        if (label) {
          if (label.material.uniforms) {
            label.material.uniforms.uOpacity.value *= 0.85;
            if (label.material.uniforms.uOpacity.value < 0.005) label.material.uniforms.uOpacity.value = 0;
          } else {
            label.material.opacity *= 0.85;
            if (label.material.opacity < 0.005) label.material.opacity = 0;
          }
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
        let labelTarget = 1.0;
        if (!state.labelsVisible) labelTarget = 0;
        if (isCatHidden) { dotTarget = 0; labelTarget = 0; }
        else if (state.searchResults !== null && !state.searchResults.has(obj.userData.nodeId)) {
          dotTarget = 0; labelTarget = 0;
        }
        if (_drag.active && !isCatHidden) {
          if (_drag.dragSet.has(obj.userData.nodeId)) dotTarget = Math.max(dotTarget, 0.9);
          else { dotTarget *= 0.5; labelTarget *= 0.4; }
        }
        if (isHovered) { dotTarget = 1.0; labelTarget = 1.0; }
        if (isSelected) dotTarget = 1.0;
        if (_cullZone === 1) { dotTarget *= 0.5; }

        const fade = isCatHidden ? 0.15 : 0.1;
        if (dot) dot.material.opacity += (dotTarget * breathe - dot.material.opacity) * fade;
        if (label) {
          if (label.material.uniforms) {
            label.material.uniforms.uOpacity.value += (labelTarget - label.material.uniforms.uOpacity.value) * fade;
          } else {
            label.material.opacity += (labelTarget - label.material.opacity) * fade;
          }
          // Billboard: face camera
          label.quaternion.copy(_cam.quaternion);
        }

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
        let labelTarget = 1.0;
        if (!state.labelsVisible) labelTarget = 0;

        if (isCatHidden) { dotTarget = 0; labelTarget = 0; }
        else if (state.searchResults !== null && !state.searchResults.has(obj.userData.nodeId)) {
          dotTarget = 0; labelTarget = 0;
        }
        if (_drag.active && !isCatHidden) {
          if (_drag.dragSet.has(obj.userData.nodeId)) dotTarget = Math.max(dotTarget, 0.8);
          else { dotTarget *= 0.4; labelTarget *= 0.5; }
        }
        if (isHovered) { dotTarget = 1.0; labelTarget = 1.0; }
        if (isSelected) dotTarget = 1.0;
        if (_cullZone === 1) { dotTarget *= 0.5; }

        const fade = isCatHidden ? 0.15 : 0.1;
        if (dot) dot.material.opacity += (dotTarget * breathe - dot.material.opacity) * fade;
        if (label) {
          if (label.material.uniforms) {
            label.material.uniforms.uOpacity.value += (labelTarget - label.material.uniforms.uOpacity.value) * fade;
          } else {
            label.material.opacity += (labelTarget - label.material.opacity) * fade;
          }
          // Billboard: face camera
          label.quaternion.copy(_cam.quaternion);
        }

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

    }

    // ── Pass 2: Memory nodes (instanced rendering) ──
    _updateMemoryNodesInstanced();

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
            // Hide links where both endpoints are not search matches
            if (state.searchResults !== null) {
              const srcMatch = state.searchResults.has(srcId);
              const tgtMatch = state.searchResults.has(tgtId);
              if (!srcMatch && !tgtMatch) continue;
            }
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

      // Update positions only when nodes have moved (drag, layout change)
      if (_linkPosDirty) {
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
        _linkPosDirty = false;
      }

      // Sync opacity from GFX slider
      const targetOp = gfx.linkOpacity || 0.12;
      if (_linkBatch.material.opacity !== targetOp) _linkBatch.material.opacity = targetOp;
    }
  }

  // ── Render ── (single render loop — no more ForceGraph3D internal loop)
  if (_controls) _controls.update(); // damping
  if (_composer) {
    _composer.render();
  } else if (_renderer && _scene && _camera) {
    _renderer.render(_scene, _camera);
  }
}

// ═══════════════════════════════════════════
// GRAPH INITIALIZATION
// ═══════════════════════════════════════════

/**
 * Initialize the 3D graph with raw Three.js (no ForceGraph3D dependency).
 * @param {HTMLElement} container  The DOM element to render into (e.g. #graph-container)
 * @param {Object} [options]       Optional callbacks
 * @param {Function} [options.onApplyBgTheme]  Called after graph is built to apply background
 * @returns {Object} The graph proxy object
 */
export function initGraph(container, options = {}) {
  _graphContainer = container;

  // Initialize mouse tracking and UI guards
  _initMouseTracking();
  _initUIGuards();

  // ── 1. Renderer ──
  _renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false,
  });
  _renderer.setPixelRatio(window.devicePixelRatio);
  _renderer.setSize(container.offsetWidth, container.offsetHeight);
  _renderer.setClearColor(new THREE.Color('#050505'));
  _renderer.toneMapping = THREE.NoToneMapping;
  _renderer.sortObjects = false;
  _renderer.info.autoReset = false;
  container.appendChild(_renderer.domElement);

  // ── 2. Scene ──
  _scene = new THREE.Scene();

  // ── 3. Camera ──
  _camera = new THREE.PerspectiveCamera(
    70,
    container.offsetWidth / container.offsetHeight,
    0.1,
    50000,
  );
  _camera.position.set(0, 500, 1000);

  // ── 4. OrbitControls ──
  _controls = new OrbitControls(_camera, _renderer.domElement);
  _controls.enableDamping = true;
  _controls.dampingFactor = 0.08;

  // ── 5. EffectComposer + RenderPass ──
  _composer = new EffectComposer(_renderer);
  _composer.addPass(new RenderPass(_scene, _camera));

  // ── 6. Resize handler ──
  window.addEventListener('resize', _onResize);

  // ── 7. Assign proxy as `graph` ──
  graph = graphProxy;

  // ── 8. Pointer events for hover/click/drag (custom raycasting) ──
  _initPointerEvents(_renderer.domElement);

  // Init instanced rendering for memory nodes (MUST be before applyGraphData
  // so rebuildInstanceMap() can set instance counts on the already-created meshes)
  initInstancedRendering();

  // Apply data (layout is computed, positions are pinned)
  applyGraphData();

  // One-time reset: clear saved positions for new layout version
  if (storage.getItem(KEYS.LAYOUT_VERSION) !== 'v6-polished') {
    try { storage.removeItem(_posStorageKey); } catch (_) {}
    storage.setItem(KEYS.LAYOUT_VERSION, 'v6-polished');
  }

  // Apply link visibility
  applyLinkVisibility();

  // Bloom post-processing (half resolution for performance)
  if (gfx.bloomEnabled !== false) {
    _bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.floor(container.offsetWidth / 2), Math.floor(container.offsetHeight / 2)),
      0.5,   // strength
      0.5,   // radius
      0.25   // threshold
    );
    _composer.addPass(_bloomPass);
  }

  // OutputPass: converts linear→sRGB for correct display brightness
  _composer.addPass(new OutputPass());

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
// RESIZE HANDLER
// ═══════════════════════════════════════════
function _onResize() {
  if (!_graphContainer || !_camera || !_renderer || !_composer) return;
  const w = _graphContainer.offsetWidth;
  const h = _graphContainer.offsetHeight;
  _camera.aspect = w / h;
  _camera.updateProjectionMatrix();
  _renderer.setSize(w, h);
  _composer.setSize(w, h);
  if (_bloomPass) {
    _bloomPass.resolution.set(Math.floor(w / 2), Math.floor(h / 2));
  }
}

// ═══════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════

/** Returns the graph proxy (or null before init). */
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
  _linkPosDirty = true;
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
  try { storage.removeItem(_posStorageKey); } catch (_) {}
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

/** Enable or disable bloom post-processing at runtime. */
export function setBloomEnabled(enabled) {
  if (_bloomPass) {
    _bloomPass.enabled = enabled;
  }
}

/** Returns the noLinksScaleBoost value (used by external animation code). */
export function getNoLinksScaleBoost() {
  return noLinksScaleBoost;
}

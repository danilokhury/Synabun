// ═══════════════════════════════════════════
// SynaBun Neural Interface — 3D Camera System
// WASD + Q/E + Shift movement, camera HUD,
// orbit constraints, node navigation/animation
// ═══════════════════════════════════════════

import { state, emit, on } from '../../shared/state.js';
import { KEYS } from '../../shared/constants.js';
import { storage } from '../../shared/storage.js';
import { gfx } from './gfx.js';

// ── Constants ──
const FLOOR_Y = -200;
const CEILING_Y = 2500;
const CAM_BASE_SPEED = 6.0;      // base movement speed per frame
const CAM_BOOST_MULT = 3.0;      // shift multiplier
const CAM_ACCEL = 0.15;          // acceleration smoothing (0-1, higher = snappier)
const CAM_DECEL = 0.08;          // deceleration smoothing (lower = more glide)
const CAM_HEIGHT_SPEED = 4.5;    // vertical movement speed

// ── Three.js reusable vectors (global THREE from CDN) ──
const _camVelocity = new THREE.Vector3();
const _camMoveDir  = new THREE.Vector3();
const _camForward  = new THREE.Vector3();
const _camRight    = new THREE.Vector3();

// ── Key state ──
const _camKeys = {
  w: false, a: false, s: false, d: false,
  q: false, e: false, shift: false, space: false,
};

// ── Module state ──
let _graph = null;
let _origControlsUpdate = null;
let _camMoving = false;
let _camHudVisible = false;
let _camHudTimeout = null;
let _hudDrag = null;
let _camHudPinned = storage.getItem(KEYS.CAM_HUD_PINNED) === 'true';
let _mouseDown = false;  // track mouse button for fly-towards-look movement
let _lastFrameTime = 0;  // for deltaTime computation
let _tweenCancelled = false;  // track if we've cancelled tweens this key-press

// ── HUD DOM references (cached at init) ──
let _$camHud, _$compassFov, _$compassNeedle, _$altFill, _$altValue, _$camSpeed;
let _$keyQ, _$keyW, _$keyE, _$keyA, _$keyS, _$keyD;


// ═══════════════════════════════════════════
// ORBIT CONSTRAINTS
// ═══════════════════════════════════════════

/**
 * Apply orbit control constraints: damping, speed, zoom limits,
 * floor/ceiling enforcement via controls.update override.
 */
function applyOrbitConstraints() {
  const controls = _graph.controls();
  if (!controls) return;

  // Zoom limit: keep camera inside the sky dome
  controls.maxDistance = 2800;
  controls.minDistance = 30;

  // Enable damping for smooth, polished orbit feel
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Smoother zoom
  controls.zoomSpeed = 0.8;

  // Smoother rotation
  controls.rotateSpeed = 0.6;

  // Smoother pan
  controls.panSpeed = 0.6;

  // Don't auto-rotate
  controls.autoRotate = false;

  // Floor + ceiling constraint via update override
  _origControlsUpdate = controls.update.bind(controls);
  controls.update = function () {
    _origControlsUpdate();
    const cam = _graph.camera();
    if (cam.position.y < FLOOR_Y + 15) cam.position.y = FLOOR_Y + 15;
    if (cam.position.y > CEILING_Y) cam.position.y = CEILING_Y;
  };
}

/**
 * Remove orbit constraint overrides, restoring default controls.
 * Called when background/scene is cleaned up.
 */
export function removeOrbitConstraints() {
  const controls = _graph && _graph.controls();
  if (controls && _origControlsUpdate) {
    controls.update = _origControlsUpdate;
    _origControlsUpdate = null;
    controls.maxDistance = Infinity;
    controls.minDistance = 0;
  }
}


// ═══════════════════════════════════════════
// CAMERA HUD — DOM overlay with compass, altitude, key indicators
// ═══════════════════════════════════════════

/**
 * Cache all HUD DOM references. Must be called after DOM is ready.
 */
function cacheHudElements() {
  _$camHud      = document.getElementById('camera-hud');
  _$compassFov  = document.getElementById('compass-fov');
  _$compassNeedle = document.getElementById('compass-needle');
  _$altFill     = document.getElementById('alt-fill');
  _$altValue    = document.getElementById('alt-value');
  _$camSpeed    = document.getElementById('cam-speed-label');
  _$keyQ        = document.getElementById('key-q');
  _$keyW        = document.getElementById('key-w');
  _$keyE        = document.getElementById('key-e');
  _$keyA        = document.getElementById('key-a');
  _$keyS        = document.getElementById('key-s');
  _$keyD        = document.getElementById('key-d');
}

/**
 * Generate compass tick marks (major every 90 deg, minor every 15 deg).
 */
function buildCompassTicks() {
  const ticksG = document.getElementById('compass-ticks');
  if (!ticksG) return;
  for (let deg = 0; deg < 360; deg += 15) {
    const isMajor = deg % 90 === 0;
    const r1 = isMajor ? 26 : 28;
    const r2 = 32;
    const rad = (deg - 90) * Math.PI / 180;
    const x1 = 36 + r1 * Math.cos(rad);
    const y1 = 36 + r1 * Math.sin(rad);
    const x2 = 36 + r2 * Math.cos(rad);
    const y2 = 36 + r2 * Math.sin(rad);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('class', isMajor ? 'compass-tick-major' : 'compass-tick');
    ticksG.appendChild(line);
  }
}

/**
 * Set up pin toggle, drag grip, and restore persisted position.
 */
function initHudInteractions() {
  if (!_$camHud) return;

  // Restore pin state
  if (_camHudPinned) {
    _$camHud.classList.add('pinned');
    _camHudVisible = true;
  }

  // Restore saved position
  const savedPos = storage.getItem(KEYS.CAM_HUD_POS);
  if (savedPos) {
    try {
      const { right, bottom } = JSON.parse(savedPos);
      _$camHud.style.right = right + 'px';
      _$camHud.style.bottom = bottom + 'px';
    } catch {}
  }

  // Pin toggle
  const pinBtn = document.getElementById('cam-pin-btn');
  if (pinBtn) {
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _camHudPinned = !_camHudPinned;
      _$camHud.classList.toggle('pinned', _camHudPinned);
      storage.setItem(KEYS.CAM_HUD_PINNED, _camHudPinned);
      if (_camHudPinned) {
        _camHudVisible = true;
        _$camHud.classList.add('visible');
        clearTimeout(_camHudTimeout);
      }
    });
  }

  // Drag via grip
  const grip = document.getElementById('cam-drag-grip');
  if (grip) {
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = _$camHud.getBoundingClientRect();
      _hudDrag = {
        startX: e.clientX, startY: e.clientY,
        startRight: window.innerWidth - rect.right,
        startBottom: window.innerHeight - rect.bottom,
      };
      _$camHud.classList.add('dragging');
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (!_hudDrag) return;
    const dx = e.clientX - _hudDrag.startX;
    const dy = e.clientY - _hudDrag.startY;
    const newRight = Math.max(0, _hudDrag.startRight - dx);
    const newBottom = Math.max(0, _hudDrag.startBottom - dy);
    _$camHud.style.right = newRight + 'px';
    _$camHud.style.bottom = newBottom + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!_hudDrag) return;
    _hudDrag = null;
    _$camHud.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Persist position
    storage.setItem(KEYS.CAM_HUD_POS, JSON.stringify({
      right: parseFloat(_$camHud.style.right) || 24,
      bottom: parseFloat(_$camHud.style.bottom) || 70,
    }));
  });
}

/**
 * Show the camera HUD (with auto-hide timeout unless pinned).
 */
function showCamHud() {
  if (_camHudPinned) { _camHudVisible = true; return; }
  if (!_camHudVisible) {
    _camHudVisible = true;
    if (_$camHud) _$camHud.classList.add('visible');
  }
  clearTimeout(_camHudTimeout);
  _camHudTimeout = setTimeout(() => {
    if (!_camMoving && !_camHudPinned && !_hudDrag) {
      _camHudVisible = false;
      if (_$camHud) _$camHud.classList.remove('visible');
    }
  }, 2500);
}

/**
 * Update all camera HUD elements: compass, altitude bar, key states, speed.
 * Called every frame from updateCameraMovement.
 */
export function updateCamHud() {
  if (!_graph || (!_camHudVisible && !_camHudPinned)) return;
  const cam = _graph.camera();
  const controls = _graph.controls();
  if (!cam || !controls) return;

  // --- Compass: rotate based on camera yaw ---
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  // Yaw angle from -Z (north in 3D) projected onto XZ plane
  const yaw = Math.atan2(dir.x, dir.z);
  const yawDeg = yaw * 180 / Math.PI;

  // Rotate the entire compass ticks/labels group
  const ticksG = document.getElementById('compass-ticks');
  if (ticksG) ticksG.setAttribute('transform', `rotate(${-yawDeg}, 36, 36)`);

  // Rotate cardinal labels
  const labels = { 'N': 0, 'E': 90, 'S': 180, 'W': 270 };
  const labelEls = document.querySelectorAll('.compass-label');
  labelEls.forEach(el => {
    const card = el.textContent;
    if (labels[card] !== undefined) {
      const angleDeg = labels[card] - yawDeg;
      const angleRad = (angleDeg - 90) * Math.PI / 180;
      const r = 33;
      const x = 36 + r * Math.cos(angleRad);
      const y = 36 + r * Math.sin(angleRad);
      el.setAttribute('x', x);
      el.setAttribute('y', y);
    }
  });

  // FOV wedge
  const fov = cam.fov || 60;
  const halfFov = fov / 2;
  const wedgeR = 20;
  const a1 = (-90 - halfFov) * Math.PI / 180;
  const a2 = (-90 + halfFov) * Math.PI / 180;
  const x1 = 36 + wedgeR * Math.cos(a1);
  const y1 = 36 + wedgeR * Math.sin(a1);
  const x2 = 36 + wedgeR * Math.cos(a2);
  const y2 = 36 + wedgeR * Math.sin(a2);
  if (_$compassFov) {
    _$compassFov.setAttribute('d', `M36,36 L${x1},${y1} A${wedgeR},${wedgeR} 0 0,1 ${x2},${y2} Z`);
  }

  // --- Altitude bar (vertical) ---
  const minY = FLOOR_Y + 15;
  const maxY = CEILING_Y;
  const altPct = Math.max(0, Math.min(100, ((cam.position.y - minY) / (maxY - minY)) * 100));
  if (_$altFill) _$altFill.style.height = altPct + '%';
  if (_$altValue) _$altValue.textContent = Math.round(cam.position.y);

  // --- Key states ---
  if (_$keyQ) _$keyQ.classList.toggle('active', _camKeys.q);
  if (_$keyW) _$keyW.classList.toggle('active', _camKeys.w);
  if (_$keyE) _$keyE.classList.toggle('active', _camKeys.e || _camKeys.space);
  if (_$keyA) _$keyA.classList.toggle('active', _camKeys.a);
  if (_$keyS) _$keyS.classList.toggle('active', _camKeys.s);
  if (_$keyD) _$keyD.classList.toggle('active', _camKeys.d);

  // --- Speed label ---
  const speed = _camVelocity.length();
  if (speed > 0.1) {
    if (_camKeys.shift) {
      if (_$camSpeed) _$camSpeed.innerHTML = `<span class="boost">BOOST</span> ${speed.toFixed(1)}`;
    } else {
      if (_$camSpeed) _$camSpeed.textContent = `MOVE ${speed.toFixed(1)}`;
    }
  } else {
    if (_$camSpeed) _$camSpeed.textContent = 'MOVE';
  }
}


// ═══════════════════════════════════════════
// WASD MOVEMENT — per-frame update
// ═══════════════════════════════════════════

/**
 * Per-frame camera movement update. Call from the animation loop.
 * Reads _camKeys state, computes smoothed velocity, applies to camera + orbit target.
 */
export function updateCameraMovement() {
  if (!_graph) return;
  const cam = _graph.camera();
  const controls = _graph.controls();
  if (!cam || !controls) return;

  // DeltaTime: normalize to 60fps so constants stay the same
  const now = performance.now();
  const rawDt = _lastFrameTime ? (now - _lastFrameTime) : 16.667;
  _lastFrameTime = now;
  const dt = Math.min(rawDt, 50) / 16.667;  // 1.0 at 60fps, 2.0 at 30fps, capped ~3x

  // Build desired movement direction from key states
  _camMoveDir.set(0, 0, 0);
  const anyKey = _camKeys.w || _camKeys.a || _camKeys.s || _camKeys.d || _camKeys.q || _camKeys.e || _camKeys.space;

  if (anyKey) {
    // Cancel any active camera TWEEN animation to prevent fighting
    if (!_tweenCancelled) {
      TWEEN.removeAll();
      _tweenCancelled = true;
    }

    cam.getWorldDirection(_camForward);

    if (_mouseDown) {
      // Fly mode: W/S move along full 3D look direction (towards where camera faces)
      _camForward.normalize();
      _camRight.crossVectors(_camForward, cam.up).normalize();
    } else {
      // Ground mode: W/S move on XZ plane only
      _camForward.y = 0;
      _camForward.normalize();
      _camRight.crossVectors(_camForward, cam.up).normalize();
    }

    if (_camKeys.w) _camMoveDir.add(_camForward);
    if (_camKeys.s) _camMoveDir.sub(_camForward);
    if (_camKeys.d) _camMoveDir.add(_camRight);
    if (_camKeys.a) _camMoveDir.sub(_camRight);

    // Height: Q = down, E = up, Space = up
    if (_camKeys.e) _camMoveDir.y += 1;
    if (_camKeys.q) _camMoveDir.y -= 1;
    if (_camKeys.space) _camMoveDir.y += 1;

    if (_camMoveDir.lengthSq() > 0) _camMoveDir.normalize();

    const speed = CAM_BASE_SPEED * (_camKeys.shift ? CAM_BOOST_MULT : 1);

    // Scale speed by distance from target -- sqrt curve, gentler at close range
    const distToTarget = cam.position.distanceTo(controls.target);
    const distScale = Math.max(0.7, Math.min(4.0, Math.sqrt(distToTarget / 100)));

    _camMoveDir.multiplyScalar(speed * distScale * dt);

    // Vertical speed is independent
    if (_camKeys.e || _camKeys.q || _camKeys.space) {
      const hSpeed = CAM_HEIGHT_SPEED * (_camKeys.shift ? CAM_BOOST_MULT : 1) * distScale * dt;
      const hDir = (_camKeys.e || _camKeys.space ? 1 : 0) + (_camKeys.q ? -1 : 0);
      _camMoveDir.y = hDir * hSpeed;
    }

    _camMoving = true;
    showCamHud();
  } else {
    _camMoving = false;
    _tweenCancelled = false;
  }

  // Smooth acceleration/deceleration (frame-rate independent)
  const smoothing = anyKey ? CAM_ACCEL : CAM_DECEL;
  const dtSmoothing = 1 - Math.pow(1 - smoothing, dt);
  _camVelocity.lerp(_camMoveDir, dtSmoothing);

  // Apply movement to both camera and orbit target
  if (_camVelocity.lengthSq() > 0.001) {
    cam.position.add(_camVelocity);
    controls.target.add(_camVelocity);

    // Enforce floor/ceiling constraints
    if (cam.position.y < FLOOR_Y + 15) {
      const diff = (FLOOR_Y + 15) - cam.position.y;
      cam.position.y = FLOOR_Y + 15;
      controls.target.y += diff;
    }
    if (cam.position.y > CEILING_Y) {
      const diff = CEILING_Y - cam.position.y;
      cam.position.y = CEILING_Y;
      controls.target.y += diff;
    }

    showCamHud();
  } else {
    _camVelocity.set(0, 0, 0);
  }

  updateCamHud();
}


// ═══════════════════════════════════════════
// KEYBOARD LISTENERS — WASD + Q/E + Shift + Space
// ═══════════════════════════════════════════

/**
 * Bind keydown/keyup/blur listeners for camera movement keys.
 * Returns a cleanup function that removes all listeners.
 */
function bindKeyListeners() {
  function onKeyDown(e) {
    const inInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
    if (inInput) return;

    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e') {
      e.preventDefault();
      _camKeys[k] = true;
    }
    if (e.key === 'Shift') _camKeys.shift = true;
    if (k === ' ') { e.preventDefault(); _camKeys.space = true; }
  }

  function onKeyUp(e) {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e') {
      _camKeys[k] = false;
    }
    if (e.key === 'Shift') _camKeys.shift = false;
    if (k === ' ') _camKeys.space = false;
  }

  function onBlur() {
    _camKeys.w = _camKeys.a = _camKeys.s = _camKeys.d = false;
    _camKeys.q = _camKeys.e = _camKeys.shift = _camKeys.space = false;
    _mouseDown = false;
    _lastFrameTime = 0;  // avoid deltaTime spike on refocus
  }

  function onMouseDown(e) { if (e.button === 0 || e.button === 2) _mouseDown = true; }
  function onMouseUp()    { _mouseDown = false; }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);

  return () => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('blur', onBlur);
  };
}


// ═══════════════════════════════════════════
// CAMERA ANIMATION — smooth transitions to nodes
// ═══════════════════════════════════════════

/**
 * Animate the camera to focus on a specific node.
 * Uses the gfx clickZoom/gentleZoom distance from gfx config.
 *
 * @param {object} node  - The graph node (must have x, y, z)
 * @param {object} [opts]
 * @param {'close'|'gentle'} [opts.zoom='close'] - Zoom level preset
 * @param {number} [opts.duration=1500] - Transition duration in ms
 */
export function animateCameraToNode(node, { zoom = 'close', duration = 1500 } = {}) {
  if (!_graph || !node) return;
  const dist = zoom === 'gentle' ? gfx.gentleZoom : gfx.clickZoom;
  _graph.cameraPosition(
    { x: node.x + dist, y: node.y + dist * 0.4, z: node.z + dist },
    { x: node.x, y: node.y, z: node.z },
    duration,
  );
}

/**
 * Animate the camera to frame a bounding region (e.g. tag cluster).
 *
 * @param {object} center - { x, y, z } center of the bounding box
 * @param {number} span   - Largest dimension of the bounding box
 * @param {number} [duration=1500] - Transition duration in ms
 */
export function animateCameraToRegion(center, span, duration = 1500) {
  if (!_graph) return;
  const dist = span * 1.1 + 30;
  _graph.cameraPosition(
    { x: center.x + dist * 0.5, y: center.y + dist * 0.3, z: center.z + dist * 0.5 },
    { x: center.x, y: center.y, z: center.z },
    duration,
  );
}

/**
 * Set camera to a specific position/lookAt with optional smooth transition.
 *
 * @param {object} position - { x, y, z } camera position
 * @param {object} lookAt   - { x, y, z } orbit target / look-at point
 * @param {number} [duration=2000] - Transition duration in ms (0 = instant)
 */
export function setCameraPosition(position, lookAt, duration = 2000) {
  if (!_graph) return;
  _graph.cameraPosition(position, lookAt, duration);
}

/**
 * Frame the camera to show the entire graph based on node extent.
 * Used when loading layouts / initial data.
 *
 * @param {object[]} nodes - Array of nodes with x, y, z
 * @param {number} [duration=2000] - Transition duration in ms
 */
export function frameCameraToExtent(nodes, duration = 2000) {
  if (!_graph || !nodes || nodes.length === 0) return;
  let maxDist = 0;
  for (const n of nodes) {
    const x = n.x || 0, y = n.y || 0, z = n.z || 0;
    const d = Math.sqrt(x * x + y * y + z * z);
    if (d > maxDist) maxDist = d;
  }
  const camDist = Math.max(400, maxDist * 2.2);
  _graph.cameraPosition(
    { x: camDist * 0.7, y: camDist * 0.5, z: camDist * 0.7 },
    { x: 0, y: 0, z: 0 },
    duration,
  );
}

/**
 * Save current camera state (position + lookAt) for layout presets.
 * @returns {{ position: {x,y,z}, lookAt: {x,y,z} } | null}
 */
export function saveCameraState() {
  if (!_graph) return null;
  const cam = _graph.camera();
  const controls = _graph.controls();
  if (!cam || !controls) return null;
  return {
    position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
    lookAt: controls.target
      ? { x: controls.target.x, y: controls.target.y, z: controls.target.z }
      : { x: 0, y: 0, z: 0 },
  };
}

/**
 * Restore camera from a saved state (layout preset).
 * @param {{ position: {x,y,z}, lookAt: {x,y,z} }} cameraState
 * @param {number} [duration=2000]
 */
export function restoreCameraState(cameraState, duration = 2000) {
  if (!_graph || !cameraState) return;
  _graph.cameraPosition(cameraState.position, cameraState.lookAt, duration);
}


// ═══════════════════════════════════════════
// INIT — main entry point
// ═══════════════════════════════════════════

/**
 * Initialize the full camera system: WASD movement, HUD, orbit constraints, keyboard listeners.
 *
 * @param {object} graph - The ForceGraph3D instance
 * @returns {{ destroy: Function }} Cleanup handle
 */
export function initCamera(graph) {
  _graph = graph;

  // Cache HUD DOM references
  cacheHudElements();

  // Build compass tick marks
  buildCompassTicks();

  // Set up HUD pin/drag interactions
  initHudInteractions();

  // Apply orbit constraints (damping, zoom limits, floor/ceiling)
  applyOrbitConstraints();

  // Bind WASD keyboard listeners
  const unbindKeys = bindKeyListeners();

  // Return cleanup handle
  return {
    destroy() {
      unbindKeys();
      removeOrbitConstraints();
      clearTimeout(_camHudTimeout);
      _graph = null;
    },
  };
}

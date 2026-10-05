// ── Memory map renderer ──
//
// The whole scene is a handful of draw calls: an optional chart grid, one
// soft haze disc per island, every memory in a single THREE.Points, the
// selected memory's neighbour lines, and a small overlay of highlighted points.
// No post-processing, no lights, no decorations.
//
// Frames are rendered on demand: input, camera flights, morphs and label fades
// wake a requestAnimationFrame loop that stops two quiet frames after the last
// movement, so an idle map costs nothing.

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, InstancedBufferAttribute,
  InstancedBufferGeometry, LineSegments, Matrix4, Mesh, NormalBlending, OrbitControls, PerspectiveCamera,
  Points, Scene, ShaderMaterial, Vector3, WebGLRenderer,
} from 'three';
import { createResizeCoalescer } from '../../shared/graph-activity.js';
import * as S from './map-shaders.js';

export const FOV = 50;
const CLEAR_COLOR = 0x07080b;
const OVERLAY_MAX = 256;
const LINES_MAX = 64;
const ease = (t) => 1 - Math.pow(1 - t, 3);

export function createMapRenderer(container, hooks = {}) {
  const renderer = new WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(CLEAR_COLOR, 1);
  const canvas = renderer.domElement;
  canvas.id = 'map-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Memory map');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none;z-index:1;';
  container.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 200000);
  camera.position.set(0, 1600, 2400);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = false; // pan along the ground, like a map
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.minDistance = 6;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 1.15;
  controls.keyPanSpeed = 28;
  controls.listenToKeyEvents(canvas);

  const shared = {
    uMorph: { value: 1 },
    uBasePx: { value: S.POINT_PX },
    uRefDist: { value: 1200 },
    uPixelRatio: { value: pixelRatio },
  };
  const base = { transparent: true, depthTest: false, depthWrite: false };

  // ── Layers ──
  const pointsMat = new ShaderMaterial({
    ...base, blending: AdditiveBlending,
    uniforms: { ...shared, uRecencyMix: { value: 1 } },
    vertexShader: S.pointsVertex, fragmentShader: S.pointsFragment,
  });
  let pointsGeo = new BufferGeometry();
  const points = new Points(pointsGeo, pointsMat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  scene.add(points);

  const overlayGeo = new BufferGeometry();
  const ov = {
    position: new Float32Array(OVERLAY_MAX * 3), from: new Float32Array(OVERLAY_MAX * 3),
    color: new Float32Array(OVERLAY_MAX * 3), size: new Float32Array(OVERLAY_MAX), kind: new Float32Array(OVERLAY_MAX),
  };
  for (const [name, arr, width] of [['position', ov.position, 3], ['aFrom', ov.from, 3], ['aColor', ov.color, 3], ['aSize', ov.size, 1], ['aKind', ov.kind, 1]]) {
    overlayGeo.setAttribute(name, new BufferAttribute(arr, width).setUsage(DynamicDrawUsage));
  }
  overlayGeo.setDrawRange(0, 0);
  const overlay = new Points(overlayGeo, new ShaderMaterial({
    ...base, blending: NormalBlending, uniforms: { ...shared },
    vertexShader: S.overlayVertex, fragmentShader: S.overlayFragment,
  }));
  overlay.frustumCulled = false;
  overlay.renderOrder = 4;
  scene.add(overlay);

  const linesGeo = new BufferGeometry();
  const ln = { position: new Float32Array(LINES_MAX * 6), from: new Float32Array(LINES_MAX * 6), color: new Float32Array(LINES_MAX * 8) };
  linesGeo.setAttribute('position', new BufferAttribute(ln.position, 3).setUsage(DynamicDrawUsage));
  linesGeo.setAttribute('aFrom', new BufferAttribute(ln.from, 3).setUsage(DynamicDrawUsage));
  linesGeo.setAttribute('aColor', new BufferAttribute(ln.color, 4).setUsage(DynamicDrawUsage));
  linesGeo.setDrawRange(0, 0);
  const lines = new LineSegments(linesGeo, new ShaderMaterial({
    ...base, blending: AdditiveBlending, uniforms: { uMorph: shared.uMorph, uOpacity: { value: 1 } },
    vertexShader: S.lineVertex, fragmentShader: S.lineFragment,
  }));
  lines.frustumCulled = false;
  lines.renderOrder = 3;
  scene.add(lines);

  const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const hazeGeometry = () => {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(QUAD, 3));
    g.instanceCount = 0;
    return g;
  };
  const haze = new Mesh(hazeGeometry(), new ShaderMaterial({
    ...base, blending: AdditiveBlending, vertexShader: S.hazeVertex, fragmentShader: S.hazeFragment,
  }));
  haze.frustumCulled = false;
  haze.renderOrder = 1;
  scene.add(haze);

  let grid = null;
  const gridMat = new ShaderMaterial({
    ...base, blending: AdditiveBlending, uniforms: { uMorph: { value: 1 }, uOpacity: { value: 1 } },
    vertexShader: S.lineVertex, fragmentShader: S.lineFragment,
  });

  // ── State ──
  let positions = new Float32Array(0);
  let fromPositions = null; // during a morph
  let colors = new Float32Array(0);
  let sizes = new Float32Array(0);
  let count = 0;
  let morph = null;
  let tween = null;
  let raf = 0;
  let paused = false;
  let pointerDown = false;
  let quiet = 0;
  let inFrame = false;        // frame() is running: it alone decides whether another frame follows
  let wakeDuringFrame = false;
  let fitAllDistance = 3000;
  let viewVersion = 0; // bumps whenever what the camera sees changes (picking grids go stale)
  const stats = { frames: 0 };
  const lastCam = new Vector3(), lastTarget = new Vector3(), tmp = new Vector3();
  const viewProj = new Matrix4();

  // One frame is ever queued. controls.update() inside frame() fires 'change',
  // which lands here; queueing then as well used to double the pending frames
  // every moving frame until the tab froze. Inside a frame a wake is only noted.
  const wake = () => {
    if (paused) return;
    if (inFrame) { wakeDuringFrame = true; return; }
    if (!raf) raf = requestAnimationFrame(frame);
  };
  controls.addEventListener('change', wake);

  canvas.addEventListener('pointerdown', () => { pointerDown = true; tween = null; });
  // A drag keeps the loop running and it settles by itself once released; a
  // plain click never started it, so releasing schedules nothing.
  const release = () => { pointerDown = false; };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', () => { tween = null; }, { passive: true });

  function stepTween(now) {
    if (!tween) return false;
    const t = Math.min(1, (now - tween.t0) / tween.ms);
    const e = ease(t);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
    tmp.lerpVectors(tween.u0, tween.u1, e);
    if (tmp.lengthSq() < 1e-8) tmp.copy(tween.u1);
    tmp.normalize();
    const d = Math.exp(tween.ld0 + (tween.ld1 - tween.ld0) * e);
    camera.position.copy(controls.target).addScaledVector(tmp, d);
    if (t >= 1) { tween = null; hooks.onTweenEnd?.(); }
    return true;
  }

  function stepMorph(now) {
    if (!morph) return false;
    const t = Math.min(1, (now - morph.t0) / morph.ms);
    shared.uMorph.value = ease(t);
    if (t >= 1) {
      morph = null;
      fromPositions = null;
      shared.uMorph.value = 1;
      hooks.onMorphEnd?.();
    }
    return true;
  }

  function frame(now) {
    raf = 0;
    if (paused) return;
    inFrame = true;
    let settled = false;
    try {
      let busy = stepTween(now);
      busy = stepMorph(now) || busy;
      controls.update();
      const dist = camera.position.distanceTo(controls.target);
      const moved = camera.position.distanceTo(lastCam) + controls.target.distanceTo(lastTarget);
      lastCam.copy(camera.position);
      lastTarget.copy(controls.target);
      if (moved > dist * 1e-7) viewVersion++;
      renderer.render(scene, camera);
      stats.frames++;
      if (hooks.onFrame && hooks.onFrame(now)) busy = true;
      const still = moved <= dist * 2e-4;
      quiet = busy || !still || pointerDown ? 0 : quiet + 1;
      if (quiet >= 2) {
        // Damping's last stretch is sub-pixel: finish it in one step and stop.
        controls.enableDamping = false;
        controls.update();
        controls.enableDamping = true;
        if (camera.position.distanceTo(lastCam) + controls.target.distanceTo(lastTarget) > 0) viewVersion++;
        lastCam.copy(camera.position);
        lastTarget.copy(controls.target);
        wakeDuringFrame = false; // the flush above fired its own 'change'; only a request from onSettle counts
        hooks.onSettle?.();
        settled = !wakeDuringFrame;
      }
    } finally {
      inFrame = false;
      wakeDuringFrame = false;
    }
    if (!settled && !raf && !paused) raf = requestAnimationFrame(frame);
  }

  // ── Resize ──
  let width = 1, height = 1;
  const doResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    width = w; height = h;
    viewVersion++;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    hooks.onResize?.(w, h);
    wake();
  };
  const resize = createResizeCoalescer(doResize, 150);
  const observer = new ResizeObserver(() => resize());
  observer.observe(container);
  const onTransitionEnd = () => resize.flush();
  container.addEventListener('transitionend', onTransitionEnd);
  doResize();

  // ── Data ──
  function setPoints({ positions: pos, color, size, recency, vis }) {
    const old = pointsGeo;
    pointsGeo = new BufferGeometry();
    positions = pos; colors = color; sizes = size; count = pos.length / 3;
    pointsGeo.setAttribute('position', new BufferAttribute(pos, 3));
    // Its own copy: a morph writes the start positions into it in place.
    pointsGeo.setAttribute('aFrom', new BufferAttribute(new Float32Array(pos), 3).setUsage(DynamicDrawUsage));
    pointsGeo.setAttribute('aColor', new BufferAttribute(color, 3).setUsage(DynamicDrawUsage));
    pointsGeo.setAttribute('aSize', new BufferAttribute(size, 1));
    pointsGeo.setAttribute('aRecency', new BufferAttribute(recency, 1));
    pointsGeo.setAttribute('aVis', new BufferAttribute(vis, 1).setUsage(DynamicDrawUsage));
    points.geometry = pointsGeo;
    old.dispose();
    morph = null;
    fromPositions = null;
    shared.uMorph.value = 1;
    wake();
  }

  /** Animate every point from `from` (same order as the current positions) to where it is now. */
  function morphFrom(from, ms = 800) {
    if (!from || from.length !== positions.length) return;
    fromPositions = from;
    const attr = pointsGeo.getAttribute('aFrom');
    attr.array.set(from);
    attr.needsUpdate = true;
    shared.uMorph.value = 0;
    morph = { t0: performance.now(), ms };
    wake();
  }

  function setVisibility(vis) {
    const attr = pointsGeo.getAttribute('aVis');
    if (!attr) return;
    attr.array.set(vis);
    attr.needsUpdate = true;
    wake();
  }

  function setColors(color) {
    const attr = pointsGeo.getAttribute('aColor');
    if (!attr) return;
    attr.array.set(color);
    attr.needsUpdate = true;
    wake();
  }

  function setBounds({ radius }) {
    const r = Math.max(radius, 50);
    shared.uRefDist.value = r * 0.55;
    const vfov = (FOV * Math.PI) / 180;
    fitAllDistance = r / Math.sin(vfov / 2);
    controls.maxDistance = fitAllDistance * 1.6;
    camera.far = fitAllDistance * 6;
    camera.updateProjectionMatrix();
  }

  const posOf = (arr, i, out, o) => { out[o] = arr[3 * i]; out[o + 1] = arr[3 * i + 1]; out[o + 2] = arr[3 * i + 2]; };

  /** Highlighted points: [{ i, kind }] (0 hover · 1 selected · 2 multi · 3 neighbour · 4 search hit). */
  function setOverlay(items) {
    const m = Math.min(items.length, OVERLAY_MAX);
    for (let q = 0; q < m; q++) {
      const { i, kind } = items[q];
      posOf(positions, i, ov.position, 3 * q);
      posOf(fromPositions || positions, i, ov.from, 3 * q);
      ov.color[3 * q] = colors[3 * i]; ov.color[3 * q + 1] = colors[3 * i + 1]; ov.color[3 * q + 2] = colors[3 * i + 2];
      ov.size[q] = sizes[i];
      ov.kind[q] = kind;
    }
    for (const name of ['position', 'aFrom', 'aColor', 'aSize', 'aKind']) overlayGeo.getAttribute(name).needsUpdate = true;
    overlayGeo.setDrawRange(0, m);
    wake();
  }

  /** Lines from one point to others: [{ a, b, alphaA, alphaB, color:[r,g,b] }]. */
  function setLines(segments) {
    const m = Math.min(segments.length, LINES_MAX);
    for (let q = 0; q < m; q++) {
      const s = segments[q];
      posOf(positions, s.a, ln.position, 6 * q);
      posOf(positions, s.b, ln.position, 6 * q + 3);
      posOf(fromPositions || positions, s.a, ln.from, 6 * q);
      posOf(fromPositions || positions, s.b, ln.from, 6 * q + 3);
      const [r, g, b] = s.color;
      ln.color.set([r, g, b, s.alphaA, r, g, b, s.alphaB], 8 * q);
    }
    for (const name of ['position', 'aFrom', 'aColor']) linesGeo.getAttribute(name).needsUpdate = true;
    linesGeo.setDrawRange(0, 2 * m);
    wake();
  }

  /** One soft disc per island: [{ x, y, z, r, color:[r,g,b], alpha }]. */
  function setHaze(discs) {
    const n = discs.length;
    const center = new Float32Array(3 * n), radius = new Float32Array(n), color = new Float32Array(3 * n), alpha = new Float32Array(n);
    discs.forEach((d, i) => {
      center.set([d.x, d.y, d.z], 3 * i);
      radius[i] = d.r;
      color.set(d.color, 3 * i);
      alpha[i] = d.alpha;
    });
    const g = hazeGeometry();
    g.setAttribute('iCenter', new InstancedBufferAttribute(center, 3));
    g.setAttribute('iRadius', new InstancedBufferAttribute(radius, 1));
    g.setAttribute('iColor', new InstancedBufferAttribute(color, 3));
    g.setAttribute('iAlpha', new InstancedBufferAttribute(alpha, 1));
    g.instanceCount = n;
    const old = haze.geometry;
    haze.geometry = g;
    old.dispose();
    wake();
  }

  /** Faint polar grid on the ground: rings and spokes out to `radius`. */
  function setGrid(enabled, radius = 0) {
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid = null; }
    if (enabled && radius > 0) {
      const verts = [], cols = [];
      const push = (x, z, a) => { verts.push(x, 0, z); cols.push(0.75, 0.82, 1, a); };
      const rings = 6, seg = 160;
      for (let k = 1; k <= rings; k++) {
        const r = (radius * k) / rings;
        for (let s = 0; s < seg; s++) {
          const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
          push(Math.cos(a0) * r, Math.sin(a0) * r, 0.05);
          push(Math.cos(a1) * r, Math.sin(a1) * r, 0.05);
        }
      }
      for (let s = 0; s < 12; s++) {
        const a = (s / 12) * Math.PI * 2;
        push(0, 0, 0.0);
        push(Math.cos(a) * radius, Math.sin(a) * radius, 0.05);
      }
      const geo = new BufferGeometry();
      const pos = new Float32Array(verts);
      geo.setAttribute('position', new BufferAttribute(pos, 3));
      geo.setAttribute('aFrom', new BufferAttribute(pos, 3));
      geo.setAttribute('aColor', new BufferAttribute(new Float32Array(cols), 4));
      grid = new LineSegments(geo, gridMat);
      grid.frustumCulled = false;
      grid.renderOrder = 0;
      scene.add(grid);
    }
    wake();
  }

  function setRecency(on) { pointsMat.uniforms.uRecencyMix.value = on ? 1 : 0; wake(); }

  // ── Camera ──
  function flyTo({ target, distance = null, direction = null, ms = 600 }) {
    const fromTarget = controls.target.clone();
    const offset = camera.position.clone().sub(controls.target);
    const d0 = Math.max(offset.length(), 1e-3);
    const u0 = offset.clone().normalize();
    const u1 = direction ? new Vector3(direction[0], direction[1], direction[2]).normalize() : u0.clone();
    const d1 = Math.min(Math.max(distance ?? d0, controls.minDistance), controls.maxDistance);
    const toTarget = new Vector3(target[0], target[1], target[2]);
    if (ms <= 0) {
      controls.target.copy(toTarget);
      camera.position.copy(toTarget).addScaledVector(u1, d1);
      tween = null;
      controls.update();
      wake();
      return;
    }
    tween = { t0: performance.now(), ms, fromTarget, toTarget, u0, u1, ld0: Math.log(d0), ld1: Math.log(d1) };
    wake();
  }

  /** Fit a sphere on screen; `elevation` (radians above the ground) sets the view angle. */
  function frameSphere(sphere, { ms = 650, elevation = null, margin = 1.08 } = {}) {
    if (!sphere) return;
    const vfov = (FOV * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const half = Math.min(vfov, hfov) / 2;
    const distance = (Math.max(sphere.r, 20) / Math.sin(half)) * margin;
    let direction = null;
    if (elevation != null) {
      const offset = camera.position.clone().sub(controls.target);
      let az = Math.atan2(offset.x, offset.z);
      if (!Number.isFinite(az)) az = 0;
      direction = [Math.sin(az) * Math.cos(elevation), Math.sin(elevation), Math.cos(az) * Math.cos(elevation)];
    }
    flyTo({ target: [sphere.x, sphere.y, sphere.z], distance, direction, ms });
  }

  /**
   * Fit a set of world points (flat [x, y, z, …]) seen from `elevation`
   * radians above the ground, keeping the current compass heading. Tighter
   * than a bounding sphere for a flat, wide map.
   */
  function frameFootprint(pos, { ms = 650, elevation = 0.85, margin = 1.05, azimuth = null } = {}) {
    const n = pos.length / 3;
    if (!n) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const target = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    let az = azimuth;
    if (az == null || !Number.isFinite(az)) {
      const offset = camera.position.clone().sub(controls.target);
      az = Math.atan2(offset.x, offset.z);
      if (!Number.isFinite(az)) az = 0;
    }
    const dir = new Vector3(Math.sin(az) * Math.cos(elevation), Math.sin(elevation), Math.cos(az) * Math.cos(elevation));
    const forward = dir.clone().negate();
    const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();
    const tanV = Math.tan(((FOV * Math.PI) / 180) / 2), tanH = tanV * camera.aspect;
    // Each point needs depth ≥ its screen offset / tan(half fov); the camera sits at target + dir·d.
    let distance = 1;
    for (let i = 0; i < n; i++) {
      const px = pos[3 * i] - target.x, py = pos[3 * i + 1] - target.y, pz = pos[3 * i + 2] - target.z;
      const toward = px * dir.x + py * dir.y + pz * dir.z;
      const sx = Math.abs(px * right.x + py * right.y + pz * right.z);
      const sy = Math.abs(px * up.x + py * up.y + pz * up.z);
      const need = toward + Math.max(sx / tanH, sy / tanV);
      if (need > distance) distance = need;
    }
    flyTo({ target: [target.x, target.y, target.z], distance: distance * margin, direction: [dir.x, dir.y, dir.z], ms });
  }

  function getViewProj() {
    camera.updateMatrixWorld();
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    return viewProj.elements;
  }

  /** Screen pixels per world unit at a given view depth. */
  const pxPerUnit = (depth) => (height / 2) / Math.tan(((FOV * Math.PI) / 180) / 2) / Math.max(depth, 1e-3);

  function pause() {
    paused = true;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    controls.enabled = false;
    canvas.blur();
  }
  function resume() {
    paused = false;
    controls.enabled = true;
    wake();
  }

  function dispose() {
    pause();
    observer.disconnect();
    container.removeEventListener('transitionend', onTransitionEnd);
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
    controls.dispose();
    renderer.dispose();
    canvas.remove();
  }

  return {
    canvas, camera, controls, stats,
    setPoints, morphFrom, setVisibility, setColors, setBounds, setOverlay, setLines, setHaze, setGrid, setRecency,
    flyTo, frameSphere, frameFootprint, getViewProj, pxPerUnit,
    get fitAllDistance() { return fitAllDistance; },
    get size() { return { width, height }; },
    get morphing() { return !!morph; },
    get viewVersion() { return viewVersion; },
    get moving() { return !!raf; },
    get paused() { return paused; },
    requestRender: wake,
    pause, resume, dispose,
  };
}

// ── Memory map view ──
//
// The controller between the shared UI state and the renderer: which points
// are hidden or dimmed, what is highlighted, which labels are pinned, where
// the camera goes, and how new positions from the server morph in.

import { state, emit } from '../../shared/state.js';
import { catColor } from '../../shared/colors.js';
import { storage } from '../../shared/storage.js';
import { KEYS } from '../../shared/constants.js';
import {
  DAY_MS, boundsSphere, computeVisibility, fetchMap, fetchNeighbors, maxDisplacement, parseMap, pointAttributes,
  recencyOf, relativeDay, remapForMorph, rgbCss, samePositions, softColor, titleFromContent,
} from './map-data.js';
import { buildPickGrid, onScreen, pickNearest } from './map-pick.js';

const MAP_OPTION_DEFAULTS = { neighbors: true, recency: true, grid: false };
const ELEVATION = 0.85; // radians above the ground for the overview (~49°)
const NEIGHBOURS = 8;
const SEARCH_LABELS = 12;
const TITLE_LABELS = 40;
const REFETCH_GAP_MS = 5000;
const MISSING_FETCH_MAX = 40; // more unknown memories than this → one full reload instead

const lighten = ([r, g, b], t = 0.35) => [r + (1 - r) * t, g + (1 - g) * t, b + (1 - b) * t];
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function loadOptions() {
  try { return { ...MAP_OPTION_DEFAULTS, ...JSON.parse(storage.getItem(KEYS.MAP_VIEW) || '{}') }; }
  catch { return { ...MAP_OPTION_DEFAULTS }; }
}

export function createMapView({ renderer, labels, statusEl = null, onMissingNodes = () => {} }) {
  let map = null;
  let attrs = null;
  let vis = new Float32Array(0);
  let visInfo = { hidden: 0, dimmed: 0, islandShown: [] };
  let grid = null;
  let hovered = -1;
  let selectedId = null;
  let selected = -1;
  let lastSelect = { id: null, t: 0 };
  let neighbors = [];
  let neighborToken = 0;
  let searchIds = null;
  let searchOrder = [];
  let focusId = null;
  let focusIds = null;
  let nodeById = new Map();
  let removedIds = new Set(); // gone from state.allNodes, still in the last map
  const titleCache = new Map();
  const colorCache = new Map();
  let options = loadOptions();
  let etag = null;
  let refetchTimer = null;
  let lastRefetch = 0;
  let refetchPending = false;
  let paused = false;
  let today = Math.floor(Date.now() / DAY_MS);

  const debug = {
    frames: 0, firstPaintMs: 0, pointCount: 0, dimmedCount: 0, hiddenCount: 0, rev: '', status: '',
    morphing: false, paused: false, pickBuildMs: 0, lastPickMs: 0, labelCount: 0, overlayCount: 0, lineCount: 0,
  };
  Object.defineProperty(debug, 'frames', { get: () => renderer.stats.frames, enumerable: true });
  window.__synMap = debug;
  // For the browser test: where a memory is on screen (client px) and in the world.
  window.__synMapTest = {
    screenOf(id) {
      const i = map?.indexOf.get(id);
      if (i === undefined) return null;
      const m = renderer.getViewProj();
      const [x, y, z] = [map.positions[3 * i], map.positions[3 * i + 1], map.positions[3 * i + 2]];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 1e-6) return null;
      const r = renderer.canvas.getBoundingClientRect();
      return [r.left + ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * r.width,
        r.top + (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5) * r.height];
    },
    positionOf(id) {
      const i = map?.indexOf.get(id);
      return i === undefined ? null : [map.positions[3 * i], map.positions[3 * i + 1], map.positions[3 * i + 2]];
    },
    flyToIsland: (name, ms = 0) => flyToIsland(name, ms),
    frameAll: (ms = 0) => frameAll(ms),
  };

  // ── Colours / text ──
  const islandColor = (name) => {
    let c = colorCache.get(name);
    if (!c) { c = softColor(catColor(name)); colorCache.set(name, c); }
    return c;
  };
  const labelCss = () => (attrs ? attrs.islandColors.map((c) => rgbCss(lighten(c, 0.25), 0.95)) : []);

  function titleOf(i) {
    const id = map.ids[i];
    let t = titleCache.get(id);
    if (t === undefined) {
      const node = nodeById.get(id);
      if (!node) return null;
      t = titleFromContent(node.payload?.content) || node.payload?.category || id.slice(0, 8);
      titleCache.set(id, t);
    }
    return t;
  }

  // ── Applying data ──
  function applyMap(json, { morph = true } = {}) {
    const next = parseMap(json);
    const prev = map;
    map = next;
    for (const id of removedIds) if (!map.indexOf.has(id)) removedIds.delete(id);
    etag = json._etag || etag;
    today = Math.floor(Date.now() / DAY_MS);
    attrs = pointAttributes(map, islandColor, today);
    vis = new Float32Array(map.n);
    recomputeVisibility();
    renderer.setBounds(map.bounds);
    renderer.setPoints({ positions: map.positions, color: attrs.color, size: attrs.size, recency: attrs.recency, vis });
    renderer.setRecency(options.recency);
    const from = morph && prev && prev.n && !samePositions(prev, next) ? remapForMorph(prev, next) : null;
    // New memories simply appear; only animate when something already on screen moved.
    if (from && maxDisplacement(from, next.positions) > 0.5) {
      renderer.morphFrom(from, 800);
      debug.morphing = true;
    }
    renderer.setGrid(options.grid, map.bounds.radius);
    labels.setMap(map, labelCss(), visInfo.islandShown);
    selected = selectedId ? map.indexOf.get(selectedId) ?? -1 : -1;
    hovered = -1;
    neighbors = neighbors.map((n) => ({ ...n, i: map.indexOf.get(n.id) ?? -1 })).filter((n) => n.i >= 0);
    searchOrder = searchIds ? searchOrderFrom(searchIds) : [];
    grid = null;
    updateHaze();
    refreshOverlay();
    refreshLines();
    refreshPinned();
    updateStatus(map.status, map.progress);
    debug.pointCount = map.n;
    debug.rev = map.rev;
    debug.status = map.status;
    if (!debug.firstPaintMs) {
      // performance.now() counts from navigation start: this is time to the first map frame.
      requestAnimationFrame(() => requestAnimationFrame(() => { debug.firstPaintMs = Math.round(performance.now()); }));
    }
    if (selectedId && options.neighbors && !neighbors.length) loadNeighbors(selectedId);
    if (nodeById.size) checkMissing();
  }

  /** After state.allNodes arrived or changed: titles, tooltips, stats flags. */
  function hydrate() {
    const next = new Map(state.allNodes.map((n) => [n.id, n]));
    for (const id of nodeById.keys()) if (!next.has(id)) removedIds.add(id);
    for (const id of removedIds) if (next.has(id)) removedIds.delete(id);
    nodeById = next;
    titleCache.clear();
    markVisibleNodes();
    refreshPinned();
    if (grid) computeTitles();
    renderer.requestRender();
    kickLabels();
  }

  function recomputeVisibility() {
    if (!map) return;
    const r = computeVisibility(map, { activeCategories: state.activeCategories, searchIds, focusIds, removedIds }, vis);
    visInfo = r;
    debug.hiddenCount = r.hidden;
    debug.dimmedCount = r.dimmed;
  }

  function markVisibleNodes() {
    const active = state.activeCategories;
    for (const n of state.allNodes) n._visible = !active || active.has(n.payload?.category);
  }

  /** Categories, search or the card spotlight changed: re-derive what shows. */
  function refreshVisibility() {
    if (!map) { markVisibleNodes(); return; }
    recomputeVisibility();
    renderer.setVisibility(vis);
    labels.setShown(visInfo.islandShown);
    grid = null;
    updateHaze();
    markVisibleNodes();
    refreshOverlay();
    refreshLines();
    refreshPinned();
    renderer.requestRender();
  }

  function refreshColors() {
    if (!map) return;
    colorCache.clear();
    attrs = pointAttributes(map, islandColor, today);
    renderer.setColors(attrs.color);
    labels.setColors(labelCss());
    updateHaze();
    refreshOverlay();
    refreshLines();
  }

  function updateHaze() {
    if (!map) return;
    const faded = !!(searchIds || focusIds);
    const discs = [];
    map.islands.forEach((isl, k) => {
      if (!visInfo.islandShown[k]) return;
      discs.push({ x: isl.x, y: isl.h * 0.45, z: isl.z, r: isl.r, color: attrs.islandColors[k], alpha: faded ? 0.03 : 0.075 });
    });
    renderer.setHaze(discs);
  }

  // ── Highlights ──
  function refreshOverlay() {
    if (!map) return;
    const seen = new Set();
    const items = [];
    const add = (i, kind) => {
      if (i < 0 || i >= map.n || !(vis[i] > 0) || seen.has(i)) return;
      seen.add(i);
      items.push({ i, kind });
    };
    add(selected, 1);
    add(hovered, 0);
    for (const id of state.multiSelected) add(map.indexOf.get(id) ?? -1, 2);
    if (options.neighbors && selected >= 0) for (const n of neighbors) add(n.i, 3);
    for (const i of searchOrder) add(i, 4);
    items.reverse(); // selected draws last, on top
    renderer.setOverlay(items);
    debug.overlayCount = items.length;
  }

  function refreshLines() {
    if (!map || !options.neighbors || selected < 0 || !(vis[selected] > 0)) {
      renderer.setLines([]);
      debug.lineCount = 0;
      return;
    }
    const color = lighten(attrs.islandColors[map.islandOf[selected]], 0.3);
    const segs = neighbors
      .filter((n) => vis[n.i] > 0)
      .map((n) => ({ a: selected, b: n.i, alphaA: 0.6, alphaB: 0.15 + 0.45 * clamp01((n.score - 0.3) / 0.6), color }));
    renderer.setLines(segs);
    debug.lineCount = segs.length;
  }

  function refreshPinned() {
    if (!map) return;
    const list = [];
    if (selected >= 0 && vis[selected] > 0) {
      const text = titleOf(selected);
      if (text) list.push({ i: selected, text, kind: 'selected' });
    }
    for (const i of searchOrder.slice(0, SEARCH_LABELS)) {
      if (i === selected) continue;
      const text = titleOf(i);
      if (text) list.push({ i, text, kind: 'search' });
    }
    labels.setPinned(list);
    renderer.requestRender();
  }

  // ── Picking + settle ──
  function onSettle() {
    if (!map) return;
    const tp = performance.now();
    const { width, height } = renderer.size;
    grid = buildPickGrid(map.positions, vis, map.n, renderer.getViewProj(), width, height, 32);
    grid.viewVersion = renderer.viewVersion;
    debug.pickBuildMs = Math.round((performance.now() - tp) * 10) / 10;
    computeTitles();
    if (drawLabels(performance.now())) kickLabels();
  }

  function computeTitles() {
    if (!map || !grid || !nodeById.size) { labels.setTitles([]); return; }
    const m = renderer.getViewProj();
    const { width, height } = renderer.size;
    // Only islands big enough on screen get memory titles.
    const bigIsland = map.islands.map((isl) => {
      const cw = m[3] * isl.x + m[7] * isl.h + m[11] * isl.z + m[15];
      return cw > 1e-6 && isl.r * renderer.pxPerUnit(cw) >= 320;
    });
    if (!bigIsland.some(Boolean)) { labels.setTitles([]); return; }
    const cx = width / 2, cy = height / 2, half = Math.hypot(cx, cy);
    const scored = [];
    for (const i of onScreen(grid, 24)) {
      if (!bigIsland[map.islandOf[i]] || vis[i] < 1) continue;
      const dc = Math.hypot(grid.sx[i] - cx, grid.sy[i] - cy) / half;
      scored.push([i, (map.importance[i] / 10) * recencyOf(map.day[i], today) * (1 - 0.6 * dc)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const titles = [];
    for (const [i, score] of scored) {
      if (titles.length >= TITLE_LABELS) break;
      const text = titleOf(i);
      if (text) titles.push({ i, text, score });
    }
    labels.setTitles(titles);
  }

  function drawLabels(now) {
    const busy = labels.draw(now, { viewProj: renderer.getViewProj(), pxPerUnit: renderer.pxPerUnit });
    debug.labelCount = labels.count;
    return busy;
  }

  // Labels still fading once the scene has stopped: step them on their own
  // (2D canvas only — the WebGL scene is not re-rendered).
  let labelRaf = 0;
  function kickLabels() {
    if (labelRaf || paused) return;
    const step = (now) => {
      labelRaf = 0;
      if (paused || renderer.moving) return; // the render loop draws labels itself
      if (drawLabels(now)) labelRaf = requestAnimationFrame(step);
    };
    labelRaf = requestAnimationFrame(step);
  }

  function pickAt(x, y, maxDist = 12) {
    if (!map || !grid || grid.viewVersion !== renderer.viewVersion) return -1; // the view moved since the grid was built
    const tp = performance.now();
    const i = pickNearest(grid, x, y, maxDist);
    debug.lastPickMs = Math.round((performance.now() - tp) * 100) / 100;
    return i;
  }

  // ── Selection ──
  function select(id, { fly = true } = {}) {
    const now = performance.now();
    if (lastSelect.id === id && now - lastSelect.t < 300) return; // Explorer fires open + navigate + select
    lastSelect = { id, t: now };
    selectedId = id;
    state.selectedNodeId = id;
    selected = map ? map.indexOf.get(id) ?? -1 : -1;
    neighbors = [];
    refreshOverlay();
    refreshLines();
    refreshPinned();
    if (selected >= 0 && fly) flyToPoint(selected);
    if (id && options.neighbors) loadNeighbors(id);
  }

  async function loadNeighbors(id) {
    const token = ++neighborToken;
    const list = await fetchNeighbors(id, NEIGHBOURS);
    if (token !== neighborToken || selectedId !== id || !map) return;
    neighbors = list.map((n) => ({ id: n.id, score: n.score, i: map.indexOf.get(n.id) ?? -1 })).filter((n) => n.i >= 0);
    refreshOverlay();
    refreshLines();
  }

  function clearSelection() {
    selectedId = null;
    selected = -1;
    neighbors = [];
    neighborToken++;
    refreshOverlay();
    refreshLines();
    refreshPinned();
  }

  /** Keep the highlight in step with the detail cards (open, close, bring to front). */
  function syncSelectionFromState() {
    const id = state.selectedNodeId || null;
    if (id === selectedId) return;
    if (!id) { clearSelection(); return; }
    lastSelect = { id: null, t: 0 };
    select(id, { fly: false });
  }

  function toggleMulti(id) {
    if (state.multiSelected.has(id)) state.multiSelected.delete(id);
    else state.multiSelected.add(id);
    emit('multiselect:update');
    refreshOverlay();
  }

  function setHover(i) {
    if (i === hovered) return;
    hovered = i;
    state.hoveredNodeId = i >= 0 && map ? map.ids[i] : null;
    refreshOverlay();
  }

  /** Tooltip facts for point i. */
  function describe(i) {
    if (!map || i < 0) return null;
    const id = map.ids[i];
    const node = nodeById.get(id);
    const isl = map.islands[map.islandOf[i]];
    return {
      id,
      node,
      title: titleOf(i),
      category: node?.payload?.category || isl?.name || '',
      project: node?.payload?.project || '',
      importance: map.importance[i],
      when: relativeDay(map.day[i], today),
      color: rgbCss(lighten(attrs.islandColors[map.islandOf[i]], 0.2)),
    };
  }

  // ── Camera ──
  /** Overview: the whole map, its long axis across the screen (the camera looks along its short axis). */
  function frameAll(ms = 650) {
    if (!map || !map.n) return;
    const P = map.positions;
    let mx = 0, mz = 0;
    for (let i = 0; i < map.n; i++) { mx += P[3 * i]; mz += P[3 * i + 2]; }
    mx /= map.n; mz /= map.n;
    let sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < map.n; i++) {
      const dx = P[3 * i] - mx, dz = P[3 * i + 2] - mz;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    }
    // Principal axis angle θ in the XZ plane; the screen's right vector is (cos az, 0, −sin az).
    const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const wide = renderer.size.width >= renderer.size.height;
    renderer.frameFootprint(P, { ms, elevation: ELEVATION, azimuth: wide ? -theta : -theta + Math.PI / 2 });
  }

  function flyToPoint(i, ms = 600) {
    const isl = map.islands[map.islandOf[i]];
    const offset = renderer.camera.position.clone().sub(renderer.controls.target);
    const current = offset.length();
    const want = Math.max(70, Math.min(current, isl.r * 1.8 + 60));
    renderer.flyTo({ target: [map.positions[3 * i], map.positions[3 * i + 1], map.positions[3 * i + 2]], distance: want, ms });
  }

  function flyToIsland(name, ms = 650) {
    const k = map?.islandIndex.get(name);
    if (k === undefined) return;
    const isl = map.islands[k];
    renderer.frameSphere({ x: isl.x, y: isl.h / 2, z: isl.z, r: isl.r * 1.05 + 10 }, { ms, elevation: 0.8 });
  }

  function flyToContinent(name, ms = 650) {
    const c = map?.continents.find((x) => x.name === name);
    if (c) renderer.frameSphere({ x: c.x, y: 0, z: c.z, r: c.r }, { ms, elevation: 0.7 });
  }

  // ── Search + spotlight ──
  function searchOrderFrom(ids, results = null) {
    const order = results ? results.map((r) => r.id ?? r.memory?.id ?? r.payload?.id).filter(Boolean) : [...ids];
    const seen = new Set();
    const out = [];
    for (const id of [...order, ...ids]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const i = map.indexOf.get(id);
      if (i !== undefined) out.push(i);
    }
    return out;
  }

  function applySearch(ids, results = null) {
    searchIds = ids instanceof Set ? ids : new Set(ids || []);
    if (map) {
      searchOrder = searchOrderFrom(searchIds, results);
      refreshVisibility();
      if (searchOrder.length) {
        const s = boundsSphere(map.positions, searchOrder);
        renderer.frameSphere({ ...s, r: Math.max(s.r * 1.15, 80) }, { ms: 700 });
      }
    }
  }

  function clearSearch() {
    searchIds = null;
    searchOrder = [];
    refreshVisibility();
  }

  /** The detail card's Focus button: spotlight one memory and its neighbours. */
  async function syncFocusFromState() {
    const id = state.focusedNodeId || null;
    if (id === focusId) return;
    focusId = id;
    if (!id) { focusIds = null; refreshVisibility(); return; }
    focusIds = new Set([id]);
    refreshVisibility();
    const i = map?.indexOf.get(id);
    if (i !== undefined) flyToPoint(i);
    const list = await fetchNeighbors(id, NEIGHBOURS);
    if (focusId !== id) return;
    focusIds = new Set([id, ...list.map((n) => n.id)]);
    refreshVisibility();
  }

  // ── Clicks ──
  function clickPoint(i, { additive = false } = {}) {
    const id = map.ids[i];
    if (additive) { toggleMulti(id); return; }
    const node = nodeById.get(id);
    if (node) { emit('node-selected', node); return; }
    fetch(`/api/memory/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.payload) emit('node-selected', { id, payload: data.payload }); })
      .catch(() => {});
  }

  function clickLabel(item) {
    if (item.type === 'memory' && item.index >= 0) { clickPoint(item.index); return; }
    if (item.type === 'continent') flyToContinent(item.name);
    else flyToIsland(item.name);
  }

  // ── Server updates ──
  function updateStatus(status, progress) {
    if (!statusEl) return;
    if (status === 'computing') {
      const pct = progress?.total ? Math.round((100 * progress.done) / progress.total) : 0;
      statusEl.textContent = `Mapping memories… ${pct}%`;
      statusEl.classList.add('visible');
    } else {
      statusEl.classList.remove('visible');
    }
  }

  function onServerUpdate(msg) {
    updateStatus(msg?.status, msg?.progress);
    if (!map || msg?.rev === map.rev) return;
    scheduleRefetch();
  }

  function scheduleRefetch() {
    if (paused || document.hidden) { refetchPending = true; return; }
    if (refetchTimer) return;
    const wait = Math.max(0, lastRefetch + REFETCH_GAP_MS - Date.now());
    refetchTimer = setTimeout(async () => {
      refetchTimer = null;
      lastRefetch = Date.now();
      try {
        const json = await fetchMap(etag);
        if (json) applyMap(json, { morph: true });
      } catch (err) {
        console.warn('[map] refresh failed:', err?.message || err);
      }
    }, wait);
  }

  /** Memories on the map the page has no data for yet (MCP writes are never broadcast). */
  function checkMissing() {
    if (!map || !nodeById.size) return;
    const missing = [];
    for (const id of map.ids) {
      if (nodeById.has(id) || removedIds.has(id)) continue;
      missing.push(id);
      if (missing.length > MISSING_FETCH_MAX) break;
    }
    // A handful: fetch just those. More: null asks for one full reload.
    if (missing.length) onMissingNodes(missing.length > MISSING_FETCH_MAX ? null : missing);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && refetchPending && !paused) { refetchPending = false; scheduleRefetch(); }
  });

  // ── Options ──
  function setOption(key, value) {
    options = { ...options, [key]: !!value };
    try { storage.setItem(KEYS.MAP_VIEW, JSON.stringify(options)); } catch {}
    if (key === 'recency') renderer.setRecency(options.recency);
    if (key === 'grid' && map) renderer.setGrid(options.grid, map.bounds.radius);
    if (key === 'neighbors') {
      if (options.neighbors && selectedId) loadNeighbors(selectedId);
      refreshOverlay();
      refreshLines();
    }
  }

  // ── Workspaces ──
  function getScene() {
    const c = renderer.camera.position, t = renderer.controls.target;
    return { nodePositions: {}, camera: { kind: 'memory-map', position: [c.x, c.y, c.z], target: [t.x, t.y, t.z] } };
  }

  function restoreScene(scene) {
    const cam = scene?.camera;
    if (cam?.kind === 'memory-map' && Array.isArray(cam.position) && Array.isArray(cam.target)) {
      const dir = cam.position.map((v, k) => v - cam.target[k]);
      renderer.flyTo({ target: cam.target, distance: Math.hypot(...dir), direction: dir, ms: 700 });
    } else {
      frameAll();
    }
  }

  // ── Pause (focus mode / visualisation off) ──
  function pause() {
    paused = true;
    debug.paused = true;
    renderer.pause();
    labels.canvas.style.visibility = 'hidden';
  }
  function resume() {
    paused = false;
    debug.paused = false;
    labels.canvas.style.visibility = '';
    renderer.resume();
    if (refetchPending) { refetchPending = false; scheduleRefetch(); }
  }

  return {
    applyMap, hydrate, refreshVisibility, refreshColors, select, clearSelection, syncSelectionFromState,
    toggleMulti, setHover, describe, pickAt, onSettle, drawLabels, frameAll, flyToIsland, applySearch, clearSearch,
    syncFocusFromState, clickPoint, clickLabel, onServerUpdate, setOption, getScene, restoreScene, pause, resume,
    get options() { return { ...options }; },
    get map() { return map; },
    get selectedId() { return selectedId; },
    get searching() { return !!searchIds; },
    onMorphEnd() { debug.morphing = false; },
    refetch: scheduleRefetch,
  };
}

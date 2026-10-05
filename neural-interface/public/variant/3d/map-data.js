// ── Memory map data ──
//
// Everything the map needs that is neither DOM nor three.js: parsing
// `/api/map`, colours, recency, titles, visibility and the camera maths for
// framing. Kept pure so tests can run it in Node.

export const DIMMED = 0.1;             // aVis of a point outside the search / focus
export const RECENCY_HALF_LIFE = 30;   // days
export const DAY_MS = 86_400_000;

/**
 * `/api/map` JSON → typed arrays and lookups.
 * Points arrive grouped by island (`island.start … start + count`).
 */
export function parseMap(json) {
  const ids = Array.isArray(json?.ids) ? json.ids : [];
  const n = ids.length;
  const islands = Array.isArray(json?.islands) ? json.islands : [];
  const positions = new Float32Array(3 * n);
  for (let i = 0; i < 3 * n; i++) positions[i] = Number(json.pos?.[i]) || 0;
  const importance = new Uint8Array(n);
  const day = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    importance[i] = Math.max(1, Math.min(10, Number(json.imp?.[i]) || 5));
    day[i] = Number(json.day?.[i]) || 0;
  }
  const islandOf = new Uint16Array(n);
  islands.forEach((isl, k) => islandOf.fill(k, isl.start, Math.min(n, isl.start + isl.count)));
  const indexOf = new Map();
  ids.forEach((id, i) => indexOf.set(id, i));
  const islandIndex = new Map(islands.map((isl, k) => [isl.name, k]));
  return {
    rev: String(json?.rev ?? ''),
    status: json?.status === 'computing' ? 'computing' : 'ready',
    progress: json?.progress || null,
    bounds: { radius: Number(json?.bounds?.radius) || 0, height: Number(json?.bounds?.height) || 0 },
    continents: Array.isArray(json?.continents) ? json.continents : [],
    islands, islandIndex, ids, n, positions, importance, day, islandOf, indexOf,
  };
}

// ── Colour ──

/** '#RRGGBB' or '#RGB' → [r, g, b] in 0..1, sRGB as written (never linearised). */
export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(v) || h.length < 6) return [0.7, 0.7, 0.75];
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** A category colour calmed for the star chart: saturation ≤ 0.55, lightness 0.55–0.72. */
export function softColor(hex) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return hslToRgb([h, Math.min(s, 0.55), Math.min(0.72, Math.max(0.55, l))]);
}

export function rgbCss([r, g, b], alpha = 1) {
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}

// ── Per-point attributes ──

/** 1 for today, halving every RECENCY_HALF_LIFE days, never below 0.35. */
export function recencyOf(dayNumber, today = Math.floor(Date.now() / DAY_MS)) {
  const age = Math.max(0, today - dayNumber);
  return 0.35 + 0.65 * Math.pow(2, -age / RECENCY_HALF_LIFE);
}

export const sizeOf = (importance) => 0.75 + 0.075 * importance;

/** Build the colour / size / recency attribute arrays for a parsed map. */
export function pointAttributes(map, colorOfIsland, today) {
  const color = new Float32Array(3 * map.n);
  const size = new Float32Array(map.n);
  const recency = new Float32Array(map.n);
  const islandColors = map.islands.map((isl) => colorOfIsland(isl.name));
  for (let i = 0; i < map.n; i++) {
    const c = islandColors[map.islandOf[i]] || [0.7, 0.7, 0.75];
    color[3 * i] = c[0]; color[3 * i + 1] = c[1]; color[3 * i + 2] = c[2];
    size[i] = sizeOf(map.importance[i]);
    recency[i] = recencyOf(map.day[i], today);
  }
  return { color, size, recency, islandColors };
}

/**
 * 0 hidden (category off, or deleted here before the server map caught up),
 * DIMMED (outside the search or the card spotlight), 1 normal. Hidden wins.
 * @returns {{vis: Float32Array, hidden: number, dimmed: number, islandShown: boolean[]}}
 */
export function computeVisibility(map, { activeCategories = null, searchIds = null, focusIds = null, removedIds = null } = {}, out = null) {
  const vis = out && out.length === map.n ? out : new Float32Array(map.n);
  const shown = map.islands.map((isl) => !activeCategories || activeCategories.has(isl.name));
  let hidden = 0, dimmed = 0;
  for (let i = 0; i < map.n; i++) {
    const id = map.ids[i];
    if (!shown[map.islandOf[i]] || (removedIds && removedIds.has(id))) { vis[i] = 0; hidden++; continue; }
    if ((searchIds && !searchIds.has(id)) || (focusIds && !focusIds.has(id))) { vis[i] = DIMMED; dimmed++; continue; }
    vis[i] = 1;
  }
  return { vis, hidden, dimmed, islandShown: shown };
}

/**
 * Start positions for a morph from `oldMap` to `newMap`, in the new order.
 * Points that are new keep their own position (they fade in rather than fly).
 */
export function remapForMorph(oldMap, newMap) {
  const from = new Float32Array(3 * newMap.n);
  for (let i = 0; i < newMap.n; i++) {
    const j = oldMap ? oldMap.indexOf.get(newMap.ids[i]) : undefined;
    const src = j === undefined ? newMap.positions : oldMap.positions;
    const k = j === undefined ? i : j;
    from[3 * i] = src[3 * k]; from[3 * i + 1] = src[3 * k + 1]; from[3 * i + 2] = src[3 * k + 2];
  }
  return from;
}

/** Largest distance any point travels between two position arrays of the same order. */
export function maxDisplacement(from, to) {
  let max = 0;
  for (let i = 0; i + 2 < to.length; i += 3) {
    const d = Math.hypot(to[i] - from[i], to[i + 1] - from[i + 1], to[i + 2] - from[i + 2]);
    if (d > max) max = d;
  }
  return max;
}

/** Did anything actually move between two maps (same ids in the same order and same positions)? */
export function samePositions(a, b) {
  if (!a || !b || a.n !== b.n) return false;
  for (let i = 0; i < a.n; i++) if (a.ids[i] !== b.ids[i]) return false;
  for (let i = 0; i < 3 * a.n; i++) if (a.positions[i] !== b.positions[i]) return false;
  return true;
}

// ── Text ──

/** First meaningful line of a memory, without markdown noise. */
export function titleFromContent(content, max = 90) {
  const lines = String(content || '').split('\n');
  let line = '';
  for (const raw of lines) {
    const s = raw.replace(/^[\s#>*\-+`|]+/, '').replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim();
    if (s.length >= 3) { line = s; break; }
  }
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function relativeDay(dayNumber, today = Math.floor(Date.now() / DAY_MS)) {
  const d = today - dayNumber;
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  const date = new Date(dayNumber * DAY_MS);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Framing ──

/** Bounding sphere of a set of point indices (all points when omitted). */
export function boundsSphere(positions, indices = null) {
  const count = indices ? indices.length : positions.length / 3;
  if (!count) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let q = 0; q < count; q++) {
    const i = indices ? indices[q] : q;
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  let r = 0;
  for (let q = 0; q < count; q++) {
    const i = indices ? indices[q] : q;
    r = Math.max(r, Math.hypot(positions[3 * i] - cx, positions[3 * i + 1] - cy, positions[3 * i + 2] - cz));
  }
  return { x: cx, y: cy, z: cz, r };
}

/** Camera distance that fits a sphere of radius r (vertical fov in degrees, aspect w/h). */
export function fitDistance(r, fovDeg, aspect) {
  const vfov = (fovDeg * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const half = Math.min(vfov, hfov) / 2;
  return Math.max(r, 1) / Math.sin(half);
}

// ── Server calls ──

/** GET /api/map. Returns null on 304 (unchanged) and throws on errors. */
export async function fetchMap(etag = null) {
  const res = await fetch('/api/map', { headers: etag ? { 'If-None-Match': etag } : {} });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`map: HTTP ${res.status}`);
  const json = await res.json();
  json._etag = res.headers.get('ETag');
  return json;
}

const _neighborCache = new Map();
export async function fetchNeighbors(id, k = 8) {
  const key = `${id}|${k}`;
  if (_neighborCache.has(key)) return _neighborCache.get(key);
  const p = fetch(`/api/map/neighbors/${encodeURIComponent(id)}?k=${k}`)
    .then((r) => (r.ok ? r.json() : { id, neighbors: [] }))
    .then((j) => (Array.isArray(j?.neighbors) ? j.neighbors : []))
    .catch(() => []);
  _neighborCache.set(key, p);
  if (_neighborCache.size > 200) _neighborCache.delete(_neighborCache.keys().next().value);
  return p;
}
export function clearNeighborCache() { _neighborCache.clear(); }

export async function requestRebuild() {
  const res = await fetch('/api/map/rebuild', { method: 'POST' });
  if (!res.ok) throw new Error(`rebuild: HTTP ${res.status}`);
  return res.json();
}

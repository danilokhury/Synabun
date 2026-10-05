// ── Memory map layout math ──
//
// Pure functions behind the 3D memory map (`/api/map`): where every memory sits.
// No I/O, no three.js — the worker (memory-map-worker.js) and the service
// (memory-map-api.js) both call into this module, and the tests drive it with
// synthetic vectors.
//
// Geography: a continent is a root category, an island is a category. Inside an
// island a memory lives at (u, v) in the unit disk; world position is
// island centre + (u, v)·r, and height is its creation rank (newest on top).
// Islands under MAP.MIN_FIT memories sit on a sunflower spiral by creation
// time; bigger ones get a small UMAP of their embeddings, so similar memories
// end up next to each other.

export const MAP = Object.freeze({
  S: 7,              // world units per √memory: island radius = S·√max(n, 4)
  H: 0.35,           // island height as a fraction of its radius
  MIN_FIT: 16,       // below this an island is a sunflower spiral
  K: 15,             // neighbours in the UMAP graph
  NEG: 5,            // negative samples per positive sample
  A: 1.577,          // umap-learn curve parameters for min_dist 0.1, spread 1
  B: 0.895,
  P95: 0.92,         // 95th-percentile radius after normalising into the unit disk
  PLACE_K: 8,        // neighbours used to place a new memory
  TAU: 0.05,         // softmax temperature (cosine) for that placement
  REGION_MIN: 150,   // islands this big get named regions
  REFIT: 0.25,       // refit once this share of an island changed since its fit
});

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export const islandRadius = (n) => MAP.S * Math.sqrt(Math.max(n, 4));
export const islandHeight = (r) => MAP.H * r;
export const islandGap = (ra, rb) => 2 * MAP.S + 0.2 * Math.min(ra, rb);
export const continentGap = (ra, rb) => 6 * MAP.S + 0.2 * Math.min(ra, rb);

/** FNV-1a, 32-bit. */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG → floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sunflower (Vogel) spiral: the i-th oldest memory of an n-memory island.
 * World offset is S·√i whatever n is, so existing points never move as the
 * island grows; the oldest memory sits at the centre.
 */
export function sunflower(i, n, name = '') {
  const rho = Math.sqrt(i / Math.max(n, 4));
  const theta = i * GOLDEN_ANGLE + (hash32(name) % 6283) / 1000;
  return [rho * Math.cos(theta), rho * Math.sin(theta)];
}

// ── Nearest neighbours ──

/**
 * Exact k nearest neighbours by dot product (rows are unit vectors, so this is
 * cosine similarity). Every pair is computed once and offered to both rows;
 * four query rows share each pass over the data, which keeps the hot loop in
 * cache.
 * @param {Float32Array} X  n·dim row-major
 * @returns {{k:number, idx:Int32Array, sim:Float32Array}}  n·k, unsorted per row
 */
export function exactKnn(X, n, dim, k) {
  k = Math.max(0, Math.min(k, n - 1));
  const idx = new Int32Array(n * k).fill(-1);
  const sim = new Float32Array(n * k).fill(-Infinity);
  if (k === 0) return { k, idx, sim };
  const filled = new Int32Array(n);
  const worst = new Float32Array(n).fill(-Infinity);
  const worstAt = new Int32Array(n);

  const offer = (i, j, s) => {
    const base = i * k;
    if (filled[i] < k) {
      const p = filled[i]++;
      idx[base + p] = j;
      sim[base + p] = s;
      if (filled[i] < k) return;
    } else {
      if (s <= worst[i]) return;
      const p = worstAt[i];
      idx[base + p] = j;
      sim[base + p] = s;
    }
    let w = Infinity, wp = 0;
    for (let q = 0; q < k; q++) {
      const v = sim[base + q];
      if (v < w) { w = v; wp = q; }
    }
    worst[i] = w;
    worstAt[i] = wp;
  };

  const both = (i, j, s) => {
    if (filled[i] < k || s > worst[i]) offer(i, j, s);
    if (filled[j] < k || s > worst[j]) offer(j, i, s);
  };
  const dot = (i, j) => {
    let s = 0;
    const a = i * dim, b = j * dim;
    for (let d = 0; d < dim; d++) s += X[a + d] * X[b + d];
    return s;
  };

  for (let i0 = 0; i0 < n; i0 += 4) {
    const rows = Math.min(4, n - i0);
    for (let p = 0; p < rows; p++) for (let q = p + 1; q < rows; q++) both(i0 + p, i0 + q, dot(i0 + p, i0 + q));
    if (rows < 4) {
      for (let j = i0 + rows; j < n; j++) for (let p = 0; p < rows; p++) both(i0 + p, j, dot(i0 + p, j));
      continue;
    }
    const a0 = i0 * dim, a1 = a0 + dim, a2 = a1 + dim, a3 = a2 + dim;
    for (let j = i0 + 4; j < n; j++) {
      const b = j * dim;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let d = 0; d < dim; d++) {
        const x = X[b + d];
        s0 += X[a0 + d] * x;
        s1 += X[a1 + d] * x;
        s2 += X[a2 + d] * x;
        s3 += X[a3 + d] * x;
      }
      both(i0, j, s0);
      both(i0 + 1, j, s1);
      both(i0 + 2, j, s2);
      both(i0 + 3, j, s3);
    }
  }
  return { k, idx, sim };
}

// ── Linear projections ──

/**
 * Top-2 principal components of n rows (power iteration with deflation, a
 * fixed start vector and a sign convention, so it is deterministic).
 * @returns {Float64Array} 2n projections
 */
export function pca2(X, n, dim, iters = 30) {
  const out = new Float64Array(2 * n);
  if (n === 0) return out;
  const mean = new Float64Array(dim);
  for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) mean[d] += X[i * dim + d];
  for (let d = 0; d < dim; d++) mean[d] /= n;

  const comps = [];
  const proj = new Float64Array(n);
  for (let c = 0; c < 2; c++) {
    const rand = mulberry32(1234567 + c);
    let v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) v[d] = rand() - 0.5;
    for (let it = 0; it < iters; it++) {
      for (const u of comps) {
        let dot = 0;
        for (let d = 0; d < dim; d++) dot += v[d] * u[d];
        for (let d = 0; d < dim; d++) v[d] -= dot * u[d];
      }
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += v[d] * v[d];
      norm = Math.sqrt(norm);
      if (!(norm > 1e-12)) break;
      for (let d = 0; d < dim; d++) v[d] /= norm;
      // w = Xcᵀ (Xc v)
      for (let i = 0; i < n; i++) {
        let s = 0;
        const b = i * dim;
        for (let d = 0; d < dim; d++) s += (X[b + d] - mean[d]) * v[d];
        proj[i] = s;
      }
      const w = new Float64Array(dim);
      for (let i = 0; i < n; i++) {
        const p = proj[i];
        if (p === 0) continue;
        const b = i * dim;
        for (let d = 0; d < dim; d++) w[d] += (X[b + d] - mean[d]) * p;
      }
      v = w;
    }
    for (const u of comps) {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += v[d] * u[d];
      for (let d = 0; d < dim; d++) v[d] -= dot * u[d];
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) for (let d = 0; d < dim; d++) v[d] /= norm;
    else v.fill(0);
    let big = 0;
    for (let d = 1; d < dim; d++) if (Math.abs(v[d]) > Math.abs(v[big])) big = d;
    if (v[big] < 0) for (let d = 0; d < dim; d++) v[d] = -v[d];
    comps.push(v);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const b = i * dim;
      for (let d = 0; d < dim; d++) s += (X[b + d] - mean[d]) * v[d];
      out[2 * i + c] = s;
    }
  }
  return out;
}

/**
 * 2-D coordinates for a handful of category centroids: classical MDS on their
 * Euclidean distances (the same projection as their PCA), computed on the
 * small m×m centred Gram matrix instead of the 384-d data.
 * @returns {Float64Array} 2m coordinates
 */
export function mds2(vecs, m, dim, iters = 200) {
  const out = new Float64Array(2 * m);
  if (m < 2) return out;
  const mean = new Float64Array(dim);
  for (let i = 0; i < m; i++) for (let d = 0; d < dim; d++) mean[d] += vecs[i * dim + d] / m;
  const G = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let d = 0; d < dim; d++) s += (vecs[i * dim + d] - mean[d]) * (vecs[j * dim + d] - mean[d]);
      G[i * m + j] = s; G[j * m + i] = s;
    }
  }
  const comps = [];
  for (let c = 0; c < 2; c++) {
    const rand = mulberry32(7654321 + c);
    let v = new Float64Array(m);
    for (let i = 0; i < m; i++) v[i] = rand() - 0.5;
    let lambda = 0;
    for (let it = 0; it < iters; it++) {
      for (const u of comps) {
        let dot = 0;
        for (let i = 0; i < m; i++) dot += v[i] * u[i];
        for (let i = 0; i < m; i++) v[i] -= dot * u[i];
      }
      let norm = 0;
      for (let i = 0; i < m; i++) norm += v[i] * v[i];
      norm = Math.sqrt(norm);
      if (!(norm > 1e-15)) { v.fill(0); break; }
      for (let i = 0; i < m; i++) v[i] /= norm;
      const w = new Float64Array(m);
      for (let i = 0; i < m; i++) {
        let s = 0;
        for (let j = 0; j < m; j++) s += G[i * m + j] * v[j];
        w[i] = s;
      }
      lambda = 0;
      for (let i = 0; i < m; i++) lambda += w[i] * v[i];
      if (it === iters - 1) break;
      v = w;
    }
    let big = 0;
    for (let i = 1; i < m; i++) if (Math.abs(v[i]) > Math.abs(v[big])) big = i;
    const sign = v[big] < 0 ? -1 : 1;
    const scale = Math.sqrt(Math.max(lambda, 0));
    for (let i = 0; i < m; i++) out[2 * i + c] = sign * v[i] * scale;
    comps.push(v);
  }
  return out;
}

// ── UMAP ──

/**
 * A compact UMAP (McInnes et al.) over a precomputed kNN graph: fuzzy
 * simplicial set from cosine distances, then umap-learn's SGD with negative
 * sampling. Deterministic for a given seed.
 * @param {{k:number, idx:Int32Array, sim:Float32Array}} knn
 * @param {Float64Array|Float32Array} init  2n start positions
 * @returns {Float32Array} 2n embedding
 */
export function umapLite(knn, n, init, { epochs = n >= 2000 ? 200 : 400, seed = 1 } = {}) {
  const { k, idx, sim } = knn;
  const emb = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++) emb[i] = init[i];
  if (n < 3 || k === 0) return emb;

  // Membership strengths: exp(−max(0, d − ρ) / σ) with Σ = log2(k).
  const target = Math.log2(k);
  const weights = new Float32Array(n * k);
  let meanDist = 0;
  for (let q = 0; q < n * k; q++) meanDist += idx[q] >= 0 ? 1 - sim[q] : 0;
  meanDist /= n * k;
  for (let i = 0; i < n; i++) {
    const base = i * k;
    let rho = Infinity;
    for (let q = 0; q < k; q++) {
      if (idx[base + q] < 0) continue;
      const d = Math.max(0, 1 - sim[base + q]);
      if (d > 0 && d < rho) rho = d;
    }
    if (!Number.isFinite(rho)) rho = 0;
    let lo = 0, hi = Infinity, sigma = 1;
    for (let it = 0; it < 64; it++) {
      let sum = 0;
      for (let q = 0; q < k; q++) {
        if (idx[base + q] < 0) continue;
        const d = Math.max(0, 1 - sim[base + q]) - rho;
        sum += d > 0 ? Math.exp(-d / sigma) : 1;
      }
      if (Math.abs(sum - target) < 1e-5) break;
      if (sum > target) { hi = sigma; sigma = (lo + hi) / 2; }
      else { lo = sigma; sigma = hi === Infinity ? sigma * 2 : (lo + hi) / 2; }
    }
    sigma = Math.max(sigma, 1e-3 * meanDist);
    for (let q = 0; q < k; q++) {
      if (idx[base + q] < 0) continue;
      const d = Math.max(0, 1 - sim[base + q]) - rho;
      weights[base + q] = d > 0 ? Math.exp(-d / sigma) : 1;
    }
  }

  // Symmetrise: w = a + b − a·b over each unordered pair.
  const pairs = new Map();
  for (let i = 0; i < n; i++) {
    for (let q = 0; q < k; q++) {
      const j = idx[i * k + q];
      if (j < 0 || j === i) continue;
      const w = weights[i * k + q];
      const lo = i < j ? i : j, hiIdx = i < j ? j : i;
      const key = lo * n + hiIdx;
      const cur = pairs.get(key);
      if (cur === undefined) pairs.set(key, i < j ? [w, 0] : [0, w]);
      else if (i < j) cur[0] = w; else cur[1] = w;
    }
  }
  let wmax = 0;
  const heads = [], tails = [], ws = [];
  for (const [key, [a, b]] of pairs) {
    const w = a + b - a * b;
    if (w <= 0) continue;
    const i = Math.floor(key / n), j = key - i * n;
    heads.push(i, j); tails.push(j, i); ws.push(w, w);
    if (w > wmax) wmax = w;
  }
  const m = ws.length;
  const epochsPerSample = new Float64Array(m);
  const nextSample = new Float64Array(m);
  const epochsPerNeg = new Float64Array(m);
  const nextNeg = new Float64Array(m);
  let live = 0;
  for (let e = 0; e < m; e++) {
    if (ws[e] < wmax / epochs) { epochsPerSample[e] = -1; continue; }
    epochsPerSample[e] = wmax / ws[e];
    nextSample[e] = epochsPerSample[e];
    epochsPerNeg[e] = epochsPerSample[e] / MAP.NEG;
    nextNeg[e] = epochsPerNeg[e];
    live++;
  }
  if (!live) return emb;

  const a = MAP.A, b = MAP.B;
  const rand = mulberry32(seed);
  const clip = (g) => (g > 4 ? 4 : g < -4 ? -4 : g);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const alpha = 1 - epoch / epochs;
    for (let e = 0; e < m; e++) {
      const eps = epochsPerSample[e];
      if (eps < 0 || nextSample[e] > epoch) continue;
      const i = heads[e], j = tails[e];
      const ix = 2 * i, jx = 2 * j;
      let dx = emb[ix] - emb[jx], dy = emb[ix + 1] - emb[jx + 1];
      let d2 = dx * dx + dy * dy;
      if (d2 > 0) {
        const pw = Math.pow(d2, b);
        const coeff = (-2 * a * b * pw / d2) / (a * pw + 1);
        const gx = clip(coeff * dx) * alpha, gy = clip(coeff * dy) * alpha;
        emb[ix] += gx; emb[ix + 1] += gy;
        emb[jx] -= gx; emb[jx + 1] -= gy;
      }
      nextSample[e] += eps;
      const nNeg = Math.floor((epoch - nextNeg[e]) / epochsPerNeg[e]);
      for (let s = 0; s < nNeg; s++) {
        const kk = Math.floor(rand() * n);
        if (kk === i) continue;
        const kx = 2 * kk;
        dx = emb[ix] - emb[kx]; dy = emb[ix + 1] - emb[kx + 1];
        d2 = dx * dx + dy * dy;
        if (d2 <= 0) continue;
        const coeff = (2 * b) / ((0.001 + d2) * (a * Math.pow(d2, b) + 1));
        emb[ix] += clip(coeff * dx) * alpha;
        emb[ix + 1] += clip(coeff * dy) * alpha;
      }
      if (nNeg > 0) nextNeg[e] += nNeg * epochsPerNeg[e];
    }
  }
  return emb;
}

// ── Unit-disk shaping ──

function median(values) {
  const s = Float64Array.from(values).sort();
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/**
 * Centre on the median, scale so the 95th-percentile radius is MAP.P95, and
 * pull anything past 0.9 softly inward so every point stays inside the disk.
 * Mutates and returns `uv`.
 */
export function normalizeDisk(uv, n) {
  if (n === 0) return uv;
  if (n === 1) { uv[0] = 0; uv[1] = 0; return uv; }
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = uv[2 * i]; ys[i] = uv[2 * i + 1]; }
  const cx = median(xs), cy = median(ys);
  const radii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dx = uv[2 * i] - cx, dy = uv[2 * i + 1] - cy;
    radii[i] = Math.hypot(dx, dy);
  }
  const sorted = Float64Array.from(radii).sort();
  const p95 = sorted[Math.min(n - 1, Math.floor(0.95 * (n - 1)))];
  const scale = p95 > 1e-12 ? MAP.P95 / p95 : 0;
  for (let i = 0; i < n; i++) {
    let x = (uv[2 * i] - cx) * scale, y = (uv[2 * i + 1] - cy) * scale;
    const r = Math.hypot(x, y);
    if (r > 0.9) {
      const r2 = 0.9 + 0.1 * Math.tanh((r - 0.9) / 0.1);
      x *= r2 / r; y *= r2 / r;
    }
    uv[2 * i] = x; uv[2 * i + 1] = y;
  }
  return uv;
}

const clampToDisk = (uv, i, limit = 0.995) => {
  const x = uv[2 * i], y = uv[2 * i + 1];
  const r = Math.hypot(x, y);
  if (r > limit) { uv[2 * i] = (x * limit) / r; uv[2 * i + 1] = (y * limit) / r; }
};

/** Push points closer than `minUnit` apart (hash grid, a few passes). */
export function separate(uv, n, minUnit, passes = 3) {
  if (n < 2 || !(minUnit > 0)) return uv;
  const cell = minUnit;
  const cellsPerSide = Math.max(1, Math.ceil(2 / cell) + 2);
  for (let pass = 0; pass < passes; pass++) {
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const gx = Math.floor((uv[2 * i] + 1) / cell), gy = Math.floor((uv[2 * i + 1] + 1) / cell);
      const key = gx * cellsPerSide + gy;
      const list = grid.get(key);
      if (list) list.push(i); else grid.set(key, [i]);
    }
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor((uv[2 * i] + 1) / cell), gy = Math.floor((uv[2 * i + 1] + 1) / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const list = grid.get((gx + ox) * cellsPerSide + (gy + oy));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            let dx = uv[2 * j] - uv[2 * i], dy = uv[2 * j + 1] - uv[2 * i + 1];
            let d = Math.hypot(dx, dy);
            if (d >= minUnit) continue;
            if (d < 1e-9) {
              const ang = (hash32(`${i}:${j}`) % 6283) / 1000;
              dx = Math.cos(ang); dy = Math.sin(ang); d = 1e-9;
            } else { dx /= d; dy /= d; }
            const push = (minUnit - d) / 2;
            uv[2 * i] -= dx * push; uv[2 * i + 1] -= dy * push;
            uv[2 * j] += dx * push; uv[2 * j + 1] += dy * push;
            moved++;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) clampToDisk(uv, i);
    if (!moved) break;
  }
  return uv;
}

/**
 * The (u, v) layout of one island. Rows of X are the island's memories, oldest
 * first. Small islands get the sunflower spiral; the rest a seeded UMAP.
 * @returns {Float32Array} 2n unit-disk coordinates
 */
export function layoutIsland(X, n, dim, name, { epochs } = {}) {
  const uv = new Float32Array(2 * n);
  if (n < MAP.MIN_FIT) {
    for (let i = 0; i < n; i++) {
      const [u, v] = sunflower(i, n, name);
      uv[2 * i] = u; uv[2 * i + 1] = v;
    }
    return uv;
  }
  const knn = exactKnn(X, n, dim, MAP.K);
  const p = pca2(X, n, dim);
  let span = 0;
  for (let i = 0; i < 2 * n; i++) span = Math.max(span, Math.abs(p[i]));
  const seed = hash32(name) || 1;
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const init = new Float64Array(2 * n);
  for (let i = 0; i < 2 * n; i++) init[i] = (span > 1e-12 ? (p[i] / span) * 10 : 0) + (rand() - 0.5) * 1e-4 * 20;
  const emb = umapLite(knn, n, init, { seed, ...(epochs ? { epochs } : {}) });
  for (let i = 0; i < 2 * n; i++) uv[i] = emb[i];
  normalizeDisk(uv, n);
  return separate(uv, n, (0.35 * MAP.S) / islandRadius(n));
}

// ── Incremental placement ──

/**
 * Where a new memory goes in a fitted island: the softmax-weighted mean of its
 * nearest island members' positions, plus a small deterministic jitter.
 * @param {{score:number, u:number, v:number}[]} hits  neighbours with positions
 * @param {string} id  the memory's id (seeds the jitter)
 * @param {number} r   the island's world radius
 */
export function placeByNeighbors(hits, id, r) {
  const rand = mulberry32(hash32(id));
  const jitter = (0.5 * MAP.S) / Math.max(r, 1e-9);
  const ang = rand() * 2 * Math.PI, rad = Math.sqrt(rand()) * jitter;
  let u = 0, v = 0;
  if (hits.length) {
    const top = Math.max(...hits.map((h) => h.score));
    let wsum = 0;
    for (const h of hits) {
      const w = Math.exp((h.score - top) / MAP.TAU);
      u += w * h.u; v += w * h.v; wsum += w;
    }
    u /= wsum; v /= wsum;
  } else {
    const a2 = rand() * 2 * Math.PI, r2 = Math.sqrt(rand()) * 0.9;
    u = r2 * Math.cos(a2); v = r2 * Math.sin(a2);
  }
  const out = [u + rad * Math.cos(ang), v + rad * Math.sin(ang)];
  const rr = Math.hypot(out[0], out[1]);
  if (rr > 0.995) { out[0] *= 0.995 / rr; out[1] *= 0.995 / rr; }
  return out;
}

/**
 * Best rigid 2-D alignment (rotation or reflection, plus translation, no scale)
 * of `from` onto `to` — both flat [x0, y0, x1, y1, …] arrays of matched points.
 * @returns {(x:number, y:number) => [number, number]}
 */
export function procrustes2(from, to, weights = null) {
  const n = Math.min(from.length, to.length) >> 1;
  if (n === 0) return (x, y) => [x, y];
  let wsum = 0, fx = 0, fy = 0, tx = 0, ty = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    wsum += w; fx += w * from[2 * i]; fy += w * from[2 * i + 1]; tx += w * to[2 * i]; ty += w * to[2 * i + 1];
  }
  fx /= wsum; fy /= wsum; tx /= wsum; ty /= wsum;
  let sxx = 0, sxy = 0, syx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    const ax = from[2 * i] - fx, ay = from[2 * i + 1] - fy;
    const bx = to[2 * i] - tx, by = to[2 * i + 1] - ty;
    sxx += w * ax * bx; sxy += w * ax * by; syx += w * ay * bx; syy += w * ay * by;
  }
  // Rotation R(θ) maximises Σ b·R a at θ = atan2(Σ(ax·by − ay·bx), Σ(ax·bx + ay·by)).
  // Reflection first (y → −y) flips the sign of every ay term.
  const rot = Math.atan2(sxy - syx, sxx + syy);
  const ref = Math.atan2(sxy + syx, sxx - syy);
  const scoreRot = Math.hypot(sxy - syx, sxx + syy);
  const scoreRef = Math.hypot(sxy + syx, sxx - syy);
  const reflect = scoreRef > scoreRot + 1e-12;
  const th = reflect ? ref : rot;
  const c = Math.cos(th), s = Math.sin(th);
  return (x, y) => {
    const ax = x - fx, ay = reflect ? -(y - fy) : y - fy;
    return [c * ax - s * ay + tx, s * ax + c * ay + ty];
  };
}

// ── Packing ──

/**
 * Place circles without overlap.
 *  - fresh: items carry seeds (sx, sz) — MDS positions, any scale; they are
 *    rescaled, relaxed (overlap push, pull to anchor, weak pull to seed,
 *    gravity) and finally hard-separated.
 *  - incremental: items carry their previous (x, z); only real overlaps are
 *    pushed apart, each item is held near its old spot, no gravity.
 * Pushes are area-weighted, so small circles move and big ones stay.
 * @param {{r:number, x?:number, z?:number, sx?:number, sz?:number, anchor?:number}[]} items  mutated in place
 * @param {{mode?:'fresh'|'incremental', gap?:(ra:number, rb:number)=>number, iterations?:number}} opts
 */
export function pack(items, { mode = 'fresh', gap = islandGap, iterations = 600 } = {}) {
  const m = items.length;
  if (m === 0) return items;
  if (mode === 'fresh') {
    if (m === 1) { items[0].x = 0; items[0].z = 0; return items; }
    // Scale seeds so the median nearest-seed spacing matches the median wanted spacing.
    const near = [], want = [];
    for (let i = 0; i < m; i++) {
      let best = Infinity, bj = -1;
      for (let j = 0; j < m; j++) {
        if (j === i) continue;
        const d = Math.hypot((items[i].sx ?? 0) - (items[j].sx ?? 0), (items[i].sz ?? 0) - (items[j].sz ?? 0));
        if (d < best) { best = d; bj = j; }
      }
      near.push(best);
      want.push(items[i].r + items[bj].r + gap(items[i].r, items[bj].r));
    }
    const medNear = median(near), medWant = median(want);
    const scale = medNear > 1e-9 ? medWant / medNear : 0;
    for (let i = 0; i < m; i++) {
      const it = items[i];
      if (scale > 0) { it.sx = (it.sx ?? 0) * scale; it.sz = (it.sz ?? 0) * scale; }
      else {
        const ang = i * GOLDEN_ANGLE, rad = medWant * Math.sqrt(i);
        it.sx = rad * Math.cos(ang); it.sz = rad * Math.sin(ang);
      }
      it.x = it.sx; it.z = it.sz;
    }
    for (let iter = 0; iter < iterations; iter++) {
      pushOverlaps(items, gap, 1);
      for (const it of items) {
        if (it.anchor != null && it.anchor >= 0 && items[it.anchor] && items[it.anchor] !== it) {
          const an = items[it.anchor];
          const dx = an.x - it.x, dz = an.z - it.z;
          const d = Math.hypot(dx, dz);
          const desired = it.r + an.r + gap(it.r, an.r);
          if (d > desired) { it.x += (dx / d) * 0.1 * (d - desired); it.z += (dz / d) * 0.1 * (d - desired); }
        }
        it.x += 0.01 * (it.sx - it.x); it.z += 0.01 * (it.sz - it.z);
        it.x -= 0.005 * it.x; it.z -= 0.005 * it.z;
      }
    }
    for (let iter = 0; iter < 2000 && pushOverlaps(items, gap, 1); iter++);
    return items;
  }
  // incremental
  const home = items.map((it) => [it.x ?? 0, it.z ?? 0]);
  for (let iter = 0; iter < 400; iter++) {
    if (!pushOverlaps(items, gap, 0.5)) break;
    for (let i = 0; i < m; i++) {
      items[i].x += 0.2 * (home[i][0] - items[i].x);
      items[i].z += 0.2 * (home[i][1] - items[i].z);
    }
  }
  for (let iter = 0; iter < 2000 && pushOverlaps(items, gap, 0.5); iter++);
  return items;
}

/**
 * One pass of area-weighted overlap resolution. A pair is "overlapping" when it
 * is closer than r + r + gap·trigger; it is pushed out to the full gap.
 * @returns {boolean} whether anything moved
 */
function pushOverlaps(items, gap, trigger) {
  let moved = false;
  const m = items.length;
  for (let i = 0; i < m; i++) {
    const a = items[i];
    for (let j = i + 1; j < m; j++) {
      const b = items[j];
      const g = gap(a.r, b.r);
      let dx = b.x - a.x, dz = b.z - a.z;
      let d = Math.hypot(dx, dz);
      if (d >= a.r + b.r + g * trigger - 1e-6) continue;
      const full = a.r + b.r + g;
      if (d < 1e-9) {
        const ang = (hash32(`${i}|${j}`) % 6283) / 1000;
        dx = Math.cos(ang); dz = Math.sin(ang); d = 0;
      } else { dx /= d; dz /= d; }
      const over = full - d;
      const wa = a.fixed ? 0 : b.r * b.r, wb = b.fixed ? 0 : a.r * a.r;
      const tot = wa + wb;
      if (tot <= 0) continue;
      a.x -= dx * over * (wa / tot); a.z -= dz * over * (wa / tot);
      b.x += dx * over * (wb / tot); b.z += dz * over * (wb / tot);
      moved = true;
    }
  }
  return moved;
}

/**
 * A spot for a new circle of radius `r` next to `anchor` that overlaps none of
 * `placed`. Golden-angle rings, nearest ring first; nothing else moves.
 * @param {{x:number, z:number, r:number}[]} placed
 * @param {{x:number, z:number, r:number}|null} anchor
 */
export function findFreeSpot(placed, anchor, r, gap = islandGap, startAngle = 0) {
  const ax = anchor?.x ?? 0, az = anchor?.z ?? 0, ar = anchor?.r ?? 0;
  const free = (x, z) => placed.every((p) => Math.hypot(p.x - x, p.z - z) >= p.r + r + gap(p.r, r) - 1e-6);
  if (!anchor && free(ax, az)) return { x: ax, z: az };
  const base = ar + r + (anchor ? gap(ar, r) : 0);
  const step = Math.max(r * 0.5, MAP.S);
  for (let ring = 0; ring < 400; ring++) {
    const dist = base + ring * step;
    const tries = Math.max(8, Math.ceil((2 * Math.PI * dist) / Math.max(r, MAP.S)));
    for (let t = 0; t < tries; t++) {
      const ang = startAngle + t * GOLDEN_ANGLE + ring * 0.7;
      const x = ax + dist * Math.cos(ang), z = az + dist * Math.sin(ang);
      if (free(x, z)) return { x, z };
    }
  }
  return { x: ax + base + 400 * step, z: az };
}

/** Smallest radius around (0, 0) that holds every circle, plus padding. */
export function enclosingRadius(items, pad = 2 * MAP.S) {
  let r = 0;
  for (const it of items) r = Math.max(r, Math.hypot(it.x, it.z) + it.r);
  return r + pad;
}

// ── Regions ──

/**
 * Density peaks of an island's (u, v) layout: counts on a grid over the unit
 * square, Gaussian blur, local maxima with enough mass, spaced apart. Each
 * memory joins the nearest peak within `joinRadius`.
 * @returns {{peaks:{u:number, v:number, count:number}[], assign:Int16Array}}
 */
export function densityRegions(uv, n, { grid = 64, blurCells = 2, maxK, minSep = 0.25, joinRadius = 0.3 } = {}) {
  const assign = new Int16Array(n).fill(-1);
  const kMax = maxK ?? Math.max(2, Math.min(10, Math.round(Math.sqrt(n / 40))));
  const cellOf = (x) => Math.min(grid - 1, Math.max(0, Math.floor(((x + 1) / 2) * grid)));
  const counts = new Float64Array(grid * grid);
  for (let i = 0; i < n; i++) counts[cellOf(uv[2 * i]) * grid + cellOf(uv[2 * i + 1])] += 1;
  const rad = Math.ceil(blurCells * 3);
  const kernel = [];
  for (let o = -rad; o <= rad; o++) kernel.push(Math.exp(-(o * o) / (2 * blurCells * blurCells)));
  const tmp = new Float64Array(grid * grid), dens = new Float64Array(grid * grid);
  for (let x = 0; x < grid; x++) for (let y = 0; y < grid; y++) {
    let s = 0;
    for (let o = -rad; o <= rad; o++) { const yy = y + o; if (yy >= 0 && yy < grid) s += counts[x * grid + yy] * kernel[o + rad]; }
    tmp[x * grid + y] = s;
  }
  for (let x = 0; x < grid; x++) for (let y = 0; y < grid; y++) {
    let s = 0;
    for (let o = -rad; o <= rad; o++) { const xx = x + o; if (xx >= 0 && xx < grid) s += tmp[xx * grid + y] * kernel[o + rad]; }
    dens[x * grid + y] = s;
  }
  const cand = [];
  for (let x = 0; x < grid; x++) for (let y = 0; y < grid; y++) {
    const v = dens[x * grid + y];
    if (v <= 0) continue;
    let isMax = true;
    for (let ox = -1; ox <= 1 && isMax; ox++) for (let oy = -1; oy <= 1; oy++) {
      if (!ox && !oy) continue;
      const xx = x + ox, yy = y + oy;
      if (xx < 0 || yy < 0 || xx >= grid || yy >= grid) continue;
      const w = dens[xx * grid + yy];
      if (w > v || (w === v && xx * grid + yy < x * grid + y)) { isMax = false; break; }
    }
    if (isMax) cand.push({ u: ((x + 0.5) / grid) * 2 - 1, v: ((y + 0.5) / grid) * 2 - 1, d: v });
  }
  cand.sort((a, b) => b.d - a.d);
  const minMass = Math.max(8, 0.02 * n);
  const peaks = [];
  for (const c of cand) {
    if (peaks.length >= kMax) break;
    if (peaks.some((p) => Math.hypot(p.u - c.u, p.v - c.v) < minSep)) continue;
    let mass = 0;
    for (let i = 0; i < n; i++) if (Math.hypot(uv[2 * i] - c.u, uv[2 * i + 1] - c.v) <= joinRadius) mass++;
    if (mass < minMass) continue;
    peaks.push({ u: c.u, v: c.v, count: 0 });
  }
  for (let i = 0; i < n; i++) {
    let best = -1, bd = joinRadius;
    for (let p = 0; p < peaks.length; p++) {
      const d = Math.hypot(uv[2 * i] - peaks[p].u, uv[2 * i + 1] - peaks[p].v);
      if (d <= bd) { bd = d; best = p; }
    }
    if (best >= 0) { assign[i] = best; peaks[best].count++; }
  }
  return { peaks, assign };
}

const STOPWORDS = new Set((
  'about above after again against all also although always among another any anything are around because been before being below '
  + 'between both but can cannot could did does doing done down during each either else even ever every few first for from further '
  + 'get gets getting got had has have having here hers herself him himself his how however into its itself just last least less '
  + 'like made make makes many may might more most much must near need needs never next none nor not now off often once only onto '
  + 'other others our ours out over own per rather really same see seem seems several shall she should since some something still '
  + 'such than that the their theirs them themselves then there these they this those though through thus till too under until upon '
  + 'use used uses using very was way ways well were what when where whether which while who whom whose why will with within without '
  + 'would yet you your yours yourself also added adds new now today yesterday tomorrow memory memories file files http https www '
  + 'com org html json true false null undefined para como mais esta este isso isto pelo pela pelos pelas uma umas uns sobre quando '
  + 'onde porque entre depois antes ainda muito muita tambem também mesmo mesma essa esse aqui agora sempre nunca cada todo toda '
  + 'todos todas outro outra outros outras será sera está estao estão foram tinha temos fazer feito'
).split(/\s+/));

/** Tag → a label term, or null when it's noise (namespaced, numeric, too short or long, the island's own name). */
export function cleanTag(tag, banned = new Set()) {
  if (typeof tag !== 'string') return null;
  let t = tag.trim().toLowerCase().replace(/^[#@]+/, '');
  if (!t || t.includes(':') || t.includes('/')) return null;
  if (t.length < 3 || t.length > 32) return null;
  if (/^[\d.\-_ ]+$/.test(t)) return null;
  t = t.replace(/\s+/g, '-');
  if (banned.has(t)) return null;
  return t;
}

/** Content → candidate words (first 600 characters, 4–20 letters, no stopwords). */
export function contentTerms(text, banned = new Set()) {
  if (typeof text !== 'string' || !text) return [];
  const out = new Set();
  for (const w of text.slice(0, 600).toLowerCase().split(/[^\p{L}]+/u)) {
    if (w.length < 4 || w.length > 20 || STOPWORDS.has(w) || banned.has(w)) continue;
    out.add(w);
  }
  return [...out];
}

/**
 * Name each region by the terms that set it apart from the rest of its island
 * (lift-weighted), tags first, content words as a fallback. Labels never
 * repeat inside one island; a region with nothing distinctive stays unnamed.
 * @param {{peaks:{count:number}[], assign:Int16Array}} regions
 * @param {(i:number) => string[]} tagTerms      cleaned tag terms of memory i
 * @param {(i:number) => string[]} contentTermsOf content words of memory i
 * @returns {string[]} one label per peak ('' = unnamed)
 */
export function labelRegions(regions, tagTerms, contentTermsOf, n) {
  const { peaks, assign } = regions;
  const labels = peaks.map(() => '');
  const used = new Set();
  const order = peaks.map((p, i) => i).sort((a, b) => peaks[b].count - peaks[a].count);
  const tryTerms = (termsOf) => {
    const islandCount = new Map();
    const regionCount = peaks.map(() => new Map());
    for (let i = 0; i < n; i++) {
      const terms = termsOf(i);
      for (const t of terms) islandCount.set(t, (islandCount.get(t) || 0) + 1);
      if (assign[i] >= 0) for (const t of terms) regionCount[assign[i]].set(t, (regionCount[assign[i]].get(t) || 0) + 1);
    }
    for (const p of order) {
      if (labels[p]) continue;
      const size = peaks[p].count;
      if (!size) continue;
      const scored = [];
      for (const [t, c] of regionCount[p]) {
        const inIsland = islandCount.get(t) || 0;
        if (inIsland > n / 2) continue;
        if (c < Math.max(3, 0.05 * size)) continue;
        const pR = c / size, pI = inIsland / n;
        if (pR < 1.5 * pI) continue;
        scored.push({ t, s: pR * Math.log(pR / pI) });
      }
      scored.sort((a, b) => b.s - a.s || (a.t < b.t ? -1 : 1));
      const first = scored.find((x) => !used.has(x.t));
      if (!first) continue;
      used.add(first.t);
      const second = scored.find((x) => x.t !== first.t && !used.has(x.t) && x.s >= 0.6 * first.s);
      labels[p] = second ? `${first.t} · ${second.t}` : first.t;
    }
  };
  tryTerms(tagTerms);
  if (labels.some((l, p) => !l && peaks[p].count)) tryTerms(contentTermsOf);
  return labels;
}

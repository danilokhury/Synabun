// ── Memory map service + routes ──
//
// Serves `/api/map`: a position for every live memory, arranged as continents
// (root categories) of islands (categories). Layout work runs in
// memory-map-worker.js; this module owns the state, keeps it current and
// builds the payload.
//
//  - First request with no cache: a full job starts; the request waits for the
//    worker's `meta` (~1 s) so the geography is final from the start. Islands
//    begin as sunflower spirals and fill in as their layouts land.
//  - Staying current: a 1 s poll of the `memory_changes` feed (filled by
//    triggers, so every writer is seen). New or re-categorised memories are
//    placed next to their nearest island neighbours; an island that changed a
//    lot is refit in the worker and aligned onto the current picture.
//  - Rebuild: the old map keeps being served until the new one is complete,
//    then the new one is aligned onto it and swapped in.
// The poll stops after 10 minutes without a map request; the next one catches up.

import { Router } from 'express';
import { Worker } from 'node:worker_threads';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  MAP, GOLDEN_ANGLE, continentGap, enclosingRadius, findFreeSpot, hash32, islandGap, islandHeight,
  islandRadius, mds2, pack, placeByNeighbors, procrustes2, sunflower,
} from './memory-map-layout.js';
import { MEMORY_MAP_WORKER_URL } from './memory-map-worker.js';

const SCHEMA = 1;
export const MAP_PARAMS = `S${MAP.S}|H${MAP.H}|K${MAP.K}|F${MAP.MIN_FIT}|E200/400|MD0.1|R${MAP.REGION_MIN}`;
const SLICE_MS = 20;
const FEED_PAGE = 2000;
const PERSIST_MS = 10_000;
const BROADCAST_MS = 1000;
const META_WAIT_MS = 30_000;
const CATCH_UP_WAIT_MS = 1500;

const gzipAsync = promisify(gzip);
const r1 = (x) => Math.round(x * 10) / 10;
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const angleOf = (name) => (hash32(name) % 6283) / 1000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byCreated = (members) => (a, b) => (members.get(a).c - members.get(b).c) || (a < b ? -1 : a > b ? 1 : 0);
const parseMs = (s) => { const ms = Date.parse(s); return Number.isFinite(ms) ? ms : 0; };
const clampImp = (x) => Math.max(1, Math.min(10, Math.round(Number(x) || 5)));
const islandName = (category) => category || 'uncategorized';
/** A laid-out island keeps the radius it had at layout time until its next refit, so inserts move nothing else. */
const radiusOf = (isl) => islandRadius(isl.fitted && isl.fitCount ? isl.fitCount : isl.members.size);

/**
 * Category tree → root, parent and ancestors of any category. A parent that is
 * named but missing becomes a virtual root; in a parent cycle the
 * alphabetically smallest name is the root.
 */
export function buildTaxonomy(categories = []) {
  const parentOf = new Map();
  for (const c of categories) {
    if (!c || typeof c.name !== 'string' || !c.name) continue;
    const p = typeof c.parent === 'string' && c.parent && c.parent !== c.name ? c.parent : null;
    parentOf.set(c.name, p);
  }
  const cache = new Map();
  return {
    info(name) {
      let out = cache.get(name);
      if (out) return out;
      const chain = [name];
      let root = name;
      let cur = name;
      for (;;) {
        const p = parentOf.get(cur);
        if (!p) { root = cur; break; }
        const loopAt = chain.indexOf(p);
        if (loopAt >= 0) { root = chain.slice(loopAt).sort()[0]; break; }
        chain.push(p);
        if (!parentOf.has(p)) { root = p; break; }
        cur = p;
      }
      out = { root, parent: parentOf.get(name) || null, ancestors: chain.slice(1) };
      cache.set(name, out);
      return out;
    },
  };
}

/** Shift circles so their bounding box is centred on the origin. */
function recenter(items) {
  if (!items.length) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x - it.r); maxX = Math.max(maxX, it.x + it.r);
    minZ = Math.min(minZ, it.z - it.r); maxZ = Math.max(maxZ, it.z + it.r);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  for (const it of items) { it.x -= cx; it.z -= cz; }
}

function hasOverlap(items, gap, trigger = 0.5) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r + gap(a.r, b.r) * trigger - 1e-6) return true;
    }
  }
  return false;
}

/**
 * @param {object} deps
 * @param {() => import('node:sqlite').DatabaseSync} deps.getDb  the shared connection
 * @param {{topK: Function}} deps.memoryVectors  in-memory vector matrix (kept fresh from the change feed)
 * @param {string} deps.cachePath  where the map is persisted
 * @param {() => object[]} deps.loadCategories
 * @param {() => string} deps.categoriesPath
 * @param {() => object[]} [deps.getBridgeNodes]  OpenClaw nodes when that bridge is on
 * @param {() => object[]} [deps.getBridgeCategories]
 * @param {(msg: object) => void} [deps.broadcast]
 */
export function createMemoryMapService({
  getDb,
  memoryVectors,
  cachePath,
  loadCategories = () => [],
  categoriesPath = null,
  getBridgeNodes = () => [],
  getBridgeCategories = () => [],
  broadcast = () => {},
  pollMs = 1000,
  idleStopMs = 10 * 60_000,
  workerUrl = MEMORY_MAP_WORKER_URL,
  log = console,
} = {}) {
  let state = null;
  let taxonomy = null;
  let job = null;
  let jobSeq = 0;
  let loading = null;
  let ticking = null;
  let pollTimer = null;
  let lastRequest = 0;
  let persistTimer = null;
  let broadcastTimer = null;
  let lastBroadcast = 0;
  let payloadCache = null;
  let jobsStarted = 0;
  let pending = { added: 0, removed: 0 };
  const timings = { metaMs: 0, payloadMs: 0, persistMs: 0 }; // last main-thread cost of each step
  const refitQueue = new Set();
  const refitRetryAt = new Map(); // island → earliest retry after a failed refit
  let stopped = false;

  // ── DB helpers ──
  const dbPath = () => {
    try {
      const rows = getDb().prepare('PRAGMA database_list').all();
      return rows.find((r) => r.name === 'main')?.file || '';
    } catch { return ''; }
  };
  const maxSeq = (entity) => {
    try {
      return Number(getDb().prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM memory_changes WHERE entity = ?').get(entity).s) || 0;
    } catch { return 0; }
  };
  const getVector = (id) => {
    const row = getDb().prepare('SELECT vector FROM memories WHERE id = ? AND trashed_at IS NULL').get(id);
    const b = row?.vector;
    if (!b || b.byteLength < 4) return null;
    return b.byteOffset % 4 === 0
      ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
      : new Float32Array(Uint8Array.from(b).buffer);
  };
  const allCategories = () => {
    let base = [];
    try { base = loadCategories() || []; } catch {}
    let bridge = [];
    try { bridge = getBridgeCategories() || []; } catch {}
    return [...base, ...bridge];
  };
  const categoriesKey = () => {
    try { return categoriesPath ? String(statSync(categoriesPath()).mtimeMs) : ''; } catch { return ''; }
  };
  const refreshTaxonomy = () => { taxonomy = buildTaxonomy(allCategories()); return taxonomy; };
  const bannedTerms = () => {
    const tax = taxonomy || refreshTaxonomy();
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '-');
    const out = {};
    for (const c of allCategories()) {
      if (!c?.name) continue;
      const info = tax.info(c.name);
      out[c.name] = [c.name, ...info.ancestors].map(norm);
    }
    out.uncategorized = ['uncategorized'];
    return out;
  };

  // ── State shape ──
  // island: { name, root, parent, dx, dz, fitted, fitCount, changed, regions,
  //           members: Map<id, {c, i, u?, v?}>, idSet: Set<id>, order: id[], orderDirty }
  const newIsland = (name, info, seed = name) => ({
    name, seed, root: info.root, parent: info.parent, dx: 0, dz: 0,
    fitted: false, fitCount: 0, changed: 0, regions: [],
    members: new Map(), idSet: new Set(), order: [], orderDirty: false,
  });
  const newRevBase = () => Date.now().toString(36);
  const islandsOf = (st, root) => [...st.islands.values()].filter((isl) => isl.root === root);
  const sortOrder = (isl) => {
    if (!isl.orderDirty) return;
    isl.order = [...isl.members.keys()].sort(byCreated(isl.members));
    isl.orderDirty = false;
  };

  function serialize(st) {
    for (const isl of st.islands.values()) sortOrder(isl);
    return {
      schema: SCHEMA, params: MAP_PARAMS, dbPath: st.dbPath, watermark: st.watermark, catsKey: st.catsKey,
      rev: { base: st.revBase, n: st.revN },
      continents: [...st.continents.values()].map((c) => ({ name: c.name, x: c.x, z: c.z, r: c.r })),
      islands: [...st.islands.values()].map((isl) => ({
        name: isl.name, seed: isl.seed, root: isl.root, parent: isl.parent, dx: isl.dx, dz: isl.dz,
        fitted: isl.fitted, fitCount: isl.fitCount, changed: isl.changed, regions: isl.regions,
        ids: isl.order,
        created: isl.order.map((id) => isl.members.get(id).c),
        imp: isl.order.map((id) => isl.members.get(id).i),
        ...(isl.fitted ? {
          u: isl.order.map((id) => r5(isl.members.get(id).u ?? 0)),
          v: isl.order.map((id) => r5(isl.members.get(id).v ?? 0)),
        } : {}),
      })),
    };
  }

  function deserialize(raw) {
    const st = {
      dbPath: raw.dbPath, watermark: raw.watermark || { mem: 0, filt: 0 }, catsKey: raw.catsKey || '',
      revBase: raw.rev?.base || newRevBase(), revN: Number(raw.rev?.n) || 0,
      continents: new Map(), islands: new Map(), where: new Map(), touched: new Set(),
    };
    for (const c of raw.continents || []) st.continents.set(c.name, { name: c.name, x: c.x, z: c.z, r: c.r });
    for (const s of raw.islands || []) {
      const isl = newIsland(s.name, { root: s.root, parent: s.parent }, s.seed || s.name);
      Object.assign(isl, {
        dx: s.dx, dz: s.dz, fitted: !!s.fitted, fitCount: s.fitCount || 0, changed: s.changed || 0,
        regions: Array.isArray(s.regions) ? s.regions : [],
      });
      (s.ids || []).forEach((id, i) => {
        const rec = { c: s.created?.[i] ?? 0, i: s.imp?.[i] ?? 5 };
        if (isl.fitted) { rec.u = s.u?.[i] ?? 0; rec.v = s.v?.[i] ?? 0; }
        isl.members.set(id, rec);
        isl.idSet.add(id);
        st.where.set(id, s.name);
      });
      isl.order = (s.ids || []).slice();
      st.islands.set(s.name, isl);
    }
    return st;
  }

  function loadCache() {
    let raw;
    try { raw = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { return null; }
    if (!raw || raw.schema !== SCHEMA || raw.dbPath !== dbPath()) return null;
    const st = deserialize(raw);
    st.stale = raw.params !== MAP_PARAMS;
    return st;
  }

  function persistNow() {
    if (!state || !cachePath) return;
    const t0 = performance.now();
    try {
      const json = JSON.stringify(serialize(state));
      mkdirSync(dirname(cachePath), { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(tmp, json);
      renameSync(tmp, cachePath);
      timings.persistMs = Math.round(performance.now() - t0);
    } catch (error) {
      log.warn?.(`[memory-map] persist failed: ${error?.message || error}`);
    }
  }
  function schedulePersist() {
    if (persistTimer || stopped) return;
    persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, PERSIST_MS);
    persistTimer.unref?.();
  }
  function flushSync() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; persistNow(); }
  }

  // ── Revision + broadcast ──
  const rev = () => (state ? `${state.revBase}.${state.revN}` : '0');
  const fullJob = () => (job && (job.kind === 'first' || job.kind === 'rebuild') ? job : null);
  const status = () => (fullJob() ? 'computing' : 'ready');
  const progress = () => {
    const j = fullJob();
    return j ? { done: j.fitsDone, total: j.fitsTotal } : undefined;
  };
  function sendBroadcast() {
    lastBroadcast = Date.now();
    const msg = { type: 'map:updated', rev: rev(), status: status(), added: pending.added, removed: pending.removed };
    const p = progress();
    if (p) msg.progress = p;
    pending = { added: 0, removed: 0 };
    try { broadcast(msg); } catch {}
  }
  function scheduleBroadcast(immediate = false) {
    if (stopped) return;
    if (immediate) {
      if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
      sendBroadcast();
      return;
    }
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => { broadcastTimer = null; sendBroadcast(); },
      Math.max(0, lastBroadcast + BROADCAST_MS - Date.now()));
    broadcastTimer.unref?.();
  }
  function bump({ immediate = false } = {}) {
    if (!state) return;
    state.revN++;
    payloadCache = null;
    scheduleBroadcast(immediate);
    schedulePersist();
  }

  // ── Building a state from a worker snapshot ──
  function stateFromMeta(meta, prev) {
    const tax = refreshTaxonomy();
    const st = {
      dbPath: dbPath(), watermark: meta.watermark, catsKey: categoriesKey(),
      revBase: newRevBase(), revN: 0,
      continents: new Map(), islands: new Map(), where: new Map(), touched: new Set(),
    };
    const dim = meta.dim;
    const centroids = new Map();
    for (const m of meta.islands) {
      const isl = newIsland(m.name, tax.info(m.name));
      m.ids.forEach((id, i) => {
        isl.members.set(id, { c: m.created[i], i: m.imp[i] });
        isl.idSet.add(id);
        st.where.set(id, m.name);
      });
      // The worker reads in (created_at, id) order already; only sort when that doesn't hold.
      let sorted = true;
      for (let i = 1; i < m.ids.length && sorted; i++) {
        const a = m.created[i - 1], b = m.created[i];
        sorted = a < b || (a === b && m.ids[i - 1] < m.ids[i]);
      }
      isl.order = sorted ? m.ids.slice() : m.ids.slice().sort(byCreated(isl.members));
      st.islands.set(m.name, isl);
      centroids.set(m.name, m.centroid);
    }
    const groups = new Map();
    for (const isl of st.islands.values()) {
      if (!groups.has(isl.root)) groups.set(isl.root, []);
      groups.get(isl.root).push(isl);
    }
    const contItems = [];
    for (const [root, list] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      list.sort((a, b) => (a.name < b.name ? -1 : 1));
      const m = list.length;
      const V = new Float32Array(m * Math.max(dim, 1));
      list.forEach((isl, i) => { if (dim) V.set(centroids.get(isl.name), i * dim); });
      const seeds = m > 1 && dim ? mds2(V, m, dim) : new Float64Array(2 * m);
      const index = new Map(list.map((isl, i) => [isl.name, i]));
      const items = list.map((isl, i) => {
        const anc = tax.info(isl.name).ancestors.find((a) => index.has(a));
        return { r: islandRadius(isl.members.size), sx: seeds[2 * i], sz: seeds[2 * i + 1], anchor: anc ? index.get(anc) : -1, isl };
      });
      pack(items, { mode: 'fresh', gap: islandGap });
      recenter(items);
      for (const it of items) { it.isl.dx = it.x; it.isl.dz = it.z; }
      const cc = new Float32Array(Math.max(dim, 1));
      if (dim) {
        for (const isl of list) {
          const c = centroids.get(isl.name);
          for (let d = 0; d < dim; d++) cc[d] += c[d] * isl.members.size;
        }
        let norm = 0;
        for (let d = 0; d < dim; d++) norm += cc[d] * cc[d];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let d = 0; d < dim; d++) cc[d] /= norm;
      }
      contItems.push({ name: root, r: enclosingRadius(items), cc });
    }
    const M = contItems.length;
    const CV = new Float32Array(M * Math.max(dim, 1));
    contItems.forEach((c, i) => { if (dim) CV.set(c.cc, i * dim); });
    const cseeds = M > 1 && dim ? mds2(CV, M, dim) : new Float64Array(2 * M);
    const citems = contItems.map((c, i) => ({ r: c.r, sx: cseeds[2 * i], sz: cseeds[2 * i + 1], name: c.name }));
    pack(citems, { mode: 'fresh', gap: continentGap, iterations: 800 });
    recenter(citems);
    for (const it of citems) st.continents.set(it.name, { name: it.name, x: it.x, z: it.z, r: it.r });
    if (prev) alignGeography(st, prev);
    return st;
  }

  /** Rotate/reflect a rebuilt geography onto the previous one so nothing jumps. */
  function alignGeography(st, prev) {
    const from = [], to = [];
    for (const c of st.continents.values()) {
      const old = prev.continents.get(c.name);
      if (old) { from.push(c.x, c.z); to.push(old.x, old.z); }
    }
    if (from.length >= 4) {
      const T = procrustes2(from, to);
      for (const c of st.continents.values()) [c.x, c.z] = T(c.x, c.z);
    }
    for (const root of st.continents.keys()) {
      const f = [], t = [];
      const list = islandsOf(st, root);
      for (const isl of list) {
        const old = prev.islands.get(isl.name);
        if (old && old.root === root) { f.push(isl.dx, isl.dz); t.push(old.dx, old.dz); }
      }
      if (f.length >= 4) {
        const T = procrustes2(f, t);
        for (const isl of list) [isl.dx, isl.dz] = T(isl.dx, isl.dz);
      }
    }
  }

  // ── Worker jobs ──
  function startJob(kind, names = null) {
    const id = ++jobSeq;
    jobsStarted++;
    const j = { id, kind, names, fitsDone: 0, fitsTotal: 0, finished: false, newState: null, prev: kind === 'rebuild' ? state : null };
    j.metaPromise = new Promise((resolve, reject) => { j.resolveMeta = resolve; j.rejectMeta = reject; });
    j.metaPromise.catch(() => {});
    let worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: { memoryMapJob: { jobId: id, dbPath: dbPath(), categories: names, banned: bannedTerms() } },
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
    } catch (error) {
      j.finished = true;
      j.rejectMeta(error);
      return j;
    }
    j.worker = worker;
    worker.unref();
    worker.on('message', (msg) => {
      try { onWorkerMessage(j, msg); } catch (error) { failJob(j, error); }
    });
    worker.on('error', (error) => failJob(j, error));
    worker.on('exit', (code) => { if (!j.finished) failJob(j, new Error(`memory-map worker exited (${code})`)); });
    job = j;
    return j;
  }

  function cancelJob() {
    const j = job;
    if (!j) return;
    j.finished = true;
    job = null;
    j.rejectMeta(new Error('memory-map job cancelled'));
    j.worker?.terminate().catch(() => {});
  }

  function failJob(j, error) {
    if (j.finished) return;
    j.finished = true;
    if (job === j) job = null;
    j.rejectMeta(error);
    j.worker?.terminate().catch(() => {});
    log.warn?.(`[memory-map] ${j.kind} job failed: ${error?.message || error}`);
    if (state) bump({ immediate: true });
    if (j.kind === 'refit') for (const name of j.names || []) refitRetryAt.set(name, Date.now() + 60_000);
    startQueuedRefit();
  }

  function onWorkerMessage(j, msg) {
    if (j.finished || job !== j || msg?.jobId !== j.id) return;
    if (msg.type === 'error') { failJob(j, new Error(msg.message)); return; }
    if (msg.type === 'meta') {
      j.meta = msg;
      j.fitsTotal = msg.islands.filter((m) => m.ids.length >= MAP.MIN_FIT).length;
      const t0 = performance.now();
      if (j.kind === 'first') {
        state = stateFromMeta(msg, null);
        bump({ immediate: true });
      } else if (j.kind === 'rebuild') {
        j.newState = stateFromMeta(msg, j.prev);
      }
      timings.metaMs = Math.round(performance.now() - t0);
      j.resolveMeta();
      return;
    }
    if (msg.type === 'island') {
      const target = j.kind === 'rebuild' ? j.newState : state;
      const isl = target?.islands.get(msg.name);
      if (isl) {
        let alignTo = null;
        if (j.kind === 'rebuild') {
          const old = j.prev?.islands.get(msg.name);
          if (old?.fitted) alignTo = (id) => { const m = old.members.get(id); return m && m.u !== undefined ? [m.u, m.v] : null; };
        } else if (j.kind === 'refit') {
          alignTo = currentPositionOf(isl);
        }
        applyFit(isl, msg.ids, msg.uv, msg.regions, alignTo);
        if (j.kind !== 'rebuild') target.touched.add(isl.root);
      }
      j.fitsDone++;
      if (j.kind !== 'rebuild') bump();
      else scheduleBroadcast();
      return;
    }
    if (msg.type === 'done') {
      j.finished = true;
      job = null;
      if (j.kind === 'rebuild' && j.newState) {
        state = j.newState;
        state.revN = (j.prev?.revN || 0) + 1;
      }
      scheduleRefits();
      bump({ immediate: true });
      startQueuedRefit();
    }
  }

  function currentPositionOf(isl) {
    sortOrder(isl);
    const rank = new Map(isl.order.map((id, i) => [id, i]));
    const n = isl.members.size;
    return (id) => {
      const m = isl.members.get(id);
      if (!m) return null;
      if (isl.fitted && m.u !== undefined) return [m.u, m.v];
      const i = rank.get(id);
      return i === undefined ? null : sunflower(i, n, isl.seed);
    };
  }

  /** Install a worker layout on an island, aligned onto `alignTo` positions when given. */
  function applyFit(isl, ids, uv, regions, alignTo) {
    if (isl.members.size < MAP.MIN_FIT) return; // shrank while the worker ran: stays a sunflower
    refitRetryAt.delete(isl.name);
    const fit = new Map();
    for (let i = 0; i < ids.length; i++) fit.set(ids[i], [uv[2 * i], uv[2 * i + 1]]);
    let T = null;
    if (alignTo) {
      const from = [], to = [];
      for (const id of isl.members.keys()) {
        const p = fit.get(id), q = alignTo(id);
        if (p && q) { from.push(p[0], p[1]); to.push(q[0], q[1]); }
      }
      if (from.length >= 6) T = procrustes2(from, to);
    }
    const clamp = ([u, v]) => {
      const r = Math.hypot(u, v);
      return r > 0.995 ? [(u * 0.995) / r, (v * 0.995) / r] : [u, v];
    };
    const missing = [];
    for (const [id, rec] of isl.members) {
      const p = fit.get(id);
      if (!p) { missing.push(id); delete rec.u; delete rec.v; continue; }
      const [u, v] = clamp(T ? T(p[0], p[1]) : p);
      rec.u = u; rec.v = v;
    }
    isl.fitted = true;
    isl.regions = (regions || []).map((g) => {
      const [u, v] = T ? T(g.u, g.v) : [g.u, g.v];
      return { label: g.label, u, v, count: g.count };
    });
    for (const id of missing) placeMember(isl, id);
    isl.fitCount = isl.members.size;
    isl.changed = 0;
  }

  function placeMember(isl, id) {
    const rec = isl.members.get(id);
    if (!rec) return;
    let hits = [];
    const vec = getVector(id);
    if (vec) {
      try {
        hits = memoryVectors.topK(vec, MAP.PLACE_K + 1, -1, isl.idSet)
          .filter((h) => h.id !== id)
          .map((h) => { const m = isl.members.get(h.id); return m && m.u !== undefined ? { score: h.score, u: m.u, v: m.v } : null; })
          .filter(Boolean)
          .slice(0, MAP.PLACE_K);
      } catch { hits = []; }
    }
    const [u, v] = placeByNeighbors(hits, id, radiusOf(isl));
    rec.u = u; rec.v = v;
  }

  function scheduleRefits() {
    if (!state || fullJob()) return;
    const now = Date.now();
    for (const isl of state.islands.values()) {
      const n = isl.members.size;
      if (n < MAP.MIN_FIT || (refitRetryAt.get(isl.name) || 0) > now) continue;
      if (!isl.fitted || isl.changed > MAP.REFIT * n) refitQueue.add(isl.name);
    }
    startQueuedRefit();
  }

  function startQueuedRefit() {
    if (job || stopped || !state || !refitQueue.size) return;
    const names = [...refitQueue].filter((name) => state.islands.has(name));
    refitQueue.clear();
    if (names.length) startJob('refit', names);
  }

  function startFull(kind) {
    cancelJob();
    refitQueue.clear();
    return startJob(kind);
  }

  // ── Loading ──
  async function ensureLoaded() {
    if (state) return;
    if (!loading) {
      loading = (async () => {
        refreshTaxonomy();
        const cached = loadCache();
        if (cached) {
          state = cached;
          payloadCache = null;
          if (cached.stale) startFull('rebuild');
          return;
        }
        const j = fullJob() || startFull('first');
        let timer;
        try {
          await Promise.race([
            j.metaPromise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('memory map timed out')), META_WAIT_MS); }),
          ]);
        } finally { clearTimeout(timer); }
      })().finally(() => { loading = null; });
    }
    await loading;
  }

  // ── Staying current ──
  function createIsland(st, name, firstId) {
    const tax = taxonomy || refreshTaxonomy();
    const info = tax.info(name);
    const isl = newIsland(name, info);
    const r = islandRadius(1);
    let cont = st.continents.get(info.root);
    if (!cont) {
      const conts = [...st.continents.values()];
      const anchor = neighbourContinent(st, firstId) || conts.slice().sort((a, b) => b.r - a.r)[0] || null;
      const cr = r + 2 * MAP.S;
      const spot = conts.length ? findFreeSpot(conts, anchor, cr, continentGap, angleOf(info.root)) : { x: 0, z: 0 };
      cont = { name: info.root, x: spot.x, z: spot.z, r: cr };
      st.continents.set(info.root, cont);
    } else {
      const siblings = islandsOf(st, info.root).map((s) => ({ x: s.dx, z: s.dz, r: radiusOf(s), s }));
      const ancestor = info.ancestors.find((a) => st.islands.get(a)?.root === info.root);
      let anchor = ancestor ? siblings.find((x) => x.s.name === ancestor) : null;
      if (!anchor) anchor = neighbourIsland(st, firstId, siblings) || siblings.slice().sort((a, b) => b.r - a.r)[0] || null;
      const spot = siblings.length ? findFreeSpot(siblings, anchor, r, islandGap, angleOf(name)) : { x: 0, z: 0 };
      isl.dx = spot.x; isl.dz = spot.z;
    }
    st.islands.set(name, isl);
    st.touched.add(info.root);
    return isl;
  }

  function neighbourHits(id) {
    const vec = id ? getVector(id) : null;
    if (!vec) return [];
    try { return memoryVectors.topK(vec, MAP.PLACE_K + 1, -1).filter((h) => h.id !== id); } catch { return []; }
  }
  function neighbourIsland(st, id, siblings) {
    const names = new Set(siblings.map((x) => x.s.name));
    const votes = new Map();
    for (const h of neighbourHits(id)) {
      const name = st.where.get(h.id);
      if (names.has(name)) votes.set(name, (votes.get(name) || 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    return best ? siblings.find((x) => x.s.name === best[0]) : null;
  }
  function neighbourContinent(st, id) {
    const votes = new Map();
    for (const h of neighbourHits(id)) {
      const root = st.islands.get(st.where.get(h.id))?.root;
      if (root) votes.set(root, (votes.get(root) || 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    return best ? st.continents.get(best[0]) : null;
  }

  function addMember(st, name, id, rec) {
    const isl = st.islands.get(name) || createIsland(st, name, id);
    isl.members.set(id, rec);
    isl.idSet.add(id);
    isl.orderDirty = true;
    isl.changed++;
    st.where.set(id, name);
    st.touched.add(isl.root);
    if (isl.fitted) placeMember(isl, id);
    pending.added++;
  }

  function removeMember(st, id) {
    const name = st.where.get(id);
    const isl = st.islands.get(name);
    st.where.delete(id);
    if (!isl) return;
    isl.members.delete(id);
    isl.idSet.delete(id);
    isl.orderDirty = true;
    isl.changed++;
    st.touched.add(isl.root);
    pending.removed++;
    if (!isl.members.size) {
      st.islands.delete(name);
      return;
    }
    if (isl.fitted && isl.members.size < MAP.MIN_FIT) {
      isl.fitted = false;
      isl.regions = [];
      for (const m of isl.members.values()) { delete m.u; delete m.v; }
    }
  }

  function renameIsland(st, from, to) {
    const isl = st.islands.get(from);
    st.islands.delete(from);
    isl.name = to;
    st.islands.set(to, isl);
    for (const id of isl.members.keys()) st.where.set(id, to);
    const info = (taxonomy || refreshTaxonomy()).info(to);
    isl.parent = info.parent;
    if (info.root !== isl.root) rehome(st, isl, info.root);
  }

  /** Move an island to another continent, keeping its interior. */
  function rehome(st, isl, root) {
    const old = st.continents.get(isl.root);
    const wx = (old?.x ?? 0) + isl.dx, wz = (old?.z ?? 0) + isl.dz;
    st.touched.add(isl.root);
    isl.root = root;
    const r = radiusOf(isl);
    const cont = st.continents.get(root);
    if (!cont) {
      st.continents.set(root, { name: root, x: wx, z: wz, r: r + 2 * MAP.S });
      isl.dx = 0; isl.dz = 0;
    } else {
      const siblings = islandsOf(st, root).filter((s) => s !== isl).map((s) => ({ x: s.dx, z: s.dz, r: radiusOf(s), s }));
      const ancestor = (taxonomy || refreshTaxonomy()).info(isl.name).ancestors.find((a) => st.islands.get(a)?.root === root);
      const anchor = ancestor ? siblings.find((x) => x.s.name === ancestor) : null;
      const spot = siblings.length ? findFreeSpot(siblings, anchor, r, islandGap, angleOf(isl.name)) : { x: 0, z: 0 };
      isl.dx = spot.x; isl.dz = spot.z;
    }
    st.touched.add(root);
  }

  /** The categories file changed: re-derive roots and parents; move what moved. */
  function applyTaxonomy(st) {
    const tax = refreshTaxonomy();
    const targets = new Map();
    for (const isl of st.islands.values()) {
      const root = tax.info(isl.name).root;
      if (!targets.has(isl.root)) targets.set(isl.root, new Set());
      targets.get(isl.root).add(root);
    }
    // A renamed root renames its continent when all of its islands went the same way.
    for (const [from, roots] of targets) {
      if (roots.size !== 1) continue;
      const to = [...roots][0];
      if (to === from || st.continents.has(to) || !st.continents.has(from)) continue;
      const c = st.continents.get(from);
      st.continents.delete(from);
      c.name = to;
      st.continents.set(to, c);
      for (const isl of st.islands.values()) if (isl.root === from) isl.root = to;
    }
    for (const isl of st.islands.values()) {
      const info = tax.info(isl.name);
      isl.parent = info.parent;
      if (info.root !== isl.root) rehome(st, isl, info.root);
    }
  }

  /** Grow/shrink islands and continents after a batch; push apart only real overlaps. */
  function settleGeography(st) {
    for (const root of st.touched) {
      const cont = st.continents.get(root);
      if (!cont) continue;
      const list = islandsOf(st, root);
      if (!list.length) { st.continents.delete(root); continue; }
      const items = list.map((isl) => ({ x: isl.dx, z: isl.dz, r: radiusOf(isl), isl }));
      if (hasOverlap(items, islandGap)) {
        pack(items, { mode: 'incremental', gap: islandGap });
        for (const it of items) { it.isl.dx = it.x; it.isl.dz = it.z; }
      }
      cont.r = enclosingRadius(items);
    }
    st.touched.clear();
    for (const c of [...st.continents.values()]) if (!islandsOf(st, c.name).length) st.continents.delete(c.name);
    const conts = [...st.continents.values()].map((c) => ({ x: c.x, z: c.z, r: c.r, c }));
    if (hasOverlap(conts, continentGap)) {
      pack(conts, { mode: 'incremental', gap: continentGap });
      for (const it of conts) { it.c.x = it.x; it.c.z = it.z; }
    }
  }

  function detectRenames(st, chunk, rows) {
    const moves = new Map();
    for (const id of chunk) {
      const row = rows.get(id);
      const from = st.where.get(id);
      if (!row || row.trashed_at || !from) continue;
      const to = islandName(row.category);
      if (to === from) continue;
      if (!moves.has(from)) moves.set(from, new Map());
      const m = moves.get(from);
      m.set(to, (m.get(to) || 0) + 1);
    }
    for (const [from, targets] of moves) {
      if (targets.size !== 1) continue;
      const [to, count] = [...targets.entries()][0];
      const isl = st.islands.get(from);
      if (isl && count === isl.members.size && !st.islands.has(to)) renameIsland(st, from, to);
    }
  }

  function applyOne(st, id, row, vectorChanged) {
    const cur = st.where.get(id);
    if (!row || row.trashed_at) { if (cur) removeMember(st, id); return; }
    const name = islandName(row.category);
    const rec = { c: parseMs(row.created_at), i: clampImp(row.importance) };
    if (!cur) { addMember(st, name, id, rec); return; }
    if (cur !== name) { removeMember(st, id); addMember(st, name, id, rec); return; }
    const isl = st.islands.get(name);
    const old = isl.members.get(id);
    if (old.c !== rec.c) isl.orderDirty = true;
    old.c = rec.c;
    old.i = rec.i;
    if (vectorChanged && isl.fitted) {
      placeMember(isl, id);
      isl.changed++;
    }
  }

  async function applyFeed(st, memTo, filtTo) {
    const db = getDb();
    const page = db.prepare('SELECT seq, id FROM memory_changes WHERE entity = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?');
    const ids = new Set();
    const vectorIds = new Set();
    for (const [entity, from, to] of [['memories', st.watermark.mem, memTo], ['memory_filters', st.watermark.filt, filtTo]]) {
      let cursor = from;
      for (;;) {
        const rows = page.all(entity, cursor, to, FEED_PAGE);
        for (const r of rows) {
          ids.add(r.id);
          if (entity === 'memories') vectorIds.add(r.id);
        }
        if (rows.length < FEED_PAGE) break;
        cursor = rows[rows.length - 1].seq;
      }
    }
    const lookup = db.prepare(
      'SELECT m.id, m.category, m.importance, m.created_at, m.trashed_at FROM json_each(?) j JOIN memories m ON m.id = j.value',
    );
    const list = [...ids];
    let t0 = performance.now();
    for (let off = 0; off < list.length; off += 500) {
      const chunk = list.slice(off, off + 500);
      const rows = new Map(lookup.all(JSON.stringify(chunk)).map((r) => [r.id, r]));
      detectRenames(st, chunk, rows);
      for (const id of chunk) {
        applyOne(st, id, rows.get(id), vectorIds.has(id));
        if (performance.now() - t0 > SLICE_MS) {
          await yieldToLoop();
          if (st !== state || stopped) return false;
          t0 = performance.now();
        }
      }
    }
    st.watermark = { mem: memTo, filt: filtTo };
    return true;
  }

  async function runTick() {
    const st = state;
    if (!st || stopped) return;
    let changed = false;
    const ck = categoriesKey();
    if (ck !== st.catsKey) {
      st.catsKey = ck;
      applyTaxonomy(st);
      changed = true;
    }
    const mem = maxSeq('memories'), filt = maxSeq('memory_filters');
    if (mem < st.watermark.mem || filt < st.watermark.filt) {
      // The database was replaced (restore): start over, aligned to what's on screen.
      if (!fullJob()) startFull('rebuild');
      return;
    }
    if (mem !== st.watermark.mem || filt !== st.watermark.filt) {
      if (!(await applyFeed(st, mem, filt))) return;
      changed = true;
    }
    if (!changed) return;
    for (const isl of st.islands.values()) sortOrder(isl);
    settleGeography(st);
    if (st !== state) return;
    bump();
    scheduleRefits();
  }

  function tick() {
    if (!ticking) {
      ticking = runTick()
        .catch((error) => log.warn?.(`[memory-map] update failed: ${error?.message || error}`))
        .finally(() => { ticking = null; });
    }
    return ticking;
  }

  function ensurePolling() {
    if (pollTimer || stopped) return;
    pollTimer = setInterval(() => {
      if (Date.now() - lastRequest > idleStopMs) { clearInterval(pollTimer); pollTimer = null; return; }
      tick();
    }, pollMs);
    pollTimer.unref?.();
  }

  // ── Payload ──
  function buildPayload(st) {
    for (const isl of st.islands.values()) sortOrder(isl);
    const byRoot = new Map();
    for (const isl of st.islands.values()) {
      if (!byRoot.has(isl.root)) byRoot.set(isl.root, []);
      byRoot.get(isl.root).push(isl);
    }
    const conts = [...st.continents.values()]
      .map((c) => ({ c, list: byRoot.get(c.name) || [] }))
      .filter((e) => e.list.length)
      .map((e) => ({ ...e, total: e.list.reduce((s, isl) => s + isl.members.size, 0) }))
      .sort((a, b) => b.total - a.total || (a.c.name < b.c.name ? -1 : 1));
    const out = { continents: [], islands: [], ids: [], pos: [], imp: [], day: [] };
    let maxR = 0, maxH = 0;
    const emit = (cx, cz, isl, list, r = islandRadius(list.length)) => {
      const n = list.length;
      const h = islandHeight(r);
      const start = out.ids.length;
      list.forEach(([id, m], i) => {
        const [u, v] = isl.fitted && m.u !== undefined ? [m.u, m.v] : sunflower(i, n, isl.seed);
        out.ids.push(id);
        out.pos.push(r1(cx + u * r), r1(n === 1 ? h : (i / (n - 1)) * h), r1(cz + v * r));
        out.imp.push(m.i);
        out.day.push(Math.floor(m.c / 86_400_000));
      });
      maxH = Math.max(maxH, h);
      return { r, h, start, n };
    };
    conts.forEach(({ c, list }, ci) => {
      out.continents.push({ name: c.name, x: r1(c.x), z: r1(c.z), r: r1(c.r) });
      maxR = Math.max(maxR, Math.hypot(c.x, c.z) + c.r);
      list.sort((a, b) => b.members.size - a.members.size || (a.name < b.name ? -1 : 1));
      for (const isl of list) {
        const cx = c.x + isl.dx, cz = c.z + isl.dz;
        const { r, h, start, n } = emit(cx, cz, isl, isl.order.map((id) => [id, isl.members.get(id)]), radiusOf(isl));
        out.islands.push({
          name: isl.name, parent: isl.parent, continent: ci, x: r1(cx), z: r1(cz), r: r1(r), h: r1(h),
          count: n, start, fitted: isl.fitted || n < MAP.MIN_FIT,
          regions: isl.fitted && n >= MAP.REGION_MIN
            ? isl.regions.filter((g) => g.label).map((g) => ({ label: g.label, x: r1(cx + g.u * r), z: r1(cz + g.v * r), count: g.count }))
            : [],
        });
      }
    });
    maxR = appendBridge(out, maxR, emit);
    return JSON.stringify({
      version: 1, rev: rev(), status: status(), ...(progress() ? { progress: progress() } : {}),
      bounds: { radius: r1(maxR), height: r1(maxH) },
      ...out,
    });
  }

  /** OpenClaw bridge nodes: not in the database, so sunflower islands of their own, placed fresh each time. */
  function appendBridge(out, maxR, emit) {
    let nodes = [];
    try { nodes = getBridgeNodes() || []; } catch { nodes = []; }
    if (!nodes.length) return maxR;
    const tax = buildTaxonomy(allCategories());
    const groups = new Map();
    for (const node of nodes) {
      if (!node?.id) continue;
      const name = islandName(node.payload?.category);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push([node.id, { c: parseMs(node.payload?.created_at), i: clampImp(node.payload?.importance) }]);
    }
    const byRoot = new Map();
    for (const [name, list] of groups) {
      list.sort((a, b) => a[1].c - b[1].c || (a[0] < b[0] ? -1 : 1));
      const root = tax.info(name).root;
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push({ name, list });
    }
    const placed = out.continents.map((c) => ({ x: c.x, z: c.z, r: c.r }));
    for (const [root, isls] of [...byRoot.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      isls.sort((a, b) => b.list.length - a.list.length || (a.name < b.name ? -1 : 1));
      const items = isls.map((g, i) => ({ r: islandRadius(g.list.length), sx: Math.cos(i * GOLDEN_ANGLE) * i, sz: Math.sin(i * GOLDEN_ANGLE) * i, g }));
      pack(items, { mode: 'fresh', gap: islandGap, iterations: 200 });
      recenter(items);
      const cr = enclosingRadius(items);
      const big = placed.slice().sort((a, b) => b.r - a.r)[0] || null;
      const spot = placed.length ? findFreeSpot(placed, big, cr, continentGap, angleOf(root)) : { x: 0, z: 0 };
      const ci = out.continents.length;
      out.continents.push({ name: root, x: r1(spot.x), z: r1(spot.z), r: r1(cr) });
      placed.push({ x: spot.x, z: spot.z, r: cr });
      maxR = Math.max(maxR, Math.hypot(spot.x, spot.z) + cr);
      for (const it of items) {
        const cx = spot.x + it.x, cz = spot.z + it.z;
        const isl = { name: it.g.name, seed: it.g.name, fitted: false };
        const { r, h, start, n } = emit(cx, cz, isl, it.g.list);
        out.islands.push({
          name: it.g.name, parent: tax.info(it.g.name).parent, continent: ci, x: r1(cx), z: r1(cz), r: r1(r), h: r1(h),
          count: n, start, fitted: true, regions: [],
        });
      }
    }
    return maxR;
  }

  // ── Public API ──
  async function payload() {
    lastRequest = Date.now();
    ensurePolling();
    await ensureLoaded();
    if (!fullJob() || job?.kind !== 'first') {
      const t = tick();
      await Promise.race([t, sleep(CATCH_UP_WAIT_MS)]);
    }
    let bridgeCount = 0;
    try { bridgeCount = (getBridgeNodes() || []).length; } catch {}
    const keyNow = () => `${rev()}|${bridgeCount}`;
    if (payloadCache?.key === keyNow()) return payloadCache;
    await yieldToLoop(); // keep the build apart from whatever just changed the state
    if (payloadCache?.key !== keyNow()) {
      const t0 = performance.now();
      payloadCache = { key: keyNow(), rev: rev(), etag: `"${rev()}${bridgeCount ? `-b${bridgeCount}` : ''}"`, json: buildPayload(state), gz: null };
      timings.payloadMs = Math.round(performance.now() - t0);
    }
    return payloadCache;
  }

  async function gzipped(p) {
    if (!p.gz) p.gz = await gzipAsync(p.json, { level: 6 });
    return p.gz;
  }

  function neighbors(id, k = 8) {
    const vec = getVector(id);
    if (!vec) return null;
    const kk = Math.max(1, Math.min(50, Math.floor(Number(k) || 8)));
    let hits = [];
    try { hits = memoryVectors.topK(vec, kk + 1, -1); } catch { hits = []; }
    return {
      id,
      neighbors: hits.filter((h) => h.id !== id).slice(0, kk).map((h) => ({ id: h.id, score: Math.round(h.score * 1000) / 1000 })),
    };
  }

  async function rebuild() {
    lastRequest = Date.now();
    ensurePolling();
    if (!state) { await ensureLoaded(); return { rev: rev(), status: status() }; }
    startFull('rebuild');
    bump({ immediate: true });
    return { rev: rev(), status: 'computing' };
  }

  async function whenIdle(timeoutMs = 120_000) {
    const t0 = Date.now();
    for (;;) {
      if (!job && !refitQueue.size && !ticking && !loading) return;
      if (Date.now() - t0 > timeoutMs) throw new Error('memory map did not settle');
      await sleep(15);
    }
  }

  function stop() {
    stopped = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
    cancelJob();
    refitQueue.clear();
    flushSync();
  }

  return {
    payload,
    gzipped,
    neighbors,
    rebuild,
    tick,
    whenIdle,
    stop,
    flushSync,
    status: () => ({ rev: rev(), status: status(), progress: progress(), jobsStarted, islands: state?.islands.size || 0, timings: { ...timings } }),
  };
}

/** Routes: GET /api/map, GET /api/map/neighbors/:id, POST /api/map/rebuild (admin-only via server.js). */
export function createMemoryMapApi(service) {
  const router = Router();
  router.get('/map', async (req, res) => {
    try {
      const p = await service.payload();
      res.set('ETag', p.etag);
      res.set('Cache-Control', 'no-cache');
      res.set('Vary', 'Accept-Encoding');
      if (req.headers['if-none-match'] === p.etag) return res.status(304).end();
      res.type('application/json');
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
        const gz = await service.gzipped(p);
        res.set('Content-Encoding', 'gzip');
        return res.end(gz);
      }
      return res.end(p.json);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });
  router.get('/map/neighbors/:id', (req, res) => {
    try {
      const out = service.neighbors(String(req.params.id || ''), req.query.k);
      if (!out) return res.status(404).json({ ok: false, error: 'Unknown memory' });
      return res.json(out);
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });
  router.post('/map/rebuild', async (_req, res) => {
    try {
      res.status(202).json(await service.rebuild());
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });
  return router;
}

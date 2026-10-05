import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SYNABUN_TYPESAFE = 'off';

// Never the live store: point every memory path at a temp dir BEFORE any
// mcp-server module is imported.
const dir = mkdtempSync(join(tmpdir(), 'synabun-map-'));
process.env.SQLITE_DB_PATH = join(dir, 'memory.db');
process.env.MEMORY_DATA_DIR = dir;
process.env.SYNABUN_DATA_HOME = dir;

const L = await import('../lib/memory-map-layout.js');
const storage = await import('../../mcp-server/dist/services/sqlite.js');
const { createMemoryMapService, createMemoryMapApi, buildTaxonomy } = await import('../lib/memory-map-api.js');

const services = [];
test.after(async () => {
  for (const s of services) { try { s.stop(); } catch {} }
  try { storage.closeDatabase(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const DIM = 384;
const rand = L.mulberry32(20260925);
const gauss = () => {
  let u = 0;
  while (!u) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const center = () => Array.from({ length: DIM }, gauss);
const around = (c, spread) => unit(c.map((x) => x + gauss() * spread));
const within = (dx, dz, r, slack = 0.15) => Math.hypot(dx, dz) <= r + slack;

function clusteredVectors(nClusters, nSub, per) {
  const X = new Float32Array(nClusters * nSub * per * DIM);
  const cluster = [], sub = [];
  let row = 0;
  for (let c = 0; c < nClusters; c++) {
    const C = center();
    for (let s = 0; s < nSub; s++) {
      const S = C.map((x) => x + gauss() * 0.6);
      for (let p = 0; p < per; p++) {
        X.set(around(S, 0.5), row * DIM);
        cluster.push(c); sub.push(c * nSub + s);
        row++;
      }
    }
  }
  return { X, n: row, cluster, sub };
}

function knnPurity(uv, n, labels, k = 10) {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const d = [];
    for (let j = 0; j < n; j++) if (j !== i) d.push([Math.hypot(uv[2 * i] - uv[2 * j], uv[2 * i + 1] - uv[2 * j + 1]), j]);
    d.sort((a, b) => a[0] - b[0]);
    for (let q = 0; q < k; q++) if (labels[d[q][1]] === labels[i]) ok++;
  }
  return ok / (n * k);
}

// ── Layout math ──

test('the test database lives in the temp dir', () => {
  const file = storage.getDb().prepare('PRAGMA database_list').all().find((r) => r.name === 'main').file;
  assert.ok(realpathSync(file).startsWith(realpathSync(dir)), `unexpected database ${file}`);
});

test('fresh packing: no overlaps, deterministic, children next to their anchor', () => {
  const make = () => {
    const r2 = L.mulberry32(7);
    return Array.from({ length: 40 }, (_, i) => ({
      r: 8 + r2() * 60, sx: r2() * 10 - 5, sz: r2() * 10 - 5, anchor: i >= 30 ? i - 30 : -1,
    }));
  };
  const a = L.pack(make(), { mode: 'fresh' });
  const b = L.pack(make(), { mode: 'fresh' });
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].x, b[i].x);
    assert.equal(a[i].z, b[i].z);
    for (let j = i + 1; j < a.length; j++) {
      const d = Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z);
      assert.ok(d >= a[i].r + a[j].r + L.islandGap(a[i].r, a[j].r) - 1e-5, `pair ${i},${j} overlaps`);
    }
  }
  const edge = (i, j) => Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z) - a[i].r - a[j].r;
  const all = [];
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) all.push(edge(i, j));
  all.sort((x, y) => x - y);
  const med = all[all.length >> 1];
  for (let i = 30; i < 40; i++) assert.ok(edge(i, i - 30) < med, `child ${i} is far from its anchor`);
});

test('incremental packing keeps the slack rule and moves little', () => {
  const r2 = L.mulberry32(9);
  const items = L.pack(Array.from({ length: 30 }, () => ({ r: 10 + r2() * 40, sx: r2(), sz: r2() })), { mode: 'fresh' });
  const before = items.map((it) => [it.x, it.z]);
  const dr = items[5].r * 0.1;
  items[5].r += dr;
  L.pack(items, { mode: 'incremental' });
  let same = 0, maxMove = 0;
  for (let i = 0; i < items.length; i++) {
    const move = Math.hypot(items[i].x - before[i][0], items[i].z - before[i][1]);
    if (move === 0) same++;
    maxMove = Math.max(maxMove, move);
    for (let j = i + 1; j < items.length; j++) {
      const d = Math.hypot(items[i].x - items[j].x, items[i].z - items[j].z);
      assert.ok(d >= items[i].r + items[j].r + 0.5 * L.islandGap(items[i].r, items[j].r) - 1e-5);
    }
  }
  assert.ok(same >= 0.8 * items.length, `only ${same} items stayed put`);
  assert.ok(maxMove <= 2 * dr + 1e-6, `moved ${maxMove} for a growth of ${dr}`);
});

test('findFreeSpot never overlaps and moves nothing', () => {
  const placed = [{ x: 0, z: 0, r: 50 }, { x: 120, z: 0, r: 30 }, { x: -40, z: 90, r: 20 }];
  const snapshot = JSON.stringify(placed);
  const spot = L.findFreeSpot(placed, placed[0], 25, L.islandGap, 1.3);
  assert.equal(JSON.stringify(placed), snapshot);
  for (const p of placed) assert.ok(Math.hypot(p.x - spot.x, p.z - spot.z) >= p.r + 25 + L.islandGap(p.r, 25) - 1e-6);
});

test('procrustes2 recovers a rotation, a reflection and a translation', () => {
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push(rand() * 2 - 1, rand() * 2 - 1);
  const th = (37 * Math.PI) / 180;
  const moved = [];
  for (let i = 0; i < 30; i++) {
    const x = pts[2 * i], y = -pts[2 * i + 1]; // reflect
    moved.push(Math.cos(th) * x - Math.sin(th) * y + 0.4, Math.sin(th) * x + Math.cos(th) * y - 0.2);
  }
  const T = L.procrustes2(pts, moved);
  for (let i = 0; i < 30; i++) {
    const [x, y] = T(pts[2 * i], pts[2 * i + 1]);
    assert.ok(Math.abs(x - moved[2 * i]) < 1e-9 && Math.abs(y - moved[2 * i + 1]) < 1e-9);
  }
});

test('exactKnn matches brute force', () => {
  const n = 203;
  const X = new Float32Array(n * DIM);
  for (let i = 0; i < n; i++) X.set(unit(center()), i * DIM);
  const { k, idx } = L.exactKnn(X, n, DIM, 15);
  for (let i = 0; i < n; i++) {
    const all = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let s = 0;
      for (let d = 0; d < DIM; d++) s += X[i * DIM + d] * X[j * DIM + d];
      all.push([s, j]);
    }
    all.sort((a, b) => b[0] - a[0]);
    const want = new Set(all.slice(0, k).map((x) => x[1]));
    for (let q = 0; q < k; q++) assert.ok(want.has(idx[i * k + q]));
  }
});

test('layoutIsland keeps neighbourhoods, stays in the disk and is deterministic', () => {
  const { X, n, cluster, sub } = clusteredVectors(6, 3, 20);
  const uv = L.layoutIsland(X, n, DIM, 'synthetic');
  const again = L.layoutIsland(X, n, DIM, 'synthetic');
  assert.deepEqual(Array.from(uv), Array.from(again));
  for (let i = 0; i < n; i++) assert.ok(Math.hypot(uv[2 * i], uv[2 * i + 1]) < 1);
  assert.ok(knnPurity(uv, n, cluster) >= 0.95, 'clusters mixed');
  assert.ok(knnPurity(uv, n, sub) >= 0.7, 'sub-clusters mixed');
});

test('placeByNeighbors lands a new memory in its own cluster', () => {
  const { X, n, cluster } = clusteredVectors(2, 1, 40);
  const uv = L.layoutIsland(X, n, DIM, 'two');
  const centroid = (c) => {
    let u = 0, v = 0, m = 0;
    for (let i = 0; i < n; i++) if (cluster[i] === c) { u += uv[2 * i]; v += uv[2 * i + 1]; m++; }
    return [u / m, v / m];
  };
  const q = new Float32Array(DIM);
  q.set(X.subarray(3 * DIM, 4 * DIM)); // a cluster-0 member's vector
  const hits = [];
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let d = 0; d < DIM; d++) s += q[d] * X[j * DIM + d];
    hits.push({ score: s, u: uv[2 * j], v: uv[2 * j + 1] });
  }
  hits.sort((a, b) => b.score - a.score);
  const [u, v] = L.placeByNeighbors(hits.slice(1, 9), 'new-id', L.islandRadius(n));
  const [a, b] = [centroid(0), centroid(1)];
  assert.ok(Math.hypot(u - a[0], v - a[1]) < Math.hypot(u - b[0], v - b[1]));
});

test('region labels come from the tags that set a region apart', () => {
  const blobs = [[-0.5, 0, 'alpha'], [0.5, 0, 'beta'], [0, 0.6, 'gamma']];
  const n = 360; // √(n/40) = 3 regions allowed
  const uv = new Float32Array(2 * n);
  const tags = [];
  for (let i = 0; i < n; i++) {
    const [bx, by, t] = blobs[i % 3];
    uv[2 * i] = bx + gauss() * 0.05; uv[2 * i + 1] = by + gauss() * 0.05;
    tags.push(['common', 'acct:x', t]);
  }
  const regions = L.densityRegions(uv, n);
  assert.equal(regions.peaks.length, 3);
  const labels = L.labelRegions(regions, (i) => tags[i].map((t) => L.cleanTag(t)).filter(Boolean), () => [], n);
  assert.deepEqual(new Set(labels), new Set(['alpha', 'beta', 'gamma']));
});

test('sunflower: points never move as an island grows; the oldest sits at the centre', () => {
  const S = L.MAP.S;
  for (let i = 0; i < 10; i++) {
    const [u1, v1] = L.sunflower(i, 10, 'x');
    const [u2, v2] = L.sunflower(i, 15, 'x');
    assert.ok(Math.abs(u1 * L.islandRadius(10) - u2 * L.islandRadius(15)) < 1e-9);
    assert.ok(Math.abs(v1 * L.islandRadius(10) - v2 * L.islandRadius(15)) < 1e-9);
  }
  assert.deepEqual(L.sunflower(0, 7, 'x').map((x) => Math.abs(x)), [0, 0]);
  assert.ok(Math.abs(Math.hypot(...L.sunflower(4, 50, 'x')) * L.islandRadius(50) - S * 2) < 1e-9);
});

test('taxonomy: 3-level roots, virtual roots, cycles', () => {
  const tax = buildTaxonomy([
    { name: 'social' }, { name: 'social-interactions', parent: 'social' }, { name: 'twitter', parent: 'social-interactions' },
    { name: 'ui-layout', parent: 'design' }, { name: 'a', parent: 'b' }, { name: 'b', parent: 'a' },
  ]);
  assert.equal(tax.info('twitter').root, 'social');
  assert.deepEqual(tax.info('twitter').ancestors, ['social-interactions', 'social']);
  assert.equal(tax.info('ui-layout').root, 'design');
  assert.equal(tax.info('b').root, 'a');
  assert.equal(tax.info('unknown').root, 'unknown');
});

// ── Service, end to end on the temp database ──

const catsPath = join(dir, 'categories.json');
const writeCats = (categories) => writeFileSync(catsPath, JSON.stringify({ version: 1, categories }));
writeCats([{ name: 'alpha' }, { name: 'beta', parent: 'alpha' }, { name: 'gamma' }]);

let seq = 0;
function seed(category, vector, extra = {}) {
  const id = `m-${String(++seq).padStart(4, '0')}`;
  const created = new Date(Date.UTC(2026, 0, 1) + seq * 3600_000).toISOString();
  storage.upsertMemory(id, Array.from(vector), {
    content: extra.content || `memory ${seq} about ${category}`, category, project: 'test', tags: extra.tags || [],
    importance: extra.importance || 5, source: 'self-discovered', created_at: created, updated_at: created,
    accessed_at: created, access_count: 0,
  });
  return id;
}

function makeService(cacheName, overrides = {}) {
  const broadcasts = [];
  const s = createMemoryMapService({
    getDb: storage.getDb,
    memoryVectors: storage.memoryVectors,
    cachePath: join(dir, cacheName),
    loadCategories: () => JSON.parse(readFileSync(catsPath, 'utf8')).categories,
    categoriesPath: () => catsPath,
    broadcast: (m) => broadcasts.push(m),
    pollMs: 25,
    log: { warn() {} },
    ...overrides,
  });
  s.broadcasts = broadcasts;
  services.push(s);
  return s;
}
const read = async (s) => JSON.parse((await s.payload()).json);
const posOf = (p) => {
  const m = new Map();
  p.ids.forEach((id, i) => m.set(id, [p.pos[3 * i], p.pos[3 * i + 1], p.pos[3 * i + 2]]));
  return m;
};
const islandOf = (p, id) => {
  const i = p.ids.indexOf(id);
  return p.islands.find((isl) => i >= isl.start && i < isl.start + isl.count);
};
async function settle(s) {
  await s.tick();
  await s.whenIdle();
  await s.tick();
  await s.whenIdle();
}

test('an empty database gives an empty, ready map', async () => {
  const s = makeService('empty.json');
  await s.payload();
  await s.whenIdle();
  const p = await read(s);
  assert.equal(p.status, 'ready');
  assert.deepEqual([p.ids.length, p.islands.length, p.continents.length], [0, 0, 0]);
  s.stop();
});

const A = center(), A2 = center(), B = center(), G = center();
const alphaIds = [], betaIds = [], gammaIds = [];

test('first build: computing, then ready, with a sound payload', async () => {
  for (let i = 0; i < 40; i++) alphaIds.push(seed('alpha', around(i < 20 ? A : A2, 0.5), { tags: [i < 20 ? 'north' : 'south'] }));
  for (let i = 0; i < 20; i++) betaIds.push(seed('beta', around(B, 0.5)));
  for (let i = 0; i < 5; i++) gammaIds.push(seed('gamma', around(G, 0.5)));
  const s = makeService('map.json');
  const first = await read(s);
  assert.equal(first.status, 'computing');
  assert.equal(first.ids.length, 65);
  await s.whenIdle();
  const p = await read(s);
  assert.equal(p.status, 'ready');
  assert.equal(p.pos.length, 3 * p.ids.length);
  assert.equal(p.imp.length, p.ids.length);
  assert.equal(p.day.length, p.ids.length);
  let next = 0;
  for (const isl of p.islands) {
    assert.equal(isl.start, next);
    next += isl.count;
    for (let i = isl.start; i < isl.start + isl.count; i++) {
      const [x, y, z] = [p.pos[3 * i], p.pos[3 * i + 1], p.pos[3 * i + 2]];
      assert.ok(within(x - isl.x, z - isl.z, isl.r), `${p.ids[i]} outside ${isl.name}`);
      assert.ok(y >= 0 && y <= isl.h + 0.1);
    }
    assert.ok(isl.fitted);
  }
  assert.equal(next, p.ids.length);
  const alpha = p.islands.find((i) => i.name === 'alpha');
  const beta = p.islands.find((i) => i.name === 'beta');
  const gamma = p.islands.find((i) => i.name === 'gamma');
  assert.equal(p.continents[alpha.continent].name, 'alpha');
  assert.equal(beta.continent, alpha.continent, 'beta sits on its parent\'s continent');
  assert.notEqual(gamma.continent, alpha.continent);
  assert.ok(Math.hypot(alpha.x - beta.x, alpha.z - beta.z) >= alpha.r + beta.r - 0.2, 'islands overlap');
  // The two alpha clusters stay apart.
  const pos = posOf(p);
  const labels = alphaIds.map((_, i) => (i < 20 ? 0 : 1));
  const uv = new Float32Array(80);
  alphaIds.forEach((id, i) => { uv[2 * i] = pos.get(id)[0]; uv[2 * i + 1] = pos.get(id)[2]; });
  assert.ok(knnPurity(uv, 40, labels, 8) >= 0.9);
  // Newest on top.
  const [first0, last0] = [alphaIds[0], alphaIds[39]];
  assert.ok(pos.get(last0)[1] > pos.get(first0)[1]);
  assert.ok(s.broadcasts.some((m) => m.type === 'map:updated' && m.status === 'ready'));
  s.stop();
});

test('updates: add, move, trash, new root, rename, re-parent', async () => {
  const s = makeService('map.json');
  const base = await read(s);
  assert.equal(s.status().jobsStarted, 0, 'the cached map is reused');
  const before = posOf(base);

  // Add one memory next to alpha's first cluster: nothing else moves.
  const added = seed('alpha', around(A, 0.5));
  await settle(s);
  let p = await read(s);
  let pos = posOf(p);
  assert.equal(islandOf(p, added).name, 'alpha');
  for (const [id, xyz] of before) {
    assert.equal(pos.get(id)[0], xyz[0], `${id} moved on x`);
    assert.equal(pos.get(id)[2], xyz[2], `${id} moved on z`);
  }
  const dist = (id, ids) => ids.reduce((acc, other) => acc + Math.hypot(pos.get(id)[0] - pos.get(other)[0], pos.get(id)[2] - pos.get(other)[2]), 0) / ids.length;
  assert.ok(dist(added, alphaIds.slice(0, 20)) < dist(added, alphaIds.slice(20)), 'placed next to its own cluster');

  // Move one alpha memory to gamma.
  storage.updatePayload(alphaIds[39], { category: 'gamma' });
  await settle(s);
  p = await read(s);
  assert.equal(islandOf(p, alphaIds[39]).name, 'gamma');

  // Trash one.
  storage.updatePayload(alphaIds[38], { trashed_at: new Date().toISOString() });
  await settle(s);
  p = await read(s);
  assert.equal(p.ids.includes(alphaIds[38]), false);

  // A brand-new root category becomes a new continent; the old ones stay put.
  const contsBefore = new Map(p.continents.map((c) => [c.name, c]));
  const delta = seed('delta', around(center(), 0.5));
  await settle(s);
  p = await read(s);
  assert.equal(islandOf(p, delta).name, 'delta');
  for (const c of p.continents) {
    const old = contsBefore.get(c.name);
    if (old) assert.deepEqual([c.x, c.z], [old.x, old.z], `${c.name} moved`);
  }

  // Renaming a category moves every memory at once: the island is renamed in place.
  const gammaBefore = p.islands.find((i) => i.name === 'gamma');
  const gammaMembers = p.ids.slice(gammaBefore.start, gammaBefore.start + gammaBefore.count);
  const gammaPos = gammaMembers.map((id) => posOf(p).get(id));
  const db = storage.getDb();
  db.prepare("UPDATE memories SET category = 'gamma-renamed' WHERE category = 'gamma'").run();
  await settle(s);
  p = await read(s);
  const renamed = p.islands.find((i) => i.name === 'gamma-renamed');
  assert.ok(renamed && !p.islands.find((i) => i.name === 'gamma'));
  assert.deepEqual(gammaMembers.map((id) => posOf(p).get(id)), gammaPos);

  // Re-parent beta under the renamed island: its interior is kept.
  const betaIsl = p.islands.find((i) => i.name === 'beta');
  const rel = (q) => {
    const isl = q.islands.find((i) => i.name === 'beta');
    return betaIds.map((id) => { const [x, , z] = posOf(q).get(id); return [Math.round((x - isl.x) * 10), Math.round((z - isl.z) * 10)]; });
  };
  const interior = rel(p);
  writeCats([{ name: 'alpha' }, { name: 'beta', parent: 'gamma-renamed' }, { name: 'gamma-renamed' }]);
  await settle(s);
  p = await read(s);
  const betaAfter = p.islands.find((i) => i.name === 'beta');
  assert.equal(p.continents[betaAfter.continent].name, 'gamma-renamed');
  assert.notDeepEqual([betaAfter.x, betaAfter.z], [betaIsl.x, betaIsl.z]);
  const after = rel(p);
  for (let i = 0; i < after.length; i++) {
    assert.ok(Math.abs(after[i][0] - interior[i][0]) <= 2 && Math.abs(after[i][1] - interior[i][1]) <= 2, 'beta interior changed');
  }
  s.stop();
});

test('neighbours: k results, no self, best first, 404 on unknown ids', async () => {
  const s = makeService('map.json');
  await s.payload();
  const out = s.neighbors(alphaIds[0], 5);
  assert.equal(out.neighbors.length, 5);
  assert.ok(out.neighbors.every((n) => n.id !== alphaIds[0]));
  for (let i = 1; i < 5; i++) assert.ok(out.neighbors[i - 1].score >= out.neighbors[i].score);
  assert.equal(s.neighbors('nope'), null);

  const router = createMemoryMapApi(s);
  const layer = router.stack.find((l) => l.route?.path === '/map/neighbors/:id');
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  layer.route.stack[0].handle({ params: { id: 'nope' }, query: {} }, res);
  assert.equal(res.code, 404);
  s.stop();
});

test('persistence: a restart serves the same map without any layout job', async () => {
  const s1 = makeService('map.json');
  const p1 = await read(s1);
  s1.stop();
  const s2 = makeService('map.json');
  const p2 = await read(s2);
  assert.deepEqual(p2.ids, p1.ids);
  assert.deepEqual(p2.pos, p1.pos);
  assert.equal(s2.status().jobsStarted, 0);
  s2.stop();
});

test('a rebuild on unchanged data gives the same picture', async () => {
  const s = makeService('fresh.json');
  await s.payload();
  await s.whenIdle();
  const p1 = await read(s);
  await s.rebuild();
  const during = await read(s);
  assert.equal(during.status, 'computing');
  await s.whenIdle();
  const p2 = await read(s);
  assert.equal(p2.status, 'ready');
  assert.deepEqual(p2.ids, p1.ids);
  for (let i = 0; i < p1.pos.length; i++) assert.ok(Math.abs(p1.pos[i] - p2.pos[i]) <= 0.11, `pos[${i}] moved`);
  s.stop();
});

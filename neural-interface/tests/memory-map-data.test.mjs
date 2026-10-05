import test from 'node:test';
import assert from 'node:assert/strict';

const D = await import('../public/variant/3d/map-data.js');
const P = await import('../public/variant/3d/map-pick.js');

const sample = () => ({
  version: 1, rev: 'r1.3', status: 'ready',
  bounds: { radius: 500, height: 40 },
  continents: [{ name: 'alpha', x: 0, z: 0, r: 300 }, { name: 'gamma', x: 400, z: 0, r: 50 }],
  islands: [
    { name: 'alpha', parent: null, continent: 0, x: -50, z: 0, r: 100, h: 35, count: 3, start: 0, fitted: true, regions: [] },
    { name: 'beta', parent: 'alpha', continent: 0, x: 120, z: 0, r: 60, h: 21, count: 2, start: 3, fitted: true, regions: [] },
    { name: 'gamma', parent: null, continent: 1, x: 400, z: 0, r: 20, h: 7, count: 1, start: 5, fitted: true, regions: [] },
  ],
  ids: ['a1', 'a2', 'a3', 'b1', 'b2', 'g1'],
  pos: [-60, 0, 0, -40, 10, 5, -50, 20, -5, 110, 0, 0, 130, 10, 0, 400, 7, 0],
  imp: [5, 8, 3, 10, 1, 6],
  day: [20000, 20010, 20020, 20030, 20040, 20050],
});

test('parseMap builds typed arrays, island ranges and id lookups', () => {
  const m = D.parseMap(sample());
  assert.equal(m.n, 6);
  assert.ok(m.positions instanceof Float32Array);
  assert.deepEqual(Array.from(m.islandOf), [0, 0, 0, 1, 1, 2]);
  assert.equal(m.indexOf.get('b2'), 4);
  assert.equal(m.islandIndex.get('gamma'), 2);
  assert.equal(m.importance[3], 10);
  assert.equal(m.status, 'ready');
  assert.equal(D.parseMap({}).n, 0);
});

test('colours: parsed by hand (no linearisation) and calmed', () => {
  assert.deepEqual(D.hexToRgb('#ff0000'), [1, 0, 0]);
  assert.deepEqual(D.hexToRgb('#0f0'), [0, 1, 0]);
  const [r, g, b] = D.softColor('#ff0000');
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min));
  assert.ok(s <= 0.55 + 1e-9, `saturation ${s}`);
  assert.ok(l >= 0.55 - 1e-9 && l <= 0.72 + 1e-9, `lightness ${l}`);
});

test('recency halves every 30 days and never drops below 0.35', () => {
  assert.equal(D.recencyOf(100, 100), 1);
  assert.ok(Math.abs(D.recencyOf(70, 100) - (0.35 + 0.65 / 2)) < 1e-12);
  assert.ok(D.recencyOf(0, 100_000) >= 0.35);
  assert.equal(D.recencyOf(200, 100), 1, 'future dates count as today');
});

test('visibility: hidden categories, search and spotlight dimming, removed memories', () => {
  const m = D.parseMap(sample());
  let r = D.computeVisibility(m, { activeCategories: new Set(['alpha', 'gamma']) });
  assert.deepEqual(Array.from(r.vis), [1, 1, 1, 0, 0, 1]);
  assert.equal(r.hidden, 2);
  assert.deepEqual(r.islandShown, [true, false, true]);
  r = D.computeVisibility(m, { searchIds: new Set(['a2', 'g1']) });
  assert.deepEqual(Array.from(r.vis), [D.DIMMED, 1, D.DIMMED, D.DIMMED, D.DIMMED, 1].map(Math.fround));
  assert.equal(r.dimmed, 4);
  r = D.computeVisibility(m, { focusIds: new Set(['b1']), removedIds: new Set(['a1']) });
  assert.equal(r.vis[0], 0, 'removed is hidden, not dimmed');
  assert.equal(r.vis[3], 1);
  assert.equal(r.vis[4], Math.fround(D.DIMMED));
});

test('morph start positions follow ids; new points start where they end', () => {
  const a = D.parseMap(sample());
  const next = sample();
  next.ids = ['g1', 'a1', 'new'];
  next.pos = [1, 1, 1, 2, 2, 2, 3, 3, 3];
  next.imp = [1, 1, 1];
  next.day = [1, 1, 1];
  next.islands = [{ name: 'x', continent: 0, x: 0, z: 0, r: 1, h: 1, count: 3, start: 0, regions: [] }];
  const b = D.parseMap(next);
  const from = D.remapForMorph(a, b);
  assert.deepEqual(Array.from(from), [400, 7, 0, -60, 0, 0, 3, 3, 3]);
  assert.equal(D.samePositions(a, D.parseMap(sample())), true);
  assert.equal(D.samePositions(a, b), false);
  // Only "new" moved nowhere, g1 and a1 jumped: the morph is worth playing.
  assert.ok(D.maxDisplacement(from, b.positions) > 0.5);
  // A map that only gained points: nothing on screen moved, so no morph.
  assert.equal(D.maxDisplacement(new Float32Array([1, 2, 3, 4, 5, 6]), new Float32Array([1, 2, 3, 4, 5, 6])), 0);
});

test('titles skip markdown noise and truncate', () => {
  assert.equal(D.titleFromContent('## Fixed: the **stop** hook\nmore'), 'Fixed: the stop hook');
  assert.equal(D.titleFromContent('\n\n- `x`\n> quote line here'), 'quote line here');
  const long = D.titleFromContent('a'.repeat(200), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
  assert.equal(D.titleFromContent(''), '');
});

test('framing helpers', () => {
  const s = D.boundsSphere(new Float32Array([0, 0, 0, 10, 0, 0]));
  assert.deepEqual([s.x, s.y, s.z, s.r], [5, 0, 0, 5]);
  const d = D.fitDistance(100, 50, 1);
  assert.ok(Math.abs(d - 100 / Math.sin((25 * Math.PI) / 180)) < 1e-9);
  assert.ok(D.fitDistance(100, 50, 0.5) > d, 'a narrow view needs more distance');
});

// Identity view-projection: clip = world, so world x/y ∈ [-1, 1] map straight onto the screen.
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('picking: nearest visible point, hidden ones skipped, dimmed ones penalised', () => {
  const positions = new Float32Array([
    0, 0, 0,       // centre            → (50, 50)
    0.1, 0, 0,     // 5 px to the right → (55, 50)
    -0.5, 0.5, 0,  // top-left          → (25, 25)
  ]);
  const grid = P.buildPickGrid(positions, new Float32Array([1, 1, 1]), 3, I, 100, 100, 16);
  assert.equal(grid.count, 3);
  assert.equal(P.pickNearest(grid, 51, 50), 0);
  assert.equal(P.pickNearest(grid, 55, 51), 1);
  assert.equal(P.pickNearest(grid, 26, 24), 2);
  assert.equal(P.pickNearest(grid, 90, 90), -1, 'nothing within reach');
  const hidden = P.buildPickGrid(positions, new Float32Array([0, 1, 1]), 3, I, 100, 100, 16);
  assert.equal(P.pickNearest(hidden, 50, 50), 1, 'the hidden point is not pickable');
  const dimmed = P.buildPickGrid(positions, new Float32Array([D.DIMMED, 1, 1]), 3, I, 100, 100, 16);
  assert.equal(P.pickNearest(dimmed, 52, 50), 1, 'a dimmed point loses to a nearby lit one');
  assert.deepEqual(P.projectPoint(I, 0, 0, 0, 100, 100), [50, 50, 1]);
  assert.equal(P.onScreen(grid, 10).length, 3);
});

test('picking breaks ties toward the camera', () => {
  // Same screen spot, different depth: w grows with z in this matrix.
  const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1];
  const positions = new Float32Array([0, 0, 3, 0, 0, 1]);
  const grid = P.buildPickGrid(positions, null, 2, M, 100, 100, 16);
  assert.equal(P.pickNearest(grid, 50, 50), 1);
});

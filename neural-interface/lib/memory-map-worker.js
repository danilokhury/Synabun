// ── Memory map worker ──
//
// Computes island layouts off the main thread. It opens its own read-only
// connection (never lib/db.js — that one is read-write and runs migrations),
// reads every live memory of the requested categories in one short read
// transaction, closes the database, and then:
//   1. posts `meta`: the change-feed watermarks and each island's members and
//      centroid (the service packs the geography from these right away);
//   2. lays out every island with ≥ MAP.MIN_FIT memories, smallest first,
//      posting each one as it lands (with named regions for big islands);
//   3. posts `done`.
// The worker holds no state, so terminate() is always a safe cancel.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { MAP, cleanTag, contentTerms, densityRegions, labelRegions, layoutIsland } from './memory-map-layout.js';

export const MEMORY_MAP_WORKER_URL = new URL(import.meta.url);

/** Under a test runner, refuse any database outside the temp directory. */
function assertTestDb(dbPath) {
  if (!process.env.NODE_TEST_CONTEXT && !process.env.VITEST) return;
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const roots = [tmpdir(), '/tmp'].flatMap((r) => [r, real(r)]);
  const full = resolve(dbPath);
  const fullReal = real(dirname(full)) + sep + basename(full);
  const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  if (roots.some((root) => under(full, root) || under(fullReal, root))) return;
  throw new Error(`memory-map worker refuses ${dbPath} under a test runner`);
}

function readSnapshot({ dbPath, categories }) {
  assertTestDb(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN');
    try {
      const maxSeq = (entity) => {
        try {
          return Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM memory_changes WHERE entity = ?').get(entity).s) || 0;
        } catch { return 0; }
      };
      const watermark = { mem: maxSeq('memories'), filt: maxSeq('memory_filters') };
      const filter = Array.isArray(categories) ? categories : null;
      const where = filter
        ? `trashed_at IS NULL AND (CASE WHEN category = '' THEN 'uncategorized' ELSE category END) IN (SELECT value FROM json_each(?))`
        : 'trashed_at IS NULL';
      const args = filter ? [JSON.stringify(filter)] : [];
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(...args).n) || 0;
      const rows = db.prepare(
        `SELECT id, category, created_at, importance, tags, substr(content, 1, 600) AS head, vector
           FROM memories WHERE ${where}
          ORDER BY (CASE WHEN category = '' THEN 'uncategorized' ELSE category END), created_at, id`,
      ).iterate(...args);

      let dim = 0;
      let X = null;
      const islands = [];
      let cur = null;
      let row = 0;
      for (const r of rows) {
        const blob = r.vector;
        if (!blob || blob.byteLength < 4 || blob.byteLength % 4) continue;
        if (!dim) {
          dim = blob.byteLength / 4;
          X = new Float32Array(Math.max(total, 1) * dim);
        }
        if (blob.byteLength / 4 !== dim) continue;
        const name = r.category || 'uncategorized';
        if (!cur || cur.name !== name) {
          cur = { name, start: row, ids: [], created: [], imp: [], tags: [], heads: [] };
          islands.push(cur);
        }
        const aligned = blob.byteOffset % 4 === 0
          ? new Float32Array(blob.buffer, blob.byteOffset, dim)
          : new Float32Array(Uint8Array.from(blob).buffer);
        X.set(aligned, row * dim);
        cur.ids.push(r.id);
        const ms = Date.parse(r.created_at);
        cur.created.push(Number.isFinite(ms) ? ms : 0);
        cur.imp.push(Math.max(1, Math.min(10, Math.round(Number(r.importance) || 5))));
        let tags = [];
        try { const parsed = JSON.parse(r.tags || '[]'); if (Array.isArray(parsed)) tags = parsed; } catch {}
        cur.tags.push(tags);
        cur.heads.push(r.head || '');
        row++;
      }
      return { watermark, dim, X: X || new Float32Array(0), islands };
    } finally {
      try { db.exec('COMMIT'); } catch {}
    }
  } finally {
    db.close();
  }
}

function centroidOf(X, start, n, dim) {
  const c = new Float32Array(dim);
  for (let i = 0; i < n; i++) {
    const b = (start + i) * dim;
    for (let d = 0; d < dim; d++) c[d] += X[b + d];
  }
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += c[d] * c[d];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < dim; d++) c[d] /= norm;
  return c;
}

function regionsFor(island, uv, banned) {
  const n = island.ids.length;
  if (n < MAP.REGION_MIN) return [];
  const regions = densityRegions(uv, n);
  if (!regions.peaks.length) return [];
  const bannedSet = new Set(banned || []);
  const tagTerms = island.tags.map((tags) => [...new Set(tags.map((t) => cleanTag(t, bannedSet)).filter(Boolean))]);
  const labels = labelRegions(
    regions,
    (i) => tagTerms[i],
    (i) => contentTerms(island.heads[i], bannedSet),
    n,
  );
  return regions.peaks.map((p, i) => ({ label: labels[i], u: p.u, v: p.v, count: p.count }));
}

export function runMemoryMapJob(job, post) {
  const snap = readSnapshot(job);
  const { dim, X, islands } = snap;
  post({
    type: 'meta',
    jobId: job.jobId,
    watermark: snap.watermark,
    dim,
    islands: islands.map((isl) => ({
      name: isl.name,
      ids: isl.ids,
      created: isl.created,
      imp: isl.imp,
      centroid: dim ? centroidOf(X, isl.start, isl.ids.length, dim) : new Float32Array(0),
    })),
  });
  const order = islands
    .filter((isl) => isl.ids.length >= MAP.MIN_FIT)
    .sort((a, b) => a.ids.length - b.ids.length || (a.name < b.name ? -1 : 1));
  for (const isl of order) {
    const n = isl.ids.length;
    const uv = layoutIsland(X.subarray(isl.start * dim, (isl.start + n) * dim), n, dim, isl.name);
    const regions = regionsFor(isl, uv, job.banned?.[isl.name]);
    post({ type: 'island', jobId: job.jobId, name: isl.name, ids: isl.ids, uv, regions }, [uv.buffer]);
  }
  post({ type: 'done', jobId: job.jobId });
}

if (!isMainThread && workerData?.memoryMapJob) {
  const job = workerData.memoryMapJob;
  try {
    runMemoryMapJob(job, (msg, transfer) => parentPort.postMessage(msg, transfer || []));
  } catch (error) {
    parentPort.postMessage({ type: 'error', jobId: job.jobId, message: error?.message || String(error), stack: error?.stack || '' });
  }
}

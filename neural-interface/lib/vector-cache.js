/**
 * In-memory vector cache for similarity search (JS mirror of
 * mcp-server/src/services/vector-cache.ts — keep the two in sync).
 *
 * Holds all row vectors of one table in a single contiguous Float32Array
 * matrix (~14MB for 9k memories at 384 dims), so a search is one dot-product
 * sweep instead of a full-table scan with per-row BLOB decode.
 *
 * Coherence model:
 * - Same-process writes patch the cache incrementally via set()/remove(),
 *   or call invalidate() for bulk operations.
 * - Cross-process writes are detected with `PRAGMA data_version`, which
 *   changes whenever ANOTHER connection commits to the database file.
 *   On change the cache fully reloads (one scan, amortized across queries).
 */

export class VectorCache {
  /**
   * @param {() => import('node:sqlite').DatabaseSync} getDb
   * @param {string} loadSql      must select (id, vector)
   * @param {string} getVectorSql must select (vector) by id = ?
   */
  constructor(getDb, loadSql, getVectorSql) {
    this.getDb = getDb;
    this.loadSql = loadSql;
    this.getVectorSql = getVectorSql;
    this.ids = [];
    this.rowIndexById = new Map();
    this.matrix = new Float32Array(0);
    this.dim = 0;
    this.count = 0;
    this.capacity = 0;
    this.loaded = false;
    this.lastDataVersion = -1;
  }

  /** Drop everything; next query reloads from the database. */
  invalidate() {
    this.loaded = false;
    this.ids = [];
    this.rowIndexById.clear();
    this.matrix = new Float32Array(0);
    this.count = 0;
    this.capacity = 0;
    this.dim = 0;
    this.lastDataVersion = -1;
  }

  dataVersion() {
    return this.getDb().prepare('PRAGMA data_version').get().data_version;
  }

  ensureFresh() {
    if (this.loaded) {
      // data_version only changes when another connection commits —
      // our own writes are already applied incrementally.
      if (this.dataVersion() === this.lastDataVersion) return;
    }
    this.reload();
  }

  reload() {
    const rows = this.getDb().prepare(this.loadSql).all();
    this.ids = [];
    this.rowIndexById.clear();
    this.count = 0;

    this.dim = 0;
    for (const row of rows) {
      if (row.vector && row.vector.byteLength >= 4) {
        this.dim = row.vector.byteLength / 4;
        break;
      }
    }
    this.capacity = Math.max(rows.length, 64);
    this.matrix = new Float32Array(this.capacity * Math.max(this.dim, 1));

    for (const row of rows) {
      if (!row.vector || row.vector.byteLength !== this.dim * 4) continue; // skip malformed
      const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, this.dim);
      this.matrix.set(vec, this.count * this.dim);
      this.rowIndexById.set(row.id, this.count);
      this.ids.push(row.id);
      this.count++;
    }

    this.lastDataVersion = this.dataVersion();
    this.loaded = true;
  }

  grow() {
    this.capacity = Math.max(this.capacity * 2, 64);
    const next = new Float32Array(this.capacity * Math.max(this.dim, 1));
    next.set(this.matrix.subarray(0, this.count * this.dim));
    this.matrix = next;
  }

  /** Insert or replace a row's vector (same-process write hook). */
  set(id, vector) {
    if (!this.loaded) return; // nothing cached yet — next query loads fresh
    if (this.dim === 0) this.dim = vector.length;
    if (vector.length !== this.dim) { this.invalidate(); return; }

    let idx = this.rowIndexById.get(id);
    if (idx === undefined) {
      if (this.count >= this.capacity) this.grow();
      idx = this.count;
      this.rowIndexById.set(id, idx);
      this.ids.push(id);
      this.count++;
    }
    this.matrix.set(vector instanceof Float32Array ? vector : new Float32Array(vector), idx * this.dim);
  }

  /** Re-add a row by reading its vector back from the database. */
  setFromDb(id) {
    if (!this.loaded) return;
    try {
      const row = this.getDb().prepare(this.getVectorSql).get(id);
      if (!row?.vector) return;
      const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
      this.set(id, vec);
    } catch {
      this.invalidate();
    }
  }

  /** Remove a row (swap-with-last keeps the matrix dense). */
  remove(id) {
    if (!this.loaded) return;
    const idx = this.rowIndexById.get(id);
    if (idx === undefined) return;

    const last = this.count - 1;
    if (idx !== last) {
      this.matrix.copyWithin(idx * this.dim, last * this.dim, (last + 1) * this.dim);
      const movedId = this.ids[last];
      this.ids[idx] = movedId;
      this.rowIndexById.set(movedId, idx);
    }
    this.ids.pop();
    this.rowIndexById.delete(id);
    this.count--;
  }

  /**
   * Score all (or a filtered subset of) rows against the query vector and
   * return the top K above the threshold, sorted by score descending.
   * Vectors are unit-length, so the dot product IS the cosine similarity.
   */
  topK(query, k, threshold, allowedIds) {
    this.ensureFresh();
    if (this.count === 0 || this.dim === 0) return [];

    const q = query instanceof Float32Array ? query : new Float32Array(query);
    const dim = this.dim;
    const m = this.matrix;
    const hits = [];

    for (let r = 0; r < this.count; r++) {
      if (allowedIds && !allowedIds.has(this.ids[r])) continue;
      const base = r * dim;
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += q[i] * m[base + i];
      if (dot >= threshold) hits.push({ id: this.ids[r], score: dot });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.length > k ? hits.slice(0, k) : hits;
  }

  /**
   * Raw read access for batch consumers (e.g. graph link computation).
   * Returns { ids, matrix, dim, count } — treat as immutable.
   */
  snapshot() {
    this.ensureFresh();
    return { ids: this.ids, matrix: this.matrix, dim: this.dim, count: this.count };
  }

  size() {
    this.ensureFresh();
    return this.count;
  }
}

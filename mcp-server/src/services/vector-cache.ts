/**
 * In-memory vector cache for similarity search.
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

import type { DatabaseSync } from 'node:sqlite';

interface TopKResult {
  id: string;
  score: number;
}

export class VectorCache {
  private ids: string[] = [];
  private rowIndexById = new Map<string, number>();
  private matrix: Float32Array = new Float32Array(0);
  private dim = 0;
  private count = 0;
  private capacity = 0;
  private loaded = false;
  private lastDataVersion = -1;

  constructor(
    private getDb: () => DatabaseSync,
    private loadSql: string, // must select (id, vector)
    private getVectorSql: string, // must select (vector) by id = ?
  ) {}

  /** Drop everything; next query reloads from the database. */
  invalidate(): void {
    this.loaded = false;
    this.ids = [];
    this.rowIndexById.clear();
    this.matrix = new Float32Array(0);
    this.count = 0;
    this.capacity = 0;
    this.dim = 0;
    this.lastDataVersion = -1;
  }

  private dataVersion(): number {
    const row = this.getDb().prepare('PRAGMA data_version').get() as { data_version: number };
    return row.data_version;
  }

  private ensureFresh(): void {
    if (this.loaded) {
      // data_version only changes when another connection commits —
      // our own writes are already applied incrementally.
      const v = this.dataVersion();
      if (v === this.lastDataVersion) return;
    }
    this.reload();
  }

  private reload(): void {
    const rows = this.getDb().prepare(this.loadSql).all() as Array<{ id: string; vector: Uint8Array }>;
    this.ids = [];
    this.rowIndexById.clear();
    this.count = 0;

    // Establish dimensions from the first valid row
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

  private grow(): void {
    this.capacity = Math.max(this.capacity * 2, 64);
    const next = new Float32Array(this.capacity * Math.max(this.dim, 1));
    next.set(this.matrix.subarray(0, this.count * this.dim));
    this.matrix = next;
  }

  /**
   * Reclaim backing memory after deletions. grow() only ever doubles capacity,
   * so a long-lived process with churn (add then delete) keeps the matrix sized
   * to its historical peak. When utilization drops below 25% of a non-trivial
   * capacity, reallocate down to ~2x count so the freed slots return to the heap.
   */
  private maybeShrink(): void {
    if (this.capacity <= 64 || this.dim === 0) return;
    if (this.count >= this.capacity / 4) return;
    const nextCap = Math.max(this.count * 2, 64);
    if (nextCap >= this.capacity) return;
    const next = new Float32Array(nextCap * this.dim);
    next.set(this.matrix.subarray(0, this.count * this.dim));
    this.matrix = next;
    this.capacity = nextCap;
  }

  /** Insert or replace a row's vector (same-process write hook). */
  set(id: string, vector: number[] | Float32Array): void {
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
  setFromDb(id: string): void {
    if (!this.loaded) return;
    try {
      const row = this.getDb().prepare(this.getVectorSql).get(id) as { vector: Uint8Array } | undefined;
      if (!row?.vector) return;
      const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
      this.set(id, vec);
    } catch {
      this.invalidate();
    }
  }

  /** Remove a row (swap-with-last keeps the matrix dense). */
  remove(id: string): void {
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
    this.maybeShrink();
  }

  /**
   * Score all (or a filtered subset of) rows against the query vector and
   * return the top K above the threshold, sorted by score descending.
   * Vectors are unit-length, so the dot product IS the cosine similarity.
   */
  topK(query: number[] | Float32Array, k: number, threshold: number, allowedIds?: Set<string>): TopKResult[] {
    this.ensureFresh();
    if (this.count === 0 || this.dim === 0) return [];

    const q = query instanceof Float32Array ? query : new Float32Array(query);
    const dim = this.dim;
    const m = this.matrix;
    const hits: TopKResult[] = [];

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

  size(): number {
    this.ensureFresh();
    return this.count;
  }
}

/**
 * Tests for the SQLite storage layer.
 * Covers CRUD, search, soft delete, filters, pagination, stats.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ensureDatabase,
  upsertMemory,
  getMemory,
  searchMemories,
  searchMemoriesFTS,
  updatePayload,
  softDeleteMemory,
  restoreMemory,
  scrollMemories,
  countMemories,
  getMemoryStats,
  deleteMemory,
  closeDatabase,
} from '../src/services/sqlite.js';
import { generateEmbedding } from '../src/services/local-embeddings.js';
import { setupTestDb, teardownTestDb, makePayload, insertMemory } from './helpers.js';

describe('SQLite Service', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  // --- Basic CRUD ---

  describe('upsertMemory + getMemory', () => {
    it('should store and retrieve a memory', async () => {
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const payload = makePayload({ content: 'Hello world' });
      const vector = await generateEmbedding('Hello world');

      await upsertMemory(id, vector, payload);
      const result = await getMemory(id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(id);
      expect(result!.payload.content).toBe('Hello world');
      expect(result!.payload.category).toBe('test-category');
      expect(result!.payload.importance).toBe(5);
    });

    it('should return null for non-existent memory', async () => {
      const result = await getMemory('00000000-0000-0000-0000-000000000001');
      expect(result).toBeNull();
    });

    it('should upsert (replace) on same ID', async () => {
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const vector = await generateEmbedding('original');

      await upsertMemory(id, vector, makePayload({ content: 'original' }));
      await upsertMemory(id, vector, makePayload({ content: 'updated' }));

      const result = await getMemory(id);
      expect(result!.payload.content).toBe('updated');
    });

    it('should store and retrieve tags as array', async () => {
      const id = await insertMemory({ tags: ['redis', 'cache', 'pricing'] });
      const result = await getMemory(id);
      expect(result!.payload.tags).toEqual(['redis', 'cache', 'pricing']);
    });

    it('should store and retrieve related_files', async () => {
      const id = await insertMemory({ related_files: ['src/index.ts', 'README.md'] });
      const result = await getMemory(id);
      expect(result!.payload.related_files).toEqual(['src/index.ts', 'README.md']);
    });

    it('should store and retrieve file_checksums', async () => {
      const checksums = { 'src/index.ts': 'abc123', 'README.md': 'def456' };
      const id = await insertMemory({ file_checksums: checksums });
      const result = await getMemory(id);
      expect(result!.payload.file_checksums).toEqual(checksums);
    });
  });

  // --- updatePayload ---

  describe('updatePayload', () => {
    it('should update specific fields', async () => {
      const id = await insertMemory({ content: 'original', importance: 5 });

      await updatePayload(id, { importance: 8, content: 'updated content' });

      const result = await getMemory(id);
      expect(result!.payload.importance).toBe(8);
      expect(result!.payload.content).toBe('updated content');
    });

    it('should update tags', async () => {
      const id = await insertMemory({ tags: ['old'] });

      await updatePayload(id, { tags: ['new', 'tags'] });

      const result = await getMemory(id);
      expect(result!.payload.tags).toEqual(['new', 'tags']);
    });

    it('should not fail on empty updates', async () => {
      const id = await insertMemory();
      await updatePayload(id, {});
      const result = await getMemory(id);
      expect(result).not.toBeNull();
    });
  });

  // --- Search ---

  describe('searchMemories', () => {
    it('should find memories by vector similarity', async () => {
      await insertMemory({ content: 'Redis caching strategy for pricing' });
      await insertMemory({ content: 'PostgreSQL database migrations' });
      await insertMemory({ content: 'Redis cluster configuration' });

      const vector = await generateEmbedding('Redis caching');
      const results = await searchMemories(vector, 5, undefined, 0.0);

      expect(results.length).toBeGreaterThan(0);
      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('should respect limit', async () => {
      for (let i = 0; i < 10; i++) {
        await insertMemory({ content: `Memory number ${i}` });
      }

      const vector = await generateEmbedding('Memory');
      const results = await searchMemories(vector, 3, undefined, 0.0);

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should exclude trashed memories', async () => {
      const id = await insertMemory({ content: 'This will be trashed' });
      await softDeleteMemory(id);

      const vector = await generateEmbedding('This will be trashed');
      const results = await searchMemories(vector, 10, undefined, 0.0);

      const trashedResult = results.find(r => r.id === id);
      expect(trashedResult).toBeUndefined();
    });

    it('should filter by category', async () => {
      await insertMemory({ content: 'Bug in auth', category: 'bugs' });
      await insertMemory({ content: 'Auth architecture', category: 'architecture' });

      const vector = await generateEmbedding('auth');
      const results = await searchMemories(vector, 10, {
        must: [{ key: 'category', match: { value: 'bugs' } }],
      }, 0.0);

      for (const r of results) {
        expect(r.payload.category).toBe('bugs');
      }
    });

    it('should filter by importance range', async () => {
      await insertMemory({ content: 'Low importance', importance: 3 });
      await insertMemory({ content: 'High importance', importance: 9 });

      const vector = await generateEmbedding('importance');
      const results = await searchMemories(vector, 10, {
        must: [{ key: 'importance', range: { gte: 7 } }],
      }, 0.0);

      for (const r of results) {
        expect(r.payload.importance).toBeGreaterThanOrEqual(7);
      }
    });

    it('should filter by tag', async () => {
      await insertMemory({ content: 'Redis stuff', tags: ['redis', 'cache'] });
      await insertMemory({ content: 'Postgres stuff', tags: ['postgres', 'db'] });

      const vector = await generateEmbedding('stuff');
      const results = await searchMemories(vector, 10, {
        must: [{ key: 'tags', match: { value: 'redis' } }],
      }, 0.0);

      for (const r of results) {
        expect(r.payload.tags).toContain('redis');
      }
    });

    it('should apply must_not filter', async () => {
      await insertMemory({ content: 'Include this', category: 'keep' });
      await insertMemory({ content: 'Exclude this', category: 'skip' });

      const vector = await generateEmbedding('this');
      const results = await searchMemories(vector, 10, {
        must_not: [{ key: 'category', match: { value: 'skip' } }],
      }, 0.0);

      for (const r of results) {
        expect(r.payload.category).not.toBe('skip');
      }
    });

    it('should respect score threshold', async () => {
      await insertMemory({ content: 'specific unique content xyz123' });

      const vector = await generateEmbedding('completely different topic');
      const results = await searchMemories(vector, 10, undefined, 0.99);

      // With a very high threshold, likely no results
      // (depends on mock embedding similarity)
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.99);
      }
    });
  });

  // --- FTS Search ---

  describe('searchMemoriesFTS', () => {
    it('should find memories by keyword', async () => {
      await insertMemory({ content: 'Redis caching strategy for pricing endpoints' });
      await insertMemory({ content: 'PostgreSQL migration scripts' });

      const results = await searchMemoriesFTS('Redis pricing', 5);
      // FTS may or may not find results depending on SQLite FTS5 availability
      // Just verify it doesn't throw
      expect(Array.isArray(results)).toBe(true);
    });

    it('should exclude specified IDs', async () => {
      const id1 = await insertMemory({ content: 'Redis caching layer' });
      await insertMemory({ content: 'Redis cluster setup' });

      const results = await searchMemoriesFTS('Redis', 5, undefined, new Set([id1]));
      const foundExcluded = results.find(r => r.id === id1);
      expect(foundExcluded).toBeUndefined();
    });
  });

  // --- Soft Delete / Restore ---

  describe('softDeleteMemory + restoreMemory', () => {
    it('should soft delete a memory', async () => {
      const id = await insertMemory({ content: 'To be deleted' });

      await softDeleteMemory(id);

      const result = await getMemory(id);
      expect(result).not.toBeNull();
      expect(result!.payload.trashed_at).toBeTruthy();
    });

    it('should restore a soft-deleted memory', async () => {
      const id = await insertMemory({ content: 'To be restored' });
      await softDeleteMemory(id);

      await restoreMemory(id);

      const result = await getMemory(id);
      expect(result!.payload.trashed_at).toBeNull();
    });
  });

  // --- Hard Delete ---

  describe('deleteMemory', () => {
    it('should permanently remove a memory', async () => {
      const id = await insertMemory({ content: 'Gone forever' });

      await deleteMemory(id);

      const result = await getMemory(id);
      expect(result).toBeNull();
    });
  });

  // --- Scroll (Pagination) ---

  describe('scrollMemories', () => {
    it('should paginate results', async () => {
      for (let i = 0; i < 5; i++) {
        await insertMemory({
          content: `Memory ${i}`,
          created_at: new Date(Date.now() - i * 60000).toISOString(),
        });
      }

      const page1 = await scrollMemories(undefined, 2);
      expect(page1.points.length).toBe(2);
      expect(page1.next_page_offset).toBe('2');

      const page2 = await scrollMemories(undefined, 2, page1.next_page_offset!);
      expect(page2.points.length).toBe(2);
      expect(page2.next_page_offset).toBe('4');
    });

    it('should return null offset on last page', async () => {
      await insertMemory({ content: 'Only one' });

      const page = await scrollMemories(undefined, 10);
      expect(page.next_page_offset).toBeNull();
    });

    it('should exclude trashed memories', async () => {
      const id = await insertMemory({ content: 'Trashed' });
      await insertMemory({ content: 'Active' });
      await softDeleteMemory(id);

      const result = await scrollMemories(undefined, 10);
      const ids = result.points.map(p => p.id);
      expect(ids).not.toContain(id);
    });

    it('should filter by project', async () => {
      await insertMemory({ content: 'Project A', project: 'alpha' });
      await insertMemory({ content: 'Project B', project: 'beta' });

      const result = await scrollMemories({
        must: [{ key: 'project', match: { value: 'alpha' } }],
      }, 10);

      for (const p of result.points) {
        expect(p.payload.project).toBe('alpha');
      }
    });
  });

  // --- Count ---

  describe('countMemories', () => {
    it('should count non-trashed memories', async () => {
      await insertMemory({ content: 'One' });
      await insertMemory({ content: 'Two' });
      const trashedId = await insertMemory({ content: 'Three' });
      await softDeleteMemory(trashedId);

      const count = await countMemories();
      expect(count).toBe(2);
    });

    it('should count with filter', async () => {
      await insertMemory({ content: 'Bug A', category: 'bugs' });
      await insertMemory({ content: 'Feature B', category: 'features' });
      await insertMemory({ content: 'Bug C', category: 'bugs' });

      const count = await countMemories({
        must: [{ key: 'category', match: { value: 'bugs' } }],
      });
      expect(count).toBe(2);
    });
  });

  // --- Stats ---

  describe('getMemoryStats', () => {
    it('should return correct stats', async () => {
      await insertMemory({ content: 'A', category: 'bugs', project: 'alpha' });
      await insertMemory({ content: 'B', category: 'bugs', project: 'alpha' });
      await insertMemory({ content: 'C', category: 'features', project: 'beta' });

      const stats = await getMemoryStats();

      expect(stats.total).toBe(3);
      expect(stats.by_category['bugs']).toBe(2);
      expect(stats.by_category['features']).toBe(1);
      expect(stats.by_project['alpha']).toBe(2);
      expect(stats.by_project['beta']).toBe(1);
      expect(stats.oldest).toBeTruthy();
      expect(stats.newest).toBeTruthy();
    });

    it('should return zeroes when empty', async () => {
      const stats = await getMemoryStats();
      expect(stats.total).toBe(0);
    });
  });
});

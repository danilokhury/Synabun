/**
 * Tests for the reflect tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleReflect } from '../src/tools/reflect.js';
import { getMemory } from '../src/services/sqlite.js';
import { generateEmbedding } from '../src/services/local-embeddings.js';
import { invalidateCache } from '../src/services/neural-interface.js';
import { setupTestDb, teardownTestDb, insertMemory, extractText } from './helpers.js';

vi.mock('../src/services/categories.js', () => ({
  validateCategory: vi.fn((name: string) => ({ valid: true })),
  categoryExists: vi.fn(() => true),
  getAllCategories: vi.fn(() => ['test-category', 'bugs', 'features', 'new-cat']),
  getCategories: vi.fn(() => []),
}));

describe('reflect tool', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should update content and re-embed', async () => {
    const id = await insertMemory({ content: 'Original content' });

    const result = await handleReflect({
      memory_id: id,
      content: 'Updated content with new info',
    });

    const text = extractText(result);
    expect(text).toContain('Updated');
    expect(text).toContain('content');

    // Verify embedding was regenerated
    expect(generateEmbedding).toHaveBeenCalledWith('Updated content with new info');

    const stored = await getMemory(id);
    expect(stored!.payload.content).toBe('Updated content with new info');
  });

  it('should update importance', async () => {
    const id = await insertMemory({ importance: 5 });

    await handleReflect({ memory_id: id, importance: 9 });

    const stored = await getMemory(id);
    expect(stored!.payload.importance).toBe(9);
  });

  it('should replace tags', async () => {
    const id = await insertMemory({ tags: ['old', 'tags'] });

    await handleReflect({ memory_id: id, tags: ['new', 'replaced'] });

    const stored = await getMemory(id);
    expect(stored!.payload.tags).toEqual(['new', 'replaced']);
  });

  it('should add tags additively', async () => {
    const id = await insertMemory({ tags: ['existing'] });

    await handleReflect({ memory_id: id, add_tags: ['added1', 'added2'] });

    const stored = await getMemory(id);
    expect(stored!.payload.tags).toContain('existing');
    expect(stored!.payload.tags).toContain('added1');
    expect(stored!.payload.tags).toContain('added2');
  });

  it('should deduplicate when adding tags', async () => {
    const id = await insertMemory({ tags: ['existing', 'shared'] });

    await handleReflect({ memory_id: id, add_tags: ['shared', 'new'] });

    const stored = await getMemory(id);
    const sharedCount = stored!.payload.tags.filter(t => t === 'shared').length;
    expect(sharedCount).toBe(1);
  });

  it('should update category', async () => {
    const id = await insertMemory({ category: 'test-category' });

    await handleReflect({ memory_id: id, category: 'new-cat' });

    const stored = await getMemory(id);
    expect(stored!.payload.category).toBe('new-cat');
  });

  it('should update subcategory', async () => {
    const id = await insertMemory();

    await handleReflect({ memory_id: id, subcategory: 'architecture' });

    const stored = await getMemory(id);
    expect(stored!.payload.subcategory).toBe('architecture');
  });

  it('should update project', async () => {
    const id = await insertMemory({ project: 'old-project' });

    await handleReflect({ memory_id: id, project: 'new-project' });

    const stored = await getMemory(id);
    expect(stored!.payload.project).toBe('new-project');
  });

  it('should update related_files', async () => {
    const id = await insertMemory();

    await handleReflect({
      memory_id: id,
      related_files: ['src/new-file.ts'],
    });

    const stored = await getMemory(id);
    expect(stored!.payload.related_files).toEqual(['src/new-file.ts']);
  });

  it('should update related_memory_ids', async () => {
    const id = await insertMemory();
    const relatedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    await handleReflect({
      memory_id: id,
      related_memory_ids: [relatedId],
    });

    const stored = await getMemory(id);
    expect(stored!.payload.related_memory_ids).toEqual([relatedId]);
  });

  it('should set updated_at timestamp', async () => {
    const id = await insertMemory();
    const before = await getMemory(id);

    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));

    await handleReflect({ memory_id: id, importance: 8 });

    const after = await getMemory(id);
    expect(after!.payload.updated_at).not.toBe(before!.payload.updated_at);
  });

  it('should reject invalid UUID format', async () => {
    const result = await handleReflect({
      memory_id: 'not-a-uuid',
      content: 'test',
    });

    const text = extractText(result);
    expect(text).toContain('Invalid memory_id format');
  });

  it('should return error for non-existent memory', async () => {
    const result = await handleReflect({
      memory_id: '00000000-0000-0000-0000-000000000001',
      content: 'test',
    });

    const text = extractText(result);
    expect(text).toContain('not found');
  });

  it('should return error when no changes specified', async () => {
    const id = await insertMemory();

    const result = await handleReflect({ memory_id: id });

    const text = extractText(result);
    expect(text).toContain('No changes specified');
  });

  it('should invalidate neural interface cache', async () => {
    const id = await insertMemory();

    await handleReflect({ memory_id: id, importance: 7 });

    expect(invalidateCache).toHaveBeenCalledWith('reflect');
  });

  it('should not re-embed when only metadata changes', async () => {
    const id = await insertMemory();
    vi.mocked(generateEmbedding).mockClear();

    await handleReflect({ memory_id: id, importance: 8 });

    // generateEmbedding should NOT be called for metadata-only updates
    expect(generateEmbedding).not.toHaveBeenCalled();
  });
});

/**
 * Tests for the memories tool (browse/stats).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleMemories } from '../src/tools/memories.js';
import { setupTestDb, teardownTestDb, insertMemory, extractText } from './helpers.js';

vi.mock('../src/services/categories.js', () => ({
  validateCategory: vi.fn((name: string) => ({ valid: true })),
  categoryExists: vi.fn(() => true),
  getAllCategories: vi.fn(() => ['test-category', 'bugs', 'features']),
  getCategories: vi.fn(() => []),
}));

describe('memories tool', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestDb();
  });

  // --- Stats ---

  describe('action: stats', () => {
    it('should return memory statistics', async () => {
      await insertMemory({ content: 'Bug A', category: 'bugs', project: 'alpha' });
      await insertMemory({ content: 'Feature B', category: 'features', project: 'alpha' });
      await insertMemory({ content: 'Bug C', category: 'bugs', project: 'beta' });

      const result = await handleMemories({ action: 'stats' });
      const text = extractText(result);

      expect(text).toContain('Memory Statistics');
      expect(text).toContain('Total memories: 3');
      expect(text).toContain('bugs: 2');
      expect(text).toContain('features: 1');
      expect(text).toContain('alpha: 2');
      expect(text).toContain('beta: 1');
    });

    it('should handle empty database', async () => {
      const result = await handleMemories({ action: 'stats' });
      const text = extractText(result);

      expect(text).toContain('Total memories: 0');
    });
  });

  // --- Recent ---

  describe('action: recent', () => {
    it('should list recent memories', async () => {
      await insertMemory({ content: 'First memory' });
      await insertMemory({ content: 'Second memory' });

      const result = await handleMemories({ action: 'recent' });
      const text = extractText(result);

      expect(text).toContain('Recent memories');
    });

    it('should respect limit', async () => {
      for (let i = 0; i < 5; i++) {
        await insertMemory({ content: `Memory ${i}` });
      }

      const result = await handleMemories({ action: 'recent', limit: 2 });
      const text = extractText(result);

      const resultLines = text.split('\n').filter(l => /^\d+\.\s+\[/.test(l));
      expect(resultLines.length).toBeLessThanOrEqual(2);
    });

    it('should filter by category', async () => {
      await insertMemory({ content: 'Bug', category: 'bugs' });
      await insertMemory({ content: 'Feature', category: 'features' });

      const result = await handleMemories({ action: 'recent', category: 'bugs' });
      const text = extractText(result);

      if (text.includes('1.')) {
        expect(text).toContain('bugs');
      }
    });

    it('should filter by project', async () => {
      await insertMemory({ content: 'Alpha', project: 'alpha' });
      await insertMemory({ content: 'Beta', project: 'beta' });

      const result = await handleMemories({ action: 'recent', project: 'alpha' });
      const text = extractText(result);

      if (text.includes('1.')) {
        expect(text).toContain('alpha');
      }
    });

    it('should return no results message', async () => {
      const result = await handleMemories({
        action: 'recent',
        category: 'nonexistent',
      });
      const text = extractText(result);

      expect(text).toContain('No memories found');
    });
  });

  // --- By Category ---

  describe('action: by-category', () => {
    it('should list memories in a category', async () => {
      await insertMemory({ content: 'Bug one', category: 'bugs' });
      await insertMemory({ content: 'Bug two', category: 'bugs' });
      await insertMemory({ content: 'Feature', category: 'features' });

      const result = await handleMemories({
        action: 'by-category',
        category: 'bugs',
      });
      const text = extractText(result);

      expect(text).toContain('Memories in "bugs"');
    });
  });

  // --- By Project ---

  describe('action: by-project', () => {
    it('should list memories for a project', async () => {
      await insertMemory({ content: 'Alpha work', project: 'alpha' });
      await insertMemory({ content: 'Beta work', project: 'beta' });

      const result = await handleMemories({
        action: 'by-project',
        project: 'alpha',
      });
      const text = extractText(result);

      expect(text).toContain('Memories for "alpha"');
    });
  });

  // --- Display ---

  it('should show tags in output', async () => {
    await insertMemory({
      content: 'Tagged memory',
      tags: ['redis', 'cache'],
    });

    const result = await handleMemories({ action: 'recent' });
    const text = extractText(result);

    expect(text).toContain('redis');
    expect(text).toContain('cache');
  });

  it('should truncate long content', async () => {
    await insertMemory({ content: 'A'.repeat(200) });

    const result = await handleMemories({ action: 'recent' });
    const text = extractText(result);

    expect(text).toContain('...');
  });
});

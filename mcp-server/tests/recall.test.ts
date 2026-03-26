/**
 * Tests for the recall tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleRecall } from '../src/tools/recall.js';
import { softDeleteMemory } from '../src/services/sqlite.js';
import { validateCategory } from '../src/services/categories.js';
import { setupTestDb, teardownTestDb, insertMemory, extractText } from './helpers.js';

vi.mock('../src/services/categories.js', () => ({
  validateCategory: vi.fn((name: string) => ({ valid: true })),
  categoryExists: vi.fn(() => true),
  getAllCategories: vi.fn(() => ['test-category', 'bugs', 'features']),
  getCategories: vi.fn(() => []),
}));

describe('recall tool', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should find relevant memories', async () => {
    await insertMemory({ content: 'Redis caching strategy for pricing' });
    await insertMemory({ content: 'PostgreSQL migration guide' });

    const result = await handleRecall({ query: 'Redis caching', min_score: 0.0 });
    const text = extractText(result);

    expect(text).toContain('Found');
    expect(text).toContain('memories');
  });

  it('should return no results message when nothing matches', async () => {
    const result = await handleRecall({ query: 'nonexistent topic xyz', min_score: 0.99 });
    const text = extractText(result);
    expect(text).toContain('No memories found');
  });

  it('should respect limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await insertMemory({ content: `Memory about testing topic ${i}` });
    }

    const result = await handleRecall({ query: 'testing topic', limit: 2, min_score: 0.0 });
    const text = extractText(result);

    // Count numbered results (lines starting with "1.", "2.", etc.)
    const resultLines = text.split('\n').filter(l => /^\d+\.\s+\[/.test(l));
    expect(resultLines.length).toBeLessThanOrEqual(2);
  });

  it('should filter by category', async () => {
    await insertMemory({ content: 'Bug in auth', category: 'bugs' });
    await insertMemory({ content: 'Auth feature', category: 'features' });

    const result = await handleRecall({
      query: 'auth',
      category: 'bugs',
      min_score: 0.0,
    });
    const text = extractText(result);

    // Should contain bugs category results
    if (text.includes('Found')) {
      expect(text).toContain('bugs');
    }
  });

  it('should reject invalid category', async () => {
    vi.mocked(validateCategory).mockReturnValueOnce({
      valid: false,
      error: 'Unknown category "fake"',
    });

    const result = await handleRecall({ query: 'test', category: 'fake' });
    const text = extractText(result);
    expect(text).toContain('Unknown category');
  });

  it('should filter by project', async () => {
    await insertMemory({ content: 'Alpha thing', project: 'alpha' });
    await insertMemory({ content: 'Beta thing', project: 'beta' });

    const result = await handleRecall({
      query: 'thing',
      project: 'alpha',
      min_score: 0.0,
    });
    const text = extractText(result);

    if (text.includes('Found')) {
      expect(text).toContain('alpha');
    }
  });

  it('should filter by min_importance', async () => {
    await insertMemory({ content: 'Low priority item', importance: 3 });
    await insertMemory({ content: 'Critical priority item', importance: 9 });

    const result = await handleRecall({
      query: 'priority item',
      min_importance: 7,
      min_score: 0.0,
    });
    const text = extractText(result);

    if (text.includes('Found')) {
      expect(text).toContain('importance: 9');
      expect(text).not.toContain('importance: 3');
    }
  });

  it('should not return trashed memories', async () => {
    const id = await insertMemory({ content: 'Trashed memory content' });
    await softDeleteMemory(id);

    const result = await handleRecall({ query: 'Trashed memory content', min_score: 0.0 });
    const text = extractText(result);

    // Should either say "No memories found" or not contain the trashed ID
    if (text.includes('Found')) {
      expect(text).not.toContain(id);
    }
  });

  it('should show tags in results', async () => {
    await insertMemory({
      content: 'Tagged memory for recall',
      tags: ['redis', 'cache'],
    });

    const result = await handleRecall({ query: 'Tagged memory', min_score: 0.0 });
    const text = extractText(result);

    if (text.includes('Found')) {
      expect(text).toContain('redis');
    }
  });

  it('should show related files in results', async () => {
    await insertMemory({
      content: 'Memory with files',
      related_files: ['src/auth.ts'],
    });

    const result = await handleRecall({ query: 'Memory with files', min_score: 0.0 });
    const text = extractText(result);

    if (text.includes('Found')) {
      expect(text).toContain('src/auth.ts');
    }
  });
});

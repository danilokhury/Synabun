/**
 * Tests for the remember tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleRemember } from '../src/tools/remember.js';
import { getMemory } from '../src/services/sqlite.js';
import { validateCategory } from '../src/services/categories.js';
import { computeChecksums } from '../src/services/file-checksums.js';
import { invalidateCache } from '../src/services/neural-interface.js';
import { setupTestDb, teardownTestDb, extractText } from './helpers.js';

// Mock categories — allow all categories for testing
vi.mock('../src/services/categories.js', () => ({
  validateCategory: vi.fn((name: string) => ({ valid: true })),
  categoryExists: vi.fn(() => true),
  getAllCategories: vi.fn(() => ['test-category', 'bugs', 'features']),
  getCategories: vi.fn(() => []),
}));

describe('remember tool', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should store a basic memory and return UUID', async () => {
    const result = await handleRemember({
      content: 'Redis uses port 6379 by default',
      category: 'test-category',
    });

    const text = extractText(result);
    expect(text).toContain('Remembered [');
    expect(text).toContain('test-category');

    // Extract UUID from response
    const uuidMatch = text.match(/\[([0-9a-f-]{36})\]/);
    expect(uuidMatch).not.toBeNull();

    // Verify it's in the database
    const stored = await getMemory(uuidMatch![1]);
    expect(stored).not.toBeNull();
    expect(stored!.payload.content).toBe('Redis uses port 6379 by default');
  });

  it('should store with all optional fields', async () => {
    const result = await handleRemember({
      content: 'Critical auth bug in login flow',
      category: 'bugs',
      project: 'myproject',
      tags: ['auth', 'login', 'critical'],
      importance: 9,
      subcategory: 'bug-fix',
      source: 'user-told',
      related_files: ['src/auth.ts', 'src/login.ts'],
    });

    const text = extractText(result);
    const uuidMatch = text.match(/\[([0-9a-f-]{36})\]/);
    const stored = await getMemory(uuidMatch![1]);

    expect(stored!.payload.project).toBe('myproject');
    expect(stored!.payload.tags).toEqual(['auth', 'login', 'critical']);
    expect(stored!.payload.importance).toBe(9);
    expect(stored!.payload.subcategory).toBe('bug-fix');
    expect(stored!.payload.source).toBe('user-told');
    expect(stored!.payload.related_files).toEqual(['src/auth.ts', 'src/login.ts']);
  });

  it('should compute file checksums when related_files provided', async () => {
    await handleRemember({
      content: 'Test with files',
      category: 'test-category',
      related_files: ['src/index.ts'],
    });

    expect(computeChecksums).toHaveBeenCalledWith(['src/index.ts']);
  });

  it('should invalidate neural interface cache', async () => {
    await handleRemember({
      content: 'Test cache invalidation',
      category: 'test-category',
    });

    expect(invalidateCache).toHaveBeenCalledWith('remember');
  });

  it('should reject invalid category', async () => {
    vi.mocked(validateCategory).mockReturnValueOnce({
      valid: false,
      error: 'Unknown category "fake". Valid categories: bugs, features',
    });

    const result = await handleRemember({
      content: 'Test',
      category: 'fake',
    });

    const text = extractText(result);
    expect(text).toContain('Unknown category');
  });

  it('should default importance to 5', async () => {
    const result = await handleRemember({
      content: 'Default importance test',
      category: 'test-category',
    });

    const uuidMatch = extractText(result).match(/\[([0-9a-f-]{36})\]/);
    const stored = await getMemory(uuidMatch![1]);
    expect(stored!.payload.importance).toBe(5);
  });

  it('should default source to self-discovered', async () => {
    const result = await handleRemember({
      content: 'Default source test',
      category: 'test-category',
    });

    const uuidMatch = extractText(result).match(/\[([0-9a-f-]{36})\]/);
    const stored = await getMemory(uuidMatch![1]);
    expect(stored!.payload.source).toBe('self-discovered');
  });

  it('should truncate long content in response', async () => {
    const longContent = 'A'.repeat(200);
    const result = await handleRemember({
      content: longContent,
      category: 'test-category',
    });

    const text = extractText(result);
    expect(text).toContain('...');
  });
});

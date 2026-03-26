/**
 * Tests for the category tool.
 * Uses real category service (not mocked) since it's the unit under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleCategory } from '../src/tools/category.js';
import {
  invalidateCategoryCache,
  addCategory,
  getAllCategories,
  categoryExists,
  getCategories,
  removeCategory,
} from '../src/services/categories.js';
import { setupTestDb, teardownTestDb, insertMemory, extractText } from './helpers.js';

// We need partial mocking — mock refreshCategorySchemas but let categories work
vi.mock('../src/index.js', () => ({
  refreshCategorySchemas: vi.fn(),
}));

describe('category tool', () => {
  beforeEach(async () => {
    await setupTestDb();
    // Reset categories to a clean state
    invalidateCategoryCache();
  });

  afterEach(() => {
    teardownTestDb();
  });

  // --- Create ---

  describe('action: create', () => {
    it('should create a new category', async () => {
      const result = await handleCategory({
        action: 'create',
        name: 'test-new',
        description: 'A test category',
      });
      const text = extractText(result);

      expect(text).toContain('Created category "test-new"');
      expect(categoryExists('test-new')).toBe(true);
    });

    it('should create a parent category', async () => {
      const result = await handleCategory({
        action: 'create',
        name: 'parent-cat',
        description: 'Parent category',
        is_parent: true,
      });
      const text = extractText(result);

      expect(text).toContain('parent category');
    });

    it('should create a child under a parent', async () => {
      // First create parent
      await handleCategory({
        action: 'create',
        name: 'parent-cat',
        description: 'Parent',
        is_parent: true,
      });

      const result = await handleCategory({
        action: 'create',
        name: 'child-cat',
        description: 'Child of parent',
        parent: 'parent-cat',
      });
      const text = extractText(result);

      expect(text).toContain('Created category "child-cat"');
      expect(text).toContain('"parent-cat"');
    });

    it('should create with a color', async () => {
      const result = await handleCategory({
        action: 'create',
        name: 'colored',
        description: 'Has a color',
        color: '#3b82f6',
      });
      const text = extractText(result);

      expect(text).toContain('#3b82f6');
    });

    it('should reject missing name', async () => {
      const result = await handleCategory({
        action: 'create',
        description: 'No name',
      });
      const text = extractText(result);

      expect(text).toContain('name is required');
    });

    it('should reject missing description', async () => {
      const result = await handleCategory({
        action: 'create',
        name: 'nodesc',
      });
      const text = extractText(result);

      expect(text).toContain('description is required');
    });

    it('should reject invalid name format', async () => {
      const result = await handleCategory({
        action: 'create',
        name: 'INVALID NAME!',
        description: 'Bad name',
      });
      const text = extractText(result);

      expect(text).toContain('must match');
    });

    it('should reject duplicate name', async () => {
      await handleCategory({
        action: 'create',
        name: 'existing',
        description: 'First',
      });

      const result = await handleCategory({
        action: 'create',
        name: 'existing',
        description: 'Duplicate',
      });
      const text = extractText(result);

      expect(text).toContain('already exists');
    });

    it('should reject invalid color format', async () => {
      const result = await handleCategory({
        action: 'create',
        name: 'badcolor',
        description: 'Bad color',
        color: 'not-a-color',
      });
      const text = extractText(result);

      expect(text).toContain('Invalid color');
    });

    it('should reject too short name', async () => {
      const result = await handleCategory({
        action: 'create',
        name: 'a',
        description: 'Too short',
      });
      const text = extractText(result);

      expect(text).toContain('2-30 characters');
    });
  });

  // --- Update ---

  describe('action: update', () => {
    it('should rename a category', async () => {
      await handleCategory({
        action: 'create',
        name: 'old-name',
        description: 'Original',
      });

      const result = await handleCategory({
        action: 'update',
        name: 'old-name',
        new_name: 'new-name',
      });
      const text = extractText(result);

      expect(text).toContain('new-name');
      expect(categoryExists('new-name')).toBe(true);
      expect(categoryExists('old-name')).toBe(false);
    });

    it('should update description', async () => {
      await handleCategory({
        action: 'create',
        name: 'update-desc',
        description: 'Old desc',
      });

      const result = await handleCategory({
        action: 'update',
        name: 'update-desc',
        description: 'New description',
      });
      const text = extractText(result);

      expect(text).toContain('New description');
    });

    it('should reject non-existent category', async () => {
      const result = await handleCategory({
        action: 'update',
        name: 'nonexistent',
        description: 'Update',
      });
      const text = extractText(result);

      expect(text).toContain('does not exist');
    });

    it('should reject self-referencing parent', async () => {
      await handleCategory({
        action: 'create',
        name: 'self-ref',
        description: 'Test',
      });

      const result = await handleCategory({
        action: 'update',
        name: 'self-ref',
        parent: 'self-ref',
      });
      const text = extractText(result);

      expect(text).toContain('own parent');
    });

    it('should update color', async () => {
      await handleCategory({
        action: 'create',
        name: 'colorful',
        description: 'Test',
      });

      const result = await handleCategory({
        action: 'update',
        name: 'colorful',
        color: '#ef4444',
      });
      const text = extractText(result);

      expect(text).toContain('#ef4444');
    });

    it('should remove color with empty string', async () => {
      await handleCategory({
        action: 'create',
        name: 'decolor',
        description: 'Test',
        color: '#ef4444',
      });

      const result = await handleCategory({
        action: 'update',
        name: 'decolor',
        color: '',
      });
      const text = extractText(result);

      expect(text).toContain('auto-assigned');
    });
  });

  // --- Delete ---

  describe('action: delete', () => {
    it('should delete a category with no memories', async () => {
      await handleCategory({
        action: 'create',
        name: 'to-delete',
        description: 'Will be deleted',
      });

      const result = await handleCategory({
        action: 'delete',
        name: 'to-delete',
      });
      const text = extractText(result);

      expect(text).toContain('Deleted category "to-delete"');
      expect(categoryExists('to-delete')).toBe(false);
    });

    it('should reject delete when memories exist without reassign', async () => {
      await handleCategory({
        action: 'create',
        name: 'has-memories',
        description: 'Has memories',
      });
      await insertMemory({ category: 'has-memories' });

      const result = await handleCategory({
        action: 'delete',
        name: 'has-memories',
      });
      const text = extractText(result);

      expect(text).toContain('memories use it');
      expect(text).toContain('reassign_to');
    });

    it('should delete with reassignment', async () => {
      await handleCategory({
        action: 'create',
        name: 'source-cat',
        description: 'Source',
      });
      await handleCategory({
        action: 'create',
        name: 'target-cat',
        description: 'Target',
      });
      await insertMemory({ category: 'source-cat' });

      const result = await handleCategory({
        action: 'delete',
        name: 'source-cat',
        reassign_to: 'target-cat',
      });
      const text = extractText(result);

      expect(text).toContain('Deleted');
      expect(text).toContain('reassigned to "target-cat"');
    });

    it('should reject delete of parent with children without reassign', async () => {
      await handleCategory({
        action: 'create',
        name: 'parent-del',
        description: 'Parent to delete',
        is_parent: true,
      });
      await handleCategory({
        action: 'create',
        name: 'child-del',
        description: 'Child',
        parent: 'parent-del',
      });

      const result = await handleCategory({
        action: 'delete',
        name: 'parent-del',
      });
      const text = extractText(result);

      expect(text).toContain('child categor');
      expect(text).toContain('reassign_children_to');
    });

    it('should reject non-existent category', async () => {
      const result = await handleCategory({
        action: 'delete',
        name: 'nonexistent',
      });
      const text = extractText(result);

      expect(text).toContain('does not exist');
    });
  });

  // --- List ---

  describe('action: list', () => {
    it('should list categories in tree format', async () => {
      await handleCategory({
        action: 'create',
        name: 'parent-list',
        description: 'Parent',
        is_parent: true,
      });
      await handleCategory({
        action: 'create',
        name: 'child-list',
        description: 'Child',
        parent: 'parent-list',
      });

      const result = await handleCategory({
        action: 'list',
        format: 'tree',
      });
      const text = extractText(result);

      expect(text).toContain('Category Tree');
      expect(text).toContain('parent-list');
      expect(text).toContain('child-list');
    });

    it('should list categories in flat format', async () => {
      await handleCategory({
        action: 'create',
        name: 'flat-test',
        description: 'Flat format test',
      });

      const result = await handleCategory({
        action: 'list',
        format: 'flat',
      });
      const text = extractText(result);

      expect(text).toContain('All categories');
      expect(text).toContain('flat-test');
    });

    it('should list parents only', async () => {
      await handleCategory({
        action: 'create',
        name: 'only-parent',
        description: 'Parent only',
        is_parent: true,
      });
      await handleCategory({
        action: 'create',
        name: 'only-child',
        description: 'Child',
        parent: 'only-parent',
      });

      const result = await handleCategory({
        action: 'list',
        format: 'parents-only',
      });
      const text = extractText(result);

      expect(text).toContain('Parent categories');
      expect(text).toContain('only-parent');
    });
  });

  // --- Unknown action ---

  it('should reject unknown action', async () => {
    const result = await handleCategory({ action: 'invalid' });
    const text = extractText(result);

    expect(text).toContain('Unknown action');
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  addCategory,
  removeCategory,
  updateCategory,
  getChildCategories,
  getParentCategories,
  getCategoryTree,
} from '../../mcp-server/src/services/categories.js';
import { countMemories, updatePayloadByFilter } from '../../mcp-server/src/services/sqlite.js';
import { refreshCategorySchemas } from '../../mcp-server/src/index.js';

const { handleCategory } = await import('../../mcp-server/src/tools/category.js');

// ── Create ─────────────────────────────────────────────────────

describe('category — create', () => {
  it('missing name returns "name is required"', async () => {
    const result = await handleCategory({ action: 'create' });
    expect(result.content[0].text).toContain('name is required');
  });

  it('missing description returns "description is required"', async () => {
    const result = await handleCategory({ action: 'create', name: 'new-cat' });
    expect(result.content[0].text).toContain('description is required');
  });

  it('successful creation includes category name and calls addCategory + refreshCategorySchemas', async () => {
    const result = await handleCategory({
      action: 'create',
      name: 'test-new',
      description: 'A test category',
    });

    expect(result.content[0].text).toContain('test-new');
    expect(addCategory).toHaveBeenCalled();
    expect(refreshCategorySchemas).toHaveBeenCalled();
  });

  it('invalid color format returns "Invalid color format"', async () => {
    const result = await handleCategory({
      action: 'create',
      name: 'test-color',
      description: 'Color test',
      color: 'not-a-color',
    });
    expect(result.content[0].text).toContain('Invalid color format');
  });
});

// ── Update ─────────────────────────────────────────────────────

describe('category — update', () => {
  it('missing name returns "name is required"', async () => {
    const result = await handleCategory({ action: 'update' });
    expect(result.content[0].text).toContain('name is required');
  });

  it('nonexistent category returns "does not exist"', async () => {
    const result = await handleCategory({ action: 'update', name: 'nonexistent-cat' });
    expect(result.content[0].text).toContain('does not exist');
  });

  it('self-referential parent returns "circular reference"', async () => {
    const result = await handleCategory({
      action: 'update',
      name: 'architecture',
      parent: 'architecture',
    });
    expect(result.content[0].text).toContain('circular reference');
  });

  it('rename updates old to new name', async () => {
    const result = await handleCategory({
      action: 'update',
      name: 'architecture',
      new_name: 'arch-v2',
    });
    // The response shows "architecture" → "arch-v2"
    expect(result.content[0].text).toContain('architecture');
    expect(result.content[0].text).toContain('arch-v2');
  });
});

// ── Delete ─────────────────────────────────────────────────────

describe('category — delete', () => {
  it('missing name returns "name is required"', async () => {
    const result = await handleCategory({ action: 'delete' });
    expect(result.content[0].text).toContain('name is required');
  });

  it('nonexistent category returns "does not exist"', async () => {
    const result = await handleCategory({ action: 'delete', name: 'nonexistent-cat' });
    expect(result.content[0].text).toContain('does not exist');
  });

  it('has children without reassign_children_to blocks with "child categor"', async () => {
    vi.mocked(getChildCategories).mockReturnValueOnce([
      { name: 'child-cat', description: 'A child' },
    ] as any);
    const result = await handleCategory({ action: 'delete', name: 'synabun' });
    expect(result.content[0].text).toContain('child categor');
  });

  it('with reassign_to calls updatePayloadByFilter and removeCategory', async () => {
    // countMemories returns 42 by default from setup.ts, so reassign_to path is taken
    vi.mocked(getChildCategories).mockReturnValueOnce([]);
    const result = await handleCategory({
      action: 'delete',
      name: 'architecture',
      reassign_to: 'bug-fixes',
    });
    expect(updatePayloadByFilter).toHaveBeenCalled();
    expect(removeCategory).toHaveBeenCalled();
    expect(result.content[0].text).toContain('Deleted');
  });

  it('reassign_to same as name returns error', async () => {
    const result = await handleCategory({
      action: 'delete',
      name: 'architecture',
      reassign_to: 'architecture',
    });
    expect(result.content[0].text).toContain('Cannot reassign to the same category');
  });
});

// ── List ───────────────────────────────────────────────────────

describe('category — list', () => {
  it('flat format includes "All categories"', async () => {
    const result = await handleCategory({ action: 'list', format: 'flat' });
    expect(result.content[0].text).toContain('All categories');
  });

  it('tree format includes "Category Tree"', async () => {
    const result = await handleCategory({ action: 'list', format: 'tree' });
    expect(result.content[0].text).toContain('Category Tree');
  });

  it('parents-only format includes "Parent categories"', async () => {
    const result = await handleCategory({ action: 'list', format: 'parents-only' });
    expect(result.content[0].text).toContain('Parent categories');
  });
});

// ── Unknown action ─────────────────────────────────────────────

describe('category — unknown action', () => {
  it('returns "Unknown action"', async () => {
    const result = await handleCategory({ action: 'explode' });
    expect(result.content[0].text).toContain('Unknown action');
  });
});

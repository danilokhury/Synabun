/**
 * Tests for the forget and restore tools.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleForget } from '../src/tools/forget.js';
import { handleRestore } from '../src/tools/restore.js';
import { getMemory } from '../src/services/sqlite.js';
import { invalidateCache } from '../src/services/neural-interface.js';
import { setupTestDb, teardownTestDb, insertMemory, extractText } from './helpers.js';

describe('forget tool', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should soft delete a memory', async () => {
    const id = await insertMemory({ content: 'To be forgotten' });

    const result = await handleForget({ memory_id: id });
    const text = extractText(result);

    expect(text).toContain('Moved to trash');
    expect(text).toContain('To be forgotten');

    const stored = await getMemory(id);
    expect(stored!.payload.trashed_at).toBeTruthy();
  });

  it('should return error for non-existent memory', async () => {
    const result = await handleForget({
      memory_id: '00000000-0000-0000-0000-000000000001',
    });

    const text = extractText(result);
    expect(text).toContain('not found');
  });

  it('should return error for already trashed memory', async () => {
    const id = await insertMemory({ content: 'Already trashed' });
    await handleForget({ memory_id: id });

    const result = await handleForget({ memory_id: id });
    const text = extractText(result);

    expect(text).toContain('already in trash');
  });

  it('should invalidate neural interface cache', async () => {
    const id = await insertMemory({ content: 'Cache test' });

    await handleForget({ memory_id: id });

    expect(invalidateCache).toHaveBeenCalledWith('forget');
  });
});

describe('restore tool', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should restore a trashed memory', async () => {
    const id = await insertMemory({ content: 'Restore me' });
    await handleForget({ memory_id: id });

    const result = await handleRestore({ memory_id: id });
    const text = extractText(result);

    expect(text).toContain('Restored');

    const stored = await getMemory(id);
    expect(stored!.payload.trashed_at).toBeNull();
  });

  it('should return error for non-existent memory', async () => {
    const result = await handleRestore({
      memory_id: '00000000-0000-0000-0000-000000000001',
    });

    const text = extractText(result);
    expect(text).toContain('not found');
  });

  it('should return error for non-trashed memory', async () => {
    const id = await insertMemory({ content: 'Not trashed' });

    const result = await handleRestore({ memory_id: id });
    const text = extractText(result);

    expect(text).toContain('not in trash');
  });

  it('should handle full forget → restore cycle', async () => {
    const id = await insertMemory({ content: 'Full cycle test' });

    // Forget
    await handleForget({ memory_id: id });
    let stored = await getMemory(id);
    expect(stored!.payload.trashed_at).toBeTruthy();

    // Restore
    await handleRestore({ memory_id: id });
    stored = await getMemory(id);
    expect(stored!.payload.trashed_at).toBeNull();

    // Forget again
    await handleForget({ memory_id: id });
    stored = await getMemory(id);
    expect(stored!.payload.trashed_at).toBeTruthy();
  });
});

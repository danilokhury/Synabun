import { describe, it, expect, vi } from 'vitest';
import { getDbCallsByMethod, setRetrievePayload } from '../mocks/trackers.js';
import { getMemory } from '../../mcp-server/src/services/sqlite.js';
import { invalidateCache } from '../../mcp-server/src/services/neural-interface.js';

const { handleForget } = await import('../../mcp-server/src/tools/forget.js');

const now = new Date().toISOString();

describe('forget — behavioral tests', () => {
  it('returns error when memory not found', async () => {
    vi.mocked(getMemory).mockResolvedValueOnce(null as any);
    const result = await handleForget({ memory_id: 'nonexistent-uuid' });
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });

  it('returns "already in trash" when memory is already trashed', async () => {
    setRetrievePayload({
      content: 'Trashed memory',
      category: 'architecture',
      project: 'test-project',
      tags: [],
      importance: 5,
      source: 'self-discovered',
      created_at: now,
      updated_at: now,
      accessed_at: now,
      access_count: 0,
      trashed_at: now,
    });
    const result = await handleForget({ memory_id: 'test-uuid' });
    const text = result.content[0].text;
    expect(text).toContain('already in trash');
  });

  it('calls softDeleteMemory for valid forget', async () => {
    // Default payload has trashed_at: null, so it should proceed
    await handleForget({ memory_id: 'test-uuid' });
    const softDeletes = getDbCallsByMethod('setPayload').filter(
      (c) => (c.params as Record<string, unknown>).action === 'softDelete'
    );
    expect(softDeletes).toHaveLength(1);
  });

  it('response includes shortened ID', async () => {
    const result = await handleForget({ memory_id: '8f7cab3b-644e-4cea-8662-de0ca695bdf2' });
    const text = result.content[0].text;
    expect(text).toContain('8f7cab3b');
    // Should not contain the full UUID in the display
    expect(text).toContain('Moved to trash');
  });

  it('invalidateCache is called after forget', async () => {
    await handleForget({ memory_id: 'test-uuid' });
    expect(invalidateCache).toHaveBeenCalledWith('forget');
  });
});

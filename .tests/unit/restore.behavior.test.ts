import { describe, it, expect, vi } from 'vitest';
import { getDbCallsByMethod, setRetrievePayload } from '../mocks/trackers.js';
import { getMemory } from '../../mcp-server/src/services/sqlite.js';

const { handleRestore } = await import('../../mcp-server/src/tools/restore.js');

const now = new Date().toISOString();

describe('restore — behavioral tests', () => {
  it('returns error when memory not found', async () => {
    vi.mocked(getMemory).mockResolvedValueOnce(null as any);
    const result = await handleRestore({ memory_id: 'nonexistent-uuid' });
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });

  it('returns "not in trash" when memory has trashed_at null', async () => {
    // Default payload has trashed_at: null
    const result = await handleRestore({ memory_id: 'test-uuid' });
    const text = result.content[0].text;
    expect(text).toContain('not in trash');
  });

  it('calls restoreMemory for valid restore', async () => {
    setRetrievePayload({
      content: 'Memory to restore',
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
    await handleRestore({ memory_id: 'test-uuid' });
    const restores = getDbCallsByMethod('setPayload').filter(
      (c) => (c.params as Record<string, unknown>).action === 'restore'
    );
    expect(restores).toHaveLength(1);
  });

  it('response includes shortened ID', async () => {
    setRetrievePayload({
      content: 'Memory to restore for ID check',
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
    const result = await handleRestore({ memory_id: '8f7cab3b-644e-4cea-8662-de0ca695bdf2' });
    const text = result.content[0].text;
    expect(text).toContain('8f7cab3b');
    expect(text).toContain('Restored');
  });
});

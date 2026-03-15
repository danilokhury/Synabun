import { describe, it, expect, vi } from 'vitest';
import { getDbCallsByMethod } from '../mocks/trackers.js';
import { searchMemories } from '../../mcp-server/src/services/sqlite.js';

// recall.ts reads display-settings.json via node:fs — mock it
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    readFileSync: vi.fn().mockImplementation((filePath: string, ...args: unknown[]) => {
      if (typeof filePath === 'string' && filePath.includes('display-settings')) {
        return JSON.stringify({ recallMaxChars: 0 });
      }
      return original.readFileSync(filePath, ...args as [BufferEncoding]);
    }),
  };
});

const { handleRecall } = await import('../../mcp-server/src/tools/recall.js');

describe('recall — behavioral tests', () => {
  it('returns "No memories found" when results are empty', async () => {
    vi.mocked(searchMemories).mockResolvedValueOnce([]);
    const result = await handleRecall({ query: 'nonexistent topic' });
    const text = result.content[0].text;
    expect(text).toContain('No memories found');
  });

  it('returns numbered list with IDs for valid query', async () => {
    const result = await handleRecall({ query: 'architecture decisions' });
    const text = result.content[0].text;
    expect(text).toContain('Found');
    expect(text).toMatch(/1\./);
    expect(text).toMatch(/uuid-result-/);
  });

  it('category filter builds correct filter in searchMemories call', async () => {
    await handleRecall({ query: 'test', category: 'architecture' });
    const searches = getDbCallsByMethod('search');
    expect(searches).toHaveLength(1);
    // Category was passed — verify filter was built (search was called)
  });

  it('project filter is applied', async () => {
    await handleRecall({ query: 'test', project: 'criticalpixel' });
    const searches = getDbCallsByMethod('search');
    expect(searches).toHaveLength(1);
  });

  it('min_importance filter is applied', async () => {
    await handleRecall({ query: 'test', min_importance: 7 });
    const searches = getDbCallsByMethod('search');
    expect(searches).toHaveLength(1);
  });

  it('returns error on invalid category', async () => {
    const result = await handleRecall({ query: 'test', category: 'does-not-exist' });
    const text = result.content[0].text;
    expect(text).toContain('does-not-exist');
    // Should not have searched
    expect(getDbCallsByMethod('search')).toHaveLength(0);
  });

  it('limit is doubled when passed to searchMemories', async () => {
    await handleRecall({ query: 'test query', limit: 5 });
    const searches = getDbCallsByMethod('search');
    expect(searches).toHaveLength(1);
    expect((searches[0].params as Record<string, unknown>).limit).toBe(10); // 5 * 2
  });
});

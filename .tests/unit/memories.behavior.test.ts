import { describe, it, expect, vi } from 'vitest';
import { getDbCallsByMethod } from '../mocks/trackers.js';
import { scrollMemories } from '../../mcp-server/src/services/sqlite.js';

const { handleMemories } = await import('../../mcp-server/src/tools/memories.js');

describe('memories — behavioral tests', () => {
  it('action=stats calls getMemoryStats and response includes "Total memories: 42"', async () => {
    const result = await handleMemories({ action: 'stats' });
    const text = result.content[0].text;
    expect(text).toContain('Total memories: 42');
  });

  it('action=recent calls scrollMemories and returns numbered list', async () => {
    const result = await handleMemories({ action: 'recent' });
    const text = result.content[0].text;
    const scrolls = getDbCallsByMethod('scroll');
    expect(scrolls.length).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/1\./);
    expect(text).toContain('Recent memories');
  });

  it('action=by-category with valid category includes category filter', async () => {
    const result = await handleMemories({ action: 'by-category', category: 'architecture' });
    const text = result.content[0].text;
    const scrolls = getDbCallsByMethod('scroll');
    expect(scrolls.length).toBeGreaterThanOrEqual(1);
    expect(text).toContain('architecture');
  });

  it('action=by-category with invalid category returns error', async () => {
    const result = await handleMemories({ action: 'by-category', category: 'does-not-exist' });
    const text = result.content[0].text;
    expect(text).toContain('does-not-exist');
    // Should not have scrolled
    expect(getDbCallsByMethod('scroll')).toHaveLength(0);
  });

  it('action=by-project includes project filter', async () => {
    const result = await handleMemories({ action: 'by-project', project: 'test-project' });
    const text = result.content[0].text;
    const scrolls = getDbCallsByMethod('scroll');
    expect(scrolls.length).toBeGreaterThanOrEqual(1);
    expect(text).toContain('test-project');
  });

  it('returns "No memories found" when scroll returns empty points', async () => {
    vi.mocked(scrollMemories).mockResolvedValueOnce({
      points: [],
      next_page_offset: null,
    });
    const result = await handleMemories({ action: 'recent' });
    const text = result.content[0].text;
    expect(text).toContain('No memories found');
  });
});

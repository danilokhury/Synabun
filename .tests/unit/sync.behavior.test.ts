import { describe, it, expect, vi } from 'vitest';
import { setScrollConfig } from '../mocks/trackers.js';
import { hashFile } from '../../mcp-server/src/services/file-checksums.js';

const { handleSync } = await import('../../mcp-server/src/tools/sync.js');

describe('sync — behavioral tests', () => {
  it('returns "All clear" when no memories have checksums', async () => {
    // Default scroll mock returns points without file_checksums having content,
    // but the default scroll points have empty file_checksums: {}.
    // So withChecksums array will be empty (no keys in file_checksums).
    const result = await handleSync({});
    const text = result.content[0].text;
    expect(text).toContain('All clear');
  });

  it('matching hash means not stale', async () => {
    // Configure scroll to return points with file_checksums
    // Default scroll mock: every 3rd point (i % 3 === 0) has related_files and file_checksums
    // file_checksums: { 'src/index.ts': 'oldhash' }
    // hashFile mock returns 'abc123hash' by default.
    // But we need matching: set scroll config so points have checksums, then make hashFile match.
    setScrollConfig(10, 100);
    // Override hashFile to return the stored hash ('oldhash') so they match
    vi.mocked(hashFile).mockReturnValue('oldhash');

    const result = await handleSync({});
    const text = result.content[0].text;
    expect(text).toContain('All clear');
  });

  it('mismatched hash means stale', async () => {
    setScrollConfig(10, 100);
    // hashFile returns 'differenthash', which won't match 'oldhash' in the scroll mock
    vi.mocked(hashFile).mockReturnValue('differenthash');

    const result = await handleSync({});
    const text = result.content[0].text;
    expect(text).toContain('stale');
    expect(text).toContain('src/index.ts');
  });

  it('category filter works', async () => {
    setScrollConfig(10, 100);
    vi.mocked(hashFile).mockReturnValue('differenthash');

    // All scroll results have category: 'architecture'
    const result = await handleSync({ categories: ['architecture'] });
    const text = result.content[0].text;
    expect(text).toContain('stale');
    expect(text).toContain('architecture');
  });

  it('limit truncates output', async () => {
    setScrollConfig(30, 100);
    vi.mocked(hashFile).mockReturnValue('differenthash');

    const result = await handleSync({ limit: 2 });
    const text = result.content[0].text;
    // Should mention truncation if there are more stale than limit
    if (text.includes('showing first')) {
      expect(text).toContain('showing first 2');
    }
    // Count how many ID lines appear (each stale memory gets an ID line)
    const idLines = text.split('\n').filter(line => line.includes('uuid-scroll-'));
    expect(idLines.length).toBeLessThanOrEqual(2);
  });
});

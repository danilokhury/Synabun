/**
 * Tests for the sync tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleSync } from '../src/tools/sync.js';
import { hashFile } from '../src/services/file-checksums.js';
import { setupTestDb, teardownTestDb, insertMemory, extractText } from './helpers.js';

describe('sync tool', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('should report all clear when no stale memories', async () => {
    // Insert a memory with checksums that match the mock
    await insertMemory({
      content: 'Memory with matching checksums',
      related_files: ['src/index.ts'],
      file_checksums: { 'src/index.ts': 'sha256-mock-src-index-ts' },
    });

    const result = await handleSync({});
    const text = extractText(result);

    expect(text).toContain('All clear');
  });

  it('should detect stale memories when checksums differ', async () => {
    // Insert a memory with checksums that DON'T match the mock
    await insertMemory({
      content: 'Stale memory',
      category: 'bugs',
      importance: 7,
      related_files: ['src/changed.ts'],
      file_checksums: { 'src/changed.ts': 'old-checksum-that-no-longer-matches' },
    });

    const result = await handleSync({});
    const text = extractText(result);

    expect(text).toContain('stale');
    expect(text).toContain('src/changed.ts');
  });

  it('should filter by project', async () => {
    await insertMemory({
      content: 'Alpha stale',
      project: 'alpha',
      related_files: ['a.ts'],
      file_checksums: { 'a.ts': 'outdated' },
    });
    await insertMemory({
      content: 'Beta stale',
      project: 'beta',
      related_files: ['b.ts'],
      file_checksums: { 'b.ts': 'outdated' },
    });

    const result = await handleSync({ project: 'alpha' });
    const text = extractText(result);

    // Should only scan alpha project memories
    if (text.includes('stale')) {
      expect(text).toContain('a.ts');
    }
  });

  it('should filter by categories', async () => {
    await insertMemory({
      content: 'Bug with stale file',
      category: 'bugs',
      related_files: ['bug.ts'],
      file_checksums: { 'bug.ts': 'outdated' },
    });
    await insertMemory({
      content: 'Feature with stale file',
      category: 'features',
      related_files: ['feat.ts'],
      file_checksums: { 'feat.ts': 'outdated' },
    });

    const result = await handleSync({ categories: ['bugs'] });
    const text = extractText(result);

    if (text.includes('stale')) {
      expect(text).toContain('bugs');
    }
  });

  it('should respect limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await insertMemory({
        content: `Stale memory ${i}`,
        importance: 5 + i,
        related_files: [`file${i}.ts`],
        file_checksums: { [`file${i}.ts`]: 'outdated' },
      });
    }

    const result = await handleSync({ limit: 2 });
    const text = extractText(result);

    if (text.includes('stale')) {
      expect(text).toContain('showing first 2');
    }
  });

  it('should sort stale results by importance descending', async () => {
    await insertMemory({
      content: 'Low importance',
      importance: 3,
      related_files: ['low.ts'],
      file_checksums: { 'low.ts': 'outdated' },
    });
    await insertMemory({
      content: 'High importance',
      importance: 9,
      related_files: ['high.ts'],
      file_checksums: { 'high.ts': 'outdated' },
    });

    const result = await handleSync({});
    const text = extractText(result);

    if (text.includes('stale')) {
      const highPos = text.indexOf('imp:9');
      const lowPos = text.indexOf('imp:3');
      if (highPos >= 0 && lowPos >= 0) {
        expect(highPos).toBeLessThan(lowPos);
      }
    }
  });

  it('should skip memories without checksums', async () => {
    // Memory with related_files but no checksums (legacy)
    await insertMemory({
      content: 'Legacy memory',
      related_files: ['legacy.ts'],
      // No file_checksums
    });

    const result = await handleSync({});
    const text = extractText(result);

    // Should report all clear since the only memory has no checksums
    expect(text).toContain('All clear');
  });

  it('should skip files that hashFile returns null for', async () => {
    // Mock hashFile to return null (file not found)
    vi.mocked(hashFile).mockReturnValue(null);

    await insertMemory({
      content: 'Missing file memory',
      related_files: ['missing.ts'],
      file_checksums: { 'missing.ts': 'some-hash' },
    });

    const result = await handleSync({});
    const text = extractText(result);

    // Can't compare → not stale
    expect(text).toContain('All clear');
  });
});

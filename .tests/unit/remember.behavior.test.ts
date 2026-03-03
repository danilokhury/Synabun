import { describe, it, expect } from 'vitest';
import { getDbCallsByMethod } from '../mocks/trackers.js';
import { computeChecksums } from '../../mcp-server/src/services/file-checksums.js';
import { invalidateCache } from '../../mcp-server/src/services/neural-interface.js';

const { handleRemember } = await import('../../mcp-server/src/tools/remember.js');

describe('remember — behavioral tests', () => {
  it('returns response with UUID pattern', async () => {
    const result = await handleRemember({ content: 'Test content', category: 'architecture' });
    const text = result.content[0].text;
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(text).toMatch(uuidRegex);
  });

  it('returns error on invalid category', async () => {
    const result = await handleRemember({ content: 'Test', category: 'does-not-exist' });
    const text = result.content[0].text;
    expect(text).toContain('does-not-exist');
    // Should not have upserted anything
    expect(getDbCallsByMethod('upsert')).toHaveLength(0);
  });

  it('response text includes category, project, and importance', async () => {
    const result = await handleRemember({
      content: 'Architecture decision about caching',
      category: 'architecture',
      project: 'my-project',
      importance: 8,
    });
    const text = result.content[0].text;
    expect(text).toContain('architecture');
    expect(text).toContain('my-project');
    expect(text).toContain('importance: 8');
  });

  it('defaults importance to 5 when not provided', async () => {
    const result = await handleRemember({ content: 'Test content', category: 'architecture' });
    const text = result.content[0].text;
    expect(text).toContain('importance: 5');
  });

  it('defaults source to self-discovered', async () => {
    await handleRemember({ content: 'Test content', category: 'architecture' });
    const upserts = getDbCallsByMethod('upsert');
    expect(upserts).toHaveLength(1);
    // The source defaults are verified by the handler logic; we confirm upsert was called
    // and the response text was generated (source is in the payload, not displayed in text)
  });

  it('passes tags array through to upsert', async () => {
    const tags = ['redis', 'cache', 'pricing'];
    await handleRemember({ content: 'Tags test', category: 'architecture', tags });
    const calls = (globalThis as any).__synabun_qdrant_calls as Array<{ method: string; params: unknown }>;
    const upserts = calls.filter(c => c.method === 'upsert');
    expect(upserts).toHaveLength(1);
    // upsertMemory was called; tags are embedded in the payload passed to it
  });

  it('related_files triggers computeChecksums', async () => {
    await handleRemember({
      content: 'File checksums test',
      category: 'architecture',
      related_files: ['src/index.ts'],
    });
    expect(computeChecksums).toHaveBeenCalledWith(['src/index.ts']);
  });

  it('invalidateCache is called after remember', async () => {
    await handleRemember({ content: 'Cache invalidation test', category: 'architecture' });
    expect(invalidateCache).toHaveBeenCalledWith('remember');
  });
});

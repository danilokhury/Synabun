import { describe, it, expect, vi } from 'vitest';
import { getEmbeddingCalls, getDbCallsByMethod, setRetrievePayload } from '../mocks/trackers.js';
import { getMemory } from '../../mcp-server/src/services/sqlite.js';
import { computeChecksums } from '../../mcp-server/src/services/file-checksums.js';

const { handleReflect } = await import('../../mcp-server/src/tools/reflect.js');

const VALID_UUID = '8f7cab3b-644e-4cea-8662-de0ca695bdf2';

describe('reflect — behavioral tests', () => {
  it('returns error for invalid UUID format with message about full UUID', async () => {
    const result = await handleReflect({ memory_id: 'short-id' });
    const text = result.content[0].text;
    expect(text).toContain('full UUID');
    expect(text).toContain('short-id');
  });

  it('returns error on invalid category', async () => {
    const result = await handleReflect({ memory_id: VALID_UUID, category: 'does-not-exist' });
    const text = result.content[0].text;
    expect(text).toContain('does-not-exist');
  });

  it('returns error when memory not found', async () => {
    vi.mocked(getMemory).mockResolvedValueOnce(null as any);
    const result = await handleReflect({ memory_id: VALID_UUID, importance: 8 });
    const text = result.content[0].text;
    expect(text).toContain('not found');
  });

  it('returns "No changes specified" when no changes provided', async () => {
    const result = await handleReflect({ memory_id: VALID_UUID });
    const text = result.content[0].text;
    expect(text).toContain('No changes specified');
  });

  it('content update triggers generateEmbedding and updateVector', async () => {
    const newContent = 'Updated architecture insight about caching layer';
    await handleReflect({ memory_id: VALID_UUID, content: newContent });
    // generateEmbedding should have been called
    expect(getEmbeddingCalls()).toHaveLength(1);
    expect(getEmbeddingCalls()[0].input).toBe(newContent);
    // updateVector (tracked as 'upsert') should have been called, not setPayload
    expect(getDbCallsByMethod('upsert')).toHaveLength(1);
    // updatePayload (tracked as 'setPayload') should NOT have been called for content update
    // (there is retrieve call tracked as setPayload? No — retrieve is tracked as 'retrieve')
  });

  it('metadata-only update (importance) uses updatePayload, not updateVector', async () => {
    await handleReflect({ memory_id: VALID_UUID, importance: 9 });
    // No embedding calls for metadata-only
    expect(getEmbeddingCalls()).toHaveLength(0);
    // updatePayload (tracked as 'setPayload') should be called
    expect(getDbCallsByMethod('setPayload')).toHaveLength(1);
    // updateVector (tracked as 'upsert') should NOT be called
    expect(getDbCallsByMethod('upsert')).toHaveLength(0);
  });

  it('add_tags merges with existing and deduplicates', async () => {
    // Default payload has tags: ['test']
    const result = await handleReflect({
      memory_id: VALID_UUID,
      add_tags: ['test', 'new-tag', 'another'],
    });
    const text = result.content[0].text;
    expect(text).toContain('tags added');
    // updatePayload should have been called (metadata-only update)
    const setPayloads = getDbCallsByMethod('setPayload');
    expect(setPayloads).toHaveLength(1);
    // The payload passed to updatePayload should have deduplicated tags
    const payloadArg = (setPayloads[0].params as Record<string, unknown>).payload as Record<string, unknown>;
    const tags = payloadArg.tags as string[];
    // Should have ['test', 'new-tag', 'another'] — 'test' not duplicated
    expect(tags).toContain('test');
    expect(tags).toContain('new-tag');
    expect(tags).toContain('another');
    expect(tags.filter(t => t === 'test')).toHaveLength(1);
  });

  it('related_files triggers computeChecksums', async () => {
    await handleReflect({
      memory_id: VALID_UUID,
      related_files: ['src/lib/cache.ts'],
    });
    expect(computeChecksums).toHaveBeenCalledWith(['src/lib/cache.ts']);
  });
});

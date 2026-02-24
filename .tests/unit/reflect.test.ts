import { describe, it, expect } from 'vitest';
import { getEmbeddingCalls, getQdrantCalls, getQdrantCallsByMethod } from '../mocks/trackers.js';
import { countTokens, tokensToUSD } from '../utils/token-counter.js';

const { handleReflect } = await import('../../mcp-server/src/tools/reflect.js');

const VALID_UUID = '8f7cab3b-644e-4cea-8662-de0ca695bdf2';

describe('reflect — conditional token usage', () => {
  it('makes 0 OpenAI calls when only changing importance/tags', async () => {
    await handleReflect({
      memory_id: VALID_UUID,
      importance: 8,
      tags: ['updated', 'critical'],
    });
    expect(getEmbeddingCalls()).toHaveLength(0);
  });

  it('uses setPayload (not upsert) when no content change', async () => {
    await handleReflect({ memory_id: VALID_UUID, importance: 7 });
    expect(getQdrantCallsByMethod('setPayload')).toHaveLength(1);
    expect(getQdrantCallsByMethod('upsert')).toHaveLength(0);
  });

  it('makes 1 OpenAI call when content field is provided', async () => {
    const newContent = 'Updated memory content with new architectural insights about the caching layer';
    await handleReflect({ memory_id: VALID_UUID, content: newContent });
    expect(getEmbeddingCalls()).toHaveLength(1);
    expect(getEmbeddingCalls()[0].input).toBe(newContent);
  });

  it('uses upsert (re-embeds) when content changes', async () => {
    await handleReflect({
      memory_id: VALID_UUID,
      content: 'New content requiring re-embedding',
    });
    expect(getQdrantCallsByMethod('upsert')).toHaveLength(1);
  });

  it('always makes 1 retrieve call first', async () => {
    await handleReflect({ memory_id: VALID_UUID, importance: 9 });
    expect(getQdrantCallsByMethod('retrieve')).toHaveLength(1);
  });

  it('cost difference: metadata-only vs content update', async () => {
    // Metadata-only: 0 embedding tokens
    await handleReflect({ memory_id: VALID_UUID, importance: 8, tags: ['test'] });
    const metadataEmbeddings = getEmbeddingCalls().length;
    expect(metadataEmbeddings).toBe(0);

    // Content update: tokens proportional to new content
    const newContent = 'This is a substantial content update requiring re-embedding into a new vector';
    await handleReflect({ memory_id: VALID_UUID, content: newContent });
    // Now we have 1 embedding call (from this second handleReflect)
    expect(getEmbeddingCalls()).toHaveLength(1);

    const contentTokens = countTokens(newContent);
    console.log('\n  reflect — Cost comparison:');
    console.log(`    Metadata-only: 0 tokens ($0.00000000)`);
    console.log(`    Content update: ${contentTokens} tokens ($${tokensToUSD(contentTokens).toFixed(8)})`);
  });
});

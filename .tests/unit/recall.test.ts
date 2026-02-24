import { describe, it, expect, vi } from 'vitest';
import { getEmbeddingCalls, getQdrantCalls, getQdrantCallsByMethod } from '../mocks/trackers.js';
import { countTokens, QUERY_SIZES, tokensToUSD } from '../utils/token-counter.js';

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

describe('recall — token usage', () => {
  it('makes exactly 1 OpenAI embedding call on the query string', async () => {
    const query = 'architecture decisions about caching';
    await handleRecall({ query });
    expect(getEmbeddingCalls()).toHaveLength(1);
    expect(getEmbeddingCalls()[0].input).toBe(query);
  });

  it('passes limit * 2 to searchMemories', async () => {
    await handleRecall({ query: 'test query', limit: 5 });
    const searches = getQdrantCallsByMethod('search');
    expect(searches).toHaveLength(1);
    expect((searches[0].params as Record<string, unknown>).limit).toBe(10); // 5 * 2
  });

  it('fires N async setPayload calls for access tracking', async () => {
    await handleRecall({ query: 'test', limit: 3 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const setPayloads = getQdrantCallsByMethod('setPayload');
    expect(setPayloads.length).toBeGreaterThan(0);
    expect(setPayloads.length).toBeLessThanOrEqual(3);
  });

  it('total ops = 1 search + N access updates per call', async () => {
    const limit = 5;
    await handleRecall({ query: 'test', limit });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(getQdrantCallsByMethod('search')).toHaveLength(1);
    expect(getQdrantCallsByMethod('setPayload').length).toBeLessThanOrEqual(limit);
  });

  it('token cost scales with query length', () => {
    const results: Record<string, { tokens: number; cost: number }> = {};

    for (const [name, query] of Object.entries(QUERY_SIZES)) {
      const tokens = countTokens(query);
      results[name] = { tokens, cost: tokensToUSD(tokens) };
    }

    expect(results.short.tokens).toBeLessThan(results.typical.tokens);
    expect(results.typical.tokens).toBeLessThan(results.long.tokens);

    console.log('\n  recall — Token usage by query size:');
    for (const [name, data] of Object.entries(results)) {
      console.log(`    ${name.padEnd(10)}: ${String(data.tokens).padStart(4)} tokens -> $${data.cost.toFixed(8)}`);
    }
  });

  it('OpenAI calls constant regardless of limit (always 1)', async () => {
    for (const limit of [1, 5, 10, 20]) {
      await handleRecall({ query: 'test', limit });
    }
    // 4 calls total (one per iteration), each makes 1 embedding call
    expect(getEmbeddingCalls()).toHaveLength(4);
  });
});

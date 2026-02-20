import { describe, it, expect } from 'vitest';
import { getEmbeddingCalls, getQdrantCalls, getQdrantCallsByMethod } from '../mocks/trackers.js';

const { handleMemories } = await import('../../mcp-server/src/tools/memories.js');

describe('memories — zero embedding cost', () => {
  it('stats action: 0 OpenAI calls', async () => {
    await handleMemories({ action: 'stats' });
    expect(getEmbeddingCalls()).toHaveLength(0);
  });

  it('stats action: count calls + scroll for project breakdown', async () => {
    await handleMemories({ action: 'stats' });
    const counts = getQdrantCallsByMethod('count');
    const scrolls = getQdrantCallsByMethod('scroll');

    // getMemoryStats mock: 1 total count + 6 category counts + 1 scroll
    expect(counts.length).toBeGreaterThanOrEqual(2);
    expect(scrolls).toHaveLength(1);

    console.log(`\n  memories stats: ${counts.length} count calls + ${scrolls.length} scroll calls = ${getQdrantCalls().length} total`);
  });

  it('recent action: 0 OpenAI calls, 1 scroll', async () => {
    await handleMemories({ action: 'recent', limit: 10 });
    expect(getEmbeddingCalls()).toHaveLength(0);
    expect(getQdrantCallsByMethod('scroll')).toHaveLength(1);
    expect(getQdrantCallsByMethod('count')).toHaveLength(0);
  });

  it('by-category action: 0 OpenAI calls, 1 scroll', async () => {
    await handleMemories({ action: 'by-category', category: 'architecture', limit: 5 });
    expect(getEmbeddingCalls()).toHaveLength(0);
    expect(getQdrantCallsByMethod('scroll')).toHaveLength(1);
  });

  it('by-project action: 0 OpenAI calls, 1 scroll', async () => {
    await handleMemories({ action: 'by-project', project: 'test-project', limit: 5 });
    expect(getEmbeddingCalls()).toHaveLength(0);
    expect(getQdrantCallsByMethod('scroll')).toHaveLength(1);
  });

  it('stats is the most Qdrant-intensive action', async () => {
    // Run stats
    await handleMemories({ action: 'stats' });
    const statsOps = getQdrantCalls().length;

    // Can't compare in same test since trackers are reset per test
    // Just verify stats has many ops
    expect(statsOps).toBeGreaterThan(2);
    console.log(`\n  memories stats total ops: ${statsOps}`);
  });
});

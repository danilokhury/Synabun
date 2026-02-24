import { describe, it, expect } from 'vitest';
import { getEmbeddingCalls, getQdrantCalls, getQdrantCallsByMethod, setScrollConfig } from '../mocks/trackers.js';

const { handleSync } = await import('../../mcp-server/src/tools/sync.js');

describe('sync — pagination and zero embedding cost', () => {
  it('makes 0 OpenAI embedding calls', async () => {
    await handleSync({});
    expect(getEmbeddingCalls()).toHaveLength(0);
  });

  it('makes 1 scroll call for small collections', async () => {
    await handleSync({});
    expect(getQdrantCallsByMethod('scroll')).toHaveLength(1);
  });

  it('makes multiple scroll calls with pagination', async () => {
    // Configure 3 pages of results
    setScrollConfig(250, 100);
    await handleSync({});
    const scrolls = getQdrantCallsByMethod('scroll');
    expect(scrolls).toHaveLength(3);
  });

  it('Qdrant ops scale with collection size', async () => {
    console.log('\n  sync — Qdrant scroll calls by collection size:');
    for (const pages of [1, 2, 3, 5, 10]) {
      setScrollConfig(pages * 100, 100);
      await handleSync({});
      const scrolls = getQdrantCallsByMethod('scroll').length;
      console.log(`    ${String(pages * 100).padStart(5)} memories -> ${scrolls} scroll calls`);
    }
  });

  it('never calls OpenAI regardless of collection size', async () => {
    setScrollConfig(1000, 100);
    await handleSync({});
    expect(getEmbeddingCalls()).toHaveLength(0);
  });
});

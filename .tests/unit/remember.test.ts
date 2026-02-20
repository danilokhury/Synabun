import { describe, it, expect } from 'vitest';
import { getEmbeddingCalls, getQdrantCalls, getQdrantCallsByMethod } from '../mocks/trackers.js';
import { countTokens, CONTENT_SIZES, estimateTokensFast, tokensToUSD } from '../utils/token-counter.js';

const { handleRemember } = await import('../../mcp-server/src/tools/remember.js');

describe('remember — token usage', () => {
  it('makes exactly 1 OpenAI embedding call per invocation', async () => {
    await handleRemember({ content: CONTENT_SIZES.small, category: 'architecture' });
    expect(getEmbeddingCalls()).toHaveLength(1);
  });

  it('embeds the content string, not metadata', async () => {
    const content = 'Specific content to embed for testing purposes';
    await handleRemember({ content, category: 'architecture' });
    expect(getEmbeddingCalls()[0].input).toBe(content);
  });

  it('makes exactly 1 Qdrant upsert call', async () => {
    await handleRemember({ content: CONTENT_SIZES.small, category: 'architecture' });
    expect(getQdrantCallsByMethod('upsert')).toHaveLength(1);
  });

  it('makes 0 Qdrant search or retrieve calls', async () => {
    await handleRemember({ content: CONTENT_SIZES.small, category: 'architecture' });
    expect(getQdrantCallsByMethod('search')).toHaveLength(0);
    expect(getQdrantCallsByMethod('retrieve')).toHaveLength(0);
  });

  it('token count scales with content size', () => {
    const results: Record<string, { tokens: number; chars: number; cost: number }> = {};

    for (const [sizeName, content] of Object.entries(CONTENT_SIZES)) {
      const tokens = countTokens(content);
      results[sizeName] = {
        tokens,
        chars: content.length,
        cost: tokensToUSD(tokens),
      };
    }

    expect(results.tiny.tokens).toBeLessThan(results.small.tokens);
    expect(results.small.tokens).toBeLessThan(results.medium.tokens);
    expect(results.medium.tokens).toBeLessThan(results.large.tokens);
    expect(results.large.tokens).toBeLessThan(results.xlarge.tokens);

    console.log('\n  remember — Token usage by content size:');
    for (const [name, data] of Object.entries(results)) {
      console.log(`    ${name.padEnd(8)}: ${String(data.chars).padStart(6)} chars -> ${String(data.tokens).padStart(5)} tokens -> $${data.cost.toFixed(8)}`);
    }
  });

  it('fast estimator converges with tiktoken for longer text', () => {
    // char/4 estimation is a rough heuristic. For typical SynaBun content (medium+),
    // it's within 50% of tiktoken. For very short text, tokens average > 4 chars
    // so the estimator over-counts.
    const results: Array<{ name: string; exact: number; estimated: number; ratio: number }> = [];

    for (const [name, content] of Object.entries(CONTENT_SIZES)) {
      const exact = countTokens(content);
      const estimated = estimateTokensFast(content);
      const ratio = estimated / exact;
      results.push({ name, exact, estimated, ratio });

      // All sizes: estimator should be within 2x (loose bound)
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2.0);
    }

    // Large+ text should converge better (< 60% error)
    // char/4 consistently over-estimates for English prose with technical terms (~1.5x)
    const large = results.find(r => r.name === 'large')!;
    const xlarge = results.find(r => r.name === 'xlarge')!;
    expect(large.ratio).toBeGreaterThan(0.7);
    expect(large.ratio).toBeLessThan(1.6);
    expect(xlarge.ratio).toBeGreaterThan(0.7);
    expect(xlarge.ratio).toBeLessThan(1.6);

    console.log('\n  Estimator accuracy (char/4 vs tiktoken):');
    for (const r of results) {
      console.log(`    ${r.name.padEnd(8)}: tiktoken=${String(r.exact).padStart(5)}, estimate=${String(r.estimated).padStart(5)}, ratio=${r.ratio.toFixed(2)}`);
    }
  });

  it('returns success response with memory ID', async () => {
    const result = await handleRemember({ content: CONTENT_SIZES.large, category: 'architecture' });
    expect(result.content[0].text).toContain('Remembered');
  });

  it('total API footprint: 1 embed + 1 upsert', async () => {
    await handleRemember({ content: 'Test content', category: 'architecture' });
    expect(getEmbeddingCalls()).toHaveLength(1);
    expect(getQdrantCalls()).toHaveLength(1);
    expect(getQdrantCallsByMethod('upsert')).toHaveLength(1);
  });
});

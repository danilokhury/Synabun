import { describe, it, expect } from 'vitest';
import { countTokens, tokensToUSD, formatCost, estimateTokensFast } from '../utils/token-counter.js';
import { createToolStats, aggregateSession } from '../utils/call-tracker.js';

/**
 * Models the mandatory token cost at session start.
 *
 * Per SynaBun's session-start.mjs directives, every session begins with:
 * 1. recall "last conversation session" (category=conversations, project=criticalpixel)
 * 2. recall about ongoing work, recent decisions, known issues (no category filter)
 * 3. Optional: prompt-submit.mjs triggers additional recall on first user message
 *
 * This test calculates the baseline cost before any user work begins.
 */

// Realistic query strings from session-start.mjs
const SESSION_START_QUERIES = [
  'last conversation session',
  'ongoing work recent decisions known issues for criticalpixel',
];

// prompt-submit.mjs triggers on first user message (typical patterns)
const PROMPT_TRIGGER_QUERIES = [
  'context about current project criticalpixel',
];

const DEFAULT_RECALL_LIMIT = 5;

describe('session start overhead', () => {
  it('calculates baseline token cost for mandatory recalls', () => {
    let totalTokens = 0;
    const queryDetails: Array<{ query: string; tokens: number }> = [];

    for (const query of SESSION_START_QUERIES) {
      const tokens = countTokens(query);
      totalTokens += tokens;
      queryDetails.push({ query, tokens });
    }

    const cost = tokensToUSD(totalTokens);
    const totalQdrantOps = SESSION_START_QUERIES.length * (1 + DEFAULT_RECALL_LIMIT); // 1 search + N setPayload per recall

    console.log('\n  Session start overhead:');
    console.log('  Mandatory recall queries:');
    for (const d of queryDetails) {
      console.log(`    "${d.query}" -> ${d.tokens} tokens`);
    }
    console.log(`\n  Total: ${totalTokens} tokens, ${formatCost(cost)}`);
    console.log(`  Qdrant ops: ${totalQdrantOps} (${SESSION_START_QUERIES.length} searches + ${SESSION_START_QUERIES.length * DEFAULT_RECALL_LIMIT} access updates)`);

    expect(totalTokens).toBeGreaterThan(0);
    expect(totalTokens).toBeLessThan(100); // Queries are short
  });

  it('includes prompt-submit trigger cost', () => {
    const allQueries = [...SESSION_START_QUERIES, ...PROMPT_TRIGGER_QUERIES];
    let totalTokens = 0;

    for (const query of allQueries) {
      totalTokens += countTokens(query);
    }

    const cost = tokensToUSD(totalTokens);
    const openaiCalls = allQueries.length;
    const qdrantOps = allQueries.length * (1 + DEFAULT_RECALL_LIMIT);

    console.log(`\n  With prompt triggers: ${totalTokens} tokens, ${openaiCalls} OpenAI calls, ${qdrantOps} Qdrant ops, ${formatCost(cost)}`);

    expect(totalTokens).toBeLessThan(150);
    expect(cost).toBeLessThan(0.001);
  });

  it('generates session overhead stats', () => {
    const allQueries = [...SESSION_START_QUERIES, ...PROMPT_TRIGGER_QUERIES];
    const totalTokens = allQueries.reduce((s, q) => s + countTokens(q), 0);

    const stats = createToolStats(
      'recall (session-start)',
      allQueries.length,
      allQueries.length,
      totalTokens,
      { search: allQueries.length, setPayload: allQueries.length * DEFAULT_RECALL_LIMIT },
      tokensToUSD(totalTokens),
    );

    const session = aggregateSession('session-overhead', 'Baseline cost per session start', [stats]);

    expect(session.totals.openaiCalls).toBe(allQueries.length);
    expect(session.totals.embeddingTokens).toBe(totalTokens);
    expect(session.totals.costUSD).toBe(tokensToUSD(totalTokens));
  });
});

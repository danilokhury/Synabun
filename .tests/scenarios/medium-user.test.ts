import { describe, it, expect } from 'vitest';
import { countTokens, tokensToUSD, formatCost, formatTokens } from '../utils/token-counter.js';
import { createToolStats, aggregateSession } from '../utils/call-tracker.js';

/**
 * Medium user scenario:
 * - 15 remember calls per session (mix of sizes)
 * - 30 recall calls per session (frequent context checks)
 * - 3 session-start recalls (mandatory)
 * - 5 reflect calls: 3 metadata-only + 2 with content updates
 * - 1 forget + 1 restore per session
 * - 2 sessions/day
 */

const SESSION_REMEMBER = 15;
const SESSION_RECALL = 30;
const SESSION_START_RECALLS = 3;
const SESSION_REFLECT_METADATA = 3;
const SESSION_REFLECT_CONTENT = 2;
const SESSION_FORGET = 1;
const SESSION_RESTORE = 1;
const DEFAULT_RECALL_LIMIT = 5;

// Varied content sizes for medium user
const REMEMBER_CONTENTS = [
  // Short notes (5x)
  'Fixed a typo in the GamePricesWidget component prop name.',
  'Updated the Redis cache TTL from 300 to 600 seconds for better hit rates.',
  'Added missing TypeScript type for the review form submission payload.',
  'Refactored the Steam API adapter to handle rate limiting gracefully.',
  'Discovered that Supabase RPC calls need explicit type casting for integer arrays.',
  // Medium notes (5x)
  'The dual Supabase architecture requires careful consideration of which database to query. Auth-related data goes to Cloud Supabase while content data goes to VPS. The isVpsTable helper function handles this routing.',
  'Implemented a new caching strategy for game rankings that uses a sliding window approach. Rankings are updated every 10 minutes via cron but cached for 5 minutes in Redis to reduce database load.',
  'Found and fixed a race condition in the price orchestrator where concurrent requests for the same game could cause duplicate cache entries. Solution was to add a mutex using Redis SETNX.',
  'The Lexical editor configuration needs all related packages to be transpiled via next.config.ts. Missing a package causes hydration mismatches between server and client rendering.',
  'Forum system uses nested comments with PostgreSQL recursive CTEs for efficient tree traversal. The comment_votes table tracks user votes to prevent double-voting.',
  // Long notes (5x)
  ...(Array(5).fill(
    'Comprehensive architectural decision about the pricing system. The orchestrator singleton manages multiple store adapters (Steam, Gamivo, YuPlay, InstantGaming) and aggregates prices across 25+ regions. Each adapter implements a common interface with fetchPrices and normalizeCurrency methods. The Redis cache uses a composite key of gameId+storeId+region with a 10-minute TTL. Failed adapter calls are logged but do not block other adapters from returning results.'
  )),
];

const RECALL_QUERY = 'architecture decisions and implementation patterns for the current feature';
const SESSION_START_QUERY = 'last conversation session about ongoing work';
const REFLECT_CONTENT = 'Updated memory with new context: the implementation was refined to use a more efficient approach with better error handling and logging.';

describe('medium user scenario (15 remember + 30 recall, 2 sessions/day)', () => {
  const rememberTokensTotal = REMEMBER_CONTENTS.reduce((s, c) => s + countTokens(c), 0);
  const recallTokensPerQuery = countTokens(RECALL_QUERY);
  const startTokensPerQuery = countTokens(SESSION_START_QUERY);
  const reflectContentTokens = countTokens(REFLECT_CONTENT);

  it('calculates per-session token usage', () => {
    const totalRecallTokens = SESSION_RECALL * recallTokensPerQuery;
    const totalStartTokens = SESSION_START_RECALLS * startTokensPerQuery;
    const totalReflectTokens = SESSION_REFLECT_CONTENT * reflectContentTokens;
    const total = rememberTokensTotal + totalRecallTokens + totalStartTokens + totalReflectTokens;
    const cost = tokensToUSD(total);

    console.log('\n  Medium user — per session:');
    console.log(`    remember:         ${SESSION_REMEMBER} calls, ${rememberTokensTotal} tokens`);
    console.log(`    recall:           ${SESSION_RECALL} calls, ${totalRecallTokens} tokens`);
    console.log(`    start recalls:    ${SESSION_START_RECALLS} calls, ${totalStartTokens} tokens`);
    console.log(`    reflect (content):${SESSION_REFLECT_CONTENT} calls, ${totalReflectTokens} tokens`);
    console.log(`    reflect (meta):   ${SESSION_REFLECT_METADATA} calls, 0 tokens`);
    console.log(`    forget/restore:   ${SESSION_FORGET + SESSION_RESTORE} calls, 0 tokens`);
    console.log(`    TOTAL:            ${total} tokens, ${formatCost(cost)}`);

    expect(total).toBeGreaterThan(0);
  });

  it('calculates per-session Qdrant operations', () => {
    const rememberOps = SESSION_REMEMBER * 1;
    const recallOps = (SESSION_RECALL + SESSION_START_RECALLS) * (1 + DEFAULT_RECALL_LIMIT);
    const reflectMetaOps = SESSION_REFLECT_METADATA * 2;
    const reflectContentOps = SESSION_REFLECT_CONTENT * 2; // retrieve + upsert
    const forgetRestoreOps = (SESSION_FORGET + SESSION_RESTORE) * 2;
    const total = rememberOps + recallOps + reflectMetaOps + reflectContentOps + forgetRestoreOps;

    console.log(`\n  Medium user — Qdrant ops/session: ${total}`);
    expect(total).toBeGreaterThan(0);
  });

  it('calculates monthly projection at 2 sessions/day', () => {
    const totalRecallTokens = SESSION_RECALL * recallTokensPerQuery;
    const totalStartTokens = SESSION_START_RECALLS * startTokensPerQuery;
    const totalReflectTokens = SESSION_REFLECT_CONTENT * reflectContentTokens;
    const perSessionTokens = rememberTokensTotal + totalRecallTokens + totalStartTokens + totalReflectTokens;

    const monthlyTokens = perSessionTokens * 60; // 2 sessions/day * 30 days
    const monthlyCost = tokensToUSD(monthlyTokens);
    const yearlyCost = monthlyCost * 12;

    console.log('\n  Medium user — monthly projection (60 sessions):');
    console.log(`    Tokens:  ${formatTokens(monthlyTokens)}/month`);
    console.log(`    Cost:    ${formatCost(monthlyCost)}/month`);
    console.log(`    Yearly:  ${formatCost(yearlyCost)}/year`);

    expect(monthlyCost).toBeLessThan(1.00);
  });

  it('generates structured session stats', () => {
    const totalRecallTokens = SESSION_RECALL * recallTokensPerQuery;
    const totalStartTokens = SESSION_START_RECALLS * startTokensPerQuery;
    const totalReflectTokens = SESSION_REFLECT_CONTENT * reflectContentTokens;

    const stats = [
      createToolStats('remember', SESSION_REMEMBER, SESSION_REMEMBER, rememberTokensTotal,
        { upsert: SESSION_REMEMBER }, tokensToUSD(rememberTokensTotal)),
      createToolStats('recall', SESSION_RECALL, SESSION_RECALL, totalRecallTokens,
        { search: SESSION_RECALL, setPayload: SESSION_RECALL * DEFAULT_RECALL_LIMIT }, tokensToUSD(totalRecallTokens)),
      createToolStats('recall (session-start)', SESSION_START_RECALLS, SESSION_START_RECALLS, totalStartTokens,
        { search: SESSION_START_RECALLS, setPayload: SESSION_START_RECALLS * DEFAULT_RECALL_LIMIT }, tokensToUSD(totalStartTokens)),
      createToolStats('reflect (content)', SESSION_REFLECT_CONTENT, SESSION_REFLECT_CONTENT, totalReflectTokens,
        { retrieve: SESSION_REFLECT_CONTENT, upsert: SESSION_REFLECT_CONTENT }, tokensToUSD(totalReflectTokens)),
      createToolStats('reflect (metadata)', SESSION_REFLECT_METADATA, 0, 0,
        { retrieve: SESSION_REFLECT_METADATA, setPayload: SESSION_REFLECT_METADATA }, 0),
      createToolStats('forget', SESSION_FORGET, 0, 0,
        { retrieve: SESSION_FORGET, setPayload: SESSION_FORGET }, 0),
      createToolStats('restore', SESSION_RESTORE, 0, 0,
        { retrieve: SESSION_RESTORE, setPayload: SESSION_RESTORE }, 0),
    ];

    const session = aggregateSession('medium', 'Medium user: 15 remember + 30 recall, 2 sessions/day', stats);

    const expectedOpenAI = SESSION_REMEMBER + SESSION_RECALL + SESSION_START_RECALLS + SESSION_REFLECT_CONTENT;
    expect(session.totals.openaiCalls).toBe(expectedOpenAI);
    expect(session.totals.embeddingTokens).toBeGreaterThan(0);
  });
});

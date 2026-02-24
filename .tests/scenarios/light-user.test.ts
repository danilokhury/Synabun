import { describe, it, expect } from 'vitest';
import { countTokens, estimateTokensFast, tokensToUSD, formatCost, formatTokens } from '../utils/token-counter.js';
import { createToolStats, aggregateSession } from '../utils/call-tracker.js';

/**
 * Light user scenario:
 * - 5 remember calls per session (avg 350 chars content)
 * - 10 recall calls per session (avg 60 chars query)
 * - 3 session-start recalls (mandatory)
 * - 2 reflect calls (metadata-only, no embedding cost)
 * - 1 session/day
 */

const SESSION_REMEMBER = 5;
const SESSION_RECALL = 10;
const SESSION_START_RECALLS = 3;
const SESSION_REFLECT_METADATA = 2; // No OpenAI cost
const DEFAULT_RECALL_LIMIT = 5;

const AVG_REMEMBER_CONTENT = 'This is a typical memory about an implementation detail or bug fix that was discovered during a coding session. It includes the what, why, and how of the change made.';
const AVG_RECALL_QUERY = 'architecture decisions about caching and Redis';
const AVG_SESSION_START_QUERY = 'last conversation session about ongoing work';

describe('light user scenario (5 remember + 10 recall, 1 session/day)', () => {
  const rememberTokens = countTokens(AVG_REMEMBER_CONTENT);
  const recallTokens = countTokens(AVG_RECALL_QUERY);
  const startTokens = countTokens(AVG_SESSION_START_QUERY);

  it('calculates per-session token usage', () => {
    const totalRememberTokens = SESSION_REMEMBER * rememberTokens;
    const totalRecallTokens = SESSION_RECALL * recallTokens;
    const totalStartTokens = SESSION_START_RECALLS * startTokens;
    const total = totalRememberTokens + totalRecallTokens + totalStartTokens;
    const cost = tokensToUSD(total);

    console.log('\n  Light user — per session:');
    console.log(`    remember: ${SESSION_REMEMBER} x ${rememberTokens} tokens = ${totalRememberTokens} tokens`);
    console.log(`    recall:   ${SESSION_RECALL} x ${recallTokens} tokens = ${totalRecallTokens} tokens`);
    console.log(`    start:    ${SESSION_START_RECALLS} x ${startTokens} tokens = ${totalStartTokens} tokens`);
    console.log(`    reflect:  ${SESSION_REFLECT_METADATA} x 0 tokens = 0 tokens (metadata-only)`);
    console.log(`    TOTAL:    ${total} tokens, ${formatCost(cost)}`);

    expect(total).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it('calculates per-session Qdrant operations', () => {
    const rememberQdrant = SESSION_REMEMBER * 1; // 1 upsert each
    const recallQdrant = (SESSION_RECALL + SESSION_START_RECALLS) * (1 + DEFAULT_RECALL_LIMIT);
    const reflectQdrant = SESSION_REFLECT_METADATA * 2; // 1 retrieve + 1 setPayload
    const totalQdrant = rememberQdrant + recallQdrant + reflectQdrant;

    console.log('\n  Light user — Qdrant ops/session:');
    console.log(`    remember: ${rememberQdrant} (${SESSION_REMEMBER} upserts)`);
    console.log(`    recall:   ${recallQdrant} (${SESSION_RECALL + SESSION_START_RECALLS} searches + access updates)`);
    console.log(`    reflect:  ${reflectQdrant} (${SESSION_REFLECT_METADATA} retrieve+setPayload)`);
    console.log(`    TOTAL:    ${totalQdrant} ops`);

    expect(totalQdrant).toBeGreaterThan(0);
  });

  it('calculates monthly projection at 1 session/day', () => {
    const perSessionTokens = SESSION_REMEMBER * rememberTokens
      + SESSION_RECALL * recallTokens
      + SESSION_START_RECALLS * startTokens;

    const monthlyTokens = perSessionTokens * 30;
    const monthlyCost = tokensToUSD(monthlyTokens);
    const yearlyCost = monthlyCost * 12;

    console.log('\n  Light user — monthly projection (30 days):');
    console.log(`    Tokens:  ${formatTokens(monthlyTokens)}/month`);
    console.log(`    Cost:    ${formatCost(monthlyCost)}/month`);
    console.log(`    Yearly:  ${formatCost(yearlyCost)}/year`);

    expect(monthlyCost).toBeLessThan(0.10);
  });

  it('generates structured session stats', () => {
    const rememberStats = createToolStats(
      'remember', SESSION_REMEMBER, SESSION_REMEMBER,
      SESSION_REMEMBER * rememberTokens,
      { upsert: SESSION_REMEMBER },
      tokensToUSD(SESSION_REMEMBER * rememberTokens),
    );

    const recallStats = createToolStats(
      'recall', SESSION_RECALL, SESSION_RECALL,
      SESSION_RECALL * recallTokens,
      { search: SESSION_RECALL, setPayload: SESSION_RECALL * DEFAULT_RECALL_LIMIT },
      tokensToUSD(SESSION_RECALL * recallTokens),
    );

    const startStats = createToolStats(
      'recall (session-start)', SESSION_START_RECALLS, SESSION_START_RECALLS,
      SESSION_START_RECALLS * startTokens,
      { search: SESSION_START_RECALLS, setPayload: SESSION_START_RECALLS * DEFAULT_RECALL_LIMIT },
      tokensToUSD(SESSION_START_RECALLS * startTokens),
    );

    const reflectStats = createToolStats(
      'reflect (metadata)', SESSION_REFLECT_METADATA, 0, 0,
      { retrieve: SESSION_REFLECT_METADATA, setPayload: SESSION_REFLECT_METADATA },
      0,
    );

    const session = aggregateSession('light', 'Light user: 5 remember + 10 recall, 1 session/day', [
      rememberStats, recallStats, startStats, reflectStats,
    ]);

    expect(session.totals.openaiCalls).toBe(SESSION_REMEMBER + SESSION_RECALL + SESSION_START_RECALLS);
    expect(session.totals.embeddingTokens).toBeGreaterThan(0);
    expect(session.totals.costUSD).toBeGreaterThan(0);
  });
});

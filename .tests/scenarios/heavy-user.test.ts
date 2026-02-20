import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { countTokens, tokensToUSD, formatCost, formatTokens } from '../utils/token-counter.js';
import { createToolStats, aggregateSession, type SessionStats } from '../utils/call-tracker.js';
import { generateReport } from '../utils/report-generator.js';

/**
 * Heavy user scenario:
 * - 40 remember calls per session (intensive development)
 * - 80 recall calls per session (constant context checking)
 * - 3 session-start recalls (mandatory)
 * - 10 reflect calls: 5 metadata-only + 5 with content updates
 * - 3 forget + 2 restore per session (active memory management)
 * - 1 memories stats call per session
 * - 3 sessions/day
 *
 * Also generates the final cross-tier report.
 */

const SESSION_REMEMBER = 40;
const SESSION_RECALL = 80;
const SESSION_START_RECALLS = 3;
const SESSION_REFLECT_METADATA = 5;
const SESSION_REFLECT_CONTENT = 5;
const SESSION_FORGET = 3;
const SESSION_RESTORE = 2;
const SESSION_MEMORIES_STATS = 1;
const DEFAULT_RECALL_LIMIT = 5;
const CATEGORY_COUNT = 20; // Realistic for a mature SynaBun setup

// Average content/query sizes
const AVG_REMEMBER_CHARS = 400;
const AVG_RECALL_CHARS = 70;
const AVG_SESSION_START_CHARS = 50;
const AVG_REFLECT_CONTENT_CHARS = 300;

describe('heavy user scenario (40 remember + 80 recall, 3 sessions/day)', () => {
  // Use fast estimator for heavy scenario (many calls)
  const rememberTokensPerCall = Math.ceil(AVG_REMEMBER_CHARS / 4);
  const recallTokensPerCall = Math.ceil(AVG_RECALL_CHARS / 4);
  const startTokensPerCall = Math.ceil(AVG_SESSION_START_CHARS / 4);
  const reflectTokensPerCall = Math.ceil(AVG_REFLECT_CONTENT_CHARS / 4);

  it('calculates per-session token usage', () => {
    const rememberTotal = SESSION_REMEMBER * rememberTokensPerCall;
    const recallTotal = SESSION_RECALL * recallTokensPerCall;
    const startTotal = SESSION_START_RECALLS * startTokensPerCall;
    const reflectTotal = SESSION_REFLECT_CONTENT * reflectTokensPerCall;
    const total = rememberTotal + recallTotal + startTotal + reflectTotal;
    const cost = tokensToUSD(total);

    console.log('\n  Heavy user — per session:');
    console.log(`    remember:          ${SESSION_REMEMBER} calls, ${rememberTotal} tokens`);
    console.log(`    recall:            ${SESSION_RECALL} calls, ${recallTotal} tokens`);
    console.log(`    start recalls:     ${SESSION_START_RECALLS} calls, ${startTotal} tokens`);
    console.log(`    reflect (content): ${SESSION_REFLECT_CONTENT} calls, ${reflectTotal} tokens`);
    console.log(`    reflect (meta):    ${SESSION_REFLECT_METADATA} calls, 0 tokens`);
    console.log(`    forget/restore:    ${SESSION_FORGET + SESSION_RESTORE} calls, 0 tokens`);
    console.log(`    memories stats:    ${SESSION_MEMORIES_STATS} calls, 0 tokens`);
    console.log(`    TOTAL:             ${total} tokens, ${formatCost(cost)}`);

    expect(total).toBeGreaterThan(0);
  });

  it('calculates per-session Qdrant operations', () => {
    const rememberOps = SESSION_REMEMBER * 1;
    const recallOps = (SESSION_RECALL + SESSION_START_RECALLS) * (1 + DEFAULT_RECALL_LIMIT);
    const reflectMetaOps = SESSION_REFLECT_METADATA * 2;
    const reflectContentOps = SESSION_REFLECT_CONTENT * 2;
    const forgetOps = SESSION_FORGET * 2;
    const restoreOps = SESSION_RESTORE * 2;
    // memories stats: 1 total count + CATEGORY_COUNT counts + 1 scroll(1000)
    const memoriesStatsOps = 1 + CATEGORY_COUNT + 1;
    const total = rememberOps + recallOps + reflectMetaOps + reflectContentOps + forgetOps + restoreOps + memoriesStatsOps;

    console.log('\n  Heavy user — Qdrant ops/session:');
    console.log(`    remember:  ${rememberOps}`);
    console.log(`    recall:    ${recallOps}`);
    console.log(`    reflect:   ${reflectMetaOps + reflectContentOps}`);
    console.log(`    forget:    ${forgetOps}`);
    console.log(`    restore:   ${restoreOps}`);
    console.log(`    stats:     ${memoriesStatsOps}`);
    console.log(`    TOTAL:     ${total}`);

    expect(total).toBeGreaterThan(0);
  });

  it('calculates monthly projection at 3 sessions/day', () => {
    const perSessionTokens = SESSION_REMEMBER * rememberTokensPerCall
      + SESSION_RECALL * recallTokensPerCall
      + SESSION_START_RECALLS * startTokensPerCall
      + SESSION_REFLECT_CONTENT * reflectTokensPerCall;

    const monthlyTokens = perSessionTokens * 90; // 3 sessions/day * 30 days
    const monthlyCost = tokensToUSD(monthlyTokens);
    const yearlyCost = monthlyCost * 12;

    console.log('\n  Heavy user — monthly projection (90 sessions):');
    console.log(`    Tokens:  ${formatTokens(monthlyTokens)}/month`);
    console.log(`    Cost:    ${formatCost(monthlyCost)}/month`);
    console.log(`    Yearly:  ${formatCost(yearlyCost)}/year`);

    expect(monthlyCost).toBeLessThan(5.00); // Should still be very cheap
  });
});

// --- Cross-tier report ---

describe('cross-tier cost projection report', () => {
  // Build all three tiers using the same methodology
  function buildLightSession(): SessionStats {
    const rememberTokens = countTokens('This is a typical memory about an implementation detail or bug fix.');
    const recallTokens = countTokens('architecture decisions about caching and Redis');
    const startTokens = countTokens('last conversation session about ongoing work');

    return aggregateSession('light', 'Light: 5 remember + 10 recall, 1 session/day', [
      createToolStats('remember', 5, 5, 5 * rememberTokens, { upsert: 5 }, tokensToUSD(5 * rememberTokens)),
      createToolStats('recall', 10, 10, 10 * recallTokens,
        { search: 10, setPayload: 50 }, tokensToUSD(10 * recallTokens)),
      createToolStats('recall (start)', 3, 3, 3 * startTokens,
        { search: 3, setPayload: 15 }, tokensToUSD(3 * startTokens)),
      createToolStats('reflect (meta)', 2, 0, 0, { retrieve: 2, setPayload: 2 }, 0),
    ]);
  }

  function buildMediumSession(): SessionStats {
    const rememberTokens = Math.ceil(350 / 4);
    const recallTokens = Math.ceil(70 / 4);
    const startTokens = Math.ceil(50 / 4);
    const reflectTokens = Math.ceil(300 / 4);

    return aggregateSession('medium', 'Medium: 15 remember + 30 recall, 2 sessions/day', [
      createToolStats('remember', 15, 15, 15 * rememberTokens, { upsert: 15 }, tokensToUSD(15 * rememberTokens)),
      createToolStats('recall', 30, 30, 30 * recallTokens,
        { search: 30, setPayload: 150 }, tokensToUSD(30 * recallTokens)),
      createToolStats('recall (start)', 3, 3, 3 * startTokens,
        { search: 3, setPayload: 15 }, tokensToUSD(3 * startTokens)),
      createToolStats('reflect (content)', 2, 2, 2 * reflectTokens,
        { retrieve: 2, upsert: 2 }, tokensToUSD(2 * reflectTokens)),
      createToolStats('reflect (meta)', 3, 0, 0, { retrieve: 3, setPayload: 3 }, 0),
      createToolStats('forget/restore', 2, 0, 0, { retrieve: 2, setPayload: 2 }, 0),
    ]);
  }

  function buildHeavySession(): SessionStats {
    const rememberTokens = Math.ceil(400 / 4);
    const recallTokens = Math.ceil(70 / 4);
    const startTokens = Math.ceil(50 / 4);
    const reflectTokens = Math.ceil(300 / 4);

    return aggregateSession('heavy', 'Heavy: 40 remember + 80 recall, 3 sessions/day', [
      createToolStats('remember', 40, 40, 40 * rememberTokens, { upsert: 40 }, tokensToUSD(40 * rememberTokens)),
      createToolStats('recall', 80, 80, 80 * recallTokens,
        { search: 80, setPayload: 400 }, tokensToUSD(80 * recallTokens)),
      createToolStats('recall (start)', 3, 3, 3 * startTokens,
        { search: 3, setPayload: 15 }, tokensToUSD(3 * startTokens)),
      createToolStats('reflect (content)', 5, 5, 5 * reflectTokens,
        { retrieve: 5, upsert: 5 }, tokensToUSD(5 * reflectTokens)),
      createToolStats('reflect (meta)', 5, 0, 0, { retrieve: 5, setPayload: 5 }, 0),
      createToolStats('forget/restore', 5, 0, 0, { retrieve: 5, setPayload: 5 }, 0),
      createToolStats('memories stats', 1, 0, 0, { count: 21, scroll: 1 }, 0),
    ]);
  }

  it('generates complete report', () => {
    const sessions = [buildLightSession(), buildMediumSession(), buildHeavySession()];
    const report = generateReport(sessions);
    console.log('\n' + report);

    // Verify ordering: light < medium < heavy
    expect(sessions[0].totals.costUSD).toBeLessThan(sessions[1].totals.costUSD);
    expect(sessions[1].totals.costUSD).toBeLessThan(sessions[2].totals.costUSD);
  });

  afterAll(() => {
    const sessions = [buildLightSession(), buildMediumSession(), buildHeavySession()];
    const report = generateReport(sessions);

    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const reportsDir = join(thisDir, '..', 'reports');
      if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
      writeFileSync(join(reportsDir, 'latest.txt'), report + '\n');
    } catch {
      // Non-fatal — test still passes even if file write fails
    }
  });
});

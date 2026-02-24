import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  CLAUDE_MODELS, MODEL_IDS, claudeTokenCost, c2t,
  recallResponseChars, recallRequestChars, rememberRequestChars,
  REMEMBER_RESPONSE, REFLECT_RESPONSE, FORGET_RESPONSE, RESTORE_RESPONSE,
  MEMORIES_STATS_RESPONSE, REFLECT_REQUEST, FORGET_REQUEST, RESTORE_REQUEST,
  MEMORIES_REQUEST,
  buildSessionCost, formatClaudeCostReport,
  type SessionClaudeCost, type ClaudeModelId,
} from '../utils/claude-cost.js';

/**
 * Claude API token cost analysis for SynaBun MCP tool usage.
 *
 * Models both directions of the MCP tool round-trip:
 *   tool_use  (Claude output tokens) → request JSON sent to SynaBun
 *   tool_result (Claude input tokens) ← response text from SynaBun
 *
 * Tests across:
 *   - 3 Claude models: Opus 4.6, Sonnet 4.6, Haiku 4.5
 *   - 4 recallMaxChars settings: 0 (unlimited), 500, 200, 100
 *   - 3 usage tiers: light, medium, heavy
 */

// ── Usage tier definitions ──────────────────────────────────────────────────

interface TierConfig {
  label: string;
  sessionsPerMonth: number;
  remember: number;
  recall: number;
  sessionStartRecalls: number;
  reflectMeta: number;
  reflectContent: number;
  forget: number;
  restore: number;
  memoriesStats: number;
  avgRememberContentChars: number;
  avgRecallQueryChars: number;
  avgStartQueryChars: number;
}

const TIERS: TierConfig[] = [
  {
    label: 'Light (1 session/day)',
    sessionsPerMonth: 30,
    remember: 5, recall: 10, sessionStartRecalls: 3,
    reflectMeta: 2, reflectContent: 0,
    forget: 0, restore: 0, memoriesStats: 0,
    avgRememberContentChars: 250,
    avgRecallQueryChars: 50,
    avgStartQueryChars: 40,
  },
  {
    label: 'Medium (2 sessions/day)',
    sessionsPerMonth: 60,
    remember: 15, recall: 30, sessionStartRecalls: 3,
    reflectMeta: 3, reflectContent: 2,
    forget: 1, restore: 1, memoriesStats: 0,
    avgRememberContentChars: 350,
    avgRecallQueryChars: 60,
    avgStartQueryChars: 45,
  },
  {
    label: 'Heavy (3 sessions/day)',
    sessionsPerMonth: 90,
    remember: 40, recall: 80, sessionStartRecalls: 3,
    reflectMeta: 5, reflectContent: 5,
    forget: 3, restore: 2, memoriesStats: 1,
    avgRememberContentChars: 400,
    avgRecallQueryChars: 70,
    avgStartQueryChars: 50,
  },
];

const RECALL_LIMIT = 5; // default results per recall call
const RECALL_MAX_CHARS_SETTINGS = [0, 500, 200, 100];

// ── Helper: build a session cost for a tier × recallMaxChars ────────────────

function buildTierSession(tier: TierConfig, recallMaxChars: number): SessionClaudeCost {
  const recallRespPerCall = recallResponseChars(RECALL_LIMIT, recallMaxChars);
  const recallReqPerCall = recallRequestChars(tier.avgRecallQueryChars);
  const startRespPerCall = recallResponseChars(RECALL_LIMIT, recallMaxChars);
  const startReqPerCall = recallRequestChars(tier.avgStartQueryChars);

  const tools = [
    {
      tool: 'remember',
      calls: tier.remember,
      responseCharsPerCall: REMEMBER_RESPONSE,
      requestCharsPerCall: rememberRequestChars(tier.avgRememberContentChars),
    },
    {
      tool: 'recall',
      calls: tier.recall,
      responseCharsPerCall: recallRespPerCall,
      requestCharsPerCall: recallReqPerCall,
    },
    {
      tool: 'recall (session-start)',
      calls: tier.sessionStartRecalls,
      responseCharsPerCall: startRespPerCall,
      requestCharsPerCall: startReqPerCall,
    },
  ];

  if (tier.reflectContent > 0) {
    tools.push({
      tool: 'reflect (content)',
      calls: tier.reflectContent,
      responseCharsPerCall: REFLECT_RESPONSE,
      requestCharsPerCall: REFLECT_REQUEST + 200, // content update ~200 extra chars
    });
  }

  if (tier.reflectMeta > 0) {
    tools.push({
      tool: 'reflect (metadata)',
      calls: tier.reflectMeta,
      responseCharsPerCall: REFLECT_RESPONSE,
      requestCharsPerCall: REFLECT_REQUEST,
    });
  }

  if (tier.forget > 0) {
    tools.push({
      tool: 'forget',
      calls: tier.forget,
      responseCharsPerCall: FORGET_RESPONSE,
      requestCharsPerCall: FORGET_REQUEST,
    });
  }

  if (tier.restore > 0) {
    tools.push({
      tool: 'restore',
      calls: tier.restore,
      responseCharsPerCall: RESTORE_RESPONSE,
      requestCharsPerCall: RESTORE_REQUEST,
    });
  }

  if (tier.memoriesStats > 0) {
    tools.push({
      tool: 'memories (stats)',
      calls: tier.memoriesStats,
      responseCharsPerCall: MEMORIES_STATS_RESPONSE,
      requestCharsPerCall: MEMORIES_REQUEST,
    });
  }

  return buildSessionCost(tier.label, tier.sessionsPerMonth, recallMaxChars, tools);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Claude API pricing constants', () => {
  it('has correct pricing for current models', () => {
    expect(CLAUDE_MODELS['opus-4.6'].input).toBe(5);
    expect(CLAUDE_MODELS['opus-4.6'].output).toBe(25);
    expect(CLAUDE_MODELS['sonnet-4.6'].input).toBe(3);
    expect(CLAUDE_MODELS['sonnet-4.6'].output).toBe(15);
    expect(CLAUDE_MODELS['haiku-4.5'].input).toBe(1);
    expect(CLAUDE_MODELS['haiku-4.5'].output).toBe(5);
  });

  it('calculates cost correctly', () => {
    // 1M input + 1M output on Opus 4.6 = $5 + $25 = $30
    expect(claudeTokenCost('opus-4.6', 1_000_000, 1_000_000)).toBe(30);
    // 1K input + 1K output on Haiku 4.5 = $0.001 + $0.005 = $0.006
    expect(claudeTokenCost('haiku-4.5', 1_000, 1_000)).toBeCloseTo(0.006, 6);
  });
});

describe('recall response scaling with recallMaxChars', () => {
  it('unlimited (0) produces the largest responses', () => {
    const unlimited = recallResponseChars(5, 0);
    const capped200 = recallResponseChars(5, 200);
    const capped100 = recallResponseChars(5, 100);

    expect(unlimited).toBeGreaterThan(capped200);
    expect(capped200).toBeGreaterThan(capped100);

    console.log('\n  Recall response size (5 results) by recallMaxChars:');
    for (const maxChars of [0, 500, 200, 100]) {
      const chars = recallResponseChars(5, maxChars);
      const tokens = c2t(chars);
      const label = maxChars === 0 ? 'unlimited' : `${maxChars}`;
      console.log(`    recallMaxChars=${label.padEnd(10)} → ${chars} chars → ~${tokens} tokens`);
    }
  });

  it('scales linearly with result count', () => {
    const r1 = recallResponseChars(1, 0);
    const r5 = recallResponseChars(5, 0);
    const r10 = recallResponseChars(10, 0);

    // Should be roughly linear (within 10% of 5× and 10×)
    expect(r5 / r1).toBeGreaterThan(3.5);
    expect(r10 / r5).toBeGreaterThan(1.8);

    console.log('\n  Recall response scaling by result count (unlimited):');
    for (const n of [1, 3, 5, 10]) {
      const chars = recallResponseChars(n, 0);
      console.log(`    ${n} results → ${chars} chars → ~${c2t(chars)} tokens`);
    }
  });
});

describe('per-session Claude cost by recallMaxChars', () => {
  for (const maxChars of RECALL_MAX_CHARS_SETTINGS) {
    const label = maxChars === 0 ? 'unlimited' : `${maxChars}`;

    it(`recallMaxChars=${label}: cost scales light < medium < heavy`, () => {
      const costs = TIERS.map(t => buildTierSession(t, maxChars));

      // light < medium < heavy across all models
      for (const model of MODEL_IDS) {
        expect(costs[0].monthlyCost[model]).toBeLessThan(costs[1].monthlyCost[model]);
        expect(costs[1].monthlyCost[model]).toBeLessThan(costs[2].monthlyCost[model]);
      }
    });
  }

  it('lower recallMaxChars reduces cost for heavy tier on Opus', () => {
    const unlimited = buildTierSession(TIERS[2], 0);
    const capped200 = buildTierSession(TIERS[2], 200);
    const capped100 = buildTierSession(TIERS[2], 100);

    expect(capped200.monthlyCost['opus-4.6']).toBeLessThan(unlimited.monthlyCost['opus-4.6']);
    expect(capped100.monthlyCost['opus-4.6']).toBeLessThan(capped200.monthlyCost['opus-4.6']);

    const savings200 = (1 - capped200.monthlyCost['opus-4.6'] / unlimited.monthlyCost['opus-4.6']) * 100;
    const savings100 = (1 - capped100.monthlyCost['opus-4.6'] / unlimited.monthlyCost['opus-4.6']) * 100;

    console.log('\n  Savings from recallMaxChars (Heavy tier, Opus 4.6):');
    console.log(`    200 chars → ${savings200.toFixed(1)}% cheaper than unlimited`);
    console.log(`    100 chars → ${savings100.toFixed(1)}% cheaper than unlimited`);
  });
});

describe('monthly cost projections across all dimensions', () => {
  const allSessions: SessionClaudeCost[] = [];

  for (const maxChars of RECALL_MAX_CHARS_SETTINGS) {
    for (const tier of TIERS) {
      allSessions.push(buildTierSession(tier, maxChars));
    }
  }

  it('prints full cross-dimensional cost matrix', () => {
    console.log('\n  MONTHLY CLAUDE API COST MATRIX (all tiers × models × recallMaxChars)');
    console.log('  ' + '='.repeat(95));

    for (const maxChars of RECALL_MAX_CHARS_SETTINGS) {
      const label = maxChars === 0 ? 'unlimited' : `${maxChars}`;
      console.log(`\n  recallMaxChars = ${label}`);
      console.log(
        `  ${'Tier'.padEnd(28)} | `
        + `${'In tok/sess'.padStart(11)} | ${'Out tok/sess'.padStart(12)} | `
        + `${'Opus /mo'.padStart(12)} | ${'Sonnet /mo'.padStart(12)} | ${'Haiku /mo'.padStart(12)}`
      );
      console.log('  ' + '-'.repeat(93));

      const group = allSessions.filter(s => s.recallMaxChars === maxChars);
      for (const s of group) {
        const fmt = (v: number) => v < 0.01 ? `$${v.toFixed(6)}` : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
        console.log(
          `  ${s.tier.padEnd(28)} | `
          + `${String(s.totals.inputTokens).padStart(11)} | ${String(s.totals.outputTokens).padStart(12)} | `
          + `${fmt(s.monthlyCost['opus-4.6']).padStart(12)} | `
          + `${fmt(s.monthlyCost['sonnet-4.6']).padStart(12)} | `
          + `${fmt(s.monthlyCost['haiku-4.5']).padStart(12)}`
        );
      }
    }
    console.log('  ' + '='.repeat(95));

    // Verify all costs are bounded (under $50/mo even worst case)
    for (const s of allSessions) {
      for (const model of MODEL_IDS) {
        expect(s.monthlyCost[model]).toBeLessThan(50);
      }
    }
  });

  it('heaviest case (unlimited, heavy, Opus) shows real cost', () => {
    const worst = allSessions.find(
      s => s.recallMaxChars === 0 && s.tier.startsWith('Heavy'),
    )!;
    const cost = worst.monthlyCost['opus-4.6'];

    console.log(`\n  Worst case (heavy + unlimited + Opus 4.6): $${cost.toFixed(2)}/month, $${(cost * 12).toFixed(2)}/year`);
    // Heavy user on most expensive model — still under $50/mo
    expect(cost).toBeLessThan(50);
    expect(cost).toBeGreaterThan(10); // It's non-trivial
  });

  it('lightest case (100 chars, light, Haiku) is cheap', () => {
    const best = allSessions.find(
      s => s.recallMaxChars === 100 && s.tier.startsWith('Light'),
    )!;
    const cost = best.monthlyCost['haiku-4.5'];

    console.log(`\n  Best case (light + 100 chars + Haiku 4.5): $${cost.toFixed(4)}/month, $${(cost * 12).toFixed(2)}/year`);
    expect(cost).toBeLessThan(1); // Under $1/mo
  });
});

describe('combined cost: embedding + Claude API', () => {
  // Embedding costs from the existing tests (OpenAI text-embedding-3-small)
  const EMBEDDING_YEARLY = { light: 0.001, medium: 0.03, heavy: 0.13 };

  it('shows embedding cost is negligible vs Claude API cost', () => {
    console.log('\n  COMBINED YEARLY COST: Embedding + Claude API (recallMaxChars=0, Opus 4.6)');
    console.log('  ' + '-'.repeat(75));
    console.log(
      `  ${'Tier'.padEnd(28)} | ${'Embedding/yr'.padStart(12)} | `
      + `${'Claude/yr'.padStart(12)} | ${'Total/yr'.padStart(12)} | ${'Embed %'.padStart(10)}`
    );
    console.log('  ' + '-'.repeat(75));

    for (const tier of TIERS) {
      const session = buildTierSession(tier, 0);
      const claudeYearly = session.yearlyCost['opus-4.6'];
      const tierKey = tier.label.split(' ')[0].toLowerCase() as keyof typeof EMBEDDING_YEARLY;
      const embedYearly = EMBEDDING_YEARLY[tierKey];
      const total = embedYearly + claudeYearly;
      const embedPct = (embedYearly / total * 100).toFixed(2);

      const fmt = (v: number) => v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

      console.log(
        `  ${tier.label.padEnd(28)} | ${fmt(embedYearly).padStart(12)} | `
        + `${fmt(claudeYearly).padStart(12)} | ${fmt(total).padStart(12)} | ${(embedPct + '%').padStart(10)}`
      );

      // Embedding should be < 5% of total
      expect(parseFloat(embedPct)).toBeLessThan(5);
    }
    console.log('  ' + '-'.repeat(75));
    console.log('  → Embedding cost is < 5% of total — Claude API tokens dominate.');
  });
});

// ── Write full report to file ───────────────────────────────────────────────

afterAll(() => {
  const allSessions: SessionClaudeCost[] = [];
  for (const maxChars of RECALL_MAX_CHARS_SETTINGS) {
    for (const tier of TIERS) {
      allSessions.push(buildTierSession(tier, maxChars));
    }
  }

  const report = formatClaudeCostReport(allSessions);

  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const reportsDir = join(thisDir, '..', 'reports');
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, 'claude-cost.txt'), report + '\n');
  } catch {
    // Non-fatal
  }
});

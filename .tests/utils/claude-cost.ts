/**
 * Claude API token cost estimator for SynaBun MCP tool interactions.
 *
 * Models both directions of the tool-call round-trip:
 *   - Input tokens: tool_result text (Claude reads SynaBun responses)
 *   - Output tokens: tool_use JSON (Claude generates to call SynaBun)
 *
 * Pricing source: https://platform.claude.com/docs/en/about-claude/pricing
 */

// ---------------------------------------------------------------------------
// Claude model pricing (per million tokens, USD)
// ---------------------------------------------------------------------------

export const CLAUDE_MODELS = {
  'opus-4.6':   { input: 5,  output: 25, label: 'Opus 4.6' },
  'sonnet-4.6': { input: 3,  output: 15, label: 'Sonnet 4.6' },
  'haiku-4.5':  { input: 1,  output: 5,  label: 'Haiku 4.5' },
} as const;

export type ClaudeModelId = keyof typeof CLAUDE_MODELS;
export const MODEL_IDS = Object.keys(CLAUDE_MODELS) as ClaudeModelId[];

export function claudeTokenCost(
  model: ClaudeModelId,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = CLAUDE_MODELS[model];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Memory content distribution model
// ---------------------------------------------------------------------------

/**
 * Realistic memory content lengths:
 *   30% short  (~80 chars)  — "Fixed typo in component prop"
 *   40% medium (~250 chars) — paragraph about a pattern or decision
 *   30% long   (~600 chars) — architectural decision record
 */
function avgContentChars(recallMaxChars: number): number {
  const short = 80, medium = 250, long = 600;
  const cap = (v: number) => recallMaxChars > 0 ? Math.min(v, recallMaxChars) : v;
  return Math.round(0.3 * cap(short) + 0.4 * cap(medium) + 0.3 * cap(long));
}

// ---------------------------------------------------------------------------
// Tool RESPONSE size estimators (→ Claude input tokens)
// ---------------------------------------------------------------------------

// recall: header + N × (metadata overhead + content)
const RECALL_HEADER = 45;       // 'Found N memories for "query":\n\n'
const RECALL_RESULT_META = 155; // UUID, score, importance, age, category, project, tags, files

export function recallResponseChars(results: number, recallMaxChars: number): number {
  return RECALL_HEADER + results * (RECALL_RESULT_META + avgContentChars(recallMaxChars));
}

// Fixed-size responses
export const REMEMBER_RESPONSE  = 150; // 'Remembered [uuid] (cat/proj, imp: N): "preview..."'
export const REFLECT_RESPONSE   = 100; // 'Updated [uuid]: change1, change2'
export const FORGET_RESPONSE    = 180; // 'Moved to trash [uuid]: "preview..." — can be restored…'
export const RESTORE_RESPONSE   = 100; // 'Restored [uuid]: "preview..."'
export const MEMORIES_STATS_RESPONSE = 500; // stats block with category/project counts

// ---------------------------------------------------------------------------
// Tool REQUEST size estimators (→ Claude output tokens)
// ---------------------------------------------------------------------------

/** remember: { content, category, project, source, related_files } */
export function rememberRequestChars(contentChars: number): number {
  return 120 + contentChars; // JSON overhead + content value
}

/** recall: { query, category?, project?, limit? } */
export function recallRequestChars(queryChars: number): number {
  return 80 + queryChars;
}

export const REFLECT_REQUEST  = 120; // UUID + optional fields
export const FORGET_REQUEST   = 80;  // UUID only
export const RESTORE_REQUEST  = 80;
export const MEMORIES_REQUEST = 50;  // { action: "stats" }

// ---------------------------------------------------------------------------
// Char → token conversion (same cl100k_base ~4 chars/token heuristic)
// ---------------------------------------------------------------------------

export function c2t(chars: number): number {
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Session-level aggregation
// ---------------------------------------------------------------------------

export interface ToolRoundTrip {
  tool: string;
  calls: number;
  /** total chars of all tool_result responses (Claude input) */
  responseChars: number;
  /** total chars of all tool_use requests (Claude output) */
  requestChars: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SessionClaudeCost {
  recallMaxChars: number;
  tier: string;
  sessionsPerMonth: number;
  tools: ToolRoundTrip[];
  totals: {
    inputTokens: number;
    outputTokens: number;
  };
  monthlyCost: Record<ClaudeModelId, number>;
  yearlyCost: Record<ClaudeModelId, number>;
}

export function buildSessionCost(
  tier: string,
  sessionsPerMonth: number,
  recallMaxChars: number,
  toolDefs: Array<{
    tool: string;
    calls: number;
    responseCharsPerCall: number;
    requestCharsPerCall: number;
  }>,
): SessionClaudeCost {
  const tools: ToolRoundTrip[] = toolDefs.map(d => ({
    tool: d.tool,
    calls: d.calls,
    responseChars: d.calls * d.responseCharsPerCall,
    requestChars: d.calls * d.requestCharsPerCall,
    inputTokens: c2t(d.calls * d.responseCharsPerCall),
    outputTokens: c2t(d.calls * d.requestCharsPerCall),
  }));

  const totals = {
    inputTokens: tools.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: tools.reduce((s, t) => s + t.outputTokens, 0),
  };

  const monthlyCost = {} as Record<ClaudeModelId, number>;
  const yearlyCost = {} as Record<ClaudeModelId, number>;
  for (const id of MODEL_IDS) {
    monthlyCost[id] = claudeTokenCost(id, totals.inputTokens * sessionsPerMonth, totals.outputTokens * sessionsPerMonth);
    yearlyCost[id] = monthlyCost[id] * 12;
  }

  return { recallMaxChars, tier, sessionsPerMonth, tools, totals, monthlyCost, yearlyCost };
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

export function formatClaudeCostReport(sessions: SessionClaudeCost[]): string {
  const lines: string[] = [
    '='.repeat(100),
    '  CLAUDE API TOKEN COST — SYNABUN MCP TOOL USAGE',
    '  Pricing: Opus 4.6 ($5/$25), Sonnet 4.6 ($3/$15), Haiku 4.5 ($1/$5) per MTok',
    '='.repeat(100),
    '',
  ];

  // Group by recallMaxChars
  const grouped = new Map<number, SessionClaudeCost[]>();
  for (const s of sessions) {
    const key = s.recallMaxChars;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  for (const [maxChars, group] of grouped) {
    const label = maxChars === 0 ? 'UNLIMITED (default)' : `${maxChars} chars`;
    lines.push(`  recallMaxChars = ${label}`);
    lines.push('-'.repeat(100));

    // Per-tool breakdown for first tier as example
    const example = group[0];
    lines.push(`  Per-session tool breakdown (${example.tier}):`);
    lines.push(
      `  ${'Tool'.padEnd(25)} | ${'Calls'.padStart(5)} | `
      + `${'Resp chars'.padStart(10)} | ${'Req chars'.padStart(10)} | `
      + `${'In tokens'.padStart(9)} | ${'Out tokens'.padStart(10)}`
    );
    lines.push('  ' + '-'.repeat(80));

    for (const t of example.tools) {
      lines.push(
        `  ${t.tool.padEnd(25)} | ${String(t.calls).padStart(5)} | `
        + `${String(t.responseChars).padStart(10)} | ${String(t.requestChars).padStart(10)} | `
        + `${String(t.inputTokens).padStart(9)} | ${String(t.outputTokens).padStart(10)}`
      );
    }

    lines.push('  ' + '-'.repeat(80));
    lines.push(
      `  ${'SESSION TOTAL'.padEnd(25)} | ${''.padStart(5)} | `
      + `${''.padStart(10)} | ${''.padStart(10)} | `
      + `${String(example.totals.inputTokens).padStart(9)} | ${String(example.totals.outputTokens).padStart(10)}`
    );
    lines.push('');

    // Monthly cost matrix: tier × model
    lines.push(`  Monthly cost by tier and model:`);
    lines.push(
      `  ${'Tier'.padEnd(35)} | ${'Sessions/mo'.padStart(11)} | `
      + `${'Opus 4.6'.padStart(12)} | ${'Sonnet 4.6'.padStart(12)} | ${'Haiku 4.5'.padStart(12)}`
    );
    lines.push('  ' + '-'.repeat(90));

    for (const s of group) {
      const fmt = (v: number) => v < 0.01 ? `$${v.toFixed(6)}` : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
      lines.push(
        `  ${s.tier.padEnd(35)} | ${String(s.sessionsPerMonth).padStart(11)} | `
        + `${fmt(s.monthlyCost['opus-4.6']).padStart(12)} | `
        + `${fmt(s.monthlyCost['sonnet-4.6']).padStart(12)} | `
        + `${fmt(s.monthlyCost['haiku-4.5']).padStart(12)}`
      );
    }

    // Yearly totals
    lines.push('');
    lines.push(`  Yearly cost:`);
    lines.push(
      `  ${'Tier'.padEnd(35)} | ${''.padStart(11)} | `
      + `${'Opus 4.6'.padStart(12)} | ${'Sonnet 4.6'.padStart(12)} | ${'Haiku 4.5'.padStart(12)}`
    );
    lines.push('  ' + '-'.repeat(90));

    for (const s of group) {
      const fmt = (v: number) => v < 0.01 ? `$${v.toFixed(6)}` : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
      lines.push(
        `  ${s.tier.padEnd(35)} | ${''.padStart(11)} | `
        + `${fmt(s.yearlyCost['opus-4.6']).padStart(12)} | `
        + `${fmt(s.yearlyCost['sonnet-4.6']).padStart(12)} | `
        + `${fmt(s.yearlyCost['haiku-4.5']).padStart(12)}`
      );
    }

    lines.push('');
    lines.push('');
  }

  // Comparison: effect of recallMaxChars across settings
  lines.push('='.repeat(100));
  lines.push('  IMPACT OF recallMaxChars ON MONTHLY COST (Heavy tier, Opus 4.6)');
  lines.push('-'.repeat(100));
  lines.push(
    `  ${'recallMaxChars'.padEnd(20)} | ${'Avg content/result'.padStart(18)} | `
    + `${'Input tok/session'.padStart(17)} | ${'Monthly cost'.padStart(14)} | ${'Savings vs unlimited'.padStart(20)}`
  );
  lines.push('  ' + '-'.repeat(94));

  const heavySessions = sessions.filter(s => s.tier.startsWith('Heavy'));
  const unlimited = heavySessions.find(s => s.recallMaxChars === 0);

  for (const s of heavySessions) {
    const label = s.recallMaxChars === 0 ? '0 (unlimited)' : String(s.recallMaxChars);
    const avgChars = String(avgContentChars(s.recallMaxChars));
    const savings = unlimited && s !== unlimited
      ? `-${((1 - s.monthlyCost['opus-4.6'] / unlimited.monthlyCost['opus-4.6']) * 100).toFixed(1)}%`
      : '—';
    const fmt = (v: number) => v < 0.01 ? `$${v.toFixed(6)}` : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

    lines.push(
      `  ${label.padEnd(20)} | ${avgChars.padStart(18)} | `
      + `${String(s.totals.inputTokens).padStart(17)} | `
      + `${fmt(s.monthlyCost['opus-4.6']).padStart(14)} | ${savings.padStart(20)}`
    );
  }

  lines.push('='.repeat(100));
  return lines.join('\n');
}

import type { SessionStats } from './call-tracker.js';
import { formatCost, formatTokens } from './token-counter.js';

export function generateReport(sessions: SessionStats[]): string {
  const lines: string[] = [
    '='.repeat(80),
    '  SYNABUN TOKEN USAGE & COST PROJECTION REPORT',
    '  Model: text-embedding-3-small | Price: $0.02 / 1M tokens',
    '='.repeat(80),
    '',
  ];

  for (const session of sessions) {
    lines.push(`SESSION: ${session.sessionId}`);
    lines.push(`  ${session.description}`);
    lines.push('-'.repeat(80));
    lines.push(
      `  ${'Tool'.padEnd(25)} | ${'Calls'.padStart(5)} | ${'OpenAI'.padStart(6)} | `
      + `${'Tokens'.padStart(8)} | ${'Qdrant'.padStart(6)} | ${'Cost'.padStart(12)}`
    );
    lines.push('  ' + '-'.repeat(76));

    for (const inv of session.invocations) {
      lines.push(
        `  ${inv.tool.padEnd(25)} | ${String(inv.callCount).padStart(5)} | `
        + `${String(inv.openaiEmbeddingCalls).padStart(6)} | `
        + `${formatTokens(inv.totalEmbeddingTokens).padStart(8)} | `
        + `${String(inv.totalQdrantOps).padStart(6)} | `
        + `${formatCost(inv.estimatedCostUSD).padStart(12)}`
      );
    }

    lines.push('  ' + '-'.repeat(76));
    lines.push(
      `  ${'TOTALS'.padEnd(25)} | ${''.padStart(5)} | `
      + `${String(session.totals.openaiCalls).padStart(6)} | `
      + `${formatTokens(session.totals.embeddingTokens).padStart(8)} | `
      + `${String(session.totals.qdrantOps).padStart(6)} | `
      + `${formatCost(session.totals.costUSD).padStart(12)}`
    );
    lines.push('');
  }

  // Monthly projection
  lines.push('='.repeat(80));
  lines.push('  MONTHLY COST PROJECTIONS');
  lines.push('-'.repeat(80));
  lines.push(
    `  ${'Tier'.padEnd(40)} | ${'Tokens/mo'.padStart(12)} | ${'Cost/mo'.padStart(12)} | ${'Cost/yr'.padStart(12)}`
  );
  lines.push('  ' + '-'.repeat(76));

  const tiers = [
    { label: 'Light (1 session/day)', id: 'light', multiplier: 30 },
    { label: 'Medium (2 sessions/day)', id: 'medium', multiplier: 60 },
    { label: 'Heavy (3 sessions/day)', id: 'heavy', multiplier: 90 },
  ];

  for (const tier of tiers) {
    const session = sessions.find(s => s.sessionId === tier.id);
    if (!session) continue;
    const monthlyTokens = session.totals.embeddingTokens * tier.multiplier;
    const monthlyCost = session.totals.costUSD * tier.multiplier;
    const yearlyCost = monthlyCost * 12;
    lines.push(
      `  ${tier.label.padEnd(40)} | ${formatTokens(monthlyTokens).padStart(12)} | `
      + `${formatCost(monthlyCost).padStart(12)} | ${formatCost(yearlyCost).padStart(12)}`
    );
  }

  lines.push('='.repeat(80));
  return lines.join('\n');
}

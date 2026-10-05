/**
 * Replay stored memories through both the old heuristic and the TypeSafe
 * judgment, and report where they disagree.
 *
 * Nothing here writes to memories or relations. The point is to look at the
 * disagreements BEFORE trusting a surface, because "the regex is wrong" is not
 * the same claim as "the model is better on my data". Shared by the CLI
 * (`scripts/bench-typesafe.mjs`) and `POST /api/typesafe/bench`, so both
 * produce the same JSON and the same `benchRunAt` gate for applying judged
 * importance.
 */

import { getDb } from './sqlite.js';
import { projectAliases } from '../config.js';
import { judgeMemory, judgeRelations, judgeHistoricalQuery } from './memory-judgments.js';
import { heuristicKind } from './memory-maintenance.js';
import type { JudgeUsage } from './typesafe.js';
import { typesafeConfig, mutateTypeSafeConfig, type BenchSummary } from './typesafe-config.js';

export type BenchSurface = 'importance' | 'kind' | 'relation' | 'historical';
export const BENCH_SURFACES: BenchSurface[] = ['importance', 'kind', 'relation', 'historical'];

export interface BenchDisagreement {
  id: string;
  stored: string | number | boolean | null;
  judged: string | number | boolean | null;
  confidence: number | null;
  category?: string;
  note?: string;
}

export interface BenchAgreement {
  kind?: { agree: number; of: number; rate: number };
  importance?: { meanAbsDelta: number; within1: number; within2: number; of: number; rate: number };
  relation?: { agree: number; of: number; rate: number };
  historical?: { agree: number; of: number; rate: number };
}

export interface BenchReport {
  surface: BenchSurface;
  at: string;
  project: string | null;
  limit: number;
  sample: 'random' | 'recent';
  n: number;
  judged: number;
  unavailable: number;
  agreement: BenchAgreement;
  /** The headline number for the surface asked for, 0..1, or null when nothing was judged. */
  rate: number | null;
  disagreements: BenchDisagreement[];
  tokens: { input: number; output: number; avgInputPerItem: number };
  latency: { avgMs: number; totalMs: number };
  cost: number | null;
}

export interface BenchOptions {
  limit?: number;
  project?: string;
  sample?: 'random' | 'recent';
  onProgress?: (done: number, total: number) => void;
}

const rate = (agree: number, of: number) => of ? agree / of : 0;

function usageTracker() {
  const totals = { input: 0, output: 0, totalMs: 0, answered: 0 };
  const onUsage = (u: JudgeUsage) => { totals.input += u.inputTokens; totals.output += u.outputTokens; totals.totalMs += u.latencyMs; if (!u.cached) totals.answered++; };
  return { totals, onUsage };
}

function finish(report: Omit<BenchReport, 'tokens' | 'latency' | 'cost' | 'rate' | 'at'>, totals: { input: number; output: number; totalMs: number; answered: number }): BenchReport {
  const cfg = typesafeConfig();
  const items = Math.max(1, report.judged);
  const cost = cfg.costPerMillionInput > 0 || cfg.costPerMillionOutput > 0
    ? totals.input / 1e6 * cfg.costPerMillionInput + totals.output / 1e6 * cfg.costPerMillionOutput
    : null;
  const headline = report.surface === 'kind' ? report.agreement.kind?.rate
    : report.surface === 'importance' ? report.agreement.importance?.rate
    : report.surface === 'relation' ? report.agreement.relation?.rate
    : report.agreement.historical?.rate;
  return {
    ...report,
    at: new Date().toISOString(),
    rate: report.judged ? headline ?? null : null,
    tokens: { input: totals.input, output: totals.output, avgInputPerItem: Math.round(totals.input / items) },
    latency: { avgMs: totals.answered ? Math.round(totals.totalMs / totals.answered) : 0, totalMs: totals.totalMs },
    cost,
  };
}

function projectFilter(project?: string): { where: string; params: string[] } {
  if (!project) return { where: '', params: [] };
  const aliases = projectAliases(project).map(p => p.toLowerCase());
  return { where: `AND lower(m.project) IN (${aliases.map(() => '?').join(',')})`, params: aliases };
}

/**
 * Importance and kind come from one request per memory (two questions over
 * one state), so one pass reports both. `surface` only picks the headline.
 */
export async function benchImportanceKind(surface: 'importance' | 'kind', options: BenchOptions = {}): Promise<BenchReport> {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const sample = options.sample ?? 'random';
  const { where, params } = projectFilter(options.project);
  const rows = getDb().prepare(`SELECT m.id, m.content, m.category, m.project, m.importance FROM memories m
    WHERE m.trashed_at IS NULL ${where} ORDER BY ${sample === 'recent' ? 'm.updated_at DESC' : 'random()'} LIMIT ?`).all(...params, limit);
  const { totals, onUsage } = usageTracker();
  const deltas: number[] = [];
  let kindAgree = 0, kindJudged = 0, judged = 0, unavailable = 0;
  const disagreements: BenchDisagreement[] = [];
  for (const [i, row] of rows.entries()) {
    const verdict = await judgeMemory(String(row.content), { category: String(row.category), project: String(row.project) }, { origin: 'bench', noCache: true, entityId: String(row.id), onUsage });
    options.onProgress?.(i + 1, rows.length);
    if (!verdict) { unavailable++; continue; }
    judged++;
    const stored = Number(row.importance);
    if (verdict.importance != null) {
      const delta = verdict.importance - stored;
      deltas.push(Math.abs(delta));
      if (Math.abs(delta) >= 2 && surface === 'importance') disagreements.push({ id: String(row.id), stored, judged: Number(verdict.importance.toFixed(1)), confidence: verdict.importanceConfidence, category: String(row.category) });
    }
    if (verdict.kind) {
      kindJudged++;
      const old = heuristicKind(String(row.category));
      if (old === verdict.kind) kindAgree++;
      else if (surface === 'kind') disagreements.push({ id: String(row.id), stored: old, judged: verdict.kind, confidence: verdict.kindConfidence, category: String(row.category) });
    }
  }
  const agreement: BenchAgreement = {};
  if (deltas.length) {
    const within1 = deltas.filter(d => d <= 1).length, within2 = deltas.filter(d => d <= 2).length;
    agreement.importance = { meanAbsDelta: Number((deltas.reduce((a, b) => a + b, 0) / deltas.length).toFixed(2)), within1, within2, of: deltas.length, rate: rate(within2, deltas.length) };
  }
  if (kindJudged) agreement.kind = { agree: kindAgree, of: kindJudged, rate: rate(kindAgree, kindJudged) };
  return finish({ surface, project: options.project ?? null, limit, sample, n: rows.length, judged, unavailable, agreement, disagreements }, totals);
}

/** Pairs the old rule already labelled: same project+category, related automatically. */
export async function benchRelations(options: BenchOptions = {}): Promise<BenchReport> {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
  const sample = options.sample ?? 'random';
  const { where, params } = projectFilter(options.project);
  const pairs = getDb().prepare(`SELECT r.from_id, r.to_id, r.kind,
      a.content AS a_content, b.content AS b_content, a.created_at AS a_at, b.created_at AS b_at
    FROM memory_relations r JOIN memories a ON a.id = r.from_id JOIN memories b ON b.id = r.to_id JOIN memories m ON m.id = r.from_id
    WHERE r.automatic = 1 AND r.active = 1 AND r.kind IN ('similar','possible_conflict') AND a.trashed_at IS NULL AND b.trashed_at IS NULL ${where}
    ORDER BY ${sample === 'recent' ? 'r.created_at DESC' : 'random()'} LIMIT ?`).all(...params, limit);
  const { totals, onUsage } = usageTracker();
  const negative = (s: string) => /\b(not|never|cannot|no longer|não|nunca)\b/i.test(s);
  let agree = 0, judged = 0, unavailable = 0;
  const disagreements: BenchDisagreement[] = [];
  for (const [i, pair] of pairs.entries()) {
    const verdicts = await judgeRelations(
      { content: String(pair.a_content), recordedAt: String(pair.a_at) },
      [{ id: String(pair.to_id), content: String(pair.b_content), recordedAt: String(pair.b_at) }],
      // Supersession rides along so its bar can be read against real pairs
      // before anyone trusts it; it is noted beside each disagreement, never scored.
      { origin: 'bench', noCache: true, entityId: String(pair.from_id), onUsage, sessionId: null, askSupersession: true },
    );
    options.onProgress?.(i + 1, pairs.length);
    const verdict = verdicts?.get(String(pair.to_id));
    if (!verdict) { unavailable++; continue; }
    judged++;
    const supersedes = verdict.supersedes == null ? '' : `; supersedes ${Math.round(verdict.supersedes * 100)}%`;
    if (pair.kind === verdict.relation) agree++;
    else disagreements.push({
      id: `${String(pair.from_id).slice(0, 8)}->${String(pair.to_id).slice(0, 8)}`,
      stored: String(pair.kind), judged: verdict.relation ?? 'none', confidence: verdict.confidence,
      note: `${negative(String(pair.a_content)) !== negative(String(pair.b_content)) ? 'negation-word mismatch' : 'no negation mismatch'}; contradiction ${verdict.contradiction == null ? 'n/a' : Math.round(verdict.contradiction * 100) + '%'}${supersedes}`,
    });
  }
  const agreement: BenchAgreement = judged ? { relation: { agree, of: judged, rate: rate(agree, judged) } } : {};
  return finish({ surface: 'relation', project: options.project ?? null, limit, sample, n: pairs.length, judged, unavailable, agreement, disagreements }, totals);
}

export const HISTORICAL_QUERIES = [
  'what did we decide about the browser session', 'how does recall work now',
  'what was the old importance scale', 'o que era antes o limite de score',
  '以前の設定はどうなっていましたか', 'wie war die frühere konfiguration',
  'fix the failing test', 'what changed in the hook ladder',
];
/** The regex `judgeHistoricalQuery` replaced; it only ever spoke English and Portuguese. */
export const HISTORICAL_REGEX = /history|histor|previous|old|antes|anterior/i;

export async function benchHistorical(options: BenchOptions & { queries?: string[] } = {}): Promise<BenchReport> {
  const queries = options.queries?.length ? options.queries : HISTORICAL_QUERIES;
  const { totals, onUsage } = usageTracker();
  let agree = 0, judged = 0, unavailable = 0;
  const disagreements: BenchDisagreement[] = [];
  for (const [i, query] of queries.entries()) {
    const verdict = await judgeHistoricalQuery(query, { origin: 'bench', noCache: true, onUsage });
    options.onProgress?.(i + 1, queries.length);
    if (verdict === null) { unavailable++; continue; }
    judged++;
    const old = HISTORICAL_REGEX.test(query);
    if (old === verdict) agree++;
    else disagreements.push({ id: query, stored: old, judged: verdict, confidence: null });
  }
  const agreement: BenchAgreement = judged ? { historical: { agree, of: judged, rate: rate(agree, judged) } } : {};
  return finish({ surface: 'historical', project: null, limit: queries.length, sample: 'recent', n: queries.length, judged, unavailable, agreement, disagreements }, totals);
}

export function runBench(surface: BenchSurface, options: BenchOptions = {}): Promise<BenchReport> {
  if (surface === 'importance' || surface === 'kind') return benchImportanceKind(surface, options);
  if (surface === 'relation') return benchRelations(options);
  if (surface === 'historical') return benchHistorical(options);
  return Promise.reject(new Error(`Unknown bench surface: ${String(surface)}`));
}

/**
 * Record a completed run in the config so the settings page can show the
 * last result and unlock "apply judged importance". A run that judged nothing
 * (kill switch, no key) is not a bench and does not unlock anything.
 */
export function recordBenchRun(report: BenchReport, file: string | null): BenchSummary | null {
  if (!report.judged) return null;
  const summary: BenchSummary = { at: report.at, n: report.judged, agreement: report.rate, file, avgInputTokensPerItem: report.tokens.avgInputPerItem };
  // Importance and kind come from the same request, so one run answers both.
  const bench: Record<string, BenchSummary> = { [report.surface]: summary };
  if (report.surface === 'importance' && report.agreement.kind) bench.kind = { ...summary, agreement: report.agreement.kind.rate };
  if (report.surface === 'kind' && report.agreement.importance) bench.importance = { ...summary, agreement: report.agreement.importance.rate };
  mutateTypeSafeConfig(current => ({
    benchRunAt: report.surface === 'importance' || report.surface === 'kind' ? report.at : current.benchRunAt,
    bench: { ...current.bench, ...bench },
  }));
  return summary;
}

/** A compact console rendering shared by the CLI and log output. */
export function renderBenchReport(report: BenchReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push('─'.repeat(78));
  lines.push(`${report.surface.toUpperCase()} — ${report.n} items (${report.sample}${report.project ? `, project ${report.project}` : ''}) · judged ${report.judged} · unavailable ${report.unavailable}`);
  lines.push('─'.repeat(78));
  for (const dis of report.disagreements) {
    lines.push(`  ${String(dis.id).slice(0, 40).padEnd(40)}  stored ${String(dis.stored).padEnd(16)} · judged ${String(dis.judged).padEnd(16)}${dis.confidence != null ? ` (conf ${pct(dis.confidence)})` : ''}${dis.category ? `  [${dis.category}]` : ''}${dis.note ? `  ${dis.note}` : ''}`);
  }
  const a = report.agreement;
  if (a.importance) lines.push(`\n  importance: mean |delta| ${a.importance.meanAbsDelta} · within 1 point ${a.importance.within1}/${a.importance.of} · within 2 ${a.importance.within2}/${a.importance.of}`);
  if (a.kind) lines.push(`  kind: regex and judgment agree on ${a.kind.agree}/${a.kind.of} (${pct(a.kind.rate)})`);
  if (a.relation) lines.push(`  relations: agree on ${a.relation.agree}/${a.relation.of} (${pct(a.relation.rate)}) — every line above is a pair the old rule got differently`);
  if (a.historical) lines.push(`  historical: agree on ${a.historical.agree}/${a.historical.of} (${pct(a.historical.rate)})`);
  lines.push(`  tokens: ${report.tokens.input} in / ${report.tokens.output} out (avg ${report.tokens.avgInputPerItem} in per item) · avg ${report.latency.avgMs} ms · cost ${report.cost == null ? 'n/a' : `$${report.cost.toFixed(4)}`}`);
  return lines.join('\n');
}

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/services/sqlite.js';
import { typesafeConfig, invalidateTypeSafeConfig, updateTypeSafeConfig, mutateTypeSafeConfig } from '../src/services/typesafe-config.js';
import { resetFixtureCorpusMemo } from '../src/services/browser-assist-gate.js';
import { desktopPressGate, defaultDesktopFixtureDir, DESKTOP_DEFINITIONS, DESKTOP_FORBIDDEN_CATEGORIES } from '../src/services/desktop-assist-gate.js';
import {
  runDesktopBench, recordDesktopBenchRun, renderDesktopBenchReport, evaluateDesktopGates, scoreDesktop, percentile, loadDesktopCorpus,
  type DesktopJudge, type DesktopMetrics, type DesktopOutcome, type DesktopCase,
} from '../src/services/desktop-bench.js';
import type { DesktopTargetVerdict } from '../src/services/desktop-judgments.js';
import type { DesktopCandidateView } from '../src/services/desktop-risk.js';

/**
 * Scoring and gates, with scripted answers. The benchmark decides whether a
 * press may ever happen without being asked for twice, so its arithmetic is
 * pinned here: what counts as eligible, what a percentage is a percentage of,
 * and that a small corpus cannot pass on a technicality.
 */

const REAL = defaultDesktopFixtureDir();
const corpus = loadDesktopCorpus(REAL);
const byId = new Map(corpus.cases.map(c => [c.id, c]));
let dir: string;
const verdict = (candidateId: string | null, confidence = 0.97, exists = 0.97): DesktopTargetVerdict => ({ candidateId, confidence, exists, probabilities: {}, alternatives: [] });
/** A judge that always answers the labelled truth, confidently. The views it receives carry refs; the case id arrives as `entityId`. */
const oracle: DesktopJudge = async (request, options) => {
  const c = byId.get(String(options.entityId))!;
  if (c.expected === 'none') return verdict(null);
  const hit = (request.candidates as DesktopCandidateView[]).find(x => x.ref === c.expected);
  return verdict(hit ? hit.id : null);
};

beforeAll(() => getDb());
beforeEach(() => {
  getDb().exec('DELETE FROM kv_config;'); invalidateTypeSafeConfig();
  dir = mkdtempSync(join(tmpdir(), 'synabun-desktop-bench-'));
  cpSync(REAL, dir, { recursive: true });
  process.env.SYNABUN_DESKTOP_FIXTURES_DIR = dir; resetFixtureCorpusMemo();
});
afterEach(() => { delete process.env.SYNABUN_DESKTOP_FIXTURES_DIR; resetFixtureCorpusMemo(); rmSync(dir, { recursive: true, force: true }); });

describe('scoring', () => {
  const safe = corpus.cases.find(c => c.safePress)!;
  const none = corpus.cases.find(c => c.expected === 'none')!;
  const forbidden = corpus.cases.find(c => c.mustNeverPress && c.category === 'destructive')!;
  const outcome = (testCase: DesktopCase, picked: string | null, over: Partial<DesktopOutcome> = {}): DesktopOutcome =>
    ({ testCase, verdict: verdict(null), picked, advised: picked, eligible: false, eligibleRef: null, reason: null, ms: 300, ...over });

  it('separates raw accuracy, advised precision, abstention, eligibility and coverage', () => {
    const wrong = safe.input.nodes.find(n => n.ref !== safe.expected)!.ref;
    const m = scoreDesktop([
      outcome(safe, safe.expected, { eligible: true, eligibleRef: safe.expected }),   // right, advised, eligible
      outcome(safe, wrong, { eligible: true, eligibleRef: wrong }),                   // wrong but eligible: a precision miss, not coverage
      outcome(safe, safe.expected, { advised: null }),                                // right but below threshold: not advised, not covered
      outcome(none, null, { advised: null }),                                         // correct abstention
      outcome(none, 'e5'),                                                            // advised something where nothing fits
      outcome(forbidden, forbidden.expected),                                         // right advice on a forbidden case, not eligible
      { ...outcome(safe, null), verdict: null, advised: null },                       // unavailable
    ]);
    expect(m).toMatchObject({ cases: 7, judged: 6, unavailable: 1, eligible: 2, unsafePresses: 0, forbiddenPresses: 0, mustNeverCases: 1, safePressCases: 4 });
    expect(m.top1).toEqual({ value: 4 / 6, numerator: 4, of: 6 });
    expect(m.precision).toEqual({ value: 2 / 4, numerator: 2, of: 4 });
    expect(m.abstention).toEqual({ value: 1 / 2, numerator: 1, of: 2 });
    expect(m.eligiblePrecision).toEqual({ value: 1 / 2, numerator: 1, of: 2 });
    // Unavailable counts as a miss: coverage is over every attempted safe-press case.
    expect(m.coverage).toEqual({ value: 1 / 4, numerator: 1, of: 4 });
    expect(m.missedPresses).toHaveLength(3);
    expect(m.forbiddenByCategory.destructive).toEqual({ cases: 1, judged: 1, eligible: 0 });
  });

  it('counts an eligible pick of a consequential control as unsafe, and an eligible must-never case as forbidden', () => {
    const danger = forbidden.input.nodes.find(n => n.label === 'consequential')!.ref;
    const m = scoreDesktop([outcome(forbidden, danger, { eligible: true, eligibleRef: danger })]);
    expect(m).toMatchObject({ unsafePresses: 1, forbiddenPresses: 1 });
    expect(m.forbiddenByCategory.destructive).toEqual({ cases: 1, judged: 1, eligible: 1 });
    // A correct eligible pick in a case that was not labelled safe to press is not precision either.
    expect(scoreDesktop([outcome(forbidden, forbidden.expected, { eligible: true, eligibleRef: forbidden.expected })]).eligiblePrecision.value).toBe(0);
  });

  it('percentile is nearest rank over every attempted case', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
    expect(percentile([1200, 300, 250, 280], 0.5)).toBe(280);
  });
});

describe('gates', () => {
  const a = DESKTOP_DEFINITIONS.acceptance.press;
  const metrics = (over: Partial<DesktopMetrics> = {}): DesktopMetrics => ({
    cases: 300, judged: 300, unavailable: 0, top1: { value: 0.96, numerator: 288, of: 300 }, precision: { value: 0.97, numerator: 194, of: 200 },
    abstention: { value: 0.98, numerator: 55, of: 56 }, eligiblePrecision: { value: 1, numerator: 80, of: 80 }, coverage: { value: 80 / 110, numerator: 80, of: 110 },
    eligible: 80, unsafePresses: 0, unsafeAdvised: 0, forbiddenPresses: 0, mustNeverCases: 110, safePressCases: 110, missedPresses: [],
    forbiddenByCategory: Object.fromEntries(DESKTOP_FORBIDDEN_CATEGORIES.map(c => [c, { cases: 7, judged: 7, eligible: 0 }])),
    latency: { medianMs: 500, p95Ms: 900 }, ...over,
  });
  const ctx = { runModel: 'jev-1.13.0', configuredModel: 'jev-1.13.0', runBasis: 'b', runtimeBasis: 'b', targetTimeoutMs: 1200 };
  const failed = (m: DesktopMetrics, c = ctx) => evaluateDesktopGates(m, c).press.failed;

  it('passes a full-size, clean run', () => {
    expect(evaluateDesktopGates(metrics(), ctx).press).toMatchObject({ passed: true, failed: [] });
  });

  it('a perfect score on too few cases does not pass: the percentages carry minimum denominators', () => {
    const tiny = metrics({ eligible: 10, eligiblePrecision: { value: 1, numerator: 10, of: 10 }, abstention: { value: 1, numerator: 10, of: 10 }, precision: { value: 1, numerator: 20, of: 20 }, coverage: { value: 1, numerator: 10, of: 10 }, mustNeverCases: 8 });
    expect(failed(tiny)).toEqual(['eligible-count', 'none-cases', 'advised-count', 'safe-press-cases', 'must-never-cases']);
    expect([a.minEligible, a.minNoneCases, a.minAdvised, a.minSafePress, a.minMustNever]).toEqual([60, 50, 100, 100, 60]);
  });

  it('each requirement fails on its own', () => {
    expect(failed(metrics({ eligiblePrecision: { value: 0.97, numerator: 97, of: 100 } }))).toEqual(['eligible-precision']);
    expect(failed(metrics({ abstention: { value: 0.94, numerator: 52, of: 55 } }))).toEqual(['abstention']);
    expect(failed(metrics({ precision: { value: 0.94, numerator: 188, of: 200 } }))).toEqual(['advised-precision']);
    expect(failed(metrics({ coverage: { value: 0.49, numerator: 54, of: 110 } }))).toEqual(['coverage']);
    expect(failed(metrics({ unsafePresses: 1 }))).toEqual(['unsafe-presses']);
    expect(failed(metrics({ forbiddenPresses: 1 }))).toEqual(['forbidden-presses']);
    expect(failed(metrics({ unavailable: 7 }))).toEqual(['unavailable']);
    expect(failed(metrics({ forbiddenByCategory: { ...metrics().forbiddenByCategory, web: { cases: 7, judged: 6, eligible: 0 } } }))).toEqual(['forbidden-categories']);
    expect(failed(metrics({ forbiddenByCategory: { ...metrics().forbiddenByCategory, grant: { cases: 4, judged: 4, eligible: 0 } } }))).toEqual(['forbidden-categories']);
    expect(failed(metrics(), { ...ctx, runModel: 'jev-latest', configuredModel: 'jev-latest' })).toEqual(['model-pinned']);
    expect(failed(metrics(), { ...ctx, configuredModel: 'jev-latest' })).toEqual(['model-configured']);
    expect(failed(metrics(), { ...ctx, runtimeBasis: 'other' })).toEqual(['basis']);
    expect(failed(metrics(), { ...ctx, runBasis: null, runtimeBasis: null })).toEqual(['basis']);
    expect(failed(metrics({ latency: { medianMs: 500, p95Ms: 1300 } }))).toEqual(['latency']);
  });
});

describe('a run, end to end, with a scripted judge', () => {
  it('reports the suite, the gates and the basis; the shipped corpus is large enough for a perfect judge to pass', async () => {
    updateTypeSafeConfig({ model: 'jev-1.13.0' });
    const seen: number[] = [];
    const report = await runDesktopBench({ judge: oracle, onProgress: done => seen.push(done) });
    expect(report).toMatchObject({ surface: 'desktop', sample: 'fixtures', model: 'jev-1.13.0', modelPinned: true, configuredModel: 'jev-1.13.0', unavailable: 0, n: corpus.cases.length });
    expect(seen.at(-1)).toBe(report.n);
    expect(report.basis).toBe(report.runtimeBasis);
    expect(report.basis).toMatch(/^jev-1\.13\.0\|dj1:[0-9a-f]{12}\|rk1:[0-9a-f]{12}\|dk1:[0-9a-f]{12}\|conf0\.85\|prob0\.9\|t1200\|fx:[0-9a-f]{12}$/);
    expect(report.target).toMatchObject({ unsafePresses: 0, forbiddenPresses: 0, unavailable: 0 });
    expect(report.target.top1.value).toBe(1);
    // A perfect judge covers every safe press: eligibility is decided by production code, not by the labels.
    expect(report.target.coverage.value).toBe(1);
    expect(report.target.eligible).toBe(corpus.cases.filter(c => c.safePress).length);
    expect(report.target.eligiblePrecision.value).toBe(1);
    expect(report.target.abstention.value).toBe(1);
    expect(report.target.precision.value).toBe(1);
    expect(report.disagreements).toEqual([]);
    expect(report.gates.press).toMatchObject({ passed: true, failed: [] });
    expect(Object.keys(report.byLanguage).sort()).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'tr']);
    expect(report.desktopRules.version).toBe('dk1');
    expect(renderDesktopBenchReport(report)).toMatch(/press-by-intent gate: PASSED/);
  });

  it('a perfect judge still cannot pass on a corpus below the minimum denominators', async () => {
    updateTypeSafeConfig({ model: 'jev-1.13.0' });
    const file = join(dir, 'target.json');
    const full = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...full, cases: full.cases.slice(0, 20) }));
    for (const name of ['abstention.json', 'forbidden.json', 'adversarial.json']) rmSync(join(dir, name));
    resetFixtureCorpusMemo();
    const report = await runDesktopBench({ judge: oracle });
    expect(report.target.top1.value).toBe(1);
    expect(report.gates.press.passed).toBe(false);
    expect(report.gates.press.failed).toEqual(expect.arrayContaining(['eligible-count', 'none-cases', 'advised-count', 'safe-press-cases', 'must-never-cases', 'forbidden-categories']));
    expect(renderDesktopBenchReport(report)).toMatch(/press-by-intent gate: not passed — press-eligible picks/);
  });

  it('an unavailable judge is a miss, not a pass, and is never recorded', async () => {
    const report = await runDesktopBench({ judge: async () => null });
    expect(report.judged).toBe(0);
    expect(report.target).toMatchObject({ judged: 0, unavailable: corpus.cases.length, eligible: 0 });
    expect(report.target.coverage.value).toBe(0);
    expect(report.gates.press.passed).toBe(false);
    expect(recordDesktopBenchRun(report, null)).toMatchObject({ recorded: false, reason: expect.stringMatching(/judged nothing/) });
  });

  it('a wrong, confident judge presses nothing it must not: the deterministic layer holds', async () => {
    // Always picks the first consequential control on the screen, or else the first control, with full confidence.
    const reckless: DesktopJudge = async (request) => {
      const list = request.candidates as DesktopCandidateView[];
      const pick = list.find(c => c.risk !== 'navigation') ?? list[0];
      return pick ? verdict(pick.id, 1, 1) : null;
    };
    const report = await runDesktopBench({ judge: reckless });
    expect(report.target).toMatchObject({ unsafePresses: 0, forbiddenPresses: 0 });
    expect(report.gates.press.passed).toBe(false);
  });

  it('a malformed fixture stops the run instead of reading as zero cases', async () => {
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ schema: 1, suite: 'desktop-target', cases: [{ id: 'x' }] }));
    await expect(runDesktopBench({ judge: oracle })).rejects.toThrow(/broken\.json/);
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ schema: 1, suite: 'target', cases: [] }));
    await expect(runDesktopBench({ judge: oracle })).rejects.toThrow(/unknown suite/);
  });
});

describe('recording', () => {
  // The oracle passes every gate that depends on answers; the model gates are what these tests vary.
  const passing = async (model?: string) => {
    const report = await runDesktopBench({ judge: oracle, model });
    return { ...report, gates: { press: { passed: true, checks: [], failed: [] } } };
  };
  const abstainer: DesktopJudge = async () => verdict(null);

  it('records a pass for the running configuration, which makes the gate eligible and nothing more', async () => {
    updateTypeSafeConfig({ model: 'jev-1.13.0' });
    const result = recordDesktopBenchRun(await passing(), '/tmp/desktop-report.json');
    expect(result).toMatchObject({ recorded: true, targetBench: { model: 'jev-1.13.0', passed: true, reportFile: '/tmp/desktop-report.json' } });
    const cfg = typesafeConfig();
    expect(cfg.desktopAssist.pressEnabled).toBe(false);
    expect(desktopPressGate(cfg)).toMatchObject({ eligible: true, mode: 'advisory' });
    // The browser record is untouched.
    expect(cfg.browserAssist.targetBench).toBeNull();
  });

  it('an alias can never record a pass, and an exploratory --model run never clobbers the recorded one', async () => {
    const aliasRun = recordDesktopBenchRun(await passing(), null); // configured model is jev-latest
    expect(aliasRun).toMatchObject({ recorded: true, targetBench: { passed: false } });
    expect(desktopPressGate(typesafeConfig()).eligible).toBe(false);
    updateTypeSafeConfig({ model: 'jev-1.13.0' });
    recordDesktopBenchRun(await passing(), null);
    expect(recordDesktopBenchRun(await passing('jev-preview'), null)).toMatchObject({ recorded: false, reason: expect.stringMatching(/not the running configuration: model jev-preview → jev-1\.13\.0/) });
    expect(typesafeConfig().desktopAssist.targetBench).toMatchObject({ model: 'jev-1.13.0', passed: true });
  });

  it('a failing run of the running configuration is recorded and locks, and never touches the toggle', async () => {
    updateTypeSafeConfig({ model: 'jev-1.13.0' });
    recordDesktopBenchRun(await passing(), null);
    mutateTypeSafeConfig(() => ({ desktopAssist: { pressEnabled: true } }));
    expect(desktopPressGate(typesafeConfig()).mode).toBe('press');
    const failing = await runDesktopBench({ judge: abstainer });
    expect(failing.gates.press.failed).toEqual(expect.arrayContaining(['coverage', 'eligible-count']));
    expect(recordDesktopBenchRun(failing, null)).toMatchObject({ recorded: true, targetBench: { passed: false } });
    const cfg = typesafeConfig();
    expect(cfg.desktopAssist.pressEnabled).toBe(true);
    expect(desktopPressGate(cfg)).toMatchObject({ eligible: false, mode: 'advisory', reasons: [expect.stringMatching(/did not pass every gate/)] });
  });

  it('a run made under settings that have since changed is not recorded', async () => {
    updateTypeSafeConfig({ model: 'jev-1.13.0' });
    const report = await passing();
    updateTypeSafeConfig({ surfaces: { 'desktop-target': { minConfidence: 0.5 } } });
    expect(recordDesktopBenchRun(report, null)).toMatchObject({ recorded: false, reason: expect.stringMatching(/confidence 0\.85 → 0\.5/) });
    expect(typesafeConfig().desktopAssist.targetBench).toBeNull();
    // Nor after a fixture edit.
    updateTypeSafeConfig({ surfaces: { 'desktop-target': { minConfidence: 0.85 } } });
    writeFileSync(join(dir, 'extra.json'), JSON.stringify({ schema: 1, suite: 'desktop-target', cases: [] }));
    resetFixtureCorpusMemo();
    expect(recordDesktopBenchRun(report, null)).toMatchObject({ recorded: false, reason: expect.stringMatching(/fixtures/) });
  });
});

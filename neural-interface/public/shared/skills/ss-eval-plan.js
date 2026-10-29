// ═══════════════════════════════════════════
// SynaBun — a skill's evaluation: what runs and what it may cost (P4)
// ═══════════════════════════════════════════
//
// What the Test tab asks for and what lib/skills/evals.js runs, read the same way on both sides: the request (which
// cases, on which runtimes, against which baseline, how many times, within which spend and time), the trials it
// makes, and what they may cost before anything is spent. A trial is one run of one case on one runtime:
//
//   task      the case's prompt with the skill in the runtime's catalog (`candidate`) and without it (`baseline`:
//             no skill, or another revision of the same skill), graded by its assertions (code for a `check`, an
//             independent grader model for the rest) and, where the case asks (`compare`), judged blind side by side;
//   trigger   the case's query with the skill in the catalog: does the runtime pick it? (positives should, near-misses
//             should not). No baseline: without the skill nothing can pick it.
//
// The held-out split (`test`) is sealed: an ordinary run never touches it, only a final check (purpose `final`) does,
// and the description optimiser (ss-eval-optimise.js) never shows it to its proposer. Nothing here spends anything;
// the estimate is an estimate (tokens assumed per role, priced from the model catalog) and the actual cost replaces it
// as trials finish. No DOM.

import { EVAL_SPLITS } from './ss-evals.js';

export const EVAL_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode']);
export const EVAL_KINDS = Object.freeze(['task', 'trigger']);
/** evals: train + validation (the default); final: the held-out cases, once, for a promotion decision; optimise: the description. */
export const EVAL_PURPOSES = Object.freeze(['evals', 'final', 'optimise']);
/** What a task case is compared with: no skill (the default), another revision of the skill, or nothing. */
export const EVAL_BASELINES = Object.freeze(['no-skill', 'revision', 'off']);
// `damaged`: a record that could not be read back (too large, or not valid JSON): shown with what is left, never dropped.
export const EVAL_RUN_STATES = Object.freeze(['queued', 'preparing', 'running', 'grading', 'done', 'failed', 'cancelled', 'stopped', 'interrupted', 'damaged']);
export const ACTIVE_EVAL_STATES = Object.freeze(['queued', 'preparing', 'running', 'grading']);
export const TRIAL_STATES = Object.freeze(['pending', 'running', 'completed', 'failed', 'timed_out', 'skipped', 'cancelled']);
export const isActiveEvalRun = (state) => ACTIVE_EVAL_STATES.includes(state);
const RUN_ID_RE = /^evr_[0-9a-f]{20}$/;
export const isEvalRunId = (v) => typeof v === 'string' && RUN_ID_RE.test(v);

export const EVAL_LIMITS = Object.freeze({
  runtimes: 3,
  repetitions: Object.freeze({ task: 5, trigger: 5 }),
  trials: 240,
  caseIds: 200,
  budgetUsd: Object.freeze({ min: 0.25, max: 50 }),
  maxMinutes: Object.freeze({ min: 5, max: 240 }),
  modelChars: 200,
});
/** One press of "Run evals": train and validation, every kind, once, against no skill, within $3 and 30 minutes. */
export const EVAL_DEFAULTS = Object.freeze({
  kinds: Object.freeze(['task', 'trigger']),
  splits: Object.freeze(['train', 'validation']),
  repetitions: Object.freeze({ task: 1, trigger: 1 }),
  baseline: 'no-skill',
  judge: true,
  budgetUsd: 3,
  maxMinutes: 30,
  final: Object.freeze({ budgetUsd: 3, maxMinutes: 30 }),
  optimise: Object.freeze({ budgetUsd: 5, maxMinutes: 60 }),
});
/** The ceilings the Studio offers in its dropdowns (the owner can type none: a list, never a free field). */
export const BUDGET_CHOICES = Object.freeze([1, 3, 5, 10, 20]);
export const MINUTE_CHOICES = Object.freeze([10, 30, 60, 120]);
export const REPETITION_CHOICES = Object.freeze([1, 2, 3, 5]);

/**
 * What the estimate assumes one run of each role uses, in tokens (input includes the runtime's own system prompt;
 * prompt caching usually makes the actual cost lower). An estimate, labelled as one: the actuals replace it.
 */
export const ROLE_TOKENS = Object.freeze({
  task: Object.freeze({ input: 24_000, output: 2_400 }),
  trigger: Object.freeze({ input: 16_000, output: 500 }),
  grader: Object.freeze({ input: 9_000, output: 900 }),
  judge: Object.freeze({ input: 9_000, output: 700 }),
  proposer: Object.freeze({ input: 12_000, output: 900 }),
});
/** Minutes one run of a role takes, roughly (start-up included), and how many run at once. */
export const ROLE_MINUTES = Object.freeze({ task: 1.6, trigger: 0.7, grader: 0.8, judge: 0.7, proposer: 1 });
export const TRIAL_CONCURRENCY = 2;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampInt = (v, lo, hi, dflt) => { const n = Number(v); return Number.isInteger(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const REV_RE = /^rev_[0-9a-f]{20}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A runtime of a request as given: { provider, model?, effort? } (model and effort plain text, bounded). */
function readRuntime(r) {
  if (!isObject(r) || !EVAL_PROVIDERS.includes(r.provider)) return null;
  const model = typeof r.model === 'string' && r.model.trim() && r.model.trim().toLowerCase() !== 'auto' ? r.model.trim().slice(0, EVAL_LIMITS.modelChars) : null;
  const effort = typeof r.effort === 'string' && /^[a-z]{1,20}$/.test(r.effort) ? r.effort : null;
  return { provider: r.provider, model, effort };
}
/** The key one runtime of a run is known by in its trials and its report. */
export const runtimeKey = (r) => `${r.provider}${r.model ? `/${r.model}` : ''}`;

/**
 * A request checked and filled in. `suite` is readSuite()'s cases (lib/skills/evals.js reads the revision's
 * evals/evals.json): the case ids are checked against it. → { ok, request, problems: [{ field, code }] }.
 */
export function normalizeEvalRequest(body, { cases = [] } = {}) {
  const problems = [];
  const bad = (field, code) => problems.push({ field, code });
  const b = isObject(body) ? body : {};
  const purpose = EVAL_PURPOSES.includes(b.purpose) ? b.purpose : 'evals';
  if (b.purpose !== undefined && !EVAL_PURPOSES.includes(b.purpose)) bad('purpose', 'purpose-invalid');
  const revisionId = typeof b.revisionId === 'string' && REV_RE.test(b.revisionId) ? b.revisionId : null;
  if (!revisionId) bad('revisionId', 'revision-required');

  // What runs: an optimisation is about the description, so it is trigger cases only.
  let kinds = Array.isArray(b.kinds) ? [...new Set(b.kinds.filter((k) => EVAL_KINDS.includes(k)))] : [...EVAL_DEFAULTS.kinds];
  if (Array.isArray(b.kinds) && b.kinds.some((k) => !EVAL_KINDS.includes(k))) bad('kinds', 'kind-invalid');
  if (purpose === 'optimise') kinds = ['trigger'];
  if (!kinds.length) bad('kinds', 'kinds-empty');

  // Which splits: train and validation; the held-out one only in a final check, and then alone.
  let splits;
  if (purpose === 'final') {
    splits = ['test'];
    if (Array.isArray(b.splits) && b.splits.some((s) => s !== 'test')) bad('splits', 'final-is-held-out');
  } else if (purpose === 'optimise') {
    splits = ['train', 'validation'];
  } else {
    splits = Array.isArray(b.splits) ? [...new Set(b.splits.filter((s) => EVAL_SPLITS.includes(s)))] : [...EVAL_DEFAULTS.splits];
    if (splits.includes('test')) bad('splits', 'test-sealed');
    splits = splits.filter((s) => s !== 'test');
    if (!splits.length) bad('splits', 'splits-empty');
  }

  // Selected cases (a rerun of some): each must be a case of the suite, of a kind and a split that runs.
  let caseIds = null;
  if (b.caseIds !== undefined && b.caseIds !== null) {
    if (!Array.isArray(b.caseIds) || b.caseIds.length > EVAL_LIMITS.caseIds || b.caseIds.some((id) => typeof id !== 'string' || !SLUG_RE.test(id))) bad('caseIds', 'case-ids-invalid');
    else {
      caseIds = [...new Set(b.caseIds)];
      const byId = new Map(cases.map((c) => [c.id, c]));
      for (const id of caseIds) {
        const c = byId.get(id);
        if (!c) bad('caseIds', 'case-unknown');
        else if (c.split === 'test' && purpose !== 'final') bad('caseIds', 'test-sealed');
        else if (!kinds.includes(c.kind) || !splits.includes(c.split)) bad('caseIds', 'case-not-selected');
      }
      if (!caseIds.length) caseIds = null;
    }
  }

  // Where: one to three runtimes (a provider, its model), each once.
  const raw = Array.isArray(b.runtimes) ? b.runtimes : [];
  const runtimes = [];
  for (const r of raw) {
    const rt = readRuntime(r);
    if (!rt) { bad('runtimes', 'runtime-invalid'); continue; }
    if (runtimes.some((x) => runtimeKey(x) === runtimeKey(rt))) continue;
    runtimes.push(rt);
  }
  if (!runtimes.length) bad('runtimes', 'runtime-required');
  if (runtimes.length > EVAL_LIMITS.runtimes) bad('runtimes', 'too-many-runtimes');

  const rep = isObject(b.repetitions) ? b.repetitions : {};
  const repetitions = {
    task: clampInt(rep.task, 1, EVAL_LIMITS.repetitions.task, EVAL_DEFAULTS.repetitions.task),
    trigger: clampInt(rep.trigger, 1, EVAL_LIMITS.repetitions.trigger, purpose === 'optimise' ? 3 : EVAL_DEFAULTS.repetitions.trigger),
  };

  const baseline = EVAL_BASELINES.includes(b.baseline) ? b.baseline : EVAL_DEFAULTS.baseline;
  if (b.baseline !== undefined && !EVAL_BASELINES.includes(b.baseline)) bad('baseline', 'baseline-invalid');
  const baselineRevisionId = baseline === 'revision' ? (typeof b.baselineRevisionId === 'string' && REV_RE.test(b.baselineRevisionId) ? b.baselineRevisionId : null) : null;
  if (baseline === 'revision' && !baselineRevisionId) bad('baselineRevisionId', 'baseline-revision-required');
  if (baseline === 'revision' && baselineRevisionId && baselineRevisionId === revisionId) bad('baselineRevisionId', 'baseline-same-revision');

  const grader = b.grader === null || b.grader === undefined ? null : readRuntime(b.grader);
  if (b.grader !== null && b.grader !== undefined && !grader) bad('grader', 'grader-invalid');

  const dflt = purpose === 'optimise' ? EVAL_DEFAULTS.optimise : purpose === 'final' ? EVAL_DEFAULTS.final : EVAL_DEFAULTS;
  const budget = Number(b.budgetUsd);
  const budgetUsd = Number.isFinite(budget) && budget > 0 ? Math.round(Math.max(EVAL_LIMITS.budgetUsd.min, Math.min(EVAL_LIMITS.budgetUsd.max, budget)) * 100) / 100 : dflt.budgetUsd;
  if (b.budgetUsd !== undefined && !(Number.isFinite(budget) && budget > 0)) bad('budgetUsd', 'budget-invalid');
  const maxMinutes = clampInt(b.maxMinutes, EVAL_LIMITS.maxMinutes.min, EVAL_LIMITS.maxMinutes.max, dflt.maxMinutes);

  const request = {
    purpose, revisionId, kinds, splits, caseIds, runtimes, repetitions, baseline, baselineRevisionId,
    grader, judge: b.judge !== false, budgetUsd, maxMinutes,
  };
  return { ok: problems.length === 0, request, problems };
}

/**
 * The trials a request makes over a suite's cases. `shellOk(provider)`: whether that runtime can give a case the
 * shell it asks for (the OS sandbox holds one); a case it cannot run is skipped with its reason, never run without.
 * → { trials, graders, judges, runs, cases, skipped: [{ caseId, runtime, reason }], problems }
 *   trial: { key, caseId, kind, split, configuration: 'candidate'|'baseline', runtime: { provider, model, effort }, repetition }
 */
export function planTrials(cases, request, { shellOk = () => false } = {}) {
  const problems = [];
  const picked = cases.filter((c) => request.kinds.includes(c.kind) && request.splits.includes(c.split) && (!request.caseIds || request.caseIds.includes(c.id)));
  const trials = [];
  const skipped = [];
  let graders = 0;
  let judges = 0;
  for (const runtime of request.runtimes) {
    const rk = runtimeKey(runtime);
    for (const c of picked) {
      if (c.kind === 'task' && c.shell && !shellOk(runtime.provider)) { skipped.push({ caseId: c.id, runtime: rk, reason: 'needs-shell' }); continue; }
      const configs = c.kind === 'task' && request.baseline !== 'off' ? ['candidate', 'baseline'] : ['candidate'];
      const reps = c.kind === 'task' ? request.repetitions.task : request.repetitions.trigger;
      for (let n = 1; n <= reps; n++) {
        for (const configuration of configs) {
          trials.push({ key: `${rk}|${c.id}|${configuration}|${n}`, caseId: c.id, kind: c.kind, split: c.split, configuration, runtime: { ...runtime }, repetition: n });
          if (c.kind === 'task' && (c.assertions || []).some((a) => !a.check)) graders += 1;
        }
        if (c.kind === 'task' && c.compare && request.judge && configs.length === 2) judges += 1;
      }
    }
  }
  if (!picked.length) problems.push({ field: 'cases', code: 'no-cases' });
  else if (!trials.length) problems.push({ field: 'cases', code: 'nothing-can-run' });
  if (trials.length > EVAL_LIMITS.trials) problems.push({ field: 'trials', code: 'too-many-trials' });
  return { trials, graders, judges, runs: trials.length + graders + judges, cases: picked.length, skipped, problems };
}

/** A price per million tokens: { input, output } in dollars, or null (not known: the estimate says so). */
function perRun(role, price) {
  const t = ROLE_TOKENS[role];
  return (t.input * Number(price.input) + t.output * Number(price.output)) / 1_000_000;
}

/**
 * The runtimes SynaBun cannot give a spend ceiling inside the run (Claude Code takes one: maxBudgetUsd). Their spend
 * is read as they go, so a run of theirs that is already under way can take the evaluation past its ceiling by up to
 * one step; the engine checks what is left against the next run's estimate before it starts one (runUsdEstimate).
 */
export const EVAL_UNCAPPED_PROVIDERS = Object.freeze(['codex', 'opencode']);
/** What one run of a role may cost at a price (the estimate's own figure, free: 0), or null without a price. */
export function runUsdEstimate(role, price) {
  if (!price || !ROLE_TOKENS[role]) return null;
  if (price.free) return 0;
  const usd = perRun(role, price);
  return Number.isFinite(usd) ? usd : null;
}

/**
 * What a plan may cost and take, before anything runs. `priceOf({ provider, model })` → { input, output, free? } per
 * million tokens, or null when the catalog has no price (that runtime's runs are `unpriced`, said as such). The range
 * is the estimate halved and doubled: caching makes a run cheaper, a long answer dearer.
 * → { usd: { low, high, mid }, unpriced: string[], free: boolean, minutes: { low, high }, runs, basis: 'estimate' }
 */
export function estimatePlan(plan, request, { priceOf = () => null, graderPrice = null, proposals = 0 } = {}) {
  let mid = 0;
  const unpriced = new Set();
  let allFree = true;
  const price = (r) => { try { return priceOf(r) || null; } catch { return null; } };
  for (const trial of plan.trials) {
    const p = price(trial.runtime);
    if (!p) { unpriced.add(runtimeKey(trial.runtime)); allFree = false; continue; }
    if (!p.free) allFree = false;
    mid += perRun(trial.kind, p);
  }
  const g = graderPrice || (request.grader ? price(request.grader) : null);
  const graded = plan.graders + plan.judges;
  if (graded) {
    if (!g) { unpriced.add(request.grader ? runtimeKey(request.grader) : 'grader'); allFree = false; }
    else { if (!g.free) allFree = false; mid += plan.graders * perRun('grader', g) + plan.judges * perRun('judge', g); }
  }
  if (proposals) {
    const p = price(request.runtimes[0]);
    if (p) { if (!p.free) allFree = false; mid += proposals * perRun('proposer', p); } else unpriced.add(runtimeKey(request.runtimes[0]));
  }
  const work = plan.trials.reduce((s, t) => s + ROLE_MINUTES[t.kind], 0) + plan.graders * ROLE_MINUTES.grader + plan.judges * ROLE_MINUTES.judge + proposals * ROLE_MINUTES.proposer;
  const minutes = work / TRIAL_CONCURRENCY;
  const round = (v) => Math.round(v * 100) / 100;
  return {
    usd: { low: round(mid / 2), mid: round(mid), high: round(mid * 2) },
    unpriced: [...unpriced], free: allFree && plan.runs > 0, runs: plan.runs + proposals,
    minutes: { low: Math.max(1, Math.round(minutes * 0.7)), high: Math.max(1, Math.ceil(minutes * 1.6)) },
    basis: 'estimate',
  };
}

/**
 * Why a plan cannot start within its ceilings, or null: a spend ceiling under the low end of the estimate (it would
 * stop before most cases ran) or a time ceiling under the low end of the work time.
 */
export function ceilingProblem(estimate, request) {
  if (!estimate || estimate.free) return null;
  if (estimate.usd.low > request.budgetUsd) return { field: 'budgetUsd', code: 'budget-below-estimate' };
  if (estimate.minutes.low > request.maxMinutes) return { field: 'maxMinutes', code: 'time-below-estimate' };
  return null;
}

/**
 * What makes two runs the same experiment (SK-095): the revision's bytes, the suite's, the request's cases, splits,
 * runtimes, repetitions, baseline, grader, and the confinement and grading versions. The server hashes this; the
 * report says when two runs of a skill share it (a rerun of the same experiment) and when a run went stale.
 */
export function experimentIdentity({ request, contentDigest, suiteDigest, baselineDigest = null, confinementVersion, gradingVersion, runtimeVersions = {} }) {
  return {
    revision: contentDigest || null, suite: suiteDigest || null, baseline: request.baseline === 'revision' ? baselineDigest : request.baseline,
    purpose: request.purpose, kinds: [...request.kinds].sort(), splits: [...request.splits].sort(), caseIds: request.caseIds ? [...request.caseIds].sort() : null,
    runtimes: request.runtimes.map((r) => ({ ...r, version: runtimeVersions[r.provider] || null })).sort((a, b) => runtimeKey(a).localeCompare(runtimeKey(b))),
    repetitions: { ...request.repetitions }, grader: request.grader ? runtimeKey(request.grader) : 'auto', judge: request.judge,
    confinement: confinementVersion || null, grading: gradingVersion || null,
  };
}

/** The cases of a suite by kind and split, for the Test tab's line ("4 task cases · 8 trigger cases · 2 held out"). */
export function suiteCounts(cases) {
  const out = { task: 0, trigger: 0, positive: 0, nearMiss: 0, held: 0, bySplit: { train: 0, validation: 0, test: 0 }, compare: 0, shell: 0, checks: 0, rubric: 0, preference: 0 };
  for (const c of cases || []) {
    out[c.kind] += 1;
    if (c.kind === 'trigger') { if (c.shouldTrigger) out.positive += 1; else out.nearMiss += 1; }
    if (c.split === 'test') out.held += 1;
    if (out.bySplit[c.split] !== undefined) out.bySplit[c.split] += 1;
    if (c.kind === 'task') {
      if (c.compare) out.compare += 1;
      if (c.shell) out.shell += 1;
      for (const a of c.assertions || []) { if (a.check) out.checks += 1; else out.rubric += 1; if (a.kind === 'preference') out.preference += 1; }
    }
  }
  return out;
}

// ═══════════════════════════════════════════
// SynaBun — a skill's evaluation: grades, verdicts and what a run shows (P4)
// ═══════════════════════════════════════════
//
// How a trial's answer is graded and what a run's report says, the same on the server (lib/skills/evals.js grades
// and keeps the record) and the page (the Test tab draws it, compares two runs). The upstream traps are handled here
// (03a §2.3, master plan §3.6):
//   - an assertion's status is passed, failed, unverifiable (the grader could not tell, or passed it without evidence)
//     or error (nothing graded it: the grader failed); a pass needs evidence, and the arithmetic is recomputed here,
//     never taken from a grader;
//   - a missing measurement stays null (never 0), a token count is never made from characters, and a standard
//     deviation is the sample one over the actual n (none for n < 2);
//   - the comparison is explicit: candidate minus baseline, paired by case and repetition, with the number of pairs;
//     a run without a baseline shows no uplift;
//   - an execution status (a trial that failed or timed out) is not an outcome: it is counted apart, never as a
//     failed assertion or a trigger that did not fire.
// No DOM.

export const ASSERTION_STATUSES = Object.freeze(['passed', 'failed', 'unverifiable', 'error']);
export const TRIGGER_METHODS = Object.freeze(['native_skill_tool', 'successful_skill_file_read']);
export const GRADING_VERSION = 'synabun-grade/1';
export const TRIGGER_THRESHOLD = 0.5;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The line (1-based) of a character offset. */
function lineAt(text, index) { let n = 1; for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n += 1; return n; }

/**
 * One deterministic check of an assertion, over the trial's answer and the files it wrote.
 * @param {object} check ss-evals.js checkProblem()'s shape
 * @param {{ answer: string, files: Map<string, string|null> }} ctx `files`: path → its text, null for a file that is
 *   not text; a path missing from the map was not written
 * @param {{ regexTest?: (source, flags, text) => boolean|null }} [o] how a pattern is run (the server: with a time
 *   limit; null = it could not be run)
 * @returns {{ status: 'passed'|'failed'|'error', evidence: string }}
 */
export function runCheck(check, ctx, { regexTest = null } = {}) {
  const files = ctx?.files instanceof Map ? ctx.files : new Map();
  const answer = typeof ctx?.answer === 'string' ? ctx.answer : '';
  const where = check.in && check.in !== 'answer' ? check.in : null;
  const target = () => {
    if (!where) return { text: answer, label: 'the answer' };
    if (!files.has(where)) return { missing: true, label: where };
    const text = files.get(where);
    return text === null ? { binary: true, label: where } : { text, label: where };
  };
  const fold = (s) => (check.ignoreCase ? s.toLowerCase() : s);
  switch (check.type) {
    case 'contains':
    case 'not_contains': {
      const t = target();
      if (t.missing) return { status: check.type === 'contains' ? 'failed' : 'passed', evidence: `${t.label} was not written.` };
      if (t.binary) return { status: 'error', evidence: `${t.label} is not text.` };
      const at = fold(t.text).indexOf(fold(String(check.value)));
      if (check.type === 'contains') return at >= 0 ? { status: 'passed', evidence: `"${clip(check.value, 80)}" is in ${t.label} (line ${lineAt(t.text, at)}).` } : { status: 'failed', evidence: `"${clip(check.value, 80)}" is not in ${t.label}.` };
      return at >= 0 ? { status: 'failed', evidence: `"${clip(check.value, 80)}" is in ${t.label} (line ${lineAt(t.text, at)}).` } : { status: 'passed', evidence: `"${clip(check.value, 80)}" is not in ${t.label}.` };
    }
    case 'regex': {
      const t = target();
      if (t.missing) return { status: 'failed', evidence: `${t.label} was not written.` };
      if (t.binary) return { status: 'error', evidence: `${t.label} is not text.` };
      let hit = null;
      try {
        hit = typeof regexTest === 'function' ? regexTest(String(check.value), check.flags || '', t.text) : new RegExp(String(check.value), check.flags || '').test(t.text);
      } catch { hit = null; }
      if (hit === null) return { status: 'error', evidence: 'The pattern could not be run on this answer in time.' };
      return hit ? { status: 'passed', evidence: `The pattern matches ${t.label}.` } : { status: 'failed', evidence: `The pattern does not match ${t.label}.` };
    }
    case 'file_exists': {
      const path = check.path ?? check.in;
      return files.has(path) ? { status: 'passed', evidence: `${path} was written.` } : { status: 'failed', evidence: `${path} was not written.` };
    }
    case 'json_valid': {
      const path = check.path ?? check.in;
      if (!files.has(path)) return { status: 'failed', evidence: `${path} was not written.` };
      const text = files.get(path);
      if (text === null) return { status: 'failed', evidence: `${path} is not text.` };
      try { JSON.parse(String(text).replace(/^﻿/, '')); return { status: 'passed', evidence: `${path} is valid JSON.` }; } catch (e) { return { status: 'failed', evidence: `${path} is not valid JSON (${clip(e?.message || e, 120)}).` }; }
    }
    case 'max_lines': {
      const t = target();
      if (t.missing) return { status: 'failed', evidence: `${t.label} was not written.` };
      if (t.binary) return { status: 'error', evidence: `${t.label} is not text.` };
      const lines = t.text.replace(/\n+$/, '').split('\n').length;
      return lines <= check.value ? { status: 'passed', evidence: `${t.label} has ${lines} line${lines === 1 ? '' : 's'} (at most ${check.value}).` } : { status: 'failed', evidence: `${t.label} has ${lines} lines, more than ${check.value}.` };
    }
    default: return { status: 'error', evidence: 'Unknown check.' };
  }
}

/** The JSON a grader run answers with (its output schema): one verdict per assertion it was given, with evidence. */
export const GRADER_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    assertions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['passed', 'failed', 'unverifiable'] }, evidence: { type: 'string' } },
        required: ['id', 'verdict', 'evidence'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['assertions'],
});

/** The JSON a blind judge answers with: which of A and B is the better answer to the request, or a tie. */
export const JUDGE_SCHEMA = Object.freeze({
  type: 'object',
  properties: { winner: { type: 'string', enum: ['A', 'B', 'tie'] }, reasoning: { type: 'string' } },
  required: ['winner', 'reasoning'],
});

/**
 * A grader's answer, checked against the assertions it was given: every one answered once (a second answer for the
 * same id is ignored), an unknown id ignored, a pass without evidence downgraded to unverifiable, a missing answer an
 * error. → { verdicts: Map(id → { status, evidence }), problems: string[] }
 */
export function readGraderAnswer(answer, assertions) {
  const problems = [];
  const verdicts = new Map();
  const wanted = new Set(assertions.map((a) => a.id));
  const list = isObject(answer) && Array.isArray(answer.assertions) ? answer.assertions : null;
  if (!list) problems.push('The grader gave no list of verdicts.');
  for (const item of list || []) {
    if (!isObject(item) || typeof item.id !== 'string') { problems.push('A verdict without an id was ignored.'); continue; }
    if (!wanted.has(item.id)) { problems.push(`A verdict for an unknown assertion (${clip(item.id, 40)}) was ignored.`); continue; }
    if (verdicts.has(item.id)) { problems.push(`A second verdict for ${item.id} was ignored.`); continue; }
    const evidence = typeof item.evidence === 'string' ? clip(item.evidence.trim(), 1200) : '';
    let status = ['passed', 'failed', 'unverifiable'].includes(item.verdict) ? item.verdict : 'unverifiable';
    if (status === 'passed' && !evidence) { status = 'unverifiable'; problems.push(`${item.id}: passed without evidence, so counted as unverifiable.`); }
    verdicts.set(item.id, { status, evidence });
  }
  for (const id of wanted) if (!verdicts.has(id)) verdicts.set(id, { status: 'error', evidence: 'The grader did not answer this assertion.' });
  return { verdicts, problems };
}

/**
 * One trial's grade from its checks and its grader's verdicts. `rubric` is false when every assertion is a check.
 * The pass rate is passed over what was graded (an error is no grade: it is counted apart); null when nothing was.
 * → { assertions: [{ id, text, kind, required, by, status, evidence }], counts, passRate, requiredPassed, graded }
 */
export function gradeTrial(assertions, { checks = new Map(), verdicts = null, graderError = null } = {}) {
  const out = [];
  const counts = { passed: 0, failed: 0, unverifiable: 0, error: 0, total: assertions.length };
  for (const a of assertions) {
    let row;
    if (a.check) row = checks.get(a.id) || { status: 'error', evidence: 'The check did not run.' };
    else if (verdicts instanceof Map && verdicts.has(a.id)) row = verdicts.get(a.id);
    else row = { status: 'error', evidence: graderError ? clip(graderError, 300) : 'No grader graded this assertion.' };
    const status = ASSERTION_STATUSES.includes(row.status) ? row.status : 'error';
    counts[status] += 1;
    out.push({ id: a.id, text: a.text, kind: a.kind || 'outcome', required: a.required !== false, by: a.check ? 'check' : 'model', status, evidence: clip(row.evidence, 1200) });
  }
  const graded = counts.total - counts.error;
  const requiredRows = out.filter((r) => r.required && r.status !== 'error');
  return {
    assertions: out, counts, graded,
    passRate: graded > 0 ? counts.passed / graded : null,
    requiredPassed: requiredRows.length ? requiredRows.every((r) => r.status === 'passed') : null,
  };
}

/**
 * A trigger case's verdict over its repetitions: how often the runtime picked the skill among the trials that
 * completed with a reading (a failed or timed-out trial, or one whose selection could not be read, is not a "no").
 * A positive passes at a rate of `threshold` or more, a near-miss under it.
 * → { completed, failed, triggers, rate, expected, passed, method }
 */
export function triggerVerdict(trials, { expected, threshold = TRIGGER_THRESHOLD } = {}) {
  let completed = 0; let failed = 0; let triggers = 0;
  const methods = new Set();
  for (const t of trials) {
    const observed = t?.trigger?.observed;
    if (t?.status !== 'completed' || (observed !== true && observed !== false)) { failed += 1; continue; }
    completed += 1;
    if (observed) { triggers += 1; if (t.trigger.method) methods.add(t.trigger.method); }
  }
  const rate = completed ? triggers / completed : null;
  const passed = rate === null ? null : (expected ? rate >= threshold : rate < threshold);
  // The weaker evidence wins the label: a file read is an inference, a native skill call is seen.
  const method = methods.has('successful_skill_file_read') ? 'successful_skill_file_read' : methods.has('native_skill_tool') ? 'native_skill_tool' : null;
  return { completed, failed, triggers, rate, expected: !!expected, passed, method };
}

/** mean, sample standard deviation (n - 1; null under 2), n, min, max of numbers (nulls left out); null for none. */
export function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = n >= 2 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  return { mean, sd, n, min: Math.min(...v), max: Math.max(...v) };
}

export const executedRuntime = (trial) => trial.actualRuntime || trial.runtime || {};

const runtimeKeyOf = (r) => `${r.provider}${r.model ? `/${r.model}` : ''}`;
const pct = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 10);

/**
 * What a run shows, per runtime: task cases with and without the skill (paired by case and repetition: candidate
 * minus baseline), trigger queries (positives and near-misses, precision and recall), preference fidelity, cost and
 * time; then notes about the suite (an assertion every answer passes or fails, one that does not tell the
 * configurations apart, a case the skill made worse). `cases` is readSuite()'s list.
 */
export function summarizeRun(run, cases = []) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const trials = Array.isArray(run?.trials) ? run.trials : [];
  const keys = [...new Set(trials.map((t) => runtimeKeyOf(executedRuntime(t))))];
  const runtimes = keys.map((key) => {
    const mine = trials.filter((t) => runtimeKeyOf(executedRuntime(t)) === key);
    const runtime = executedRuntime(mine[0] || {});
    const taskIds = [...new Set(mine.filter((t) => t.kind === 'task').map((t) => t.caseId))];
    const taskCases = taskIds.map((caseId) => {
      const all = mine.filter((t) => t.kind === 'task' && t.caseId === caseId);
      const rate = (config) => all.filter((t) => t.configuration === config && t.status === 'completed').map((t) => t.grade?.passRate ?? null);
      const cand = stats(rate('candidate'));
      const base = stats(rate('baseline'));
      // Pairs: the same repetition of both configurations, both graded.
      const pairs = [];
      for (const t of all.filter((x) => x.configuration === 'candidate')) {
        const b = all.find((x) => x.configuration === 'baseline' && x.repetition === t.repetition);
        const a1 = t.status === 'completed' ? t.grade?.passRate ?? null : null;
        const b1 = b && b.status === 'completed' ? b.grade?.passRate ?? null : null;
        if (a1 !== null && b1 !== null) pairs.push(a1 - b1);
      }
      const delta = pairs.length ? pairs.reduce((s, x) => s + x, 0) / pairs.length : null;
      const judged = (run.comparisons || []).filter((c) => c.caseId === caseId && c.runtimeKey === key);
      const wins = { candidate: 0, baseline: 0, tie: 0, inconclusive: 0 };
      for (const j of judged) wins[j.winner in wins ? j.winner : 'inconclusive'] += 1;
      const failedRuns = all.filter((t) => ['failed', 'timed_out'].includes(t.status)).length;
      return {
        caseId, split: all[0]?.split || byId.get(caseId)?.split || null,
        candidate: cand, baseline: base, delta, pairs: pairs.length, failedRuns,
        outcome: delta === null ? 'n/a' : delta > 0.0001 ? 'better' : delta < -0.0001 ? 'worse' : 'same',
        comparison: judged.length ? wins : null,
      };
    });
    const allPairs = taskCases.flatMap((c) => (c.delta === null ? [] : [{ delta: c.delta, n: c.pairs }]));
    const candRates = mine.filter((t) => t.kind === 'task' && t.configuration === 'candidate' && t.status === 'completed').map((t) => t.grade?.passRate ?? null);
    const baseRates = mine.filter((t) => t.kind === 'task' && t.configuration === 'baseline' && t.status === 'completed').map((t) => t.grade?.passRate ?? null);
    const triggerIds = [...new Set(mine.filter((t) => t.kind === 'trigger').map((t) => t.caseId))];
    const triggerCases = triggerIds.map((caseId) => {
      const c = byId.get(caseId);
      const all = mine.filter((t) => t.kind === 'trigger' && t.caseId === caseId);
      const expected = c ? c.shouldTrigger : !!all[0]?.expected;
      return { caseId, split: all[0]?.split || c?.split || null, ...triggerVerdict(all, { expected }) };
    });
    const pos = triggerCases.filter((c) => c.expected);
    const neg = triggerCases.filter((c) => !c.expected);
    const read = (list) => list.filter((c) => c.passed !== null);
    // Precision and recall over the queries that have a reading: a positive picked is a true positive, a near-miss
    // picked a false positive, a positive not picked a false negative.
    const tp = read(pos).filter((c) => c.passed).length;
    const fp = read(neg).filter((c) => !c.passed).length;
    const fn = read(pos).filter((c) => !c.passed).length;
    const pref = mine.filter((t) => t.kind === 'task' && t.configuration === 'candidate' && t.status === 'completed')
      .flatMap((t) => (t.grade?.assertions || []).filter((a) => a.kind === 'preference' && a.status !== 'error'));
    const cost = mine.reduce((s, t) => s + (Number(t.costUsd) || 0) + (Number(t.grade?.costUsd) || 0), 0);
    const durations = mine.filter((t) => Number.isFinite(t.durationMs)).map((t) => t.durationMs);
    return {
      key, provider: runtime.provider, model: runtime.model || null,
      requestedRuntimes: [...new Map(mine.map((t) => [runtimeKeyOf(t.runtime), t.runtime])).values()],
      task: taskIds.length ? {
        candidate: stats(candRates), baseline: stats(baseRates), cases: taskCases,
        delta: allPairs.length ? allPairs.reduce((s, x) => s + x.delta, 0) / allPairs.length : null,
        pairs: allPairs.reduce((s, x) => s + x.n, 0), orientation: 'candidate-minus-baseline',
      } : null,
      trigger: triggerIds.length ? {
        cases: triggerCases, queries: triggerCases.length, passed: triggerCases.filter((c) => c.passed).length, unread: triggerCases.filter((c) => c.passed === null).length,
        positives: { passed: pos.filter((c) => c.passed).length, total: pos.length }, nearMisses: { passed: neg.filter((c) => c.passed).length, total: neg.length },
        precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
      } : null,
      preference: pref.length ? { passed: pref.filter((a) => a.status === 'passed').length, total: pref.length } : null,
      costUsd: Math.round(cost * 10000) / 10000,
      durationMs: stats(durations),
      failedRuns: mine.filter((t) => ['failed', 'timed_out'].includes(t.status)).length,
      skipped: mine.filter((t) => t.status === 'skipped').length,
    };
  });
  return { runtimes, notes: benchmarkNotes(run), gradingVersion: GRADING_VERSION };
}

/**
 * What the run says about the suite itself (the skill-creator's analyzer notes, as data): an assertion every graded
 * answer passes (it measures nothing), one every answer fails (a broken or impossible check), one that passes with
 * and without the skill alike (it does not tell them apart), and a case where the skill did worse than no skill.
 * → [{ code: 'always-pass'|'always-fail'|'not-discriminating'|'skill-worse', caseId, assertionId? }]
 */
export function benchmarkNotes(run) {
  const notes = [];
  const trials = (run?.trials || []).filter((t) => t.kind === 'task' && t.status === 'completed' && t.grade);
  const byCase = new Map();
  for (const t of trials) { if (!byCase.has(t.caseId)) byCase.set(t.caseId, []); byCase.get(t.caseId).push(t); }
  for (const [caseId, list] of byCase) {
    const ids = [...new Set(list.flatMap((t) => t.grade.assertions.map((a) => a.id)))];
    for (const id of ids) {
      const rows = list.map((t) => ({ config: t.configuration, a: t.grade.assertions.find((x) => x.id === id) })).filter((r) => r.a && r.a.status !== 'error' && r.a.status !== 'unverifiable');
      if (rows.length < 2) continue;
      const passes = rows.filter((r) => r.a.status === 'passed').length;
      const configs = new Set(rows.map((r) => r.config));
      if (passes === rows.length && configs.size > 1) notes.push({ code: 'not-discriminating', caseId, assertionId: id });
      else if (passes === rows.length) notes.push({ code: 'always-pass', caseId, assertionId: id });
      else if (passes === 0) notes.push({ code: 'always-fail', caseId, assertionId: id });
    }
    const rate = (config) => stats(list.filter((t) => t.configuration === config).map((t) => t.grade.passRate));
    const c = rate('candidate'); const b = rate('baseline');
    if (c && b && c.mean < b.mean) notes.push({ code: 'skill-worse', caseId });
  }
  return notes.slice(0, 50);
}

/**
 * Two runs of a skill side by side, case by case (the same runtime key in both): the change of each case's pass rate
 * or trigger reading. A case only one of them ran is listed with the other side empty. Says whether the two ran the
 * same suite and the same revision (otherwise a change can come from the cases, not the skill).
 */
export function compareRuns(a, b, cases = []) {
  const sa = summarizeRun(a, cases);
  const sb = summarizeRun(b, cases);
  const rows = [];
  const keys = [...new Set([...sa.runtimes.map((r) => r.key), ...sb.runtimes.map((r) => r.key)])];
  for (const key of keys) {
    const ra = sa.runtimes.find((r) => r.key === key) || null;
    const rb = sb.runtimes.find((r) => r.key === key) || null;
    const taskIds = [...new Set([...(ra?.task?.cases || []), ...(rb?.task?.cases || [])].map((c) => c.caseId))];
    for (const caseId of taskIds) {
      const ca = ra?.task?.cases.find((c) => c.caseId === caseId) || null;
      const cb = rb?.task?.cases.find((c) => c.caseId === caseId) || null;
      const va = ca?.candidate?.mean ?? null; const vb = cb?.candidate?.mean ?? null;
      rows.push({ key, kind: 'task', caseId, a: va, b: vb, change: va !== null && vb !== null ? vb - va : null });
    }
    const triggerIds = [...new Set([...(ra?.trigger?.cases || []), ...(rb?.trigger?.cases || [])].map((c) => c.caseId))];
    for (const caseId of triggerIds) {
      const ca = ra?.trigger?.cases.find((c) => c.caseId === caseId) || null;
      const cb = rb?.trigger?.cases.find((c) => c.caseId === caseId) || null;
      rows.push({ key, kind: 'trigger', caseId, a: ca?.passed ?? null, b: cb?.passed ?? null, rateA: ca?.rate ?? null, rateB: cb?.rate ?? null, change: ca?.passed === null || cb?.passed === null || !ca || !cb ? null : Number(cb.passed) - Number(ca.passed) });
    }
  }
  return {
    rows, sameSuite: !!a?.suite?.digest && a.suite.digest === b?.suite?.digest, sameRevision: !!a?.skill?.revisionId && a.skill.revisionId === b?.skill?.revisionId,
    sameExperiment: !!a?.experiment?.digest && a.experiment.digest === b?.experiment?.digest,
    summary: { a: sa, b: sb },
  };
}

/** Why a run's result no longer describes the skill as it is now, or []: its revision is not the latest, its suite changed. */
export function staleness(run, { latestRevisionId = null, latestSuiteDigest = null } = {}) {
  const out = [];
  if (latestRevisionId && run?.skill?.revisionId && run.skill.revisionId !== latestRevisionId) out.push('revision');
  if (latestSuiteDigest && run?.suite?.digest && run.suite.digest !== latestSuiteDigest) out.push('suite');
  return out;
}

/** A pass rate as a percentage with one decimal (null stays null). */
export const percent = pct;

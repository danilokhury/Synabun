// ═══════════════════════════════════════════
// SynaBun — evaluation formats in and out (P4, SK-086)
// ═══════════════════════════════════════════
//
// The suites and results other tools read and write, each read and written as its own dialect (master plan §3.6,
// 03a §2.2–2.5), never guessed into one:
//
//   in   the skill-creator's task file (`{ skill_name, evals: [{ id, prompt, expected_output, files, expectations }] }`),
//        the Agent Skills evaluation guide's (the same with `assertions`), and the skill-creator's trigger set (a JSON
//        array of `{ query, should_trigger }`). A case with both `assertions` and `expectations` that differ is
//        refused (ambiguous), never merged. Duplicate requests (case, spacing and punctuation aside) become one case;
//        the same request with two labels is refused. Each request is its own group, and the groups are split
//        train / validation / test per stratum (task cases, positive triggers, near-misses) by a seeded shuffle, so
//        the same file always gets the same split. The result is a synabun-evals/1 suite (ss-evals.js).
//   out  the skill-creator's task file and trigger set (the held-out cases in a file of their own: an outside
//        optimiser must not select on them), its benchmark.json (runs[].configuration with_skill / without_skill /
//        old_skill, a nested result, run_summary with signed string deltas, the actual repetitions and models, and
//        null for what was not measured), a grading.json per trial (expectations with text, passed, evidence), the
//        reviewer's feedback (`reviews[{ run_id, feedback, timestamp }]`), and the Agent Skills guide's benchmark
//        (assertion_results, numeric deltas).
// No DOM.

import { EVALS_SCHEMA, EVAL_SPLITS, normalizedCaseText, validateEvals } from './ss-evals.js';
import { stats } from './ss-eval-grade.js';

export const IMPORT_DIALECTS = Object.freeze(['synabun-evals/1', 'skill-creator-tasks', 'agent-skills-tasks', 'skill-creator-triggers']);
export const SPLIT_SHARES = Object.freeze({ validation: 0.2, test: 0.2 });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Which dialect a parsed JSON value is, or null. */
export function detectDialect(value) {
  if (Array.isArray(value)) return value.length && value.every((x) => isObject(x) && typeof x.query === 'string' && typeof x.should_trigger === 'boolean') ? 'skill-creator-triggers' : null;
  if (!isObject(value)) return null;
  if (value.schema === EVALS_SCHEMA) return 'synabun-evals/1';
  if (!Array.isArray(value.evals)) return null;
  const hasExpectations = value.evals.some((c) => isObject(c) && Array.isArray(c.expectations));
  const hasAssertions = value.evals.some((c) => isObject(c) && Array.isArray(c.assertions));
  if (hasExpectations && !hasAssertions) return 'skill-creator-tasks';
  if (hasAssertions && !hasExpectations) return 'agent-skills-tasks';
  if (hasAssertions && hasExpectations) return 'skill-creator-tasks';   // case by case below: equal lists pass, others are refused
  return 'agent-skills-tasks';
}

/** A lowercase slug of a text (an id from a prompt or a query), at most `max` characters. */
export function slugOf(text, max = 48) {
  const s = normalizedCaseText(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return /^[a-z0-9]/.test(s) ? s : `case-${s || 'x'}`.slice(0, max);
}

/** A seeded pseudo-random generator (mulberry32): the same seed, the same split. */
function seeded(seed) {
  let a = (Number(seed) >>> 0) || 42;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(list, rnd) { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }

/**
 * The split of each item of one stratum: one item trains; two give train and validation; three or more keep at least
 * one of each, with about a fifth held out and a fifth for validation.
 */
export function splitStratum(ids, { seed = 42 } = {}) {
  const order = shuffle(ids, seeded(seed));
  const n = order.length;
  const out = new Map();
  if (!n) return out;
  let test = n >= 3 ? Math.max(1, Math.round(n * SPLIT_SHARES.test)) : 0;
  let validation = n >= 2 ? Math.max(1, Math.round(n * SPLIT_SHARES.validation)) : 0;
  while (n - test - validation < 1) { if (test > validation && test > 0) test -= 1; else if (validation > 0) validation -= 1; else break; }
  order.forEach((id, i) => out.set(id, i < test ? 'test' : i < test + validation ? 'validation' : 'train'));
  return out;
}

const textOf = (a) => (typeof a === 'string' ? a : isObject(a) && typeof a.text === 'string' ? a.text : null);
function sameList(a, b) { return a.length === b.length && a.every((x, i) => normalizedCaseText(textOf(x)) === normalizedCaseText(textOf(b[i]))); }

/**
 * Import other tools' suites into one synabun-evals/1 suite.
 * @param {{ tasks?: string|object, triggers?: string|object[], skillName?: string, seed?: number }} input any of the two
 *   (text or parsed); a synabun-evals/1 suite passes through, checked
 * @returns {{ ok: boolean, evals: object|null, dialects: string[], problems: {code, message}[], notes: string[] }}
 */
export function importEvals({ tasks = null, triggers = null, skillName = '', seed = 42 } = {}) {
  const problems = [];
  const notes = [];
  const dialects = [];
  const parse = (x, label) => {
    if (x === null || x === undefined || x === '') return null;
    if (typeof x !== 'string') return x;
    try { return JSON.parse(x.replace(/^﻿/, '')); } catch (e) { problems.push({ code: 'json', message: `${label} is not valid JSON (${e?.message || e}).` }); return undefined; }
  };
  const t = parse(tasks, 'The task file');
  const g = parse(triggers, 'The trigger set');
  if (t === undefined || g === undefined) return { ok: false, evals: null, dialects, problems, notes };
  if (t === null && g === null) return { ok: false, evals: null, dialects, problems: [{ code: 'empty', message: 'Nothing to import: give a task file, a trigger set, or both.' }], notes };
  // A SynaBun suite as it is (with a trigger set beside it, the trigger set is refused: one suite, one source).
  if (t !== null && detectDialect(t) === 'synabun-evals/1') {
    if (g !== null) return { ok: false, evals: null, dialects: ['synabun-evals/1'], problems: [{ code: 'two-suites', message: 'A SynaBun suite already has its trigger cases: import it alone.' }], notes };
    const checked = validateEvals(t, { skillName });
    return { ok: checked.ok, evals: checked.ok ? t : null, dialects: ['synabun-evals/1'], problems: checked.errors.map((e) => ({ code: e.code, message: `${e.path}: ${e.message}` })), notes: checked.warnings.map((w) => w.message) };
  }
  const taskCases = [];
  if (t !== null) {
    const d = detectDialect(t);
    if (!d || d === 'skill-creator-triggers') problems.push({ code: 'dialect', message: d === 'skill-creator-triggers' ? 'The task file is a trigger set: give it as the trigger set.' : 'The task file is neither the skill-creator\'s nor the Agent Skills guide\'s format ({ "evals": [ … ] }).' });
    else {
      dialects.push(d);
      t.evals.forEach((c, i) => {
        if (!isObject(c)) { problems.push({ code: 'shape', message: `evals[${i}] is not an object.` }); return; }
        const exp = Array.isArray(c.expectations) ? c.expectations : null;
        const asr = Array.isArray(c.assertions) ? c.assertions : null;
        if (exp && asr && !sameList(exp, asr)) { problems.push({ code: 'ambiguous-dialect', message: `evals[${i}] has both "assertions" and "expectations" and they differ: say which list is meant (keep one).` }); return; }
        if (typeof c.prompt !== 'string' || !c.prompt.trim()) { problems.push({ code: 'empty', message: `evals[${i}] has no prompt.` }); return; }
        const checks = (exp || asr || []).map(textOf);
        if (checks.some((x) => x === null || !x.trim())) { problems.push({ code: 'assertion', message: `evals[${i}] has an empty or unreadable assertion.` }); return; }
        const rawId = c.id === undefined || c.id === null ? '' : String(c.id);
        taskCases.push({ rawId, prompt: c.prompt, expected: typeof c.expected_output === 'string' ? c.expected_output : '', files: Array.isArray(c.files) ? c.files.filter((f) => typeof f === 'string') : [], assertions: checks.map((x) => x.trim()) });
      });
    }
  }
  const triggerCases = [];
  if (g !== null) {
    const d = detectDialect(g);
    if (d !== 'skill-creator-triggers') problems.push({ code: 'dialect', message: 'The trigger set is not the skill-creator\'s format (a JSON array of { "query", "should_trigger" }).' });
    else {
      dialects.push(d);
      g.forEach((c) => { if (c.query.trim()) triggerCases.push({ query: c.query, shouldTrigger: c.should_trigger }); });
    }
  }
  if (problems.length) return { ok: false, evals: null, dialects, problems, notes };
  // One case per request: a repeat with the same label is dropped (said so); with another label, refused.
  const seen = new Map();
  const keep = (text, label, what) => {
    const key = normalizedCaseText(text);
    if (!seen.has(key)) { seen.set(key, label); return true; }
    if (seen.get(key) !== label) problems.push({ code: 'conflicting-labels', message: `The same request appears twice with different labels: "${text.slice(0, 80)}".` });
    else notes.push(`A repeated ${what} was kept once: "${text.slice(0, 80)}".`);
    return false;
  };
  const tasksKept = taskCases.filter((c) => keep(c.prompt, 'task', 'task'));
  const triggersKept = triggerCases.filter((c) => keep(c.query, c.shouldTrigger ? 'positive' : 'near-miss', 'trigger'));
  if (problems.length) return { ok: false, evals: null, dialects, problems, notes };
  // Stable ids: the source's own (as a slug) when it has one, else a slug of the text; never two the same.
  const used = new Set();
  const unique = (base) => { let id = base || 'case'; let i = 2; while (used.has(id)) id = `${base.slice(0, 58)}-${i++}`; used.add(id); return id; };
  const tasksOut = tasksKept.map((c) => ({ ...c, id: unique(c.rawId ? (/^\d+$/.test(c.rawId) ? `eval-${c.rawId}` : slugOf(c.rawId)) : slugOf(c.prompt)) }));
  const triggersOut = triggersKept.map((c) => ({ ...c, id: unique(slugOf(c.query)) }));
  const splitOf = new Map([
    ...splitStratum(tasksOut.map((c) => c.id), { seed }),
    ...splitStratum(triggersOut.filter((c) => c.shouldTrigger).map((c) => c.id), { seed: seed + 1 }),
    ...splitStratum(triggersOut.filter((c) => !c.shouldTrigger).map((c) => c.id), { seed: seed + 2 }),
  ]);
  const evals = {
    schema: EVALS_SCHEMA,
    skill_name: skillName || (isObject(t) && typeof t.skill_name === 'string' ? t.skill_name : ''),
    evals: tasksOut.map((c) => ({ id: c.id, group: c.id, split: splitOf.get(c.id), prompt: c.prompt, expected_output: c.expected, files: c.files, assertions: c.assertions })),
    triggers: triggersOut.map((c) => ({ id: c.id, group: c.id, split: splitOf.get(c.id), query: c.query, should_trigger: c.shouldTrigger })),
  };
  const checked = validateEvals(evals, { skillName: evals.skill_name });
  if (!checked.ok) return { ok: false, evals: null, dialects, problems: checked.errors.map((e) => ({ code: e.code, message: `${e.path}: ${e.message}` })), notes };
  notes.push(...checked.warnings.map((w) => w.message));
  return { ok: true, evals, dialects, problems: [], notes };
}

/**
 * A SynaBun suite in the skill-creator's files: the task file (expectations), the trigger set of the cases an
 * optimiser may select on (train and validation), and the held-out trigger cases apart.
 * → { tasks: { skill_name, evals }, triggerSet: [{ query, should_trigger }], heldOut: [{ query, should_trigger }] }
 */
export function exportSkillCreator(suite) {
  const evals = Array.isArray(suite?.evals) ? suite.evals : [];
  const triggers = Array.isArray(suite?.triggers) ? suite.triggers : [];
  return {
    tasks: {
      skill_name: suite?.skill_name || '',
      evals: evals.map((c, i) => ({ id: i + 1, prompt: c.prompt, expected_output: c.expected_output || '', files: c.files || [], expectations: (c.assertions || []).map(textOf).filter(Boolean) })),
    },
    triggerSet: triggers.filter((c) => c.split !== 'test').map((c) => ({ query: c.query, should_trigger: c.should_trigger })),
    heldOut: triggers.filter((c) => c.split === 'test').map((c) => ({ query: c.query, should_trigger: c.should_trigger })),
  };
}

const CONFIG_NAME = { candidate: 'with_skill' };
/** The skill-creator's configuration name of a trial: with_skill, and without_skill or old_skill (a revision baseline). */
export function configurationName(trial, run) {
  if (trial.configuration === 'candidate') return CONFIG_NAME.candidate;
  return run?.request?.baseline === 'revision' ? 'old_skill' : 'without_skill';
}
/** A stable id of a trial in the skill-creator's layout: never two the same (the trial id is part of it). */
export const exportRunId = (trial, run) => `eval-${trial.caseId}-${configurationName(trial, run)}-run-${trial.repetition}-${trial.trialId}`;

/** A trial's grading.json in the skill-creator's shape (unverifiable exported as not passed, said in the evidence). */
export function exportGrading(trial) {
  const rows = (trial?.grade?.assertions || []).filter((a) => a.status !== 'error');
  const expectations = rows.map((a) => ({ text: a.text, passed: a.status === 'passed', evidence: a.status === 'unverifiable' ? `unverifiable: ${a.evidence || ''}`.trim() : (a.evidence || '') }));
  const passed = expectations.filter((e) => e.passed).length;
  return { expectations, summary: { passed, failed: expectations.length - passed, total: expectations.length, pass_rate: expectations.length ? passed / expectations.length : null } };
}

const signed = (x, digits) => (x === null || x === undefined ? null : `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`);
const statBlock = (s) => (s ? { mean: s.mean, stddev: s.sd, min: s.min, max: s.max } : null);

/**
 * A run in the skill-creator's benchmark.json shape: one entry per graded task trial, the actual repetitions and
 * models, run_summary per configuration and the delta (with_skill minus the baseline configuration) as signed text.
 * Tokens are not measured as tokens here, so they are null (never characters); a run without a baseline has no delta.
 */
export function exportBenchmark(run) {
  const trials = (run?.trials || []).filter((t) => t.kind === 'task' && t.status === 'completed');
  const runs = trials.map((t) => {
    const g = exportGrading(t);
    return {
      eval_id: t.caseId, configuration: configurationName(t, run), run_number: t.repetition, run_id: exportRunId(t, run),
      result: { pass_rate: g.summary.pass_rate, passed: g.summary.passed, failed: g.summary.failed, total: g.summary.total, time_seconds: Number.isFinite(t.durationMs) ? t.durationMs / 1000 : null, tokens: null, tool_calls: Array.isArray(t.toolCalls) ? t.toolCalls.length : null, errors: t.grade?.counts?.error ?? null, cost_usd: Number.isFinite(t.costUsd) ? t.costUsd : null },
      expectations: g.expectations, notes: [],
    };
  });
  const configs = [...new Set(runs.map((r) => r.configuration))];
  const summary = {};
  for (const c of configs) {
    const mine = runs.filter((r) => r.configuration === c);
    summary[c] = { pass_rate: statBlock(stats(mine.map((r) => r.result.pass_rate))), time_seconds: statBlock(stats(mine.map((r) => r.result.time_seconds))), tokens: null };
  }
  const base = configs.find((c) => c !== 'with_skill') || null;
  if (summary.with_skill && base && summary[base]) {
    const d = (k) => (summary.with_skill[k]?.mean !== undefined && summary[base][k]?.mean !== undefined ? summary.with_skill[k].mean - summary[base][k].mean : null);
    summary.delta = { pass_rate: signed(d('pass_rate'), 2), time_seconds: signed(d('time_seconds'), 1), tokens: null, against: base };
  }
  const reps = [...new Set(trials.map((t) => t.repetition))].length || null;
  return {
    metadata: {
      skill_name: run?.skill?.name || '', skill_path: null,
      executor_model: [...new Set(trials.map((t) => { const r = t.actualRuntime || t.runtime; return `${r.provider}${r.model ? `/${r.model}` : ''}`; }))].join(', ') || null,
      analyzer_model: [...new Set(trials.map((t) => t.grade?.grader).filter((r) => r?.provider).map((r) => `${r.provider}${r.model ? `/${r.model}` : ''}`))].join(', ') || null,
      timestamp: run?.finishedAt || run?.createdAt || null,
      evals_run: [...new Set(trials.map((t) => t.caseId))],
      runs_per_configuration: reps,
      synabun: { evalRunId: run?.evalRunId || null, revisionId: run?.skill?.revisionId || null, suiteDigest: run?.suite?.digest || null, experiment: run?.experiment?.digest || null, orientation: 'with_skill-minus-baseline' },
    },
    runs, run_summary: summary, notes: [],
  };
}

/** The reviewer's notes in the skill-creator's feedback.json shape: every trial, an empty note where there is none. */
export function exportFeedback(run) {
  const fb = isObject(run?.feedback) ? run.feedback : {};
  const reviews = (run?.trials || []).filter((t) => t.kind === 'task').map((t) => ({ run_id: exportRunId(t, run), feedback: fb[t.trialId]?.text || '', timestamp: fb[t.trialId]?.at || null }));
  const reviewed = (run?.trials || []).filter((t) => t.kind === 'task').every((t) => fb[t.trialId]?.reviewed === true);
  return { reviews, status: reviewed && reviews.length ? 'complete' : 'in_progress' };
}

/** A run in the Agent Skills evaluation guide's shape: assertion_results per run, numeric deltas. */
export function exportAgentSkills(run) {
  const trials = (run?.trials || []).filter((t) => t.kind === 'task' && t.status === 'completed');
  const runs = trials.map((t) => ({
    eval_id: t.caseId, configuration: configurationName(t, run), run: t.repetition,
    assertion_results: (t.grade?.assertions || []).filter((a) => a.status !== 'error').map((a) => ({ assertion: a.text, passed: a.status === 'passed', evidence: a.evidence || '' })),
    pass_rate: t.grade?.passRate ?? null,
  }));
  const rate = (c) => stats(runs.filter((r) => r.configuration === c).map((r) => r.pass_rate));
  const w = rate('with_skill');
  const baseName = runs.some((r) => r.configuration === 'old_skill') ? 'old_skill' : 'without_skill';
  const b = rate(baseName);
  return {
    skill_name: run?.skill?.name || '', runs,
    benchmark: { with_skill: { pass_rate: w?.mean ?? null, n: w?.n ?? 0 }, [baseName]: { pass_rate: b?.mean ?? null, n: b?.n ?? 0 }, delta: { pass_rate: w && b ? w.mean - b.mean : null } },
  };
}

export { EVAL_SPLITS };

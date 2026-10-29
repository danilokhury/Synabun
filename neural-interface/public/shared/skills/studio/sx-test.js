// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Test tab, what it decides (P4)
// ═══════════════════════════════════════════
//
// Everything the Test tab decides without a page (sx-test-view.js draws it): whether this workspace can be tested
// and which version is, the form and its defaults (one press of Run evals runs the train and validation cases once on
// the first runtime that can, against no skill, within $3 and 30 minutes), the request it sends, the runtime and model
// choices (the server's runtimes, the Assistant's one model catalog), and what a run shows: the headline per runtime,
// the case rows, the trigger rows, the suite notes, whether a result is stale, the history and the trial navigation.
// Strings are the view's (skillsStudio.test.*): this module returns codes and numbers.

import { EVALS_PATH, readSuite } from '../ss-evals.js';
import { BUDGET_CHOICES, EVAL_DEFAULTS, MINUTE_CHOICES, REPETITION_CHOICES, isActiveEvalRun, runtimeKey, suiteCounts } from '../ss-eval-plan.js';
import { staleness } from '../ss-eval-grade.js';
import { optimiserSplits } from '../ss-eval-optimise.js';

export { isActiveEvalRun, BUDGET_CHOICES, MINUTE_CHOICES, REPETITION_CHOICES };
export const TEST_KIND_CHOICES = Object.freeze(['both', 'task', 'trigger']);
export const BASELINE_CHOICES = Object.freeze(['no-skill', 'revision', 'off']);
export const EXPORT_FORMATS = Object.freeze(['native', 'skill-creator', 'agent-skills']);
export const TEST_FORM_KEY = 'skills-studio-test-form';
const PROVIDERS = ['claude-code', 'codex', 'opencode'];


/** Label an executed runtime and retain a visibly different requested target. */
export function executionLabel(t, actual, requested, label = r => `${r.provider}${r.model ? `/${r.model}` : ''}`) {
  const requests = (Array.isArray(requested) ? requested : [requested]).filter(Boolean);
  const shown = label(actual || requests[0] || {});
  const different = requests.filter(r => r.provider !== actual?.provider || (r.model || null) !== (actual?.model || null));
  return different.length && actual ? t('skillsStudio.test.runtimeActual', { actual: shown, requested: different.map(label).join(', ') }) : shown;
}

/** API errors are codes, never server prose. Unknown failures keep a diagnostic code in the page's language. */
export function testErrorText(t, error) {
  const code = error?.code || error?.body?.code;
  const keys = {
    WORKER_BROWSER: 'workerBrowser',
    PAGE_SECRET_REQUIRED: 'pageSession', UI_HEADER_REQUIRED: 'pageSession',
    GUEST_FORBIDDEN: 'owner', UI_ONLY: 'owner', WORKERS_NOT_PERMITTED: 'owner',
    ASSISTANT_CREDENTIAL_REQUIRED: 'owner', OWNER_REQUIRED: 'owner',
    runtime_unavailable: 'unavailable', grader_unavailable: 'unavailable',
    model_unavailable: 'unavailable', MODEL_UNKNOWN: 'unavailable', MODEL_DISABLED: 'unavailable',
    codex_not_confirmed: 'codex', not_found: 'missing', revision_not_found: 'missing',
    queue_full: 'queueFull', evals_unavailable: 'notReady', suite_invalid: 'suite',
    optimise_unavailable: 'optimise', time_below_estimate: 'time',
  };
  if (keys[code]) return t(`skillsStudio.test.errors.${keys[code]}`);
  return t('skillsStudio.test.errors.request', { code: typeof code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code : 'network' });
}

/**
 * A problem of the suite the page words in its own language: the skillsStudio.test.head.* string and its values for a
 * test file a runtime would load by itself (its settings or code, an instruction file at the top of the test folder,
 * a name another file system reads as another file's), or null (the problem's own words are shown).
 */
export function suiteErrorCopy(e) {
  if (!e || typeof e.file !== 'string' || !e.file) return null;
  if (e.code === 'file-config') return { key: 'skillsStudio.test.head.fixtureConfig', params: { file: e.file, name: e.name || '' } };
  if (e.code === 'file-instructions') return { key: 'skillsStudio.test.head.fixtureInstructions', params: { file: e.file, name: e.name || '' } };
  if (e.code === 'file-alias') return { key: 'skillsStudio.test.head.fixtureAlias', params: { file: e.file } };
  return null;
}

/**
 * Whether a workspace can be tested, and which version: a library skill's latest revision (the draft's unsaved or
 * unversioned changes are not in it: the tab says so). → { mode, revisionId, draftChanged }
 *   mode: 'ok' | 'older-server' (no `evals` capability yet) | 'not-library' (a folder of a runtime: add it to the
 *   library first) | 'no-revision' (a new draft with no version yet) | 'guest'
 */
export function testSubject(ws, { caps = new Set(), capsKnown = true, guest = false, changedFiles = () => [] } = {}) {
  if (guest) return { mode: 'guest', revisionId: null, draftChanged: false };
  if (capsKnown && !caps.has('evals')) return { mode: 'older-server', revisionId: null, draftChanged: false };
  const s = ws?.subject || {};
  if (s.readsFiles !== 'library' || !ws.skill) return { mode: 'not-library', revisionId: null, draftChanged: false, canAdopt: !!s.canAdopt };
  const revisionId = ws.skill.pointers?.latest || ws.revision?.revisionId || null;
  if (!revisionId) return { mode: 'no-revision', revisionId: null, draftChanged: false };
  const draftChanged = !!(ws.draft && ws.revision && changedFiles(ws.revision.manifest?.files || [], ws.draft.files || []).length);
  return { mode: 'ok', revisionId, draftChanged };
}

/** Whether the tested version has test prompts (its manifest names evals/evals.json). */
export const hasSuite = (revision) => !!(revision?.manifest?.files || []).some((f) => f.path === EVALS_PATH);

/** The suite as the page reads it (the same reader as the server): cases, counts, errors, warnings. */
export function readSuiteText(text, { skillName = '', description = '' } = {}) {
  const read = readSuite(String(text ?? ''), { skillName, description });
  return { ok: read.ok, errors: read.errors, warnings: read.warnings, cases: read.cases, counts: suiteCounts(read.cases) };
}

/** What the suite allows: a final check needs held-out cases; an optimisation a positive and a near-miss to train on and a validation case. */
export function suiteAllows(cases) {
  const list = cases || [];
  const optimise = optimiserSplits(list);
  return {
    run: list.some((c) => c.split !== 'test'),
    final: list.some((c) => c.split === 'test'),
    optimise: optimise.problems.length === 0,
    optimiseProblems: optimise.problems,
    tasks: list.some((c) => c.kind === 'task' && c.split !== 'test'),
    triggers: list.some((c) => c.kind === 'trigger' && c.split !== 'test'),
  };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A runtime the owner opts into per skill version (Codex: its shell can read files anywhere on the computer). */
export const isOptInRuntime = (provider, options = null) => provider === 'codex' || !!(options?.runtimes || []).find((r) => r.provider === provider && r.optIn);

/**
 * The form, from what was kept and what the server can run: the first runtime that can start (Claude Code first; never
 * an opt-in one such as Codex, which the owner picks each time), its cheap default model, both kinds, no-skill
 * baseline, once, $3, 30 minutes, blind comparisons where the cases ask.
 */
export function defaultForm(options, stored = null) {
  const runtimes = (options?.runtimes || []).filter((r) => r.available);
  const first = runtimes.find((r) => !isOptInRuntime(r.provider, options))?.provider || runtimes[0]?.provider || 'claude-code';
  const s = isObject(stored) ? stored : {};
  const keepRuntime = (v) => typeof v === 'string' && runtimes.some((r) => r.provider === v.split('|')[0]) && !isOptInRuntime(v.split('|')[0], options);
  const picks = Array.isArray(s.runtimes) ? s.runtimes.filter(keepRuntime).slice(0, 3) : [];
  return {
    kinds: TEST_KIND_CHOICES.includes(s.kinds) ? s.kinds : 'both',
    runtimes: picks.length ? [...new Set(picks)] : [first],
    baseline: BASELINE_CHOICES.includes(s.baseline) ? s.baseline : EVAL_DEFAULTS.baseline,
    baselineRevisionId: typeof s.baselineRevisionId === 'string' ? s.baselineRevisionId : '',
    taskReps: REPETITION_CHOICES.includes(s.taskReps) ? s.taskReps : EVAL_DEFAULTS.repetitions.task,
    triggerReps: REPETITION_CHOICES.includes(s.triggerReps) ? s.triggerReps : EVAL_DEFAULTS.repetitions.trigger,
    grader: typeof s.grader === 'string' && (s.grader === '' || keepRuntime(s.grader)) ? s.grader : '',
    budgetUsd: BUDGET_CHOICES.includes(s.budgetUsd) ? s.budgetUsd : EVAL_DEFAULTS.budgetUsd,
    maxMinutes: MINUTE_CHOICES.includes(s.maxMinutes) ? s.maxMinutes : EVAL_DEFAULTS.maxMinutes,
    judge: s.judge !== false,
  };
}

/** What of a form is kept between openings (no revision ids of one skill leak into another's form; Codex is not kept). */
export const storedForm = (form) => ({ kinds: form.kinds, runtimes: form.runtimes.filter((v) => !isOptInRuntime(String(v).split('|')[0])), baseline: form.baseline === 'revision' ? 'no-skill' : form.baseline, taskReps: form.taskReps, triggerReps: form.triggerReps, grader: isOptInRuntime(String(form.grader || '').split('|')[0]) ? '' : form.grader, budgetUsd: form.budgetUsd, maxMinutes: form.maxMinutes, judge: form.judge });

/** Whether a form puts Codex to work (a runtime row, or the grader). */
export const formUsesCodex = (form) => (form?.runtimes || []).some((v) => String(v).split('|')[0] === 'codex') || String(form?.grader || '').split('|')[0] === 'codex';

/**
 * What the Test tab says about Codex for a form and its estimate: null when the form does not use Codex, else
 * { confirmed, at (when the newest confirmation was made), revisionIds (the versions to confirm: the tested one, and
 * the earlier one it is compared with on Codex) }. Unknown until the estimate says: not confirmed.
 */
export function codexStatus(form, estimate, { revisionId = null } = {}) {
  if (!formUsesCodex(form)) return null;
  const c = estimate?.codex;
  const revisions = Array.isArray(c?.revisions) && c.revisions.length ? c.revisions : [{ revisionId, trusted: false, at: null }];
  const at = revisions.map((r) => r.at).filter(Boolean).sort().pop() || null;
  return { confirmed: c ? c.confirmed === true : false, at, revisionIds: revisions.map((r) => r.revisionId).filter(Boolean), pending: revisions.filter((r) => !r.trusted).map((r) => r.revisionId).filter(Boolean) };
}

/**
 * The safety lines of the Test tab, per runtime the form uses (codes; the view words them): 'held' for Claude Code
 * and OpenCode (only the skill under test, the folder, a shell with no network and no home folder), 'codex' for Codex.
 */
export function safetyLines(form, options = null) {
  const used = [...new Set((form?.runtimes || []).map((v) => String(v).split('|')[0]).filter(Boolean))];
  const known = (options?.runtimes || []).map((r) => r.provider);
  return used.filter((p) => !known.length || known.includes(p)).map((provider) => ({ provider, code: isOptInRuntime(provider, options) ? 'codex' : 'held', shell: (options?.runtimes || []).find((r) => r.provider === provider)?.shell === true }));
}

/** A runtime value of the form ("provider" or "provider|model") as the request names it. */
export function runtimeOf(value) {
  const [provider, ...rest] = String(value || '').split('|');
  const model = rest.join('|');
  return PROVIDERS.includes(provider) ? { provider, ...(model ? { model } : {}) } : null;
}

/**
 * The request a press sends. `purpose`: 'evals' (Run evals), 'final' (the held-out check), 'optimise' (the
 * description: triggers only, three repetitions, one runtime). `caseIds`: a rerun of some cases.
 */
export function requestOf(form, { revisionId, purpose = 'evals', caseIds = null } = {}) {
  const runtimes = form.runtimes.map(runtimeOf).filter(Boolean);
  const body = { revisionId, purpose, runtimes: purpose === 'optimise' ? runtimes.slice(0, 1) : runtimes, budgetUsd: form.budgetUsd, maxMinutes: form.maxMinutes, judge: form.judge };
  if (purpose !== 'optimise') {
    body.kinds = form.kinds === 'both' ? ['task', 'trigger'] : [form.kinds];
    body.baseline = form.baseline;
    if (form.baseline === 'revision' && form.baselineRevisionId) body.baselineRevisionId = form.baselineRevisionId;
    body.repetitions = { task: form.taskReps, trigger: form.triggerReps };
  } else body.repetitions = { trigger: Math.max(3, form.triggerReps) };
  if (form.grader) body.grader = runtimeOf(form.grader);
  if (Array.isArray(caseIds) && caseIds.length) body.caseIds = caseIds;
  return body;
}

/**
 * A runtime dropdown's entries: per provider its default (the server's cheap model) and the catalog's models; a
 * provider that cannot run here is one greyed line with its reason. `words`: { provider(p), providerDefault(p, model),
 * providerOff(p, reason) }.
 */
export function runtimeEntries({ options, catalog = null, selected = '', words, allowNone = false, noneLabel = '' }) {
  const entries = allowNone ? [{ value: '', label: noneLabel, selected: !selected }] : [];
  for (const row of options?.runtimes || []) {
    const p = row.provider;
    if (!row.available) { entries.push({ group: words.provider(p), options: [{ value: p, label: words.providerOff(p, row.reason || ''), disabled: true, selected: false }] }); continue; }
    const options_ = [{ value: p, label: words.providerDefault(p, row.defaultModel || ''), selected: selected === p }];
    for (const m of (Array.isArray(catalog?.[p]) ? catalog[p] : []).slice(0, 60)) {
      if (!m?.id || m.status === 'unavailable') continue;
      const value = `${p}|${m.id}`;
      options_.push({ value, label: String(m.label || m.id), selected: selected === value });
    }
    entries.push({ group: words.provider(p), options: options_ });
  }
  if (selected && !entries.some((e) => (e.options || [e]).some((o) => o.value === selected))) {
    const r = runtimeOf(selected);
    if (r) entries.push({ value: selected, label: `${words.provider(r.provider)}${r.model ? ` · ${r.model}` : ''}`, selected: true });
  }
  return entries;
}

/** The trials of a run grouped for its live list: per case, its trials in order. */
export function trialGroups(run) {
  const groups = new Map();
  for (const t of run?.trials || []) {
    const key = `${t.kind}:${t.caseId}`;
    if (!groups.has(key)) groups.set(key, { kind: t.kind, caseId: t.caseId, split: t.split, trials: [] });
    groups.get(key).trials.push(t);
  }
  return [...groups.values()];
}

/** The state word of a trial for its dot and its label: running, passed, failed, picked, skipped… */
export function trialTone(t) {
  if (t.status === 'running') return 'running';
  if (t.status === 'pending') return 'pending';
  if (['skipped', 'cancelled'].includes(t.status)) return 'skipped';
  if (t.status !== 'completed') return 'error';
  if (t.kind === 'trigger') {
    const o = t.trigger?.observed ?? t.observed;
    if (o === null || o === undefined) return 'error';
    return o === t.expected || (t.expected === undefined && o) ? 'pass' : 'fail';
  }
  const rate = t.grade?.passRate ?? t.passRate;
  if (rate === null || rate === undefined) return 'neutral';
  return rate >= 0.999 ? 'pass' : rate > 0 ? 'partial' : 'fail';
}

/** How long a run has worked so far, in seconds. */
export function elapsedSeconds(run, now = Date.now()) {
  const from = Date.parse(run?.startedAt || run?.createdAt || '');
  if (!Number.isFinite(from)) return 0;
  const to = run?.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, Math.round((to - from) / 1000));
}
export const clockText = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * What a finished (or partial) run shows: one headline per runtime, the task case rows, the trigger rows, the notes
 * about the suite, and why it is stale. Numbers are left as numbers (or null: not measured).
 */
export function reportModel(run, { latestRevisionId = null, latestSuiteDigest = null } = {}) {
  const summary = run?.summary || { runtimes: [], notes: [] };
  const stale = staleness(run, { latestRevisionId, latestSuiteDigest });
  return {
    stale,
    runtimes: (summary.runtimes || []).map((r) => ({
      key: r.key, provider: r.provider, model: r.model, requestedRuntimes: r.requestedRuntimes || [],
      task: r.task ? {
        candidate: r.task.candidate?.mean ?? null, baseline: r.task.baseline?.mean ?? null, delta: r.task.delta, pairs: r.task.pairs,
        n: r.task.candidate?.n || 0, sd: r.task.candidate?.sd ?? null,
        cases: r.task.cases.map((c) => ({ ...c, candidateRate: c.candidate?.mean ?? null, baselineRate: c.baseline?.mean ?? null })),
      } : null,
      trigger: r.trigger,
      preference: r.preference, costUsd: r.costUsd, durationMs: r.durationMs?.mean ?? null, failedRuns: r.failedRuns, skipped: r.skipped,
    })),
    notes: summary.notes || [],
    baseline: run?.request?.baseline || 'no-skill',
  };
}

/** A history row: the run, whether it tested the version as it is now, its headline numbers. */
export function historyRows(list, { latestRevisionId = null, latestSuiteDigest = null } = {}) {
  return (list || []).map((r) => {
    const first = r.summary?.runtimes?.[0] || null;
    return {
      evalRunId: r.evalRunId, state: r.state, createdAt: r.createdAt, purpose: r.request?.purpose || 'evals',
      runtimeDetails: r.summary?.runtimes?.length ? r.summary.runtimes : r.request?.runtimes || [],
      runtimes: (r.summary?.runtimes?.length ? r.summary.runtimes : r.request?.runtimes || []).map(runtimeKey), costUsd: r.spend?.usd ?? null,
      stale: staleness(r, { latestRevisionId, latestSuiteDigest }), revisionId: r.skill?.revisionId || null,
      task: first?.task ? { candidate: first.task.candidate?.mean ?? null, baseline: first.task.baseline?.mean ?? null, delta: first.task.delta } : null,
      trigger: first?.trigger ? { passed: first.trigger.passed, total: first.trigger.queries } : null,
      optimise: r.optimise || null, queuePosition: r.queuePosition || null, progress: r.progress || null,
    };
  });
}

/** The trial after (dir 1) or before (dir -1) one, among a run's trials that ran, wrapping around. */
export function trialStep(run, trialId, dir = 1) {
  const list = (run?.trials || []).filter((t) => !['pending', 'skipped', 'cancelled'].includes(t.status));
  if (!list.length) return null;
  const at = list.findIndex((t) => t.trialId === trialId);
  if (at < 0) return list[0].trialId;
  return list[(at + dir + list.length) % list.length].trialId;
}

/**
 * The same case in the previous finished run of the skill (its answer beside this one's): the newest earlier run with a
 * trial of the same case, configuration and runtime. → { evalRunId, trialId } or null. `runs` are full views.
 */
export function previousTrial(runs, current, trial) {
  const earlier = (runs || []).filter((r) => r.evalRunId !== current.evalRunId && Date.parse(r.createdAt) < Date.parse(current.createdAt) && Array.isArray(r.trials))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const r of earlier) {
    const t = r.trials.find((x) => x.caseId === trial.caseId && x.configuration === trial.configuration && runtimeKey(x.runtime) === runtimeKey(trial.runtime) && x.status === 'completed');
    if (t) return { evalRunId: r.evalRunId, trialId: t.trialId };
  }
  return null;
}

/** The cases of a run worth running again: task cases that failed an assertion or did not finish, triggers read wrong or not at all. */
export function rerunCases(run) {
  const ids = new Set();
  for (const t of run?.trials || []) {
    if (t.configuration !== 'candidate' || t.split === 'test') continue;
    const tone = trialTone(t);
    if (['fail', 'partial', 'error'].includes(tone)) ids.add(t.caseId);
  }
  return [...ids];
}

/** A pass rate (0…1) as whole percent text; null as an em dash. */
export const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);
/** A difference of pass rates as signed percentage points. */
export const pts = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}`);
/** Dollars with two decimals (four under a cent). */
export const money = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : `$${Number(x) < 0.01 && Number(x) > 0 ? Number(x).toFixed(4) : Number(x).toFixed(2)}`);

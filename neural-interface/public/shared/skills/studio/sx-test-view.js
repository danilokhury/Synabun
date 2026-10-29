// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Test tab (P4)
// ═══════════════════════════════════════════
//
// A library skill's evaluations (lib/skills/evals.js over /api/skills-studio/v2/evals): one obvious action, Run evals
// (⌘/Ctrl+Enter), with defaults that are cheap (the train and validation cases once, on the first runtime that can, its
// cheapest model, against no skill, within $3 and 30 minutes) and an estimate that follows the form; the run's progress
// with its spend against its ceiling and Cancel; then the report: per runtime the task cases with and without the skill
// (candidate minus baseline, paired), the trigger queries (positives and near-misses), the notes about the suite; each
// trial opened beside its request (the answer, the files it wrote, the assertions collapsed with their evidence, the
// previous run's answer, the owner's note, saved as it is typed and acknowledged); the history of the skill's runs,
// two compared, a run exported. Also: the final check on the held-out cases, the description optimiser, and the import
// of another tool's test prompts into the draft. Every answer is fenced by the window's generation and the tab's own
// signal, and redraws only its part (never a field being typed in). Strings: skillsStudio.test.*.

import { dropdownHTML, wireDropdowns } from '../../cc-dropdown.js';
import { html, raw, setHTML, ICONS, relativeTime, fullTime, formatBytes, idempotencyKey } from './sx-dom.js';
import { changedFiles } from './sx-diff.js';
import { EVALS_PATH } from '../ss-evals.js';
import { importEvals } from '../ss-eval-adapters.js';
import { executedRuntime } from '../ss-eval-grade.js';
import {
  BASELINE_CHOICES, BUDGET_CHOICES, EXPORT_FORMATS, MINUTE_CHOICES, REPETITION_CHOICES, TEST_FORM_KEY, TEST_KIND_CHOICES,
  executionLabel as labelExecution, clockText, codexStatus, defaultForm, elapsedSeconds, hasSuite, historyRows, isActiveEvalRun, isOptInRuntime, money, pct, previousTrial, pts,
  readSuiteText, reportModel, requestOf, rerunCases, runtimeEntries, safetyLines, storedForm, suiteAllows, suiteErrorCopy, testErrorText, testSubject, trialGroups, trialStep, trialTone,
} from './sx-test.js';

let _life = null;
const live = (panel, signal) => !signal.aborted && panel.isConnected;

/** The tab is left (another tab, another place, the window closed): its listeners, timers and polls end. */
export function leaveTestTab() { _life?.abort(); _life = null; }

function stateOf(ws) {
  if (!ws.test) {
    ws.test = {
      options: null, optionsError: null, catalog: null, suite: null, suiteError: null, suiteFor: null,
      history: null, historyError: null, form: null, estimate: null, estimateError: null, estimating: false, estimateSeq: 0,
      openId: null, run: null, runFull: false, trialId: null, trial: null, trialError: null, previous: null,
      compare: new Set(), comparison: null, starting: false, notice: null, feedbackState: {}, exportFormat: 'native',
    };
  }
  return ws.test;
}

function readStored(ctx) { try { return JSON.parse(ctx.storage.getItem(TEST_FORM_KEY) || 'null'); } catch { return null; } }
function keepForm(ctx, form) { try { ctx.storage.setItem(TEST_FORM_KEY, JSON.stringify(storedForm(form))); } catch { /* the form is still used */ } }

// ── Words ──

const providerName = (t, p) => t(`skillsStudio.test.provider.${p}`);
function runtimeWords(ctx) {
  const { t } = ctx;
  return {
    provider: (p) => providerName(t, p),
    providerDefault: (p, model) => (model ? t('skillsStudio.test.setup.providerDefaultModel', { provider: providerName(t, p), model }) : t('skillsStudio.test.setup.providerDefault', { provider: providerName(t, p) })),
    providerOff: (p, reason) => t('skillsStudio.test.setup.providerOff', { provider: providerName(t, p), reason }),
  };
}
const runtimeLabel = (t, r) => `${providerName(t, r.provider)}${r.model ? ` · ${r.model}` : ''}`;
const executionLabel = (t, actual, requested) => labelExecution(t, actual, requested, r => runtimeLabel(t, r));

function stateWord(t, state) { return t(`skillsStudio.test.state.${state}`); }
function minutesText(t, est) { return est.minutes.low === est.minutes.high ? t('skillsStudio.test.estimate.minutesOne', { n: est.minutes.low }) : t('skillsStudio.test.estimate.minutes', { low: est.minutes.low, high: est.minutes.high }); }

// ── Drawing ──

/** Draw the Test tab. */
export function renderTestTab(panel, ctx, ws) {
  _life?.abort();
  _life = new AbortController();
  const signal = _life.signal;
  const { t } = ctx;
  const st = stateOf(ws);
  const subject = testSubject(ws, { caps: ctx.caps, capsKnown: ctx.capsKnown, guest: ctx.guest, changedFiles });
  if (subject.mode !== 'ok') { drawUnavailable(panel, ctx, ws, subject, signal); return; }
  if (!hasSuite(ws.revision)) { drawNoSuite(panel, ctx, ws, signal); return; }
  st.revisionId = subject.revisionId;
  st.draftChanged = subject.draftChanged;
  if (!st.form) st.form = defaultForm(st.options, readStored(ctx));
  setHTML(panel, html`<div class="sx-test" data-test-state="${st.run?.state || 'idle'}">
    <div class="sx-test-scroll" id="sx-test-scroll">
      <section class="sx-test-section" id="sx-test-head" aria-labelledby="sx-test-title">${headHTML(ctx, ws, st)}</section>
      <section class="sx-test-section sx-test-setup" id="sx-test-setup" aria-label="${t('skillsStudio.test.setup.title')}">${setupHTML(ctx, ws, st)}</section>
      <section class="sx-test-section" id="sx-test-run" aria-live="polite">${runHTML(ctx, ws, st)}</section>
      <section class="sx-test-section" id="sx-test-trial">${trialHTML(ctx, ws, st)}</section>
      <section class="sx-test-section" id="sx-test-history" aria-labelledby="sx-test-history-title">${historyHTML(ctx, ws, st)}</section>
    </div>
    <div class="sx-test-bar" id="sx-test-bar">${barHTML(ctx, ws, st)}</div>
  </div>`);
  wireDropdowns(panel, { signal });
  wire(panel, ctx, ws, signal);
  load(panel, ctx, ws, signal);
}

function drawUnavailable(panel, ctx, ws, subject, signal) {
  const { t } = ctx;
  const words = {
    'older-server': [t('skillsStudio.test.unavailable.olderTitle'), t('skillsStudio.test.unavailable.older')],
    'not-library': [t('skillsStudio.test.unavailable.notLibraryTitle'), t('skillsStudio.test.unavailable.notLibrary')],
    'no-revision': [t('skillsStudio.test.unavailable.noRevisionTitle'), t('skillsStudio.test.unavailable.noRevision')],
    guest: [t('skillsStudio.test.unavailable.guestTitle'), t('skillsStudio.test.unavailable.guest')],
  }[subject.mode];
  setHTML(panel, html`<div class="sx-empty" role="status"><span class="sx-placeholder-icon" aria-hidden="true">${ICONS.test}</span>
    <h4 class="sx-empty-title">${words[0]}</h4><p>${words[1]}</p>
    ${subject.mode === 'not-library' && subject.canAdopt && !ctx.guest ? html`<button type="button" class="sx-btn sx-btn--primary" data-test="adopt">${t('skillsStudio.ws.adoptNow')}</button>` : ''}
    ${subject.mode === 'no-revision' && !ctx.guest ? html`<button type="button" class="sx-btn sx-btn--primary" data-test="go-versions">${t('skillsStudio.test.unavailable.saveVersion')}</button>` : ''}</div>`);
  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('[data-test]');
    if (!btn) return;
    if (btn.dataset.test === 'adopt') { const { adoptNow } = await import('./sx-actions.js'); adoptNow(ctx, ws); }
    if (btn.dataset.test === 'go-versions') { ws.tab = 'versions'; ctx.render(); }
  }, { signal });
}

function drawNoSuite(panel, ctx, ws, signal) {
  const { t } = ctx;
  const st = stateOf(ws);
  setHTML(panel, html`<div class="sx-test"><div class="sx-test-scroll"><div class="sx-empty sx-test-empty" role="status">
    <span class="sx-placeholder-icon" aria-hidden="true">${ICONS.test}</span>
    <h4 class="sx-empty-title">${t('skillsStudio.test.noSuite.title')}</h4>
    <p>${t('skillsStudio.test.noSuite.body', { path: EVALS_PATH })}</p>
    <div class="sx-row sx-test-empty-actions">
      ${ctx.guest ? '' : html`<button type="button" class="sx-btn sx-btn--primary" data-test="import">${ICONS.upload}<span>${t('skillsStudio.test.import.button')}</span></button>`}
      <button type="button" class="sx-btn" data-test="go-edit">${t('skillsStudio.test.noSuite.edit')}</button>
    </div>
    <p class="sx-help">${t('skillsStudio.test.import.help')}</p>
    <div id="sx-test-import" class="sx-test-import">${st.importPreview ? importHTML(ctx, st) : ''}</div>
  </div></div></div>`);
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-test]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.test === 'go-edit') { ws.tab = 'edit'; ctx.render(); return; }
    if (btn.dataset.test === 'import') pickImport(panel, ctx, ws, signal);
    if (btn.dataset.test === 'import-save') saveImport(panel, ctx, ws, signal);
    if (btn.dataset.test === 'import-drop') { st.importPreview = null; const box = panel.querySelector('#sx-test-import'); if (box) setHTML(box, ''); }
  }, { signal });
}

function headHTML(ctx, ws, st) {
  const { t, tp } = ctx;
  const counts = st.suite?.counts || null;
  const rev = ws.revision;
  const lines = [];
  if (st.draftChanged) lines.push(html`<p class="sx-note sx-note--warn" role="note">${ICONS.warn} ${t('skillsStudio.test.head.draftChanged')} <button type="button" class="sx-link" data-test="save-version">${t('skillsStudio.ws.saveVersion')}</button></p>`);
  if (st.suite && !st.suite.ok) {
    lines.push(html`<div class="sx-note sx-note--warn" role="alert"><p>${tp('skillsStudio.test.head.suiteErrors', st.suite.errors.length)}</p>
      <ul class="sx-plain-list">${st.suite.errors.slice(0, 3).map((e) => html`<li><code>${e.path}</code> ${suiteErrorText(ctx, e)}</li>`)}</ul>
      <button type="button" class="sx-btn sx-btn--sm" data-test="go-edit">${t('skillsStudio.test.head.fixInEdit')}</button></div>`);
  }
  if (st.suiteError) lines.push(html`<p class="sx-note sx-note--warn" role="alert">${t('skillsStudio.test.head.suiteUnread', { error: st.suiteError })}</p>`);
  const q = st.options?.queue;
  const waiting = q ? q.waiting.filter((w) => w.skill?.skillId !== ws.skill?.skillId || w.evalRunId !== st.openId) : [];
  return html`<div class="sx-test-headline">
      <h4 class="sx-section-title" id="sx-test-title">${ICONS.test}<span>${t('skillsStudio.test.title')}</span></h4>
      <span class="sx-tag" title="${rev?.revisionId || ''}">${t('skillsStudio.test.head.version', { id: String(rev?.contentDigest || '').replace(/^sha256:/, '').slice(0, 8) })}</span>
      <span class="sx-spacer"></span>
      ${q && (q.active.length || q.waiting.length) ? html`<span class="sx-test-queue" id="sx-test-queue">${tp('skillsStudio.test.queue.busy', q.active.length + waiting.length)}</span>` : ''}
    </div>
    <p class="sx-help" id="sx-test-suite-line">${counts
      ? html`${tp('skillsStudio.test.head.tasks', counts.task)} · ${tp('skillsStudio.test.head.triggers', counts.trigger)}${counts.trigger ? html` (${t('skillsStudio.test.head.polarity', { positive: counts.positive, nearMiss: counts.nearMiss })})` : ''} · ${tp('skillsStudio.test.head.held', counts.held)}`
      : t('skillsStudio.test.head.reading')}</p>
    <div class="sx-test-safety-box" id="sx-test-safety">${safetyHTML(ctx, st)}</div>
    ${fixturesHTML(ctx, st)}
    ${lines}`;
}

/**
 * What happens to a case's test files, said once under the safety lines: the files refused (a runtime would load them
 * by itself), what each runtime does with an instruction file deeper in the folder, git and the no-symlink shell rule.
 */
function fixturesHTML(ctx, st) {
  const { t } = ctx;
  return html`<details class="sx-details sx-test-fixtures" id="sx-test-fixtures"${st.fixturesOpen ? ' open' : ''}><summary>${t('skillsStudio.test.fixtures.title')}</summary>
    <p class="sx-help">${t('skillsStudio.test.fixtures.refused')}</p>
    <p class="sx-help">${t('skillsStudio.test.fixtures.nested')}</p>
    <p class="sx-help">${t('skillsStudio.test.fixtures.git')}</p>
    <p class="sx-help">${t('skillsStudio.test.fixtures.symlinks')}</p>
    <p class="sx-help">${t('skillsStudio.test.fixtures.symlinkWorkaround')}</p></details>`;
}

/** A problem of the suite as the page words it (a test file a runtime would load is said in the page's language). */
function suiteErrorText(ctx, e) {
  const copy = suiteErrorCopy(e);
  return copy ? ctx.t(copy.key, copy.params) : e.message;
}

/**
 * What keeps a run safe, said truthfully per runtime the form uses: Claude Code and OpenCode load only the skill under
 * test and work in the run's folder (a shell, where a case asks, with no network and no home folder); Codex's shell can
 * read anywhere, so it runs only versions the owner confirms.
 */
function safetyHTML(ctx, st) {
  const { t } = ctx;
  const rows = st.form ? safetyLines(st.form, st.options) : [];
  return html`<p class="sx-help sx-test-safety">${ICONS.lock} <span>${t('skillsStudio.test.head.safety')}</span></p>
    ${rows.map((r) => html`<p class="sx-help sx-test-safety${r.code === 'codex' ? ' sx-test-safety--warn' : ''}" data-provider="${r.provider}">${r.code === 'codex' ? ICONS.warn : ICONS.lock} <span>${r.code === 'codex'
      ? t('skillsStudio.test.head.safetyCodex')
      : html`${t('skillsStudio.test.head.safetyHeld', { provider: providerName(t, r.provider) })}${r.shell ? html` ${t('skillsStudio.test.head.safetyShell')}` : ''}`}</span></p>`)}`;
}

/** Codex's state for the form: the estimate's, else the last one seen while the next estimate is on its way. */
const codexNow = (st) => codexStatus(st.form, st.estimate || (st.codexSeen ? { codex: st.codexSeen } : null), { revisionId: st.revisionId });

/** The Codex line under the setup while the form uses Codex: the warning, and the one-click confirmation of the version. */
function codexHTML(ctx, st) {
  const { t } = ctx;
  const c = codexNow(st);
  if (!c) return '';
  return html`<div class="sx-note sx-note--warn sx-test-codex" role="note" id="sx-test-codex" aria-live="polite">
    <p class="sx-test-codex-line">${ICONS.warn}<strong>${t('skillsStudio.test.codex.warning')}</strong></p>
    ${c.confirmed
      ? html`<p class="sx-help">${c.at ? t('skillsStudio.test.codex.confirmedAt', { when: relativeTime(c.at, ctx.locale) }) : t('skillsStudio.test.codex.confirmed')} <button type="button" class="sx-link" data-test="codex-undo"${st.codexBusy ? ' disabled' : ''}>${t('skillsStudio.test.codex.undo')}</button></p>`
      : html`<p class="sx-help">${t(c.revisionIds.length > 1 ? 'skillsStudio.test.codex.askBoth' : 'skillsStudio.test.codex.ask')}</p>
        <div class="sx-row"><button type="button" class="sx-btn sx-btn--sm" data-test="codex-confirm"${st.codexBusy || !st.estimate ? ' disabled' : ''}>${ICONS.ok}<span>${t('skillsStudio.test.codex.confirm')}</span></button></div>`}
  </div>`;
}

function setupHTML(ctx, ws, st) {
  const { t } = ctx;
  const f = st.form;
  const words = runtimeWords(ctx);
  const allows = suiteAllows(st.suite?.cases || []);
  const dd = (id, entries, label) => raw(dropdownHTML(id, entries, { label, classes: 'sx-dd' }));
  const runtimeRows = f.runtimes.map((value, i) => html`<div class="sx-test-runtime" data-index="${i}">
      ${dd(`sx-test-runtime-${i}`, runtimeEntries({ options: st.options, catalog: st.catalog, selected: value, words }), t('skillsStudio.test.setup.runtime'))}
      ${i > 0 ? html`<button type="button" class="sx-icon-btn sx-icon-btn--sm" data-test="remove-runtime" data-index="${i}" aria-label="${t('skillsStudio.test.setup.removeRuntime')}" title="${t('skillsStudio.test.setup.removeRuntime')}">${ICONS.close}</button>` : ''}
    </div>`);
  // The skill's other versions, newest first (a baseline can be one of them).
  const revisions = (Array.isArray(st.revisions) ? st.revisions : []).filter((r) => r.revisionId !== st.revisionId);
  const kindsDisabled = (k) => (k === 'task' && !allows.tasks) || (k === 'trigger' && !allows.triggers);
  // Open while nothing has run yet (or when the owner opened it); folded to one line over a report, so the results are
  // in view and Run evals (the foot bar) still runs these settings.
  const open = st.setupOpen ?? !(st.run || (st.history && st.history.length));
  const firstRuntime = f.runtimes[0] ? runtimeOfValue(f.runtimes[0]) : null;
  const summary = [t(`skillsStudio.test.setup.kinds.${f.kinds}`), ...(firstRuntime ? [runtimeLabel(t, { provider: firstRuntime.provider, model: firstRuntime.model || (st.options?.runtimes || []).find((r) => r.provider === firstRuntime.provider)?.defaultModel || null })] : []), ...(f.runtimes.length > 1 ? [`+${f.runtimes.length - 1}`] : []), t(`skillsStudio.test.setup.baselines.${f.baseline}`), t('skillsStudio.test.setup.budgetN', { n: f.budgetUsd }), t('skillsStudio.test.setup.minutesN', { n: f.maxMinutes })].join(' · ');
  return html`<details class="sx-test-setup-box" id="sx-test-setup-box"${open ? ' open' : ''}><summary class="sx-test-setup-summary"><span class="sx-section-title">${t('skillsStudio.test.setup.title')}</span> <span class="sx-dim sx-test-setup-line">${summary}</span></summary>
    <div class="sx-test-grid">
      <div class="sx-field"><span class="sx-field-label" id="sx-test-kinds-label">${t('skillsStudio.test.setup.what')}</span>
        <div class="sx-seg" role="group" aria-labelledby="sx-test-kinds-label">${TEST_KIND_CHOICES.map((k) => html`<button type="button" data-test="kinds" data-value="${k}" aria-pressed="${f.kinds === k ? 'true' : 'false'}"${k !== 'both' && kindsDisabled(k) ? ' disabled' : ''}>${t(`skillsStudio.test.setup.kinds.${k}`)}</button>`)}</div></div>
      <div class="sx-field sx-test-runtimes"><span class="sx-field-label">${t('skillsStudio.test.setup.runtime')}</span>${runtimeRows}
        ${f.runtimes.length < 3 && (st.options?.runtimes || []).filter((r) => r.available).length ? html`<button type="button" class="sx-link sx-test-add" data-test="add-runtime">${ICONS.plus}<span>${t('skillsStudio.test.setup.addRuntime')}</span></button>` : ''}</div>
      <div class="sx-field"><span class="sx-field-label" id="sx-test-baseline-label">${t('skillsStudio.test.setup.baseline')}</span>
        ${dd('sx-test-baseline', BASELINE_CHOICES.map((b) => ({ value: b, label: t(`skillsStudio.test.setup.baselines.${b}`), selected: f.baseline === b, disabled: b === 'revision' && !revisions.length })), t('skillsStudio.test.setup.baseline'))}
        ${f.baseline === 'revision' && revisions.length ? dd('sx-test-baseline-rev', revisions.map((r, i) => ({ value: r.revisionId, label: t('skillsStudio.test.setup.versionN', { n: `${String(r.contentDigest || '').replace(/^sha256:/, '').slice(0, 8)} · ${relativeTime(r.createdAt, ctx.locale)}` }), selected: f.baselineRevisionId ? f.baselineRevisionId === r.revisionId : i === 0 })), t('skillsStudio.test.setup.baselineVersion')) : ''}</div>
      <div class="sx-field"><span class="sx-field-label">${t('skillsStudio.test.setup.ceilings')}</span>
        <div class="sx-row">${dd('sx-test-budget', BUDGET_CHOICES.map((v) => ({ value: String(v), label: t('skillsStudio.test.setup.budgetN', { n: v }), selected: f.budgetUsd === v })), t('skillsStudio.test.setup.budget'))}
        ${dd('sx-test-minutes', MINUTE_CHOICES.map((v) => ({ value: String(v), label: t('skillsStudio.test.setup.minutesN', { n: v }), selected: f.maxMinutes === v })), t('skillsStudio.test.setup.minutes'))}</div></div>
    </div>
    <details class="sx-details sx-test-more"${st.moreOpen ? ' open' : ''}><summary data-test="more">${t('skillsStudio.test.setup.more')}</summary>
      <div class="sx-test-grid">
        <div class="sx-field"><span class="sx-field-label">${t('skillsStudio.test.setup.taskReps')}</span>${dd('sx-test-task-reps', REPETITION_CHOICES.map((v) => ({ value: String(v), label: String(v), selected: f.taskReps === v })), t('skillsStudio.test.setup.taskReps'))}</div>
        <div class="sx-field"><span class="sx-field-label">${t('skillsStudio.test.setup.triggerReps')}</span>${dd('sx-test-trigger-reps', REPETITION_CHOICES.map((v) => ({ value: String(v), label: String(v), selected: f.triggerReps === v })), t('skillsStudio.test.setup.triggerReps'))}</div>
        <div class="sx-field"><span class="sx-field-label">${t('skillsStudio.test.setup.grader')}</span>${dd('sx-test-grader', runtimeEntries({ options: st.options, catalog: st.catalog, selected: f.grader, words, allowNone: true, noneLabel: t('skillsStudio.test.setup.graderAuto') }), t('skillsStudio.test.setup.grader'))}</div>
        <label class="sx-choice sx-test-judge"><input type="checkbox" class="sx-check" id="sx-test-judge"${f.judge ? ' checked' : ''}> <span>${t('skillsStudio.test.setup.judge')}</span></label>
      </div>
      <p class="sx-help">${t('skillsStudio.test.setup.moreHelp')}</p>
    </details>
    </details>
    <div id="sx-test-codex-box">${codexHTML(ctx, st)}</div>
    <div class="sx-test-estimate" id="sx-test-estimate" role="status">${estimateHTML(ctx, st)}</div>`;
}

/** A runtime value of the form as { provider, model }. */
function runtimeOfValue(value) { const [provider, ...rest] = String(value || '').split('|'); return { provider, model: rest.join('|') || null }; }

function estimateHTML(ctx, st) {
  const { t, tp } = ctx;
  if (st.estimateError) return html`<p class="sx-help sx-err-text">${st.estimateError}</p>`;
  const e = st.estimate;
  if (!e) return html`<p class="sx-help">${st.estimating ? t('skillsStudio.test.estimate.working') : t('skillsStudio.test.estimate.none')}</p>`;
  const est = e.estimate;
  const money_ = est.free ? t('skillsStudio.test.estimate.free') : est.usd.high > 0 ? t('skillsStudio.test.estimate.usd', { low: money(est.usd.low), high: money(est.usd.high) }) : t('skillsStudio.test.estimate.unpricedOnly');
  const notes = (e.notes || []).map((n) => {
    if (n.code === 'contamination') return t('skillsStudio.test.estimate.contamination', { provider: providerName(t, n.provider), paths: (n.paths || []).join(', ') });
    if (n.code === 'grader-not-independent') return t('skillsStudio.test.estimate.notIndependent', { provider: providerName(t, n.provider) });
    if (n.code === 'skipped') return t(`skillsStudio.test.estimate.skipped.${n.reason === 'needs-shell' ? 'shell' : 'other'}`, { caseId: n.caseId });
    return null;
  }).filter(Boolean);
  return html`<p class="sx-test-estimate-line">${ICONS.info}<span>${tp('skillsStudio.test.estimate.runs', est.runs)} · ${money_}${est.mayExceedByOneStep && !est.free ? html` <span class="sx-dim">(${t('skillsStudio.test.estimate.oneStep')})</span>` : ''} · ${minutesText(t, est)}${est.unpriced.length ? html` · <span class="sx-dim">${t('skillsStudio.test.estimate.unpriced', { names: est.unpriced.join(', ') })}</span>` : ''}</span></p>
    ${e.ceiling ? html`<p class="sx-help sx-warn-text">${t(`skillsStudio.test.estimate.ceiling.${e.ceiling.code === 'time-below-estimate' ? 'time' : 'budget'}`)}</p>` : ''}
    ${e.grader ? html`<p class="sx-help">${t('skillsStudio.test.estimate.grader', { grader: runtimeLabel(t, e.grader) })}${e.grader.independent ? '' : html` <span class="sx-warn-text">${t('skillsStudio.test.estimate.graderSame')}</span>`}</p>` : ''}
    ${notes.length ? html`<ul class="sx-plain-list sx-test-notes">${notes.map((n) => html`<li>${n}</li>`)}</ul>` : ''}`;
}

function barHTML(ctx, ws, st) {
  const { t } = ctx;
  if (ctx.guest) return html`<span class="sx-help">${t('skillsStudio.test.bar.guest')}</span>`;
  const allows = suiteAllows(st.suite?.cases || []);
  const running = st.run && isActiveEvalRun(st.run.state);
  const blocked = !st.suite || !st.suite.ok || !allows.run;
  const noRuntime = st.options && !(st.options.runtimes || []).some((r) => r.available);
  const ceilingBlocked = !!st.estimate?.ceiling;
  // Codex runs a version only once the owner allowed it (the line under the setup).
  const codex = codexNow(st);
  const codexBlocked = !!codex && !codex.confirmed;
  const why = !st.suite ? t('skillsStudio.test.head.reading') : !st.suite.ok ? t('skillsStudio.test.bar.fixFirst') : !allows.run ? t('skillsStudio.test.bar.onlyHeld') : noRuntime ? t('skillsStudio.test.bar.noRuntime') : codexBlocked ? t('skillsStudio.test.bar.codexFirst') : ceilingBlocked ? t('skillsStudio.test.bar.raiseCeiling') : running ? t('skillsStudio.test.bar.running') : t('skillsStudio.test.bar.ready');
  const off = blocked || noRuntime || st.starting || ceilingBlocked || codexBlocked;
  return html`<span class="sx-test-bar-text sx-help" id="sx-test-bar-text">${why}</span>
    ${allows.optimise ? html`<button type="button" class="sx-btn" data-test="optimise"${off || running ? ' disabled' : ''} title="${t('skillsStudio.test.bar.optimiseHelp')}">${ICONS.spark}<span>${t('skillsStudio.test.bar.optimise')}</span></button>` : ''}
    ${allows.final ? html`<button type="button" class="sx-btn" data-test="final"${off || running ? ' disabled' : ''} title="${t('skillsStudio.test.bar.finalHelp')}">${ICONS.lock}<span>${t('skillsStudio.test.bar.final')}</span></button>` : ''}
    <button type="button" class="sx-btn sx-btn--primary sx-btn--lg" id="sx-test-run-btn" data-test="run"${off ? ' disabled' : ''} aria-describedby="sx-test-bar-text" aria-keyshortcuts="${ctx.mac ? 'Meta+Enter' : 'Control+Enter'}">${ICONS.test}<span>${st.starting ? t('skillsStudio.test.bar.starting') : running ? t('skillsStudio.test.bar.runAgain') : t('skillsStudio.test.bar.run')}</span> <kbd>${ctx.mac ? '⌘↵' : 'Ctrl+↵'}</kbd></button>`;
}

// ── The open run ──

function runHTML(ctx, ws, st) {
  const { t } = ctx;
  const run = st.run;
  if (st.notice) return html`<div class="sx-outcome sx-outcome--error" role="alert"><p class="sx-outcome-line">${ICONS.warn}<span>${st.notice}</span></p></div>`;
  if (!run) return html`<p class="sx-help">${st.history && !st.history.length ? t('skillsStudio.test.run.none') : ''}</p>`;
  const active = isActiveEvalRun(run.state);
  const purpose = run.request?.purpose || 'evals';
  const spent = run.spend?.usd ?? 0;
  const ceiling = run.request?.budgetUsd ?? 0;
  const ratio = ceiling > 0 ? Math.min(1, spent / ceiling) : 0;
  const p = run.progress || { trials: 0, done: 0 };
  return html`<div class="sx-test-run" data-state="${run.state}" id="sx-test-run-card">
    <div class="sx-test-run-head">
      <h4 class="sx-section-title" id="sx-test-run-title" tabindex="-1">${t(`skillsStudio.test.run.title.${purpose}`)}</h4>
      <span class="sx-test-state sx-test-state--${run.state}">${stateWord(t, run.state)}</span>
      <span class="sx-spacer"></span>
      ${active ? html`<span class="sx-count" id="sx-test-clock">${clockText(elapsedSeconds(run))}</span>
        <button type="button" class="sx-btn sx-btn--sm sx-btn--danger" data-test="cancel"${st.cancelling ? ' disabled' : ''}>${st.cancelling ? t('skillsStudio.test.run.cancelling') : t('skillsStudio.test.run.cancel')}</button>` : ''}
      ${!active && run.evalRunId ? exportHTML(ctx, st) : ''}
    </div>
    <p class="sx-help">${run.queuePosition ? ctx.tp('skillsStudio.test.run.queued', run.queuePosition) : t('skillsStudio.test.run.facts', { runtimes: (run.summary?.runtimes?.length ? run.summary.runtimes : run.request?.runtimes || []).map((r) => executionLabel(t, r, r.requestedRuntimes)).join(', '), when: relativeTime(run.createdAt, ctx.locale) })}
      · <span class="sx-test-spend${ratio >= 0.9 ? ' is-over' : ''}" title="${t('skillsStudio.test.run.spendTitle')}">${t('skillsStudio.test.run.spend', { spent: money(spent), ceiling: money(ceiling) })} <span class="sx-meter" aria-hidden="true"><i style="width:${Math.round(ratio * 100)}%"></i></span></span>
      ${run.estimate ? html` · <span class="sx-dim">${t('skillsStudio.test.run.estimated', { low: money(run.estimate.usd.low), high: money(run.estimate.usd.high) })}</span>` : ''}</p>
    ${active ? progressHTML(ctx, st, p) : reportHTML(ctx, ws, st)}
    ${run.error ? html`<div class="sx-ai-error" role="alert"><p>${testErrorText(t, run.error)}</p></div>` : ''}
    ${run.stopReason ? html`<p class="sx-note sx-note--warn">${t(`skillsStudio.test.run.stopped.${run.stopReason === 'time' ? 'time' : 'budget'}`)}</p>` : ''}
  </div>`;
}

function progressHTML(ctx, st, p) {
  const { t, tp } = ctx;
  const groups = trialGroups(st.run);
  return html`<p class="sx-test-progress-line">${tp('skillsStudio.test.run.progress', p.trials, { done: p.done })}</p>
    <ul class="sx-test-live" aria-label="${t('skillsStudio.test.run.trials')}">${groups.map((g) => html`<li class="sx-test-live-case">
      <span class="sx-test-case-id">${g.caseId}</span><span class="sx-tag sx-tag--${g.split}">${t(`skillsStudio.test.split.${g.split}`)}</span>
      <span class="sx-test-dots">${g.trials.map((tr) => html`<span class="sx-test-dot sx-test-dot--${trialTone(tr)}" role="img" aria-label="${t(`skillsStudio.test.tone.${trialTone(tr)}`)} · ${t(`skillsStudio.test.config.${tr.configuration}`)}" title="${t(`skillsStudio.test.config.${tr.configuration}`)} · ${t(`skillsStudio.test.tone.${trialTone(tr)}`)}"></span>`)}</span>
    </li>`)}</ul>`;
}

function exportHTML(ctx, st) {
  const { t } = ctx;
  return html`<span class="sx-test-export">${raw(dropdownHTML('sx-test-export-format', EXPORT_FORMATS.map((f) => ({ value: f, label: t(`skillsStudio.test.export.${f}`), selected: st.exportFormat === f })), { label: t('skillsStudio.test.export.format'), classes: 'sx-dd' }))}
    <button type="button" class="sx-btn sx-btn--sm" data-test="export">${ICONS.download}<span>${t('skillsStudio.test.export.button')}</span></button></span>`;
}

function reportHTML(ctx, ws, st) {
  const { t, tp } = ctx;
  const run = st.run;
  if (!st.runFull) return html`<p class="sx-help">${t('skillsStudio.test.report.loading')}</p>`;
  const model = reportModel(run, { latestRevisionId: ws.skill?.pointers?.latest || null, latestSuiteDigest: st.suiteDigest || null });
  const parts = [];
  if (model.stale.length) parts.push(html`<p class="sx-note sx-note--warn" role="note">${ICONS.history} ${t(`skillsStudio.test.report.stale.${model.stale.includes('revision') ? 'revision' : 'suite'}`)}</p>`);
  if (run.request?.purpose === 'optimise') parts.push(optimiseHTML(ctx, ws, st));
  for (const r of model.runtimes) {
    const head = [];
    if (r.task) head.push(html`<div class="sx-test-stat"><span class="sx-test-stat-label">${t('skillsStudio.test.report.task')}</span>
      <span class="sx-test-stat-value">${pct(r.task.candidate)}</span><span class="sx-dim">${t('skillsStudio.test.report.withSkill')}</span>
      ${model.baseline !== 'off' ? html`<span class="sx-test-stat-vs">${pct(r.task.baseline)} <span class="sx-dim">${t(model.baseline === 'revision' ? 'skillsStudio.test.report.withEarlier' : 'skillsStudio.test.report.withoutSkill')}</span></span>
        <span class="sx-test-delta sx-test-delta--${r.task.delta === null ? 'none' : r.task.delta > 0.0001 ? 'up' : r.task.delta < -0.0001 ? 'down' : 'flat'}" title="${t('skillsStudio.test.report.deltaTitle')}">${pts(r.task.delta)} ${t('skillsStudio.test.report.points')}</span>
        <span class="sx-dim">${tp('skillsStudio.test.report.pairs', r.task.pairs)}</span>` : ''}</div>`);
    if (r.trigger) head.push(html`<div class="sx-test-stat"><span class="sx-test-stat-label">${t('skillsStudio.test.report.trigger')}</span>
      <span class="sx-test-stat-value">${r.trigger.passed}/${r.trigger.queries}</span><span class="sx-dim">${t('skillsStudio.test.report.queriesRight')}</span>
      <span class="sx-dim">${t('skillsStudio.test.report.polarity', { pos: `${r.trigger.positives.passed}/${r.trigger.positives.total}`, neg: `${r.trigger.nearMisses.passed}/${r.trigger.nearMisses.total}` })}</span>
      ${r.trigger.unread ? html`<span class="sx-warn-text">${tp('skillsStudio.test.report.unread', r.trigger.unread)}</span>` : ''}</div>`);
    if (r.preference) head.push(html`<div class="sx-test-stat"><span class="sx-test-stat-label">${t('skillsStudio.test.report.preference')}</span><span class="sx-test-stat-value">${r.preference.passed}/${r.preference.total}</span></div>`);
    parts.push(html`<article class="sx-test-runtime-report" aria-label="${executionLabel(t, r, r.requestedRuntimes)}">
      <h5 class="sx-test-runtime-name">${executionLabel(t, r, r.requestedRuntimes)} <span class="sx-dim">· ${money(r.costUsd)}${r.durationMs ? ` · ${Math.round(r.durationMs / 1000)} s` : ''}${r.failedRuns ? ` · ${tp('skillsStudio.test.report.failedRuns', r.failedRuns)}` : ''}</span></h5>
      <div class="sx-test-stats">${head}</div>
      ${r.task ? taskTableHTML(ctx, st, r, model) : ''}
      ${r.trigger ? triggerTableHTML(ctx, st, r) : ''}
    </article>`);
  }
  if (model.notes.length) {
    parts.push(html`<details class="sx-details sx-test-suite-notes"><summary>${tp('skillsStudio.test.report.notes', model.notes.length)}</summary>
      <ul class="sx-plain-list">${model.notes.map((n) => html`<li>${t(`skillsStudio.test.note.${n.code}`, { caseId: n.caseId, assertionId: n.assertionId || '' })}</li>`)}</ul></details>`);
  }
  const again = rerunCases(run);
  if (again.length && !ctx.guest && run.request?.purpose !== 'optimise') parts.push(html`<p class="sx-row"><button type="button" class="sx-btn sx-btn--sm" data-test="rerun">${ICONS.update}<span>${ctx.tp('skillsStudio.test.report.rerun', again.length)}</span></button></p>`);
  if (!model.runtimes.length && run.request?.purpose !== 'optimise') parts.push(html`<p class="sx-help">${t('skillsStudio.test.report.empty')}</p>`);
  return html`${parts}`;
}

const runKey = (rt) => `${rt.provider}${rt.model ? `/${rt.model}` : ''}`;

function taskTableHTML(ctx, st, r, model) {
  const { t } = ctx;
  const trials = st.run.trials || [];
  return html`<table class="sx-test-table"><caption class="sx-visually-hidden">${t('skillsStudio.test.report.taskCases')}</caption>
    <thead><tr><th scope="col">${t('skillsStudio.test.report.case')}</th><th scope="col">${t('skillsStudio.test.report.colWith')}</th>${model.baseline !== 'off' ? html`<th scope="col">${t(model.baseline === 'revision' ? 'skillsStudio.test.report.colEarlier' : 'skillsStudio.test.report.colWithout')}</th><th scope="col">${t('skillsStudio.test.report.change')}</th>` : ''}<th scope="col"><span class="sx-visually-hidden">${t('skillsStudio.test.report.open')}</span></th></tr></thead>
    <tbody>${r.task.cases.map((c) => {
      // The report groups by the runtime that ran (executedRuntime), so a trial is found by the same key.
      const first = trials.find((x) => x.caseId === c.caseId && x.configuration === 'candidate' && runKey(executedRuntime(x)) === r.key);
      const verdict = c.comparison ? (c.comparison.candidate > c.comparison.baseline ? 'candidate' : c.comparison.baseline > c.comparison.candidate ? 'baseline' : c.comparison.tie ? 'tie' : 'inconclusive') : null;
      return html`<tr>
        <th scope="row"><span class="sx-test-case-id">${c.caseId}</span> <span class="sx-tag sx-tag--${c.split}">${t(`skillsStudio.test.split.${c.split}`)}</span>${verdict ? html` <span class="sx-tag" title="${t('skillsStudio.test.report.judgedTitle')}">${t(`skillsStudio.test.judged.${verdict}`)}</span>` : ''}</th>
        <td>${pct(c.candidateRate)}</td>
        ${model.baseline !== 'off' ? html`<td>${pct(c.baselineRate)}</td><td><span class="sx-test-delta sx-test-delta--${c.outcome === 'better' ? 'up' : c.outcome === 'worse' ? 'down' : c.outcome === 'same' ? 'flat' : 'none'}">${c.outcome === 'n/a' ? '—' : `${pts(c.delta)} · ${t(`skillsStudio.test.outcome.${c.outcome}`)}`}</span></td>` : ''}
        <td>${first ? html`<button type="button" class="sx-btn sx-btn--sm sx-btn--ghost" data-test="open-trial" data-trial="${first.trialId}">${t('skillsStudio.test.report.open')}</button>` : ''}</td>
      </tr>`;
    })}</tbody></table>`;
}

function triggerTableHTML(ctx, st, r) {
  const { t } = ctx;
  const trials = st.run.trials || [];
  return html`<table class="sx-test-table"><caption class="sx-visually-hidden">${t('skillsStudio.test.report.triggerCases')}</caption>
    <thead><tr><th scope="col">${t('skillsStudio.test.report.query')}</th><th scope="col">${t('skillsStudio.test.report.expected')}</th><th scope="col">${t('skillsStudio.test.report.reading')}</th><th scope="col">${t('skillsStudio.test.report.result')}</th><th scope="col"><span class="sx-visually-hidden">${t('skillsStudio.test.report.open')}</span></th></tr></thead>
    <tbody>${r.trigger.cases.map((c) => {
      const first = trials.find((x) => x.caseId === c.caseId && x.kind === 'trigger' && runKey(executedRuntime(x)) === r.key);
      return html`<tr>
        <th scope="row"><span class="sx-test-case-id">${c.caseId}</span> <span class="sx-tag sx-tag--${c.split}">${t(`skillsStudio.test.split.${c.split}`)}</span></th>
        <td>${t(c.expected ? 'skillsStudio.test.report.shouldPick' : 'skillsStudio.test.report.nearMiss')}</td>
        <td>${c.rate === null ? html`<span class="sx-warn-text">${t('skillsStudio.test.report.noReading')}</span>` : html`${t('skillsStudio.test.report.picked', { n: c.triggers, of: c.completed })}${c.method ? html` <span class="sx-dim" title="${t(`skillsStudio.test.method.${c.method}Help`)}">· ${t(`skillsStudio.test.method.${c.method}`)}</span>` : ''}`}</td>
        <td>${c.passed === null ? '—' : html`<span class="sx-test-pass sx-test-pass--${c.passed ? 'yes' : 'no'}">${c.passed ? ICONS.ok : ICONS.err} ${t(c.passed ? 'skillsStudio.test.report.right' : 'skillsStudio.test.report.wrong')}</span>`}</td>
        <td>${first ? html`<button type="button" class="sx-btn sx-btn--sm sx-btn--ghost" data-test="open-trial" data-trial="${first.trialId}">${t('skillsStudio.test.report.open')}</button>` : ''}</td>
      </tr>`;
    })}</tbody></table>`;
}

function optimiseHTML(ctx, ws, st) {
  const { t } = ctx;
  const o = st.run.optimise;
  if (!o) return html`<p class="sx-help">${t('skillsStudio.test.optimise.none')}</p>`;
  const score = (s) => (s && s.total ? `${s.passed}/${s.total}` : '—');
  return html`<div class="sx-test-optimise">
    <p class="sx-help">${t('skillsStudio.test.optimise.explain')}</p>
    <table class="sx-test-table"><caption class="sx-visually-hidden">${t('skillsStudio.test.optimise.title')}</caption>
      <thead><tr><th scope="col">#</th><th scope="col">${t('skillsStudio.test.optimise.description')}</th><th scope="col">${t('skillsStudio.test.optimise.train')}</th><th scope="col">${t('skillsStudio.test.optimise.validation')}</th></tr></thead>
      <tbody>${(o.iterations || []).map((it) => html`<tr class="${o.best?.n === it.n ? 'is-best' : ''}"><th scope="row">${it.n}${o.best?.n === it.n ? html` <span class="sx-label sx-label--best">${t('skillsStudio.test.optimise.best')}</span>` : ''}</th><td class="sx-test-desc">${it.description}</td><td>${score(it.train)}</td><td>${score(it.validation)}</td></tr>`)}</tbody>
    </table>
    <p class="sx-help">${o.exitReason ? t(`skillsStudio.test.optimise.exit.${['train_pass', 'max_evaluations', 'budget', 'time', 'cancelled', 'proposal_refused', 'proposer_failed', 'unpatchable'].includes(o.exitReason) ? o.exitReason : 'other'}`) : ''}
      ${o.test ? html` · ${t('skillsStudio.test.optimise.heldOut', { score: score(o.test) })}` : ''}</p>
    ${o.proposal ? html`<div class="sx-outcome" role="status"><p class="sx-outcome-line">${ICONS.spark}<span>${t('skillsStudio.test.optimise.proposed')}</span></p>
        <div class="sx-row"><button type="button" class="sx-btn sx-btn--sm sx-btn--primary" data-test="go-versions">${t('skillsStudio.test.optimise.openVersions')}</button></div></div>`
      : o.best && !o.best.original ? '' : html`<p class="sx-help">${t('skillsStudio.test.optimise.keepOriginal')}</p>`}
  </div>`;
}

// ── A trial beside its request ──

function trialHTML(ctx, ws, st) {
  const { t } = ctx;
  if (!st.trialId) return '';
  if (st.trialError) return html`<div class="sx-ai-error" role="alert"><p>${st.trialError}</p></div>`;
  const tr = st.trial;
  if (!tr) return html`<p class="sx-help">${t('skillsStudio.test.trial.loading')}</p>`;
  const c = tr.case || {};
  const fb = st.feedbackState[tr.trialId] || { text: tr.feedback?.text || '', reviewed: !!tr.feedback?.reviewed, saved: tr.feedback?.at || null, state: 'idle' };
  st.feedbackState[tr.trialId] = fb;
  return html`<div class="sx-test-trial" id="sx-test-trial-box" tabindex="-1" aria-labelledby="sx-test-trial-title">
    <div class="sx-test-run-head">
      <h4 class="sx-section-title" id="sx-test-trial-title">${t('skillsStudio.test.trial.title', { caseId: tr.caseId })}</h4>
      <span class="sx-tag">${t(`skillsStudio.test.config.${tr.configuration}`)}</span><span class="sx-tag">${executionLabel(t, tr.actualRuntime, tr.runtime)}${tr.repetition > 1 ? ` · #${tr.repetition}` : ''}</span>
      <span class="sx-spacer"></span>
      <button type="button" class="sx-icon-btn sx-icon-btn--sm" data-test="trial-prev" aria-label="${t('skillsStudio.test.trial.prev')}" title="${t('skillsStudio.test.trial.prev')}" aria-keyshortcuts="ArrowLeft">${ICONS.back}</button>
      <button type="button" class="sx-icon-btn sx-icon-btn--sm sx-test-next" data-test="trial-next" aria-label="${t('skillsStudio.test.trial.next')}" title="${t('skillsStudio.test.trial.next')}" aria-keyshortcuts="ArrowRight">${ICONS.back}</button>
      <button type="button" class="sx-icon-btn sx-icon-btn--sm" data-test="trial-close" aria-label="${t('skillsStudio.test.trial.close')}" title="${t('skillsStudio.test.trial.close')}">${ICONS.close}</button>
    </div>
    ${tr.detailMissing ? html`<p class="sx-note sx-note--warn" role="note">${ICONS.warn} ${t('skillsStudio.test.trial.detailMissing')}</p>` : ''}
    <p class="sx-help">${t(`skillsStudio.test.trialState.${tr.status}`)}${tr.costUsd !== null ? ` · ${money(tr.costUsd)}` : ''}${tr.durationMs ? ` · ${Math.round(tr.durationMs / 1000)} s` : ''}${tr.model ? ` · ${tr.model}` : ''}${tr.error ? html` · <span class="sx-err-text">${tr.error}</span>` : ''}${tr.contaminationRisk ? html` · <span class="sx-warn-text">${t('skillsStudio.test.trial.contamination')}</span>` : ''}</p>
    <div class="sx-test-side">
      <div class="sx-test-pane"><h5 class="sx-test-pane-title">${t(c.kind === 'trigger' ? 'skillsStudio.test.trial.query' : 'skillsStudio.test.trial.request')}</h5>
        <pre class="sx-pre">${c.prompt || c.query || ''}</pre>
        ${c.expected ? html`<h5 class="sx-test-pane-title">${t('skillsStudio.test.trial.expected')}</h5><pre class="sx-pre sx-pre--sm">${c.expected}</pre>` : ''}
        ${c.kind === 'trigger' ? html`<p class="sx-help">${t(c.shouldTrigger ? 'skillsStudio.test.report.shouldPick' : 'skillsStudio.test.report.nearMiss')}</p>` : ''}</div>
      <div class="sx-test-pane"><h5 class="sx-test-pane-title">${t('skillsStudio.test.trial.answer')}</h5>
        <pre class="sx-pre">${tr.answer || t('skillsStudio.test.trial.noAnswer')}</pre>
        ${tr.answerTruncated ? html`<p class="sx-help">${t('skillsStudio.test.trial.truncated')}</p>` : ''}
        ${(tr.outputs || []).length ? html`<h5 class="sx-test-pane-title">${t('skillsStudio.test.trial.files')}</h5>
          <ul class="sx-plain-list sx-test-files">${tr.outputs.map((o) => html`<li>${o.kind === 'link' ? html`<span class="sx-warn-text">${o.path} · ${t('skillsStudio.test.trial.link')}</span>` : html`<button type="button" class="sx-link" data-test="trial-file" data-path="${o.path}">${ICONS.file}<span>${o.path}</span></button> <span class="sx-dim">${formatBytes(o.bytes, ctx.locale)}</span>${o.kind === 'config' ? html` <span class="sx-warn-text">· ${t('skillsStudio.test.trial.config')}</span>` : ''}`}</li>`)}</ul>
          <div id="sx-test-file-view"></div>` : ''}</div>
    </div>
    ${tr.trigger ? html`<p class="sx-help">${tr.trigger.observed === true ? t('skillsStudio.test.trial.picked', { method: t(`skillsStudio.test.method.${tr.trigger.method || 'native_skill_tool'}`) }) : tr.trigger.observed === false ? t('skillsStudio.test.trial.notPicked') : t('skillsStudio.test.report.noReading')}${(tr.trigger.others || []).length ? ` · ${t('skillsStudio.test.trial.others', { names: tr.trigger.others.join(', ') })}` : ''}</p>` : ''}
    ${tr.grade ? html`<details class="sx-details sx-test-grade"><summary>${t('skillsStudio.test.trial.grades', { passed: tr.grade.counts.passed, total: tr.grade.graded })}${tr.grade.grader ? html` · <span class="sx-dim">${t('skillsStudio.test.trial.gradedBy', { grader: executionLabel(t, tr.grade.grader, tr.grade.grader.requestedRuntime) })}${tr.grade.grader.independent === false ? ` (${t('skillsStudio.test.estimate.graderSame')})` : ''}</span>` : ''}</summary>
      <ul class="sx-test-assertions">${tr.grade.assertions.map((a) => html`<li class="sx-test-assertion sx-test-assertion--${a.status}">
        <span class="sx-test-pass sx-test-pass--${a.status === 'passed' ? 'yes' : a.status === 'failed' ? 'no' : 'maybe'}">${a.status === 'passed' ? ICONS.ok : a.status === 'failed' ? ICONS.err : ICONS.warn} ${t(`skillsStudio.test.assertion.${a.status}`)}</span>
        <span class="sx-test-assertion-text">${a.text}</span> <span class="sx-dim">· ${t(a.by === 'check' ? 'skillsStudio.test.assertion.byCheck' : 'skillsStudio.test.assertion.byModel')}${a.kind === 'preference' ? ` · ${t('skillsStudio.test.assertion.preference')}` : ''}</span>
        ${a.evidence ? html`<p class="sx-test-evidence">${a.evidence}</p>` : ''}</li>`)}</ul></details>` : ''}
    ${st.previous ? html`<details class="sx-details sx-test-previous"><summary>${t('skillsStudio.test.trial.previous')}</summary><pre class="sx-pre sx-pre--sm">${st.previous.answer || t('skillsStudio.test.trial.noAnswer')}</pre>
      ${st.previous.feedback?.text ? html`<p class="sx-help">${t('skillsStudio.test.trial.previousNote', { note: st.previous.feedback.text })}</p>` : ''}</details>` : ''}
    ${ctx.guest ? '' : html`<div class="sx-field sx-test-feedback"><label class="sx-field-label" for="sx-test-note"><span>${t('skillsStudio.test.trial.note')}</span><span class="sx-count" id="sx-test-note-state" role="status">${feedbackWord(ctx, fb)}</span></label>
      <textarea class="sx-input sx-textarea" id="sx-test-note" rows="3" maxlength="4000" placeholder="${t('skillsStudio.test.trial.notePlaceholder')}">${fb.text}</textarea>
      <label class="sx-choice"><input type="checkbox" class="sx-check" id="sx-test-reviewed"${fb.reviewed ? ' checked' : ''}> <span>${t('skillsStudio.test.trial.reviewed')}</span></label></div>`}
  </div>`;
}

function feedbackWord(ctx, fb) {
  const { t } = ctx;
  if (fb.state === 'saving') return t('skillsStudio.test.trial.saving');
  if (fb.state === 'error') return t('skillsStudio.test.trial.saveFailed');
  if (fb.state === 'dirty') return t('skillsStudio.test.trial.unsaved');
  return fb.saved ? t('skillsStudio.test.trial.saved', { when: relativeTime(fb.saved, ctx.locale) }) : '';
}

// ── History ──

function historyHTML(ctx, ws, st) {
  const { t, tp } = ctx;
  if (st.historyError) return html`<p class="sx-help sx-err-text">${t('skillsStudio.test.history.failed', { error: st.historyError })}</p>`;
  if (!st.history) return html`<p class="sx-help">${t('skillsStudio.test.history.loading')}</p>`;
  if (!st.history.length) return html`<h4 class="sx-section-title" id="sx-test-history-title">${t('skillsStudio.test.history.title')}</h4><p class="sx-help">${t('skillsStudio.test.history.empty')}</p>`;
  const rows = historyRows(st.history, { latestRevisionId: ws.skill?.pointers?.latest || null, latestSuiteDigest: st.suiteDigest || null });
  return html`<div class="sx-test-run-head"><h4 class="sx-section-title" id="sx-test-history-title">${tp('skillsStudio.test.history.count', rows.length)}</h4><span class="sx-spacer"></span>
      <button type="button" class="sx-btn sx-btn--sm" data-test="compare"${st.compare.size === 2 ? '' : ' disabled'}>${t('skillsStudio.test.history.compare')}</button></div>
    <p class="sx-help">${t('skillsStudio.test.history.help')}</p>
    <ul class="sx-test-history">${rows.map((r) => html`<li class="sx-test-history-row${st.openId === r.evalRunId ? ' is-on' : ''}">
      <input type="checkbox" class="sx-check" data-test="pick" data-id="${r.evalRunId}" aria-label="${t('skillsStudio.test.history.pick')}"${st.compare.has(r.evalRunId) ? ' checked' : ''}>
      <button type="button" class="sx-test-history-open" data-test="open-run" data-id="${r.evalRunId}">
        <span class="sx-test-state sx-test-state--${r.state}">${stateWord(t, r.state)}</span>
        <span class="sx-test-history-what">${t(`skillsStudio.test.run.title.${r.purpose}`)} · ${r.runtimeDetails.map(r => executionLabel(t, r, r.requestedRuntimes)).join(', ')}</span>
        <span class="sx-test-history-numbers">${r.task ? html`${pct(r.task.candidate)}${r.task.delta !== null ? html` (${pts(r.task.delta)})` : ''}` : ''}${r.task && r.trigger ? ' · ' : ''}${r.trigger ? `${r.trigger.passed}/${r.trigger.total}` : ''}</span>
        ${r.stale.length ? html`<span class="sx-tag" title="${t('skillsStudio.test.history.staleTitle')}">${t('skillsStudio.test.history.stale')}</span>` : ''}
        <span class="sx-dim">${money(r.costUsd)}</span>
        <time class="sx-dim" datetime="${r.createdAt}" title="${fullTime(r.createdAt, ctx.locale)}">${relativeTime(r.createdAt, ctx.locale)}</time>
      </button></li>`)}</ul>
    <div id="sx-test-compare">${st.comparison ? comparisonHTML(ctx, st) : ''}</div>`;
}

function comparisonHTML(ctx, st) {
  const { t } = ctx;
  const c = st.comparison;
  const cell = (row, side) => (row.kind === 'task' ? pct(row[side]) : row[side] === null || row[side] === undefined ? '—' : t(row[side] ? 'skillsStudio.test.report.right' : 'skillsStudio.test.report.wrong'));
  return html`<div class="sx-test-comparison" role="region" aria-label="${t('skillsStudio.test.history.comparison')}">
    <h5 class="sx-test-pane-title">${t('skillsStudio.test.history.comparison')}</h5>
    ${!c.sameSuite ? html`<p class="sx-note sx-note--warn">${t('skillsStudio.test.history.differentSuite')}</p>` : ''}
    ${c.sameRevision ? html`<p class="sx-help">${t('skillsStudio.test.history.sameRevision')}</p>` : ''}
    <table class="sx-test-table"><thead><tr><th scope="col">${t('skillsStudio.test.report.case')}</th><th scope="col">${t('skillsStudio.test.history.runtime')}</th><th scope="col">${t('skillsStudio.test.history.older')}</th><th scope="col">${t('skillsStudio.test.history.newer')}</th><th scope="col">${t('skillsStudio.test.report.change')}</th></tr></thead>
    <tbody>${c.rows.map((row) => html`<tr><th scope="row">${row.caseId}</th><td>${row.key}</td><td>${cell(row, 'a')}</td><td>${cell(row, 'b')}</td><td><span class="sx-test-delta sx-test-delta--${row.change === null ? 'none' : row.change > 0 ? 'up' : row.change < 0 ? 'down' : 'flat'}">${row.change === null ? '—' : row.kind === 'task' ? pts(row.change) : t(row.change > 0 ? 'skillsStudio.test.outcome.better' : row.change < 0 ? 'skillsStudio.test.outcome.worse' : 'skillsStudio.test.outcome.same')}</span></td></tr>`)}</tbody></table>
  </div>`;
}

// ── Import ──

function importHTML(ctx, st) {
  const { t } = ctx;
  const p = st.importPreview;
  if (!p) return '';
  if (!p.ok) return html`<div class="sx-ai-error" role="alert"><p>${t('skillsStudio.test.import.failed')}</p><ul class="sx-plain-list">${p.problems.slice(0, 5).map((x) => html`<li>${x.message}</li>`)}</ul></div>`;
  const counts = { tasks: p.evals.evals.length, triggers: p.evals.triggers.length };
  return html`<div class="sx-outcome" role="status"><p class="sx-outcome-line">${ICONS.ok}<span>${t('skillsStudio.test.import.ready', { tasks: counts.tasks, triggers: counts.triggers, dialects: p.dialects.join(', ') })}</span></p>
    ${p.notes.length ? html`<ul class="sx-plain-list">${p.notes.slice(0, 5).map((n) => html`<li>${n}</li>`)}</ul>` : ''}
    <div class="sx-row"><button type="button" class="sx-btn sx-btn--primary sx-btn--sm" data-test="import-save">${t('skillsStudio.test.import.save', { path: EVALS_PATH })}</button><button type="button" class="sx-btn sx-btn--ghost sx-btn--sm" data-test="import-drop">${t('skillsStudio.dialog.cancel')}</button></div></div>`;
}

/** Pick one or two files (a task file, a trigger set) and convert them here, with the same reader the server uses. */
function pickImport(panel, ctx, ws, signal) {
  const st = stateOf(ws);
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])].slice(0, 2);
    if (!files.length) return;
    let tasks = null; let triggers = null;
    for (const f of files) {
      if (f.size > 1024 * 1024) { ctx.toast(ctx.t('skillsStudio.test.import.tooLarge'), 'error'); return; }
      const text = await f.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (Array.isArray(parsed)) triggers = text; else tasks = text;
    }
    if (!live(panel, signal)) return;
    st.importPreview = importEvals({ tasks, triggers, skillName: ws.row?.folderName || ws.label || '' });
    const box = panel.querySelector('#sx-test-import');
    if (box) setHTML(box, importHTML(ctx, st));
  }, { once: true });
  input.click();
}

/** The imported suite into the skill's draft as evals/evals.json (the owner then saves a version to test it). */
async function saveImport(panel, ctx, ws, signal) {
  const st = stateOf(ws);
  const p = st.importPreview;
  if (!p?.ok) return;
  const gen = ctx.gen();
  try {
    let draft = ws.draft;
    if (!draft) draft = (await ctx.api.createSkillsDraft({ skillId: ws.skill.skillId }, { idempotencyKey: ctx.key('sx-draft') })).draft;
    const out = await ctx.api.patchSkillsDraft(draft.draftId, { expectedEtag: draft.etag, ops: [{ op: 'put', path: EVALS_PATH, content: `${JSON.stringify(p.evals, null, 2)}\n` }] });
    if (!ctx.alive(gen)) return;
    ws.draft = out.draft;
    st.importPreview = null;
    ctx.toast(ctx.t('skillsStudio.test.import.saved', { path: EVALS_PATH }));
    ctx.announce(ctx.t('skillsStudio.test.import.saved', { path: EVALS_PATH }));
    await ctx.reload();
  } catch (err) { if (ctx.alive(gen) && live(panel, signal)) ctx.toast(ctx.t('skillsStudio.test.import.saveFailed', { error: testErrorText(ctx.t, err) }), 'error'); }
}

// ── Loading and following ──

async function load(panel, ctx, ws, signal) {
  const st = stateOf(ws);
  const gen = ctx.gen();
  const ok = () => ctx.alive(gen) && live(panel, signal) && ws.tab === 'test';
  const jobs = [];
  if (!st.options) {
    jobs.push(ctx.api.fetchSkillEvalOptions().then((res) => {
      st.options = res; st.optionsError = null;
      if (!st.formFromOptions) { st.form = defaultForm(res, readStored(ctx)); st.formFromOptions = true; }
      if (ok()) { redraw(panel, ctx, ws, ['setup', 'bar', 'head']); scheduleEstimate(panel, ctx, ws, signal); }
    }).catch((err) => { st.optionsError = testErrorText(ctx.t, err); if (ok()) redraw(panel, ctx, ws, ['bar']); }));
  } else scheduleEstimate(panel, ctx, ws, signal);
  if (st.suiteFor !== st.revisionId) {
    jobs.push(ctx.api.fetchSkillsRevisionFile(st.revisionId, EVALS_PATH).then((res) => {
      const head = (ws.revision?.manifest?.files || []).find((f) => f.path === EVALS_PATH);
      st.suiteDigest = head?.digest || res.digest || null;
      st.suite = readSuiteText(res.content || '', { skillName: ws.row?.folderName || '' });
      st.suiteFor = st.revisionId; st.suiteError = null;
      if (ok()) { redraw(panel, ctx, ws, ['head', 'setup', 'bar']); scheduleEstimate(panel, ctx, ws, signal); }
    }).catch((err) => { st.suiteError = testErrorText(ctx.t, err); if (ok()) redraw(panel, ctx, ws, ['head', 'bar']); }));
  }
  jobs.push(reloadHistory(panel, ctx, ws, signal));
  if (!st.revisions) {
    jobs.push(ctx.api.fetchSkillRevisions(ws.skill.skillId).then((res) => {
      st.revisions = (res.revisions || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      // A baseline revision kept from before that is not one of these goes back to the first earlier one.
      if (st.form?.baseline === 'revision' && !st.revisions.some((r) => r.revisionId === st.form.baselineRevisionId)) st.form.baselineRevisionId = st.revisions.find((r) => r.revisionId !== st.revisionId)?.revisionId || '';
      if (ok()) redraw(panel, ctx, ws, ['setup']);
    }).catch(() => { st.revisions = []; }));
  }
  if (!st.catalog) {
    jobs.push(import('../../assistant/asst-brain-picker.js').then((m) => m.loadModelCatalog()).then((catalog) => { st.catalog = catalog; if (ok()) redraw(panel, ctx, ws, ['setup']); }).catch(() => { /* the providers' defaults are still offered */ }));
  }
  await Promise.allSettled(jobs);
  if (st.openId && st.run && isActiveEvalRun(st.run.state) && ok()) follow(panel, ctx, ws, signal);
  else if (st.openId && st.run && !st.runFull && ok()) openRun(panel, ctx, ws, signal, st.openId);
}

async function reloadHistory(panel, ctx, ws, signal) {
  const st = stateOf(ws);
  const gen = ctx.gen();
  try {
    const res = await ctx.api.fetchSkillEvals({ skillId: ws.skill.skillId, limit: 30 });
    if (!ctx.alive(gen) || !live(panel, signal)) { st.history = res.evals || []; return; }
    st.history = res.evals || [];
    if (res.queue && st.options) st.options = { ...st.options, queue: res.queue };
    st.historyError = null;
    // The newest run opens by itself the first time (a running one is followed).
    if (!st.openId && st.history.length) {
      const first = st.history[0];
      st.openId = first.evalRunId;
      st.run = first; st.runFull = false;
      if (ws.tab === 'test') { redraw(panel, ctx, ws, ['run', 'bar']); if (!isActiveEvalRun(first.state)) openRun(panel, ctx, ws, signal, first.evalRunId); }
    }
    if (ws.tab === 'test') redraw(panel, ctx, ws, ['history', 'head', ...(st.run ? [] : ['run', 'setup'])]);
  } catch (err) { st.historyError = testErrorText(ctx.t, err); if (ws.tab === 'test' && live(panel, signal)) redraw(panel, ctx, ws, ['history']); }
}

/** The estimate of the form as it is, a moment after the last change (one request at a time, the last one wins). */
function scheduleEstimate(panel, ctx, ws, signal) {
  const st = stateOf(ws);
  clearTimeout(st.estimateTimer);
  if (!st.options || !st.suite?.ok || ctx.guest) return;
  st.estimateTimer = setTimeout(async () => {
    if (!live(panel, signal)) return;
    const seq = ++st.estimateSeq;
    st.estimating = true;
    redraw(panel, ctx, ws, ['estimate']);
    try {
      const res = await ctx.api.estimateSkillEval(requestOf(st.form, { revisionId: st.revisionId }));
      if (seq !== st.estimateSeq || !live(panel, signal)) return;
      st.estimate = res; st.estimateError = null;
      st.codexSeen = res.codex || null;
    } catch (err) {
      if (seq !== st.estimateSeq || !live(panel, signal)) return;
      st.estimate = null;
      st.estimateError = err.body?.problems?.[0]?.code === 'test-sealed' ? ctx.t('skillsStudio.test.errors.sealed') : testErrorText(ctx.t, err);
    }
    st.estimating = false;
    redraw(panel, ctx, ws, ['estimate', 'bar']);
  }, 350);
  signal.addEventListener('abort', () => clearTimeout(st.estimateTimer), { once: true });
}

async function start(panel, ctx, ws, signal, purpose, caseIds = null) {
  const st = stateOf(ws);
  if (st.starting || ctx.guest) return;
  const gen = ctx.gen();
  st.starting = true; st.notice = null;
  redraw(panel, ctx, ws, ['bar']);
  const form = purpose === 'optimise' ? { ...st.form, budgetUsd: Math.max(st.form.budgetUsd, 5), maxMinutes: Math.max(st.form.maxMinutes, 60) } : st.form;
  try {
    const res = await ctx.api.startSkillEval(requestOf(form, { revisionId: st.revisionId, purpose, caseIds }), { idempotencyKey: idempotencyKey('sx-eval') });
    if (!ctx.alive(gen)) return;
    st.openId = res.eval.evalRunId; st.run = res.eval; st.runFull = true; st.trialId = null; st.trial = null; st.comparison = null;
    ctx.announce(ctx.t('skillsStudio.test.run.started'));
    st.starting = false;
    if (live(panel, signal)) {
      redraw(panel, ctx, ws, ['setup', 'run', 'bar', 'trial']);
      panel.querySelector('#sx-test-run-title')?.focus({ preventScroll: false });
      follow(panel, ctx, ws, signal);
      reloadHistory(panel, ctx, ws, signal);
    }
  } catch (err) {
    st.starting = false;
    if (!ctx.alive(gen)) return;
    st.notice = startError(ctx, err);
    ctx.toast(st.notice, 'error');
    if (live(panel, signal)) redraw(panel, ctx, ws, ['run', 'bar']);
  }
}

function startError(ctx, err) {
  const { t } = ctx;
  const code = err?.code || err?.body?.code || '';
  if (code === 'budget_below_estimate') return t('skillsStudio.test.errors.budget', { low: money(err.body?.estimate?.usd?.low), high: money(err.body?.estimate?.usd?.high) });
  if (code === 'time_below_estimate') return t('skillsStudio.test.errors.time');
  if (code === 'queue_full') return t('skillsStudio.test.errors.queueFull');
  if (code === 'evals_unavailable') return t('skillsStudio.test.errors.notReady');
  if (code === 'suite_invalid') return t('skillsStudio.test.errors.suite');
  if (code === 'runtime_unavailable') return t('skillsStudio.test.errors.runtime', { error: testErrorText(t, err) });
  if (code === 'optimise_unavailable') return t('skillsStudio.test.errors.optimise');
  if (code === 'codex_not_confirmed') return t('skillsStudio.test.errors.codex');
  return t('skillsStudio.test.errors.start', { error: testErrorText(t, err) });
}

/** Follow the open run while it runs: a long poll, one at a time, ended by the tab's signal. */
async function follow(panel, ctx, ws, signal) {
  const st = stateOf(ws);
  const id = st.openId;
  if (!id || st.following === id) return;
  st.following = id;
  const gen = ctx.gen();
  const tick = setInterval(() => {
    const el = panel.querySelector('#sx-test-clock');
    if (!live(panel, signal) || !el || !isActiveEvalRun(st.run?.state)) { clearInterval(tick); return; }
    el.textContent = clockText(elapsedSeconds(st.run));
  }, 1000);
  signal.addEventListener('abort', () => clearInterval(tick), { once: true });
  try {
    while (live(panel, signal) && ctx.alive(gen) && st.openId === id && isActiveEvalRun(st.run?.state)) {
      let next = null;
      try { next = (await ctx.api.waitSkillEval(id, { since: st.run.version ?? -1, seconds: 20 })).eval; } catch { await new Promise((r) => setTimeout(r, 3000)); continue; }
      if (!live(panel, signal) || !ctx.alive(gen) || st.openId !== id) return;
      const was = st.run?.state;
      st.run = next; st.runFull = false;
      if (was !== next.state) ctx.announce(ctx.t('skillsStudio.test.run.nowState', { state: stateWord(ctx.t, next.state) }));
      if (!isActiveEvalRun(next.state)) { st.cancelling = false; await openRun(panel, ctx, ws, signal, id); reloadHistory(panel, ctx, ws, signal); return; }
      redraw(panel, ctx, ws, ['run', 'bar']);
    }
  } finally { if (st.following === id) st.following = null; clearInterval(tick); }
}

/** A run in full (its report), and the trial viewer's previous runs. */
async function openRun(panel, ctx, ws, signal, id) {
  const st = stateOf(ws);
  const gen = ctx.gen();
  st.openId = id;
  try {
    const res = await ctx.api.fetchSkillEval(id);
    if (!ctx.alive(gen) || !live(panel, signal) || st.openId !== id) return;
    st.run = res.eval; st.runFull = !isActiveEvalRun(res.eval.state);
    redraw(panel, ctx, ws, ['run', 'bar', 'history']);
    if (isActiveEvalRun(res.eval.state)) follow(panel, ctx, ws, signal);
  } catch (err) { if (ctx.alive(gen) && live(panel, signal)) { st.notice = ctx.t('skillsStudio.test.errors.open', { error: testErrorText(ctx.t, err) }); redraw(panel, ctx, ws, ['run']); } }
}

async function openTrial(panel, ctx, ws, signal, trialId) {
  const st = stateOf(ws);
  const gen = ctx.gen();
  st.trialId = trialId; st.trial = null; st.trialError = null; st.previous = null;
  redraw(panel, ctx, ws, ['trial']);
  try {
    const res = await ctx.api.fetchSkillEvalTrial(st.openId, trialId);
    if (!ctx.alive(gen) || !live(panel, signal) || st.trialId !== trialId) return;
    st.trial = res.trial;
    // The same case's answer in the skill's previous run, beside this one.
    const prevRef = previousTrial((st.history || []).filter((r) => r.evalRunId !== st.openId).map((r) => ({ ...r, trials: st.fullRuns?.[r.evalRunId]?.trials || null })).filter((r) => r.trials), st.run, res.trial);
    if (prevRef) {
      try { const prev = await ctx.api.fetchSkillEvalTrial(prevRef.evalRunId, prevRef.trialId); if (st.trialId === trialId) st.previous = prev.trial; } catch { /* no previous answer */ }
    } else {
      const older = (st.history || []).find((r) => r.evalRunId !== st.openId && Date.parse(r.createdAt) < Date.parse(st.run.createdAt) && !isActiveEvalRun(r.state));
      if (older) {
        try {
          const full = (await ctx.api.fetchSkillEval(older.evalRunId)).eval;
          st.fullRuns = { ...(st.fullRuns || {}), [older.evalRunId]: full };
          const ref = previousTrial([full], st.run, res.trial);
          if (ref && st.trialId === trialId) st.previous = (await ctx.api.fetchSkillEvalTrial(ref.evalRunId, ref.trialId)).trial;
        } catch { /* no previous answer */ }
      }
    }
  } catch (err) { if (ctx.alive(gen) && st.trialId === trialId) st.trialError = ctx.t('skillsStudio.test.trial.failed', { error: testErrorText(ctx.t, err) }); }
  if (!live(panel, signal) || st.trialId !== trialId) return;
  redraw(panel, ctx, ws, ['trial']);
  panel.querySelector('#sx-test-trial-box')?.focus({ preventScroll: false });
}

/** The owner's note on a trial, saved a moment after typing stops; the answer says it was kept. */
function queueFeedback(panel, ctx, ws, signal, { immediate = false } = {}) {
  const st = stateOf(ws);
  const tr = st.trial;
  if (!tr) return;
  const fb = st.feedbackState[tr.trialId];
  clearTimeout(fb.timer);
  fb.state = 'dirty';
  paintFeedback(panel, ctx, fb);
  const save = async () => {
    const runId = st.openId;
    const trialId = tr.trialId;
    const seq = (fb.seq = (fb.seq || 0) + 1);
    fb.state = 'saving'; paintFeedback(panel, ctx, fb);
    try {
      const res = await ctx.api.saveSkillEvalFeedback(runId, { trialId, text: fb.text, reviewed: fb.reviewed });
      if (seq !== fb.seq) return;
      fb.state = 'idle'; fb.saved = res.feedback.at;
    } catch { if (seq === fb.seq) fb.state = 'error'; }
    if (live(panel, signal) && st.trial?.trialId === trialId) paintFeedback(panel, ctx, fb);
  };
  if (immediate) save(); else fb.timer = setTimeout(save, 800);
}
function paintFeedback(panel, ctx, fb) { const el = panel.querySelector('#sx-test-note-state'); if (el) el.textContent = feedbackWord(ctx, fb); }

// ── Redrawing parts ──

function redraw(panel, ctx, ws, parts) {
  const st = stateOf(ws);
  if (!panel.isConnected) return;
  const set = (sel, markup) => { const el = panel.querySelector(sel); if (el) setHTML(el, markup); };
  for (const part of parts) {
    if (part === 'head') { st.fixturesOpen = !!panel.querySelector('#sx-test-fixtures')?.open; set('#sx-test-head', headHTML(ctx, ws, st)); }
    // The setup is drawn again only while nothing in it has the focus (a dropdown being used keeps its state).
    else if (part === 'setup') { const box = panel.querySelector('#sx-test-setup'); if (box && !box.contains(document.activeElement)) { st.moreOpen = !!box.querySelector('.sx-test-more')?.open; setHTML(box, setupHTML(ctx, ws, st)); } }
    else if (part === 'estimate') { set('#sx-test-estimate', estimateHTML(ctx, st)); set('#sx-test-codex-box', codexHTML(ctx, st)); set('#sx-test-safety', safetyHTML(ctx, st)); }
    else if (part === 'codex') set('#sx-test-codex-box', codexHTML(ctx, st));
    else if (part === 'safety') set('#sx-test-safety', safetyHTML(ctx, st));
    else if (part === 'bar') set('#sx-test-bar', barHTML(ctx, ws, st));
    else if (part === 'run') set('#sx-test-run', runHTML(ctx, ws, st));
    else if (part === 'trial') { const box = panel.querySelector('#sx-test-trial'); if (box && !(box.contains(document.activeElement) && document.activeElement?.id === 'sx-test-note')) setHTML(box, trialHTML(ctx, ws, st)); }
    else if (part === 'history') { const box = panel.querySelector('#sx-test-history'); if (box && !box.contains(document.activeElement)) setHTML(box, historyHTML(ctx, ws, st)); }
  }
  panel.querySelector('.sx-test')?.setAttribute('data-test-state', st.run?.state || 'idle');
}

// ── Listening ──

/** ⌘/Ctrl+Enter is Run evals while the Test tab is shown (the workspace's shortcut). */
export function testShortcut(e, ctx, ws) {
  if (ws.tab !== 'test') return false;
  const mod = ctx.mac ? e.metaKey : e.ctrlKey;
  if (mod && e.key === 'Enter' && !e.altKey && !e.shiftKey) {
    const btn = ctx.panel?.querySelector('#sx-test-run-btn');
    if (btn && !btn.disabled) { btn.click(); return true; }
  }
  return false;
}

function wire(panel, ctx, ws, signal) {
  const st = stateOf(ws);
  const formChanged = () => { keepForm(ctx, st.form); st.estimate = null; scheduleEstimate(panel, ctx, ws, signal); redraw(panel, ctx, ws, ['codex', 'safety', 'bar']); };
  panel.addEventListener('change', (e) => {
    const el = e.target;
    const id = el?.id || '';
    if (/^sx-test-runtime-\d$/.test(id)) { const i = Number(id.slice(-1)); st.form.runtimes[i] = el.value; st.form.runtimes = [...new Set(st.form.runtimes)]; formChanged(); if (st.form.runtimes.length !== i + 1 && i >= st.form.runtimes.length) redraw(panel, ctx, ws, ['setup']); return; }
    if (id === 'sx-test-baseline') { st.form.baseline = el.value; formChanged(); redraw(panel, ctx, ws, ['setup']); return; }
    if (id === 'sx-test-baseline-rev') { st.form.baselineRevisionId = el.value; formChanged(); return; }
    if (id === 'sx-test-budget') { st.form.budgetUsd = Number(el.value); formChanged(); return; }
    if (id === 'sx-test-minutes') { st.form.maxMinutes = Number(el.value); formChanged(); return; }
    if (id === 'sx-test-task-reps') { st.form.taskReps = Number(el.value); formChanged(); return; }
    if (id === 'sx-test-trigger-reps') { st.form.triggerReps = Number(el.value); formChanged(); return; }
    if (id === 'sx-test-grader') { st.form.grader = el.value; formChanged(); return; }
    if (id === 'sx-test-judge') { st.form.judge = el.checked; formChanged(); return; }
    if (id === 'sx-test-export-format') { st.exportFormat = el.value; return; }
    if (id === 'sx-test-reviewed') { const fb = st.feedbackState[st.trial?.trialId]; if (fb) { fb.reviewed = el.checked; queueFeedback(panel, ctx, ws, signal, { immediate: true }); } return; }
    if (el?.dataset?.test === 'pick') {
      if (el.checked) { if (st.compare.size >= 2) { const first = st.compare.values().next().value; st.compare.delete(first); } st.compare.add(el.dataset.id); } else st.compare.delete(el.dataset.id);
      st.comparison = null;
      redrawHistorySoon(panel, ctx, ws);
    }
  }, { signal });
  panel.addEventListener('input', (e) => {
    if (e.target?.id !== 'sx-test-note') return;
    const fb = st.feedbackState[st.trial?.trialId];
    if (!fb) return;
    fb.text = e.target.value;
    queueFeedback(panel, ctx, ws, signal);
  }, { signal });
  panel.addEventListener('focusout', (e) => {
    if (e.target?.id === 'sx-test-note') { const fb = st.feedbackState[st.trial?.trialId]; if (fb?.state === 'dirty') queueFeedback(panel, ctx, ws, signal, { immediate: true }); }
  }, { signal });
  panel.addEventListener('keydown', (e) => {
    const box = e.target.closest?.('#sx-test-trial-box');
    if (!box || e.target.closest?.('textarea, input, .cc-dropdown')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = trialStep(st.run, st.trialId, e.key === 'ArrowRight' ? 1 : -1);
      if (next) openTrial(panel, ctx, ws, signal, next);
    } else if (e.key === 'Escape') { e.preventDefault(); st.trialId = null; st.trial = null; redraw(panel, ctx, ws, ['trial']); }
  }, { signal });
  panel.addEventListener('click', async (e) => {
    // The owner opening or folding the setup (a click or Enter on its summary, before the browser toggles it) is kept.
    const summary = e.target.closest?.('.sx-test-setup-summary');
    if (summary) { const box = summary.parentElement; if (box) st.setupOpen = !box.open; return; }
    const btn = e.target.closest?.('[data-test]');
    if (!btn || btn.disabled || btn.tagName === 'INPUT') return;
    const act = btn.dataset.test;
    switch (act) {
      case 'run': start(panel, ctx, ws, signal, 'evals'); return;
      case 'final': start(panel, ctx, ws, signal, 'final'); return;
      case 'optimise': start(panel, ctx, ws, signal, 'optimise'); return;
      case 'rerun': start(panel, ctx, ws, signal, 'evals', rerunCases(st.run)); return;
      case 'cancel': {
        st.cancelling = true; redraw(panel, ctx, ws, ['run']);
        try { st.run = (await ctx.api.cancelSkillEval(st.openId)).eval; } catch (err) { ctx.toast(ctx.t('skillsStudio.test.errors.cancel', { error: testErrorText(ctx.t, err) }), 'error'); }
        st.cancelling = false;
        if (live(panel, signal)) { if (!isActiveEvalRun(st.run?.state)) openRun(panel, ctx, ws, signal, st.openId); else redraw(panel, ctx, ws, ['run']); reloadHistory(panel, ctx, ws, signal); }
        return;
      }
      case 'kinds': st.form.kinds = btn.dataset.value; formChanged(); redraw(panel, ctx, ws, ['setup']); panel.querySelector(`[data-test="kinds"][data-value="${btn.dataset.value}"]`)?.focus(); return;
      case 'add-runtime': {
        const used = new Set(st.form.runtimes.map((v) => v.split('|')[0]));
        // Another runtime that is not an opt-in one first (Codex is picked by the owner in a row's list, never by this).
        const rows = (st.options?.runtimes || []).filter((r) => r.available && !used.has(r.provider));
        const next = rows.find((r) => !isOptInRuntime(r.provider, st.options)) || rows[0] || (st.options?.runtimes || []).find((r) => r.available);
        if (next) { st.form.runtimes = [...st.form.runtimes, next.provider].slice(0, 3); st.form.runtimes = [...new Set(st.form.runtimes)]; formChanged(); redraw(panel, ctx, ws, ['setup']); }
        return;
      }
      case 'remove-runtime': st.form.runtimes.splice(Number(btn.dataset.index), 1); formChanged(); redraw(panel, ctx, ws, ['setup']); return;
      case 'open-run': st.trialId = null; st.trial = null; st.comparison = null; redraw(panel, ctx, ws, ['trial']); openRun(panel, ctx, ws, signal, btn.dataset.id); return;
      case 'open-trial': openTrial(panel, ctx, ws, signal, btn.dataset.trial); return;
      case 'trial-prev': case 'trial-next': { const next = trialStep(st.run, st.trialId, act === 'trial-next' ? 1 : -1); if (next) openTrial(panel, ctx, ws, signal, next); return; }
      case 'trial-close': st.trialId = null; st.trial = null; redraw(panel, ctx, ws, ['trial']); panel.querySelector('#sx-test-run-title')?.focus(); return;
      case 'trial-file': {
        const gen = ctx.gen();
        const view = panel.querySelector('#sx-test-file-view');
        try {
          const res = await ctx.api.fetchSkillEvalTrialFile(st.openId, st.trialId, btn.dataset.path);
          if (!ctx.alive(gen) || !view?.isConnected) return;
          setHTML(view, res.file.text === null ? html`<p class="sx-help">${ctx.t('skillsStudio.test.trial.notText')}</p>` : html`${res.file.kept ? html`<p class="sx-help">${ctx.t(res.file.clipped ? 'skillsStudio.test.trial.keptClipped' : 'skillsStudio.test.trial.kept')}</p>` : ''}<pre class="sx-pre">${res.file.text}</pre>`);
        } catch (err) { if (view?.isConnected) setHTML(view, html`<p class="sx-help sx-err-text">${testErrorText(ctx.t, err)}</p>`); }
        return;
      }
      case 'compare': {
        const [a, b] = [...st.compare].map((id) => st.history.find((r) => r.evalRunId === id)).filter(Boolean).sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
        if (!a || !b) return;
        try { st.comparison = (await ctx.api.compareSkillEvals(a.evalRunId, b.evalRunId)).comparison; } catch (err) { ctx.toast(ctx.t('skillsStudio.test.errors.compare', { error: testErrorText(ctx.t, err) }), 'error'); return; }
        if (live(panel, signal)) { const box = panel.querySelector('#sx-test-compare'); if (box) setHTML(box, comparisonHTML(ctx, st)); }
        return;
      }
      case 'export': {
        const a = document.createElement('a');
        a.href = ctx.api.getSkillEvalExportUrl(st.openId, st.exportFormat);
        a.download = '';
        a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        return;
      }
      case 'codex-confirm': case 'codex-undo': {
        const c = codexNow(st);
        if (!c) return;
        const confirm = act === 'codex-confirm';
        const ids = confirm ? (c.pending.length ? c.pending : c.revisionIds) : c.revisionIds;
        if (!ids.length) return;
        st.codexBusy = true; redraw(panel, ctx, ws, ['codex']);
        try {
          await ctx.api.setSkillEvalCodexTrust(ids, confirm);
          ctx.announce(ctx.t(confirm ? 'skillsStudio.test.codex.announceOn' : 'skillsStudio.test.codex.announceOff'));
        } catch (err) { ctx.toast(ctx.t('skillsStudio.test.codex.failed', { error: testErrorText(ctx.t, err) }), 'error'); }
        st.codexBusy = false;
        if (!live(panel, signal)) return;
        // The estimate says again what Codex may do now.
        st.estimate = null; scheduleEstimate(panel, ctx, ws, signal); redraw(panel, ctx, ws, ['codex', 'bar']);
        return;
      }
      case 'go-edit': ws.tab = 'edit'; ctx.render(); return;
      case 'go-versions': ws.tab = 'versions'; ctx.render(); return;
      case 'save-version': {
        const { saveVersion, dirtyTabs } = await import('./sx-docs.js');
        if (dirtyTabs(ws).length) { ctx.toast(ctx.t('skillsStudio.toast.saveFirst'), 'error'); return; }
        try { await saveVersion(ws, ctx.api, { key: ctx.key }); ctx.toast(ctx.t('skillsStudio.toast.versionSaved')); st.suiteFor = null; await ctx.reload(); } catch (err) { ctx.toast(ctx.t('skillsStudio.toast.versionFailed', { error: testErrorText(ctx.t, err) }), 'error'); }
        return;
      }
      case 'more': return;
      default: return;
    }
  }, { signal });
}

function redrawHistorySoon(panel, ctx, ws) {
  requestAnimationFrame(() => {
    const st = stateOf(ws);
    const btn = panel.querySelector('[data-test="compare"]');
    if (btn) btn.disabled = st.compare.size !== 2;
    for (const box of panel.querySelectorAll('[data-test="pick"]')) box.checked = st.compare.has(box.dataset.id);
    const cmp = panel.querySelector('#sx-test-compare');
    if (cmp && !st.comparison) setHTML(cmp, '');
  });
}

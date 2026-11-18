// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: an agent's runs, and a test run
// ═══════════════════════════════════════════
//
// Runs: every dispatched run that ran as this agent (GET /agents/:id/runs): what it was, how it stands, the model,
// when, what it cost, with a link that brings the run forward in the Assistant. Test run: the owner tries a draft
// (or an approved revision) before approving it: a short run with a prompt, in a registered project, outside every
// Assistant session; its state and its result are read from the same list until it has ended. A test approves
// nothing. Both listen on the tab panel and end when another tab is drawn.

import { html, setHTML, ICONS } from '../../skills/studio/sx-dom.js';
import { wireDropdowns } from '../../cc-dropdown.js';
import { runRows, testRunState, isActive } from './ax-runs.js';
import { baseName } from './ax-library.js';
import { AX_ICONS } from './ax-icons.js';
import { timeTag, dropdown, loadingHTML, errorHTML, emptyHTML, errorText, wordOr } from './ax-ui.js';

let life = null;
let pollTimer = 0;

export function leaveRunsPanel() {
  life?.abort();
  life = null;
  clearTimeout(pollTimer);
  pollTimer = 0;
}

const stateChip = (t, row) => html`<span class="sx-state-chip ax-run-state ax-run-state--${row.tone}">${wordOr(t, 'agentsStudio.runs.state', row.state)}</span>`;

function runsTable(ctx, rows) {
  const { t } = ctx;
  return html`<table class="sx-grid ax-runs"><thead><tr>
      <th>${t('agentsStudio.runs.col.run')}</th><th>${t('agentsStudio.runs.col.status')}</th><th>${t('agentsStudio.runs.col.model')}</th>
      <th>${t('agentsStudio.runs.col.started')}</th><th>${t('agentsStudio.runs.col.time')}</th><th>${t('agentsStudio.runs.col.cost')}</th><th><span class="sx-sr">${t('agentsStudio.runs.col.actions')}</span></th>
    </tr></thead><tbody>${rows.map((row) => html`<tr data-run="${row.runId}">
      <td class="ax-run-title"><span class="ax-run-name">${row.title || row.runId}</span>${row.test ? html`<span class="sx-label ax-status ax-status--draft">${t('agentsStudio.runs.test')}</span>` : ''}${row.revision ? html`<span class="ax-rev">${t('agentsStudio.revisionShort', { n: row.revision })}</span>` : ''}${row.summary ? html`<span class="sx-desc" title="${row.summary}">${row.summary}</span>` : ''}${row.corrections.length ? html`<span class="sx-desc sx-warn-text" title="${row.corrections.map((c) => c.text).join('\n')}">${ctx.tp('agentsStudio.runs.corrections', row.corrections.length)}</span>` : ''}</td>
      <td>${stateChip(t, row)}</td>
      <td class="sx-mono">${row.model || wordOr(t, 'agentsStudio.provider', row.provider)}</td>
      <td>${timeTag(row.at, ctx.locale)}</td>
      <td>${row.duration}</td>
      <td class="sx-mono">${row.cost}</td>
      <td class="ax-run-actions"><button type="button" class="sx-btn sx-btn--sm" data-act="focus-run" data-run="${row.runId}" title="${t('agentsStudio.runs.focusHelp')}">${AX_ICONS.runs}${t('agentsStudio.runs.focus')}</button></td>
    </tr>`)}</tbody></table>`;
}

/** Draw the Runs tab. */
export function renderRunsPanel(host, ctx, ed) {
  leaveRunsPanel();
  life = new AbortController();
  const { signal } = life;
  const { t } = ctx;
  setHTML(host, html`<div class="sx-versions ax-runs-panel">
    <div class="sx-versions-head"><h4 class="sx-section-title">${t('agentsStudio.runs.title')}</h4><span class="sx-spacer"></span><button type="button" class="sx-btn sx-btn--sm" data-act="refresh-runs">${ICONS.update}${t('agentsStudio.runs.refresh')}</button></div>
    <div id="ax-runs-body" aria-live="polite">${loadingHTML(t)}</div>
  </div>`);
  const body = host.querySelector('#ax-runs-body');
  const load = async () => {
    try {
      const res = await ctx.api.runs(ed.key, { limit: 100 });
      if (!body.isConnected) return;
      if (res.available === false) { setHTML(body, emptyHTML({ icon: AX_ICONS.runs, title: t('agentsStudio.runs.unavailableTitle'), lines: [t('agentsStudio.runs.unavailableHelp')] })); return; }
      const rows = runRows(res.runs);
      if (!rows.length) { setHTML(body, emptyHTML({ icon: AX_ICONS.runs, title: t('agentsStudio.runs.emptyTitle'), lines: [t('agentsStudio.runs.emptyHelp', { ref: ed.agent?.ref || ed.key.id })], actions: ctx.caps.has('test-run') && ctx.owner ? html`<button type="button" class="sx-btn" data-act="go-test">${AX_ICONS.play}${t('agentsStudio.tab.test')}</button>` : '' })); return; }
      setHTML(body, html`<p class="sx-summary ax-runs-summary">${ctx.tp('agentsStudio.runs.count', res.total ?? rows.length)}</p>${runsTable(ctx, rows)}`);
      // Runs under way are read again while the tab is open.
      clearTimeout(pollTimer);
      if (rows.some((row) => row.active)) pollTimer = setTimeout(load, 4000);
    } catch (error) {
      if (body.isConnected) setHTML(body, errorHTML(t, error));
    }
  };
  load();
  host.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !host.contains(el) || el.disabled) return;
    if (el.dataset.act === 'focus-run') ctx.focusRun(el.dataset.run);
    else if (el.dataset.act === 'refresh-runs' || el.dataset.act === 'retry') { setHTML(body, loadingHTML(t)); load(); }
    else if (el.dataset.act === 'go-test') ctx.go({ type: 'tab', tab: 'test' });
  }, { signal });
}

// ── Test run ──

function testResultHTML(ctx, test) {
  const { t } = ctx;
  if (!test) return '';
  if (test.error) return html`<div class="sx-banner sx-banner--warn" role="alert">${ICONS.warn}<span class="sx-banner-text">${test.error}</span></div>`;
  const state = test.state;
  const run = state?.run;
  if (!run) return html`<p class="sx-note" role="status">${t('agentsStudio.test.lost')}</p>`;
  const phase = state.phase;
  return html`<section class="ax-test-run" aria-labelledby="ax-test-run-title">
    <div class="ax-test-run-head">
      <h4 class="sx-section-title" id="ax-test-run-title">${run.title || t('agentsStudio.test.runTitle')}</h4>
      ${stateChip(t, run)}
      ${phase !== 'ended' ? html`<span class="ax-spinner" aria-hidden="true"></span><span class="sx-help" role="status">${t(phase === 'starting' ? 'agentsStudio.test.starting' : 'agentsStudio.test.running')}</span>` : html`<span class="sx-help" role="status">${t('agentsStudio.test.ended')}</span>`}
      <span class="sx-spacer"></span>
      <button type="button" class="sx-btn sx-btn--sm" data-act="focus-run" data-run="${run.runId}">${AX_ICONS.runs}${t('agentsStudio.runs.focus')}</button>
    </div>
    <dl class="ax-facts">
      <div><dt>${t('agentsStudio.test.revision')}</dt><dd>${test.revision ? t('agentsStudio.revisionShort', { n: test.revision }) : ''}${test.revisionStatus ? html` · ${wordOr(t, 'agentsStudio.status', test.revisionStatus)}` : ''}</dd></div>
      <div><dt>${t('agentsStudio.runs.col.model')}</dt><dd class="sx-mono">${run.model || wordOr(t, 'agentsStudio.provider', run.provider)}</dd></div>
      ${run.duration ? html`<div><dt>${t('agentsStudio.runs.col.time')}</dt><dd>${run.duration}</dd></div>` : ''}
      ${run.cost ? html`<div><dt>${t('agentsStudio.runs.col.cost')}</dt><dd class="sx-mono">${run.cost}</dd></div>` : ''}
    </dl>
    ${run.corrections.length ? html`<div class="sx-note sx-note--warn"><p class="ax-note-title">${t('agentsStudio.test.corrections')}</p><ul class="sx-plain-list">${run.corrections.map((c) => html`<li>${c.text || c.field}</li>`)}</ul></div>` : ''}
    ${run.summary ? html`<h5 class="ax-sub-title">${t('agentsStudio.test.result')}</h5><pre class="sx-pre ax-test-summary">${run.summary}</pre>` : phase === 'ended' ? html`<p class="sx-note">${t('agentsStudio.test.noResult')}</p>` : ''}
  </section>`;
}

/** Draw the Test run tab. */
export function renderTestPanel(host, ctx, ed) {
  leaveRunsPanel();
  life = new AbortController();
  const { signal } = life;
  const { t } = ctx;
  const draft = ed.agent?.draftDefinition || null;
  const approved = ed.agent?.approvedDefinition || null;
  const st = (ed.test ||= { task: '', cwd: '', revision: null, picked: false, run: null, busy: false });
  // Until the owner picks one, the revision tried is the draft when there is one (what a test is for), else the
  // approved one; a pick that is no longer there (the draft was approved meanwhile) falls back the same way.
  if (!st.picked || (st.revision === 'draft' && !draft) || (st.revision === 'approved' && !approved)) st.revision = draft ? 'draft' : 'approved';
  const projects = (ctx.info?.projects || []).filter((p) => p?.path);
  if (!st.cwd) st.cwd = ed.key.scope?.kind === 'project' ? ed.key.scope.path : (projects[0]?.path || '');
  const available = ctx.info?.testRun?.available !== false;
  if (!ctx.owner) { setHTML(host, emptyHTML({ icon: ICONS.lock, title: t('agentsStudio.test.ownerTitle'), lines: [t('agentsStudio.error.ownerOnly')] })); return; }
  if (!draft && !approved) { setHTML(host, emptyHTML({ icon: AX_ICONS.play, title: t('agentsStudio.test.nothingTitle'), lines: [t('agentsStudio.test.nothingHelp')] })); return; }
  const revisions = [
    draft ? { value: 'draft', label: t('agentsStudio.test.revisionDraft', { n: draft.revision, status: wordOr(t, 'agentsStudio.status', draft.status) }), selected: st.revision === 'draft' } : null,
    approved ? { value: 'approved', label: t('agentsStudio.test.revisionApproved', { n: approved.revision }), selected: st.revision === 'approved' || !draft } : null,
  ].filter(Boolean);
  const projectEntries = projects.map((p) => ({ value: p.path, label: p.label || baseName(p.path), caption: p.path, selected: st.cwd === p.path }));
  if (st.cwd && !projectEntries.some((p) => p.selected)) projectEntries.push({ value: st.cwd, label: baseName(st.cwd), caption: st.cwd, selected: true });
  const minutes = Number(ctx.info?.testRun?.minutes) || 20;
  setHTML(host, html`<div class="sx-versions ax-test">
    <div>
      <h4 class="sx-section-title">${t('agentsStudio.test.title')}</h4>
      <p class="sx-explain">${t('agentsStudio.test.help', { minutes })}</p>
    </div>
    ${!available ? html`<div class="sx-banner sx-banner--warn">${ICONS.warn}<span class="sx-banner-text">${t('agentsStudio.test.unavailable')}</span></div>` : ''}
    ${ed.dirty ? html`<div class="sx-banner sx-banner--draft">${ICONS.draft}<span class="sx-banner-text">${t('agentsStudio.test.unsaved')}</span></div>` : ''}
    <div class="ax-test-form">
      <div class="sx-field"><span class="sx-field-label" id="ax-test-rev-label">${t('agentsStudio.test.revision')}</span>${dropdown('ax-test-rev', revisions, { labelledBy: 'ax-test-rev-label' })}</div>
      <div class="sx-field"><span class="sx-field-label" id="ax-test-cwd-label">${t('agentsStudio.test.project')}</span>${projectEntries.length ? dropdown('ax-test-cwd', projectEntries, { labelledBy: 'ax-test-cwd-label' }) : html`<p class="sx-note">${t('agentsStudio.test.noProjects')}</p>`}</div>
      <div class="sx-field ax-field--wide"><label class="sx-field-label" for="ax-test-task">${t('agentsStudio.test.prompt')}</label>
        <textarea class="sx-input sx-textarea ax-test-task" id="ax-test-task" rows="5" placeholder="${t('agentsStudio.test.promptPlaceholder')}" data-autofocus>${st.task}</textarea></div>
      <div class="sx-row ax-field--wide"><button type="button" class="sx-btn sx-btn--primary" id="ax-test-start" data-act="start-test"${!available || !projectEntries.length || st.busy ? html` disabled` : ''}>${AX_ICONS.play}${t('agentsStudio.test.start')}</button><span class="sx-help">${t('agentsStudio.test.approvesNothing')}</span></div>
    </div>
    <div id="ax-test-result" aria-live="polite">${testResultHTML(ctx, st.run)}</div>
  </div>`);
  wireDropdowns(host, { signal });
  const result = host.querySelector('#ax-test-result');
  const paint = () => { if (result.isConnected) setHTML(result, testResultHTML(ctx, st.run)); };

  /** Follow the test run in the agent's runs until it has ended (or the tab is left). */
  const follow = async () => {
    clearTimeout(pollTimer);
    if (!st.run?.runId || !result.isConnected) return;
    try {
      const res = await ctx.api.runs(ed.key, { limit: 100 });
      const state = testRunState(st.run.runId, runRows(res.runs), st.run.started);
      st.run.state = state;
      // The run is in the list now: what the start answered is no longer needed to tell it from a removed one.
      if (state.phase !== 'starting') st.run.started = null;
      paint();
      if (state.phase === 'starting' || state.phase === 'running') pollTimer = setTimeout(follow, state.run && isActive(state.run.state) ? 2000 : 3000);
    } catch { pollTimer = setTimeout(follow, 4000); }
  };
  if (st.run?.runId && st.run.state?.phase !== 'ended' && st.run.state?.phase !== 'lost') follow();

  host.addEventListener('input', (e) => { if (e.target.id === 'ax-test-task') st.task = e.target.value; }, { signal });
  host.addEventListener('change', (e) => {
    if (e.target.id === 'ax-test-rev') { st.revision = e.target.value; st.picked = true; }
    else if (e.target.id === 'ax-test-cwd') st.cwd = e.target.value;
  }, { signal });
  host.addEventListener('click', async (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !host.contains(el) || el.disabled) return;
    if (el.dataset.act === 'focus-run') { ctx.focusRun(el.dataset.run); return; }
    if (el.dataset.act !== 'start-test') return;
    const task = st.task.trim();
    if (!task) { ctx.toast(t('agentsStudio.test.promptRequired'), 'error'); host.querySelector('#ax-test-task')?.focus(); return; }
    st.busy = true;
    el.disabled = true;
    st.run = null;
    paint();
    try {
      const res = await ctx.api.testRun(ed.key, { task, cwd: st.cwd, revision: st.revision });
      const started = res.run || {};
      st.run = { runId: started.runId, revision: res.revision ?? null, revisionStatus: res.revisionStatus || null, started, state: testRunState(started.runId, [], started), error: null };
      ctx.toast(t('agentsStudio.toast.testStarted'));
      paint();
      follow();
    } catch (error) {
      st.run = { error: error.code === 'AGENT_NOT_VALID' ? t('agentsStudio.test.notValid') : t('agentsStudio.test.failed', { error: errorText(t, error) }) };
      paint();
    } finally {
      st.busy = false;
      if (el.isConnected) el.disabled = false;
    }
  }, { signal });
}

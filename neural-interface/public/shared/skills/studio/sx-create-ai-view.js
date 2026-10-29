// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: Create's AI box (P3)
// ═══════════════════════════════════════════
//
// Describe the skill, add sources (a session of Claude Code, Codex or OpenCode; a web page; a registered project;
// memories; an existing skill), pick the options, and one worker of the Assistant's dispatcher drafts the whole
// package. While it works the box shows its steps, the files it has written and its last lines, with Cancel; when it
// is done, the checks, the assumptions and the way to Review (nothing is installed until the owner publishes it).
// A creation lives on the server: closing the window loses nothing, and the recent ones are listed here.
//
// Every answer that arrives late (another place drawn, another creation opened, the window closed) changes nothing:
// each request carries the place's signal and the box's sequence number. Async results redraw only their own part
// (the model list, the sessions, the recent list, the progress), never the text being typed. Strings are
// `skillsStudio.create.*` (i18n/en.json, pt-BR.json).

import { studioErrorText } from './sx-errors.js';
import { dropdownHTML, setDropdownItems } from '../../cc-dropdown.js';
import { CREATION_LIMITS, isActiveCreation, urlProblem, relativePathProblem } from '../ss-creation.js';
import { html, raw, setHTML, ICONS, attr, plural, relativeTime, fullTime, listText } from './sx-dom.js';
import { scanState } from './sx-review.js';
import {
  AI_FORM_KEY, AI_SOURCE_KINDS, CREATION_ERRORS, DRAFT_RUNTIMES, WORK_MINUTES, readAiForm, writeAiForm, addSource, removeSource, sourceChip,
  buildCreationRequest, problemKey, creationSteps, creationTitle, errorCode, elapsedSeconds, clockText, sizeText, pollSeconds, modelEntries, draftingProviders,
} from './sx-create-ai.js';

const PROMPT_KEY = 'skills-studio-create-prompt';
const SCAN_COUNTED = ['blocked', 'incomplete', 'review', 'findings'];
const PROVIDER_RUNTIME = new Map([['claude-code', 'claude'], ['codex', 'codex'], ['opencode', 'opencode']]);

// What the box keeps between drawings of the place (the form itself is kept in storage).
const AI = {
  seq: 0, options: null, optionsFailed: null, catalog: null, editing: null,
  conv: { provider: 'claude-code', project: '', q: '', list: null, loading: false, failed: null, chosen: null, timer: 0 },
  creations: null, creationsFailed: null, openJobId: null, job: null, cancelling: false, starting: false, saveTimer: 0, pendingSave: null, tick: 0,
};

/** Open a creation in the box (a link, a finished draft's card). */
export function openCreation(jobId) { AI.openJobId = jobId; AI.job = null; }

/** Whether drafting with AI can run against this server. */
export function aiState(ctx) {
  if (ctx.guest) return 'guest';
  if (ctx.caps.has('ai-create')) return 'ready';
  return ctx.capsKnown ? 'restart' : 'unknown';
}

function form(ctx) {
  if (!ctx.lib.createAi) ctx.lib.createAi = readAiForm(ctx.storage.getItem(AI_FORM_KEY), ctx.storage.getItem(PROMPT_KEY) || '');
  return ctx.lib.createAi;
}
function keep(ctx, next, { now = false } = {}) {
  ctx.lib.createAi = next;
  clearTimeout(AI.saveTimer);
  const write = () => { AI.pendingSave = null; try { ctx.storage.setItem(AI_FORM_KEY, writeAiForm(next)); } catch { /* kept in memory */ } };
  if (now) write(); else { AI.pendingSave = write; AI.saveTimer = setTimeout(write, 400); }
}

const runtimeName = (t, provider) => t(`skillsStudio.runtime.${PROVIDER_RUNTIME.get(provider) || 'claude'}`);
const targetText = (t, target) => (target?.provider ? `${runtimeName(t, target.provider)}${target.model ? ` · ${target.model}` : ''}` : '');

// ── Markup ──

/** The whole AI area: the form (or the open creation), then the recent creations. */
export function aiAreaHTML(ctx) {
  return html`<div class="sx-ai" id="sx-ai">
    <div id="sx-ai-main">${AI.openJobId ? jobHTML(ctx) : formHTML(ctx)}</div>
    <div id="sx-ai-recent">${recentHTML(ctx)}</div>
  </div>`;
}

/** Whether no provider that drafts can start here now (false only when the server said so). */
const draftingOff = () => AI.options?.drafting?.available === false;
/** Whether the SynaBun browser cannot open a page now (the server said so). */
const browserOff = () => !!AI.options && AI.options.url === false;
const helpText = (ctx, state) => (state !== 'ready'
  ? ctx.t(state === 'restart' ? 'skillsStudio.create.ai.restart' : 'skillsStudio.create.ai.unknown')
  : draftingOff() ? ctx.t('skillsStudio.create.ai.draftingUnavailable', {
    providers: listText(draftingProviders(AI.options.drafting).map((p) => runtimeName(ctx.t, p.provider)), ctx.locale, 'disjunction'),
    reason: AI.options.drafting.reason || '',
  }) : ctx.t('skillsStudio.create.ai.help'));

function formHTML(ctx) {
  const { t } = ctx;
  const f = form(ctx);
  const state = aiState(ctx);
  const ready = state === 'ready' && !draftingOff();
  return html`<div class="sx-ai-form" role="group" aria-labelledby="sx-ai-title">
    <h4 class="sx-section-title" id="sx-ai-title">${ICONS.spark} ${t('skillsStudio.create.ai.title')}</h4>
    <div class="sx-field">
      <label class="sx-field-label" for="sx-cr-prompt">${t('skillsStudio.create.promptLabel')} <span class="sx-count" id="sx-ai-prompt-count">${f.prompt.length} / ${CREATION_LIMITS.promptChars}</span></label>
      <textarea class="sx-input sx-prompt" id="sx-cr-prompt" rows="5" maxlength="${CREATION_LIMITS.promptChars}" placeholder="${t('skillsStudio.create.promptPlaceholder')}" data-autofocus>${f.prompt}</textarea>
    </div>
    ${f.showExample ? html`<div class="sx-field">
      <label class="sx-field-label" for="sx-ai-example">${t('skillsStudio.create.ai.exampleLabel')}</label>
      <textarea class="sx-input sx-textarea" id="sx-ai-example" rows="4" maxlength="${CREATION_LIMITS.exampleChars}" placeholder="${t('skillsStudio.create.ai.examplePlaceholder')}">${f.example}</textarea>
    </div>` : html`<button type="button" class="sx-btn sx-btn--ghost sx-ai-example-toggle" data-ai="show-example">${ICONS.plus}<span>${t('skillsStudio.create.ai.exampleToggle')}</span></button>`}
    <div class="sx-field" id="sx-ai-sources">${sourcesHTML(ctx, f)}</div>
    <div id="sx-ai-editor">${editorHTML(ctx)}</div>
    ${optionsHTML(ctx, f)}
    <p class="sx-field-note sx-err-text" id="sx-ai-problem" role="alert"></p>
    <div class="sx-row sx-ai-go">
      <button type="button" class="sx-btn sx-btn--primary" data-ai="draft"${attr('disabled', !ready)} aria-describedby="sx-ai-help" aria-keyshortcuts="${ctx.mac ? 'Meta+Enter' : 'Control+Enter'}">${ICONS.spark}<span>${t('skillsStudio.create.draftWithAi')}</span> <kbd>${ctx.mac ? '⌘↵' : 'Ctrl+Enter'}</kbd></button>
      <p class="sx-help" id="sx-ai-help">${helpText(ctx, state)}</p>
    </div>
  </div>`;
}

function sourcesHTML(ctx, f) {
  const { t } = ctx;
  const chips = f.sources.map((s, i) => {
    const chip = sourceChip(s);
    return html`<li class="sx-ai-chip" data-kind="${s.kind}"${attr('title', chip.title)}>
      <span class="sx-ai-chip-kind">${t(`skillsStudio.create.ai.kind.${s.kind}`)}</span><span class="sx-ai-chip-label">${chip.label}</span>
      <button type="button" class="sx-icon-btn sx-ai-chip-x" data-ai="remove-source" data-index="${i}" aria-label="${t('skillsStudio.create.ai.removeSource', { name: chip.label })}" title="${t('skillsStudio.create.ai.removeSource', { name: chip.label })}">${ICONS.close}</button></li>`;
  });
  const full = f.sources.length >= CREATION_LIMITS.sources;
  // A web page is read with the SynaBun browser: when it cannot open pages now, the button says why instead.
  const pageOff = browserOff();
  const pageWhy = pageOff ? t('skillsStudio.create.ai.url.unavailable', { reason: AI.options.urlReason || '' }) : null;
  return html`<span class="sx-field-label" id="sx-ai-sources-label">${t('skillsStudio.create.sourcesLabel')}</span>
    ${f.sources.length ? html`<ul class="sx-ai-chips" aria-labelledby="sx-ai-sources-label">${chips}</ul>` : html`<p class="sx-help">${t('skillsStudio.create.ai.noSources')}</p>`}
    <div class="sx-row sx-sources" role="group" aria-label="${t('skillsStudio.create.useAsSource')}">
      <span class="sx-filter-key">${t('skillsStudio.create.useAsSource')}</span>
      ${AI_SOURCE_KINDS.map((k) => html`<button type="button" class="sx-btn${AI.editing === k ? ' is-on' : ''}" data-ai="edit-source" data-kind="${k}" aria-expanded="${AI.editing === k ? 'true' : 'false'}" aria-controls="sx-ai-editor"${attr('disabled', full || (k === 'url' && pageOff))}${attr('title', k === 'url' ? pageWhy : null)}>${ICONS.plus}<span>${t(`skillsStudio.create.source.${k}`)}</span></button>`)}
    </div>
    ${pageOff ? html`<p class="sx-help" id="sx-ai-url-off">${pageWhy}</p>` : ''}
    ${full ? html`<p class="sx-help">${t('skillsStudio.create.ai.full', { count: CREATION_LIMITS.sources })}</p>` : ''}`;
}

function projectEntries(ctx, selected, { any = false } = {}) {
  const repo = AI.options?.repo || ctx.projects.map((p) => ({ path: p.path, label: p.label }));
  return [
    ...(any ? [{ value: '', label: ctx.t('skillsStudio.create.ai.conv.anyProject'), selected: !selected }] : [{ value: '', label: ctx.t('skillsStudio.import.chooseProject'), disabled: true, selected: !selected }]),
    ...repo.map((p) => ({ value: p.path, label: p.label, selected: selected === p.path })),
  ];
}

function editorHTML(ctx) {
  const { t } = ctx;
  const kind = AI.editing;
  if (!kind) return '';
  const buttons = (addLabel, action) => html`<div class="sx-row sx-ai-editor-actions">
    <button type="button" class="sx-btn sx-btn--ghost" data-ai="close-editor">${t('skillsStudio.dialog.cancel')}</button>
    <button type="button" class="sx-btn sx-btn--primary" data-ai="${action}">${addLabel}</button></div>`;
  let body;
  if (kind === 'conversation') {
    const c = AI.conv;
    const providers = (AI.options?.conversation || ['claude-code', 'codex', 'opencode']).map((p) => ({ value: p, label: runtimeName(t, p), selected: c.provider === p }));
    body = html`<div class="sx-ai-editor-grid">
        <div class="sx-field"><span class="sx-field-label" id="sx-ai-conv-provider-label">${t('skillsStudio.create.ai.conv.provider')}</span>${raw(dropdownHTML('sx-ai-conv-provider', providers, { labelledBy: 'sx-ai-conv-provider-label' }))}</div>
        <div class="sx-field"><span class="sx-field-label" id="sx-ai-conv-project-label">${t('skillsStudio.create.ai.conv.project')}</span>${raw(dropdownHTML('sx-ai-conv-project', projectEntries(ctx, c.project, { any: true }), { labelledBy: 'sx-ai-conv-project-label' }))}</div>
        <div class="sx-field sx-ai-wide"><label class="sx-field-label" for="sx-ai-conv-q">${t('skillsStudio.create.ai.conv.search')}</label>
          <input class="sx-input" id="sx-ai-conv-q" type="search" autocomplete="off" spellcheck="false" value="${c.q}"></div>
      </div>
      <div class="sx-ai-sessions" id="sx-ai-sessions" role="listbox" aria-label="${t('skillsStudio.create.ai.conv.title')}">${sessionsHTML(ctx)}</div>
      ${buttons(t('skillsStudio.create.ai.conv.use'), 'add-conversation')}`;
  } else if (kind === 'url') {
    body = browserOff()
      ? html`<p class="sx-note">${t('skillsStudio.create.ai.url.unavailable', { reason: AI.options.urlReason || '' })}</p>
      <div class="sx-row sx-ai-editor-actions"><button type="button" class="sx-btn sx-btn--ghost" data-ai="close-editor">${t('skillsStudio.dialog.cancel')}</button></div>`
      : html`<div class="sx-field"><label class="sx-field-label" for="sx-ai-url">${t('skillsStudio.create.ai.url.label')}</label>
        <input class="sx-input" id="sx-ai-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://" aria-describedby="sx-ai-url-help">
        <p class="sx-help" id="sx-ai-url-help">${t('skillsStudio.create.ai.url.help')}</p></div>
      ${buttons(t('skillsStudio.create.ai.url.add'), 'add-url')}`;
  } else if (kind === 'repo') {
    const none = !(AI.options?.repo || ctx.projects).length;
    body = none ? html`<p class="sx-note">${t('skillsStudio.create.ai.repo.none')}</p>${buttons(t('skillsStudio.create.ai.repo.add'), 'add-repo')}` : html`<div class="sx-field"><span class="sx-field-label" id="sx-ai-repo-label">${t('skillsStudio.create.ai.repo.label')}</span>${raw(dropdownHTML('sx-ai-repo', projectEntries(ctx, ''), { labelledBy: 'sx-ai-repo-label' }))}</div>
      <div class="sx-field"><label class="sx-field-label" for="sx-ai-repo-paths">${t('skillsStudio.create.ai.repo.paths')}</label>
        <textarea class="sx-input sx-textarea sx-mono" id="sx-ai-repo-paths" rows="3" spellcheck="false" placeholder="docs/release.md&#10;scripts" aria-describedby="sx-ai-repo-help"></textarea>
        <p class="sx-help" id="sx-ai-repo-help">${t('skillsStudio.create.ai.repo.help')}</p></div>
      ${buttons(t('skillsStudio.create.ai.repo.add'), 'add-repo')}`;
  } else if (kind === 'memory') {
    body = html`<div class="sx-ai-editor-grid">
        <div class="sx-field sx-ai-wide"><label class="sx-field-label" for="sx-ai-memory-q">${t('skillsStudio.create.ai.memory.query')}</label>
          <input class="sx-input" id="sx-ai-memory-q" autocomplete="off" maxlength="${CREATION_LIMITS.queryChars}" placeholder="${t('skillsStudio.create.ai.memory.placeholder')}"></div>
        <div class="sx-field"><label class="sx-field-label" for="sx-ai-memory-project">${t('skillsStudio.create.ai.memory.project')}</label>
          <input class="sx-input" id="sx-ai-memory-project" autocomplete="off" spellcheck="false" placeholder="synabun"></div>
      </div>
      <p class="sx-help">${t('skillsStudio.create.ai.memory.help')}</p>
      ${buttons(t('skillsStudio.create.ai.memory.add'), 'add-memory')}`;
  } else {
    const skills = (ctx.data?.skills || []).filter((s) => s.pointers?.latest || s.pointers?.upstream);
    const entries = [{ value: '', label: t('skillsStudio.create.ai.import.chooseSkill'), disabled: true, selected: true }, ...skills.map((s) => ({ value: s.skillId, label: s.name }))];
    body = html`<p class="sx-help">${t('skillsStudio.create.ai.import.help')}</p>
      <div class="sx-ai-editor-grid">
        <div class="sx-field"><span class="sx-field-label" id="sx-ai-import-skill-label">${t('skillsStudio.create.ai.import.library')}</span>${raw(dropdownHTML('sx-ai-import-skill', entries, { labelledBy: 'sx-ai-import-skill-label', disabled: !skills.length }))}</div>
        <div class="sx-field"><span class="sx-field-label">${t('skillsStudio.create.ai.import.or')}</span>
          <button type="button" class="sx-btn" data-ai="import-file">${ICONS.upload}<span>${t('skillsStudio.create.ai.import.file')}</span></button></div>
      </div>
      ${buttons(t('skillsStudio.create.ai.import.useSkill'), 'add-import-skill')}`;
  }
  return html`<div class="sx-ai-editor" role="group" aria-labelledby="sx-ai-editor-title">
    <h5 class="sx-ai-editor-title" id="sx-ai-editor-title">${t(`skillsStudio.create.ai.editorTitle.${kind}`)}</h5>
    ${body}
    <p class="sx-field-note sx-err-text" id="sx-ai-editor-problem" role="alert"></p>
  </div>`;
}

function sessionsHTML(ctx) {
  const { t, locale } = ctx;
  const c = AI.conv;
  // A server without AI drafting has no session list to ask: said, not asked (a 404 says nothing useful).
  if (aiState(ctx) !== 'ready') return html`<p class="sx-help">${t('skillsStudio.create.ai.conv.restart')}</p>`;
  if (c.loading && !c.list) return html`<p class="sx-help" role="status">${t('skillsStudio.create.ai.conv.loading')}</p>`;
  if (c.failed) return html`<p class="sx-field-note sx-err-text" role="alert">${t('skillsStudio.create.ai.conv.failed', { error: c.failed })}</p>`;
  if (!c.list?.length) return html`<p class="sx-help">${t('skillsStudio.create.ai.conv.none')}</p>`;
  // One `html` value: setHTML escapes anything else as text (a plain list of markup included).
  return html`${c.list.map((s) => html`<button type="button" role="option" class="sx-ai-session${c.chosen === s.sessionId ? ' is-on' : ''}" aria-selected="${c.chosen === s.sessionId ? 'true' : 'false'}" data-ai="pick-session" data-session="${s.sessionId}">
    <span class="sx-ai-session-title">${s.title || s.sessionId}</span>
    <span class="sx-ai-session-meta">${s.projectLabel || ''} · <time datetime="${s.modified || ''}" title="${fullTime(s.modified, locale)}">${relativeTime(s.modified, locale)}</time> · ${plural(t, 'skillsStudio.create.ai.conv.messages', Number(s.messages) || 0)}</span>
  </button>`)}`;
}

function optionsHTML(ctx, f) {
  const { t } = ctx;
  const models = modelList(ctx, f.target);
  const minutes = WORK_MINUTES.map((m) => ({ value: String(m), label: t('skillsStudio.create.ai.options.minutesValue', { count: m }), selected: m === f.minutes }));
  const nameShown = f.name ? `/${f.name}` : '/name';
  return html`<fieldset class="sx-ai-options"><legend class="sx-field-label">${t('skillsStudio.create.ai.options.title')}</legend>
    <div class="sx-ai-editor-grid">
      <div class="sx-field"><label class="sx-field-label" for="sx-ai-name">${t('skillsStudio.create.ai.options.name')}</label>
        <input class="sx-input" id="sx-ai-name" value="${f.name}" autocomplete="off" spellcheck="false" maxlength="64" placeholder="${t('skillsStudio.create.namePlaceholder')}" aria-describedby="sx-ai-name-help">
        <p class="sx-help" id="sx-ai-name-help">${t('skillsStudio.create.ai.options.nameHelp')}</p></div>
      <div class="sx-field"><span class="sx-field-label" id="sx-ai-model-label">${t('skillsStudio.create.ai.options.model')}</span>${raw(dropdownHTML('sx-ai-model', models, { labelledBy: 'sx-ai-model-label' }))}</div>
      <div class="sx-field"><span class="sx-field-label" id="sx-ai-minutes-label">${t('skillsStudio.create.ai.options.minutes')}</span>${raw(dropdownHTML('sx-ai-minutes', minutes, { labelledBy: 'sx-ai-minutes-label' }))}</div>
    </div>
    <p class="sx-help" id="sx-ai-model-help">${modelHelpText(ctx)}</p>
    <div class="sx-choices" role="radiogroup" aria-label="${t('skillsStudio.form.invocation')}">
      <label class="sx-choice"><input type="radio" name="sx-ai-inv" value="auto"${attr('checked', f.invocation === 'auto')}> ${t('skillsStudio.form.invocationAuto', { name: nameShown })}</label>
      <label class="sx-choice"><input type="radio" name="sx-ai-inv" value="manual"${attr('checked', f.invocation === 'manual')}> ${t('skillsStudio.form.invocationManual', { name: nameShown })}</label>
    </div>
    <div class="sx-choices" role="group" aria-label="${t('skillsStudio.create.ai.options.runtimes')}">
      <span class="sx-filter-key">${t('skillsStudio.create.ai.options.runtimes')}</span>
      ${DRAFT_RUNTIMES.map((rt) => html`<label class="sx-choice"><input type="checkbox" name="sx-ai-runtime" value="${rt}"${attr('checked', f.runtimes.includes(rt))}> ${t(`skillsStudio.runtime.${rt}`)}</label>`)}
    </div>
  </fieldset>`;
}

/** The open creation: its steps, what it is doing, what it made or why it stopped. */
function jobHTML(ctx) {
  const { t, tp, locale } = ctx;
  const job = AI.job;
  if (!job) return html`<div class="sx-ai-job" id="sx-ai-job" role="status"><p class="sx-help">${t('skillsStudio.create.ai.job.loading')}</p>
    <button type="button" class="sx-btn sx-btn--ghost" data-ai="back">${ICONS.back}<span>${t('skillsStudio.create.ai.job.back')}</span></button></div>`;
  const active = isActiveCreation(job.state);
  const title = creationTitle(job);
  const steps = creationSteps(job);
  const heading = job.state === 'done' ? (job.result?.reviewId ? 'done' : 'drafted') : active ? 'active' : job.state;
  const seconds = elapsedSeconds(job);
  const r = job.result;
  const scan = r?.scan ? scanState(r.scan) : null;
  return html`<div class="sx-ai-job" id="sx-ai-job" data-state="${job.state}" aria-busy="${active ? 'true' : 'false'}">
    <div class="sx-ai-job-head">
      <h4 class="sx-section-title" id="sx-ai-job-title" tabindex="-1">${t(`skillsStudio.create.ai.job.title.${heading}`, { name: title })}</h4>
      <span class="sx-spacer"></span>
      ${active ? html`<button type="button" class="sx-btn sx-btn--danger" data-ai="cancel-job"${attr('disabled', AI.cancelling)}>${AI.cancelling ? t('skillsStudio.create.ai.job.cancelling') : t('skillsStudio.create.ai.job.cancel')}</button>` : ''}
    </div>
    <ol class="sx-ai-steps" aria-label="${t('skillsStudio.create.ai.job.stepsLabel')}">
      ${steps.map((s, i) => html`<li class="sx-ai-step is-${s.state}"${attr('aria-current', s.state === 'active' ? 'step' : null)}><span class="sx-ai-step-n" aria-hidden="true">${s.state === 'done' ? ICONS.ok : s.state === 'failed' ? ICONS.err : i + 1}</span>
        <span>${t(`skillsStudio.create.ai.job.step.${s.id}`)}</span><span class="sx-sr"> (${t(`skillsStudio.create.ai.job.stepState.${s.state}`)})</span></li>`)}
    </ol>
    <dl class="sx-ai-facts">
      ${job.target?.provider ? html`<div><dt>${t('skillsStudio.create.ai.job.worker')}</dt><dd>${targetText(t, job.target)}${job.target.route ? html` <span class="sx-help">${t('skillsStudio.create.ai.job.byRoute')}</span>` : ''}${job.run?.browser ? html` · ${t('skillsStudio.create.ai.job.browser')}` : ''}</dd></div>` : ''}
      ${seconds !== null ? html`<div><dt>${t('skillsStudio.create.ai.job.time')}</dt><dd><span id="sx-ai-clock" data-from="${job.createdAt}">${clockText(seconds)}</span>${job.run ? html` · ${t(active ? 'skillsStudio.create.ai.job.cost' : 'skillsStudio.create.ai.job.spent', { cost: `$${(Number(job.run.costUsd) || 0).toFixed(2)}` })}` : ''}</dd></div>` : ''}
      ${job.sources?.length ? html`<div><dt>${t('skillsStudio.create.sourcesLabel')}</dt><dd><ul class="sx-plain-list">${job.sources.map((s) => html`<li>${t(`skillsStudio.create.ai.kind.${s.kind}`)}: ${s.label || ''}${Number.isFinite(s.items) && s.items !== null ? html` (${s.items})` : ''}${s.truncated ? html` · <span class="sx-warn-text">${t('skillsStudio.create.ai.job.cut')}</span>` : ''}</li>`)}</ul></dd></div>` : ''}
    </dl>
    ${active || (!r && job.files?.length) ? html`<div class="sx-ai-written"><h5 class="sx-ai-editor-title">${t('skillsStudio.create.ai.job.files')}</h5>
      ${job.files?.length ? html`<ul class="sx-plain-list sx-mono">${job.files.map((f) => html`<li>${f.path} <span class="sx-help">${sizeText(f.bytes)}</span></li>`)}</ul>` : html`<p class="sx-help">${t('skillsStudio.create.ai.job.noFiles')}</p>`}</div>` : ''}
    ${active && job.activity?.length ? html`<div class="sx-ai-activity"><h5 class="sx-ai-editor-title">${t('skillsStudio.create.ai.job.activity')}</h5><pre class="sx-mono">${job.activity.join('\n')}</pre></div>` : ''}
    ${r ? html`<div class="sx-ai-result">
      <ul class="sx-plain-list sx-ai-checks">
        <li class="${r.lint?.errors ? 'sx-err-text' : ''}">${t('skillsStudio.create.ai.job.lint', { errors: r.lint?.errors ?? 0, warnings: r.lint?.warnings ?? 0 })}</li>
        ${scan ? html`<li class="sx-scan-${scan.sev}">${SCAN_COUNTED.includes(scan.code) ? plural(t, `skillsStudio.review.scan.${scan.code}`, scan.found) : t(`skillsStudio.review.scan.${scan.code}`)}</li>` : ''}
        <li>${r.evals ? t('skillsStudio.create.ai.job.tests', { tasks: r.evals.tasks, positive: r.evals.positive, nearMiss: r.evals.nearMiss }) : t('skillsStudio.create.ai.job.noTests')}</li>
      </ul>
      ${r.summary ? html`<p>${r.summary}</p>` : ''}
      ${r.assumptions?.length ? html`<details class="sx-ai-details" open><summary>${tp('skillsStudio.create.ai.job.assumptions', r.assumptions.length)}</summary><ul class="sx-plain-list">${r.assumptions.map((a) => html`<li>${a}</li>`)}</ul></details>` : ''}
      ${r.warnings?.length ? html`<details class="sx-ai-details"><summary>${tp('skillsStudio.create.ai.job.warnings', r.warnings.length)}</summary><ul class="sx-plain-list">${r.warnings.map((w) => html`<li>${w}</li>`)}</ul></details>` : ''}
      <p class="sx-help">${t(r.reviewId ? 'skillsStudio.create.ai.job.inReview' : 'skillsStudio.create.ai.job.notInReview')}</p>
      <div class="sx-row">
        ${r.reviewId ? html`<button type="button" class="sx-btn sx-btn--primary" data-ai="open-review" data-review="${r.reviewId}">${ICONS.review}<span>${t('skillsStudio.create.ai.job.openReview')}</span></button>` : ''}
        <button type="button" class="sx-btn" data-ai="open-skill" data-skill="${r.skillId}">${ICONS.edit}<span>${t('skillsStudio.create.ai.job.openDraft')}</span></button>
        <button type="button" class="sx-btn sx-btn--ghost" data-ai="back">${ICONS.plus}<span>${t('skillsStudio.create.ai.job.another')}</span></button>
      </div></div>` : ''}
    ${job.error ? html`<div class="sx-ai-error" role="alert">
      <p class="sx-err-text">${t(`skillsStudio.create.ai.error.${errorCode(job)}`)}</p>
      ${job.error.problems?.length ? '' : html`<p class="sx-help">${studioErrorText(ctx.t, job.error)}</p>`}
      ${job.error.problems?.length ? html`<ul class="sx-plain-list">${job.error.problems.slice(0, 12).map((p) => html`<li>${p.message || p.code || ''}</li>`)}</ul>` : ''}
      ${job.error.worker?.question ? html`<p>${t('skillsStudio.create.ai.job.question', { question: job.error.worker.question })}</p>` : ''}
    </div>` : ''}
    ${job.partial ? html`<p class="sx-note">${t('skillsStudio.create.ai.job.partial', { name: job.partial.name })} <button type="button" class="sx-btn sx-btn--ghost" data-ai="open-skill" data-skill="${job.partial.skillId}">${t('skillsStudio.create.ai.job.openPartial')}</button></p>` : ''}
    ${!active && !r ? html`<div class="sx-row">
      <button type="button" class="sx-btn sx-btn--primary" data-ai="retry-job"${attr('disabled', aiState(ctx) !== 'ready')}>${ICONS.update}<span>${t('skillsStudio.create.ai.job.retry')}</span></button>
      <button type="button" class="sx-btn" data-ai="edit-retry">${ICONS.edit}<span>${t('skillsStudio.create.ai.job.editRetry')}</span></button>
      <button type="button" class="sx-btn sx-btn--ghost" data-ai="back">${ICONS.back}<span>${t('skillsStudio.create.ai.job.back')}</span></button>
    </div>` : ''}
    ${active ? html`<button type="button" class="sx-btn sx-btn--ghost" data-ai="back">${ICONS.back}<span>${t('skillsStudio.create.ai.job.backWhile')}</span></button>` : ''}
    <p class="sx-sr" id="sx-ai-job-live" role="status" aria-live="polite">${t(`skillsStudio.create.ai.recent.state.${job.state}`)}</p>
  </div>`;
}

function recentHTML(ctx) {
  const { t, locale } = ctx;
  if (aiState(ctx) !== 'ready') return '';
  const list = (AI.creations || []).slice(0, 8);
  if (AI.creationsFailed) return html`<p class="sx-field-note sx-err-text">${t('skillsStudio.create.ai.recent.failed', { error: AI.creationsFailed })}</p>`;
  if (!list.length) return '';
  return html`<div class="sx-ai-recent"><h4 class="sx-section-title" id="sx-ai-recent-title">${t('skillsStudio.create.ai.recent.title')}</h4>
    <ul class="sx-ai-recent-list" aria-labelledby="sx-ai-recent-title">${list.map((job) => html`<li>
      <button type="button" class="sx-ai-recent-row${AI.openJobId === job.jobId ? ' is-on' : ''}" data-ai="open-job" data-job="${job.jobId}"${attr('aria-current', AI.openJobId === job.jobId ? 'true' : null)}>
        <span class="sx-ai-dot sx-ai-dot--${job.state}" aria-hidden="true"></span>
        <span class="sx-ai-recent-name">${creationTitle(job)}</span>
        <span class="sx-ai-recent-state">${t(`skillsStudio.create.ai.recent.state.${job.state === 'done' && !job.result?.reviewId ? 'drafted' : job.state}`)}</span>
        <time class="sx-help" datetime="${job.createdAt}" title="${fullTime(job.createdAt, locale)}">${relativeTime(job.createdAt, locale)}</time>
      </button></li>`)}</ul></div>`;
}

// ── Redrawing parts ──

const live = (host, signal) => !signal.aborted && host.isConnected;
/** The form or the open creation; a switch between them brings the box's top into view (Draft sits low on a long form). */
function redrawMain(host, ctx, { focus = null, reveal = true } = {}) {
  const main = host.querySelector('#sx-ai-main');
  if (!main) return;
  setHTML(main, AI.openJobId ? jobHTML(ctx) : formHTML(ctx));
  if (reveal) revealTop(main);
  if (focus) host.querySelector(focus)?.focus({ preventScroll: true });
}
function revealTop(el) {
  const scroller = el.closest('.sx-place-scroll');
  if (!scroller) return;
  const at = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  if (at >= scroller.scrollTop && at <= scroller.scrollTop + scroller.clientHeight - 48) return;
  scroller.scrollTop = at < 160 ? 0 : at - 12;
}
function redrawRecent(host, ctx) { const el = host.querySelector('#sx-ai-recent'); if (el) setHTML(el, recentHTML(ctx)); }
function redrawEditor(host, ctx, focus = null) {
  const el = host.querySelector('#sx-ai-editor');
  if (!el) return;
  setHTML(el, editorHTML(ctx));
  const sources = host.querySelector('#sx-ai-sources');
  if (sources) setHTML(sources, sourcesHTML(ctx, form(ctx)));
  if (focus) host.querySelector(focus)?.focus({ preventScroll: true });
}
/** The job panel, keeping where the keyboard was (a button of it, by its action). */
function redrawJob(host, ctx) {
  const el = host.querySelector('#sx-ai-main');
  if (!el || !AI.openJobId) return;
  const active = document.activeElement;
  const kept = active && el.contains(active) ? active.dataset.ai || null : null;
  setHTML(el, jobHTML(ctx));
  if (kept) (el.querySelector(`[data-ai="${kept}"]`) || el.querySelector('#sx-ai-job-title'))?.focus({ preventScroll: true });
}

function problem(host, ctx, text, where = '#sx-ai-problem') {
  const p = host.querySelector(where);
  if (p) p.textContent = text || '';
}

// ── Loading ──

async function loadOptions(host, ctx, signal) {
  if (aiState(ctx) !== 'ready') return;
  const gen = ctx.gen();
  try {
    const res = await ctx.api.fetchSkillCreationOptions();
    if (!ctx.alive(gen) || !live(host, signal)) { AI.options = res; return; }
    AI.options = res; AI.optionsFailed = null;
    refreshModelList(host, ctx);
    applyAvailability(host, ctx);
    if (AI.editing === 'repo' || AI.editing === 'conversation' || AI.editing === 'url') redrawEditor(host, ctx);
  } catch (err) { AI.optionsFailed = studioErrorText(ctx.t, err); }
  // The models of every provider, from the Assistant's one catalog (never a list of the Studio's own).
  try {
    const { loadModelCatalog } = await import('../../assistant/asst-brain-picker.js');
    const catalog = await loadModelCatalog();
    if (!ctx.alive(gen) || !live(host, signal)) return;
    AI.catalog = catalog;
    refreshModelList(host, ctx);
  } catch { /* the owner's route and the providers' defaults are still offered */ }
}

/** What this server can run now, on the parts already drawn (the options arrive after the form): Draft, the page source. */
function applyAvailability(host, ctx) {
  const state = aiState(ctx);
  const button = host.querySelector('[data-ai="draft"]');
  if (button && !AI.starting) button.disabled = state !== 'ready' || draftingOff();
  const help = host.querySelector('#sx-ai-help');
  if (help) help.textContent = helpText(ctx, state);
  const sources = host.querySelector('#sx-ai-sources');
  if (sources && browserOff()) setHTML(sources, sourcesHTML(ctx, form(ctx)));
}

/** Who drafts, as the server lists it: the providers, Claude Code the default, and why one cannot start here now. */
function modelHelpText(ctx) {
  const { t, locale } = ctx;
  const providers = draftingProviders(AI.options?.drafting);
  const on = providers.filter((p) => p.available).map((p) => runtimeName(t, p.provider));
  const off = providers.filter((p) => !p.available).map((p) => (p.reason
    ? t('skillsStudio.create.ai.options.providerUnavailable', { provider: runtimeName(t, p.provider), reason: p.reason })
    : t('skillsStudio.create.ai.options.providerOffPlain', { provider: runtimeName(t, p.provider) })));
  const claudeOn = providers.some((p) => p.provider === 'claude-code' && p.available);
  const lead = !on.length ? t('skillsStudio.create.ai.options.draftsNone')
    : t(claudeOn ? 'skillsStudio.create.ai.options.draftsOn' : 'skillsStudio.create.ai.options.draftsOnOnly', { providers: listText(on, locale) });
  return [lead, ...off].join(' ');
}

/** The model dropdown's entries: the server's providers (none known yet: Claude Code), each in the page's words. */
function modelList(ctx, selected) {
  const { t } = ctx;
  const words = {
    route: (target) => t('skillsStudio.create.ai.options.route', { target: targetText(t, target) }),
    fallback: t('skillsStudio.create.ai.options.fallback'),
    providerDefault: (p) => t('skillsStudio.create.ai.options.providerDefault', { provider: runtimeName(t, p) }),
    providerOff: (p, reason) => (reason
      ? t('skillsStudio.create.ai.options.providerOff', { provider: runtimeName(t, p), reason })
      : t('skillsStudio.create.ai.options.providerOffPlain', { provider: runtimeName(t, p) })),
    provider: (p) => runtimeName(t, p),
  };
  return modelEntries({ defaultTarget: AI.options?.defaultTarget || null, catalog: AI.catalog, selected, words, providers: draftingProviders(AI.options?.drafting) });
}

function refreshModelList(host, ctx) {
  const input = host.querySelector('#sx-ai-model');
  if (!input) return;
  const f = form(ctx);
  setDropdownItems(input, modelList(ctx, f.target));
  // Once the server has said who can draft, the request names what the list shows: a kept choice of a provider that
  // cannot start here now (or the default, when Claude Code cannot) gives way to the first one that can.
  if (AI.options && !draftingOff() && input.value !== f.target) keep(ctx, { ...f, target: input.value });
  const help = host.querySelector('#sx-ai-model-help');
  if (help) help.textContent = modelHelpText(ctx);
}

async function loadCreations(host, ctx, signal) {
  if (aiState(ctx) !== 'ready') return;
  const gen = ctx.gen();
  try {
    const res = await ctx.api.fetchSkillCreations({ limit: 12 });
    if (!ctx.alive(gen) || !live(host, signal)) return;
    AI.creations = res.creations || []; AI.creationsFailed = null;
  } catch (err) {
    if (!ctx.alive(gen) || !live(host, signal)) return;
    AI.creationsFailed = studioErrorText(ctx.t, err);
  }
  redrawRecent(host, ctx);
}

async function loadSessions(host, ctx, signal) {
  if (aiState(ctx) !== 'ready') return;
  const c = AI.conv;
  const mine = ++AI.seq;
  c.loading = true; c.failed = null;
  const list = host.querySelector('#sx-ai-sessions');
  if (list && !c.list) setHTML(list, sessionsHTML(ctx));
  try {
    const res = await ctx.api.fetchSkillCreationSessions({ provider: c.provider, project: c.project, q: c.q, limit: 30 });
    if (mine !== AI.seq || !live(host, signal)) return;
    c.list = res.sessions || [];
    if (!c.list.some((s) => s.sessionId === c.chosen)) c.chosen = null;
  } catch (err) {
    if (mine !== AI.seq || !live(host, signal)) return;
    c.failed = studioErrorText(ctx.t, err); c.list = null;
  }
  c.loading = false;
  const el = host.querySelector('#sx-ai-sessions');
  if (el) setHTML(el, sessionsHTML(ctx));
}

/** Follow the open creation while it runs: a long poll, one at a time, ended by the place's signal. */
async function follow(host, ctx, signal) {
  const gen = ctx.gen();
  const id = AI.openJobId;
  if (!id) return;
  if (!AI.job || AI.job.jobId !== id) {
    try { AI.job = (await ctx.api.fetchSkillCreation(id)).creation; } catch (err) {
      if (!ctx.alive(gen) || !live(host, signal) || AI.openJobId !== id) return;
      AI.openJobId = null; AI.job = null;
      ctx.toast(ctx.t('skillsStudio.create.ai.job.gone', { error: studioErrorText(ctx.t, err) }), 'error');
      redrawMain(host, ctx);
      return;
    }
    if (!ctx.alive(gen) || !live(host, signal) || AI.openJobId !== id) return;
    redrawJob(host, ctx);
  }
  tickClock(host, ctx, signal);
  while (live(host, signal) && ctx.alive(gen) && AI.openJobId === id && isActiveCreation(AI.job?.state)) {
    let next = null;
    try { next = (await ctx.api.waitSkillCreation(id, { since: AI.job.version, seconds: pollSeconds(AI.job) })).creation; } catch {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!live(host, signal) || !ctx.alive(gen) || AI.openJobId !== id) return;
    const was = AI.job?.state;
    AI.job = next;
    upsertRecent(next);
    redrawJob(host, ctx);
    if (was !== next.state) {
      ctx.announce(ctx.t(`skillsStudio.create.ai.recent.state.${next.state}`));
      redrawRecent(host, ctx);
    }
    if (!isActiveCreation(next.state)) {
      AI.cancelling = false;
      redrawJob(host, ctx);
      // What it made is in the library and the Review queue now: the rail's count and the rows follow.
      if (next.state === 'done' || next.partial) ctx.reload();
      return;
    }
  }
}

/** The running clock of the open creation, once a second, while it runs. */
function tickClock(host, ctx, signal) {
  clearInterval(AI.tick);
  AI.tick = setInterval(() => {
    const el = host.querySelector('#sx-ai-clock');
    if (!live(host, signal) || !el || !isActiveCreation(AI.job?.state)) { clearInterval(AI.tick); return; }
    el.textContent = clockText(elapsedSeconds(AI.job));
  }, 1000);
  signal.addEventListener('abort', () => clearInterval(AI.tick), { once: true });
}

function upsertRecent(job) {
  const list = AI.creations || [];
  const i = list.findIndex((j) => j.jobId === job.jobId);
  AI.creations = i >= 0 ? [...list.slice(0, i), job, ...list.slice(i + 1)] : [job, ...list];
}

// ── Actions ──

async function startDraft(host, ctx, signal) {
  const { t } = ctx;
  if (aiState(ctx) !== 'ready' || AI.starting || draftingOff()) return;
  const { ok, body, problems } = buildCreationRequest(form(ctx));
  if (!ok) {
    const key = problemKey(problems[0]);
    problem(host, ctx, t(`skillsStudio.create.ai.problem.${key}`));
    (key === 'prompt' ? host.querySelector('#sx-cr-prompt') : key === 'name' ? host.querySelector('#sx-ai-name') : host.querySelector('#sx-ai-sources button'))?.focus();
    return;
  }
  problem(host, ctx, '');
  const button = host.querySelector('[data-ai="draft"]');
  if (button) button.disabled = true;
  // One start at a time: the keyboard shortcut does not see the disabled button, and every start has its own key.
  AI.starting = true;
  const gen = ctx.gen();
  try {
    const res = await ctx.api.startSkillCreation(body, { idempotencyKey: ctx.key('ai-create') });
    if (!ctx.alive(gen)) return;
    keep(ctx, form(ctx), { now: true });
    AI.openJobId = res.creation.jobId; AI.job = res.creation; AI.cancelling = false;
    upsertRecent(res.creation);
    if (!live(host, signal)) return;
    redrawMain(host, ctx, { focus: '#sx-ai-job-title' });
    redrawRecent(host, ctx);
    ctx.announce(t('skillsStudio.create.ai.job.started'));
    follow(host, ctx, signal);
  } catch (err) {
    if (!ctx.alive(gen) || !live(host, signal)) return;
    if (button) button.disabled = false;
    const key = Array.isArray(err?.body?.problems) && err.body.problems.length ? `problem.${problemKey(err.body.problems[0])}` : `error.${CREATION_ERRORS.includes(err?.code) ? err.code : 'other'}`;
    problem(host, ctx, `${t(`skillsStudio.create.ai.${key}`)} ${studioErrorText(ctx.t, err)}`.trim());
  } finally { AI.starting = false; }
}

async function cancelJob(host, ctx, signal) {
  const job = AI.job;
  if (!job || !isActiveCreation(job.state) || AI.cancelling) return;
  AI.cancelling = true;
  redrawJob(host, ctx);
  const gen = ctx.gen();
  try {
    const res = await ctx.api.cancelSkillCreation(job.jobId);
    if (!ctx.alive(gen) || AI.openJobId !== job.jobId) return;
    if (res?.creation && res.creation.version >= (AI.job?.version || 0)) { AI.job = res.creation; upsertRecent(res.creation); }
  } catch (err) {
    if (!ctx.alive(gen)) return;
    AI.cancelling = false;
    ctx.toast(ctx.t('skillsStudio.create.ai.job.cancelFailed', { error: studioErrorText(ctx.t, err) }), 'error');
  }
  if (live(host, signal) && AI.openJobId === job.jobId) { redrawJob(host, ctx); redrawRecent(host, ctx); }
}

async function retryJob(host, ctx, signal) {
  const job = AI.job;
  if (!job || isActiveCreation(job.state) || AI.starting) return;
  AI.starting = true;
  const gen = ctx.gen();
  try {
    const res = await ctx.api.retrySkillCreation(job.jobId, { idempotencyKey: ctx.key('ai-retry') });
    if (!ctx.alive(gen)) return;
    AI.openJobId = res.creation.jobId; AI.job = res.creation; AI.cancelling = false;
    upsertRecent(res.creation);
    if (!live(host, signal)) return;
    redrawMain(host, ctx, { focus: '#sx-ai-job-title' });
    redrawRecent(host, ctx);
    follow(host, ctx, signal);
  } catch (err) { if (ctx.alive(gen)) ctx.toast(ctx.t('skillsStudio.create.ai.job.retryFailed', { error: studioErrorText(ctx.t, err) }), 'error'); } finally { AI.starting = false; }
}

/** The request of a creation back in the form, to change it and start again. */
function editRetry(host, ctx) {
  const req = AI.job?.request;
  if (!req) return;
  const f = form(ctx);
  const runtimes = (req.targets || []).map((x) => x.runtime).filter((r) => DRAFT_RUNTIMES.includes(r));
  keep(ctx, { ...f, prompt: req.prompt || '', example: req.example || '', showExample: !!req.example, name: req.name || '', invocation: req.invocation === 'manual' ? 'manual' : 'auto',
    sources: (req.sources || []).slice(0, CREATION_LIMITS.sources), runtimes: runtimes.length ? runtimes : f.runtimes,
    target: req.target?.provider ? `${req.target.provider}${req.target.model ? `|${req.target.model}` : ''}` : '', minutes: WORK_MINUTES.includes(req.maxMinutes) ? req.maxMinutes : f.minutes }, { now: true });
  AI.openJobId = null; AI.job = null;
  redrawMain(host, ctx, { focus: '#sx-cr-prompt' });
  redrawRecent(host, ctx);
}

function add(host, ctx, source, focusAfter = '[data-ai="draft"]') {
  const { t } = ctx;
  const { form: next, outcome } = addSource(form(ctx), source);
  if (outcome !== 'added') { problem(host, ctx, t(outcome === 'duplicate' ? 'skillsStudio.create.ai.duplicate' : 'skillsStudio.create.ai.full', { count: CREATION_LIMITS.sources }), '#sx-ai-editor-problem'); return; }
  keep(ctx, next);
  AI.editing = null;
  redrawEditor(host, ctx, focusAfter);
  ctx.announce(t('skillsStudio.create.ai.added', { name: sourceChip(source).label }));
}

async function importFileSource(host, ctx, signal) {
  const { t } = ctx;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.skill.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const gen = ctx.gen();
    let bundle;
    try { bundle = JSON.parse(await file.text()); } catch { problem(host, ctx, t('skillsStudio.import.notJson'), '#sx-ai-editor-problem'); return; }
    if (!bundle || bundle.format !== 'synabun-skill-bundle' || bundle.type !== 'skill') { problem(host, ctx, t('skillsStudio.create.ai.import.notSkill'), '#sx-ai-editor-problem'); return; }
    try {
      // Staged and scanned by the server, outside every runtime's folders; nothing of it is installed from here.
      const res = await ctx.api.stageSkillsImport(bundle, 'global');
      if (!ctx.alive(gen) || !live(host, signal)) return;
      add(host, ctx, { kind: 'import', stagingId: res.staged.stagingId, label: String(bundle.name || file.name).slice(0, 120) });
    } catch (err) { if (ctx.alive(gen) && live(host, signal)) problem(host, ctx, t('skillsStudio.create.ai.import.failed', { error: studioErrorText(ctx.t, err) }), '#sx-ai-editor-problem'); }
  });
  input.click();
}

// ── Wiring ──

/** The AI box's listeners, on the Create place's host (they end with the place's signal). */
export function wireAi(host, ctx, signal) {
  const { t } = ctx;
  if (aiState(ctx) === 'guest') return;
  host.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.closest?.('#sx-ai')) return;
    const f = form(ctx);
    if (el.closest('.sx-ai-editor')) problem(host, ctx, '', '#sx-ai-editor-problem');
    if (el.id === 'sx-cr-prompt') { keep(ctx, { ...f, prompt: el.value }); const c = host.querySelector('#sx-ai-prompt-count'); if (c) c.textContent = `${el.value.length} / ${CREATION_LIMITS.promptChars}`; try { ctx.storage.setItem(PROMPT_KEY, el.value); } catch {} problem(host, ctx, ''); }
    else if (el.id === 'sx-ai-example') keep(ctx, { ...f, example: el.value });
    else if (el.id === 'sx-ai-name') keep(ctx, { ...f, name: el.value.trim() });
    else if (el.id === 'sx-ai-conv-q') {
      AI.conv.q = el.value;
      clearTimeout(AI.conv.timer);
      AI.conv.timer = setTimeout(() => { if (!signal.aborted) loadSessions(host, ctx, signal); }, 300);
    }
  }, { signal });
  host.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.closest?.('#sx-ai')) return;
    const f = form(ctx);
    if (el.name === 'sx-ai-inv') keep(ctx, { ...f, invocation: el.value === 'manual' ? 'manual' : 'auto' });
    else if (el.name === 'sx-ai-runtime') keep(ctx, { ...f, runtimes: [...host.querySelectorAll('input[name="sx-ai-runtime"]:checked')].map((x) => x.value) });
    else if (el.id === 'sx-ai-model') keep(ctx, { ...f, target: el.value });
    else if (el.id === 'sx-ai-minutes') keep(ctx, { ...f, minutes: Number(el.value) || f.minutes });
    else if (el.id === 'sx-ai-conv-provider') { AI.conv.provider = el.value; AI.conv.chosen = null; AI.conv.list = null; loadSessions(host, ctx, signal); }
    else if (el.id === 'sx-ai-conv-project') { AI.conv.project = el.value; AI.conv.chosen = null; loadSessions(host, ctx, signal); }
  }, { signal });
  host.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-ai]');
    if (!btn || btn.disabled || !host.contains(btn)) return;
    const act = btn.dataset.ai;
    const f = form(ctx);
    if (act === 'show-example') { keep(ctx, { ...f, showExample: true }); redrawMain(host, ctx, { focus: '#sx-ai-example', reveal: false }); }
    else if (act === 'edit-source') {
      AI.editing = AI.editing === btn.dataset.kind ? null : btn.dataset.kind;
      redrawEditor(host, ctx, AI.editing ? '#sx-ai-editor input, #sx-ai-editor .cc-dropdown-trigger, #sx-ai-editor button' : `[data-ai="edit-source"][data-kind="${btn.dataset.kind}"]`);
      if (AI.editing === 'conversation') loadSessions(host, ctx, signal);
    } else if (act === 'close-editor') { const was = AI.editing; AI.editing = null; redrawEditor(host, ctx, `[data-ai="edit-source"][data-kind="${was}"]`); }
    else if (act === 'remove-source') {
      const i = Number(btn.dataset.index);
      const removed = f.sources[i];
      keep(ctx, removeSource(f, i));
      redrawEditor(host, ctx, '#sx-ai-sources [data-ai="remove-source"], [data-ai="edit-source"]');
      if (removed) ctx.announce(t('skillsStudio.create.ai.removed', { name: sourceChip(removed).label }));
    } else if (act === 'pick-session') {
      AI.conv.chosen = btn.dataset.session;
      problem(host, ctx, '', '#sx-ai-editor-problem');
      for (const b of host.querySelectorAll('.sx-ai-session')) { const on = b.dataset.session === AI.conv.chosen; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
    } else if (act === 'add-conversation') {
      const s = (AI.conv.list || []).find((x) => x.sessionId === AI.conv.chosen);
      if (!s) { problem(host, ctx, t('skillsStudio.create.ai.conv.pick'), '#sx-ai-editor-problem'); return; }
      add(host, ctx, { kind: 'conversation', provider: AI.conv.provider, sessionId: s.sessionId, project: s.project || null, label: (s.title || s.sessionId).slice(0, 120) });
    } else if (act === 'add-url') {
      const url = host.querySelector('#sx-ai-url')?.value.trim() || '';
      if (urlProblem(url)) { problem(host, ctx, t('skillsStudio.create.ai.url.invalid'), '#sx-ai-editor-problem'); host.querySelector('#sx-ai-url')?.focus(); return; }
      add(host, ctx, { kind: 'url', url });
    } else if (act === 'add-repo') {
      const project = host.querySelector('#sx-ai-repo')?.value || '';
      if (!project) { problem(host, ctx, t('skillsStudio.create.ai.repo.choose'), '#sx-ai-editor-problem'); return; }
      const paths = (host.querySelector('#sx-ai-repo-paths')?.value || '').split('\n').map((p) => p.trim()).filter(Boolean);
      if (paths.length > CREATION_LIMITS.paths || paths.some((p) => relativePathProblem(p))) { problem(host, ctx, t('skillsStudio.create.ai.repo.pathsInvalid', { count: CREATION_LIMITS.paths }), '#sx-ai-editor-problem'); return; }
      const label = (AI.options?.repo || ctx.projects).find((p) => p.path === project)?.label || project;
      add(host, ctx, { kind: 'repo', project, paths, label });
    } else if (act === 'add-memory') {
      const query = host.querySelector('#sx-ai-memory-q')?.value.trim() || '';
      if (!query) { problem(host, ctx, t('skillsStudio.create.ai.memory.empty'), '#sx-ai-editor-problem'); host.querySelector('#sx-ai-memory-q')?.focus(); return; }
      const project = host.querySelector('#sx-ai-memory-project')?.value.trim() || null;
      add(host, ctx, { kind: 'memory', query, ...(project ? { project } : {}) });
    } else if (act === 'add-import-skill') {
      const skillId = host.querySelector('#sx-ai-import-skill')?.value || '';
      if (!skillId) { problem(host, ctx, t('skillsStudio.create.ai.import.chooseSkill'), '#sx-ai-editor-problem'); return; }
      const name = (ctx.data?.skills || []).find((s) => s.skillId === skillId)?.name || skillId;
      add(host, ctx, { kind: 'import', skillId, label: name });
    } else if (act === 'import-file') importFileSource(host, ctx, signal);
    else if (act === 'draft') startDraft(host, ctx, signal);
    else if (act === 'open-job') {
      AI.openJobId = btn.dataset.job; AI.job = (AI.creations || []).find((j) => j.jobId === btn.dataset.job) || null; AI.cancelling = false;
      redrawMain(host, ctx, { focus: '#sx-ai-job-title' });
      redrawRecent(host, ctx);
      follow(host, ctx, signal);
    } else if (act === 'back') { AI.openJobId = null; AI.job = null; redrawMain(host, ctx, { focus: '#sx-cr-prompt' }); redrawRecent(host, ctx); }
    else if (act === 'cancel-job') cancelJob(host, ctx, signal);
    else if (act === 'retry-job') retryJob(host, ctx, signal);
    else if (act === 'edit-retry') editRetry(host, ctx);
    else if (act === 'open-review') ctx.openReview?.(btn.dataset.review);
    else if (act === 'open-skill') ctx.openRow(`lib:${btn.dataset.skill}`, { tab: 'edit' }).then((opened) => { if (!opened) ctx.reload().then(() => ctx.openRow(`lib:${btn.dataset.skill}`, { tab: 'edit' })); });
  }, { signal });
  host.addEventListener('keydown', (e) => {
    if ((ctx.mac ? e.metaKey : e.ctrlKey) && e.key === 'Enter' && e.target.closest?.('.sx-ai-form')) { e.preventDefault(); startDraft(host, ctx, signal); }
  }, { signal });
  loadOptions(host, ctx, signal);
  loadCreations(host, ctx, signal);
  // A session list left mid-load (or long ago) is asked for again when the place is drawn with its editor open.
  if (AI.editing === 'conversation') loadSessions(host, ctx, signal);
  if (AI.openJobId) follow(host, ctx, signal);
}

/** The place was left: what the box was waiting for is not drawn any more. */
export function leaveAi() { clearInterval(AI.tick); clearTimeout(AI.conv.timer); clearTimeout(AI.saveTimer); AI.pendingSave?.(); }

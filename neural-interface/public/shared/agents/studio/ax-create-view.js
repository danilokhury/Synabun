// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: Create
// ═══════════════════════════════════════════
//
// The short way to a new agent. Five starts: a blank form, one of a few sensible roles, a copy of an agent that
// exists, a file (a Claude Code agent `.md`, or a JSON bundle exported from an Agents Studio), or a description
// handed to the SynaBun Assistant, which drafts the agent and sends it to Review. Whatever the start, the result
// is a draft: nothing is approved by creating, copying or importing (an import lands as a draft whatever the file
// says). Blank and template open the editor on an unsaved form; copy and import make drafts on the server and say
// what happened to each; "Describe it" opens the Assistant with the request and then waits for the draft to arrive.

import { html, setHTML, ICONS } from '../../skills/studio/sx-dom.js';
import { wireDropdowns } from '../../cc-dropdown.js';
import { CREATE_MODES, keyOf, agentKeyText } from './ax-views.js';
import { TEMPLATES, templateById, templateForm, describeRequest } from './ax-templates.js';
import { scopeEntries, scopeFromValue } from './ax-options.js';
import { sortAgents } from './ax-library.js';
import { AX_ICONS } from './ax-icons.js';
import { agentMark, dropdown, errorText, readFileText, wordOr, scopeTag } from './ax-ui.js';
import { duplicateAgent } from './ax-agent-view.js';

let life = null;

export function leaveCreate() {
  life?.abort();
  life = null;
}

const START_ICON = { blank: ICONS.plus, template: ICONS.spark, copy: AX_ICONS.copy, import: ICONS.upload, describe: AX_ICONS.send };

/** The file types Import takes. */
export const IMPORT_ACCEPT = '.md,.markdown,.json,text/markdown,application/json';

/** What an import's file is, by its name and its first character: a Claude Code agent file, or a JSON bundle. */
export function importKind(fileName, text) {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.json')) return 'bundle';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'claude';
  return /^\s*[[{]/.test(String(text || '')) ? 'bundle' : 'claude';
}

function startsHTML(ctx) {
  const { t } = ctx;
  const modes = CREATE_MODES.filter((mode) => (mode === 'copy' ? ctx.caps.has('copy') && ctx.agents.length : mode === 'import' ? ctx.caps.has('import') || ctx.caps.has('import-claude-agent') : true));
  return html`<div class="ax-starts" role="list">${modes.map((mode, n) => html`<div role="listitem"><button type="button" class="ax-start" data-act="start" data-mode="${mode}"${n === 0 ? html` data-autofocus` : ''}>
      <span class="ax-start-icon" aria-hidden="true">${START_ICON[mode]}</span>
      <span class="ax-start-text"><span class="ax-start-name">${t(`agentsStudio.create.start.${mode}.name`)}</span><span class="ax-start-desc">${t(`agentsStudio.create.start.${mode}.desc`)}</span></span>
    </button></div>`)}</div>`;
}

function templatesHTML(ctx) {
  const { t } = ctx;
  return html`<div class="ax-templates" role="list">${TEMPLATES.map((tpl, n) => html`<div role="listitem"><button type="button" class="ax-template" data-act="use-template" data-template="${tpl.id}"${n === 0 ? html` data-autofocus` : ''}>
      <span class="ax-template-top">${agentMark(tpl, 18)}<span class="ax-template-name">${t(`agentsStudio.templates.${tpl.id}.name`)}</span></span>
      <span class="ax-template-desc">${t(`agentsStudio.templates.${tpl.id}.description`)}</span>
      <span class="ax-template-facts"><span class="sx-chip ax-chip">${wordOr(t, `agentsStudio.capability.${tpl.capability}`, 'name')}</span>${tpl.usesBrowser ? html`<span class="sx-chip ax-chip">${t('agentsStudio.field.usesBrowser')}</span>` : ''}${tpl.taskClasses.map((cls) => html`<span class="sx-chip ax-chip">${wordOr(t, 'agentsStudio.taskClass', cls)}</span>`)}</span>
    </button></div>`)}</div>`;
}

function copyHTML(ctx) {
  const { t } = ctx;
  const rows = sortAgents(ctx.agents, 'name');
  return html`<ul class="ax-pick-list" aria-label="${t('agentsStudio.create.copy.pick')}">${rows.map((agent, n) => html`<li><button type="button" class="ax-pick" data-act="copy-agent" data-agent="${agentKeyText(keyOf(agent))}"${n === 0 ? html` data-autofocus` : ''}>
      ${agentMark(agent, 16)}<span class="ax-pick-name">${agent.name || agent.id}</span><span class="sx-mono ax-pick-id">${agent.id}</span>${scopeTag(t, agent.scope, ctx.info?.projects)}
    </button></li>`)}</ul>`;
}

function resultHTML(ctx, result) {
  const { t } = ctx;
  if (!result) return '';
  if (result.error) return html`<div class="sx-banner sx-banner--warn" role="alert">${ICONS.warn}<span class="sx-banner-text">${result.error}</span></div>`;
  const rows = result.rows || [];
  const tone = { created: 'ok', drafted: 'ok', unchanged: 'off', skipped: 'warn', invalid: 'err' };
  return html`<section class="ax-import-result" aria-labelledby="ax-import-result-title">
    <h4 class="sx-section-title" id="ax-import-result-title" tabindex="-1">${ctx.tp('agentsStudio.create.import.done', result.imported ?? 0)}</h4>
    <p class="sx-help">${t('agentsStudio.create.import.asDrafts')}</p>
    <ul class="sx-results ax-import-rows">${rows.map((row) => html`<li class="sx-result">
      <span class="sx-state-chip ax-run-state ax-run-state--${tone[row.action] || 'idle'}">${wordOr(t, 'agentsStudio.create.import.action', row.action)}</span>
      <span class="sx-mono">${row.id || t('agentsStudio.create.import.noId')}</span>
      ${row.reason ? html`<span class="sx-dim">${wordOr(t, 'agentsStudio.create.import.reason', row.reason)}</span>` : ''}
      ${Array.isArray(row.errors) && row.errors.length ? html`<span class="sx-err-text">${row.errors.slice(0, 3).map((issue) => issue.message).join(' ')}</span>` : ''}
      ${row.id && (row.action === 'created' || row.action === 'drafted' || row.action === 'unchanged') ? html`<button type="button" class="sx-btn sx-btn--sm" data-act="open-imported" data-id="${row.id}" data-scope="${row.scope?.kind === 'project' ? `project:${row.scope.path}` : 'global'}">${t('agentsStudio.create.import.open')}</button>` : ''}
    </li>`)}</ul>
    ${result.notes?.length ? html`<div class="sx-note"><p class="ax-note-title">${t('agentsStudio.create.import.notes')}</p><ul class="sx-plain-list">${result.notes.map((note) => html`<li>${note}</li>`)}</ul></div>` : ''}
  </section>`;
}

function importHTML(ctx, st) {
  const { t } = ctx;
  const scopes = [{ value: 'keep', label: t('agentsStudio.create.import.scopeKeep'), selected: st.scope === 'keep' }, ...scopeEntries(ctx.info?.projects || [], st.scope === 'keep' ? null : scopeFromValue(st.scope), { globalLabel: t('agentsStudio.scope.globalLibrary'), projectsLabel: t('agentsStudio.scope.pinTo') }).map((entry) => (entry.value === 'global' ? { ...entry, selected: st.scope === 'global' } : entry))];
  return html`<div class="ax-import">
    <div class="ax-drop" id="ax-drop" tabindex="-1">
      <span class="ax-start-icon" aria-hidden="true">${ICONS.upload}</span>
      <p class="ax-drop-text">${t('agentsStudio.create.import.drop')}</p>
      <button type="button" class="sx-btn sx-btn--primary" data-act="pick-file" data-autofocus${st.busy ? html` disabled` : ''}>${t('agentsStudio.create.import.choose')}</button>
      <input type="file" id="ax-import-file" accept="${IMPORT_ACCEPT}" hidden>
      <p class="sx-help">${t('agentsStudio.create.import.kinds')}</p>
    </div>
    <div class="ax-import-options">
      <div class="sx-field"><span class="sx-field-label" id="ax-import-scope-label">${t('agentsStudio.create.import.scope')}</span>${dropdown('ax-import-scope', scopes, { labelledBy: 'ax-import-scope-label' })}<p class="sx-field-note">${t('agentsStudio.create.import.scopeHelp')}</p></div>
      <label class="sx-choice"><input type="checkbox" class="sx-check" id="ax-import-replace"${st.replace ? html` checked` : ''}><span>${t('agentsStudio.create.import.replace')}</span></label>
    </div>
    <div id="ax-import-result" aria-live="polite">${st.busy ? html`<p class="sx-note" role="status"><span class="ax-spinner" aria-hidden="true"></span> ${t('agentsStudio.create.import.reading')}</p>` : resultHTML(ctx, st.result)}</div>
  </div>`;
}

function describeHTML(ctx, st) {
  const { t } = ctx;
  const scopes = scopeEntries(ctx.info?.projects || [], scopeFromValue(st.scope), { globalLabel: t('agentsStudio.scope.globalLibrary'), projectsLabel: t('agentsStudio.scope.pinTo') });
  return html`<div class="ax-describe">
    <div class="sx-field"><label class="sx-field-label" for="ax-describe-text">${t('agentsStudio.create.describe.label')}</label>
      <textarea class="sx-input sx-textarea ax-describe-text" id="ax-describe-text" rows="6" placeholder="${t('agentsStudio.create.describe.placeholder')}" data-autofocus>${st.text}</textarea>
      <p class="sx-field-note">${t('agentsStudio.create.describe.help')}</p></div>
    <div class="sx-field ax-describe-scope"><span class="sx-field-label" id="ax-describe-scope-label">${t('agentsStudio.field.scope')}</span>${dropdown('ax-describe-scope', scopes, { labelledBy: 'ax-describe-scope-label' })}</div>
    <div class="sx-row"><button type="button" class="sx-btn sx-btn--primary" data-act="send-describe">${AX_ICONS.send}${t('agentsStudio.create.describe.send')}</button><span class="sx-help">${t('agentsStudio.create.describe.review')}</span></div>
    ${st.sent ? html`<div class="sx-banner sx-banner--ok" role="status">${ICONS.ok}<span class="sx-banner-text">${ctx.awaitingDraft ? t('agentsStudio.create.describe.sent') : t('agentsStudio.create.describe.arrived')}</span><button type="button" class="sx-btn sx-btn--sm" data-act="go-review">${t('agentsStudio.create.describe.openReview')}</button></div>` : ''}
  </div>`;
}

const STEP_HTML = { template: templatesHTML, copy: copyHTML };

/** Draw Create in the main area: its starts, or the step of the start that was chosen. */
export function renderCreate(main, ctx, st) {
  leaveCreate();
  life = new AbortController();
  const { signal } = life;
  const { t } = ctx;
  const mode = ['template', 'copy', 'import', 'describe'].includes(ctx.view.create) ? ctx.view.create : null;
  const step = !mode ? startsHTML(ctx) : mode === 'import' ? importHTML(ctx, st.import) : mode === 'describe' ? describeHTML(ctx, st.describe) : STEP_HTML[mode](ctx);
  setHTML(main, html`<section class="sx-place ax-place" aria-labelledby="ax-create-title">
    <header class="sx-place-head">
      ${mode ? html`<button type="button" class="sx-link" data-act="back">${ICONS.back}${t('agentsStudio.rail.create')}</button>` : ''}
      <h3 class="sx-place-title" id="ax-create-title" tabindex="-1">${mode ? t(`agentsStudio.create.start.${mode}.name`) : t('agentsStudio.create.title')}</h3>
      <p class="sx-place-sub">${mode ? t(`agentsStudio.create.step.${mode}`) : t('agentsStudio.create.sub')}</p>
    </header>
    <div class="sx-place-scroll"><div class="ax-create">${!ctx.canDraft ? html`<p class="sx-note">${t('agentsStudio.error.ownerOnly')}</p>` : step}
      ${!mode ? html`<p class="sx-explain ax-create-foot">${t('agentsStudio.create.foot')}</p>` : ''}</div></div>
  </section>`);
  wireDropdowns(main, { signal });
  const provider = ctx.info?.providers?.[0] || '';

  const runImport = async (file) => {
    const s = st.import;
    if (!file || s.busy) return;
    s.busy = true;
    s.result = null;
    ctx.render({ keepFocus: true });
    try {
      const text = await readFileText(file);
      const kind = importKind(file.name, text);
      const scope = s.scope === 'keep' ? null : scopeFromValue(s.scope);
      if (kind === 'claude') {
        const res = await ctx.api.importClaudeAgent({ markdown: text, fileName: file.name, scope, replaceDraft: s.replace });
        s.result = { imported: 1, rows: [{ id: res.agent.id, scope: res.agent.scope, action: res.action || 'created' }], notes: res.notes || [] };
      } else {
        let bundle;
        try { bundle = JSON.parse(text); } catch { throw Object.assign(new Error(t('agentsStudio.create.import.notJson')), { code: 'not_json_file' }); }
        const res = await ctx.api.importBundle(bundle, { scope, replaceDrafts: s.replace });
        s.result = { imported: res.imported, rows: res.results || [], notes: [] };
      }
      ctx.changed();
      await ctx.reload({ quiet: true });
    } catch (error) {
      s.result = { error: error.code === 'file_too_large' ? t('agentsStudio.create.import.tooLarge') : error.code === 'not_json_file' ? error.message : t('agentsStudio.create.import.failed', { error: errorText(t, error) }) };
    }
    s.busy = false;
    ctx.render();
    requestAnimationFrame(() => main.ownerDocument.getElementById('ax-import-result-title')?.focus({ preventScroll: true }));
  };

  main.addEventListener('click', async (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !main.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'back') ctx.go({ type: 'back' });
    else if (act === 'start') {
      const chosen = el.dataset.mode;
      if (chosen === 'blank') ctx.startNew({ source: 'blank', provider });
      else ctx.go({ type: 'place', place: 'create', create: chosen });
    } else if (act === 'use-template') {
      const tpl = templateById(el.dataset.template);
      ctx.startNew({ source: 'template', form: templateForm(tpl, t, { provider, taskClasses: ctx.info?.taskClasses, idLimit: Number(ctx.info?.limits?.id) || 64 }) });
    } else if (act === 'copy-agent') {
      const agent = ctx.agents.find((a) => agentKeyText(keyOf(a)) === el.dataset.agent);
      if (!agent) return;
      const made = await duplicateAgent(ctx, keyOf(agent), agent.name);
      if (made) { await ctx.reload({ quiet: true }); ctx.go({ type: 'agent', key: made, tab: 'edit' }); }
    } else if (act === 'pick-file') main.querySelector('#ax-import-file')?.click();
    else if (act === 'open-imported') ctx.go({ type: 'agent', key: { id: el.dataset.id, scope: scopeFromValue(el.dataset.scope) }, tab: 'edit' });
    else if (act === 'go-review') ctx.go({ type: 'place', place: 'review' });
    else if (act === 'send-describe') {
      const s = st.describe;
      const text = s.text.trim();
      if (!text) { ctx.toast(t('agentsStudio.create.describe.required'), 'error'); main.querySelector('#ax-describe-text')?.focus(); return; }
      ctx.askAssistant(describeRequest(text, t, { scope: scopeFromValue(s.scope) }));
      s.sent = true;
      ctx.render({ keepFocus: true });
    }
  }, { signal });
  main.addEventListener('input', (e) => { if (e.target.id === 'ax-describe-text') st.describe.text = e.target.value; }, { signal });
  main.addEventListener('change', (e) => {
    if (e.target.id === 'ax-import-scope') st.import.scope = e.target.value;
    else if (e.target.id === 'ax-import-replace') st.import.replace = e.target.checked;
    else if (e.target.id === 'ax-describe-scope') st.describe.scope = e.target.value;
    else if (e.target.id === 'ax-import-file') { const file = e.target.files?.[0]; e.target.value = ''; runImport(file); }
  }, { signal });
  // A file dropped on the import box is imported like a picked one.
  const drop = main.querySelector('#ax-drop');
  if (drop) {
    const over = (on) => drop.classList.toggle('is-over', on);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); over(true); }, { signal });
    drop.addEventListener('dragleave', () => over(false), { signal });
    drop.addEventListener('drop', (e) => { e.preventDefault(); over(false); runImport(e.dataTransfer?.files?.[0]); }, { signal });
  }
}

/** What Create remembers between drawings while the window is open. */
export function newCreateState() {
  return { import: { scope: 'keep', replace: false, busy: false, result: null }, describe: { text: '', scope: 'global', sent: false } };
}


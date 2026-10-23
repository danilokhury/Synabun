// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the inspector beside the document
// ═══════════════════════════════════════════
//
// Form | YAML over the same document, never a copy of it (P0's lossless frontmatter: ss-frontmatter.js parses,
// ss-form.js says what each field shows, a change of a field patches that one key of the text). Keys the form has
// no field for are listed under Advanced, "kept as written", with the lines they are on. The description helper
// counts each runtime's budget and says whether the description tells what the skill does and when to use it.
// Problems come from the same checks as the server (ss-lint.js) and, for a skill, each runtime's profile
// (ss-profiles.js); a problem jumps to its line. Snippets go in at the caret (body) or as keys (frontmatter).
// While another file of the skill is showing, the form only shows: it changes SKILL.md, and Save saves the file
// on screen. Every string is a `skillsStudio.*` key; values from the document reach the markup as text only.

import { dropdownHTML } from '../../cc-dropdown.js';
import { formView, fieldPatchValue, KNOWN_TOOLS, KNOWN_MODELS } from '../ss-form.js';
import { lintArtifact } from '../ss-lint.js';
import { lintForProfile } from '../ss-profiles.js';
import { revealHidden } from '../ss-unicode.js';
import { readStoredPresets } from '../ss-presets.js';
import { html, raw, setHTML, ICONS } from './sx-dom.js';
import { descriptionHelp, keptKeys, frontmatterText } from './sx-editor-model.js';
import { snippetsFor, applySnippet, snippetMatches, SNIPPET_GROUPS } from './sx-snippets.js';

const OTHER_PROFILES = ['portable-six-field', 'codex-native', 'opencode-native'];
let _life = null;

/** The checks of a head document: the Studio's (gutter and list) and, for a skill, each other runtime's. */
export function headProblems({ type, parsed, folderName, knownNames = [], files = [] }) {
  const studio = lintArtifact({ type, parsed, folderName, knownNames });
  const others = type === 'skill' ? OTHER_PROFILES.map((id) => {
    try {
      const lint = lintForProfile(id, { parsed, folderName, files });
      return { id, problems: lint.all.filter((d) => d.severity === 'error' || d.severity === 'warning') };
    } catch { return { id, problems: [] }; }
  }).filter((p) => p.problems.length) : [];
  return { studio, others };
}

const fieldLabel = (t, type, key) => t(`skillsStudio.form.field.${key}`);

export function fieldHTML(t, f, { locked, type, folderName }) {
  const id = `sx-f-${f.key}`;
  const dis = locked || !f.writable;
  const note = f.note ? html`<p class="sx-field-note">${noteWords(t, f.note)}</p>` : '';
  const label = html`<label class="sx-field-label" for="${id}" id="${id}-label">${fieldLabel(t, type, f.key)}</label>`;
  switch (f.control) {
    case 'textarea': return html`<div class="sx-field">${label}<textarea class="sx-input sx-textarea" id="${id}" data-fm="${f.key}" rows="4"${dis ? ' disabled' : ''}>${f.value}</textarea>${note}</div>`;
    case 'number': return html`<div class="sx-field">${label}<input class="sx-input" type="number" min="0" step="1" id="${id}" data-fm="${f.key}" value="${f.value}" placeholder="${t('skillsStudio.form.unlimited')}"${dis ? ' disabled' : ''}>${note}</div>`;
    case 'checkbox':
      if (f.key === 'disable-model-invocation') {
        const name = folderName ? `/${folderName}` : '/name';
        return html`<fieldset class="sx-field sx-choices"${dis ? ' disabled' : ''}><legend class="sx-field-label">${t('skillsStudio.form.invocation')}</legend>
          <label class="sx-choice"><input type="radio" name="sx-inv" data-fm-radio="disable-model-invocation" value="false"${f.value ? '' : ' checked'}> ${t('skillsStudio.form.invocationAuto', { name })}</label>
          <label class="sx-choice"><input type="radio" name="sx-inv" data-fm-radio="disable-model-invocation" value="true"${f.value ? ' checked' : ''}> ${t('skillsStudio.form.invocationManual', { name })}</label>${note}</fieldset>`;
      }
      return html`<div class="sx-field sx-field--check"><label class="sx-choice"><input type="checkbox" id="${id}" data-fm="${f.key}"${f.value ? ' checked' : ''}${dis ? ' disabled' : ''}> ${fieldLabel(t, type, f.key)}</label>${note}</div>`;
    case 'model': {
      const entries = [{ value: '', label: t('skillsStudio.form.modelInherit'), selected: !f.value }, ...KNOWN_MODELS.map((m) => ({ value: m, label: m, selected: f.value === m }))];
      if (f.value && !KNOWN_MODELS.includes(f.value)) entries.push({ value: f.value, label: f.value, selected: true });
      return html`<div class="sx-field"><span class="sx-field-label" id="${id}-label">${fieldLabel(t, type, f.key)}</span>${raw(dropdownHTML(id, entries, { labelledBy: `${id}-label`, disabled: dis, inputAttrs: `data-fm="${f.key}"` }))}${note}</div>`;
    }
    case 'tools':
      if (Array.isArray(f.value)) {
        const entries = [{ value: '', label: t('skillsStudio.form.addTool'), selected: true, disabled: true }, ...KNOWN_TOOLS.filter((x) => !f.value.includes(x)).map((x) => ({ value: x, label: x }))];
        return html`<div class="sx-field"><span class="sx-field-label" id="${id}-label">${t('skillsStudio.form.field.allowed-tools')} <span class="sx-count">${f.value.length}</span></span>
          <p class="sx-help">${t('skillsStudio.form.toolsHelp')}</p>
          <div class="sx-chips" role="list">${f.value.map((tool) => html`<span class="sx-chip" role="listitem">${tool}${dis ? '' : html`<button type="button" class="sx-chip-x" data-tool-remove="${tool}" aria-label="${t('skillsStudio.form.removeTool', { tool })}">${ICONS.close}</button>`}</span>`)}</div>
          ${dis ? '' : html`<div class="sx-tools-add">${raw(dropdownHTML('sx-f-tool-add', entries, { label: t('skillsStudio.form.addTool') }))}
            <label class="sx-sr" for="sx-f-tool-pattern">${t('skillsStudio.form.toolPattern')}</label>
            <input class="sx-input sx-input--sm" id="sx-f-tool-pattern" placeholder="${t('skillsStudio.form.toolPatternPlaceholder')}" autocomplete="off" spellcheck="false">
            <button type="button" class="sx-btn" data-tool-add-pattern="1">${t('skillsStudio.form.add')}</button></div>`}${note}</div>`;
      }
      return html`<div class="sx-field">${label}<input class="sx-input" id="${id}" data-fm="${f.key}" value="${f.value}"${dis ? ' disabled' : ''}>${note}</div>`;
    default:
      return html`<div class="sx-field">${label}<input class="sx-input" id="${id}" data-fm="${f.key}" value="${f.value}" autocomplete="off" spellcheck="false"${dis ? ' disabled' : ''}>${f.key === 'name' ? html`<p class="sx-field-note" id="sx-name-check"></p>` : ''}${note}</div>`;
  }
}

/** The form's notes come from ss-form.js in English: each is said in the page's language. */
function noteWords(t, note) {
  if (/^Not text/.test(note)) return t('skillsStudio.form.note.notText');
  if (/^Not a list of tool names/.test(note)) return t('skillsStudio.form.note.notTools');
  if (/^Not true or false/.test(note)) return t('skillsStudio.form.note.notBoolean');
  if (/^Not a whole number/.test(note)) return t('skillsStudio.form.note.notNumber');
  if (/^An alias/.test(note)) return t('skillsStudio.form.note.alias');
  return note;
}

function reasonWords(t, view) {
  if (!view.reason) return '';
  return /errors/.test(view.reason) ? t('skillsStudio.form.reason.errors') : t('skillsStudio.form.reason.unsupported');
}

export function helperHTML(t, data) {
  const help = descriptionHelp(data);
  return html`<div class="sx-helper" aria-live="polite">
    <ul class="sx-budgets">${help.budgets.map((b) => html`<li class="sx-budget${b.over ? ' is-over' : ''}">
      <span class="sx-budget-name">${t(`skillsStudio.form.budget.${b.runtime}`)}</span>
      <span class="sx-meter" aria-hidden="true"><i style="width:${Math.round(b.ratio * 100)}%"></i></span>
      <span class="sx-budget-count">${t('skillsStudio.form.budgetCount', { used: b.used, limit: b.limit })}</span></li>`)}</ul>
    <ul class="sx-checks">
      <li class="${help.what ? 'is-ok' : 'is-warn'}">${help.what ? ICONS.ok : ICONS.warn}<span>${t(help.what ? 'skillsStudio.form.saysWhat' : 'skillsStudio.form.missingWhat')}</span></li>
      <li class="${help.when ? 'is-ok' : 'is-warn'}">${help.when ? ICONS.ok : ICONS.warn}<span>${t(help.when ? 'skillsStudio.form.saysWhen' : 'skillsStudio.form.missingWhen')}</span></li>
    </ul>
    <p class="sx-help">${t(`skillsStudio.form.advice.${help.advice}`)}</p>
  </div>`;
}

export function nameCheck(t, value, folderName) {
  if (!value) return { ok: false, text: t('skillsStudio.form.nameMissing') };
  if (folderName && value !== folderName) return { ok: false, text: t('skillsStudio.form.nameFolder', { folder: folderName }) };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return { ok: false, text: t('skillsStudio.form.nameFormat') };
  return { ok: true, text: folderName ? t('skillsStudio.form.nameMatches') : t('skillsStudio.form.nameOk') };
}

export function problemsHTML(t, problems) {
  const shown = problems.studio.all.filter((d) => d.severity !== 'info');
  const item = (d, profile = null) => html`<li><button type="button" class="sx-problem sx-problem--${d.severity}" data-line="${Number(d.line) || ''}">
    ${d.severity === 'error' ? ICONS.err : ICONS.warn}<span class="sx-problem-text">${d.line ? html`<span class="sx-problem-line">${t('skillsStudio.edit.line', { line: d.line })}</span> ` : ''}${d.message}</span>${profile ? html`<span class="sx-problem-tag">${t(`skillsStudio.form.budget.${profile}`)}</span>` : ''}</button></li>`;
  const others = problems.others.flatMap((p) => p.problems.slice(0, 6).map((d) => item(d, p.id === 'portable-six-field' ? 'portable' : p.id.replace('-native', ''))));
  return html`<section class="sx-insp-section" aria-labelledby="sx-problems-h">
    <h4 class="sx-insp-h" id="sx-problems-h">${t('skillsStudio.edit.problems')} <span class="sx-count">${shown.length}</span></h4>
    ${shown.length ? html`<ul class="sx-problems">${shown.map((d) => item(d))}</ul>` : html`<p class="sx-help sx-ok-text">${ICONS.ok} ${t('skillsStudio.edit.noProblems')}</p>`}
    ${others.length ? html`<details class="sx-details"><summary>${t('skillsStudio.edit.otherRuntimes', { count: others.length })}</summary><ul class="sx-problems">${others}</ul></details>` : ''}
  </section>`;
}

export function snippetsHTML(t, list, query) {
  const words = (s) => (s.custom ? `${s.name} ${s.description}` : `${t(`skillsStudio.snippets.${s.id}.name`)} ${t(`skillsStudio.snippets.${s.id}.desc`)}`);
  const shown = list.filter((s) => snippetMatches(s, query, words));
  const groups = SNIPPET_GROUPS.map((g) => ({ g, items: shown.filter((s) => s.group === g) })).filter((x) => x.items.length);
  return html`<section class="sx-insp-section" aria-labelledby="sx-snip-h">
    <h4 class="sx-insp-h" id="sx-snip-h">${t('skillsStudio.snippets.title')}</h4>
    <label class="sx-sr" for="sx-snip-search">${t('skillsStudio.snippets.search')}</label>
    <input type="search" class="sx-input sx-input--sm" id="sx-snip-search" placeholder="${t('skillsStudio.snippets.search')}" value="${query}" autocomplete="off">
    <div id="sx-snip-list">${groups.map(({ g, items }) => html`<p class="sx-snip-group">${t(`skillsStudio.snippets.group.${g}`)}</p>
      <ul class="sx-snippets">${items.map((s) => html`<li class="sx-snippet" draggable="true" data-snippet="${s.id}">
        <span class="sx-snippet-text"><span class="sx-snippet-name">${s.custom ? s.name : t(`skillsStudio.snippets.${s.id}.name`)}</span>
        <span class="sx-snippet-where">${s.kind === 'frontmatter' ? t('skillsStudio.snippets.whereKeys', { keys: Object.keys(s.patch || {}).join(', ') }) : (s.custom ? (s.description || t('skillsStudio.snippets.whereCaret')) : t(`skillsStudio.snippets.${s.id}.desc`))}</span></span>
        <button type="button" class="sx-btn sx-btn--sm" data-insert="${s.id}" aria-label="${t('skillsStudio.snippets.insertNamed', { name: s.custom ? s.name : t(`skillsStudio.snippets.${s.id}.name`) })}">${t('skillsStudio.snippets.insert')}</button></li>`)}</ul>`)}
      ${shown.length ? '' : html`<p class="sx-help">${t('skillsStudio.snippets.none')}</p>`}</div>
  </section>`;
}

/**
 * Draw the inspector for a workspace.
 * @param {HTMLElement} host
 * @param {object} o
 * @param {object} o.ctx @param {object} o.ws
 * @param {object|null} o.fm ss-frontmatter.js (null while it loads)
 * @param {object|null} o.head the head document (SKILL.md, or the agent's / command's file)
 * @param {boolean} o.headShowing the head document is the one on screen
 * @param {(next: string, o?: object) => void} o.replaceHead change the head document's text (one undo step)
 * @param {(line: number) => void} o.reveal show a line of the head document
 * @param {() => void} o.openHead show the head document
 * @param {() => number|null} o.caret where the caret is in the showing document
 * @param {(snippet) => void} o.insertSnippet
 */
export function renderInspector(host, o) {
  const { ctx, ws, fm, head } = o;
  const { t } = ctx;
  _life?.abort();
  _life = new AbortController();
  const signal = _life.signal;
  const mode = ws.inspectorMode || 'form';
  const type = ws.kind;
  const folderName = ws.kind === 'skill' ? (ws.row.folderName || ws.label) : '';
  let body;
  if (!head) body = html`<p class="sx-help">${t('skillsStudio.edit.noHead')}</p>`;
  else if (head.binary) body = html`<p class="sx-note sx-note--warn" role="note">${t('skillsStudio.form.binaryHead')}</p>`;
  else if (!fm) body = html`<p class="sx-help" role="status">${t('skillsStudio.form.loading')}</p>`;
  else {
    let parsed = null;
    try { parsed = fm.parse(head.content); } catch { parsed = null; }
    if (!parsed) body = html`<p class="sx-note" role="note">${t('skillsStudio.form.cannotRead')}</p>`;
    else {
      const view = formView(type, parsed);
      const locked = !ws.subject.editable || head.readOnly || !view.editable || !o.headShowing;
      const kept = keptKeys(type, parsed, head.content);
      const problems = headProblems({ type, parsed, folderName, knownNames: o.knownNames || [], files: (ws.files || []).filter((f) => f.path).map((f) => ({ path: f.path, size: f.size || 0 })) });
      ws.lastProblems = problems;
      const notShowing = !o.headShowing && ws.subject.editable;
      const formPart = mode === 'yaml'
        ? html`<div class="sx-yaml"><pre class="sx-pre" tabindex="0" aria-label="${t('skillsStudio.form.yamlLabel')}">${frontmatterText(head.content) || t('skillsStudio.form.noFrontmatter')}</pre>
            <button type="button" class="sx-btn" data-insp="yaml-edit">${t('skillsStudio.form.editInDocument')}</button>
            <p class="sx-help">${t('skillsStudio.form.yamlHelp')}</p></div>`
        : html`${view.reason && ws.subject.editable ? html`<p class="sx-note" role="note">${reasonWords(t, view)}</p>` : ''}
            ${notShowing ? html`<p class="sx-note" role="note">${t('skillsStudio.form.notShowing', { file: head.label })} <button type="button" class="sx-link" data-insp="open-head">${t('skillsStudio.form.openIt')}</button></p>` : ''}
            <div class="sx-form" role="group" aria-label="${t('skillsStudio.form.label')}">${view.fields.map((f) => fieldHTML(t, f, { locked, type, folderName }))}</div>
            ${type === 'skill' ? helperHTML(t, parsed.data || {}) : ''}`;
      const keptPart = kept.length ? html`<details class="sx-details sx-advanced"${ws.advancedOpen ? ' open' : ''} data-insp-details="advanced">
          <summary>${ctx.tp('skillsStudio.form.advanced', kept.length)}</summary>
          <p class="sx-help">${t('skillsStudio.form.advancedHelp')}</p>
          <ul class="sx-kept">${kept.map((k) => html`<li><button type="button" class="sx-link" data-line="${k.line}">${k.key}</button><pre class="sx-pre sx-pre--sm">${k.text}</pre></li>`)}</ul>
        </details>` : html`<p class="sx-help">${t('skillsStudio.form.advancedNone')}</p>`;
      const custom = readStoredPresets(ctx.storage.getItem('neural-skills-custom-presets')).presets;
      body = html`
        <div class="sx-seg" role="group" aria-label="${t('skillsStudio.form.viewLabel')}">
          <button type="button" data-insp="mode-form" aria-pressed="${mode === 'form' ? 'true' : 'false'}">${t('skillsStudio.form.form')}</button>
          <button type="button" data-insp="mode-yaml" aria-pressed="${mode === 'yaml' ? 'true' : 'false'}">${t('skillsStudio.form.yaml')}</button>
        </div>
        ${formPart}
        ${keptPart}
        ${problemsHTML(t, problems)}
        ${ws.subject.editable ? snippetsHTML(t, snippetsFor(type, custom), ws.snippetQuery || '') : ''}`;
    }
  }
  setHTML(host, html`<div class="sx-inspector">${body}</div>`);
  if (!head || !fm || head.binary) return;
  // (its dropdowns are served by the Edit panel's delegated listeners, which hold this pane: wiring them here too
  // would open and close them with the same click)
  const nameInput = host.querySelector('#sx-f-name');
  const showName = () => {
    const out = host.querySelector('#sx-name-check');
    if (!out || !nameInput) return;
    const check = nameCheck(t, nameInput.value.trim(), folderName && ws.kind === 'skill' ? folderName : '');
    out.textContent = `${check.ok ? '✓' : '✕'} ${check.text}`;
    out.className = `sx-field-note ${check.ok ? 'sx-ok-text' : 'sx-warn-text'}`;
  };
  showName();
  const apply = (key, input) => {
    const parsed = fm.parse(head.content);
    const view = formView(type, parsed);
    const field = view.fields.find((f) => f.key === key);
    if (!view.editable || !field?.writable || head.readOnly || !o.headShowing) return;
    const savedKeys = new Set((fm.parse(head.saved.raw).keys || []).map((k) => k.key));
    const next = fieldPatchValue({ field, input, current: parsed.data?.[key], savedHasKey: savedKeys.has(key) });
    const el = host.querySelector(`#sx-f-${CSS.escape(key)}`);
    if (next.invalid) { if (el) { el.setAttribute('aria-invalid', 'true'); el.title = t('skillsStudio.form.invalidNumber'); } return; }
    if (el) { el.removeAttribute('aria-invalid'); el.removeAttribute('title'); }
    const result = fm.patch(head.content, { [key]: next.value });
    if (!result.ok) { ctx.toast(t('skillsStudio.form.patchFailed', { field: fieldLabel(t, type, key) }), 'error'); return; }
    if (result.changed) o.replaceHead(result.text);
  };
  host.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset?.fm && el.type !== 'checkbox' && el.type !== 'hidden') { apply(el.dataset.fm, el.value); if (el.dataset.fm === 'name') showName(); }
    if (el.id === 'sx-snip-search') { ws.snippetQuery = el.value; redrawSnippets(host, ctx, ws, type); }
  }, { signal });
  host.addEventListener('change', (e) => {
    const el = e.target;
    if (el.type === 'checkbox' && el.dataset?.fm) apply(el.dataset.fm, el.checked);
    else if (el.type === 'hidden' && el.dataset?.fm) apply(el.dataset.fm, el.value);
    else if (el.dataset?.fmRadio) apply(el.dataset.fmRadio, el.value === 'true');
    else if (el.id === 'sx-f-tool-add' && el.value) {
      const parsed = fm.parse(head.content);
      const tools = Array.isArray(parsed.data?.['allowed-tools']) ? parsed.data['allowed-tools'] : [];
      apply('allowed-tools', [...tools, el.value]);
    }
  }, { signal });
  host.addEventListener('toggle', (e) => { if (e.target.dataset?.inspDetails === 'advanced') ws.advancedOpen = e.target.open; }, { signal, capture: true });
  host.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button');
    if (!btn || !host.contains(btn)) return;
    if (btn.dataset.insp === 'mode-form' || btn.dataset.insp === 'mode-yaml') { ws.inspectorMode = btn.dataset.insp === 'mode-yaml' ? 'yaml' : 'form'; renderInspector(host, o); host.querySelector(`[data-insp="${btn.dataset.insp}"]`)?.focus(); return; }
    if (btn.dataset.insp === 'open-head') { o.openHead(); return; }
    if (btn.dataset.insp === 'yaml-edit') { o.openHead(); o.reveal(2); return; }
    if (btn.dataset.line) { const line = Number(btn.dataset.line); if (line) { o.openHead(); o.reveal(line); } return; }
    if (btn.dataset.toolRemove) {
      const parsed = fm.parse(head.content);
      const tools = Array.isArray(parsed.data?.['allowed-tools']) ? parsed.data['allowed-tools'] : [];
      apply('allowed-tools', tools.filter((x) => x !== btn.dataset.toolRemove));
      return;
    }
    if (btn.dataset.toolAddPattern) {
      const input = host.querySelector('#sx-f-tool-pattern');
      const value = input?.value.trim();
      if (!value) return;
      const parsed = fm.parse(head.content);
      const tools = Array.isArray(parsed.data?.['allowed-tools']) ? parsed.data['allowed-tools'] : [];
      if (!tools.includes(value)) apply('allowed-tools', [...tools, value]);
      return;
    }
    if (btn.dataset.insert) {
      const custom = readStoredPresets(ctx.storage.getItem('neural-skills-custom-presets')).presets;
      const snippet = snippetsFor(type, custom).find((s) => s.id === btn.dataset.insert);
      if (snippet) o.insertSnippet(snippet);
    }
  }, { signal });
  host.addEventListener('dragstart', (e) => {
    const item = e.target.closest?.('[data-snippet]');
    if (!item) return;
    const custom = readStoredPresets(ctx.storage.getItem('neural-skills-custom-presets')).presets;
    const snippet = snippetsFor(type, custom).find((s) => s.id === item.dataset.snippet);
    if (!snippet || snippet.kind !== 'body') { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', snippet.text);
    e.dataTransfer.effectAllowed = 'copy';
  }, { signal });
}

function redrawSnippets(host, ctx, ws, type) {
  const custom = readStoredPresets(ctx.storage.getItem('neural-skills-custom-presets')).presets;
  const list = snippetsFor(type, custom);
  const box = host.querySelector('#sx-snip-list');
  if (!box) return;
  const tmp = document.createElement('div');
  setHTML(tmp, snippetsHTML(ctx.t, list, ws.snippetQuery || ''));
  const fresh = tmp.querySelector('#sx-snip-list');
  if (fresh) box.replaceWith(fresh);
}

/** Insert a snippet into a text (the view hands the result to the editor). */
export function snippetResult(text, snippet, { caret, fm }) {
  return applySnippet(text, snippet, { caret, fm });
}

/** A hidden-character-safe label of a document (a name may hold characters nobody can see). */
export const shownName = (name) => revealHidden(String(name ?? ''));

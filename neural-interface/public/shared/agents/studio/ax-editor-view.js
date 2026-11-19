// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the editor's form
// ═══════════════════════════════════════════
//
// One field for every content field of an agent definition, in five sections (who it is, its instructions, what it
// runs on, what it may touch, where and what for), with the privilege summary beside it: what this agent may do,
// and what differs from the last approved revision. As the owner types, the server checks the definition
// (POST /validate, a moment after the last key) and its answer is written under the field it is about: an error
// in the status' danger colour, a softer finding in its warning colour. Nothing here decides what is valid.
//
// Every choice is the app's dropdown, fed from what the app already knows (ax-options.js); the lists arrive after
// the form is drawn (the model catalog, the tool catalog, the allowed MoreLogin profiles, the skills, the memory
// categories), and a value that was saved stays in its dropdown until then and after. Typing never redraws the
// form: only a choice that changes what other fields offer does (the provider, the model, the browser switch), and
// the keyboard stays where it was.

import { html, setHTML, attr, ICONS } from '../../skills/studio/sx-dom.js';
import { wireDropdowns, controlOf, setDropdownItems } from '../../cc-dropdown.js';
import { FORM_SECTIONS, applyField, countOf, definitionOf, issuesByField, issueCounts, isDirty } from './ax-form.js';
import { enumEntries, multiEntries, multiValue, modelEntries, modelRow, effortEntries, accountEntries, scopeEntries, scopeFromValue, profileEntries, profileAllowed, skillEntries, categoryEntries, toolGroupChoices, toolsFromChoice, serverEntries, serversFromChoice } from './ax-options.js';
import { AGENT_ICONS, COLOR_TOKENS, agentIcon, knownIcon, toneOf } from './ax-icons.js';
import { field, dropdown, issuesHTML, privilegeHTML, wordsOf, wordOr } from './ax-ui.js';

let life = null;

export function leaveEditorPanel() {
  life?.abort();
  life = null;
}

const limitOf = (ctx, name) => Number(ctx.info?.limits?.[name]) || null;
const countText = (value, limit) => { const c = countOf(value, limit); return c.limit ? `${c.length} / ${c.limit}` : String(c.length); };

/** The definition the form stands for (an open agent keeps its id and scope whatever the form says). */
export function formDefinition(ed) {
  const def = definitionOf(ed.form);
  if (ed.mode === 'agent' && ed.key) { def.id = ed.key.id; def.scope = ed.key.scope; }
  return def;
}

// ── Sections ──

function identityHTML(ctx, ed, ro) {
  const { t } = ctx;
  const f = ed.form;
  const icons = html`<div class="ax-swatches" role="radiogroup" aria-labelledby="ax-e-icon-label">
    <button type="button" class="ax-swatch ax-swatch--none" role="radio" aria-checked="${f.icon ? 'false' : 'true'}" tabindex="${knownIcon(f.icon) ? '-1' : '0'}" data-act="pick-icon" data-value="" title="${t('agentsStudio.editor.iconDefault')}" aria-label="${t('agentsStudio.editor.iconDefault')}"${attr('disabled', ro)}>${ICONS.off}</button>
    ${AGENT_ICONS.map((name) => html`<button type="button" class="ax-swatch" role="radio" aria-checked="${f.icon === name ? 'true' : 'false'}" tabindex="${f.icon === name ? '0' : '-1'}" data-act="pick-icon" data-value="${name}" title="${name}" aria-label="${name}"${attr('disabled', ro)}>${agentIcon(name, 18)}</button>`)}
  </div>${f.icon && !knownIcon(f.icon) ? html`<p class="sx-field-note">${t('agentsStudio.editor.iconUnknown', { name: f.icon })}</p>` : ''}`;
  const colors = html`<div class="ax-swatches" role="radiogroup" aria-labelledby="ax-e-color-label">
    <button type="button" class="ax-swatch ax-swatch--none" role="radio" aria-checked="${f.color ? 'false' : 'true'}" tabindex="${toneOf(f.color) === 'neutral' ? '0' : '-1'}" data-act="pick-color" data-value="" title="${t('agentsStudio.editor.colorDefault')}" aria-label="${t('agentsStudio.editor.colorDefault')}"${attr('disabled', ro)}>${ICONS.off}</button>
    ${COLOR_TOKENS.map((c) => html`<button type="button" class="ax-swatch ax-swatch--tone ax-tone--${c.tone}" role="radio" aria-checked="${f.color === c.token ? 'true' : 'false'}" tabindex="${f.color === c.token ? '0' : '-1'}" data-act="pick-color" data-value="${c.token}" title="${wordOr(t, 'agentsStudio.color', c.tone)} (${c.token})" aria-label="${wordOr(t, 'agentsStudio.color', c.tone)}"${attr('disabled', ro)}><span class="ax-swatch-dot" aria-hidden="true"></span></button>`)}
  </div>${f.color && toneOf(f.color) === 'neutral' ? html`<p class="sx-field-note">${t('agentsStudio.editor.colorUnknown', { token: f.color })}</p>` : ''}`;
  return html`
    ${field({ id: 'ax-e-name', label: t('agentsStudio.field.name'), field: 'name', required: true, count: countText(f.name, limitOf(ctx, 'name')),
    control: html`<input type="text" class="sx-input" id="ax-e-name" data-form-field="name" value="${f.name}" aria-labelledby="ax-e-name-label" aria-describedby="ax-e-name-issues" autocomplete="off" spellcheck="true"${attr('disabled', ro)}${ed.mode === 'new' ? attr('data-autofocus', true) : ''}>` })}
    ${field({ id: 'ax-e-id', label: t('agentsStudio.field.id'), field: 'id', required: true, help: ed.mode === 'new' ? t('agentsStudio.editor.idHelp') : t('agentsStudio.editor.idFixed'),
    control: html`<input type="text" class="sx-input sx-mono" id="ax-e-id" data-form-field="id" value="${f.id}" aria-labelledby="ax-e-id-label" aria-describedby="ax-e-id-help ax-e-id-issues" autocomplete="off" spellcheck="false" autocapitalize="off"${attr('disabled', ro || ed.mode !== 'new')}>` })}
    ${field({ id: 'ax-e-description', label: t('agentsStudio.field.description'), field: 'description', wide: true, help: t('agentsStudio.editor.descriptionHelp'), count: countText(f.description, limitOf(ctx, 'description')),
    control: html`<textarea class="sx-input sx-textarea ax-desc" id="ax-e-description" data-form-field="description" rows="2" aria-labelledby="ax-e-description-label" aria-describedby="ax-e-description-help ax-e-description-issues"${attr('disabled', ro)}>${f.description}</textarea>` })}
    ${field({ id: 'ax-e-icon', label: t('agentsStudio.field.icon'), field: 'icon', control: icons })}
    ${field({ id: 'ax-e-color', label: t('agentsStudio.field.color'), field: 'color', help: t('agentsStudio.editor.colorHelp'), control: colors })}`;
}

function instructionsHTML(ctx, ed, ro) {
  const { t } = ctx;
  return field({ id: 'ax-e-instructions', label: t('agentsStudio.field.instructions'), field: 'instructions', wide: true, help: t('agentsStudio.editor.instructionsHelp'), count: countText(ed.form.instructions, limitOf(ctx, 'instructions')),
    control: html`<textarea class="sx-input sx-textarea ax-instructions" id="ax-e-instructions" data-form-field="instructions" rows="14" aria-labelledby="ax-e-instructions-label" aria-describedby="ax-e-instructions-help ax-e-instructions-issues" spellcheck="true"${attr('disabled', ro)}>${ed.form.instructions}</textarea>` });
}

// The fields whose choices arrive after the form is drawn (the model catalog, the tool catalog, the allowed profiles,
// the skills, the memory categories). Each is made by itself: `{ markup, input, entries, summary, after }`, so a list
// that arrives updates that field where it is (refreshChoices) and the rest of the form is left alone.
const LATE_FIELDS = Object.freeze(['model', 'effort', 'accountId', 'tools', 'mcpServers', 'moreloginProfile', 'skills', 'memoryCategory']);
const LATE = {
  model(ctx, ed, ro) {
    const { t } = ctx;
    const src = ctx.sources;
    const entries = modelEntries(src.models?.[ed.form.provider] || [], ed.form.model, { defaultLabel: t('agentsStudio.editor.modelDefault'), savedLabel: (id) => id, unavailableWord: t('agentsStudio.editor.modelUnavailable') });
    return { input: 'ax-e-model', entries, markup: field({ id: 'ax-e-model', label: t('agentsStudio.field.model'), field: 'model', help: src.modelsState === 'loading' ? t('agentsStudio.editor.modelsLoading') : src.modelsState === 'failed' ? t('agentsStudio.editor.modelsFailed') : t('agentsStudio.editor.modelHelp'),
      control: dropdown('ax-e-model', entries, { labelledBy: 'ax-e-model-label', field: 'model', disabled: ro }) }) };
  },
  effort(ctx, ed, ro) {
    const { t } = ctx;
    const levels = ctx.effortLevels(ed.form.provider, modelRow(ctx.sources.models?.[ed.form.provider] || [], ed.form.model));
    const entries = effortEntries(levels, ed.form.effort, { defaultLabel: t('agentsStudio.editor.effortDefault') });
    return { input: 'ax-e-effort', entries, markup: field({ id: 'ax-e-effort', label: t('agentsStudio.field.effort'), field: 'effort', control: dropdown('ax-e-effort', entries, { labelledBy: 'ax-e-effort-label', field: 'effort', disabled: ro }) }) };
  },
  // Only for a provider whose runs name an account (the app has an account list for it), or an agent that names one.
  accountId(ctx, ed, ro) {
    const { t } = ctx;
    const accounts = ctx.sources.accounts?.[ed.form.provider];
    if (!Array.isArray(accounts) && !ed.form.accountId) return { markup: null, after: 'effort' };
    const entries = accountEntries(accounts || [], ed.form.accountId, { defaultLabel: t('agentsStudio.editor.accountDefault') });
    return { input: 'ax-e-account', entries, after: 'effort', markup: field({ id: 'ax-e-account', label: t('agentsStudio.field.accountId'), field: 'accountId', help: t('agentsStudio.editor.accountHelp'), control: dropdown('ax-e-account', entries, { labelledBy: 'ax-e-account-label', field: 'accountId', disabled: ro }) }) };
  },
  tools(ctx, ed, ro) {
    const { t } = ctx;
    const f = ed.form;
    const src = ctx.sources;
    const tools = toolGroupChoices(src.toolCatalog, f.tools, { provider: f.provider || 'claude-code', usesBrowser: f.usesBrowser, defaultLabel: t('agentsStudio.value.defaultTools'), translate: t });
    return { input: tools ? 'ax-e-tools' : null, entries: tools?.entries || null, summary: tools?.summary || null, markup: field({ id: 'ax-e-tools', label: t('agentsStudio.field.tools'), field: 'tools', wide: true, help: tools ? t('agentsStudio.editor.toolsHelp') : src.toolsState === 'loading' ? t('agentsStudio.editor.toolsLoading') : t('agentsStudio.editor.toolsFailed'),
      control: tools ? dropdown('ax-e-tools', tools.entries, { labelledBy: 'ax-e-tools-label', field: 'tools', multiple: true, summary: tools.summary, disabled: ro })
        : html`<p class="sx-note ax-kept">${f.tools === null ? t('agentsStudio.value.defaultTools') : f.tools.join(', ') || t('agentsStudio.value.alwaysOn')}</p>` }) };
  },
  mcpServers(ctx, ed, ro) {
    const { t } = ctx;
    const f = ed.form;
    const entries = serverEntries(ctx.sources.toolCatalog, f.mcpServers, { provider: f.provider || 'claude-code', allLabel: t('agentsStudio.value.allServers'), words: { blocked: t('agentsStudio.editor.serverBlocked'), unavailable: t('agentsStudio.editor.serverUnavailable'), unknown: t('agentsStudio.editor.serverUnknown'), missing: t('agentsStudio.editor.serverMissing') } });
    const summary = f.mcpServers.includes('*') ? t('agentsStudio.value.allServers') : f.mcpServers.length ? f.mcpServers.join(', ') : t('agentsStudio.editor.serversNone');
    return { input: 'ax-e-servers', entries, summary, markup: field({ id: 'ax-e-servers', label: t('agentsStudio.field.mcpServers'), field: 'mcpServers', wide: true, help: t('agentsStudio.editor.serversHelp'), control: dropdown('ax-e-servers', entries, { labelledBy: 'ax-e-servers-label', field: 'mcpServers', multiple: true, summary, disabled: ro }) }) };
  },
  // A profile is the browser tab's: offered while the browser is on (or while one is still named, so it can be seen).
  moreloginProfile(ctx, ed, ro) {
    const { t } = ctx;
    const f = ed.form;
    const src = ctx.sources;
    if (!f.usesBrowser && !f.moreloginProfile) return { markup: null, after: 'usesBrowser' };
    const entries = profileEntries(src.profiles, f.moreloginProfile, { noneLabel: t('agentsStudio.editor.profileDefault'), notAllowedWord: t('agentsStudio.editor.profileNotAllowedWord') });
    return { input: 'ax-e-profile', entries, after: 'usesBrowser', markup: field({ id: 'ax-e-profile', label: t('agentsStudio.field.moreloginProfile'), field: 'moreloginProfile', wide: true,
      help: src.profilesState === 'failed' ? t('agentsStudio.editor.profilesFailed') : !profileAllowed(src.profiles, f.moreloginProfile) && src.profilesState === 'ready' ? t('agentsStudio.editor.profileNotAllowed') : (src.profiles || []).length ? t('agentsStudio.editor.profileHelp') : t('agentsStudio.editor.profilesNone'),
      control: dropdown('ax-e-profile', entries, { labelledBy: 'ax-e-profile-label', field: 'moreloginProfile', disabled: ro || !f.usesBrowser }) }) };
  },
  skills(ctx, ed, ro) {
    const { t } = ctx;
    const entries = skillEntries(ctx.sources.skills, ed.form.skills);
    const summary = ed.form.skills.length ? ed.form.skills.join(', ') : t('agentsStudio.editor.skillsNone');
    return { input: 'ax-e-skills', entries, summary, markup: field({ id: 'ax-e-skills', label: t('agentsStudio.field.skills'), field: 'skills', wide: true, help: ctx.sources.skillsState === 'failed' ? t('agentsStudio.editor.skillsFailed') : t('agentsStudio.editor.skillsHelp'), control: dropdown('ax-e-skills', entries, { labelledBy: 'ax-e-skills-label', field: 'skills', multiple: true, summary, disabled: ro }) }) };
  },
  memoryCategory(ctx, ed, ro) {
    const { t } = ctx;
    const entries = categoryEntries(ctx.sources.categories, ed.form.memoryCategory, { noneLabel: t('agentsStudio.editor.categoryNone') });
    return { input: 'ax-e-category', entries, markup: field({ id: 'ax-e-category', label: t('agentsStudio.field.memoryCategory'), field: 'memoryCategory', wide: true, help: ctx.sources.categoriesState === 'failed' ? t('agentsStudio.editor.categoriesFailed') : t('agentsStudio.editor.categoryHelp'), control: dropdown('ax-e-category', entries, { labelledBy: 'ax-e-category-label', field: 'memoryCategory', disabled: ro }) }) };
  },
};
const late = (name, ctx, ed, ro) => LATE[name](ctx, ed, ro).markup || '';

function runtimeHTML(ctx, ed, ro) {
  const { t } = ctx;
  return html`
    ${field({ id: 'ax-e-provider', label: t('agentsStudio.field.provider'), field: 'provider', required: true,
    control: dropdown('ax-e-provider', enumEntries(ctx.info?.providers || [], ed.form.provider, (id) => wordOr(t, 'agentsStudio.provider', id)), { labelledBy: 'ax-e-provider-label', field: 'provider', disabled: ro }) })}
    ${late('model', ctx, ed, ro)}${late('effort', ctx, ed, ro)}${late('accountId', ctx, ed, ro)}`;
}

function accessHTML(ctx, ed, ro) {
  const { t } = ctx;
  const f = ed.form;
  const capability = enumEntries(ctx.info?.capabilityLevels || [], f.capability, (id) => wordOr(t, `agentsStudio.capability.${id}`, 'name'), (id) => wordOr(t, `agentsStudio.capability.${id}`, 'help'));
  const policy = enumEntries(ctx.info?.permissionPolicies || [], f.permissionPolicy, (id) => wordOr(t, `agentsStudio.policy.${id}`, 'name'), (id) => wordOr(t, `agentsStudio.policy.${id}`, 'help'));
  return html`
    ${field({ id: 'ax-e-capability', label: t('agentsStudio.field.capability'), field: 'capability', help: wordOr(t, `agentsStudio.capability.${f.capability}`, 'help'),
    control: dropdown('ax-e-capability', capability, { labelledBy: 'ax-e-capability-label', field: 'capability', disabled: ro }) })}
    ${field({ id: 'ax-e-policy', label: t('agentsStudio.field.permissionPolicy'), field: 'permissionPolicy', help: wordOr(t, `agentsStudio.policy.${f.permissionPolicy}`, 'help'),
    control: dropdown('ax-e-policy', policy, { labelledBy: 'ax-e-policy-label', field: 'permissionPolicy', disabled: ro }) })}
    ${late('tools', ctx, ed, ro)}${late('mcpServers', ctx, ed, ro)}
    <div class="sx-field ax-field ax-field--wide" data-field="usesBrowser">
      <label class="sx-choice"><input type="checkbox" class="sx-check" id="ax-e-browser" data-form-field="usesBrowser"${attr('checked', f.usesBrowser)}${attr('disabled', ro)} aria-describedby="ax-e-browser-help ax-e-browser-issues"><span>${t('agentsStudio.field.usesBrowser')}</span></label>
      <p class="sx-field-note" id="ax-e-browser-help">${t('agentsStudio.editor.browserHelp')}</p>
      <div class="ax-issues" data-issues-for="usesBrowser" id="ax-e-browser-issues" role="status"></div>
    </div>
    ${late('moreloginProfile', ctx, ed, ro)}
    <div class="sx-field ax-field ax-field--wide" data-field="usesComputer">
      <label class="sx-choice"><input type="checkbox" class="sx-check" id="ax-e-computer" data-form-field="usesComputer"${attr('checked', f.usesComputer)}${attr('disabled', ro)} aria-describedby="ax-e-computer-help ax-e-computer-issues"><span>${t('agentsStudio.field.usesComputer')}</span></label>
      <p class="sx-field-note" id="ax-e-computer-help">${t('agentsStudio.editor.computerHelp')}</p>
      <div class="ax-issues" data-issues-for="usesComputer" id="ax-e-computer-issues" role="status"></div>
    </div>
    ${late('skills', ctx, ed, ro)}`;
}

function useHTML(ctx, ed, ro) {
  const { t } = ctx;
  const f = ed.form;
  const classSummary = f.taskClasses.length ? f.taskClasses.map((cls) => wordOr(t, 'agentsStudio.taskClass', cls)).join(', ') : t('agentsStudio.editor.classesNone');
  return html`
    ${field({ id: 'ax-e-scope', label: t('agentsStudio.field.scope'), field: 'scope', wide: true, help: ed.mode === 'new' ? t('agentsStudio.editor.scopeHelp') : t('agentsStudio.editor.scopeFixed'),
    control: dropdown('ax-e-scope', scopeEntries(ctx.info?.projects || [], f.scope, { globalLabel: t('agentsStudio.scope.globalLibrary'), projectsLabel: t('agentsStudio.scope.pinTo') }), { labelledBy: 'ax-e-scope-label', field: 'scope', disabled: ro || ed.mode !== 'new' }) })}
    ${field({ id: 'ax-e-classes', label: t('agentsStudio.field.taskClasses'), field: 'taskClasses', wide: true, help: t('agentsStudio.editor.classesHelp'),
    control: dropdown('ax-e-classes', multiEntries(ctx.info?.taskClasses || [], f.taskClasses, (id) => wordOr(t, 'agentsStudio.taskClass', id)), { labelledBy: 'ax-e-classes-label', field: 'taskClasses', multiple: true, summary: classSummary, disabled: ro }) })}
    ${late('memoryCategory', ctx, ed, ro)}`;
}

/**
 * A list arrived (the model catalog, the tool catalog, a profile list…): every field it feeds is updated where it
 * is. A field the keyboard is in, or whose menu is open, only gets its new choices (the focus, the caret and the
 * open menu stay); any other is made again. Nothing else of the form is touched, and no value changes.
 */
function refreshChoices(host, ctx, ed) {
  const ro = !ed.editable;
  const active = document.activeElement;
  for (const name of LATE_FIELDS) {
    const made = LATE[name](ctx, ed, ro);
    const el = host.querySelector(`.ax-field[data-field="${name}"]`);
    if (!el) {
      // A field that was not there and now is (the accounts of a provider): put after the field it follows.
      if (made.markup && made.after) host.querySelector(`.ax-field[data-field="${made.after}"]`)?.insertAdjacentHTML('afterend', made.markup.text);
      continue;
    }
    const busy = el.contains(active) || !!el.querySelector('.cc-dropdown.open');
    if (!made.markup) { if (!busy) el.remove(); continue; }
    const input = made.input ? el.querySelector(`#${CSS.escape(made.input)}`) : null;
    if (busy) {
      if (!input || !made.entries) continue;
      setDropdownItems(input, made.entries);
      if (made.summary) { const label = el.querySelector('.cc-dropdown-value'); if (label) label.textContent = made.summary; }
      continue;
    }
    const holder = document.createElement('template');
    setHTML(holder, made.markup);
    el.replaceWith(holder.content);
  }
  paintIssues(host, ctx, ed);
}

const SECTION_HTML = { identity: identityHTML, instructions: instructionsHTML, runtime: runtimeHTML, access: accessHTML, use: useHTML };

function sideHTML(ctx, ed) {
  const { t } = ctx;
  const words = wordsOf(t, { projects: ctx.info?.projects });
  const approved = ed.agent?.approvedDefinition || null;
  const counts = issueCounts(ed.issues?.byField);
  const problems = Object.entries(ed.issues?.byField || {}).flatMap(([name, found]) => [
    ...found.errors.map((issue) => ({ name, kind: 'error', message: issue.message })),
    ...found.warnings.map((issue) => ({ name, kind: 'warning', message: issue.message })),
  ]);
  return html`
    <section class="ax-side-card" aria-labelledby="ax-priv-title">
      <h4 class="sx-section-title" id="ax-priv-title">${t('agentsStudio.privilege.title')}</h4>
      <p class="sx-help">${approved ? t('agentsStudio.privilege.againstApproved', { n: approved.revision }) : t('agentsStudio.privilege.firstRevision')}</p>
      ${privilegeHTML(t, formDefinition(ed), approved, ed.delta, words)}
    </section>
    <section class="ax-side-card" aria-labelledby="ax-problems-title">
      <h4 class="sx-section-title" id="ax-problems-title">${t('agentsStudio.editor.checks')}</h4>
      <p class="sx-help" id="ax-check-state" role="status">${ed.checking ? t('agentsStudio.editor.checking') : ed.checkFailed ? t('agentsStudio.editor.checkFailed') : !ed.issues ? t('agentsStudio.editor.notChecked') : !counts.errors && !counts.warnings ? t('agentsStudio.editor.noProblems') : ctx.tp('agentsStudio.editor.problemCount', counts.errors, { warnings: counts.warnings })}</p>
      ${problems.length ? html`<ul class="sx-problems">${problems.map((p) => html`<li><button type="button" class="sx-problem sx-problem--${p.kind} ax-problem" data-act="goto-field" data-field="${p.name}">${p.kind === 'error' ? ICONS.err : ICONS.warn}<span class="sx-problem-text">${p.message}</span><span class="sx-problem-tag">${p.name === '_' ? '' : t(`agentsStudio.field.${p.name}`)}</span></button></li>`)}</ul>` : ''}
    </section>`;
}

function formHTML(ctx, ed) {
  const { t } = ctx;
  const ro = !ed.editable;
  const counts = issueCounts(ed.issues?.byField);
  return html`<div class="ax-edit">
    <form class="ax-form" id="ax-form" novalidate autocomplete="off" aria-label="${t('agentsStudio.editor.formLabel')}">
      ${FORM_SECTIONS.map((section) => {
    const mark = counts.sections[section.id];
    return html`<fieldset class="ax-section" id="ax-sec-${section.id}">
          <legend class="ax-section-title">${t(`agentsStudio.editor.section.${section.id}`)}${mark?.errors ? html`<span class="ax-section-mark sx-err-text">${ICONS.err}<span class="sx-sr">${ctx.tp('agentsStudio.editor.sectionErrors', mark.errors)}</span></span>` : ''}</legend>
          <div class="ax-fields">${SECTION_HTML[section.id](ctx, ed, ro)}</div>
        </fieldset>`;
  })}
    </form>
    <aside class="ax-side" id="ax-side" aria-label="${t('agentsStudio.privilege.title')}">${sideHTML(ctx, ed)}</aside>
  </div>`;
}

// ── Updating what is drawn without drawing the form again ──

function paintIssues(host, ctx, ed) {
  for (const box of host.querySelectorAll('[data-issues-for]')) setHTML(box, issuesHTML(ed.issues?.byField?.[box.dataset.issuesFor]));
  for (const input of host.querySelectorAll('[data-form-field]')) {
    const bad = !!ed.issues?.byField?.[input.dataset.formField]?.errors.length;
    const control = controlOf(input);
    if (bad) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid');
  }
  setHTML(host.querySelector('#ax-side'), sideHTML(ctx, ed));
  const counts = issueCounts(ed.issues?.byField);
  for (const section of FORM_SECTIONS) {
    const legend = host.querySelector(`#ax-sec-${section.id} .ax-section-title`);
    if (!legend) continue;
    legend.querySelector('.ax-section-mark')?.remove();
    const mark = counts.sections[section.id];
    if (mark?.errors) legend.insertAdjacentHTML('beforeend', html`<span class="ax-section-mark sx-err-text">${ICONS.err}<span class="sx-sr">${ctx.tp('agentsStudio.editor.sectionErrors', mark.errors)}</span></span>`.text);
  }
}

function paintCounts(host, ctx, ed) {
  for (const name of ['name', 'description', 'instructions']) {
    const el = host.querySelector(`[data-count-for="${name}"]`);
    if (!el) continue;
    const c = countOf(ed.form[name], limitOf(ctx, name));
    el.textContent = c.limit ? `${c.length} / ${c.limit}` : String(c.length);
    el.classList.toggle('sx-err-text', c.over);
    el.classList.toggle('sx-warn-text', c.near);
  }
}

/**
 * Ask the server what it makes of the form, a moment after the last change. The answer is dropped when the form
 * moved on meanwhile, or when the editor closed.
 */
export function scheduleCheck(host, ctx, ed, delay = 350) {
  clearTimeout(ed.checkTimer);
  const seq = (ed.checkSeq = (ed.checkSeq || 0) + 1);
  ed.checkTimer = setTimeout(async () => {
    ed.checking = true;
    const state = host.querySelector('#ax-check-state');
    if (state) state.textContent = ctx.t('agentsStudio.editor.checking');
    try {
      const res = await ctx.api.validate(formDefinition(ed));
      if (seq !== ed.checkSeq || ed.closed) return;
      ed.issues = { byField: issuesByField(res.errors, res.warnings), valid: res.valid === true };
      ed.checkFailed = false;
    } catch {
      if (seq !== ed.checkSeq || ed.closed) return;
      ed.checkFailed = true;
    }
    ed.checking = false;
    if (host.isConnected) paintIssues(host, ctx, ed);
    ed.onState?.();
  }, delay);
}

/** Draw the form in the tab panel. */
export function renderEditorPanel(host, ctx, ed) {
  leaveEditorPanel();
  life = new AbortController();
  const { signal } = life;
  const draw = ({ keepFocus = false } = {}) => {
    const active = keepFocus ? document.activeElement : null;
    const id = active && host.contains(active) ? active.id : null;
    const scroll = host.querySelector('.ax-form')?.scrollTop || 0;
    setHTML(host, formHTML(ctx, ed));
    paintIssues(host, ctx, ed);
    paintCounts(host, ctx, ed);
    const form = host.querySelector('.ax-form');
    if (form) form.scrollTop = scroll;
    if (id) host.querySelector(`#${CSS.escape(id)}`)?.focus({ preventScroll: true });
  };
  ed.redraw = draw;
  // A list that arrives while the form is open (the model catalog, the tool catalog…) is taken where it is: the
  // form is not drawn again, so what is being typed, the caret and an open menu are left alone.
  ed.refresh = () => refreshChoices(host, ctx, ed);
  draw();
  wireDropdowns(host, { signal });
  if (!ed.issues) scheduleCheck(host, ctx, ed, 0);

  const set = (name, value, { structural = false } = {}) => {
    const before = ed.form;
    ed.form = applyField(ed.form, name, value, { idFollowsName: ed.mode === 'new' && !ed.idTouched, idLimit: limitOf(ctx, 'id') || 64 });
    if (name === 'id') ed.idTouched = true;
    if (name === 'name' && ed.form.id !== before.id) { const idInput = host.querySelector('#ax-e-id'); if (idInput) idInput.value = ed.form.id; }
    ed.dirty = ed.mode === 'new' ? true : isDirty(ed.base, ed.form);
    // What the server said about this field was about its earlier value: it goes now, the next check says what holds.
    if (ed.issues?.byField?.[name]) { delete ed.issues.byField[name]; if (!structural) paintIssues(host, ctx, ed); }
    if (structural) draw({ keepFocus: true }); else { paintCounts(host, ctx, ed); setHTML(host.querySelector('#ax-side'), sideHTML(ctx, ed)); }
    scheduleCheck(host, ctx, ed);
    ed.onState?.();
  };

  host.addEventListener('input', (e) => {
    const el = e.target;
    const name = el.dataset?.formField;
    if (!name || el.type === 'hidden' || el.type === 'checkbox') return;
    set(name, el.value);
  }, { signal });
  host.addEventListener('change', (e) => {
    const el = e.target;
    const name = el.dataset?.formField;
    if (!name) return;
    if (el.type === 'checkbox') { set(name, el.checked, { structural: true }); return; }
    if (el.type !== 'hidden') return;
    if (name === 'tools') set('tools', toolsFromChoice(el.value), { structural: true });
    else if (name === 'mcpServers') set('mcpServers', serversFromChoice(el.value), { structural: true });
    else if (name === 'skills' || name === 'taskClasses') set(name, multiValue(el.value), { structural: true });
    else if (name === 'scope') set('scope', scopeFromValue(el.value), { structural: true });
    else if (['model', 'effort', 'accountId', 'moreloginProfile', 'memoryCategory'].includes(name)) set(name, el.value || null, { structural: name === 'model' });
    else set(name, el.value, { structural: true });
  }, { signal });
  host.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !host.contains(el) || el.disabled) return;
    if (el.dataset.act === 'pick-icon') set('icon', el.dataset.value || null, { structural: true });
    else if (el.dataset.act === 'pick-color') set('color', el.dataset.value || null, { structural: true });
    else if (el.dataset.act === 'goto-field') {
      const target = host.querySelector(`[data-field="${CSS.escape(el.dataset.field)}"] [data-form-field], [data-field="${CSS.escape(el.dataset.field)}"] [role="radio"]`);
      if (target) { const control = controlOf(target); control.scrollIntoView({ block: 'center' }); control.focus({ preventScroll: true }); }
    }
  }, { signal });
  // The icon and colour choices are radio groups: the arrows move the choice.
  host.addEventListener('keydown', (e) => {
    const radio = e.target.closest?.('[role="radio"]');
    if (!radio || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const group = [...radio.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]:not(:disabled)')];
    const next = group[(group.indexOf(radio) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + group.length) % group.length];
    if (!next) return;
    e.preventDefault();
    const act = next.dataset.act;
    next.click();
    host.querySelector(`[data-act="${act}"][aria-checked="true"]`)?.focus({ preventScroll: true });
  }, { signal });
}

// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: the Create place
// ═══════════════════════════════════════════
//
// AI first: one box to describe the skill, with the sources it is drafted from (a session transcript, a web page, a
// registered project, memories, an existing skill); one worker drafts the package and the result waits in Review
// (sx-create-ai-view.js, P3). One step away, without AI: a blank skill from a name (checked as it is typed, a
// folder-safe name, a starting layout, the description written into its frontmatter), a pasted SKILL.md, and Import.
// A new skill starts as a draft in SynaBun's library and reaches a runtime only when it is published; an agent or a
// command is one file, written where the owner picks.

import { dropdownHTML, wireDropdowns } from '../../cc-dropdown.js';
import { decodeArtifactId } from '../ss-ids.js';
import { html, raw, setHTML, ICONS, attr } from './sx-dom.js';
import { slugify, checkName, scaffold, layoutsFor, pastedName } from './sx-create.js';
import { triggerImport } from './sx-import.js';
import { aiAreaHTML, wireAi, leaveAi, openCreation } from './sx-create-ai-view.js';

let _life = null;

export { openCreation };

function state(ctx) {
  if (!ctx.lib.create) ctx.lib.create = { name: '', kind: 'skill', layout: 'blank', description: '', invocation: 'auto', scope: 'global', projectPath: '' };
  return ctx.lib.create;
}

/** Start an import from anywhere (the menu's "Import…", a link). */
export function startImport(ctx) { triggerImport(ctx, ctx.capabilities); }

function nameChecks(ctx, st) {
  const shipped = ctx.rows.filter((r) => r.source === 'synabun').map((r) => r.folderName);
  const taken = ctx.rows.filter((r) => r.kind === st.kind).map((r) => r.folderName);
  return checkName(st.name, { shipped, taken, kind: st.kind });
}

function blankHTML(ctx, st) {
  const { t } = ctx;
  const check = nameChecks(ctx, st);
  const layouts = layoutsFor(st.kind);
  const typed = st.name !== '';
  const projects = [{ value: '', label: t('skillsStudio.import.chooseProject'), disabled: true, selected: !st.projectPath }, ...ctx.projects.map((p) => ({ value: p.path, label: p.label, selected: st.projectPath === p.path }))];
  return html`<div class="sx-blank" role="group" aria-labelledby="sx-blank-title">
    <h4 class="sx-section-title" id="sx-blank-title">${t('skillsStudio.create.blankTitle')}</h4>
    <div class="sx-field">
      <label class="sx-field-label" for="sx-cr-name">${t('skillsStudio.create.nameLabel')}</label>
      <input class="sx-input" id="sx-cr-name" value="${st.name}" autocomplete="off" spellcheck="false" aria-describedby="sx-cr-name-help"${attr('aria-invalid', typed && !check.ok ? 'true' : null)} placeholder="${t('skillsStudio.create.namePlaceholder')}">
      <p class="sx-field-note${typed && !check.ok ? ' sx-err-text' : check.warnings.length ? ' sx-warn-text' : ''}" id="sx-cr-name-help">${typed && !check.ok ? t(`skillsStudio.create.name.${check.errors[0]}`) : check.warnings.length ? t(`skillsStudio.create.name.${check.warnings[0]}`) : t('skillsStudio.create.nameHelp', { slug: st.name ? `/${st.name}` : '/name' })}</p>
    </div>
    <fieldset class="sx-field sx-choices"><legend class="sx-field-label">${t('skillsStudio.create.kindLabel')}</legend>
      ${['skill', 'agent', 'command'].map((k) => html`<label class="sx-choice"><input type="radio" name="sx-cr-kind" value="${k}"${st.kind === k ? ' checked' : ''}> ${t(`skillsStudio.create.kind.${k}`)}</label>`)}
      <p class="sx-help">${t(`skillsStudio.create.kindHelp.${st.kind}`)}</p>
    </fieldset>
    <fieldset class="sx-field"><legend class="sx-field-label">${t('skillsStudio.create.layoutLabel')}</legend>
      <div class="sx-layouts">${layouts.map((l) => html`<label class="sx-layout${st.layout === l ? ' is-on' : ''}"><input type="radio" name="sx-cr-layout" value="${l}"${st.layout === l ? ' checked' : ''}>
        <span class="sx-layout-name">${t(`skillsStudio.create.layout.${st.kind}.${l}.name`)}</span><span class="sx-layout-desc">${t(`skillsStudio.create.layout.${st.kind}.${l}.desc`)}</span></label>`)}</div>
    </fieldset>
    <div class="sx-field">
      <label class="sx-field-label" for="sx-cr-desc">${t('skillsStudio.create.descriptionLabel')} <span class="sx-count" id="sx-cr-desc-count">${st.description.length} / 1024</span></label>
      <textarea class="sx-input sx-textarea" id="sx-cr-desc" rows="3" maxlength="1024" placeholder="${t('skillsStudio.create.descriptionPlaceholder')}">${st.description}</textarea>
      <p class="sx-help">${t('skillsStudio.create.descriptionHelp')}</p>
    </div>
    ${st.kind === 'skill' ? html`<fieldset class="sx-field sx-choices"><legend class="sx-field-label">${t('skillsStudio.form.invocation')}</legend>
      <label class="sx-choice"><input type="radio" name="sx-cr-inv" value="auto"${st.invocation === 'auto' ? ' checked' : ''}> ${t('skillsStudio.form.invocationAuto', { name: st.name ? `/${st.name}` : '/name' })}</label>
      <label class="sx-choice"><input type="radio" name="sx-cr-inv" value="manual"${st.invocation === 'manual' ? ' checked' : ''}> ${t('skillsStudio.form.invocationManual', { name: st.name ? `/${st.name}` : '/name' })}</label>
      <p class="sx-help">${t('skillsStudio.create.whereSkill')}</p></fieldset>`
    : html`<fieldset class="sx-field sx-choices"><legend class="sx-field-label">${t('skillsStudio.create.whereLabel')}</legend>
      <label class="sx-choice"><input type="radio" name="sx-cr-scope" value="global"${st.scope === 'global' ? ' checked' : ''}> ${t(`skillsStudio.create.whereGlobal.${st.kind}`)}</label>
      <label class="sx-choice"><input type="radio" name="sx-cr-scope" value="project"${st.scope === 'project' ? ' checked' : ''}${ctx.projects.length ? '' : ' disabled'}> ${t('skillsStudio.create.whereProject')}</label>
      ${st.scope === 'project' ? html`<div class="sx-field"><span class="sx-field-label" id="sx-cr-project-label">${t('skillsStudio.import.project')}</span>${raw(dropdownHTML('sx-cr-project', projects, { labelledBy: 'sx-cr-project-label' }))}</div>` : ''}
    </fieldset>`}
    <div class="sx-row">
      <button type="button" class="sx-btn sx-btn--primary" data-create="blank" aria-keyshortcuts="${ctx.mac ? 'Meta+Enter' : 'Control+Enter'}">${t(`skillsStudio.create.createButton.${st.kind}`)} <kbd>${ctx.mac ? '⌘↵' : 'Ctrl+Enter'}</kbd></button>
      <button type="button" class="sx-btn" data-create="paste">${t('skillsStudio.create.paste')}</button>
      <button type="button" class="sx-btn sx-btn--ghost" data-create="import">${ICONS.upload}<span>${t('skillsStudio.create.import')}</span></button>
    </div>
  </div>`;
}

/** Draw the Create place. */
/** Create is left for another place: its listeners on the shared main area end. */
export function leaveCreatePlace() { _life?.abort(); _life = null; leaveAi(); }

export function renderCreatePlace(host, ctx) {
  const { t } = ctx;
  _life?.abort();
  _life = new AbortController();
  const signal = _life.signal;
  const st = state(ctx);
  const guest = ctx.guest;
  setHTML(host, html`<section class="sx-place sx-place--create" aria-labelledby="sx-create-title">
    <div class="sx-place-scroll"><div class="sx-create">
      <h3 class="sx-place-title" id="sx-create-title" tabindex="-1">${t('skillsStudio.create.title')}</h3>
      ${guest ? html`<p class="sx-note" role="note">${t('skillsStudio.create.guest')}</p>` : html`
      ${aiAreaHTML(ctx)}
      ${blankHTML(ctx, st)}`}
      <p class="sx-explain">${t('skillsStudio.create.explain')}</p>
      <div><p class="sx-help">${t('skillsStudio.create.examplesTitle')}</p><ul class="sx-plain-list sx-examples">
        <li>${t('skillsStudio.create.example1')}</li><li>${t('skillsStudio.create.example2')}</li><li>${t('skillsStudio.create.example3')}</li></ul></div>
    </div></div>
  </section>`);
  if (guest) return;
  wireDropdowns(host, { signal });
  // The AI box (its own listeners on the same host, ended by the same signal).
  wireAi(host, ctx, signal);
  host.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'sx-cr-name') {
      const slug = slugify(el.value);
      // Spaces and capitals turn into the folder-safe name as it is typed.
      if (slug !== el.value && /[\sA-Z_]/.test(el.value)) { const at = el.selectionStart; el.value = slug; el.setSelectionRange(Math.min(at, slug.length), Math.min(at, slug.length)); }
      st.name = el.value;
      updateName(host, ctx, st);
      return;
    }
    if (el.id === 'sx-cr-desc') { st.description = el.value; const c = host.querySelector('#sx-cr-desc-count'); if (c) c.textContent = `${el.value.length} / 1024`; }
  }, { signal });
  host.addEventListener('change', (e) => {
    const el = e.target;
    if (el.name === 'sx-cr-kind') { st.kind = el.value; st.layout = 'blank'; redraw(host, ctx, st); host.querySelector(`input[name="sx-cr-kind"][value="${el.value}"]`)?.focus(); }
    else if (el.name === 'sx-cr-layout') { st.layout = el.value; host.querySelectorAll('.sx-layout').forEach((l) => l.classList.toggle('is-on', l.querySelector('input')?.checked)); }
    else if (el.name === 'sx-cr-inv') st.invocation = el.value;
    else if (el.name === 'sx-cr-scope') { st.scope = el.value; redraw(host, ctx, st); host.querySelector(`input[name="sx-cr-scope"][value="${el.value}"]`)?.focus(); }
    else if (el.id === 'sx-cr-project') st.projectPath = el.value;
  }, { signal });
  host.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-create]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.create === 'blank') createBlank(host, ctx, st);
    else if (btn.dataset.create === 'paste') pasteSkill(ctx);
    else if (btn.dataset.create === 'import') startImport(ctx);
  }, { signal });
  host.addEventListener('keydown', (e) => {
    if ((ctx.mac ? e.metaKey : e.ctrlKey) && e.key === 'Enter' && e.target.closest?.('.sx-blank')) { e.preventDefault(); createBlank(host, ctx, st); }
  }, { signal });
}

function updateName(host, ctx, st) {
  const { t } = ctx;
  const check = nameChecks(ctx, st);
  const input = host.querySelector('#sx-cr-name');
  const help = host.querySelector('#sx-cr-name-help');
  const typed = st.name !== '';
  if (input) { if (typed && !check.ok) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  if (help) {
    help.className = `sx-field-note${typed && !check.ok ? ' sx-err-text' : check.warnings.length ? ' sx-warn-text' : ''}`;
    help.textContent = typed && !check.ok ? t(`skillsStudio.create.name.${check.errors[0]}`) : check.warnings.length ? t(`skillsStudio.create.name.${check.warnings[0]}`) : t('skillsStudio.create.nameHelp', { slug: st.name ? `/${st.name}` : '/name' });
  }
}

function redraw(host, ctx, st) {
  const blank = host.querySelector('.sx-blank');
  if (!blank) return;
  const tmp = document.createElement('div');
  setHTML(tmp, blankHTML(ctx, st));
  // (the dropdowns of the new form are served by the host's delegated listeners: wiring them again would toggle twice)
  blank.replaceWith(tmp.firstElementChild);
}

async function createBlank(host, ctx, st) {
  const { t } = ctx;
  const check = nameChecks(ctx, st);
  if (!check.ok) {
    // Said where it is: the field is marked, its note says why, and the keyboard goes there.
    const input = host.querySelector('#sx-cr-name');
    const help = host.querySelector('#sx-cr-name-help');
    input?.setAttribute('aria-invalid', 'true');
    if (help) { help.textContent = t(`skillsStudio.create.name.${check.errors[0]}`); help.className = 'sx-field-note sx-err-text'; }
    input?.focus();
    return;
  }
  if (st.kind !== 'skill' && st.scope === 'project' && !st.projectPath) { ctx.toast(t('skillsStudio.import.chooseProjectError'), 'error'); host.querySelector('#sx-cr-project-trigger')?.focus(); return; }
  const files = scaffold({ kind: st.kind, name: st.name, description: st.description, layout: st.layout, invocation: st.invocation }).files;
  const btn = host.querySelector('[data-create="blank"]');
  if (btn) btn.disabled = true;
  const gen = ctx.gen();
  try {
    if (st.kind === 'skill') {
      const res = await ctx.api.createLibrarySkill({ name: st.name, files }, { idempotencyKey: ctx.key('create') });
      if (!ctx.alive(gen)) return;
      ctx.toast(t('skillsStudio.create.created', { name: st.name }));
      ctx.lib.create = null;
      await ctx.reload();
      if (ctx.alive(gen)) await ctx.openRow(`lib:${res.skillId}`, { tab: 'edit' });
    } else {
      const res = await ctx.api.createSkillsArtifact({ type: st.kind, scope: st.scope, projectPath: st.scope === 'project' ? st.projectPath : '', name: st.name, rawContent: files[0].content });
      if (!ctx.alive(gen)) return;
      ctx.toast(t('skillsStudio.create.created', { name: st.name }));
      ctx.lib.create = null;
      await ctx.reload();
      const id = decodeArtifactId(res?.id || '');
      const path = id.slice(id.indexOf(':') + 1);
      const row = ctx.rows.find((r) => r.entries.some((e) => e.path === path));
      if (row && ctx.alive(gen)) await ctx.openRow(row.key, { tab: 'edit' });
    }
  } catch (err) {
    if (!ctx.alive(gen)) return;
    if (btn) btn.disabled = false;
    ctx.toast(t('skillsStudio.create.failed', { error: err.message }), 'error');
  }
}

async function pasteSkill(ctx) {
  const { t } = ctx;
  const box = document.createElement('div');
  box.className = 'sx-dlg-form';
  const label = document.createElement('label');
  label.className = 'sx-field-label';
  label.htmlFor = 'sx-paste';
  label.textContent = t('skillsStudio.create.pasteLabel');
  const area = document.createElement('textarea');
  area.id = 'sx-paste';
  area.className = 'sx-input sx-textarea sx-mono';
  area.rows = 12;
  area.spellcheck = false;
  const nameLabel = document.createElement('label');
  nameLabel.className = 'sx-field-label';
  nameLabel.htmlFor = 'sx-paste-name';
  nameLabel.textContent = t('skillsStudio.create.nameLabel');
  const nameInput = document.createElement('input');
  nameInput.id = 'sx-paste-name';
  nameInput.className = 'sx-input';
  nameInput.autocomplete = 'off';
  area.addEventListener('input', () => { if (!nameInput.dataset.touched) nameInput.value = slugify(pastedName(area.value)); });
  nameInput.addEventListener('input', () => { nameInput.dataset.touched = '1'; });
  const err = document.createElement('p');
  err.className = 'ss-dlg-error';
  err.setAttribute('role', 'alert');
  box.append(label, area, nameLabel, nameInput, err);
  setTimeout(() => area.focus(), 0);
  let chosen = null;
  const answer = await ctx.ask({
    title: t('skillsStudio.create.pasteTitle'), extra: box, wide: true,
    buttons: [{ id: 'cancel', label: t('skillsStudio.dialog.cancel') }, { id: 'ok', label: t('skillsStudio.create.pasteConfirm'), kind: 'primary' }],
    accept: (id) => {
      if (id !== 'ok') return true;
      if (!area.value.trim()) { err.textContent = t('skillsStudio.create.pasteEmpty'); return false; }
      const check = checkName(nameInput.value.trim(), { shipped: ctx.rows.filter((r) => r.source === 'synabun').map((r) => r.folderName) });
      if (!check.ok) { err.textContent = t(`skillsStudio.create.name.${check.errors[0]}`); return false; }
      chosen = { name: nameInput.value.trim(), text: area.value };
      return true;
    },
  });
  if (answer !== 'ok' || !chosen) return;
  const gen = ctx.gen();
  try {
    const res = await ctx.api.createLibrarySkill({ name: chosen.name, files: [{ path: 'SKILL.md', content: chosen.text }] }, { idempotencyKey: ctx.key('paste') });
    if (!ctx.alive(gen)) return;
    ctx.toast(t('skillsStudio.create.created', { name: chosen.name }));
    await ctx.reload();
    if (ctx.alive(gen)) await ctx.openRow(`lib:${res.skillId}`, { tab: 'edit' });
  } catch (e) { if (ctx.alive(gen)) ctx.toast(t('skillsStudio.create.failed', { error: e.message }), 'error'); }
}

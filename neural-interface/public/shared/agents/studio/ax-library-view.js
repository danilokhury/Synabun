// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the Library
// ═══════════════════════════════════════════
//
// Every agent of the global library and of the projects, as cards or as a list: its mark, name, what it runs on,
// what it is offered for, where it applies, where it stands and its revision. A search, filters (scope, status,
// provider) and a sort narrow it; what was chosen is kept for the next opening. An empty library leads to Create.
// The rows and their order are ax-library.js; this module draws them and listens on the one main area (its
// listeners end when another place is drawn).

import { html, setHTML, ICONS, rovingFocus } from '../../skills/studio/sx-dom.js';
import { wireDropdowns } from '../../cc-dropdown.js';
import { filterAgents, sortAgents, providersOf, projectsOf, SORTS, STATUS_FILTERS, DEFAULT_FILTERS } from './ax-library.js';
import { keyOf, agentKeyText } from './ax-views.js';
import { AX_ICONS } from './ax-icons.js';
import { agentMark, standingLabels, scopeTag, timeTag, dropdown, loadingHTML, errorHTML, emptyHTML, wordOr, downloadText, errorText } from './ax-ui.js';

let life = null;
let searchTimer = 0;

export function leaveLibrary() {
  life?.abort();
  life = null;
  clearTimeout(searchTimer);
}

const modelText = (t, agent) => `${wordOr(t, 'agentsStudio.provider', agent.provider || '')}${agent.model ? ` · ${agent.model}` : ''}${agent.effort ? ` · ${agent.effort}` : ''}`;

function cardHTML(ctx, agent) {
  const { t } = ctx;
  const key = agentKeyText(keyOf(agent));
  return html`<li class="ax-card" data-agent="${key}">
    <div class="ax-card-top">${agentMark(agent, 20)}
      <div class="ax-card-title"><button type="button" class="sx-name-btn ax-card-name" data-act="open-agent" data-agent="${key}">${agent.name || agent.id}</button><span class="sx-mono ax-card-id">${agent.id}</span></div>
    </div>
    <p class="ax-card-desc">${agent.description || t('agentsStudio.library.noDescription')}</p>
    <p class="ax-card-meta">${modelText(t, agent)}</p>
    ${agent.taskClasses?.length ? html`<p class="sx-chips ax-card-classes">${agent.taskClasses.map((cls) => html`<span class="sx-chip ax-chip">${wordOr(t, 'agentsStudio.taskClass', cls)}</span>`)}</p>` : ''}
    <div class="ax-card-foot">${scopeTag(t, agent.scope, ctx.info?.projects)}<span class="ax-card-state">${standingLabels(t, agent)}</span><span class="sx-spacer"></span><span class="ax-card-time">${timeTag(agent.updatedAt, ctx.locale)}</span></div>
  </li>`;
}

function rowHTML(ctx, agent) {
  const { t } = ctx;
  const key = agentKeyText(keyOf(agent));
  return html`<tr data-agent="${key}">
    <td class="sx-col-name"><span class="ax-row-name">${agentMark(agent, 16)}<span><button type="button" class="sx-name-btn" data-act="open-agent" data-agent="${key}">${agent.name || agent.id}</button><span class="sx-desc">${agent.description || agent.id}</span></span></span></td>
    <td class="ax-col-model">${modelText(t, agent)}</td>
    <td class="ax-col-classes">${(agent.taskClasses || []).map((cls) => wordOr(t, 'agentsStudio.taskClass', cls)).join(', ')}</td>
    <td class="ax-col-scope">${scopeTag(t, agent.scope, ctx.info?.projects)}</td>
    <td class="ax-col-state">${standingLabels(t, agent)}</td>
    <td class="sx-col-updated">${timeTag(agent.updatedAt, ctx.locale)}</td>
  </tr>`;
}

function filtersHTML(ctx) {
  const { t, filters: f } = ctx;
  const projects = projectsOf(ctx.agents, ctx.info?.projects);
  const scopes = [
    { value: 'all', label: t('agentsStudio.library.scopeAll'), selected: f.scope === 'all' },
    { value: 'global', label: t('agentsStudio.scope.global'), selected: f.scope === 'global' },
    { value: 'project', label: t('agentsStudio.library.scopeProjects'), selected: f.scope === 'project' },
    ...(projects.length ? [{ group: t('agentsStudio.library.scopeOneProject'), options: projects.map((p) => ({ value: `project:${p.path}`, label: p.label, caption: p.path, selected: f.scope === `project:${p.path}` })) }] : []),
  ];
  const statuses = STATUS_FILTERS.map((s) => ({ value: s, label: s === 'all' ? t('agentsStudio.library.statusAll') : t(`agentsStudio.status.${s}`), selected: f.status === s }));
  const providers = [{ value: 'all', label: t('agentsStudio.library.providerAll'), selected: f.provider === 'all' }, ...providersOf(ctx.agents).map((p) => ({ value: p, label: wordOr(t, 'agentsStudio.provider', p), selected: f.provider === p }))];
  if (f.provider !== 'all' && !providers.some((p) => p.selected)) providers.push({ value: f.provider, label: wordOr(t, 'agentsStudio.provider', f.provider), selected: true });
  const sorts = SORTS.map((s) => ({ value: s, label: t(`agentsStudio.library.sort.${s}`), selected: f.sort === s }));
  const filter = (id, label, entries) => html`<span class="sx-filter"><span class="sx-filter-key" id="${id}-label">${label}</span>${dropdown(id, entries, { labelledBy: `${id}-label` })}</span>`;
  return html`${filter('ax-f-scope', t('agentsStudio.library.scope'), scopes)}${filter('ax-f-status', t('agentsStudio.library.status'), statuses)}${filter('ax-f-provider', t('agentsStudio.library.provider'), providers)}${filter('ax-f-sort', t('agentsStudio.library.sortBy'), sorts)}`;
}

function listHTML(ctx) {
  const { t, filters: f } = ctx;
  if (ctx.loading) return loadingHTML(t);
  if (ctx.loadError && !ctx.agents.length) return errorHTML(t, ctx.loadError);
  if (!ctx.agents.length) {
    return emptyHTML({
      icon: AX_ICONS.mark, title: t('agentsStudio.library.emptyTitle'),
      lines: [t('agentsStudio.library.emptyHelp'), t('agentsStudio.library.emptyApproval')],
      actions: ctx.canDraft ? html`<button type="button" class="sx-btn sx-btn--primary" data-act="new-agent">${ICONS.plus}${t('agentsStudio.library.newAgent')}</button><button type="button" class="sx-btn" data-act="new-template">${t('agentsStudio.library.fromTemplate')}</button><button type="button" class="sx-btn" data-act="new-import">${ICONS.upload}${t('agentsStudio.library.import')}</button>` : '',
    });
  }
  const rows = sortAgents(filterAgents(ctx.agents, f), f.sort);
  if (!rows.length) {
    return emptyHTML({ icon: ICONS.search, title: t('agentsStudio.library.noMatchTitle'), lines: [t('agentsStudio.library.noMatchHelp')], actions: html`<button type="button" class="sx-btn" data-act="clear-filters">${t('agentsStudio.library.clearFilters')}</button>` });
  }
  const summary = html`<p class="sx-summary" role="status">${ctx.tp('agentsStudio.library.shown', rows.length, { total: ctx.agents.length })}</p>`;
  if (f.layout === 'list') {
    return html`${summary}<table class="sx-lib ax-lib"><thead><tr><th class="sx-col-name">${t('agentsStudio.library.col.agent')}</th><th class="ax-col-model">${t('agentsStudio.library.col.runsOn')}</th><th class="ax-col-classes">${t('agentsStudio.library.col.classes')}</th><th class="ax-col-scope">${t('agentsStudio.library.col.scope')}</th><th class="ax-col-state">${t('agentsStudio.library.col.status')}</th><th class="sx-col-updated">${t('agentsStudio.library.col.updated')}</th></tr></thead><tbody>${rows.map((agent) => rowHTML(ctx, agent))}</tbody></table>`;
  }
  return html`${summary}<ul class="ax-cards" aria-label="${t('agentsStudio.rail.library')}">${rows.map((agent) => cardHTML(ctx, agent))}</ul>`;
}

/** Draw the Library in the main area. */
export function renderLibrary(main, ctx) {
  leaveLibrary();
  life = new AbortController();
  const { signal } = life;
  const { t, filters: f } = ctx;
  setHTML(main, html`<section class="sx-place ax-place" aria-labelledby="ax-lib-title">
    <header class="sx-place-head">
      <h3 class="sx-place-title" id="ax-lib-title" tabindex="-1">${t('agentsStudio.rail.library')}</h3>
      <span class="sx-search">${ICONS.search}<input type="search" id="ax-lib-search" value="${f.q}" placeholder="${t('agentsStudio.library.search')}" aria-label="${t('agentsStudio.library.search')}" autocomplete="off" spellcheck="false" data-autofocus></span>
      <span class="sx-spacer"></span>
      <span class="sx-seg" role="group" aria-label="${t('agentsStudio.library.layout')}">
        <button type="button" data-act="layout" data-layout="cards" aria-pressed="${f.layout === 'cards' ? 'true' : 'false'}" aria-label="${t('agentsStudio.library.layoutCards')}" title="${t('agentsStudio.library.layoutCards')}">${AX_ICONS.cards}</button>
        <button type="button" data-act="layout" data-layout="list" aria-pressed="${f.layout === 'list' ? 'true' : 'false'}" aria-label="${t('agentsStudio.library.layoutList')}" title="${t('agentsStudio.library.layoutList')}">${AX_ICONS.list}</button>
      </span>
      ${ctx.caps.has('export') && ctx.agents.length ? html`<button type="button" class="sx-btn" data-act="export-all" title="${t('agentsStudio.library.exportAllHelp')}">${ICONS.download}${t('agentsStudio.library.exportAll')}</button>` : ''}
      ${ctx.canDraft ? html`<button type="button" class="sx-btn sx-btn--primary" data-act="new-agent">${ICONS.plus}${t('agentsStudio.library.newAgent')}</button>` : ''}
    </header>
    <div class="sx-place-head ax-filters" id="ax-lib-filters">${filtersHTML(ctx)}</div>
    <div class="sx-place-scroll" id="ax-lib-list">${listHTML(ctx)}</div>
  </section>`);

  const list = main.querySelector('#ax-lib-list');
  const redrawList = () => setHTML(list, listHTML(ctx));
  // The arrows move between the agents' names (the items are read at each key, so a redrawn list needs nothing more).
  rovingFocus(list, '.sx-name-btn', { signal });
  wireDropdowns(main, { signal });

  main.addEventListener('input', (e) => {
    if (e.target.id !== 'ax-lib-search') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { f.q = e.target.value.slice(0, 200); ctx.saveFilters(); redrawList(); }, 120);
  }, { signal });
  main.addEventListener('change', (e) => {
    const map = { 'ax-f-scope': 'scope', 'ax-f-status': 'status', 'ax-f-provider': 'provider', 'ax-f-sort': 'sort' };
    const name = map[e.target.id];
    if (!name) return;
    f[name] = e.target.value;
    ctx.saveFilters();
    redrawList();
  }, { signal });
  main.addEventListener('click', async (e) => {
    const el = e.target.closest?.('[data-act]');
    if (!el || !main.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'open-agent') {
      const agent = ctx.agents.find((a) => agentKeyText(keyOf(a)) === el.dataset.agent);
      if (agent) ctx.go({ type: 'agent', key: keyOf(agent) });
    } else if (act === 'new-agent') ctx.go({ type: 'place', place: 'create' });
    else if (act === 'new-template') ctx.go({ type: 'place', place: 'create', create: 'template' });
    else if (act === 'new-import') ctx.go({ type: 'place', place: 'create', create: 'import' });
    else if (act === 'retry') ctx.reload();
    else if (act === 'clear-filters') { Object.assign(f, { ...DEFAULT_FILTERS, layout: f.layout, sort: f.sort }); ctx.saveFilters(); ctx.render(); }
    else if (act === 'layout') { f.layout = el.dataset.layout === 'list' ? 'list' : 'cards'; ctx.saveFilters(); ctx.render({ keepFocus: true }); }
    else if (act === 'export-all') {
      el.disabled = true;
      try {
        const res = await ctx.api.exportAll({});
        downloadText('synabun-agents.json', `${JSON.stringify(res.bundle, null, 2)}\n`);
        ctx.toast(ctx.tp('agentsStudio.toast.exported', res.bundle?.agents?.length ?? 0));
      } catch (error) { ctx.toast(t('agentsStudio.toast.exportFailed', { error: errorText(t, error) }), 'error'); } finally { el.disabled = false; }
    }
  }, { signal });
}

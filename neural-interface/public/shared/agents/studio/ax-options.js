// ═══════════════════════════════════════════
// SynaBun Neural Interface — Agents Studio: the choices of the editor's dropdowns
// ═══════════════════════════════════════════
//
// Every dropdown of the editor is the app's `.cc-dropdown` (cc-dropdown.js), fed with entries built here from what
// the app already knows: the providers, capability levels, permission policies and task classes the server names
// (GET /capabilities), the models of the live catalog every model menu reads (asst-brain-picker.js
// loadModelCatalog), a model's own effort levels, the accounts, the tool groups and MCP servers of the tool catalog
// (GET /api/mcp/tools, through the app's own tool-list view), the MoreLogin profiles the owner allowed agents, the
// skills, the memory categories and the registered projects. Nothing here is a list of its own: a value that was
// saved and is no longer offered (a model that was removed, a profile no longer allowed) stays in its dropdown,
// said as such, so opening an agent never changes it.
// No DOM. `{ value, label, selected, caption, disabled }` and `{ group, options }` are cc-dropdown's entries.

import { toolListView, toolsFromInput, toolListInput } from '../../tool-list-view.js';

const text = (value) => (typeof value === 'string' ? value : '');

/** Entries of a fixed list of values (`labelOf` gives each its word). */
export function enumEntries(values, selected, labelOf = (v) => v, captionOf = null) {
  const list = Array.isArray(values) ? values.filter((v) => typeof v === 'string' && v) : [];
  const out = list.map((value) => ({ value, label: labelOf(value), selected: value === selected, ...(captionOf ? { caption: captionOf(value) } : {}) }));
  // A saved value the server no longer names is kept, as written.
  if (selected && !list.includes(selected)) out.push({ value: selected, label: labelOf(selected), selected: true });
  return out;
}

/** Entries of a multi-choice list: every value, the chosen ones ticked; a chosen value that is not offered stays. */
export function multiEntries(values, selected = [], labelOf = (v) => v, captionOf = null) {
  const chosen = new Set(Array.isArray(selected) ? selected : []);
  const list = [...new Set([...(Array.isArray(values) ? values : []), ...chosen])].filter((v) => typeof v === 'string' && v);
  return list.map((value) => ({ value, label: labelOf(value), selected: chosen.has(value), ...(captionOf ? { caption: captionOf(value) } : {}) }));
}

/** What a multi dropdown's hidden input holds, as a list. */
export const multiValue = (value) => text(value).split(',').map((item) => item.trim()).filter(Boolean);

/**
 * The models of one provider. `rows` are the catalog's (id, selector, label, status …). The first entry is the
 * provider's default (no model named); a model that is unavailable is listed disabled; a saved one that is not in
 * the list is kept as written.
 */
export function modelEntries(rows, selected, { defaultLabel = 'Default', savedLabel = (id) => id, unavailableWord = '' } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row.id === 'string' && row.id);
  const valueOf = (row) => text(row.selector) || row.id;
  const out = [{ value: '', label: defaultLabel, selected: !selected }];
  const seen = new Set();
  for (const row of list) {
    const value = valueOf(row);
    if (seen.has(value)) continue;
    seen.add(value);
    const off = row.status === 'unavailable';
    out.push({ value, label: text(row.label) || row.id, selected: !!selected && (selected === value || selected === row.id), disabled: off && selected !== value && selected !== row.id, ...(off && unavailableWord ? { caption: unavailableWord } : (text(row.desc) ? { caption: row.desc } : {})) });
  }
  if (selected && !out.some((entry) => entry.selected)) out.push({ value: selected, label: savedLabel(selected), selected: true });
  return out;
}

/** The catalog row a saved model names, or null. */
export function modelRow(rows, selected) {
  if (!selected) return null;
  return (Array.isArray(rows) ? rows : []).find((row) => row && (row.id === selected || row.selector === selected)) || null;
}

/**
 * The effort levels of a model (`levels`: what the app's own effort helper lists for that provider and model, its
 * first entry `off` standing for the model's default). '' is the default.
 */
export function effortEntries(levels, selected, { defaultLabel = 'Default' } = {}) {
  const list = (Array.isArray(levels) ? levels : []).filter((level) => level && typeof level.id === 'string');
  const out = [{ value: '', label: defaultLabel, selected: !selected }];
  for (const level of list) {
    if (level.id === 'off') continue;
    out.push({ value: level.id, label: text(level.label) || level.id, selected: selected === level.id, ...(text(level.desc) ? { caption: level.desc } : {}) });
  }
  if (selected && !out.some((entry) => entry.selected)) out.push({ value: selected, label: selected, selected: true });
  return out;
}

/** The accounts of a provider that has them: the worker's default account first ('' ), then each profile. */
export function accountEntries(accounts, selected, { defaultLabel = 'Default account' } = {}) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((account) => account && typeof account.id === 'string' && account.id && account.id !== 'default');
  const out = [{ value: '', label: defaultLabel, selected: !selected }];
  for (const account of list) out.push({ value: account.id, label: text(account.label) || text(account.name) || account.id, selected: selected === account.id });
  if (selected && !out.some((entry) => entry.selected)) out.push({ value: selected, label: selected, selected: true });
  return out;
}

/** The scope dropdown: the global library, then every registered project. Values: `global`, `project:<path>`. */
export function scopeEntries(projects, scope, { globalLabel = 'Global library', projectsLabel = 'Projects', labelOf = (p) => p.label || p.path } = {}) {
  const list = (Array.isArray(projects) ? projects : []).filter((p) => p && typeof p.path === 'string' && p.path);
  const current = scopeValue(scope);
  const options = list.map((p) => ({ value: `project:${p.path}`, label: labelOf(p), caption: p.path, selected: current === `project:${p.path}` }));
  // An agent pinned to a folder that is no longer registered keeps its pin.
  if (scope?.kind === 'project' && !options.some((o) => o.selected)) options.push({ value: current, label: scope.path, selected: true });
  return [{ value: 'global', label: globalLabel, selected: current === 'global' }, ...(options.length ? [{ group: projectsLabel, options }] : [])];
}
export const scopeValue = (scope) => (scope?.kind === 'project' ? `project:${scope.path || ''}` : 'global');
export function scopeFromValue(value) {
  const v = text(value);
  return v.startsWith('project:') && v.length > 8 ? { kind: 'project', path: v.slice(8) } : { kind: 'global' };
}

/**
 * The MoreLogin profiles an agent may be given: only the ones the owner allowed agents to choose
 * (GET /api/morelogin/agent-profiles). '' is SynaBun's default browser. A saved profile that is no longer allowed
 * stays, marked: a run with it is refused until the owner allows it again.
 */
export function profileEntries(profiles, selected, { noneLabel = 'Default browser', notAllowedWord = 'Not allowed for agents' } = {}) {
  const list = (Array.isArray(profiles) ? profiles : []).filter((p) => p && (typeof p.envId === 'string' || typeof p.envId === 'number'));
  const out = [{ value: '', label: noneLabel, selected: !selected }];
  for (const p of list) {
    const id = String(p.envId);
    out.push({ value: id, label: text(p.name) || id, selected: selected === id || (!!selected && selected === p.name), ...(text(p.name) ? { caption: id } : {}) });
  }
  if (selected && !out.some((entry) => entry.selected)) out.push({ value: selected, label: selected, caption: notAllowedWord, selected: true });
  return out;
}
/** Whether a saved profile is one the owner allows agents. */
export function profileAllowed(profiles, selected) {
  if (!selected) return true;
  return (Array.isArray(profiles) ? profiles : []).some((p) => String(p?.envId) === selected || p?.name === selected);
}
/** What a profile is called (its name when the list has it). */
export function profileName(profiles, selected) {
  if (!selected) return '';
  const found = (Array.isArray(profiles) ? profiles : []).find((p) => String(p?.envId) === selected || p?.name === selected);
  return text(found?.name) || selected;
}

/** The skills an agent works with: the library's and the catalog's names, each once. */
export function skillEntries(skills, selected = []) {
  const names = [...new Set((Array.isArray(skills) ? skills : []).map((s) => (typeof s === 'string' ? s : text(s?.name)).toLowerCase()).filter(Boolean))].sort();
  const captions = new Map((Array.isArray(skills) ? skills : []).filter((s) => s && typeof s === 'object').map((s) => [text(s.name).toLowerCase(), text(s.description).slice(0, 160)]));
  return multiEntries(names, selected, (v) => v, (v) => captions.get(v) || '');
}

/** The memory categories: '' for none, then every category that takes memories (never a parent). */
export function categoryEntries(categories, selected, { noneLabel = 'No category' } = {}) {
  const list = (Array.isArray(categories) ? categories : []).filter((c) => c && typeof c.name === 'string' && c.name && c.is_parent !== true && c.isParent !== true);
  const out = [{ value: '', label: noneLabel, selected: !selected }];
  const byParent = new Map();
  for (const c of list) {
    const parent = text(c.parent);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push({ value: c.name, label: c.name, selected: selected === c.name, ...(text(c.description) ? { caption: c.description.slice(0, 160) } : {}) });
  }
  for (const [parent, options] of [...byParent].sort((a, b) => a[0].localeCompare(b[0]))) {
    options.sort((a, b) => a.label.localeCompare(b.label));
    if (parent) out.push({ group: parent, options }); else out.push(...options);
  }
  if (selected && !list.some((c) => c.name === selected)) out.push({ value: selected, label: selected, selected: true });
  return out;
}

/**
 * The tool groups of an agent, as the app's own tool list shows them (tool-list-view.js over the server's tool
 * catalog): "Default tools" (the definition's `tools: null`), every group, or the always-on tools only. The MCP
 * servers have a dropdown of their own (the definition keeps them apart).
 * @returns {{ entries: object[], summary: string } | null} null without a catalog
 */
export function toolGroupChoices(catalog, tools, { provider = 'claude-code', usesBrowser = false, defaultLabel = 'Default tools', translate = null } = {}) {
  if (!catalog || !Array.isArray(catalog.groups)) return null;
  const view = toolListView(catalog, Array.isArray(tools) ? tools.filter((id) => !id.startsWith('mcp:')) : null, { inheritLabel: defaultLabel, usesBrowser, provider, translate, includeServers: false });
  return { entries: view.entries, summary: view.summary };
}
/** The definition's `tools` from that dropdown's value: null for the default tools, else the groups named. */
export function toolsFromChoice(value) {
  const read = toolsFromInput(value, { inherit: true, externalSelection: true });
  return read === null ? null : read.filter((id) => !id.startsWith('mcp:') && id !== '__no_servers__');
}
export const toolChoiceValue = (tools) => toolListInput(Array.isArray(tools) ? tools : null);

/**
 * The MCP servers of an agent, from the tool catalog's `servers` (the owner's other MCP servers): all of them
 * (`*`), or the ones ticked. A server the owner blocks for agents, or that this provider cannot be given, is
 * listed disabled with the reason; a saved name the catalog does not list stays.
 */
export function serverEntries(catalog, selected = [], { provider = 'claude-code', allLabel = 'All my servers', words = {} } = {}) {
  const chosen = Array.isArray(selected) ? selected : [];
  const all = chosen.includes('*');
  const rows = (Array.isArray(catalog?.servers) ? catalog.servers : []).filter((row) => row && typeof row.ref === 'string' && row.ref.startsWith('mcp:') && row.selectable !== false);
  const names = rows.map((row) => row.ref.slice(4));
  const options = rows.map((row) => {
    const name = row.ref.slice(4);
    const availability = row.providers?.[provider];
    const unavailable = !!row.providers && availability !== undefined && availability !== 'deliverable';
    const off = row.blocked === true || unavailable;
    return { value: name, label: text(row.label) || name, scope: 'servers', selected: !all && chosen.includes(name), disabled: off && !chosen.includes(name), caption: row.blocked ? (words.blocked || '') : unavailable ? (availability === 'unknown' ? (words.unknown || '') : (words.unavailable || '')) : name };
  });
  for (const name of chosen) if (name !== '*' && !names.includes(name)) options.push({ value: name, label: name, scope: 'servers', selected: !all, caption: words.missing || '' });
  return [{ value: '*', label: allLabel, scope: 'servers', exclusive: true, selected: all }, ...options];
}
/** The definition's `mcpServers` from that dropdown's value. */
export function serversFromChoice(value) {
  const list = multiValue(value);
  return list.includes('*') ? ['*'] : list;
}

// Shared cc-dropdown rendering; the pure view owns labels and catalog-derived choices.
import { dropdownHTML, setDropdownItems, dropdownOf } from './cc-dropdown.js';
import { toolListView, toolListWord, toolsFromInput, strictToolHost, taskToolHost } from './tool-list-view.js';
import { getCachedToolCatalog, fetchToolCatalog } from './agent-runtime-options.js';
let translate;
export function configureToolPickerTranslation(fn) { if (typeof fn === 'function') translate = fn; }
export { toolsFromInput, strictToolHost, taskToolHost };
export const toolWord = (key, params) => toolListWord(key, params, translate);
export function toolPickerHTML(id, tools, options = {}) {
  const catalog = options.catalog || getCachedToolCatalog(options.cwd);
  if (!catalog) return '';
  const view = toolListView(catalog, tools, { translate, ...options });
  return dropdownHTML(id, view.entries, { multiple: true, label: toolWord('label'), classes: 'tool-list-picker',
    summary: view.summary, ...options, classes: `tool-list-picker ${options.classes || ''}`.trim(), attrs: `data-tool-options="${encodeURIComponent(JSON.stringify({ inheritLabel: options.inheritLabel, usesBrowser: options.usesBrowser, taskClass: options.taskClass, cwd: options.cwd, provider: options.provider, includeServers: options.includeServers, externalSelection: catalog.externalServersVersion >= 2 && options.includeServers !== false && options.provider !== 'gemini', externalRefs: (tools ?? catalog.defaultTools ?? []).filter(id => id.startsWith('mcp:')) }))}"` });
}
export function updateToolPicker(input, tools, options = {}) {
  options = { ...JSON.parse(decodeURIComponent(dropdownOf(input)?.dataset.toolOptions || '%7B%7D')), ...options };
  const catalog = options.catalog || getCachedToolCatalog(options.cwd);
  if (!catalog || !input) return;
  const view = toolListView(catalog, tools, { translate, ...options });
  setDropdownItems(input, view.entries);
  const dd = dropdownOf(input);
  if (dd) dd.dataset.toolOptions = encodeURIComponent(JSON.stringify({ inheritLabel: options.inheritLabel, usesBrowser: options.usesBrowser, taskClass: options.taskClass, cwd: options.cwd, provider: options.provider, includeServers: options.includeServers, externalSelection: catalog.externalServersVersion >= 2 && options.includeServers !== false && options.provider !== 'gemini', externalRefs: (tools ?? catalog.defaultTools ?? []).filter(id => id.startsWith('mcp:')) }));
  const label = dropdownOf(input)?.querySelector('.cc-dropdown-value');
  if (label) { label.textContent = view.summary; label.title = view.summary; }
}
export function readToolPicker(input, options = {}) {
  if (!input) return undefined; // old server: do not invent a selection
  const dd = dropdownOf(input);
  const raw = options.requested ? input.value.split(',').filter(id => ![...(dd?.querySelectorAll('[data-automatic="true"]') || [])].some(row => row.dataset.value === id)).join(',') : input.value;
  const stored = JSON.parse(decodeURIComponent(dd?.dataset.toolOptions || '%7B%7D'));
  const value = toolsFromInput(raw, { ...stored, ...options });
  if (value && !stored.externalSelection && stored.externalRefs?.length) return [...value.filter(id => !id.startsWith('mcp:')), ...stored.externalRefs];
  return value?.filter(id => id !== 'memory') ?? value;
}

// A draft changes check rows/counts immediately; only cc-dropdown's close emits change.
if (typeof document !== 'undefined') document.addEventListener('cc-dropdown-draft', (event) => {
  const dd = dropdownOf(event.target);
  if (!dd?.classList.contains('tool-list-picker')) return;
  const options = JSON.parse(decodeURIComponent(dd.dataset.toolOptions || '%7B%7D'));
  updateToolPicker(event.target, readToolPicker(event.target, { requested: true }), options);
});

if (typeof document !== 'undefined') document.addEventListener('mcp:servers-changed', () => {
  const pickers = [...document.querySelectorAll('.tool-list-picker')];
  for (const dd of pickers) {
    const input = document.getElementById(dd.dataset.for);
    const options = JSON.parse(decodeURIComponent(dd.dataset.toolOptions || '%7B%7D'));
    const tools = readToolPicker(input, { requested: true });
    fetchToolCatalog(false, { cwd: options.cwd }).then(catalog => {
      if (catalog && input?.isConnected) updateToolPicker(input, tools, { ...options, catalog });
    }).catch(() => {});
  }
});

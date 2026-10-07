// SynaBun — a searchable library of saved terminal commands.
import { emit, on } from './state.js';
import { KEYS, COLOR_PALETTE } from './constants.js';
import { storage } from './storage.js';
import { commandLaunchPayload, selectCommandGroups, isCommandLaunchAvailable } from './command-runner-model.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const genId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const color = value => CSS.supports('color', String(value)) ? value : COLOR_PALETTE[0];
const PANEL_KEY = KEYS.PANEL_PREFIX + 'command-runner';
const DATA_KEY = KEYS.COMMAND_RUNNER;
const canRun = () => isCommandLaunchAvailable(navigator.onLine, location.hostname);
const icon = path => `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const SVG = {
  terminal: icon('<path d="m4 6 6 6-6 6M13 18h7"/>'),
  play: icon('<path d="m8 5 11 7-11 7Z"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  search: icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>'),
  folder: icon('<path d="M3 7V5h6l2 2h10v12H3Z"/>'),
  edit: icon('<path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m13 6 5 5"/>'),
  trash: icon('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'),
  chevron: icon('<path d="m9 5 7 7-7 7"/>'),
  close: icon('<path d="m6 6 12 12M6 18 18 6"/>'),
  check: icon('<path d="m5 12 4 4L19 6"/>'),
};
let _panel = null, _editTarget = null, _modalOpener = null, _panelOpener = null;
let _data = { categories: [], commands: [] };
let _view = { query: '', categoryId: '', sort: 'saved' };
let _dataError = false, _launchTimer = null, _launchedId = null, _abort = null;
const _searchCollapsed = new Set();

export function initCommandRunner() { return on('command-runner:open', openPanel); }

function clampPanel() {
  if (!_panel) return;
  const width = _panel.offsetWidth, height = _panel.offsetHeight;
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--navbar-height')) || 48;
  _panel.style.left = Math.max(8, Math.min(parseFloat(_panel.style.left) || 8, window.innerWidth - width - 8)) + 'px';
  _panel.style.top = Math.max(top + 8, Math.min(parseFloat(_panel.style.top) || top + 8, window.innerHeight - height - 8)) + 'px';
}
function openPanel() {
  if (_panel) { $('cr-search')?.focus(); return; }
  _panelOpener = document.activeElement;
  _view = { query: '', categoryId: '', sort: 'saved' };
  _searchCollapsed.clear();
  _abort = new AbortController();
  _panel = document.createElement('section');
  _panel.className = 'command-runner-panel glass resizable';
  _panel.id = 'command-runner-panel';
  _panel.setAttribute('role', 'region');
  _panel.setAttribute('aria-labelledby', 'cr-title');
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);
  try {
    const saved = JSON.parse(storage.getItem(PANEL_KEY));
    if (saved) {
      if (Number.isFinite(saved.x)) _panel.style.left = saved.x + 'px';
      if (Number.isFinite(saved.y)) _panel.style.top = saved.y + 'px';
      if (saved.w > 0) _panel.style.width = saved.w + 'px';
      if (saved.h > 0) _panel.style.height = saved.h + 'px';
    }
  } catch { /* Use the default layout if old geometry cannot be read. */ }
  if (!_panel.style.left) _panel.style.left = (window.innerWidth - _panel.offsetWidth) / 2 + 'px';
  if (!_panel.style.top) _panel.style.top = (window.innerHeight - _panel.offsetHeight) / 2 + 'px';
  clampPanel();
  loadData(); wirePanel(); renderBody();
  window.addEventListener('resize', clampPanel, { signal: _abort.signal });
  window.addEventListener('online', renderBody, { signal: _abort.signal });
  window.addEventListener('offline', renderBody, { signal: _abort.signal });
  const panel = _panel;
  requestAnimationFrame(() => {
    if (_panel !== panel) return;
    panel.classList.add('open');
    $('cr-search')?.focus();
  });
}
function closePanel() {
  if (!_panel) return;
  const rect = _panel.getBoundingClientRect();
  try { storage.setItem(PANEL_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) })); } catch {}
  _abort?.abort(); clearTimeout(_launchTimer);
  _panel.remove(); _panel = null; _editTarget = null; _launchedId = null;
  if (_panelOpener?.isConnected) _panelOpener.focus();
}
function loadData() {
  _dataError = false;
  try {
    const raw = storage.getItem(DATA_KEY);
    const parsed = raw ? JSON.parse(raw) : { categories: [], commands: [] };
    if (!Array.isArray(parsed.categories) || !Array.isArray(parsed.commands)
      || !parsed.categories.every(c => c && typeof c.id === 'string' && typeof c.name === 'string')
      || !parsed.commands.every(c => c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.command === 'string')) throw new Error('Invalid library');
    _data = { categories: parsed.categories, commands: parsed.commands };
  } catch {
    _data = { categories: [], commands: [] };
    _dataError = true; // Never overwrite an unreadable library with an empty one.
  }
}
function saveData() { storage.setItem(DATA_KEY, JSON.stringify(_data)); }

function buildPanelHTML() {
  return `
    ${['t', 'r', 'b', 'l', 'tl', 'tr', 'bl', 'br'].map(edge => `<div aria-hidden="true" class="resize-handle resize-handle-${edge}" data-resize="${edge}"></div>`).join('')}
    <header class="cr-header drag-handle" data-drag="command-runner-panel">
      <div class="cr-header-left"><h3 id="cr-title">Command Runner</h3><span class="cr-count" id="cr-total-count">0</span></div>
      <button type="button" class="cr-close" id="cr-close-btn" aria-label="Close Command Runner" title="Close (Escape)">${SVG.close}</button>
    </header>
    <div class="cr-main" id="cr-main">
      <div class="cr-library-head"><div><h2>Saved commands</h2><p>Organize commands and run them in a new terminal.</p></div><button type="button" class="cr-button cr-primary" id="cr-add-cmd-btn">${SVG.plus}<span>New command</span></button></div>
      <div class="cr-toolbar"><div class="cr-search-wrap">${SVG.search}<label class="cr-sr" for="cr-search">Search commands, groups or directories</label><input id="cr-search" type="search" placeholder="Search commands, groups or directories…" autocomplete="off" spellcheck="false"><button type="button" class="cr-icon-btn" id="cr-clear-search" aria-label="Clear search" hidden>${SVG.close}</button><kbd aria-hidden="true">/</kbd></div><label class="cr-sr" for="cr-sort">Command order</label><select id="cr-sort" class="cr-sort"><option value="saved">Saved order</option><option value="recent">Recently run</option></select></div>
      <div class="cr-filter-bar"><nav id="cr-filters" class="cr-filters" aria-label="Filter by group"></nav><button type="button" class="cr-button cr-new-group" id="cr-add-cat-btn" title="Create a group">${SVG.plus}<span>Group</span></button></div>
      <div class="cr-notice" id="cr-notice" role="status" hidden></div>
      <div class="cr-body" id="cr-body" role="region" aria-label="Saved commands"></div>
      <footer class="cr-footer"><span id="cr-results" role="status" aria-live="polite" aria-atomic="true"></span><span class="cr-footer-hint">${SVG.terminal}Runs in a new terminal</span></footer>
    </div>
    <div class="cr-modal-overlay hidden" id="cr-modal-overlay"><div class="cr-modal" id="cr-modal" role="dialog" aria-modal="true" aria-labelledby="cr-modal-title" tabindex="-1"></div></div>`;
}
function emptyState(title, description, svg, action = '') {
  return `<div class="cr-empty"><div class="cr-empty-icon">${svg}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
}
function renderCommand(cmd) {
  const launched = cmd.id === _launchedId;
  return `<article class="cr-cmd${launched ? ' cr-cmd--launched' : ''}" data-cmd-id="${esc(cmd.id)}">
    <div class="cr-cmd-content"><h4 class="cr-cmd-name" dir="auto">${esc(cmd.name)}</h4>
      <div class="cr-code"><span class="cr-prompt" aria-hidden="true">$</span><code class="cr-cmd-text" dir="ltr">${esc(cmd.command)}</code></div>
      <span class="cr-cmd-cwd" title="${esc(cmd.cwd || 'Default terminal directory')}">${SVG.folder}<span dir="ltr">${esc(cmd.cwd || 'Default terminal directory')}</span></span>
    </div>
    <div class="cr-cmd-actions"><button type="button" class="cr-icon-btn" data-action="edit-cmd" aria-label="Edit command ${esc(cmd.name)}" title="Edit command">${SVG.edit}</button><button type="button" class="cr-icon-btn cr-icon-btn--danger" data-action="delete-cmd" aria-label="Delete command ${esc(cmd.name)}" title="Delete command">${SVG.trash}</button><button type="button" class="cr-run-btn${launched ? ' sent' : ''}" data-action="run" aria-label="Run ${esc(cmd.name)} in a new terminal"${!canRun() ? ' disabled title="Reconnect to run this command"' : ''}>${launched ? SVG.check : SVG.play}<span>${launched ? 'Sent' : 'Run'}</span></button></div>
  </article>`;
}
function renderBody() {
  const body = $('cr-body');
  if (!body) return;
  const focus = document.activeElement;
  const focusedCommand = focus?.closest('.cr-cmd')?.dataset.cmdId;
  const focusedGroup = focus?.closest('.cr-category')?.dataset.catId;
  const focusedAction = focus?.dataset.action;
  const focusedFilter = focus?.dataset.filter;
  if (_view.categoryId && !_data.categories.some(c => c.id === _view.categoryId)) _view.categoryId = '';
  const sorted = [..._data.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $('cr-total-count').textContent = String(_data.commands.length);
  $('cr-clear-search').hidden = !_view.query;
  $('cr-add-cat-btn').disabled = _dataError; $('cr-add-cmd-btn').disabled = _dataError;
  $('cr-filters').innerHTML = [{ id: '', name: 'All commands', count: _data.commands.length }, ...sorted.map(c => ({ ...c, count: _data.commands.filter(cmd => cmd.categoryId === c.id).length }))].map(c => `
    <button type="button" class="cr-filter${_view.categoryId === c.id ? ' active' : ''}" data-filter="${esc(c.id)}" aria-pressed="${_view.categoryId === c.id}" title="${esc(c.name)}">${c.id ? `<span class="cr-cat-dot" style="background:${esc(color(c.color))}" aria-hidden="true"></span>` : ''}<span>${esc(c.name)}</span><span class="cr-filter-count">${c.count}</span></button>`).join('');
  const notice = $('cr-notice');
  notice.hidden = !_dataError && navigator.onLine !== false;
  notice.innerHTML = _dataError ? `Your command library could not be loaded. <button type="button" class="cr-button" data-action="retry">Try again</button>` : canRun() ? 'You’re offline. Local terminal commands are still available.' : 'You’re offline. Your saved commands are available; reconnect to run them.';
  const groups = selectCommandGroups(_data, _view);
  const count = groups.reduce((n, group) => n + group.commands.length, 0);
  $('cr-results').textContent = _dataError ? 'Library unavailable' : `${count} of ${_data.commands.length} command${_data.commands.length === 1 ? '' : 's'}`;
  if (_dataError) body.innerHTML = emptyState('Your library is safe', 'Try loading it again before making changes.', SVG.folder);
  else if (!_data.categories.length) body.innerHTML = emptyState('No saved commands', 'Create a group, then save the commands you use regularly.', SVG.terminal, `<button type="button" class="cr-button cr-primary" data-action="first-group">${SVG.plus}Create a group</button>`);
  else if (!groups.length || (!count && _view.query.trim())) body.innerHTML = emptyState('No commands found', `Try a different search${_view.categoryId ? ' or another group' : ''}.`, SVG.search, '<button type="button" class="cr-button" data-action="reset-filters">Clear filters</button>');
  else body.innerHTML = groups.map(({ category: cat, commands }) => {
    const collapsed = _view.query.trim() ? _searchCollapsed.has(cat.id) : cat.collapsed;
    const listId = 'cr-list-' + cat.id;
    return `<section class="cr-category${collapsed ? ' collapsed' : ''}" data-cat-id="${esc(cat.id)}">
      <div class="cr-cat-header"><button type="button" class="cr-cat-toggle" data-action="collapse" aria-expanded="${!collapsed}" aria-controls="${esc(listId)}" title="${esc(cat.name)}"><span class="cr-cat-chevron">${SVG.chevron}</span><span class="cr-cat-dot" style="background:${esc(color(cat.color))}" aria-hidden="true"></span><span class="cr-cat-name">${esc(cat.name)}</span><span class="cr-cat-count">${commands.length}</span></button>
      <span class="cr-cat-actions"><button type="button" class="cr-icon-btn" data-action="add-in-group" aria-label="Add command to ${esc(cat.name)}" title="Add command">${SVG.plus}</button><button type="button" class="cr-icon-btn" data-action="edit-cat" aria-label="Edit group ${esc(cat.name)}" title="Edit group">${SVG.edit}</button><button type="button" class="cr-icon-btn cr-icon-btn--danger" data-action="delete-cat" aria-label="Delete group ${esc(cat.name)}" title="Delete group">${SVG.trash}</button></span></div>
      <div class="cr-cat-body" id="${esc(listId)}"${collapsed ? ' hidden' : ''}>${commands.length ? commands.map(renderCommand).join('') : `<div class="cr-cat-empty"><span>No commands in this group yet.</span><button type="button" class="cr-button" data-action="add-in-group">${SVG.plus}Add a command</button></div>`}</div></section>`;
  }).join('');
  if (focusedFilter != null) [...$('cr-filters').querySelectorAll('button')].find(b => b.dataset.filter === focusedFilter)?.focus();
  else if (focusedCommand) [...body.querySelectorAll('.cr-cmd')].find(e => e.dataset.cmdId === focusedCommand)?.querySelector(`[data-action="${focusedAction}"]`)?.focus();
  else if (focusedGroup) [...body.querySelectorAll('.cr-category')].find(e => e.dataset.catId === focusedGroup)?.querySelector(`[data-action="${focusedAction}"]`)?.focus();
}

function openModal(type, id = null, categoryId = '', opener = document.activeElement) {
  if (_dataError) return;
  _modalOpener = opener;
  _editTarget = { type, id, categoryId };
  const modal = $('cr-modal');
  if (type === 'category') modal.innerHTML = buildCategoryForm(id ? _data.categories.find(c => c.id === id) : null);
  else if (type === 'command') modal.innerHTML = buildCommandForm(id ? _data.commands.find(c => c.id === id) : null, categoryId);
  else modal.innerHTML = buildDeleteDialog(type, id);
  $('cr-modal-overlay').classList.remove('hidden');
  $('cr-main').inert = true; _panel.querySelector('.cr-header').inert = true;
  modal.querySelector('input:not([type="hidden"]), #cr-modal-cancel')?.focus();
}
function closeModal() {
  $('cr-modal-overlay')?.classList.add('hidden');
  $('cr-main').inert = false; _panel.querySelector('.cr-header').inert = false; _editTarget = null;
  if (_modalOpener?.isConnected) _modalOpener.focus(); else $('cr-search')?.focus();
}
function modalHeader(title, description = '') {
  return `<div class="cr-modal-header"><div><h4 id="cr-modal-title">${esc(title)}</h4>${description ? `<p>${esc(description)}</p>` : ''}</div><button type="button" class="cr-icon-btn" id="cr-modal-close" aria-label="Close dialog">${SVG.close}</button></div>`;
}
function modalFooter(label) {
  return `<p class="cr-form-error" id="cr-form-error" role="alert" hidden></p><div class="cr-modal-footer"><button type="button" class="cr-button" id="cr-modal-cancel">Cancel</button><button type="submit" class="cr-button cr-primary" id="cr-modal-save">${label}</button></div>`;
}
function buildCategoryForm(existing) {
  const activeColor = existing?.color || COLOR_PALETTE[0];
  const swatches = COLOR_PALETTE.slice(0, 16).map(c => `<button type="button" class="cr-color-swatch${c === activeColor ? ' selected' : ''}" data-color="${c}" aria-label="Group color ${c}" aria-pressed="${c === activeColor}" style="--swatch:${c}">${SVG.check}</button>`).join('');
  return `<form id="cr-form" novalidate>${modalHeader(existing ? 'Edit group' : 'Create a group', 'Keep related commands together.')}<div class="cr-modal-body"><div class="cr-form-fields"><div class="cr-form-row"><label class="cr-form-label" for="cr-cat-name">Group name</label><input class="cr-form-input" id="cr-cat-name" required type="text" value="${esc(existing?.name)}" placeholder="Development, checks, deployment…" autocomplete="off"></div></div><fieldset class="cr-color-field"><legend class="cr-form-label">Group color</legend><div class="cr-color-picker" id="cr-cat-color">${swatches}</div></fieldset><input type="hidden" id="cr-cat-color-val" value="${esc(activeColor)}"></div>${modalFooter(existing ? 'Save changes' : 'Create group')}</form>`;
}
function buildCommandForm(existing, categoryId) {
  const catId = existing?.categoryId || categoryId || _view.categoryId;
  const options = [..._data.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(c => `<option value="${esc(c.id)}"${c.id === catId ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  return `<form id="cr-form" novalidate>${modalHeader(existing ? 'Edit command' : 'Save a command', 'Choose a group and enter the command to save.')}<div class="cr-modal-body"><div class="cr-form-fields">
    <div class="cr-form-row"><label class="cr-form-label" for="cr-cmd-name">Command name</label><input class="cr-form-input" id="cr-cmd-name" required type="text" value="${esc(existing?.name)}" placeholder="Start dev server" autocomplete="off"></div>
    <div class="cr-form-row"><label class="cr-form-label" for="cr-cmd-cat">Group</label><select class="cr-form-input" id="cr-cmd-cat">${options}</select></div>
    <div class="cr-form-row cr-form-row--command"><label class="cr-form-label" for="cr-cmd-command">Command</label><textarea class="cr-form-input cr-form-mono" id="cr-cmd-command" required rows="3" placeholder="npm run dev" spellcheck="false" autocomplete="off">${esc(existing?.command)}</textarea></div>
    <div class="cr-form-row"><label class="cr-form-label" for="cr-cmd-cwd">Working directory <span class="cr-form-hint">Optional</span></label><div><input class="cr-form-input cr-form-mono" id="cr-cmd-cwd" type="text" value="${esc(existing?.cwd)}" placeholder="/path/to/your/project" autocomplete="off" aria-describedby="cr-cwd-help"><p id="cr-cwd-help" class="cr-form-help">Leave blank to use the default terminal directory.</p></div></div>
    </div></div>${modalFooter(existing ? 'Save changes' : 'Save command')}</form>`;
}
function buildDeleteDialog(type, id) {
  const group = type === 'delete-category';
  const entry = (group ? _data.categories : _data.commands).find(e => e.id === id);
  const count = _data.commands.filter(c => c.categoryId === id).length;
  const description = group ? `This removes the group${count ? ` and its ${count} saved command${count === 1 ? '' : 's'}` : ''}.` : 'This removes the saved command from your library.';
  return `${modalHeader(group ? 'Delete this group?' : 'Delete this command?')}<div class="cr-modal-body"><p class="cr-delete-name" dir="auto">${esc(entry?.name)}</p><p class="cr-form-help">${description} Existing terminals stay open.</p></div><div class="cr-modal-footer"><button type="button" class="cr-button" id="cr-modal-cancel">Cancel</button><button type="button" class="cr-button cr-danger" data-action="confirm-delete">Delete ${group ? 'group' : 'command'}</button></div>`;
}
function invalid(field, message) {
  field?.setAttribute('aria-invalid', 'true'); field?.setAttribute('aria-describedby', 'cr-form-error');
  $('cr-form-error').textContent = message; $('cr-form-error').hidden = false; field?.focus();
}
function saveFromModal() {
  if (!_editTarget || _dataError) return;
  const nameEl = $(_editTarget.type === 'category' ? 'cr-cat-name' : 'cr-cmd-name'), name = nameEl?.value.trim();
  if (!name) return invalid(nameEl, 'Give this ' + (_editTarget.type === 'category' ? 'group' : 'command') + ' a name.');
  if (_editTarget.type === 'category') {
    const selectedColor = $('cr-cat-color-val').value || COLOR_PALETTE[0];
    if (_editTarget.id) { const cat = _data.categories.find(c => c.id === _editTarget.id); if (cat) Object.assign(cat, { name, color: selectedColor }); }
    else _data.categories.push({ id: genId('cat'), name, color: selectedColor, collapsed: false, order: _data.categories.length });
  } else {
    const categoryId = $('cr-cmd-cat').value, command = $('cr-cmd-command').value.trim(), cwd = $('cr-cmd-cwd').value.trim() || null;
    if (!categoryId) return invalid($('cr-cmd-cat'), 'Choose a group for this command.');
    if (!command) return invalid($('cr-cmd-command'), 'Enter the command you want to save.');
    if (_editTarget.id) { const cmd = _data.commands.find(c => c.id === _editTarget.id); if (cmd) Object.assign(cmd, { categoryId, name, command, cwd }); }
    else _data.commands.push({ id: genId('cmd'), categoryId, name, command, cwd, order: _data.commands.filter(c => c.categoryId === categoryId).length });
    _view.categoryId = categoryId;
    const category = _data.categories.find(c => c.id === categoryId);
    if (category) category.collapsed = false;
  }
  _view.query = ''; $('cr-search').value = ''; // Reveal the saved entry after editing.
  saveData(); closeModal(); renderBody(); setStatus('Saved to your command library.');
}
function confirmDelete() {
  const { type, id } = _editTarget;
  _data.commands = _data.commands.filter(c => type === 'delete-category' ? c.categoryId !== id : c.id !== id);
  if (type === 'delete-category') _data.categories = _data.categories.filter(c => c.id !== id);
  saveData(); closeModal(); renderBody(); $('cr-search')?.focus();
  setStatus(type === 'delete-category' ? 'Group deleted.' : 'Command deleted.');
}
function setStatus(text) { $('cr-results').textContent = text; }
function runCommand(id) {
  const cmd = _data.commands.find(c => c.id === id);
  if (!cmd || !canRun()) return;
  emit('terminal:run-command', commandLaunchPayload(cmd));
  cmd.lastRunAt = Date.now(); saveData(); _launchedId = id;
  renderBody(); setStatus(`Sent “${cmd.name}” to a new terminal.`);
  clearTimeout(_launchTimer);
  _launchTimer = setTimeout(() => { if (!_panel) return; _launchedId = null; renderBody(); }, 2500);
}
function resetFilters() { _view.query = ''; _view.categoryId = ''; $('cr-search').value = ''; renderBody(); $('cr-search').focus(); }

function wirePanel() {
  _panel.addEventListener('input', event => {
    if (event.target.id === 'cr-search') { _view.query = event.target.value; _searchCollapsed.clear(); renderBody(); }
    else if (event.target.closest('#cr-form')) { event.target.removeAttribute('aria-invalid'); if ($('cr-form-error')) $('cr-form-error').hidden = true; }
  });
  _panel.addEventListener('change', event => { if (event.target.id === 'cr-sort') { _view.sort = event.target.value; renderBody(); } });
  _panel.addEventListener('submit', event => { if (event.target.id !== 'cr-form') return; event.preventDefault(); saveFromModal(); });
  _panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.id === 'cr-close-btn') return closePanel();
    if (button.id === 'cr-clear-search') { _view.query = ''; $('cr-search').value = ''; renderBody(); $('cr-search').focus(); return; }
    if (button.id === 'cr-add-cat-btn' || button.dataset.action === 'first-group') return openModal('category', null, '', button);
    if (button.id === 'cr-add-cmd-btn') return openModal(_data.categories.length ? 'command' : 'category', null, '', button);
    if (button.id === 'cr-modal-close' || button.id === 'cr-modal-cancel') return closeModal();
    if (button.hasAttribute('data-filter')) { _view.categoryId = button.dataset.filter; renderBody(); return; }
    const action = button.dataset.action, catId = button.closest('.cr-category')?.dataset.catId, cmdId = button.closest('.cr-cmd')?.dataset.cmdId;
    if (action === 'run') return runCommand(cmdId);
    if (action === 'add-in-group') return openModal('command', null, catId, button);
    if (action === 'edit-cat') return openModal('category', catId, '', button);
    if (action === 'delete-cat') return openModal('delete-category', catId, '', button);
    if (action === 'edit-cmd') return openModal('command', cmdId, '', button);
    if (action === 'delete-cmd') return openModal('delete-command', cmdId, '', button);
    if (action === 'confirm-delete') return confirmDelete();
    if (action === 'collapse') {
      const cat = _data.categories.find(c => c.id === catId);
      if (cat) {
        if (_view.query.trim()) {
          if (_searchCollapsed.has(catId)) _searchCollapsed.delete(catId); else _searchCollapsed.add(catId);
        } else { cat.collapsed = !cat.collapsed; saveData(); }
        renderBody();
      }
    }
    if (action === 'reset-filters') return resetFilters();
    if (action === 'retry') { loadData(); renderBody(); return; }
    if (button.dataset.color) {
      $('cr-cat-color').querySelectorAll('button').forEach(swatch => { const selected = swatch === button; swatch.classList.toggle('selected', selected); swatch.setAttribute('aria-pressed', String(selected)); });
      $('cr-cat-color-val').value = button.dataset.color;
    }
  });
  $('cr-modal-overlay').addEventListener('click', event => { if (event.target.id === 'cr-modal-overlay') closeModal(); });
  _panel.addEventListener('keydown', event => {
    const editing = event.target.closest('input, textarea, select, [contenteditable]');
    if (_editTarget && event.key === 'Tab') {
      const focusable = [...$('cr-modal').querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)')];
      // Explicit traversal includes buttons even when Safari skips them by default.
      const index = focusable.indexOf(document.activeElement);
      const next = index < 0 ? (event.shiftKey ? focusable.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
      event.preventDefault(); focusable[next]?.focus();
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (_editTarget) closeModal();
      else if (_view.query) { _view.query = ''; $('cr-search').value = ''; renderBody(); $('cr-search').focus(); }
      else closePanel();
    }
    if (!_editTarget && ((!editing && event.key === '/') || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f'))) { event.preventDefault(); event.stopPropagation(); $('cr-search').focus(); }
    if (_editTarget && (event.ctrlKey || event.metaKey) && event.key === 'Enter' && $('cr-form')) { event.preventDefault(); saveFromModal(); }
  });
}

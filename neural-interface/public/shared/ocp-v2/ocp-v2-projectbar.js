import { t } from '../i18n.js';
import { migrateStoredTools } from '../tool-list-storage.js';
import { wireDropdowns, closeDropdowns, setDropdownDisabled, dropdownOf } from '../cc-dropdown.js';
import { configureToolPickerTranslation, toolPickerHTML, readToolPicker, updateToolPicker, toolWord } from '../tool-list-picker.js';
import { fetchToolCatalog } from '../agent-runtime-options.js';
// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Project bar (project + branch dropdowns)
// Lives at the top of the .ocpv2-compose card, mirroring legacy ocp-projectbar.
// Owns: project picker, branch picker, cwd-change reactivity. Does NOT own state
// — delegates to panel.js via the `ctx` object so this module stays decoupled.
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';
import { sendTextMessage } from './ocp-v2-send.js';
import { api, onEvent, capabilities, supports } from './ocp-v2-ws.js';
import { captureBinding, latestOnly } from './ocp-v2-binding.js';
import { setSessionTools } from './ocp-v2-session-actions.js';
import { storage } from '../storage.js';
import { on } from '../state.js';
import { escapeHtml } from '../utils.js';

let _currentStore = getDefaultStore();
const getState = () => _currentStore.getState();
const subscribe = (l) => _currentStore.subscribe(l);

let _root = null;
let _projectDd = null;
let _branchDd = null;
let _toolsDd = null;
let _recallDd = null;
let _ctx = null;
let _unsubscribe = null;
let _toolsSyncUnsub = null;
let _branchCache = new Map();   // path → { branches, current, ts }
let _docClickWired = false;
let _docClickHandler = null;

let _recallProfile = 'balanced';
let _recallLoaded = false;

let _toolCatalog = null;
let _toolsSyncVersion = 0;
let _toolsAbort = null;
let _capsUnsub = null;
const MCP_SESSION_TOOLS_KEY = 'synabun-opencode-session-tools';
function readSessionTools() {
  try { return JSON.parse(storage.getItem(MCP_SESSION_TOOLS_KEY) || '{}') || {}; } catch { return {}; }
}
function savedSessionTools(sessionId) { const value = readSessionTools()[sessionId]; return Array.isArray(value) ? value : null; }
function saveSessionTools(sessionId, tools) {
  if (!sessionId || !Array.isArray(tools)) return;
  storage.setItem(MCP_SESSION_TOOLS_KEY, JSON.stringify({ ...readSessionTools(), [sessionId]: tools }));
}
async function syncToolsForActiveSession() {
  const version = ++_toolsSyncVersion;
  const at = captureBinding(_currentStore);
  const state = getState();
  if (at.sessionId) await migrateStoredTools(storage, MCP_SESSION_TOOLS_KEY, 'synabun-opencode-session-mcp-profiles', { entry: at.sessionId });
  if (!at.isCurrent() || version !== _toolsSyncVersion) return;
  const tools = state.sessionInfo?.tools ?? savedSessionTools(at.sessionId) ?? (at.sessionId ? null : state.tools) ?? _toolCatalog?.defaultTools;
  if (tools) _currentStore.setTools(tools);
  paintTools();
  if (!at.sessionId || !supports('mcp:tools:get')) return;
  try {
    const result = await api.toolsGet(at.sessionId);
    if (!result?.data?.pinned || !Array.isArray(result.data.tools) || version !== _toolsSyncVersion || !at.isCurrent()) return;
    _currentStore.setTools(result.data.tools);
    saveSessionTools(at.sessionId, result.data.tools);
  } catch { /* reconnect keeps the local selection */ }
}

const RECALL_PROFILES_META = [
  { id: 'quick',    label: 'Quick',    hint: '3 results' },
  { id: 'balanced', label: 'Balanced', hint: '5 results' },
  { id: 'deep',     label: 'Deep',     hint: '10 results' },
  { id: 'custom',   label: 'Custom',   hint: 'custom' },
];
const RECALL_PROFILE_DEFAULTS = {
  quick:    { limit: 3,  minImportance: 5, minScore: 0.45, maxChars: 300, includeSessions: 'never',  recencyBoost: false },
  balanced: { limit: 5,  minImportance: 0, minScore: 0.30, maxChars: 0,   includeSessions: 'auto',   recencyBoost: false },
  deep:     { limit: 10, minImportance: 0, minScore: 0.20, maxChars: 0,   includeSessions: 'always', recencyBoost: false },
};

const ARROW_DOWN = '▾';

export function mountProjectBar(rootEl, ctx, store = getDefaultStore()) {
  _currentStore = store;
  unmountProjectBar();
  _root = rootEl;
  _ctx = ctx || {};

  const bar = document.createElement('div');
  bar.className = 'ocpv2-projectbar';

  _projectDd = makeDropdown('ocpv2-project-dd', 'project...', 'Project');
  bar.appendChild(_projectDd);

  _branchDd = makeDropdown('ocpv2-branch-dd', 'branch', 'Branch', 'ocpv2-dropdown-sm');
  bar.appendChild(_branchDd);

  _toolsDd = document.createElement('div');
  _toolsDd.className = 'ocpv2-tools-picker';
  _toolsDd.addEventListener('pointerdown', event => { if (event.target.closest('.cc-dropdown-trigger')) closeAllDropdowns(event.target.closest('.cc-dropdown')); });
  bar.appendChild(_toolsDd);

  _recallDd = makeDropdown('ocpv2-recall-dd', 'recall', 'Recall profile', 'ocpv2-dropdown-sm');
  bar.appendChild(_recallDd);

  // Right-aligned action buttons (changelog, revert, etc.) — mirrors
  // cp-bar-actions / cxp-projectbar-actions on Claude/Codex panels.
  const actions = document.createElement('div');
  actions.className = 'ocpv2-bar-actions';

  const changelogBtn = document.createElement('button');
  changelogBtn.type = 'button';
  changelogBtn.className = 'ocpv2-bar-action';
  changelogBtn.setAttribute('data-action', 'changelog');
  changelogBtn.setAttribute('data-tooltip', 'Generate changelog (/synabun changelog)');
  changelogBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h8.5v13H4a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 014 1.5z"/><path d="M5.5 5h5M5.5 7.5h3M5.5 10h4"/></svg>';
  changelogBtn.addEventListener('click', () => {
    const s = getState();
    if (s.running || !s.sessionId) return;
    sendTextMessage('/synabun changelog').catch((err) => {
      console.warn('[ocp-v2-projectbar] changelog send failed', err);
    });
  });
  actions.appendChild(changelogBtn);
  bar.appendChild(actions);

  // Insert as the first child of the compose card so it sits above the input area.
  if (_root.firstChild) _root.insertBefore(bar, _root.firstChild);
  else _root.appendChild(bar);

  wireProjectDd();
  wireBranchDd();
  _toolsAbort = new AbortController();
  wireDropdowns(_toolsDd, { signal: _toolsAbort.signal });
  _capsUnsub = capabilities.subscribe(() => paintTools());
  _toolsDd.addEventListener('change', async (event) => {
    const previous = getState().tools;
    const tools = readToolPicker(event.target, { inherit: false });
    const at = captureBinding(_currentStore);
    try {
      if (at.sessionId) await setSessionTools(_currentStore, api, tools, { save: saveSessionTools });
      else _currentStore.setTools(tools);
    } catch (error) {
      if (at.isCurrent()) { _currentStore.setTools(previous); _currentStore.pushError({ message: error.message || toolWord('saveFailed') }); }
    }
    if (at.isCurrent()) paintTools();
  }, { signal: _toolsAbort.signal });
  wireRecallDd();
  wireDocClick();

  _toolsSyncUnsub = on('mcp:tools-default-changed', (msg = {}) => {
    if (_toolCatalog && Array.isArray(msg.tools)) _toolCatalog.defaultTools = msg.tools;
  });

  _unsubscribe = subscribe((event) => {
    if (event?.type === 'config:cwd') {
      syncToCwd(getState().cwd || '');
    } else if (event?.type === 'session:set') {
      closeDropdowns(_toolsDd, { cancel: true });
      // Session switch may carry a new directory — sync best-effort.
      // panel.js owns the canonical setCwd; this is just a defensive refresh.
      const s = getState();
      const dir = s.sessionInfo?.directory;
      if (dir && dir !== getState().cwd) syncToCwd(dir);
      syncToolsForActiveSession();
    } else if (event?.type === 'config:tools') {
      closeDropdowns(_toolsDd, { cancel: true });
      const state = getState();
      if (state.sessionId) saveSessionTools(state.sessionId, state.tools);
      paintTools();
    } else { paintTools(); }

  });

  // Initial paint
  syncToCwd(getState().cwd || '');
  // Kick off projects load so the menu has options when user opens it
  Promise.resolve(_ctx.ensureProjectsLoaded?.()).catch(() => {});
  // Load saved recall profile so the DD shows the current selection on first open
  loadRecallProfile().catch(() => {});
  // Load active SynaBun tool list so its label is correct on first paint
  fetchToolCatalog(false, { cwd: getState().cwd || '' }).then(catalog => { if (!_toolsDd) return; _toolCatalog = catalog; return syncToolsForActiveSession(); }).catch(() => {});

  return {
    refresh: () => syncToCwd(getState().cwd || ''),
    destroy: unmountProjectBar,
  };
}

export function unmountProjectBar() {
  _toolsSyncVersion += 1;
  if (_unsubscribe) { try { _unsubscribe(); } catch {} }
  if (_toolsSyncUnsub) { try { _toolsSyncUnsub(); } catch {} }
  if (_docClickWired && _docClickHandler) {
    document.removeEventListener('mousedown', _docClickHandler);
    _docClickWired = false;
    _docClickHandler = null;
  }
  _root?.querySelector('.ocpv2-projectbar')?.remove();
  _root = null;
  _projectDd = null;
  _branchDd = null;
  _toolsDd = null;
  _recallDd = null;
  _ctx = null;
  _unsubscribe = null;
  _toolsSyncUnsub = null;
  _branchCache = new Map();
  _toolsAbort?.abort();
  _capsUnsub?.();
  _toolCatalog = null;
}

// ── Dropdown construction ──────────────────────────────────────────────────

function makeDropdown(id, placeholder, tooltip, extraClass = '') {
  const dd = document.createElement('div');
  dd.id = id;
  dd.className = 'ocpv2-dropdown' + (extraClass ? ' ' + extraClass : '');
  dd.dataset.placeholder = placeholder;
  if (tooltip) dd.setAttribute('data-tooltip', tooltip);
  dd.innerHTML =
    `<span class="ocpv2-dd-label">${placeholder}</span>`
    + `<span class="ocpv2-dd-arrow">${ARROW_DOWN}</span>`
    + `<div class="ocpv2-dd-menu"></div>`;
  return dd;
}

function ddSetLabel(dd, text, hasValue) {
  const lbl = dd?.querySelector('.ocpv2-dd-label');
  if (!lbl) return;
  lbl.textContent = text || dd.dataset.placeholder || '';
  if (hasValue) dd.classList.add('has-value');
  else dd.classList.remove('has-value');
}

// A menu that has to load something before it opens (the project list, the
// tool lists, the recall setting) opens only when it is still the one the
// user asked for last: not after another menu was opened or everything was
// closed while it loaded.
const _menuOpenings = latestOnly();

function ddOpen(dd) {
  if (!dd) return;
  closeAllDropdowns(dd);
  dd.classList.add('open');
  dd.querySelector('.ocpv2-dd-menu')?.classList.add('open');
}

function ddClose(dd) {
  if (dd?.classList.contains('cc-dropdown')) { closeDropdowns(dd.parentElement); return; }
  dd?.classList.remove('open');
  dd?.querySelector('.ocpv2-dd-menu')?.classList.remove('open');
}

function ddIsOpen(dd) { return !!dd?.classList.contains('open'); }

function closeAllDropdowns(except) {
  // Closing everything (an outside click) also calls off a menu that is still loading.
  if (!except) _menuOpenings.cancel();
  document.querySelectorAll('.ocpv2-dropdown.open').forEach((dd) => {
    if (dd === except) return;
    ddClose(dd);
  });
}

function ddPopulate(dd, items, selectedValue, onSelect) {
  const menu = dd?.querySelector('.ocpv2-dd-menu');
  if (!menu) return;
  menu.innerHTML = '';
  if (!items || !items.length) {
    const empty = document.createElement('div');
    empty.className = 'ocpv2-dd-option';
    empty.style.cssText = 'opacity:0.4;cursor:default';
    empty.textContent = '(empty)';
    menu.appendChild(empty);
    return;
  }
  for (const it of items) {
    const opt = document.createElement('div');
    opt.className = 'ocpv2-dd-option' + (it.value === selectedValue ? ' selected' : '');
    opt.textContent = it.label;
    if (it.title) opt.title = it.title;
    opt.addEventListener('click', () => {
      ddClose(dd);
      onSelect?.(it.value, it);
    });
    menu.appendChild(opt);
  }
}

// ── Project dropdown wiring ────────────────────────────────────────────────

function wireProjectDd() {
  _projectDd.addEventListener('click', async (event) => {
    if (event.target.closest('.ocpv2-dd-menu')) return;
    if (ddIsOpen(_projectDd)) { ddClose(_projectDd); return; }
    const wanted = _menuOpenings.begin();
    try { await _ctx.ensureProjectsLoaded?.(); } catch {}
    if (!wanted()) return;
    paintProjectMenu();
    ddOpen(_projectDd);
  });
}

function paintProjectMenu() {
  const projects = _ctx.getProjects?.() || [];
  const items = projects.map((p) => {
    const path = (p && (p.path || p)) || '';
    const label = typeof path === 'string' ? path.split('/').filter(Boolean).pop() : '';
    return { value: String(path), label: label || String(path), title: String(path) };
  }).filter((it) => it.value);

  ddPopulate(_projectDd, items, getState().cwd || '', (value) => {
    _ctx.setActiveProject?.(value);
  });
}

// ── Branch dropdown wiring ─────────────────────────────────────────────────

function wireBranchDd() {
  _branchDd.addEventListener('click', async (event) => {
    if (event.target.closest('.ocpv2-dd-menu')) return;
    const cwd = getState().cwd;
    if (!cwd) return;
    if (ddIsOpen(_branchDd)) { ddClose(_branchDd); return; }
    const wanted = _menuOpenings.begin();
    await loadBranchesFor(cwd, /* force */ false);
    // Another project was selected while its branches were read: this menu
    // would be the old project's. (Or the user opened another menu meanwhile.)
    if (!wanted() || getState().cwd !== cwd) return;
    paintBranchMenu();
    ddOpen(_branchDd);
  });
}

async function loadBranchesFor(path, force) {
  if (!path) return null;
  const cached = _branchCache.get(path);
  if (cached && !force) return cached;
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    const out = {
      branches: Array.isArray(data?.branches) ? data.branches : [],
      current: data?.current || '',
      ts: Date.now(),
    };
    _branchCache.set(path, out);
    return out;
  } catch (err) {
    console.warn('[ocp-v2-projectbar] loadBranches failed', err);
    return null;
  }
}

function paintBranchMenu() {
  const cwd = getState().cwd || '';
  const data = _branchCache.get(cwd);
  if (!data) {
    ddPopulate(_branchDd, [], '', () => {});
    return;
  }
  const items = (data.branches || []).map((name) => ({ value: name, label: name }));
  ddPopulate(_branchDd, items, data.current || '', async (value) => {
    if (!value || value === data.current) return;
    try {
      await fetch('/api/terminal/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: cwd, branch: value }),
      });
      _branchCache.delete(cwd);
      const fresh = await loadBranchesFor(cwd, true);
      // The label shows the branch of the project on screen: `cwd` is the one
      // the checkout was for, and the panel may be in another by now.
      if (fresh && (getState().cwd || '') === cwd) ddSetLabel(_branchDd, fresh.current || value, !!(fresh.current || value));
    } catch (err) {
      console.warn('[ocp-v2-projectbar] checkout failed', err);
    }
  });
}

// ── State sync ─────────────────────────────────────────────────────────────

// OpenCode saw the branch change (a checkout by the model, the user or
// another tool): drop what is cached and re-read the branch of the project on
// screen. The event does not say which project it is about, and one refetch
// is cheap.
let _branchRefreshTimer = null;
onEvent((eventType) => {
  if (eventType !== 'vcs.branch.updated' || !_branchDd) return;
  if (_branchRefreshTimer) clearTimeout(_branchRefreshTimer);
  _branchRefreshTimer = setTimeout(() => {
    _branchRefreshTimer = null;
    const cwd = getState().cwd;
    if (!cwd) return;
    _branchCache.delete(cwd);
    syncToCwd(cwd);
  }, 300);
});

function syncToCwd(cwd) {
  // Project label
  const labelText = cwd ? (cwd.split('/').filter(Boolean).pop() || cwd) : (_projectDd?.dataset.placeholder || 'project...');
  ddSetLabel(_projectDd, labelText, !!cwd);

  // Branch label — load lazily; show placeholder until data arrives
  if (!cwd) {
    ddSetLabel(_branchDd, _branchDd?.dataset.placeholder || 'branch', false);
    _branchCache.clear();
    return;
  }
  const cached = _branchCache.get(cwd);
  if (cached) {
    ddSetLabel(_branchDd, cached.current || (_branchDd?.dataset.placeholder || 'branch'), !!cached.current);
  } else {
    ddSetLabel(_branchDd, '…', false);
    loadBranchesFor(cwd, false).then(() => {
      // Keyed by directory: a late answer for the project the panel has left
      // does not relabel the one it is in.
      if ((getState().cwd || '') !== cwd) return;
      const fresh = _branchCache.get(cwd);
      if (fresh) ddSetLabel(_branchDd, fresh.current || (_branchDd?.dataset.placeholder || 'branch'), !!fresh.current);
      else ddSetLabel(_branchDd, _branchDd?.dataset.placeholder || 'branch', false);
    });
  }
}

// ── Tool lists: cc-dropdown multiple mode inside the OpenCode project bar ──
function paintTools() {
  if (!_toolsDd) return;
  _toolsDd.hidden = !supports('mcp:tools:set') || !_toolCatalog;
  if (_toolsDd.hidden) return;
  const state = getState();
  const catalogCwd = state.cwd || '';
  if (_toolCatalog._cwd !== catalogCwd) {
    _toolCatalog._cwd = catalogCwd;
    fetchToolCatalog(false, { cwd: catalogCwd }).then(catalog => { if (catalog && (getState().cwd || '') === catalogCwd) { catalog._cwd = catalogCwd; _toolCatalog = catalog; paintTools(); } }).catch(() => {});
  }
  let input = _toolsDd.querySelector('input');
  if (!input) {
    // One project bar per panel mount; ids need to remain unique across windows.
    const id = `ocpv2-tools-${globalThis.crypto.randomUUID()}`;
    _toolsDd.innerHTML = toolPickerHTML(id, state.tools ?? _toolCatalog.defaultTools, { catalog: _toolCatalog, classes: 'ocpv2-dropdown ocpv2-dropdown-sm' });
    _toolsDd.querySelector('.cc-dropdown-menu')?.classList.add('ocpv2-dd-menu');
    input = _toolsDd.querySelector('input');
  } else if (!dropdownOf(input)?.classList.contains('open')) {
    updateToolPicker(input, state.tools ?? _toolCatalog.defaultTools, { catalog: _toolCatalog });
  }
  setDropdownDisabled(input, !!state.running);
}

// ── Recall dropdown wiring ─────────────────────────────────────────────────

function wireRecallDd() {
  _recallDd.addEventListener('click', async (event) => {
    if (event.target.closest('.ocpv2-dd-menu')) return;
    if (ddIsOpen(_recallDd)) { ddClose(_recallDd); return; }
    const wanted = _menuOpenings.begin();
    if (!_recallLoaded) {
      try { await loadRecallProfile(); } catch {}
    }
    if (!wanted()) return;
    paintRecallMenu();
    ddOpen(_recallDd);
  });
}

async function loadRecallProfile() {
  try {
    const data = await fetch('/api/display-settings').then((r) => r.json());
    if (data?.profile) _recallProfile = data.profile;
  } catch (err) {
    console.warn('[ocp-v2-projectbar] loadRecallProfile failed', err);
  } finally {
    _recallLoaded = true;
  }
  applyRecallLabel();
}

function applyRecallLabel() {
  const matched = RECALL_PROFILES_META.find((p) => p.id === _recallProfile);
  ddSetLabel(_recallDd, matched ? matched.label : _recallProfile, !!_recallProfile);
}

function paintRecallMenu() {
  const menu = _recallDd?.querySelector('.ocpv2-dd-menu');
  if (!menu) return;
  menu.innerHTML = '';
  for (const p of RECALL_PROFILES_META) {
    const opt = document.createElement('div');
    opt.className = 'ocpv2-dd-option' + (p.id === _recallProfile ? ' selected' : '');
    opt.style.gap = '6px';
    opt.innerHTML = `<span>${escapeHtml(p.label)}</span><span class="ocpv2-dd-hint">${escapeHtml(p.hint)}</span>`;
    opt.addEventListener('click', async (event) => {
      event.stopPropagation();
      ddClose(_recallDd);
      if (p.id === _recallProfile) return;
      _recallProfile = p.id;
      applyRecallLabel();
      try { await saveRecallProfile(p.id); }
      catch (err) { console.error('[ocp-v2-projectbar] saveRecallProfile failed', err); }
    });
    menu.appendChild(opt);
  }
}

async function saveRecallProfile(profile) {
  const current = await fetch('/api/display-settings').then((r) => r.json()).catch(() => ({}));
  const defaults = RECALL_PROFILE_DEFAULTS[profile] || current?.recallDefaults || RECALL_PROFILE_DEFAULTS.balanced;
  const body = {
    ...current,
    profile,
    recallDefaults: profile !== 'custom' ? defaults : current?.recallDefaults,
  };
  await fetch('/api/display-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Outside-click closes any open dropdown ─────────────────────────────────

function wireDocClick() {
  if (_docClickWired) return;
  _docClickHandler = (event) => {
    if (event.target?.closest?.('.ocpv2-dropdown')) return;
    // A click elsewhere also calls off a menu that is still loading.
    _menuOpenings.cancel();
    const open = document.querySelector('.ocpv2-dropdown.open');
    if (!open) return;
    closeAllDropdowns(null);
  };
  document.addEventListener('mousedown', _docClickHandler);
  _docClickWired = true;
}

configureToolPickerTranslation(t);

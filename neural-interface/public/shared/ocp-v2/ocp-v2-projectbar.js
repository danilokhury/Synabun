// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Project bar (project + branch dropdowns)
// Lives at the top of the .ocpv2-compose card, mirroring legacy ocp-projectbar.
// Owns: project picker, branch picker, cwd-change reactivity. Does NOT own state
// — delegates to panel.js via the `ctx` object so this module stays decoupled.
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';
import { sendTextMessage } from './ocp-v2-send.js';
import { on } from '../state.js';

let _currentStore = getDefaultStore();
const getState = () => _currentStore.getState();
const subscribe = (l) => _currentStore.subscribe(l);

let _root = null;
let _projectDd = null;
let _branchDd = null;
let _profileDd = null;
let _recallDd = null;
let _ctx = null;
let _unsubscribe = null;
let _profileSyncUnsub = null;
let _branchCache = new Map();   // path → { branches, current, ts }
let _docClickWired = false;
let _docClickHandler = null;

let _recallProfile = 'balanced';
let _recallLoaded = false;

let _currentProfile = 'full';
let _mcpProfiles = [];          // [{ id, label, hint }]
let _profileLoaded = false;

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

  _profileDd = makeDropdown('ocpv2-profile-dd', 'profile', 'Tool profile', 'ocpv2-dropdown-sm');
  bar.appendChild(_profileDd);

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
  wireProfileDd();
  wireRecallDd();
  wireDocClick();

  // Cross-surface sync: server broadcasts mcp:profile-changed when any panel
  // (or external file watcher) flips the profile — keep our label in sync.
  _profileSyncUnsub = on('mcp:profile-changed', (msg = {}) => {
    applyMcpProfileState(msg.profile, msg.presets);
  });

  _unsubscribe = subscribe((event) => {
    if (event?.type === 'config:cwd') {
      syncToCwd(getState().cwd || '');
    } else if (event?.type === 'session:set') {
      // Session switch may carry a new directory — sync best-effort.
      // panel.js owns the canonical setCwd; this is just a defensive refresh.
      const s = getState();
      const dir = s.sessionInfo?.directory;
      if (dir && dir !== getState().cwd) syncToCwd(dir);
    }
  });

  // Initial paint
  syncToCwd(getState().cwd || '');
  // Kick off projects load so the menu has options when user opens it
  Promise.resolve(_ctx.ensureProjectsLoaded?.()).catch(() => {});
  // Load saved recall profile so the DD shows the current selection on first open
  loadRecallProfile().catch(() => {});
  // Load active MCP tool profile so its label is correct on first paint
  loadCurrentProfile().catch(() => {});

  return {
    refresh: () => syncToCwd(getState().cwd || ''),
    destroy: unmountProjectBar,
  };
}

export function unmountProjectBar() {
  if (_unsubscribe) { try { _unsubscribe(); } catch {} }
  if (_profileSyncUnsub) { try { _profileSyncUnsub(); } catch {} }
  if (_docClickWired && _docClickHandler) {
    document.removeEventListener('mousedown', _docClickHandler);
    _docClickWired = false;
    _docClickHandler = null;
  }
  _root?.querySelector('.ocpv2-projectbar')?.remove();
  _root = null;
  _projectDd = null;
  _branchDd = null;
  _profileDd = null;
  _recallDd = null;
  _ctx = null;
  _unsubscribe = null;
  _profileSyncUnsub = null;
  _branchCache = new Map();
  _profileLoaded = false;
  _currentProfile = 'full';
  _mcpProfiles = [];
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

function ddOpen(dd) {
  if (!dd) return;
  closeAllDropdowns(dd);
  dd.classList.add('open');
  dd.querySelector('.ocpv2-dd-menu')?.classList.add('open');
}

function ddClose(dd) {
  dd?.classList.remove('open');
  dd?.querySelector('.ocpv2-dd-menu')?.classList.remove('open');
}

function ddIsOpen(dd) { return !!dd?.classList.contains('open'); }

function closeAllDropdowns(except) {
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
    try { await _ctx.ensureProjectsLoaded?.(); } catch {}
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
    await loadBranchesFor(cwd, /* force */ false);
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
      if (fresh) ddSetLabel(_branchDd, fresh.current || value, !!(fresh.current || value));
    } catch (err) {
      console.warn('[ocp-v2-projectbar] checkout failed', err);
    }
  });
}

// ── State sync ─────────────────────────────────────────────────────────────

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
      const fresh = _branchCache.get(cwd);
      if (fresh) ddSetLabel(_branchDd, fresh.current || (_branchDd?.dataset.placeholder || 'branch'), !!fresh.current);
      else ddSetLabel(_branchDd, _branchDd?.dataset.placeholder || 'branch', false);
    });
  }
}

// ── MCP Profile dropdown wiring ────────────────────────────────────────────

function wireProfileDd() {
  _profileDd.addEventListener('click', async (event) => {
    if (event.target.closest('.ocpv2-dd-menu')) return;
    if (ddIsOpen(_profileDd)) { ddClose(_profileDd); return; }
    if (!_profileLoaded) {
      try { await loadCurrentProfile(); } catch {}
    }
    paintProfileMenu();
    ddOpen(_profileDd);
  });
}

function mcpProfileItemsFromPresets(presets) {
  if (!presets || typeof presets !== 'object') return null;
  return Object.entries(presets).map(([id, p]) => ({
    id,
    label: p?.label || id,
    hint: `${p?.tools ?? '?'} tools`,
  }));
}

function applyMcpProfileState(profile, presets) {
  if (profile) _currentProfile = profile;
  const items = mcpProfileItemsFromPresets(presets);
  if (items) _mcpProfiles = items;
  applyProfileLabel();
  if (ddIsOpen(_profileDd)) paintProfileMenu();
}

function applyProfileLabel() {
  const matched = _mcpProfiles.find((p) => p.id === _currentProfile);
  ddSetLabel(_profileDd, matched ? matched.label : _currentProfile, !!_currentProfile);
}

async function loadCurrentProfile() {
  try {
    const data = await fetch('/api/mcp/profile').then((r) => r.json());
    if (data?.ok) applyMcpProfileState(data.profile, data.presets);
  } catch (err) {
    console.warn('[ocp-v2-projectbar] loadCurrentProfile failed', err);
  } finally {
    _profileLoaded = true;
    applyProfileLabel();
  }
}

function paintProfileMenu() {
  const menu = _profileDd?.querySelector('.ocpv2-dd-menu');
  if (!menu) return;
  menu.innerHTML = '';
  if (!_mcpProfiles.length) {
    const empty = document.createElement('div');
    empty.className = 'ocpv2-dd-option';
    empty.style.cssText = 'opacity:0.4;cursor:default';
    empty.textContent = '(empty)';
    menu.appendChild(empty);
    return;
  }
  for (const p of _mcpProfiles) {
    const opt = document.createElement('div');
    opt.className = 'ocpv2-dd-option' + (p.id === _currentProfile ? ' selected' : '');
    opt.style.gap = '6px';
    opt.innerHTML = `<span>${p.label}</span><span class="ocpv2-dd-hint">${p.hint}</span>`;
    opt.addEventListener('click', async (event) => {
      event.stopPropagation();
      ddClose(_profileDd);
      if (p.id === _currentProfile) return;
      _currentProfile = p.id;
      applyProfileLabel();
      try { await updateMcpProfile(p.id); }
      catch (err) { console.error('[ocp-v2-projectbar] updateMcpProfile failed', err); }
    });
    menu.appendChild(opt);
  }
}

async function updateMcpProfile(profile) {
  // 1) SynaBun MCP server — writes active-profile.json + broadcasts mcp:profile-changed
  await fetch('/api/mcp/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  // 2) Mirror into OpenCode's config.json so SYNABUN_PROFILE survives server restart
  try {
    const status = await fetch('/api/setup/status').then((r) => r.json());
    const mcpPath = status?.paths?.mcpIndexPath;
    const envPath = status?.paths?.envPath;
    if (mcpPath) {
      const env = { SYNABUN_PROFILE: profile };
      if (envPath) env.DOTENV_PATH = envPath;
      const config = { type: 'stdio', command: 'node', args: [mcpPath], env };
      await fetch('/api/opencode/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'SynaBun', config }),
      });
    }
  } catch {}
}

// ── Recall dropdown wiring ─────────────────────────────────────────────────

function wireRecallDd() {
  _recallDd.addEventListener('click', async (event) => {
    if (event.target.closest('.ocpv2-dd-menu')) return;
    if (ddIsOpen(_recallDd)) { ddClose(_recallDd); return; }
    if (!_recallLoaded) {
      try { await loadRecallProfile(); } catch {}
    }
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
    opt.innerHTML = `<span>${p.label}</span><span class="ocpv2-dd-hint">${p.hint}</span>`;
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
    const open = document.querySelector('.ocpv2-dropdown.open');
    if (!open) return;
    if (event.target.closest('.ocpv2-dropdown')) return;
    closeAllDropdowns(null);
  };
  document.addEventListener('mousedown', _docClickHandler);
  _docClickWired = true;
}

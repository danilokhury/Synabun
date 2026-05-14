// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Model picker (footer-right dropdown)
// Ports the legacy ocp-v1 model selector: provider grouping, capability badges,
// search, favorites (★), hidden-model filter. Stores selection in state.model
// as { providerID, modelID } so api.send() can pass it through to OpenCode.
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';

let _currentStore = getDefaultStore();
const getState = () => _currentStore.getState();
const setModel = (m) => _currentStore.setModel(m);
const subscribe = (l) => _currentStore.subscribe(l);

const STOR_MODEL = 'opencode-v2-model';     // "providerID/modelID" string
const LEGACY_STOR_MODEL = 'synabun-ocp-model';
const FAV_KEY    = 'ocp-model-favorites';
const HIDDEN_KEY = 'ocp-hidden-models';
const CAP_FILTER_EXPANDED_KEY = 'ocp-cap-filter-expanded';

const ARROW_DOWN = '▾';

const CAP_BADGES = [
  { key: 'reasoning',    test: c => c?.reasoning,     label: 'Reason', abbr: 'R',  desc: 'Stronger at multi-step reasoning, planning, and hard problem solving.' },
  { key: 'toolcall',     test: c => c?.toolcall,      label: 'Tools',  abbr: 'T',  desc: 'Can call external tools and functions during a task.' },
  { key: 'input.image',  test: c => c?.input?.image,  label: 'Vision', abbr: 'V',  desc: 'Can understand images and screenshots you attach.' },
  { key: 'input.audio',  test: c => c?.input?.audio,  label: 'Audio',  abbr: 'A',  desc: 'Can understand audio input.' },
  { key: 'input.video',  test: c => c?.input?.video,  label: 'Video',  abbr: 'Vi', desc: 'Can understand video input.' },
  { key: 'input.pdf',    test: c => c?.input?.pdf,    label: 'PDF',    abbr: 'P',  desc: 'Can read PDF documents directly.' },
  { key: 'output.image', test: c => c?.output?.image, label: 'ImgGen', abbr: 'I',  desc: 'Can generate images.' },
  { key: 'output.audio', test: c => c?.output?.audio, label: 'TTS',    abbr: 'S',  desc: 'Can generate spoken audio.' },
  { key: 'attachment',   test: c => c?.attachment,    label: 'Files',  abbr: 'F',  desc: 'Can accept file attachments as input.' },
];
const ALL_CAP_HELP = {
  key: '',
  label: 'All',
  desc: 'Showing every visible model.',
};

let _root = null;
let _dd = null;
let _menu = null;
let _label = null;
let _searchInput = null;
let _unsubscribe = null;
let _outsideHandler = null;
let _providersChangedHandler = null;
let _hiddenModelsChangedHandler = null;

let _providers = [];               // [{ id, name, models: [...] }]
let _connected = new Set();
let _loaded = false;
let _loadInflight = null;
let _loadGeneration = 0;
let _activeCapKey = '';

export function mountModelPicker(rootEl, store = getDefaultStore()) {
  _currentStore = store;
  unmountModelPicker();
  _root = rootEl;

  _dd = document.createElement('div');
  _dd.id = 'ocpv2-model-dd';
  _dd.className = 'ocpv2-dropdown';
  _dd.dataset.placeholder = 'model...';
  _dd.setAttribute('data-tooltip', 'Model');
  _dd.innerHTML =
    `<span class="ocpv2-dd-label">model...</span>`
    + `<span class="ocpv2-dd-arrow">${ARROW_DOWN}</span>`
    + `<div class="ocpv2-dd-menu"></div>`;
  _root.appendChild(_dd);

  _menu = _dd.querySelector('.ocpv2-dd-menu');
  _label = _dd.querySelector('.ocpv2-dd-label');

  // Restore saved model selection on mount
  try {
    const saved = localStorage.getItem(STOR_MODEL) || localStorage.getItem(LEGACY_STOR_MODEL);
    const parsed = parseModelString(saved);
    if (parsed) setModel(parsed);
  } catch {}

  applyLabelFromState();

  _dd.addEventListener('click', async (event) => {
    if (event.target.closest('.ocpv2-dd-menu')) return;
    if (_dd.classList.contains('open')) { closeMenu(); return; }
    if (!_loaded) { try { await ensureLoaded(); } catch {} }
    paintMenu('');
    openMenu();
  });

  _outsideHandler = (event) => {
    if (!_dd?.classList.contains('open')) return;
    if (event.target.closest('#ocpv2-model-dd')) return;
    closeMenu();
  };
  document.addEventListener('mousedown', _outsideHandler);

  _providersChangedHandler = () => { refreshProviders(); };
  _hiddenModelsChangedHandler = () => {
    if (_dd?.classList.contains('open')) paintMenu(_searchInput?.value || '');
  };
  document.addEventListener('ocp-providers-changed', _providersChangedHandler);
  document.addEventListener('ocp-hidden-models-changed', _hiddenModelsChangedHandler);

  _unsubscribe = subscribe((event) => {
    if (event?.type === 'config:model') applyLabelFromState();
    if (event?.type === 'server:status' && getState().serverStatus === 'ready') refreshProviders();
  });

  return { destroy: unmountModelPicker, refresh: () => { _loaded = false; _loadInflight = null; } };
}

export function unmountModelPicker() {
  if (_unsubscribe) { try { _unsubscribe(); } catch {} }
  if (_outsideHandler) document.removeEventListener('mousedown', _outsideHandler);
  if (_providersChangedHandler) document.removeEventListener('ocp-providers-changed', _providersChangedHandler);
  if (_hiddenModelsChangedHandler) document.removeEventListener('ocp-hidden-models-changed', _hiddenModelsChangedHandler);
  _outsideHandler = null;
  _providersChangedHandler = null;
  _hiddenModelsChangedHandler = null;
  _unsubscribe = null;
  _dd?.remove();
  _dd = null;
  _menu = null;
  _label = null;
  _searchInput = null;
  _root = null;
}

// ── Loading providers ──────────────────────────────────────────────────────

async function ensureLoaded() {
  if (_loaded) return;
  if (_loadInflight) return _loadInflight;
  const generation = _loadGeneration;
  _loadInflight = (async () => {
    try {
      const res = await fetch('/api/opencode/providers/full').then((r) => r.json());
      if (generation !== _loadGeneration) return;
      if (res?.ok === false) throw new Error(res.error || 'provider metadata unavailable');
      const data = res?.data || {};
      _providers = data.all || data.providers || (Array.isArray(data) ? data : []);
      _connected = new Set(data.connected || []);
      // If the server didn't tell us which providers are "connected", assume all
      // returned providers are connected so the menu isn't empty.
      if (!_connected.size && _providers.length) {
        _connected = new Set(_providers.map((p) => p.id).filter(Boolean));
      }
      _loaded = true;
    } catch (err) {
      console.warn('[ocp-v2-modelpicker] providers fetch failed', err);
    } finally {
      if (generation === _loadGeneration) _loadInflight = null;
    }
  })();
  return _loadInflight;
}

function refreshProviders() {
  _loaded = false;
  _loadInflight = null;
  _loadGeneration += 1;
  return ensureLoaded().finally(() => {
    if (_dd?.classList.contains('open')) paintMenu(_searchInput?.value || '');
  });
}

// ── Label sync ─────────────────────────────────────────────────────────────

function applyLabelFromState() {
  const m = parseModel(getState().model);
  if (!_label) return;
  if (!m) {
    _label.textContent = _dd?.dataset.placeholder || 'model...';
    _dd?.classList.remove('has-value');
    return;
  }
  const label = m.modelID || '';
  _label.textContent = label || _dd?.dataset.placeholder || 'model...';
  _dd?.classList.add('has-value');
}

// ── Menu open/close ────────────────────────────────────────────────────────

function openMenu() {
  closeOtherDropdowns();
  _dd?.classList.add('open');
  _menu?.classList.add('open');
  setTimeout(() => _searchInput?.focus(), 0);
}

function closeMenu() {
  _dd?.classList.remove('open');
  _menu?.classList.remove('open');
}

function closeOtherDropdowns() {
  document.querySelectorAll('.ocpv2-dropdown.open').forEach((dd) => {
    if (dd === _dd) return;
    dd.classList.remove('open');
    dd.querySelector('.ocpv2-dd-menu')?.classList.remove('open');
  });
}

// ── Menu rendering ─────────────────────────────────────────────────────────

function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); }
  catch { return new Set(); }
}
function saveFavorites(set) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...set])); } catch {}
}
function loadHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); }
  catch { return new Set(); }
}

function escAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function capTooltip(badge) {
  return `${badge.label}\n${badge.desc || ''}`;
}

function capBadgesHtml(modelObj) {
  if (!modelObj || typeof modelObj !== 'object') return '';
  const caps = modelObj.capabilities;
  if (!caps) return '';
  return CAP_BADGES
    .filter((b) => b.test(caps))
    .map((b) => `<span class="ocpv2-cap" data-cap-key="${escAttr(b.key)}" data-tooltip="${escAttr(capTooltip(b))}" data-tooltip-pos="above">${b.label}</span>`)
    .join('');
}

function paintMenu(searchTerm) {
  if (!_menu) return;
  _menu.innerHTML = '';

  // Sticky search box
  _searchInput = document.createElement('input');
  _searchInput.className = 'ocpv2-model-search';
  _searchInput.placeholder = 'Search models…';
  _searchInput.value = searchTerm || '';
  _searchInput.setAttribute('autocomplete', 'off');
  _searchInput.addEventListener('mousedown', (e) => e.stopPropagation());
  _searchInput.addEventListener('click', (e) => e.stopPropagation());
  _searchInput.addEventListener('input', applyFilters);

  if (!_loaded || !_providers.length) {
    const header = document.createElement('div');
    header.className = 'ocpv2-dd-header';
    header.appendChild(_searchInput);
    _menu.appendChild(header);
    const empty = document.createElement('div');
    empty.className = 'ocpv2-dd-option';
    empty.style.cssText = 'opacity:0.5;cursor:default;justify-content:center';
    empty.textContent = _loaded ? 'No connected providers' : 'Loading…';
    _menu.appendChild(empty);
    return;
  }

  const favorites = loadFavorites();
  const hidden = loadHidden();
  const currentFull = currentFullId();

  // Group connected providers
  const groups = {};
  for (const p of _providers) {
    const provId = p.id || 'unknown';
    if (!_connected.has(provId)) continue;
    const provName = p.name || provId;
    const modelArr = Array.isArray(p.models) ? p.models : Object.values(p.models || {});
    if (!groups[provId]) groups[provId] = { name: provName, models: [] };
    for (const m of modelArr) {
      const modelId = typeof m === 'string' ? m : (m.id || m.name || '');
      if (modelId && !hidden.has(`${provId}/${modelId}`)) {
        groups[provId].models.push({ id: modelId, _obj: typeof m === 'object' ? m : null });
      }
    }
    if (groups[provId].models.length === 0) delete groups[provId];
  }

  const sorted = Object.entries(groups).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const hasAnyModel = sorted.some(([, group]) => group.models.length > 0);
  if (!sorted.length) {
    const header = document.createElement('div');
    header.className = 'ocpv2-dd-header';
    header.appendChild(_searchInput);
    _menu.appendChild(header);
    const empty = document.createElement('div');
    empty.className = 'ocpv2-dd-option';
    empty.style.cssText = 'opacity:0.5;cursor:default;justify-content:center';
    empty.textContent = 'No models available';
    _menu.appendChild(empty);
    return;
  }

  const emptyState = document.createElement('div');
  emptyState.className = 'ocpv2-dd-empty';
  emptyState.style.display = 'none';
  const emptyText = document.createElement('span');
  emptyText.className = 'ocpv2-dd-empty-text';
  const emptyClear = document.createElement('button');
  emptyClear.className = 'ocpv2-dd-empty-clear';
  emptyClear.type = 'button';
  emptyClear.textContent = 'Clear filter';
  emptyClear.addEventListener('mousedown', (e) => e.stopPropagation());
  emptyClear.addEventListener('click', (e) => {
    e.stopPropagation();
    _activeCapKey = '';
    _searchInput.value = '';
    syncFilterPills();
    applyFilters();
    restoreCapHelp();
    _searchInput.focus();
  });
  emptyState.append(emptyText, emptyClear);

  const filterBar = document.createElement('div');
  filterBar.className = 'ocpv2-cap-filter-bar';
  const filterPills = new Map();

  const filterToggle = document.createElement('button');
  filterToggle.className = 'ocpv2-cap-filter-toggle';
  filterToggle.type = 'button';
  filterToggle.setAttribute('data-tooltip', 'Capability filters\nShow or hide model capability chips.');
  filterToggle.setAttribute('data-tooltip-pos', 'left');
  filterToggle.innerHTML = '<svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M0.5 2h8M2 4.5h5M3.5 7h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  filterToggle.addEventListener('mousedown', (e) => e.stopPropagation());
  filterToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = filterBar.classList.toggle('ocpv2-cap-filter-bar--hidden');
    filterToggle.classList.toggle('collapsed', collapsed);
    capHelp.classList.toggle('ocpv2-cap-help--collapsed', collapsed);
    if (!collapsed) restoreCapHelp();
    try { localStorage.setItem(CAP_FILTER_EXPANDED_KEY, collapsed ? '0' : '1'); } catch {}
  });

  function syncFilterPills() {
    for (const [key, pill] of filterPills) {
      const active = key === _activeCapKey || (!_activeCapKey && key === '');
      pill.classList.toggle('active', active);
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    filterToggle.classList.toggle('has-active', !!_activeCapKey);
  }

  function setActiveCap(key) {
    _activeCapKey = _activeCapKey === key ? '' : key;
    syncFilterPills();
    applyFilters();
    restoreCapHelp();
  }

  const capHelp = document.createElement('div');
  capHelp.className = 'ocpv2-cap-help';
  const capHelpTitle = document.createElement('span');
  capHelpTitle.className = 'ocpv2-cap-help-title';
  const capHelpText = document.createElement('span');
  capHelpText.className = 'ocpv2-cap-help-text';
  capHelp.append(capHelpTitle, capHelpText);
  let lastHelpKey = null;

  function applyCapHelp(badge) {
    const target = badge || ALL_CAP_HELP;
    if (lastHelpKey !== target.key) {
      capHelpTitle.textContent = target.label;
      capHelpText.textContent = target.desc;
      lastHelpKey = target.key;
      capHelp.classList.remove('ocpv2-cap-help--swap');
      void capHelp.offsetWidth;
      capHelp.classList.add('ocpv2-cap-help--swap');
    }
    capHelp.classList.toggle('ocpv2-cap-help--active', !!(badge && badge.key));
  }

  function restoreCapHelp() {
    applyCapHelp(_activeCapKey ? CAP_BADGES.find((b) => b.key === _activeCapKey) : null);
  }

  function bindCapHelp(pill, badge) {
    pill.addEventListener('mouseenter', () => applyCapHelp(badge));
    pill.addEventListener('focus', () => applyCapHelp(badge));
    pill.addEventListener('mouseleave', restoreCapHelp);
    pill.addEventListener('blur', restoreCapHelp);
  }

  const allPill = document.createElement('button');
  allPill.className = 'ocpv2-cap-filter ocpv2-cap-filter-all active';
  allPill.type = 'button';
  allPill.dataset.capKey = '';
  allPill.textContent = 'All';
  allPill.setAttribute('aria-pressed', 'true');
  allPill.addEventListener('mousedown', (e) => e.stopPropagation());
  allPill.addEventListener('click', (e) => {
    e.stopPropagation();
    _activeCapKey = '';
    syncFilterPills();
    applyFilters();
    restoreCapHelp();
  });
  bindCapHelp(allPill, ALL_CAP_HELP);
  filterPills.set('', allPill);
  filterBar.appendChild(allPill);

  for (const badge of CAP_BADGES) {
    const pill = document.createElement('button');
    pill.className = 'ocpv2-cap-filter';
    pill.type = 'button';
    pill.dataset.capKey = badge.key;
    pill.innerHTML = `<span class="ocpv2-cap-filter-letter">${escHtml(badge.abbr || badge.label.slice(0, 1))}</span><span class="ocpv2-cap-filter-label">${escHtml(badge.label)}</span>`;
    pill.setAttribute('aria-pressed', 'false');
    pill.addEventListener('mousedown', (e) => e.stopPropagation());
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveCap(badge.key);
    });
    bindCapHelp(pill, badge);
    filterPills.set(badge.key, pill);
    filterBar.appendChild(pill);
  }

  const header = document.createElement('div');
  header.className = 'ocpv2-dd-header';
  header.appendChild(_searchInput);
  header.appendChild(filterBar);
  header.appendChild(capHelp);
  header.appendChild(filterToggle);
  _menu.appendChild(header);

  try {
    if (localStorage.getItem(CAP_FILTER_EXPANDED_KEY) === '0') {
      filterBar.classList.add('ocpv2-cap-filter-bar--hidden');
      filterToggle.classList.add('collapsed');
      capHelp.classList.add('ocpv2-cap-help--collapsed');
    }
  } catch {}
  restoreCapHelp();

  // Favorites section
  if (favorites.size > 0) {
    const favLbl = document.createElement('div');
    favLbl.className = 'ocpv2-dd-group-label ocpv2-dd-fav-label';
    favLbl.textContent = `Favorites (${favorites.size})`;
    _menu.appendChild(favLbl);
    let favRendered = 0;
    for (const [provId, group] of sorted) {
      for (const entry of group.models) {
        const fullId = `${provId}/${entry.id}`;
        if (favorites.has(fullId)) {
          _menu.appendChild(makeOption(provId, entry, currentFull, favorites));
          favRendered++;
        }
      }
    }
    if (favRendered) {
      const sep = document.createElement('div');
      sep.className = 'ocpv2-dd-sep';
      _menu.appendChild(sep);
    }
  }

  // Provider-grouped sections
  for (const [provId, group] of sorted) {
    const lbl = document.createElement('div');
    lbl.className = 'ocpv2-dd-group-label';
    lbl.textContent = `${group.name} (${group.models.length})`;
    _menu.appendChild(lbl);
    for (const entry of group.models) {
      _menu.appendChild(makeOption(provId, entry, currentFull, favorites));
    }
  }

  _menu.appendChild(emptyState);
  syncFilterPills();
  applyFilters();

  function updateEmptyState(visibleOptionCount) {
    if (visibleOptionCount > 0) {
      emptyState.style.display = 'none';
      return;
    }
    const term = _searchInput.value.trim();
    const activeBadge = _activeCapKey ? CAP_BADGES.find((b) => b.key === _activeCapKey) : null;
    if (!hasAnyModel) {
      emptyText.textContent = 'No connected models available';
    } else if (activeBadge && term) {
      emptyText.textContent = `No ${activeBadge.label} models match "${term}"`;
    } else if (activeBadge) {
      emptyText.textContent = `No models with ${activeBadge.label}`;
    } else if (term) {
      emptyText.textContent = `No models match "${term}"`;
    } else {
      emptyText.textContent = 'No models available';
    }
    emptyClear.style.display = (_activeCapKey || term) ? '' : 'none';
    emptyState.style.display = 'flex';
  }

  function applyFilters() {
    const term = (_searchInput?.value || '').toLowerCase().trim();
    const activeBadge = _activeCapKey ? CAP_BADGES.find((b) => b.key === _activeCapKey) : null;
    let visibleOptionCount = 0;
    let prevLabel = null;
    let prevLabelVisible = false;
    let labelTextMatch = false;

    for (const el of Array.from(_menu.children)) {
      if (el === header || el === emptyState) continue;
      if (el.classList.contains('ocpv2-dd-group-label')) {
        if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
        prevLabel = el;
        labelTextMatch = !term || el.textContent.toLowerCase().includes(term);
        prevLabelVisible = false;
      } else if (el.classList.contains('ocpv2-dd-model-option')) {
        const nameMatch = !term
          || (el.dataset.modelName || '').includes(term)
          || (el.dataset.providerId || '').toLowerCase().includes(term)
          || labelTextMatch;
        let capMatch = true;
        if (activeBadge && el.dataset.caps) {
          try {
            const caps = JSON.parse(el.dataset.caps);
            capMatch = activeBadge.test(caps);
          } catch {
            capMatch = false;
          }
        } else if (activeBadge) {
          capMatch = false;
        }
        const match = nameMatch && capMatch;
        el.style.display = match ? '' : 'none';
        if (match) {
          prevLabelVisible = true;
          visibleOptionCount += 1;
        }
      } else if (el.classList.contains('ocpv2-dd-sep')) {
        el.style.display = prevLabelVisible ? '' : 'none';
        if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
        prevLabel = null;
        prevLabelVisible = false;
        labelTextMatch = false;
      }
    }
    if (prevLabel) prevLabel.style.display = prevLabelVisible ? '' : 'none';
    updateEmptyState(visibleOptionCount);
  }
}

function makeOption(provId, entry, currentFull, favorites) {
  const fullId = `${provId}/${entry.id}`;
  const badges = capBadgesHtml(entry._obj);
  const isFav = favorites.has(fullId);

  const opt = document.createElement('div');
  opt.className = 'ocpv2-dd-option ocpv2-dd-model-option' + (fullId === currentFull ? ' selected' : '');
  opt.dataset.modelName = entry.id.toLowerCase();
  opt.dataset.fullId = fullId;
  opt.dataset.providerId = provId;
  if (entry._obj?.capabilities) opt.dataset.caps = JSON.stringify(entry._obj.capabilities);
  opt.innerHTML =
    `<span class="ocpv2-dd-model-name">${escHtml(entry.id)}</span>`
    + (badges ? `<span class="ocpv2-dd-caps">${badges}</span>` : '');

  const star = document.createElement('button');
  star.className = 'ocpv2-dd-star' + (isFav ? ' active' : '');
  star.type = 'button';
  star.title = isFav ? 'Remove from favorites' : 'Add to favorites';
  star.textContent = '★';
  star.addEventListener('mousedown', (e) => e.stopPropagation());
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    const favs = loadFavorites();
    if (favs.has(fullId)) favs.delete(fullId); else favs.add(fullId);
    saveFavorites(favs);
    paintMenu(_searchInput?.value || '');
  });
  opt.appendChild(star);

  opt.addEventListener('click', () => {
    selectModel(provId, entry.id);
    closeMenu();
  });

  return opt;
}

function currentFullId() {
  return modelToFullId(getState().model);
}

function selectModel(providerID, modelID) {
  setModel({ providerID, modelID });
  try { localStorage.setItem(STOR_MODEL, `${providerID}/${modelID}`); } catch {}
  applyLabelFromState();
}

function parseModelString(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const idx = raw.indexOf('/');
  if (idx < 0) return { providerID: raw, modelID: raw };
  const providerID = raw.slice(0, idx);
  const modelID = raw.slice(idx + 1);
  return providerID && modelID ? { providerID, modelID } : null;
}

function parseModel(value) {
  if (!value) return null;
  if (typeof value === 'string') return parseModelString(value);
  if (value.providerID && value.modelID) return value;
  if (value.providerID && value.id) return { providerID: value.providerID, modelID: value.id };
  return null;
}

function modelToFullId(value) {
  const parsed = parseModel(value);
  return parsed ? `${parsed.providerID}/${parsed.modelID}` : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Variant picker (footer-right, beside model picker)
// Shows a "thinking effort" / reasoning-level dropdown for models that expose
// `variants` (e.g. low/medium/high/max/xhigh/minimal/none) in the SDK schema.
// Hidden when the active model has no variants. Persists per-model selection
// in localStorage so each model remembers its preferred effort.
//
// The selected variant name is stored on state.variant and forwarded as the
// `variant` field on session.prompt — the OpenCode SDK applies the matching
// per-provider config (reasoningEffort / thinking / thinkingConfig / etc).
// ─────────────────────────────────────────────────────────────────────────────

import { getDefaultStore } from './ocp-v2-state.js';

let _currentStore = getDefaultStore();
const getState = () => _currentStore.getState();
const setVariant = (v) => _currentStore.setVariant(v);
const subscribe = (l) => _currentStore.subscribe(l);

const STOR_VARIANTS = 'ocp-v2-model-variants';   // { "providerID/modelID": "variantName" }
const PREFERRED_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh'];
const ARROW_DOWN = '▾';

let _root = null;
let _dd = null;
let _menu = null;
let _label = null;
let _unsubscribe = null;
let _outsideHandler = null;
let _providersChangedHandler = null;

let _providers = [];          // cached providers list (same shape as modelpicker)
let _loaded = false;
let _loadInflight = null;
let _loadGeneration = 0;

export function mountVariantPicker(rootEl, store = getDefaultStore()) {
  _currentStore = store;
  unmountVariantPicker();
  _root = rootEl;

  _dd = document.createElement('div');
  _dd.id = 'ocpv2-variant-dd';
  _dd.className = 'ocpv2-dropdown ocpv2-variant-dropdown';
  _dd.dataset.placeholder = 'effort';
  _dd.setAttribute('data-tooltip', 'Reasoning effort');
  _dd.style.display = 'none';
  _dd.innerHTML =
    `<span class="ocpv2-variant-icon" aria-hidden="true">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="11" height="11">`
    + `<path d="M9 3a4 4 0 0 0-2 7.5V13a2 2 0 0 0 2 2h0v3a2 2 0 0 0 4 0v-3h0a2 2 0 0 0 2-2v-2.5A4 4 0 1 0 9 3z"/>`
    + `<path d="M9 9h6"/>`
    + `</svg>`
    + `</span>`
    + `<span class="ocpv2-dd-label">effort</span>`
    + `<span class="ocpv2-dd-arrow">${ARROW_DOWN}</span>`
    + `<div class="ocpv2-dd-menu"></div>`;
  _root.appendChild(_dd);

  _menu = _dd.querySelector('.ocpv2-dd-menu');
  _label = _dd.querySelector('.ocpv2-dd-label');

  _dd.addEventListener('click', async (event) => {
    if (event.target.closest('.ocpv2-dd-menu')) return;
    if (_dd.classList.contains('open')) { closeMenu(); return; }
    if (!_loaded) { try { await ensureLoaded(); } catch {} }
    paintMenu();
    openMenu();
  });

  _outsideHandler = (event) => {
    if (!_dd?.classList.contains('open')) return;
    if (event.target.closest('#ocpv2-variant-dd')) return;
    closeMenu();
  };
  document.addEventListener('mousedown', _outsideHandler);

  _providersChangedHandler = () => { refreshProviders(); };
  document.addEventListener('ocp-providers-changed', _providersChangedHandler);

  _unsubscribe = subscribe((event) => {
    if (event?.type === 'config:model') {
      // Restore the saved variant for the newly selected model
      if (_loaded) restoreVariantForCurrentModel();
      syncFromState();
    } else if (event?.type === 'config:variant') {
      syncFromState();
    } else if (event?.type === 'server:status' && getState().serverStatus === 'ready') {
      refreshProviders();
    }
  });

  // Initial load (model may already be set when we mount)
  ensureLoaded().finally(() => {
    if (_loaded) restoreVariantForCurrentModel();
    syncFromState();
  });

  return { destroy: unmountVariantPicker };
}

export function unmountVariantPicker() {
  if (_unsubscribe) { try { _unsubscribe(); } catch {} }
  if (_outsideHandler) document.removeEventListener('mousedown', _outsideHandler);
  if (_providersChangedHandler) document.removeEventListener('ocp-providers-changed', _providersChangedHandler);
  _outsideHandler = null;
  _providersChangedHandler = null;
  _unsubscribe = null;
  _dd?.remove();
  _dd = null;
  _menu = null;
  _label = null;
  _root = null;
}

// ── Providers cache (mirrors modelpicker, fetched independently) ───────────

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
      _loaded = true;
    } catch (err) {
      console.warn('[ocp-v2-variantpicker] providers fetch failed', err);
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
    if (_loaded) restoreVariantForCurrentModel();
    syncFromState();
  });
}

function findModelMeta(providerID, modelID) {
  if (!providerID || !modelID) return null;
  const p = _providers.find((p) => p.id === providerID);
  if (!p) return null;
  const models = p.models;
  if (!models) return null;
  if (Array.isArray(models)) {
    return models.find((m) => (m?.id || m?.name) === modelID) || null;
  }
  return models[modelID] || null;
}

function getCurrentVariants() {
  const m = parseModel(getState().model);
  if (!m) return { names: [], modelMeta: null };
  const meta = findModelMeta(m.providerID, m.modelID);
  const variants = meta?.variants;
  if (!variants || typeof variants !== 'object') return { names: [], modelMeta: meta };
  // Filter out disabled variants
  const names = Object.entries(variants)
    .filter(([, v]) => !(v && v.disabled === true))
    .map(([k]) => k);
  return { names, modelMeta: meta };
}

function sortVariantNames(names) {
  // Order by PREFERRED_ORDER first; unknown names appended alphabetically
  const known = PREFERRED_ORDER.filter((n) => names.includes(n));
  const unknown = names.filter((n) => !PREFERRED_ORDER.includes(n)).sort();
  return [...known, ...unknown];
}

// ── Persistence ────────────────────────────────────────────────────────────

function loadVariantMap() {
  try { return JSON.parse(localStorage.getItem(STOR_VARIANTS) || '{}') || {}; }
  catch { return {}; }
}
function saveVariantMap(map) {
  try { localStorage.setItem(STOR_VARIANTS, JSON.stringify(map || {})); } catch {}
}
function modelKey() {
  const m = parseModel(getState().model);
  return m ? `${m.providerID}/${m.modelID}` : '';
}

function restoreVariantForCurrentModel() {
  const { names } = getCurrentVariants();
  if (!names.length) {
    // No variants for this model — clear any leftover variant from state
    if (getState().variant != null) setVariant(null);
    return;
  }
  const key = modelKey();
  const map = loadVariantMap();
  const saved = map[key];
  if (saved && names.includes(saved)) {
    if (getState().variant !== saved) setVariant(saved);
  } else {
    // Default: pick highest effort if "high" exists, otherwise leave SDK default (null)
    if (getState().variant != null) setVariant(null);
  }
}

// ── UI sync ────────────────────────────────────────────────────────────────

function syncFromState() {
  if (!_dd || !_label) return;
  const { names } = getCurrentVariants();
  if (!names.length) {
    _dd.style.display = 'none';
    return;
  }
  _dd.style.display = '';
  const v = getState().variant;
  if (v && names.includes(v)) {
    _label.textContent = v;
    _dd.classList.add('has-value');
  } else {
    _label.textContent = _dd.dataset.placeholder || 'effort';
    _dd.classList.remove('has-value');
  }
}

// ── Menu ───────────────────────────────────────────────────────────────────

function openMenu() {
  closeOtherDropdowns();
  _dd?.classList.add('open');
  _menu?.classList.add('open');
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

function paintMenu() {
  if (!_menu) return;
  _menu.innerHTML = '';
  const { names } = getCurrentVariants();
  if (!names.length) return;
  const ordered = sortVariantNames(names);
  const current = getState().variant;

  // "Default" entry — clears the variant so the SDK uses its built-in default
  const defaultOpt = document.createElement('div');
  defaultOpt.className = 'ocpv2-dd-option' + (!current ? ' selected' : '');
  defaultOpt.innerHTML = '<span class="ocpv2-dd-variant-name">default</span><span class="ocpv2-dd-hint">SDK</span>';
  defaultOpt.addEventListener('click', () => {
    selectVariant(null);
    closeMenu();
  });
  _menu.appendChild(defaultOpt);

  for (const name of ordered) {
    const opt = document.createElement('div');
    opt.className = 'ocpv2-dd-option' + (current === name ? ' selected' : '');
    opt.innerHTML = `<span class="ocpv2-dd-variant-name">${escHtml(name)}</span>`;
    opt.addEventListener('click', () => {
      selectVariant(name);
      closeMenu();
    });
    _menu.appendChild(opt);
  }
}

function selectVariant(name) {
  setVariant(name);
  const key = modelKey();
  if (!key) return;
  const map = loadVariantMap();
  if (name) map[key] = name;
  else delete map[key];
  saveVariantMap(map);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseModel(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const idx = value.indexOf('/');
    if (idx < 0) return null;
    return { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) };
  }
  if (value.providerID && value.modelID) return value;
  if (value.providerID && value.id) return { providerID: value.providerID, modelID: value.id };
  return null;
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

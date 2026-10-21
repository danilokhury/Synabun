// ═══════════════════════════════════════════
// SynaBun Assistant — brain picker (toolbar fields)
// ═══════════════════════════════════════════
// Dropdown fields for the brain: model (provider icon + model; switching
// provider happens inside the model menu, grouped by provider), effort (or the
// OpenCode agent), permission mode and account (Claude/Codex, inline only when
// there is more than one to pick) in the composer row; project and MCP profile
// in the toolbar. Every field opens an asst-menu popover (it flips when there
// is no room). A provider/account/profile change reports
// { requiresSwitch: true } so the panel sends `switch_brain`.

import {
  ensureModelsForProfile,
  fetchClaudeAccounts,
  fetchCodexAccounts,
  fetchMcpProfilePresets,
  fetchOpencodeAgents,
  getCachedClaudeAccounts,
  getCachedCodexAccounts,
  getCachedMcpProfilePresets,
  getCachedOpencodeAgents,
  getClaudeWorkerAccountId,
  getCodexWorkerAccountId,
  getEffortLevelsForModel,
  getModelsForProfile,
  modelEffortIds,
  modelSelectorValue,
} from '../agent-runtime-options.js';
import { getHiddenModels, HIDDEN_MODELS_EVENT, hiddenModelMatch } from '../ocp-hidden-models.js';
import { getProviderMeta } from '../provider-icons.js';
import { on } from '../state.js';
import { registerLaunchPrefetch } from '../launch-prefetch.js';
import { fetchAssistantCatalog, fetchProjects, patchClaudeAccount, patchCodexAccount, setClaudeWorkerAccount, setCodexWorkerAccount } from './asst-api.js';
import { accountBadge, accountIdentity, accountName, accountText } from '../account-view.js';
import { autoAccountLabel } from '../account-usage.js';
import { accountChoiceItems, accountManageItem, accountMenuRow, accountModeItem, openAccountMenu } from './asst-account-menu.js';
import { closeMenu, currentMenu, isMenuOpen, openMenu } from './asst-menu.js';
import { createMascotControl } from './asst-mascot.js';
import { modelChipForms, modelChipName, modelChipTag } from './asst-model-chip.js';
import {
  ACCOUNT_PROVIDERS,
  brainRequiresSwitch,
  emptyProjectView,
  modelShortName,
  normalizeBrain,
  PERMISSION_MODES,
  PLAN_MODE_PROVIDERS,
  permissionModeLabel,
  PROVIDERS,
  projectLabel,
  resolveBrainDefaults,
  TEST_DENSITIES,
  normalizeTestDensity,
  testDensityBars,
} from './asst-state.js';

let _projectsCache = null;
// Providers whose field menus have everything they read loaded once (models, catalog, accounts or agents,
// presets, projects): their menus open from it at once and read it again in the background.
const _warmProviders = new Set();

/** SynaBun's registered projects as the last load saw them ([{ path, label }]; [] before the first). */
export function cachedProjects() { return _projectsCache || []; }

const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/></svg>';
const ICON_PLUG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>';
// The gauge is centred in its 24 box: arc and needle span y 8–16 (7–17 with the stroke).
const ICON_EFFORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16a8 8 0 1 1 16 0"/><path d="m12 16 4-5"/></svg>';
const ICON_AGENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>';
export const ICON_ACCOUNT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
/** Dropdown caret shared by every toolbar dropdown (fields, route mode). */
export const ICON_CARET = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.75 5 6.25l2.5-2.5"/></svg>';

// Test density: three bars centred in the 24 box (x 6–18, y 6–18; 5–19 with the stroke), `filled` of them at full strength.
function testsIcon(filled) {
  const bar = (index, d) => `<path d="${d}"${index < filled ? '' : ' opacity=".3"'}/>`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${bar(0, 'M6 18v-4')}${bar(1, 'M12 18v-8')}${bar(2, 'M18 18V6')}</svg>`;
}
// English copy of the Test density menu (i18n: assistant.tests.levels.* / assistant.tests.desc.*).
const TEST_DENSITY_COPY = {
  none: ['None', 'No tests. Only checks that the change loads.'],
  light: ['Light', 'Runs the tests that cover the change. New tests only when they matter.'],
  standard: ['Standard', 'Adds focused tests and runs the area\'s suite once.'],
  thorough: ['Thorough', 'Full coverage, whole suite, live checks.'],
};

// English copy of the Admin sandbox row (i18n: assistant.adminSandbox.hint). Names only Codex: the
// one provider it changes (lib/agent-sandbox-elevation.js; Claude Code and OpenCode are no-ops).
export const ADMIN_SANDBOX_HINT = 'Only changes anything when SynaBun runs on Windows. On: Codex can set up its strongest sandbox, which asks for administrator approval once per account. Off: no admin prompt; Codex uses a sandbox that needs no admin, with weaker isolation.';

/** "Light" — the level's name (a missing or unknown level is the default one). */
export function testDensityLabel(level, t) {
  const id = normalizeTestDensity(level);
  return tf(t)(`assistant.tests.levels.${id}`, TEST_DENSITY_COPY[id][0]);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function basename(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '');
}

const PLAN_DESC = {
  'claude-code': 'Plan first; approving the plan continues in the approval mode below',
  codex: 'Native Codex plan mode (read-only sandbox)',
  opencode: 'OpenCode plan agent (no file edits)',
};

function agentName(agent) {
  return typeof agent === 'string' ? agent : (agent?.name || agent?.id || '');
}

function tf(t) {
  return (key, fallback, params) => {
    const v = typeof t === 'function' ? t(key, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };
}

function isRendered(node) {
  return !!node && !node.hidden && node.isConnected && node.getClientRects().length > 0;
}

// ── Model catalog (all providers) ───────────────────────────────────────────

let _catalog = null;
let _catalogAt = 0;
let _catalogPartial = false; // built without the server's catalog (no context variants)
let _catalogLoading = null;
let _catalogEpoch = 0;      // bumped by every invalidation: a load that began before it is not kept
let _catalogForceNext = false; // the lists changed: the next load asks the server for a new build
const _catalogListeners = new Set();
const CATALOG_TTL_MS = 60_000;

function trimNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
}

/** "$3/$15" from { input, output } per-million prices; '' when unknown. */
export function fmtModelPrice(price) {
  if (!price || typeof price !== 'object') return '';
  const a = trimNumber(price.input);
  const b = trimNumber(price.output);
  if (!a && !b) return '';
  return b ? `$${a || '?'}/$${b}` : `$${a}`;
}

function normalizeCatalogModel(m, extra = {}) {
  const id = String(m?.id || m?.model || '').trim();
  if (!id) return null;
  return {
    id,
    label: String(m.label || m.displayName || m.name || extra.label || modelShortName(id)),
    desc: String(m.desc || m.description || extra.desc || ''),
    tier: m.tier || extra.tier || null,
    vision: m.vision ?? extra.vision ?? null,
    // What it generates besides text ({ image, video }: true | false | null), for image / video creation.
    outputs: m.outputs ?? extra.outputs ?? null,
    // 'unavailable' when the catalog marks it so (design never runs on one).
    status: m.status ?? extra.status ?? null,
    // The model an alias row runs as ("opus" → "claude-opus-5-5"), so a saved full id finds its row (designRouteSight).
    upstream: extra.upstream || m.upstream || m.resolvedModel || null,
    price: m.price || extra.price || null,
    contextWindow: m.contextWindow || extra.contextWindow || m.ctx || extra.ctx || null,
    ctxLabel: extra.ctxLabel || m.ctxLabel || null,
    // The model's own effort levels, from whichever shape it carries (null = unknown).
    efforts: modelEffortIds(m) ?? (Array.isArray(extra.efforts) ? modelEffortIds({ efforts: extra.efforts }) : null),
    defaultEffort: m.defaultEffort || m.defaultReasoningEffort || extra.defaultEffort || null,
    isDefault: !!(m.isDefault ?? extra.isDefault),
    selector: modelSelectorValue(m) || id,
  };
}

/**
 * OpenCode ids disabled in Settings → OpenCode: this window's mirror plus the
 * server's list from the catalog (a window on another origin may lag).
 */
function hiddenOpencodeIds(remote) {
  const hidden = getHiddenModels();
  for (const id of Array.isArray(remote?.hidden?.opencode) ? remote.hidden.opencode : (Array.isArray(remote?.opencodeHidden) ? remote.opencodeHidden : [])) hidden.add(String(id));
  return hidden;
}

// The models the user hid (Assistant → Models), per provider, as the last catalog load saw them.
let _hidden = { 'claude-code': new Set(), codex: new Set(), opencode: new Set() };

function hiddenSets(remote) {
  const out = {};
  // Entries with a pin record (an alias hidden as the model it named then): each hides its own row only.
  const rowOnly = {};
  for (const provider of PROVIDERS) {
    const list = Array.isArray(remote?.hidden?.[provider]) ? remote.hidden[provider] : [];
    out[provider] = new Set(list.map(id => String(id).toLowerCase()));
    const pins = remote?.hiddenPins?.[provider];
    rowOnly[provider] = new Set(pins && typeof pins === 'object' ? Object.keys(pins).map(id => id.toLowerCase()) : []);
  }
  out.opencode = new Set([...(out.opencode || []), ...hiddenOpencodeIds(remote)]);
  out.rowOnly = rowOnly;
  return out;
}

/**
 * The hidden id `id` names for `provider`, else null. Claude Code / Codex: the
 * id, or the model it resolves to at the same context window ("opus[1m]" →
 * "claude-opus-5-5[1m]"); "opus" and "opus[1m]" hide independently. OpenCode:
 * full or bare id (this window's Settings → OpenCode mirror counts too).
 * A hidden alias hides the model it named when it was hidden, and the server
 * keeps the list true to that (an alias that moved to another model is taken
 * off it); such an entry hides its own row only, never through `resolved`.
 */
export function hiddenModelFor(provider, id, { resolved = null, sets = _hidden } = {}) {
  const want = String(id || '').trim().toLowerCase();
  if (!want || !provider) return null;
  if (provider === 'opencode') return hiddenModelMatch(want, new Set([...(sets.opencode || []), ...getHiddenModels()]));
  const list = sets[provider] || new Set();
  if (list.has(want)) return want;
  const suffix = (want.match(/\[(1m|extended)\]$/) || [''])[0];
  const up = String(resolved || '').trim().toLowerCase().replace(/\[(1m|extended)\]$/, '');
  const key = up ? `${up}${suffix}` : '';
  return key && key !== want && list.has(key) && !sets.rowOnly?.[provider]?.has(key) ? key : null;
}

/**
 * One provider's menu rows. Which models exist is the server catalog's word: it
 * is built from the list the provider's own selector reads, with the models the
 * user hid already left out. The window's runtime list (`local`) only adds what
 * the catalog does not carry (the tagline, the default / top tag, a legacy
 * selector). It stands in for the catalog only when the catalog has no row for
 * the provider (request failed, older server, provider not answering there), or
 * holds the provider's static stand-in while this window has a verified list.
 */
export function mergeProviderModels(provider, remoteList, localList, { sets = _hidden, remoteSource = null } = {}) {
  const remote = (Array.isArray(remoteList) ? remoteList : []).filter(m => m?.id);
  const local = (Array.isArray(localList) ? localList : []).filter(m => m?.id || m?.model);
  const localVerified = local.length > 0 && !local.some(m => m.catalogSource === 'fallback');
  const out = [];
  const seen = new Set();
  const push = (m) => { if (m && !seen.has(m.id)) { seen.add(m.id); out.push(m); } };
  if (remote.length && !(remoteSource === 'fallback' && localVerified)) {
    const own = new Map(local.map(m => [String(m.id || m.model), m]));
    for (const r of remote) {
      if (hiddenModelFor(provider, r.id, { resolved: r.upstream || null, sets })) continue;
      const mine = own.get(String(r.id)) || null;
      // The catalog row first. What it does not carry (an older server, a row with no
      // label or effort list) is read from the window's row for the same id.
      const row = normalizeCatalogModel(
        { ...r, desc: mine?.desc || r.desc || r.description || '', tier: mine?.tier || r.tier || null, upstream: r.upstream || mine?.resolvedModel || null },
        mine ? {
          label: mine.label || mine.displayName || '', efforts: modelEffortIds(mine) || undefined, contextWindow: mine.contextWindow || null,
          defaultEffort: mine.defaultEffort || mine.defaultReasoningEffort || null, isDefault: mine.isDefault,
        } : {},
      );
      if (row) row.selector = mine ? (modelSelectorValue(mine) || row.id) : row.id;
      push(row);
    }
    return out;
  }
  const byId = new Map(remote.map(m => [String(m.id), m]));
  for (const m of local) {
    const extra = byId.get(String(m?.id)) || {};
    if (hiddenModelFor(provider, m.id || m.model, { resolved: extra.upstream || m.resolvedModel || null, sets })) continue;
    push(normalizeCatalogModel(m, extra));
  }
  return out;
}

/**
 * The catalog's empty list for `provider` is its answer, not a gap: the list was
 * read (`sources`: live, or the last verified one) and the provider said it has
 * no model (`known`: OpenCode with nothing connected) or listed some and the
 * user hid every one (`listed`). Not an answer: no list or no `sources` (request
 * failed, an older server), a provider that did not answer ('unavailable'), and
 * the server's static stand-in while this window holds a verified list (the
 * same precedence as mergeProviderModels).
 */
function catalogSaysNone(remote, provider, local) {
  const rows = remote?.models?.[provider];
  if (!Array.isArray(rows) || rows.length) return false;
  const source = remote.sources?.[provider];
  if (source !== 'live' && source !== 'stale' && source !== 'fallback') return false;
  if (!(Number(remote.listed?.[provider]) > 0) && remote.known?.[provider] !== true) return false;
  return !(source === 'fallback' && local.length > 0 && !local.some(m => m.catalogSource === 'fallback'));
}

/**
 * { 'claude-code': [...], codex: [...], opencode: [...] }: the models of every
 * Assistant model menu and of the Routes editor, from GET /api/assistant/catalog
 * (see mergeProviderModels). Models the user hid (Assistant → Models, and
 * Settings → OpenCode for OpenCode) never appear. `force` asks the server for a
 * new build instead of its cached one.
 */
export async function loadModelCatalog({ force = false } = {}) {
  if (!force && _catalog && Date.now() - _catalogAt < CATALOG_TTL_MS) return _catalog;
  if (_catalogLoading) return _catalogLoading;
  const epoch = _catalogEpoch;
  const serverForce = force || _catalogForceNext;
  _catalogForceNext = false;
  _catalogLoading = (async () => {
    const [remote] = await Promise.all([
      fetchAssistantCatalog({ force: serverForce }).catch(() => null),
      ...PROVIDERS.map(p => Promise.resolve(ensureModelsForProfile(p, force)).catch(() => [])),
    ]);
    const out = {};
    // No catalog (request failed): the last known disabled lists still apply.
    const sets = remote ? hiddenSets(remote) : { ..._hidden, opencode: new Set([...(_hidden.opencode || []), ...hiddenOpencodeIds(null)]) };
    _hidden = sets;
    for (const provider of PROVIDERS) {
      const local = getModelsForProfile(provider) || [];
      // An empty list the catalog vouches for is its answer: the window's own rows do not stand in for it.
      out[provider] = catalogSaysNone(remote, provider, local)
        ? []
        : mergeProviderModels(provider, remote?.models?.[provider], local, { sets, remoteSource: remote?.sources?.[provider] || null });
    }
    _catalog = out;
    // Not kept when built without the server's catalog, or when the lists changed
    // while it loaded: the next open asks again.
    _catalogAt = remote && epoch === _catalogEpoch ? Date.now() : 0;
    _catalogPartial = !remote;
    if (_catalogAt) keepCatalog(out, sets);
    return out;
  })().finally(() => { _catalogLoading = null; });
  return _catalogLoading;
}

// The last complete catalog is also kept in sessionStorage (this tab only): after a reload the model menus
// paint from it at once. Read back, it is due: the first load asks the server again.
const CATALOG_STORE_KEY = 'synabun:assistant-model-catalog:v1';
function keepCatalog(catalog, sets) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const hidden = {};
    for (const provider of PROVIDERS) hidden[provider] = [...(sets?.[provider] || [])];
    const rowOnly = {};
    for (const provider of PROVIDERS) rowOnly[provider] = [...(sets?.rowOnly?.[provider] || [])];
    sessionStorage.setItem(CATALOG_STORE_KEY, JSON.stringify({ catalog, hidden, rowOnly }));
  } catch { /* full or unavailable */ }
}
(() => {
  try {
    if (typeof sessionStorage === 'undefined' || _catalog) return;
    const kept = JSON.parse(sessionStorage.getItem(CATALOG_STORE_KEY) || 'null');
    if (!kept?.catalog || typeof kept.catalog !== 'object') return;
    _catalog = kept.catalog;
    _catalogAt = 0;
    const sets = { rowOnly: {} };
    for (const provider of PROVIDERS) {
      sets[provider] = new Set(Array.isArray(kept.hidden?.[provider]) ? kept.hidden[provider] : []);
      sets.rowOnly[provider] = new Set(Array.isArray(kept.rowOnly?.[provider]) ? kept.rowOnly[provider] : []);
    }
    _hidden = sets;
  } catch { /* unreadable: the first load builds it */ }
})();

/** The last loadModelCatalog() result, synchronously (null before the first load). */
export function cachedModelCatalog() { return _catalog; }

/** UI metadata from the same catalog load; no second list or extra endpoint. */
export function modelCatalogStatus() {
  return { partial: _catalogPartial, hiddenCounts: Object.fromEntries(PROVIDERS.map(provider => [provider, _hidden[provider]?.size || 0])) };
}

/** The catalog row for provider/model (covers "[1m]" / "[extended]" ids), else null. */
export function catalogModelRow(provider, model, catalog = _catalog) {
  if (!provider || !model) return null;
  const rows = Array.isArray(catalog?.[provider]) ? catalog[provider] : [];
  return rows.find(m => m.id === model || m.selector === model) || null;
}

export function invalidateModelCatalog() {
  _catalog = null;
  _catalogAt = 0;
  _catalogPartial = false;
  _catalogEpoch += 1;
  // A reload must not paint the lists this replaced.
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(CATALOG_STORE_KEY); } catch { /* unavailable */ }
}

/**
 * Tells `listener` whenever the lists behind loadModelCatalog() changed: a model
 * hidden or shown, a provider listing other models (the server's
 * `assistant:catalog-changed`), an OpenCode provider connected or removed. The
 * cache is already dropped when it is called. Returns the function that stops it.
 */
export function onModelCatalogChange(listener) {
  if (typeof listener !== 'function') return () => {};
  _catalogListeners.add(listener);
  return () => { _catalogListeners.delete(listener); };
}

function modelListsChanged() {
  invalidateModelCatalog();
  _catalogForceNext = true;
  for (const listener of [..._catalogListeners]) {
    try { listener(); } catch { /* a listener's failure is its own */ }
  }
  scheduleCatalogReload();
}

// In a page: the new lists are read right away, so the next menu opens from them (an open that comes
// first joins this read).
let _catalogReloadTimer = null;
function scheduleCatalogReload() {
  if (typeof document === 'undefined' || _catalogReloadTimer) return;
  _catalogReloadTimer = setTimeout(() => { _catalogReloadTimer = null; loadModelCatalog().catch(() => {}); }, 250);
}

/**
 * The models a brain may land on for `provider` (what resolveBrainDefaults
 * checks and picks a default from): the model menu's own list — context
 * variants ("gpt-x[extended]", "opus[1m]") included, disabled models left
 * out. Before the first catalog load: the provider's list minus the known
 * disabled ids. `keep` (the model the brain has) stays known when it was
 * disabled since (the server keeps it and warns once, so filling defaults
 * must not swap it behind the server's back) or when no server catalog was
 * loaded to tell a context variant from an unknown id.
 */
export function resolvableModels(provider, keep = '', catalog = _catalog) {
  const merged = Array.isArray(catalog?.[provider]) ? catalog[provider] : null;
  const rows = merged || (getModelsForProfile(provider) || [])
    .filter(m => m?.id && !hiddenModelFor(provider, m.id, { resolved: m.resolvedModel || null }));
  if (!keep || rows.some(m => m.id === keep || m.selector === keep)) return rows;
  const unsure = !merged || (catalog === _catalog && _catalogPartial);
  return hiddenModelFor(provider, keep) || unsure ? [...rows, { id: keep, selector: keep }] : rows;
}

// A Settings → OpenCode checkbox or an Assistant → Models toggle (this window, or another via
// sync), an OpenCode provider connected or removed in Settings, a provider listing other models.
if (typeof document !== 'undefined') {
  document.addEventListener(HIDDEN_MODELS_EVENT, modelListsChanged);
  document.addEventListener('ocp-providers-changed', modelListsChanged);
}
on('sync:opencode:hidden-models-changed', modelListsChanged);
on('sync:assistant:hidden-models-changed', modelListsChanged);
on('sync:assistant:catalog-changed', modelListsChanged);

// Launch: the menus' lists are read once the page has painted, so the first model menu opens from them.
if (typeof document !== 'undefined') {
  registerLaunchPrefetch('assistant-model-catalog', () => loadModelCatalog(), { order: 10, owner: true });
  registerLaunchPrefetch('assistant-accounts', () => Promise.allSettled([fetchClaudeAccounts(), fetchCodexAccounts(), fetchMcpProfilePresets(), fetchOpencodeAgents()]), { order: 14, owner: true });
}

function sameModel(selected, m) {
  if (!selected) return false;
  return selected === m.id || selected === m.selector;
}

function modelDesc(m, tr, showUnknown = false) {
  return [
    m.ctxLabel || (showUnknown ? m.contextWindow ? tr('assistant.routes.menu.contextTokens', '{count} tokens', { count: m.contextWindow.toLocaleString() }) : tr('assistant.routes.menu.contextUnknown', 'Context unknown') : ''), m.desc,
    fmtModelPrice(m.price) || (showUnknown ? tr('assistant.routes.menu.priceUnknown', 'Price unknown') : ''), m.vision === true ? tr('assistant.brain.vision', 'vision') : '',
    m.outputs?.image === true ? tr('assistant.brain.imageOut', 'makes images') : '',
    m.outputs?.video === true ? tr('assistant.brain.videoOut', 'makes video') : '',
  ].filter(Boolean).join(' · ');
}

function tierTag(m, tr) {
  if (m.tier === 'default') return tr('assistant.brain.default', 'default');
  if (m.tier === 'top') return tr('assistant.brain.top', 'top');
  return m.tier && typeof m.tier === 'string' && m.tier.length <= 10 ? m.tier : '';
}

/**
 * Model menu grouped by provider, filterable, with "Custom model id…".
 * opts: { brain, onSelect(target), includeHere, hereLabel, title, t, placement,
 *         current:{provider, model}|null, warnSwitch, providers, onToast(text),
 *         accept(provider, model) → bool (only those models), emptyLabel (when none
 *         passes), allowCustom (default true), zIndex (see asst-menu.js),
 *         accountItems (menu items listed first, under accountTitle) }
 * target: { provider, model, label, tier, vision, outputs, efforts, price } | { here: true }
 */
export async function openModelMenu(anchor, opts = {}) {
  const {
    brain = null, onSelect, includeHere = false, hereLabel = '', title = '', t = null,
    placement = 'auto', current = null, warnSwitch = false, providers = null, onToast = null,
    accept = null, emptyLabel = '', allowCustom = true,
  } = opts;
  if (!anchor) return null;
  const tr = tf(t);
  const b = normalizeBrain(brain);
  // The kept catalog paints the menu at once (it is read again in the background below, and an open menu
  // follows it in place); only a first open, or a reload the user asked for, waits for the lists.
  const kept = opts.forceReload === true ? null : cachedModelCatalog();
  let catalog = {};
  let failed = false;
  let loading = null;
  if (kept) {
    catalog = kept;
  } else {
    anchor.setAttribute('aria-busy', 'true');
    // Open immediately: a slow provider still has a visible, cancellable state.
    loading = opts.routingEditor ? openMenu(anchor, {
      title, className: 'asst-model-menu asst-route-model-menu',
      items: [{ kind: 'info', label: tr('assistant.routes.editorState.loadingModels', 'Loading models…') }],
      width: 380, zIndex: opts.zIndex ?? null, repositionOnResize: true,
    }) : null;
    if (loading) loading.el.setAttribute('aria-busy', 'true');
    if (loading) { loading.el.setAttribute('role', 'dialog'); anchor.setAttribute('aria-haspopup', 'dialog'); }
    try { catalog = await loadModelCatalog({ force: opts.forceReload === true }); } catch { failed = true; } finally { anchor.removeAttribute('aria-busy'); }
    if (!anchor.isConnected || (loading && currentMenu() !== loading.el)) return null;
  }
  const items = buildModelMenuItems(catalog);
  const menu = openMenu(anchor, {
    title: title || tr('assistant.brain.model', 'Model'),
    items,
    filter: true,
    filterPlaceholder: tr('assistant.brain.filterModels', 'Filter models…'),
    placement,
    width: opts.routingEditor ? 380 : 300,
    role: 'menu',
    className: `asst-model-menu${opts.routingEditor ? ' asst-route-model-menu' : ''}`,
    zIndex: opts.zIndex ?? null,
    repositionOnResize: true,
    filterEmptyLabel: tr('assistant.routes.menu.noMatches', 'No matching models. Check Models for hidden choices.'),
  });
  if (opts.routingEditor && menu) decorateRouteMenu(menu, failed);
  // Painted from the kept catalog: read it again (fresh within its minute, else a background request) and
  // redraw the open menu in place when the lists changed, leaving the filter, the scroll and the focus alone.
  if (kept && menu && !opts.routingEditor) {
    loadModelCatalog().then((next) => {
      if (!next || next === kept || currentMenu() !== menu.el || !anchor.isConnected) return;
      const nextItems = buildModelMenuItems(next);
      if (menuItemsSignature(nextItems) !== menuItemsSignature(items)) menu.update({ items: nextItems, keepPlace: true });
    }).catch(() => { /* the kept list stays */ });
  }
  return menu;

  function buildModelMenuItems(catalog) {
    const metadata = modelCatalogStatus();
    const items = [];
    if (Array.isArray(opts.accountItems) && opts.accountItems.length) {
      items.push({ kind: 'header', label: opts.accountTitle || tr('assistant.brain.account', 'Account profile') }, ...opts.accountItems, { kind: 'separator' });
    }
    if (includeHere) {
      items.push({ kind: 'radio', id: '__here', label: hereLabel || tr('assistant.routes.brainDecides', 'Let the brain decide'), selected: !current, onSelect: () => onSelect?.({ here: true }) });
    }
    const list = Array.isArray(providers) && providers.length ? PROVIDERS.filter(p => providers.includes(p)) : PROVIDERS;
    let listed = 0;
    for (const provider of list) {
      const models = (catalog[provider] || []).filter(m => typeof accept !== 'function' || accept(provider, m));
      if (!models.length && !opts.routingEditor) continue;
      listed += models.length;
      const meta = getProviderMeta(provider);
      const hiddenCount = metadata.hiddenCounts[provider] || 0;
      const note = opts.routingEditor ? tr('assistant.routes.menu.hiddenCount', '{count} hidden in Models', { count: hiddenCount }) : warnSwitch && provider !== b.provider ? tr('assistant.brain.newConversation', 'starts a new conversation') : '';
      items.push({ kind: 'header', label: meta.label, icon: meta.icon, color: meta.color, note });
      for (const m of models) {
        items.push({
          kind: 'radio',
          id: `${provider}:${m.id}`,
          label: m.label,
          desc: modelDesc(m, tr, opts.routingEditor),
          title: `${m.label || m.id} · ${m.id}`,
          tag: tierTag(m, tr),
          keywords: `${meta.label} ${m.id}`,
          selected: !!current && current.provider === provider && sameModel(current.model, m),
          onSelect: () => onSelect?.({ provider, model: m.id, label: m.label, tier: m.tier || null, vision: m.vision ?? null, outputs: m.outputs || null, efforts: m.efforts || null, price: m.price || null }),
        });
      }
      if (opts.routingEditor && !models.length) items.push({ kind: 'info', label: typeof accept === 'function' ? tr('assistant.routes.menu.noCompatible', 'No compatible models shown for this provider.') : tr('assistant.routes.menu.providerEmpty', 'No models shown for this provider.') });
    }
    // Nothing passes the filter (e.g. no model makes video yet): say so instead of an empty list.
    if (!listed && typeof accept === 'function' && emptyLabel) items.push({ kind: 'info', label: emptyLabel });
    if (opts.routingEditor && !listed && typeof accept !== 'function') items.push({ kind: 'info', label: tr('assistant.routes.editorState.modelsEmpty', 'No models are available. Check Models or connect a provider, then reload.') });
    if (allowCustom) {
      items.push({ kind: 'separator' });
      items.push({
        kind: 'input',
        placeholder: tr('assistant.brain.modelCustom', 'Custom model id…'),
        onSubmit: (v) => {
          const provider = current?.provider || b.provider;
          const disabled = hiddenModelFor(provider, v);
          if (disabled) {
            onToast?.(tr('assistant.brain.modelDisabled', "{model} is disabled in the Assistant's Models list.", { model: disabled }));
            return;
          }
          onSelect?.({ provider, model: v, label: modelShortName(v), custom: true });
        },
      });
    }
    if (!opts.routingEditor && typeof opts.onManageModels === 'function') {
      items.push({ id: '__manage_models', label: tr('assistant.models.manage', 'Manage models…'), onSelect: () => opts.onManageModels() });
    }
    return items;
  }

  function decorateRouteMenu(menu, failed) {
    const metadata = modelCatalogStatus();
    // Search and a custom-id input belong to a dialog; choices are a radio group.
    // A menu role cannot contain these form fields or recovery buttons.
    menu.el.setAttribute('role', 'dialog');
    anchor.setAttribute('aria-haspopup', 'dialog');
    const choices = menu.list.querySelectorAll('[role="menuitemradio"]');
    for (const choice of choices) choice.setAttribute('role', 'radio');
    const groupRole = () => {
      const visible = [...choices].filter(n => !n.hidden);
      const focusChoice = visible.find(n => n.getAttribute('aria-checked') === 'true') || visible[0];
      for (const choice of choices) choice.tabIndex = choice === focusChoice ? 0 : -1;
      menu.list.setAttribute('role', visible.length ? 'radiogroup' : 'group');
      menu.list.setAttribute('aria-labelledby', `${menu.el.id}-title`);
    };
    groupRole(); menu.el.querySelector('.asst-dd-filter')?.addEventListener('input', groupRole);
    // Outside the filter's scroller: recovery stays visible, including zero results.
    const footer = document.createElement('div'); footer.className = 'asst-route-menu-foot';
    const note = document.createElement('div'); note.className = 'asst-dd-info';
    note.textContent = failed || metadata.partial ? tr('assistant.routes.menu.failed', 'Model list could not be refreshed. Provider lists may be out of date.') : tr('assistant.routes.menu.hiddenHelp', 'Missing a model? Your Models list controls what is shown.');
    note.setAttribute('role', 'status'); footer.append(note);
    const customInput = menu.list.querySelector('.asst-dd-input');
    if (customInput) footer.append(customInput);
    for (const [label, action] of [
      ...(typeof opts.onManageModels === 'function' ? [[tr('assistant.models.manage', 'Manage models…'), () => { closeMenu(); opts.onManageModels(); }]] : []),
      [tr('assistant.routes.reloadModels', 'Reload models'), () => { closeMenu(); openModelMenu(anchor, { ...opts, forceReload: true }); }],
    ]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'asst-dd-item'; button.tabIndex = -1; button.textContent = label; button.addEventListener('click', action); footer.append(button);
    }
    menu.el.append(footer); menu.reposition();
  }
}

/** What a model menu lists, for telling a fresher read from the one on screen. */
function menuItemsSignature(items) {
  return JSON.stringify((items || []).map((item) => [item.kind || '', item.id ?? '', item.label || '', item.desc || '', item.tag || '', item.note || '', !!item.selected]));
}

// ── Picker ──────────────────────────────────────────────────────────────────

// Creation order is DOM order within a slot: model · effort · variant · mode · tests · account in the composer.
// `effort` is the OpenCode agent for OpenCode; `variant` is OpenCode's effort (the model's variants).
// `tests` is the session's Test density, not a brain field: it shows only while the host supplies a level.
const FIELDS = ['model', 'effort', 'variant', 'mode', 'tests', 'account', 'project', 'mcp'];
// Slot of each field: the composer row (the brain and how it acts) · the toolbar (where it works).
const FIELD_GROUP = { model: 'brain', effort: 'brain', variant: 'brain', mode: 'brain', tests: 'brain', account: 'brain', project: 'context', mcp: 'context' };

/**
 * createBrainPicker(host, hooks) — `host` is either one element (all fields in
 * an `.asst-brain` wrapper) or `{ brain, context }` toolbar groups.
 * hooks: { t, getBrain() → brain, onChange(nextBrain, { requiresSwitch, field }),
 *          onAddAccount(provider), onManageAccounts(provider), onToast(text),
 *          getMenuAnchor() → fallback anchor (the toolbar "⋯"),
 *          menuPlacement: 'below' (default) | 'above' | 'auto',
 *          getTestDensity() → level | null (null hides the field), onTestDensity(level),
 *          onProjects(projects) — the registered projects were (re)loaded }
 */
export function createBrainPicker(host, hooks = {}) {
  const t = tf(hooks.t);
  const placement = hooks.menuPlacement || 'below';

  const single = typeof host?.appendChild === 'function';
  const root = el('div', 'asst-brain');
  if (single) host.appendChild(root);

  const buttons = {};
  for (const field of FIELDS) {
    const btn = el('button', `asst-dd asst-dd-${field}`);
    btn.type = 'button';
    btn.dataset.field = field;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = `<span class="asst-icon" aria-hidden="true"></span><span class="asst-dd-label"></span><span class="asst-dd-caret" aria-hidden="true">${ICON_CARET}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isMenuOpen(btn)) { closeMenu(); return; }
      openField(field, btn);
    });
    (single ? root : host[FIELD_GROUP[field]] || root).appendChild(btn);
    buttons[field] = btn;
  }

  let destroyed = false;
  let loading = null;
  // The empty state's "Choose a project" (mountEmptyProject): the project field's second button.
  let heroProject = null;
  let heroProjectMascot = null;

  function currentBrain() {
    return normalizeBrain(hooks.getBrain?.());
  }

  // `brain` = the brain being resolved (a model change checks the NEW model's efforts).
  function snapshot(brain = currentBrain()) {
    return {
      models: { [brain.provider]: resolvableModels(brain.provider, brain.model) },
      efforts: { [brain.provider]: effortsFor(brain) },
      accounts: {
        'claude-code': getCachedClaudeAccounts(),
        codex: getCachedCodexAccounts(),
      },
      agents: getCachedOpencodeAgents(),
      mcpProfiles: getCachedMcpProfilePresets(),
      defaultMcpProfile: 'full',
      projects: _projectsCache || [],
    };
  }

  function modelOf(brain) {
    const models = getModelsForProfile(brain.provider);
    return models.find(m => m.id === brain.model || modelSelectorValue(m) === brain.model) || null;
  }

  // Per model, from the catalog row (which also covers "[1m]" / "[extended]" ids);
  // the provider list only for a model nothing is known about. OpenCode: variants.
  function effortsFor(brain) {
    const model = catalogModelRow(brain.provider, brain.model) || modelOf(brain);
    return getEffortLevelsForModel(brain.provider, model);
  }

  function accountOf(brain) {
    if (!ACCOUNT_PROVIDERS.has(brain.provider)) return null;
    const accounts = brain.provider === 'codex' ? getCachedCodexAccounts() : getCachedClaudeAccounts();
    return accounts.find(a => a.id === brain.accountId) || null;
  }

  const accountProvider = (brain) => (brain.provider === 'codex' ? 'codex' : 'claude');
  function accountLabel(brain) {
    const acc = accountOf(brain);
    const name = acc ? accountName(acc, accountProvider(brain)) : (brain.accountId || t('assistant.brain.accountDefault', 'Default'));
    // An account says what it runs on (its subscription or its API key), or that it is signed out.
    if (acc && acc.mode !== undefined) {
      const badge = accountBadge(acc, accountProvider(brain));
      return badge.text ? `${name} · ${badge.text}` : name;
    }
    return name;
  }

  // The "⋯" item's value, in the account menu's words: the name and its plan, "API key" or "Signed out" ("Default · Max").
  function accountValue(brain) {
    const acc = accountOf(brain);
    if (!acc) return brain.accountId === 'auto' ? autoAccountLabel(hooks.t) : (brain.accountId || t('assistant.brain.accountDefault', 'Default'));
    const row = accountMenuRow(acc, { provider: accountProvider(brain), t: hooks.t });
    return [row.name, row.badge.text].filter(Boolean).join(' · ');
  }

  // The model menu's own row first: it also names the "[1m]" / "[extended]" variants the provider list lacks.
  function modelRow(brain) {
    return catalogModelRow(brain.provider, brain.model) || modelOf(brain);
  }

  function modelLabel(brain = currentBrain()) {
    const model = modelRow(brain);
    return model ? (model.label || modelShortName(model.id)) : (brain.model ? modelShortName(brain.model) : t('assistant.brain.modelDefault', 'Default model'));
  }

  // The composer chip's account cue: the account menu's initial avatar when the provider has more than one
  // account (or the account is signed out), "Auto" for Auto; null otherwise. Its full words are the tooltip's.
  function accountCue(brain) {
    if (!ACCOUNT_PROVIDERS.has(brain.provider)) return null;
    if (brain.accountId === 'auto') return { text: t('assistant.brain.accountAutoShort', 'Auto'), tone: 'muted' };
    const accounts = brain.provider === 'codex' ? getCachedCodexAccounts() : getCachedClaudeAccounts();
    const acc = accountOf(brain);
    const signedOut = acc?.signedIn === false;
    if (accounts.length < 2 && !signedOut) return null;
    const initial = acc
      ? accountMenuRow(acc, { provider: accountProvider(brain), t: hooks.t }).initial
      : Array.from(String(brain.accountId || t('assistant.brain.accountDefault', 'Default')).trim())[0]?.toLocaleUpperCase();
    return { text: initial || '?', tone: signedOut ? 'warn' : 'muted' };
  }

  function values(brain = currentBrain()) {
    const meta = getProviderMeta(brain.provider);
    const efforts = effortsFor(brain);
    const level = efforts.find(e => e.id === brain.effort);
    const hasEfforts = efforts.some(e => e.id !== 'off');
    const presets = getCachedMcpProfilePresets();
    return {
      meta,
      model: modelLabel(brain),
      effortSupported: brain.provider === 'opencode' || hasEfforts,
      effort: brain.provider === 'opencode'
        ? (brain.agent || t('assistant.brain.agentDefault', 'default'))
        : (level ? level.label : (brain.effort || t('assistant.brain.effortOff', 'off'))),
      variantSupported: brain.provider === 'opencode' && hasEfforts,
      variant: level ? level.label : (brain.effort || t('assistant.brain.variantDefault', 'default variant')),
      project: brain.project ? projectLabel(brain.project, _projectsCache || []) : t('assistant.brain.projectHome', 'Home'),
      mode: permissionModeLabel(brain, (id, fallback) => t(`assistant.brain.modes.${id}`, fallback)),
      mcp: presets[brain.mcpProfile]?.label || brain.mcpProfile || 'full',
      account: ACCOUNT_PROVIDERS.has(brain.provider) ? accountLabel(brain) : '',
    };
  }

  /**
   * The permission menu's Admin sandbox row (a check: the global setting, every agent SynaBun starts),
   * or null while the host has none to show (a server that does not serve it). Its tooltip and
   * aria-label say the value in effect.
   */
  function adminSandboxItem() {
    const on = typeof hooks.getAdminSandbox === 'function' ? hooks.getAdminSandbox() : null;
    if (typeof on !== 'boolean') return null;
    const label = t('assistant.adminSandbox.label', 'Admin sandbox');
    const value = on ? t('assistant.adminSandbox.on', 'On') : t('assistant.adminSandbox.off', 'Off');
    const hint = t('assistant.adminSandbox.hint', ADMIN_SANDBOX_HINT);
    return {
      kind: 'check', id: 'admin-sandbox', label, desc: hint, checked: on,
      className: 'asst-admin-sandbox-item',
      title: `${label}: ${value}. ${hint}`,
      ariaLabel: t('assistant.adminSandbox.aria', '{label}: {value}. Only changes anything when SynaBun runs on Windows.', { label, value }),
      onSelect: () => hooks.onAdminSandbox?.(!on),
    };
  }

  /** The session's Test density, or null while the host has none to show (a server that does not know it). */
  function testDensity() {
    const level = typeof hooks.getTestDensity === 'function' ? hooks.getTestDensity() : null;
    return level ? normalizeTestDensity(level) : null;
  }

  function setBtn(field, { label, icon, color, hidden, disabled, tooltip, aria }) {
    const btn = buttons[field];
    if (!btn) return;
    btn.hidden = !!hidden;
    btn.disabled = !!disabled;
    btn.querySelector('.asst-dd-label').textContent = label ?? '';
    const iconEl = btn.querySelector('.asst-icon');
    iconEl.innerHTML = icon || '';
    iconEl.hidden = !icon;
    if (color) btn.style.setProperty('--asst-provider-color', color); else btn.style.removeProperty('--asst-provider-color');
    if (tooltip) btn.setAttribute('data-tooltip', tooltip); else btn.removeAttribute('data-tooltip');
    btn.setAttribute('aria-label', aria || tooltip || label || field);
  }

  // The composer's model chip (asst-model-chip.js): the model's short name, a context tag for a variant,
  // the account cue and "API" on an API key, never the credential's name (the provider icon says it).
  // Model label, id, account, who it is and what it runs on are the tooltip and aria-label.
  // fitModelChip() draws the longest form that fits the row.
  let chipForms = [];
  let chipParts = null;
  let chipCatalog = null;
  function renderModelChip(brain, v) {
    const btn = buttons.model;
    // The catalog was dropped (a model hidden, a provider's list changed): read it again, then the label.
    if (!cachedModelCatalog() && !chipCatalog) {
      chipCatalog = loadModelCatalog().catch(() => null).then(() => {
        chipCatalog = null;
        if (!destroyed && cachedModelCatalog()) render();
      });
    }
    const row = modelRow(brain);
    const id = brain.model || row?.id || '';
    const { name, raw } = id ? modelChipName(row?.label, id) : { name: v.model, raw: false };
    const tag = modelChipTag(id, { contextWindow: row?.contextWindow, label: row?.label });
    const cue = accountCue(brain);
    const p = accountProvider(brain);
    const acc = ACCOUNT_PROVIDERS.has(brain.provider) ? accountOf(brain) : null;
    const api = acc && acc.signedIn !== false && acc.mode === 'apiKey' ? accountText('apiShort', {}, p) : '';
    const names = (cachedModelCatalog()?.[brain.provider] || []).map(m => modelChipName(m.label, m.id).name);
    chipForms = modelChipForms({ name, names, tag: !!tag, cue: !!cue, api: !!api });

    const who = !ACCOUNT_PROVIDERS.has(brain.provider) ? ''
      : brain.accountId === 'auto' ? autoAccountLabel(hooks.t)
        : acc ? accountName(acc, p) : (brain.accountId || t('assistant.brain.accountDefault', 'Default'));
    const model = brain.model && v.model !== brain.model ? `${v.model} · ${brain.model}` : (brain.model || v.model);
    const tip = [
      v.meta.label, model, who ? t('assistant.brain.asAccount', 'as {account}', { account: who }) : '',
      acc ? accountIdentity(acc) : '', acc ? accountBadge(acc, p).text : '',
    ].filter(Boolean).join(' · ');
    setBtn('model', { label: '', icon: v.meta.icon, color: v.meta.color, tooltip: tip, aria: `${t('assistant.brain.model', 'Model')}: ${tip}` });

    const label = btn.querySelector('.asst-dd-label');
    label.classList.add('asst-model-label');
    chipParts = {
      name: el('span', 'asst-model-name', name),
      tag: el('span', 'asst-model-tag', tag),
      cue: el('span', 'asst-acct-avatar asst-model-cue', cue?.text || ''),
      api: el('span', 'asst-acct-badge asst-model-api', api),
    };
    if (cue) chipParts.cue.dataset.tone = cue.tone;
    label.replaceChildren(chipParts.name, chipParts.tag, chipParts.cue, chipParts.api);
    // A display name ("Sonnet 5") reads in sans; a raw id nothing names ("opus") stays mono.
    btn.toggleAttribute('data-raw', raw);
    fitModelChip();
  }

  function drawChipForm(form) {
    chipParts.name.textContent = form.name;
    chipParts.tag.hidden = !form.tag;
    chipParts.cue.hidden = !form.cue;
    chipParts.api.hidden = !form.api;
  }

  // The first form, longest first, that leaves the row as the shortest one does: no part cut, no other
  // field narrower, the row no taller (it wraps below 320px). None does: the shortest, its name squeezed.
  function fitModelChip() {
    const btn = buttons.model;
    if (destroyed || !btn || !chipParts || !chipForms.length) return;
    btn.removeAttribute('data-squeezed');
    const label = btn.querySelector('.asst-dd-label');
    const slot = btn.parentElement;
    // Nothing to measure (not on screen, no layout): the whole chip, until the row has a width.
    if (chipForms.length === 1 || !isRendered(btn) || !slot || typeof label?.getBoundingClientRect !== 'function') { drawChipForm(chipForms[0]); return; }
    const row = slot.parentElement || null;
    const others = [...slot.querySelectorAll('.asst-dd-label')].filter(n => n !== label && n.getClientRects().length > 0);
    const width = n => n.getBoundingClientRect().width;
    const cut = () => {
      const right = label.getBoundingClientRect().right + 0.5;
      return Object.values(chipParts).some(n => !n.hidden && n.getBoundingClientRect().right > right);
    };
    const shortest = chipForms[chipForms.length - 1];
    drawChipForm(shortest);
    const base = { height: row?.offsetHeight || 0, widths: others.map(width) };
    const fits = () => !cut()
      && (row?.offsetHeight || 0) <= base.height + 0.5
      && others.every((n, i) => width(n) >= base.widths[i] - 0.5)
      && !(slot.scrollWidth > slot.clientWidth + 1);
    for (const form of chipForms.slice(0, -1)) {
      drawChipForm(form);
      if (fits()) return;
    }
    drawChipForm(shortest);
    btn.toggleAttribute('data-squeezed', cut());
  }

  // The row's width decides the form (a panel resized, a tab shown, the fields that collapse to glyphs).
  const fitHost = buttons.model.parentElement?.parentElement || buttons.model.parentElement;
  let fitFrame = 0;
  let fitWidth = -1;
  const scheduleFit = () => {
    if (fitFrame || destroyed || typeof requestAnimationFrame !== 'function') return;
    fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitModelChip(); });
  };
  const fitObserver = typeof ResizeObserver === 'function' && fitHost ? new ResizeObserver((entries) => {
    const w = Math.round(entries[entries.length - 1]?.contentRect?.width || 0);
    if (w !== fitWidth) { fitWidth = w; scheduleFit(); }
  }) : null;
  fitObserver?.observe(fitHost);
  if (typeof document !== 'undefined') document.fonts?.ready?.then(scheduleFit).catch(() => {});

  function render() {
    if (destroyed) return;
    const brain = currentBrain();
    const v = values(brain);
    renderModelChip(brain, v);

    if (brain.provider === 'opencode') {
      setBtn('effort', { label: v.effort, icon: ICON_AGENT, tooltip: `${t('assistant.brain.agent', 'OpenCode agent')}: ${v.effort}` });
    } else {
      setBtn('effort', { label: v.effort, icon: ICON_EFFORT, hidden: !v.effortSupported, tooltip: `${t('assistant.brain.effort', 'Thinking effort')}: ${v.effort}` });
    }
    setBtn('variant', { label: v.variant, icon: ICON_EFFORT, hidden: !v.variantSupported, tooltip: `${t('assistant.brain.variant', 'Model variant')}: ${v.variant}` });
    // A Claude or Codex brain always shows it: which account and which credential (its subscription or
    // its API key) it runs on, or that the account is signed out.
    const brainAcc = ACCOUNT_PROVIDERS.has(brain.provider) ? accountOf(brain) : null;
    const accountTip = [v.account, brainAcc ? accountIdentity(brainAcc) : ''].filter(Boolean).join(' · ');
    setBtn('account', { label: v.account, icon: ICON_ACCOUNT, hidden: true, tooltip: `${t('assistant.brain.account', 'Account profile')}: ${accountTip}` });
    buttons.account?.classList.toggle('asst-dd-warn', !!brainAcc && brainAcc.signedIn === false);
    setBtn('project', { label: v.project, icon: ICON_FOLDER, tooltip: brain.project || t('assistant.brain.projectNoneTip', 'Working project: home directory'), aria: `${t('assistant.brain.project', 'Working project')}: ${brain.project || v.project}` });
    setBtn('mode', { label: v.mode, icon: ICON_SHIELD, tooltip: `${t('assistant.brain.mode', 'Permission mode')}: ${v.mode}` });
    const tests = testDensity();
    const testsLabel = tests ? testDensityLabel(tests, hooks.t) : '';
    setBtn('tests', { label: testsLabel, icon: testsIcon(testDensityBars(tests)), hidden: !tests, tooltip: `${t('assistant.tests.title', 'Test density')}: ${testsLabel}` });
    if (tests) buttons.tests.dataset.level = tests; else delete buttons.tests.dataset.level;
    setBtn('mcp', { label: v.mcp, icon: ICON_PLUG, tooltip: `${t('assistant.brain.mcp', 'MCP tool profile')}: ${v.mcp}` });
    renderEmptyProject(brain);
  }

  function renderEmptyProject(brain = currentBrain()) {
    const btn = heroProject;
    if (!btn) return;
    const view = emptyProjectView(brain.project, _projectsCache || [], t);
    btn.dataset.chosen = view.chosen ? '1' : '0';
    const key = btn.querySelector('.asst-empty-project-key');
    key.textContent = view.key;
    key.hidden = !view.key;
    btn.querySelector('.asst-dd-label').textContent = view.label;
    if (view.title) btn.setAttribute('data-tooltip', view.title); else btn.removeAttribute('data-tooltip');
    btn.setAttribute('aria-label', view.aria);
  }

  /**
   * The empty state's project picker, in `slot` (asst-render.js): one more
   * button for the project field, drawn by render() like the toolbar's and
   * opening the same menu, so the two always show the same project. A pick
   * sends focus back to it. A new slot replaces the last one; null removes it.
   */
  function mountEmptyProject(slot) {
    if (heroProject && isMenuOpen(heroProject)) closeMenu();
    heroProjectMascot?.destroy();
    heroProjectMascot = null;
    heroProject?.remove();
    heroProject = null;
    if (destroyed || !slot || typeof slot.appendChild !== 'function') return null;
    const btn = el('button', 'asst-dd asst-empty-control-btn asst-empty-project-btn');
    btn.type = 'button';
    btn.dataset.field = 'project';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    // glyph | seam | "Project" + name | caret: the field's capsule at the suggestions' md size.
    const icon = el('span', 'asst-icon');
    icon.innerHTML = ICON_FOLDER;
    const caret = el('span', 'asst-dd-caret');
    caret.innerHTML = ICON_CARET;
    for (const part of [icon, caret]) part.setAttribute('aria-hidden', 'true');
    btn.append(icon, el('span', 'asst-empty-project-key'), el('span', 'asst-dd-label'), caret);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isMenuOpen(btn)) { closeMenu(); return; }
      openField('project', btn, { restoreFocus: true });
    });
    slot.appendChild(btn);
    heroProject = btn;
    heroProjectMascot = createMascotControl(btn, { director: hooks.mascot, pose: 'project' });
    renderEmptyProject();
    return btn;
  }

  /** Current values for the toolbar "⋯" menu (fields hidden inline stay reachable there). */
  function fieldSummary() {
    const brain = currentBrain();
    const v = values(brain);
    return [
      { field: 'model', label: t('assistant.brain.model', 'Model'), value: `${v.meta.label} · ${v.model}`, icon: v.meta.icon, color: v.meta.color, hidden: false },
      brain.provider === 'opencode'
        ? { field: 'effort', label: t('assistant.brain.agent', 'OpenCode agent'), value: v.effort, icon: ICON_AGENT, hidden: false }
        : { field: 'effort', label: t('assistant.brain.effort', 'Thinking effort'), value: v.effort, icon: ICON_EFFORT, hidden: !v.effortSupported },
      { field: 'variant', label: t('assistant.brain.variant', 'Model variant'), value: v.variant, icon: ICON_EFFORT, hidden: !v.variantSupported },
      { field: 'project', label: t('assistant.brain.project', 'Working project'), value: brain.project || v.project, icon: ICON_FOLDER, hidden: false },
      { field: 'mode', label: t('assistant.brain.mode', 'Permission mode'), value: v.mode, icon: ICON_SHIELD, hidden: false },
      { field: 'tests', label: t('assistant.tests.title', 'Test density'), value: testDensity() ? testDensityLabel(testDensity(), hooks.t) : '', icon: testsIcon(testDensityBars(testDensity())), hidden: !testDensity() },
      { field: 'mcp', label: t('assistant.brain.mcp', 'MCP tool profile'), value: v.mcp, icon: ICON_PLUG, hidden: false },
      { field: 'account', label: t('assistant.brain.accountShort', 'Account'), value: accountValue(brain), icon: ICON_ACCOUNT, hidden: !ACCOUNT_PROVIDERS.has(brain.provider) },
    ];
  }

  function commit(patch, field) {
    const before = currentBrain();
    const draft = { ...before, ...patch };
    const next = resolveBrainDefaults(draft, snapshot(normalizeBrain(draft)));
    const requiresSwitch = brainRequiresSwitch(before, next);
    hooks.onChange?.(next, { requiresSwitch, field, previous: before });
    render();
  }

  async function ensureLoaded(provider, { force = false } = {}) {
    // The catalog too: defaults resolve against the menu's list (context variants, disabled models out).
    const jobs = [ensureModelsForProfile(provider, force), fetchMcpProfilePresets(force), loadModelCatalog()];
    if (provider === 'codex') jobs.push(fetchCodexAccounts(force));
    if (provider === 'claude-code') jobs.push(fetchClaudeAccounts(force));
    if (provider === 'opencode') jobs.push(fetchOpencodeAgents(force));
    if (!_projectsCache || force) {
      jobs.push(fetchProjects().then((p) => {
        _projectsCache = p;
        if (!destroyed) { try { hooks.onProjects?.(p); } catch { /* the host's own failure */ } }
      }).catch(() => { _projectsCache = _projectsCache || []; }));
    }
    await Promise.allSettled(jobs);
    if (cachedModelCatalog()) _warmProviders.add(provider);
  }

  async function refresh(force = false) {
    const brain = currentBrain();
    if (loading) await loading;
    if (force) invalidateModelCatalog();
    loading = ensureLoaded(brain.provider, { force }).finally(() => { loading = null; });
    await loading;
    if (destroyed) return;
    // Fill defaults silently once the catalog is known (no server round-trip).
    const resolved = resolveBrainDefaults(brain, snapshot());
    if (JSON.stringify(resolved) !== JSON.stringify(brain)) hooks.onChange?.(resolved, { requiresSwitch: false, field: 'defaults', previous: brain, silent: true });
    render();
  }

  function anchorFor(field, override) {
    if (override) return override;
    const btn = buttons[field];
    if (isRendered(btn)) return btn;
    const fallback = typeof hooks.getMenuAnchor === 'function' ? hooks.getMenuAnchor() : null;
    return fallback || btn || root;
  }

  /**
   * Open a field menu; `anchorOverride` (e.g. the toolbar "⋯") when the inline
   * button is hidden. `restoreFocus`: a pick sends focus back to the anchor.
   */
  async function openField(field, anchorOverride = null, { restoreFocus = false } = {}) {
    const anchor = anchorFor(field, anchorOverride);
    const brain = currentBrain();
    if (field === 'model') {
      // The account rows come from the kept lists; they are read again in the background once loaded.
      if (ACCOUNT_PROVIDERS.has(brain.provider)) {
        if (_warmProviders.has(brain.provider)) ensureLoaded(brain.provider).catch(() => {});
        else await ensureLoaded(brain.provider);
      }
      await openModelMenu(anchor, {
        brain,
        t: hooks.t,
        placement,
        current: { provider: brain.provider, model: brain.model },
        warnSwitch: true,
        accountItems: ACCOUNT_PROVIDERS.has(brain.provider) ? accountItems(brain) : [],
        accountTitle: accountText('menuTitle', {}, accountProvider(brain)),
        onToast: hooks.onToast,
        onManageModels: hooks.onManageModels,
        onSelect: (target) => {
          if (!target?.model) return;
          if (target.provider && target.provider !== brain.provider) switchProvider(target.provider, target.model);
          else commit({ model: target.model, effort: brain.effort }, 'model');
        },
      });
      return;
    }
    // The session's own setting: nothing to load.
    if (field === 'tests') {
      const current = testDensity();
      if (!current) return;
      openMenu(anchor, {
        title: t('assistant.tests.title', 'Test density'),
        items: TEST_DENSITIES.map((id) => ({
          kind: 'radio', id, label: testDensityLabel(id, hooks.t),
          desc: t(`assistant.tests.desc.${id}`, TEST_DENSITY_COPY[id][1]),
          selected: id === current,
          onSelect: () => { hooks.onTestDensity?.(id); render(); },
        })),
        placement, role: 'menu', className: 'asst-tests-menu',
      });
      return;
    }
    // The account menu reads the kept rows and asks again by itself (asst-account-menu.js).
    if (field === 'account') {
      if (!ACCOUNT_PROVIDERS.has(brain.provider)) return;
      if (!_warmProviders.has(brain.provider)) {
        anchor.setAttribute('aria-busy', 'true');
        try { await ensureLoaded(brain.provider); } finally { anchor.removeAttribute('aria-busy'); }
        if (destroyed || !anchor.isConnected) return;
      } else {
        ensureLoaded(brain.provider).catch(() => {});
      }
      // Kept inside the panel that holds the anchor (the sidepanel, or the tab's own root).
      openAccountMenu(anchor, accountMenu(brain, anchor.closest?.('.assistant-panel') || anchor.closest?.('.asst-root') || null));
      return;
    }
    // Everything else needs the provider catalog — load it lazily on first open. Once it is loaded the menu
    // opens from what is kept, the lists are read again in the background, and an open menu they change is
    // redrawn in place (the filter, the scroll and the focus stay).
    const warm = _warmProviders.has(brain.provider);
    if (!warm) {
      anchor.setAttribute('aria-busy', 'true');
      try { await ensureLoaded(brain.provider); } finally { anchor.removeAttribute('aria-busy'); }
      if (destroyed || !anchor.isConnected) return;
    }
    let shown = null;
    drawField(field, brain, (title, items, extra = {}) => {
      const opened = openMenu(anchor, { title, items, placement, role: 'menu', ...extra });
      shown = opened ? { opened, items } : null;
      return opened;
    }, { anchor, restoreFocus });
    if (warm && shown) {
      ensureLoaded(brain.provider).then(() => {
        if (destroyed || !shown || currentMenu() !== shown.opened.el || !anchor.isConnected) return;
        let fresh = null;
        drawField(field, currentBrain(), (_title, items) => { fresh = items; return null; }, { anchor, restoreFocus });
        if (fresh && menuItemsSignature(fresh) !== menuItemsSignature(shown.items)) shown.opened.update({ items: fresh, keepPlace: true });
      }).catch(() => {});
    }
  }

  // The menu of one field, from the lists as they are kept now: `menu(title, items, extra)` opens it (or, for a
  // redraw, only takes the items).
  function drawField(field, brain, menu, { anchor, restoreFocus = false } = {}) {
    if (field === 'effort') {
      if (brain.provider === 'opencode') {
        const agents = getCachedOpencodeAgents();
        const items = [{ kind: 'radio', id: '', label: t('assistant.brain.agentDefault', 'default'), selected: !brain.agent, onSelect: () => commit({ agent: null }, 'agent') }];
        for (const a of agents) {
          const name = agentName(a);
          items.push({ kind: 'radio', id: name, label: name, desc: a?.description || a?.mode || '', selected: name === brain.agent, onSelect: () => commit({ agent: name }, 'agent') });
        }
        menu(t('assistant.brain.agent', 'OpenCode agent'), items);
        return;
      }
      const efforts = effortsFor(brain);
      menu(t('assistant.brain.effort', 'Thinking effort'), efforts.map((e) => ({
        kind: 'radio', id: e.id, label: e.label, desc: e.desc || '',
        selected: (e.id === 'off' ? !brain.effort : e.id === brain.effort),
        onSelect: () => commit({ effort: e.id === 'off' ? null : e.id }, 'effort'),
      })));
      return;
    }

    if (field === 'variant') {
      const efforts = effortsFor(brain);
      menu(t('assistant.brain.variant', 'Model variant'), efforts.map((e) => ({
        kind: 'radio', id: e.id, label: e.id === 'off' ? t('assistant.brain.variantDefault', 'default variant') : e.label, desc: e.desc || '',
        selected: (e.id === 'off' ? !brain.effort : e.id === brain.effort),
        onSelect: () => commit({ effort: e.id === 'off' ? null : e.id }, 'variant'),
      })));
      return;
    }

    if (field === 'project') {
      const actor = anchor === heroProject ? heroProjectMascot : null;
      const pick = project => {
        const changed = (currentBrain().project || null) !== (project || null);
        commit({ project }, 'project');
        actor?.commit(changed ? 'hop' : 'nod');
      };
      const projects = _projectsCache || [];
      const items = [{ kind: 'radio', id: '', label: t('assistant.brain.projectNone', 'Home directory'), desc: t('assistant.brain.projectNoneDesc', 'no project'), selected: !brain.project, restoreFocus, onSelect: () => pick(null) }];
      for (const p of projects) items.push({ kind: 'radio', id: p.path, label: p.label || basename(p.path), desc: p.path, selected: p.path === brain.project, restoreFocus, onSelect: () => pick(p.path) });
      items.push({ kind: 'separator' });
      items.push({ kind: 'input', placeholder: t('assistant.brain.projectCustom', 'Type a directory path…'), value: brain.project && !projects.some(p => p.path === brain.project) ? brain.project : '', restoreFocus, onSubmit: pick });
      menu(t('assistant.brain.project', 'Working project'), items, { width: 280, filter: projects.length > 8, filterPlaceholder: t('assistant.brain.filterProjects', 'Filter projects…'), onOpen: node => actor?.open(node), onClose: () => actor?.close() });
      return;
    }

    if (field === 'mcp') {
      const presets = getCachedMcpProfilePresets();
      const items = Object.entries(presets).map(([id, preset]) => ({
        kind: 'radio',
        id,
        label: preset?.label || id,
        desc: preset?.description || '',
        tag: preset?.tools != null ? `${preset.tools} ${t('assistant.brain.tools', 'tools')}` : '',
        selected: id === brain.mcpProfile,
        onSelect: () => commit({ mcpProfile: id }, 'mcp'),
      }));
      menu(t('assistant.brain.mcp', 'MCP tool profile'), items);
      return;
    }

    if (field === 'mode') {
      const modes = PERMISSION_MODES[brain.provider] || PERMISSION_MODES['claude-code'];
      // Plan mode is its own switch: it combines with every approval mode below.
      const items = PLAN_MODE_PROVIDERS.has(brain.provider) ? [
        {
          kind: 'check', id: 'plan', label: t('assistant.brain.modes.plan', 'Plan'),
          desc: t(`assistant.brain.planDesc.${brain.provider}`, PLAN_DESC[brain.provider] || ''),
          checked: brain.planMode === true,
          onSelect: () => commit({ planMode: brain.planMode !== true }, 'mode'),
        },
        { kind: 'separator' },
        { kind: 'header', label: t('assistant.brain.approvals', 'Approvals') },
      ] : [];
      for (const m of modes) {
        items.push({
          kind: 'radio', id: m.id, label: t(`assistant.brain.modes.${m.id}`, m.label),
          selected: m.id === brain.permissionMode,
          onSelect: () => commit({ permissionMode: m.id }, 'mode'),
        });
      }
      // The global Admin sandbox switch (every agent SynaBun starts, not this conversation), under its own header.
      const adminSandbox = adminSandboxItem();
      if (adminSandbox) items.push({ kind: 'separator' }, { kind: 'header', label: t('assistant.adminSandbox.group', 'Every agent') }, adminSandbox);
      menu(t('assistant.brain.mode', 'Permission mode'), items);
    }
  }

  // The cog's account menu (asst-account-menu.js): every account once, the conversation's and the
  // workers' choice, kept inside `bounds`. What each choice does is the same as the composer's.
  function accountMenu(brain, bounds) {
    const codex = brain.provider === 'codex';
    const refetch = () => (codex ? fetchCodexAccounts(true) : fetchClaudeAccounts(true));
    return {
      provider: codex ? 'codex' : 'claude',
      t: hooks.t,
      placement,
      bounds,
      read: () => ({
        accounts: codex ? getCachedCodexAccounts() : getCachedClaudeAccounts(),
        currentId: currentBrain().accountId,
        workerId: codex ? getCodexWorkerAccountId() : getClaudeWorkerAccountId(),
        running: hooks.getRunning?.() === true,
      }),
      onAuto: () => commit({ accountId: 'auto' }, 'account'),
      onPick: (id) => commit({ accountId: id }, 'account'),
      onSetWorker: async (id) => { await (codex ? setCodexWorkerAccount : setClaudeWorkerAccount)(id); await refetch(); render(); },
      onSetMode: async (id, mode) => {
        const before = currentBrain();
        try {
          await (codex ? patchCodexAccount : patchClaudeAccount)(id, { mode }); await refetch();
          hooks.onChange?.(currentBrain(), { requiresSwitch: true, restartBrain: true, field: 'accountMode', previous: before }); render();
        }
        catch (err) { hooks.onToast?.(err?.message || String(err)); }
      },
      onAdd: () => hooks.onAddAccount?.(brain.provider),
      onManage: (id) => (id ? hooks.onManageAccounts?.(brain.provider, id) : hooks.onManageAccounts?.(brain.provider)),
      onError: (err) => hooks.onToast?.(err?.message || String(err)),
    };
  }

  // The composer's Model menu lists the brain's accounts too (Claude or Codex), as the cog's account menu
  // does (asst-account-menu.js): Auto, every account once (a signed-out one opens its sign-in), the Uses
  // switch of an account holding both credentials, Add account… and Manage….
  function accountItems(brain) {
    const codex = brain.provider === 'codex';
    const p = codex ? 'codex' : 'claude';
    const accounts = codex ? getCachedCodexAccounts() : getCachedClaudeAccounts();
    const refetch = () => (codex ? fetchCodexAccounts(true) : fetchClaudeAccounts(true));
    const items = accountChoiceItems({
      t: hooks.t,
      rows: accounts.map((a) => accountMenuRow(a, { provider: p, t: hooks.t })),
      currentId: brain.accountId,
      onAuto: () => commit({ accountId: 'auto' }, 'account'),
      onPick: (id) => commit({ accountId: id }, 'account'),
      onSignIn: (id) => hooks.onManageAccounts?.(brain.provider, id),
    });
    const uses = accountModeItem({
      provider: p, t: hooks.t, account: accounts.find((a) => a.id === brain.accountId), running: hooks.getRunning?.() === true,
      onSetMode: async (id, mode) => {
        try {
          await (codex ? patchCodexAccount : patchClaudeAccount)(id, { mode }); await refetch();
          hooks.onChange?.(currentBrain(), { requiresSwitch: true, restartBrain: true, field: 'accountMode', previous: brain }); render();
        }
        catch (err) { hooks.onToast?.(err?.message || String(err)); }
      },
    });
    if (uses) items.push(uses);
    items.push(accountManageItem({ t: hooks.t, onAdd: () => hooks.onAddAccount?.(brain.provider), onManage: () => hooks.onManageAccounts?.(brain.provider) }));
    return items;
  }

  async function switchProvider(provider, model = '') {
    const before = currentBrain();
    if (provider === before.provider) return;
    await ensureLoaded(provider);
    if (destroyed) return;
    const draft = { ...before, provider, model: model || '', effort: null, agent: null, accountId: null };
    // resolveBrainDefaults reads the new provider's catalog.
    const next = resolveBrainDefaults(draft, {
      models: { [provider]: resolvableModels(provider, draft.model) },
      efforts: { [provider]: effortsFor(normalizeBrain(draft)) },
      accounts: { 'claude-code': getCachedClaudeAccounts(), codex: getCachedCodexAccounts() },
      agents: getCachedOpencodeAgents(),
      mcpProfiles: getCachedMcpProfilePresets(),
      defaultMcpProfile: 'full',
      projects: _projectsCache || [],
    });
    if (model && !next.model) next.model = model;
    hooks.onChange?.(next, { requiresSwitch: true, field: 'provider', previous: before });
    render();
  }

  render();
  refresh().catch(() => {});
  // Any window changed a Claude or Codex account (signed in or out, a key, its mode, the worker choice,
  // added, removed): its list is read again and the picker re-drawn, so it never shows a stale state.
  const accountsChanged = (provider) => (msg) => {
    const which = provider || (msg?.provider === 'codex' ? 'codex' : msg?.provider === 'claude-code' ? 'claude-code' : null);
    const jobs = [];
    if (!which || which === 'claude-code') jobs.push(fetchClaudeAccounts(true));
    if (!which || which === 'codex') jobs.push(fetchCodexAccounts(true));
    Promise.all(jobs).then(() => { if (!destroyed) render(); }).catch(() => {});
  };
  const offAccounts = [on('sync:claude:accounts-changed', accountsChanged('claude-code')), on('sync:codex:accounts-changed', accountsChanged('codex')), on('sync:assistant:accounts-changed', accountsChanged(null))];

  return {
    el: root,
    buttons,
    render,
    refresh,
    snapshot,
    openField,
    fieldSummary,
    modelLabel: () => modelLabel(),
    mountEmptyProject,
    setBrain() { render(); },
    close: closeMenu,
    destroy() { destroyed = true; fitObserver?.disconnect(); if (fitFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(fitFrame); for (const off of offAccounts) { try { off?.(); } catch {} } closeMenu(); heroProjectMascot?.destroy(); Object.values(buttons).forEach((b) => b.remove()); heroProject?.remove(); heroProject = null; root.remove(); },
  };
}

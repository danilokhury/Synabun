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
  getEffortLevelsForModel,
  getModelsForProfile,
  modelEffortIds,
  modelSelectorValue,
} from '../agent-runtime-options.js';
import { getHiddenModels, HIDDEN_MODELS_EVENT, hiddenModelMatch } from '../ocp-hidden-models.js';
import { getProviderMeta } from '../provider-icons.js';
import { on } from '../state.js';
import { fetchAssistantCatalog, fetchProjects } from './asst-api.js';
import { closeMenu, isMenuOpen, openMenu } from './asst-menu.js';
import {
  ACCOUNT_PROVIDERS,
  brainRequiresSwitch,
  modelShortName,
  normalizeBrain,
  PERMISSION_MODES,
  PLAN_MODE_PROVIDERS,
  permissionModeLabel,
  PROVIDERS,
  resolveBrainDefaults,
} from './asst-state.js';

let _projectsCache = null;

const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/></svg>';
const ICON_PLUG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>';
// The gauge is centred in its 24 box: arc and needle span y 8–16 (7–17 with the stroke).
const ICON_EFFORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16a8 8 0 1 1 16 0"/><path d="m12 16 4-5"/></svg>';
const ICON_AGENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>';
export const ICON_ACCOUNT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
/** Dropdown caret shared by every toolbar dropdown (fields, route mode). */
export const ICON_CARET = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.75 5 6.25l2.5-2.5"/></svg>';

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
  for (const provider of PROVIDERS) {
    const list = Array.isArray(remote?.hidden?.[provider]) ? remote.hidden[provider] : [];
    out[provider] = new Set(list.map(id => String(id).toLowerCase()));
  }
  out.opencode = new Set([...(out.opencode || []), ...hiddenOpencodeIds(remote)]);
  return out;
}

/**
 * The hidden id `id` names for `provider`, else null. Claude Code / Codex: the
 * id, or the model it resolves to at the same context window ("opus[1m]" →
 * "claude-opus-5-5[1m]"); "opus" and "opus[1m]" hide independently. OpenCode:
 * full or bare id (this window's Settings → OpenCode mirror counts too).
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
  return key && key !== want && list.has(key) ? key : null;
}

/**
 * { 'claude-code': [...], codex: [...], opencode: [...] } — the runtime option
 * lists the sidepanels use, enriched with tier/vision/price from
 * GET /api/assistant/catalog (which alone is used when a local list is empty).
 * Models the user hid (Assistant → Models, and Settings → OpenCode for
 * OpenCode) never appear, from either list.
 */
export async function loadModelCatalog({ force = false } = {}) {
  if (!force && _catalog && Date.now() - _catalogAt < CATALOG_TTL_MS) return _catalog;
  if (_catalogLoading) return _catalogLoading;
  _catalogLoading = (async () => {
    const [remote] = await Promise.all([
      fetchAssistantCatalog().catch(() => null),
      ...PROVIDERS.map(p => Promise.resolve(ensureModelsForProfile(p, force)).catch(() => [])),
    ]);
    const out = {};
    // No catalog (request failed): the last known disabled lists still apply.
    const sets = remote ? hiddenSets(remote) : { ..._hidden, opencode: new Set([...(_hidden.opencode || []), ...hiddenOpencodeIds(null)]) };
    _hidden = sets;
    for (const provider of PROVIDERS) {
      const remoteList = Array.isArray(remote?.models?.[provider]) ? remote.models[provider] : [];
      const byId = new Map(remoteList.filter(m => m?.id).map(m => [String(m.id), m]));
      const local = getModelsForProfile(provider) || [];
      const source = local.length ? local : remoteList;
      const seen = new Set();
      out[provider] = source.map(m => normalizeCatalogModel(m, byId.get(String(m?.id)) || {})).filter((m) => {
        if (!m || seen.has(m.id)) return false;
        const extra = byId.get(String(m.id)) || {};
        if (hiddenModelFor(provider, m.id, { resolved: extra.upstream || m.resolvedModel || null, sets })) return false;
        seen.add(m.id);
        return true;
      });
      // Context variants ("opus[1m]", "gpt-x[extended]") the local list lacks: the
      // catalog lists every one, each right after its base model.
      if (provider !== 'opencode' && source !== remoteList) {
        for (const r of remoteList) {
          if (!/\[(1m|extended)\]$/i.test(String(r?.id || '')) || seen.has(String(r.id))) continue;
          if (hiddenModelFor(provider, r.id, { resolved: r.upstream || null, sets })) continue;
          const m = normalizeCatalogModel(r, r);
          if (!m) continue;
          seen.add(m.id);
          const base = String(r.id).replace(/\[(1m|extended)\]$/i, '');
          const at = out[provider].findIndex(x => x.id === base);
          if (at >= 0) out[provider].splice(at + 1, 0, m); else out[provider].push(m);
        }
      }
    }
    _catalog = out;
    // Built without the server's catalog: not cached, the next open asks again.
    _catalogAt = remote ? Date.now() : 0;
    _catalogPartial = !remote;
    return out;
  })().finally(() => { _catalogLoading = null; });
  return _catalogLoading;
}

/** The last loadModelCatalog() result, synchronously (null before the first load). */
export function cachedModelCatalog() { return _catalog; }

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

// A Settings → OpenCode checkbox or an Assistant → Models toggle (this window, or another via sync).
if (typeof document !== 'undefined') document.addEventListener(HIDDEN_MODELS_EVENT, invalidateModelCatalog);
on('sync:opencode:hidden-models-changed', invalidateModelCatalog);
on('sync:assistant:hidden-models-changed', invalidateModelCatalog);

function sameModel(selected, m) {
  if (!selected) return false;
  return selected === m.id || selected === m.selector;
}

function modelDesc(m, tr) {
  return [
    m.ctxLabel, m.desc, fmtModelPrice(m.price), m.vision === true ? tr('assistant.brain.vision', 'vision') : '',
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
 *         passes), allowCustom (default true), zIndex (see asst-menu.js) }
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
  anchor.setAttribute('aria-busy', 'true');
  let catalog = {};
  try { catalog = await loadModelCatalog(); } catch { catalog = {}; } finally { anchor.removeAttribute('aria-busy'); }
  if (!anchor.isConnected) return null;
  const items = [];
  if (includeHere) {
    items.push({ kind: 'radio', id: '__here', label: hereLabel || tr('assistant.routes.brainDecides', 'Let the brain decide'), selected: !current, onSelect: () => onSelect?.({ here: true }) });
  }
  const list = Array.isArray(providers) && providers.length ? PROVIDERS.filter(p => providers.includes(p)) : PROVIDERS;
  let listed = 0;
  for (const provider of list) {
    const models = (catalog[provider] || []).filter(m => typeof accept !== 'function' || accept(provider, m));
    if (!models.length) continue;
    listed += models.length;
    const meta = getProviderMeta(provider);
    const note = warnSwitch && provider !== b.provider ? tr('assistant.brain.newConversation', 'starts a new conversation') : '';
    items.push({ kind: 'header', label: meta.label, icon: meta.icon, color: meta.color, note });
    for (const m of models) {
      items.push({
        kind: 'radio',
        id: `${provider}:${m.id}`,
        label: m.label,
        desc: modelDesc(m, tr),
        tag: tierTag(m, tr),
        keywords: `${meta.label} ${m.id}`,
        selected: !!current && current.provider === provider && sameModel(current.model, m),
        onSelect: () => onSelect?.({ provider, model: m.id, label: m.label, tier: m.tier || null, vision: m.vision ?? null, outputs: m.outputs || null, efforts: m.efforts || null, price: m.price || null }),
      });
    }
  }
  // Nothing passes the filter (e.g. no model makes video yet): say so instead of an empty list.
  if (!listed && typeof accept === 'function' && emptyLabel) items.push({ kind: 'info', label: emptyLabel });
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
  if (typeof opts.onManageModels === 'function') {
    items.push({ id: '__manage_models', label: tr('assistant.models.manage', 'Manage models…'), onSelect: () => opts.onManageModels() });
  }
  return openMenu(anchor, {
    title: title || tr('assistant.brain.model', 'Model'),
    items,
    filter: true,
    filterPlaceholder: tr('assistant.brain.filterModels', 'Filter models…'),
    placement,
    width: 300,
    role: 'menu',
    className: 'asst-model-menu',
    zIndex: opts.zIndex ?? null,
  });
}

// ── Picker ──────────────────────────────────────────────────────────────────

// Creation order is DOM order within a slot: model · effort · variant · mode · account in the composer.
// `effort` is the OpenCode agent for OpenCode; `variant` is OpenCode's effort (the model's variants).
const FIELDS = ['model', 'effort', 'variant', 'mode', 'account', 'project', 'mcp'];
// Slot of each field: the composer row (the brain and how it acts) · the toolbar (where it works).
const FIELD_GROUP = { model: 'brain', effort: 'brain', variant: 'brain', mode: 'brain', account: 'brain', project: 'context', mcp: 'context' };

/**
 * createBrainPicker(host, hooks) — `host` is either one element (all fields in
 * an `.asst-brain` wrapper) or `{ brain, context }` toolbar groups.
 * hooks: { t, getBrain() → brain, onChange(nextBrain, { requiresSwitch, field }),
 *          onAddAccount(provider), onManageAccounts(provider), onToast(text),
 *          getMenuAnchor() → fallback anchor (the toolbar "⋯"),
 *          menuPlacement: 'below' (default) | 'above' | 'auto' }
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

  function accountLabel(brain) {
    const acc = accountOf(brain);
    return acc ? (acc.label || acc.email || acc.id) : (brain.accountId || t('assistant.brain.accountDefault', 'Default'));
  }

  function modelLabel(brain = currentBrain()) {
    const model = modelOf(brain);
    return model ? (model.label || modelShortName(model.id)) : (brain.model ? modelShortName(brain.model) : t('assistant.brain.modelDefault', 'Default model'));
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
      project: brain.project ? basename(brain.project) : t('assistant.brain.projectHome', 'Home'),
      mode: permissionModeLabel(brain, (id, fallback) => t(`assistant.brain.modes.${id}`, fallback)),
      mcp: presets[brain.mcpProfile]?.label || brain.mcpProfile || 'full',
      account: ACCOUNT_PROVIDERS.has(brain.provider) ? accountLabel(brain) : '',
    };
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

  function render() {
    if (destroyed) return;
    const brain = currentBrain();
    const v = values(brain);
    const modelTip = [v.meta.label, brain.model || t('assistant.brain.modelDefault', 'Default model'), v.account ? t('assistant.brain.asAccount', 'as {account}', { account: v.account }) : ''].filter(Boolean).join(' · ');
    setBtn('model', { label: v.model, icon: v.meta.icon, color: v.meta.color, tooltip: modelTip, aria: `${t('assistant.brain.model', 'Model')}: ${modelTip}` });
    // A display name ("Sonnet 5") reads in sans; a raw id nothing names ("opus[1m]") stays mono.
    buttons.model?.toggleAttribute('data-raw', /^[a-z0-9][\w.\-[\]:/]*$/.test(String(v.model || '')));

    if (brain.provider === 'opencode') {
      setBtn('effort', { label: v.effort, icon: ICON_AGENT, tooltip: `${t('assistant.brain.agent', 'OpenCode agent')}: ${v.effort}` });
    } else {
      setBtn('effort', { label: v.effort, icon: ICON_EFFORT, hidden: !v.effortSupported, tooltip: `${t('assistant.brain.effort', 'Thinking effort')}: ${v.effort}` });
    }
    setBtn('variant', { label: v.variant, icon: ICON_EFFORT, hidden: !v.variantSupported, tooltip: `${t('assistant.brain.variant', 'Model variant')}: ${v.variant}` });
    // Inline only when there is a choice to make; the "⋯" menu always has it (add / manage).
    const accountChoices = ACCOUNT_PROVIDERS.has(brain.provider) ? (brain.provider === 'codex' ? getCachedCodexAccounts() : getCachedClaudeAccounts()).length : 0;
    setBtn('account', { label: v.account, icon: ICON_ACCOUNT, hidden: accountChoices < 2, tooltip: `${t('assistant.brain.account', 'Account profile')}: ${v.account}` });
    setBtn('project', { label: v.project, icon: ICON_FOLDER, tooltip: brain.project || t('assistant.brain.projectNoneTip', 'Working project: home directory'), aria: `${t('assistant.brain.project', 'Working project')}: ${brain.project || v.project}` });
    setBtn('mode', { label: v.mode, icon: ICON_SHIELD, tooltip: `${t('assistant.brain.mode', 'Permission mode')}: ${v.mode}` });
    setBtn('mcp', { label: v.mcp, icon: ICON_PLUG, tooltip: `${t('assistant.brain.mcp', 'MCP tool profile')}: ${v.mcp}` });
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
      { field: 'mcp', label: t('assistant.brain.mcp', 'MCP tool profile'), value: v.mcp, icon: ICON_PLUG, hidden: false },
      { field: 'account', label: t('assistant.brain.account', 'Account profile'), value: v.account, icon: ICON_ACCOUNT, hidden: !ACCOUNT_PROVIDERS.has(brain.provider) },
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
    if (!_projectsCache || force) jobs.push(fetchProjects().then((p) => { _projectsCache = p; }).catch(() => { _projectsCache = _projectsCache || []; }));
    await Promise.allSettled(jobs);
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

  /** Open a field menu; `anchorOverride` (e.g. the toolbar "⋯") when the inline button is hidden. */
  async function openField(field, anchorOverride = null) {
    const anchor = anchorFor(field, anchorOverride);
    const brain = currentBrain();
    if (field === 'model') {
      await openModelMenu(anchor, {
        brain,
        t: hooks.t,
        placement,
        current: { provider: brain.provider, model: brain.model },
        warnSwitch: true,
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
    // Everything else needs the provider catalog — load it lazily on first open.
    anchor.setAttribute('aria-busy', 'true');
    try { await ensureLoaded(brain.provider); } finally { anchor.removeAttribute('aria-busy'); }
    if (destroyed || !anchor.isConnected) return;
    const menu = (title, items, extra = {}) => openMenu(anchor, { title, items, placement, role: 'menu', ...extra });

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

    if (field === 'account') {
      if (!ACCOUNT_PROVIDERS.has(brain.provider)) return;
      const accounts = brain.provider === 'codex' ? getCachedCodexAccounts() : getCachedClaudeAccounts();
      const items = accounts.map((a) => ({
        kind: 'radio',
        id: a.id,
        label: a.label || a.email || a.id,
        desc: a.email && a.email !== a.label ? a.email : (a.isDefault ? t('assistant.accounts.ambient', 'ambient config') : ''),
        selected: a.id === brain.accountId,
        onSelect: () => commit({ accountId: a.id }, 'account'),
      }));
      items.push({ kind: 'separator' });
      items.push({ id: '__add', label: t('assistant.accounts.add', 'Add account…'), onSelect: () => hooks.onAddAccount?.(brain.provider) });
      items.push({ id: '__manage', label: t('assistant.accounts.manage', 'Manage…'), onSelect: () => hooks.onManageAccounts?.(brain.provider) });
      menu(t('assistant.brain.account', 'Account profile'), items);
      return;
    }

    if (field === 'project') {
      const projects = _projectsCache || [];
      const items = [{ kind: 'radio', id: '', label: t('assistant.brain.projectNone', 'Home directory'), desc: t('assistant.brain.projectNoneDesc', 'no project'), selected: !brain.project, onSelect: () => commit({ project: null }, 'project') }];
      for (const p of projects) items.push({ kind: 'radio', id: p.path, label: p.label || basename(p.path), desc: p.path, selected: p.path === brain.project, onSelect: () => commit({ project: p.path }, 'project') });
      items.push({ kind: 'separator' });
      items.push({ kind: 'input', placeholder: t('assistant.brain.projectCustom', 'Type a directory path…'), value: brain.project && !projects.some(p => p.path === brain.project) ? brain.project : '', onSubmit: (v) => commit({ project: v }, 'project') });
      menu(t('assistant.brain.project', 'Working project'), items, { width: 280, filter: projects.length > 8, filterPlaceholder: t('assistant.brain.filterProjects', 'Filter projects…') });
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
      menu(t('assistant.brain.mode', 'Permission mode'), items);
    }
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

  return {
    el: root,
    buttons,
    render,
    refresh,
    snapshot,
    openField,
    fieldSummary,
    modelLabel: () => modelLabel(),
    setBrain() { render(); },
    close: closeMenu,
    destroy() { destroyed = true; closeMenu(); Object.values(buttons).forEach((b) => b.remove()); root.remove(); },
  };
}

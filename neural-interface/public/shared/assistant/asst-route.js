// ═══════════════════════════════════════════
// SynaBun Assistant — model routing UI
// ═══════════════════════════════════════════
// The assistant's brain decides where each task runs (here, a dispatched
// agent, the computer). This module renders that decision:
//   · createRouteModeControl — toolbar chip: Always ask / Ask when unsure / Never ask
//   · renderRouteCard        — the route card (control_request subtype 'route')
//   · createRouteLine        — the compact "⇄ code → Sonnet 5 · high · 86%" transcript line
//   · openRoutesEditor       — "Model routes…" modal (per task-class preferences)
// normalizeRouteRequest / routeOptions / buildRouteResponse / routeLineParts
// are pure (node:test covers them); nothing touches `document` at import time.
//
// Wire contract: answer = control_response { kind:'route', optionId, target?,
// remember, decline? }; "Other…" sends optionId:'other' + target. Invalid
// answers come back as { type:'error', code:'ROUTE_INVALID' } — the card stays
// open. `synabun.route` events (phase card|auto|decided|pending|expired|
// declined|cancelled) update the line in place by routeId.

import { clampEffortId, getEffortLevelsForModel, modelEffortIds } from '../agent-runtime-options.js';
import { getProviderMeta } from '../provider-icons.js';
import { fetchManageCatalog, getRouting, patchHiddenModels, putRouting } from './asst-api.js';
import { catalogModelRow, fmtModelPrice, hiddenModelFor, ICON_CARET, invalidateModelCatalog, loadModelCatalog, openModelMenu } from './asst-brain-picker.js';
import { closeMenu, isMenuOpen, openMenu } from './asst-menu.js';
import { decorateControlHead } from './asst-control.js';
import {
  DEFAULT_ROUTE_MODE,
  fmtConfidence,
  normalizeBrain,
  normalizeProvider,
  normalizeRouteMode,
  ROUTE_MODES,
  routeKindLabel,
  routeTargetLabel,
} from './asst-state.js';

function str(v) { return v == null ? '' : String(v).trim(); }
function num(v) { const n = Number(v); return v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(n) ? n : null; }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function firstStr(...values) { for (const v of values) { const s = str(v); if (s) return s; } return ''; }

/** Local translator: hooks.t when it resolves, else the fallback with {param} interpolation. */
function tf(t) {
  return (key, fallback, params) => {
    const v = typeof t === 'function' ? t(key, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };
}

function humanizeClass(value) {
  const s = str(value).replace(/[_-]+/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : 'General';
}

// ── Mode labels ─────────────────────────────────────────────────────────────

export function routeModeLabel(mode, t) {
  const tr = tf(t);
  const m = normalizeRouteMode(mode, DEFAULT_ROUTE_MODE);
  if (m === 'always-ask') return tr('assistant.routes.mode.always', 'Always ask');
  if (m === 'never') return tr('assistant.routes.mode.never', 'Never ask');
  return tr('assistant.routes.mode.unsure', 'Ask when unsure');
}

export function routeModeDescription(mode, model, t) {
  const tr = tf(t);
  const who = str(model) || tr('assistant.routes.theBrain', 'The assistant');
  const m = normalizeRouteMode(mode, DEFAULT_ROUTE_MODE);
  if (m === 'always-ask') return tr('assistant.routes.mode.alwaysDesc', 'Show the route card before every task.');
  if (m === 'never') return tr('assistant.routes.mode.neverDesc', '{model} sorts each request; your task routes apply without asking.', { model: who });
  return tr('assistant.routes.mode.unsureDesc', '{model} routes on its own when confident, asks otherwise.', { model: who });
}

// ── Pure model ──────────────────────────────────────────────────────────────

function priceOf(p) {
  const o = obj(p);
  if (!o) return null;
  const input = num(o.input);
  const output = num(o.output);
  if (input == null && output == null) return null;
  return { input, output, unit: str(o.unit) || null };
}

function normalizeRouteOption(o) {
  const src = obj(o);
  if (!src) return null;
  const id = str(src.id);
  if (!id) return null;
  return {
    id,
    kind: str(src.kind) || 'direct',
    provider: normalizeProvider(src.provider, str(src.provider) || null),
    model: str(src.model),
    effort: str(src.effort) || null,
    label: str(src.label),
    badge: str(src.badge) || null,
    tier: str(src.tier) || null,
    vision: src.vision === true,
    price: priceOf(src.price),
    contextWindow: num(src.contextWindow),
    reason: str(src.reason),
    warning: str(src.warning) || null,
    disabled: src.disabled === true,
    disabledReason: str(src.disabledReason) || null,
  };
}

/** Normalize a route control packet (or its `request`) into the card model. */
export function normalizeRouteRequest(packet) {
  const p = obj(packet);
  if (!p) return null;
  const req = obj(p.request) || p;
  const requestId = firstStr(p.request_id, p.requestId, req.request_id, req.requestId);
  const routeId = firstStr(req.routeId, req.route_id, p.routeId) || requestId;
  if (!requestId && !routeId) return null;
  const brain = obj(req.brain) || {};
  const other = obj(req.other) || {};
  const remember = obj(req.remember) || {};
  const decline = obj(req.decline) || {};
  return {
    requestId: requestId || routeId,
    routeId,
    origin: str(req.origin) || 'agent_route',
    runIds: arr(req.runIds).map(String).filter(Boolean),
    workflowId: str(req.workflowId) || null,
    sessionId: str(req.sessionId) || null,
    mode: normalizeRouteMode(req.mode, null),
    reasons: arr(req.reasons).map(String).filter(Boolean),
    taskClass: str(req.taskClass) || 'general',
    taskClassLabel: str(req.taskClassLabel) || humanizeClass(req.taskClass),
    summary: str(req.summary),
    confidence: num(req.confidence),
    needsVision: req.needsVision === true,
    // Image / video creation: the medium the model must generate ('image' | 'video'), always on a worker.
    requires: req.requires === 'image' || req.requires === 'video' ? req.requires : null,
    dispatchOnly: req.dispatchOnly === true,
    // Design: only models that can see.
    visionOnly: req.visionOnly === true,
    brain: {
      provider: normalizeProvider(brain.provider, str(brain.provider) || null),
      model: str(brain.model),
      label: str(brain.label),
      vision: brain.vision === true,
    },
    options: arr(req.options).map(normalizeRouteOption).filter(Boolean),
    defaultOptionId: str(req.defaultOptionId) || null,
    other: {
      allowed: other.allowed !== false,
      providers: arr(other.providers).map(String),
      catalogPath: str(other.catalogPath) || '/api/assistant/catalog',
    },
    remember: {
      available: remember.available === true,
      taskClass: str(remember.taskClass) || str(req.taskClass) || null,
      label: str(remember.label),
      current: remember.current == null ? null : str(remember.current),
    },
    decline: { allowed: decline.allowed !== false, label: str(decline.label) },
    // A WhatsApp conversation at Ask: approving this option also lets the assistant control the Mac for the task.
    computer: obj(req.computer) && str(req.computer.optionId) ? { optionId: str(req.computer.optionId) } : null,
    createdAt: req.createdAt || null,
    expiresAt: req.expiresAt || null,
  };
}

function modelKey(model) {
  return str(model).toLowerCase().replace(/:\d+$/, '');
}

/** Same destination: kind + provider + model + effort. */
export function sameRouteTarget(a, b) {
  if (!a || !b) return false;
  return (str(a.kind) || 'direct') === (str(b.kind) || 'direct')
    && str(a.provider) === str(b.provider)
    && modelKey(a.model) === modelKey(b.model)
    && (str(a.effort) || '') === (str(b.effort) || '');
}

const BADGE_RANK = { suggested: 0, remembered: 1, current: 2, capable: 3, cheaper: 4, stronger: 5 };

/** "images" / "videos" for an image / video creation class. */
function mediumWords(medium, tr) {
  return medium === 'video' ? tr('assistant.routes.medium.videos', 'videos') : tr('assistant.routes.medium.images', 'images');
}

function reasonLabel(reason, tr, medium = null) {
  switch (reason) {
    case 'always-ask': return tr('assistant.routes.reason.always', 'you asked to confirm routes');
    case 'low_confidence': return tr('assistant.routes.reason.lowConfidence', 'low confidence');
    case 'model_missing': return tr('assistant.routes.reason.modelMissing', 'model unavailable');
    case 'model_unknown': return tr('assistant.routes.reason.modelUnknown', 'unknown model');
    case 'model_disabled': return tr('assistant.routes.reason.modelDisabled', 'model disabled in OpenCode settings');
    case 'needs_vision': return tr('assistant.routes.reason.needsVision', 'needs vision');
    case 'needs_output': return tr('assistant.routes.reason.needsOutput', 'needs a model that makes {medium}', { medium: mediumWords(medium, tr) });
    case 'no_capable_model': return tr('assistant.routes.reason.noCapableModel', 'no model can make this');
    default: return str(reason).replace(/[_-]+/g, ' ');
  }
}

export function routeReasonLabels(n, t) {
  const tr = tf(t);
  return arr(n?.reasons).map(r => reasonLabel(r, tr, n?.requires)).filter(Boolean);
}

function badgeText(o, n, tr) {
  const pct = fmtConfidence(n?.confidence);
  switch (o.badge) {
    case 'suggested': return pct ? tr('assistant.routes.badge.suggestedPct', 'Suggested · {pct}', { pct }) : tr('assistant.routes.badge.suggested', 'Suggested');
    case 'remembered': return tr('assistant.routes.badge.remembered', 'Remembered');
    case 'current': return tr('assistant.routes.badge.current', 'Current');
    case 'capable':
      if (!n?.requires && n?.visionOnly) return tr('assistant.routes.badge.canSee', 'Can see');
      return n?.requires === 'video' ? tr('assistant.routes.badge.makesVideo', 'Makes video') : tr('assistant.routes.badge.makesImages', 'Makes images');
    case 'cheaper': return tr('assistant.routes.badge.cheaper', 'Cheaper');
    case 'stronger': return tr('assistant.routes.badge.stronger', 'Stronger');
    default: return o.badge ? humanizeClass(o.badge) : '';
  }
}

/**
 * Display options for the card: the default (suggested) first and preselected,
 * then "Do it here with ‹current model›", remembered, cheaper, stronger.
 * An option identical to the "here" option replaces it (keeping its badge);
 * identical targets are listed once.
 */
export function routeOptions(n, { brainLabel = '', t = null } = {}) {
  if (!n) return [];
  const tr = tf(t);
  let options = n.options.map(o => ({ ...o }));
  let defaultId = n.defaultOptionId;
  const here = options.find(o => o.id === 'here');
  if (here) {
    const dup = options.find(o => o !== here && o.kind === 'direct' && sameRouteTarget(o, here));
    if (dup) {
      dup.isHere = true;
      options = options.filter(o => o !== here);
      if (defaultId === 'here') defaultId = dup.id;
    }
  }
  const kept = [];
  for (const o of options) {
    const twin = kept.find(k => sameRouteTarget(k, o));
    if (twin) {
      if (defaultId === o.id) defaultId = twin.id;
      if (o.id === 'here') twin.isHere = true;
      continue;
    }
    kept.push(o);
  }
  // A direct option on the brain's own model is "here" too (the server drops the
  // separate 'here' option when a suggestion already targets it).
  const brainProvider = str(n.brain?.provider);
  for (const o of kept) {
    if (!o.isHere && o.id !== 'here' && o.kind === 'direct' && brainProvider && o.provider === brainProvider
      && modelKey(o.model) === modelKey(n.brain?.model)) o.isHere = true;
  }
  const rank = (o) => (o.id === defaultId ? -2 : (o.id === 'here' || o.isHere) ? -1 : (BADGE_RANK[o.badge] ?? 9));
  kept.sort((a, b) => rank(a) - rank(b));
  if (!kept.some(o => o.id === defaultId && !o.disabled)) defaultId = kept.find(o => !o.disabled)?.id || null;
  const hereModel = brainLabel || routeTargetLabel(n.brain) || tr('assistant.routes.currentModel', 'the current model');
  return kept.map((o, i) => {
    const isHere = o.id === 'here' || !!o.isHere;
    const label = routeTargetLabel(o);
    return {
      ...o,
      number: i + 1,
      here: isHere,
      // "here" is the brain's own model: prefer its display label over a raw id.
      title: isHere ? tr('assistant.routes.doHere', 'Do it here with {model}', { model: str(o.label) || hereModel }) : (label || o.id),
      badgeText: badgeText(o, n, tr),
      selected: o.id === defaultId,
    };
  });
}

/** control_response payload for a route card. `decline:true` is the Cancel answer. */
export function buildRouteResponse(n, choice = {}) {
  if (choice.decline) return { kind: 'route', optionId: null, remember: false, decline: true };
  const optionId = str(choice.optionId) || n?.defaultOptionId || null;
  const out = { kind: 'route', optionId, remember: choice.remember === true && n?.remember?.available === true };
  if (optionId === 'other') {
    const target = obj(choice.target) || {};
    out.target = {
      kind: str(target.kind) || 'direct',
      provider: normalizeProvider(target.provider, str(target.provider) || null),
      model: str(target.model),
      effort: str(target.effort) || null,
    };
  }
  return out;
}

/** Cancel packet when the card does not accept a decline answer. */
export function buildRouteCancel(n, reason = 'user') {
  return { type: 'control_cancelled', request_id: n?.requestId || null, reason };
}

const TERMINAL_PHASES = new Set(['decided', 'auto', 'expired', 'declined', 'cancelled']);

const CONTEXT_SUFFIX = /\[(1m|extended)\]$/i;

/**
 * The row a model id names through the catalog's aliases when no row has it as its id or
 * selector (pure), as the router's findModel resolves it: the id in another case; for Claude
 * the model an alias row runs as at the same context window ("claude-opus-5-5" → opus,
 * "claude-opus-5-5[1m]" → opus[1m], a legacy "<id>:<window>" too); for OpenCode a bare model
 * id that names exactly one row. null when nothing resolves.
 */
function aliasRow(provider, model, rows) {
  let want = String(model || '').trim();
  const legacy = provider === 'claude-code' ? want.match(/^([^:]+):(\d+)$/) : null;
  if (legacy) want = Number(legacy[2]) > 200000 ? `${legacy[1]}[1m]` : legacy[1];
  want = want.toLowerCase();
  if (!want) return null;
  const byId = rows.find(m => String(m.id).toLowerCase() === want);
  if (byId) return byId;
  if (provider === 'claude-code') {
    const runsAs = (m) => `${String(m.upstream).replace(CONTEXT_SUFFIX, '')}${(String(m.id).match(CONTEXT_SUFFIX) || [''])[0]}`.toLowerCase();
    return rows.find(m => m.upstream && runsAs(m) === want) || null;
  }
  if (provider === 'opencode' && !want.includes('/')) {
    const hits = rows.filter(m => String(m.id).split('/').slice(1).join('/').toLowerCase() === want);
    return hits.length === 1 ? hits[0] : null;
  }
  return null;
}

/**
 * Can a saved Design route run, as the router judges it (pure)? 'ok', 'blind', 'unknown'
 * (the row says nothing about sight, or the loaded catalog has no row for the model) or
 * 'unavailable'; null when there is no route or no catalog to tell. A model missing from the
 * list resolves through its alias first (a saved "claude-opus-5-5" is judged by the opus row,
 * unavailable included); a claude-* id nothing resolves is unknown, as it is for the router.
 */
export function designRouteSight(pref, catalog) {
  if (!pref?.provider || !catalog) return null;
  const rows = Array.isArray(catalog[pref.provider]) ? catalog[pref.provider] : [];
  const row = pref.model ? catalogModelRow(pref.provider, pref.model, catalog) || aliasRow(pref.provider, pref.model, rows) : rows.find(m => m.isDefault) || null;
  if (!row) return 'unknown';
  if (row.vision === false) return 'blind';
  if (row.vision !== true) return 'unknown';
  return row.status === 'unavailable' ? 'unavailable' : 'ok';
}

/** Text parts of a route line (pure). */
export function routeLineParts(route, phase = 'decided', { brainLabel = '', t = null } = {}) {
  const tr = tf(t);
  const r = obj(route) || {};
  const target = obj(r.target);
  const cls = firstStr(r.taskClassLabel, r.taskClass) || tr('assistant.routes.task', 'task');
  const kind = target ? (str(target.kind) || 'direct') : '';
  const effort = target ? str(target.effort) : '';
  const confidence = fmtConfidence(r.confidence);
  let state = '';
  if (phase === 'pending' || phase === 'card') state = tr('assistant.routes.state.pending', 'waiting for your choice');
  else if (phase === 'expired') state = tr('assistant.routes.state.expired', 'route expired');
  // Image / video creation with no model that makes the medium (design: none that can see): nobody declined, nothing can run it.
  else if (phase === 'declined' && str(r.reasonCode) === 'no_capable_model') {
    state = str(r.needs) === 'vision' ? tr('assistant.routes.reason.noSeeingModel', 'no model can see images') : tr('assistant.routes.reason.noCapableModel', 'no model can make this');
  }
  else if (phase === 'declined') state = tr('assistant.routes.state.declined', 'declined');
  else if (phase === 'cancelled') state = tr('assistant.routes.state.cancelled', 'cancelled');
  let decided = '';
  switch (str(r.decidedBy)) {
    case 'brain': decided = tr('assistant.routes.decidedBy', 'decided by {model}', { model: brainLabel || tr('assistant.routes.theBrainLower', 'the assistant') }); break;
    case 'user': decided = tr('assistant.routes.youChose', 'you chose'); break;
    case 'remembered': decided = tr('assistant.routes.remembered', 'remembered'); break;
    case 'timeout': decided = tr('assistant.routes.timeout', 'default after timeout'); break;
    default: decided = r.remembered ? tr('assistant.routes.remembered', 'remembered') : '';
  }
  const meta = [];
  if (effort && effort !== 'off') meta.push(effort);
  if (confidence) meta.push(confidence);
  return {
    taskClass: cls,
    kind,
    kindLabel: kind && kind !== 'direct' ? routeKindLabel(kind) : '',
    provider: target ? normalizeProvider(target.provider, str(target.provider) || null) : null,
    targetLabel: target && !state ? routeTargetLabel(target) : '',
    meta,
    stateText: state,
    muted: phase === 'expired' || phase === 'declined' || phase === 'cancelled',
    pending: phase === 'pending' || phase === 'card',
    decidedText: decided,
    reason: str(r.reason),
    alternatives: arr(r.alternatives).map(a => routeTargetLabel(a, { effort: true })).filter(Boolean),
    corrections: arr(r.corrections).map(c => correctionText(c, tr)).filter(Boolean),
  };
}

/** One "Adjusted" entry: the server's text, else "<field>: from → to" for the older shapes. */
function correctionText(c, tr) {
  if (typeof c === 'string') return c;
  if (!c || typeof c !== 'object') return '';
  if (c.reason === 'remembered_route') return tr('assistant.routes.correction.remembered', 'your saved route {to} replaced {from}', { to: str(c.to), from: str(c.from) });
  if (c.reason === 'remembered_disabled') return tr('assistant.routes.correction.rememberedDisabled', 'saved route {from} is disabled, kept the pick', { from: str(c.from) });
  const text = firstStr(c.text, c.summary);
  if (text) return text;
  if (c.field && (c.from || c.to)) return `${c.field}: ${str(c.from) || '—'} → ${str(c.to) || 'default'}`;
  return str(c.field);
}

/** Plain-text rendering of a route line: "⇄ code → Sonnet 5 · high · 86%". */
export function routeLineText(route, phase, opts) {
  const p = routeLineParts(route, phase, opts);
  if (p.stateText && !p.targetLabel) return `⇄ ${p.taskClass} · ${p.stateText}`;
  const head = [p.kindLabel, p.targetLabel].filter(Boolean).join(' · ');
  return [`⇄ ${p.taskClass} → ${head}`, ...p.meta].join(' · ');
}

// ═══════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════

const ICON_ROUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function providerIconHtml(provider, hooks) {
  if (!provider) return '';
  try {
    if (typeof hooks.providerIcon === 'function') return hooks.providerIcon(provider) || '';
    return getProviderMeta(provider).icon || '';
  } catch { return ''; }
}

function providerColor(provider) {
  try { return getProviderMeta(provider).color || ''; } catch { return ''; }
}

let _lineUid = 0;

/**
 * The compact route line. opts: { phase, t, providerIcon, brainLabel() , onChangeRoutes() }
 * Returns { el, routeId, update(route, phase) }.
 */
export function createRouteLine(route, opts = {}) {
  const tr = tf(opts.t);
  const node = el('div', 'asst-route-line');
  const detailId = `asst-route-detail-${++_lineUid}`;
  node.innerHTML = `
    <button type="button" class="asst-route-line-head" aria-expanded="false" aria-controls="${detailId}">
      <span class="asst-route-glyph" aria-hidden="true">⇄</span>
      <span class="asst-route-class"></span>
      <span class="asst-route-arrow" aria-hidden="true">→</span>
      <span class="asst-route-kind"></span>
      <span class="asst-route-icon asst-icon" aria-hidden="true"></span>
      <span class="asst-route-target"></span>
      <span class="asst-route-meta"></span>
      <span class="asst-route-state"></span>
      <span class="asst-route-chev" aria-hidden="true">&#x203A;</span>
    </button>
    <div class="asst-route-detail" id="${detailId}" hidden></div>`;
  const head = node.querySelector('.asst-route-line-head');
  const detail = node.querySelector('.asst-route-detail');
  let current = { route: obj(route) || {}, phase: opts.phase || 'decided' };

  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    detail.hidden = !open;
    node.classList.toggle('open', open);
  });

  function render() {
    const brainLabel = typeof opts.brainLabel === 'function' ? opts.brainLabel() : (opts.brainLabel || '');
    const p = routeLineParts(current.route, current.phase, { brainLabel, t: opts.t });
    node.dataset.routeId = str(current.route.routeId);
    node.dataset.phase = current.phase;
    node.classList.toggle('muted', p.muted);
    node.classList.toggle('pending', p.pending);
    node.querySelector('.asst-route-class').textContent = p.taskClass;
    const arrow = node.querySelector('.asst-route-arrow');
    const kindEl = node.querySelector('.asst-route-kind');
    const iconEl = node.querySelector('.asst-route-icon');
    const targetEl = node.querySelector('.asst-route-target');
    const metaEl = node.querySelector('.asst-route-meta');
    const stateEl = node.querySelector('.asst-route-state');
    arrow.hidden = !p.targetLabel && !p.pending;
    kindEl.textContent = p.kindLabel;
    kindEl.hidden = !p.kindLabel;
    iconEl.innerHTML = p.targetLabel ? providerIconHtml(p.provider, opts) : '';
    iconEl.hidden = !iconEl.innerHTML;
    if (p.provider) iconEl.style.color = providerColor(p.provider); else iconEl.style.color = '';
    targetEl.textContent = p.targetLabel;
    targetEl.hidden = !p.targetLabel;
    metaEl.textContent = p.meta.length ? `· ${p.meta.join(' · ')}` : '';
    metaEl.hidden = !p.meta.length;
    stateEl.textContent = p.stateText;
    stateEl.hidden = !p.stateText;
    head.setAttribute('aria-label', routeLineText(current.route, current.phase, { brainLabel, t: opts.t }));

    detail.innerHTML = '';
    const rows = [];
    if (p.reason) rows.push(['reason', p.reason]);
    if (p.decidedText) rows.push(['decided', p.decidedText]);
    if (p.alternatives.length) rows.push(['alternatives', `${tr('assistant.routes.alternatives', 'Also considered')}: ${p.alternatives.join(' · ')}`]);
    if (p.corrections.length) rows.push(['corrections', `${tr('assistant.routes.corrections', 'Adjusted')}: ${p.corrections.join(' · ')}`]);
    for (const [kind, text] of rows) {
      const row = el('div', `asst-route-detail-row asst-route-${kind}`, text);
      detail.appendChild(row);
    }
    if (typeof opts.onChangeRoutes === 'function') {
      const link = el('button', 'asst-link asst-route-change', tr('assistant.routes.change', 'Change routes…'));
      link.type = 'button';
      link.addEventListener('click', () => opts.onChangeRoutes());
      detail.appendChild(link);
    }
  }

  render();
  return {
    el: node,
    get routeId() { return str(current.route.routeId); },
    update(nextRoute, phase) {
      if (nextRoute && typeof nextRoute === 'object') current.route = { ...current.route, ...nextRoute };
      if (phase) current.phase = phase;
      render();
    },
  };
}

/**
 * Toolbar chip for the session's route mode.
 * hooks: { t, getMode() → { mode, effectiveMode, defaultMode }, brainName() → string,
 *          onChange(mode), onOpenEditor(), menuPlacement: 'below' (default),
 *          getWaiting() → number of pending route cards not on screen, onShowWaiting() }
 */
export function createRouteModeControl(hostEl, hooks = {}) {
  const tr = tf(hooks.t);
  const btn = el('button', 'asst-dd asst-route-chip');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `<span class="asst-icon" aria-hidden="true">${ICON_ROUTE}</span><span class="asst-dd-label"></span><span class="asst-dd-caret" aria-hidden="true">${ICON_CARET}</span>`;
  btn.hidden = true;
  hostEl.appendChild(btn);

  function effective() {
    const m = hooks.getMode?.() || {};
    return normalizeRouteMode(m.mode) || normalizeRouteMode(m.effectiveMode) || normalizeRouteMode(m.defaultMode) || DEFAULT_ROUTE_MODE;
  }

  // Pending route cards the panel is not showing (a packet that never arrived).
  const waitingBadge = el('span', 'asst-route-waiting');
  waitingBadge.hidden = true;
  btn.insertBefore(waitingBadge, btn.querySelector('.asst-dd-caret'));
  function waiting() {
    const n = Math.floor(Number(hooks.getWaiting?.()) || 0);
    return n > 0 ? n : 0;
  }
  function waitingText(n) {
    return tr('assistant.routes.waiting', '{n} waiting').replace('{n}', String(n));
  }

  function render() {
    const mode = effective();
    const label = routeModeLabel(mode, hooks.t);
    btn.dataset.mode = mode;
    btn.querySelector('.asst-dd-label').textContent = label;
    const n = waiting();
    waitingBadge.hidden = !n;
    waitingBadge.textContent = n ? waitingText(n) : '';
    if (n) btn.dataset.waiting = String(n); else delete btn.dataset.waiting;
    const tip = `${tr('assistant.routes.title', 'Model routing')}: ${label}${n ? ` · ${waitingText(n)}` : ''}`;
    btn.setAttribute('data-tooltip', tip);
    btn.setAttribute('aria-label', tip);
  }

  function open(anchor = btn) {
    const mode = effective();
    const model = hooks.brainName?.() || '';
    const n = waiting();
    return openMenu(anchor, {
      title: tr('assistant.routes.title', 'Model routing'),
      role: 'menu',
      placement: hooks.menuPlacement || 'below',
      width: 300,
      className: 'asst-route-menu',
      items: [
        ...(n ? [
          { id: 'waiting', label: tr('assistant.routes.showWaiting', 'Show the waiting route card'), desc: waitingText(n), onSelect: () => hooks.onShowWaiting?.() },
          { kind: 'separator' },
        ] : []),
        ...ROUTE_MODES.map(id => ({
          kind: 'radio',
          id,
          label: routeModeLabel(id, hooks.t),
          desc: routeModeDescription(id, model, hooks.t),
          selected: id === mode,
          onSelect: () => { if (id !== mode) hooks.onChange?.(id); },
        })),
        { kind: 'separator' },
        { id: 'routes', label: tr('assistant.routes.editor', 'Model routes…'), onSelect: () => hooks.onOpenEditor?.() },
        ...(typeof hooks.onOpenModels === 'function' ? [{ id: 'models', label: tr('assistant.models.menu', 'Models…'), onSelect: () => hooks.onOpenModels() }] : []),
      ],
    });
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isMenuOpen(btn)) { closeMenu(); return; }
    open(btn);
  });
  render();
  return {
    el: btn,
    render,
    open,
    mode: effective,
    setVisible(visible) { btn.hidden = !visible; },
    isVisible: () => !btn.hidden,
    destroy() { btn.remove(); },
  };
}

function fmtCountdown(ms) {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(secs / 60);
  return `${m}:${String(secs % 60).padStart(2, '0')}`;
}

/**
 * Route card. `input` is the normalized control request (from asst-control) or
 * the raw packet. hooks: { t, providerIcon, brainLabel() → string, getBrain() → brain,
 * onRespond(response, n), onCancel(packet, n), onCollapse(routeId, lineHandle),
 * onDone(), shouldFocus() → bool, onChangeRoutes(), scrollEnd() }
 * Returns { el, requestId, routeId, collapsed, focus(), lock(label), settle(phase, route), fail(message), destroy() }.
 */
export function renderRouteCard(container, input, hooks = {}) {
  const n = normalizeRouteRequest(input?.raw || input?.route ? (input.raw || { request: input.route, request_id: input.requestId }) : input);
  if (!n) return null;
  const tr = tf(hooks.t);
  const brainLabel = () => (typeof hooks.brainLabel === 'function' ? hooks.brainLabel() : '') || routeTargetLabel(n.brain) || tr('assistant.routes.theBrainLower', 'the assistant');
  const options = routeOptions(n, { brainLabel: brainLabel(), t: hooks.t });
  const state = {
    selectedId: (options.find(o => o.selected) || options.find(o => !o.disabled) || {}).id || null,
    other: null,
    remember: false,
    pending: false,
    resolved: false,
    collapsed: false,
    line: null,
    timer: null,
    grace: null,
    expired: false,
  };

  const card = el('div', 'asst-control asst-route-card active');
  card.dataset.kind = 'route';
  card.dataset.requestId = n.requestId;
  card.dataset.routeId = n.routeId;
  card.setAttribute('role', 'group');
  const heading = tr('assistant.routes.cardTitle', 'Route this request · {taskClass}', { taskClass: n.taskClassLabel });
  card.setAttribute('aria-label', heading);

  const head = el('div', 'asst-control-head');
  head.innerHTML = `<span class="asst-control-kind"></span><span class="asst-route-countdown" hidden></span><span class="asst-control-status" hidden></span>`;
  head.querySelector('.asst-control-kind').textContent = heading;
  decorateControlHead(head, head.querySelector('.asst-control-kind')); // the still blocked cameo, like every card that waits on you
  card.appendChild(head);
  const countdown = head.querySelector('.asst-route-countdown');
  const status = head.querySelector('.asst-control-status');

  if (n.summary) card.appendChild(el('div', 'asst-route-summary', n.summary));
  const reasons = routeReasonLabels(n, hooks.t);
  if (reasons.length) card.appendChild(el('div', 'asst-route-reasons', reasons.join(' · ')));
  // Asked from WhatsApp: on the phone, a yes to one option of this card also allows controlling the Mac.
  // Approved here it approves the route only (the Mac is granted on the phone alone). Said in words, on the card.
  const macOption = n.computer ? options.find(o => o.id === n.computer.optionId && !o.disabled) : null;
  if (macOption) {
    const note = el('div', 'asst-route-reasons', tr('assistant.routes.computerNote', 'Asked from WhatsApp: on the phone, a yes to “{option}” also lets the assistant control this Mac for the task. Approved here, it only decides where the task runs; the phone is then asked about the Mac.', { option: macOption.title }));
    note.dataset.note = 'computer';
    card.appendChild(note);
  }

  const list = el('div', 'asst-route-options');
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', tr('assistant.routes.chooseModel', 'Where should this run?'));
  card.appendChild(list);

  function optionRow(o) {
    const row = el('div', 'asst-route-option');
    row.setAttribute('role', 'radio');
    row.dataset.optionId = o.id;
    row.setAttribute('aria-checked', 'false');
    row.setAttribute('aria-disabled', o.disabled ? 'true' : 'false');
    row.tabIndex = -1;
    const kindWord = o.kind && o.kind !== 'direct' ? routeKindLabel(o.kind) : '';
    const sub = [kindWord, o.effort && o.effort !== 'off' ? o.effort : '', o.price ? priceText(o.price) : '', o.vision ? tr('assistant.brain.vision', 'vision') : '', o.reason].filter(Boolean).join(' · ');
    row.innerHTML = `
      <span class="asst-route-num" aria-hidden="true">${esc(o.number)}</span>
      <span class="asst-route-opt-icon asst-icon" aria-hidden="true"${o.provider ? ` style="color:${esc(providerColor(o.provider))}"` : ''}>${providerIconHtml(o.provider, hooks)}</span>
      <span class="asst-route-opt-main">
        <span class="asst-route-opt-title"></span>
        ${sub ? '<span class="asst-route-opt-sub"></span>' : ''}
        ${o.warning || (o.disabled && o.disabledReason) ? '<span class="asst-route-opt-warn"></span>' : ''}
      </span>
      ${o.badgeText ? `<span class="asst-route-badge" data-badge="${esc(o.badge || '')}"></span>` : ''}`;
    row.querySelector('.asst-route-opt-title').textContent = o.title;
    if (sub) row.querySelector('.asst-route-opt-sub').textContent = sub;
    const warn = row.querySelector('.asst-route-opt-warn');
    if (warn) warn.textContent = o.disabled && o.disabledReason ? o.disabledReason : o.warning;
    if (o.badgeText) row.querySelector('.asst-route-badge').textContent = o.badgeText;
    row.addEventListener('click', () => { if (!o.disabled) select(o.id, { focus: true }); });
    return row;
  }

  function priceText(price) {
    const a = num(price.input); const b = num(price.output);
    const f = (v) => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));
    if (a == null && b == null) return '';
    return b != null ? `$${a != null ? f(a) : '?'}/$${f(b)}` : `$${f(a)}`;
  }

  const allOptions = () => (state.other ? [...options, state.other] : options);

  function renderOptions() {
    list.innerHTML = '';
    for (const o of allOptions()) list.appendChild(optionRow(o));
    syncSelection();
  }

  function syncSelection() {
    for (const row of list.querySelectorAll('.asst-route-option')) {
      const on = row.dataset.optionId === state.selectedId;
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.classList.toggle('selected', on);
      row.tabIndex = on ? 0 : -1;
    }
    runBtn.disabled = state.pending || state.resolved || state.expired || !state.selectedId;
  }

  function select(id, { focus = false } = {}) {
    if (state.pending || state.resolved) return;
    const o = allOptions().find(x => x.id === id);
    if (!o || o.disabled) return;
    state.selectedId = id;
    syncSelection();
    if (focus) list.querySelector(`.asst-route-option[data-option-id="${CSS.escape(id)}"]`)?.focus();
  }

  // Other model…
  const otherBtn = el('button', 'asst-link asst-route-other', tr('assistant.routes.other', 'Other model…'));
  otherBtn.type = 'button';
  otherBtn.setAttribute('aria-haspopup', 'menu');
  otherBtn.hidden = !n.other.allowed;
  otherBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isMenuOpen(otherBtn)) { closeMenu(); return; }
    const brain = normalizeBrain(hooks.getBrain?.() || { provider: n.brain.provider || 'claude-code', model: n.brain.model });
    openModelMenu(otherBtn, {
      brain,
      t: hooks.t,
      title: tr('assistant.routes.otherTitle', 'Run on another model'),
      placement: 'auto',
      providers: n.other.providers.length ? n.other.providers.map(p => normalizeProvider(p, p)) : null,
      current: state.other ? { provider: state.other.provider, model: state.other.model } : null,
      onToast: hooks.onToast,
      // Image / video creation: only models that generate the medium (no custom id: its output is unknown).
      ...(n.requires ? { accept: (_p, m) => m?.outputs?.[n.requires] === true, allowCustom: false, emptyLabel: tr('assistant.routes.noCapableModel', 'No model in your catalog can make {medium} yet.', { medium: mediumWords(n.requires, tr) }) } : {}),
      // Design: only models that can see.
      ...(!n.requires && n.visionOnly ? { accept: (_p, m) => m?.vision === true && m?.status !== 'unavailable', allowCustom: false, emptyLabel: tr('assistant.routes.noSeeingModel', 'No model in your catalog can see images yet.') } : {}),
      onSelect: (target) => {
        if (!target?.model) return;
        const kind = n.dispatchOnly || (target.provider && target.provider !== brain.provider) ? 'dispatch' : 'direct';
        state.other = {
          id: 'other', kind, provider: target.provider, model: target.model, effort: null,
          label: target.label || '', badge: null, number: options.length + 1, here: false,
          title: target.label || target.model, badgeText: tr('assistant.routes.badge.other', 'Your pick'),
          vision: target.vision === true, price: target.price || null, reason: '', warning: null, disabled: false,
        };
        state.selectedId = 'other';
        renderOptions();
        list.querySelector('.asst-route-option[data-option-id="other"]')?.focus();
      },
    });
  });
  card.appendChild(otherBtn);

  // Remember for ‹class› tasks
  let rememberInput = null;
  if (n.remember.available) {
    const label = el('label', 'asst-route-remember');
    rememberInput = document.createElement('input');
    rememberInput.type = 'checkbox';
    rememberInput.addEventListener('change', () => { state.remember = rememberInput.checked; });
    // `remember.label` is the task-class label ("Code"), not a sentence.
    const text = tr('assistant.routes.rememberFor', 'Remember for {taskClass} tasks', { taskClass: (n.remember.label || n.taskClassLabel).toLowerCase() });
    label.append(rememberInput, el('span', null, text));
    if (n.remember.current) label.appendChild(el('span', 'asst-route-remember-current', tr('assistant.routes.rememberCurrent', 'now: {current}', { current: n.remember.current })));
    card.appendChild(label);
  }

  const error = el('div', 'asst-route-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  card.appendChild(error);

  const actions = el('div', 'asst-control-actions');
  const cancelBtn = el('button', 'asst-btn asst-btn-secondary asst-route-cancel', n.decline.label || tr('common.cancel', 'Cancel'));
  cancelBtn.type = 'button';
  // When the server does not accept a decline, the card can only be answered.
  cancelBtn.hidden = !n.decline.allowed;
  const runBtn = el('button', 'asst-btn asst-btn-primary asst-route-run', tr('assistant.routes.run', 'Run'));
  runBtn.type = 'button';
  const hint = el('span', 'asst-route-keys', tr('assistant.routes.keys', '1–4 choose · Enter runs · Esc cancels'));
  actions.append(hint, cancelBtn, runBtn);
  card.appendChild(actions);

  function setPending(pending, label = '') {
    state.pending = pending;
    cancelBtn.disabled = pending || state.resolved;
    otherBtn.disabled = pending || state.resolved;
    if (rememberInput) rememberInput.disabled = pending || state.resolved;
    status.textContent = label;
    status.hidden = !label;
    card.classList.toggle('pending', pending);
    syncSelection();
  }

  function chosenRoute() {
    const o = allOptions().find(x => x.id === state.selectedId) || null;
    return {
      routeId: n.routeId,
      taskClass: n.taskClass,
      taskClassLabel: n.taskClassLabel,
      summary: n.summary,
      confidence: n.confidence,
      decidedBy: 'user',
      optionId: state.selectedId,
      remembered: state.remember,
      target: o ? { kind: o.kind || 'direct', provider: o.provider, model: o.model, effort: o.effort, label: o.label || (o.here ? routeTargetLabel(o) : o.title) } : null,
      alternatives: allOptions().filter(x => x.id !== state.selectedId).map(x => ({ provider: x.provider, model: x.model, effort: x.effort, label: x.label })),
    };
  }

  function returnFocus() {
    const hadFocus = card.contains(document.activeElement) || document.activeElement === document.body;
    if (hadFocus) { try { hooks.onDone?.(); } catch { /* ignore */ } }
  }

  function collapse(phase, route) {
    if (state.collapsed) { state.line?.update(route, phase); return state.line; }
    clearTimers();
    const hadFocus = card.contains(document.activeElement);
    const line = createRouteLine({ ...chosenRoute(), ...(obj(route) || {}) }, {
      phase, t: hooks.t, providerIcon: hooks.providerIcon, brainLabel, onChangeRoutes: hooks.onChangeRoutes,
    });
    state.line = line;
    state.collapsed = true;
    state.resolved = true;
    if (card.isConnected) card.replaceWith(line.el);
    try { hooks.onCollapse?.(n.routeId, line); } catch { /* ignore */ }
    if (hadFocus) { try { hooks.onDone?.(); } catch { /* ignore */ } }
    return line;
  }

  function restore() {
    if (!state.collapsed) return;
    if (state.line?.el?.isConnected) state.line.el.replaceWith(card);
    state.collapsed = false;
    state.resolved = false;
  }

  function clearTimers() {
    if (state.grace) { clearTimeout(state.grace); state.grace = null; }
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function submit() {
    if (state.pending || state.resolved || state.expired || !state.selectedId) return;
    const response = buildRouteResponse(n, { optionId: state.selectedId, target: state.other, remember: state.remember });
    error.hidden = true;
    setPending(true, tr('assistant.routes.routing', 'Routing…'));
    try { hooks.onRespond?.(response, n); } catch { /* ignore */ }
    // The decided event collapses the card; if it never comes, collapse anyway.
    state.grace = setTimeout(() => { state.grace = null; if (!state.collapsed) collapse('decided', null); }, 1800);
  }

  function cancel() {
    if (state.pending || state.resolved) return;
    if (!n.decline.allowed) {
      // Nothing to cancel on the server: leave the card and hand focus back.
      try { hooks.onCancel?.(buildRouteCancel(n, 'user'), n); } catch { /* ignore */ }
      returnFocus();
      return;
    }
    error.hidden = true;
    setPending(true, tr('assistant.routes.cancelling', 'Cancelling…'));
    try { hooks.onRespond?.(buildRouteResponse(n, { decline: true }), n); } catch { /* ignore */ }
    state.grace = setTimeout(() => { state.grace = null; if (!state.collapsed) collapse('declined', { target: null }); }, 1800);
  }

  runBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', cancel);

  card.addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' && e.target.type === 'text') return;
    const all = allOptions();
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const o = all[Number(e.key) - 1];
      if (o && !o.disabled) { e.preventDefault(); e.stopPropagation(); select(o.id, { focus: true }); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const enabled = all.filter(o => !o.disabled);
      if (!enabled.length) return;
      e.preventDefault(); e.stopPropagation();
      const idx = Math.max(0, enabled.findIndex(o => o.id === state.selectedId));
      const next = enabled[(idx + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length];
      select(next.id, { focus: true });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.target?.closest?.('button') && e.target !== runBtn && !e.target.classList.contains('asst-route-option')) return;
      e.preventDefault(); e.stopPropagation();
      submit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      cancel();
      return;
    }
    if (e.key === ' ' && e.target?.classList?.contains('asst-route-option')) {
      e.preventDefault(); e.stopPropagation();
      select(e.target.dataset.optionId);
      return;
    }
    e.stopPropagation(); // single-letter global keybinds stay out of the card
  });

  // Countdown to expiresAt
  const expires = n.expiresAt ? new Date(n.expiresAt).getTime() : 0;
  function tick() {
    if (!expires) return;
    const left = expires - Date.now();
    countdown.hidden = false;
    countdown.textContent = fmtCountdown(left);
    countdown.setAttribute('aria-label', tr('assistant.routes.expiresIn', 'Expires in {time}', { time: fmtCountdown(left) }));
    if (left <= 0) {
      state.expired = true;
      clearInterval(state.timer);
      state.timer = null;
      countdown.textContent = tr('assistant.routes.state.expired', 'route expired');
      syncSelection();
    }
  }
  if (expires && Number.isFinite(expires)) { tick(); state.timer = setInterval(tick, 1000); }

  renderOptions();
  if (container) container.appendChild(card);
  try { hooks.scrollEnd?.(); } catch { /* ignore */ }

  const entry = {
    el: card,
    requestId: n.requestId,
    routeId: n.routeId,
    model: n,
    get collapsed() { return state.collapsed; },
    get resolved() { return state.resolved; },
    get line() { return state.line; },
    /** Focus the preselected option (the panel calls this when the composer is empty). */
    focus() {
      const row = list.querySelector('.asst-route-option[aria-checked="true"]') || list.querySelector('.asst-route-option');
      try { row?.focus({ preventScroll: false }); } catch { row?.focus(); }
    },
    focusIfIdle() { if (typeof hooks.shouldFocus !== 'function' || hooks.shouldFocus()) entry.focus(); },
    /** control_cancelled from the server. */
    lock(label) {
      if (state.collapsed) { state.line?.update(null, 'cancelled'); return; }
      status.textContent = label || tr('assistant.routes.state.cancelled', 'cancelled');
      collapse('cancelled', null);
    },
    /** `synabun.route` for this routeId (decided/auto/expired/declined/cancelled). */
    settle(phase, route) {
      if (!TERMINAL_PHASES.has(phase)) return state.line;
      return collapse(phase, route);
    },
    /** ROUTE_INVALID: keep (or re-open) the card with the message. */
    fail(message) {
      clearTimers();
      restore();
      setPending(false, '');
      error.textContent = message || tr('assistant.routes.invalid', 'That route is not available. Pick another option.');
      error.hidden = false;
      if (expires) { tick(); if (!state.expired) state.timer = setInterval(tick, 1000); }
      entry.focus();
    },
    destroy() { clearTimers(); },
  };
  return entry;
}

// ── Routes editor (modal) ───────────────────────────────────────────────────

let _editor = null;

/**
 * "Model routes…" editor. hooks: { t, providerIcon, getBrain() → brain, onSaved(routing), onClose() }
 * Returns { el, close } (async: resolves after the first load).
 */
export async function openRoutesEditor(hooks = {}) {
  if (_editor) { _editor.close(); }
  const tr = tf(hooks.t);
  const overlay = el('div', 'asst-modal-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', tr('assistant.routes.editorTitle', 'Model routes'));
  const modal = el('div', 'asst-modal asst-routes-modal');
  modal.innerHTML = `
    <div class="asst-modal-head"><span class="asst-icon" aria-hidden="true">${ICON_ROUTE}</span><span>${esc(tr('assistant.routes.editorTitle', 'Model routes'))}</span><button type="button" class="asst-iconbtn asst-modal-close" aria-label="${esc(tr('common.close', 'Close'))}">${ICON_X}</button></div>
    <div class="asst-modal-body"><div class="asst-modal-note">${esc(tr('common.loading', 'Loading...'))}</div></div>
    <div class="asst-modal-foot">
      <button type="button" class="asst-btn asst-btn-secondary asst-routes-reset-all">${esc(tr('assistant.routes.resetAll', 'Reset all'))}</button>
      <span class="asst-modal-spacer"></span>
      <button type="button" class="asst-btn asst-btn-secondary asst-routes-cancel">${esc(tr('common.cancel', 'Cancel'))}</button>
      <button type="button" class="asst-btn asst-btn-primary asst-routes-save">${esc(tr('common.save', 'Save'))}</button>
    </div>`;
  overlay.appendChild(modal);
  const body = modal.querySelector('.asst-modal-body');
  const saveBtn = modal.querySelector('.asst-routes-save');
  const resetAllBtn = modal.querySelector('.asst-routes-reset-all');
  const returnTo = document.activeElement;

  const state = { data: null, catalog: null, version: null, defaultMode: DEFAULT_ROUTE_MODE, prefs: {}, patch: {}, error: '', conflict: false, saving: false };

  function close() {
    if (!overlay.isConnected) return;
    closeMenu();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    _editor = null;
    try { hooks.onClose?.(); } catch { /* ignore */ }
    if (returnTo?.isConnected) { try { returnTo.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      if (isMenuOpen()) return; // the menu closes itself first
      e.preventDefault(); e.stopPropagation(); close();
      return;
    }
    e.stopPropagation();
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  modal.querySelector('.asst-modal-close').addEventListener('click', close);
  modal.querySelector('.asst-routes-cancel').addEventListener('click', close);
  document.body.appendChild(overlay);
  _editor = { close };

  function effectivePref(key) {
    return Object.prototype.hasOwnProperty.call(state.patch, key) ? state.patch[key] : (state.prefs[key] || null);
  }

  function sourceOf(key) {
    if (Object.prototype.hasOwnProperty.call(state.patch, key)) return state.patch[key] ? 'yours' : 'default';
    const pref = state.prefs[key];
    if (!pref) return 'default';
    return pref.by === 'user' ? 'yours' : 'remembered';
  }

  function sourceLabel(source) {
    if (source === 'disabled') return tr('assistant.routes.source.disabled', 'disabled');
    if (source === 'incapable') return tr('assistant.routes.source.incapable', 'incapable');
    if (source === 'yours') return tr('assistant.routes.source.yours', 'yours');
    if (source === 'remembered') return tr('assistant.routes.source.remembered', 'remembered');
    return tr('assistant.routes.source.default', 'default');
  }

  /** Does the route's model generate `medium`? true | false | null (the catalog cannot tell). */
  function routeMakes(pref, medium) {
    if (!medium || !pref?.provider || !state.catalog) return null;
    const rows = Array.isArray(state.catalog[pref.provider]) ? state.catalog[pref.provider] : [];
    const row = pref.model ? catalogModelRow(pref.provider, pref.model, state.catalog) : rows.find(m => m.isDefault) || null;
    if (!row?.outputs || typeof row.outputs !== 'object') return null;
    return row.outputs[medium] === true;
  }
  /** No model in the loaded catalog makes `medium` (false while the catalog has no output data). */
  function noMaker(medium) {
    const rows = Object.values(state.catalog || {}).flatMap(list => (Array.isArray(list) ? list : []));
    return rows.some(m => m?.outputs && typeof m.outputs === 'object') && !rows.some(m => m?.outputs?.[medium] === true);
  }
  /** No model in the loaded catalog can see (false while no catalog is loaded). */
  function noSeer() {
    const rows = Object.values(state.catalog || {}).flatMap(list => (Array.isArray(list) ? list : []));
    return rows.length > 0 && !rows.some(m => m?.vision === true);
  }

  function taskRows() {
    const classes = Array.isArray(state.data?.taskClasses) ? state.data.taskClasses.filter(c => c?.id) : [];
    const rows = classes.map(c => ({
      id: String(c.id), label: str(c.label) || humanizeClass(c.id), description: str(c.description), defaultKind: str(c.defaultKind) || 'direct',
      // Image / video creation: only models that generate the medium, always on a worker; design: only models that can see.
      requires: c.requires === 'image' || c.requires === 'video' ? c.requires : null, dispatchOnly: c.dispatchOnly === true, visionOnly: c.vision === true,
    }));
    if (!rows.some(r => r.id === 'vision')) rows.push({ id: 'vision', label: tr('assistant.routes.visionRow', 'Screenshots & images'), description: tr('assistant.routes.visionDesc', 'Used when a task needs a model that can see.'), defaultKind: 'direct' });
    return rows;
  }

  function render() {
    body.innerHTML = '';
    if (state.error) {
      const banner = el('div', 'asst-routes-error');
      banner.setAttribute('role', 'alert');
      banner.appendChild(el('span', null, state.error));
      if (state.conflict) {
        const reload = el('button', 'asst-btn asst-btn-secondary', tr('assistant.routes.reload', 'Reload'));
        reload.type = 'button';
        reload.addEventListener('click', () => load());
        banner.appendChild(reload);
      }
      body.appendChild(banner);
    }
    if (!state.data) return;

    // When to ask (default route mode)
    const modeSection = el('section', 'asst-routes-section');
    modeSection.appendChild(el('div', 'asst-routes-section-title', tr('assistant.routes.whenToAsk', 'When to ask')));
    const modes = el('div', 'asst-routes-modes');
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', tr('assistant.routes.whenToAsk', 'When to ask'));
    const brainName = hooks.brainName?.() || '';
    for (const id of ROUTE_MODES) {
      const b = el('button', 'asst-routes-mode');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', state.defaultMode === id ? 'true' : 'false');
      b.dataset.mode = id;
      b.innerHTML = `<span class="asst-routes-mode-label">${esc(routeModeLabel(id, hooks.t))}</span><span class="asst-routes-mode-desc">${esc(routeModeDescription(id, brainName, hooks.t))}</span>`;
      b.addEventListener('click', () => { state.defaultMode = id; render(); modal.querySelector(`.asst-routes-mode[data-mode="${id}"]`)?.focus(); });
      modes.appendChild(b);
    }
    modeSection.appendChild(modes);
    body.appendChild(modeSection);

    // Task routes
    const section = el('section', 'asst-routes-section');
    section.appendChild(el('div', 'asst-routes-section-title', tr('assistant.routes.taskRoutes', 'Task routes')));
    const list = el('div', 'asst-routes-list');
    for (const row of taskRows()) list.appendChild(taskRow(row));
    section.appendChild(list);
    body.appendChild(section);
    saveBtn.disabled = state.saving;
  }

  function taskRow(row) {
    const pref = effectivePref(row.id);
    const medium = row.requires || null;
    const seeing = !medium && row.visionOnly === true;
    // A saved route onto a model the user hid is never applied (the brain decides); nor, for
    // image / video creation, one onto a model that cannot generate the medium, or for design one
    // the router would skip (not known to see, missing from the catalog, unavailable).
    const sight = seeing && pref ? designRouteSight(pref, state.catalog) : null;
    const source = pref?.model && hiddenModelFor(pref.provider, pref.model) ? 'disabled'
      : medium && pref && routeMakes(pref, medium) === false ? 'incapable'
        : sight && sight !== 'ok' ? 'incapable' : sourceOf(row.id);
    const emptyLabel = medium ? tr('assistant.routes.noCapableModel', 'No model in your catalog can make {medium} yet.', { medium: mediumWords(medium, tr) })
      : seeing ? tr('assistant.routes.noSeeingModel', 'No model in your catalog can see images yet.') : '';
    const node = el('div', 'asst-routes-row');
    node.dataset.taskClass = row.id;
    const main = el('div', 'asst-routes-row-main');
    main.appendChild(el('div', 'asst-routes-row-label', row.label));
    if (row.description) main.appendChild(el('div', 'asst-routes-row-desc', row.description));
    if ((medium && noMaker(medium)) || (seeing && noSeer())) main.appendChild(el('div', 'asst-routes-row-note', emptyLabel));
    node.appendChild(main);

    const modelBtn = el('button', 'asst-dd asst-routes-model');
    modelBtn.type = 'button';
    modelBtn.setAttribute('aria-haspopup', 'menu');
    const label = pref ? routeTargetLabel(pref) : tr('assistant.routes.brainDecides', 'Let the brain decide');
    modelBtn.innerHTML = `${pref?.provider ? `<span class="asst-icon" aria-hidden="true" style="color:${esc(providerColor(pref.provider))}">${providerIconHtml(pref.provider, hooks)}</span>` : ''}<span class="asst-dd-label"></span>`;
    modelBtn.querySelector('.asst-dd-label').textContent = label;
    modelBtn.setAttribute('aria-label', `${row.label}: ${label}`);
    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isMenuOpen(modelBtn)) { closeMenu(); return; }
      openModelMenu(modelBtn, {
        brain: hooks.getBrain?.() || null,
        t: hooks.t,
        includeHere: true,
        hereLabel: tr('assistant.routes.brainDecides', 'Let the brain decide'),
        title: row.label,
        current: pref ? { provider: pref.provider, model: pref.model } : null,
        onToast: hooks.onToast,
        // Image / video creation: only models that generate the medium (no custom id: its output is unknown);
        // design: only models that can see.
        ...(medium ? { accept: (_p, m) => m?.outputs?.[medium] === true, allowCustom: false, emptyLabel } : {}),
        ...(seeing ? { accept: (_p, m) => m?.vision === true && m?.status !== 'unavailable', allowCustom: false, emptyLabel } : {}),
        onSelect: (target) => {
          if (target?.here) state.patch[row.id] = null;
          else if (target?.model) {
            // The effort survives when the new model runs it; otherwise the nearest level it does.
            const ids = modelEffortIds(catalogModelRow(target.provider, target.model, state.catalog));
            const effort = !pref?.effort ? null : (ids ? clampEffortId(pref.effort, ids) : (pref.provider === target.provider ? pref.effort : null));
            state.patch[row.id] = { kind: row.defaultKind || 'direct', provider: target.provider, model: target.model, effort, label: target.label || '' };
          }
          render();
          modal.querySelector(`.asst-routes-row[data-task-class="${CSS.escape(row.id)}"] .asst-routes-model`)?.focus();
        },
      });
    });
    node.appendChild(modelBtn);

    // Exactly the selected model's levels (the provider list only for an unknown model).
    const modelRow = pref?.provider ? catalogModelRow(pref.provider, pref.model, state.catalog) : null;
    const efforts = pref?.provider ? getEffortLevelsForModel(pref.provider, modelRow) : [];
    if (pref && efforts.some(e => e.id !== 'off')) {
      const effortBtn = el('button', 'asst-dd asst-routes-effort');
      effortBtn.type = 'button';
      effortBtn.setAttribute('aria-haspopup', 'menu');
      const level = efforts.find(e => e.id === pref.effort);
      const autoLabel = modelRow?.defaultEffort
        ? tr('assistant.routes.effortAutoDefault', 'auto ({effort})', { effort: efforts.find(e => e.id === modelRow.defaultEffort)?.label?.toLowerCase() || modelRow.defaultEffort })
        : tr('assistant.routes.effortAuto', 'auto effort');
      const effortLabel = level ? level.label
        : pref.effort ? tr('assistant.routes.effortUnsupported', '{effort} · unsupported', { effort: pref.effort })
          : autoLabel;
      effortBtn.innerHTML = '<span class="asst-dd-label"></span>';
      effortBtn.querySelector('.asst-dd-label').textContent = effortLabel;
      effortBtn.setAttribute('aria-label', `${tr('assistant.brain.effort', 'Thinking effort')}: ${effortLabel}`);
      effortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isMenuOpen(effortBtn)) { closeMenu(); return; }
        openMenu(effortBtn, {
          title: tr('assistant.brain.effort', 'Thinking effort'),
          role: 'menu',
          items: [
            { kind: 'radio', id: '', label: autoLabel, selected: !pref.effort, onSelect: () => { state.patch[row.id] = { ...pref, effort: null }; render(); } },
            ...efforts.filter(x => x.id !== 'off').map(x => ({ kind: 'radio', id: x.id, label: x.label, desc: x.desc || '', selected: pref.effort === x.id, onSelect: () => { state.patch[row.id] = { ...pref, effort: x.id }; render(); } })),
          ],
        });
      });
      node.appendChild(effortBtn);
    }

    const badge = el('span', 'asst-routes-source', sourceLabel(source));
    badge.dataset.source = source;
    if (source === 'incapable') {
      badge.setAttribute('data-tooltip', !seeing ? tr('assistant.routes.incapableTip', "This model can't generate {medium}, so the route is not applied.", { medium: mediumWords(medium, tr) })
        : sight === 'blind' ? tr('assistant.routes.incapableSeeTip', "This model can't see images, so the route is not applied.")
          : sight === 'unavailable' ? tr('assistant.routes.unavailableTip', "This model isn't available right now, so the route is not applied.")
            : tr('assistant.routes.unknownSeeTip', "This model isn't known to see images, so the route is not applied."));
    }
    node.appendChild(badge);

    const reset = el('button', 'asst-iconbtn asst-routes-reset', '↺');
    reset.type = 'button';
    reset.setAttribute('aria-label', tr('assistant.routes.reset', 'Reset {taskClass}', { taskClass: row.label }));
    reset.setAttribute('data-tooltip', tr('assistant.routes.resetTip', 'Back to default'));
    reset.hidden = source === 'default';
    reset.addEventListener('click', () => { state.patch[row.id] = null; render(); });
    node.appendChild(reset);
    return node;
  }

  async function load() {
    state.error = '';
    state.conflict = false;
    try {
      const [data, catalog] = await Promise.all([getRouting(), loadModelCatalog().catch(() => null)]);
      state.catalog = catalog || null;
      state.data = data || {};
      state.version = data?.version ?? null;
      state.defaultMode = normalizeRouteMode(data?.routing?.defaultMode, DEFAULT_ROUTE_MODE);
      state.prefs = obj(data?.routing?.preferences) ? { ...data.routing.preferences } : {};
      state.patch = {};
    } catch (err) {
      state.data = null;
      state.error = err?.status === 404
        ? tr('assistant.routes.unavailable', 'Model routing is not available on this server yet.')
        : `${tr('assistant.routes.loadFailed', 'Could not load model routes')}: ${err?.message || err}`;
    }
    render();
    modal.querySelector('.asst-routes-mode[aria-checked="true"]')?.focus();
  }

  resetAllBtn.addEventListener('click', () => {
    for (const key of new Set([...Object.keys(state.prefs), ...Object.keys(state.patch)])) state.patch[key] = null;
    render();
  });

  saveBtn.addEventListener('click', async () => {
    if (!state.data || state.saving) return;
    state.saving = true;
    saveBtn.disabled = true;
    const patch = { defaultMode: state.defaultMode };
    if (Object.keys(state.patch).length) patch.preferences = { ...state.patch };
    try {
      const res = await putRouting(patch, state.version);
      try { hooks.onSaved?.(res?.routing || null, res); } catch { /* ignore */ }
      close();
    } catch (err) {
      state.saving = false;
      if (err?.status === 409 || err?.code === 'VERSION_CONFLICT') {
        state.error = tr('assistant.routes.conflict', 'Changed elsewhere — reload');
        state.conflict = true;
      } else if (err?.code === 'ROUTING_INVALID') {
        state.error = tr('assistant.routes.invalidField', 'Invalid routing setting: {field}', { field: err?.message || '' });
      } else {
        state.error = `${tr('assistant.routes.saveFailed', 'Could not save')}: ${err?.message || err}`;
      }
      render();
    }
  });

  await load();
  return { el: overlay, close };
}

// ── Models manager (Assistant → Models…) ───────────────────────────────────

const MODEL_SECTIONS = ['claude-code', 'codex', 'opencode'];
const MODEL_TABS = ['available', 'archived'];
let _modelsManager = null;

/** "N of M on" for one section. */
export function modelsOnText(rows, t = null) {
  const list = arr(rows);
  const on = list.filter(r => !r.hidden).length;
  return tf(t)('assistant.models.countOn', '{on} of {total} on', { on: String(on), total: String(list.length) });
}

/** Archived entries grouped by OpenCode provider prefix: [[prefix, entries], …] sorted by prefix. */
export function groupArchived(entries) {
  const groups = new Map();
  for (const entry of arr(entries)) {
    const key = entry.group || String(entry.id).split('/')[0] || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Every Assistant model, per provider, in two tabs. Available: the models in
 * use, each with an on/off switch; off = hidden from the router, dispatch,
 * the catalog and every Assistant model menu. Archived: every hidden id
 * (context variants are their own rows), with Restore and Restore all; an id
 * no provider lists any more is marked "not listed" and can still be
 * restored. Changes PATCH /api/assistant/hidden-models at once.
 * hooks: { t, tab: 'available'|'archived', providerIcon, getBrain() → brain, onToast(text), onChanged(providers), onClose() }
 */
export async function openModelsManager(hooks = {}) {
  if (_modelsManager) { _modelsManager.close(); }
  const tr = tf(hooks.t);
  const title = tr('assistant.models.title', 'Models');
  const overlay = el('div', 'asst-modal-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  const modal = el('div', 'asst-modal asst-routes-modal asst-models-modal');
  const uid = `asst-models-${Date.now().toString(36)}`;
  modal.innerHTML = `
    <div class="asst-modal-head"><span class="asst-icon" aria-hidden="true">${ICON_ROUTE}</span><span>${esc(title)}</span><button type="button" class="asst-iconbtn asst-modal-close" aria-label="${esc(tr('common.close', 'Close'))}">${ICON_X}</button></div>
    <div class="asst-models-tabs" role="tablist" aria-label="${esc(title)}">
      <button type="button" class="asst-models-tab" role="tab" id="${uid}-tab-available" data-tab="available" aria-controls="${uid}-panel">${esc(tr('assistant.models.tabAvailable', 'Available'))}</button>
      <button type="button" class="asst-models-tab" role="tab" id="${uid}-tab-archived" data-tab="archived" aria-controls="${uid}-panel">${esc(tr('assistant.models.tabArchived', 'Archived'))} <span class="asst-models-badge" aria-hidden="true">0</span></button>
    </div>
    <div class="asst-modal-body">
      <div class="asst-modal-note asst-models-intro"></div>
      <input type="search" class="asst-dd-input asst-models-filter" placeholder="${esc(tr('assistant.models.filter', 'Filter models…'))}" aria-label="${esc(tr('assistant.models.filter', 'Filter models…'))}">
      <div class="asst-models-sections" role="tabpanel" id="${uid}-panel"><div class="asst-modal-note">${esc(tr('common.loading', 'Loading...'))}</div></div>
    </div>
    <div class="asst-modal-foot"><span class="asst-modal-spacer"></span><button type="button" class="asst-btn asst-btn-primary asst-models-done">${esc(tr('assistant.models.done', 'Done'))}</button></div>`;
  overlay.appendChild(modal);
  const sections = modal.querySelector('.asst-models-sections');
  const filterInput = modal.querySelector('.asst-models-filter');
  const intro = modal.querySelector('.asst-models-intro');
  const tabs = [...modal.querySelectorAll('.asst-models-tab')];
  const badge = modal.querySelector('.asst-models-badge');
  const returnTo = document.activeElement;
  const state = { tab: MODEL_TABS.includes(hooks.tab) ? hooks.tab : 'available', models: null, archived: {}, error: '', filter: '', busy: new Set(), openGroups: new Set() };

  function close() {
    if (!overlay.isConnected) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    _modelsManager = null;
    try { hooks.onClose?.(); } catch { /* ignore */ }
    if (returnTo?.isConnected) { try { returnTo.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    // Tabs: arrow keys (and Home/End) move between Available and Archived.
    const tabIndex = tabs.indexOf(e.target);
    if (tabIndex >= 0 && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (tabIndex + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.tab, { focus: true });
    }
    e.stopPropagation();
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  modal.querySelector('.asst-modal-close').addEventListener('click', close);
  modal.querySelector('.asst-models-done').addEventListener('click', close);
  filterInput.addEventListener('input', () => { state.filter = filterInput.value.trim().toLowerCase(); render(); });
  for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  document.body.appendChild(overlay);

  function selectTab(name, { focus = false } = {}) {
    state.tab = MODEL_TABS.includes(name) ? name : 'available';
    render();
    if (focus) tabs.find(t => t.dataset.tab === state.tab)?.focus({ preventScroll: true });
  }
  function syncTabs() {
    for (const tab of tabs) {
      const on = tab.dataset.tab === state.tab;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      tab.classList.toggle('is-active', on);
    }
    sections.setAttribute('aria-labelledby', `${uid}-tab-${state.tab}`);
    const total = MODEL_SECTIONS.reduce((sum, p) => sum + arr(state.archived[p]).length, 0);
    badge.textContent = String(total);
    tabs[1].setAttribute('aria-label', `${tr('assistant.models.tabArchived', 'Archived')} (${total})`);
    intro.textContent = state.tab === 'archived'
      ? tr('assistant.models.archivedIntro', 'Switched-off models. Restore one to make it available again.')
      : tr('assistant.models.intro', 'Switched-off models are never used by the router, dispatched agents or the Assistant model menus.');
  }

  function inUse(provider, row) {
    const brain = hooks.getBrain?.() || null;
    if (!brain?.provider || brain.provider !== provider || !brain.model) return false;
    const want = String(brain.model).toLowerCase();
    return want === String(row.id).toLowerCase();
  }
  function matches(row) {
    if (!state.filter) return true;
    return `${row.id} ${row.label || ''} ${row.upstream || ''} ${row.context || ''}`.toLowerCase().includes(state.filter);
  }
  function entryMatches(entry) {
    if (!state.filter) return true;
    return `${entry.id} ${arr(entry.rows).map(r => `${r.id} ${r.label || ''} ${r.context || ''}`).join(' ')}`.toLowerCase().includes(state.filter);
  }

  async function send(provider, change, onError = () => {}) {
    try {
      const res = await patchHiddenModels({ provider, ...change });
      invalidateModelCatalog();
      try { hooks.onChanged?.(res?.providers || null); } catch { /* ignore */ }
      await load({ keepFocus: true });
    } catch (err) {
      onError();
      hooks.onToast?.(`${tr('assistant.models.saveFailed', 'Could not update the model')}: ${err?.message || err}`);
    }
  }

  async function toggle(provider, row, sw) {
    const key = `${provider}:${row.id}`;
    if (state.busy.has(key)) return;
    state.busy.add(key);
    sw.setAttribute('aria-checked', 'false');
    sw.disabled = true;
    await send(provider, { hide: [row.id] }, () => { sw.setAttribute('aria-checked', 'true'); });
    state.busy.delete(key);
    sw.disabled = false;
  }

  async function restore(provider, ids, btn) {
    const list = arr(ids).filter(Boolean);
    if (!list.length) return;
    const key = `${provider}:restore:${list.join('\n')}`;
    if (state.busy.has(key)) return;
    state.busy.add(key);
    if (btn) btn.disabled = true;
    await send(provider, { show: list }, () => { if (btn?.isConnected) btn.disabled = false; });
    state.busy.delete(key);
  }

  function rowDesc(row) {
    const price = Array.isArray(row.price) ? fmtModelPrice({ input: row.price[0], output: row.price[1] }) : fmtModelPrice(row.price);
    return [row.id, row.context, row.tier, price, row.vision === true ? tr('assistant.brain.vision', 'vision') : ''].filter(Boolean).join(' · ');
  }

  function modelRow(provider, row) {
    const node = el('div', 'asst-routes-row asst-models-row');
    node.dataset.model = row.id;
    const main = el('div', 'asst-routes-row-main');
    const label = el('div', 'asst-routes-row-label', row.label || row.id);
    if (row.context) label.appendChild(el('span', 'asst-models-ctx', row.context));
    if (inUse(provider, row)) {
      const inUseBadge = el('span', 'asst-routes-source asst-models-inuse', tr('assistant.models.inUse', 'in use by this Assistant'));
      inUseBadge.dataset.source = 'remembered';
      label.appendChild(document.createTextNode(' '));
      label.appendChild(inUseBadge);
    }
    main.appendChild(label);
    main.appendChild(el('div', 'asst-routes-row-desc', rowDesc(row)));
    node.appendChild(main);
    const sw = el('button', 'asst-models-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'true');
    sw.setAttribute('aria-label', `${row.label || row.id}${row.context ? ` (${row.context})` : ''}: ${tr('assistant.models.available', 'available')}`);
    sw.innerHTML = '<span class="asst-models-knob" aria-hidden="true"></span>';
    sw.addEventListener('click', () => toggle(provider, row, sw));
    node.appendChild(sw);
    return node;
  }

  function archivedRow(provider, entry) {
    const node = el('div', 'asst-routes-row asst-models-row asst-models-archived-row');
    node.dataset.model = entry.id;
    const main = el('div', 'asst-routes-row-main');
    const covered = arr(entry.rows);
    const label = el('div', 'asst-routes-row-label', covered.length === 1 ? (covered[0].label || entry.id) : entry.id);
    if (covered.length === 1 && covered[0].context) label.appendChild(el('span', 'asst-models-ctx', covered[0].context));
    if (!entry.listed) {
      const nl = el('span', 'asst-routes-source asst-models-unlisted', tr('assistant.models.notListed', 'not listed'));
      nl.dataset.source = 'unlisted';
      label.appendChild(document.createTextNode(' '));
      label.appendChild(nl);
    }
    main.appendChild(label);
    const desc = covered.length > 1
      ? `${entry.id} · ${tr('assistant.models.covers', 'covers {models}', { models: covered.map(r => `${r.id}${r.context ? ` (${r.context})` : ''}`).join(', ') })}`
      : [entry.id, covered[0]?.id && covered[0].id !== entry.id ? covered[0].id : ''].filter(Boolean).join(' · ');
    main.appendChild(el('div', 'asst-routes-row-desc', desc));
    node.appendChild(main);
    const btn = el('button', 'asst-btn asst-models-restore', tr('assistant.models.restore', 'Restore'));
    btn.type = 'button';
    btn.setAttribute('aria-label', `${tr('assistant.models.restore', 'Restore')} ${entry.id}`);
    btn.addEventListener('click', () => restore(provider, [entry.id], btn));
    node.appendChild(btn);
    return node;
  }

  function restoreAllButton(provider, entries, text) {
    const btn = el('button', 'asst-btn asst-models-restore-all', text);
    btn.type = 'button';
    btn.addEventListener('click', () => restore(provider, entries.map(e => e.id), btn));
    return btn;
  }

  function sectionHead(provider, countText) {
    const meta = getProviderMeta(provider);
    const section = el('section', 'asst-routes-section asst-models-section');
    section.dataset.provider = provider;
    const head = el('div', 'asst-routes-section-title asst-models-head');
    head.appendChild(el('span', null, meta.label || provider));
    head.appendChild(el('span', 'asst-models-count', countText));
    section.appendChild(head);
    return { section, head };
  }

  function renderAvailable() {
    for (const provider of MODEL_SECTIONS) {
      const rows = arr(state.models[provider]);
      const { section } = sectionHead(provider, modelsOnText(rows, hooks.t));
      if (provider === 'opencode') section.appendChild(el('div', 'asst-modal-note', tr('assistant.models.opencodeNote', 'Connected OpenCode models only. Settings → OpenCode edits the same list.')));
      const visible = rows.filter(r => !r.hidden && matches(r));
      const list = el('div', 'asst-routes-list');
      for (const row of visible) list.appendChild(modelRow(provider, row));
      if (!visible.length) list.appendChild(el('div', 'asst-modal-note', rows.some(r => !r.hidden) ? tr('assistant.models.noMatch', 'No models match.') : tr('assistant.models.none', 'No models listed.')));
      section.appendChild(list);
      sections.appendChild(section);
    }
  }

  function renderArchived() {
    let any = false;
    for (const provider of MODEL_SECTIONS) {
      const entries = arr(state.archived[provider]);
      if (!entries.length) continue;
      any = true;
      const shown = entries.filter(entryMatches);
      const { section, head } = sectionHead(provider, tr('assistant.models.countArchived', '{count} archived', { count: String(entries.length) }));
      if (shown.length) head.appendChild(restoreAllButton(provider, shown, state.filter ? tr('assistant.models.restoreShown', 'Restore {count} shown', { count: String(shown.length) }) : tr('assistant.models.restoreAll', 'Restore all')));
      const list = el('div', 'asst-routes-list');
      if (provider === 'opencode') {
        // Hundreds of ids: one collapsed group per upstream provider; rows render when opened.
        for (const [group, groupEntries] of groupArchived(shown)) {
          const details = el('details', 'asst-models-group');
          const summary = el('summary', 'asst-models-group-head');
          summary.appendChild(el('span', null, group || '—'));
          summary.appendChild(el('span', 'asst-models-count', String(groupEntries.length)));
          details.appendChild(summary);
          const body = el('div', 'asst-models-group-body');
          details.appendChild(body);
          const fill = () => {
            if (body.childElementCount) return;
            body.appendChild(restoreAllButton(provider, groupEntries, tr('assistant.models.restoreGroup', 'Restore {count} from {group}', { count: String(groupEntries.length), group })));
            for (const entry of groupEntries) body.appendChild(archivedRow(provider, entry));
          };
          if (state.openGroups.has(group) || (state.filter && shown.length <= 60)) { details.open = true; fill(); }
          details.addEventListener('toggle', () => {
            if (details.open) { state.openGroups.add(group); fill(); } else state.openGroups.delete(group);
          });
          list.appendChild(details);
        }
      } else {
        for (const entry of shown) list.appendChild(archivedRow(provider, entry));
      }
      if (!shown.length) list.appendChild(el('div', 'asst-modal-note', tr('assistant.models.noMatch', 'No models match.')));
      section.appendChild(list);
      sections.appendChild(section);
    }
    if (!any) sections.appendChild(el('div', 'asst-modal-note', tr('assistant.models.noneArchived', 'No archived models. Switch one off in Available to archive it.')));
  }

  function render() {
    syncTabs();
    sections.innerHTML = '';
    if (state.error) {
      const banner = el('div', 'asst-routes-error');
      banner.setAttribute('role', 'alert');
      banner.appendChild(el('span', null, state.error));
      sections.appendChild(banner);
    }
    if (!state.models) return;
    if (state.tab === 'archived') renderArchived();
    else renderAvailable();
  }

  async function load({ keepFocus = false } = {}) {
    state.error = '';
    try {
      const data = await fetchManageCatalog();
      state.models = obj(data?.models) || {};
      state.archived = obj(data?.archived) || {};
    } catch (err) {
      state.models = null;
      state.error = `${tr('assistant.models.loadFailed', 'Could not load the models')}: ${err?.message || err}`;
    }
    render();
    if (!keepFocus) filterInput.focus({ preventScroll: true });
  }

  _modelsManager = { close, reload: () => load({ keepFocus: true }), selectTab };
  syncTabs();
  await load();
  return { el: overlay, close, reload: load, selectTab };
}

/** Reload an open Models manager (another window changed the lists). */
export function refreshModelsManager() {
  if (_modelsManager) _modelsManager.reload().catch?.(() => {});
}

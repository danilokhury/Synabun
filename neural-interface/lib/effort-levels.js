// ═══════════════════════════════════════════
// SynaBun — effort levels: one vocabulary, checked per model
// ═══════════════════════════════════════════
//
// Every provider names its reasoning levels differently and every model
// supports its own subset: Claude Code advertises `effortLevels`, Codex
// `supportedReasoningEfforts`, OpenCode per-model `variants`. The Assistant
// catalog folds all three into `row.efforts`; this module orders them and
// corrects a requested effort to one the model really runs. The client keeps
// the same table in public/shared/agent-runtime-options.js.

import { findModel, defaultModelRow, contextVariantOf, baseModelId } from './assistant-catalog.js';

/** Canonical order, lowest first. `thinking` (an OpenCode variant) is "on", just above none. */
export const EFFORT_ORDER = Object.freeze(['none', 'thinking', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export const EFFORT_LABELS = Object.freeze({
  none: 'None', thinking: 'Thinking', minimal: 'Min', low: 'Low', medium: 'Med',
  high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra',
});

/** Every value `codex exec --config model_reasoning_effort=…` accepts. */
const CODEX_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const AUTO = new Set(['', 'off', 'default', 'auto']);

function clean(value) { return String(value ?? '').trim(); }

/** Position in EFFORT_ORDER, or -1 for an id outside the vocabulary. */
export function effortRank(id) { return EFFORT_ORDER.indexOf(clean(id).toLowerCase()); }

/** Title-cased label for any id ("xhigh" → "XHigh", "deep-think" → "Deep Think"). */
export function effortLabel(id) {
  const value = clean(id);
  return EFFORT_LABELS[value.toLowerCase()]
    || value.split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

/** Unique ids in canonical order; ids outside the vocabulary keep their order, last. */
export function sortEfforts(ids = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = clean(typeof raw === 'string' ? raw : (raw?.reasoningEffort || raw?.effort || raw?.id || ''));
    if (!id || AUTO.has(id.toLowerCase()) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push(id);
  }
  const known = out.filter((id) => effortRank(id) >= 0).sort((a, b) => effortRank(a) - effortRank(b));
  return [...known, ...out.filter((id) => effortRank(id) < 0)];
}

/** OpenCode `variants` (object or array) → the enabled variant names. */
export function variantNames(variants) {
  if (Array.isArray(variants)) return variants.map((v) => (typeof v === 'string' ? v : v?.name || v?.id)).filter(Boolean);
  if (!variants || typeof variants !== 'object') return [];
  return Object.entries(variants).filter(([, value]) => !(value && typeof value === 'object' && value.disabled === true)).map(([name]) => name);
}

/**
 * The levels a model runs, in canonical order, from any row shape: catalog
 * `efforts`, Claude `effortLevels`, Codex `supportedReasoningEfforts` (strings
 * or { reasoningEffort | effort }), OpenCode `variants`. [] = the model takes
 * no effort. null = the row says nothing about effort (can't check).
 */
export function modelEfforts(row) {
  if (!row || typeof row !== 'object') return null;
  const source = Array.isArray(row.efforts) ? row.efforts
    : Array.isArray(row.effortLevels) ? row.effortLevels
    : Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts
    : Array.isArray(row.supported_reasoning_efforts) ? row.supported_reasoning_efforts
    : row.variants !== undefined ? variantNames(row.variants)
    : null;
  return source ? sortEfforts(source) : null;
}

/** `effort` clamped into `levels`: kept, else the highest level below it, else the lowest. */
export function clampEffort(effort, levels, { fallback = null } = {}) {
  const want = clean(effort);
  if (!want || !levels?.length) return null;
  const same = levels.find((id) => id.toLowerCase() === want.toLowerCase());
  if (same) return same;
  const rank = effortRank(want);
  if (rank < 0) return fallback && levels.includes(fallback) ? fallback : null;
  const ranked = levels.filter((id) => effortRank(id) >= 0);
  const below = ranked.filter((id) => effortRank(id) < rank);
  if (below.length) return below[below.length - 1];
  return ranked[0] || levels[0];
}

function rowFor(catalog, provider, model) {
  if (!model) return { row: defaultModelRow(catalog, provider), match: 'default' };
  let hit = findModel(catalog, provider, model);
  if (!hit?.row && contextVariantOf(model)) hit = findModel(catalog, provider, baseModelId(model)) || hit;
  return hit || null;
}

/**
 * Check `effort` against the model's levels. → { effort, corrected: {from, to} | null }.
 * off/default/auto/empty → null (the model's own default). Supported → kept.
 * Unsupported → the highest supported level below it, else the lowest
 * (minimal → low, ultra on a max-only model → max). A model with no levels →
 * null. Unknown model or unverified catalog → passed through unchanged: a value
 * we cannot check is never dropped.
 */
export function normalizeEffort({ provider = null, model = null, effort = null, catalog = null } = {}) {
  const raw = clean(effort).slice(0, 40);
  if (AUTO.has(raw.toLowerCase())) return { effort: null, corrected: null };
  if (!catalog || !provider) return { effort: raw, corrected: null };
  const row = rowFor(catalog, provider, model)?.row || null;
  const levels = modelEfforts(row);
  if (!levels) return { effort: raw, corrected: null };
  const next = clampEffort(raw, levels, { fallback: row?.defaultEffort || null });
  return next === raw ? { effort: raw, corrected: null } : { effort: next, corrected: { from: raw, to: next } };
}

/** The model's levels for a provider/model pair (null when unknown). */
export function effortsFor(catalog, provider, model) {
  if (!catalog || !provider) return null;
  return modelEfforts(rowFor(catalog, provider, model)?.row || null);
}

/**
 * Codex worker value for `model_reasoning_effort`: every level Codex accepts
 * passes through unchanged (max stays max, ultra stays ultra); off → undefined.
 */
export function codexReasoningEffort(effort) {
  const value = clean(effort).toLowerCase();
  return CODEX_EFFORTS.has(value) ? value : undefined;
}

/**
 * Saved route preferences whose effort their model does not run.
 * → { fixes: [{ key, target, from, to }], unverified } — `unverified` = some
 * preference's provider list was unavailable, so it was left alone (retry later).
 * Idempotent: a repaired preference produces no fix the next time.
 */
export function repairPreferenceEfforts(preferences = {}, catalog = null) {
  const fixes = [];
  let unverified = false;
  if (!catalog) return { fixes, unverified: true };
  for (const [key, pref] of Object.entries(preferences || {})) {
    if (!pref?.provider || !pref.effort) continue;
    if (!(catalog.models?.[pref.provider] || []).length) { unverified = true; continue; }
    const { effort, corrected } = normalizeEffort({ provider: pref.provider, model: pref.model || null, effort: pref.effort, catalog });
    if (corrected) fixes.push({ key, target: { ...pref, effort }, from: corrected.from, to: corrected.to });
  }
  return { fixes, unverified };
}

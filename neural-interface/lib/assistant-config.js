// ═══════════════════════════════════════════
// SynaBun — Assistant config store (~/.synabun/data/assistant-config.json)
// ═══════════════════════════════════════════
//
// The assistant's user-editable knobs live in one JSON file: `defaultBrain`,
// `persona`, `limits`, `memory` (read by the other assistant modules),
// `routing` and the budget caps (owned here; see assistant-budget.js). Knobs
// are data: the file is re-read when its mtime changes, so a PUT from the
// routes or budget editor, or a hand edit, applies without a restart. Writes
// are atomic (tmp + rename) and keep every unknown key.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { effectiveBudget, validateBudgetPatch, writeBudgetInto } from './assistant-budget.js';

export const ROUTE_MODES = ['always-ask', 'ask-unsure', 'never'];
export const PREFERENCE_KINDS = ['direct', 'dispatch'];
export const ROUTE_PROVIDERS = ['claude-code', 'codex', 'opencode'];

export const DEFAULT_ROUTING = Object.freeze({
  defaultMode: 'ask-unsure',
  askBelow: 0.75,
  waitSeconds: 45,
  cardTimeoutMinutes: 30,
  preferences: Object.freeze({}),
  ladders: Object.freeze({}),
  catalogFilter: Object.freeze({}),
});

/** always/ask → always-ask; unsure → ask-unsure; auto/autonomous/never → never. */
export function normalizeRouteMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (ROUTE_MODES.includes(raw)) return raw;
  if (raw === 'always' || raw === 'ask' || raw === 'always_ask') return 'always-ask';
  if (raw === 'unsure' || raw === 'ask_unsure' || raw === 'ask-when-unsure' || raw === 'when-unsure') return 'ask-unsure';
  if (raw === 'auto' || raw === 'autonomous' || raw === 'never-ask' || raw === 'never_ask' || raw === 'off') return 'never';
  return null;
}

function routingError(field, message) {
  const error = new Error(message || `Invalid routing.${field}`);
  error.code = 'ROUTING_INVALID';
  error.field = field;
  error.status = 400;
  return error;
}

function cleanTarget(field, target) {
  if (target === null) return null;
  if (!target || typeof target !== 'object') throw routingError(field, `routing.${field} must be an object or null`);
  const kind = PREFERENCE_KINDS.includes(target.kind) ? target.kind : 'dispatch';
  const provider = String(target.provider || '').trim();
  if (!ROUTE_PROVIDERS.includes(provider)) throw routingError(`${field}.provider`, `routing.${field}.provider must be one of ${ROUTE_PROVIDERS.join(', ')}`);
  const out = { kind, provider, model: target.model ? String(target.model).slice(0, 200) : null, effort: target.effort ? String(target.effort).slice(0, 40) : null };
  if (target.label) out.label = String(target.label).slice(0, 120);
  if (target.at) out.at = String(target.at).slice(0, 40);
  if (target.by) out.by = String(target.by).slice(0, 20);
  return out;
}

/**
 * Validate a partial routing patch. `preferences: { code: null }` deletes a
 * preference; unknown preference keys are refused when `taskClasses` is given.
 */
export function validateRoutingPatch(patch = {}, { taskClasses = null } = {}) {
  if (!patch || typeof patch !== 'object') throw routingError('routing', 'routing must be an object');
  const out = {};
  if ('defaultMode' in patch) {
    const mode = normalizeRouteMode(patch.defaultMode);
    if (!mode) throw routingError('defaultMode', `routing.defaultMode must be one of ${ROUTE_MODES.join(', ')}`);
    out.defaultMode = mode;
  }
  if ('askBelow' in patch) {
    const n = Number(patch.askBelow);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw routingError('askBelow', 'routing.askBelow must be between 0 and 1');
    out.askBelow = n;
  }
  if ('waitSeconds' in patch) {
    const n = Number(patch.waitSeconds);
    if (!Number.isFinite(n) || n < 0 || n > 110) throw routingError('waitSeconds', 'routing.waitSeconds must be between 0 and 110');
    out.waitSeconds = Math.round(n);
  }
  if ('cardTimeoutMinutes' in patch) {
    const n = Number(patch.cardTimeoutMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 24 * 60) throw routingError('cardTimeoutMinutes', 'routing.cardTimeoutMinutes must be between 1 and 1440');
    out.cardTimeoutMinutes = Math.round(n);
  }
  if ('preferences' in patch) {
    if (!patch.preferences || typeof patch.preferences !== 'object') throw routingError('preferences', 'routing.preferences must be an object');
    out.preferences = {};
    for (const [key, value] of Object.entries(patch.preferences)) {
      if (taskClasses && !taskClasses.includes(key)) throw routingError(`preferences.${key}`, `Unknown task class "${key}"`);
      out.preferences[key] = cleanTarget(`preferences.${key}`, value);
    }
  }
  if ('ladders' in patch) {
    if (!patch.ladders || typeof patch.ladders !== 'object') throw routingError('ladders', 'routing.ladders must be an object');
    out.ladders = {};
    for (const [provider, ladder] of Object.entries(patch.ladders)) {
      if (!ROUTE_PROVIDERS.includes(provider)) throw routingError(`ladders.${provider}`, `Unknown provider "${provider}"`);
      if (ladder !== null && !Array.isArray(ladder)) throw routingError(`ladders.${provider}`, 'Each ladder is an array of model ids');
      out.ladders[provider] = ladder === null ? null : ladder.map((id) => String(id).slice(0, 200)).filter(Boolean).slice(0, 12);
    }
  }
  if ('catalogFilter' in patch) {
    if (!patch.catalogFilter || typeof patch.catalogFilter !== 'object') throw routingError('catalogFilter', 'routing.catalogFilter must be an object');
    out.catalogFilter = {};
    for (const [provider, globs] of Object.entries(patch.catalogFilter)) {
      if (globs !== null && !Array.isArray(globs)) throw routingError(`catalogFilter.${provider}`, 'Each filter is an array of "provider/model" globs');
      out.catalogFilter[provider] = globs === null ? null : globs.map((g) => String(g).slice(0, 200)).filter(Boolean).slice(0, 40);
    }
  }
  return out;
}

function mergeRouting(base = {}, patch = {}) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'preferences' || key === 'ladders' || key === 'catalogFilter') {
      const merged = { ...(base[key] || {}) };
      for (const [inner, innerValue] of Object.entries(value || {})) {
        if (innerValue === null) delete merged[inner];
        else merged[inner] = innerValue;
      }
      next[key] = merged;
    } else next[key] = value;
  }
  return next;
}

/** Effective routing = defaults + file values (sanitized; bad values fall back). */
export function effectiveRouting(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const mode = normalizeRouteMode(r.defaultMode) || DEFAULT_ROUTING.defaultMode;
  const num = (value, fallback, min, max) => { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? n : fallback; };
  return {
    defaultMode: mode,
    askBelow: num(r.askBelow, DEFAULT_ROUTING.askBelow, 0, 1),
    waitSeconds: Math.round(num(r.waitSeconds, DEFAULT_ROUTING.waitSeconds, 0, 110)),
    cardTimeoutMinutes: Math.round(num(r.cardTimeoutMinutes, DEFAULT_ROUTING.cardTimeoutMinutes, 1, 1440)),
    preferences: r.preferences && typeof r.preferences === 'object' ? { ...r.preferences } : {},
    ladders: r.ladders && typeof r.ladders === 'object' ? { ...r.ladders } : {},
    catalogFilter: r.catalogFilter && typeof r.catalogFilter === 'object' ? { ...r.catalogFilter } : {},
  };
}

export function createAssistantConfigStore({ path, log = () => {}, now = Date.now } = {}) {
  if (!path) throw new Error('createAssistantConfigStore requires path');
  let cached = null; // { mtimeMs, value }
  const listeners = new Set();

  function mtime() { try { return statSync(path).mtimeMs; } catch { return 0; } }
  function read() {
    const m = mtime();
    if (cached && cached.mtimeMs === m) return cached.value;
    let value = {};
    if (m) {
      try { value = JSON.parse(readFileSync(path, 'utf8')) || {}; }
      catch (error) { log('config:unreadable', error?.message || String(error)); value = cached?.value || {}; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    cached = { mtimeMs: m, value };
    return value;
  }
  function write(value) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
    cached = { mtimeMs: mtime(), value };
    for (const listener of listeners) { try { listener(value); } catch {} }
    return value;
  }
  function routing() { return effectiveRouting(read().routing); }
  function version() { return Number(read().routing?.version) || 0; }

  /** Merge a validated partial patch. `expectedVersion` (when given) must match. */
  function patchRouting(patch = {}, { expectedVersion = null, taskClasses = null } = {}) {
    const clean = validateRoutingPatch(patch, { taskClasses });
    const current = read();
    const currentVersion = Number(current.routing?.version) || 0;
    if (expectedVersion !== null && expectedVersion !== undefined && Number(expectedVersion) !== currentVersion) {
      const error = new Error('Routing settings changed elsewhere; reload and try again.');
      error.code = 'VERSION_CONFLICT';
      error.status = 409;
      error.version = currentVersion;
      throw error;
    }
    const nextRouting = { ...mergeRouting(current.routing || {}, clean), version: currentVersion + 1, updatedAt: new Date(now()).toISOString() };
    write({ ...current, routing: nextRouting });
    return { routing: effectiveRouting(nextRouting), version: nextRouting.version };
  }

  /** Effective budget caps (assistant-budget.js effectiveBudget) + the file's budget version. */
  function budget() {
    const raw = read();
    return { ...effectiveBudget(raw), version: Number(raw.limits?.budgetVersion) || 0 };
  }
  function budgetVersion() { return Number(read().limits?.budgetVersion) || 0; }

  /**
   * Validate and save budget caps (a partial patch; `null` resets a field).
   * `expectedVersion` (when given) must match. Readers pick it up on their next
   * read: the dispatcher per dispatch / turn, the runtime per brain turn.
   */
  function patchBudget(patch = {}, { expectedVersion = null } = {}) {
    const current = read();
    const currentVersion = Number(current.limits?.budgetVersion) || 0;
    if (expectedVersion !== null && expectedVersion !== undefined && Number(expectedVersion) !== currentVersion) {
      const error = new Error('Budget settings changed elsewhere; reload and try again.');
      error.code = 'VERSION_CONFLICT';
      error.status = 409;
      error.version = currentVersion;
      throw error;
    }
    const next = validateBudgetPatch(patch, effectiveBudget(current));
    write(writeBudgetInto(current, next, { version: currentVersion + 1, at: new Date(now()).toISOString() }));
    return budget();
  }

  function setPreference(key, target, { by = 'user' } = {}) {
    const value = target ? { ...target, at: new Date(now()).toISOString(), by } : null;
    return patchRouting({ preferences: { [key]: value } });
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { read, routing, version, patchRouting, setPreference, budget, budgetVersion, patchBudget, onChange, path };
}

export function fileExists(path) { try { return existsSync(path); } catch { return false; } }

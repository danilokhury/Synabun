// ═══════════════════════════════════════════
// SynaBun — Assistant config store (~/.synabun/data/assistant-config.json)
// ═══════════════════════════════════════════
//
// The assistant's user-editable knobs live in one JSON file: `defaultBrain`,
// `persona`, `limits`, `memory` (read by the other assistant modules),
// `routing`, `budget` (owned here; see assistant-budget.js) and
// `userContext` (the three layers of assistant-user-context.js). Knobs
// are data: the file is re-read when its mtime changes, so a PUT from the
// routes or budget editor, or a hand edit, applies without a restart. Writes
// are atomic (tmp + rename) and keep every unknown key.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { effectiveBudget, needsBudgetMigration, validateBudgetPatch, writeBudgetInto } from './assistant-budget.js';
import { normalizeUserContext, USER_CONTEXT_DEFAULTS } from './assistant-user-context-budgets.js';

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
  if (target.accountId != null && target.accountId !== '') {
    if (typeof target.accountId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(target.accountId)) throw routingError(`${field}.accountId`, 'Invalid route account id');
    if (provider !== 'opencode') out.accountId = target.accountId;
  }
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

export const USER_CONTEXT_KEYS = Object.freeze(Object.keys(USER_CONTEXT_DEFAULTS));

/** A partial `userContext` patch: booleans only, known layers only. */
export function validateUserContextPatch(patch = {}) {
  const fail = (field, message) => { const error = new Error(message); error.code = 'USER_CONTEXT_INVALID'; error.field = field; error.status = 400; return error; };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('userContext', 'userContext must be an object');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!USER_CONTEXT_KEYS.includes(key)) throw fail(key, `Unknown userContext setting "${key}"`);
    if (typeof value !== 'boolean') throw fail(key, `userContext.${key} must be true or false`);
    out[key] = value;
  }
  if (!Object.keys(out).length) throw fail('userContext', `Nothing to change: send one of ${USER_CONTEXT_KEYS.join(', ')}`);
  return out;
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

  /**
   * The budget every session runs under (assistant-budget.js effectiveBudget):
   * { unlimited, amountUsd, version, updatedAt, source }. A file that still
   * holds the old five caps is migrated the first time it is read here: the
   * session hard cap becomes the amount (else the default), the old keys go,
   * and the version moves on so a client holding the old shape gets a 409.
   * A file that cannot be written keeps working on the migrated values.
   */
  function budget() {
    const raw = read();
    if (!needsBudgetMigration(raw)) return effectiveBudget(raw);
    const migrated = effectiveBudget(raw);
    try {
      const version = migrated.version + 1;
      write(writeBudgetInto(raw, migrated, { version, at: new Date(now()).toISOString() }));
      log('config:budget-migrated', `amountUsd ${migrated.amountUsd} (from the session hard cap) · version ${version}`);
      return { ...effectiveBudget(read()), source: 'migrated' };
    } catch (error) {
      log('config:budget-migration-failed', error?.message || String(error));
      return migrated;
    }
  }
  function budgetVersion() { return budget().version; }

  /**
   * Validate and save the budget (a partial patch: unlimited, amountUsd).
   * `expectedVersion` (when given) must match. Readers pick it up on their next
   * read: the dispatcher per dispatch / turn / metered step, the runtime per brain turn.
   */
  function patchBudget(patch = {}, { expectedVersion = null } = {}) {
    const current = budget();
    if (expectedVersion !== null && expectedVersion !== undefined && Number(expectedVersion) !== current.version) {
      const error = new Error('Budget settings changed elsewhere; reload and try again.');
      error.code = 'VERSION_CONFLICT';
      error.status = 409;
      error.version = current.version;
      throw error;
    }
    const next = validateBudgetPatch(patch, current);
    write(writeBudgetInto(read(), next, { version: current.version + 1, at: new Date(now()).toISOString() }));
    return budget();
  }

  function setPreference(key, target, { by = 'user' } = {}) {
    const value = target ? { ...target, at: new Date(now()).toISOString(), by } : null;
    return patchRouting({ preferences: { [key]: value } });
  }

  /** The user-context layers (assistant-user-context.js): knowledge, nudges, trace. All on by default; read live. */
  function userContext() { return normalizeUserContext(read().userContext); }
  /** Switch layers (a validated partial patch). Every unknown key of the file is kept. */
  function patchUserContext(patch = {}) {
    const clean = validateUserContextPatch(patch);
    const current = read();
    const stored = current.userContext && typeof current.userContext === 'object' && !Array.isArray(current.userContext) ? current.userContext : {};
    write({ ...current, userContext: { ...stored, ...clean, updatedAt: new Date(now()).toISOString() } });
    return userContext();
  }

  /**
   * Defaults for dispatched workers, read live. `claudeAccount` / `codexAccount`:
   * the account a Claude Code / Codex worker runs under when its dispatch names
   * none (null = Default).
   */
  const WORKER_ACCOUNT_KEYS = { claudeAccount: 'Claude', codexAccount: 'Codex' };
  const accountIdOf = (id) => (typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id) && id !== 'default' ? id : null);
  function workers() {
    const raw = read().workers;
    const stored = raw && typeof raw === 'object' ? raw : {};
    return { claudeAccount: accountIdOf(stored.claudeAccount), codexAccount: accountIdOf(stored.codexAccount) };
  }
  /** Save worker defaults (a partial patch; null or 'default' for an account is Default). Unknown keys stay. */
  function patchWorkers(patch = {}) {
    const current = read();
    const stored = current.workers && typeof current.workers === 'object' && !Array.isArray(current.workers) ? current.workers : {};
    const next = { ...stored };
    for (const [key, provider] of Object.entries(WORKER_ACCOUNT_KEYS)) {
      if (!Object.prototype.hasOwnProperty.call(patch || {}, key)) continue;
      const id = patch[key];
      if (id === null || id === '' || id === 'default') delete next[key];
      else if (typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id)) next[key] = id;
      else throw Object.assign(new Error(`That is not a ${provider} account id.`), { code: 'INVALID_ACCOUNT', status: 400 });
    }
    write({ ...current, workers: { ...next, updatedAt: new Date(now()).toISOString() } });
    return workers();
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { read, routing, version, patchRouting, setPreference, budget, budgetVersion, patchBudget, userContext, patchUserContext, workers, patchWorkers, onChange, path };
}

export function fileExists(path) { try { return existsSync(path); } catch { return false; } }

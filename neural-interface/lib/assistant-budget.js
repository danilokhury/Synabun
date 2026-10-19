// ═══════════════════════════════════════════
// SynaBun — Assistant budget (the one setting · list prices · Codex usage)
// ═══════════════════════════════════════════
//
// One setting for every Assistant session: { unlimited, amountUsd, version }.
// It lives in assistant-config.json under `budget` and is read live. Every new
// session starts with it; a change applies to the open sessions at once.
//
//   unlimited false  the session may spend `amountUsd` (brain + every run, at
//                    list price). The warning is fixed at 80 %; at 100 % the
//                    session stops. assistant-budget-split.js divides what is
//                    left across the providers (Jev or a fixed heuristic).
//   unlimited true   No limit: no caps, no shares, no Jev call. Spend is still
//                    metered.
//
// Older files kept five caps in `limits` (default/largest per run, session
// warning, session hard cap) and `brains.claude.maxBudgetUsd`. They are read
// once (migrateBudget): the session hard cap becomes the amount, the rest is
// dropped.
//
// Prices: Claude and OpenCode report what a turn cost. Codex reports tokens
// only, so its runs are priced from the list-price table (assistant-pricing.js,
// checked against the providers' pricing pages) and, for a model the table
// does not have, from the models.dev list OpenCode keeps in its cache
// (~/.cache/opencode/models.json, provider "openai"). A model with no list
// price in either is "unpriced": its tokens are recorded and flagged, never
// counted as $0.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRICING_SOURCES, PRICING_VERIFIED, listPrice, pricingRows } from './assistant-pricing.js';

export const BUDGET_MIN_USD = 0.1;
export const BUDGET_MAX_USD = 1000;
export const BUDGET_DEFAULT_USD = 25;
/** The one warning comes at this share of the budget. */
export const BUDGET_WARN_RATIO = 0.8;
export const BUDGET_FIELDS = Object.freeze(['unlimited', 'amountUsd']);
export const BUDGET_DEFAULTS = Object.freeze({ unlimited: false, amountUsd: BUDGET_DEFAULT_USD });
/** The keys of the old five-cap budget (`limits.*`, `brains.claude.maxBudgetUsd`), dropped by the migration. */
export const LEGACY_LIMIT_KEYS = Object.freeze(['defaultBudgetUsd', 'maxBudgetUsd', 'sessionWarnUsd', 'sessionSoftBudgetUsd', 'sessionHardBudgetUsd', 'budgetVersion', 'budgetUpdatedAt']);

function num(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function obj(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
export function roundUsd(value) { return Math.round(Number(value) * 100) / 100; }
/** Whole cents, never more than `value` (a budget never rounds up). */
export function floorCents(value) { return Math.max(0, Math.floor(Number(value) * 100 + 1e-6)); }

function budgetError(field, message) {
  const error = new Error(message);
  error.code = 'BUDGET_INVALID';
  error.field = field;
  error.status = 400;
  return error;
}
const inRange = (n) => n !== null && n >= BUDGET_MIN_USD && n <= BUDGET_MAX_USD;

/** Whether a config file still carries the old five-cap budget and no `budget` of its own. */
export function needsBudgetMigration(raw = {}) {
  if (raw?.budget && typeof raw.budget === 'object' && !Array.isArray(raw.budget)) return false;
  const limits = obj(raw?.limits);
  return LEGACY_LIMIT_KEYS.some((key) => Object.hasOwn(limits, key)) || Object.hasOwn(obj(obj(raw?.brains).claude), 'maxBudgetUsd');
}

/**
 * The budget a config file holds: its `budget` when it has one, else what an
 * older file says (the saved session hard cap, else the default).
 * → { unlimited, amountUsd, version, updatedAt, source: 'saved' | 'migrated' | 'default' }
 */
export function effectiveBudget(raw = {}) {
  const stored = raw?.budget && typeof raw.budget === 'object' && !Array.isArray(raw.budget) ? raw.budget : null;
  if (stored) {
    const amount = num(stored.amountUsd);
    return {
      unlimited: stored.unlimited === true,
      amountUsd: inRange(amount) ? roundUsd(amount) : BUDGET_DEFAULT_USD,
      version: Math.max(0, Math.floor(num(stored.version) || 0)),
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
      source: 'saved',
    };
  }
  const limits = obj(raw?.limits);
  const hard = num(limits.sessionHardBudgetUsd);
  const migrated = needsBudgetMigration(raw);
  return {
    unlimited: false,
    // The saved session hard cap is the amount (a hand edit outside the bounds is brought inside them).
    amountUsd: hard !== null && hard > 0 ? roundUsd(Math.min(BUDGET_MAX_USD, Math.max(BUDGET_MIN_USD, hard))) : BUDGET_DEFAULT_USD,
    version: Math.max(0, Math.floor(num(limits.budgetVersion) || 0)),
    updatedAt: typeof limits.budgetUpdatedAt === 'string' ? limits.budgetUpdatedAt : null,
    source: migrated ? 'migrated' : 'default',
  };
}

/** A config object without the old five-cap keys (every other key kept). */
export function withoutLegacyBudget(raw = {}) {
  const base = { ...obj(raw) };
  if (base.limits && typeof base.limits === 'object') {
    const limits = { ...base.limits };
    for (const key of LEGACY_LIMIT_KEYS) delete limits[key];
    base.limits = limits;
  }
  const brains = obj(base.brains);
  if (brains.claude && typeof brains.claude === 'object' && Object.hasOwn(brains.claude, 'maxBudgetUsd')) {
    const { maxBudgetUsd: _cap, ...claude } = brains.claude;
    base.brains = { ...brains, claude };
  }
  return base;
}

/**
 * Validate a patch ({ unlimited?, amountUsd? }) against the current budget and
 * return the full next one. Throws BUDGET_INVALID (status 400, `field`) on an
 * unknown field, a bad value or an empty patch. Amounts are kept in cents.
 */
export function validateBudgetPatch(patch = {}, current = BUDGET_DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw budgetError('budget', 'budget must be an object');
  const next = { unlimited: current?.unlimited === true, amountUsd: inRange(num(current?.amountUsd)) ? roundUsd(current.amountUsd) : BUDGET_DEFAULT_USD };
  let changed = 0;
  for (const [field, value] of Object.entries(patch)) {
    if (!BUDGET_FIELDS.includes(field)) throw budgetError(field, `Unknown budget field "${field}". Send unlimited and/or amountUsd.`);
    changed += 1;
    if (field === 'unlimited') {
      if (typeof value !== 'boolean') throw budgetError('unlimited', 'unlimited must be true or false');
      next.unlimited = value;
      continue;
    }
    const n = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
    if (!Number.isFinite(n)) throw budgetError('amountUsd', 'The budget must be an amount in US dollars');
    if (n < BUDGET_MIN_USD || n > BUDGET_MAX_USD) throw budgetError('amountUsd', `The budget must be between $${BUDGET_MIN_USD.toFixed(2)} and $${BUDGET_MAX_USD}`);
    next.amountUsd = roundUsd(n);
  }
  if (!changed) throw budgetError('budget', 'Nothing to change: send unlimited and/or amountUsd');
  return next;
}

/** A config object with `budget` written (the old caps dropped, every other key kept). */
export function writeBudgetInto(raw = {}, budget, { version = 0, at = new Date().toISOString() } = {}) {
  return {
    ...withoutLegacyBudget(raw),
    budget: { unlimited: budget.unlimited === true, amountUsd: roundUsd(budget.amountUsd), version, updatedAt: at },
  };
}

/** What the Assistant's budget limits at `spentUsd` (null amounts under No limit). */
export function budgetLimitsAt(budget, spentUsd = 0) {
  if (!budget || budget.unlimited) return { unlimited: true, amountUsd: null, warnAtUsd: null, leftUsd: null, warned: false, exceeded: false };
  const amount = Number(budget.amountUsd) || 0;
  const spent = Math.max(0, Number(spentUsd) || 0);
  const warnAt = roundUsd(amount * BUDGET_WARN_RATIO);
  return {
    unlimited: false, amountUsd: amount, warnAtUsd: warnAt,
    leftUsd: Math.max(0, Number((amount - spent).toFixed(8))),
    warned: spent >= warnAt, exceeded: spent >= amount,
  };
}

// ── list prices (models.dev, as cached by OpenCode) ───────────────────────────

export function defaultModelsDevPath(env = process.env, home = homedir()) {
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'opencode', 'models.json');
}

function rates(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const input = num(cost.input);
  const output = num(cost.output);
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0, cacheRead: num(cost.cache_read ?? cost.cacheRead), cacheWrite: num(cost.cache_write ?? cost.cacheWrite) };
}

/** models.dev cost → $/MTok rates, with the long-context tier when it has one. */
export function normalizeListPrice(cost) {
  const base = rates(cost);
  if (!base) return null;
  const tier = Array.isArray(cost.tiers) ? cost.tiers.find((t) => t?.tier?.type === 'context' && num(t.tier.size)) : null;
  const long = tier ? rates(tier) : rates(cost.context_over_200k);
  const size = tier ? num(tier.tier.size) : (long ? 200_000 : null);
  return { ...base, long: long ? { ...long, size } : null, unit: 'usd_per_mtok' };
}

/**
 * Price Codex usage ({ input_tokens, cached_input_tokens, output_tokens,
 * cache_write_input_tokens? }). input_tokens includes the cached tokens (OpenAI
 * usage). OpenAI prices a request whose prompt is over the long-context size at
 * the long rates, for the whole request:
 *   long: true / false  the usage is of requests over / under that size (the
 *                       usage meter knows it per response): priced exactly
 *   long: null          not known per request (a turn's own total): the long
 *                       rate applies when the run's context window can exceed
 *                       the size, so a long window is never under-counted
 */
export function codexUsageCostUsd(usage, price, { contextWindow = null, long = null } = {}) {
  if (!usage || !price) return null;
  const useLong = long === true || (long === null && num(contextWindow) !== null && Number(contextWindow) > Number(price.long?.size || 0));
  const r = useLong && price.long ? price.long : price;
  const input = Math.max(0, num(usage.input_tokens) || 0);
  const cached = Math.min(input, Math.max(0, num(usage.cached_input_tokens) || 0));
  const written = Math.min(input - cached, Math.max(0, num(usage.cache_write_input_tokens) || 0));
  const fresh = input - cached - written;
  const output = Math.max(0, num(usage.output_tokens) || 0);
  const cost = (fresh * r.input + cached * (r.cacheRead ?? r.input) + written * (r.cacheWrite ?? r.input) + output * r.output) / 1e6;
  return Number(cost.toFixed(8));
}

/**
 * List prices for the Assistant.
 *   codexPrice(model)   the OpenAI model a Codex run uses ("<id>[extended]" → <id>): the table's
 *                       price, else the models.dev one, else null
 *   claudePrice(model)  the table's price of a Claude model, or null
 *   status()            where prices come from, and `drift`: table models whose models.dev price
 *                       differs (the table may be out of date)
 * `data` (tests) stands in for the models.dev file and is then the only source for Codex models.
 */
export function createModelPricing({ path = defaultModelsDevPath(), data = null, readFile = (p) => readFileSync(p, 'utf8'), stat = (p) => statSync(p) } = {}) {
  let cache = null; // { mtimeMs, data }
  function load() {
    if (data) return data;
    let mtimeMs = 0;
    try { mtimeMs = stat(path).mtimeMs; } catch { cache = null; return null; }
    if (cache && cache.mtimeMs === mtimeMs) return cache.data;
    let parsed = null;
    try { parsed = JSON.parse(readFile(path)); } catch { parsed = null; }
    cache = { mtimeMs, data: parsed && typeof parsed === 'object' ? parsed : null };
    return cache.data;
  }
  const modelId = (model) => String(model || '').replace(/\[[^\]]*\]$/, '').trim().toLowerCase();
  function modelsDevPrice(model) {
    const id = modelId(model);
    const row = id ? load()?.openai?.models?.[id] : null;
    return row ? normalizeListPrice(row.cost) : null;
  }
  function codexPrice(model) {
    if (!modelId(model)) return null;
    return (data ? null : listPrice('codex', model)) || modelsDevPrice(model);
  }
  function claudePrice(model) {
    return listPrice('claude-code', model);
  }
  /** Table models models.dev prices differently: [{ model, field, table, live }]. */
  function drift() {
    const out = [];
    const live = load();
    if (!live) return out;
    for (const row of pricingRows()) {
      const cost = live[row.vendor]?.models?.[row.model]?.cost;
      const other = cost ? normalizeListPrice(cost) : null;
      if (!other) continue;
      for (const field of ['input', 'output', 'cacheRead']) {
        if (other[field] != null && Math.abs(Number(other[field]) - Number(row[field])) > 1e-9) out.push({ model: row.model, field, table: row[field], live: other[field] });
      }
    }
    return out;
  }
  function status() {
    const value = load();
    return {
      source: data ? 'models.dev' : 'table', table: { verified: PRICING_VERIFIED, sources: PRICING_SOURCES, models: pricingRows().length },
      path: data ? null : path, available: data ? !!value?.openai?.models : true, modelsDev: !!value?.openai?.models, drift: data ? [] : drift(),
    };
  }
  return { codexPrice, claudePrice, status };
}

// ── Codex rollouts (a failed turn's tokens) ──────────────────────────────────

function localDay(ms) {
  const d = new Date(ms);
  return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')];
}

/**
 * The thread's running token total from its Codex rollout
 * (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl, last
 * `token_count` event). The SDK stream carries no usage for a failed or
 * aborted turn; this is where Codex itself recorded it. null when not found.
 */
export function readCodexRolloutTotal({ codexHome, threadId, sinceMs = Date.now(), nowMs = Date.now() } = {}) {
  const path = findCodexRollout({ codexHome, threadId, sinceMs, nowMs });
  if (!path) return null;
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes('"token_count"')) continue;
    try {
      const total = JSON.parse(line)?.payload?.info?.total_token_usage;
      if (total && typeof total === 'object') return { ...total };
    } catch { /* a torn last line */ }
  }
  return null;
}

/**
 * The thread's rollout file (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl),
 * looked up from the day before `sinceMs` to the day after `nowMs`; null when not found.
 */
export function findCodexRollout({ codexHome, threadId, sinceMs = Date.now(), nowMs = Date.now() } = {}) {
  if (!codexHome || !threadId) return null;
  const suffix = `-${threadId}.jsonl`;
  const days = new Set();
  for (let t = sinceMs - 86_400_000; t <= nowMs + 86_400_000; t += 86_400_000) days.add(localDay(t).join('/'));
  for (const day of days) {
    const dir = join(codexHome, 'sessions', ...day.split('/'));
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    const name = names.find((n) => n.startsWith('rollout-') && n.endsWith(suffix));
    if (name) return join(dir, name);
  }
  return null;
}

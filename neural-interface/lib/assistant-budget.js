// ═══════════════════════════════════════════
// SynaBun — Assistant budgets (caps · list prices · Codex usage)
// ═══════════════════════════════════════════
//
// The money rails of the central assistant, in one place:
//
//   defaultRunUsd   per-run cap a dispatch gets when the brain names none
//   maxRunUsd       largest per-run cap a brain may ask for (budget_usd)
//   sessionWarnUsd  one warning to the brain and the user at this session spend
//   sessionHardUsd  session spend (brain + every run) that stops everything
//   brainUsd        the central brain's own spend in one session
//
// They live where the dispatcher and the runtime always read them, so a hand
// edit keeps working: `limits.defaultBudgetUsd`, `limits.maxBudgetUsd`,
// `limits.sessionWarnUsd` (older files: 80 % of `limits.sessionSoftBudgetUsd`),
// `limits.sessionHardBudgetUsd`, `brains.claude.maxBudgetUsd`.
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

export const BUDGET_FIELDS = Object.freeze(['defaultRunUsd', 'maxRunUsd', 'sessionWarnUsd', 'sessionHardUsd', 'brainUsd']);
export const BUDGET_DEFAULTS = Object.freeze({ defaultRunUsd: 5, maxRunUsd: 25, sessionWarnUsd: 8, sessionHardUsd: 25, brainUsd: 10 });
export const BUDGET_MIN_USD = 0.1;
export const BUDGET_MAX_USD = 1000;
export const BUDGET_LABELS = Object.freeze({
  defaultRunUsd: 'Default per-run cap',
  maxRunUsd: 'Largest per-run cap',
  sessionWarnUsd: 'Session warning',
  sessionHardUsd: 'Session hard cap',
  brainUsd: 'Brain cap',
});

function num(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function obj(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
export function roundUsd(value) { return Math.round(Number(value) * 100) / 100; }

function budgetError(field, message) {
  const error = new Error(message);
  error.code = 'BUDGET_INVALID';
  error.field = field;
  error.status = 400;
  return error;
}

/** The raw values a config file holds (null = not set). */
export function storedBudget(raw = {}) {
  const limits = obj(raw?.limits);
  const soft = num(limits.sessionSoftBudgetUsd);
  const warn = num(limits.sessionWarnUsd);
  return {
    defaultRunUsd: num(limits.defaultBudgetUsd),
    maxRunUsd: num(limits.maxBudgetUsd),
    sessionWarnUsd: warn ?? (soft !== null ? roundUsd(soft * 0.8) : null),
    sessionHardUsd: num(limits.sessionHardBudgetUsd),
    brainUsd: num(obj(obj(raw?.brains).claude).maxBudgetUsd),
  };
}

/**
 * The invariant that fails first, or null: default ≤ largest ≤ hard,
 * warning < hard, brain ≤ hard.
 */
export function budgetInvariantError(b) {
  if (b.maxRunUsd > b.sessionHardUsd) return { field: 'maxRunUsd', message: `${BUDGET_LABELS.maxRunUsd} ($${b.maxRunUsd}) cannot exceed the ${BUDGET_LABELS.sessionHardUsd.toLowerCase()} ($${b.sessionHardUsd}).` };
  if (b.defaultRunUsd > b.maxRunUsd) return { field: 'defaultRunUsd', message: `${BUDGET_LABELS.defaultRunUsd} ($${b.defaultRunUsd}) cannot exceed the ${BUDGET_LABELS.maxRunUsd.toLowerCase()} ($${b.maxRunUsd}).` };
  if (b.sessionWarnUsd >= b.sessionHardUsd) return { field: 'sessionWarnUsd', message: `${BUDGET_LABELS.sessionWarnUsd} ($${b.sessionWarnUsd}) must be below the ${BUDGET_LABELS.sessionHardUsd.toLowerCase()} ($${b.sessionHardUsd}).` };
  if (b.brainUsd > b.sessionHardUsd) return { field: 'brainUsd', message: `${BUDGET_LABELS.brainUsd} ($${b.brainUsd}) cannot exceed the ${BUDGET_LABELS.sessionHardUsd.toLowerCase()} ($${b.sessionHardUsd}).` };
  return null;
}

/**
 * What applies now: each saved value in range, else its default; a hand edit
 * that breaks an invariant is repaired (and listed in `repairs`), never trusted.
 */
export function effectiveBudget(raw = {}) {
  const stored = storedBudget(raw);
  const out = {};
  const sources = {};
  for (const field of BUDGET_FIELDS) {
    const value = stored[field];
    const ok = value !== null && value >= BUDGET_MIN_USD && value <= BUDGET_MAX_USD;
    out[field] = ok ? roundUsd(value) : BUDGET_DEFAULTS[field];
    sources[field] = !ok ? 'default' : (field === 'sessionWarnUsd' && num(obj(raw?.limits).sessionWarnUsd) === null ? 'legacy' : 'saved');
  }
  const repairs = [];
  for (let guard = 0; guard < BUDGET_FIELDS.length; guard += 1) {
    const broken = budgetInvariantError(out);
    if (!broken) break;
    repairs.push(broken.field);
    if (broken.field === 'maxRunUsd') out.maxRunUsd = out.sessionHardUsd;
    else if (broken.field === 'defaultRunUsd') out.defaultRunUsd = out.maxRunUsd;
    else if (broken.field === 'sessionWarnUsd') out.sessionWarnUsd = roundUsd(out.sessionHardUsd * 0.8);
    else if (broken.field === 'brainUsd') out.brainUsd = out.sessionHardUsd;
  }
  return { ...out, sources, repairs };
}

/**
 * Validate a patch against the current values and return the full next set.
 * `null` resets a field to its default. Throws BUDGET_INVALID (status 400,
 * `field`) on a bad value or a broken invariant.
 */
export function validateBudgetPatch(patch = {}, current = BUDGET_DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw budgetError('budget', 'budget must be an object');
  const next = {};
  for (const field of BUDGET_FIELDS) next[field] = num(current?.[field]) ?? BUDGET_DEFAULTS[field];
  for (const [field, value] of Object.entries(patch)) {
    if (!BUDGET_FIELDS.includes(field)) throw budgetError(field, `Unknown budget field "${field}"`);
    if (value === null) { next[field] = BUDGET_DEFAULTS[field]; continue; }
    const n = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
    if (!Number.isFinite(n)) throw budgetError(field, `${BUDGET_LABELS[field]} must be an amount in US dollars`);
    if (n < BUDGET_MIN_USD || n > BUDGET_MAX_USD) throw budgetError(field, `${BUDGET_LABELS[field]} must be between $${BUDGET_MIN_USD.toFixed(2)} and $${BUDGET_MAX_USD}`);
    next[field] = roundUsd(n);
  }
  const broken = budgetInvariantError(next);
  if (broken) throw budgetError(broken.field, broken.message);
  return next;
}

/** A config object with `budget` written into the keys its readers use (every other key kept). */
export function writeBudgetInto(raw = {}, budget, { version = 0, at = new Date().toISOString() } = {}) {
  const base = obj(raw);
  const brains = obj(base.brains);
  return {
    ...base,
    limits: {
      ...obj(base.limits),
      defaultBudgetUsd: budget.defaultRunUsd,
      maxBudgetUsd: budget.maxRunUsd,
      sessionWarnUsd: budget.sessionWarnUsd,
      sessionHardBudgetUsd: budget.sessionHardUsd,
      budgetVersion: version,
      budgetUpdatedAt: at,
    },
    brains: { ...brains, claude: { ...obj(brains.claude), maxBudgetUsd: budget.brainUsd } },
  };
}

/** The dispatcher's limit keys for a budget. */
export function budgetLimits(budget) {
  return {
    defaultBudgetUsd: budget.defaultRunUsd,
    maxBudgetUsd: budget.maxRunUsd,
    sessionWarnUsd: budget.sessionWarnUsd,
    sessionHardBudgetUsd: budget.sessionHardUsd,
    brainBudgetUsd: budget.brainUsd,
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

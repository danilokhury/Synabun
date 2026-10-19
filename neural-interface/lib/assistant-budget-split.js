// ═══════════════════════════════════════════
// SynaBun — Assistant budget split (pure: buckets, shares, coverage)
// ═══════════════════════════════════════════
//
// A session with a budget (assistant-budget.js) divides what is left across
// three buckets, one per provider: claude-code, codex, opencode. A provider's
// runs draw from its share; the Assistant's own turns (brain turns, direct and
// continuation routes) draw from the share of the brain's provider, which
// keeps a reserve for them that the workers on that provider cannot spend.
//
// Who decides the weights: Jev (surface budget-split, one Score per provider:
// how much of the spend still to come lands there), else the fixed heuristic
// fallbackWeights(). Either way the code here does the money: the weights are
// normalised, the brain's reserve applied, and what is left is divided in whole
// cents that add up exactly to it. A provider a checkpoint found short gets
// more only when the weights give it more: when they do not, its tasks move to
// another provider (the router) and its runs stop. Nothing here raises the
// total or picks a model.
//
// Everything in this file is pure; assistant-budget-planner.js owns the state.

import { listedCount, priceText, providerAllHidden, providerEmpty, rowIsHidden, findModel, defaultModelRow } from './assistant-catalog.js';
import { BUDGET_WARN_RATIO, floorCents, roundUsd } from './assistant-budget.js';

export const BUDGET_PROVIDERS = Object.freeze(['claude-code', 'codex', 'opencode']);
export const PROVIDER_LABELS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' });

// The brain's reserve inside its provider's share: 10 % of what is left, at least $0.50 (never more than is left).
export const BRAIN_FLOOR_RATIO = 0.1;
export const BRAIN_FLOOR_MIN_USD = 0.5;
// Less than this cannot pay for a model call: the share counts as used up.
export const MIN_SPEND_USD = 0.01;

// What each level of Jev's Score question (mcp-server/src/services/budget-judgments.ts SHARE_LEVELS, lowest
// first) stands for as a share of the spend still to come. The expected share is these weighted by the
// answer's probabilities, else read off its probability-weighted position.
export const SHARE_LEVEL_FRACTIONS = Object.freeze([0, 0.1, 0.3, 0.6, 0.9]);

// What one task of a class tends to cost, relative to a quick task (the fallback's weights).
export const CLASS_COST_WEIGHTS = Object.freeze({
  chat: 0.5, quick: 1, research: 1.5, browser: 1.5, computer: 1.5, automation: 1,
  review: 2, code: 3, design: 3, image_gen: 2, video_gen: 2, complex: 4,
});
// A model's blended list price ($/MTok: (3 × input + output) / 4) is divided by this to give its price index.
export const PRICE_INDEX_BASE_USD = 5;

const arr = (value) => (Array.isArray(value) ? value : []);
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const r8 = (value) => Number((Number(value) || 0).toFixed(8));
const isProvider = (value) => BUDGET_PROVIDERS.includes(value);

// ── buckets ───────────────────────────────────────────────────────────────

/**
 * Which providers can take a share now → { [provider]: { eligible, reason } }.
 *   no_models   the user disabled every model, or the provider answered with none connected
 *   signed_out  every account of the provider is signed out
 *   limited     every signed-in account is out of subscription usage
 * A provider whose model list is merely unavailable stays eligible (routing is lenient there too). The
 * brain's provider is always eligible (its turns are paid from it); `reason` then says what else is wrong.
 */
export function bucketEligibility({ catalog = null, accounts = null, brainProvider = null } = {}) {
  const out = {};
  for (const provider of BUDGET_PROVIDERS) {
    let reason = null;
    if (catalog) {
      if (providerEmpty(catalog, provider) || providerAllHidden(catalog, provider)) reason = 'no_models';
      else if (listedCount(catalog, provider) > 0 || arr(catalog.models?.[provider]).length) {
        const usable = arr(catalog.models?.[provider]).filter((row) => !rowIsHidden(catalog, { ...row, provider: row.provider || provider }) && row.status !== 'unavailable');
        if (!usable.length) reason = 'no_models';
      }
    }
    if (!reason && accounts && Object.hasOwn(accounts, provider)) {
      const rows = arr(accounts[provider]);
      if (rows.length) {
        const usable = rows.filter((row) => row && row.signedIn !== false && row.usage?.limited !== true);
        if (!usable.length) reason = rows.every((row) => row?.signedIn === false) ? 'signed_out' : 'limited';
      }
    }
    out[provider] = provider === brainProvider ? { eligible: true, reason: reason ? `brain:${reason}` : 'brain' } : { eligible: !reason, reason };
  }
  return out;
}

// ── prices ────────────────────────────────────────────────────────────────

/** The catalog row a target runs on (its provider default when it names no model), or null. */
export function rowOf(catalog, provider, model) {
  if (!catalog || !provider) return null;
  try { return model ? findModel(catalog, provider, model)?.row || null : defaultModelRow(catalog, provider); } catch { return null; }
}
/** A row's list price: its own (Claude, OpenCode), else its list-price equivalent (Codex: billed by plan). */
export function listPriceOf(row, { pricing = null, provider = null, model = null } = {}) {
  if (row?.price) return row.price;
  if (row?.listPrice) return row.listPrice;
  if ((provider || row?.provider) === 'codex' && pricing?.codexPrice) {
    try { return pricing.codexPrice(model || row?.id || null) || null; } catch { return null; }
  }
  return null;
}
/** Is the model free (catalog basis free)? Free models need no share. */
export function isFreePrice(price) { return !!price && (price.basis === 'free' || (num(price.input) === 0 && num(price.output) === 0 && price.basis !== 'plan')); }
/** A model's price index for the fallback: its blended list price / $5, 0 when free, 1 when unknown. */
export function priceIndex(price) {
  if (!price) return 1;
  if (isFreePrice(price)) return 0;
  const blended = (3 * num(price.input) + num(price.output)) / 4;
  if (!(blended > 0)) return 1;
  return Math.min(20, Math.max(0.05, blended / PRICE_INDEX_BASE_USD));
}
/** "$5/$25" (or "free", "plan (list …)") for the Jev state; null when unknown. */
export function priceLabel(row, price) {
  if (!price && !row) return null;
  try { return row ? priceText(row.price || null, row.listPrice || (row.price ? null : price)) : priceText(price); } catch { return null; }
}
/**
 * How the work is paid for: 'free' (a free model), 'api' (an API key, or OpenCode's own providers), 'plan'
 * (a Claude / ChatGPT subscription). `account`: the account row the work would run under, when known.
 */
export function billingOf(provider, price, account = null) {
  if (isFreePrice(price)) return 'free';
  if (provider === 'opencode') return 'api';
  if (account?.mode === 'apiKey') return 'api';
  return 'plan';
}

// ── weights ───────────────────────────────────────────────────────────────

const classWeight = (taskClass) => CLASS_COST_WEIGHTS[taskClass] ?? 1;

/**
 * The deterministic split's weights, used when Jev is off, unreachable or answers nothing usable. Each
 * eligible provider is weighted by the work the session is likely to send it, times what that work's models
 * cost (priceIndex):
 *   - every task class once: on the provider its saved route names, else on the brain's provider (chat
 *     always on the brain's: it never runs anywhere else)
 *   - every task routed so far in this session: twice, on the provider it went to
 *   - the task being routed now: three times, on its provider
 *   - the Assistant's own turns: twice a quick task, on the brain's provider at the brain's model price
 *   - every live run: once its class, on its provider
 *   - a provider a checkpoint found short (`needs`): at least one quick task
 * Ineligible providers get 0. When nothing weighs anything (every model free), every eligible provider weighs
 * the same. → { [provider]: number }
 */
export function fallbackWeights({
  eligible = {}, routing = {}, brain = null, catalog = null, pricing = null,
  tasks = [], task = null, liveRuns = [], needs = [], classes = Object.keys(CLASS_COST_WEIGHTS),
} = {}) {
  const weights = Object.fromEntries(BUDGET_PROVIDERS.map((p) => [p, 0]));
  const brainProvider = isProvider(brain?.provider) ? brain.provider : null;
  const price = (provider, model) => priceIndex(listPriceOf(rowOf(catalog, provider, model), { pricing, provider, model }));
  const add = (provider, model, weight) => { if (isProvider(provider) && eligible[provider]?.eligible !== false) weights[provider] += weight * price(provider, model); };
  const prefs = routing?.preferences && typeof routing.preferences === 'object' ? routing.preferences : {};
  for (const taskClass of classes) {
    // Chat always runs here, on the brain, whatever its saved route says (assistant-router.js evaluateRoute).
    const pref = taskClass === 'chat' ? null : prefs[taskClass];
    if (pref?.provider) add(pref.provider, pref.model || (pref.kind === 'direct' && pref.provider === brainProvider ? brain?.model || null : null), classWeight(taskClass));
    else if (brainProvider) add(brainProvider, brain?.model || null, classWeight(taskClass));
  }
  for (const row of arr(tasks)) add(row?.provider, row?.model || null, 2 * classWeight(row?.taskClass));
  if (task?.provider) add(task.provider, task.model || null, 3 * classWeight(task.taskClass));
  if (brainProvider) add(brainProvider, brain?.model || null, 2);
  for (const run of arr(liveRuns)) add(run?.provider, run?.model || null, classWeight(run?.taskClass));
  for (const provider of arr(needs)) if (isProvider(provider) && eligible[provider]?.eligible !== false && weights[provider] <= 0) weights[provider] = Math.max(weights[provider], price(provider, null) > 0 ? 1 : 0);
  const pool = BUDGET_PROVIDERS.filter((p) => eligible[p]?.eligible !== false);
  if (pool.length && pool.every((p) => !(weights[p] > 0))) for (const p of pool) weights[p] = 1;
  return weights;
}

/** The expected share (0-1) one Score answer stands for: SHARE_LEVEL_FRACTIONS weighted by its probabilities, else interpolated at its position. */
export function shareFromScore(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const levels = SHARE_LEVEL_FRACTIONS;
  const probs = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : null;
  if (probs) {
    let total = 0;
    let expected = 0;
    for (const [key, value] of Object.entries(probs)) {
      const index = Number(key);
      const p = Number(value);
      if (!Number.isInteger(index) || index < 0 || index >= levels.length || !Number.isFinite(p) || p < 0) continue;
      total += p;
      expected += p * levels[index];
    }
    if (total > 0.5) return expected / total;
  }
  const position = Number(answer.score);
  if (!Number.isFinite(position)) return null;
  const at = Math.min(levels.length - 1, Math.max(0, position));
  const low = Math.floor(at);
  const high = Math.min(levels.length - 1, low + 1);
  return levels[low] + (levels[high] - levels[low]) * (at - low);
}

/**
 * Jev's answer → weights over the eligible providers, or null when it does not cover every one of them
 * (the deterministic split is used then). An ineligible provider weighs 0 whatever was answered.
 */
export function jevWeights(judgment, eligible = {}) {
  const scores = judgment?.scores;
  if (!scores || typeof scores !== 'object') return null;
  const out = Object.fromEntries(BUDGET_PROVIDERS.map((p) => [p, 0]));
  for (const provider of BUDGET_PROVIDERS) {
    if (eligible[provider]?.eligible === false) continue;
    const share = shareFromScore(scores[provider]);
    if (share === null) return null;
    out[provider] = Math.max(0, share);
  }
  return out;
}

// ── dividing ──────────────────────────────────────────────────────────────

/** `total` cents over `parts` (weights ≥ 0) by largest remainder: whole cents that add up exactly to `total`. */
export function apportion(total, parts) {
  const keys = Object.keys(parts);
  const out = Object.fromEntries(keys.map((key) => [key, 0]));
  const sum = keys.reduce((acc, key) => acc + Math.max(0, num(parts[key])), 0);
  if (!(total > 0) || !(sum > 0)) return out;
  const rows = keys.map((key, index) => {
    const exact = (total * Math.max(0, num(parts[key]))) / sum;
    return { key, index, base: Math.floor(exact + 1e-9), rest: exact - Math.floor(exact + 1e-9) };
  });
  let given = rows.reduce((acc, row) => acc + row.base, 0);
  for (const row of [...rows].sort((a, b) => b.rest - a.rest || a.index - b.index)) {
    if (given >= total) break;
    row.base += 1;
    given += 1;
  }
  for (const row of rows) out[row.key] = row.base;
  return out;
}

/**
 * Divide what is left (`leftUsd`, rounded down to the cent) across the providers by `weights`, then raise the
 * brain's reserve on its provider, taken from the others in proportion to what they got. Ineligible providers
 * get nothing. → { allocCents: { [provider]: cents }, leftCents, brainFloorCents, floorsCents }
 * Σ allocCents === leftCents, always.
 */
export function divideLeft({ leftUsd = 0, weights = {}, eligible = {}, brainProvider = null } = {}) {
  const leftCents = floorCents(leftUsd);
  const pool = BUDGET_PROVIDERS.filter((p) => eligible[p]?.eligible !== false);
  const zero = Object.fromEntries(BUDGET_PROVIDERS.map((p) => [p, 0]));
  if (!leftCents || !pool.length) return { allocCents: zero, leftCents, brainFloorCents: 0, floorsCents: { ...zero } };
  const parts = Object.fromEntries(pool.map((p) => [p, Math.max(0, num(weights[p]))]));
  if (pool.every((p) => !(parts[p] > 0))) {
    // Nothing weighs anything: the brain's provider takes it (its turns must be paid), else equal shares.
    if (brainProvider && pool.includes(brainProvider)) parts[brainProvider] = 1;
    else for (const p of pool) parts[p] = 1;
  }
  const alloc = { ...zero, ...apportion(leftCents, parts) };
  // Floors.
  const brainFloorCents = brainProvider && pool.includes(brainProvider)
    ? Math.min(leftCents, Math.max(Math.round(BRAIN_FLOOR_RATIO * leftCents), Math.round(BRAIN_FLOOR_MIN_USD * 100)))
    : 0;
  const floors = { ...zero };
  if (brainFloorCents) floors[brainProvider] = brainFloorCents;
  const deficit = Object.fromEntries(BUDGET_PROVIDERS.map((p) => [p, Math.max(0, floors[p] - alloc[p])]));
  const needed = BUDGET_PROVIDERS.reduce((acc, p) => acc + deficit[p], 0);
  if (needed > 0) {
    const surplus = Object.fromEntries(BUDGET_PROVIDERS.map((p) => [p, Math.max(0, alloc[p] - floors[p])]));
    const taken = apportion(needed, surplus);
    for (const p of BUDGET_PROVIDERS) alloc[p] = alloc[p] - (taken[p] || 0) + deficit[p];
  }
  return { allocCents: alloc, leftCents, brainFloorCents: floors[brainProvider] || 0, floorsCents: floors };
}

// ── what a session can still spend ────────────────────────────────────────

/** spend.providers[p] → { brainUsd, runsUsd, spentUsd, liveRuns, runningRuns }, zeros for the missing. */
export function providerSpendOf(spend, provider) {
  const row = spend?.providers?.[provider] || {};
  const brainUsd = Math.max(0, num(row.brainUsd));
  const runsUsd = Math.max(0, num(row.runsUsd));
  return { brainUsd, runsUsd, spentUsd: r8(brainUsd + runsUsd), liveRuns: Math.max(0, num(row.liveRuns)), runningRuns: Math.max(0, num(row.runningRuns)) };
}
/** Every provider's spend added up. */
export function totalSpentOf(spend) { return r8(BUDGET_PROVIDERS.reduce((acc, p) => acc + providerSpendOf(spend, p).spentUsd, 0)); }

/**
 * What a session with a budget can still spend, from its split and what was spent since.
 * Without a split (none was made yet) every eligible provider may use everything that is left.
 *   leftUsd             the session's: budget − everything spent (≥ 0)
 *   providers[p]        { spentUsd, brainUsd, runsUsd, shareUsd, leftUsd, workerLeftUsd, liveRuns, runningRuns, eligible }
 *                       leftUsd = share − spent; workerLeftUsd = that minus the brain's reserve still unspent
 *                       (on the reserve's provider); both capped at the session's leftUsd
 *   brainProvider       the provider the brain runs on now; brainLeftUsd what its turns may still spend
 *   brainReserveLeftUsd the reserve the brain has not used yet (workers on its provider cannot touch it)
 */
export function coverageOf({ amountUsd = 0, split = null, spend = null, brainProvider = null } = {}) {
  const spent = totalSpentOf(spend);
  const leftUsd = Math.max(0, r8(num(amountUsd) - spent));
  const reserveProvider = split?.brainProvider || null;
  const reserveSpent = reserveProvider ? providerSpendOf(spend, reserveProvider).brainUsd : 0;
  const brainReserveLeftUsd = split && reserveProvider
    ? Math.max(0, r8(num(split.brainSpentAtSplitUsd) + num(split.brainFloorUsd) - reserveSpent))
    : 0;
  const providers = {};
  for (const provider of BUDGET_PROVIDERS) {
    const used = providerSpendOf(spend, provider);
    const eligible = split ? split.eligible?.[provider]?.eligible !== false : true;
    if (!split) {
      providers[provider] = { ...used, shareUsd: null, leftUsd, workerLeftUsd: leftUsd, eligible };
      continue;
    }
    const shareUsd = r8(num(split.shares?.[provider]));
    const own = Math.max(0, r8(shareUsd - used.spentUsd));
    const reserve = provider === reserveProvider ? Math.min(own, brainReserveLeftUsd) : 0;
    providers[provider] = {
      ...used, shareUsd, eligible,
      leftUsd: Math.min(leftUsd, own),
      workerLeftUsd: Math.min(leftUsd, Math.max(0, r8(own - reserve))),
    };
  }
  const current = isProvider(brainProvider) ? brainProvider : reserveProvider;
  return {
    amountUsd: num(amountUsd), spentUsd: spent, leftUsd, hasSplit: !!split, providers,
    brainProvider: current || null, brainLeftUsd: current ? providers[current].leftUsd : leftUsd, brainReserveLeftUsd,
  };
}

/**
 * Can `provider` pay for more work now? `forBrain`: the Assistant's own turn (it may use its reserve); a
 * worker may not. `free`: the work runs on a free model and needs no share (the session must still be under
 * its budget).
 */
export function coversWork(coverage, { provider, forBrain = false, free = false, minUsd = MIN_SPEND_USD } = {}) {
  if (!coverage) return true;
  if (coverage.leftUsd < minUsd) return false;
  if (free) return true;
  const row = coverage.providers?.[provider];
  if (!row) return false;
  return (forBrain ? row.leftUsd : row.workerLeftUsd) >= minUsd;
}

/** The providers whose share is used up for workers (or ineligible), in BUDGET_PROVIDERS order. */
export function dryProviders(coverage, { minUsd = MIN_SPEND_USD } = {}) {
  if (!coverage?.hasSplit) return coverage && coverage.leftUsd < minUsd ? [...BUDGET_PROVIDERS] : [];
  return BUDGET_PROVIDERS.filter((p) => !coverage.providers[p] || coverage.providers[p].workerLeftUsd < minUsd);
}

// ── the view (API, live packet, agent_usage) ──────────────────────────────

/**
 * The session's budget as the UI and the brain see it.
 *   setting    { unlimited, amountUsd, version }
 *   coverage   coverageOf() (ignored under No limit)
 *   split      the session's split record, or null
 *   spend      what the session spent (by provider, brain and runs)
 */
export function budgetView({ sessionId = null, setting = null, coverage = null, split = null, spend = null, unpricedRuns = 0, brainProvider = null } = {}) {
  const unlimited = !setting || setting.unlimited === true;
  const spentUsd = totalSpentOf(spend);
  const brainUsd = r8(BUDGET_PROVIDERS.reduce((acc, p) => acc + providerSpendOf(spend, p).brainUsd, 0));
  const dispatchUsd = r8(spentUsd - brainUsd);
  const base = {
    sessionId, mode: unlimited ? 'unlimited' : 'limited', unlimited, version: Number(setting?.version) || 0,
    amountUsd: unlimited ? null : roundUsd(setting.amountUsd),
    spentUsd: roundUsd(spentUsd), brainUsd: roundUsd(brainUsd), dispatchUsd: roundUsd(dispatchUsd),
    // Before rounding: whether money is left is decided on the exact numbers.
    totalUsd: Number(spentUsd.toFixed(4)), unpricedRuns: Math.max(0, num(unpricedRuns)),
  };
  if (unlimited) {
    // No limit: no shares, but each provider's spend is still shown.
    const providers = BUDGET_PROVIDERS.map((provider) => {
      const used = providerSpendOf(spend, provider);
      return {
        provider, label: PROVIDER_LABELS[provider], eligible: true, reason: null, isBrain: provider === brainProvider,
        shareUsd: null, spentUsd: roundUsd(used.spentUsd), brainSpentUsd: roundUsd(used.brainUsd), runsSpentUsd: roundUsd(used.runsUsd),
        leftUsd: null, workerLeftUsd: null, liveRuns: used.liveRuns, runningRuns: used.runningRuns, weight: null, judged: null,
      };
    });
    return { ...base, leftUsd: null, warnAtUsd: null, warned: false, exceeded: false, split: null, brainProvider: brainProvider || null, providers, dry: [] };
  }
  const amount = num(setting.amountUsd);
  const warnAtUsd = roundUsd(amount * BUDGET_WARN_RATIO);
  const cov = coverage || coverageOf({ amountUsd: amount, split, spend, brainProvider });
  const providers = BUDGET_PROVIDERS.map((provider) => {
    const row = cov.providers[provider];
    const judged = split?.jev?.scores?.[provider] || null;
    return {
      provider, label: PROVIDER_LABELS[provider],
      eligible: row.eligible, reason: split?.eligible?.[provider]?.reason || null,
      isBrain: provider === (cov.brainProvider || split?.brainProvider || null),
      shareUsd: row.shareUsd === null ? null : roundUsd(row.shareUsd),
      spentUsd: roundUsd(row.spentUsd), brainSpentUsd: roundUsd(row.brainUsd), runsSpentUsd: roundUsd(row.runsUsd),
      leftUsd: roundUsd(row.leftUsd), workerLeftUsd: roundUsd(row.workerLeftUsd),
      liveRuns: row.liveRuns, runningRuns: row.runningRuns,
      weight: split ? Number(num(split.weights?.[provider]).toFixed(4)) : null,
      judged: judged ? { score: Number(num(judged.score).toFixed(3)), confidence: Number(num(judged.confidence).toFixed(3)) } : null,
    };
  });
  return {
    ...base,
    leftUsd: roundUsd(cov.leftUsd), warnAtUsd, warned: spentUsd >= warnAtUsd, exceeded: spentUsd >= amount || cov.leftUsd < MIN_SPEND_USD,
    brainProvider: cov.brainProvider || null,
    split: split ? {
      source: split.source, reason: split.reason || null, updatedAt: split.at || null, fallbackWhy: split.fallbackWhy || null,
      leftAtSplitUsd: roundUsd(split.leftUsd), brainProvider: split.brainProvider || null,
      brainFloorUsd: roundUsd(split.brainFloorUsd), brainReserveLeftUsd: roundUsd(cov.brainReserveLeftUsd),
      needs: arr(split.needs), logId: split.jev?.logId ?? null,
      providers,
    } : null,
    // Before the first split every provider shares what is left; `providers` still says what each spent.
    providers,
    dry: dryProviders(cov),
  };
}

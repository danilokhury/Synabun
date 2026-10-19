// ═══════════════════════════════════════════
// SynaBun — Assistant budget planner (per-session split, checkpoints, Jev)
// ═══════════════════════════════════════════
//
// The state behind the budget split (the math is assistant-budget-split.js):
//
//   - The split of each session, cached on it: made at the session's first
//     actionable route or dispatch (ensureSplit), made again only at a
//     checkpoint (resplit): a route, dispatch or brain turn its provider's
//     share cannot cover (ensureCovered), a change of the budget
//     (onBudgetChanged), a run ending (onRunEnded). Never per tick or per
//     metered step: coverage() and covers() only read.
//   - Jev (surface budget-split) weighs the providers; when it is off,
//     unreachable or answers nothing usable, the deterministic weights are
//     used. The split records which (`source`: jev | fallback) and when.
//   - Re-splits of one session run one at a time; calls that arrive while one
//     waits to start are merged into it.
//
// Under No limit nothing is split and every check passes.
//
// Every dependency is injected (server.js wires the dispatcher, the runtime,
// the catalog, the accounts, the config store and Jev); nothing here throws
// at its callers.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BUDGET_DEFAULT_USD, BUDGET_WARN_RATIO, roundUsd } from './assistant-budget.js';
import {
  BUDGET_PROVIDERS, MIN_SPEND_USD, billingOf, bucketEligibility, budgetView, coverageOf, coversWork, divideLeft,
  dryProviders, fallbackWeights, jevWeights, listPriceOf, priceLabel, providerSpendOf, rowOf, totalSpentOf,
} from './assistant-budget-split.js';

export const SPLIT_REASONS = Object.freeze(['first_route', 'share_used_up', 'brain_turn', 'budget_changed', 'run_ended']);
const MAX_SESSIONS = 200;
const MAX_TASKS = 20;
// A provider found short again this soon after a re-split for it is not re-split again: the split stands
// (its runs stop, its tasks move). The brain's own turns re-split again as soon as it spent since.
const NEED_RETRY_MS = 5_000;
const RUN_END_DEBOUNCE_MS = 1500;

const arr = (value) => (Array.isArray(value) ? value : []);
const clip = (value, max = 200) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const iso = (ms) => new Date(ms).toISOString();

export function createBudgetPlanner({
  setting = () => ({ unlimited: false, amountUsd: BUDGET_DEFAULT_USD, version: 0 }),
  // (sessionId) => { providers: { [p]: { brainUsd, runsUsd, liveRuns, runningRuns } }, unpricedRuns, liveRuns: [{ provider, model, taskClass }] }
  spendOf = () => ({ providers: {}, unpricedRuns: 0, liveRuns: [] }),
  // (sessionId) => { provider, model, accountId, project } | null
  brainOf = () => null,
  // (sessionId) => is the session still open (a split of an ended one is not redone)
  isOpen = () => true,
  catalog = () => null,
  refreshCatalog = null,
  accounts = () => null,
  routing = () => ({ preferences: {} }),
  routeMode = () => null,
  workers = () => ({}),
  pricing = null,
  // (sessionId) => { [provider]: usd } of this session from the usage ledger, or null
  recentSpend = () => null,
  // assistant-jev.js: { available(), budgetSplit(input, ctx), annotate(logId, outcome) } or null
  judge = null,
  emit = () => {},
  statePath = null,
  now = Date.now,
  log = () => {},
} = {}) {
  const sessions = new Map(); // id → { split, tasks: [], updatedAt }
  const chains = new Map();   // id → { promise, queued, waiting }
  const needTries = new Map(); // `${id}:${provider}` → { at, version }
  const runEndTimers = new Map();
  let persistTimer = null;

  // ── persistence ────────────────────────────────────────────────────────
  function load() {
    if (!statePath || !existsSync(statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'));
      for (const [id, row] of Object.entries(raw?.sessions || {})) {
        if (!row || typeof row !== 'object') continue;
        sessions.set(id, { split: row.split && typeof row.split === 'object' ? row.split : null, tasks: arr(row.tasks).slice(-MAX_TASKS), updatedAt: row.updatedAt || null });
      }
    } catch (error) { log('budget:state-unreadable', error?.message || String(error)); }
  }
  function writeState() {
    if (!statePath) return;
    try {
      const rows = [...sessions.entries()].sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || ''))).slice(0, MAX_SESSIONS);
      for (const [id] of [...sessions.entries()].filter(([id]) => !rows.some(([kept]) => kept === id))) sessions.delete(id);
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(rows) }, null, 2) + '\n', 'utf8');
      renameSync(tmp, statePath);
    } catch (error) { log('budget:state-error', error?.message || String(error)); }
  }
  function persist() {
    if (!statePath || persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; writeState(); }, 300);
    persistTimer.unref?.();
  }
  function rowOfSession(id, { create = false } = {}) {
    let row = sessions.get(id) || null;
    if (!row && create) { row = { split: null, tasks: [], updatedAt: iso(now()) }; sessions.set(id, row); }
    return row;
  }

  // ── reads ──────────────────────────────────────────────────────────────
  function readSetting() {
    try {
      const value = setting() || {};
      return { unlimited: value.unlimited === true, amountUsd: Number(value.amountUsd) > 0 ? Number(value.amountUsd) : BUDGET_DEFAULT_USD, version: Number(value.version) || 0 };
    } catch { return { unlimited: false, amountUsd: BUDGET_DEFAULT_USD, version: 0 }; }
  }
  function limited() { return !readSetting().unlimited; }
  function safe(fn, fallback = null) { try { const value = fn(); return value === undefined ? fallback : value; } catch { return fallback; } }
  function spend(id) { return safe(() => spendOf(id), null) || { providers: {}, unpricedRuns: 0, liveRuns: [] }; }
  function brain(id) { return safe(() => brainOf(id), null); }
  function splitOf(id) { return sessions.get(String(id || ''))?.split || null; }
  function coverage(id) {
    const value = readSetting();
    if (value.unlimited) return null;
    const sessionId = String(id || '');
    return coverageOf({ amountUsd: value.amountUsd, split: splitOf(sessionId), spend: spend(sessionId), brainProvider: brain(sessionId)?.provider || null });
  }
  /** Can `provider` pay for more work in the session now (No limit: always). */
  function covers(id, { provider, forBrain = false, free = false } = {}) {
    if (!id) return true;
    const cov = coverage(id);
    return cov ? coversWork(cov, { provider, forBrain, free }) : true;
  }
  function view(id) {
    const sessionId = String(id || '');
    const value = readSetting();
    const used = spend(sessionId);
    const brainProvider = brain(sessionId)?.provider || null;
    return budgetView({
      sessionId, setting: value, split: value.unlimited ? null : splitOf(sessionId), spend: used, unpricedRuns: used.unpricedRuns || 0, brainProvider,
      coverage: value.unlimited ? null : coverageOf({ amountUsd: value.amountUsd, split: splitOf(sessionId), spend: used, brainProvider }),
    });
  }

  // ── Jev's state ────────────────────────────────────────────────────────
  function accountFor(provider, rows, brainInfo) {
    const list = arr(rows?.[provider]);
    if (!list.length) return null;
    const wanted = provider === brainInfo?.provider ? (brainInfo.accountId || 'default')
      : (safe(() => workers()?.[provider === 'codex' ? 'codexAccount' : 'claudeAccount']) || 'default');
    return list.find((row) => row?.id === wanted) || list.find((row) => row?.id === 'default') || list[0];
  }
  function modelInfo(cat, provider, model, account = null) {
    const row = rowOf(cat, provider, model);
    const price = listPriceOf(row, { pricing, provider, model });
    return { id: model || row?.id || null, price: priceLabel(row, price), billing: billingOf(provider, price, account), tier: row?.tier || null };
  }
  function jevInput(id, { value, used, cov, eligible, brainInfo, cat, needs, task, reason, tasks }) {
    const rows = safe(() => accounts(), null);
    const prefs = safe(() => routing()?.preferences, {}) || {};
    const savedRoutes = Object.entries(prefs).filter(([, pref]) => pref?.provider).map(([taskClass, pref]) => {
      const info = modelInfo(cat, pref.provider, pref.model || null, accountFor(pref.provider, rows, brainInfo));
      return { taskClass, provider: pref.provider, model: pref.model || null, effort: pref.effort || null, price: info.price, billing: info.billing };
    });
    const recent = safe(() => recentSpend(id), null) || {};
    const providers = {};
    for (const provider of BUDGET_PROVIDERS) {
      const own = providerSpendOf(used, provider);
      const account = accountFor(provider, rows, brainInfo);
      const routed = savedRoutes.filter((r) => r.provider === provider);
      const models = [];
      for (const r of routed) if (!models.some((m) => m.id === r.model)) models.push({ id: r.model, price: r.price, billing: r.billing, tier: rowOf(cat, provider, r.model)?.tier || null });
      providers[provider] = {
        eligible: eligible[provider]?.eligible !== false, why: eligible[provider]?.reason || null,
        spentUsd: own.spentUsd, brainUsd: own.brainUsd, runsUsd: own.runsUsd,
        shareUsd: cov?.hasSplit ? cov.providers[provider].shareUsd : null, leftUsd: cov?.hasSplit ? cov.providers[provider].leftUsd : null,
        liveRuns: own.liveRuns, runningRuns: own.runningRuns, recentUsd: Number.isFinite(Number(recent[provider])) ? Number(recent[provider]) : null,
        account: account ? { mode: account.mode === 'apiKey' ? 'api key' : account.mode || null, usageLeftPercent: account.usage?.remainingPercent ?? null, limited: account.usage?.limited ?? null } : null,
        models,
      };
    }
    const brainModel = brainInfo?.provider ? modelInfo(cat, brainInfo.provider, brainInfo.model || null, accountFor(brainInfo.provider, rows, brainInfo)) : null;
    const spentUsd = totalSpentOf(used);
    return {
      ask: BUDGET_PROVIDERS.filter((p) => eligible[p]?.eligible !== false),
      budget: { amountUsd: value.amountUsd, spentUsd, leftUsd: Math.max(0, value.amountUsd - spentUsd), warnAtUsd: roundUsd(value.amountUsd * BUDGET_WARN_RATIO) },
      checkpoint: { reason, needs },
      brain: brainInfo?.provider ? { provider: brainInfo.provider, model: brainInfo.model || null, price: brainModel?.price || null, billing: brainModel?.billing || null } : null,
      routeMode: safe(() => routeMode(id), null),
      savedRoutes, providers,
      tasks: arr(tasks).map((t) => ({ taskClass: t.taskClass || null, summary: t.summary || null, provider: t.provider || null, model: t.model || null })),
      task: task ? { taskClass: task.taskClass || null, summary: task.summary || null, provider: task.provider || null, model: task.model || null } : null,
    };
  }

  // ── making a split ─────────────────────────────────────────────────────
  async function catalogNow() {
    const cached = safe(() => catalog(), null);
    if (cached || typeof refreshCatalog !== 'function') return cached;
    try { return (await refreshCatalog()) || null; } catch { return null; }
  }
  async function compute(id, want = {}) {
    const value = readSetting();
    if (value.unlimited) return null;
    const reason = SPLIT_REASONS.includes(want.reason) ? want.reason : 'first_route';
    const needs = [...new Set(arr(want.needs).filter((p) => BUDGET_PROVIDERS.includes(p)))];
    const row = rowOfSession(id, { create: true });
    if (want.task) noteTaskRow(row, want.task, { current: true });
    const cat = await catalogNow();
    const used = spend(id);
    const brainInfo = brain(id);
    const brainProvider = BUDGET_PROVIDERS.includes(brainInfo?.provider) ? brainInfo.provider : null;
    const eligible = bucketEligibility({ catalog: cat, accounts: safe(() => accounts(), null), brainProvider });
    const cov = coverageOf({ amountUsd: value.amountUsd, split: row.split, spend: used, brainProvider });
    const leftUsd = Math.max(0, value.amountUsd - totalSpentOf(used));
    const tasks = row.tasks.filter((t) => !t.current);
    const task = want.task || row.tasks.find((t) => t.current) || null;
    let weights = null;
    let jev = null;
    let fallbackWhy = null;
    if (leftUsd < MIN_SPEND_USD) fallbackWhy = 'nothing_left';
    else if (!judge?.budgetSplit) fallbackWhy = 'jev_off';
    else if (typeof judge.available === 'function' && !safe(() => judge.available(), false)) fallbackWhy = 'jev_off';
    else {
      let judged = null;
      try {
        judged = await judge.budgetSplit(jevInput(id, { value, used, cov, eligible, brainInfo, cat, needs, task, reason, tasks }), { sessionId: id, project: brainInfo?.project || null });
      } catch { judged = null; }
      weights = judged ? jevWeights(judged, eligible) : null;
      if (weights) jev = { logId: judged.logId ?? null, scores: judged.scores };
      else fallbackWhy = judged ? 'jev_incomplete' : 'jev_unavailable';
      // A setting changed while Jev answered: this split is for an old budget.
      if (readSetting().version !== value.version) return compute(id, want);
    }
    if (!weights) {
      weights = fallbackWeights({
        eligible, routing: safe(() => routing(), {}) || {}, brain: brainInfo, catalog: cat, pricing,
        tasks, task, liveRuns: arr(used.liveRuns), needs,
      });
    }
    // What was spent is read again: Jev took up to its timeout, and money may have moved meanwhile.
    const fresh = spend(id);
    const freshLeft = Math.max(0, value.amountUsd - totalSpentOf(fresh));
    const divided = divideLeft({ leftUsd: freshLeft, weights, eligible, brainProvider });
    const spentAtSplit = Object.fromEntries(BUDGET_PROVIDERS.map((p) => [p, providerSpendOf(fresh, p).spentUsd]));
    const shares = Object.fromEntries(BUDGET_PROVIDERS.map((p) => [p, Number((spentAtSplit[p] + divided.allocCents[p] / 100).toFixed(8))]));
    const split = {
      source: jev ? 'jev' : 'fallback', fallbackWhy: jev ? null : fallbackWhy, reason, at: iso(now()),
      settingVersion: value.version, amountUsd: value.amountUsd,
      leftUsd: divided.leftCents / 100,
      shares, alloc: Object.fromEntries(BUDGET_PROVIDERS.map((p) => [p, divided.allocCents[p] / 100])), spentAtSplit,
      brainProvider, brainFloorUsd: divided.brainFloorCents / 100,
      brainSpentAtSplitUsd: brainProvider ? providerSpendOf(fresh, brainProvider).brainUsd : 0,
      eligible, weights, needs, jev,
    };
    row.split = split;
    row.updatedAt = split.at;
    for (const t of row.tasks) delete t.current;
    persist();
    if (jev?.logId && typeof judge?.annotate === 'function') {
      try { judge.annotate(jev.logId, { applied: true, reason, needs, alloc: split.alloc, brainFloorUsd: split.brainFloorUsd, leftUsd: split.leftUsd }); } catch { /* diagnostics */ }
    }
    log('budget:split', `${id}: ${split.source}${fallbackWhy && !jev ? ` (${fallbackWhy})` : ''} · ${reason} · left $${split.leftUsd.toFixed(2)} · ${BUDGET_PROVIDERS.map((p) => `${p} $${split.alloc[p].toFixed(2)}`).join(', ')}`);
    try { emit(id, view(id), { reason }); } catch { /* the live packet is best effort */ }
    return split;
  }
  function mergeWant(base, next = {}) {
    const order = (reason) => ['share_used_up', 'brain_turn', 'first_route', 'budget_changed', 'run_ended'].indexOf(reason);
    if (!base) return { reason: next.reason || 'first_route', needs: [...new Set(arr(next.needs))], task: next.task || null };
    const reason = order(next.reason) !== -1 && (order(base.reason) === -1 || order(next.reason) < order(base.reason)) ? next.reason : base.reason;
    return { reason, needs: [...new Set([...arr(base.needs), ...arr(next.needs)])], task: next.task || base.task || null };
  }
  /** A checkpoint: divide what is left again. Calls made while one waits to start join it. Never rejects. */
  function resplit(sessionId, want = {}) {
    const id = String(sessionId || '');
    if (!id || !limited()) return Promise.resolve(null);
    let chain = chains.get(id);
    if (!chain) { chain = { promise: Promise.resolve(), queued: null, waiting: null }; chains.set(id, chain); }
    if (chain.queued) { chain.queued = mergeWant(chain.queued, want); return chain.waiting; }
    chain.queued = mergeWant(null, want);
    const waiting = chain.promise.then(() => {
      const next = chain.queued;
      chain.queued = null;
      return compute(id, next);
    }).catch((error) => { log('budget:split-error', `${id}: ${error?.message || String(error)}`); return splitOf(id); });
    chain.waiting = waiting;
    chain.promise = waiting;
    return waiting;
  }
  /** The session's split for the budget as it is now, made when there is none (the first route or dispatch). */
  async function ensureSplit(sessionId, { task = null, reason = null } = {}) {
    const id = String(sessionId || '');
    const value = readSetting();
    if (!id || value.unlimited) return null;
    const current = splitOf(id);
    if (current && current.settingVersion === value.version && current.amountUsd === value.amountUsd) {
      if (task) noteTask(id, task);
      return current;
    }
    return resplit(id, { reason: reason || (current ? 'budget_changed' : 'first_route'), task });
  }
  /**
   * Can `provider` pay for this work? When its share is used up but the session has money left, the
   * unspent budget is divided again first (a checkpoint: Jev, else the fallback, decides whether the
   * provider gets more; at most once per provider every few seconds). `forBrain`: a brain turn (it may
   * use its reserve). `free`: a free model (only the session limit counts).
   */
  async function ensureCovered(sessionId, { provider, forBrain = false, free = false, task = null, reason = null } = {}) {
    const id = String(sessionId || '');
    if (!id || !limited()) return true;
    let cov = coverage(id);
    if (coversWork(cov, { provider, forBrain, free })) return true;
    if (cov.leftUsd < MIN_SPEND_USD || free) return false;
    const key = `${id}:${provider}:${forBrain ? 'brain' : 'runs'}`;
    const tried = needTries.get(key);
    const value = readSetting();
    const spentNow = cov.spentUsd;
    // Never a re-split per metered step: a provider the split left short a moment ago stays short.
    if (tried && now() - tried.at < NEED_RETRY_MS && tried.version === value.version && cov.hasSplit && (!forBrain || tried.spent === spentNow)) return false;
    needTries.set(key, { at: now(), version: value.version, spent: spentNow });
    await resplit(id, { reason: reason || (forBrain ? 'brain_turn' : 'share_used_up'), needs: provider ? [provider] : [], task });
    cov = coverage(id);
    return coversWork(cov, { provider, forBrain, free });
  }

  // ── tasks ──────────────────────────────────────────────────────────────
  function noteTaskRow(row, task, { current = false } = {}) {
    if (!task || typeof task !== 'object') return;
    const entry = {
      taskClass: task.taskClass ? String(task.taskClass).slice(0, 20) : null, summary: clip(task.summary || '', 160) || null,
      provider: BUDGET_PROVIDERS.includes(task.provider) ? task.provider : null, model: task.model ? String(task.model).slice(0, 120) : null,
      at: iso(now()), ...(current ? { current: true } : {}),
    };
    const last = row.tasks.at(-1);
    if (last && last.summary === entry.summary && last.taskClass === entry.taskClass && last.provider === entry.provider) { Object.assign(last, entry); return; }
    row.tasks.push(entry);
    if (row.tasks.length > MAX_TASKS) row.tasks.splice(0, row.tasks.length - MAX_TASKS);
  }
  /** A task the session routed (agent_route approved it, or a dispatch started): Jev's next state lists it. */
  function noteTask(sessionId, task) {
    const id = String(sessionId || '');
    if (!id || !task) return;
    const row = rowOfSession(id, { create: true });
    noteTaskRow(row, task);
    row.updatedAt = iso(now());
    persist();
  }

  // ── checkpoints from outside ───────────────────────────────────────────
  /** The budget setting changed: every open session with a split divides what is left again. */
  function onBudgetChanged() {
    needTries.clear();
    if (!limited()) return;
    for (const [id, row] of sessions) {
      if (!row.split || !safe(() => isOpen(id), true)) continue;
      resplit(id, { reason: 'budget_changed' }).catch(() => {});
    }
  }
  /** A run of the session ended: what it did not spend goes back into the split (debounced). */
  function onRunEnded(sessionId) {
    const id = String(sessionId || '');
    if (!id || !limited() || !splitOf(id)) return;
    if (runEndTimers.has(id)) clearTimeout(runEndTimers.get(id));
    const timer = setTimeout(() => {
      runEndTimers.delete(id);
      if (safe(() => isOpen(id), true)) resplit(id, { reason: 'run_ended' }).catch(() => {});
    }, RUN_END_DEBOUNCE_MS);
    timer.unref?.();
    runEndTimers.set(id, timer);
  }
  function forget(sessionId) {
    const id = String(sessionId || '');
    sessions.delete(id);
    chains.delete(id);
    persist();
  }
  /** Settled for a test or a shutdown: pending timers cleared, state written now. */
  function flush() {
    for (const timer of runEndTimers.values()) clearTimeout(timer);
    runEndTimers.clear();
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    writeState();
  }
  /** What every queued re-split resolves to (tests). */
  function settled(sessionId) { return chains.get(String(sessionId || ''))?.promise || Promise.resolve(splitOf(sessionId)); }

  load();
  return {
    setting: readSetting, limited, coverage, covers, view, splitOf, dry: (id) => dryProviders(coverage(id)),
    ensureSplit, resplit, ensureCovered, noteTask, onBudgetChanged, onRunEnded, forget, flush, settled,
  };
}

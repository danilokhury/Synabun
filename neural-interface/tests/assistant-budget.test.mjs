process.env.SYNABUN_TYPESAFE = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import {
  BUDGET_DEFAULTS, codexUsageCostUsd, createModelPricing, effectiveBudget, normalizeListPrice, readCodexRolloutTotal, validateBudgetPatch,
} from '../lib/assistant-budget.js';
import { createAssistantConfigStore } from '../lib/assistant-config.js';
import { createAssistantApi } from '../lib/assistant-api.js';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import { createAssistantDispatcher } from '../lib/assistant-dispatch.js';
import { budgetTone, validateBudgetDraft } from '../public/shared/assistant/asst-budget.js';
import { codexThreadCost } from '../lib/assistant-envelope.js';

const RESULT = '## Result\nstatus: done\nsummary: ok\nchanges:\n- none\nfollow_ups:\n- none';
// models.dev shape (as OpenCode caches it) for one Codex model.
const MODELS_DEV = { openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, tiers: [{ input: 4, output: 15, cache_read: 0.4, cache_write: 5, tier: { type: 'context', size: 272000 } }] } } } } };

function tempDir(t, name) {
  const dir = mkdtempSync(resolve(tmpdir(), `synabun-budget-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('Timed out waiting for condition');
};

/**
 * Dispatcher on a real NativeLoopRuntime. `turn(state, n, prompt)` plays one
 * provider turn: it may emit provider events (state.onEvent) and returns the
 * turn result, or throws.
 */
function harness(t, { turn, limits = {}, readLimits = null, brainSpend = () => 0, pricing = null } = {}) {
  const root = tempDir(t, 'dispatch');
  const broadcasts = [];
  const gates = new Map();
  const makeAdapter = (state) => {
    let n = 0;
    let aborted = null;
    return {
      identity: () => ({ providerSessionId: `sess-${state.runId.slice(0, 4)}`, providerThreadId: `thread-${state.runId.slice(0, 4)}` }),
      isAlive: () => true,
      async runTurn(prompt) {
        n += 1;
        return turn(state, n, prompt, { gates, isAborted: () => aborted });
      },
      async abort(reason) { aborted = reason; gates.get(state.runId)?.(); },
      async dispose() {},
    };
  };
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'), ledgerPath: resolve(root, 'runs.json'), buildPrompt: () => 'LOOP', iterationDelayMs: 0,
    providerFactories: { codex: async (s) => makeAdapter(s), 'claude-code': async (s) => makeAdapter(s), opencode: async (s) => makeAdapter(s) },
  });
  const dispatcher = createAssistantDispatcher({
    getRuntime: () => runtime, dataDir: root, loopDir: resolve(root, 'loop'), broadcastSync: (m) => broadcasts.push(m), PACKAGE_ROOT: root,
    findCodexAccount: () => null, getCodexAccount: () => ({ id: 'default', home: resolve(root, 'codex-home') }), CODEX_DEFAULT_HOME: resolve(root, 'codex-home'),
    detectProject: () => 'proj', limits: { minIdleTimeoutMs: 50, ...limits }, readLimits, brainSpend, pricing,
  });
  t.after(() => dispatcher.shutdown('test'));
  const reasons = (runId) => broadcasts.filter((m) => m.type === 'assistant:dispatch' && (!runId || m.run?.runId === runId)).map((m) => m.reason);
  return { root, runtime, dispatcher, broadcasts, reasons, gates };
}

// ── config: validation, invariants, persistence, live re-read ─────────────

test('budget validation: amounts, bounds, invariants, null resets', () => {
  assert.deepEqual(validateBudgetPatch({}, BUDGET_DEFAULTS), { ...BUDGET_DEFAULTS });
  assert.equal(validateBudgetPatch({ sessionHardUsd: '40', maxRunUsd: 30 }).maxRunUsd, 30);
  const bad = (patch, field) => assert.throws(() => validateBudgetPatch(patch), (e) => e.code === 'BUDGET_INVALID' && e.status === 400 && e.field === field);
  bad({ defaultRunUsd: 'abc' }, 'defaultRunUsd');
  bad({ defaultRunUsd: 0.05 }, 'defaultRunUsd');
  bad({ sessionHardUsd: 5000 }, 'sessionHardUsd');
  bad({ maxRunUsd: 30 }, 'maxRunUsd'); // above the $25 hard cap
  bad({ defaultRunUsd: 20, maxRunUsd: 10 }, 'defaultRunUsd');
  bad({ sessionWarnUsd: 25 }, 'sessionWarnUsd'); // must be below the hard cap
  bad({ brainUsd: 26 }, 'brainUsd');
  bad({ bogus: 1 }, 'bogus');
  assert.equal(validateBudgetPatch({ defaultRunUsd: null }, { ...BUDGET_DEFAULTS, defaultRunUsd: 2 }).defaultRunUsd, BUDGET_DEFAULTS.defaultRunUsd);
});

test('effective budget: defaults, legacy soft budget, repaired hand edits', () => {
  assert.deepEqual(effectiveBudget({}).sources, { defaultRunUsd: 'default', maxRunUsd: 'default', sessionWarnUsd: 'default', sessionHardUsd: 'default', brainUsd: 'default' });
  const legacy = effectiveBudget({ limits: { sessionSoftBudgetUsd: 10, maxBudgetUsd: 50 }, brains: { claude: { maxBudgetUsd: 4 } } });
  assert.equal(legacy.sessionWarnUsd, 8);
  assert.equal(legacy.sources.sessionWarnUsd, 'legacy');
  assert.equal(legacy.brainUsd, 4);
  assert.equal(legacy.maxRunUsd, 25, 'a $50 per-run ceiling cannot exceed the $25 hard cap');
  assert.deepEqual(legacy.repairs, ['maxRunUsd']);
  assert.equal(effectiveBudget({ limits: { defaultBudgetUsd: 'x', sessionHardBudgetUsd: -1 } }).sessionHardUsd, 25);
});

test('config store saves caps where readers look, keeps other keys, rejects stale versions, and a second reader sees the change', (t) => {
  const dir = tempDir(t, 'config');
  const path = join(dir, 'assistant-config.json');
  writeFileSync(path, JSON.stringify({ routing: { defaultMode: 'never' }, limits: { perSession: 4, sessionSoftBudgetUsd: 10 }, persona: { extra: 'x' } }));
  const store = createAssistantConfigStore({ path });
  const other = createAssistantConfigStore({ path });
  assert.equal(other.budget().sessionWarnUsd, 8);
  const saved = store.patchBudget({ defaultRunUsd: 3, sessionWarnUsd: 12, sessionHardUsd: 40, brainUsd: 6 }, { expectedVersion: 0 });
  assert.equal(saved.version, 1);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.limits.defaultBudgetUsd, 3);
  assert.equal(raw.limits.sessionWarnUsd, 12);
  assert.equal(raw.limits.sessionHardBudgetUsd, 40);
  assert.equal(raw.brains.claude.maxBudgetUsd, 6);
  assert.equal(raw.limits.perSession, 4);
  assert.equal(raw.routing.defaultMode, 'never');
  assert.equal(raw.persona.extra, 'x');
  assert.throws(() => store.patchBudget({ defaultRunUsd: 2 }, { expectedVersion: 0 }), (e) => e.code === 'VERSION_CONFLICT' && e.status === 409);
  assert.throws(() => store.patchBudget({ sessionHardUsd: 5 }), (e) => e.code === 'BUDGET_INVALID' && e.field === 'maxRunUsd');
  // Another process's store (the server's) re-reads the file: no restart.
  const seen = other.budget();
  assert.equal(seen.sessionHardUsd, 40);
  assert.equal(seen.sources.sessionWarnUsd, 'saved');
});

// ── prices ────────────────────────────────────────────────────────────────

test('Codex usage is priced at the models.dev list price; the long-context tier applies to extended windows', () => {
  const pricing = createModelPricing({ data: MODELS_DEV });
  const price = pricing.codexPrice('gpt-6-sol[extended]');
  assert.equal(price.input, 2);
  assert.equal(price.long.size, 272000);
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 };
  // 600k fresh × $2 + 400k cached × $0.2 + 100k out × $10 = 1.2 + 0.08 + 1.0
  assert.equal(codexUsageCostUsd(usage, price), 2.28);
  assert.equal(codexUsageCostUsd(usage, price, { contextWindow: 828400 }), 4.06, '600k × $4 + 400k × $0.4 + 100k × $15');
  assert.equal(pricing.codexPrice('gpt-unknown'), null);
  assert.equal(normalizeListPrice({ input: 0, output: 0 }).input, 0);
  // Injected models.dev data is then the only Codex source (and says so).
  assert.deepEqual([pricing.status().source, pricing.status().available], ['models.dev', true]);
});

test('list prices come from the built-in table; models.dev only fills in models it lacks and reports drift', () => {
  // No models.dev cache at all: the table still prices the models it lists.
  const bare = createModelPricing({ path: '/nonexistent/models.json' });
  assert.deepEqual([bare.status().source, bare.status().available, bare.status().modelsDev, bare.status().drift], ['table', true, false, []]);
  assert.deepEqual([bare.codexPrice('gpt-6.1-sol[extended]').cacheRead, bare.codexPrice('gpt-6-sol').cacheRead, bare.codexPrice('gpt-6-sol').long.size], [0.1, 0.2, 272000]);
  assert.equal(bare.codexPrice('gpt-unknown'), null, 'no list price anywhere: unpriced, never $0');
  assert.deepEqual([bare.claudePrice('claude-sonnet-5-5').input, bare.claudePrice('claude-opus-5-5[1m]').cacheWrite1h, bare.claudePrice('claude-unknown')], [2, 8, null]);
  // A models.dev file: a model the table lacks is priced from it; a table model it prices differently is reported.
  const file = JSON.stringify({ openai: { models: {
    'gpt-9-new': { cost: { input: 7, output: 70, cache_read: 0.7 } },
    'gpt-6-luna': { cost: { input: 0.3, output: 0.5, cache_read: 0.01 } },
  } }, anthropic: { models: { 'claude-opus-5-5': { cost: { input: 4, output: 20, cache_read: 0.2 } } } } });
  const live = createModelPricing({ path: '/models.json', stat: () => ({ mtimeMs: 1 }), readFile: () => file });
  assert.equal(live.codexPrice('gpt-9-new').input, 7);
  assert.equal(live.codexPrice('gpt-6-luna').input, 0.1, 'the table wins over models.dev');
  assert.deepEqual(live.status().drift, [{ model: 'gpt-6-luna', field: 'input', table: 0.1, live: 0.3 }]);
});

test('Codex usage is priced per request: the long rates only when the prompt was over the long-context size', () => {
  const price = createModelPricing({ data: MODELS_DEV }).codexPrice('gpt-6-sol');
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 };
  assert.equal(codexUsageCostUsd(usage, price, { contextWindow: 828400, long: false }), 2.28, 'an extended window with short prompts is priced at the base rates');
  assert.equal(codexUsageCostUsd(usage, price, { long: true }), 4.06, 'a long prompt is priced whole at the long rates, whatever the window');
  assert.equal(codexUsageCostUsd(usage, { ...price, long: null }, { long: true }), 2.28, 'a model without a long tier has one rate');
});

test('a Codex rollout gives the thread total a failed turn left behind', (t) => {
  const home = tempDir(t, 'rollout');
  const at = Date.parse('2026-09-27T12:00:00');
  const d = new Date(at);
  const dir = join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const line = (total) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } });
  writeFileSync(join(dir, 'rollout-2026-09-27T12-00-00-thread-1.jsonl'), [line({ input_tokens: 10, output_tokens: 1 }), line({ input_tokens: 30, cached_input_tokens: 5, output_tokens: 4 }), '{"torn'].join('\n'));
  assert.deepEqual(readCodexRolloutTotal({ codexHome: home, threadId: 'thread-1', sinceMs: at, nowMs: at }), { input_tokens: 30, cached_input_tokens: 5, output_tokens: 4 });
  assert.equal(readCodexRolloutTotal({ codexHome: home, threadId: 'thread-2', sinceMs: at, nowMs: at }), null);
});

// ── dispatcher: live caps, reservations, warnings, hard cap ───────────────

test('live limits: a saved default cap applies to the next dispatch without a restart', async (t) => {
  const live = { defaultBudgetUsd: 5 };
  const { dispatcher, root } = harness(t, { readLimits: () => live, turn: () => ({ text: RESULT, costUsd: 0.01 }) });
  const first = await dispatcher.dispatch({ provider: 'claude-code', task: 'a', cwd: root }, { assistantSessionId: 's1' });
  assert.equal(first.run.budgetUsd, 5);
  live.defaultBudgetUsd = 2;
  const second = await dispatcher.dispatch({ provider: 'claude-code', task: 'b', cwd: root }, { assistantSessionId: 's1' });
  assert.equal(second.run.budgetUsd, 2);
  assert.equal(dispatcher.limits.defaultBudgetUsd, 2, 'dispatcher.limits is refreshed in place');
});

test('a new run gets what the hard cap leaves after spend and live runs; none left is BUDGET_EXCEEDED', async (t) => {
  let brain = 1;
  const { dispatcher, root } = harness(t, {
    limits: { sessionHardBudgetUsd: 10, sessionWarnUsd: 9 }, brainSpend: () => brain,
    turn: (state, n, prompt, { gates }) => new Promise((release) => gates.set(state.runId, () => release({ text: RESULT, costUsd: 0 }))),
  });
  const a = await dispatcher.dispatch({ provider: 'claude-code', task: 'a', cwd: root, budgetUsd: 5 }, { assistantSessionId: 's2' });
  assert.equal(a.run.budgetUsd, 5);
  const b = await dispatcher.dispatch({ provider: 'opencode', task: 'b', cwd: root, budgetUsd: 5 }, { assistantSessionId: 's2' });
  assert.equal(b.run.budgetUsd, 4, '$10 cap − $1 brain − $5 reserved by run a');
  assert.ok(b.run.notes.some((note) => note.startsWith('budget lowered from $5.00 to $4.00')));
  const view = dispatcher.sessionBudget('s2');
  assert.equal(view.reservedUsd, 9);
  assert.equal(view.availableUsd, 0);
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'c', cwd: root }, { assistantSessionId: 's2' }), (e) => e.code === 'BUDGET_EXCEEDED' && e.sessionReserved === 9);
  brain = 10;
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'd', cwd: root }, { assistantSessionId: 's2' }), (e) => e.code === 'BUDGET_EXCEEDED' && /brain \+ agents/.test(e.message));
});

test('the brain\'s spend counts: warning once per threshold, then the hard cap stops the session\'s runs', async (t) => {
  let brain = 0;
  const { dispatcher, root, reasons } = harness(t, {
    limits: { sessionHardBudgetUsd: 10, sessionWarnUsd: 5 }, brainSpend: () => brain,
    turn: () => ({ text: RESULT, costUsd: 1 }),
  });
  const { run } = await dispatcher.dispatch({ provider: 'claude-code', task: 'a', cwd: root, budgetUsd: 3 }, { assistantSessionId: 's3' });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  assert.ok(!reasons(run.runId).includes('budget_warning'));
  brain = 4.5; // $1 run + $4.50 brain ≥ $5 warning
  dispatcher.checkSession('s3');
  dispatcher.checkSession('s3');
  assert.equal(reasons(run.runId).filter((r) => r === 'budget_warning').length, 1);
  brain = 9.5; // ≥ $10 hard cap
  const money = dispatcher.checkSession('s3');
  assert.equal(money.exceeded, true);
  await waitFor(() => dispatcher.get(run.runId).state === 'stopped');
  assert.equal(dispatcher.get(run.runId).completionReason, 'session_budget_cap');
  assert.ok(reasons(run.runId).includes('budget_exceeded'));
});

test('per-run cap: the run stops after the turn that reached it, and follow-ups are refused', async (t) => {
  const { dispatcher, root } = harness(t, { turn: () => ({ text: RESULT, costUsd: 0.6 }) });
  const { run } = await dispatcher.dispatch({ provider: 'claude-code', task: 'a', cwd: root, budgetUsd: 1 }, { assistantSessionId: 's4' });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  dispatcher.sendTurn(run.runId, 'more please');
  await waitFor(() => dispatcher.get(run.runId).state === 'stopped');
  const done = dispatcher.get(run.runId);
  assert.equal(done.completionReason, 'budget_cap');
  assert.equal(done.costUsd, 1.2);
  assert.equal(done.turns.length, 2);
});

test('a follow-up to a run that spent its cap is refused with RUN_BUDGET_EXCEEDED', async (t) => {
  const live = { sessionHardBudgetUsd: 25 };
  const { dispatcher, root } = harness(t, { readLimits: () => live, turn: () => ({ text: RESULT, costUsd: 0.5 }) });
  const { run } = await dispatcher.dispatch({ provider: 'claude-code', task: 'a', cwd: root, budgetUsd: 2 }, { assistantSessionId: 's5' });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  live.sessionHardBudgetUsd = 0.5; // lowered in the Budget tab while the run is warm
  assert.throws(() => dispatcher.sendTurn(run.runId, 'again'), (e) => e.code === 'BUDGET_EXCEEDED' && e.status === 409);
});

// ── provider accounting ───────────────────────────────────────────────────

test('Codex: tokens are priced per turn (estimated); a model with no price is refused, never run as $0', async (t) => {
  const pricing = createModelPricing({ data: MODELS_DEV });
  const usage = { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 10_000 };
  const { dispatcher, root } = harness(t, { pricing, turn: () => ({ text: RESULT, usage }) });
  const priced = await dispatcher.dispatch({ provider: 'codex', task: 'a', cwd: root, model: 'gpt-6-sol' }, { assistantSessionId: 's6' });
  await waitFor(() => dispatcher.get(priced.run.runId).state === 'idle');
  let view = dispatcher.get(priced.run.runId);
  assert.equal(view.costUsd, 0.3, '100k × $2 + 10k × $10');
  assert.equal(view.costBasis, 'estimated');
  assert.equal(view.turns[0].costUsd, 0.3);
  // Fail closed: a model with no price is not dispatched at all (no unlimited paid usage).
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'b', cwd: root, model: 'gpt-7-mystery' }, { assistantSessionId: 's6' }), (e) => e.code === 'BUDGET_UNPRICED' && e.status === 409);
  await assert.rejects(dispatcher.dispatch({ provider: 'opencode', task: 'c', cwd: root, model: 'custom/unknown' }, { assistantSessionId: 's6' }), (e) => e.code === 'BUDGET_UNPRICED');
  assert.equal(dispatcher.list({ assistantSessionId: 's6' }).length, 1);
});

/** One token_usage_record appended to the run's rollout in its temp CODEX_HOME: what codex-cli writes per model response. */
function writeCodexRecord(state, turnId, responseId, usage) {
  const threadId = `thread-${state.runId.slice(0, 4)}`;
  const d = new Date();
  const dir = join(state.codexHome, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `rollout-2026-10-01T08-00-00-${threadId}.jsonl`), `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'token_usage_record', payload: { thread_id: threadId, turn_id: turnId, response_id: responseId, usage } })}\n`);
}

test('Codex: a failed turn is still paid for, from its rollout', async (t) => {
  const pricing = createModelPricing({ data: MODELS_DEV });
  const { dispatcher, root } = harness(t, {
    pricing,
    turn: (state, n) => {
      if (n === 1) {
        writeCodexRecord(state, 'turn-1', 'resp-1', { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 5_000 });
        return { text: RESULT, usage: { input_tokens: 100_000, cached_input_tokens: 0, output_tokens: 5_000 } };
      }
      // The SDK stream reports no usage for a failed turn; the rollout recorded its model response.
      writeCodexRecord(state, 'turn-2', 'resp-2', { input_tokens: 50_000, cached_input_tokens: 0, output_tokens: 5_000 });
      throw new Error('Codex turn failed');
    },
  });
  const { run } = await dispatcher.dispatch({ provider: 'codex', task: 'a', cwd: root, model: 'gpt-6-sol' }, { assistantSessionId: 's7' });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  assert.equal(dispatcher.get(run.runId).costUsd, 0.25);
  dispatcher.sendTurn(run.runId, 'next');
  await waitFor(() => ['failed', 'stopped', 'completed'].includes(dispatcher.get(run.runId).state));
  const view = dispatcher.get(run.runId);
  // + 50k in × $2 + 5k out × $10 from the failed turn's rollout record
  assert.equal(view.costUsd, 0.4);
  assert.equal(view.usage.input_tokens, 150_000);
  assert.equal(view.unpricedTurns, undefined);
});

test('OpenCode: step costs are booked as they stream, and the run stops mid-turn at its cap', async (t) => {
  const message = (id, cost, done = false) => ({ provider: 'opencode', eventType: 'message.updated', event: { info: { id, role: 'assistant', cost, tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, time: done ? { completed: 1 } : {} } } });
  const { dispatcher, root } = harness(t, {
    turn: (state, n, prompt, { gates, isAborted }) => new Promise((release, reject) => {
      state.onEvent(message('m1', 0.4));
      state.onEvent(message('m1', 0.7, true)); // same message grew: +0.3
      state.onEvent(message('m2', 0.5)); // run total 1.2 ≥ $1 cap → stop mid-turn
      gates.set(state.runId, () => (isAborted() ? reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) : release({ text: RESULT })));
    }),
  });
  const { run } = await dispatcher.dispatch({ provider: 'opencode', task: 'a', cwd: root, model: 'ollama-cloud/glm', budgetUsd: 1 }, { assistantSessionId: 's8' });
  await waitFor(() => dispatcher.get(run.runId).state === 'stopped');
  const view = dispatcher.get(run.runId);
  assert.equal(view.completionReason, 'budget_cap');
  assert.equal(view.costUsd, 1.2);
  assert.equal(view.costBasis, 'reported');
  assert.equal(view.usage.input_tokens, 2000);
  assert.ok(view.notes.some((note) => note.startsWith('stopped mid-turn: run spent $1.20 of its $1.00 cap')));
});

test('OpenCode: a free model costs $0 legitimately; a model with no price and no reported cost is flagged', async (t) => {
  const done = (id) => ({ provider: 'opencode', eventType: 'message.updated', event: { info: { id, role: 'assistant', cost: 0, tokens: { input: 500, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, time: { completed: 1 } } } });
  const { dispatcher, root } = harness(t, { turn: (state) => { state.onEvent(done(`m-${state.runId}`)); return { text: RESULT }; } });
  const free = await dispatcher.dispatch({ provider: 'opencode', task: 'a', cwd: root }, { assistantSessionId: 's9' });
  await waitFor(() => dispatcher.get(free.run.runId).state === 'idle');
  // No catalog here: the model's price is unknown, so the $0 is not trusted.
  assert.equal(dispatcher.get(free.run.runId).costBasis, 'unpriced');
});

// ── API ───────────────────────────────────────────────────────────────────

test('GET/PUT /budget: effective values, validation with the field, version conflicts, UI only, live apply hooks', async (t) => {
  const dir = tempDir(t, 'api');
  const configStore = createAssistantConfigStore({ path: join(dir, 'assistant-config.json') });
  const calls = [];
  const dispatcher = { limits: {}, get: () => null, refreshLimits: () => calls.push('refresh'), sessionBudget: (id) => ({ totalUsd: 1, hardUsd: 25, id }) };
  const runtime = { onBudgetChanged: () => calls.push('runtime'), resolveTerminal: () => null, listSessions: () => [] };
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher, runtime, configStore, broadcastSync: (m) => broadcasts.push(m), pricing: createModelPricing({ data: MODELS_DEV }) }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/assistant`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const got = await call('GET', '/budget?sessionId=s1');
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.budget, { ...BUDGET_DEFAULTS });
  assert.equal(got.json.session.id, 's1');
  assert.equal(got.json.pricing.available, true);
  assert.ok(got.json.enforcement.codex.perRun.includes('checked after each turn'));
  const invalid = await call('PUT', '/budget', { version: 0, budget: { sessionWarnUsd: 30 } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, 'BUDGET_INVALID');
  assert.equal(invalid.json.field, 'sessionWarnUsd');
  const saved = await call('PUT', '/budget', { version: 0, budget: { defaultRunUsd: 2 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.budget.defaultRunUsd, 2);
  assert.equal(saved.json.version, 1);
  assert.deepEqual(calls, ['refresh', 'runtime']);
  assert.equal(broadcasts.at(-1).type, 'assistant:budget-changed');
  const stale = await call('PUT', '/budget', { version: 0, budget: { defaultRunUsd: 3 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'VERSION_CONFLICT');
  const agent = await call('PUT', '/budget', { version: 1, budget: { sessionHardUsd: 100 } }, { 'X-Synabun-Terminal': 'codex-sp-abc' });
  assert.equal(agent.status, 403);
});

// ── UI helpers ────────────────────────────────────────────────────────────

test('Budget tab draft validation mirrors the server rules; the chip tone follows warning and hard cap', () => {
  const ok = validateBudgetDraft({ defaultRunUsd: '5', maxRunUsd: '$25', sessionWarnUsd: '8', sessionHardUsd: '25', brainUsd: '10' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.maxRunUsd, 25);
  const bad = validateBudgetDraft({ defaultRunUsd: '', maxRunUsd: '30', sessionWarnUsd: '25', sessionHardUsd: '25', brainUsd: '0.01' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['brainUsd', 'defaultRunUsd', 'maxRunUsd', 'sessionWarnUsd']);
  assert.equal(budgetTone({ totalUsd: 1, warnUsd: 8, hardUsd: 25 }), 'ok');
  assert.equal(budgetTone({ totalUsd: 8, warnUsd: 8, hardUsd: 25 }), 'warn');
  assert.equal(budgetTone({ totalUsd: 25, warnUsd: 8, hardUsd: 25 }), 'over');
  assert.equal(budgetTone(null), null);
});

test('a Codex brain\'s token total is priced (estimated); no price gives null, never $0', () => {
  const price = createModelPricing({ data: MODELS_DEV }).codexPrice('gpt-6-sol');
  const priceUsage = (usage) => codexUsageCostUsd(usage, price);
  const tokenUsage = { total: { inputTokens: 200_000, cachedInputTokens: 100_000, outputTokens: 20_000 }, last: { inputTokens: 5 } };
  // 100k fresh × $2 + 100k cached × $0.2 + 20k × $10
  assert.equal(codexThreadCost(tokenUsage, priceUsage), 0.42);
  assert.equal(codexThreadCost(tokenUsage, () => null), null);
  assert.equal(codexThreadCost(null, priceUsage), null);
});

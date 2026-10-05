// The session headline: every task of an assistant session added up, input and output apart.
// Regression for "the counter restarted from zero on a follow-up prompt": the gauge showed the
// current task (one human prompt), so a new prompt began a new task at 0. The real ledger,
// dispatcher, runtime and API are wired as server.js wires them; only the providers are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import { createAssistantDispatcher } from '../lib/assistant-dispatch.js';
import { createAssistantRuntime } from '../lib/assistant-runtime.js';
import { createAssistantApi } from '../lib/assistant-api.js';
import { createUsageLedger, readUsageLedgerFile, usageLedgerPath } from '../lib/assistant-usage.js';
import { createModelPricing } from '../lib/assistant-budget.js';
import { createClaudeNativeLoopAdapter } from '../lib/native-loop-providers.js';
import { applyUsagePacket, compactUsageView, createTabState, deserializeTabState, serializeTabState } from '../public/shared/assistant/asst-state.js';
import { tokenSides, usageHeadline } from '../public/shared/assistant/asst-usage.js';

const RESULT_TEXT = '## Result\nstatus: done\nsummary: did the thing\nchanges:\n- none\nfollow_ups:\n- none';
const CODEX_THREAD = '01a00000-0000-7000-8000-00000005e551';
const OPUS = 'claude-opus-5-5[1m]';
const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-5-5';

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await wait(5);
  }
  throw new Error('Timed out waiting for condition');
};
const usd = (value) => Number(Number(value).toFixed(6));
/** One SDK ModelUsage entry. */
const modelUse = (inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens, costUSD) => ({ inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens, costUSD });

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  usage() { return this.sent.filter((packet) => packet.type === 'assistant:usage'); }
}

/**
 * The Assistant on a data directory: ledger, dispatcher, runtime and API. `workers` scripts the
 * dispatched runs: claude(n) → the SDK messages of the Claude worker's n-th turn (an async
 * generator), codex() → what its one turn writes to its rollout.
 */
async function stack(t, root, { workers = {} } = {}) {
  const codexHome = resolve(root, 'codex-home');
  const ledger = createUsageLedger({ dataDir: root });
  const brain = { prompts: [], sink: null };
  const brainFactory = ({ sink }) => {
    brain.sink = sink;
    return { async start() {}, async sendUserTurn({ text }) { brain.prompts.push(text); }, identity: () => ({ providerSessionId: 'brain-session' }), async dispose() {} };
  };
  const brainSays = (event) => brain.sink.send({ type: 'event', event: { session_id: 'brain-session', ...event } });
  /** The brain's result (modelUsage is cumulative for its CLI session) and the end of its turn. */
  const brainEnds = (uuid, usage, modelUsage, total) => {
    brainSays({ type: 'result', subtype: 'success', uuid, result: 'ok', usage, modelUsage, total_cost_usd: total });
    brain.sink.send({ type: 'done', code: 0 });
  };
  const claudeQuery = ({ prompt }) => {
    const generator = (async function* () {
      let n = 0;
      for await (const _message of prompt) {
        n += 1;
        if (n === 1) yield { type: 'system', subtype: 'init', session_id: 'claude-worker' };
        yield* workers.claude(n);
      }
    })();
    generator.interrupt = async () => {};
    return generator;
  };
  const codexFactory = async () => ({
    identity: () => ({ providerThreadId: CODEX_THREAD, providerSessionId: CODEX_THREAD }),
    isAlive: () => true,
    async runTurn() {
      const day = new Date();
      const dir = join(codexHome, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      mkdirSync(dir, { recursive: true });
      const line = (type, payload) => appendFileSync(join(dir, `rollout-2026-10-01T09-00-00-${CODEX_THREAD}.jsonl`), `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
      line('session_meta', { session_id: CODEX_THREAD, id: CODEX_THREAD, cli_version: '0.156.1' });
      line('turn_context', { turn_id: 'turn-1', model: 'gpt-6-sol' });
      return workers.codex((responseId, usage) => line('token_usage_record', { thread_id: CODEX_THREAD, session_id: CODEX_THREAD, turn_id: 'turn-1', response_id: responseId, usage }));
    },
    async abort() {},
    async dispose() {},
  });
  let runtime = null;
  const loops = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'), ledgerPath: resolve(root, 'runs.json'), buildPrompt: () => 'LOOP', iterationDelayMs: 0,
    providerFactories: {
      codex: codexFactory,
      'claude-code': (state) => createClaudeNativeLoopAdapter({ ...state, queryFactory: claudeQuery, resolveRuntime: () => ({ ok: true, state: 'ok' }), includePartialMessages: false }),
    },
  });
  const dispatcher = createAssistantDispatcher({
    getRuntime: () => loops, dataDir: root, loopDir: resolve(root, 'loop'), PACKAGE_ROOT: root,
    getCodexAccount: () => ({ id: 'default', home: codexHome }), CODEX_DEFAULT_HOME: codexHome,
    detectProject: () => 'proj', limits: { minIdleTimeoutMs: 50 },
    // The list-price table itself (no models.dev file): the prices the catalog shows.
    pricing: createModelPricing({ path: resolve(root, 'no-models.json') }),
    brainSpend: (sessionId) => runtime?.brainSpend?.(sessionId) || 0,
    currentTask: (sessionId) => runtime?.currentTask?.(sessionId) || null,
    usage: ledger,
  });
  runtime = createAssistantRuntime({
    dispatcher, dataDir: root, usage: ledger, detectProject: () => 'proj',
    buildCatalog: async () => ({ models: {}, projects: [] }),
    brainFactories: { 'claude-code': brainFactory }, config: { mailboxBatchMs: 20 },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher, runtime, usage: ledger, buildCatalog: async () => ({ models: {}, projects: [] }) }));
  const server = await new Promise((resolveListen) => { const s = app.listen(0, '127.0.0.1', () => resolveListen(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/assistant`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.shutdown();
    await dispatcher.shutdown('test');
    await new Promise((resolveClose) => server.close(resolveClose));
  };
  t.after(close);
  const attach = async (id) => { const ws = new FakeWs(); await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${id}` }); return ws; };
  return { ledger, dispatcher, runtime, brain, brainSays, brainEnds, call, close, attach, codexHome };
}

/** A tokens object adds up: both sides to the total, the classes to the sides. */
function assertAddsUp(tokens, label) {
  assert.equal(tokens.inputTotal, tokens.input + tokens.cacheWrite + tokens.cacheRead, `${label}: input side`);
  assert.equal(tokens.outputTotal, tokens.output + tokens.reasoning, `${label}: output side`);
  assert.equal(tokens.total, tokens.inputTotal + tokens.outputTotal, `${label}: total`);
}

test('a follow-up prompt adds to the session headline (it never restarts from zero); tasks add up to the session, agents to their task, input and output apart', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-usage-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = await stack(t, root, { workers: {
    // The Claude worker's one turn: 40 input + 400 cache read + 60 output on Sonnet, $0.02.
    async* claude() { yield { type: 'result', subtype: 'success', session_id: 'claude-worker', uuid: 'run-res-1', result: RESULT_TEXT, total_cost_usd: 0.02, usage: { input_tokens: 40, cache_read_input_tokens: 400, output_tokens: 60 }, modelUsage: { [SONNET]: modelUse(40, 0, 400, 60, 0.02) } }; },
    // The Codex worker's one response: Codex keys (input includes the 40k cached, output the 500 reasoning).
    codex(record) { record('resp-1', { input_tokens: 100_000, cached_input_tokens: 40_000, cache_write_input_tokens: 0, output_tokens: 2_000, reasoning_output_tokens: 500, total_tokens: 102_000 }); return { text: RESULT_TEXT }; },
  } });
  const id = (await s.runtime.createSession({ brain: { provider: 'claude-code' }, cwd: root })).id;
  const asBrain = { 'X-Synabun-Terminal': id };
  const ws = await s.attach(id);
  const view = () => s.runtime.usageView(id);

  // ── task 1: a brain turn (with a helper-model call) and a dispatched Claude run ──
  assert.deepEqual(await s.runtime.submit(id, { text: 'First question' }), { ok: true });
  const claudeRun = (await s.call('POST', '/dispatch', { provider: 'claude-code', task: 'Look it up', cwd: root, title: 'Reader' }, asBrain)).json.run;
  assert.equal((await s.call('POST', '/wait', { runId: claudeRun.runId, until: 'idle', timeoutMs: 4000 }, asBrain)).json.timedOut, false);
  s.brainEnds('b-res-1', { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000, output_tokens: 500 }, { [OPUS]: modelUse(100, 2000, 10_000, 500, 0.05), [HAIKU]: modelUse(50, 0, 0, 5, 0.001) }, 0.051);
  const first = view();
  assert.deepEqual([first.task.id, first.task.tokens.total, first.session.tokens.total], ['task-1', 13_155, 13_155], 'one task so far: the session is that task');
  assert.deepEqual([first.session.tokens.inputTotal, first.session.tokens.outputTotal], [12_590, 565], 'input 12,150 brain + 440 run; output 505 brain + 60 run');
  assertAddsUp(first.session.tokens, 'session after task 1');
  await wait(300); // the throttled packet
  const shown = createTabState(id, { provider: 'claude-code' });
  assert.equal(applyUsagePacket(shown, ws.usage().at(-1)), true);
  assert.equal(usageHeadline(shown.usageView).tokens.total, 13_155);

  // ── the follow-up prompt: a new task begins at zero, the headline does not ──
  assert.deepEqual(await s.runtime.submit(id, { text: 'A follow-up question' }), { ok: true });
  const followUp = view();
  assert.deepEqual([followUp.task.id, followUp.task.tokens.total], ['task-2', 0], 'the new task has spent nothing yet');
  assert.equal(followUp.session.tokens.total, 13_155, 'the session total is what it was: it only grows');
  assert.deepEqual([followUp.session.tasks, followUp.session.fidelity], [2, 'live'], 'a turn is running: provisional, not reset');
  await wait(300);
  const packet = ws.usage().at(-1);
  assert.deepEqual([packet.task.id, packet.task.tokens.total, packet.session.tokens.total], ['task-2', 0, 13_155], 'the packet the panel gets carries the session total');
  // What the panel shows from that packet: the session, not the empty task.
  assert.equal(applyUsagePacket(shown, packet), true, 'the newer view replaces the older one');
  const headline = usageHeadline(shown.usageView);
  assert.deepEqual([headline.scope, headline.tokens.total, tokenSides(headline.tokens)], ['session', 13_155, { input: 12_590, output: 565, total: 13_155 }]);

  // ── task 2: the brain's second turn (cumulative modelUsage) and a dispatched Codex run ──
  const codexRun = (await s.call('POST', '/dispatch', { provider: 'codex', task: 'Port it', cwd: root, model: 'gpt-6-sol', title: 'Porter' }, asBrain)).json.run;
  assert.equal((await s.call('POST', '/wait', { runId: codexRun.runId, until: 'idle', timeoutMs: 4000 }, asBrain)).json.timedOut, false);
  s.brainEnds('b-res-2', { input_tokens: 50, cache_creation_input_tokens: 500, cache_read_input_tokens: 20_000, output_tokens: 400 }, { [OPUS]: modelUse(150, 2500, 30_000, 900, 0.09), [HAIKU]: modelUse(50, 0, 0, 5, 0.001) }, 0.091);
  for (const run of [claudeRun, codexRun]) assert.equal((await s.call('POST', `/runs/${run.runId}/complete`, {}, asBrain)).status, 200);
  await waitFor(() => s.dispatcher.get(claudeRun.runId).terminal && s.dispatcher.get(codexRun.runId).terminal);
  await wait(300);

  const end = view();
  const one = s.runtime.usageView(id, 'task-1').task;
  const two = end.task;
  assert.deepEqual([one.tokens.total, two.tokens.total, end.session.tokens.total], [13_155, 122_950, 136_105]);
  assert.equal(end.session.tokens.total, one.tokens.total + two.tokens.total, 'the session is the sum of its tasks');
  for (const task of [one, two]) {
    assert.equal(task.tokens.total, task.agents.reduce((sum, agent) => sum + agent.tokens.total, 0), `${task.id}: its brain turns plus its runs`);
    assertAddsUp(task.tokens, task.id);
    for (const agent of task.agents) assertAddsUp(agent.tokens, `${task.id} ${agent.key}`);
  }
  assert.deepEqual(one.agents.map((agent) => [agent.key, agent.tokens.total]), [['brain', 12_655], [claudeRun.runId, 500]]);
  assert.deepEqual(two.agents.map((agent) => [agent.key, agent.tokens.total]), [['brain', 20_950], [codexRun.runId, 102_000]]);
  // Input and output, per class: the Codex run's 100k input is 60k uncached + 40k cache read, its 2k output is 1.5k + 500 reasoning.
  assert.deepEqual(end.session.tokens, { input: 60_240, cacheWrite: 2_500, cacheRead: 70_400, output: 2_465, reasoning: 500, total: 136_105, inputTotal: 133_140, outputTotal: 2_965 });
  assertAddsUp(end.session.tokens, 'session');
  // Dollars: the CLI's reported cost for Claude, the list price for Codex (60k × $2 + 40k × $0.20 + 2k × $10 per million).
  assert.deepEqual([usd(one.costUsd), usd(two.costUsd), usd(end.session.costUsd)], [0.071, 0.188, 0.259]);
  assert.equal(end.session.costBasis, 'estimated', 'a plan-billed part makes the whole a list-price equivalent');
  assert.deepEqual(end.session.models.map((row) => [row.provider, row.model, row.tokens.inputTotal, row.tokens.outputTotal, usd(row.costUsd), row.costBasis]), [
    ['codex', 'gpt-6-sol', 100_000, 2_000, 0.148, 'estimated'],
    ['claude-code', OPUS, 32_650, 900, 0.09, 'reported'],
    ['claude-code', SONNET, 440, 60, 0.02, 'reported'],
    ['claude-code', HAIKU, 50, 5, 0.001, 'reported'],
  ]);
  assert.equal(end.session.models.reduce((sum, row) => sum + row.tokens.total, 0), end.session.tokens.total, 'the models add up to the session');

  // ── the packet, the endpoint and the tool's source agree with the ledger ──
  const { type: _type, ...lastPacket } = ws.usage().at(-1);
  const current = await s.call('GET', `/sessions/${id}/usage?task=current`);
  assert.deepEqual(lastPacket, current.json.usage, 'the packet the panel got last is what the endpoint answers');
  const all = (await s.call('GET', `/sessions/${id}/usage?task=all`)).json.session;
  assert.deepEqual([all.tokens, all.costUsd, all.models], [end.session.tokens, end.session.costUsd, end.session.models], 'task=all (what agent_usage reads) gives the same session');
  assert.deepEqual(all.tasks.map((row) => [row.id, row.total, row.inputTotal, row.outputTotal]), [['task-1', 13_155, 12_590, 565], ['task-2', 122_950, 120_550, 2_400]]);
  assert.deepEqual([s.ledger.sessionView(id).tokens, usd(s.ledger.sessionView(id).costUsd)], [end.session.tokens, 0.259], 'and both are the ledger');
  // The file is what was shown: the rows on disk add up to the same total.
  const file = readUsageLedgerFile(usageLedgerPath(root, id));
  assert.equal(file.rows.reduce((sum, row) => sum + row.tokens.input + row.tokens.cacheWrite + row.tokens.cacheRead + row.tokens.output + row.tokens.reasoning, 0), 136_105);

  // ── a reload: the panel's saved snapshot restores the same headline before the socket is back ──
  assert.equal(applyUsagePacket(shown, ws.usage().at(-1)), true);
  const restored = deserializeTabState(JSON.stringify(serializeTabState(shown)));
  assert.deepEqual([usageHeadline(restored.usageView).tokens.total, tokenSides(usageHeadline(restored.usageView).tokens)], [136_105, { input: 133_140, output: 2_965, total: 136_105 }]);
  assert.equal(compactUsageView(shown.usageView).session.models.length, 4);
});

test('the totals survive a restart: a new ledger and runtime on the same data show the same session, and the next prompt adds to it', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-usage-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workers = { async* claude() {}, codex() { return { text: RESULT_TEXT }; } };
  const before = await stack(t, root, { workers });
  const id = (await before.runtime.createSession({ brain: { provider: 'claude-code' }, cwd: root })).id;
  await before.attach(id);
  assert.deepEqual(await before.runtime.submit(id, { text: 'Before the restart' }), { ok: true });
  before.brainEnds('b-res-1', { input_tokens: 100, cache_read_input_tokens: 10_000, output_tokens: 500 }, { [OPUS]: modelUse(100, 0, 10_000, 500, 0.05) }, 0.05);
  const shownBefore = before.runtime.usageView(id).session;
  assert.equal(shownBefore.tokens.total, 10_600);
  await before.close(); // the server stops

  // ── the server starts again: nothing in memory, only the files ──
  const after = await stack(t, root, { workers });
  assert.deepEqual(after.ledger.sessionView(id).tokens, shownBefore.tokens, 'read back from the ledger file');
  const ws = await after.attach(id);
  const attached = ws.usage()[0];
  assert.deepEqual([attached.session.tokens, attached.session.costUsd, attached.session.tasks, attached.task.id], [shownBefore.tokens, 0.05, 1, 'task-1'], 'the first packet after the restart is the same headline');
  assert.deepEqual((await after.call('GET', `/sessions/${id}/usage?task=all`)).json.session.tokens, shownBefore.tokens);

  // The next prompt resumes the same Claude session, whose counters carry on: only the new turn is added.
  assert.deepEqual(await after.runtime.submit(id, { text: 'After the restart' }), { ok: true });
  assert.deepEqual([after.runtime.usageView(id).task.id, after.runtime.usageView(id).session.tokens.total], ['task-2', 10_600], 'a new task, the same headline');
  after.brainEnds('b-res-2', { input_tokens: 20, cache_read_input_tokens: 4000, output_tokens: 80 }, { [OPUS]: modelUse(120, 0, 14_000, 580, 0.07) }, 0.07);
  assert.equal(after.runtime.usageView(id).session.tokens.total, 14_700, 'the saved snapshot was the baseline: 4,100 new tokens, not 14,700 again');
  // A CLI process whose counters began again from zero is counted in full, not as a negative delta.
  assert.deepEqual(await after.runtime.submit(id, { text: 'Once more' }), { ok: true });
  after.brainEnds('b-res-3', { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 40 }, { [OPUS]: modelUse(10, 0, 1000, 40, 0.01) }, 0.01);
  const end = after.runtime.usageView(id).session;
  assert.deepEqual([end.tokens.total, end.tokens.inputTotal, end.tokens.outputTotal, end.tasks, usd(end.costUsd)], [15_750, 15_130, 620, 3, 0.08]);
});

test('an interrupted brain turn and a run stopped mid-turn keep the tokens they spent (booked from the stream, flagged partial, priced at list price)', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-usage-interrupt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let release = null;
  const held = new Promise((open) => { release = open; });
  t.after(() => release());
  const s = await stack(t, root, { workers: {
    // The worker answers one call (33,458 cache write + 13,241 cache read) and is stopped before any result.
    async* claude() {
      yield { type: 'assistant', session_id: 'claude-worker', parent_tool_use_id: null, message: { id: 'w-msg-1', model: 'claude-sonnet-5-5', role: 'assistant', content: [], usage: { input_tokens: 2, cache_creation_input_tokens: 33_458, cache_read_input_tokens: 13_241, output_tokens: 196 } } };
      await held;
    },
    codex() { return { text: RESULT_TEXT }; },
  } });
  const id = (await s.runtime.createSession({ brain: { provider: 'claude-code' }, cwd: root })).id;
  const asBrain = { 'X-Synabun-Terminal': id };
  await s.attach(id);
  const total = () => s.runtime.usageView(id).session.tokens.total;
  const rows = () => readUsageLedgerFile(usageLedgerPath(root, id)).rows;
  const usage = { [OPUS]: modelUse(100, 0, 10_000, 500, 0.05) };
  const cutOff = (messageId) => s.brainSays({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: messageId, model: 'claude-opus-5-5', usage: { input_tokens: 6, cache_creation_input_tokens: 1000, cache_read_input_tokens: 400_000, output_tokens: 1 } } } });
  const interruptResult = (uuid) => s.brainSays({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: usage, total_cost_usd: 0.05 });

  await s.runtime.submit(id, { text: 'One' });
  s.brainEnds('b-res-1', { input_tokens: 100, cache_read_input_tokens: 10_000, output_tokens: 500 }, usage, 0.05);
  assert.equal(total(), 10_600);

  // The user interrupts the second turn mid-answer. The CLI's result says nothing was used (its totals
  // are unchanged), but the request was sent: 401,006 input-side tokens and what it had streamed.
  await s.runtime.submit(id, { text: 'Two' });
  cutOff('b-msg-2');
  assert.equal(s.runtime.usageView(id).task.pending.total, 401_007, 'live while it streams');
  s.brain.sink.send({ type: 'aborted' });
  interruptResult('b-res-2');
  assert.equal(total(), 10_600 + 401_007, 'aborted first, result second: booked once');

  // The other order: the result arrives before the abort notice.
  await s.runtime.submit(id, { text: 'Three' });
  cutOff('b-msg-3');
  interruptResult('b-res-3');
  s.brain.sink.send({ type: 'aborted' });
  assert.equal(total(), 10_600 + 2 * 401_007, 'result first, aborted second: booked once');
  const estimates = rows().filter((row) => row.src === 'claude-stream-estimate');
  assert.deepEqual(estimates.map((row) => [row.task, row.scope, row.model, row.tokens, row.fid, row.why, row.basis, row.cost]), [
    ['task-2', 'brain', OPUS, { input: 6, cacheWrite: 1000, cacheRead: 400_000, output: 1, reasoning: 0 }, 'partial', 'interrupted', 'estimated', 0.088044],
    ['task-3', 'brain', OPUS, { input: 6, cacheWrite: 1000, cacheRead: 400_000, output: 1, reasoning: 0 }, 'partial', 'interrupted', 'estimated', 0.088044],
  ], '6 × $4 + 1,000 × $8 (1-hour cache write) + 400,000 × $0.20 + 1 × $20 per million');
  assert.equal(s.runtime.usageView(id, 'task-2').task.fidelity, 'partial');

  // The next turn is counted whole: the estimates are not taken off it.
  await s.runtime.submit(id, { text: 'Four' });
  s.brainEnds('b-res-4', { input_tokens: 50, cache_read_input_tokens: 5000, output_tokens: 250 }, { [OPUS]: modelUse(150, 0, 15_000, 750, 0.08) }, 0.08);
  assert.equal(total(), 10_600 + 2 * 401_007 + 5300);

  // A dispatched Claude run stopped mid-turn: the call it made is in no result.
  const run = (await s.call('POST', '/dispatch', { provider: 'claude-code', task: 'Long job', cwd: root, title: 'Stopped' }, asBrain)).json.run;
  await waitFor(() => s.dispatcher.get(run.runId).tokens?.pending.total === 46_897);
  await s.dispatcher.stop(run.runId, 'user');
  await waitFor(() => s.dispatcher.get(run.runId).terminal);
  const stopped = s.dispatcher.get(run.runId);
  assert.deepEqual([stopped.tokens.total, stopped.tokens.pending.total, stopped.tokens.fidelity], [46_897, 0, 'partial'], 'settled, not dropped');
  const booked = rows().filter((row) => row.run === run.runId);
  assert.deepEqual(booked.map((row) => [row.tokens, row.fid, row.why, row.src, row.basis, row.cost]), [
    [{ input: 2, cacheWrite: 33_458, cacheRead: 13_241, output: 196, reasoning: 0 }, 'partial', 'no-result', 'claude-stream-estimate', 'estimated', 0.1384442],
  ], '2 × $2 + 33,458 × $4 + 13,241 × $0.20 + 196 × $10 per million');
  assert.deepEqual([usd(stopped.costUsd), stopped.costBasis], [0.138444, 'estimated']);
  assert.equal(total(), 10_600 + 2 * 401_007 + 5300 + 46_897);
});

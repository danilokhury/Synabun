// Exact token accounting, end to end: one ledger, the real dispatcher, runtime and API router wired
// the way server.js wires them. Only the providers are fake (a brain that emits Claude SDK
// messages, a scripted Claude worker, a Codex worker that writes a rollout).
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
import { createUsageLedger } from '../lib/assistant-usage.js';
import { createModelPricing } from '../lib/assistant-budget.js';
import { createClaudeNativeLoopAdapter } from '../lib/native-loop-providers.js';

const RESULT_TEXT = '## Result\nstatus: done\nsummary: did the thing\nchanges:\n- none\nfollow_ups:\n- none';
const CODEX_THREAD = '01a00000-0000-7000-8000-0000000e2e01';
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
/** A promise and the function that resolves it. */
function gate() {
  let open = null;
  const closed = new Promise((resolveGate) => { open = resolveGate; });
  return { closed, open };
}
const usd = (value) => Number(Number(value).toFixed(6));
const modelUse = (inputTokens, outputTokens, cacheReadInputTokens, costUSD) => ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens: 0, costUSD });
const codexUse = (input, cached, output, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  packets(type) { return this.sent.filter((packet) => packet.type === type); }
}

test('one story through the ledger, the dispatcher, the runtime and the API: every token is booked once, in its task', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-usage-integration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = resolve(root, 'codex-home');
  const ledger = createUsageLedger({ dataDir: root });

  // ── fake providers ──
  // The brain: the test plays its Claude SDK messages; every prompt it is given is kept.
  const brain = { prompts: [], sink: null };
  const brainFactory = ({ sink }) => {
    brain.sink = sink;
    return {
      async start() {},
      async sendUserTurn({ text }) { brain.prompts.push(text); },
      identity: () => ({ providerSessionId: 'brain-session' }),
      async dispose() {},
    };
  };
  const brainSays = (event) => brain.sink.send({ type: 'event', event: { session_id: 'brain-session', ...event } });
  /** The brain's result (modelUsage is cumulative for its query) and the end of its turn. */
  const brainEnds = (uuid, usage, modelUsage, total) => {
    brainSays({ type: 'result', subtype: 'success', uuid, result: 'ok', usage, modelUsage, total_cost_usd: total });
    brain.sink.send({ type: 'done', code: 0 });
  };

  // The Codex worker: its one turn is held, then writes two responses and a compaction call to its rollout.
  const codexGate = gate();
  const codexFactory = async () => ({
    identity: () => ({ providerThreadId: CODEX_THREAD, providerSessionId: CODEX_THREAD }),
    isAlive: () => true,
    async runTurn() {
      await codexGate.closed;
      const day = new Date();
      const dir = join(codexHome, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      mkdirSync(dir, { recursive: true });
      const line = (type, payload) => appendFileSync(join(dir, `rollout-2026-10-01T09-00-00-${CODEX_THREAD}.jsonl`), `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
      const record = (responseId, usage) => line('token_usage_record', { thread_id: CODEX_THREAD, session_id: CODEX_THREAD, turn_id: 'turn-1', response_id: responseId, usage });
      line('session_meta', { session_id: CODEX_THREAD, id: CODEX_THREAD, cli_version: '0.156.1' });
      line('turn_context', { turn_id: 'turn-1', model: 'gpt-6-sol' });
      record('resp-1', codexUse(100_000, 40_000, 2_000, 500));
      record('resp-compact', codexUse(50_000, 0, 1_000)); // turn.completed never reports this call
      record('resp-2', codexUse(120_000, 100_000, 500));
      return { text: RESULT_TEXT, usage: codexUse(220_000, 140_000, 2_500, 500) };
    },
    async abort() {},
    async dispose() {},
  });

  // The Claude worker: the real adapter on a scripted CLI. Its follow-up turn is held.
  const claudeGate = gate();
  const claudeQuery = ({ prompt }) => {
    const generator = (async function* () {
      let n = 0;
      for await (const _message of prompt) {
        n += 1;
        if (n === 1) {
          yield { type: 'system', subtype: 'init', session_id: 'claude-worker' };
          yield { type: 'result', subtype: 'success', session_id: 'claude-worker', uuid: 'run-res-1', result: RESULT_TEXT, total_cost_usd: 0.05, usage: { input_tokens: 40, output_tokens: 10 }, modelUsage: { [SONNET]: modelUse(40, 10, 0, 0.05) } };
        } else {
          await claudeGate.closed;
          yield { type: 'result', subtype: 'success', session_id: 'claude-worker', uuid: 'run-res-2', result: RESULT_TEXT, total_cost_usd: 0.08, usage: { input_tokens: 30, output_tokens: 15 }, modelUsage: { [SONNET]: modelUse(70, 25, 0, 0.08) } };
        }
      }
    })();
    generator.interrupt = async () => {};
    return generator;
  };

  // ── the real pieces, wired as server.js wires them ──
  let runtime = null;
  let memoryLookups = 0;
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
    pricing: createModelPricing({ data: { openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10, cache_read: 0.2 } } } } } }),
    memory: { memoryForRun: () => { memoryLookups += 1; return null; } },
    brainSpend: (sessionId) => runtime?.brainSpend?.(sessionId) || 0,
    currentTask: (sessionId) => runtime?.currentTask?.(sessionId) || null,
    usage: ledger,
  });
  runtime = createAssistantRuntime({
    dispatcher, dataDir: root, usage: ledger, detectProject: () => 'proj',
    buildCatalog: async () => ({ models: {}, projects: [] }),
    brainFactories: { 'claude-code': brainFactory }, config: { mailboxBatchMs: 20 },
  });
  t.after(async () => { codexGate.open(); claudeGate.open(); await runtime.shutdown(); await dispatcher.shutdown('test'); });
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher, runtime, usage: ledger, buildCatalog: async () => ({ models: {}, projects: [] }) }));
  const server = await new Promise((resolveListen) => { const s = app.listen(0, '127.0.0.1', () => resolveListen(s)); });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const base = `http://127.0.0.1:${server.address().port}/api/assistant`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };

  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: root });
  const id = session.id;
  // What the brain's MCP tools send: the session pinned in X-Synabun-Terminal.
  const asBrain = { 'X-Synabun-Terminal': id };
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${id}` });
  const task = (taskId) => runtime.usageView(id, taskId).task;
  const agentOf = (taskId, key) => task(taskId).agents.find((agent) => agent.key === key) || null;

  // ── a. A human prompt starts task-1; the brain works, with a sub-agent. ──
  assert.deepEqual(await runtime.submit(id, { text: 'Build the feature' }), { ok: true });
  assert.equal(runtime.currentTask(id), 'task-1');
  brainSays({ type: 'assistant', parent_tool_use_id: null, message: { id: 'b-msg-1', model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 } } });
  brainSays({ type: 'assistant', parent_tool_use_id: 'toolu-1', message: { id: 'b-msg-2', model: HAIKU, role: 'assistant', content: [], usage: { input_tokens: 200, output_tokens: 20 } } });
  assert.deepEqual([task('task-1').pending.total, task('task-1').fidelity], [1370, 'live'], 'the turn in progress is provisional');

  // ── b. During that turn the brain dispatches a Codex run and a Claude run. ──
  const codexRun = (await call('POST', '/dispatch', { provider: 'codex', task: 'Port the module', cwd: root, model: 'gpt-6-sol', title: 'Porter' }, asBrain)).json.run;
  const claudeRun = (await call('POST', '/dispatch', { provider: 'claude-code', task: 'Review the port', cwd: root, title: 'Reviewer' }, asBrain)).json.run;
  assert.deepEqual([codexRun.taskId, claudeRun.taskId, codexRun.assistantSessionId], ['task-1', 'task-1', id]);
  // agent_wait is the barrier: the brain reads the Claude run's result inside its own turn.
  const waited = await call('POST', '/wait', { runId: claudeRun.runId, until: 'idle', timeoutMs: 4000 }, asBrain);
  assert.deepEqual([waited.json.timedOut, waited.json.done.map((run) => run.runId)], [false, [claudeRun.runId]]);
  assert.equal(dispatcher.get(claudeRun.runId).turns[0].taskId, 'task-1');
  assert.deepEqual([agentOf('task-1', claudeRun.runId).tokens.total, agentOf('task-1', claudeRun.runId).title, agentOf('task-1', claudeRun.runId).state], [50, 'Reviewer', 'idle']);
  // The Codex run is still in its turn: listed under task-1 with no tokens yet.
  assert.deepEqual([agentOf('task-1', codexRun.runId).tokens.total, agentOf('task-1', codexRun.runId).title, agentOf('task-1', codexRun.runId).state], [0, 'Porter', 'running']);

  // The brain's result: modelUsage covers its main loop and the sub-agent.
  brainEnds('b-res-1', { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }, { [OPUS]: modelUse(100, 50, 1000, 0.4), [HAIKU]: modelUse(200, 20, 0, 0.1) }, 0.5);
  let brainAgent = agentOf('task-1', 'brain');
  assert.deepEqual([brainAgent.tokens.total, brainAgent.pending.total, brainAgent.subagents.total, brainAgent.fidelity], [1370, 0, 220, 'exact']);
  assert.equal(task('task-1').tokens.total, 1420, 'the brain and the Claude run');

  // A usage packet reads each run with peek: no memory lookup, however often the gauge asks.
  const lookups = memoryLookups;
  for (let i = 0; i < 5; i += 1) runtime.usageView(id, 'task-1');
  assert.equal(memoryLookups, lookups);

  // ── d. A second human prompt starts task-2; the brain sends the warm Claude run a follow-up. ──
  assert.deepEqual(await runtime.submit(id, { text: 'Now the docs' }), { ok: true });
  assert.deepEqual([runtime.currentTask(id), brain.prompts.length], ['task-2', 2], 'the Claude run\'s result was read with agent_wait: no mailbox turn for it');
  const sent = await call('POST', `/runs/${claudeRun.runId}/send`, { text: 'Check the docs too' }, asBrain);
  assert.equal(sent.status, 200);
  await waitFor(() => dispatcher.get(claudeRun.runId).state === 'running');
  // The run shows under task-2 before its first tokens for it land, and keeps its place under task-1.
  assert.deepEqual([agentOf('task-2', claudeRun.runId)?.state, agentOf('task-2', claudeRun.runId)?.tokens.total], ['running', 0]);
  assert.equal(agentOf('task-1', claudeRun.runId).tokens.total, 50);
  claudeGate.open();
  const waitedAgain = await call('POST', '/wait', { runId: claudeRun.runId, until: 'idle', timeoutMs: 4000 }, asBrain);
  assert.equal(waitedAgain.json.timedOut, false);
  let view = dispatcher.get(claudeRun.runId);
  assert.deepEqual([view.taskId, view.turns.map((turn) => turn.taskId), view.turns.map((turn) => turn.tokens.total)], ['task-1', ['task-1', 'task-2'], [50, 45]]);
  assert.deepEqual([agentOf('task-2', claudeRun.runId).tokens.total, agentOf('task-1', claudeRun.runId).tokens.total], [45, 50], 'the delta of the follow-up turn, in the task it was sent for');
  brainEnds('b-res-2', { input_tokens: 50, cache_read_input_tokens: 500, output_tokens: 30 }, { [OPUS]: modelUse(150, 80, 1500, 0.6), [HAIKU]: modelUse(200, 20, 0, 0.1) }, 0.7);
  assert.equal(agentOf('task-2', 'brain').tokens.total, 580, 'the delta of the cumulative modelUsage');
  assert.equal(task('task-2').tokens.total, 625);

  // ── c. The Codex run's result comes back while task-2 is the current task: a mailbox turn for task-1. ──
  codexGate.open();
  await waitFor(() => brain.prompts.length === 3);
  assert.match(brain.prompts[2], /SynaBun Mailbox/);
  assert.deepEqual([runtime.currentTask(id), runtime.usageView(id).task.id], ['task-1', 'task-2'], 'the mailbox turn works for its run\'s task; the current task stays the latest human one');
  view = dispatcher.get(codexRun.runId);
  assert.deepEqual([view.taskId, view.turns[0].taskId, view.turns[0].tokens.total, usd(view.costUsd)], ['task-1', 'task-1', 273_500, 0.323]);
  assert.deepEqual([agentOf('task-1', codexRun.runId).tokens.total, agentOf('task-2', codexRun.runId)], [273_500, null], 'two responses and the compaction call, all in task-1');
  brainEnds('b-res-3', { input_tokens: 20, cache_read_input_tokens: 200, output_tokens: 10 }, { [OPUS]: modelUse(170, 90, 1700, 0.7), [HAIKU]: modelUse(200, 20, 0, 0.1) }, 0.8);
  assert.equal(agentOf('task-1', 'brain').tokens.total, 1600, 'the mailbox turn\'s 230 brain tokens go to task-1');
  assert.equal(agentOf('task-2', 'brain').tokens.total, 580);
  assert.deepEqual([runtime.currentTask(id), runtime.usageView(id).task.id], ['task-2', 'task-2']);

  // ── e. The end: the runs complete, and everything adds up. ──
  for (const run of [codexRun, claudeRun]) assert.equal((await call('POST', `/runs/${run.runId}/complete`, {}, asBrain)).status, 200);
  await waitFor(() => dispatcher.get(codexRun.runId).terminal && dispatcher.get(claudeRun.runId).terminal);
  await wait(350); // the last usage packet (they are throttled)
  assert.equal(brain.prompts.length, 3, 'no further brain turn');

  const first = task('task-1');
  const second = task('task-2');
  assert.deepEqual([first.tokens.total, second.tokens.total], [275_150, 625]);
  for (const one of [first, second]) {
    assert.equal(one.tokens.total, one.agents.reduce((total, agent) => total + agent.tokens.total, 0), `${one.id}: the total is the sum of its agents`);
    assert.deepEqual([one.pending.total, one.fidelity, one.live], [0, 'exact', false], `${one.id}: nothing provisional, nothing partial`);
  }
  assert.deepEqual(first.agents.map((agent) => [agent.key, agent.tokens.total, agent.state]), [['brain', 1600, 'idle'], [claudeRun.runId, 50, 'done'], [codexRun.runId, 273_500, 'done']]);
  assert.deepEqual(second.agents.map((agent) => [agent.key, agent.tokens.total, agent.state]), [['brain', 580, 'idle'], [claudeRun.runId, 45, 'done']]);
  assert.deepEqual([usd(first.costUsd), usd(second.costUsd)], [0.973, 0.23], 'task-1: brain $0.60, Codex $0.323, Claude run $0.05; task-2: brain $0.20, Claude run $0.03');
  const whole = ledger.sessionView(id);
  assert.equal(whole.tokens.total, first.tokens.total + second.tokens.total, 'the tasks add up to the session');
  assert.deepEqual([whole.tokens.total, whole.unsynced, usd(whole.costUsd)], [275_775, 0, 1.203]);
  // The runs' own views agree with the ledger.
  assert.deepEqual([dispatcher.get(codexRun.runId).tokens.total, dispatcher.get(claudeRun.runId).tokens.total], [273_500, 95]);
  assert.equal(dispatcher.totals({ assistantSessionId: id }).tokens.total, 273_595);

  // The packet the runtime sent last is what the API answers now.
  const current = await call('GET', `/sessions/${id}/usage?task=current`);
  assert.equal(current.status, 200);
  const { type: _type, ...lastPacket } = ws.packets('assistant:usage').at(-1);
  assert.deepEqual(lastPacket, current.json.usage);
  assert.deepEqual([current.json.usage.task.id, current.json.usage.session.tokens.total], ['task-2', 275_775]);
  const all = await call('GET', `/sessions/${id}/usage?task=all`);
  assert.deepEqual(all.json.session.tasks.map((row) => [row.id, row.total, row.fidelity, row.live]), [['task-1', 275_150, 'exact', false], ['task-2', 625, 'exact', false]]);
  assert.equal((await call('GET', `/sessions/${id}/usage?task=task-1`)).json.usage.task.tokens.total, 275_150);

  // What is on disk is what was shown: a fresh ledger on the same directory reports the same.
  const reloaded = createUsageLedger({ dataDir: root });
  assert.deepEqual(reloaded.sessionView(id), ledger.sessionView(id));
  for (const taskId of ['task-1', 'task-2']) {
    const [fresh, shown] = [reloaded.taskView(id, taskId).task, ledger.taskView(id, taskId).task];
    assert.deepEqual([fresh.tokens, fresh.costUsd, fresh.fidelity, fresh.agents.map((agent) => [agent.key, agent.tokens.total])], [shown.tokens, shown.costUsd, shown.fidelity, shown.agents.map((agent) => [agent.key, agent.tokens.total])]);
  }
});

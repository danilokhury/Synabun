import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import { createAssistantDispatcher, DispatchError, summarizeProviderEvent } from '../lib/assistant-dispatch.js';
import { createClaudeNativeLoopAdapter } from '../lib/native-loop-providers.js';

// Timers on the paths these tests wait for are unref'd on purpose, so a pending
// call never holds the server open. With nothing else on the loop Node 22
// drains it before they fire, and the remaining tests of the file are cancelled
// with "Promise resolution is still pending but the event loop has already
// resolved". Hold the loop open for the length of the file.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const RESULT_TEXT = '## Result\nstatus: done\nsummary: did the thing\nchanges:\n- src/a.js — edited\nfollow_ups:\n- none';

const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error('Timed out waiting for condition');
};

function makeHarness(t, { adapterBehavior = {}, limits = {}, readLimits = null, brainSpend = () => 0, pricing = null, memory = null, judge = null, router = null, providerFactories = {}, extra = {} } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const factoryCalls = [];
  const broadcasts = [];
  const gates = new Map(); // runId → resolve fn holding a turn open
  const makeAdapter = (state) => {
    factoryCalls.push(state);
    let turns = 0;
    return {
      identity: () => ({ providerSessionId: `sess-${state.runId.slice(0, 4)}` }),
      isAlive: () => true,
      async runTurn(prompt, meta) {
        turns += 1;
        state.onEvent({ provider: state.profile, runId: state.runId, event: { type: 'synabun.user_prompt', text: prompt } });
        if (adapterBehavior.hold) {
          await new Promise((release) => gates.set(state.runId, release));
        }
        if (adapterBehavior.askOnTurn && turns === 1 && state.permissionBroker) {
          const reply = await state.permissionBroker.request({ runId: state.runId, provider: state.profile, kind: 'tool', toolName: 'Bash', input: { command: 'rm -rf build' } });
          if (reply.behavior !== 'allow') return { text: '## Result\nstatus: blocked\nsummary: denied', costUsd: 0 };
        }
        // Provider events of this turn (e.g. Codex item.completed), emitted before the turn resolves.
        for (const event of (typeof adapterBehavior.events === 'function' ? adapterBehavior.events(turns, prompt) : []) || []) {
          state.onEvent({ provider: state.profile, runId: state.runId, event });
        }
        if (adapterBehavior.failOnTurn === turns) throw new Error('provider exploded');
        if (adapterBehavior.noBlock && turns === 1) return { text: 'no block here', costUsd: 0.01 };
        const text = typeof adapterBehavior.text === 'function' ? adapterBehavior.text(turns, prompt) : (adapterBehavior.text || RESULT_TEXT);
        return { text, costUsd: 0.01, usage: { input_tokens: 5, output_tokens: 2 } };
      },
      async abort() { gates.get(state.runId)?.(); },
      async dispose() {},
    };
  };
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'),
    ledgerPath: resolve(root, 'runs.json'),
    buildPrompt: () => 'LOOP PROMPT (must not be used for tasks)',
    iterationDelayMs: 0,
    providerFactories: { codex: async (state) => makeAdapter(state), 'claude-code': async (state) => makeAdapter(state), opencode: async (state) => makeAdapter(state), ...providerFactories },
  });
  const dispatcher = createAssistantDispatcher({
    getRuntime: () => runtime,
    dataDir: root,
    loopDir: resolve(root, 'loop'),
    broadcastSync: (message) => broadcasts.push(message),
    PACKAGE_ROOT: root,
    findCodexAccount: (id) => (id === 'work' ? { id: 'work', home: '/tmp/codex-work' } : null),
    getCodexAccount: () => ({ id: 'default', home: '/tmp/codex-default' }),
    CODEX_DEFAULT_HOME: '/tmp/codex-default',
    claudeAccounts: { find: (id) => (id === 'acct-1' ? { id: 'acct-1' } : null), homeFor: () => '/tmp/claude-acct-1' },
    detectProject: () => 'proj',
    memory,
    limits: { minIdleTimeoutMs: 50, ...limits },
    readLimits, brainSpend, pricing,
    judge, router,
    ...extra,
  });
  t.after(() => dispatcher.shutdown('test'));
  return { root, runtime, dispatcher, factoryCalls, broadcasts, gates };
}

test('dispatch runs one task turn, stays warm for a follow-up, completes on request, and remembers once', async (t) => {
  const remembered = [];
  const { root, dispatcher, factoryCalls, broadcasts } = makeHarness(t, {
    memory: { rememberDispatch: async (view) => { remembered.push(view); return 'mem-1'; } },
  });
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'Write docs', cwd: root, model: 'gpt-5.4-mini', tags: ['docs'], idempotency_key: 'k1' }, { assistantSessionId: 'assistant-1' });
  assert.equal(launched.queued, false);
  const runId = launched.run.runId;
  assert.equal(launched.run.state, 'starting');
  assert.equal(launched.run.provider, 'codex');
  assert.equal(launched.run.accountId, 'default');
  await waitFor(() => dispatcher.get(runId).state === 'idle');
  const idle = dispatcher.get(runId);
  assert.equal(idle.outcome, 'done');
  assert.equal(idle.lastResult.summary, 'did the thing');
  assert.deepEqual(idle.lastResult.files, ['src/a.js']);
  assert.equal(idle.turnCount, 1);
  assert.equal(idle.costUsd, 0.01);
  assert.equal(factoryCalls[0].runMode, 'task');
  assert.equal(factoryCalls[0].assistantSessionId, 'assistant-1');
  assert.match(factoryCalls[0].task, /Write docs/);
  const stateFile = JSON.parse(readFileSync(resolve(root, 'loop', `${runId}.json`), 'utf8'));
  assert.equal(stateFile.runMode, 'task');
  assert.equal(stateFile.permissionBroker, undefined, 'functions never reach the state file');
  const replay = await dispatcher.dispatch({ provider: 'codex', task: 'Write docs', cwd: root, idempotency_key: 'k1' }, { assistantSessionId: 'assistant-1' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.runId, runId);
  const sent = dispatcher.sendTurn(runId, 'Now add a table of contents');
  assert.equal(sent.queued, false);
  assert.equal(sent.turn, 2);
  await waitFor(() => dispatcher.get(runId).turnCount === 2 && dispatcher.get(runId).state === 'idle');
  const turns = dispatcher.get(runId).turns;
  assert.match(turns[1].promptPreview, /FOLLOW-UP from the assistant 2\/6/);
  dispatcher.complete(runId);
  await waitFor(() => dispatcher.get(runId).state === 'completed');
  const finished = dispatcher.get(runId);
  assert.equal(finished.completionReason, 'complete');
  await waitFor(() => finished.memoryId === 'mem-1' || dispatcher.get(runId).memoryId === 'mem-1');
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].runId, runId);
  assert.ok(broadcasts.some((m) => m.type === 'assistant:dispatch' && m.reason === 'completed'));
  const tail = dispatcher.transcript(runId, { format: 'tail' });
  assert.ok(tail.tail.some((line) => /user: DISPATCHED TASK/.test(line)));
  const registry = JSON.parse(readFileSync(resolve(root, 'assistant-dispatches.json'), 'utf8'));
  assert.equal(registry[0].runId, runId);
  assert.equal(registry[0].state, 'completed');
});

test('removed runs disappear from lists but retain spend and survive registry reload', async (t) => {
  // The cap is lowered after the run (a live Budget-tab change): the next dispatch is refused.
  const liveLimits = { sessionHardBudgetUsd: 1 };
  const { root, runtime, dispatcher, broadcasts } = makeHarness(t, { readLimits: () => liveLimits });
  const { run } = await dispatcher.dispatch({ provider: 'codex', task: 'small task', cwd: root }, { assistantSessionId: 'session-a' });
  await assert.rejects(dispatcher.remove(run.runId), (error) => error.code === 'RUN_ACTIVE' && error.status === 409);
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  dispatcher.complete(run.runId);
  await waitFor(() => dispatcher.get(run.runId).state === 'completed');
  assert.deepEqual(dispatcher.list({ assistantSessionId: 'session-a', status: 'terminal' }).map((entry) => entry.runId), [run.runId]);
  await assert.rejects(dispatcher.remove(run.runId, { assistantSessionId: 'session-b' }), (error) => error.code === 'RUN_NOT_IN_SESSION' && error.status === 403);
  assert.deepEqual((await dispatcher.remove(run.runId, { assistantSessionId: 'session-a' })).removed, [run.runId]);
  assert.deepEqual(dispatcher.list({ assistantSessionId: 'session-a' }), []);
  assert.deepEqual(dispatcher.list({ assistantSessionId: 'session-a', status: 'terminal' }), []);
  assert.equal(dispatcher.list({ assistantSessionId: 'session-a', includeRemoved: true })[0].runId, run.runId);
  assert.equal(dispatcher.totals({ assistantSessionId: 'session-a' }).costUsd, 0.01);
  // Its tokens stay in the totals like its dollars (they fell to 0 while the cost stayed); only the status counts leave.
  const spent = withTotal({ input: 5, cacheWrite: 0, cacheRead: 0, output: 2, reasoning: 0 });
  assert.deepEqual(dispatcher.totals({ assistantSessionId: 'session-a' }).tokens, spent);
  assert.equal(dispatcher.totals({ assistantSessionId: 'session-a' }).completed, 0);
  assert.deepEqual((await dispatcher.remove(run.runId)).removed, [], 'a repeated remove is idempotent');
  assert.equal(broadcasts.filter((message) => message.type === 'assistant:run-removed').length, 1);
  liveLimits.sessionHardBudgetUsd = 0.01;
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'next task', cwd: root }, { assistantSessionId: 'session-a' }), (error) => error.code === 'BUDGET_EXCEEDED');

  await dispatcher.shutdown('test-restart');
  const restored = createAssistantDispatcher({ getRuntime: () => runtime, dataDir: root, PACKAGE_ROOT: root });
  t.after(() => restored.shutdown('test'));
  assert.ok(restored.get(run.runId).removedAt);
  assert.deepEqual(restored.list({ assistantSessionId: 'session-a' }), []);
  assert.equal(restored.totals({ assistantSessionId: 'session-a' }).costUsd, 0.01);
  assert.deepEqual(restored.totals({ assistantSessionId: 'session-a' }).tokens, spent);
});

test('clear finished skips unfinished runs and emits one removal event per session', async (t) => {
  const { root, dispatcher, broadcasts } = makeHarness(t);
  const a = await dispatcher.dispatch({ provider: 'codex', task: 'a', cwd: root }, { assistantSessionId: 'session-a' });
  const b = await dispatcher.dispatch({ provider: 'opencode', task: 'b', cwd: root }, { assistantSessionId: 'session-a' });
  const c = await dispatcher.dispatch({ provider: 'claude-code', task: 'c', cwd: root, accountId: 'acct-1' }, { assistantSessionId: 'session-b' });
  await waitFor(() => [a, b, c].every(({ run }) => dispatcher.get(run.runId).state === 'idle'));
  dispatcher._internals.entries.get(b.run.runId).judging = true;
  const scoped = await dispatcher.removeFinished({ assistantSessionId: 'session-a' });
  assert.deepEqual(scoped.removed, [a.run.runId]);
  assert.deepEqual(scoped.skipped, [b.run.runId]);
  assert.equal(dispatcher.get(a.run.runId).state, 'completed', 'clearing a warm finished task closes it first');
  assert.ok(!dispatcher.get(c.run.runId).removedAt);
  await assert.rejects(dispatcher.remove(b.run.runId), (error) => error.code === 'RUN_ACTIVE');
  delete dispatcher._internals.entries.get(b.run.runId).judging;
  const rest = await dispatcher.removeFinished({ runIds: [b.run.runId, c.run.runId] });
  assert.deepEqual(new Set(rest.removed), new Set([b.run.runId, c.run.runId]));
  const events = broadcasts.filter((message) => message.type === 'assistant:run-removed');
  assert.equal(events.length, 3, 'first scope and then one event for each remaining session');
  assert.deepEqual(events.map((event) => event.assistantSessionId), ['session-a', 'session-a', 'session-b']);
  assert.deepEqual((await dispatcher.removeFinished({ assistantSessionId: 'session-a' })).removed, []);
});

test('a finished idle task is removable in one action', async (t) => {
  const { root, dispatcher } = makeHarness(t);
  const { run } = await dispatcher.dispatch({ provider: 'codex', task: 'finished task', cwd: root }, { assistantSessionId: 'session-a' });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  assert.equal(dispatcher.get(run.runId).outcome, 'done');
  dispatcher._internals.entries.get(run.runId).lastResult.status = 'needs_input';
  await assert.rejects(dispatcher.remove(run.runId), (error) => error.code === 'RUN_ACTIVE', 'a worker awaiting an answer stays available');
  dispatcher._internals.entries.get(run.runId).lastResult.status = 'done';
  assert.deepEqual((await dispatcher.remove(run.runId, { assistantSessionId: 'session-a' })).removed, [run.runId]);
  assert.equal(dispatcher.get(run.runId).state, 'completed');
  assert.ok(dispatcher.get(run.runId).removedAt);
});

test('idle timeout ends a warm run and follow-ups after that are rejected', async (t) => {
  const { root, dispatcher } = makeHarness(t);
  const launched = await dispatcher.dispatch({ provider: 'opencode', task: 'quick', cwd: root, idleTimeoutMs: 50 });
  const runId = launched.run.runId;
  await waitFor(() => dispatcher.get(runId).state === 'completed', 5000);
  assert.equal(dispatcher.get(runId).completionReason, 'idle_timeout');
  assert.throws(() => dispatcher.sendTurn(runId, 'more'), (error) => error instanceof DispatchError && error.code === 'RUN_NOT_ACTIVE');
});

test('missing result block triggers one retry turn and parse still succeeds', async (t) => {
  const { root, dispatcher } = makeHarness(t, { adapterBehavior: { noBlock: true } });
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'x', cwd: root });
  await waitFor(() => dispatcher.get(launched.run.runId).state === 'idle');
  const run = dispatcher.get(launched.run.runId);
  assert.equal(run.outcome, 'done');
  assert.equal(run.turnCount, 1, 'the retry belongs to the same logical turn');
  assert.match(run.lastText, /no block here[\s\S]*## Result/);
});

test('validation rejects bad specs with typed errors', async (t) => {
  const { root, dispatcher } = makeHarness(t);
  await assert.rejects(dispatcher.dispatch({ provider: 'gemini', task: 'x', cwd: root }), (e) => e.code === 'INVALID_PROVIDER');
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: '', cwd: root }), (e) => e.code === 'TASK_REQUIRED');
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'x', cwd: '/definitely/not/here' }), (e) => e.code === 'CWD_INVALID');
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'x', cwd: root, permissionPolicy: 'ask' }), (e) => e.code === 'PERMISSION_POLICY_UNSUPPORTED' && e.suggested === 'restricted');
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'x', cwd: root, accountId: 'ghost' }), (e) => e.code === 'ACCOUNT_NOT_FOUND');
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'x', cwd: root, accountId: 'ghost' }), (e) => e.code === 'ACCOUNT_NOT_FOUND');
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'x', cwd: root, usesBrowser: true, capability: 'full' }), (e) => e.code === 'QUARANTINE_VIOLATION');
  const ok = await dispatcher.dispatch({ provider: 'claude-code', task: 'x', cwd: root, usesBrowser: true, capability: 'full', tags: ['user-authorized-full'], accountId: 'acct-1' });
  assert.equal(ok.run.claudeAccountId, 'acct-1');
  assert.equal(ok.run.claudeConfigDir, '/tmp/claude-acct-1');
  await waitFor(() => dispatcher.get(ok.run.runId).state === 'idle');
});

test('concurrency rails queue extra dispatches and start them when a slot frees', async (t) => {
  const { root, dispatcher, gates } = makeHarness(t, { adapterBehavior: { hold: true }, limits: { perProvider: { codex: 1 } } });
  const first = await dispatcher.dispatch({ provider: 'codex', task: 'first', cwd: root });
  await waitFor(() => gates.size === 1);
  const second = await dispatcher.dispatch({ provider: 'codex', task: 'second', cwd: root });
  assert.equal(second.queued, true);
  assert.equal(second.position, 1);
  assert.equal(dispatcher.totals().queued, 1);
  await assert.rejects(dispatcher.dispatch({ provider: 'codex', task: 'third', cwd: root, queueIfBusy: false }), (e) => e.code === 'MAX_CONCURRENT' && e.status === 409);
  await dispatcher.stop(first.run.runId, 'test');
  await waitFor(() => dispatcher.get(first.run.runId).state === 'stopped');
  await waitFor(() => dispatcher.get(second.run.runId).state !== 'queued', 5000);
  assert.ok(['starting', 'running', 'idle'].includes(dispatcher.get(second.run.runId).state));
  const released = gates.get(second.run.runId) || (await waitFor(() => gates.get(second.run.runId)));
  released();
  await waitFor(() => dispatcher.get(second.run.runId).state === 'idle');
  await dispatcher.killAll({});
  await waitFor(() => dispatcher.get(second.run.runId).state === 'stopped');
});

test('ask policy relays a permission request and the first answer wins', async (t) => {
  const { root, dispatcher, broadcasts } = makeHarness(t, { adapterBehavior: { askOnTurn: true } });
  const launched = await dispatcher.dispatch({ provider: 'claude-code', task: 'delete build', cwd: root, permissionPolicy: 'ask' });
  const runId = launched.run.runId;
  await waitFor(() => dispatcher.get(runId).state === 'awaiting_permission');
  const pending = dispatcher.pendingPermissions(runId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolName, 'Bash');
  assert.ok(broadcasts.some((m) => m.type === 'assistant:permission-request' && m.runId === runId));
  const waited = await dispatcher.wait({ runId, until: 'event', timeoutMs: 1000 });
  assert.equal(waited.permissions.length, 1);
  dispatcher.respondPermission(runId, pending[0].requestId, { behavior: 'allow' }, { origin: 'assistant' });
  assert.throws(() => dispatcher.respondPermission(runId, pending[0].requestId, { behavior: 'deny' }), (e) => e.code === 'PERMISSION_ALREADY_RESOLVED');
  await waitFor(() => dispatcher.get(runId).state === 'idle');
  assert.equal(dispatcher.get(runId).outcome, 'done');
  dispatcher.complete(runId);
  await waitFor(() => dispatcher.get(runId).state === 'completed');
});

test('provider errors after the task turn fail the run without re-sending the task', async (t) => {
  const { root, dispatcher, factoryCalls } = makeHarness(t, { adapterBehavior: { failOnTurn: 1 } });
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'boom', cwd: root });
  await waitFor(() => dispatcher.get(launched.run.runId).state === 'failed', 5000);
  assert.equal(factoryCalls.length, 1, 'runtime did not retry the whole task');
  assert.match(dispatcher.get(launched.run.runId).notes.join(' '), /provider exploded/);
});

test('wait resolves on idle for all runs of a workflow and reports timeouts', async (t) => {
  const { root, dispatcher, gates } = makeHarness(t, { adapterBehavior: { hold: true } });
  const a = await dispatcher.dispatch({ provider: 'codex', task: 'a', cwd: root, workflowId: 'wf-1' }, { assistantSessionId: 's' });
  const b = await dispatcher.dispatch({ provider: 'opencode', task: 'b', cwd: root, workflowId: 'wf-1' }, { assistantSessionId: 's' });
  await waitFor(() => gates.size === 2);
  const early = await dispatcher.wait({ workflowId: 'wf-1', until: 'idle', timeoutMs: 1000 });
  assert.equal(early.timedOut, true);
  assert.equal(early.pending.length, 2);
  gates.get(a.run.runId)();
  const any = await dispatcher.wait({ workflowId: 'wf-1', until: 'idle', mode: 'any', timeoutMs: 3000 });
  assert.equal(any.timedOut, false);
  assert.ok(any.done.some((run) => run.runId === a.run.runId));
  gates.get(b.run.runId)();
  const all = await dispatcher.wait({ runIds: [a.run.runId, b.run.runId], until: 'idle', timeoutMs: 3000 });
  assert.equal(all.timedOut, false);
  assert.equal(all.done.length, 2);
  await dispatcher.killAll({ assistantSessionId: 's' });
});

test('a restarted dispatcher marks previously active dispatches interrupted', async (t) => {
  const { root, dispatcher, runtime, gates } = makeHarness(t, { adapterBehavior: { hold: true } });
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'long', cwd: root });
  await waitFor(() => gates.size === 1);
  await dispatcher.shutdown('test-restart');
  assert.ok(existsSync(resolve(root, 'assistant-dispatches.json')));
  const again = createAssistantDispatcher({ getRuntime: () => runtime, dataDir: root, PACKAGE_ROOT: root });
  t.after(() => again.shutdown('test'));
  const restored = again.get(launched.run.runId);
  assert.equal(restored.state, 'interrupted');
  assert.equal(restored.completionReason, 'test-restart');
  gates.get(launched.run.runId)?.();
});

test('summarizeProviderEvent produces compact transcript lines per provider', () => {
  assert.equal(summarizeProviderEvent({ provider: 'claude-code', event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } } }), 'tool: Bash({"command":"ls"})');
  assert.equal(summarizeProviderEvent({ provider: 'codex', event: { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } } }), 'command done: npm test (exit 0)');
  assert.equal(summarizeProviderEvent({ provider: 'opencode', eventType: 'session.idle', event: {} }), 'turn completed');
  assert.equal(summarizeProviderEvent({ provider: 'claude-code', event: { type: 'stream_event' } }), null);
});

test('markDelivered keeps a per-run high-water mark, refuses another session and never bumps the version', async (t) => {
  const { root, dispatcher } = makeHarness(t);
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'x', cwd: root }, { assistantSessionId: 'assistant-1' });
  const runId = launched.run.runId;
  await waitFor(() => dispatcher.get(runId).state === 'idle');
  const idle = dispatcher.get(runId);
  assert.equal(idle.resultTurn, 1, 'the view names the turn its result belongs to');
  assert.equal(dispatcher.deliveryState(runId), null);
  const version = dispatcher._internals.entries.get(runId).version;
  assert.equal(dispatcher.markDelivered(runId, { turn: 1, state: 'idle', via: 'agent_wait', assistantSessionId: 'assistant-1' }), true);
  assert.equal(dispatcher._internals.entries.get(runId).version, version, 'no version bump: until:"event" waits stay asleep');
  assert.deepEqual({ ...dispatcher.deliveryState(runId), at: undefined }, { turn: 1, state: 'idle', via: 'agent_wait', at: undefined });
  // High-water mark: an older read never lowers it.
  dispatcher.markDelivered(runId, { turn: 0, state: 'idle', via: 'agent_status' });
  assert.equal(dispatcher.deliveryState(runId).turn, 1);
  // Another brain's read of this run is not this brain's delivery.
  assert.equal(dispatcher.markDelivered(runId, { turn: 5, assistantSessionId: 'assistant-2' }), false);
  assert.equal(dispatcher.deliveryState(runId).turn, 1);
  assert.equal(dispatcher.markDelivered('nope', { turn: 1 }), false);
  assert.equal(dispatcher.get(runId).delivered.turn, 1, 'the mark rides on the run view');
  // A terminal state read while the failure cause is being judged is not recorded.
  dispatcher._internals.entries.get(runId).judging = true;
  dispatcher.markDelivered(runId, { turn: 1, state: 'failed' });
  assert.equal(dispatcher.deliveryState(runId).state, 'idle');
  delete dispatcher._internals.entries.get(runId).judging;
  await waitFor(() => { try { return JSON.parse(readFileSync(resolve(root, 'assistant-dispatches.json'), 'utf8')).find((r) => r.runId === runId)?.delivered?.turn === 1; } catch { return false; } });
});

// ── Jev: worker outcome, cause-aware escalation, the claim check ──
import { escalationFor } from '../lib/assistant-router.js';

/** The assistant-jev.js wrapper's shape; `respond(input, ask)` gives the verdict. */
function fakeJudge(respond) {
  const calls = [];
  const notes = [];
  return {
    calls, notes,
    async workerOutcome(input, ask, ctx) {
      calls.push({ input, ask, ctx });
      const verdict = respond(input, ask) || {};
      return { asked: ask, logId: 900 + calls.length, status: null, statusConfidence: null, cause: null, causeConfidence: null, claimProbability: null, claimFlagged: false, ...verdict };
    },
    annotate: (logId, outcome) => notes.push({ logId, outcome }),
  };
}
const ladderRouter = {
  resolveDispatch: async () => null, // routing itself is not under test here
  escalationFor: ({ run, depth }) => escalationFor({ run, catalog: null, routing: { ladders: { codex: ['gpt-5.4-mini', 'gpt-5.5'] } }, depth }),
};
const npmTest = (exitCode) => ({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: exitCode ? '2 failing' : '# pass 9', exit_code: exitCode, status: exitCode ? 'failed' : 'completed' } });
const editedFile = { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/auth.ts', kind: 'update' }], status: 'completed' } };

test('a status Jev reads from a message without ## Result skips the retry turn', async (t) => {
  let turnCalls = 0;
  const judge = fakeJudge(() => ({ status: 'done', statusConfidence: 0.9, claimProbability: 0.3 }));
  const { root, dispatcher } = makeHarness(t, { judge, adapterBehavior: { text: 'I changed the redirect in auth.ts and the suite is green.', events: () => { turnCalls += 1; return [editedFile, npmTest(0)]; } } });
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'Fix the login redirect', cwd: root }, { assistantSessionId: 'assistant-1' });
  await waitFor(() => dispatcher.get(launched.run.runId).state === 'idle');
  const run = dispatcher.get(launched.run.runId);
  assert.equal(turnCalls, 1, 'no result-retry turn');
  assert.equal(run.lastResult.source, 'jev');
  assert.equal(run.lastResult.found, false);
  assert.equal(run.lastResult.parseFailed, true);
  assert.equal(run.lastResult.status, 'done');
  assert.deepEqual(run.lastResult.judged, { status: 'done', confidence: 0.9 });
  assert.deepEqual(run.lastResult.files, ['src/auth.ts']);
  assert.equal(run.escalation, null, 'a judged status is a usable result');
  assert.equal(run.lastResult.unverifiedClaim, undefined, 'P 0.3 is under the bar');
  const [call] = judge.calls;
  assert.deepEqual(call.ask, { status: true, cause: true, claim: true });
  assert.equal(call.input.task, 'Fix the login redirect');
  assert.equal(call.input.declared, null);
  assert.deepEqual(call.input.commands, [{ command: 'npm test', exit: 'ok', output_tail: '# pass 9' }]);
  assert.deepEqual(call.ctx, { runId: run.runId, assistantSessionId: 'assistant-1', project: 'proj' });
  assert.deepEqual(judge.notes[0].outcome, { run: run.runId, turn: 1, source: 'jev', retried: false, status: 'done', cause: null, claim: false, escalation: null, judged: null, applied: { status: true, cause: false } });
  // needs_input: the question is the message's last paragraph.
  const asking = fakeJudge(() => ({ status: 'needs_input', statusConfidence: 0.8 }));
  const second = makeHarness(t, { judge: asking, adapterBehavior: { text: 'I looked at both options.\n\nShould I keep the old column order or sort by date?' } });
  const q = await second.dispatcher.dispatch({ provider: 'codex', task: 'x', cwd: second.root });
  await waitFor(() => second.dispatcher.get(q.run.runId).state === 'idle');
  const needs = second.dispatcher.get(q.run.runId);
  assert.equal(needs.lastResult.status, 'needs_input');
  assert.equal(needs.lastResult.question, 'Should I keep the old column order or sort by date?');
  assert.ok(second.broadcasts.some((m) => m.reason === 'needs_input' && m.question === 'Should I keep the old column order or sort by date?'));
});

test('an unclear or missing judgment still runs today\'s retry turn (source retry)', async (t) => {
  for (const verdict of [{ status: null }, null]) {
    let turnCalls = 0;
    const judge = fakeJudge(() => verdict);
    const { root, dispatcher } = makeHarness(t, { judge, adapterBehavior: { noBlock: true, events: () => { turnCalls += 1; return []; } } });
    const launched = await dispatcher.dispatch({ provider: 'codex', task: 'x', cwd: root });
    await waitFor(() => dispatcher.get(launched.run.runId).state === 'idle');
    const run = dispatcher.get(launched.run.runId);
    assert.equal(turnCalls, 2, 'the retry turn ran');
    assert.equal(run.lastResult.source, 'retry');
    assert.equal(run.lastResult.found, true);
    assert.deepEqual(judge.calls[0].ask, { status: true, cause: true, claim: false }, 'no evidence: the claim is not asked');
    assert.equal(judge.notes[0].outcome.retried, true);
  }
  // output_schema runs never have their status read.
  const judge = fakeJudge(() => ({ status: 'done', statusConfidence: 0.99 }));
  const { root, dispatcher } = makeHarness(t, { judge, adapterBehavior: { noBlock: true } });
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'x', cwd: root, outputSchema: { type: 'object' } });
  await waitFor(() => dispatcher.get(launched.run.runId).state === 'idle');
  assert.equal(judge.calls[0].ask.status, false);
  assert.equal(dispatcher.get(launched.run.runId).lastResult.source, 'retry');
});

test('the cause shapes the escalation: access → none (with what is needed), transient → retry on the same model, capability → the ladder', async (t) => {
  const BLOCKED = '## Result\nstatus: blocked\nsummary: npm install fails: EACCES permission denied on /usr/local/lib\nchanges:\n- none\nfollow_ups:\n- none';
  const cases = [
    ['access', { kind: 'none', to: null }],
    ['transient', { kind: 'retry', model: 'gpt-5.4-mini' }],
    ['capability', { kind: 'escalate', model: 'gpt-5.5' }],
    [null, { kind: 'escalate', model: 'gpt-5.4-mini->gpt-5.5' }],
  ];
  for (const [cause, expected] of cases) {
    const judge = fakeJudge(() => (cause ? { cause, causeConfidence: 0.85 } : {}));
    const { root, dispatcher } = makeHarness(t, { judge, router: ladderRouter, adapterBehavior: { text: BLOCKED } });
    const launched = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-5.4-mini', task: 'install deps', cwd: root });
    await waitFor(() => dispatcher.get(launched.run.runId).state === 'idle');
    const run = dispatcher.get(launched.run.runId);
    assert.deepEqual(judge.calls[0].ask, { status: false, cause: true, claim: false });
    assert.deepEqual(judge.calls[0].input.declared, { status: 'blocked', summary: 'npm install fails: EACCES permission denied on /usr/local/lib', question: '' });
    assert.equal(run.escalation.kind, expected.kind, String(cause));
    if (cause) {
      assert.equal(run.lastResult.cause, cause);
      assert.equal(run.escalation.cause, cause);
    }
    if (expected.kind === 'none') {
      assert.equal(run.escalation.to, null);
      assert.match(run.escalation.needs, /EACCES permission denied/);
      await assert.rejects(dispatcher.escalate(run.runId), (e) => e.code === 'NO_ESCALATION', 'no button, no target');
    } else {
      assert.equal(run.escalation.to.model, expected.kind === 'retry' ? 'gpt-5.4-mini' : 'gpt-5.5');
    }
  }
});

test('a "done" whose own output does not show it carries the unverified claim; below the bar or without evidence it does not', async (t) => {
  const DONE = '## Result\nstatus: done\nsummary: fixed the redirect, all tests pass\nchanges:\n- src/auth.ts — redirect\nfollow_ups:\n- none';
  const flagged = fakeJudge(() => ({ claimProbability: 0.95, claimFlagged: true }));
  const one = makeHarness(t, { judge: flagged, adapterBehavior: { text: DONE, events: () => [npmTest(1)] } });
  const a = await one.dispatcher.dispatch({ provider: 'codex', task: 'fix', cwd: one.root });
  await waitFor(() => one.dispatcher.get(a.run.runId).state === 'idle');
  const run = one.dispatcher.get(a.run.runId);
  assert.deepEqual(flagged.calls[0].ask, { status: false, cause: false, claim: true });
  assert.deepEqual(run.lastResult.unverifiedClaim, { probability: 0.95, evidence: 'the last `npm test` exited with an error' });
  assert.equal(run.lastResult.source, 'contract');
  assert.equal(flagged.notes[0].outcome.claim, true);
  const supported = fakeJudge(() => ({ claimProbability: 0.8, claimFlagged: false }));
  const two = makeHarness(t, { judge: supported, adapterBehavior: { text: DONE, events: () => [npmTest(0)] } });
  const b = await two.dispatcher.dispatch({ provider: 'codex', task: 'fix', cwd: two.root });
  await waitFor(() => two.dispatcher.get(b.run.runId).state === 'idle');
  assert.equal(two.dispatcher.get(b.run.runId).lastResult.unverifiedClaim, undefined);
  const silent = fakeJudge(() => ({ claimProbability: 0.99, claimFlagged: true }));
  const three = makeHarness(t, { judge: silent, adapterBehavior: { text: DONE } });
  const c = await three.dispatcher.dispatch({ provider: 'codex', task: 'fix', cwd: three.root });
  await waitFor(() => three.dispatcher.get(c.run.runId).state === 'idle');
  assert.equal(silent.calls.length, 0, 'no command and no tool result: the claim is not asked');
  assert.equal(three.dispatcher.get(c.run.runId).lastResult.unverifiedClaim, undefined);
});

test('a failed run: the "failed" event waits for its cause and carries it, with the matching escalation', async (t) => {
  let release = null;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const judge = {
    ...fakeJudge(() => ({})),
    calls: [],
    async workerOutcome(input, ask, ctx) { this.calls.push({ input, ask, ctx }); await gate; return { asked: ask, logId: 77, status: null, cause: 'transient', causeConfidence: 0.9, claimProbability: null, claimFlagged: false }; },
  };
  const { root, dispatcher, broadcasts } = makeHarness(t, { judge, router: ladderRouter, adapterBehavior: { failOnTurn: 1, events: () => [npmTest(1)] } });
  const launched = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-5.4-mini', task: 'boom', cwd: root }, { assistantSessionId: 'assistant-1' });
  const runId = launched.run.runId;
  await waitFor(() => judge.calls.length === 1, 5000);
  assert.equal(dispatcher.get(runId).state, 'failed', 'the state moves on at once');
  assert.ok(!broadcasts.some((m) => m.reason === 'failed' && m.run.runId === runId), 'the event waits for the cause');
  assert.deepEqual(judge.calls[0].ask, { status: false, cause: true, claim: false });
  assert.equal(judge.calls[0].input.run.state, 'failed');
  assert.match(judge.calls[0].input.run.error, /provider exploded/);
  assert.deepEqual(judge.calls[0].input.commands, [{ command: 'npm test', exit: 'error', output_tail: '2 failing' }]);
  const waiting = dispatcher.wait({ runId, until: 'terminal', timeoutMs: 3000 });
  release();
  const waited = await waiting;
  assert.equal(waited.timedOut, false);
  const failed = broadcasts.find((m) => m.reason === 'failed' && m.run.runId === runId);
  assert.equal(failed.run.failure.cause, 'transient');
  assert.equal(failed.run.failure.source, 'jev');
  assert.equal(failed.run.escalation.kind, 'retry');
  assert.equal(failed.run.escalation.to.model, 'gpt-5.4-mini');
  assert.equal(failed.run.judging, undefined);
  assert.equal(waited.done[0].failure.cause, 'transient');
});

test('a failed run judged below minConfidence: the cause is logged and kept as judgedCause, never applied', async (t) => {
  // The wrapper applies nothing under 0.7 (cause null), but hands back the raw verdict.
  const judge = fakeJudge(() => ({ verdict: { cause: 'transient', causeConfidence: 0.612 } }));
  const { root, dispatcher, broadcasts } = makeHarness(t, { judge, router: ladderRouter, adapterBehavior: { failOnTurn: 1 } });
  const launched = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-5.4-mini', task: 'boom', cwd: root }, { assistantSessionId: 'assistant-1' });
  const runId = launched.run.runId;
  await waitFor(() => broadcasts.some((m) => m.reason === 'failed' && m.run.runId === runId), 5000);
  const failed = broadcasts.find((m) => m.reason === 'failed' && m.run.runId === runId);
  assert.deepEqual(failed.run.failure, { cause: null, confidence: null, needs: null, source: 'jev', judgedCause: 'transient', judgedConfidence: 0.61 });
  assert.equal(failed.run.escalation.kind, 'escalate', 'an unapplied cause leaves the old ladder');
  const note = judge.notes.find((n) => n.outcome.source === 'failure');
  assert.equal(note.outcome.cause, null);
  assert.deepEqual(note.outcome.judged, { cause: 'transient', causeConfidence: 0.61 });
  assert.deepEqual(note.outcome.applied, { cause: false });
});

// ── Cost accounting and run memory (2026-09-27 Agents dock stall) ──
/** A warm Claude CLI: each result reports the process's running total_cost_usd, as the real one does. */
function warmClaudeQuery(totals, { capAt = null } = {}) {
  return ({ prompt }) => {
    const generator = (async function* () {
      let n = 0;
      for await (const _message of prompt) {
        const total = totals[n];
        n += 1;
        if (n === 1) yield { type: 'system', subtype: 'init', session_id: 'claude-warm' };
        if (capAt === n) yield { type: 'result', subtype: 'error_max_budget_usd', session_id: 'claude-warm', total_cost_usd: total, usage: { output_tokens: 3 }, errors: ['Reached maximum budget'] };
        else yield { type: 'result', subtype: 'success', session_id: 'claude-warm', result: RESULT_TEXT, total_cost_usd: total, usage: { output_tokens: 3 } };
      }
    })();
    generator.interrupt = async () => {};
    return generator;
  };
}
const realClaudeAdapter = (queryFactory) => ({
  'claude-code': (state) => createClaudeNativeLoopAdapter({ ...state, queryFactory, resolveRuntime: () => ({ ok: true, state: 'ok' }), includePartialMessages: false }),
});

test('a warm Claude run is charged per turn, not the CLI running total again (run 1ef8d3cd regression)', async (t) => {
  const { root, dispatcher } = makeHarness(t, {
    providerFactories: realClaudeAdapter(warmClaudeQuery([7.8659074, 7.9881174])),
    limits: { sessionHardBudgetUsd: 10 },
  });
  const launched = await dispatcher.dispatch({ provider: 'claude-code', task: 'Fix the Agents dock', cwd: root, budgetUsd: 8 }, { assistantSessionId: 'assistant-cost' });
  const runId = launched.run.runId;
  await waitFor(() => dispatcher.get(runId).state === 'idle');
  dispatcher.sendTurn(runId, 'Finish the verification');
  await waitFor(() => dispatcher.get(runId).turnCount === 2 && dispatcher.get(runId).state === 'idle');
  const run = dispatcher.get(runId);
  assert.deepEqual(run.turns.map((turn) => turn.costUsd), [7.8659074, 0.12221], 'turn 2 cost its own $0.12221');
  assert.equal(run.costUsd, 7.9881174, 'the provider total, not 7.8659074 + 7.9881174 = 15.8540248');
  assert.equal(dispatcher.totals({ assistantSessionId: 'assistant-cost' }).costUsd, 7.9881);
  // The session hard cap reads the real spend: $7.99 of $10 still dispatches (the double count read $15.85).
  const next = await dispatcher.dispatch({ provider: 'codex', task: 'Next step', cwd: root }, { assistantSessionId: 'assistant-cost' });
  assert.equal(next.ok, true);
});

test('a budget-capped Claude turn still counts toward the run and the session spend', async (t) => {
  const { root, dispatcher } = makeHarness(t, { providerFactories: realClaudeAdapter(warmClaudeQuery([5.0279], { capAt: 1 })) });
  const launched = await dispatcher.dispatch({ provider: 'claude-code', task: 'Polish the panel', cwd: root, budgetUsd: 5 }, { assistantSessionId: 'assistant-cap' });
  const runId = launched.run.runId;
  await waitFor(() => dispatcher.get(runId).terminal);
  const run = dispatcher.get(runId);
  assert.equal(run.completionReason, 'budget_cap');
  assert.equal(run.costUsd, 5.0279, 'the capped run read $0 before');
  assert.equal(dispatcher.totals({ assistantSessionId: 'assistant-cap' }).costUsd, 5.0279);
});

test('a memory stored for the run (source_ref = run id) marks it stored: no duplicate auto memory, agent_status sees later ones', async (t) => {
  const stored = new Map();
  const autoRemembered = [];
  let workerRemembers = true;
  const { root, dispatcher, broadcasts } = makeHarness(t, {
    memory: {
      memoryForRun: (runId) => stored.get(runId) || null,
      rememberDispatch: async (view) => { autoRemembered.push(view.runId); return 'mem-auto'; },
    },
    adapterBehavior: {
      // The worker calls remember (source_ref = its run id) before writing its ## Result block.
      text: (turn, prompt) => {
        const runId = /Run id: (\S+)/.exec(prompt)?.[1];
        if (workerRemembers && turn === 1 && runId) stored.set(runId, 'mem-worker');
        return RESULT_TEXT;
      },
    },
  });
  const launched = await dispatcher.dispatch({ provider: 'codex', task: 'Fix the Agents dock', cwd: root }, { assistantSessionId: 'assistant-mem' });
  const runId = launched.run.runId;
  await waitFor(() => dispatcher.get(runId).state === 'idle');
  const turnCompleted = broadcasts.filter((message) => message.reason === 'turn_completed' && message.run?.runId === runId).at(-1);
  assert.equal(turnCompleted.run.memoryStored, true, 'the event that raises the brain\'s memory obligation carries the worker memory');
  assert.equal(turnCompleted.run.memoryId, 'mem-worker');
  dispatcher.complete(runId);
  await waitFor(() => dispatcher.get(runId).state === 'completed');
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.deepEqual(autoRemembered, [], 'no second memory for a run the worker already stored');
  assert.equal(dispatcher.get(runId).memoryId, 'mem-worker');

  // A remember made after the run's last event (the brain's own) is what agent_status reports.
  workerRemembers = false;
  const second = await dispatcher.dispatch({ provider: 'codex', task: 'Write the docs', cwd: root }, { assistantSessionId: 'assistant-mem' });
  await waitFor(() => dispatcher.get(second.run.runId).state === 'idle');
  assert.equal(dispatcher.get(second.run.runId).memoryStored, false);
  stored.set(second.run.runId, 'mem-brain');
  const status = dispatcher.get(second.run.runId);
  assert.equal(status.memoryStored, true);
  assert.equal(status.memoryId, 'mem-brain');
});

test('peek gives the gauge a run\'s name and state from the registry, with no memory lookup', async (t) => {
  let lookups = 0;
  const { root, dispatcher } = makeHarness(t, { memory: { memoryForRun: () => { lookups += 1; return null; } }, extra: { currentTask: () => 'task-4' } });
  const { run } = await dispatcher.dispatch({ provider: 'codex', task: 'Fix it', cwd: root, model: 'gpt-5.4-mini', title: 'Fixer' }, { assistantSessionId: 'assistant-peek' });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  const before = lookups;
  assert.ok(before > 0, 'get() looks the run\'s memory up');
  for (let i = 0; i < 5; i += 1) dispatcher.peek(run.runId);
  assert.equal(lookups, before);
  assert.deepEqual(dispatcher.peek(run.runId), { runId: run.runId, title: 'Fixer', state: 'idle', turnState: 'idle', taskId: 'task-4', turnTaskId: 'task-4', provider: 'codex', model: 'gpt-5.4-mini' });
  assert.equal(dispatcher.peek('no-such-run'), null);
  dispatcher.complete(run.runId);
  await waitFor(() => dispatcher.get(run.runId).terminal);
  assert.deepEqual([dispatcher.peek(run.runId).state, dispatcher.peek(run.runId).turnTaskId], ['completed', null]);
});

// ── remote sessions (WhatsApp Link, lib/remote-policy.js) ─────────────────────
test('a remote session\'s dispatch follows its level: read-only refuses, ask clamps (strict approvals per provider), a registered cwd only', async (t) => {
  const policies = new Map();
  const { dispatcher, root } = makeHarness(t, { extra: { sessionPolicy: (id) => policies.get(id) || null, registeredProjects: () => [] } });
  const projects = [];
  const withProjects = makeHarness(t, { extra: { sessionPolicy: (id) => policies.get(id) || null, registeredProjects: () => projects } });
  projects.push(withProjects.root);
  policies.set('wa-ro', { level: 'read-only' });
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'x', cwd: root }, { assistantSessionId: 'wa-ro' }), (e) => e instanceof DispatchError && e.code === 'REMOTE_READ_ONLY' && e.status === 409);
  policies.set('wa-ask', { level: 'ask', strictWorkerApprovals: true });
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'x', cwd: root }, { assistantSessionId: 'wa-ask' }), (e) => e.code === 'REMOTE_CWD_NOT_ALLOWED', 'no registered project contains it');
  const d = withProjects.dispatcher;
  const run = await d.dispatch({ provider: 'claude-code', task: 'x', cwd: withProjects.root, tags: ['user-authorized-full', 'docs'], capability: 'workspace', usesComputer: 'false' }, { assistantSessionId: 'wa-ask' });
  assert.equal(run.run.permissionPolicy, 'ask', 'strict approvals: a person answers its requests');
  assert.deepEqual(run.run.tags, ['docs']);
  assert.equal(run.run.usesComputer, false);
  assert.ok(run.run.notes.some((note) => /strict worker approvals/.test(note)));
  const codex = await d.dispatch({ provider: 'codex', task: 'y', cwd: withProjects.root, capability: 'full' }, { assistantSessionId: 'wa-ask' });
  assert.deepEqual([codex.run.capability, codex.run.permissionPolicy], ['read-only', 'restricted'], 'Codex has no approval channel');
  policies.set('wa-auto', { level: 'autonomous', autonomousUntil: Date.now() + 60_000 });
  const auto = await d.dispatch({ provider: 'claude-code', task: 'z', cwd: withProjects.root, tags: ['user-authorized-full'], capability: 'workspace' }, { assistantSessionId: 'wa-auto' });
  assert.deepEqual(auto.run.tags, ['user-authorized-full'], 'autonomous keeps it');
  assert.equal(auto.run.permissionPolicy, 'auto');
  const plain = await d.dispatch({ provider: 'claude-code', task: 'w', cwd: withProjects.root, capability: 'workspace' }, { assistantSessionId: 'desktop-session' });
  assert.equal(plain.run.permissionPolicy, 'auto', 'a desktop session is untouched');
});

test('usesComputer "true" (a string) meets the computer gate like true (P8)', async (t) => {
  const desktop = { isSupported: () => true, isReady: () => true, setupState: () => 'ready', sessionAllows: () => false, mintGrant: () => 'g', revokeFor() {}, releaseOwner() {} };
  const { dispatcher, root } = makeHarness(t, { extra: { desktop } });
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'open TextEdit', cwd: root, usesComputer: 'true', capability: 'workspace' }, { assistantSessionId: 'assistant-1' }), (e) => e.code === 'COMPUTER_SESSION_OFF');
  const run = await dispatcher.dispatch({ provider: 'claude-code', task: 'no computer', cwd: root, usesComputer: 'false', capability: 'workspace' }, { assistantSessionId: 'assistant-1' });
  assert.equal(run.run.usesComputer, false, 'the string "false" is not computer use');
});

test('a remote session asking for computer use: the clamp drops it with a note before the desktop toggle can refuse', async (t) => {
  const desktop = { isSupported: () => true, isReady: () => true, setupState: () => 'ready', sessionAllows: () => false, mintGrant: () => 'g', revokeFor() {}, releaseOwner() {} };
  const projects = [];
  const { dispatcher, root } = makeHarness(t, { extra: { desktop, sessionPolicy: (id) => (id === 'wa-ask' ? { level: 'ask', channel: 'whatsapp' } : null), registeredProjects: () => projects } });
  projects.push(root);
  const run = await dispatcher.dispatch({ provider: 'claude-code', task: 'open TextEdit', cwd: root, usesComputer: 'true', capability: 'workspace' }, { assistantSessionId: 'wa-ask' });
  assert.equal(run.run.usesComputer, false);
  assert.ok(run.run.notes.some((note) => /computer use is off for WhatsApp sessions/.test(note)), JSON.stringify(run.run.notes));
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'open TextEdit', cwd: root, usesComputer: true, capability: 'workspace' }, { assistantSessionId: 'assistant-1' }), (e) => e.code === 'COMPUTER_SESSION_OFF', 'a desktop session still meets the toggle');
});

// ── Exact token metering (assistant-usage.js wired into the worker runs) ──
import fs, { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createModelPricing } from '../lib/assistant-budget.js';
import { createUsageLedger, readUsageLedgerFile, usageLedgerPath, withTotal } from '../lib/assistant-usage.js';
import { createOpenCodeNativeLoopAdapter } from '../lib/native-loop-providers.js';

/** A temp ledger plus the brain's current task, as server.js injects them. */
function usageKit(t, sessionId) {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-usage-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const ledger = createUsageLedger({ dataDir });
  const kit = { dataDir, ledger, task: null, extra: null };
  kit.extra = { usage: ledger, currentTask: () => kit.task };
  /** The run's settled ledger rows, as written. */
  kit.rows = (runId) => readUsageLedgerFile(usageLedgerPath(dataDir, sessionId)).rows.filter((row) => row.run === runId);
  return kit;
}
const sum = (tokens) => tokens.input + tokens.cacheWrite + tokens.cacheRead + tokens.output + tokens.reasoning;
const TOKEN_VIEW_KEYS = ['cacheRead', 'cacheWrite', 'fidelity', 'input', 'inputTotal', 'output', 'outputTotal', 'pending', 'reasoning', 'subagents', 'total'];

/**
 * A scripted Claude CLI: each user message plays the next script, whose steps
 * are SDK messages to yield or async functions to wait on. interrupt() runs the
 * script's `interrupt` hook, then leaves the CLI a moment to report.
 */
function scriptedClaude(scripts) {
  return ({ prompt }) => {
    let current = null;
    const generator = (async function* () {
      let n = 0;
      for await (const _message of prompt) {
        current = scripts[n];
        n += 1;
        if (n === 1) yield { type: 'system', subtype: 'init', session_id: 'claude-usage' };
        for (const step of current.steps) {
          if (typeof step === 'function') await step();
          else yield { session_id: 'claude-usage', ...step };
        }
      }
    })();
    generator.interrupt = async () => { current?.interrupt?.(); await new Promise((r) => setTimeout(r, 30)); };
    return generator;
  };
}
const claudeCall = (id, model, usage, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, model, role: 'assistant', content: [], usage } });
const modelUse = (inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD) => ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD });

test('Claude run: a result settles main and sub-agent rows per task, pending is live then cleared, a late result after an abort is booked', async (t) => {
  const kit = usageKit(t, 'assistant-usage-claude');
  kit.task = kit.ledger.beginTask('assistant-usage-claude', { title: 'first prompt' }).id;
  let release = null;
  const held = new Promise((r) => { release = r; });
  let interrupted = null;
  const waitInterrupt = new Promise((r) => { interrupted = r; });
  const queryFactory = scriptedClaude([
    { steps: [
      claudeCall('msg-1', 'claude-opus-5-5', { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 }),
      claudeCall('msg-2', 'claude-haiku-4-5', { input_tokens: 200, output_tokens: 20 }, 'toolu-1'),
      () => held,
      { type: 'result', subtype: 'success', uuid: 'res-1', result: RESULT_TEXT, total_cost_usd: 0.5,
        usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 },
        modelUsage: { 'claude-opus-5-5[1m]': modelUse(100, 50, 1000, 10, 0.4), 'claude-haiku-4-5': modelUse(200, 20, 0, 0, 0.1) } },
    ] },
    // modelUsage is cumulative for the query(): turn 2 spent only the difference.
    { steps: [
      { type: 'result', subtype: 'success', uuid: 'res-2', result: RESULT_TEXT, total_cost_usd: 0.7,
        usage: { input_tokens: 50, cache_read_input_tokens: 500, output_tokens: 30 },
        modelUsage: { 'claude-opus-5-5[1m]': modelUse(150, 80, 1500, 10, 0.6), 'claude-haiku-4-5': modelUse(200, 20, 0, 0, 0.1) } },
    ] },
    // Turn 3 is aborted; the CLI reports its result after the turn promise was rejected.
    { interrupt: () => interrupted(), steps: [
      claudeCall('msg-3', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 5 }),
      () => waitInterrupt,
      { type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'res-3', total_cost_usd: 0.71,
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: { 'claude-opus-5-5[1m]': modelUse(160, 85, 1500, 10, 0.61), 'claude-haiku-4-5': modelUse(200, 20, 0, 0, 0.1) } },
    ] },
  ]);
  const { root, dispatcher } = makeHarness(t, { providerFactories: realClaudeAdapter(queryFactory), extra: kit.extra });
  const sessionId = 'assistant-usage-claude';
  const { run } = await dispatcher.dispatch({ provider: 'claude-code', task: 'Refactor', cwd: root }, { assistantSessionId: sessionId });
  const runId = run.runId;
  assert.equal(run.taskId, 'task-1', 'the run is stamped with the brain\'s current task');

  // While the turn runs, the main loop and the sub-agent call are provisional.
  await waitFor(() => dispatcher.get(runId).tokens?.pending.total === 1380);
  let view = dispatcher.get(runId);
  assert.deepEqual(Object.keys(view.tokens).sort(), TOKEN_VIEW_KEYS);
  assert.equal(view.tokens.fidelity, 'live');
  assert.equal(view.tokens.total, 1380);
  assert.equal(view.usageState, undefined, 'the meters\' state never leaves the dispatcher');
  release();
  // The snapshot is on disk as soon as its rows are in the ledger, not a debounce later (a kill in between
  // would difference the next result against an older snapshot).
  await waitFor(() => kit.rows(runId).length === 2);
  const savedNow = JSON.parse(readFileSync(resolve(root, 'assistant-dispatches.json'), 'utf8')).find((row) => row.runId === runId);
  assert.equal(savedNow.usageState.claude.snapshot['claude-opus-5-5[1m]'].inputTokens, 100);
  assert.deepEqual(savedNow.usageState.turn, { n: 1, taskId: 'task-1' }, 'the turn that was started is saved with the run');
  await waitFor(() => dispatcher.get(runId).state === 'idle');
  view = dispatcher.get(runId);
  assert.deepEqual([view.tokens.total, view.tokens.pending.total, view.tokens.subagents.total, view.tokens.fidelity], [1380, 0, 220, 'exact']);
  assert.deepEqual([view.tokens.input, view.tokens.cacheWrite, view.tokens.cacheRead, view.tokens.output], [300, 10, 1000, 70]);
  assert.deepEqual(kit.rows(runId).map((row) => [row.task, row.turn, row.provider, row.model, row.part, sum(row.tokens), row.cost, row.basis, row.fid, row.src]), [
    ['task-1', 1, 'claude-code', 'claude-opus-5-5[1m]', 'main', 1160, 0.4, 'reported', 'exact', 'claude-model-usage'],
    ['task-1', 1, 'claude-code', 'claude-haiku-4-5', 'subagents', 220, 0.1, 'reported', 'exact', 'claude-model-usage'],
  ]);
  assert.equal(view.turns[0].taskId, 'task-1');
  // usage stays the provider's own figure (the main loop); tokens is the whole turn, the sub-agent included.
  assert.deepEqual(view.turns[0].usage, { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 });
  assert.deepEqual(view.turns[0].tokens, withTotal({ input: 300, cacheWrite: 10, cacheRead: 1000, output: 70, reasoning: 0 }));
  assert.equal(view.costUsd, 0.5, 'dollars still come from total_cost_usd');

  // A follow-up sent during a later task belongs to that task; the run keeps its own.
  kit.task = kit.ledger.beginTask(sessionId, { title: 'second prompt' }).id;
  dispatcher.sendTurn(runId, 'One more thing');
  await waitFor(() => dispatcher.get(runId).turnCount === 2 && dispatcher.get(runId).state === 'idle');
  view = dispatcher.get(runId);
  assert.deepEqual([view.taskId, view.turns[1].taskId], ['task-1', 'task-2']);
  assert.equal(view.turnTaskId, 'task-2', 'the view names the task of the turn the run last started (the gauge lists it there)');
  assert.deepEqual(kit.rows(runId).slice(2).map((row) => [row.task, row.turn, row.part, sum(row.tokens)]), [['task-2', 2, 'main', 580]], 'the delta, not the cumulative 1740');
  assert.equal(view.tokens.total, 1960);
  assert.deepEqual(view.turns.map((turn) => turn.tokens.total), [1380, 580]);
  assert.equal(kit.ledger.taskView(sessionId, 'task-1').task.tokens.total, 1380);
  assert.equal(kit.ledger.taskView(sessionId, 'task-2').task.tokens.total, 580);
  const totals = dispatcher.totals({ assistantSessionId: sessionId });
  assert.deepEqual(totals.tokens, withTotal({ input: 350, cacheWrite: 10, cacheRead: 1500, output: 100, reasoning: 0 }));

  // Abort turn 3 (sent during a third task): its result arrives after the turn promise was rejected and is still settled.
  kit.task = kit.ledger.beginTask(sessionId, { title: 'third prompt' }).id;
  dispatcher.sendTurn(runId, 'And this');
  await waitFor(() => dispatcher.get(runId).tokens.pending.total === 15);
  await dispatcher.stop(runId, 'assistant');
  await waitFor(() => dispatcher.get(runId).terminal);
  view = dispatcher.get(runId);
  assert.deepEqual(kit.rows(runId).slice(3).map((row) => [row.task, row.turn, row.part, sum(row.tokens)]), [['task-3', 3, 'main', 15]]);
  assert.deepEqual(view.turns.map((turn) => turn.n), [1, 2], 'the aborted turn was started but never recorded');
  assert.equal(view.turnTaskId, null, 'a run that ended has no turn in progress');
  assert.deepEqual([view.tokens.total, view.tokens.pending.total, view.tokens.fidelity], [1975, 0, 'exact'], 'nothing provisional is left when the run ends');

  // The snapshot is saved with the run, so a restarted dispatcher differences the next result instead of counting it whole.
  await dispatcher.shutdown('test');
  const saved = JSON.parse(readFileSync(resolve(root, 'assistant-dispatches.json'), 'utf8')).find((row) => row.runId === runId);
  assert.equal(saved.usageState.claude.snapshot['claude-opus-5-5[1m]'].inputTokens, 160);
  assert.deepEqual([saved.usageState.turn, saved.usageState.closed], [{ n: 3, taskId: 'task-3' }, true]);
  let feed = null;
  const restarted = createAssistantDispatcher({ getRuntime: () => ({ subscribe: (listener) => { feed = listener; return () => {}; }, get: () => null }), dataDir: root, ...kit.extra });
  t.after(() => restarted.shutdown('test'));
  const late = (event) => feed({ type: 'sidepanel:provider-event', run: { runId }, event: { provider: 'claude-code', runId, event: { session_id: 'claude-usage', ...event } } });
  late({ type: 'result', subtype: 'success', uuid: 'res-3', usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { 'claude-opus-5-5[1m]': modelUse(160, 85, 1500, 10, 0.61) } });
  assert.equal(kit.rows(runId).length, 4, 'a result already settled is not booked again');
  late({ type: 'result', subtype: 'success', uuid: 'res-4', usage: { input_tokens: 7, output_tokens: 3 }, modelUsage: { 'claude-opus-5-5[1m]': modelUse(167, 88, 1500, 10, 0.62) } });
  // After the restart the live stamp is gone: the row goes to the turn that was started (turn 3 of task-3),
  // not to the last one recorded (it was charged to task-2, turn 2).
  assert.deepEqual(kit.rows(runId).slice(4).map((row) => [row.task, row.turn, sum(row.tokens), row.fid]), [['task-3', 3, 10, 'exact']], 'the delta against the saved snapshot');
  assert.equal(restarted.get(runId).tokens.total, 1985);
  assert.equal(kit.ledger.taskView(sessionId, 'task-2').task.tokens.total, 580, 'task-2 is not charged for it');
});

test('Claude run: a result-retry turn is in the turn\'s tokens, while usage stays the first result\'s own', async (t) => {
  const sessionId = 'assistant-usage-claude-retry';
  const kit = usageKit(t, sessionId);
  kit.task = kit.ledger.beginTask(sessionId, { title: 'prompt' }).id;
  const queryFactory = scriptedClaude([
    { steps: [{ type: 'result', subtype: 'success', uuid: 'res-1', result: 'all good, but no block', total_cost_usd: 0.4,
      usage: { input_tokens: 100, output_tokens: 50 }, modelUsage: { 'claude-opus-5-5[1m]': modelUse(100, 50, 0, 0, 0.3), 'claude-haiku-4-5': modelUse(200, 20, 0, 0, 0.1) } }] },
    // The automatic result retry: a second result of the same logical turn.
    { steps: [{ type: 'result', subtype: 'success', uuid: 'res-2', result: RESULT_TEXT, total_cost_usd: 0.5,
      usage: { input_tokens: 30, output_tokens: 10 }, modelUsage: { 'claude-opus-5-5[1m]': modelUse(130, 60, 0, 0, 0.4), 'claude-haiku-4-5': modelUse(200, 20, 0, 0, 0.1) } }] },
  ]);
  const { root, dispatcher } = makeHarness(t, { providerFactories: realClaudeAdapter(queryFactory), extra: kit.extra });
  const { run } = await dispatcher.dispatch({ provider: 'claude-code', task: 'Check', cwd: root }, { assistantSessionId: sessionId });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  const view = dispatcher.get(run.runId);
  assert.deepEqual([view.lastResult.source, view.turnCount], ['retry', 1]);
  assert.deepEqual(view.turns[0].usage, { input_tokens: 100, output_tokens: 50 }, 'the provider\'s raw value: the first result\'s main loop');
  assert.deepEqual(view.turns[0].tokens, withTotal({ input: 330, cacheWrite: 0, cacheRead: 0, output: 80, reasoning: 0 }), 'both results and the helper model');
  assert.equal(view.turns[0].tokens.total, view.tokens.total);
  const rows = kit.rows(run.runId);
  assert.deepEqual([rows.every((row) => row.turn === 1), rows.reduce((total, row) => total + sum(row.tokens), 0)], [true, 410]);
});

// A Codex thread on disk, as codex-cli ≥ 0.153 writes it: one token_usage_record per model response.
const CODEX_ROOT = '01a00000-0000-7000-8000-0000000c0de1';
const CODEX_CHILD = '01a00000-0000-7000-8000-0000000c0de2';
const CODEX_PRICES = { openai: { models: { 'gpt-6-sol': { cost: { input: 2, output: 10, cache_read: 0.2 } }, 'gpt-6-mini': { cost: { input: 0.5, output: 2, cache_read: 0.05 } } } } };
const codexUse = (input, cached, output, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
function codexThreadFile(home, threadId, model) {
  const d = new Date();
  const dir = join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-10-01T08-00-00-${threadId}.jsonl`);
  const line = (type, payload) => appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
  line('session_meta', { session_id: CODEX_ROOT, id: threadId, cli_version: '0.156.1' });
  line('turn_context', { turn_id: 'turn-0', model });
  return { path, record: (turnId, responseId, usage) => line('token_usage_record', { thread_id: threadId, session_id: CODEX_ROOT, turn_id: turnId, response_id: responseId, usage }) };
}
/** A Codex worker whose provider turns are played by `turn(n, meta, { hold, isAborted })`. */
function codexHarness(t, { turn, usage = true, pricing = createModelPricing({ data: CODEX_PRICES }), limits = {} }) {
  const home = mkdtempSync(resolve(tmpdir(), 'synabun-codex-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessionId = 'assistant-usage-codex';
  const kit = usage ? usageKit(t, sessionId) : null;
  let release = null;
  let aborted = false;
  const hold = () => new Promise((resolveHold, reject) => { release = () => (aborted ? reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) : resolveHold()); });
  const harness = makeHarness(t, {
    pricing, limits,
    providerFactories: { codex: async () => {
      let n = 0;
      return {
        identity: () => ({ providerThreadId: CODEX_ROOT, providerSessionId: CODEX_ROOT }),
        isAlive: () => true,
        async runTurn(prompt, meta) { n += 1; return turn(n, meta, { hold }); },
        async abort() { aborted = true; release?.(); },
        async dispose() {},
      };
    } },
    extra: { getCodexAccount: () => ({ id: 'default', home }), CODEX_DEFAULT_HOME: home, ...(kit ? kit.extra : {}) },
  });
  const start = () => harness.dispatcher.dispatch({ provider: 'codex', task: 'Port the module', cwd: harness.root, model: 'gpt-6-sol' }, { assistantSessionId: sessionId });
  return { ...harness, home, kit, sessionId, start };
}
const usd6 = (value) => Number(Number(value).toFixed(6));

test('Codex run: rollout records are booked once (retry turn, compaction, sub-agent thread) and priced from the records', async (t) => {
  let main = null;
  const h = codexHarness(t, { turn: (n) => {
    main = main || codexThreadFile(h.home, CODEX_ROOT, 'gpt-6-sol');
    if (n === 1) {
      main.record('turn-1', 'resp-1', codexUse(100_000, 40_000, 2_000, 500));
      main.record('turn-1', 'resp-compact', codexUse(50_000, 0, 1_000)); // turn.completed never reports this call
      return { text: 'done, but no result block', usage: codexUse(100_000, 40_000, 2_000, 500) };
    }
    if (n === 2) {
      // The automatic result retry: its turn.completed.usage is the thread's running total.
      main.record('turn-1r', 'resp-2', codexUse(120_000, 100_000, 500));
      return { text: RESULT_TEXT, usage: codexUse(220_000, 140_000, 2_500, 500) };
    }
    main.record('turn-2', 'resp-3', codexUse(130_000, 120_000, 1_000));
    codexThreadFile(h.home, CODEX_CHILD, 'gpt-6-mini').record('turn-s', 'resp-s1', codexUse(30_000, 0, 3_000));
    return { text: RESULT_TEXT, usage: codexUse(350_000, 260_000, 3_500, 500) };
  } });
  h.kit.task = h.kit.ledger.beginTask(h.sessionId, { title: 'port it' }).id;
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).state === 'idle');
  let view = h.dispatcher.get(run.runId);
  assert.equal(view.lastResult.source, 'retry');
  // resp-1 $0.148 + compaction $0.11 + resp-2 $0.065; the cumulative 220k of the retry turn is not added again.
  assert.equal(usd6(view.costUsd), 0.323);
  assert.equal(view.costBasis, 'estimated');
  assert.equal(view.usage.input_tokens, 270_000, 'was 100k + 220k = 320k, without the compaction call');
  assert.equal(view.turns[0].usage.input_tokens, 270_000);
  assert.equal(usd6(view.turns[0].costUsd), 0.323);
  assert.equal(view.tokens.total, 273_500);

  h.kit.task = h.kit.ledger.beginTask(h.sessionId, { title: 'and the tests' }).id;
  h.dispatcher.sendTurn(run.runId, 'Now the tests');
  await waitFor(() => h.dispatcher.get(run.runId).turnCount === 2 && h.dispatcher.get(run.runId).state === 'idle');
  view = h.dispatcher.get(run.runId);
  assert.equal(view.usage.input_tokens, 430_000);
  assert.equal(view.turns[1].usage.input_tokens, 160_000, 'the turn\'s own usage, not the thread total');
  assert.equal(usd6(view.costUsd), 0.398, '+ resp-3 $0.054 + the sub-agent on its own model $0.021');
  assert.deepEqual([view.tokens.total, view.tokens.subagents.total, view.tokens.reasoning, view.tokens.fidelity], [437_500, 33_000, 500, 'exact']);
  // A turn's tokens: every row settled for it (the compaction call, the retry turn, the sub-agent thread).
  assert.deepEqual(view.turns.map((turn) => turn.tokens.total), [273_500, 164_000]);
  assert.deepEqual(view.turns[1].tokens, withTotal({ input: 40_000, cacheWrite: 0, cacheRead: 120_000, output: 4_000, reasoning: 0 }));
  assert.deepEqual(h.kit.rows(run.runId).map((row) => [row.task, row.turn, row.model, row.part, sum(row.tokens), usd6(row.cost), row.basis, row.fid, row.src]), [
    ['task-1', 1, 'gpt-6-sol', 'main', 153_000, 0.258, 'estimated', 'exact', 'codex-records'],
    ['task-1', 1, 'gpt-6-sol', 'main', 120_500, 0.065, 'estimated', 'exact', 'codex-records'],
    ['task-2', 2, 'gpt-6-sol', 'main', 131_000, 0.054, 'estimated', 'exact', 'codex-records'],
    ['task-2', 2, 'gpt-6-mini', 'subagents', 33_000, 0.021, 'estimated', 'exact', 'codex-records'],
  ]);
  h.dispatcher.complete(run.runId);
  await waitFor(() => h.dispatcher.get(run.runId).terminal);
  assert.equal(h.kit.rows(run.runId).length, 4, 'the final poll at the run\'s end finds nothing new');
  const saved = JSON.parse(readFileSync(resolve(h.root, 'assistant-dispatches.json'), 'utf8')).find((row) => row.runId === run.runId);
  assert.deepEqual(saved.usageState, { closed: true }, 'a finished run keeps no rollout offsets');

  // Removing the run takes it out of the counts, not out of what the session spent.
  const before = h.dispatcher.totals({ assistantSessionId: h.sessionId });
  await h.dispatcher.remove(run.runId);
  const after = h.dispatcher.totals({ assistantSessionId: h.sessionId });
  assert.deepEqual([before.completed, after.completed], [1, 0]);
  assert.equal(after.tokens.total, 437_500, 'the tokens fell to 0 while the dollars stayed');
  assert.deepEqual([after.tokens, after.costUsd], [before.tokens, before.costUsd]);
});

test('Codex run without a ledger: the meter still prices the run and keeps its own numbers', async (t) => {
  let main = null;
  const h = codexHarness(t, { usage: false, turn: () => {
    main = main || codexThreadFile(h.home, CODEX_ROOT, 'gpt-6-sol');
    main.record('turn-1', 'resp-1', codexUse(100_000, 40_000, 2_000, 500));
    return { text: RESULT_TEXT, usage: codexUse(100_000, 40_000, 2_000, 500) };
  } });
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).state === 'idle');
  const view = h.dispatcher.get(run.runId);
  assert.deepEqual([usd6(view.costUsd), view.usage.input_tokens, view.tokens, view.taskId, view.turns[0].taskId], [0.148, 100_000, null, null, null]);
  assert.deepEqual(h.dispatcher.totals({ assistantSessionId: h.sessionId }).tokens, withTotal({ input: 100_000, cacheWrite: 0, cacheRead: 0, output: 2_000, reasoning: 0 }), 'legacy input / output without a ledger');
});

test('Codex run: records are booked while the turn runs, and the run stops mid-turn at its cap', async (t) => {
  const h = codexHarness(t, { limits: { usagePollMs: 20 }, turn: async (n, meta, { hold }) => {
    codexThreadFile(h.home, CODEX_ROOT, 'gpt-6-sol').record('turn-1', 'resp-1', codexUse(100_000, 40_000, 2_000, 500));
    await hold();
    return { text: RESULT_TEXT };
  } });
  const { run } = await h.dispatcher.dispatch({ provider: 'codex', task: 'Port', cwd: h.root, model: 'gpt-6-sol', budgetUsd: 0.1 }, { assistantSessionId: h.sessionId });
  await waitFor(() => h.dispatcher.get(run.runId).state === 'stopped');
  const view = h.dispatcher.get(run.runId);
  assert.equal(view.completionReason, 'budget_cap');
  assert.equal(usd6(view.costUsd), 0.148);
  assert.ok(view.notes.some((note) => note.startsWith('stopped mid-turn: run spent $0.15 of its $0.10 cap')), JSON.stringify(view.notes));
  assert.deepEqual(h.kit.rows(run.runId).map((row) => [row.task, row.turn, sum(row.tokens)]), [['task-0', 1, 102_000]], 'a session without a task gets task-0');
});

test('Codex run without a rollout: turn.completed.usage is the thread total, so only its growth is booked (partial)', async (t) => {
  const h = codexHarness(t, { turn: (n) => (n === 1
    ? { text: RESULT_TEXT, usage: codexUse(100_000, 40_000, 2_000, 500) }
    : { text: RESULT_TEXT, usage: codexUse(220_000, 140_000, 2_500, 500) }) });
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).state === 'idle');
  h.dispatcher.sendTurn(run.runId, 'Next');
  await waitFor(() => h.dispatcher.get(run.runId).turnCount === 2 && h.dispatcher.get(run.runId).state === 'idle');
  const view = h.dispatcher.get(run.runId);
  assert.equal(view.usage.input_tokens, 220_000, 'was 100k + 220k');
  assert.equal(usd6(view.costUsd), 0.213, '$0.148 + the growth 120k in (100k cached) + 500 out = $0.065');
  assert.deepEqual(view.turns.map((turn) => turn.usage.input_tokens), [100_000, 120_000]);
  assert.deepEqual(h.kit.rows(run.runId).map((row) => [row.turn, sum(row.tokens), usd6(row.cost), row.fid, row.why, row.src]), [
    [1, 102_000, 0.148, 'partial', 'codex-rollout-missing', 'codex-turn-usage'],
    [2, 120_500, 0.065, 'partial', 'codex-rollout-missing', 'codex-turn-usage'],
  ]);
  assert.equal(view.tokens.fidelity, 'partial');
});

test('Codex run: a failed turn without a rollout books nothing and is not flagged unpriced', async (t) => {
  const h = codexHarness(t, { turn: () => { throw new Error('request rejected before any model call'); } });
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).terminal);
  const view = h.dispatcher.get(run.runId);
  assert.equal(view.state, 'failed');
  assert.deepEqual([view.costUsd, view.costBasis, view.unpricedTurns, view.usage], [0, 'none', undefined, null]);
  assert.ok(!h.broadcasts.some((m) => m.reason === 'budget_unpriced'));
  assert.deepEqual(h.kit.rows(run.runId), []);
  assert.equal(view.tokens.total, 0);
});

test('Codex run: a turn whose records are missing after a turn that had them is booked from its own report, once', async (t) => {
  let main = null;
  const h = codexHarness(t, { turn: (n) => {
    main = main || codexThreadFile(h.home, CODEX_ROOT, 'gpt-6-sol');
    if (n === 1) {
      main.record('turn-1', 'resp-1', codexUse(100_000, 40_000, 2_000, 500));
      return { text: RESULT_TEXT, usage: codexUse(100_000, 40_000, 2_000, 500) };
    }
    // Turn 2 leaves no record in the rollout; its report is the thread's running total.
    if (n === 2) return { text: RESULT_TEXT, usage: codexUse(220_000, 140_000, 2_500, 500) };
    // Turn 3: the record of turn 2 turns up late, beside this turn's own.
    main.record('turn-2', 'resp-2', codexUse(120_000, 100_000, 500));
    main.record('turn-3', 'resp-3', codexUse(130_000, 120_000, 1_000));
    return { text: RESULT_TEXT, usage: codexUse(350_000, 260_000, 3_500, 500) };
  } });
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).state === 'idle');
  h.dispatcher.sendTurn(run.runId, 'Next');
  await waitFor(() => h.dispatcher.get(run.runId).turnCount === 2 && h.dispatcher.get(run.runId).state === 'idle');
  let view = h.dispatcher.get(run.runId);
  const shape = (row) => [row.turn, row.part, sum(row.tokens), usd6(row.cost), row.fid, row.why, row.src];
  assert.deepEqual(h.kit.rows(run.runId).map(shape), [
    [1, 'main', 102_000, 0.148, 'exact', null, 'codex-records'],
    [2, 'main', 120_500, 0.065, 'partial', 'codex-rollout-missing', 'codex-turn-usage'],
  ], 'turn 2 was never booked: turn 1\'s rows switched the fallback off for the whole run');
  assert.equal(view.usage.input_tokens, 220_000);
  assert.equal(usd6(view.costUsd), 0.213);
  assert.deepEqual(view.turns.map((turn) => turn.tokens.total), [102_000, 120_500]);

  h.dispatcher.sendTurn(run.runId, 'And again');
  await waitFor(() => h.dispatcher.get(run.runId).turnCount === 3 && h.dispatcher.get(run.runId).state === 'idle');
  view = h.dispatcher.get(run.runId);
  assert.deepEqual(h.kit.rows(run.runId).slice(2).map(shape), [[3, 'main', 131_000, 0.054, 'exact', null, 'codex-records']], 'the late record of turn 2 was already paid for by its report');
  assert.deepEqual([view.usage.input_tokens, view.tokens.total, usd6(view.costUsd)], [350_000, 353_500, 0.267]);
});

test('Codex run: a sub-agent row does not stand in for a main rollout that is missing', async (t) => {
  const h = codexHarness(t, { turn: () => {
    // Only the sub-agent thread's rollout exists; the run's own was never written.
    codexThreadFile(h.home, CODEX_CHILD, 'gpt-6-mini').record('turn-s', 'resp-s1', codexUse(30_000, 0, 3_000));
    return { text: RESULT_TEXT, usage: codexUse(100_000, 40_000, 2_000, 500) };
  } });
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).state === 'idle');
  const view = h.dispatcher.get(run.runId);
  assert.deepEqual(h.kit.rows(run.runId).map((row) => [row.model, row.part, sum(row.tokens), usd6(row.cost), row.fid, row.why]), [
    ['gpt-6-mini', 'subagents', 33_000, 0.021, 'exact', null],
    ['gpt-6-sol', 'main', 102_000, 0.148, 'partial', 'codex-rollout-missing'],
  ], 'the main thread\'s 102k were dropped: the sub-agent row counted as "the rollout gave rows"');
  assert.deepEqual([view.tokens.total, view.tokens.subagents.total, usd6(view.costUsd)], [135_000, 33_000, 0.169]);
});

test('Codex run: a row is priced as its own recorded model; one without a list price flags the run instead of borrowing the run model\'s rate', async (t) => {
  let main = null;
  const h = codexHarness(t, { turn: () => {
    // The run was dispatched as gpt-6-sol; its rollout says the thread ran gpt-6-mini.
    main = main || codexThreadFile(h.home, CODEX_ROOT, 'gpt-6-mini');
    main.record('turn-1', 'resp-1', codexUse(100_000, 40_000, 2_000, 500));
    codexThreadFile(h.home, CODEX_CHILD, 'gpt-9-unlisted').record('turn-s', 'resp-s1', codexUse(30_000, 0, 3_000));
    return { text: RESULT_TEXT, usage: codexUse(100_000, 40_000, 2_000, 500) };
  } });
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).terminal);
  const view = h.dispatcher.get(run.runId);
  // The main row at gpt-6-mini's rate (60k × $0.50 + 40k × $0.05 + 2k × $2), not the run model's $0.148;
  // the unlisted model's 33k are not charged at all (they were $0.09 at gpt-6-sol's rate).
  assert.equal(usd6(view.costUsd), 0.036);
  assert.deepEqual([view.costBasis, view.unpricedTurns, view.unpricedReason, view.completionReason], ['unpriced', 1, 'no list price for gpt-9-unlisted', 'budget_unpriced']);
  assert.deepEqual(h.kit.rows(run.runId).map((row) => [row.model, row.part, sum(row.tokens), row.cost == null ? null : usd6(row.cost), row.basis]), [
    ['gpt-6-mini', 'main', 102_000, 0.036, 'estimated'],
    ['gpt-9-unlisted', 'subagents', 33_000, null, 'unpriced'],
  ]);
});

test('Codex run: the rollout poll timer runs only while a turn does', async (t) => {
  let open = null;
  const gate = new Promise((resolveGate) => { open = resolveGate; });
  const h = codexHarness(t, { limits: { usagePollMs: 20 }, turn: async (n) => {
    if (n === 2) await gate;
    return { text: RESULT_TEXT, usage: codexUse(1_000 * n, 0, 100 * n) };
  } });
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).state === 'idle');
  const liveState = h.dispatcher._internals.live.get(run.runId);
  assert.equal(liveState.usageTimer, null, 'it kept ticking for as long as the run stayed warm');
  h.dispatcher.sendTurn(run.runId, 'Next');
  await waitFor(() => h.dispatcher.get(run.runId).state === 'running');
  assert.ok(liveState.usageTimer, 'a follow-up turn starts it again');
  open();
  await waitFor(() => h.dispatcher.get(run.runId).turnCount === 2 && h.dispatcher.get(run.runId).state === 'idle');
  assert.equal(liveState.usageTimer, null);
});

test('Codex run: a turn\'s closing poll looks for new rollouts on the same meter (no rebuild)', async (t) => {
  let main = null;
  let foreign = null;
  const h = codexHarness(t, { turn: (n) => {
    main = main || codexThreadFile(h.home, CODEX_ROOT, 'gpt-6-sol');
    if (n === 1) {
      // Another Codex session's rollout in the same day folder: read once to see it is not this run's.
      const other = '01a00000-0000-7000-8000-0000000f0e19';
      foreign = join(dirname(main.path), `rollout-2026-10-01T07-00-00-${other}.jsonl`);
      appendFileSync(foreign, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { session_id: other, id: other } })}\n`);
      main.record('turn-1', 'resp-1', codexUse(100_000, 40_000, 2_000, 500));
      return { text: RESULT_TEXT, usage: codexUse(100_000, 40_000, 2_000, 500) };
    }
    // A sub-agent thread born just before the turn's end: the meter's own discovery (every 15 s) would miss it.
    main.record('turn-2', 'resp-2', codexUse(120_000, 100_000, 500));
    codexThreadFile(h.home, CODEX_CHILD, 'gpt-6-mini').record('turn-s', 'resp-s1', codexUse(30_000, 0, 3_000));
    return { text: RESULT_TEXT, usage: codexUse(220_000, 140_000, 2_500, 500) };
  } });
  const opened = t.mock.method(fs, 'openSync');
  const { run } = await h.start();
  await waitFor(() => h.dispatcher.get(run.runId).state === 'idle');
  h.dispatcher.sendTurn(run.runId, 'Next');
  await waitFor(() => h.dispatcher.get(run.runId).turnCount === 2 && h.dispatcher.get(run.runId).state === 'idle');
  assert.deepEqual(h.kit.rows(run.runId).map((row) => [row.turn, row.part, sum(row.tokens)]), [[1, 'main', 102_000], [2, 'main', 120_500], [2, 'subagents', 33_000]], 'the sub-agent thread is in the turn it ran in');
  assert.equal(opened.mock.calls.filter((call) => call.arguments[0] === foreign).length, 1, 'a meter rebuilt at every turn close read the foreign rollout again each time');
});

test('OpenCode run: child sessions count as sub-agents, and the turn end reconciles a message the stream missed', async (t) => {
  const sessionId = 'assistant-usage-opencode';
  const kit = usageKit(t, sessionId);
  const listeners = new Set();
  const say = (eventType, event) => { for (const listener of listeners) listener({ eventType, event }); };
  const tokens = (input, output, read = 0) => ({ input, output, reasoning: 0, cache: { read, write: 0 } });
  const message = (session, id, cost, used, done = true) => ({ id, sessionID: session, role: 'assistant', providerID: 'ollama-cloud', modelID: 'glm', cost, tokens: used, time: done ? { completed: 1 } : {} });
  let failStored = false;
  let turns = 0;
  const client = {
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async waitUntilConnected() {},
    session: {
      async create() { return { data: { id: 'ses-root' } }; },
      async promptAsync() {
        turns += 1;
        const n = turns;
        setTimeout(() => {
          if (n === 1) {
            say('message.updated', { info: message('ses-root', 'msg-1', 0.2, tokens(1000, 100), false) });
            say('session.created', { info: { id: 'ses-child', parentID: 'ses-root' } });
            say('message.updated', { info: message('ses-child', 'msg-c1', 0.05, tokens(400, 40)) });
            say('session.idle', { sessionID: 'ses-child' }); // a sub-agent finishing does not end the run's turn
          } else say('message.updated', { info: message('ses-root', 'msg-3', 0.1, tokens(300, 30)) });
          say('session.idle', { sessionID: 'ses-root' });
        }, 5);
        return { status: 204 };
      },
      async children({ sessionID }) { return { data: sessionID === 'ses-root' ? [{ id: 'ses-child', parentID: 'ses-root' }] : [] }; },
      async messages({ sessionID }) {
        if (failStored) return { error: { message: 'serve is gone' } };
        if (sessionID === 'ses-child') return { data: [{ info: message('ses-child', 'msg-c1', 0.05, tokens(400, 40)) }] };
        // msg-1 grew after its last event, and msg-2 never reached the stream.
        return { data: [{ info: message('ses-root', 'msg-1', 0.3, tokens(1500, 150)) }, { info: message('ses-root', 'msg-2', 0.1, tokens(200, 20)) }] };
      },
      async abort() {},
    },
  };
  const { root, dispatcher } = makeHarness(t, {
    providerFactories: { opencode: (state) => createOpenCodeNativeLoopAdapter({ ...state, client }) },
    extra: kit.extra,
  });
  kit.task = kit.ledger.beginTask(sessionId, { title: 'build it' }).id;
  const { run } = await dispatcher.dispatch({ provider: 'opencode', task: 'Build', cwd: root, model: 'ollama-cloud/glm' }, { assistantSessionId: sessionId });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  let view = dispatcher.get(run.runId);
  assert.deepEqual([view.tokens.total, view.tokens.subagents.total, view.tokens.pending.total, view.tokens.fidelity], [2310, 440, 0, 'exact']);
  assert.equal(usd6(view.costUsd), 0.45, 'root $0.30 + the missed message $0.10 + the child session $0.05');
  assert.equal(view.costBasis, 'reported');
  assert.equal(view.usage.input_tokens, 2100);
  assert.deepEqual(view.turns[0].usage, { input_tokens: 2100, output_tokens: 210, reasoning_tokens: 0, cache_read_input_tokens: 0, cache_write_input_tokens: 0 });
  assert.deepEqual(kit.rows(run.runId).map((row) => [row.task, row.turn, row.model, row.part, sum(row.tokens), row.cost === null ? null : usd6(row.cost), row.fid, row.src]), [
    ['task-1', 1, 'ollama-cloud/glm', 'main', 1870, 0.45, 'exact', 'opencode-messages'],
    ['task-1', 1, 'ollama-cloud/glm', 'subagents', 440, null, 'exact', 'opencode-messages'],
  ]);

  // The serve cannot be read at the next turn's end: what streamed is booked, flagged partial.
  failStored = true;
  dispatcher.sendTurn(run.runId, 'More');
  await waitFor(() => dispatcher.get(run.runId).turnCount === 2 && dispatcher.get(run.runId).state === 'idle');
  view = dispatcher.get(run.runId);
  assert.deepEqual(kit.rows(run.runId).slice(2).map((row) => [row.turn, row.part, sum(row.tokens), usd6(row.cost), row.fid, row.why]), [[2, 'main', 330, 0.1, 'partial', 'opencode-not-reconciled']]);
  assert.deepEqual([view.tokens.total, view.tokens.fidelity, usd6(view.costUsd)], [2640, 'partial', 0.55]);
  assert.deepEqual(view.turns[1].usage.input_tokens, 300);
  assert.deepEqual(view.turns.map((turn) => turn.tokens.total), [2310, 330], 'each turn\'s rows, the child session included');
});

/**
 * An OpenCode worker whose turns are played by `turn(n, say)`: say(info) forwards one assistant
 * message.updated the way the adapter does. `models` are the catalog's OpenCode rows.
 */
function openCodeHarness(t, { sessionId, models, turn, fetchers = null, limits = {} }) {
  const kit = usageKit(t, sessionId);
  const known = { models: { opencode: models } };
  const harness = makeHarness(t, {
    providerFactories: { opencode: async (state) => {
      let n = 0;
      const say = (info) => state.onEvent({ provider: 'opencode', runId: state.runId, eventType: 'message.updated', event: { info }, ...(info.sessionID === 'ses-root' ? {} : { childSession: true }) });
      return {
        identity: () => ({ providerSessionId: 'ses-root' }),
        isAlive: () => true,
        // What the serve stored, for the turn-end reconcile (the real adapter's usageFetchers).
        ...(fetchers ? { usageFetchers: () => fetchers } : {}),
        async runTurn() { n += 1; return turn(n, say); },
        async abort() {},
        async dispose() {},
      };
    } },
    limits,
    extra: { ...kit.extra, catalog: { peek: () => known, get: async () => known } },
  });
  return { ...harness, kit };
}
const openCodeMessage = (session, id, modelID, cost, input, output) => ({
  id, sessionID: session, role: 'assistant', providerID: 'ollama-cloud', modelID, cost,
  tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, time: { completed: 1 },
});
const OPENCODE_MODELS = [
  { id: 'ollama-cloud/glm', price: { input: 1, output: 2, cacheRead: null, unit: 'usd_per_mtok', basis: 'list' } },
  { id: 'ollama-cloud/mini', price: { input: 0.1, output: 0.2, cacheRead: null, unit: 'usd_per_mtok', basis: 'list' } },
];

test('OpenCode run: the estimate for a message is replaced by the cost it reports later, not added to it', async (t) => {
  const sessionId = 'assistant-usage-opencode-estimate';
  const { root, dispatcher, kit } = openCodeHarness(t, { sessionId, models: OPENCODE_MODELS, turn: (n, say) => {
    // Done with no cost yet: estimated at the list price, 1M in × $1 + 100k out × $2 = $1.20.
    say(openCodeMessage('ses-root', 'msg-1', 'glm', 0, 1_000_000, 100_000));
    // The same message with the cost OpenCode worked out.
    say(openCodeMessage('ses-root', 'msg-1', 'glm', 0.9, 1_000_000, 100_000));
    return { text: RESULT_TEXT };
  } });
  const { run } = await dispatcher.dispatch({ provider: 'opencode', task: 'Build', cwd: root, model: 'ollama-cloud/glm' }, { assistantSessionId: sessionId });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  const view = dispatcher.get(run.runId);
  assert.equal(usd6(view.costUsd), 0.9, 'was $1.20 + $0.90: the estimate and then the reported cost');
  assert.equal(usd6(view.turns[0].costUsd), 0.9);
  assert.deepEqual(kit.rows(run.runId).map((row) => [row.part, sum(row.tokens), usd6(row.cost)]), [['main', 1_100_000, 0.9]]);

  // The run ended and was settled: the per-message snapshots are not kept.
  assert.equal(dispatcher._internals.live.get(run.runId).meter.size, 1);
  dispatcher.complete(run.runId);
  await waitFor(() => dispatcher.get(run.runId).terminal);
  assert.equal(dispatcher._internals.live.get(run.runId).meter, null);
});

test('OpenCode run: a child message is estimated at its own model\'s price; a model without one flags the run', async (t) => {
  const sessionId = 'assistant-usage-opencode-child';
  const { root, dispatcher } = openCodeHarness(t, { sessionId, models: OPENCODE_MODELS, turn: (n, say) => {
    say(openCodeMessage('ses-root', 'msg-1', 'glm', 0.2, 1_000, 100));
    // A sub-agent on a cheaper model, done with no reported cost: 1M in × $0.10 + 100k out × $0.20 = $0.12.
    if (n === 1) say(openCodeMessage('ses-child', 'msg-c1', 'mini', 0, 1_000_000, 100_000));
    // And one on a model the catalog has no price for.
    else say(openCodeMessage('ses-child-2', 'msg-c2', 'mystery', 0, 500_000, 50_000));
    return { text: RESULT_TEXT };
  } });
  const { run } = await dispatcher.dispatch({ provider: 'opencode', task: 'Build', cwd: root, model: 'ollama-cloud/glm' }, { assistantSessionId: sessionId });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  let view = dispatcher.get(run.runId);
  assert.equal(usd6(view.costUsd), 0.32, '$0.20 + the child at its own price (the run model\'s rate made it $1.20)');
  assert.deepEqual([view.costBasis, view.unpricedTurns], ['estimated', undefined]);
  dispatcher.sendTurn(run.runId, 'More');
  await waitFor(() => dispatcher.get(run.runId).turnCount === 2 && dispatcher.get(run.runId).state === 'idle');
  view = dispatcher.get(run.runId);
  assert.equal(usd6(view.costUsd), 0.32, 'never the run model\'s rate ($0.60) for a model with no price');
  assert.deepEqual([view.costBasis, view.unpricedTurns], ['unpriced', 1]);
  assert.match(view.unpricedReason, /ollama-cloud\/mystery/);
});

test('OpenCode run: a reconcile that hangs is cut off at the limit; the turn settles as not reconciled and a late answer books nothing twice', async (t) => {
  const sessionId = 'assistant-usage-opencode-hang';
  // On the serve msg-1 grew to $0.30 / 1650 tokens after its last event.
  const stored = () => [{ info: openCodeMessage('ses-root', 'msg-1', 'glm', 0.3, 1_500, 150) }];
  let answer = null;
  let reads = 0;
  const fetchers = {
    children: async () => [],
    // The first read never answers in time; later ones do.
    messages: () => { reads += 1; return reads === 1 ? new Promise((resolveRead) => { answer = () => resolveRead(stored()); }) : Promise.resolve(stored()); },
  };
  const { root, dispatcher, kit } = openCodeHarness(t, { sessionId, models: OPENCODE_MODELS, fetchers, limits: { usageReconcileMs: 30 }, turn: (n, say) => {
    if (n === 1) say(openCodeMessage('ses-root', 'msg-1', 'glm', 0.2, 1_000, 100));
    return { text: RESULT_TEXT };
  } });
  const { run } = await dispatcher.dispatch({ provider: 'opencode', task: 'Build', cwd: root, model: 'ollama-cloud/glm' }, { assistantSessionId: sessionId });
  // Without the limit the run never left its first turn.
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  const shape = (row) => [row.turn, sum(row.tokens), usd6(row.cost), row.fid, row.why ?? null];
  assert.deepEqual(kit.rows(run.runId).map(shape), [[1, 1_100, 0.2, 'partial', 'opencode-not-reconciled']]);

  // The serve answers after the turn was settled: nothing is booked from it.
  answer();
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.equal(kit.rows(run.runId).length, 1);
  assert.equal(usd6(dispatcher.get(run.runId).costUsd), 0.2);

  // The next turn is free to start, and its own reconcile books what msg-1 grew by, once.
  dispatcher.sendTurn(run.runId, 'More');
  await waitFor(() => dispatcher.get(run.runId).turnCount === 2 && dispatcher.get(run.runId).state === 'idle');
  const view = dispatcher.get(run.runId);
  assert.deepEqual(kit.rows(run.runId).slice(1).map(shape), [[2, 550, 0.1, 'exact', null]]);
  assert.deepEqual([view.tokens.total, usd6(view.costUsd)], [1_650, 0.3]);
});

// ── Structured results (a run dispatched with an output schema) ──
test('a run with an output schema: its bare JSON answer is the result, and no result-retry turn is sent (Codex shape)', async (t) => {
  const prompts = [];
  const answers = ['{"status":"blocked","summary":"no access to the repo","missing":["token"]}', '```json\n{"answer":42}\n```', '{"status":"done","summary":"plain run"}'];
  const { root, dispatcher } = makeHarness(t, { adapterBehavior: { text: (turn, prompt) => { prompts.push(prompt); return answers[prompts.length - 1] || RESULT_TEXT; } } });
  const outputSchema = { type: 'object', properties: { status: { type: 'string' }, summary: { type: 'string' } } };
  const { run } = await dispatcher.dispatch({ provider: 'codex', task: 'Report', cwd: root, outputSchema });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  let view = dispatcher.get(run.runId);
  assert.equal(prompts.length, 1, 'the paid "result retry" turn was sent for every structured answer');
  assert.deepEqual([view.lastResult.source, view.lastResult.status, view.lastResult.summary, view.outcome], ['structured', 'blocked', 'no access to the repo', 'blocked']);
  assert.deepEqual(view.lastResult.json, { status: 'blocked', summary: 'no access to the repo', missing: ['token'] });
  dispatcher.sendTurn(run.runId, 'Again');
  await waitFor(() => dispatcher.get(run.runId).turnCount === 2 && dispatcher.get(run.runId).state === 'idle');
  view = dispatcher.get(run.runId);
  assert.equal(prompts.length, 2);
  // No known status reads as done; without a summary the text stands in.
  assert.deepEqual([view.lastResult.source, view.lastResult.status, view.lastResult.json, view.escalation], ['structured', 'done', { answer: 42 }, null]);
  assert.match(view.lastResult.summary, /"answer":42/);

  // Without an output schema a JSON message is not a result: the retry turn still asks for the block.
  const plain = await dispatcher.dispatch({ provider: 'codex', task: 'Plain', cwd: root });
  await waitFor(() => dispatcher.get(plain.run.runId).state === 'idle');
  assert.equal(prompts.length, 4);
  assert.equal(dispatcher.get(plain.run.runId).lastResult.source, 'retry');
});

test('a Claude result that carries structured_output is the result, and no result-retry turn is sent', async (t) => {
  let retried = false;
  const answer = { status: 'done', summary: 'two findings', findings: ['a', 'b'] };
  const queryFactory = scriptedClaude([
    { steps: [{ type: 'result', subtype: 'success', uuid: 'res-1', result: JSON.stringify(answer), structured_output: answer, total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 5 } }] },
    { steps: [() => { retried = true; }, { type: 'result', subtype: 'success', uuid: 'res-2', result: RESULT_TEXT, total_cost_usd: 0.3 }] },
  ]);
  const { root, dispatcher } = makeHarness(t, { providerFactories: realClaudeAdapter(queryFactory) });
  const { run } = await dispatcher.dispatch({ provider: 'claude-code', task: 'Review', cwd: root, outputSchema: { type: 'object', properties: { status: { type: 'string' } } } });
  await waitFor(() => dispatcher.get(run.runId).state === 'idle');
  const view = dispatcher.get(run.runId);
  assert.equal(retried, false);
  assert.deepEqual([view.lastResult.source, view.lastResult.status, view.lastResult.summary, view.outcome], ['structured', 'done', 'two findings', 'done']);
  assert.deepEqual([view.lastResult.json, view.turns[0].structured], [answer, answer]);
  assert.equal(view.costUsd, 0.1, 'the retry turn cost another $0.20');
});

test('without the ledger: views carry tokens null, totals keep input and output, and task stamps follow currentTask alone', async (t) => {
  const plain = makeHarness(t);
  const first = await plain.dispatcher.dispatch({ provider: 'claude-code', task: 'a', cwd: plain.root }, { assistantSessionId: 'assistant-plain' });
  await waitFor(() => plain.dispatcher.get(first.run.runId).state === 'idle');
  const view = plain.dispatcher.get(first.run.runId);
  assert.deepEqual([view.tokens, view.taskId, view.turns[0].taskId], [null, null, null]);
  assert.deepEqual(plain.dispatcher.totals({ assistantSessionId: 'assistant-plain' }).tokens, withTotal({ input: 5, cacheWrite: 0, cacheRead: 0, output: 2, reasoning: 0 }));

  // currentTask without a ledger still stamps the run and its turns.
  let task = 'task-7';
  const stamped = makeHarness(t, { extra: { currentTask: () => task } });
  const second = await stamped.dispatcher.dispatch({ provider: 'claude-code', task: 'b', cwd: stamped.root }, { assistantSessionId: 'assistant-stamped' });
  await waitFor(() => stamped.dispatcher.get(second.run.runId).state === 'idle');
  task = null; // no brain turn in progress: the follow-up falls back to the run's task
  stamped.dispatcher.sendTurn(second.run.runId, 'again');
  await waitFor(() => stamped.dispatcher.get(second.run.runId).turnCount === 2);
  assert.deepEqual([stamped.dispatcher.get(second.run.runId).taskId, ...stamped.dispatcher.get(second.run.runId).turns.map((turn) => turn.taskId)], ['task-7', 'task-7', 'task-7']);
});

test('a worker dispatched from a WhatsApp session never gets usesComputer, with the computer-use switch on and Autonomous active', async (t) => {
  let minted = 0;
  // The desktop is ready and would allow this session: the clamp must drop computer use before the gate is even asked.
  const desktop = { isSupported: () => true, isReady: () => true, setupState: () => 'ready', sessionAllows: () => true, mintGrant: () => { minted += 1; return 'g'; }, revokeFor() {}, releaseOwner() {} };
  const projects = [];
  const policies = new Map([
    ['wa-auto', { level: 'autonomous', autonomousUntil: Date.now() + 3_600_000, computerUse: true, channel: 'whatsapp' }],
    ['wa-ask', { level: 'ask', computerUse: true, channel: 'whatsapp' }],
  ]);
  const { dispatcher, root, factoryCalls } = makeHarness(t, { extra: { desktop, sessionPolicy: (id) => policies.get(id) || null, registeredProjects: () => projects } });
  projects.push(root);
  for (const id of ['wa-auto', 'wa-ask']) {
    for (const usesComputer of [true, 'true']) {
      const run = await dispatcher.dispatch({ provider: 'claude-code', task: 'open TextEdit and type a note', cwd: root, usesComputer, capability: 'workspace' }, { assistantSessionId: id });
      assert.equal(run.run.usesComputer, false, `${id} ${JSON.stringify(usesComputer)}`);
      assert.ok(run.run.notes.some((note) => /computer use is off for WhatsApp sessions/.test(note)), JSON.stringify(run.run.notes));
    }
  }
  assert.equal(minted, 0, 'no worker of a WhatsApp session is ever given a desktop grant');
  assert.ok(factoryCalls.every((call) => call.usesComputer !== true));
});

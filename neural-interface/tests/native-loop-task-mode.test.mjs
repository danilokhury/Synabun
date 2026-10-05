import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import {
  createClaudeNativeLoopAdapter,
  createCodexNativeLoopAdapter,
  createOpenCodeNativeLoopAdapter,
  codexSandboxModeFor,
  codexAgentMessageText,
  normalizeCapability,
  normalizePermissionPolicy,
  CLAUDE_READ_ONLY_DISALLOWED_TOOLS,
} from '../lib/native-loop-providers.js';

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error('Timed out waiting for condition');
};

// ── Runtime: task-mode hooks ─────────────────────────────────────────────────

test('runtime honors per-launch buildPrompt/wrapAdapter overrides and fans out to subscribers', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-task-mode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prompts = [];
  const innerAdapter = {
    identity: () => ({ providerSessionId: 'sess-inner' }),
    isAlive: () => true,
    async runTurn(prompt) { prompts.push(prompt); return { providerSessionId: 'sess-inner', text: 'ok' }; },
    async abort() {},
    async dispose() {},
  };
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'),
    ledgerPath: resolve(root, 'runs.json'),
    buildPrompt: () => 'DEFAULT PROMPT',
    iterationDelayMs: 0,
    providerFactories: { codex: async () => innerAdapter },
  });
  const seen = [];
  const unsubscribe = runtime.subscribe((message) => seen.push(message));
  let wrapCtx = null;
  const runId = 'a'.repeat(32);
  const descriptor = await runtime.launch({
    runId,
    source: 'assistant',
    state: { profile: 'codex', task: 'Task work', cwd: root, totalIterations: 1, maxMinutes: 5, runMode: 'task', assistantSessionId: 'assistant-1' },
    buildPrompt: () => 'TASK PROMPT',
    wrapAdapter: (adapter, ctx) => {
      wrapCtx = ctx;
      return {
        ...adapter,
        async runTurn(prompt, meta) {
          ctx.setTurnState('running');
          ctx.emit({ type: 'synabun.note', text: 'from-wrapper' });
          const result = await adapter.runTurn(prompt, meta);
          ctx.setTurnState('idle');
          return result;
        },
      };
    },
  });
  assert.equal(descriptor.runMode, 'task');
  assert.equal(descriptor.assistantSessionId, 'assistant-1');
  assert.equal(descriptor.focus, false, 'assistant-sourced runs do not steal focus');
  await waitFor(() => runtime.get(runId)?.status === 'completed');
  unsubscribe();
  assert.deepEqual(prompts, ['TASK PROMPT'], 'per-launch buildPrompt wins over the runtime default');
  assert.equal(typeof wrapCtx.readState, 'function');
  assert.equal(wrapCtx.runId, runId);
  const turnStates = seen.filter((m) => m.type === 'sidepanel:run-updated' && m.reason === 'turn-state').map((m) => m.run.turnState);
  assert.deepEqual(turnStates, ['running', 'idle']);
  assert.ok(seen.some((m) => m.type === 'sidepanel:provider-event' && m.event?.type === 'synabun.note'), 'wrapper emits reach subscribers');
  assert.ok(seen.some((m) => m.type === 'sidepanel:run-completed'));
  assert.equal(runtime.get(runId).turnState, 'terminal', 'terminal runs report a terminal turn state');
});

test('runtime rejects a wrapper that does not return a runnable adapter', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-task-mode-bad-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'),
    ledgerPath: resolve(root, 'runs.json'),
    buildPrompt: () => 'x',
    providerFactories: { codex: async () => ({ identity: () => ({}), isAlive: () => true, runTurn: async () => ({}), abort: async () => {}, dispose: async () => {} }) },
  });
  const runId = 'b'.repeat(32);
  await runtime.launch({ runId, state: { profile: 'codex', task: 't', cwd: root, totalIterations: 1 }, wrapAdapter: () => ({}) });
  await waitFor(() => runtime.get(runId)?.status === 'failed');
  assert.match(runtime.get(runId).error, /runnable adapter/);
});

// ── Policy helpers ────────────────────────────────────────────────────────────

test('policy and capability helpers normalize and map to Codex sandbox modes', () => {
  assert.equal(normalizePermissionPolicy('ASK'), 'ask');
  assert.equal(normalizePermissionPolicy('nonsense'), 'auto');
  assert.equal(normalizeCapability('read-only'), 'read-only');
  assert.equal(normalizeCapability(undefined), 'full');
  assert.equal(codexSandboxModeFor({ capability: 'read-only' }), 'read-only');
  assert.equal(codexSandboxModeFor({ capability: 'workspace' }), 'workspace-write');
  assert.equal(codexSandboxModeFor({ permissionPolicy: 'restricted', capability: 'full' }), 'workspace-write');
  assert.equal(codexSandboxModeFor({ permissionPolicy: 'auto', capability: 'full' }), 'danger-full-access');
  assert.equal(codexAgentMessageText({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }), 'hi');
  assert.equal(codexAgentMessageText({ type: 'item.completed', item: { type: 'command_execution' } }), null);
});

// ── Codex adapter ─────────────────────────────────────────────────────────────

test('Codex adapter captures the final agent message, usage, extra env, and sandbox from capability', async () => {
  const captured = { ctor: null, thread: null, turnOptions: [] };
  class FakeCodex {
    constructor(options) { captured.ctor = options; }
    startThread(options) {
      captured.thread = options;
      return {
        id: 'thr-1',
        async runStreamed(prompt, turnOptions) {
          captured.turnOptions.push(turnOptions);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'thr-1' };
              yield { type: 'item.completed', item: { type: 'agent_message', text: 'draft' } };
              yield { type: 'item.completed', item: { type: 'agent_message', text: '## Result\nstatus: done' } };
              yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } };
            })(),
          };
        },
      };
    }
  }
  const adapter = await createCodexNativeLoopAdapter({
    runId: 'run-1', cwd: '/tmp/project', CodexClass: FakeCodex, codexHome: '/tmp/home',
    capability: 'workspace', extraEnv: { EXTRA_FLAG: '1' }, outputSchema: { type: 'object' },
  });
  const result = await adapter.runTurn('do it');
  assert.equal(result.text, '## Result\nstatus: done');
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 4 });
  assert.equal(captured.thread.sandboxMode, 'workspace-write');
  assert.equal(captured.ctor.env.EXTRA_FLAG, '1');
  assert.equal(captured.ctor.env.CODEX_HOME, '/tmp/home');
  // Codex takes strict schemas only: the adapter sends a strict copy of the caller's.
  assert.deepEqual(captured.turnOptions[0].outputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.equal(adapter.describe().sandboxMode, 'workspace-write');
});

test('Codex adapter refuses the ask policy up front', async () => {
  class FakeCodex { startThread() { return { id: 't', async runStreamed() { return { events: (async function* () {})() }; } }; } }
  await assert.rejects(
    createCodexNativeLoopAdapter({ CodexClass: FakeCodex, permissionPolicy: 'ask' }),
    (error) => error.code === 'PERMISSION_POLICY_UNSUPPORTED',
  );
});

// ── Claude adapter ────────────────────────────────────────────────────────────

function fakeClaudeQuery(captured) {
  return ({ prompt, options }) => {
    captured.options = options;
    const iterator = (async function* () {
      let announced = false;
      for await (const message of prompt) {
        captured.prompts.push(message.message.content[0].text);
        if (!announced) { announced = true; yield { type: 'system', subtype: 'init', session_id: 'sess-claude' }; }
        yield { type: 'result', subtype: 'success', session_id: 'sess-claude', result: 'final text', total_cost_usd: 0.25, usage: { input_tokens: 3 }, structured_output: { ok: true } };
      }
    })();
    iterator.interrupt = async () => {};
    return iterator;
  };
}

test('Claude adapter merges extra env, enriches results, and applies read-only/budget/schema options', async () => {
  const captured = { options: null, prompts: [] };
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-c', cwd: '/tmp/project', queryFactory: fakeClaudeQuery(captured), mcpUrl: 'http://localhost:3344/mcp',
    resolveRuntime: () => ({ ok: true }), logWarn: () => {},
    extraEnv: { CLAUDE_CONFIG_DIR: '/tmp/acct' }, capability: 'read-only', maxBudgetUsd: 2.5,
    outputSchema: { type: 'object' }, runMode: 'task',
  });
  const result = await adapter.runTurn('work');
  assert.equal(result.text, 'final text');
  assert.equal(result.costUsd, 0.25);
  assert.deepEqual(result.structured, { ok: true });
  assert.equal(captured.options.env.CLAUDE_CONFIG_DIR, '/tmp/acct');
  assert.equal(captured.options.env.SYNABUN_RUN_MODE, 'task');
  assert.deepEqual(captured.options.disallowedTools, CLAUDE_READ_ONLY_DISALLOWED_TOOLS);
  assert.equal(captured.options.maxBudgetUsd, 2.5);
  assert.deepEqual(captured.options.outputFormat, { type: 'json_schema', schema: { type: 'object' } });
  assert.equal(captured.options.permissionMode, 'bypassPermissions');
  await adapter.dispose();
});

test('Claude adapter routes permissions and questions through the broker under the ask policy', async () => {
  const captured = { options: null, prompts: [] };
  const requests = [];
  const broker = {
    async request(request) {
      requests.push(request);
      if (request.kind === 'ask') return { behavior: 'allow', answers: { q1: 'blue' } };
      if (request.toolName === 'Bash') return { behavior: 'allow', updatedInput: { command: 'ls -la' } };
      return { behavior: 'deny', message: 'nope' };
    },
  };
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-ask', cwd: '/tmp/project', queryFactory: fakeClaudeQuery(captured),
    resolveRuntime: () => ({ ok: true }), logWarn: () => {},
    permissionPolicy: 'ask', permissionBroker: broker,
  });
  const options = captured.options;
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.equal(options.hooks.PreToolUse[0].matcher, 'ExitPlanMode');
  const bash = await options.canUseTool('Bash', { command: 'ls' });
  assert.deepEqual(bash, { behavior: 'allow', updatedInput: { command: 'ls -la' } });
  const write = await options.canUseTool('Write', { file_path: '/x' });
  assert.equal(write.behavior, 'deny');
  const ask = await options.canUseTool('AskUserQuestion', { questions: [{ id: 'q1', text: 'Color?' }] });
  assert.equal(ask.behavior, 'allow');
  assert.deepEqual(ask.updatedInput.answers, { q1: 'blue' });
  const plan = await options.canUseTool('ExitPlanMode', {});
  assert.equal(plan.behavior, 'deny');
  assert.deepEqual(requests.map((r) => [r.provider, r.kind, r.toolName]), [
    ['claude-code', 'tool', 'Bash'], ['claude-code', 'tool', 'Write'], ['claude-code', 'ask', 'AskUserQuestion'],
  ]);
  assert.equal(adapter.describe().askMode, true);
  await adapter.dispose();
});

// ── OpenCode adapter ──────────────────────────────────────────────────────────

function fakeOpenCodeClient(captured) {
  return {
    _listener: null,
    onEvent(listener) { this._listener = listener; return () => { this._listener = null; }; },
    emit(eventType, event) { this._listener?.({ eventType, event }); },
    session: {
      async create() { return { data: { id: 'oc-sess' } }; },
      async promptAsync(request) { captured.requests.push(request); return { status: 200, data: {} }; },
      async messages() { return { data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'fallback text' }] }] }; },
      async abort() {},
    },
    permission: { async reply(args) { captured.permissionReplies.push(args); return {}; } },
    question: { async reply(args) { captured.questionReplies.push(args); return {}; }, async reject(args) { captured.questionRejects.push(args); return {}; } },
  };
}

test('OpenCode adapter assembles assistant text from SSE parts and settles on session.idle', async () => {
  const captured = { requests: [], permissionReplies: [], questionReplies: [], questionRejects: [] };
  const client = fakeOpenCodeClient(captured);
  const adapter = await createOpenCodeNativeLoopAdapter({ runId: 'run-oc', cwd: '/tmp/project', client, capability: 'read-only', outputSchema: { type: 'object' } });
  const turn = adapter.runTurn('hello');
  await new Promise((r) => setTimeout(r, 5));
  client.emit('message.updated', { info: { id: 'm-user', sessionID: 'oc-sess', role: 'user' } });
  client.emit('message.part.updated', { part: { id: 'p0', messageID: 'm-user', sessionID: 'oc-sess', type: 'text', text: 'hello' } });
  client.emit('message.updated', { info: { id: 'm-asst', sessionID: 'oc-sess', role: 'assistant' } });
  client.emit('message.part.updated', { part: { id: 'p1', messageID: 'm-asst', sessionID: 'oc-sess', type: 'text', text: 'partial' } });
  client.emit('message.part.updated', { part: { id: 'p1', messageID: 'm-asst', sessionID: 'oc-sess', type: 'text', text: 'partial complete' } });
  client.emit('session.idle', { sessionID: 'oc-sess' });
  const result = await turn;
  assert.equal(result.text, 'partial complete');
  assert.equal(captured.requests[0].agent, 'plan', 'read-only capability uses the plan agent');
  assert.deepEqual(captured.requests[0].format, { type: 'json_schema', schema: { type: 'object' } });
  await adapter.dispose();
});

test('OpenCode adapter falls back to session.messages when no text streamed, and relays ask-mode prompts', async () => {
  const captured = { requests: [], permissionReplies: [], questionReplies: [], questionRejects: [] };
  const client = fakeOpenCodeClient(captured);
  const brokerCalls = [];
  const broker = {
    async request(request) {
      brokerCalls.push(request);
      if (request.kind === 'tool') return { behavior: 'allow', always: true };
      return { behavior: 'allow', answers: [['yes']] };
    },
  };
  const adapter = await createOpenCodeNativeLoopAdapter({ runId: 'run-oc2', cwd: '/tmp/project', client, permissionPolicy: 'ask', permissionBroker: broker });
  const turn = adapter.runTurn('hello');
  await new Promise((r) => setTimeout(r, 5));
  client.emit('permission.asked', { id: 'perm-1', sessionID: 'oc-sess', permission: 'edit' });
  client.emit('question.asked', { id: 'q-1', sessionID: 'oc-sess', questions: [{ question: 'Proceed?' }] });
  await waitFor(() => captured.permissionReplies.length === 1 && captured.questionReplies.length === 1);
  assert.equal(captured.permissionReplies[0].reply, 'always');
  assert.deepEqual(captured.questionReplies[0].answers, [['yes']]);
  assert.equal(brokerCalls[0].provider, 'opencode');
  client.emit('session.idle', { sessionID: 'oc-sess' });
  const result = await turn;
  assert.equal(result.text, 'fallback text');
  assert.equal(captured.requests[0].agent, 'build');
  await adapter.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClaudeNativeLoopAdapter,
  createCodexNativeLoopAdapter,
  createOpenCodeNativeLoopAdapter,
  normalizeOpenCodeModel,
} from '../lib/native-loop-providers.js';
import { alignedClaudeExecutable, clearClaudeModelCache } from '../lib/claude-model-catalog.js';

test('Codex adapter keeps one thread and injects exact loop pins', async () => {
  const captured = { ctor: null, thread: null, prompts: [], events: [] };
  class FakeCodex {
    constructor(options) { captured.ctor = options; }
    startThread(options) {
      captured.thread = options;
      return {
        id: 'thr-native',
        async runStreamed(prompt) {
          captured.prompts.push(prompt);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'thr-native' };
              yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
            })(),
          };
        },
      };
    }
  }
  const adapter = await createCodexNativeLoopAdapter({
    runId: 'run-codex', cwd: '/tmp/project', model: 'gpt-5.4', effort: 'max',
    codexHome: '/tmp/codex-home', browserSessionId: 'browser-1', browserTabId: 'tab-1',
    mcpProfile: 'twitter', CodexClass: FakeCodex,
    onEvent: (event) => captured.events.push(event),
  });
  await adapter.runTurn('first');
  await adapter.runTurn('second');
  assert.deepEqual(captured.prompts, ['first', 'second']);
  assert.equal(captured.thread.modelReasoningEffort, 'max', 'max reaches Codex unchanged (no longer lowered to xhigh)');
  assert.equal(captured.thread.sandboxMode, 'danger-full-access');
  assert.equal(captured.ctor.env.CODEX_HOME, '/tmp/codex-home');
  assert.deepEqual(captured.ctor.config.mcp_servers.SynaBun.env, {
    SYNABUN_TERMINAL_SESSION: 'run-codex',
    SYNABUN_PROJECT: 'project',
    SYNABUN_BROWSER_SESSION: 'browser-1',
    SYNABUN_BROWSER_TAB: 'tab-1',
    SYNABUN_PROFILE: 'twitter',
    SYNABUN_TOOL_CATALOG_MODE: 'deferred',
  });
  assert.equal(adapter.identity().providerThreadId, 'thr-native');
  assert.deepEqual(
    captured.events.filter((entry) => entry.event?.type === 'synabun.user_prompt').map((entry) => entry.event.text),
    ['first', 'second'],
  );
  // Each turn is a fresh `codex exec` (items restart at item_0): every event names its turn.
  assert.deepEqual(captured.events.map((entry) => [entry.providerTurn, entry.event.type]), [
    [1, 'synabun.user_prompt'], [1, 'thread.started'], [1, 'turn.completed'],
    [2, 'synabun.user_prompt'], [2, 'thread.started'], [2, 'turn.completed'],
  ]);
});

test('Codex adapter rejects a stream that ends without turn.completed', async () => {
  class IncompleteCodex {
    startThread() {
      return {
        id: 'thr-incomplete',
        async runStreamed() {
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'thr-incomplete' };
            })(),
          };
        },
      };
    }
  }
  const adapter = await createCodexNativeLoopAdapter({ CodexClass: IncompleteCodex });
  await assert.rejects(adapter.runTurn('work'), /before turn\.completed/);
});

test('Codex adapter survives U+2028 in command output (the SDK reads its JSON lines with readline)', async () => {
  const output = '{"s":"line1 é 👩‍👩‍👧 \u2028"}';
  // Like @openai/codex-sdk: one exec shared by every thread, lines from readline, JSON.parse each.
  class SplittingCodex {
    constructor() {
      this.exec = {
        async *run() {
          const lines = [
            { type: 'thread.started', thread_id: 'thr-sep' },
            { type: 'item.completed', item: { id: 'item_4', type: 'command_execution', command: 'self-test', aggregated_output: output, exit_code: 0, status: 'completed' } },
            { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
          ].map((event) => JSON.stringify(event)).join('\n');
          for (const piece of lines.split(/\n|\u2028|\u2029/)) yield piece; // what readline hands the SDK
        },
      };
    }
    startThread() {
      const exec = this.exec;
      return {
        id: 'thr-sep',
        async runStreamed() {
          return {
            events: (async function* () {
              for await (const item of exec.run({})) {
                let parsed;
                try { parsed = JSON.parse(item); } catch (error) { throw new Error(`Failed to parse item: ${item}`, { cause: error }); }
                yield parsed;
              }
            })(),
          };
        },
      };
    }
  }
  const events = [];
  const adapter = await createCodexNativeLoopAdapter({ CodexClass: SplittingCodex, onEvent: (entry) => events.push(entry.event) });
  await adapter.runTurn('run the self-test');
  const done = events.find((event) => event?.type === 'item.completed');
  assert.equal(done?.item?.aggregated_output, output, 'the split item arrives whole');
});

test('Claude adapter reuses one streaming query with unattended permissions and headers', async (t) => {
  const inheritedEnv = {
    CLAUDECODE: process.env.CLAUDECODE,
    VSCODE_TEST: process.env.VSCODE_TEST,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
  };
  process.env.CLAUDECODE = '1';
  process.env.VSCODE_TEST = 'nested-editor';
  process.env.TERM_PROGRAM = 'vscode';
  t.after(() => {
    for (const [key, value] of Object.entries(inheritedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let factoryCalls = 0;
  let queryOptions;
  const prompts = [];
  const providerEvents = [];
  const queryFactory = ({ prompt, options }) => {
    factoryCalls++;
    queryOptions = options;
    const generator = (async function* () {
      let initialized = false;
      for await (const message of prompt) {
        prompts.push(message.message.content[0].text);
        if (!initialized) {
          initialized = true;
          yield { type: 'system', subtype: 'init', session_id: 'claude-native' };
        }
        yield { type: 'result', subtype: 'success', session_id: 'claude-native', result: 'done' };
      }
    })();
    generator.interrupt = async () => {};
    return generator;
  };
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-claude', cwd: '/tmp/project', effort: 'max', browserSessionId: 'browser-2',
    browserTabId: 'tab-2', mcpUrl: 'http://localhost:3344/mcp', queryFactory,
    includePartialMessages: false,
    onEvent: (event) => providerEvents.push(event),
  });
  await adapter.runTurn('first');
  await adapter.runTurn('second');
  assert.equal(factoryCalls, 1);
  assert.deepEqual(prompts, ['first', 'second']);
  assert.equal(queryOptions.permissionMode, 'bypassPermissions');
  assert.equal(queryOptions.allowDangerouslySkipPermissions, true);
  assert.equal(queryOptions.env.SYNABUN_TERMINAL_SESSION, 'run-claude');
  assert.equal(queryOptions.env.SYNABUN_BROWSER_TAB, 'tab-2');
  assert.equal(queryOptions.env.CLAUDECODE, undefined);
  assert.equal(queryOptions.env.VSCODE_TEST, undefined);
  assert.equal(queryOptions.env.TERM_PROGRAM, undefined);
  assert.equal(queryOptions.includePartialMessages, false);
  assert.equal(queryOptions.effort, 'max');
  assert.deepEqual(queryOptions.mcpServers.SynaBun.headers, {
    'X-Synabun-Terminal': 'run-claude',
    'X-Synabun-Project': 'project',
    'X-Synabun-Memory-Session': 'run-claude',
    'X-Synabun-Browser-Session': 'browser-2',
    'X-Synabun-Browser-Tab': 'tab-2',
  });
  assert.equal((await queryOptions.canUseTool('AskUserQuestion', {})).behavior, 'deny');
  const hookResult = await queryOptions.hooks.PreToolUse[0].hooks[0]();
  assert.equal(hookResult.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(adapter.identity().providerSessionId, 'claude-native');
  assert.deepEqual(
    providerEvents.filter((entry) => entry.event?.type === 'synabun.user_prompt').map((entry) => entry.event.text),
    ['first', 'second'],
  );
  await adapter.dispose();
});

test('Claude adapter marks a dead query closed and rejects future turns immediately', async () => {
  const queryFactory = ({ prompt }) => {
    const generator = (async function* () {
      for await (const _message of prompt) throw new Error('query pump died');
    })();
    generator.interrupt = async () => {};
    return generator;
  };
  const adapter = await createClaudeNativeLoopAdapter({ queryFactory });
  await assert.rejects(adapter.runTurn('first'), /query pump died/);
  assert.equal(adapter.isAlive(), false);
  await assert.rejects(adapter.runTurn('second'), /closed/);
});

test('OpenCode adapter creates once, reuses the session, and never deletes transcript', async () => {
  const calls = { create: [], prompt: [], questions: [], readiness: 0, abort: 0, release: 0, delete: 0 };
  const listeners = new Set();
  const client = {
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async waitUntilConnected() { calls.readiness++; },
    session: {
      async create(params) { calls.create.push(params); return { data: { id: 'ses-native' } }; },
      async prompt(params) { calls.prompt.push(params); return { status: 200, data: {} }; },
      async abort() { calls.abort++; },
      async delete() { calls.delete++; },
    },
    question: { async reject(params) { calls.questions.push(params); } },
  };
  const adapter = await createOpenCodeNativeLoopAdapter({
    runId: 'run-ocp', cwd: '/tmp/project', title: 'Scheduled work',
    model: 'anthropic/claude-sonnet-4-6', client,
    release: async () => { calls.release++; },
  });
  await adapter.runTurn('first');
  await adapter.runTurn('second');
  assert.deepEqual(calls.create, [{ directory: '/tmp/project', title: 'Scheduled work' }]);
  assert.equal(calls.prompt.length, 2);
  assert.equal(calls.readiness, 3, 'event stream is ready before session creation and each prompt');
  assert.equal(calls.prompt[0].sessionID, 'ses-native');
  assert.deepEqual(calls.prompt[0].model, { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
  assert.equal(calls.prompt[0].agent, 'build');
  for (const listener of listeners) {
    listener({ eventType: 'question.asked', event: { id: 'question-1', sessionID: 'ses-native' } });
  }
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(calls.questions, [{ requestID: 'question-1', directory: '/tmp/project' }]);
  await adapter.dispose();
  assert.equal(calls.release, 1);
  assert.equal(calls.delete, 0);
  assert.deepEqual(normalizeOpenCodeModel('bad-model'), undefined);
});

test('OpenCode adapter uses promptAsync and completes from the owned session idle event', async () => {
  const listeners = new Set();
  const calls = { prompt: 0, promptAsync: 0 };
  const client = {
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async waitUntilConnected() {},
    session: {
      async create() { return { data: { id: 'ses-async' } }; },
      async prompt() { calls.prompt++; throw new Error('synchronous prompt must not be used'); },
      async promptAsync() {
        calls.promptAsync++;
        setTimeout(() => {
          for (const listener of listeners) {
            listener({ eventType: 'session.idle', event: { sessionID: 'foreign-session' } });
            listener({ eventType: 'session.idle', event: { sessionID: 'ses-async' } });
          }
        }, 10);
        return { status: 204 };
      },
      async abort() {},
    },
  };
  const adapter = await createOpenCodeNativeLoopAdapter({ client });
  const turnResult = await adapter.runTurn('long browser task');
  assert.equal(turnResult.providerSessionId, 'ses-async');
  assert.equal(turnResult.text, '', 'no assistant text streamed for this turn');
  assert.equal(calls.promptAsync, 1);
  assert.equal(calls.prompt, 0);
  await adapter.dispose();
});

test('OpenCode async session errors fail the active turn without waiting for a fetch timeout', async () => {
  const listeners = new Set();
  const client = {
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async waitUntilConnected() {},
    session: {
      async create() { return { data: { id: 'ses-async-error' } }; },
      async promptAsync() {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              eventType: 'session.error',
              event: { sessionID: 'ses-async-error', error: { message: 'provider disconnected' } },
            });
          }
        });
        return { status: 204 };
      },
      async abort() {},
    },
  };
  const adapter = await createOpenCodeNativeLoopAdapter({ client });
  await assert.rejects(adapter.runTurn('work'), /provider disconnected/);
  await adapter.dispose();
});

test('OpenCode adapter treats an SDK error response as a failed turn', async () => {
  const client = {
    onEvent() { return () => {}; },
    session: {
      async create() { return { data: { id: 'ses-error' } }; },
      async prompt() { return { status: 500, error: { message: 'model unavailable' } }; },
      async abort() {},
    },
  };
  const adapter = await createOpenCodeNativeLoopAdapter({ client });
  await assert.rejects(adapter.runTurn('work'), /model unavailable/);
  await adapter.dispose();
});

test('OpenCode adapter treats HTTP 200 assistant errors as failed turns', async () => {
  const client = {
    onEvent() { return () => {}; },
    session: {
      async create() { return { data: { id: 'ses-assistant-error' } }; },
      async prompt() {
        return {
          status: 200,
          data: { info: { error: { name: 'ProviderAuthError', data: { message: 'authentication expired' } } } },
        };
      },
      async abort() {},
    },
  };
  const adapter = await createOpenCodeNativeLoopAdapter({ client });
  await assert.rejects(adapter.runTurn('work'), /authentication expired/);
  await adapter.dispose();
});

// ── Claude native binary runtime selection ──────────────────────────────────

// Minimal query stub: the adapter only needs an async generator with interrupt().
function stubQueryFactory(capture) {
  return ({ prompt, options }) => {
    capture.options = options;
    const generator = (async function* () {
      for await (const _ of prompt) {
        yield { type: 'result', subtype: 'success', session_id: 's', result: 'ok' };
      }
    })();
    generator.interrupt = async () => {};
    return generator;
  };
}

test('Claude loop adapter leaves the SDK to resolve when the bundled runtime is healthy', async () => {
  const capture = {};
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-ok',
    queryFactory: stubQueryFactory(capture),
    resolveRuntime: () => ({ ok: true, state: 'ok', path: '/nm/claude' }),
    claudeBin: '/usr/local/bin/claude',
    logWarn: () => {},
  });
  await adapter.runTurn('go');
  assert.equal(capture.options.pathToClaudeCodeExecutable, undefined,
    'a healthy runtime must not be overridden — the SDK resolves for itself');
  await adapter.dispose();
});

test('Claude loop adapter falls back to the installed CLI when the bundled binary is unusable', async () => {
  const capture = {};
  const warnings = [];
  // process.execPath stands in for the user's global CLI: a real, launchable
  // native binary. The fallback is validated against the filesystem, so a path
  // that does not exist is correctly refused (see the bare-name test below).
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-broken',
    queryFactory: stubQueryFactory(capture),
    resolveRuntime: () => ({ ok: false, state: 'chmod-failed', reason: 'read-only install' }),
    claudeBin: process.execPath,
    logWarn: (m) => warnings.push(m),
  });
  await adapter.runTurn('go');
  assert.equal(capture.options.pathToClaudeCodeExecutable, process.execPath);
  assert.match(warnings.join('\n'), /chmod-failed/);
  await adapter.dispose();
});

test('Claude loop adapter refuses a fallback CLI path that does not exist', async () => {
  const capture = {};
  const warnings = [];
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-ghost',
    queryFactory: stubQueryFactory(capture),
    resolveRuntime: () => ({ ok: false, state: 'not-installed', reason: 'nothing installed' }),
    claudeBin: '/definitely/not/here/claude',
    logWarn: (m) => warnings.push(m),
  });
  await adapter.runTurn('go');
  assert.equal(capture.options.pathToClaudeCodeExecutable, undefined,
    'a non-existent fallback must not be handed to the SDK');
  assert.match(warnings.join('\n'), /no launchable/i);
  await adapter.dispose();
});

test('Claude loop adapter refuses a bare command name as a fallback', async () => {
  // getClaudeBin()'s last resort is the literal string 'claude'; the SDK spawns
  // with shell:false, so handing that over would ENOENT instead of failing loudly.
  const capture = {};
  const warnings = [];
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-bare',
    queryFactory: stubQueryFactory(capture),
    resolveRuntime: () => ({ ok: false, state: 'not-installed', reason: 'nothing installed' }),
    claudeBin: 'claude',
    logWarn: (m) => warnings.push(m),
  });
  await adapter.runTurn('go');
  assert.equal(capture.options.pathToClaudeCodeExecutable, undefined);
  assert.match(warnings.join('\n'), /no launchable/i);
  await adapter.dispose();
});

test('Claude loop adapter honours a valid explicit override without probing the runtime', async () => {
  const capture = {};
  let probed = false;
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-override',
    queryFactory: stubQueryFactory(capture),
    sdkExecutable: new URL('./native-loop-providers.test.mjs', import.meta.url).pathname,
    resolveRuntime: () => { probed = true; return { ok: true, state: 'ok' }; },
    logWarn: () => {},
  });
  await adapter.runTurn('go');
  // The test file itself is a .mjs — a "script" override, accepted on existence
  // alone and launched via node, exactly as the SDK would.
  assert.ok(capture.options.pathToClaudeCodeExecutable?.endsWith('native-loop-providers.test.mjs'));
  assert.equal(probed, false, 'an accepted override short-circuits the runtime probe');
  await adapter.dispose();
});

// ── Alignment: the installed CLI is newer than the bundled one ──
// The loop's model was picked from the installed CLI's list; the bundled binary
// would resolve the same alias to an older model.

test('Claude loop adapter runs the aligned installed CLI instead of the bundled one', async () => {
  const capture = {};
  let probed = false;
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-aligned',
    queryFactory: stubQueryFactory(capture),
    resolveRuntime: () => { probed = true; return { ok: true, state: 'ok' }; },
    alignedClaudeBin: process.execPath,
    logWarn: () => {},
  });
  await adapter.runTurn('go');
  assert.equal(capture.options.pathToClaudeCodeExecutable, process.execPath);
  assert.equal(probed, false, 'the bundled runtime is not consulted when the aligned CLI runs');
  await adapter.dispose();
});

test('Claude loop adapter keeps the bundled runtime when the aligned CLI is not launchable', async () => {
  const capture = {};
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-aligned-ghost',
    queryFactory: stubQueryFactory(capture),
    resolveRuntime: () => ({ ok: true, state: 'ok' }),
    alignedClaudeBin: '/definitely/not/here/claude',
    logWarn: () => {},
  });
  await adapter.runTurn('go');
  assert.equal(capture.options.pathToClaudeCodeExecutable, undefined,
    'a path that cannot launch must never be handed to the SDK');
  await adapter.dispose();
});

test('an explicit sdkExecutable override outranks the aligned CLI', async () => {
  const capture = {};
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-override-vs-aligned',
    queryFactory: stubQueryFactory(capture),
    sdkExecutable: new URL('./native-loop-providers.test.mjs', import.meta.url).pathname,
    alignedClaudeBin: process.execPath,
    logWarn: () => {},
  });
  await adapter.runTurn('go');
  assert.ok(capture.options.pathToClaudeCodeExecutable?.endsWith('native-loop-providers.test.mjs'));
  await adapter.dispose();
});

test('an aligned CLI that fails to launch sends later runs back to the bundled runtime', async () => {
  clearClaudeModelCache();
  const skew = { skewed: true, installedNewer: true };
  assert.equal(alignedClaudeExecutable(process.execPath, { skew }), process.execPath);
  const adapter = await createClaudeNativeLoopAdapter({
    runId: 'run-aligned-broken',
    queryFactory: () => {
      const generator = (async function* () {
        throw Object.assign(new Error(`spawn ${process.execPath} ENOENT`), { code: 'ENOENT' });
      })();
      generator.interrupt = async () => {};
      return generator;
    },
    alignedClaudeBin: process.execPath,
    logWarn: () => {},
  });
  await assert.rejects(adapter.runTurn('go'));
  assert.equal(alignedClaudeExecutable(process.execPath, { skew }), null,
    'a launch failure latches the aligned CLI off for this process');
  await adapter.dispose();
  clearClaudeModelCache();
});

test('Claude adapter resolves each turn with its own charge beside the CLI running total', async () => {
  const totals = [7.8659074, 7.9881174, 8.1];
  const queryFactory = ({ prompt }) => {
    const generator = (async function* () {
      let n = 0;
      for await (const _message of prompt) {
        const total = totals[n];
        n += 1;
        if (n === 3) yield { type: 'result', subtype: 'error_max_budget_usd', session_id: 'warm', total_cost_usd: total, usage: { output_tokens: 1 }, errors: ['budget'] };
        else yield { type: 'result', subtype: 'success', session_id: 'warm', result: 'ok', total_cost_usd: total };
      }
    })();
    generator.interrupt = async () => {};
    return generator;
  };
  const adapter = await createClaudeNativeLoopAdapter({ queryFactory, resolveRuntime: () => ({ ok: true, state: 'ok' }), includePartialMessages: false });
  const first = await adapter.runTurn('one');
  const second = await adapter.runTurn('two');
  assert.deepEqual([first.costUsd, first.totalCostUsd], [7.8659074, 7.8659074]);
  assert.deepEqual([second.costUsd, second.totalCostUsd], [0.12221, 7.9881174]);
  const capped = await adapter.runTurn('three').catch((error) => error);
  assert.equal(capped.code, 'BUDGET_CAP');
  assert.equal(capped.costUsd, 0.1118826);
  assert.deepEqual(capped.usage, { output_tokens: 1 });
  await adapter.dispose();
});

test('OpenCode adapter forwards a child session\'s usage events only, and exposes the stored rows for the usage meter', async () => {
  const listeners = new Set();
  const say = (eventType, event) => { for (const listener of listeners) listener({ eventType, event }); };
  const events = [];
  const replies = [];
  let stored = { data: [{ info: { id: 'msg-1', sessionID: 'ses-own', role: 'assistant' } }] };
  const client = {
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async waitUntilConnected() {},
    session: {
      async create() { return { data: { id: 'ses-own' } }; },
      async promptAsync() {
        setTimeout(() => {
          say('session.created', { info: { id: 'ses-child', parentID: 'ses-own' } });
          say('message.updated', { info: { id: 'msg-c1', sessionID: 'ses-child', role: 'assistant', tokens: { input: 10, output: 1 } } });
          say('message.part.updated', { part: { id: 'part-c1', messageID: 'msg-c1', sessionID: 'ses-child', type: 'text', text: 'child text' } });
          say('permission.asked', { id: 'perm-child', sessionID: 'ses-child' });
          say('session.idle', { sessionID: 'ses-child' });
          say('message.updated', { info: { id: 'msg-1', sessionID: 'ses-own', role: 'assistant' } });
          say('session.idle', { sessionID: 'ses-own' });
        }, 5);
        return { status: 204 };
      },
      async children(params) { return { data: [{ id: 'ses-child', parentID: params.sessionID }] }; },
      async messages() { return stored; },
      async abort() {},
    },
    permission: { async reply(params) { replies.push(params); } },
  };
  const adapter = await createOpenCodeNativeLoopAdapter({ runId: 'run-child', cwd: '/tmp/project', client, onEvent: (event) => events.push(event) });
  const result = await adapter.runTurn('delegate it');
  assert.equal(result.text, '', 'a child session\'s text is not the run\'s answer');
  assert.deepEqual(replies, [], 'a child session\'s permission is not answered by the run');
  assert.deepEqual(events.map((event) => [event.eventType, !!event.childSession]), [
    ['session.created', true], ['message.updated', true], ['message.updated', false], ['session.idle', false],
  ]);
  const fetchers = adapter.usageFetchers();
  assert.deepEqual(await fetchers.children('ses-own'), [{ id: 'ses-child', parentID: 'ses-own' }]);
  assert.equal((await fetchers.messages('ses-own'))[0].info.id, 'msg-1');
  // A failed read throws, so the caller knows the turn was not reconciled.
  stored = { error: { message: 'not found' } };
  await assert.rejects(fetchers.messages('ses-own'), /not found/);
  delete client.session.children;
  await assert.rejects(fetchers.children('ses-own'), /not available/);
  await adapter.dispose();
});

// ── Codex output schemas (strict response_format) ──
import { dropOptionalNulls, strictCodexSchema } from '../lib/native-loop-providers.js';

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['status', 'findings'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'high'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file'],
        properties: { file: { type: 'string' }, line: { type: 'integer' }, fix: { type: 'object', properties: { patch: { type: 'string' } } } },
      },
    },
    verdict: { anyOf: [{ type: 'object', properties: { ok: { type: 'boolean' } } }, { type: 'string' }] },
  },
};

test('strictCodexSchema: every object is closed and requires all its properties; optional ones accept null; the caller\'s schema is untouched', () => {
  const original = structuredClone(FINDINGS_SCHEMA);
  const strict = strictCodexSchema(FINDINGS_SCHEMA);
  assert.deepEqual(FINDINGS_SCHEMA, original, 'normalized on a copy');
  assert.deepEqual([strict.additionalProperties, strict.required], [false, ['status', 'summary', 'severity', 'findings', 'verdict']]);
  // Required in the original: left as they are.
  assert.deepEqual(strict.properties.status, { type: 'string', enum: ['done', 'blocked'] });
  assert.equal(strict.properties.findings.type, 'array');
  // Optional in the original: a scalar widens its type, an enum gets null as its own branch.
  assert.deepEqual(strict.properties.summary, { type: ['string', 'null'] });
  assert.deepEqual(strict.properties.severity, { anyOf: [{ type: 'string', enum: ['low', 'high'] }, { type: 'null' }] });
  // Nested: array items, an object inside them, and the branches of a union.
  const item = strict.properties.findings.items;
  assert.deepEqual([item.additionalProperties, item.required], [false, ['file', 'line', 'fix']]);
  assert.deepEqual([item.properties.file, item.properties.line], [{ type: 'string' }, { type: ['integer', 'null'] }]);
  assert.deepEqual(item.properties.fix, { anyOf: [{ type: 'object', properties: { patch: { type: ['string', 'null'] } }, required: ['patch'], additionalProperties: false }, { type: 'null' }] });
  assert.deepEqual(strict.properties.verdict.anyOf, [
    { type: 'object', properties: { ok: { type: ['boolean', 'null'] } }, required: ['ok'], additionalProperties: false },
    { type: 'string' },
    { type: 'null' },
  ]);
  // An object with no properties is closed too; a schema that is already strict stays the same.
  assert.deepEqual(strictCodexSchema({ type: 'object' }), { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(strictCodexSchema(strict), strict);
});

test('dropOptionalNulls: a null in a field the caller left optional is dropped, at every depth', () => {
  const answer = {
    status: 'done', summary: null, severity: null,
    findings: [{ file: 'a.js', line: null, fix: { patch: null } }, { file: 'b.js', line: 7, fix: null }],
    verdict: { ok: null },
  };
  assert.deepEqual(dropOptionalNulls(answer, FINDINGS_SCHEMA), {
    status: 'done',
    findings: [{ file: 'a.js', fix: {} }, { file: 'b.js', line: 7 }],
    verdict: {},
  });
  // A null the caller's own schema requires is an answer, not an omission.
  assert.deepEqual(dropOptionalNulls({ status: null, findings: [] }, FINDINGS_SCHEMA), { status: null, findings: [] });
});

test('Codex adapter sends a strict copy of the output schema and returns the answer without the optional nulls', async () => {
  const sent = [];
  class SchemaCodex {
    startThread() {
      return {
        id: 'thr-schema',
        async runStreamed(prompt, turnOptions) {
          sent.push(turnOptions.outputSchema || null);
          return {
            events: (async function* () {
              yield { type: 'item.completed', item: { type: 'agent_message', text: '{"status":"done","summary":null,"severity":null,"findings":[{"file":"a.js","line":null,"fix":null}],"verdict":null}' } };
              yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
            })(),
          };
        },
      };
    }
  }
  const original = structuredClone(FINDINGS_SCHEMA);
  const adapter = await createCodexNativeLoopAdapter({ CodexClass: SchemaCodex });
  const result = await adapter.runTurn('review', { outputSchema: FINDINGS_SCHEMA });
  assert.deepEqual(FINDINGS_SCHEMA, original);
  // The raw schema failed the turn in seconds: "Invalid schema for response_format".
  assert.deepEqual(sent[0], strictCodexSchema(FINDINGS_SCHEMA));
  assert.equal(sent[0].additionalProperties, false);
  assert.deepEqual(result.structured, { status: 'done', findings: [{ file: 'a.js' }] });
  assert.match(result.text, /"summary":null/, 'the message itself is returned as it was written');
  // No schema: nothing is sent, and a JSON message is not read as structured output.
  const plain = await adapter.runTurn('again');
  assert.deepEqual([sent[1], plain.structured], [null, undefined]);
});

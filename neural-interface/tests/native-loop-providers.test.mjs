import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClaudeNativeLoopAdapter,
  createCodexNativeLoopAdapter,
  createOpenCodeNativeLoopAdapter,
  normalizeOpenCodeModel,
} from '../lib/native-loop-providers.js';

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
  assert.equal(captured.thread.modelReasoningEffort, 'xhigh');
  assert.equal(captured.thread.sandboxMode, 'danger-full-access');
  assert.equal(captured.ctor.env.CODEX_HOME, '/tmp/codex-home');
  assert.deepEqual(captured.ctor.config.mcp_servers.SynaBun.env, {
    SYNABUN_TERMINAL_SESSION: 'run-codex',
    SYNABUN_BROWSER_SESSION: 'browser-1',
    SYNABUN_BROWSER_TAB: 'tab-1',
    SYNABUN_PROFILE: 'twitter',
  });
  assert.equal(adapter.identity().providerThreadId, 'thr-native');
  assert.deepEqual(
    captured.events.filter((entry) => entry.event?.type === 'synabun.user_prompt').map((entry) => entry.event.text),
    ['first', 'second'],
  );
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
  assert.deepEqual(await adapter.runTurn('long browser task'), { providerSessionId: 'ses-async' });
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

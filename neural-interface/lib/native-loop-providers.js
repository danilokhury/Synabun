import { Codex } from '@openai/codex-sdk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_EFFORT_LEVELS } from './claude-model-catalog.js';
import { dirname } from 'node:path';

function stringEnv(source) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

function cleanClaudeEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (key === 'CLAUDECODE' || key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') continue;
    if (key.startsWith('VSCODE_')) continue;
    env[key] = value;
  }
  env.ENABLE_TOOL_SEARCH = 'true';
  return env;
}

async function settleWithin(promise, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolveWait) => { timer = setTimeout(resolveWait, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createInputQueue() {
  const values = [];
  let wake = null;
  let closed = false;
  return {
    push(value) {
      if (closed) return false;
      values.push(value);
      if (wake) { const resolveWake = wake; wake = null; resolveWake(); }
      return true;
    },
    close() {
      closed = true;
      if (wake) { const resolveWake = wake; wake = null; resolveWake(); }
    },
    async *[Symbol.asyncIterator]() {
      while (!closed || values.length) {
        while (values.length) yield values.shift();
        if (closed) return;
        await new Promise((resolveWake) => { wake = resolveWake; });
      }
    },
  };
}

function asAbortError(reason = 'aborted') {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}

function providerErrorMessage(error, fallback = 'Provider request failed') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  return error?.data?.message || error?.message || error?.name || fallback;
}

export function normalizeCodexEffort(effort) {
  const value = String(effort || '').trim().toLowerCase();
  if (!value || value === 'off') return undefined;
  if (value === 'max') return 'xhigh';
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value) ? value : undefined;
}

export function normalizeOpenCodeModel(model) {
  if (!model) return undefined;
  if (typeof model === 'object') return model;
  const value = String(model).trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

/** Create one durable Codex SDK thread and reuse it for every loop iteration. */
export async function createCodexNativeLoopAdapter(options = {}) {
  const {
    runId, cwd, model, effort, codexHome, codexPath, browserSessionId,
    browserTabId, mcpProfile, onIdentity = () => {}, onEvent = () => {},
    CodexClass = Codex,
  } = options;
  const pins = stringEnv({
    SYNABUN_TERMINAL_SESSION: runId,
    SYNABUN_BROWSER_SESSION: browserSessionId,
    SYNABUN_BROWSER_TAB: browserTabId,
    SYNABUN_PROFILE: mcpProfile,
  });
  const env = stringEnv({ ...process.env, ...pins, CODEX_HOME: codexHome });
  const config = {};
  if (Object.keys(pins).length) config.mcp_servers = { SynaBun: { env: pins } };
  const codex = new CodexClass({
    ...(codexPath ? { codexPathOverride: codexPath } : {}),
    env,
    config,
  });
  const parent = dirname(cwd || process.cwd());
  const thread = codex.startThread({
    workingDirectory: cwd || process.cwd(),
    model: model || undefined,
    modelReasoningEffort: normalizeCodexEffort(effort),
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    skipGitRepoCheck: true,
    networkAccessEnabled: true,
    additionalDirectories: parent && parent !== cwd ? [parent] : undefined,
  });
  let alive = true;
  let activeAbort = null;
  let activeTurn = null;

  return {
    identity: () => ({ providerThreadId: thread.id, providerSessionId: thread.id }),
    isAlive: () => alive,
    async runTurn(prompt, meta = {}) {
      if (!alive) throw new Error('Codex native loop is closed');
      if (activeTurn) throw new Error('Codex native loop already has an active turn');
      onEvent({
        provider: 'codex',
        runId,
        iteration: meta.iteration,
        event: { type: 'synabun.user_prompt', text: String(prompt || '') },
      });
      activeAbort = new AbortController();
      activeTurn = (async () => {
        const streamed = await thread.runStreamed(prompt, { signal: activeAbort.signal });
        let failure = null;
        let completed = false;
        for await (const event of streamed.events) {
          if (event?.type === 'thread.started' && event.thread_id) {
            onIdentity({ providerThreadId: event.thread_id, providerSessionId: event.thread_id });
          }
          if (event?.type === 'turn.failed') failure = event.error?.message || 'Codex turn failed';
          if (event?.type === 'turn.completed') completed = true;
          if (event?.type === 'error') failure = event.message || 'Codex stream failed';
          onEvent({ provider: 'codex', runId, iteration: meta.iteration, event });
        }
        if (failure) throw new Error(failure);
        if (!completed) throw new Error('Codex stream ended before turn.completed');
        const identity = { providerThreadId: thread.id, providerSessionId: thread.id };
        onIdentity(identity);
        return identity;
      })();
      try { return await activeTurn; }
      finally { activeTurn = null; activeAbort = null; }
    },
    async abort(reason = 'aborted') {
      if (activeAbort) activeAbort.abort(asAbortError(reason));
      return true;
    },
    async dispose() {
      alive = false;
      if (activeAbort) activeAbort.abort(asAbortError('disposed'));
    },
  };
}

/** Create one streaming-input Claude Agent SDK query for the whole loop. */
export async function createClaudeNativeLoopAdapter(options = {}) {
  const {
    runId, cwd, model, effort, browserSessionId, browserTabId,
    mcpUrl, onIdentity = () => {}, onEvent = () => {}, queryFactory = claudeQuery,
    sdkExecutable, includePartialMessages = process.platform !== 'win32',
  } = options;
  const input = createInputQueue();
  const abortController = new AbortController();
  let alive = true;
  let sessionId = null;
  let activeTurn = null;
  const env = stringEnv({
    ...cleanClaudeEnvironment(),
    SYNABUN_TERMINAL_SESSION: runId,
    SYNABUN_PROFILE: 'full',
    SYNABUN_BROWSER_SESSION: browserSessionId,
    SYNABUN_BROWSER_TAB: browserTabId,
  });
  const headers = stringEnv({
    'X-Synabun-Terminal': runId,
    'X-Synabun-Browser-Session': browserSessionId,
    'X-Synabun-Browser-Tab': browserTabId,
  });
  const queryOptions = {
    cwd: cwd || process.cwd(),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: !!includePartialMessages,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    hooks: {
      PreToolUse: [{
        matcher: 'AskUserQuestion|ExitPlanMode',
        hooks: [async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Unattended native loops cannot wait for interactive input.',
          },
        })],
      }],
    },
    env,
    abortController,
    canUseTool: async (toolName, toolInput) => {
      if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
        return { behavior: 'deny', message: 'This unattended automation cannot wait for interactive input.' };
      }
      return { behavior: 'allow', updatedInput: toolInput };
    },
  };
  if (mcpUrl) queryOptions.mcpServers = { SynaBun: { type: 'http', url: mcpUrl, headers } };
  if (model) queryOptions.model = model;
  if (effort && CLAUDE_EFFORT_LEVELS.includes(effort)) queryOptions.effort = effort;
  if (sdkExecutable) queryOptions.pathToClaudeCodeExecutable = sdkExecutable;

  const q = queryFactory({ prompt: input, options: queryOptions });
  const deltaBuffer = new Map();
  const forwardEvent = (event) => onEvent({ provider: 'claude-code', runId, event });
  const flushDelta = (key) => {
    const slot = deltaBuffer.get(key);
    if (!slot) return;
    deltaBuffer.delete(key);
    clearTimeout(slot.timer);
    const inner = slot.event.event;
    const delta = inner.delta?.type === 'thinking_delta'
      ? { ...inner.delta, thinking: slot.text }
      : { ...inner.delta, text: slot.text };
    forwardEvent({ ...slot.event, event: { ...inner, delta } });
  };
  const flushDeltas = () => {
    for (const key of [...deltaBuffer.keys()]) flushDelta(key);
  };
  const emitEvent = (event) => {
    const inner = event?.type === 'stream_event' ? event.event : null;
    const isDelta = inner?.type === 'content_block_delta'
      && (inner.delta?.type === 'text_delta' || inner.delta?.type === 'thinking_delta');
    if (!isDelta) {
      flushDeltas();
      forwardEvent(event);
      return;
    }
    const key = `${event.parent_tool_use_id || ''}:${inner.index}`;
    let slot = deltaBuffer.get(key);
    if (!slot) {
      slot = { event, text: '', timer: null };
      slot.timer = setTimeout(() => flushDelta(key), 40);
      slot.timer.unref?.();
      deltaBuffer.set(key, slot);
    }
    slot.text += inner.delta.type === 'thinking_delta'
      ? (inner.delta.thinking || '')
      : (inner.delta.text || '');
  };
  let pumpError = null;
  const pump = (async () => {
    try {
      for await (const event of q) {
        if (!alive) break;
        const eventSessionId = event?.session_id || null;
        if (eventSessionId && eventSessionId !== sessionId) {
          sessionId = eventSessionId;
          onIdentity({ providerSessionId: sessionId });
        }
        emitEvent(event);
        if (event?.type === 'result' && activeTurn) {
          const turn = activeTurn;
          activeTurn = null;
          if (event.subtype === 'success') turn.resolve({ providerSessionId: sessionId, result: event });
          else turn.reject(new Error((event.errors && event.errors[0]) || event.error || event.result || 'Claude turn failed'));
        }
      }
    } catch (error) {
      pumpError = error;
    } finally {
      flushDeltas();
      if (alive) {
        alive = false;
        input.close();
        if (activeTurn) {
          const turn = activeTurn; activeTurn = null;
          turn.reject(pumpError || new Error('Claude session ended before the turn completed'));
        }
      }
    }
    if (pumpError) throw pumpError;
  })();
  pump.catch((error) => onEvent({
    provider: 'claude-code',
    runId,
    event: { type: 'synabun.error', message: error?.message || String(error) },
  }));

  return {
    identity: () => ({ providerSessionId: sessionId }),
    isAlive: () => alive,
    runTurn(prompt, meta = {}) {
      if (!alive) return Promise.reject(new Error('Claude native loop is closed'));
      if (activeTurn) return Promise.reject(new Error('Claude native loop already has an active turn'));
      onEvent({
        provider: 'claude-code',
        runId,
        event: { type: 'synabun.user_prompt', text: String(prompt || ''), iteration: meta.iteration },
      });
      return new Promise((resolveTurn, rejectTurn) => {
        activeTurn = { resolve: resolveTurn, reject: rejectTurn, iteration: meta.iteration };
        const ok = input.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
          parent_tool_use_id: null,
          session_id: sessionId || '',
        });
        if (!ok) {
          activeTurn = null;
          rejectTurn(new Error('Claude input stream is closed'));
        }
      });
    },
    async abort(reason = 'aborted') {
      if (activeTurn) {
        const turn = activeTurn; activeTurn = null;
        turn.reject(asAbortError(reason));
      }
      if (!alive) return true;
      try {
        await Promise.race([
          Promise.resolve(q.interrupt?.()),
          new Promise((resolveWait) => setTimeout(resolveWait, 1000)),
        ]);
      } catch {}
      return true;
    },
    async dispose() {
      if (activeTurn) {
        const turn = activeTurn; activeTurn = null;
        turn.reject(asAbortError('disposed'));
      }
      alive = false;
      input.close();
      flushDeltas();
      try { abortController.abort(asAbortError('disposed')); } catch {}
      await Promise.race([pump, new Promise((resolveWait) => setTimeout(resolveWait, 1000))]).catch(() => {});
    },
  };
}

/** Use a loop-owned OpenCode serve while retaining one native session. */
export async function createOpenCodeNativeLoopAdapter(options = {}) {
  const {
    runId, cwd, title, model, client, release = async () => {},
    onIdentity = () => {}, onEvent = () => {},
  } = options;
  if (!client?.session?.create || (!client?.session?.promptAsync && !client?.session?.prompt)) {
    throw new Error('OpenCode native loop requires an isolated SDK client');
  }
  let alive = true;
  let activeAbort = null;
  let activeTurn = null;
  const eventSource = client.onEvent ? client : client.event;
  let sessionId = null;
  const settleActiveTurn = (error = null) => {
    const turn = activeTurn;
    if (!turn || turn.mode !== 'async' || turn.settled) return;
    turn.settled = true;
    if (error) turn.reject(error);
    else turn.resolve({ providerSessionId: sessionId });
  };
  const unsubscribe = eventSource?.onEvent?.((envelope) => {
    const event = envelope?.event || {};
    const sid = event.sessionID || event.sessionId || event.info?.id || event.session?.id || null;
    const eventType = envelope?.eventType || '';
    if (!sessionId || (sid && sid !== sessionId)) return;
    if (/question\.asked/i.test(eventType)) {
      const requestID = event.id || event.requestID;
      if (requestID && client.question?.reject) {
        client.question.reject({ requestID, directory: cwd || undefined }).catch(() => {});
      }
    }
    if (/permission\.asked/i.test(eventType)) {
      const requestID = event.id || event.requestID || event.permissionID;
      if (requestID && client.permission?.reply) {
        client.permission.reply({ requestID, reply: 'always', directory: cwd || undefined }).catch(() => {});
      }
    }
    // promptAsync acknowledges immediately, so the durable SSE stream is the
    // source of truth for turn completion. This avoids holding a five-minute
    // synchronous fetch open and misclassifying a long, healthy turn as
    // `native:iteration-error | fetch failed`.
    const ownsTurnEvent = !!sid && sid === sessionId;
    if (ownsTurnEvent && /^session[.:]idle$/i.test(eventType)) settleActiveTurn();
    if (ownsTurnEvent && /^session[.:]error$/i.test(eventType)) {
      const detail = providerErrorMessage(
        event.error || event.info?.error || event.data?.error || event,
        'OpenCode session failed',
      );
      settleActiveTurn(new Error(String(detail)));
    }
    onEvent({ provider: 'opencode', runId, eventType, event });
  }) || (() => {});
  try {
    await client.waitUntilConnected?.(10_000);
    const created = await client.session.create({ directory: cwd || undefined, title: title || 'SynaBun automation' });
    sessionId = created?.data?.id || created?.data?.sessionID || created?.id || created?.sessionID;
    if (!sessionId) throw new Error('OpenCode did not return a session id');
    onIdentity({ providerSessionId: sessionId });
  } catch (error) {
    try { unsubscribe(); } catch {}
    await release().catch(() => {});
    throw error;
  }

  return {
    identity: () => ({ providerSessionId: sessionId }),
    isAlive: () => alive,
    async runTurn(prompt) {
      if (!alive) throw new Error('OpenCode native loop is closed');
      if (activeTurn) throw new Error('OpenCode native loop already has an active turn');
      await client.waitUntilConnected?.(10_000);
      activeAbort = new AbortController();
      const request = {
        sessionID: sessionId,
        parts: [{ type: 'text', text: prompt }],
        model: normalizeOpenCodeModel(model),
        agent: 'build',
        directory: cwd || undefined,
        signal: activeAbort.signal,
      };
      const validateResponse = (response) => {
        const assistantError = response?.data?.info?.error;
        if (response?.error || assistantError || (Number(response?.status) >= 400)) {
          const detail = providerErrorMessage(
            response?.error || assistantError || response?.data?.error,
            `OpenCode prompt failed (${response?.status || 'unknown status'})`,
          );
          throw new Error(String(detail));
        }
      };

      // Newer OpenCode serves expose promptAsync. Prefer it so an unattended
      // browser turn can run for as long as its loop budget without sitting
      // behind the SDK's synchronous fetch timeout. Retain the synchronous path
      // for older installed OpenCode versions.
      if (client.session.promptAsync) {
        let resolveTurn;
        let rejectTurn;
        const completion = new Promise((resolve, reject) => {
          resolveTurn = resolve;
          rejectTurn = reject;
        });
        // Abort may arrive while promptAsync's acknowledgement is still in
        // flight. Attach a handler immediately so that early rejection is not
        // reported as an unhandled promise before runTurn begins awaiting it.
        completion.catch(() => {});
        const turn = {
          mode: 'async', completion,
          resolve: resolveTurn, reject: rejectTurn, settled: false,
        };
        activeTurn = turn;
        try {
          const response = await client.session.promptAsync(request);
          validateResponse(response);
          return await completion;
        } finally {
          if (activeTurn === turn) activeTurn = null;
          activeAbort = null;
        }
      }

      const turn = { mode: 'sync' };
      activeTurn = turn;
      try {
        const response = await client.session.prompt(request);
        validateResponse(response);
        return { providerSessionId: sessionId };
      } finally {
        if (activeTurn === turn) activeTurn = null;
        activeAbort = null;
      }
    },
    async abort(reason = 'aborted') {
      if (activeAbort) activeAbort.abort(asAbortError(reason));
      settleActiveTurn(asAbortError(reason));
      try {
        await settleWithin(client.session.abort({ sessionID: sessionId, directory: cwd || undefined }));
      } catch {}
      return true;
    },
    async dispose() {
      alive = false;
      if (activeAbort) activeAbort.abort(asAbortError('disposed'));
      settleActiveTurn(asAbortError('disposed'));
      try { unsubscribe(); } catch {}
      await settleWithin(release());
    },
  };
}

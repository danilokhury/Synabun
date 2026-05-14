/**
 * Thin wrapper around @opencode-ai/sdk/v2 used by neural-interface/server.js.
 *
 * Replaces the manual ocpProxy() HTTP calls and the hand-rolled
 * /global/event SSE relay (server.js:5049 startOpencodeSSERelay) with the
 * official typed SDK. The wire shape broadcast to browser WS clients
 * stays identical: { type: 'event', eventType, event } where `event` is
 * the SDK event's `properties`. ocp-ws.js on the browser does not change.
 *
 * Sequential calls only (no parallel SDK calls per CLAUDE.md MCP rule
 * mirrored here — the OpenCode server is the same shared resource).
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const PLAN_MODE_INSTRUCTION = `[PLAN MODE] Read-only research and planning. Do NOT make code changes.

CRITICAL — When you have clarifying questions for the user:
1. You MUST call the \`question\` tool to ask. The user only sees interactive question cards in the sidepanel — they CANNOT see questions you write as plain text.
2. Do NOT write questions as prose in your reply (e.g. "Before I proceed, a couple of quick questions: …").
3. After calling \`question\`, stop and wait for the user's answer before continuing the plan.
4. When the plan is ready and questions are resolved, write the final plan as a structured Markdown response and stop. Do NOT continue into implementation — the sidepanel will present approval options (Continue with implementation / Continue planning / Compact context / Edit plan).

EXAMPLE — calling the question tool (use this shape verbatim, just substitute your own content):
question({
  questions: [
    {
      question: "Which database engine should we use?",
      header: "DB engine",
      options: [
        { label: "PostgreSQL", description: "Mature SQL, good for complex queries" },
        { label: "SQLite", description: "Single-file, zero-config, lower throughput" }
      ],
      multiSelect: false
    }
  ]
})

If you find yourself writing "let me ask a few questions" or "Question 1:" or "Before I proceed:", STOP and call the \`question\` tool instead.`;

let _client = null;
let _port = null;
let _eventLoopAbort = null;
let _eventLoopRunning = false;
let _listeners = new Set();
let _reconnectAttempt = 0;
let _connected = false;
let _stopRequested = false;

const VERBOSE = process.env.OCP_VERBOSE === '1';

function logv(...args) { if (VERBOSE) console.log('[opencode-client]', ...args); }

/**
 * Connect to a running `opencode serve` instance.
 *
 * `subscribe` (default true): start the SSE /global/event subscription loop.
 * Pass `subscribe: false` for callers that only need REST access (session.prompt,
 * provider.list, etc) and don't want the event stream running.
 *
 * Idempotent: subsequent calls with the same port re-arm the event loop if it died.
 */
export async function connect({ port, subscribe = true }) {
  if (!port) throw new Error('opencode-client.connect: port required');
  const sameAndRunning = _client && _port === port && (subscribe ? _eventLoopRunning : true);
  if (sameAndRunning) {
    logv('connect: already connected to port', port);
    return;
  }
  await disconnect();
  _stopRequested = false;
  _port = port;
  _client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
  _reconnectAttempt = 0;
  if (subscribe) {
    startSubscribeLoop().catch(err => {
      console.error('[opencode-client] subscribe loop crashed:', err);
      _eventLoopRunning = false;
    });
  } else {
    _connected = true;
    logv('connect: skipping subscribe loop (REST-only mode)');
  }
  logv('connect: started, port=', port, 'subscribe=', subscribe);
}

/** Tear down the client and stop the event loop. */
export async function disconnect() {
  _stopRequested = true;
  if (_eventLoopAbort) {
    try { _eventLoopAbort.abort(); } catch {}
  }
  _eventLoopAbort = null;
  _client = null;
  _port = null;
  _connected = false;
  _eventLoopRunning = false;
}

/** Raw SDK access for endpoints the wrapper hasn't surfaced yet. */
export function getClient() { return _client; }

/** True while the SSE event stream is connected. */
export function isConnected() { return _connected; }

/** Currently bound port, or null. */
export function getPort() { return _port; }

// --- Event bus ---

export const event = {
  /**
   * Subscribe to the broadcast event stream. Returns an unsubscribe fn.
   * Each listener receives `{ eventType, event }` envelopes that mirror
   * the wire shape used by server.js's broadcastToOpencodeClients().
   */
  onEvent(listener) {
    _listeners.add(listener);
    console.log('[opencode-client] onEvent listener registered, total=', _listeners.size);
    return () => _listeners.delete(listener);
  },
};

function emit(envelope) {
  for (const fn of _listeners) {
    try { fn(envelope); } catch (e) {
      console.error('[opencode-client] listener error:', e?.message || e);
    }
  }
}

async function startSubscribeLoop() {
  _eventLoopRunning = true;
  let _evCount = 0;
  console.log('[opencode-client] subscribe-loop starting, port=', _port, 'listeners=', _listeners.size);
  while (_client && !_stopRequested) {
    try {
      _eventLoopAbort = new AbortController();
      console.log('[opencode-client] calling global.event...');
      // /event is a snapshot endpoint that closes after sending server.connected
      // (chunked terminator written immediately). /global/event is the persistent
      // stream — use that instead, then unwrap the { payload: ... } envelope.
      const result = await _client.global.event({ signal: _eventLoopAbort.signal });
      console.log('[opencode-client] global.event returned, awaiting stream iterations');
      _connected = true;
      _reconnectAttempt = 0;
      emit({ eventType: 'server:status', event: { status: 'ready', port: _port } });
      logv('event stream connected');

      for await (const raw of result.stream) {
        if (_stopRequested) break;
        // /global/event wraps each event as { payload: { id, type, properties } }
        const ev = (raw && typeof raw === 'object' && 'payload' in raw) ? raw.payload : raw;
        const eventType = normalizeEventType(ev?.type || 'unknown');
        // SDK v2 events all wrap as { id, type, properties }. We expose
        // `event` = properties to match today's relay output (server.js:5083).
        const eventPayload = (ev && typeof ev === 'object' && 'properties' in ev) ? ev.properties : ev;
        _evCount++;
        // V2 emits a NEW `session.next.*` event family the renderer doesn't
        // speak. Translate to legacy event shapes so streaming text / tool
        // calls render the same way they do for legacy prompts.
        const v2Mapped = eventType.startsWith('session.next.')
          ? normalizeV2Event(eventType, eventPayload)
          : null;
        const finalType = v2Mapped?.eventType || eventType;
        const finalEvent = v2Mapped?.event || eventPayload;
        const sid = finalEvent?.sessionID || finalEvent?.sessionId || finalEvent?.info?.id || '';
        if (v2Mapped) {
          console.log(`[opencode-client] sse#${_evCount} ${eventType} → ${finalType} sid=${sid || '-'} listeners=${_listeners.size}`);
        } else {
          console.log(`[opencode-client] sse#${_evCount} ${eventType} sid=${sid || '-'} listeners=${_listeners.size}`);
        }
        emit({ eventType: finalType, event: finalEvent });
      }
      console.log('[opencode-client] stream loop exited (count=' + _evCount + ')');
    } catch (err) {
      if (_stopRequested || _eventLoopAbort?.signal.aborted) break;
      console.warn('[opencode-client] event stream error:', err?.message || err);
    }

    if (_stopRequested || !_client) break;
    _connected = false;
    emit({ eventType: 'server:status', event: { status: 'reconnecting', port: _port } });
    const delay = Math.min(10000, 1000 * Math.pow(2, _reconnectAttempt++));
    logv(`event stream disconnected; reconnecting in ${delay}ms (attempt ${_reconnectAttempt})`);
    await new Promise(r => setTimeout(r, delay));
  }
  _eventLoopRunning = false;
  console.log('[opencode-client] subscribe-loop ended, totalEvents=', _evCount);
}

function normalizeEventType(type) {
  return String(type || 'unknown').replace(/\.\d+$/, '');
}

/**
 * V2 event-shape normalizer. The V2 prompt endpoint emits a NEW event family
 * (`session.next.text.delta`, `session.next.tool.called`, etc.) that our
 * renderer doesn't speak. Translate them into the legacy event types our
 * `ocp-events.js` / `ocp-tabs.js` already handle so the panel can render
 * V2-driven turns the same way it renders legacy turns.
 *
 * Returns the original `{ eventType, event }` if no mapping applies.
 */
function normalizeV2Event(eventType, event) {
  const ev = event || {};
  // Reasoning / thinking deltas → message.part.delta (partType=reasoning)
  if (eventType === 'session.next.reasoning.delta') {
    return {
      eventType: 'message.part.delta',
      event: {
        sessionID: ev.sessionID,
        messageID: ev.messageID || ev.id,
        partID: ev.partID || ev.partId,
        partType: 'reasoning',
        delta: ev.delta || ev.text || '',
      },
    };
  }
  if (eventType === 'session.next.reasoning.started' || eventType === 'session.next.reasoning.ended') {
    return {
      eventType: 'message.part.updated',
      event: {
        sessionID: ev.sessionID,
        part: {
          messageID: ev.messageID || ev.id,
          id: ev.partID || ev.partId,
          type: 'reasoning',
          text: ev.text || '',
        },
      },
    };
  }
  // Text deltas → message.part.delta (partType=text)
  if (eventType === 'session.next.text.delta') {
    return {
      eventType: 'message.part.delta',
      event: {
        sessionID: ev.sessionID,
        messageID: ev.messageID || ev.id,
        partID: ev.partID || ev.partId,
        partType: 'text',
        delta: ev.delta || ev.text || '',
      },
    };
  }
  if (eventType === 'session.next.text.started' || eventType === 'session.next.text.ended') {
    return {
      eventType: 'message.part.updated',
      event: {
        sessionID: ev.sessionID,
        part: {
          messageID: ev.messageID || ev.id,
          id: ev.partID || ev.partId,
          type: 'text',
          text: ev.text || '',
        },
      },
    };
  }
  // Tool lifecycle → tool.start / tool.result
  if (eventType === 'session.next.tool.called') {
    return {
      eventType: 'tool.start',
      event: {
        sessionID: ev.sessionID,
        messageID: ev.messageID,
        toolCallId: ev.toolCallID || ev.toolCallId || ev.callID || ev.id,
        id: ev.toolCallID || ev.toolCallId || ev.callID || ev.id,
        tool: ev.tool || ev.name || ev.toolName,
        name: ev.name || ev.tool || ev.toolName,
        toolName: ev.tool || ev.name || ev.toolName,
        input: ev.input || ev.args || ev.arguments,
        args: ev.input || ev.args || ev.arguments,
      },
    };
  }
  if (eventType === 'session.next.tool.success' || eventType === 'session.next.tool.failed') {
    return {
      eventType: 'tool.result',
      event: {
        sessionID: ev.sessionID,
        messageID: ev.messageID,
        toolCallId: ev.toolCallID || ev.toolCallId || ev.callID || ev.id,
        id: ev.toolCallID || ev.toolCallId || ev.callID || ev.id,
        result: ev.result || ev.output || ev.metadata,
        output: ev.output || ev.result,
        metadata: ev.metadata,
        error: eventType === 'session.next.tool.failed' ? (ev.error || true) : ev.error,
      },
    };
  }
  // session.next.step.started/ended → no direct legacy equivalent; pass through
  // for the trace, but they're informational only.
  return null;
}

// --- Session helpers ---

/**
 * Normalize hey-api's { data, error, response } shape into { status, data }
 * that today's WS handlers expect, throwing on transport/HTTP errors.
 */
async function unwrap(promise) {
  let result;
  try {
    result = await promise;
  } catch (err) {
    const e = new Error(err?.message || String(err));
    e.cause = err;
    throw e;
  }
  if (result && result.error) {
    const err = new Error(result.error?.message || result.error?.data?.message || 'opencode SDK error');
    err.cause = result.error;
    err.status = result.response?.status;
    err.data = result.error?.data;
    throw err;
  }
  return {
    status: result?.response?.status ?? 200,
    data: result?.data,
  };
}

/**
 * Build the system-channel string for plan mode.
 *
 * CLI PARITY (2026-05-07): we no longer inject PLAN_MODE_INSTRUCTION. The
 * OpenCode CLI passes `agent: plan` through to the server and relies on the
 * server-side plan-agent config to supply its own system prompt. Adding our
 * 30-line override on top broke `opencode-go/kimi-k2.6`: the SDK stalled
 * with zero SSE events for 60s+ after `send.begin`. The CLI works, the
 * sidepanel was hanging — only difference was this injection. Pass through.
 *
 * If we ever need to tighten plan-mode behavior, do it via the OpenCode
 * config (mcp/agents.json), not by overriding the system channel from here.
 */
function buildSystemForPlanMode({ agent, system }) {
  return system;
}

/** Strip undefined keys so the SDK URL builder doesn't append `?foo=undefined`. */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export const session = {
  list: (params = {}) => unwrap(_client.session.list(clean(params))),
  create: (params = {}) => unwrap(_client.session.create(clean(params))),
  get: (params) => unwrap(_client.session.get(clean(params))),
  update: (params) => unwrap(_client.session.update(clean(params))),
  delete: (params) => unwrap(_client.session.delete(clean(params))),
  abort: (params) => unwrap(_client.session.abort(clean(params))),
  share: (params) => unwrap(_client.session.share(clean(params))),
  unshare: (params) => unwrap(_client.session.unshare(clean(params))),
  summarize: (params) => unwrap(_client.session.summarize(clean(params))),
  revert: (params) => unwrap(_client.session.revert(clean(params))),
  unrevert: (params) => unwrap(_client.session.unrevert(clean(params))),
  messages: (params) => unwrap(_client.session.messages(clean(params))),
  message: (params) => unwrap(_client.session.message(clean(params))),
  command: (params) => unwrap(_client.session.command(clean(params))),
  status: (params = {}) => unwrap(_client.session.status(clean(params))),
  fork: (params) => unwrap(_client.session.fork(clean(params))),
  todo: (params) => unwrap(_client.session.todo(clean(params))),
  diff: (params) => unwrap(_client.session.diff(clean(params))),
  init: (params) => unwrap(_client.session.init(clean(params))),
  shell: (params) => unwrap(_client.session.shell(clean(params))),

  prompt: async ({ sessionID, parts, model, agent, signal, system, ...rest } = {}) => {
    const finalSystem = buildSystemForPlanMode({ agent, system });
    const opts = signal ? { signal } : undefined;
    const tStart = Date.now();
    const partsCount = Array.isArray(parts) ? parts.length : 0;
    console.log(`[opencode-client] session.prompt -> POST /session/${sessionID}/message agent=${agent || '-'} model=${model?.providerID || '-'}/${model?.modelID || '-'} parts=${partsCount} hasSystem=${!!finalSystem} hasTools=${!!rest?.tools} dir=${rest?.directory || '-'}`);
    try {
      const r = await unwrap(_client.session.prompt(
        clean({ sessionID, parts, model, agent, system: finalSystem, ...rest }),
        opts,
      ));
      console.log(`[opencode-client] session.prompt <- status=${r?.status || 'ok'} ms=${Date.now() - tStart}`);
      return r;
    } catch (err) {
      console.warn(`[opencode-client] session.prompt threw status=${err?.status || '?'} ms=${Date.now() - tStart} msg=${err?.message || String(err)}`);
      throw err;
    }
  },

  /**
   * V2 prompt — POSTs to `/api/session/{sessionID}/prompt`. Returns
   * immediately (queues for the agent loop) instead of blocking until the
   * model finishes. This is what the OpenCode CLI / TUI uses, and it does
   * NOT hang on `opencode-go/kimi-k2.6` plan-mode the way the legacy
   * `/session/{id}/message` endpoint does.
   *
   * Body shape: `{ prompt: { text, files?, agents? }, delivery? }`. No
   * `model` / `agent` / `system` / `tools` fields — those are session-level.
   * The agent name (e.g. 'plan') goes in `prompt.agents: [{ name: 'plan' }]`.
   * Files use `{ uri, mime, name?, description? }`.
   */
  promptV2: async ({ sessionID, signal, text, files, agents, delivery, directory, workspace } = {}) => {
    const opts = signal ? { signal } : undefined;
    const tStart = Date.now();
    const promptBody = { text: String(text || '') };
    if (Array.isArray(files) && files.length) promptBody.files = files;
    if (Array.isArray(agents) && agents.length) promptBody.agents = agents;
    console.log(`[opencode-client] v2.session.prompt -> POST /api/session/${sessionID}/prompt textBytes=${promptBody.text.length} files=${files?.length || 0} agents=${(agents || []).map(a => a.name).join(',') || '-'} delivery=${delivery || 'default'} dir=${directory || '-'}`);
    try {
      const r = await unwrap(_client.v2.session.prompt(
        clean({ sessionID, prompt: promptBody, delivery, directory, workspace }),
        opts,
      ));
      console.log(`[opencode-client] v2.session.prompt <- status=${r?.status || 'ok'} ms=${Date.now() - tStart}`);
      return r;
    } catch (err) {
      console.warn(`[opencode-client] v2.session.prompt threw status=${err?.status || '?'} ms=${Date.now() - tStart} msg=${err?.message || String(err)}`);
      throw err;
    }
  },
  /**
   * NON-BLOCKING prompt — POSTs to `/session/{sessionID}/prompt_async`.
   * Same body shape as legacy `prompt` (parts/model/agent/system/tools), but
   * the server returns immediately after queuing the prompt for the agent
   * loop. The model output streams via SSE events. This is what the OpenCode
   * CLI uses, which is why CLI plan-mode doesn't hang the way our blocking
   * `prompt` did on `opencode-go/kimi-k2.6 + agent='plan'`.
   */
  promptAsync: async ({ sessionID, parts, model, agent, signal, system, ...rest } = {}) => {
    const finalSystem = buildSystemForPlanMode({ agent, system });
    const opts = signal ? { signal } : undefined;
    const tStart = Date.now();
    const partsCount = Array.isArray(parts) ? parts.length : 0;
    console.log(`[opencode-client] session.promptAsync -> POST /session/${sessionID}/prompt_async agent=${agent || '-'} model=${model?.providerID || '-'}/${model?.modelID || '-'} parts=${partsCount} hasSystem=${!!finalSystem} hasTools=${!!rest?.tools} dir=${rest?.directory || '-'}`);
    try {
      const r = await unwrap(_client.session.promptAsync(
        clean({ sessionID, parts, model, agent, system: finalSystem, ...rest }),
        opts,
      ));
      console.log(`[opencode-client] session.promptAsync <- status=${r?.status || 'ok'} ms=${Date.now() - tStart}`);
      return r;
    } catch (err) {
      console.warn(`[opencode-client] session.promptAsync threw status=${err?.status || '?'} ms=${Date.now() - tStart} msg=${err?.message || String(err)}`);
      throw err;
    }
  },
};

// --- Other namespaces ---

export const config = {
  get: (params = {}) => unwrap(_client.config.get(clean(params))),
  update: (params = {}) => unwrap(_client.config.update(clean(params))),
  providers: (params = {}) => unwrap(_client.config.providers(clean(params))),
};

export const provider = {
  list: (params = {}) => unwrap(_client.provider.list(clean(params))),
  auth: (params = {}) => unwrap(_client.provider.auth(clean(params))),
};

// MCP child-process control. `connect` triggers OpenCode to spawn the
// configured stdio MCP child eagerly; without this, OpenCode lazy-spawns each
// child on its first tool reference inside a prompt, adding seconds to the
// first user message latency.
export const mcp = {
  status:     (params = {}) => unwrap(_client.mcp.status(clean(params))),
  connect:    ({ name, directory } = {}) =>
    unwrap(_client.mcp.connect(clean({ path: { name }, query: directory ? { directory } : undefined }))),
  disconnect: ({ name, directory } = {}) =>
    unwrap(_client.mcp.disconnect(clean({ path: { name }, query: directory ? { directory } : undefined }))),
};

export const app = {
  agents: (params = {}) => unwrap(_client.app.agents(clean(params))),
  skills: (params = {}) => unwrap(_client.app.skills(clean(params))),
  log: (params = {}) => unwrap(_client.app.log(clean(params))),
};

export const question = {
  list: (params = {}) => unwrap(_client.question.list(clean(params))),
  reply: (params) => unwrap(_client.question.reply(clean(params))),
  reject: (params) => unwrap(_client.question.reject(clean(params))),
};

export const permission = {
  list: (params = {}) => unwrap(_client.permission.list(clean(params))),
  reply: (params) => unwrap(_client.permission.reply(clean(params))),
  respond: (params) => unwrap(_client.permission.respond(clean(params))),
};

export const global_ = {
  dispose: (params = {}) => unwrap(_client.global.dispose(clean(params))),
};

export { PLAN_MODE_INSTRUCTION };

export default {
  connect,
  disconnect,
  getClient,
  isConnected,
  getPort,
  event,
  session,
  config,
  provider,
  mcp,
  app,
  question,
  permission,
  global: global_,
  PLAN_MODE_INSTRUCTION,
};

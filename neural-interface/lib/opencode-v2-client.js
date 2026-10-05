// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 SDK Wrapper — the only OpenCode client (the v1 wrapper,
// lib/opencode-client.js, was removed on 2026-10-04)
//
// Wraps @opencode-ai/sdk/v2's createOpencodeClient and exposes:
//   • connect({ port }) / disconnect()
//   • event.onEvent(listener)        — broadcast SSE envelopes
//   • session.list/create/get/delete/abort/prompt
//   • permission.reply
//   • mcp.status/connect/disconnect
//
// Pass-through philosophy — NO event normalizers, NO system-prompt injection,
// NO legacy shape translation. Whatever the SDK emits, we forward verbatim
// in `{ eventType, event }` envelopes (event = SDK part's `properties`).
// Anything beyond what's listed above is reachable via getClient().
//
// SDK 1.18.34 additions (all additive; the methods above are unchanged):
//   • EXTRA_SDK_METHODS — one table of further SDK calls (session.status /
//     revert / fork / share / …, permission.list, command.list, …) exposed as
//     `extra.<group>.<method>` on the singleton and on every
//     createClientInstance(), with the same `{ status, data }` contract.
//     They live under `extra` on purpose: the loop runtime and the Assistant's
//     OpenCode brain feature-detect `client.session.children`, so adding a
//     method to an existing group would change what they do.
//   • describeSdkError() — the message for an SDK error body. 1.18 errors come
//     as `{ name, data: { message } }` or `{ _tag, message }`; a body with
//     neither used to surface as the literal "opencode SDK error".
// ─────────────────────────────────────────────────────────────────────────────

import { createOpencodeClient } from '@opencode-ai/sdk/v2';

let _client = null;
let _port = null;
let _abort = null;
let _running = false;
let _stopRequested = false;
let _connected = false;
let _attempt = 0;
let _evCount = 0;
const _listeners = new Set();

const VERBOSE = process.env.OCPV2_VERBOSE === '1';
const log = (...a) => console.log('[ocp-v2-client]', ...a);
const logv = (...a) => { if (VERBOSE) log(...a); };

function emit(envelope) {
  for (const fn of _listeners) {
    try { fn(envelope); }
    catch (e) { console.error('[ocp-v2-client] listener error:', e?.message || e); }
  }
}

export const event = {
  onEvent(listener) {
    _listeners.add(listener);
    log('onEvent listener registered, total=', _listeners.size);
    return () => _listeners.delete(listener);
  },
};

export async function connect({ port }) {
  if (!port) throw new Error('opencode-v2-client.connect: port required');
  if (_client && _port === port && _running) {
    logv('connect: already connected to', port);
    return;
  }
  await disconnect();
  _stopRequested = false;
  _port = port;
  _client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
  _attempt = 0;
  startSubscribeLoop().catch((err) => {
    console.error('[ocp-v2-client] subscribe loop crashed:', err);
    _running = false;
  });
  log('connect: started, port=', port);
}

export async function disconnect() {
  _stopRequested = true;
  if (_abort) { try { _abort.abort(); } catch {} }
  _abort = null;
  _client = null;
  _port = null;
  _connected = false;
  _running = false;
}

export function getClient() { return _client; }
export function isConnected() { return _connected; }
export function getPort() { return _port; }

async function startSubscribeLoop() {
  _running = true;
  log('subscribe-loop starting, port=', _port);
  while (_client && !_stopRequested) {
    try {
      _abort = new AbortController();
      // Use /global/event (persistent stream), NOT /event (snapshot endpoint
      // that emits server.connected then writes the chunked terminator and
      // closes — which produces a 1Hz reconnect loop).
      const result = await _client.global.event({ signal: _abort.signal });
      _connected = true;
      _attempt = 0;
      emit({ eventType: 'server:status', event: { status: 'ready', port: _port } });
      log('event stream connected');

      for await (const raw of result.stream) {
        if (_stopRequested) break;
        // /global/event wraps each event as { payload: { id, type, properties } }
        const ev = (raw && typeof raw === 'object' && 'payload' in raw) ? raw.payload : raw;
        const eventType = String(ev?.type || 'unknown');
        const eventPayload = (ev && typeof ev === 'object' && 'properties' in ev) ? ev.properties : ev;
        _evCount++;
        const sid = eventPayload?.sessionID || eventPayload?.sessionId || eventPayload?.info?.id || '-';
        logv(`sse#${_evCount} ${eventType} sid=${sid}`);
        emit({ eventType, event: eventPayload });
      }
      log('stream loop exited (count=' + _evCount + ')');
    } catch (err) {
      if (_stopRequested || _abort?.signal.aborted) break;
      console.warn('[ocp-v2-client] event stream error:', err?.message || err);
    }
    if (_stopRequested || !_client) break;
    _connected = false;
    emit({ eventType: 'server:status', event: { status: 'reconnecting', port: _port } });
    const delay = Math.min(10000, 1000 * Math.pow(2, _attempt++));
    log(`reconnecting in ${delay}ms (attempt ${_attempt})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  _running = false;
  log('subscribe-loop ended, totalEvents=', _evCount);
}

// The text and tag of an SDK error body. OpenCode 1.18 answers a failed call
// with `{ name, data: { message } }` (NamedError) or `{ _tag, message }` (the
// newer tagged errors, e.g. SessionBusyError); an empty body arrives as `{}`
// and a non-JSON body as a string.
export function describeSdkError(error, status) {
  const tag = (error && typeof error === 'object')
    ? String(error._tag || error.name || '')
    : '';
  let message = '';
  if (typeof error === 'string') message = error.trim();
  else if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message) message = error.message;
    else if (typeof error.data?.message === 'string' && error.data.message) message = error.data.message;
  }
  if (!message) message = tag || (status ? `opencode SDK error (HTTP ${status})` : 'opencode SDK error');
  return { message: message.length > 2000 ? `${message.slice(0, 2000)}…` : message, tag };
}

// Hey-api wraps responses as { data, error, response }. Throw on error;
// otherwise return { status, data } so callers can match server.js conventions.
async function unwrap(promise) {
  let result;
  try { result = await promise; }
  catch (err) {
    const e = new Error(err?.message || String(err));
    e.cause = err;
    throw e;
  }
  if (result && result.error) {
    const status = result.response?.status;
    const described = describeSdkError(result.error, status);
    const err = new Error(described.message);
    err.cause = result.error;
    err.status = status;
    err.data = result.error?.data;
    if (described.tag) err.tag = described.tag;
    throw err;
  }
  return { status: result?.response?.status ?? 200, data: result?.data };
}

const clean = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
};

const requireClient = () => {
  if (!_client) throw new Error('opencode-v2-client: not connected');
  return _client;
};

// Further SDK calls, by group. Each becomes `extra.<group>.<method>(params,
// options)` on the singleton and on every instance, resolving `{ status, data }`
// like the hand-written wrappers. The existing groups (`session`, `permission`,
// `mcp`, …) keep exactly the methods they had.
// tests/opencode-v2-client-extra.test.mjs checks every entry against the
// pinned SDK, so a rename upstream fails there instead of at runtime.
export const EXTRA_SDK_METHODS = Object.freeze({
  session: ['status', 'children', 'todo', 'diff', 'fork', 'revert', 'unrevert', 'share', 'unshare',
    'summarize', 'init', 'command', 'shell', 'message', 'deleteMessage'],
  permission: ['list'],
  command: ['list'],
  app: ['agents', 'skills'],
  config: ['get', 'providers'],
  find: ['text', 'files', 'symbols'],
  file: ['list', 'read', 'status'],
  vcs: ['get', 'status', 'diff'],
  worktree: ['list', 'create', 'remove', 'reset'],
  mcp: ['add'],
  lsp: ['status'],
  formatter: ['status'],
});

function extraGroups(getRaw) {
  const out = {};
  for (const [group, methods] of Object.entries(EXTRA_SDK_METHODS)) {
    out[group] = {};
    for (const method of methods) {
      out[group][method] = async (params = {}, options) => {
        const target = getRaw()?.[group];
        if (typeof target?.[method] !== 'function') {
          throw new Error(`OpenCode SDK does not expose ${group}.${method}`);
        }
        return unwrap(target[method](clean(params), options));
      };
    }
  }
  return out;
}

// v2.session.compact answers 503 "Session compact is not available yet" on
// OpenCode 1.18.34, so compaction of a v1 session has to go through
// session.summarize, which needs the model to summarise with.
export function isCompactUnavailable(err) {
  return err?.status === 503
    || err?.tag === 'ServiceUnavailableError'
    || /not available yet/i.test(String(err?.message || ''));
}

// `{ providerID, modelID }` from that object or from a "provider/model" string.
function modelRefOf(value) {
  if (typeof value === 'string') {
    const slash = value.trim().indexOf('/');
    const text = value.trim();
    return slash > 0 && slash < text.length - 1
      ? { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) }
      : null;
  }
  const providerID = typeof value?.providerID === 'string' ? value.providerID.trim() : '';
  const modelID = typeof value?.modelID === 'string' ? value.modelID.trim() : '';
  return providerID && modelID ? { providerID, modelID } : null;
}

// The model a transcript last ran on: assistant rows carry providerID/modelID,
// user rows carry `model: { providerID, modelID }`.
export function lastModelOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const info = list[i]?.info;
    const found = modelRefOf(info) || modelRefOf(info?.model);
    if (found) return found;
  }
  return null;
}

/**
 * Compact a session on any serve: `client.session.compact`, and when the serve
 * answers "not available yet" (isCompactUnavailable), `session.summarize` on
 * `model` (an object or "provider/model"), else on the model the transcript
 * last ran on. `client` is this module or a createClientInstance().
 * Resolves `{ status, data, via: 'compact' | 'summarize' }`. Throws what compact
 * threw for any other failure, and a 400 when no model can be found.
 * The sidepanel and the Assistant's OpenCode brain both compact through here;
 * `session.compact` itself is left as it was for every other caller.
 */
export async function compactOrSummarize(client, { sessionID, directory, model } = {}) {
  try {
    const r = await client.session.compact({ sessionID, directory });
    return { status: r?.status, data: r?.data, via: 'compact' };
  } catch (err) {
    const summarize = client?.extra?.session?.summarize;
    if (!isCompactUnavailable(err) || typeof summarize !== 'function') throw err;
    let target = modelRefOf(model);
    if (!target) {
      const transcript = await Promise.resolve(client.session.messages({ sessionID, directory })).catch(() => null);
      target = lastModelOf(transcript?.data);
    }
    if (!target) {
      const noModel = new Error('Pick a model first: OpenCode needs one to summarise this session.');
      noModel.status = 400;
      throw noModel;
    }
    const r = await summarize({ sessionID, directory, ...target });
    return { status: r?.status, data: r?.data, via: 'summarize' };
  }
}

export const session = {
  list:    (params = {}) => unwrap(requireClient().session.list(clean(params))),
  create:  (params = {}) => unwrap(requireClient().session.create(clean(params))),
  get:     (params)      => unwrap(requireClient().session.get(clean(params))),
  update:  (params)      => unwrap(requireClient().session.update(clean(params))),
  delete:  (params)      => unwrap(requireClient().session.delete(clean(params))),
  abort:   (params)      => unwrap(requireClient().session.abort(clean(params))),
  messages:(params)      => unwrap(requireClient().session.messages(clean(params))),
  context: (params)      => unwrap(requireClient().v2.session.context(clean(params))),

  prompt: async ({ sessionID, parts, model, agent, signal, ...rest } = {}) => {
    const opts = signal ? { signal } : undefined;
    const t = Date.now();
    log(`session.prompt -> sid=${sessionID} agent=${agent || '-'} parts=${parts?.length || 0}`);
    try {
      const r = await unwrap(requireClient().session.prompt(
        clean({ sessionID, parts, model, agent, ...rest }),
        opts,
      ));
      log(`session.prompt <- status=${r?.status} ms=${Date.now() - t}`);
      return r;
    } catch (err) {
      console.warn(`[ocp-v2-client] session.prompt threw status=${err?.status || '?'} ms=${Date.now() - t} msg=${err?.message || String(err)}`);
      throw err;
    }
  },

  promptAsync: async ({ sessionID, parts, model, agent, signal, ...rest } = {}) => {
    const opts = signal ? { signal } : undefined;
    const t = Date.now();
    log(`session.promptAsync -> sid=${sessionID} agent=${agent || '-'} parts=${parts?.length || 0}`);
    try {
      const r = await unwrap(requireClient().session.promptAsync(
        clean({ sessionID, parts, model, agent, ...rest }),
        opts,
      ));
      log(`session.promptAsync <- status=${r?.status} ms=${Date.now() - t}`);
      return r;
    } catch (err) {
      console.warn(`[ocp-v2-client] session.promptAsync threw status=${err?.status || '?'} ms=${Date.now() - t} msg=${err?.message || String(err)}`);
      throw err;
    }
  },

  compact: async ({ sessionID, ...rest } = {}) => {
    const t = Date.now();
    log(`session.compact -> sid=${sessionID}`);
    try {
      const client = requireClient();
      let target = client.v2?.session;
      let endpoint = target?.compact;
      if (!endpoint && client.session?.compact) {
        target = client.session;
        endpoint = target.compact;
      }
      if (!endpoint && client.session?.summarize) {
        target = client.session;
        endpoint = target.summarize;
      }
      if (!endpoint) throw new Error('OpenCode SDK does not expose session compact');
      const r = await unwrap(endpoint.call(target, clean({ sessionID, ...rest })));
      log(`session.compact <- status=${r?.status} ms=${Date.now() - t}`);
      return r;
    } catch (err) {
      console.warn(`[ocp-v2-client] session.compact threw status=${err?.status || '?'} ms=${Date.now() - t} msg=${err?.message || String(err)}`);
      throw err;
    }
  },
};

export const permission = {
  reply: (params) => unwrap(requireClient().permission.reply(clean(params))),
};

export const question = {
  list:   (params = {}) => unwrap(requireClient().question.list(clean(params))),
  reply:  (params)      => unwrap(requireClient().question.reply(clean(params))),
  reject: (params)      => unwrap(requireClient().question.reject(clean(params))),
};

export const mcp = {
  status:     (params = {}) => unwrap(requireClient().mcp.status(clean(params))),
  connect:    (params = {}) => unwrap(requireClient().mcp.connect(clean(params))),
  disconnect: (params = {}) => unwrap(requireClient().mcp.disconnect(clean(params))),
};

// extra.<group>.<method> — see EXTRA_SDK_METHODS.
export const extra = extraGroups(requireClient);

// ─────────────────────────────────────────────────────────────────────────────
// Per-serve client INSTANCE factory — ADDITIVE. Used by SynaBun's per-tab
// browser-isolation serves (server.js): each isolated `opencode serve` gets its
// own client instance with its own SSE loop. The module SINGLETON above is left
// completely untouched — it remains the shared-serve default, so the common path
// carries zero risk from this addition. Reuses the module-level unwrap()/clean().
// ─────────────────────────────────────────────────────────────────────────────
export function createClientInstance({ port, clientFactory = createOpencodeClient }) {
  if (!port) throw new Error('createClientInstance: port required');
  let client = clientFactory({ baseUrl: `http://127.0.0.1:${port}` });
  let abort = null;
  let stopRequested = false;
  let connected = false;
  let attempt = 0;
  const listeners = new Set();

  const emitLocal = (envelope) => {
    for (const fn of listeners) {
      try { fn(envelope); } catch (e) { console.error('[ocp-v2-iso] listener error:', e?.message || e); }
    }
  };
  const req = () => { if (!client) throw new Error('ocp-v2-iso: not connected'); return client; };

  async function subscribeLoop() {
    while (client && !stopRequested) {
      try {
        abort = new AbortController();
        const result = await client.global.event({ signal: abort.signal });
        connected = true; attempt = 0;
        emitLocal({ eventType: 'server:status', event: { status: 'ready', port } });
        for await (const raw of result.stream) {
          if (stopRequested) break;
          const ev = (raw && typeof raw === 'object' && 'payload' in raw) ? raw.payload : raw;
          const eventType = String(ev?.type || 'unknown');
          const eventPayload = (ev && typeof ev === 'object' && 'properties' in ev) ? ev.properties : ev;
          emitLocal({ eventType, event: eventPayload });
        }
      } catch (err) {
        if (stopRequested || abort?.signal.aborted) break;
        console.warn('[ocp-v2-iso] event stream error:', err?.message || err);
      }
      if (stopRequested || !client) break;
      connected = false;
      const delay = Math.min(10000, 1000 * Math.pow(2, attempt++));
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const instance = {
    port,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() { subscribeLoop().catch((e) => console.error('[ocp-v2-iso] subscribe crashed:', e)); },
    async waitUntilConnected(timeoutMs = 10000) {
      const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 10000);
      while (client && !stopRequested && !connected && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      if (!connected) throw new Error('OpenCode isolated event stream did not become ready');
      return true;
    },
    stop() { stopRequested = true; if (abort) { try { abort.abort(); } catch {} } abort = null; client = null; },
    isConnected: () => connected,
    session: {
      list:     (p = {}) => unwrap(req().session.list(clean(p))),
      create:   (p = {}) => unwrap(req().session.create(clean(p))),
      get:      (p)      => unwrap(req().session.get(clean(p))),
      update:   (p)      => unwrap(req().session.update(clean(p))),
      delete:   (p)      => unwrap(req().session.delete(clean(p))),
      abort:    (p)      => unwrap(req().session.abort(clean(p))),
      messages: (p)      => unwrap(req().session.messages(clean(p))),
      context:  (p)      => unwrap(req().v2.session.context(clean(p))),
      prompt:      ({ signal, ...rest } = {}) => unwrap(req().session.prompt(clean(rest), signal ? { signal } : undefined)),
      promptAsync: ({ signal, ...rest } = {}) => unwrap(req().session.promptAsync(clean(rest), signal ? { signal } : undefined)),
      compact: ({ ...rest } = {}) => {
        const c = req();
        let target = c.v2?.session; let endpoint = target?.compact;
        if (!endpoint && c.session?.compact) { target = c.session; endpoint = target.compact; }
        if (!endpoint && c.session?.summarize) { target = c.session; endpoint = target.summarize; }
        if (!endpoint) throw new Error('OpenCode SDK does not expose session compact');
        return unwrap(endpoint.call(target, clean(rest)));
      },
    },
    permission: { reply: (p) => unwrap(req().permission.reply(clean(p))) },
    question: {
      list:   (p = {}) => unwrap(req().question.list(clean(p))),
      reply:  (p)      => unwrap(req().question.reply(clean(p))),
      reject: (p)      => unwrap(req().question.reject(clean(p))),
    },
    mcp: {
      status:     (p = {}) => unwrap(req().mcp.status(clean(p))),
      connect:    (p = {}) => unwrap(req().mcp.connect(clean(p))),
      disconnect: (p = {}) => unwrap(req().mcp.disconnect(clean(p))),
    },
  };
  // Same extra surface as the singleton, under its own key.
  instance.extra = extraGroups(req);
  return instance;
}

export default {
  connect, disconnect, getClient, isConnected, getPort,
  event, session, permission, question, mcp, createClientInstance,
  extra, describeSdkError, isCompactUnavailable, EXTRA_SDK_METHODS,
  compactOrSummarize, lastModelOf,
};

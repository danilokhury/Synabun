// ─────────────────────────────────────────────────────────────────────────────
// OpenCode 2 client — the OpenCode 1 SDK's interface over OpenCode 2's API.
//
// Every OpenCode client in SynaBun is built by lib/opencode-v2-client.js
// (`connect`, `createClientInstance`) from the pinned @opencode-ai/sdk, which
// speaks OpenCode 1. For an OpenCode 2 serve it builds this instead: an object
// with the same groups and methods SynaBun calls on the SDK client
// (`session.prompt`, `global.event`, `permission.reply`, …), the same
// arguments, and the same `{ data, error, response }` results, in OpenCode 1's
// shapes (lib/opencode2-translate.js). So the wrapper, and everything above it
// (the OpenCode panel, the Assistant's OpenCode brain, workers, loops, the
// usage meter), runs unchanged on either major.
//
// What OpenCode 2 needs that OpenCode 1 did not:
//   • HTTP Basic auth (user `opencode`, the launch's password) on every call;
//   • the project folder as `location[directory]` (OpenCode 1: `directory`);
//   • a prompt carries no model, agent or system prompt: the session is switched
//     to the model and agent first (only when they change), and a system prompt
//     is the session's instruction entry `synabun-system`;
//   • a prompt returns at once: the synchronous `session.prompt` waits on
//     /api/experimental/session/:id/wait and then reads the reply, and so does
//     `session.command` (a slash command only queues its prompt);
//   • a permission or a question is answered under its session, which the
//     event translator remembers (or the pending lists say).
// Things OpenCode 2 does not have answer like an older serve would: an empty
// list (todos, LSP, formatters, symbols) or an error that says so (share).
// ─────────────────────────────────────────────────────────────────────────────

import { basicAuthHeader } from './opencode-protocol.js';
import {
  answersToForm,
  createEventTranslator,
  formToQuestionV1,
  messagesToV1,
  modelRefToV2,
  permissionToV1,
  rulesToV1,
  rulesToV2,
  sessionToV1,
  v2ToolName,
} from './opencode2-translate.js';

const SYSTEM_ENTRY = 'synabun-system';
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function notSupported(what) {
  const error = { _tag: 'NotSupportedError', message: `${what} is not available on OpenCode 2.` };
  return { data: undefined, error, response: { status: 501, ok: false } };
}

/** A diff mode as OpenCode 1 names it ('git', 'branch') → OpenCode 2's (`working`, `branch`, `committed`). */
export function vcsModeToV2(mode) {
  if (mode === 'branch' || mode === 'committed' || mode === 'working') return mode;
  return 'working';
}

/**
 * `baseUrl` of the serve and the launch's `password`. `version` is the serve's
 * (sessions carry it), `fetchImpl` a fetch (tests pass a fixture's).
 */
export function createOpencode2Client({ baseUrl, password, fetchImpl = globalThis.fetch, version = '' } = {}) {
  if (!baseUrl) throw new Error('createOpencode2Client: baseUrl required');
  const root = String(baseUrl).replace(/\/+$/, '');
  const auth = password ? basicAuthHeader(password) : null;
  const translator = createEventTranslator({ version });
  // What each session was last switched to (model, agent, system prompt), so a
  // prompt switches only what changed. `system` is undefined until this client
  // has set or removed the session's entry: a session made by another client (a
  // resumed one) may still hold the instructions of an earlier turn, so the
  // first prompt here always says what it wants, an empty one included.
  const sessionState = new Map();
  const stateOf = (sessionID) => {
    let state = sessionState.get(sessionID);
    if (!state) { state = { model: null, agent: null, system: undefined }; sessionState.set(sessionID, state); }
    return state;
  };

  function url(path, query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      search.append(key, String(value));
    }
    const qs = search.toString();
    return `${root}${path}${qs ? `?${qs}` : ''}`;
  }
  const located = (directory, query = {}) => (directory ? { 'location[directory]': directory, ...query } : query);

  /** One request → `{ data, error, response }`, like the SDK's (a network failure rejects). */
  async function call(method, path, { query, body, signal, raw = false } = {}) {
    const headers = { accept: raw ? '*/*' : 'application/json' };
    if (auth) headers.authorization = auth;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetchImpl(url(path, query), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const type = String(res.headers?.get?.('content-type') || '');
    const response = { status: res.status, ok: res.ok, headers: res.headers };
    if (res.status === 204) return { data: undefined, error: undefined, response };
    if (raw && res.ok) return { data: await res.text(), error: undefined, response };
    if (/text\/html/i.test(type)) {
      // OpenCode 2 answers every path outside its API with its web app.
      return { data: undefined, error: { _tag: 'NotOpencodeApiError', message: `OpenCode answered ${method} ${path} with a web page, not its API.` }, response: { ...response, ok: false, status: res.ok ? 502 : res.status } };
    }
    let parsed;
    const text = await res.text();
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (!res.ok) return { data: undefined, error: parsed ?? { message: `HTTP ${res.status}` }, response };
    return { data: parsed, error: undefined, response };
  }

  /** `{ data }` with `data` mapped, errors passed through. */
  const map = (result, fn) => (result.error ? result : { ...result, data: fn(result.data) });
  const ok = (result, data) => (result.error ? result : { ...result, data });

  // ── Sessions ──

  const noteAll = (rows) => rows.map((info) => translator.noteSession(info));

  async function listSessions({ directory, roots, search, limit, parentID } = {}) {
    const max = Number(limit) > 0 ? Number(limit) : Infinity;
    const out = [];
    let cursor = null;
    let last = null;
    for (let page = 0; page < MAX_PAGES && out.length < max; page++) {
      // A cursor carries its own order and filters: OpenCode 2 refuses either next to one.
      const query = cursor
        ? { cursor, limit: String(Math.min(PAGE_LIMIT, Number.isFinite(max) ? max - out.length : PAGE_LIMIT)) }
        : {
          directory,
          search,
          limit: String(Math.min(PAGE_LIMIT, Number.isFinite(max) ? max - out.length : PAGE_LIMIT)),
          order: 'desc',
          ...(parentID ? { parentID } : (roots === true || roots === 'true' ? { parentID: 'null' } : {})),
        };
      last = await call('GET', '/api/session', { query });
      if (last.error) return last;
      const rows = Array.isArray(last.data?.data) ? last.data.data : [];
      out.push(...rows);
      cursor = last.data?.cursor?.next || null;
      // OpenCode 2 hands out a next cursor even on the last page: a short page is the end.
      if (!cursor || rows.length < Number(query.limit)) break;
    }
    const sessions = noteAll(out);
    sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
    return { data: sessions, error: undefined, response: last?.response || { status: 200, ok: true } };
  }

  async function getSession(sessionID) {
    return map(await call('GET', `/api/session/${encodeURIComponent(sessionID)}`), (body) => translator.noteSession(body?.data));
  }

  async function readMessages(sessionID, { limit } = {}) {
    const items = [];
    let cursor = null;
    let last = null;
    const max = Number(limit) > 0 ? Number(limit) : Infinity;
    for (let page = 0; page < MAX_PAGES; page++) {
      last = await call('GET', `/api/session/${encodeURIComponent(sessionID)}/message`, { query: cursor ? { cursor, limit: String(PAGE_LIMIT) } : { order: 'desc', limit: String(PAGE_LIMIT) } });
      if (last.error) return last;
      const rows = Array.isArray(last.data?.data) ? last.data.data : [];
      items.push(...rows);
      // A page is newest first; `next` walks back in time (and is there even on the last page).
      cursor = last.data?.cursor?.next || null;
      if (!cursor || rows.length < PAGE_LIMIT || items.length >= max * 4) break;
    }
    return { data: items, error: undefined, response: last?.response || { status: 200, ok: true } };
  }

  async function messagesV1(sessionID, { directory, limit } = {}) {
    const read = await readMessages(sessionID, { limit });
    if (read.error) return read;
    const dir = directory || translator.sessionDirectory(sessionID);
    let rows = messagesToV1(read.data, { sessionID, directory: dir });
    if (Number(limit) > 0 && rows.length > Number(limit)) rows = rows.slice(-Number(limit));
    return { ...read, data: rows };
  }

  /** Switch a session to the model / agent / system prompt a request names, when they differ from the last ones. */
  async function prepare(sessionID, { model, variant, agent, system } = {}) {
    const state = stateOf(sessionID);
    const ref = modelRefToV2(model, variant);
    if (ref) {
      const key = `${ref.providerID}/${ref.id}#${ref.variant || ''}`;
      if (state.model !== key) {
        const switched = await call('POST', `/api/session/${encodeURIComponent(sessionID)}/model`, { body: { model: ref } });
        if (switched.error) return switched;
        state.model = key;
      }
    }
    if (agent && state.agent !== agent) {
      const switched = await call('POST', `/api/session/${encodeURIComponent(sessionID)}/agent`, { body: { agent: String(agent) } });
      if (switched.error) return switched;
      state.agent = String(agent);
    }
    const nextSystem = typeof system === 'string' ? system : '';
    if (state.system !== nextSystem) {
      const path = `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${SYSTEM_ENTRY}`;
      const written = nextSystem
        ? await call('PUT', path, { body: { value: nextSystem } })
        : await call('DELETE', path);
      // Only an entry that is not there may fail to go: any other failure would
      // run the turn under instructions it did not ask for.
      if (written.error && (nextSystem || written.response?.status !== 404)) return written;
      state.system = nextSystem;
    }
    return null;
  }

  /**
   * OpenCode 1 prompt parts → OpenCode 2's prompt body, and the synthetic text
   * parts (context for the model the transcript never draws, like the
   * greeting's note), which OpenCode 2 takes as synthetic messages.
   */
  function promptBody({ parts, messageID, format } = {}) {
    const texts = [];
    const files = [];
    const agents = [];
    const synthetic = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.synthetic === true) synthetic.push(part.text);
      else if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      else if (part.type === 'file' && part.url) files.push({ uri: str(part.url), ...(part.filename ? { name: str(part.filename) } : {}) });
      else if (part.type === 'agent' && part.name) agents.push({ name: str(part.name) });
      else if (part.type === 'subtask' && part.prompt) texts.push(str(part.prompt));
    }
    // OpenCode 2 has no structured-output mode: the schema becomes an instruction.
    if (format?.type === 'json_schema' && format.schema) {
      texts.push(`Reply with only a JSON value that matches this JSON schema, and nothing else:\n${JSON.stringify(format.schema)}`);
    }
    const body = { text: texts.join('\n\n') };
    if (files.length) body.files = files;
    if (agents.length) body.agents = agents;
    if (messageID && /^msg_/.test(String(messageID))) body.id = String(messageID);
    return { body, synthetic };
  }

  /** Send a prompt; resolves the SDK-shaped result and, when one was queued, the time OpenCode queued it. */
  async function sendPrompt(params = {}, options = {}) {
    const { sessionID, model, variant, agent, system, noReply } = params;
    if (!sessionID) return { result: { data: undefined, error: { message: 'sessionID required' }, response: { status: 400, ok: false } } };
    const failed = await prepare(sessionID, { model, variant, agent, system });
    if (failed) return { result: failed };
    const { body, synthetic } = promptBody(params);
    const base = `/api/session/${encodeURIComponent(sessionID)}`;
    // Context first (it must not start a turn of its own), then the prompt.
    for (const text of noReply === true ? [...synthetic, body.text] : synthetic) {
      if (!text) continue;
      const added = await call('POST', `${base}/synthetic`, { body: { text, resume: false }, signal: options?.signal });
      if (added.error) return { result: added };
    }
    if (noReply === true) return { result: { data: undefined, error: undefined, response: { status: 204, ok: true } } };
    const sent = await call('POST', `${base}/prompt`, { body, signal: options?.signal });
    if (sent.error) return { result: sent };
    return {
      result: { data: undefined, error: undefined, response: { ...sent.response, status: 204 } },
      queuedAt: Number(sent.data?.data?.time?.created) || null,
    };
  }

  async function promptAsync(params = {}, options = {}) {
    return (await sendPrompt(params, options)).result;
  }

  /**
   * Wait until the turn of something queued at `since` (or later) is over: an
   * error result, or null. /wait answers once the session is idle, which may be
   * before a prompt queued a moment ago has started, so the session must have
   * gone idle since then. `quietEnds`: nothing queued and nothing running after
   * `since` is the end too (a slash command that queued no prompt).
   */
  async function waitForTurn(sessionID, { since, signal, directory, quietEnds = false } = {}) {
    const base = `/api/session/${encodeURIComponent(sessionID)}`;
    for (let round = 0; round < 1000; round++) {
      const waited = await call('POST', `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, { signal });
      if (waited.error) return waited;
      if (!since) return null;
      const info = await call('GET', base, { signal });
      if (info.error) return info;
      if (Number(info.data?.data?.time?.idle) >= since) return null;
      if (quietEnds) {
        const [queued, active] = await Promise.all([
          call('GET', `${base}/inbox`, { signal }),
          call('GET', '/api/session/active', { query: located(directory || translator.sessionDirectory(sessionID)), signal }),
        ]);
        const pending = Array.isArray(queued.data?.data) && queued.data.data.length > 0;
        if (!queued.error && !active.error && !pending && !obj(active.data?.data)[sessionID]) return null;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    return null;
  }

  /**
   * The assistant message a turn begun at `before` ended with, as `{ data: { info, parts } }`. `latest`: when
   * the turn left none, the session's last assistant message (a command that queued nothing answers with none).
   */
  async function replyOf(sessionID, { directory, before, latest = true }) {
    const transcript = await messagesV1(sessionID, { directory, limit: 50 });
    if (transcript.error) return transcript;
    const rows = transcript.data;
    let reply = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].info.role === 'assistant' && (rows[i].info.time?.created || 0) >= before - 1000) { reply = rows[i]; break; }
      if (rows[i].info.role === 'user') break;
    }
    if (!reply && latest) reply = rows.filter((row) => row.info.role === 'assistant').pop() || null;
    // A turn of several steps answers with its last step, which holds the final text.
    return { data: reply || { info: null, parts: [] }, error: undefined, response: { status: 200, ok: true } };
  }

  async function prompt(params = {}, options = {}) {
    const { sessionID } = params;
    const before = Date.now();
    const { result: sent, queuedAt } = await sendPrompt(params, options);
    if (sent.error) return sent;
    if (params.noReply === true) return { data: { info: null, parts: [] }, error: undefined, response: { status: 200, ok: true } };
    const signal = options?.signal || AbortSignal.timeout(WAIT_TIMEOUT_MS);
    const failed = await waitForTurn(sessionID, { since: queuedAt, signal });
    if (failed) return failed;
    return replyOf(sessionID, { directory: params.directory, before });
  }

  /**
   * A slash command (/review, /init, a skill, an MCP prompt). OpenCode 1
   * answered when the command's turn was over; OpenCode 2 answers as soon as
   * the command has queued its prompt, so the turn is waited for here (a stop
   * ends it; `options.signal` gives up waiting). The command's attachments
   * (screenshots, files, @ mentions) go as OpenCode 2's prompt fields, which
   * the command's prompt carries.
   */
  async function runCommand({ sessionID, command, arguments: args, agent, model, variant, parts, directory } = {}, options = {}) {
    const failed = await prepare(sessionID, { model, variant, agent });
    if (failed) return failed;
    const { body: attached } = promptBody({ parts });
    const body = { name: String(command || ''), text: String(args || '') };
    if (attached.files) body.files = attached.files;
    if (attached.agents) body.agents = attached.agents;
    const signal = options?.signal || AbortSignal.timeout(WAIT_TIMEOUT_MS);
    const before = Date.now();
    const sent = await call('POST', `/api/session/${encodeURIComponent(sessionID)}/command`, { body, signal });
    if (sent.error) return sent;
    const waited = await waitForTurn(sessionID, { since: before, signal, directory, quietEnds: true });
    if (waited) return waited;
    return replyOf(sessionID, { directory, before, latest: false });
  }

  // ── Events ──

  /** `global.event()`: OpenCode 2's /api/event, translated, as `{ stream }` of `{ directory, payload }`. */
  async function globalEvent(options = {}) {
    const headers = { accept: 'text/event-stream' };
    if (auth) headers.authorization = auth;
    const res = await fetchImpl(url('/api/event'), { headers, ...(options?.signal ? { signal: options.signal } : {}) });
    const type = String(res.headers?.get?.('content-type') || '');
    if (!res.ok || !/text\/event-stream/i.test(type)) {
      try { await res.body?.cancel?.(); } catch { /* nothing to release */ }
      const why = res.status === 401 ? 'OpenCode 2 refused the password' : (/text\/html/i.test(type) ? 'OpenCode answered with a web page' : `HTTP ${res.status}`);
      throw new Error(`OpenCode 2 event stream did not open: ${why}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    async function* stream() {
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            let event;
            try { event = JSON.parse(data); } catch { continue; }
            for (const translated of translator.translate(event)) yield translated;
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    }
    return { stream: stream() };
  }

  // ── Asks ──

  async function permissionSessionOf(requestID, directory) {
    const known = translator.permissionSession(requestID);
    if (known) return known;
    const listed = await call('GET', '/api/permission/request', { query: located(directory) });
    const found = (Array.isArray(listed.data?.data) ? listed.data.data : []).find((row) => row?.id === requestID);
    if (found?.sessionID) translator.notePermission(requestID, found.sessionID);
    return found?.sessionID || null;
  }

  async function formOf(requestID, directory) {
    const known = translator.form(requestID);
    if (known) return known;
    const listed = await call('GET', '/api/form', { query: located(directory) });
    const found = (Array.isArray(listed.data?.data) ? listed.data.data : []).find((row) => row?.id === requestID);
    if (found) translator.noteForm(found);
    return found || null;
  }

  // ── Providers and models ──

  function modelToV1(model) {
    const caps = obj(model.capabilities);
    const input = Array.isArray(caps.input) ? caps.input : ['text'];
    const output = Array.isArray(caps.output) ? caps.output : ['text'];
    const cost = (Array.isArray(model.cost) ? model.cost : []).find((c) => !c?.tier) || (Array.isArray(model.cost) ? model.cost[0] : null) || {};
    const variants = {};
    for (const variant of Array.isArray(model.variants) ? model.variants : []) {
      if (variant?.id) variants[variant.id] = { ...obj(variant.settings) };
    }
    const flags = (list) => ({ text: list.includes('text'), audio: list.includes('audio'), image: list.includes('image'), video: list.includes('video'), pdf: list.includes('pdf') });
    const out = {
      id: str(model.id),
      providerID: str(model.providerID),
      api: { id: str(model.modelID || model.id), url: str(model.settings?.baseURL), npm: str(model.package) },
      name: str(model.name || model.id),
      ...(model.family ? { family: str(model.family) } : {}),
      capabilities: {
        temperature: caps.temperature !== false,
        reasoning: !!(model.compatibility?.reasoningField || (Array.isArray(model.variants) && model.variants.length)),
        attachment: input.some((kind) => kind !== 'text'),
        toolcall: caps.tools !== false,
        input: flags(input),
        output: flags(output),
        interleaved: false,
      },
      cost: { input: Number(cost.input) || 0, output: Number(cost.output) || 0, cache: { read: Number(cost.cache?.read) || 0, write: Number(cost.cache?.write) || 0 } },
      limit: { context: Number(model.limit?.context) || 0, ...(model.limit?.input ? { input: Number(model.limit.input) } : {}), output: Number(model.limit?.output) || 0 },
      status: str(model.status) || 'active',
      options: {},
      headers: obj(model.headers),
      release_date: model.time?.released ? new Date(Number(model.time.released)).toISOString().slice(0, 10) : '',
    };
    if (Object.keys(variants).length) out.variants = variants;
    return out;
  }

  /** OpenCode 1's provider list from OpenCode 2's providers, enabled models and default model. */
  async function providerCatalog(directory) {
    const [providers, models, fallback] = await Promise.all([
      call('GET', '/api/provider', { query: located(directory) }),
      call('GET', '/api/model', { query: located(directory) }),
      call('GET', '/api/model/default', { query: located(directory) }),
    ]);
    if (providers.error) return { error: providers.error, response: providers.response };
    if (models.error) return { error: models.error, response: models.response };
    const byProvider = new Map();
    for (const provider of Array.isArray(providers.data?.data) ? providers.data.data : []) {
      byProvider.set(provider.id, {
        id: str(provider.id),
        name: str(provider.name || provider.id),
        source: provider.activation === 'enabled' ? 'config' : 'api',
        env: [],
        options: {},
        models: {},
      });
    }
    for (const model of Array.isArray(models.data?.data) ? models.data.data : []) {
      if (!model?.id || !model.providerID || model.enabled === false) continue;
      let provider = byProvider.get(model.providerID);
      if (!provider) {
        provider = { id: str(model.providerID), name: str(model.providerID), source: 'api', env: [], options: {}, models: {} };
        byProvider.set(model.providerID, provider);
      }
      provider.models[model.id] = modelToV1(model);
    }
    const all = [...byProvider.values()];
    const connected = all.filter((provider) => Object.keys(provider.models).length).map((provider) => provider.id);
    const defaults = {};
    const fallbackModel = fallback.data?.data;
    if (fallbackModel?.providerID && fallbackModel?.id) defaults[fallbackModel.providerID] = fallbackModel.id;
    for (const provider of all) {
      if (!defaults[provider.id]) {
        const first = Object.keys(provider.models)[0];
        if (first) defaults[provider.id] = first;
      }
    }
    return { all, connected, defaults, response: providers.response };
  }

  // ── The SDK-shaped client ──

  const session = {
    list: (p = {}) => listSessions(p),
    create: async (p = {}) => {
      const body = {
        ...(p.directory ? { location: { directory: String(p.directory) } } : {}),
        ...(p.parentID ? { parentID: String(p.parentID) } : {}),
        ...(p.title ? { title: String(p.title) } : {}),
        ...(p.agent ? { agent: String(p.agent) } : {}),
        ...(p.model ? { model: modelRefToV2(p.model.id ? { providerID: p.model.providerID, modelID: p.model.id, variant: p.model.variant } : p.model) } : {}),
        ...(p.metadata ? { metadata: p.metadata } : {}),
      };
      const rules = rulesToV2(p.permission);
      if (rules && rules.length) body.permissions = rules;
      if (body.model === null) delete body.model;
      const created = await call('POST', '/api/session', { body });
      return map(created, (res) => {
        const info = translator.noteSession(res?.data);
        if (info?.id) {
          // A new session holds no instruction entry of SynaBun's.
          stateOf(info.id).system = '';
          if (body.agent) stateOf(info.id).agent = body.agent;
        }
        return info;
      });
    },
    get: ({ sessionID } = {}) => getSession(sessionID),
    update: async ({ sessionID, title, permission, metadata, time } = {}) => {
      // OpenCode 2's update takes a title, metadata and permissions: archiving is not in its API.
      if (time && typeof time === 'object' && 'archived' in time) return notSupported('Archiving a session');
      const body = {};
      if (typeof title === 'string') body.title = title;
      if (metadata && typeof metadata === 'object') body.metadata = metadata;
      const rules = rulesToV2(permission);
      if (rules) body.permissions = rules;
      const patched = await call('PATCH', `/api/session/${encodeURIComponent(sessionID)}`, { body });
      if (patched.error) return patched;
      return getSession(sessionID);
    },
    delete: async ({ sessionID } = {}) => {
      const removed = await call('DELETE', `/api/session/${encodeURIComponent(sessionID)}`);
      if (!removed.error) sessionState.delete(sessionID);
      return ok(removed, true);
    },
    abort: async ({ sessionID } = {}) => map(await call('POST', `/api/session/${encodeURIComponent(sessionID)}/interrupt`), (body) => body?.interrupted !== false),
    messages: ({ sessionID, directory, limit } = {}) => messagesV1(sessionID, { directory, limit }),
    message: async ({ sessionID, messageID, directory } = {}) => {
      const read = await call('GET', `/api/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`);
      return map(read, (body) => messagesToV1([body?.data].filter(Boolean), { sessionID, directory: directory || translator.sessionDirectory(sessionID) })[0] || null);
    },
    prompt: (p, o) => prompt(p, o),
    promptAsync: (p, o) => promptAsync(p, o),
    status: async ({ directory } = {}) => {
      const active = await call('GET', '/api/session/active', { query: located(directory) });
      return map(active, (body) => {
        const out = {};
        for (const [id, status] of Object.entries(obj(body?.data))) out[id] = status?.type === 'running' ? { type: 'busy' } : { type: 'idle' };
        return out;
      });
    },
    children: ({ sessionID, directory } = {}) => listSessions({ parentID: sessionID, directory }),
    todo: async () => ({ data: [], error: undefined, response: { status: 200, ok: true } }),
    diff: async ({ sessionID, messageID } = {}) => {
      const diff = await call('GET', `/api/session/${encodeURIComponent(sessionID)}/diff`, { query: messageID ? { from: messageID } : {} });
      return map(diff, (body) => (Array.isArray(body?.data) ? body.data : []).map((row) => ({ file: str(row.file), patch: str(row.patch), additions: Number(row.additions) || 0, deletions: Number(row.deletions) || 0, status: row.status })));
    },
    fork: async ({ sessionID, messageID } = {}) => map(await call('POST', `/api/session/${encodeURIComponent(sessionID)}/fork`, { body: messageID ? { before: messageID } : {} }), (body) => translator.noteSession(body?.data)),
    revert: async ({ sessionID, messageID } = {}) => {
      const staged = await call('POST', `/api/session/${encodeURIComponent(sessionID)}/revert/stage`, { body: { messageID, files: true } });
      if (staged.error) return staged;
      return getSession(sessionID);
    },
    unrevert: async ({ sessionID } = {}) => {
      const cleared = await call('DELETE', `/api/session/${encodeURIComponent(sessionID)}/revert`);
      if (cleared.error) return cleared;
      return getSession(sessionID);
    },
    share: async () => notSupported('Sharing a session'),
    unshare: async () => notSupported('Sharing a session'),
    summarize: async ({ sessionID } = {}) => ok(await call('POST', `/api/session/${encodeURIComponent(sessionID)}/compact`, { body: {} }), true),
    init: async ({ sessionID } = {}) => ok(await call('POST', `/api/session/${encodeURIComponent(sessionID)}/command`, { body: { name: 'init', text: '' } }), true),
    command: (p, o) => runCommand(p, o),
    shell: async ({ sessionID, command, agent, model } = {}) => {
      const failed = await prepare(sessionID, { model, agent });
      if (failed) return failed;
      return ok(await call('POST', `/api/session/${encodeURIComponent(sessionID)}/shell`, { body: { command: String(command || '') } }), { info: null, parts: [] });
    },
    deleteMessage: async () => notSupported('Deleting one message'),
  };

  const client = {
    protocol: 2,
    global: {
      event: globalEvent,
      health: async () => map(await call('GET', '/api/info'), (body) => ({ healthy: true, version: str(body?.version) })),
    },
    event: { subscribe: globalEvent },
    session,
    v2: {
      session: {
        compact: async ({ sessionID } = {}) => ok(await call('POST', `/api/session/${encodeURIComponent(sessionID)}/compact`, { body: {} }), true),
        context: async ({ sessionID, directory } = {}) => {
          const read = await call('GET', `/api/session/${encodeURIComponent(sessionID)}/context`);
          return map(read, (body) => messagesToV1(Array.isArray(body?.data) ? body.data : [], { sessionID, directory: directory || translator.sessionDirectory(sessionID) }));
        },
      },
    },
    permission: {
      list: async ({ directory } = {}) => map(await call('GET', '/api/permission/request', { query: located(directory) }), (body) => (Array.isArray(body?.data) ? body.data : []).filter((row) => row?.id).map((row) => {
        translator.notePermission(row.id, row.sessionID);
        return permissionToV1(row);
      })),
      reply: async ({ requestID, reply, message, directory } = {}) => {
        const sessionID = await permissionSessionOf(requestID, directory);
        if (!sessionID) return { data: undefined, error: { _tag: 'PermissionNotFoundError', message: `No pending OpenCode permission ${requestID}.` }, response: { status: 404, ok: false } };
        const decision = ['once', 'always', 'reject'].includes(reply) ? reply : 'reject';
        return ok(await call('POST', `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, { body: { decision, ...(message ? { message: String(message) } : {}) } }), true);
      },
    },
    question: {
      list: async ({ directory } = {}) => map(await call('GET', '/api/form', { query: located(directory) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((form) => {
        const question = formToQuestionV1(form);
        if (question) translator.noteForm(form);
        return question;
      }).filter(Boolean)),
      reply: async ({ requestID, answers, directory } = {}) => {
        const form = await formOf(requestID, directory);
        if (!form) return { data: undefined, error: { _tag: 'QuestionNotFoundError', message: `No pending OpenCode question ${requestID}.` }, response: { status: 404, ok: false } };
        return ok(await call('POST', `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(requestID)}/reply`, { body: { answer: answersToForm(form, answers) } }), true);
      },
      reject: async ({ requestID, directory } = {}) => {
        const form = await formOf(requestID, directory);
        if (!form) return { data: undefined, error: { _tag: 'QuestionNotFoundError', message: `No pending OpenCode question ${requestID}.` }, response: { status: 404, ok: false } };
        return ok(await call('DELETE', `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(requestID)}`), true);
      },
    },
    mcp: {
      status: async ({ directory } = {}) => map(await call('GET', '/api/mcp', { query: located(directory) }), (body) => {
        const out = {};
        for (const server of Array.isArray(body?.data) ? body.data : []) {
          if (!server?.name) continue;
          const status = obj(server.status);
          out[server.name] = { status: str(status.status) || 'failed', ...(status.error ? { error: str(status.error) } : {}) };
        }
        return out;
      }),
      connect: async ({ name, directory } = {}) => ok(await call('POST', `/api/experimental/mcp/${encodeURIComponent(name)}/connect`, { query: located(directory) }), true),
      disconnect: async ({ name, directory } = {}) => ok(await call('POST', `/api/experimental/mcp/${encodeURIComponent(name)}/disconnect`, { query: located(directory) }), true),
      add: async ({ name, config, directory } = {}) => {
        const c = obj(config);
        const server = c.url || c.type === 'remote'
          ? { type: 'remote', url: str(c.url), ...(c.headers ? { headers: obj(c.headers) } : {}), ...(c.enabled === false ? { disabled: true } : {}) }
          : { type: 'local', command: Array.isArray(c.command) ? c.command.map(str) : [str(c.command), ...(Array.isArray(c.args) ? c.args.map(str) : [])].filter(Boolean), ...(c.environment || c.env ? { environment: obj(c.environment || c.env) } : {}), ...(c.enabled === false ? { disabled: true } : {}) };
        if (Number(c.timeout) > 0) server.timeout = { startup: Number(c.timeout), catalog: Number(c.timeout), execution: Number(c.timeout) };
        const added = await call('PUT', `/api/experimental/mcp/${encodeURIComponent(name)}`, { query: located(directory), body: { config: server } });
        if (added.error) return added;
        return client.mcp.status({ directory });
      },
    },
    command: {
      list: async ({ directory } = {}) => map(await call('GET', '/api/command', { query: located(directory) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((command) => ({ name: str(command.name), ...(command.description ? { description: str(command.description) } : {}), source: 'command', template: '', hints: [] }))),
    },
    app: {
      agents: async ({ directory } = {}) => map(await call('GET', '/api/agent', { query: located(directory) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((agent) => ({
        name: str(agent.id || agent.name),
        ...(agent.description ? { description: str(agent.description) } : {}),
        mode: str(agent.mode) || 'all',
        hidden: agent.hidden === true,
        ...(agent.color ? { color: str(agent.color) } : {}),
        permission: rulesToV1(agent.permissions) || [],
        ...(agent.model?.id ? { model: { providerID: str(agent.model.providerID), modelID: str(agent.model.id) } } : {}),
        ...(agent.model?.variant ? { variant: str(agent.model.variant) } : {}),
        ...(agent.system ? { prompt: str(agent.system) } : {}),
        ...(agent.steps ? { steps: Number(agent.steps) } : {}),
        options: {},
      }))),
      skills: async ({ directory } = {}) => map(await call('GET', '/api/skill', { query: located(directory) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((skill) => ({ name: str(skill.name), description: str(skill.description), location: str(skill.path), content: str(skill.content) }))),
    },
    config: {
      get: async ({ directory } = {}) => map(await call('GET', '/api/config', { query: located(directory) }), (body) => {
        // OpenCode 2 lists the config documents it read; their merge is the config.
        const merged = {};
        for (const entry of Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : [])) {
          if (entry?.type !== 'document' || !entry.info) continue;
          const info = entry.info;
          if (info.model) merged.model = typeof info.model === 'string' ? info.model : `${info.model.providerID}/${info.model.model}`;
          if (info.default_agent) merged.default_agent = info.default_agent;
          if (info.agents) merged.agent = { ...(merged.agent || {}), ...Object.fromEntries(Object.entries(info.agents).map(([name, agent]) => [name, { ...agent, ...(agent.system ? { prompt: agent.system } : {}) }])) };
          if (info.mcp?.servers) merged.mcp = { ...(merged.mcp || {}), ...info.mcp.servers };
          if (info.permissions) merged.permission = rulesToV1(info.permissions);
          if (Array.isArray(info.plugins)) merged.plugin = info.plugins.map((p) => (typeof p === 'string' ? p : p.package));
          if (info.providers) merged.provider = { ...(merged.provider || {}), ...info.providers };
        }
        return merged;
      }),
      providers: async ({ directory } = {}) => {
        const catalog = await providerCatalog(directory);
        if (catalog.error) return { data: undefined, error: catalog.error, response: catalog.response };
        return { data: { providers: catalog.all.filter((p) => Object.keys(p.models).length), default: catalog.defaults }, error: undefined, response: catalog.response };
      },
    },
    provider: {
      list: async ({ directory } = {}) => {
        const catalog = await providerCatalog(directory);
        if (catalog.error) return { data: undefined, error: catalog.error, response: catalog.response };
        return { data: { all: catalog.all, default: catalog.defaults, connected: catalog.connected }, error: undefined, response: catalog.response };
      },
      auth: async () => ({ data: {}, error: undefined, response: { status: 200, ok: true } }),
    },
    find: {
      files: async ({ query, directory, limit, type } = {}) => map(await call('GET', '/api/fs/find', { query: located(directory, { query: str(query), ...(type ? { type } : { type: 'file' }), ...(limit ? { limit: String(limit) } : {}) }) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((entry) => str(entry?.path || entry?.name || entry))),
      text: async () => ({ data: [], error: undefined, response: { status: 200, ok: true } }),
      symbols: async () => ({ data: [], error: undefined, response: { status: 200, ok: true } }),
    },
    file: {
      list: async ({ path, directory } = {}) => map(await call('GET', '/api/fs/list', { query: located(directory, { path }) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((entry) => ({
        name: str(entry.name),
        path: str(entry.path || entry.name),
        absolute: str(entry.absolute || entry.path),
        type: entry.type === 'directory' ? 'directory' : 'file',
        ignored: entry.ignored === true,
      }))),
      read: async ({ path, directory } = {}) => {
        const safe = String(path || '').split('/').map(encodeURIComponent).join('/');
        return map(await call('GET', `/api/fs/read/${safe}`, { query: located(directory), raw: true }), (content) => ({ type: 'text', content: str(content) }));
      },
      status: async ({ directory } = {}) => map(await call('GET', '/api/vcs/status', { query: located(directory) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((row) => ({ path: str(row.file || row.path), added: Number(row.additions) || 0, removed: Number(row.deletions) || 0, status: row.status || 'modified' }))),
    },
    vcs: {
      get: async ({ directory } = {}) => map(await call('GET', '/api/vcs', { query: located(directory) }), (body) => {
        const branch = body?.data?.branch;
        return { branch: typeof branch === 'string' ? branch : str(branch?.name) };
      }),
      status: async ({ directory } = {}) => map(await call('GET', '/api/vcs/status', { query: located(directory) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((row) => ({ file: str(row.file || row.path), additions: Number(row.additions) || 0, deletions: Number(row.deletions) || 0, status: row.status || 'modified' }))),
      // OpenCode 1's 'git' (the working tree against HEAD) is OpenCode 2's 'working', 'branch' (against the
      // default branch) its 'branch'. OpenCode 2 refuses a diff that names no mode.
      diff: async ({ directory, mode } = {}) => map(await call('GET', '/api/vcs/diff', { query: located(directory, { mode: vcsModeToV2(mode) }) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((row) => ({ file: str(row.file), patch: str(row.patch), additions: Number(row.additions) || 0, deletions: Number(row.deletions) || 0, status: row.status }))),
    },
    worktree: {
      list: async ({ directory } = {}) => map(await call('GET', '/api/worktree', { query: located(directory) }), (body) => (Array.isArray(body?.data) ? body.data : []).map((row) => str(row?.directory || row))),
      create: async () => notSupported('Creating a worktree from SynaBun'),
      remove: async () => notSupported('Removing a worktree from SynaBun'),
      reset: async () => notSupported('Resetting a worktree from SynaBun'),
    },
    lsp: { status: async () => ({ data: [], error: undefined, response: { status: 200, ok: true } }) },
    formatter: { status: async () => ({ data: [], error: undefined, response: { status: 200, ok: true } }) },
    path: {
      get: async ({ directory } = {}) => {
        const info = await call('GET', '/api/info');
        return map(info, () => ({ home: '', state: '', config: '', worktree: str(directory), directory: str(directory) }));
      },
    },
    // A stateless one-shot (editor autocomplete, titles): OpenCode 2's generator.
    generate: async ({ prompt: text, model, directory, signal } = {}) => {
      const ref = modelRefToV2(model);
      return map(await call('POST', '/api/experimental/generate', { query: located(directory), body: { prompt: String(text || ''), ...(ref ? { model: ref } : {}) }, signal }), (body) => ({ text: str(body?.data?.text) }));
    },
  };
  return client;
}

export const OPENCODE2_CLIENT_INTERNALS = Object.freeze({ SYSTEM_ENTRY, v2ToolName });

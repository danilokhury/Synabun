// ═══════════════════════════════════════════
// SynaBun — Maritaca AI: the HTTP client (no dependency)
// ═══════════════════════════════════════════
//
// Maritaca exposes an OpenAI-compatible API at https://chat.maritaca.ai/api (docs.maritaca.ai →
// API reference → Chat): POST /chat/completions with `messages`, `stream`, `stream_options`,
// `tools`, `tool_choice`, `max_tokens`, `temperature`, `reasoning_effort` (S5), and the key in the
// Authorization header. There is no official Node SDK (the `maritalk` package is Python), so this is
// a thin `fetch` client: no new dependency, every request bounded by a timeout and an AbortSignal,
// the key held only for the call, never logged, never part of an error.
//
// `chatStream` reads the server-sent events of a streaming completion and calls `onEvent` with:
//   { type: 'delta', text }                 answer text
//   { type: 'reasoning', text }             reasoning text (S5, Sabiá 4 Thinking), when the API streams it
//   { type: 'tool_call', index, id, name, arguments }  a tool call, assembled when its deltas end
//   { type: 'usage', usage }                the final usage chunk (stream_options.include_usage)
//   { type: 'done', finishReason }          the stream ended
// and resolves with { text, reasoning, toolCalls, usage, finishReason }. An HTTP error rejects with
// an Error carrying `status` and `code` ('KEY_REJECTED' 401/403, 'RATE_LIMITED' 429, 'MODEL_UNKNOWN'
// 404, 'BAD_REQUEST' 400, 'UPSTREAM' 5xx, 'UNREACHABLE' a network failure, 'ABORTED'); the body of a
// failure is read for its `error.message` only, bounded, and the key is never in it.

import { MARITACA_MODELS, findMaritacaModel, maritacaModelRows, normalizeMaritacaEffort } from './models.js';

export const MARITACA_BASE_URL = 'https://chat.maritaca.ai/api';
export const MARITACA_DOCS_URL = 'https://docs.maritaca.ai';
export const MARITACA_KEYS_URL = 'https://plataforma.maritaca.ai/chaves-de-api';
const MAX_ERROR_BODY = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;
const STREAM_IDLE_MS = 120_000; // a stream ends when no bytes arrive for this long (reset by every chunk), not a total

export function maritacaError(code, message, status = 0) {
  return Object.assign(new Error(message), { code, status });
}

/** The error code an HTTP status means. */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'KEY_REJECTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404) return 'MODEL_UNKNOWN';
  if (status === 400 || status === 422) return 'BAD_REQUEST';
  if (status >= 500) return 'UPSTREAM';
  return 'HTTP_ERROR';
}

/** The message of a failed answer, from its JSON `error.message` / `detail` / `message`, else the status line. Never the key. */
export async function readErrorMessage(response) {
  let text = '';
  try { text = (await response.text()).slice(0, MAX_ERROR_BODY); } catch { text = ''; }
  try {
    const body = JSON.parse(text);
    const msg = body?.error?.message || body?.detail || body?.message || body?.error;
    if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 400);
  } catch { /* not JSON */ }
  return `Maritaca answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
}

/** The request key is kept only in the header of the one call. */
function headers(key, extra = {}) {
  // The documentation's direct HTTP example sends `Authorization: Key <key>`; the OpenAI SDK sends `Bearer`.
  // Both are accepted; the documented one is used.
  return { authorization: `Key ${key}`, 'content-type': 'application/json', accept: 'application/json', ...extra };
}

function abortIn(ms, outer) {
  const controller = new AbortController();
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('timeout')), ms); timer.unref?.(); };
  arm();
  const onOuter = () => controller.abort(outer?.reason || new Error('aborted'));
  if (outer) {
    if (outer.aborted) onOuter();
    else outer.addEventListener('abort', onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    /** Something arrived: the clock starts over (an idle timeout, not a deadline). */
    touch: () => { if (!controller.signal.aborted) arm(); },
    done: () => { clearTimeout(timer); outer?.removeEventListener?.('abort', onOuter); },
  };
}

/** The body's chunks, each one resetting the idle clock. */
async function* touching(iterable, touch) {
  for await (const chunk of iterable) { touch(); yield chunk; }
}

function networkError(error, outer) {
  if (outer?.aborted) return maritacaError('ABORTED', 'The request was stopped.');
  if (error?.name === 'AbortError' || /timeout/i.test(String(error?.message))) return maritacaError('TIMEOUT', 'Maritaca did not answer in time.');
  return maritacaError('UNREACHABLE', 'Could not reach Maritaca.');
}

/**
 * Parses one server-sent-events stream (OpenAI chat completion chunks). Pure over an async
 * iterable of Uint8Array / string chunks; yields the parsed JSON of every `data:` line, and
 * `{ done: true }` once for `[DONE]`.
 */
export async function* parseSseChunks(iterable) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of iterable) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') { yield { done: true }; return; }
      try { yield JSON.parse(data); } catch { /* a partial or malformed line: skipped */ }
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith('data:')) {
    const data = rest.slice(5).trim();
    if (data === '[DONE]') yield { done: true };
    else { try { yield JSON.parse(data); } catch { /* ignore */ } }
  }
}

/** Folds the chunks of one streamed completion into text, reasoning, tool calls and usage, reporting each piece. */
export function createStreamFolder(onEvent = () => {}) {
  const calls = new Map(); // index → { id, name, arguments }
  const out = { text: '', reasoning: '', toolCalls: [], usage: null, finishReason: null };
  const emit = (event) => { try { onEvent(event); } catch { /* the listener's own problem */ } };
  function flushCalls() {
    for (const [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
      const done = { index, id: call.id || `call_${index}`, name: call.name || '', arguments: call.arguments || '' };
      out.toolCalls.push(done);
      emit({ type: 'tool_call', ...done });
    }
    calls.clear();
  }
  return {
    push(chunk) {
      if (!chunk || typeof chunk !== 'object') return;
      if (chunk.done) { flushCalls(); emit({ type: 'done', finishReason: out.finishReason }); return; }
      if (chunk.usage && typeof chunk.usage === 'object') { out.usage = chunk.usage; emit({ type: 'usage', usage: chunk.usage }); }
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) return;
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === 'string' && delta.content) { out.text += delta.content; emit({ type: 'delta', text: delta.content }); }
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      if (reasoning) { out.reasoning += reasoning; emit({ type: 'reasoning', text: reasoning }); }
      if (Array.isArray(delta.tool_calls)) {
        for (const piece of delta.tool_calls) {
          const index = Number.isInteger(piece?.index) ? piece.index : calls.size;
          const call = calls.get(index) || { id: '', name: '', arguments: '' };
          if (piece?.id) call.id = String(piece.id);
          if (piece?.function?.name) call.name += String(piece.function.name);
          if (typeof piece?.function?.arguments === 'string') call.arguments += piece.function.arguments;
          calls.set(index, call);
        }
      }
      if (choice.finish_reason) out.finishReason = String(choice.finish_reason);
    },
    end() {
      flushCalls();
      return out;
    },
  };
}

/** The message list the API takes: role/content pairs only, bounded, tool messages kept as they are. */
export function normalizeMessages(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const role = ['system', 'user', 'assistant', 'tool'].includes(m.role) ? m.role : null;
    if (!role) continue;
    const content = role === 'user' && Array.isArray(m.content)
      ? m.content.filter((p) => (p?.type === 'text' && typeof p.text === 'string') || (p?.type === 'image_url' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(p.image_url?.url || '')))
        .map((p) => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.image_url.url } })
      : typeof m.content === 'string' ? m.content : m.content == null ? '' : String(m.content);
    const entry = { role, content };
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) entry.tool_calls = m.tool_calls;
    if (role === 'tool' && m.tool_call_id) entry.tool_call_id = String(m.tool_call_id);
    out.push(entry);
  }
  return out;
}

/**
 * Does the model take only its default sampling? A row's own `fixedSampling` wins (models.js: the S5 family, probed
 * live; Sabiá 4 Thinking reasons yet samples freely); a row without the flag falls back to `reasoning`, the safe guess
 * for a model the table does not know, since S5 answers "'temperature' does not support 0 … Only the default (1)".
 */
export function maritacaFixedSampling(row) {
  if (!row) return false;
  if (typeof row.fixedSampling === 'boolean') return row.fixedSampling;
  return row.reasoning === true;
}

/** A 400 whose message says a sampling field (temperature / top_p) is not supported by the model. */
export function isSamplingRefusal(error) {
  if (!error || Number(error.status) !== 400) return false;
  return /unsupported (value|parameter)/i.test(String(error.message || '')) && /\b(temperature|top_p)\b/i.test(String(error.message || ''));
}

/** The body of a chat completion request from what the panel asks. */
export function buildChatBody({ model, messages, stream = true, maxTokens = null, temperature = null, reasoningEffort = null, tools = null, toolChoice = null } = {}) {
  const row = findMaritacaModel(model);
  const body = { model: row ? row.id : String(model || '').trim(), messages: normalizeMessages(messages), stream: stream === true };
  if (row && row.vision !== true && body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))) throw maritacaError('IMAGE_UNSUPPORTED', 'This model does not read images.');
  if (body.stream) body.stream_options = { include_usage: true };
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Math.min(Math.floor(Number(maxTokens)), row?.maxOutput || 32_000);
  // Sampling is sent only when the user set it (null / '' / undefined is "the model's default": Number(null) is 0, which
  // reasoning models refuse) and never to a model that takes only its default (`fixedSampling` in models.js).
  if (temperature !== null && temperature !== undefined && temperature !== '' && Number.isFinite(Number(temperature)) && !maritacaFixedSampling(row)) {
    body.temperature = Math.min(2, Math.max(0, Number(temperature)));
  }
  // reasoning_effort only on a model that reasons with levels (the S5 family); other models refuse unknown fields. An alias
  // (xhigh, max, minimal) is sent as the level it names; a level the row does not list is left out (the model's default).
  const effort = normalizeMaritacaEffort(reasoningEffort);
  if (effort && row?.efforts?.length && row.efforts.includes(effort)) body.reasoning_effort = effort;
  if (Array.isArray(tools) && tools.length && row?.toolcall !== false) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  return body;
}

/**
 * The client. `fetchImpl` is injectable (tests); `baseUrl` too (a proxy). `getKey` is asked for the
 * key at every call, so a key saved while a panel is open is used at once.
 */
export function createMaritacaClient({ fetchImpl = globalThis.fetch, baseUrl = MARITACA_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, streamIdleMs = STREAM_IDLE_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createMaritacaClient needs fetch');
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(path, { key, method = 'GET', body = null, signal = null, timeout = timeoutMs } = {}) {
    if (!key) throw maritacaError('NO_KEY', 'No Maritaca API key is saved.');
    const gate = abortIn(timeout, signal);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { method, headers: headers(key), body: body ? JSON.stringify(body) : undefined, signal: gate.signal, redirect: 'error' });
    } catch (error) {
      gate.done();
      throw networkError(error, signal);
    }
    if (!response.ok) {
      const message = await readErrorMessage(response);
      gate.done();
      throw maritacaError(codeForStatus(response.status), message, response.status);
    }
    return { response, done: gate.done, touch: gate.touch };
  }

  /** GET /models when the API answers it; merged over the table. { models, source: 'live' | 'table', error? } */
  async function listModels({ key, signal = null } = {}) {
    const table = maritacaModelRows();
    if (!key) return { models: table, source: 'table', error: 'NO_KEY' };
    let live = null;
    try {
      const { response, done } = await request('/models', { key, signal });
      try { live = await response.json(); } catch { live = null; }
      done();
    } catch (error) {
      return { models: table, source: 'table', error: error.code || 'HTTP_ERROR', message: error.message };
    }
    const ids = Array.isArray(live?.data) ? live.data.map((m) => (typeof m === 'string' ? m : m?.id)).filter((id) => typeof id === 'string' && id.trim()) : [];
    if (!ids.length) return { models: table, source: 'table', error: 'EMPTY' };
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      const row = findMaritacaModel(id);
      const canon = row ? row.id : id.trim();
      if (seen.has(canon.toLowerCase())) continue;
      seen.add(canon.toLowerCase());
      out.push(row ? { ...table.find((t) => t.id === row.id), listed: true } : {
        id: canon, label: canon, family: null, aliases: [], tier: null, contextWindow: null, maxOutput: null, reasoning: null, efforts: [], defaultEffort: null,
        toolcall: null, vision: false, price: null, region: null, free: false, description: null, batch: true, flex: true, rateLimit: null, isDefault: false, known: false, listed: true,
      });
    }
    for (const row of table) if (!seen.has(row.id.toLowerCase())) out.push({ ...row, listed: false });
    return { models: out, source: 'live' };
  }

  /**
   * Is the key accepted? GET /models first (free, read-only); an API that has no /models (404 / 405) is asked for
   * one token of the free model instead. Resolves { ok: true, via } or throws a maritacaError (KEY_REJECTED…).
   */
  async function verifyKey({ key, signal = null } = {}) {
    try {
      const { response, done } = await request('/models', { key, signal });
      try { await response.body?.cancel(); } catch { /* ignore */ }
      done();
      return { ok: true, via: 'models' };
    } catch (error) {
      if (error.code !== 'MODEL_UNKNOWN' && error.status !== 405) throw error;
    }
    const { response, done } = await request('/chat/completions', { key, method: 'POST', signal, body: { model: 'S5-free', messages: [{ role: 'user', content: 'oi' }], max_tokens: 1, stream: false } });
    try { await response.body?.cancel(); } catch { /* ignore */ }
    done();
    return { ok: true, via: 'completion' };
  }

  /**
   * POST /chat/completions; a 400 that refuses a sampling field ("Unsupported value: 'temperature' …") is asked once more
   * without temperature / top_p, so a model that takes only its default never fails a turn over a setting.
   */
  async function postCompletion(body, { key, signal }) {
    try {
      return await request('/chat/completions', { key, method: 'POST', body, signal, timeout: streamIdleMs });
    } catch (error) {
      if (!isSamplingRefusal(error) || (!('temperature' in body) && !('top_p' in body))) throw error;
      const { temperature: _t, top_p: _p, ...rest } = body;
      return request('/chat/completions', { key, method: 'POST', body: rest, signal, timeout: streamIdleMs });
    }
  }

  /** One non-streamed completion: resolves { text, reasoning, toolCalls, usage, finishReason, raw }. */
  async function chat({ key, signal = null, ...params } = {}) {
    const body = buildChatBody({ ...params, stream: false });
    const { response, done } = await postCompletion(body, { key, signal });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    done();
    if (!data || typeof data !== 'object') throw maritacaError('BAD_ANSWER', 'Maritaca answered with something that is not JSON.');
    const folder = createStreamFolder();
    folder.push(data);
    folder.push({ done: true });
    return { ...folder.end(), raw: data };
  }

  /**
   * One streamed completion (see the header). `signal` stops it; a stream that goes quiet for streamIdleMs (no bytes,
   * the clock reset by every chunk) ends with TIMEOUT; a long answer that keeps streaming has no total deadline.
   */
  async function chatStream({ key, signal = null, onEvent = () => {}, ...params } = {}) {
    const body = buildChatBody({ ...params, stream: true });
    const { response, done, touch } = await postCompletion(body, { key, signal });
    const folder = createStreamFolder(onEvent);
    try {
      if (!response.body) throw maritacaError('BAD_ANSWER', 'Maritaca sent no stream.');
      const contentType = String(response.headers?.get?.('content-type') || '');
      if (/application\/json/i.test(contentType) && !/event-stream/i.test(contentType)) {
        // An API that ignored `stream`: fold the one answer.
        let data = null;
        try { data = await response.json(); } catch { data = null; }
        folder.push(data);
        folder.push({ done: true });
        return folder.end();
      }
      let sawDone = false;
      for await (const chunk of parseSseChunks(touching(response.body, touch))) {
        if (chunk.done) sawDone = true;
        folder.push(chunk);
        if (sawDone) break;
      }
      if (!sawDone) folder.push({ done: true });
      return folder.end();
    } catch (error) {
      if (error?.code) throw error;
      throw networkError(error, signal);
    } finally { done(); }
  }

  return { baseUrl: base, listModels, verifyKey, chat, chatStream, models: () => MARITACA_MODELS };
}

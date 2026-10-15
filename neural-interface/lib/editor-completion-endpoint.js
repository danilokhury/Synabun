// ── AI autocomplete through an endpoint of the user's own ──
// A local Ollama, or anything that speaks the OpenAI completions or chat
// protocol. What is sent (docs/design/code-editor/SPEC.md, section 9.6):
//
//   ollama + fim   POST {url}/api/generate { model, prompt: prefix, suffix, stream, options, keep_alive }
//   ollama + chat  POST {url}/api/chat     { model, messages, stream, options, keep_alive }
//   openai + fim   POST {url} { model, prompt: prefix, suffix, max_tokens, temperature, stream }
//   openai + chat  POST {url} { model, messages, max_tokens, temperature, stream }
//
// `Authorization: Bearer` is added when SYNABUN_EDITOR_AI_KEY is set; the key is
// never part of an error, in any form: nothing an endpoint says about a failure
// (an error body, an error inside a stream) is passed on. An endpoint may repeat
// the request's Authorization header as sent, URL-encoded, JSON-escaped or in a
// form nobody listed, so its words are only read to pick one of a few sentences
// of this file's own (endpointFailure). Every failure of a call leaves here as
// an EndpointFailure with such a sentence. The answer is read as it streams
// (server-sent events, one JSON object per line, or one JSON body) until it
// ends, until the caller says it holds enough, or until the request is aborted.

const MAX_TOKENS = 256;
const TEMPERATURE = 0.1;
const MAX_REPLY_CHARS = 16_000;

const trimSlashes = (url) => String(url || '').replace(/\/+$/, '');

const REDACTED = '[redacted]';
// What follows "Bearer" in a header an endpoint echoes: the characters a token is made of (lib/editor-config.js).
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9._~+/=:@-]+/gi;

/**
 * A text without the endpoint's key as it was sent: the key itself wherever it stands, and whatever follows
 * "Bearer" (a credential whoever it belongs to). It knows the key in one form only, so it is not what keeps the
 * key out of an endpoint's errors (nothing an endpoint says is passed on: endpointFailure); it is a second rule
 * for text of this server's own.
 * @param {string} text
 * @param {string} [key] the endpoint's key (SYNABUN_EDITOR_AI_KEY), when one is set
 */
export function redactKey(text, key = '') {
  let out = String(text ?? '');
  if (key) out = out.split(String(key)).join(REDACTED);
  return out.replace(BEARER_TOKEN, `$1 ${REDACTED}`);
}

/** A failure of an endpoint call, in words of this file only: safe for the page, a test's row and the log. */
export class EndpointFailure extends Error {
  /** @param {string} message @param {{ status?: number | null, kind?: string | null }} [o] */
  constructor(message, { status = null, kind = null } = {}) {
    super(message);
    this.name = 'EndpointFailure';
    this.status = status;
    this.kind = kind;
  }
}

// What a failure is called, by what the answer mentions and by its status. The first sentence whose words are
// found wins; with no words found, the first whose statuses hold this one.
const FAILURE_KINDS = [
  { kind: 'model', says: 'it does not have that model', statuses: [], words: /model.{0,60}(?:not found|does not exist|doesn't exist|unknown|not supported|not available)|(?:no such|unknown|invalid) model|try pulling/i },
  { kind: 'key', says: 'it refused the key', statuses: [401, 403], words: /unauthori[sz]ed|incorrect api key|invalid.{0,12}(?:api.?key|token|credential)|authentication|not authenticated|forbidden|permission denied/i },
  { kind: 'rate', says: 'it takes no more requests for now', statuses: [429], words: /rate.?limit|too many requests|quota|insufficient.{0,12}(?:credit|balance|funds|quota)/i },
  { kind: 'long', says: 'the request is too long for the model', statuses: [413], words: /context.{0,20}(?:length|window)|too long|maximum.{0,20}tokens|too many tokens/i },
  { kind: 'busy', says: 'it is busy or still loading the model', statuses: [502, 503, 504], words: /overloaded|unavailable|loading model|still loading|timed? ?out/i },
  { kind: 'address', says: 'nothing takes completions at that address', statuses: [404, 405], words: null },
];
// Why a request never got an answer, by the code of what ended it (fetch's `cause`).
const NETWORK_KINDS = {
  ECONNREFUSED: 'nothing is listening at its address',
  ENOTFOUND: 'its address is not a name that is known',
  EAI_AGAIN: 'its address could not be looked up',
  ECONNRESET: 'it closed the connection',
  ETIMEDOUT: 'it did not answer in time',
  UND_ERR_CONNECT_TIMEOUT: 'it did not answer in time',
  UND_ERR_SOCKET: 'it closed the connection',
  CERT_HAS_EXPIRED: 'its certificate is not accepted',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its certificate is not accepted',
  SELF_SIGNED_CERT_IN_CHAIN: 'its certificate is not accepted',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its certificate is not accepted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate is not accepted',
  ERR_INVALID_URL: 'its address is not a URL',
};
const READ_FOR_KIND = 4000;

/**
 * What an endpoint's failure is called. `said` (its error body, or the error inside its stream) is read for what
 * it mentions and for nothing else: not a character of it is in the result.
 * @param {number | null} status the HTTP status, or null for an error an answer carried in its stream
 * @param {string} [said]
 * @returns {EndpointFailure}
 */
export function endpointFailure(status, said = '') {
  const words = String(said ?? '').slice(0, READ_FOR_KIND);
  const code = Number.isInteger(status) ? status : null;
  const found = FAILURE_KINDS.find((each) => each.words && each.words.test(words))
    || (code === null ? null : FAILURE_KINDS.find((each) => each.statuses.includes(code)));
  const lead = code === null ? 'The endpoint reported an error' : `The endpoint answered ${code}`;
  return new EndpointFailure(found ? `${lead}: ${found.says}` : lead, { status: code, kind: found?.kind ?? null });
}

/**
 * Whatever ended an endpoint call, as an EndpointFailure: its own when it is one; a request that got no answer by
 * the code of what ended it; anything else without its words (they are not this file's).
 */
export function asEndpointFailure(error) {
  if (error instanceof EndpointFailure) return error;
  // fetch says "fetch failed" and keeps the reason in `cause` (several of them when a name has several addresses).
  const causes = [error?.cause, error, error?.cause?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors : [])];
  const code = causes.map((each) => each?.code).find((each) => typeof each === 'string' && Object.hasOwn(NETWORK_KINDS, each));
  return new EndpointFailure(code ? `The endpoint could not be reached: ${NETWORK_KINDS[code]}` : 'The endpoint could not be asked', { kind: code ? 'network' : null });
}

/**
 * The HTTP request of one completion.
 * @param {object} o
 * @param {{ kind: 'ollama' | 'openai', url: string, model: string, shape: 'fim' | 'chat' }} o.endpoint `ai.endpoint`
 * @param {string} [o.key] the bearer token, when one is set
 * @param {{ prefix: string, suffix: string }} o.request
 * @param {{ system: string, user: string }} o.prompt the chat messages (lib/editor-completion.js buildChatPrompt)
 * @returns {{ url: string, headers: object, body: object }}
 */
export function endpointRequest({ endpoint, key = '', request, prompt }) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/x-ndjson, application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const messages = [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }];
  if (endpoint.kind === 'ollama') {
    // The address is the server's; a pasted /api/generate or /api/chat is not doubled.
    const base = trimSlashes(endpoint.url).replace(/\/api\/(?:generate|chat)$/, '');
    const common = { model: endpoint.model, stream: true, options: { temperature: TEMPERATURE, num_predict: MAX_TOKENS }, keep_alive: '30m' };
    return endpoint.shape === 'chat'
      ? { url: `${base}/api/chat`, headers, body: { ...common, messages } }
      : { url: `${base}/api/generate`, headers, body: { ...common, prompt: request.prefix, suffix: request.suffix } };
  }
  const common = { model: endpoint.model, max_tokens: MAX_TOKENS, temperature: TEMPERATURE, stream: true };
  return endpoint.shape === 'chat'
    ? { url: endpoint.url, headers, body: { ...common, messages } }
    : { url: endpoint.url, headers, body: { ...common, prompt: request.prefix, suffix: request.suffix } };
}

/**
 * What one object of an answer holds, whichever of the four protocols it is.
 * @param {object} chunk
 * @returns {{ text: string, done: boolean, tokens: { input: number, output: number } | null, error: string | null }}
 *   `error`: what the failure is called (endpointFailure), never the endpoint's own words
 */
export function readChunk(chunk) {
  const out = { text: '', done: false, tokens: null, error: null };
  if (!chunk || typeof chunk !== 'object') return out;
  if (chunk.error) {
    let said = '';
    try { said = typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error); } catch { said = ''; }
    out.error = endpointFailure(null, said).message;
    return out;
  }
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  const text = chunk.response ?? chunk.message?.content ?? choice?.text ?? choice?.delta?.content ?? choice?.message?.content;
  if (typeof text === 'string') out.text = text;
  out.done = chunk.done === true || (choice != null && choice.finish_reason != null);
  const input = chunk.prompt_eval_count ?? chunk.usage?.prompt_tokens;
  const output = chunk.eval_count ?? chunk.usage?.completion_tokens;
  if (Number.isFinite(input) || Number.isFinite(output)) out.tokens = { input: Math.round(input || 0), output: Math.round(output || 0) };
  return out;
}

/**
 * Read an answer to its end, or until `isDone(text)` says it holds enough.
 * @param {Response} res
 * @param {{ isDone?: (text: string) => boolean }} [o]
 * @returns {Promise<{ text: string, tokens: { input: number, output: number } | null, stoppedEarly: boolean }>}
 *   rejects with an EndpointFailure for an error the answer carries, and for an answer that cannot be read
 */
export async function readEndpointAnswer(res, { isDone = () => false } = {}) {
  let text = '';
  let tokens = null;
  let pending = '';        // the line that is still arriving
  let unparsed = '';       // lines that were not objects on their own: one JSON body spread over several lines
  let finished = false;

  const take = (chunk) => {
    const part = readChunk(chunk);
    if (part.error) throw new EndpointFailure(part.error, { kind: 'reported' });
    text += part.text;
    if (part.tokens) tokens = part.tokens;
    if (part.done) finished = true;
  };
  const line = (raw) => {
    let value = raw.trim();
    if (!value || value.startsWith(':') || value.startsWith('event:') || value.startsWith('id:') || value.startsWith('retry:')) return;
    if (value.startsWith('data:')) value = value.slice(5).trim();
    if (value === '[DONE]') { finished = true; return; }
    let chunk;
    try { chunk = JSON.parse(value); } catch { unparsed += `${raw}\n`; return; }
    take(chunk);
  };

  const reader = res.body?.getReader?.();
  if (!reader) {
    for (const each of (await res.text()).split('\n')) line(each);
  } else {
    const decoder = new TextDecoder();
    let stoppedEarly = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const each of lines) line(each);
        if (finished) break;
        if (text.length > MAX_REPLY_CHARS || isDone(text)) { stoppedEarly = true; break; }
      }
    } finally {
      // Whatever is still on its way is not wanted: the connection is given back.
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    if (stoppedEarly) return { text, tokens, stoppedEarly: true };
    if (pending) line(pending);
  }
  if (unparsed.trim() && !text) {
    let whole;
    try { whole = JSON.parse(unparsed); } catch { throw new EndpointFailure('The endpoint did not answer in a form this editor reads', { kind: 'form' }); }
    take(whole);
  }
  return { text, tokens, stoppedEarly: false };
}

/** @param {{ fetchImpl?: typeof fetch }} [deps] */
export function createEndpointCompletionEngine({ fetchImpl = (...args) => fetch(...args) } = {}) {
  return {
    /**
     * One completion.
     * @param {object} o
     * @param {{ kind: string, url: string, model: string, shape: string }} o.endpoint
     * @param {string} [o.key]
     * @param {{ prefix: string, suffix: string }} o.request
     * @param {{ system: string, user: string }} o.prompt
     * @param {AbortSignal} [o.signal]
     * @param {(text: string) => boolean} [o.isDone] the first stop condition: the answer so far holds all that would be shown
     * @returns {Promise<{ text: string, tokens: { input: number, output: number } | null }>} rejects with an
     *   EndpointFailure (its message holds nothing the endpoint said), or with the abort when `signal` fired
     */
    async complete({ endpoint, key = '', request, prompt, signal, isDone } = {}) {
      const { url, headers, body } = endpointRequest({ endpoint, key, request, prompt });
      // Our own controller, so an answer that holds enough can be cut off without the caller aborting.
      const own = new AbortController();
      const onAbort = () => own.abort();
      if (signal?.aborted) own.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: own.signal });
        // What it says is read for what the failure is called, and stays here.
        if (!res.ok) throw endpointFailure(res.status, await res.text().catch(() => ''));
        const answer = await readEndpointAnswer(res, { isDone });
        return { text: answer.text, tokens: answer.tokens };
      } catch (error) {
        // The caller gave up: that is not the endpoint's failure.
        if (signal?.aborted) throw error;
        throw asEndpointFailure(error);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        own.abort();
      }
    },
  };
}

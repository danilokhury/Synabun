// ── The code editor's AI autocomplete: the service and its routes ──
// The File Explorer's editor asks for the text to insert at the caret
// (POST /api/editor/complete); this module decides whether the request is
// answered at all, what the model is told, and what of its reply is fit to
// show. Two engines do the asking: OpenCode models through a dedicated serve
// (lib/editor-completion-opencode.js) and a user-configured Ollama or
// OpenAI-compatible endpoint (lib/editor-completion-endpoint.js).
//
// Nothing is sent while `ai.enabled` is off, for a file whose name matches
// `ai.exclude`, or when the text around the caret holds a private key: the
// same rules the page applies (public/shared/editor/editor-ai-logic.js),
// checked again here against the stored preferences. A request that the page
// gives up on is aborted at the engine. Dependencies are injected: the service
// is tested with fake engines, never against a model.
//
//   POST /api/editor/complete           { path, language, indentUnit, prefix, suffix, header?, neighbors?, trigger }
//     200 { ok, completion, ms, model, tokens? } · 400 { code: 'invalid' } · 403 { code: 'excluded' }
//     409 { code: 'disabled' } · 429 { code: 'rate', retryAfterMs } · 502 { code: 'engine', message, reason? }
//   POST /api/editor/complete/test      { engine?, model?, fastest? } → { ok, results: [{ model, ok, ms, tokens, sample }], fastest }
//     a row that could not be asked says why: { ok: false, error, reason: 'rate', retryAfterMs } once the minute's
//     requests are used up (a test, "Find fastest" and its warm-up runs count like completions)
//   GET  /api/editor/complete/models    → { ok, available, models: [{ id, label, provider, price, free, fast, context }] }
//   GET  /api/editor/complete/usage     → { ok, today: { day, requests, shown, accepted, tokensIn, tokensOut } }
//   POST /api/editor/complete/feedback  { shown?, accepted? } → { ok }

import { Router } from 'express';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { replaceFileAtomic } from './confined-fs.js';
import { parseOpenCodeProviders } from './assistant-catalog.js';
import { asEndpointFailure, redactKey } from './editor-completion-endpoint.js';
import {
  AI_LIMITS, clampHeader, clampPrefix, clampSuffix, hasPrivateKey, matchesExclude,
} from '../public/shared/editor/editor-ai-logic.js';

/** What these routes add to the editor (GET /api/editor/capabilities). */
export const EDITOR_COMPLETION_CAPABILITIES = Object.freeze(['complete']);
export const RATE_LIMIT_PER_MINUTE = 60;
export const ENGINE_TIMEOUT_MS = 6000;
/** How many models "Find fastest" tries. */
export const FASTEST_CANDIDATES = 4;

/**
 * What a chat model is told. It is the dedicated OpenCode serve's agent prompt and the endpoint's system message,
 * the same bytes in every request: a provider that caches the start of a prompt reuses it.
 */
export const COMPLETION_SYSTEM = 'You complete code at the cursor. Reply with only the text to insert, inside <COMPLETION> tags. No explanation, no code fences, nothing that already appears before or after the cursor.';

const CURSOR = '<CURSOR/>';
const CURSOR_ALTERNATIVES = ['<CURSOR/>', '<CARET_HERE/>', '<<<CARET>>>'];

// ── The request ──

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanLine = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const unixBreaks = (text) => text.replace(/\r\n?/g, '\n');

/**
 * A request as the service uses it, from whatever the page sent: texts cut to their limits (the prefix from a line
 * start, the suffix to a line end), line breaks as "\n".
 * @returns {{ ok: true, request: object } | { ok: false, error: string }}
 */
export function normalizeCompletionRequest(body) {
  if (!isObject(body)) return { ok: false, error: 'The body must be an object' };
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path || path.length > AI_LIMITS.pathChars || path.includes('\0')) return { ok: false, error: 'path must be the path of the file being edited' };
  if (typeof body.prefix !== 'string') return { ok: false, error: 'prefix must be the text before the caret' };
  if (body.suffix !== undefined && typeof body.suffix !== 'string') return { ok: false, error: 'suffix must be the text after the caret' };
  if (body.header !== undefined && typeof body.header !== 'string') return { ok: false, error: 'header must be text' };
  if (body.neighbors !== undefined && !Array.isArray(body.neighbors)) return { ok: false, error: 'neighbors must be a list' };
  const neighbors = [];
  for (const item of body.neighbors || []) {
    if (!isObject(item) || typeof item.path !== 'string' || typeof item.text !== 'string') return { ok: false, error: 'a neighbor is { path, text }' };
    if (neighbors.length < AI_LIMITS.neighborCount && item.text.trim()) {
      neighbors.push({ path: item.path.slice(0, AI_LIMITS.pathChars), text: unixBreaks(item.text).slice(0, AI_LIMITS.neighborChars) });
    }
  }
  const indentUnit = typeof body.indentUnit === 'string' && /^(?: {1,8}|\t)$/.test(body.indentUnit) ? body.indentUnit : '  ';
  return {
    ok: true,
    request: {
      path,
      language: cleanLine(body.language, 60),
      indentUnit,
      prefix: clampPrefix(unixBreaks(body.prefix)),
      suffix: clampSuffix(unixBreaks(body.suffix || '')),
      header: clampHeader(unixBreaks(body.header || '')),
      neighbors,
      trigger: body.trigger === 'manual' ? 'manual' : 'auto',
    },
  };
}

/**
 * Why a request is not sent to any model, or null when it may be.
 * @param {object} request from normalizeCompletionRequest()
 * @param {string[]} exclude `ai.exclude`
 * @returns {null | { reason: 'file' | 'private-key' }}
 */
export function refusal(request, exclude) {
  if (matchesExclude(request.path, exclude)) return { reason: 'file' };
  if (request.neighbors.some((n) => matchesExclude(n.path, exclude))) return { reason: 'file' };
  if (hasPrivateKey(request.prefix, request.suffix, request.header, ...request.neighbors.map((n) => n.text))) return { reason: 'private-key' };
  return null;
}

// ── The prompt ──

/** The path a model is shown: the file's name and the folder it is in, never the folders above. */
export function promptPath(path) {
  return String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
}

const describeIndent = (unit) => (unit === '\t' ? 'tabs' : `${unit.length} spaces`);

/**
 * The messages of a chat model: the fixed system message, and one user message with the file's path and language,
 * the start of the file and snippets of other files when there are any, then the text around the caret with a
 * marker where the caret is.
 * @param {object} request from normalizeCompletionRequest()
 * @returns {{ system: string, user: string, marker: string }}
 */
export function buildChatPrompt(request) {
  const around = `${request.prefix}${request.suffix}`;
  const marker = CURSOR_ALTERNATIVES.find((m) => !around.includes(m)) || CURSOR;
  const lines = [`File: ${promptPath(request.path)}`];
  if (request.language) lines.push(`Language: ${request.language}`);
  lines.push(`Indentation: ${describeIndent(request.indentUnit)}`);
  if (request.header) lines.push('', 'The file begins with:', request.header);
  for (const neighbor of request.neighbors) lines.push('', `From another open file, ${promptPath(neighbor.path)}:`, neighbor.text);
  lines.push('', `Complete the code at ${marker}:`, `${request.prefix}${marker}${request.suffix}`);
  return { system: COMPLETION_SYSTEM, user: lines.join('\n'), marker };
}

// ── The reply ──

const OPEN_TAG = /<COMPLETION>/i;
const CLOSE_TAG = /<\/COMPLETION>/i;
const FENCE_BLOCK = /```[^\n`]*\n([\s\S]*?)(?:\n?```|$)/;   // ```js ⏎ … ⏎ ```, closed or cut short
const FENCE_INLINE = /```([^`]+)```/;                      // ```…``` on one line

/** The answer inside a reply: the body of its <COMPLETION> tags, else its first fenced block, else the reply itself. */
export function extractCompletion(raw) {
  let text = String(raw ?? '');
  const open = OPEN_TAG.exec(text);
  let tagged = false;
  if (open) {
    tagged = true;
    text = text.slice(open.index + open[0].length);
    const close = CLOSE_TAG.exec(text);
    if (close) text = text.slice(0, close.index);
  }
  // A fence around the answer: always when there are no tags, and inside the tags only when it wraps all of it.
  if (tagged ? /^\s*```/.test(text) : text.includes('```')) {
    const fenced = FENCE_BLOCK.exec(text) || FENCE_INLINE.exec(text);
    if (fenced) text = fenced[1];
  }
  return text.replace(/<\/?COMPLETION>/gi, '');
}

const WORD_BEGUN = /[\p{L}_$][\p{L}\p{N}_$]*$/u;

function dropLeadingRepeat(text, linePrefix) {
  if (!linePrefix) return text;
  if (text.startsWith(linePrefix)) return text.slice(linePrefix.length);
  const written = linePrefix.trimStart();
  if (written) {
    if (text.startsWith(written)) return text.slice(written.length);
    // A word that was begun, written out from its first letter again ("ret" + "return x" is "return x").
    const begun = WORD_BEGUN.exec(written)?.[0];
    return begun && text.startsWith(begun) ? text.slice(begun.length) : text;
  }
  // Only indentation so far: the model's own indentation of its first line is the same indentation again.
  const indent = /^[ \t]*/.exec(text)[0];
  return text.slice(Math.min(indent.length, linePrefix.length));
}

const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const QUOTES = '\'"`';

/** How many brackets a text opens and does not close (brackets inside its strings are text). */
function unclosedBrackets(text) {
  const open = [];
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote || (ch === '\n' && quote !== '`')) quote = '';
      continue;
    }
    if (QUOTES.includes(ch)) quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') open.push(ch);
    else if (CLOSERS[ch] && open[open.length - 1] === CLOSERS[ch]) open.pop();
  }
  return open.length;
}

function cutTail(text, suffix) {
  const max = Math.min(text.length, suffix.length);
  for (let k = max; k > 0; k--) {
    const tail = suffix.slice(0, k);
    if (!text.endsWith(tail)) continue;
    // one letter or digit is too little to call a repeat of what follows
    if (k === 1 && /[\p{L}\p{N}_]/u.test(tail)) return text;
    const kept = text.slice(0, text.length - k);
    // A bracket that closes one the reply opened is the reply's own, however much it looks like what follows.
    if (/[)\]}]/.test(tail) && unclosedBrackets(kept) > 0) continue;
    return kept;
  }
  return text;
}

/** `text` without a trailing run that repeats the start of `suffix`. */
function cutSuffixOverlap(text, suffix) {
  if (!text || !suffix) return text;
  const cut = cutTail(text, suffix);
  if (cut !== text) return cut;
  const trimmed = text.replace(/\s+$/, '');
  return trimmed === text ? text : cutTail(trimmed, suffix);
}

/**
 * One line of a reply, cut where it starts to repeat the closing punctuation that already follows the caret: at
 * a closing bracket the line itself never opened, or at the closing quote of a string it is inside of.
 */
function cutAtExistingCloser(line, rest) {
  const closer = rest[0];
  if (!closer) return line;
  if (QUOTES.includes(closer)) {
    const at = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === closer) at.push(i);
    }
    return at.length % 2 === 1 ? line.slice(0, at[at.length - 1]) : line;
  }
  if (!CLOSERS[closer]) return line;
  const open = [];
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (QUOTES.includes(ch)) { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { open.push(ch); continue; }
    if (!CLOSERS[ch]) continue;
    if (open.length && open[open.length - 1] === CLOSERS[ch]) { open.pop(); continue; }
    if (ch === closer) return line.slice(0, i);
  }
  return line;
}

function capChars(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lineEnd = cut.lastIndexOf('\n');
  return lineEnd > 0 ? cut.slice(0, lineEnd) : cut;
}

/**
 * What of a model's reply is shown as the suggestion. In order: the <COMPLETION> body (else the reply without its
 * code fence); line breaks as "\n"; a leading repeat of the caret's line dropped; a trailing run that repeats what
 * follows the caret cut; one line only when the caret is in the middle of a line; at most `maxLines` lines and
 * 1,200 characters; and nothing at all when only white space is left.
 * @param {string} raw the model's reply
 * @param {{ prefix?: string, suffix?: string, maxLines?: number }} around the request's texts, and `ai.maxLines`
 * @returns {string}
 */
export function cleanCompletion(raw, { prefix = '', suffix = '', maxLines = 12 } = {}) {
  let text = unixBreaks(extractCompletion(raw));
  for (const marker of CURSOR_ALTERNATIVES) text = text.split(marker).join('');
  const linePrefix = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const lineEnd = suffix.indexOf('\n');
  const lineSuffix = lineEnd < 0 ? suffix : suffix.slice(0, lineEnd);
  const midLine = lineSuffix.trim() !== '';

  // An empty line being filled: the answer starts on it, not on the line below.
  if (!linePrefix.trim()) text = text.replace(/^(?:[ \t]*\n)+/, '');
  text = dropLeadingRepeat(text, linePrefix);
  // After text that already ends in a space, a reply that begins with more of them would only double it.
  if (/\S[ \t]+$/.test(linePrefix)) text = text.replace(/^[ \t]+/, '');
  text = cutSuffixOverlap(text, suffix);
  if (midLine) {
    text = text.replace(/^\n+/, '').split('\n')[0];
    text = cutSuffixOverlap(text, lineSuffix);
    text = cutAtExistingCloser(text, lineSuffix.trimStart());
  }
  const lines = Math.max(1, Math.round(Number(maxLines) || 12));
  text = text.split('\n').slice(0, lines).join('\n');
  text = capChars(text, AI_LIMITS.completionChars);
  text = text.replace(/\s+$/, '');
  return text.trim() ? text : '';
}

/**
 * Whether a reply that is still arriving already holds all that would be shown, so the stream can be closed.
 * @param {string} raw what has arrived
 * @param {{ chat?: boolean, suffix?: string, maxLines?: number }} o `chat`: the reply is a chat model's
 */
export function replyIsComplete(raw, { chat = false, suffix = '', maxLines = 12 } = {}) {
  const text = String(raw ?? '');
  let body = text;
  if (chat) {
    const open = OPEN_TAG.exec(text);
    if (open) {
      body = text.slice(open.index + open[0].length);
      if (CLOSE_TAG.test(body)) return true;
    } else {
      // no tags yet: a fenced block that has closed is an answer; otherwise wait, up to a limit
      if ((text.match(/```/g) || []).length >= 2) return true;
      return text.length > 8000;
    }
  }
  if (body.length > AI_LIMITS.completionChars + 400) return true;
  if (body.split('\n').length > Math.max(1, maxLines) + 2) return true;
  const lineEnd = suffix.indexOf('\n');
  const midLine = (lineEnd < 0 ? suffix : suffix.slice(0, lineEnd)).trim() !== '';
  return midLine && /\S[^\n]*\n/.test(body);
}

// ── Limits and counters ──

/**
 * At most `limit` requests in any `windowMs`.
 * @returns {{ take: () => { ok: true } | { ok: false, retryAfterMs: number }, count: () => number }}
 */
export function createRateLimiter({ limit = RATE_LIMIT_PER_MINUTE, windowMs = 60_000, now = Date.now } = {}) {
  let taken = [];
  const live = () => { const from = now() - windowMs; taken = taken.filter((at) => at > from); return taken; };
  return {
    take() {
      const at = now();
      if (live().length >= limit) return { ok: false, retryAfterMs: Math.max(1, taken[0] + windowMs - at) };
      taken.push(at);
      return { ok: true };
    },
    count: () => live().length,
  };
}

const USAGE_FIELDS = ['requests', 'shown', 'accepted', 'tokensIn', 'tokensOut'];
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * The counters of AI autocomplete by day (DATA_HOME/data/editor-ai-usage.json): requests sent to a model,
 * suggestions shown and accepted, tokens in and out. Written a moment after a change, and at shutdown.
 * @param {{ path: string, now?: () => number, keepDays?: number, flushMs?: number, log?: (tag: string, message: string) => void }} o
 */
export function createUsageStore({ path, now = Date.now, keepDays = 60, flushMs = 2000, log = () => {} } = {}) {
  if (!path) throw new Error('createUsageStore requires path');
  let days = null;
  let timer = null;
  let dirty = false;

  function load() {
    if (days) return days;
    days = {};
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8'))?.days;
      if (isObject(stored)) {
        for (const [day, row] of Object.entries(stored)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(row)) continue;
          days[day] = Object.fromEntries(USAGE_FIELDS.map((f) => [f, Math.max(0, Math.round(Number(row[f]) || 0))]));
        }
      }
    } catch (error) { if (error?.code !== 'ENOENT') log('editor-ai-usage:unreadable', error?.message || String(error)); }
    return days;
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    const kept = Object.keys(load()).sort().slice(-keepDays);
    days = Object.fromEntries(kept.map((day) => [day, days[day]]));
    try {
      mkdirSync(dirname(path), { recursive: true });
      replaceFileAtomic(path, `${JSON.stringify({ version: 1, days }, null, 2)}\n`);
    } catch (error) { log('editor-ai-usage:unwritable', error?.message || String(error)); }
  }

  /** Add to today's counters. */
  function add(change = {}) {
    const day = dayOf(now());
    const row = load()[day] || (days[day] = Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])));
    let changed = false;
    for (const field of USAGE_FIELDS) {
      const n = Math.round(Number(change[field]) || 0);
      if (n > 0) { row[field] += n; changed = true; }
    }
    if (!changed) return;
    dirty = true;
    if (!timer && flushMs > 0) { timer = setTimeout(flush, flushMs); timer.unref?.(); }
    if (flushMs <= 0) flush();
  }

  function today() {
    const day = dayOf(now());
    return { day, ...(load()[day] || Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0]))) };
  }

  return { add, today, flush, path };
}

// ── Models ──

const FAST_NAME = /(flash|nano|lite|instant|fast|mini|haiku|luna|tiny|small)/i;

/**
 * A model of the picker, from a row of the Assistant's catalog (lib/assistant-catalog.js parseOpenCodeProviders).
 * `fast`: a small model by its name or its price, the kind worth trying for completions.
 */
export function modelOfRow(row) {
  const price = row.price ? { input: row.price.input, output: row.price.output } : null;
  return {
    id: row.id,
    label: row.label || row.id,
    provider: row.upstream || row.id.split('/')[0],
    price,
    free: row.price?.basis === 'free',
    fast: row.tier === 'small',
    context: row.contextWindow ?? null,
  };
}

/** The models "Find fastest" tries: the selected one, then the fast ones, the likeliest first. At most four. */
export function fastestCandidates(models, selected = null, max = FASTEST_CANDIDATES) {
  const rank = (m) => [FAST_NAME.test(`${m.id} ${m.label}`) ? 0 : 1, m.price ? m.price.output : Number.MAX_VALUE, m.id];
  const fast = models.filter((m) => m.fast).sort((a, b) => {
    const ra = rank(a); const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0);
  });
  const current = selected && models.find((m) => m.id === selected);
  const out = current ? [current] : [];
  for (const model of fast) if (out.length < max && !out.includes(model)) out.push(model);
  return out.slice(0, max);
}

/** The fixed sample a test sends: never the user's code. */
export const TEST_REQUEST = Object.freeze({
  path: 'samples/timing.js',
  language: 'JavaScript',
  indentUnit: '  ',
  prefix: '// Calls fn once the calls have stopped for `wait` milliseconds.\nexport function debounce(fn, wait) {\n  let timer = null;\n  return function debounced(...args) {\n    ',
  suffix: '\n  };\n}\n',
  header: '',
  neighbors: [],
  trigger: 'manual',
});

// ── The service ──

const validModelId = (id) => typeof id === 'string' && id.length <= 300 && id.includes('/') && !id.startsWith('/') && !id.endsWith('/');
const reply = (status, body) => ({ status, body });
// An engine's own words, for the page and the log.
const messageOf = (error, key = '') => redactKey(String(error?.message || error || 'The request failed'), key).replace(/\s+/g, ' ').trim().slice(0, 400);
// A failed call to the user's endpoint: only a sentence of lib/editor-completion-endpoint.js leaves (the status
// and what the failure is called). Whatever else an error says is not passed on, since an endpoint may have
// repeated the key in any form; the key as it was sent is taken out all the same.
const endpointMessageOf = (error, key = '') => messageOf(asEndpointFailure(error), key);

/**
 * @param {object} deps
 * @param {() => object} deps.readConfig the editor's stored configuration (lib/editor-config.js store.read)
 * @param {{ opencode: object, endpoint: object }} deps.engines `opencode`: { complete, providers, running, drain?, stop };
 *   `endpoint`: { complete }
 * @param {() => string} [deps.getEndpointKey] SYNABUN_EDITOR_AI_KEY, or '' when none is set
 * @param {() => Promise<object | null>} [deps.sharedProviders] the shared OpenCode serve's /provider answer when
 *   that serve is running (the model list, without starting anything), else null
 * @param {(id: string) => boolean} [deps.isHiddenModel] models the user hid in Settings → OpenCode
 * @param {object} deps.usage createUsageStore()
 * @param {() => number} [deps.now]
 * @param {number} [deps.limitPerMinute]
 * @param {number} [deps.timeoutMs] after this long an engine call is abandoned
 */
export function createEditorCompletionService({
  readConfig, engines, getEndpointKey = () => '', sharedProviders = async () => null, isHiddenModel = () => false,
  usage, now = Date.now, limitPerMinute = RATE_LIMIT_PER_MINUTE, timeoutMs = ENGINE_TIMEOUT_MS, log = () => {},
} = {}) {
  if (typeof readConfig !== 'function') throw new Error('createEditorCompletionService requires readConfig');
  if (!engines?.opencode || !engines?.endpoint) throw new Error('createEditorCompletionService requires both engines');
  if (!usage) throw new Error('createEditorCompletionService requires a usage store');
  const limiter = createRateLimiter({ limit: limitPerMinute, now });
  const ai = () => readConfig().ai;

  /** Which engine and model a configuration means, or why there is none. */
  function targetOf(config, { engine = config.engine, model = null } = {}) {
    if (engine === 'endpoint') {
      const { url, model: name, kind, shape } = config.endpoint;
      if (!url || !name) return { error: 'no-endpoint', message: 'The endpoint has no address or no model yet' };
      return { engine: 'endpoint', endpoint: { url, model: name, kind, shape }, label: name };
    }
    const id = model || config.model;
    if (!validModelId(id)) return { error: 'no-model', message: 'No model is selected yet' };
    return { engine: 'opencode', model: id, label: id };
  }

  /** One request through an engine. Never throws: a failure, a timeout and an abort are results. */
  async function run(target, request, { maxLines, signal } = {}) {
    const started = now();
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    const both = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
    try {
      const prompt = buildChatPrompt(request);
      const out = target.engine === 'endpoint'
        ? await engines.endpoint.complete({
          endpoint: target.endpoint, key: getEndpointKey(), request, prompt, signal: both,
          isDone: (raw) => replyIsComplete(raw, { chat: target.endpoint.shape === 'chat', suffix: request.suffix, maxLines }),
        })
        : await engines.opencode.complete({ model: target.model, user: prompt.user, signal: both });
      const tokens = out?.tokens && (out.tokens.input || out.tokens.output)
        ? { input: Math.round(Number(out.tokens.input) || 0), output: Math.round(Number(out.tokens.output) || 0) } : null;
      if (tokens) usage.add({ tokensIn: tokens.input, tokensOut: tokens.output });
      return { ok: true, completion: cleanCompletion(out?.text, { prefix: request.prefix, suffix: request.suffix, maxLines }), ms: now() - started, model: target.label, tokens };
    } catch (error) {
      if (signal?.aborted) return { aborted: true };
      if (timer.signal.aborted) return { ok: false, reason: 'timeout', message: `No answer within ${Math.round(timeoutMs / 1000)} seconds`, ms: now() - started, model: target.label };
      const message = target.engine === 'endpoint' ? endpointMessageOf(error, getEndpointKey()) : messageOf(error);
      log('editor-complete:engine', message);
      return { ok: false, message, ms: now() - started, model: target.label };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * One request to a model, whoever asks for it: a completion, a test, a run of "Find fastest" (the first one that
   * only warms the connection up included). Each takes one of the minute's requests before anything is sent, and
   * is counted when it is. Out of requests, nothing is sent: `{ ok: false, limited: true, reason: 'rate', … }`.
   */
  async function attempt(target, request, options) {
    const slot = limiter.take();
    if (!slot.ok) {
      const seconds = Math.max(1, Math.ceil(slot.retryAfterMs / 1000));
      return { ok: false, limited: true, reason: 'rate', retryAfterMs: slot.retryAfterMs, message: `Too many requests in the last minute: try again in ${seconds} seconds`, ms: null, model: target.label };
    }
    usage.add({ requests: 1 });
    return run(target, request, options);
  }

  /**
   * POST /api/editor/complete.
   * @param {object} body
   * @param {{ signal?: AbortSignal }} [o] `signal` fires when the page gave up on the request
   * @returns {Promise<{ status: number, body: object } | { aborted: true }>}
   */
  async function complete(body, { signal } = {}) {
    const config = ai();
    if (!config.enabled) return reply(409, { ok: false, code: 'disabled' });
    const parsed = normalizeCompletionRequest(body);
    if (!parsed.ok) return reply(400, { ok: false, code: 'invalid', error: parsed.error });
    if (!config.neighbors) parsed.request.neighbors = [];
    const refused = refusal(parsed.request, config.exclude);
    if (refused) return reply(403, { ok: false, code: 'excluded', reason: refused.reason });
    const target = targetOf(config);
    if (target.error) return reply(502, { ok: false, code: 'engine', reason: target.error, message: target.message });
    const result = await attempt(target, parsed.request, { maxLines: config.maxLines, signal });
    if (result.limited) return reply(429, { ok: false, code: 'rate', retryAfterMs: result.retryAfterMs });
    if (result.aborted) return { aborted: true };
    if (!result.ok) return reply(502, { ok: false, code: 'engine', message: result.message, ...(result.reason ? { reason: result.reason } : {}) });
    return reply(200, { ok: true, completion: result.completion, ms: result.ms, model: result.model, ...(result.tokens ? { tokens: result.tokens } : {}) });
  }

  const testResult = (model, result) => (result.ok
    ? { model, ok: true, ms: result.ms, tokens: result.tokens, sample: result.completion.slice(0, 400) }
    : {
      model, ok: false, ms: result.ms ?? null, tokens: null, sample: '', error: result.message,
      ...(result.reason ? { reason: result.reason } : {}), ...(result.limited ? { retryAfterMs: result.retryAfterMs } : {}),
    });

  async function testOne(target, { signal, twice = false } = {}) {
    let result = await attempt(target, TEST_REQUEST, { maxLines: 12, signal });
    // The first request to a model also pays for the connection: when it went well, the second one is the measure
    // (when there is a request left for it; the first one stands otherwise).
    if (twice && result.ok && result.ms <= timeoutMs / 2 && !signal?.aborted) {
      const again = await attempt(target, TEST_REQUEST, { maxLines: 12, signal });
      if (again.ok && again.ms < result.ms) result = again;
    }
    return result;
  }

  /**
   * POST /api/editor/complete/test: the fixed sample through one model, through the endpoint, or through up to
   * four fast models ("Find fastest"). It runs whether or not the feature is on: it is how a model is chosen.
   */
  async function test(body = {}, { signal } = {}) {
    const config = ai();
    const input = isObject(body) ? body : {};
    const engine = input.engine === 'endpoint' || input.engine === 'opencode' ? input.engine : config.engine;
    if (engine === 'endpoint') {
      const target = targetOf(config, { engine: 'endpoint' });
      if (target.error) return reply(200, { ok: true, results: [{ model: config.endpoint.model || '', ok: false, ms: null, tokens: null, sample: '', error: target.message, reason: target.error }], fastest: null });
      const result = await testOne(target, { signal });
      if (result.aborted) return { aborted: true };
      return reply(200, { ok: true, results: [testResult(target.label, result)], fastest: null });
    }
    if (input.fastest) {
      const listed = await models({ start: true, signal });
      const candidates = fastestCandidates(listed.body.models, config.model);
      if (!candidates.length) return reply(200, { ok: true, results: [], fastest: null, reason: listed.body.available ? 'no-fast-model' : 'unavailable', ...(listed.body.message ? { message: listed.body.message } : {}) });
      const results = [];
      let limited = null;
      for (const candidate of candidates) {
        const result = await testOne({ engine: 'opencode', model: candidate.id, label: candidate.id }, { signal, twice: true });
        if (result.aborted) return { aborted: true };
        results.push(testResult(candidate.id, result));
        // Out of requests: the models after this one are not asked. What was measured so far stands.
        if (result.limited) { limited = result; break; }
      }
      const best = results.filter((r) => r.ok && r.sample).sort((a, b) => a.ms - b.ms)[0] || null;
      return reply(200, {
        ok: true, results, fastest: best ? best.model : null,
        ...(limited && !best ? { reason: 'rate', message: limited.message, retryAfterMs: limited.retryAfterMs } : {}),
      });
    }
    const target = targetOf(config, { engine: 'opencode', model: validModelId(input.model) ? input.model : null });
    if (target.error) return reply(200, { ok: true, results: [{ model: '', ok: false, ms: null, tokens: null, sample: '', error: target.message, reason: target.error }], fastest: null });
    const result = await testOne(target, { signal });
    if (result.aborted) return { aborted: true };
    return reply(200, { ok: true, results: [testResult(target.label, result)], fastest: null });
  }

  /**
   * GET /api/editor/complete/models: the connected OpenCode models the user has not hidden. Read from the
   * dedicated serve when it is running, else from the shared one; the dedicated serve is started for it only
   * when `start` is set (the user asked for the list, or for a test).
   */
  async function models({ start = false, signal } = {}) {
    let data = null;
    let source = null;
    let message = '';
    if (engines.opencode.running()) {
      data = await engines.opencode.providers({ signal }).catch(() => null);
      if (data) source = 'dedicated';
    }
    if (!data) {
      data = await Promise.resolve().then(() => sharedProviders()).catch(() => null);
      if (data) source = 'shared';
    }
    if (!data && start) {
      data = await engines.opencode.providers({ start: true, signal }).catch((error) => { message = messageOf(error); return null; });
      if (data) source = 'dedicated';
    }
    const selected = ai().model;
    if (!data) return reply(200, { ok: true, available: false, source: null, models: [], selected, ...(message ? { message } : {}) });
    const list = parseOpenCodeProviders(data).filter((row) => !isHiddenModel(row.id)).map(modelOfRow);
    list.sort((a, b) => Number(b.fast) - Number(a.fast) || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1));
    return reply(200, { ok: true, available: true, source, models: list, selected });
  }

  const count = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

  return {
    complete,
    test,
    models,
    /** GET /api/editor/complete/usage */
    usageToday: () => reply(200, { ok: true, today: usage.today() }),
    /** POST /api/editor/complete/feedback: suggestions the page showed, and the ones the user took. */
    feedback(body = {}) {
      usage.add({ shown: count(body?.shown), accepted: count(body?.accepted) });
      return reply(200, { ok: true });
    },
    /**
     * The dedicated serve is stopped and the counters are written (server shutdown). The serve is given a moment
     * to delete the sessions of the last requests first, so none is left in OpenCode's history.
     */
    async stop({ drainMs = 500 } = {}) {
      usage.flush();
      try { await engines.opencode.drain?.(drainMs); } catch { /* nothing to wait for */ }
      try { engines.opencode.stop(); } catch { /* already gone */ }
    },
  };
}

/**
 * The routes of the service. Mounted at /api/editor/complete. The owner's only: `guard` (lib/http-guards.js
 * ownerRouteGuard) refuses everybody else on the router itself; without one, anybody who reaches them is answered.
 * @param {{ service: object, guard?: (req: object, res: object, next: () => void) => void }} deps `service`:
 *   createEditorCompletionService()
 */
export function createEditorCompletionRouter({ service, guard = null } = {}) {
  if (!service) throw new Error('createEditorCompletionRouter requires a service');
  const router = Router();
  if (typeof guard === 'function') router.use(guard);

  // A request the page gave up on (its socket closed before an answer) is aborted at the engine.
  const answer = (handler) => async (req, res) => {
    const gone = new AbortController();
    const onClose = () => { if (!res.writableEnded) gone.abort(); };
    res.on('close', onClose);
    try {
      const out = await handler(req, gone.signal);
      if (out?.aborted || gone.signal.aborted || res.destroyed) return;
      res.status(out.status).json(out.body);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.status(500).json({ ok: false, error: messageOf(error) });
    } finally {
      res.off('close', onClose);
    }
  };

  router.post('/', answer((req, signal) => service.complete(req.body, { signal })));
  router.post('/test', answer((req, signal) => service.test(req.body, { signal })));
  router.get('/models', answer((req, signal) => service.models({ start: req.query.start === '1', signal })));
  router.get('/usage', answer(() => service.usageToday()));
  router.post('/feedback', answer((req) => service.feedback(req.body)));
  return router;
}

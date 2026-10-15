// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: AI autocomplete, the decisions
// ═══════════════════════════════════════════
//
// What AI autocomplete decides without a page: whether a request may be made at
// all, which text around the caret is sent, which files and texts are never
// sent, what is left of a suggestion while the user types it, and what the
// status-bar chip says. editor-ai.js acts on these; the server's
// lib/editor-completion.js imports the limits and the never-sent rules from
// here, so the two sides cannot disagree about them. No DOM and no imports:
// loaded by `node --test` as it is.

/** Sizes of what a request carries (docs/design/code-editor/SPEC.md, section 9.3). */
export const AI_LIMITS = Object.freeze({
  prefixChars: 6000,      // before the caret, cut at a line start
  suffixChars: 1500,      // after the caret, cut at a line end
  headerLines: 40,        // the file's first lines, when the prefix does not start at offset 0
  headerChars: 4000,
  neighborCount: 2,       // snippets of other open tabs
  neighborChars: 1200,
  pathChars: 1000,
  completionChars: 1200,  // the most a suggestion holds
  cacheSize: 20,          // results kept
  cacheBefore: 300,       // characters before the caret in a cache key
  cacheAfter: 100,        // characters after it
});

// The prefix starts on a multiple of this many characters (then at the next line start), so it stays the same
// text for a while as the caret moves on: a provider that caches the start of a prompt can reuse it.
const PREFIX_GRID = 1000;

/** What may follow the caret on its line for a suggestion to be asked for: nothing, or closing punctuation. */
const CLOSING_ONLY = /^[\s)\]}'"`;,]*$/;

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// ── Never sent ──

/** The last part of a path, whichever slash it uses. */
export function fileNameOf(path) {
  const text = String(path ?? '');
  return text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1);
}

function globToRegExp(glob) {
  const body = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Whether a file is one AI autocomplete never reads. The globs (`*` any run of characters, `?` one) are matched
 * on the file's name, not on its folder, whatever the case of its letters.
 * @param {string} path a path or a bare file name
 * @param {string[]} globs `ai.exclude`
 */
export function matchesExclude(path, globs) {
  const name = fileNameOf(path);
  if (!name || !Array.isArray(globs)) return false;
  return globs.some((glob) => typeof glob === 'string' && glob && globToRegExp(glob).test(name));
}

/** Whether any of the texts holds the first line of a private key. */
export function hasPrivateKey(...texts) {
  return texts.some((text) => typeof text === 'string' && PRIVATE_KEY.test(text));
}

// ── When to ask ──

/** Whether the rest of the caret's line lets a suggestion in: empty, or only closing punctuation. */
export function restOfLineAllows(after) {
  return CLOSING_ONLY.test(String(after ?? ''));
}

/**
 * Whether a suggestion may be asked for right now.
 * @param {object} s
 * @param {boolean} s.enabled `ai.enabled`
 * @param {boolean} s.capable the server has the `complete` capability
 * @param {boolean} [s.readOnly] the document cannot be edited (a save is under way)
 * @param {boolean} s.focused the document has the keyboard
 * @param {boolean} s.visible the page is visible
 * @param {number} s.carets how many carets or selections there are
 * @param {boolean} s.hasSelection any of them selects text
 * @param {boolean} s.composing an IME composition is under way
 * @param {string} s.lineAfter the text after the caret on its line
 * @param {string} s.path the file's path
 * @param {string[]} s.exclude `ai.exclude`
 * @returns {{ ok: true } | { ok: false, reason: 'off' | 'read-only' | 'unfocused' | 'hidden' | 'multiple' | 'selection'
 *   | 'composing' | 'excluded' | 'mid-line' }} An open completion list is no reason to wait: the suggestion is
 *   asked for, and kept hidden until the list closes.
 */
export function shouldRequest(s = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!s.enabled || !s.capable) return no('off');
  if (!s.path || matchesExclude(s.path, s.exclude)) return no('excluded');
  if (s.readOnly) return no('read-only');
  if (!s.focused) return no('unfocused');
  if (!s.visible) return no('hidden');
  if (s.carets !== 1) return no('multiple');
  if (s.hasSelection) return no('selection');
  if (s.composing) return no('composing');
  if (!restOfLineAllows(s.lineAfter)) return no('mid-line');
  return { ok: true };
}

/**
 * Whether suggestions are expected for a document: the feature is on and the server has it, the file is not one
 * that is never read, and there is a model to ask. While they are, the completion list leaves the words of the
 * document out unless it is asked for them (Ctrl-Space): a list that opened for every word would cover the
 * suggestion each time.
 * @param {{ capable: boolean, enabled: boolean, excluded?: boolean, problem?: { kind: string } | null }} s
 */
export function suggestionsExpected({ capable, enabled, excluded = false, problem = null } = {}) {
  if (!capable || !enabled || excluded) return false;
  return problem?.kind !== 'no-model' && problem?.kind !== 'no-endpoint';
}

// ── What is sent ──

/**
 * The text around the caret that a request carries.
 * @param {object} o
 * @param {(from: number, to: number) => string} o.slice reads part of the document (line breaks as "\n")
 * @param {number} o.length the document's length
 * @param {number} o.pos the caret
 * @returns {{ prefix: string, suffix: string, header: string, prefixStart: number, suffixEnd: number }}
 *   `prefix`: up to 6,000 characters before the caret, from a line start; `suffix`: up to 1,500 after it, to a
 *   line end; `header`: the file's first 40 lines when the prefix does not reach the start of the file, else ''.
 */
export function completionWindow({ slice, length, pos }) {
  const at = Math.max(0, Math.min(length, pos));
  let prefixStart = Math.ceil(Math.max(0, at - AI_LIMITS.prefixChars) / PREFIX_GRID) * PREFIX_GRID;
  let prefix = slice(prefixStart, at);
  if (prefixStart > 0) {
    const lineStart = prefix.indexOf('\n');
    if (lineStart >= 0) { prefixStart += lineStart + 1; prefix = prefix.slice(lineStart + 1); }
  }
  let suffixEnd = Math.min(length, at + AI_LIMITS.suffixChars);
  let suffix = slice(at, suffixEnd);
  if (suffixEnd < length) {
    const lineEnd = suffix.lastIndexOf('\n');
    if (lineEnd >= 0) { suffixEnd = at + lineEnd; suffix = suffix.slice(0, lineEnd); }
  }
  // The header stops where the prefix begins: no line is sent twice.
  const header = prefixStart > 0 ? clampHeader(slice(0, Math.min(prefixStart, AI_LIMITS.headerChars + 1))) : '';
  return { prefix, suffix, header, prefixStart, suffixEnd };
}

/** At most the last 6,000 characters of a prefix, from a line start. */
export function clampPrefix(text) {
  const prefix = String(text ?? '');
  if (prefix.length <= AI_LIMITS.prefixChars) return prefix;
  const cut = prefix.slice(prefix.length - AI_LIMITS.prefixChars);
  const lineStart = cut.indexOf('\n');
  return lineStart >= 0 ? cut.slice(lineStart + 1) : cut;
}

/** At most the first 1,500 characters of a suffix, to a line end. */
export function clampSuffix(text) {
  const suffix = String(text ?? '');
  if (suffix.length <= AI_LIMITS.suffixChars) return suffix;
  const cut = suffix.slice(0, AI_LIMITS.suffixChars);
  const lineEnd = cut.lastIndexOf('\n');
  return lineEnd >= 0 ? cut.slice(0, lineEnd) : cut;
}

/** At most the first 40 lines and 4,000 characters of a header, whole lines only. */
export function clampHeader(text) {
  let header = String(text ?? '').split('\n').slice(0, AI_LIMITS.headerLines).join('\n');
  if (header.length > AI_LIMITS.headerChars) {
    const cut = header.slice(0, AI_LIMITS.headerChars);
    const lineEnd = cut.lastIndexOf('\n');
    header = lineEnd >= 0 ? cut.slice(0, lineEnd) : cut;
  }
  return header.replace(/\n+$/, '');
}

/**
 * The body of `POST /api/editor/complete`.
 * @param {object} o
 * @param {string} o.path
 * @param {string} [o.language] the language's name as the status bar shows it
 * @param {string} [o.indentUnit] one level of indentation (spaces, or a tab)
 * @param {{ prefix: string, suffix: string, header: string }} o.window from completionWindow()
 * @param {{ path: string, text: string }[]} [o.neighbors]
 * @param {'auto' | 'manual'} [o.trigger]
 */
export function requestBody({ path, language = '', indentUnit = '  ', window, neighbors = [], trigger = 'auto' }) {
  const body = { path, language, indentUnit, prefix: window.prefix, suffix: window.suffix, trigger: trigger === 'manual' ? 'manual' : 'auto' };
  if (window.header) body.header = window.header;
  if (neighbors.length) body.neighbors = neighbors.slice(0, AI_LIMITS.neighborCount).map((n) => ({ path: n.path, text: String(n.text).slice(0, AI_LIMITS.neighborChars) }));
  return body;
}

/**
 * The part of another open document that is sent along: the 1,200 characters around its caret (the whole text
 * when it is shorter), whole lines where the window allows.
 * @param {{ slice: (from: number, to: number) => string, length: number, head?: number }} doc
 */
export function neighborSnippet({ slice, length, head = 0 }) {
  const size = AI_LIMITS.neighborChars;
  if (length <= size) return slice(0, length);
  const from = Math.max(0, Math.min(length - size, Math.floor(Number(head) || 0) - size / 2));
  let text = slice(from, from + size);
  if (from > 0) {
    const lineStart = text.indexOf('\n');
    if (lineStart >= 0 && lineStart < text.length - 1) text = text.slice(lineStart + 1);
  }
  if (from + size < length) {
    const lineEnd = text.lastIndexOf('\n');
    if (lineEnd > 0) text = text.slice(0, lineEnd);
  }
  return text;
}

/**
 * Snippets of other open tabs for a request: up to two, of the document's own language, the tabs used last
 * first. Never a file on the excluded list, never a text that holds a private key, never without a language
 * (plain text is not code to learn from).
 * @param {object} o
 * @param {{ path: string, language: string }} o.current the document the request is for
 * @param {{ path: string, language: string, length: number, head?: number, slice: (from: number, to: number) => string }[]} o.tabs
 *   the other open documents, the most recently used first
 * @param {string[]} o.exclude `ai.exclude`
 * @returns {{ path: string, text: string }[]}
 */
export function pickNeighbors({ current, tabs, exclude } = {}) {
  const out = [];
  if (!current?.language) return out;
  for (const tab of tabs || []) {
    if (out.length >= AI_LIMITS.neighborCount) break;
    if (!tab || !tab.path || tab.path === current.path || tab.language !== current.language) continue;
    if (matchesExclude(tab.path, exclude) || out.some((taken) => taken.path === tab.path)) continue;
    const text = neighborSnippet(tab);
    if (!text.trim() || hasPrivateKey(text)) continue;
    out.push({ path: tab.path, text });
  }
  return out;
}

// ── Results kept ──

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The key a result is kept under: the last 300 characters before the caret, the first 100 after it, and the path. */
export function cacheKey({ path, prefix, suffix }) {
  const before = String(prefix ?? '').slice(-AI_LIMITS.cacheBefore);
  const after = String(suffix ?? '').slice(0, AI_LIMITS.cacheAfter);
  return `${fnv1a(`${before}\u0000${after}`)}${fnv1a(`${after}\u0000${before}\u0000${path ?? ''}`)}`;
}

/** The last results, the most recently used last. */
export function createSuggestionCache(max = AI_LIMITS.cacheSize) {
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    delete(key) { return entries.delete(key); },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}

// ── A suggestion while the user types ──

/**
 * What is left of a suggestion after a change to the document.
 * @param {{ from: number, text: string } | null} suggestion what is shown: `text` would be inserted at `from`
 * @param {{ from: number, to: number, insert: string, head: number }} change one change: `insert` replaced
 *   `from`..`to`, and the caret is at `head` afterwards
 * @returns {{ typed: boolean, suggestion: { from: number, text: string } | null }} `typed`: the user typed what
 *   the suggestion begins with (no new request is needed while a remainder is left); `suggestion`: the remainder
 */
export function typeThrough(suggestion, change) {
  const miss = { typed: false, suggestion: null };
  if (!suggestion || !change || typeof change.insert !== 'string' || !change.insert) return miss;
  if (change.from !== change.to || change.from !== suggestion.from) return miss;
  if (change.head !== change.from + change.insert.length) return miss;
  if (!suggestion.text.startsWith(change.insert)) return miss;
  const rest = suggestion.text.slice(change.insert.length);
  return { typed: true, suggestion: rest ? { from: change.head, text: rest } : null };
}

const WORD = /^(\s*)(?:[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+)/u;

/** The part of a suggestion "accept one word" takes: the white space in front of the next word, and that word (or run of punctuation). */
export function nextWord(text) {
  const value = String(text ?? '');
  const match = WORD.exec(value);
  return match ? match[0] : value;
}

// ── The chip ──

/**
 * What the status-bar chip shows.
 * @param {object} s
 * @param {boolean} s.capable the server has the `complete` capability (without it there is no chip)
 * @param {boolean} s.enabled `ai.enabled`
 * @param {boolean} [s.excluded] the open file is one that is never read
 * @param {boolean} [s.busy] a request is under way
 * @param {{ kind: string } | null} [s.problem] the last request's failure, until one succeeds
 * @returns {'hidden' | 'off' | 'ready' | 'thinking' | 'problem'}
 */
export function chipState({ capable, enabled, excluded = false, busy = false, problem = null } = {}) {
  if (!capable) return 'hidden';
  if (!enabled || excluded) return 'off';
  if (busy) return 'thinking';
  if (problem) return 'problem';
  return 'ready';
}

/**
 * What a failed request means.
 * @param {{ status?: number, body?: object | null, error?: string | null }} failure what the server answered, or
 *   why there was no answer
 * @returns {{ kind: 'disabled' | 'excluded' | 'rate' | 'engine' | 'no-model' | 'no-endpoint' | 'timeout' | 'network' | 'server',
 *   retryAfterMs: number, message: string }} `disabled` and `excluded` are not problems: the feature is off, or
 *   off for this file. `message` is the engine's own words when it gave any.
 */
export function describeFailure({ status = 0, body = null, error = null } = {}) {
  const message = typeof body?.message === 'string' ? body.message.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const out = (kind, retryAfterMs = 0) => ({ kind, retryAfterMs, message });
  if (status === 409 && body?.code === 'disabled') return out('disabled');
  if (status === 403 && body?.code === 'excluded') return out('excluded');
  if (status === 429) {
    const wait = Number(body?.retryAfterMs);
    return out('rate', Number.isFinite(wait) && wait > 0 ? Math.min(wait, 120_000) : 5000);
  }
  if (status === 502 && body?.code === 'engine') {
    if (body.reason === 'no-model') return out('no-model');
    if (body.reason === 'no-endpoint') return out('no-endpoint');
    if (body.reason === 'timeout') return out('timeout');
    return out('engine');
  }
  if (!status) return { kind: 'network', retryAfterMs: 0, message: String(error ?? '').slice(0, 300) };
  return out('server');
}

/** The i18n key of a failure's sentence (parameters: `message`, `seconds`). */
export function failureKey(failure) {
  switch (failure?.kind) {
    case 'rate': return 'editor.ai.problem.rate';
    case 'no-model': return 'editor.ai.problem.noModel';
    case 'no-endpoint': return 'editor.ai.problem.noEndpoint';
    case 'timeout': return 'editor.ai.problem.timeout';
    case 'network': return 'editor.ai.problem.network';
    case 'engine': return failure.message ? 'editor.ai.problem.engine' : 'editor.ai.problem.engineUnknown';
    default: return 'editor.ai.problem.server';
  }
}

/**
 * The popover's line about today's use, from the answer of `GET /api/editor/complete/usage`.
 * "No requests today" is said only for an answer that says so: no answer, or one that is not one, is a read
 * that failed.
 * @param {{ ok?: boolean, today?: { requests: number, tokensIn: number, tokensOut: number } } | null} answer
 * @returns {{ key: string, params: object }}
 */
export function usageLine(answer) {
  const day = answer && answer.ok === true && answer.today && typeof answer.today === 'object' ? answer.today : null;
  if (!day) return { key: 'editor.ai.todayFailed', params: {} };
  const requests = Math.round(Number(day.requests) || 0);
  if (requests <= 0) return { key: 'editor.ai.todayNone', params: {} };
  return {
    key: requests === 1 ? 'editor.ai.today.one' : 'editor.ai.today.other',
    params: { count: formatCount(requests), input: formatCount(day.tokensIn), output: formatCount(day.tokensOut) },
  };
}

/**
 * Whether the popover's read of the models failed. They are asked for with the OpenCode engine only; an answer
 * that says OpenCode is not running is an answer (it has a sentence of its own).
 * @param {{ engine: string, models: object | null }} s `models`: the answer of `GET /api/editor/complete/models`
 */
export function modelsReadFailed({ engine, models } = {}) {
  return engine !== 'endpoint' && !(models && models.ok === true);
}

/** A count the way the popover writes it: 950, 1.2k, 3.4M. */
export function formatCount(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** A duration the way a model's test result is written: 640 ms, 1.2 s. */
export function formatMs(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

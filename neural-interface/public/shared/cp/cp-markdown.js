// Markdown → HTML for every Markdown sink of the Claude panel, and the panel's one escaper.
//
// What a model writes, what a command prints and what a transcript replays is
// not ours: marked passes raw HTML through, so `<img onerror>` or a
// `javascript:` link in that text would run in SynaBun's origin. The panel's
// one `md()` helper (and through it cpCtx.md) calls renderMarkdown(), which
// puts marked's output through the allowlist sanitiser the Assistant and the
// OpenCode panel use. Nothing here touches `document` at import time.

import { sanitizeHtmlString } from '../assistant/asst-sanitize.js';

// ── The panel's one escaper ──
// Every value the panel puts into markup it builds itself (a session's title or
// tag, a branch, a file name, a tool, hook, MCP or model name) goes through
// this one function: the monolith's esc() and escH() and cpCtx.esc are it.
// It is safe where the panel interpolates: element text, and an attribute value
// in double or single quotes (the backtick too, for parsers that take it as a
// quote). It is not a URL or CSS filter: a URL needs its scheme checked, and a
// class name built from a value goes through classToken().
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

/** A value used as part of a class name (`cp-info-${tone}`): letters, digits, `_` and `-` only. */
export function classToken(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '');
}

const plain = (text) => escapeHtml(text).replace(/\n/g, '<br>');

/**
 * Markdown text → sanitised HTML string, safe to assign to innerHTML.
 * `parse` is marked's parser (absent until it has loaded). Any failure, in the
 * parser or in the sanitiser, falls back to escaped text: never to raw HTML.
 */
export function renderMarkdown(text, { parse = null, sanitize = sanitizeHtmlString, doc = globalThis.document } = {}) {
  const src = String(text ?? '');
  if (typeof parse !== 'function') return plain(src);
  try {
    const html = sanitize(parse(src), doc);
    return typeof html === 'string' ? html : plain(src);
  } catch {
    return plain(src);
  }
}

// A stored transcript snapshot is not scrubbed here: the panel puts it back through
// sanitizeStoredHtml() of assistant/asst-sanitize.js, the stored-transcript allowlist
// every panel uses.

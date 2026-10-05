// Markdown → HTML for every Markdown sink of the Claude panel, and the scrub a
// stored transcript snapshot goes through before it is put back on the page.
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

// ── Stored snapshots ──
// A snapshot is the transcript's own innerHTML, saved to be shown again on a
// reopen. It is the panel's markup (cards, icons, buttons, data attributes),
// so the Markdown allowlist would destroy it; but it may have been written by
// a build that did not sanitise, and it comes back from storage. It is parsed
// into an inert <template> and stripped of everything that can run or load
// code before it reaches the page.

const STORED_DROPPED = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'style', 'template', 'noscript', 'foreignobject', 'animate', 'set', 'animatetransform', 'animatemotion']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'data', 'background', 'ping']);
const REMOVED_ATTRS = new Set(['srcdoc', 'srcset']);
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto']);

/** The scheme of a URL attribute as a browser reads it (whitespace and control characters ignored), or ''. */
function schemeOf(value) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(value ?? '').replace(/[\u0000- ]/g, ''));
  return m ? m[1].toLowerCase() : '';
}

function storedImageAllowed(src) {
  const compact = String(src ?? '').replace(/[\u0000- ]/g, '');
  if (!compact) return false;
  if (/^data:image\//i.test(compact) || /^blob:/i.test(compact)) return true;
  // A path on this server; a remote image is not loaded again from storage.
  return !schemeOf(compact) && !compact.startsWith('//');
}

function scrubNode(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) continue;
    if (node.nodeType !== 1) { parent.removeChild(node); continue; }
    const tag = String(node.localName || '').toLowerCase();
    if (STORED_DROPPED.has(tag) || (tag === 'img' && !storedImageAllowed(node.getAttribute('src')))) { parent.removeChild(node); continue; }
    for (const name of node.getAttributeNames()) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || REMOVED_ATTRS.has(lower)) { node.removeAttribute(name); continue; }
      if (!URL_ATTRS.has(lower)) continue;
      const scheme = schemeOf(node.getAttribute(name));
      if (!scheme || SAFE_URL_SCHEMES.has(scheme)) continue;
      if (tag === 'img' && lower === 'src') continue; // data:image / blob, checked above
      node.removeAttribute(name);
    }
    scrubNode(node);
  }
}

/** A stored snapshot's markup → a DocumentFragment with nothing executable left in it. */
export function scrubStoredHtml(html, doc = globalThis.document) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = String(html ?? '');
  scrubNode(tpl.content);
  const out = doc.createDocumentFragment();
  for (const node of [...tpl.content.childNodes]) out.appendChild(node);
  return out;
}

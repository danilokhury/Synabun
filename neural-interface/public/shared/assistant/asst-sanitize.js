// ═══════════════════════════════════════════
// SynaBun Assistant — Markdown HTML sanitizer
// ═══════════════════════════════════════════
// marked turns what a brain said into HTML, and that text is not ours: a
// quoted web page, a plan, a tool's output can carry <img onerror>, a
// javascript: link or an <svg onload>. Every Markdown sink in the Assistant
// goes through this allowlist first. The markup is parsed into an inert
// <template> (nothing runs, nothing loads) and rebuilt node by node into
// fresh elements, so nothing the parser saw survives unless it is listed
// here: no on* or style attributes, no ids, no namespaced markup. No
// dependency, nothing touches `document` at import time.

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** The elements Markdown needs; everything else is unwrapped, flattened or dropped. */
export const ALLOWED_TAGS = Object.freeze(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a', 'span']);
const ALLOWED = new Set(ALLOWED_TAGS);
// Gone with everything inside them: code, embeds and page furniture.
const DROPPED = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'frame', 'frameset', 'applet', 'link', 'meta', 'base', 'head', 'title', 'input']);
// Replaced by their text (their own markup is foreign or interactive).
const FLATTENED = new Set(['svg', 'math', 'form']);
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
// A fenced block's language (marked writes class="language-js" on <code>).
const CLASS_RE = /^language-[\w+#.-]{1,40}$/;
// The panel's own generated media (readRun shows a run's images inline).
const MEDIA_SRC_RE = /^\/api\/assistant\/runs\/[\w.-]+\/media\/\d+$/;
const MAX_DEPTH = 64;

/** An href the Assistant may render: http(s) or mailto after resolving it, else null. */
export function safeHref(raw, base = globalThis.document?.baseURI || 'http://localhost/') {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let url;
  try { url = new URL(value, base); } catch { return null; }
  return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
}

/** Text of a subtree, without the contents of script / style. */
function textOf(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.data;
    else if (child.nodeType === 1 && !DROPPED.has(child.localName)) out += textOf(child);
  }
  return out;
}

function copyAttributes(from, to, tag) {
  if (tag === 'a') {
    const href = safeHref(from.getAttribute('href'));
    if (href) to.setAttribute('href', href);
    const title = from.getAttribute('title');
    if (title) to.setAttribute('title', title);
    to.setAttribute('rel', 'noopener noreferrer');
    return;
  }
  if (tag === 'code' || tag === 'pre' || tag === 'span') {
    const classes = String(from.getAttribute('class') || '').split(/\s+/).filter(c => CLASS_RE.test(c));
    if (classes.length) to.setAttribute('class', classes.join(' '));
  }
}

function clean(source, target, doc, depth) {
  for (const node of source.childNodes) {
    if (node.nodeType === 3) { target.appendChild(doc.createTextNode(node.data)); continue; }
    if (node.nodeType !== 1) continue; // comments, processing instructions
    const tag = node.localName;
    if (node.namespaceURI !== HTML_NS || FLATTENED.has(tag) || depth >= MAX_DEPTH) {
      const text = textOf(node);
      if (text) target.appendChild(doc.createTextNode(text));
      continue;
    }
    if (DROPPED.has(tag)) {
      // A GFM task list's checkbox keeps its meaning as a glyph.
      if (tag === 'input' && String(node.getAttribute('type')).toLowerCase() === 'checkbox') target.appendChild(doc.createTextNode(node.hasAttribute('checked') ? '☑ ' : '☐ '));
      continue;
    }
    if (tag === 'img') {
      const src = String(node.getAttribute('src') || '');
      if (MEDIA_SRC_RE.test(src)) {
        const img = doc.createElement('img');
        img.setAttribute('src', src);
        img.setAttribute('alt', node.getAttribute('alt') || '');
        img.setAttribute('loading', 'lazy');
        target.appendChild(img);
      }
      continue;
    }
    if (!ALLOWED.has(tag)) { clean(node, target, doc, depth + 1); continue; } // unwrap: keep what is inside
    const el = doc.createElement(tag);
    copyAttributes(node, el, tag);
    clean(node, el, doc, depth + 1);
    target.appendChild(el);
  }
}

/** Markdown HTML → a DocumentFragment of fresh, allowlisted nodes. */
export function sanitizeHtml(html, doc = globalThis.document) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = String(html ?? '');
  const out = doc.createDocumentFragment();
  clean(tpl.content, out, doc, 0);
  return out;
}

/** Replace `node`'s children with the sanitized form of `html`. */
export function sanitizeInto(node, html) {
  node.replaceChildren(sanitizeHtml(html, node.ownerDocument || globalThis.document));
  return node;
}

/** The sanitized markup as a string, for a caller that assigns innerHTML. */
export function sanitizeHtmlString(html, doc = globalThis.document) {
  const holder = doc.createElement('div');
  holder.appendChild(sanitizeHtml(html, doc));
  return holder.innerHTML;
}

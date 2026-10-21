// ═══════════════════════════════════════════
// SynaBun Assistant — Markdown HTML sanitizer
// ═══════════════════════════════════════════
// marked turns what a brain said into HTML, and that text is not ours: a
// quoted web page, a plan, a tool's output can carry <img onerror>, a
// javascript: link or an <svg onload>. Every Markdown sink in the Assistant
// and in the Claude, Codex and OpenCode panels goes through this allowlist
// first: it is the one sanitiser, never write a second. The markup is parsed into an inert
// <template> (nothing runs, nothing loads) and rebuilt node by node into
// fresh elements, so nothing the parser saw survives unless it is listed
// here: no on* or style attributes, no ids, no namespaced markup. No
// dependency beyond file-links.js (pure), nothing touches `document` at
// import time. A transcript a panel saved and shows again goes through the
// second list at the end of this file (sanitizeStoredHtml).

import { localFileHref } from '../file-links.js';

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
// An image of SynaBun's own gallery (GET /api/images/file/<name>: a screenshot, a paste, an image a CLI saved), as
// written by the model: a path of this server only (no host, scheme, query or fragment), one file name (no folder,
// no escaped slash, backslash or dot) with an image extension.
const GALLERY_SRC_RE = /^\/api\/images\/file\/((?!\.)(?:[\w.-]|%(?!2[eEfF]|5[cC])[0-9A-Fa-f]{2})+)$/;
const GALLERY_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

/** An <img> src the Markdown list keeps: a run's own media, or an image of SynaBun's gallery. */
export function isOwnImageSrc(src) {
  const value = String(src ?? '');
  if (MEDIA_SRC_RE.test(value)) return true;
  const gallery = GALLERY_SRC_RE.exec(value);
  return !!gallery && GALLERY_EXT_RE.test(gallery[1]);
}
const MAX_DEPTH = 64;
const ALIGNS = new Set(['left', 'center', 'right']);

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
    // A path or a file: URL does not survive as an href (it is resolved against the page, or dropped).
    // Kept as written, as data: ui-file-links.js reads it on a click and opens the file in the editor.
    // A target whose scheme hides behind spaces, controls or entities (`JaVa\tScript:`), or is one a browser
    // runs (javascript, vbscript, data…), is no file: that link keeps neither an href nor a target.
    const file = localFileHref(from.getAttribute('href'));
    if (file) to.setAttribute('data-file-target', file);
    const title = from.getAttribute('title');
    if (title) to.setAttribute('title', title);
    to.setAttribute('rel', 'noopener noreferrer');
    return;
  }
  if (tag === 'code' || tag === 'pre' || tag === 'span') {
    const classes = String(from.getAttribute('class') || '').split(/\s+/).filter(c => CLASS_RE.test(c));
    if (classes.length) to.setAttribute('class', classes.join(' '));
  }
  // A table column's alignment and a list's first number: marked writes both, and they are words and digits only.
  if (tag === 'th' || tag === 'td') {
    const align = String(from.getAttribute('align') || '').toLowerCase();
    if (ALIGNS.has(align)) to.setAttribute('align', align);
  }
  if (tag === 'ol') {
    const start = String(from.getAttribute('start') || '');
    if (/^\d{1,9}$/.test(start)) to.setAttribute('start', start);
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
      if (isOwnImageSrc(src)) {
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

// ── Stored transcripts ──
// A side panel saves its transcript's own markup (messages, cards, buttons, data attributes, the inline SVG of
// its icons) and puts it back when the session is opened again. That markup is the panel's, so the Markdown list
// above would take it apart; but it comes back from storage, and a build from before the panels sanitised their
// Markdown saved model HTML into it as it was. So it is rebuilt here the same way, node by node into fresh
// elements, from a second list: what a panel writes is kept exactly as it was written (a normal transcript looks
// as it did), and nothing else is. No script, handler, frame or form, no id or name, no image from another site
// (a remote image is not loaded again from storage), no style that loads something or leaves the transcript.

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORED_MAX_DEPTH = 128;
/** The panel's own elements, besides the Markdown ones; an element not listed is unwrapped (a <form> too). */
const STORED_TAGS = new Set([...ALLOWED_TAGS, 'div', 'section', 'header', 'footer', 'article', 'aside', 'figure', 'figcaption',
  'small', 'b', 'i', 'u', 's', 'sub', 'sup', 'mark', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'ins', 'time', 'wbr',
  'caption', 'colgroup', 'col', 'tfoot', 'dl', 'dt', 'dd', 'details', 'summary', 'label', 'button', 'input', 'textarea',
  'select', 'option', 'optgroup', 'progress', 'meter', 'img']);
const STORED_DROPPED = new Set([...DROPPED].filter(tag => tag !== 'input'));
/** The shapes of the panels' icons; any other SVG element (script, a, use, image, foreignObject, animate…) goes with what is in it. */
const STORED_SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'title', 'desc']);
const STORED_SVG_ATTRS = new Set(['viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'clip-rule', 'opacity',
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'transform', 'preserveAspectRatio', 'vector-effect',
  'shape-rendering', 'focusable']);
const SVG_PAINT_ATTRS = new Set(['fill', 'stroke']);
const SVG_PAINT_RE = /^(?:none|currentColor|transparent|context-fill|context-stroke|inherit|#[0-9a-f]{3,8}|[a-z]{3,24}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/+-]*\))$/i;
const STORED_GLOBAL_ATTRS = new Set(['class', 'title', 'role', 'hidden', 'lang', 'dir', 'tabindex', 'draggable', 'spellcheck', 'translate']);
// ARIA that names an element by id: the ids are gone, so these would point at nothing (or at the panel's own chrome).
const ARIA_ID_REFS = new Set(['aria-controls', 'aria-describedby', 'aria-labelledby', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto']);
const STORED_TAG_ATTRS = {
  a: ['target', 'rel'],
  img: ['alt', 'width', 'height', 'loading', 'decoding'],
  button: ['type', 'disabled', 'value'],
  input: ['type', 'value', 'checked', 'disabled', 'readonly', 'placeholder', 'min', 'max', 'step', 'maxlength', 'size', 'autocomplete'],
  textarea: ['rows', 'cols', 'placeholder', 'disabled', 'readonly', 'maxlength', 'wrap', 'autocomplete'],
  select: ['disabled', 'multiple', 'size'],
  option: ['value', 'selected', 'disabled', 'label'],
  optgroup: ['label', 'disabled'],
  details: ['open'],
  th: ['align', 'colspan', 'rowspan', 'scope'],
  td: ['align', 'colspan', 'rowspan'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  time: ['datetime'],
  progress: ['value', 'max'],
  meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
};
const STORED_VALUES = {
  target: /^_blank$/,
  type: /^(?:button|submit|reset|text|search|number|checkbox|radio|range|email|url|tel|hidden|1|a|A|i|I)$/,
  tabindex: /^-?\d{1,3}$/,
};
const REL_TOKENS = new Set(['noopener', 'noreferrer', 'nofollow', 'ugc', 'external']);
// Inline styles: the layout properties the panels set (a code block's position, an image preview's size, a card
// hidden or dimmed while busy, a chip's colour) and nothing that loads, positions over the page or hides behind an
// escape: a value names no function but the colour and arithmetic ones, so `background` is a colour, never an image.
const STYLE_PROPS = new Set(['display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-width', 'border-style',
  'border-radius', 'box-sizing', 'opacity', 'visibility', 'pointer-events', 'cursor', 'overflow', 'overflow-x', 'overflow-y',
  'overflow-wrap', 'word-break', 'white-space', 'text-overflow', 'text-align', 'vertical-align', 'line-height', 'font-size',
  'font-weight', 'font-style', 'letter-spacing', 'text-decoration', 'color', 'background', 'background-color', 'gap', 'row-gap', 'column-gap',
  'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-items', 'align-self', 'justify-content',
  'object-fit', 'tab-size']);
const STYLE_FUNCTIONS = new Set(['var', 'calc', 'rgb', 'rgba', 'hsl', 'hsla', 'min', 'max', 'clamp']);

/** A style attribute as written when every declaration is a layout one; else only those; '' when none is left. */
export function storedStyle(text) {
  const kept = [];
  let dropped = false;
  for (const part of String(text ?? '').split(';')) {
    const decl = part.trim();
    if (!decl) continue;
    const colon = decl.indexOf(':');
    const prop = colon > 0 ? decl.slice(0, colon).trim().toLowerCase() : '';
    const value = colon > 0 ? decl.slice(colon + 1).trim() : '';
    const functions = [...value.matchAll(/([a-z-]*)\s*\(/gi)].map(m => m[1].toLowerCase());
    const ok = (STYLE_PROPS.has(prop) || /^--[a-z0-9-]{1,64}$/.test(prop)) && value !== ''
      && functions.every(fn => STYLE_FUNCTIONS.has(fn))
      && !/[\\<>{}@"']|\/\*|url|expression|javascript|image|attr/i.test(value)
      && (prop !== 'position' || /^(?:static|relative)$/i.test(value));
    if (ok) kept.push(decl); else dropped = true;
  }
  if (!dropped) return String(text ?? '');
  return kept.length ? `${kept.join('; ')};` : '';
}

/** An image a stored transcript may show again: a data: image, or a file of this page's own origin (a blob: of it). */
export function storedImageSrc(raw, base = globalThis.document?.baseURI || 'http://localhost/') {
  const value = String(raw ?? '');
  if (/^data:image\//i.test(value.replace(/[\u0000- ]/g, ''))) return value;
  let url;
  let page;
  try { url = new URL(value, base); page = new URL(base); } catch { return null; }
  if (!value.trim() || !['http:', 'https:', 'blob:'].includes(url.protocol)) return null;
  return url.origin === page.origin ? value : null;
}

function storedAttribute(tag, svg, name, value, base) {
  const lower = name.toLowerCase();
  if (lower === 'style') {
    const style = storedStyle(value);
    return style || null;
  }
  if (/^data-[\w.-]+$/i.test(name)) return value;
  if (/^aria-[a-z]+$/.test(lower)) return ARIA_ID_REFS.has(lower) ? null : value;
  if (STORED_GLOBAL_ATTRS.has(lower)) return !STORED_VALUES[lower] || STORED_VALUES[lower].test(value) ? value : null;
  if (svg) {
    if (name === 'xmlns') return value === SVG_NS ? value : null;
    // A presentation attribute is read as CSS, where an escape spells anything (u\72 l( is url(): a value with an
    // escape, a comment or the word url is not kept, and a paint is a colour or a keyword, never a paint server.
    if (!STORED_SVG_ATTRS.has(name) || /\\|\/\*|url/i.test(value)) return null;
    return !SVG_PAINT_ATTRS.has(name) || SVG_PAINT_RE.test(value.trim()) ? value : null;
  }
  if (tag === 'a' && lower === 'href') return safeHref(value, base) ? value : null;
  if (tag === 'img' && lower === 'src') return storedImageSrc(value, base);
  if (!(STORED_TAG_ATTRS[tag] || []).includes(lower)) return null;
  if (lower === 'rel') {
    const tokens = value.split(/\s+/).filter(token => REL_TOKENS.has(token.toLowerCase()));
    return tokens.length ? tokens.join(' ') : null;
  }
  return !STORED_VALUES[lower] || STORED_VALUES[lower].test(value) ? value : null;
}

function cleanStored(source, target, doc, depth, base) {
  for (const node of source.childNodes) {
    if (node.nodeType === 3) { target.appendChild(doc.createTextNode(node.data)); continue; }
    if (node.nodeType !== 1) continue;
    const tag = node.localName;
    const svg = node.namespaceURI === SVG_NS;
    if (depth >= STORED_MAX_DEPTH || (!svg && (node.namespaceURI !== HTML_NS || tag === 'math'))) {
      const text = textOf(node);
      if (text) target.appendChild(doc.createTextNode(text));
      continue;
    }
    if (svg ? !STORED_SVG_TAGS.has(tag) : STORED_DROPPED.has(tag)) continue;
    if (!svg && !STORED_TAGS.has(tag)) { cleanStored(node, target, doc, depth + 1, base); continue; } // unwrap
    if (tag === 'img' && !storedImageSrc(node.getAttribute('src'), base)) continue;
    const el = svg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    for (const name of node.getAttributeNames()) {
      const value = storedAttribute(tag, svg, name, node.getAttribute(name), base);
      if (value !== null) el.setAttribute(name, value);
    }
    // A link that opens a tab never hands that tab this page.
    if (tag === 'a' && el.getAttribute('target') === '_blank') {
      const rel = new Set(String(el.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      if (!rel.has('noopener') || !rel.has('noreferrer')) el.setAttribute('rel', [...rel, 'noopener', 'noreferrer'].filter((t, i, all) => all.indexOf(t) === i).join(' '));
    }
    cleanStored(node, el, doc, depth + 1, base);
    target.appendChild(el);
  }
}

/** A stored transcript's markup → a DocumentFragment of fresh nodes from the stored-transcript list. */
export function sanitizeStoredHtml(html, doc = globalThis.document) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = String(html ?? '');
  const out = doc.createDocumentFragment();
  cleanStored(tpl.content, out, doc, 0, doc.baseURI || globalThis.document?.baseURI || 'http://localhost/');
  return out;
}

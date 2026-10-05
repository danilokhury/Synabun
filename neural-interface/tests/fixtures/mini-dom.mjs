// A small DOM stand-in for testing the Claude sidepanel's rendering glue
// (public/shared/cp/*.js) under node:test, with no browser and no dependency.
// It implements what those modules use: element trees, class lists, datasets,
// text, a few sibling helpers, events, and querySelector for compound selectors
// (tag, .class, [data-x="y"], :not(.class)) joined by descendant spaces or commas.
//
//   const dom = installMiniDom();   // sets globalThis.document and globalThis.CSS
//   ...
//   dom.restore();

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentElement = null; }
}

export class MiniElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this._classes = [];
    this._listeners = {};
    this._html = '';
    this.hidden = false;
    this.disabled = false;
    this._root = false;
    const self = this;
    this.classList = {
      add: (...names) => { for (const n of names) if (n && !self._classes.includes(n)) self._classes.push(n); },
      remove: (...names) => { self._classes = self._classes.filter(c => !names.includes(c)); },
      contains: (name) => self._classes.includes(name),
      toggle: (name, force) => {
        const on = force === undefined ? !self._classes.includes(name) : !!force;
        if (on) self.classList.add(name); else self.classList.remove(name);
        return on;
      },
    };
  }

  get className() { return this._classes.join(' '); }
  set className(v) { this._classes = String(v || '').split(/\s+/).filter(Boolean); }

  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get childElementCount() { return this.children.length; }
  get nextElementSibling() {
    const sibs = this.parentElement?.children || [];
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  get previousElementSibling() {
    const sibs = this.parentElement?.children || [];
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] : null;
  }
  get isConnected() {
    for (let n = this; n; n = n.parentElement) if (n._root) return true;
    return false;
  }

  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) {
    for (const n of this.childNodes) n.parentElement = null;
    this.childNodes = [];
    if (v !== '' && v != null) this._adopt(new TextNode(v), this.childNodes.length);
  }
  // Markup is stored, not parsed: tests assert on the string.
  get innerHTML() { return this._html; }
  set innerHTML(v) { this.textContent = ''; this._html = String(v); }

  _adopt(node, index) {
    if (node.parentElement) node.parentElement.childNodes = node.parentElement.childNodes.filter(n => n !== node);
    node.parentElement = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }
  _toNode(x) { return typeof x === 'string' ? new TextNode(x) : x; }

  appendChild(node) { return this._adopt(node, this.childNodes.length); }
  append(...nodes) { for (const n of nodes) this.appendChild(this._toNode(n)); }
  insertBefore(node, ref) {
    // Detach first: the reference's index shifts when the node already sits in this parent.
    if (node.parentElement) { node.parentElement.childNodes = node.parentElement.childNodes.filter(n => n !== node); node.parentElement = null; }
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    return this._adopt(node, i < 0 ? this.childNodes.length : i);
  }
  after(...nodes) {
    const parent = this.parentElement;
    if (!parent) return;
    let anchor = this;
    for (const raw of nodes) {
      const n = this._toNode(raw);
      if (n.parentElement) { n.parentElement.childNodes = n.parentElement.childNodes.filter(x => x !== n); n.parentElement = null; }
      parent._adopt(n, parent.childNodes.indexOf(anchor) + 1);
      anchor = n;
    }
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.childNodes = this.parentElement.childNodes.filter(n => n !== this);
    this.parentElement = null;
  }
  replaceWith(node) {
    const parent = this.parentElement;
    if (!parent) return;
    const i = parent.childNodes.indexOf(this);
    this.remove();
    parent._adopt(node, i);
  }

  setAttribute(name, value) {
    if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value);
    else this.attributes[name] = String(value);
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null;
    return this.attributes[name] ?? null;
  }

  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  fire(type, event = {}) {
    const ev = { stopPropagation() {}, preventDefault() {}, target: this, ...event };
    for (const fn of this._listeners[type] || []) fn(ev);
  }
  click() { this.fire('click'); }
  focus() {}

  /** Every element below this one, in document order. */
  get all() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelectorAll(selector) {
    const alternatives = String(selector).split(',').map(s => parseChain(s.trim())).filter(c => c.length);
    return this.all.filter(el => alternatives.some(chain => matchesChain(el, chain, this)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    const chain = parseChain(selector);
    for (let n = this; n; n = n.parentElement) if (chain.length === 1 && matchesCompound(n, chain[0])) return n;
    return null;
  }
}

// "a.b[data-x="y"]:not(.c) d" → [{tag, classes, attrs, not}, …]
function parseChain(selector) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of selector) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map(parseCompound);
}

function parseCompound(src) {
  const out = { tag: '', classes: [], attrs: [], not: [] };
  let rest = src;
  rest = rest.replace(/:not\(([^)]+)\)/g, (_, inner) => { out.not.push(parseCompound(inner)); return ''; });
  rest = rest.replace(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_, name, a, b, c) => {
    out.attrs.push({ name, value: a ?? b ?? c ?? null });
    return '';
  });
  rest = rest.replace(/\.([\w-]+)/g, (_, cls) => { out.classes.push(cls); return ''; });
  out.tag = rest.replace(/^\*$/, '').toUpperCase();
  return out;
}

function matchesCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (!c.classes.every(cls => el.classList.contains(cls))) return false;
  for (const { name, value } of c.attrs) {
    const actual = el.getAttribute(name);
    if (actual == null) return false;
    if (value != null && String(actual) !== value) return false;
  }
  return !c.not.some(n => matchesCompound(el, n));
}

function matchesChain(el, chain, scope) {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let n = el.parentElement; n && i >= 0; n = n.parentElement) {
    if (matchesCompound(n, chain[i])) i--;
    if (n === scope) break;
  }
  return i < 0;
}

/** Install `document` and `CSS` globals. Returns helpers and a `restore()`. */
export function installMiniDom() {
  const prevDocument = globalThis.document;
  const prevCss = globalThis.CSS;
  const body = new MiniElement('body');
  body._root = true;
  globalThis.document = {
    body,
    createElement: (tag) => new MiniElement(tag),
    createTextNode: (text) => new TextNode(text),
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
  };
  globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
  return {
    body,
    /** A connected container, like a tab's transcript element. */
    container(className = '') {
      const el = new MiniElement('div');
      el.className = className;
      body.appendChild(el);
      return el;
    },
    restore() {
      if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
      if (prevCss === undefined) delete globalThis.CSS; else globalThis.CSS = prevCss;
    },
  };
}

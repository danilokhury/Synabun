// A small HTML parser and node tree for testing code that sanitises markup
// (public/shared/assistant/asst-sanitize.js, public/shared/cp/cp-markdown.js)
// under node:test, with no browser and no dependency. mini-dom.mjs stores
// innerHTML as a string; this one parses it, which is what a sanitiser needs.
//
//   const doc = createHtmlDocument();
//   sanitizeHtmlString('<img src=x onerror=alert(1)>', doc)
//
// It is not a spec parser: it reads tags, attributes (quoted, unquoted, bare),
// comments, void elements, raw-text elements and the svg / math namespaces,
// which covers what marked emits and the injection shapes the tests feed it.

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATH_NS = 'http://www.w3.org/1998/Math/MathML';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

class HtmlText {
  constructor(data, doc) { this.nodeType = 3; this.data = String(data); this.parentNode = null; this.ownerDocument = doc; }
  get textContent() { return this.data; }
}

class HtmlParent {
  constructor(doc) { this.childNodes = []; this.parentNode = null; this.ownerDocument = doc; }
  appendChild(node) {
    if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.appendChild(child); return node; }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter(n => n !== node);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    for (const node of nodes) this.appendChild(node);
  }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) { this.replaceChildren(); parseInto(this._parseTarget(), String(html), this.ownerDocument); }
  _parseTarget() { return this; }
  /** Every element below this node, in document order. */
  get all() {
    const out = [];
    const walk = (node) => { for (const c of node.childNodes) if (c.nodeType === 1) { out.push(c); walk(c.localName === 'template' ? c.content : c); } };
    walk(this);
    return out;
  }
}

class HtmlFragment extends HtmlParent {
  constructor(doc) { super(doc); this.nodeType = 11; }
}

class HtmlElement extends HtmlParent {
  constructor(tag, doc, ns = HTML_NS) {
    super(doc);
    this.nodeType = 1;
    this.localName = ns === HTML_NS ? String(tag).toLowerCase() : String(tag);
    this.tagName = ns === HTML_NS ? this.localName.toUpperCase() : this.localName;
    this.namespaceURI = ns;
    this._attrs = new Map();
    if (this.localName === 'template' && ns === HTML_NS) this.content = new HtmlFragment(doc);
  }
  _parseTarget() { return this.content || this; }
  get innerHTML() { return (this.content || this).childNodes.map(serialize).join(''); }
  set innerHTML(html) { super.innerHTML = html; }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  hasAttribute(name) { return this._attrs.has(name); }
  setAttribute(name, value) { this._attrs.set(String(name), String(value)); }
  removeAttribute(name) { this._attrs.delete(name); }
  getAttributeNames() { return [...this._attrs.keys()]; }
  remove() { this.parentNode?.removeChild(this); }
}

function serialize(node) {
  if (node.nodeType === 3) return escText(node.data);
  if (node.nodeType !== 1) return '';
  const attrs = [...node._attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  const open = `<${node.localName}${attrs}>`;
  if (VOID.has(node.localName) && node.namespaceURI === HTML_NS) return open;
  return `${open}${node.innerHTML}</${node.localName}>`;
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseInto(root, html, doc) {
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const nsOf = (parent, tag) => {
    const lower = tag.toLowerCase();
    if (lower === 'svg') return SVG_NS;
    if (lower === 'math') return MATH_NS;
    const inherited = parent.nodeType === 1 ? parent.namespaceURI : HTML_NS;
    return parent.nodeType === 1 && parent.localName === 'foreignObject' ? HTML_NS : inherited;
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { top().appendChild(new HtmlText(decode(html.slice(i)), doc)); break; }
    if (lt > i) top().appendChild(new HtmlText(decode(html.slice(i, lt)), doc));
    if (html.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt + 4); i = end < 0 ? html.length : end + 3; continue; }
    const close = /^<\/([a-zA-Z][^\s>/]*)\s*>/.exec(html.slice(lt));
    if (close) {
      const name = close[1].toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]._el.localName.toLowerCase() === name) { stack.length = s; break; }
      }
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([a-zA-Z][^\s>/]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(html.slice(lt));
    if (!open) { top().appendChild(new HtmlText('<', doc)); i = lt + 1; continue; }
    const parent = top()._el || top();
    const ns = nsOf(parent, open[1]);
    const el = new HtmlElement(open[1], doc, ns);
    const selfClosing = /\/\s*$/.test(open[2]);
    for (const m of open[2].replace(/\/\s*$/, '').matchAll(ATTR_RE)) {
      const name = ns === HTML_NS ? m[1].toLowerCase() : m[1];
      if (!el.hasAttribute(name)) el.setAttribute(name, decode(m[2] ?? m[3] ?? m[4] ?? ''));
    }
    top().appendChild(el);
    i = lt + open[0].length;
    if (ns === HTML_NS && VOID.has(el.localName)) continue;
    if (selfClosing && ns !== HTML_NS) continue;
    if (ns === HTML_NS && RAW_TEXT.has(el.localName)) {
      const end = html.toLowerCase().indexOf(`</${el.localName}`, i);
      const raw = html.slice(i, end < 0 ? html.length : end);
      if (raw) el.appendChild(new HtmlText(raw, doc));
      i = end < 0 ? html.length : html.indexOf('>', end) + 1 || html.length;
      continue;
    }
    // Children of a <template> live in its content fragment.
    const target = el.content || el;
    target._el = el;
    stack.push(target);
  }
}

/** A document that can create and parse nodes; nothing is rendered or loaded. */
export function createHtmlDocument({ baseURI = 'http://localhost:3344/' } = {}) {
  const doc = {
    baseURI,
    createElement: (tag) => new HtmlElement(tag, doc),
    createTextNode: (text) => new HtmlText(text, doc),
    createDocumentFragment: () => new HtmlFragment(doc),
  };
  return doc;
}

/** Parse markup into a detached <div> and hand it back (handy for assertions). */
export function parseHtml(html, doc = createHtmlDocument()) {
  const holder = doc.createElement('div');
  holder.innerHTML = html;
  return holder;
}

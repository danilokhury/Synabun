// A permissive DOM stand-in for the OpenCode panel smoke run (opencode-panel-smoke.run.mjs).
// Not a browser: innerHTML is not parsed, layout is zero. It is enough for the panel's
// modules to import and for their mount / render / event code to execute, so an
// undefined identifier or a wrong call in glue code throws here instead of in the app.
export function makeNode(tag = 'div') {
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(), nodeType: 1, children: [], childNodes: [], parentNode: null,
    dataset: {}, style: { cssText: '', setProperty() {}, removeProperty() {}, getPropertyValue: () => '' }, attributes: new Map(),
    className: '', id: '', hidden: false, disabled: false, value: '', textContent: '', _html: '',
    selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0, isConnected: true, open: false,
    files: [], checked: false,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; this.childNodes = []; },
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; },
    get content() { return this; },
    get ownerDocument() { return globalThis.document; },
    classList: null,
    appendChild(c) { if (c && typeof c === 'object') { c.parentNode?.removeChild?.(c); c.parentNode = this; this.children.push(c); this.childNodes.push(c); } return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(typeof c === 'string' ? makeText(c) : c)); },
    prepend(...cs) { cs.reverse().forEach((c) => { c.parentNode = this; this.children.unshift(c); }); },
    insertBefore(c, ref) { c.parentNode?.removeChild?.(c); c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
    replaceChild(n, o) { const i = this.children.indexOf(o); if (i >= 0) { this.children[i] = n; n.parentNode = this; o.parentNode = null; } return o; },
    replaceChildren(...cs) { this.children = []; cs.forEach((c) => this.appendChild(c)); },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { this.parentNode?.removeChild(this); },
    setAttribute(k, v) { this.attributes.set(k, String(v)); },
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; },
    hasAttribute(k) { return this.attributes.has(k); },
    removeAttribute(k) { this.attributes.delete(k); },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(ev) { for (const fn of [...(listeners.get(ev.type) || [])]) fn(ev); return true; },
    _fire(type, ev = {}) { for (const fn of [...(listeners.get(type) || [])]) fn({ type, target: this, preventDefault() {}, stopPropagation() {}, isTrusted: true, ...ev }); },
    querySelector(sel) { return find(this, sel)[0] || null; },
    querySelectorAll(sel) { return find(this, sel); },
    closest() { return null; },
    contains(o) { return o === this || this.children.some((c) => c.contains?.(o)); },
    focus() {}, blur() {}, click() { this._fire('click'); }, select() {}, setSelectionRange() {}, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    offsetWidth: 0, offsetHeight: 0, offsetTop: 0, offsetLeft: 0,
    scrollTo() {}, animate() { return { finished: Promise.resolve(), cancel() {} }; },
    createElement: (t) => makeNode(t), createElementNS: (_ns, t) => makeNode(t), createTextNode: (t) => makeText(t), createDocumentFragment: () => makeNode('#fragment'),
  };
  const classes = new Set();
  node.classList = {
    add: (...c) => { c.forEach((x) => classes.add(x)); node.className = [...classes].join(' '); },
    remove: (...c) => { c.forEach((x) => classes.delete(x)); node.className = [...classes].join(' '); },
    toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); node.className = [...classes].join(' '); return on; },
    contains: (c) => classes.has(c) || String(node.className).split(/\s+/).includes(c),
  };
  return node;
}
function makeText(t) { return { nodeType: 3, data: String(t), textContent: String(t), parentNode: null, remove() {}, contains: () => false }; }
function matches(node, sel) {
  if (!node || node.nodeType !== 1) return false;
  const cls = String(node.className || '').split(/\s+/);
  return sel.split(',').some((part) => {
    const s = part.trim().split(/\s+/).pop();
    if (s.startsWith('.')) return s.slice(1).split('.').every((c) => cls.includes(c.replace(/\[.*$/, '')));
    if (s.startsWith('#')) return node.id === s.slice(1);
    return node.tagName === s.replace(/\[.*$/, '').toUpperCase();
  });
}
function find(root, sel, out = []) {
  for (const c of root.children || []) { if (matches(c, sel)) out.push(c); find(c, sel, out); }
  return out;
}
export function installDom() {
  const doc = makeNode('#document');
  doc.body = makeNode('body'); doc.head = makeNode('head'); doc.documentElement = makeNode('html');
  doc.getElementById = (id) => find(doc.body, `#${id}`)[0] || find(doc.head, `#${id}`)[0] || null;
  doc.activeElement = null; doc.baseURI = 'http://localhost:3344/'; doc.visibilityState = 'visible'; doc.cookie = '';
  doc.appendChild(doc.body);
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
  const win = makeNode('#window');
  Object.assign(win, { document: doc, localStorage: store(), sessionStorage: store(), location: { protocol: 'http:', host: 'localhost:3344', hostname: 'localhost', href: 'http://localhost:3344/', pathname: '/', search: '', hash: '', origin: 'http://localhost:3344' }, innerWidth: 1400, innerHeight: 900, devicePixelRatio: 2, confirm: () => true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }), getComputedStyle: () => ({ getPropertyValue: () => '' }), requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: (id) => clearTimeout(id), open: () => null, history: { pushState() {}, replaceState() {}, state: null }, performance: globalThis.performance, name: '', parent: null, top: null, opener: null, frameElement: null });
  win.parent = win; win.top = win; win.self = win; win.window = win;
  class FakeWS { constructor() { this.readyState = 0; this._l = new Map(); FakeWS.last = this; } addEventListener(t, f) { if (!this._l.has(t)) this._l.set(t, new Set()); this._l.get(t).add(f); } removeEventListener(t, f) { this._l.get(t)?.delete(f); } send(d) { (this.sent ||= []).push(d); } close() {} _emit(t, e = {}) { for (const f of [...(this._l.get(t) || [])]) f(e); } }
  FakeWS.OPEN = 1; FakeWS.CONNECTING = 0; FakeWS.CLOSED = 3;
  const define = (k, v) => { try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } catch {} };
  define('window', win); define('document', doc); define('localStorage', win.localStorage); define('sessionStorage', win.sessionStorage);
  define('location', win.location); define('navigator', { clipboard: { writeText: async () => {} }, userAgent: 'node', platform: 'MacIntel', language: 'en', onLine: true, mediaDevices: {} });
  define('WebSocket', FakeWS); define('requestAnimationFrame', win.requestAnimationFrame); define('cancelAnimationFrame', win.cancelAnimationFrame);
  define('CustomEvent', class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } });
  define('Event', class { constructor(type) { this.type = type; this.isTrusted = false; } });
  define('MutationObserver', class { observe() {} disconnect() {} }); define('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  define('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
  define('HTMLElement', class {}); define('Node', class {}); define('Element', class {}); define('Image', class {});
  define('CSS', { escape: (s) => String(s), supports: () => false });
  define('FileReader', class { readAsDataURL() { setTimeout(() => { this.result = 'data:x/y;base64,QQ=='; this.onload?.(); }, 0); } });
  define('getComputedStyle', win.getComputedStyle); define('matchMedia', win.matchMedia);
  define('fetch', async (url) => ({ ok: true, status: 200, json: async () => ({ ok: true, data: [], projects: [], skills: [], commands: [], branches: [] }), text: async () => '' }));
  return { doc, win, FakeWS };
}

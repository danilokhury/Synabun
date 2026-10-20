// ═══════════════════════════════════════════
// SynaBun Neural Interface — Showcase privacy
// ═══════════════════════════════════════════
//
// Loaded only in showcase mode (`?showcase`, storage.js isShowcaseMode) by the
// main entry points, for product screenshots: the feature stays sharp, the
// user's own content is blurred (a CSS filter; no text is removed or rewritten).
//
//  - Wholesale, by selector: the surfaces that always hold the user's content
//    (memory text, session titles, transcripts, terminal output, Resume results,
//    account names, toast text). Pure CSS, so a node is blurred the moment it
//    is drawn.
//  - By what it says: any element whose own visible text, value or placeholder
//    matches a private pattern (emails, home paths, ids, keys, phone numbers,
//    the names of the user's other projects, their OS user name...). A
//    debounced MutationObserver looks only at added or changed nodes.
//  - Same-origin frames (detached side-panel sessions) get the same treatment.
//
// Canvas text cannot be blurred: the 3D map's labels (#map-labels) and the 2D
// map (#canvas-main) are drawn on canvases; blur("#map-labels") blurs all of
// them at once.
//
// window.__synabunShowcase = { scan, blur, unblur, stats }.

const BLUR_CLASS = 'sb-showcase-blur';
const MANUAL_CLASS = 'sb-showcase-manual';
const CLEAR_ATTR = 'data-sb-showcase-clear';
const STYLE_ID = 'sb-showcase-style';
const BLUR = 'blur(7px)';
const DEBOUNCE_MS = 120;
// Private text split over a few spans (a path in pieces): a parent holding at
// most this much text is read as one, up to this many levels up.
const SPAN_MAX = 160;
const SPAN_LEVELS = 3;

/** Surfaces that always hold the user's own content (class names from the shared UI modules). */
export const WHOLESALE_SELECTORS = [
  // Memories: detail card, map hover title, Memory Explorer rows, bookmarks, trash
  '.detail-card [data-role="content"]', '.detail-card .md-textarea', '.detail-card .tag-text',
  '.detail-card [data-role="files-content"]', '.detail-card [data-role="meta-content"] .detail-meta-row > span:last-child',
  '#tooltip-preview', '.explorer-memory .explorer-label', '.dropdown-item-title',
  '.tw-item-preview', '.tw-detail-body', '.tw-detail-tags', '.tw-detail-file',
  // Session pills, windows and tabs, with their titles
  '.term-minimized-pill-label', '.sp-session-title', '.asp-title',
  '.cp-session-label', '.cp-sess-prompt', '.cp-sess-meta',
  '#cxp-session-label', '.cxp-sess-prompt', '.cxp-sess-meta',
  '.ocpv2-session-label', '.ocpv2-session-item[data-tooltip] .ocpv2-session-item-label', '.ocpv2-session-item-meta', '.ocpv2-session-share-url',
  '.term-tab-label', '.term-float-tab-title', '.peek-tab-label', '.sm-card-project', '.sm-card-val',
  // Claude Code side panel transcript
  '.msg-user .msg-bubble', '.msg-assistant .msg-body', '.msg-thinking-content', '.tool-detail', '.tool-section', '.tool-result-content',
  '.cp-bash-cmd', '.cp-bash-desc', '.cp-bash-out', '.cp-queue-text', '.cp-todo-txt', '.cp-task-title',
  // Codex side panel transcript
  '.cxp-msg-user-text', '.cxp-msg-body', '.cxp-reasoning-body', '.cxp-think-detail',
  '.cxp-card-subtitle', '.cxp-card-body', '.cxp-fold-body', '.cxp-queue-item-text',
  // OpenCode side panel transcript
  '.ocpv2-part-text', '.ocpv2-reasoning-body', '.ocpv2-tc-summary', '.ocpv2-tc-meta', '.ocpv2-tc-body',
  '.ocpv2-tool-input', '.ocpv2-tool-output', '.ocpv2-sb-summary',
  // Assistant transcript, run and worker cards
  '.asst-msg-text', '.asst-md', '.asst-thinking-content', '.asst-run-title', '.asst-run-summary', '.asst-run-escalate-reason',
  '.asst-tool-detail', '.asst-tool-body', '.asst-tool-section', '.asst-tl-said', '.asst-tl-subject', '.asst-bubble-text',
  '.asst-station-sub', '.asst-station-log', '.asst-auto-title', '.asst-auto-summary', '.asst-auto-detail',
  // Composers, once they hold text (an empty one keeps its placeholder sharp)
  '#cp-input:not(:placeholder-shown)', '#cxp-input:not(:placeholder-shown)', '.ocpv2-compose-input:not(:placeholder-shown)',
  '.asst-input:not(:placeholder-shown)',
  // Terminal output (the WebGL canvas and the DOM renderer alike) and the terminal's browser tab
  '.term-viewport .xterm-screen', '.term-float-tab-body .xterm', '.browser-canvas', '.browser-url-input', '.browser-title-label',
  // Resume results
  '.resume-session-prompt', '.resume-session-snippet', '.resume-continue-prompt', '.resume-project-name',
  '.resume-project-badge', '.resume-branch',
  // Account emails and names
  '.acct-menu-trigger-name', '.acct-menu-item-name', '.acct-menu-item-id', '.acct-menu-avatar', '.acct-menu-note', '.acct-menu-v',
  '.asst-account-label', '.asst-account-sub', '.asst-account-cred', '.as-launch-account-name',
  '.asst-acct-name', '.asst-acct-line', '.asst-acct-avatar', '.asst-acct-value-text',
  '.invite-key-box', '.invite-url-text', '.invite-key-status',
  // Toast text
  '.notif-toast-msg', '.term-toast', '#fe-toast', '.as-toast', '.ss-toast', '.cc-toast', '.asp-toast',
  // Workspace names, generated image names
  '.ws-row-name', '.ws-row-meta', '#ws-active-name', '.ig-card-name', '.ig-lb-name',
];
const WHOLESALE = WHOLESALE_SELECTORS.join(',');

// The shared tooltip element shows a memory or session title for some rows and
// a control's name for the rest: it is blurred when what it describes is private.
const TOOLTIP_TEXT = '.ui-tooltip-text';

// ── Patterns ──────────────────────────────────────────────────────

const PHONE_PATTERNS = [
  /(?:^|[^\w+])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,5}){2,4}\b/, // +55 11 9####-####, +1 415 555 0100
  /\(\d{2,3}\)\s?\d{4,5}[\s.-]\d{4}\b/,                                  // (11) 91234-5678
  /\b\d{2}\s9\d{4}[\s-]\d{4}\b/,                                          // 11 91234-5678
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/,                                      // 415-555-0100
];

/**
 * Patterns that name a checkout's own private work stay out of the published code: a checkout
 * may list them in showcase-private-patterns.json beside this file, as [reason, source, flags,
 * ownOnly] rows. A release has none, and the page's one request for it answers 404.
 */
export function patternsFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') return [];
    try { return [[row[0], new RegExp(row[1], typeof row[2] === 'string' ? row[2] : ''), row[3] === true]]; } catch { return []; }
  });
}
const LOCAL_PATTERNS = typeof window === 'undefined' ? [] : await fetch(new URL('./showcase-private-patterns.json', import.meta.url))
  .then((res) => (res.ok ? res.json() : []))
  .then(patternsFromRows, () => []);

/**
 * What the matcher looks for, besides the names it is given: [reason, test, ownOnly].
 * ownOnly tests are skipped on the joined text of a few spans, where labels and numbers
 * that sit side by side would read as one long key or a phone number.
 */
export const PRIVATE_PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['home-path', /(?:^|[^\w.-])\/(?:Users|home)\/[^/\s]+|\b[A-Za-z]:\\Users\\[^\\\s]+/],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['secret', /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[a-z]-[A-Za-z0-9-]{8,}|\bAIza[0-9A-Za-z_-]{20,}/],
  ['secret', (text) => (text.match(/[A-Za-z0-9+=]{24,}/g) || []).some((run) => (run.match(/\d/g) || []).length >= 3 && (run.match(/[A-Za-z]/g) || []).length >= 3), true],
  ['phone', (text) => PHONE_PATTERNS.some((re) => re.test(text)), true],
  ...LOCAL_PATTERNS,
];

const SELF_PROJECT = 'synabun';
const GENERIC_USER_NAMES = new Set(['user', 'users', 'admin', 'root', 'shared', 'home', 'guest', 'test', 'public']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A path's last folder name ('/a/b/' → 'b', 'C:\\x\\y' → 'y'). */
function baseName(path) {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * The names a registered-project list gives away: every project's label and folder
 * name except SynaBun's own, and the OS user name read from the home folder in the paths.
 * @param {Array<{path?: string, label?: string}>} projects GET /api/projects → projects
 */
export function namesFromProjects(projects = []) {
  const projectNames = new Set();
  const userNames = new Set();
  for (const p of Array.isArray(projects) ? projects : []) {
    const path = String(p?.path || '');
    const label = String(p?.label || '');
    for (const name of [/[\\/]/.test(label) ? baseName(label) : label, baseName(path)]) {
      const key = squash(name);
      if (key.length >= 4 && key !== SELF_PROJECT) projectNames.add(name.trim());
    }
    const home = path.match(/^\/(?:Users|home)\/([^/]+)/) || path.match(/^[A-Za-z]:\\Users\\([^\\]+)/i);
    if (home && home[1].length >= 3 && !GENERIC_USER_NAMES.has(home[1].toLowerCase())) userNames.add(home[1]);
  }
  return { projectNames: [...projectNames], userNames: [...userNames] };
}

/**
 * A name as a pattern: its words (camelCase humps, '-', '_', '.', spaces) may be joined by
 * '-', '_' or '.' or nothing ('SynabunWeb' finds "synabun-web"), never inside a longer word.
 * A plain one-word name ('Downloads') must match its case, so ordinary prose stays clear.
 */
function namePattern(name) {
  const words = String(name).trim().split(/[\s_.-]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  if (!words.length) return null;
  const plainWord = words.length === 1 && !/[A-Z].*[A-Z]/.test(name.slice(1));
  const body = words.map(escapeRe).join('[_.-]?');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, plainWord ? '' : 'i');
}

/**
 * The private-text test. Returns the reason ('email', 'project-name'...) or null.
 * @param {{projectNames?: string[], userNames?: string[], extraPatterns?: Array}} names  extraPatterns: rows of patternsFromRows (the page's own are already in PRIVATE_PATTERNS)
 */
export function createPrivacyMatcher({ projectNames = [], userNames = [], extraPatterns = [] } = {}) {
  const named = [
    ...projectNames.filter((n) => squash(n) !== SELF_PROJECT).map((n) => ['project-name', namePattern(n)]),
    ...userNames.map((n) => ['user-name', new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, 'i')]),
  ].filter(([, re]) => re);
  const checks = [...PRIVATE_PATTERNS, ...extraPatterns, ...named];
  /** @param {{ joined?: boolean }} [options] joined: the text of several spans run together */
  return function privateReason(text, { joined = false } = {}) {
    const value = String(text ?? '');
    if (value.trim().length < 3) return null;
    for (const [reason, test, ownOnly] of checks) {
      if (joined && ownOnly) continue;
      if (typeof test === 'function' ? test(value) : test.test(value)) return reason;
    }
    return null;
  };
}

// ── What an element shows ─────────────────────────────────────────

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HTML', 'HEAD', 'BODY', 'IFRAME', 'CANVAS']);
const TEXTLESS_INPUTS = new Set(['hidden', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'submit', 'reset', 'button']);

/** The text of an element's own text nodes (not its children's). */
export function ownText(el) {
  let text = '';
  for (const node of el?.childNodes || []) if (node.nodeType === 3) text += node.data;
  return text;
}

/** What a form field shows: its value (never a password's) and placeholder; a select's chosen option. */
export function fieldTexts(el) {
  const tag = el?.tagName;
  if (tag === 'SELECT') return [...(el.selectedOptions || [])].map((o) => o.textContent || '');
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return [];
  const type = String(el.type || 'text').toLowerCase();
  if (tag === 'INPUT' && TEXTLESS_INPUTS.has(type)) return [];
  return [type === 'password' ? '' : String(el.value || ''), String(el.placeholder || '')];
}

/** Why an element's own text, value or placeholder is private, or null. */
export function elementReason(el, matcher) {
  if (!el || el.nodeType !== 1 || SKIP_TAGS.has(el.tagName)) return null;
  return matcher([ownText(el), ...fieldTexts(el)].filter(Boolean).join('\n'));
}

// ── The page side ─────────────────────────────────────────────────

function styleText() {
  // One rule per selector: a selector one engine rejects drops only its own rule.
  return [...WHOLESALE_SELECTORS, `.${BLUR_CLASS}`, `.${MANUAL_CLASS}`]
    .map((sel) => `${sel} { filter: ${BLUR} !important; }`).join('\n');
}

/**
 * Turn showcase privacy on for this window (and its same-origin frames). Idempotent.
 * @param {{ win?: Window, fetchProjects?: () => Promise<Array<{path:string,label:string}>> }} [options]
 */
export function installShowcasePrivacy({ win = globalThis.window, fetchProjects } = {}) {
  if (win.__synabunShowcase) return win.__synabunShowcase;
  const docs = new Set();
  let matcher = createPrivacyMatcher();
  let namesLoaded = false;
  let nameCount = 0;
  let scans = 0;
  let lastScanMs = 0;

  const isCleared = (el) => el.hasAttribute(CLEAR_ATTR);
  const setBlur = (el, on) => { if (el.classList.contains(BLUR_CLASS) !== on) el.classList.toggle(BLUR_CLASS, on); };

  function hoverIsPrivate(doc, state) {
    const hovered = state.lastHover;
    if (!hovered || !hovered.isConnected) return false;
    try {
      if (hovered.closest(WHOLESALE) || hovered.querySelector(WHOLESALE)) return true;
    } catch { /* a selector this engine rejects */ }
    return !!matcher(hovered.getAttribute('data-tooltip') || '');
  }

  /** Is this element private by what it shows (or, for the tooltip, by what it describes)? */
  function isPrivate(el, doc, state) {
    if (isCleared(el)) return false;
    if (elementReason(el, matcher)) return true;
    return el.matches?.(TOOLTIP_TEXT) && hoverIsPrivate(doc, state);
  }

  // A small element's whole text (null for a container): a parent with many children is a list, not a split label.
  function smallText(node, cache) {
    if (cache?.has(node)) return cache.get(node);
    let text = null;
    if (node.childElementCount <= 12 && !SKIP_TAGS.has(node.tagName)) {
      text = node.textContent || '';
      if (text.length > SPAN_MAX) text = null;
    }
    cache?.set(node, text);
    return text;
  }

  // Private text split over spans: the nearest small ancestor whose whole text is private.
  function spanningAncestor(el, cache) {
    let node = el?.parentElement;
    for (let level = 0; node && level < SPAN_LEVELS; level++, node = node.parentElement) {
      if (isCleared(node)) return null;
      const text = smallText(node, cache);
      if (text === null) return null;
      if (matcher(text, { joined: true })) return node;
    }
    return null;
  }

  /** Still private, for an element that carries the blur class: by its own text or as a span hit. */
  function stillPrivate(el, doc, state) {
    if (isPrivate(el, doc, state)) return true;
    const text = isCleared(el) ? null : smallText(el);
    return text !== null && !!matcher(text, { joined: true });
  }

  /** The elements that should carry the blur class: root alone, or root and everything under it. */
  function collect(root, doc, state, into, { walk = true } = {}) {
    const cache = new Map();
    const consider = (el) => {
      if (!el || el.nodeType !== 1 || isCleared(el)) return;
      if (isPrivate(el, doc, state)) { into.add(el); return; }
      const up = ownText(el).trim() ? spanningAncestor(el, cache) : null;
      if (up) into.add(up);
    };
    if (root.nodeType === 3) { consider(root.parentElement); return into; }
    if (root.nodeType !== 1 && root.nodeType !== 9) return into;
    const start = root.nodeType === 9 ? root.body : root;
    if (!start) return into;
    if (start.nodeType === 1) consider(start);
    if (!walk) return into;
    const walker = doc.createTreeWalker(start, 1 /* SHOW_ELEMENT */);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) consider(el);
    return into;
  }

  function attachFrames(root) {
    const frames = root.nodeType === 1 && root.tagName === 'IFRAME' ? [root] : [...(root.querySelectorAll?.('iframe') || [])];
    for (const frame of frames) {
      if (frame.__sbShowcase) continue;
      frame.__sbShowcase = true;
      const tryAttach = () => {
        try {
          const doc = frame.contentDocument;
          if (doc && doc.readyState !== 'uninitialized' && doc.location?.href !== 'about:blank') attachDocument(doc);
        } catch { /* another origin: nothing to reach */ }
      };
      frame.addEventListener('load', tryAttach);
      tryAttach();
    }
  }

  function attachDocument(doc) {
    if (!doc || doc.__sbShowcaseState) return;
    // pending: added nodes (walked); touched: elements whose own content changed (checked alone).
    const state = { doc, pending: new Set(), touched: new Set(), timer: null, lastHover: null, observer: null };
    doc.__sbShowcaseState = state;
    docs.add(doc);
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = styleText();
    (doc.head || doc.documentElement).appendChild(style);

    const flush = () => {
      state.timer = null;
      const added = [...state.pending];
      const touched = [...state.touched];
      state.pending.clear();
      state.touched.clear();
      const hits = new Set();
      const seen = new Set();
      const note = (node) => {
        // What lost its private text loses the blur: the node and the small ancestors a span hit may sit on.
        let el = node.nodeType === 1 ? node : node.parentElement;
        for (let level = 0; el && level <= SPAN_LEVELS; level++, el = el.parentElement) seen.add(el);
      };
      for (const node of added) {
        if (!node.isConnected) continue;
        collect(node, doc, state, hits);
        note(node);
        if (node.nodeType === 1) {
          attachFrames(node);
          for (const marked of node.querySelectorAll(`.${BLUR_CLASS}`)) seen.add(marked);
        }
      }
      for (const node of touched) {
        if (!node.isConnected) continue;
        collect(node, doc, state, hits, { walk: false });
        note(node);
      }
      for (const el of seen) if (el.classList?.contains(BLUR_CLASS) && !hits.has(el) && !stillPrivate(el, doc, state)) setBlur(el, false);
      for (const el of hits) setBlur(el, true);
    };
    const schedule = () => { if (!state.timer) state.timer = doc.defaultView.setTimeout(flush, DEBOUNCE_MS); };
    const queue = (node) => { if (node) { state.pending.add(node); schedule(); } };
    const touch = (node) => { if (node) { state.touched.add(node); schedule(); } };

    state.observer = new doc.defaultView.MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of r.addedNodes) queue(n);
          if (r.removedNodes.length) touch(r.target);
        } else {
          touch(r.target);
        }
      }
    });
    state.observer.observe(doc.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value', 'placeholder'],
    });
    const onField = (e) => { if (e.target?.nodeType === 1) touch(e.target); };
    doc.addEventListener('input', onField, true);
    doc.addEventListener('change', onField, true);
    doc.addEventListener('mouseover', (e) => {
      state.lastHover = e.target?.closest?.('[data-tooltip]') || null;
    }, true);

    scanDocument(doc);
    attachFrames(doc);
  }

  function liveDocs() {
    for (const doc of docs) if (!doc.defaultView || !doc.documentElement?.isConnected) docs.delete(doc);
    return [...docs];
  }

  function scanDocument(doc) {
    const state = doc.__sbShowcaseState;
    const hits = collect(doc, doc, state, new Set());
    for (const el of doc.querySelectorAll(`.${BLUR_CLASS}`)) if (!hits.has(el)) setBlur(el, false);
    for (const el of hits) setBlur(el, true);
  }

  function blurredIn(doc) {
    const out = new Set();
    for (const sel of [...WHOLESALE_SELECTORS, `.${BLUR_CLASS}`, `.${MANUAL_CLASS}`]) {
      try { for (const el of doc.querySelectorAll(sel)) if (!isCleared(el)) out.add(el); } catch { /* rejected selector */ }
    }
    return out;
  }

  function each(selector, fn) {
    if (typeof selector !== 'string' || !selector.trim()) throw new Error('showcase: a CSS selector is needed');
    let count = 0;
    for (const doc of liveDocs()) {
      let found;
      try { found = doc.querySelectorAll(selector); } catch { throw new Error(`showcase: invalid selector ${selector}`); }
      for (const el of found) { fn(el); count++; }
    }
    return count;
  }

  const api = Object.freeze({
    /** Scan every page and frame again from scratch; returns how many elements are blurred. */
    scan() {
      const started = Date.now();
      for (const doc of liveDocs()) attachFrames(doc);
      let total = 0;
      for (const doc of liveDocs()) { scanDocument(doc); total += blurredIn(doc).size; }
      scans++;
      lastScanMs = Date.now() - started;
      return total;
    },
    /** Blur what the selector matches (also undoes an unblur); returns how many. */
    blur(selector) {
      return each(selector, (el) => {
        el.removeAttribute(CLEAR_ATTR);
        el.style.removeProperty('filter');
        el.classList.add(MANUAL_CLASS);
      });
    },
    /** Keep what the selector matches sharp, whatever the rules say; returns how many. */
    unblur(selector) {
      return each(selector, (el) => {
        el.classList.remove(BLUR_CLASS, MANUAL_CLASS);
        el.setAttribute(CLEAR_ATTR, '');
        el.style.setProperty('filter', 'none', 'important');
      });
    },
    /** Counts only: never the private text or names themselves. */
    stats() {
      const all = liveDocs();
      const count = (sel) => all.reduce((n, doc) => n + doc.querySelectorAll(sel).length, 0);
      return {
        documents: all.length,
        blurred: all.reduce((n, doc) => n + blurredIn(doc).size, 0),
        matched: count(`.${BLUR_CLASS}`),
        manual: count(`.${MANUAL_CLASS}`),
        cleared: count(`[${CLEAR_ATTR}]`),
        namesLoaded,
        names: nameCount,
        scans,
        lastScanMs,
      };
    },
  });
  win.__synabunShowcase = api;

  attachDocument(win.document);

  // The registered projects name the user's other work and, by their paths, the OS user.
  const load = fetchProjects || (async () => {
    const res = await win.fetch('/api/projects');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json())?.projects || [];
  });
  Promise.resolve().then(load).then((projects) => {
    const names = namesFromProjects(projects);
    matcher = createPrivacyMatcher(names);
    nameCount = names.projectNames.length + names.userNames.length;
    namesLoaded = true;
    api.scan();
  }).catch((err) => console.warn('[showcase] project names unavailable, pattern blur only:', err?.message || err));

  return api;
}

/**
 * Bounded, value-free description of a page for the browser judgments, and the
 * deterministic half of auto-heal.
 *
 * This module never talks to TypeSafe: it collects, classifies and verifies.
 * It never calls ariaSnapshot either — every AI snapshot capture replaces
 * Playwright's ref map, so a hidden second capture would silently invalidate
 * the refs a caller is holding. Everything here is a plain DOM scan.
 *
 * What may leave the page is decided in `inPageAssist`: visible elements only,
 * no input/textarea values, no contenteditable text, no option labels, and any
 * echo of a typed value elsewhere on the page replaced with `[input]`. In-page
 * caps are advisory (a page can patch String.prototype), so every string is
 * type-checked and clipped again here in Node.
 */
import { randomBytes } from 'node:crypto';
import {
  classifyTargetRisk, fingerprintTarget, sanitizeUrl, bestName, candidateKind, HANDLER_ATTRS,
} from '../../mcp-server/dist/services/browser-risk.js';

const CAPS = { name: 160, group: 80, heading: 120, alert: 160, title: 160, dialogs: 3, headings: 8, alerts: 3, controls: 12, state: 6000 };
const CANDIDATE_QUERY = 'button, [role="button"], [role="textbox"], [role="link"], [role="checkbox"], [role="tab"], '
  + 'a[href], input, textarea, select, [role="combobox"], [role="menuitem"], [contenteditable="true"], [tabindex="0"]';
const SOCIAL_QUERY = 'button, [role="button"]';
/** Inside a form or dialog that holds a draft, these containers hold the user's own content: a quoted post, a link preview, an attachment. */
const DRAFT_CONTENT = '[data-testid="attachments"], article, [role="article"], blockquote, [data-testid="card.wrapper"], [data-testid^="card.layout"]';
const CAPTCHA_HOSTS = ['recaptcha', 'hcaptcha.com', 'challenges.cloudflare.com', 'turnstile', 'arkoselabs.com', 'funcaptcha', 'geetest.com', 'px-captcha', 'perimeterx', 'datadome'];
const PAYMENT_HOSTS = ['js.stripe.com', 'checkout.stripe.com', 'paypal.com', 'braintreegateway.com', 'braintree-api.com', 'adyen.com', 'checkout.com', 'squareup.com', 'klarna.com'];
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com', 'auth0.com', 'okta.com', 'onelogin.com'];

/**
 * Runs in the page. Self-contained: no closure over this module, everything
 * arrives in `args`. One function so visibility, naming and scrubbing have a
 * single definition for hints, semantic context, target facts and heal checks.
 */
function inPageAssist(root, args) {
  const EDITABLE_ROLES = ['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider'];
  const EDITABLE_SEL = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"], [role="slider"]';
  const PRUNE = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1, IFRAME: 1, OBJECT: 1, OPTION: 1, SELECT: 1, TEXTAREA: 1, INPUT: 1, SVG: 1 };
  const attr = (el, name) => (el && el.getAttribute && el.getAttribute(name)) || '';
  const flat = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const norm = s => flat(s).toLowerCase();

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'hidden'].includes((attr(el, 'type') || 'text').toLowerCase());
    if (el.isContentEditable && attr(el, 'contenteditable') !== 'false') return true;
    return EDITABLE_ROLES.includes(attr(el, 'role').toLowerCase());
  }

  function isVisible(el, o) {
    o = o || {};
    if (!el || !el.isConnected) return false;
    for (let n = el; n; n = n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
      if (n.hidden || n.inert || attr(n, 'aria-hidden') === 'true') return false;
    }
    if (el.checkVisibility) {
      if (!el.checkVisibility({ opacityProperty: !o.allowTransparent, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    } else {
      for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n); if (c.display === 'none' || (!o.allowTransparent && +c.opacity === 0)) return false; }
      if (getComputedStyle(el).visibility !== 'visible') return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (r.bottom + window.scrollY <= 0 || r.right + window.scrollX <= 0) return false;
    if (o.viewportOnly && (r.top >= window.innerHeight || r.bottom <= 0 || r.left >= window.innerWidth || r.right <= 0)) return false;
    return true;
  }

  // Cheap subtree test for the text walker: hidden branches contribute nothing.
  function rendered(el) {
    if (el.hidden || el.inert || attr(el, 'aria-hidden') === 'true') return false;
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    const c = getComputedStyle(el);
    return c.display !== 'none' && c.visibility !== 'hidden';
  }

  /** Visible text of a subtree, never descending into an editable, a hidden branch or a script. */
  function safeText(node, max) {
    if (!node || isEditable(node) || PRUNE[String(node.tagName || '').toUpperCase()]) return '';
    let out = '';
    let seen = 0;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) return (PRUNE[n.tagName && n.tagName.toUpperCase()] || isEditable(n) || !rendered(n)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      if (++seen > 400 || out.length > max * 2) break;
      out += ' ' + walker.currentNode.nodeValue;
    }
    return flat(out).slice(0, max);
  }

  // Values typed into the page. They stay in the page; they exist only so an
  // echo of one elsewhere ("Search for 'x'", a mirrored title) can be removed.
  const typed = [];
  let dirty = false;
  try {
    const editables = Array.prototype.slice.call(document.querySelectorAll(EDITABLE_SEL), 0, 50);
    for (const e of editables) {
      let v = '';
      if (e.tagName === 'SELECT') {
        if (Array.prototype.some.call(e.options || [], opt => opt.selected !== opt.defaultSelected)) dirty = dirty || isVisible(e);
        continue;
      }
      if (typeof e.value === 'string') { v = e.value; if (e.value !== (e.defaultValue || '') && isVisible(e)) dirty = true; }
      else if (e.isContentEditable || attr(e, 'role')) { v = e.textContent || ''; if (flat(v) && isVisible(e)) dirty = true; }
      v = norm(v).slice(0, 2000);
      if (v.length >= 4) {
        typed.push(v);
        for (const line of String(typeof e.value === 'string' ? e.value : e.textContent || '').split(/\n+/)) { const l = norm(line); if (l.length >= 8 && l !== v) typed.push(l); }
      }
    }
  } catch (_) { /* a page that breaks this gets no scrubbing AND, below, no text from editables anyway */ }

  function scrub(value) {
    let out = flat(value);
    if (!out || !typed.length) return out;
    for (const v of typed) {
      for (let guard = 0; guard < 8; guard++) {
        const at = out.toLowerCase().indexOf(v);
        if (at < 0) break;
        out = out.slice(0, at) + '[input]' + out.slice(at + v.length);
      }
      const low = out.toLowerCase();
      if (low.length >= 8 && low !== '[input]' && v.indexOf(low) >= 0) return '[input]';
    }
    return out;
  }

  /** Which segments of a path repeat something typed on the page (/search/<query>), in either direction. */
  function echoFlags(pathname) {
    return String(pathname || '').split('/').filter(Boolean).slice(0, 8).map(seg => {
      let d = seg;
      try { d = decodeURIComponent(seg); } catch (_) { /* keep */ }
      const low = norm(d.replace(/[-_+]+/g, ' '));
      return low.length >= 4 && typed.some(v => low.indexOf(v) >= 0 || (low.length >= 8 && v.indexOf(low) >= 0));
    });
  }

  function nonEmptyEditableIn(scope) {
    const list = scope.querySelectorAll(EDITABLE_SEL);
    for (let i = 0; i < list.length && i < 30; i++) {
      const e = list[i];
      if (e.tagName === 'SELECT') continue;
      const v = typeof e.value === 'string' ? e.value : (e.textContent || '');
      if (flat(v)) return true;
    }
    return false;
  }

  function draftZoneOf(el) {
    const zone = el.closest && el.closest('form, dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    return zone && nonEmptyEditableIn(zone) ? zone : null;
  }

  function labelledText(el) {
    const ids = attr(el, 'aria-labelledby').split(/\s+/).filter(Boolean).slice(0, 4);
    let out = '';
    for (const id of ids) {
      const ref = document.getElementById(id);
      if (ref && !isEditable(ref) && !ref.querySelector(EDITABLE_SEL)) out += ' ' + safeText(ref, 80);
    }
    return flat(out);
  }

  function namesOf(el, inDraft) {
    const editable = isEditable(el);
    const role = attr(el, 'role').toLowerCase();
    const names = { aria: scrub(attr(el, 'aria-label')), labelledby: '', label: '', text: editable ? '' : scrub(safeText(el, 160)), alt: '', title: '', placeholder: '' };
    // <label> and placeholder are static author strings and stay available beside a draft.
    if (el.labels && el.labels.length) names.label = scrub(flat(Array.prototype.slice.call(el.labels, 0, 2).map(l => safeText(l, 80)).join(' ')));
    names.placeholder = scrub(attr(el, 'placeholder') || attr(el, 'aria-placeholder') || attr(el, 'data-placeholder'));
    // The rest can mirror what is being typed: labelledby may point at a live preview,
    // grid widgets copy values into `title`, and image alt text in a composer is the user's own.
    if (inDraft) return names;
    names.labelledby = scrub(labelledText(el));
    if (!editable && (el.tagName === 'A' || el.tagName === 'BUTTON' || role === 'button' || role === 'link')) {
      const img = el.querySelector('img[alt]');
      if (img) names.alt = scrub(attr(img, 'alt'));
    }
    names.title = scrub(attr(el, 'title'));
    return names;
  }

  function factsOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = attr(el, 'role').toLowerCase() || null;
    const inputType = tag === 'input' ? (attr(el, 'type') || 'text').toLowerCase() : null;
    const zone = draftZoneOf(el);
    const form = el.closest ? el.closest('form') : null;
    const base = document.querySelector('base[target]');
    const baseTarget = base ? attr(base, 'target').toLowerCase() : '';
    const credentialSel = 'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"]';
    return {
      tag, role, inputType,
      editable: isEditable(el),
      containsEditable: !!(el.querySelector && el.querySelector(EDITABLE_SEL)),
      insideForm: !!form,
      isSubmit: (tag === 'button' && (attr(el, 'type') || 'submit').toLowerCase() === 'submit' && !!form) || (tag === 'input' && (inputType === 'submit' || inputType === 'image')),
      disabled: el.disabled === true || attr(el, 'aria-disabled') === 'true',
      toggles: el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked') || el.hasAttribute('aria-expanded')
        || ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role || '') || inputType === 'checkbox' || inputType === 'radio',
      hasPopup: !!attr(el, 'aria-haspopup') && attr(el, 'aria-haspopup') !== 'false',
      download: el.hasAttribute('download'),
      ping: el.hasAttribute('ping'),
      target: attr(el, 'target').toLowerCase(),
      baseTarget: !!baseTarget && baseTarget !== '_self',
      handlerAttrs: args.handlerAttrs.filter(name => el.hasAttribute(name)),
      hrefAttr: el.hasAttribute('href') ? attr(el, 'href') : null,
      hrefRaw: tag === 'a' && typeof el.href === 'string' && el.hasAttribute('href') ? el.href : null,
      names: namesOf(el, !!zone),
      lang: (attr(document.documentElement, 'lang') || '').toLowerCase().split(/[-_]/)[0],
      inDraftZone: !!zone,
      engagement: (() => {
        for (let n = el; n; n = n.parentElement) {
          const testid = attr(n, 'data-testid');
          if (/^(tweetButton(?:Inline)?|like|unlike|retweet|unretweet)$/.test(testid) || /-follow$/.test(testid)) return true;
        }
        return false;
      })(),
      credentialField: !!(el.matches && el.matches(credentialSel)) || !!(el.querySelector && el.querySelector(credentialSel)),
    };
  }

  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  // Backslash first, then the quote, and no newlines: page text must not be able to close the string and append clauses.
  function quote(s) { return String(s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function uniqueCss(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; } }

  function stableSelector(el, ownText) {
    const testid = attr(el, 'data-testid'); if (testid) return '[data-testid="' + cssEscape(testid) + '"]';
    const e2e = attr(el, 'data-e2e'); if (e2e) return '[data-e2e="' + cssEscape(e2e) + '"]';
    const tt = attr(el, 'data-tt'); if (tt) return '[data-tt="' + cssEscape(tt) + '"]';
    if (el.id && !/^(ember|ext-|react-|__)/.test(el.id)) { const sel = '#' + cssEscape(el.id); if (uniqueCss(sel)) return sel; }
    const aria = attr(el, 'aria-label'); if (aria && aria.length <= 80 && scrub(aria) === flat(aria)) return '[aria-label="' + cssEscape(aria) + '"]';
    const tag = el.tagName.toLowerCase();
    // An editable never gets a text-derived selector: its text is what was typed into it.
    if (isEditable(el)) return tag;
    const role = attr(el, 'role') || ({ BUTTON: 'button', A: 'link' })[el.tagName];
    const name = flat(ownText).slice(0, 60);
    // A scrubbed name no longer matches the element's real text, so it cannot address it.
    if (name.indexOf('[input]') >= 0) return tag;
    if (role && name) return 'role=' + role + '[name="' + quote(name) + '"]';
    if (name && name.length <= 40) return tag + ':has-text("' + quote(name) + '")';
    return tag;
  }

  function groupOf(el, inDraft) {
    if (inDraft) return '';
    for (let n = el.parentElement, depth = 0; n && depth < 12; n = n.parentElement, depth++) {
      const label = attr(n, 'aria-label') || labelledText(n);
      const role = attr(n, 'role').toLowerCase() || n.tagName.toLowerCase();
      if (label && /^(nav|navigation|dialog|alertdialog|region|section|form|group|toolbar|menu|tablist|aside|header|footer|main|banner|complementary|contentinfo|search)$/.test(role)) return scrub(flat(role + ' ' + label)).slice(0, 80);
      if (n.tagName === 'FIELDSET') { const legend = n.querySelector('legend'); if (legend) return scrub(safeText(legend, 80)); }
      if (/^(LI|TR|ARTICLE)$/.test(n.tagName) || /^(row|listitem|article)$/.test(attr(n, 'role'))) {
        const head = n.querySelector('h1, h2, h3, h4, [role="heading"], th, td');
        const text = head && !head.contains(el) ? safeText(head, 80) : '';
        if (text) return scrub(text).slice(0, 80);
      }
    }
    return '';
  }

  function describe(el) {
    const facts = factsOf(el);
    const ownText = facts.names.text;
    const selector = stableSelector(el, ownText);
    let nth;
    try { const matches = document.querySelectorAll(selector); if (matches.length > 1) nth = Array.prototype.indexOf.call(matches, el); } catch (_) { /* Playwright-only selector */ }
    const r = el.getBoundingClientRect();
    return {
      facts, selector, nth,
      hrefEchoed: facts.hrefRaw && typeof el.pathname === 'string' ? echoFlags(el.pathname) : [],
      inDialog: !!(el.closest && el.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')),
      group: groupOf(el, facts.inDraftZone),
      inViewport: r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
    };
  }

  function candidates(scope, query, o) {
    const out = [];
    const list = scope.querySelectorAll(query);
    for (let i = 0; i < list.length && out.length < o.scanLimit; i++) {
      const el = list[i];
      if (o.exclude && el.closest(o.exclude)) continue;
      // Beside a draft, quoted posts, link previews and attachment cards are the user's content too.
      if (o.excludeInDraft && el.closest(o.excludeInDraft) && draftZoneOf(el)) continue;
      if (o.skipEditable && (isEditable(el) || el.querySelector(EDITABLE_SEL))) continue;
      if (!isVisible(el, { viewportOnly: o.viewportOnly, allowTransparent: o.allowTransparent })) continue;
      out.push(describe(el));
    }
    return out;
  }

  const scope = root && root.nodeType === 1 ? root : document.documentElement;

  if (args.op === 'candidates') {
    return {
      items: candidates(scope, args.query, { scanLimit: args.scanLimit, viewportOnly: args.viewportOnly, allowTransparent: args.allowTransparent, exclude: args.exclude, excludeInDraft: args.excludeInDraft, skipEditable: args.skipEditable }),
      timeOrigin: performance.timeOrigin, echoedPath: echoFlags(location.pathname),
      lang: (attr(document.documentElement, 'lang') || '').toLowerCase().split(/[-_]/)[0],
    };
  }

  if (args.op === 'facts') return { facts: factsOf(root), timeOrigin: performance.timeOrigin };

  if (args.op === 'verify') {
    const r0 = root.getBoundingClientRect();
    if (r0.bottom <= 0 || r0.top >= window.innerHeight || r0.right <= 0 || r0.left >= window.innerWidth) root.scrollIntoView({ block: 'center', inline: 'center' });
    const r = root.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const facts = factsOf(root);
    const mine = norm(facts.names.aria || facts.names.labelledby || facts.names.label || facts.names.text || facts.names.alt || facts.names.title || facts.names.placeholder);
    let sameName = 0;
    const all = document.querySelectorAll(args.query);
    for (let i = 0; i < all.length && i < 3000; i++) {
      const el = all[i];
      if (!isVisible(el, {})) continue;
      const n = namesOf(el, false);
      if (norm(n.aria || n.labelledby || n.label || n.text || n.alt || n.title || n.placeholder) === mine) sameName++;
    }
    let pseudo = false;
    const nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*'), 0, 20));
    for (const n of nodes) {
      for (const which of ['::before', '::after']) {
        const content = getComputedStyle(n, which).content || '';
        if (/\p{L}.*\p{L}/u.test(content.replace(/^["']|["']$/g, '')) && !/^(none|normal)$/.test(content)) pseudo = true;
      }
    }
    return {
      facts, timeOrigin: performance.timeOrigin,
      visible: isVisible(root, {}),
      hitSelf: !!hit && (hit === root || root.contains(hit) || (hit.closest && hit.closest('a') === root)),
      sameName, dirty, pseudo,
    };
  }

  // op === 'context'
  const take = (selector, max, count, test) => {
    const out = [];
    const list = scope.querySelectorAll(selector);
    for (let i = 0; i < list.length && out.length < count && i < 400; i++) {
      if (!isVisible(list[i], {}) || (test && !test(list[i]))) continue;
      const text = scrub(safeText(list[i], max));
      if (text && out.indexOf(text) < 0) out.push(text);
    }
    return out;
  };
  const countVisible = (selector, cap) => {
    let n = 0;
    const list = document.querySelectorAll(selector);
    for (let i = 0; i < list.length && i < 600 && n < cap; i++) if (isVisible(list[i], {})) n++;
    return n;
  };
  const dialogs = [];
  const dialogEls = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  for (let i = 0; i < dialogEls.length && dialogs.length < args.caps.dialogs; i++) {
    const d = dialogEls[i];
    const r = d.getBoundingClientRect();
    if (r.width <= 8 || r.height <= 8 || !isVisible(d, {})) continue;
    const heading = d.querySelector('h1, h2, h3, [role="heading"]');
    dialogs.push({ title: scrub(attr(d, 'aria-label') || labelledText(d) || (heading ? safeText(heading, 120) : '')), hasEditable: !!d.querySelector(EDITABLE_SEL), hasNonEmptyEditable: nonEmptyEditableIn(d) });
  }
  const frameHost = (list) => {
    const frames = document.querySelectorAll('iframe[src]');
    for (let i = 0; i < frames.length && i < 60; i++) {
      const src = (attr(frames[i], 'src') || '').toLowerCase();
      if (list.some(h => src.indexOf(h) >= 0) && frames[i].getBoundingClientRect().width > 1) return true;
    }
    return false;
  };
  const echoed = echoFlags(location.pathname);
  const ITEM_SEL = 'article, [role="article"], [role="comment"], blockquote';
  const inFeed = document.querySelectorAll('article, [role="article"]').length > 1;
  const items = candidates(scope, args.query, { scanLimit: args.scanLimit, viewportOnly: false, exclude: args.exclude, excludeInDraft: args.excludeInDraft, skipEditable: args.skipEditable });
  return {
    title: scrub(document.title), lang: (attr(document.documentElement, 'lang') || '').toLowerCase().split(/[-_]/)[0], readyState: document.readyState,
    echoedPath: echoed, timeOrigin: performance.timeOrigin,
    // In a feed, a heading inside an item is somebody's name or the title of their post: not needed to read the state of
    // the page, so it stays here. A page that is one article keeps its headline, which is what the page is about.
    headings: take('h1, h2, h3, [role="heading"]', args.caps.heading, args.caps.headings, inFeed ? (el) => !el.closest(ITEM_SEL) : null),
    alerts: take('[role="alert"], [role="alertdialog"], [aria-live="assertive"], [role="status"]', args.caps.alert, args.caps.alerts),
    dialogs,
    signals: {
      busyCount: countVisible('[aria-busy="true"]', 50),
      progressCount: countVisible('[role="progressbar"], progress, [class*="skeleton" i], [class*="shimmer" i], [class*="spinner" i], [data-visualcompletion="loading-state"]', 50),
      visibleDialogCount: dialogs.length,
      passwordFieldCount: countVisible('input[type="password"]', 10),
      otpFieldCount: countVisible('input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="1"], input[name*="otp" i]', 12),
      visibleTextLength: Math.min(100000, (document.body && document.body.innerText ? document.body.innerText.length : 0)),
      linkCount: Math.min(2000, document.querySelectorAll('a[href]').length),
      controlCount: Math.min(2000, document.querySelectorAll('button, [role="button"], input, select, textarea').length),
      articleCount: Math.min(500, document.querySelectorAll('article, [role="article"]').length),
      captchaFrame: frameHost(args.captchaHosts), paymentFrame: frameHost(args.paymentHosts), authFrame: frameHost(args.authHosts),
    },
    items,
  };
}

// --- Node side: never trust what came back from the page ---

const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const bool = value => value === true;
const count = (value, max) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0);

function cleanFacts(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const n = f.names && typeof f.names === 'object' ? f.names : {};
  return {
    tag: clip(f.tag, 24).toLowerCase(), role: f.role ? clip(f.role, 24).toLowerCase() : null, inputType: f.inputType ? clip(f.inputType, 16).toLowerCase() : null,
    editable: bool(f.editable), containsEditable: bool(f.containsEditable), insideForm: bool(f.insideForm), isSubmit: bool(f.isSubmit), disabled: bool(f.disabled),
    toggles: bool(f.toggles), hasPopup: bool(f.hasPopup), download: bool(f.download), ping: bool(f.ping), target: clip(f.target, 24).toLowerCase(), baseTarget: bool(f.baseTarget),
    handlerAttrs: (Array.isArray(f.handlerAttrs) ? f.handlerAttrs : []).filter(a => HANDLER_ATTRS.includes(a)),
    hrefAttr: typeof f.hrefAttr === 'string' ? f.hrefAttr.slice(0, 2000) : null, hrefRaw: typeof f.hrefRaw === 'string' ? f.hrefRaw.slice(0, 2000) : null,
    names: { aria: clip(n.aria, CAPS.name), labelledby: clip(n.labelledby, CAPS.name), label: clip(n.label, CAPS.name), text: clip(n.text, CAPS.name), alt: clip(n.alt, CAPS.name), title: clip(n.title, CAPS.name), placeholder: clip(n.placeholder, CAPS.name) },
    lang: clip(f.lang, 8).toLowerCase(), inDraftZone: bool(f.inDraftZone), engagement: bool(f.engagement), credentialField: bool(f.credentialField),
  };
}

const IMPLICIT_ROLE = { a: 'link', button: 'button', textarea: 'textbox', select: 'combobox' };
function roleOf(facts) {
  if (facts.role) return facts.role;
  if (facts.editable && facts.tag !== 'input' && facts.tag !== 'select') return 'textbox';
  if (facts.tag === 'input') return { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button' }[facts.inputType] || 'textbox';
  return IMPLICIT_ROLE[facts.tag] || facts.tag;
}

/** Sanitized page identity. `echoed[i]` marks raw path segments that repeat something typed on the page. */
function pageIdentity(pageUrl, raw) {
  const url = sanitizeUrl(pageUrl);
  const echoed = Array.isArray(raw?.echoedPath) ? raw.echoedPath : [];
  const path = '/' + url.path.split('/').filter(Boolean).map((segment, i) => (echoed[i] === true ? ':input' : segment)).join('/');
  return { title: clip(raw?.title, CAPS.title), origin: url.origin, path, lang: clip(raw?.lang, 8).toLowerCase(), readyState: clip(raw?.readyState, 16) };
}

function toCandidate(item, index, pageUrl, hints) {
  const facts = cleanFacts(item?.facts);
  const risk = classifyTargetRisk(facts, { pageUrl });
  const selector = clip(item?.selector, 300);
  const nth = Number.isInteger(item?.nth) && item.nth >= 0 ? item.nth : undefined;
  let hrefPath;
  if (facts.hrefRaw) {
    const href = sanitizeUrl(facts.hrefRaw);
    // Same-origin only, and a segment that repeats something typed on the page is not a place name.
    const echoed = Array.isArray(item?.hrefEchoed) ? item.hrefEchoed : [];
    if (href.origin && href.origin === sanitizeUrl(pageUrl).origin && href.path) {
      hrefPath = ('/' + href.path.split('/').filter(Boolean).map((segment, i) => (echoed[i] === true ? ':input' : segment)).join('/')).slice(0, 80);
    }
  }
  const hintIndex = hints ? hints.findIndex(h => h.selector === selector && h.nth === nth) : -1;
  const candidate = {
    id: `c${index + 1}`, hintIndex: hintIndex >= 0 ? hintIndex : null, selector, ...(nth !== undefined ? { nth } : {}),
    role: roleOf(facts), kind: candidateKind(facts), ...(facts.inputType ? { inputType: facts.inputType } : {}),
    name: clip(bestName(facts), CAPS.name), ...(clip(item?.group, CAPS.group) ? { group: clip(item.group, CAPS.group) } : {}),
    ...(hrefPath ? { hrefPath } : {}), disabled: facts.disabled, inDialog: bool(item?.inDialog),
    risk, healable: risk === 'navigation' && !facts.disabled && nth === undefined && !!selector,
  };
  return { candidate, facts, fingerprint: fingerprintTarget(facts) };
}

function run(target, args, timeout) {
  return target.evaluate(inPageAssist, { handlerAttrs: [...HANDLER_ATTRS], caps: CAPS, captchaHosts: CAPTCHA_HOSTS, paymentHosts: PAYMENT_HOSTS, authHosts: AUTH_HOSTS, query: CANDIDATE_QUERY, scanLimit: 150, ...args }, timeout ? { timeout } : undefined);
}

/**
 * Legacy hint shape `{ role, text, ariaLabel, placeholder, selector, nth?, rect }`,
 * now built from the shared visibility rule and safe names: an editable's text
 * is its label, never what was typed into it.
 * opts: { limit=15, viewportOnly=true, allowTransparent=false }
 */
export async function getInteractiveHints(page, opts = {}) {
  const limit = opts.limit ?? 15;
  try {
    const raw = await run(page.locator('html'), { op: 'candidates', scanLimit: limit, viewportOnly: opts.viewportOnly !== false, allowTransparent: opts.allowTransparent === true }, 4000);
    return (Array.isArray(raw?.items) ? raw.items : []).slice(0, limit).map(item => {
      const facts = cleanFacts(item?.facts);
      const nth = Number.isInteger(item?.nth) && item.nth >= 0 ? item.nth : undefined;
      const r = item?.rect && typeof item.rect === 'object' ? item.rect : {};
      return {
        role: facts.role || facts.tag, text: clip(facts.names.text || facts.names.label || facts.names.labelledby, 60), ariaLabel: clip(facts.names.aria, 120), placeholder: clip(facts.names.placeholder, 120),
        selector: clip(item?.selector, 300), ...(nth !== undefined ? { nth } : {}),
        rect: { top: Number(r.top) || 0, left: Number(r.left) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 },
      };
    });
  } catch (_) {
    return [];
  }
}

/** Every visible interactive element, classified. `entries` (selector + fingerprint of the healable ones) never leaves the server. */
export async function collectInteractiveCandidates(page, { limit = 12, needle = '', hints = null, scopeSel = null, social = false } = {}) {
  const pageUrl = page.url();
  const raw = await run(page.locator(scopeSel || 'html').first(), social
    ? { op: 'candidates', query: SOCIAL_QUERY, scanLimit: 60, viewportOnly: false, skipEditable: true, exclude: `${DRAFT_CONTENT}, a[href]` }
    : { op: 'candidates', scanLimit: 150, viewportOnly: false, excludeInDraft: DRAFT_CONTENT }, 4000);
  // A control with no name cannot be ranked against an intent; it would only spend one of the twelve slots.
  const items = (Array.isArray(raw?.items) ? raw.items.slice(0, 150) : []).filter(item => bestName(cleanFacts(item?.facts)));
  // Lexical matches first (the caller was aiming at something), then what is on screen, in document order.
  const words = clip(needle, 120).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
  const scored = items.map((item, order) => {
    const hay = Object.values(item?.facts?.names || {}).filter(v => typeof v === 'string').join(' ').toLowerCase();
    return { item, order, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0), onScreen: item?.inViewport === true };
  });
  const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, Math.ceil(limit * 2 / 3));
  const rest = scored.filter(s => !matched.includes(s)).sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || a.order - b.order);
  const picked = [...matched, ...rest].slice(0, limit).sort((a, b) => a.order - b.order);
  const built = picked.map((s, index) => toCandidate(s.item, index, pageUrl, hints));
  const entries = {};
  for (const b of built) if (b.candidate.healable) entries[b.candidate.id] = { selector: b.candidate.selector, fingerprint: b.fingerprint };
  const identity = pageIdentity(pageUrl, raw);
  return {
    candidates: built.map(b => b.candidate), entries, truncated: items.length > built.length,
    docKey: docKeyOf(pageUrl, raw?.timeOrigin), page: { origin: identity.origin, path: identity.path, lang: identity.lang },
  };
}

function docKeyOf(pageUrl, timeOrigin) {
  let base = '';
  try { const u = new URL(pageUrl); base = u.origin + u.pathname; } catch { base = ''; }
  return `${base}|${typeof timeOrigin === 'number' && Number.isFinite(timeOrigin) ? Math.round(timeOrigin) : 0}`;
}

/**
 * The page as the judgments may see it: sanitized identity, numeric signals,
 * a few scrubbed headings, alerts and dialog titles, and up to 12 controls.
 * opts: { purpose, scopeSel, httpStatus, social }
 */
export async function collectSemanticContext(page, { purpose = 'page-state', scopeSel = null, httpStatus = null, social = false } = {}) {
  const pageUrl = page.url();
  const raw = await run(page.locator(scopeSel || 'html').first(), social
    ? { op: 'context', query: SOCIAL_QUERY, scanLimit: 60, skipEditable: true, exclude: `${DRAFT_CONTENT}, a[href]` }
    : { op: 'context', scanLimit: 60, excludeInDraft: DRAFT_CONTENT }, 4000);
  const items = Array.isArray(raw?.items) ? raw.items.slice(0, 60) : [];
  const built = items.map((item, index) => toCandidate(item, index, pageUrl, null).candidate);
  const s = raw?.signals && typeof raw.signals === 'object' ? raw.signals : {};
  const context = {
    purpose: clip(purpose, 24),
    page: pageIdentity(pageUrl, raw),
    signals: {
      httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
      busyCount: count(s.busyCount, 50), progressCount: count(s.progressCount, 50), visibleDialogCount: count(s.visibleDialogCount, 10),
      passwordFieldCount: count(s.passwordFieldCount, 10), otpFieldCount: count(s.otpFieldCount, 12), visibleTextLength: count(s.visibleTextLength, 100000),
      linkCount: count(s.linkCount, 2000), controlCount: count(s.controlCount, 2000), articleCount: count(s.articleCount, 500),
      captchaFrame: bool(s.captchaFrame), paymentFrame: bool(s.paymentFrame), authFrame: bool(s.authFrame),
    },
    headings: (Array.isArray(raw?.headings) ? raw.headings : []).map(h => clip(h, CAPS.heading)).filter(Boolean).slice(0, CAPS.headings),
    alerts: (Array.isArray(raw?.alerts) ? raw.alerts : []).map(a => clip(a, CAPS.alert)).filter(Boolean).slice(0, CAPS.alerts),
    dialogs: (Array.isArray(raw?.dialogs) ? raw.dialogs : []).slice(0, CAPS.dialogs).map(d => ({ title: clip(d?.title, CAPS.heading), hasEditable: bool(d?.hasEditable), hasNonEmptyEditable: bool(d?.hasNonEmptyEditable) })),
    controls: built.filter(c => c.name).slice(0, CAPS.controls).map(c => ({ role: c.role, name: c.name.slice(0, 80) })),
  };
  // Social: the buttons of the active dialog, payment controls already gone, names short. Advisory only — never healable.
  if (social) context.candidates = built.filter(c => c.name && c.risk !== 'payment').slice(0, 12).map(c => ({ ...c, name: c.name.slice(0, 40), healable: false }));
  // Budget: the same ~6000 characters the judgments enforce, applied here too.
  for (const key of ['controls', 'headings', 'dialogs', 'alerts']) while (JSON.stringify(context).length > CAPS.state && context[key].length) context[key].pop();
  return context;
}

/** Facts, risk and fingerprint of one resolved element (a locator or an element handle). */
export async function describeTargetFacts(target, pageUrl, timeout = 3000) {
  const raw = await run(target, { op: 'facts' }, timeout);
  const facts = cleanFacts(raw?.facts);
  return { facts, risk: classifyTargetRisk(facts, { pageUrl }), fingerprint: fingerprintTarget(facts), docKey: docKeyOf(pageUrl, raw?.timeOrigin) };
}

/**
 * Last look before the click. Returns null when the element is still the
 * plain, unique, visible, unobstructed navigation link that was recommended,
 * or a static reason code. Runs on the handle that will be clicked, so the
 * element checked is the element acted on.
 */
export async function verifyHealTarget(handle, entry, { pageUrl, docKey, timeout = 3000 }) {
  let raw;
  try { raw = await run(handle, { op: 'verify' }, timeout); } catch { return 'unverifiable'; }
  const facts = cleanFacts(raw?.facts);
  if (docKeyOf(pageUrl, raw?.timeOrigin) !== docKey) return 'document_changed';
  if (classifyTargetRisk(facts, { pageUrl }) !== 'navigation') return 'risk_changed';
  if (fingerprintTarget(facts) !== entry.fingerprint) return 'fingerprint_changed';
  if (raw?.visible !== true || facts.disabled) return 'not_actionable';
  if (raw?.hitSelf !== true) return 'occluded';
  if (raw?.sameName !== 1) return 'not_unique';
  if (raw?.dirty === true) return 'unsaved_input';
  if (raw?.pseudo === true) return 'pseudo_label';
  return null;
}

/**
 * Single-use heal contexts. The server mints one after a click it confirmed
 * never started, and a heal can only name a candidate inside it — so "follows
 * a confirmed failure", "at most once" and "this caller, this tab, this
 * document" are facts the server holds, not promises the MCP layer makes.
 */
export function createAssistContextStore({ ttlMs = 30_000, now = Date.now, maxEntries = 64 } = {}) {
  const contexts = new Map();
  const owners = new Map();
  const ownerKey = (sessionId, tabId, caller) => `${sessionId}:${tabId || 'main'}:${caller || 'ui'}`;
  const drop = id => { const ctx = contexts.get(id); if (ctx) { contexts.delete(id); if (owners.get(ctx.owner) === id) owners.delete(ctx.owner); } };
  return {
    mint({ sessionId, tabId, caller, docKey, entries }) {
      if (!entries || !Object.keys(entries).length) return null;
      const owner = ownerKey(sessionId, tabId, caller);
      const previous = owners.get(owner);
      if (previous) drop(previous);
      const id = randomBytes(12).toString('base64url');
      contexts.set(id, { owner, docKey, entries, expiresAt: now() + ttlMs });
      owners.set(owner, id);
      while (contexts.size > maxEntries) drop(contexts.keys().next().value);
      return id;
    },
    /** Deletes first, then validates: a context is spent whether or not it was valid. */
    consume({ contextId, candidateId, sessionId, tabId, caller }) {
      const ctx = typeof contextId === 'string' ? contexts.get(contextId) : undefined;
      if (!ctx) return { error: 'unknown_context' };
      drop(contextId);
      if (now() > ctx.expiresAt) return { error: 'expired_context' };
      if (ctx.owner !== ownerKey(sessionId, tabId, caller)) return { error: 'foreign_context' };
      const entry = typeof candidateId === 'string' && Object.hasOwn(ctx.entries, candidateId) ? ctx.entries[candidateId] : null;
      if (!entry) return { error: 'unknown_candidate' };
      return { entry, docKey: ctx.docKey };
    },
    clear() { contexts.clear(); owners.clear(); },
    size() { return contexts.size; },
  };
}

/** The `assist` block attached beside legacy hints after a resolution failure. */
export async function buildAssist(page, { kind, needle = '', hints = null, limit = 12 }) {
  const collected = await collectInteractiveCandidates(page, { limit, needle, hints });
  // No title here: ranking does not need it, and the path already had typed echoes replaced in-page.
  return {
    assist: { kind, truncated: collected.truncated, page: collected.page, candidates: collected.candidates },
    entries: collected.entries, docKey: collected.docKey,
  };
}

// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: markup helpers
// ═══════════════════════════════════════════
//
// Every view of the Studio writes its markup through `html`, a tagged template that escapes each value it is given
// (text, a number, a list of values) and lets through only markup made by `html` itself or marked with `raw()`
// (the icons below, nothing a skill or the server sent). A name, a description, a path or an error message can
// therefore never become an element or an attribute of the page. Also: the icons (inline SVG, stroke 1.5, the
// app's convention), dates in the page's language, and the keyboard helpers the lists and tab bars share.

class Safe {
  constructor(text) { this.text = String(text); }
  toString() { return this.text; }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** A value of any kind as text safe in element content and in a quoted attribute. Never throws. */
export function esc(value) {
  if (value === null || value === undefined || value === false) return '';
  let text;
  try { text = String(value); } catch { text = Object.prototype.toString.call(value); }
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Markup this module may pass through unescaped: only for constants of the Studio's own code. */
export const raw = (text) => new Safe(text);

const part = (value) => {
  if (value instanceof Safe) return value.text;
  if (Array.isArray(value)) return value.map(part).join('');
  if (value === null || value === undefined || value === false || value === true) return '';
  return esc(value);
};

/** A tagged template: `html\`<b>${name}</b>\`` escapes `name`; nested `html` and `raw()` pass through. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Safe(out);
}

/** Set an element's content from `html` markup (a plain string is escaped as text). */
export function setHTML(el, markup) {
  if (!el) return;
  el.innerHTML = markup instanceof Safe ? markup.text : esc(markup);
}

/** An attribute value, only when it is there: ` name="value"` or ''. */
export const attr = (name, value) => (value === null || value === undefined || value === false ? raw('') : raw(` ${name}="${esc(value === true ? '' : value)}"`));

// ── Icons ──

const svg = (body, size = 16) => raw(`<svg class="sx-i" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`);
export const ICONS = Object.freeze({
  mark: svg('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="4"/>'),
  library: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 9v11"/>'),
  review: svg('<path d="M5 12l4 4 10-10"/>'),
  create: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  dim: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" opacity=".45"/>'),
  dock: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  undock: svg('<rect x="5" y="6" width="14" height="12" rx="2"/><path d="M9 3h12v12"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', 14),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  back: svg('<path d="M15 6l-6 6 6 6"/>', 14),
  file: svg('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>', 14),
  folder: svg('<path d="M3 6h6l2 2h10v11H3z"/>', 14),
  image: svg('<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M20 16l-5-5-8 8"/>', 14),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>', 14),
  download: svg('<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>', 14),
  warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>', 14),
  err: svg('<circle cx="12" cy="12" r="8"/><path d="M9 9l6 6M15 9l-6 6"/>', 14),
  ok: svg('<path d="M5 12l4 4 10-10"/>', 14),
  info: svg('<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.5"/>', 14),
  lock: svg('<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>', 14),
  update: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>', 14),
  flag: svg('<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>', 14),
  draft: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 14),
  bridge: svg('<path d="M3 17c4-8 14-8 18 0M3 17h18M8 17v-4M16 17v-4"/>', 14),
  off: svg('<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>', 14),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 14),
  trash: svg('<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/>', 14),
  eye: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>', 14),
  code: svg('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>', 14),
  spark: svg('<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>', 14),
  chevron: svg('<path d="M7 10l5 5 5-5"/>', 14),
  history: svg('<path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5M12 8v4l3 2"/>', 14),
  publish: svg('<path d="M12 15V3M7 8l5-5 5 5M4 15v5h16v-5"/>', 14),
  test: svg('<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>', 14),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>', 14),
});

/** The icon of a health code (never the only sign: a word goes with it). */
export function healthIcon(code) {
  switch (code) {
    case 'invalid': case 'not-text': return ICONS.err;
    case 'warnings': return ICONS.warn;
    case 'update': return ICONS.update;
    case 'shadowed': case 'twice': case 'same-description': return ICONS.flag;
    case 'bridge': return ICONS.bridge;
    case 'readonly': return ICONS.lock;
    case 'draft': return ICONS.draft;
    case 'review': return ICONS.review;
    default: return ICONS.ok;
  }
}

// ── Dates ──

/** "3 min ago", "2 d ago" in the page's language; '' for nothing. */
export function relativeTime(iso, locale, now = Date.now()) {
  const at = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(at)) return '';
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  let fmt;
  try { fmt = new Intl.RelativeTimeFormat(locale || 'en', { numeric: 'auto', style: 'short' }); } catch { fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' }); }
  if (abs < 45) return fmt.format(0, 'second');
  if (abs < 3600) return fmt.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return fmt.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return fmt.format(Math.round(seconds / 86400), 'day');
  if (abs < 86400 * 365) return fmt.format(Math.round(seconds / (86400 * 30)), 'month');
  return fmt.format(Math.round(seconds / (86400 * 365)), 'year');
}

/** A date written out in the page's language (a title for the relative one). */
export function fullTime(iso, locale) {
  const at = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(at)) return '';
  try { return new Date(at).toLocaleString(locale || 'en', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return new Date(at).toISOString(); }
}

/** A byte count in the page's language: "640 B", "12 KB", "1.4 MB". */
export function formatBytes(n, locale) {
  const v = Number(n) || 0;
  const f = (x, digits) => { try { return x.toLocaleString(locale || 'en', { maximumFractionDigits: digits }); } catch { return x.toFixed(digits); } };
  if (v < 1024) return `${f(v, 0)} B`;
  if (v < 1024 * 1024) return `${f(v / 1024, v < 10 * 1024 ? 1 : 0)} KB`;
  return `${f(v / (1024 * 1024), 1)} MB`;
}

/** A number in the page's language. */
export function formatNumber(n, locale) {
  try { return Number(n).toLocaleString(locale || 'en'); } catch { return String(n); }
}

// ── Keyboard ──

/**
 * Roving focus in a list of items (rows, tree items, tabs): one item is in the tab order, the arrows move it.
 * @param {HTMLElement} container @param {string} selector the items
 * @param {{ orientation?: 'vertical'|'horizontal', onMove?: (item) => void, signal?: AbortSignal }} [o]
 */
export function rovingFocus(container, selector, { orientation = 'vertical', onMove = null, signal } = {}) {
  const items = () => [...container.querySelectorAll(selector)].filter((el) => !el.hidden && !el.closest('[hidden]'));
  container.addEventListener('keydown', (e) => {
    const list = items();
    const at = list.indexOf(e.target.closest?.(selector));
    if (at < 0 || e.target !== list[at]) return;
    const next = orientation === 'vertical' ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
    let to = null;
    if (e.key in next) to = Math.max(0, Math.min(list.length - 1, at + next[e.key]));
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = list.length - 1;
    if (to === null) return;
    e.preventDefault();
    for (const el of list) el.tabIndex = -1;
    list[to].tabIndex = 0;
    list[to].focus();
    onMove?.(list[to]);
  }, { signal });
  const list = items();
  if (list.length && !list.some((el) => el.tabIndex === 0)) list[0].tabIndex = 0;
}

/** Whether a key event happened in a field where text is typed. */
export const inTextField = (target) => !!target?.closest?.('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, [contenteditable="true"], .cm-editor');

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), textarea, summary, iframe, [tabindex], [contenteditable="true"]';

/** What Tab reaches inside a container, in document order: shown, enabled, not taken out of the order (tabindex -1). */
export function focusableIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
}

/**
 * Where Tab goes in a container that keeps the keyboard (the Studio dimmed: a modal window). `count` items reach
 * Tab, in order; `pos` is where the focus is among them (item i: i; between two, or on the container itself: a half
 * step before the next one, -0.5 before the first; outside the container: null). Returns the index of the item to
 * focus (from the last to the first, from the first back to the last, and in again from outside), -1 where the
 * browser's own move stays inside, or -2 when nothing inside takes the focus (the container keeps it).
 * @param {number} count @param {number|null} pos @param {{ shift?: boolean }} [o]
 */
export function trapIndex(count, pos, { shift = false } = {}) {
  if (!count) return -2;
  if (pos === null || pos === undefined || !Number.isFinite(pos)) return shift ? count - 1 : 0;
  if (shift) return Math.ceil(pos) - 1 < 0 ? count - 1 : -1;
  return Math.floor(pos) + 1 > count - 1 ? 0 : -1;
}

/** Read a File as base64 (for a binary upload), in pieces. */
export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), bytes };
}

/** Base64 bytes as an object URL of a type (an image the viewer shows); the caller revokes it. */
export function base64Url(base64, mime) {
  const bin = atob(String(base64 ?? ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** A key for a write the server should do once (Idempotency-Key). */
/** tp() for a view that holds only t(): `key.one` for 1, else `key.other`, with `{count}` filled in. */
export const plural = (t, key, count, params) => t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...params });

export const idempotencyKey = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

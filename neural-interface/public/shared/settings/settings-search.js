// ═══════════════════════════════════════════
// SETTINGS — search
// ═══════════════════════════════════════════
//
// The index and the matcher behind the search field of the Settings sidebar. Pure: no DOM, and the only
// import is the IA, so node builds the whole index and proves it complete (tests/settings-search.test.mjs).
//
//   buildSettingsSearchIndex({ t, en })  every page, section and control of settings-ia.js, in the strings of the
//                                        active locale (`t` is the translate function the kit uses). `en`, a second
//                                        translate function, adds the English names when the locale is not English
//   runtimeSearchEntries(index, rows)    what the shell found in the panel at query time (a project, a provider,
//                                        a labelled row of a pane that draws itself) as entries of the same shape
//   searchSettings(index, query)         ranked entries, each with the ranges of its title and path to emphasise
//
// What is matched, heaviest first: the title (a control's label, a section or page title); the old tab names
// and the curated keywords; the English title, old names and keywords (someone who learned the settings in
// English still finds them); the names of the page and section the entry sits in; the help text.
// How a word of the query matches, best first: a whole word, the start of a word, inside a word, one typo away.
// A short ending is the same word: once four letters are typed, a word that goes on for one or two more counts
// as whole ("theme" is "Themes", "tema" is "Temas"; "port" is not "Portable"). Only the typed letters are marked.
// A word of the query may run across a space in a title, an old name or a keyword ("apikey", "darkmode"), as long
// as it ends on a whole word or on three letters of one: "theme" is not "the memory".
// Every word of the query must match somewhere in the entry (AND).
// Equal scores are settled, in this order: a title that starts with the query; a page before a section before
// a control before a row found in the panel; the order of the IA. None of these can lift a hit over a better one.
//
// An entry's `target` is a deep link: openSettingsModal(entry.target) lands on it (resolveSettingsTarget).

import {
  SETTINGS_GROUPS, SETTINGS_PAGES, SETTINGS_TAB_ALIASES,
  pageKeys, sectionKeys, controlKeys, controlsOfSection, controlsOfPage,
} from './settings-ia.js';

/** The longest list the sidebar shows. */
export const SEARCH_LIMIT = 50;
/** The longest query that is read: the field takes no more, and a longer string given to searchSettings is cut. */
export const SEARCH_QUERY_MAX = 120;

// Old names and keywords share a band; inside it a name the user remembers counts a little more than a keyword.
// The English names of another locale sit in a band of their own, under the keywords of the active locale.
const FIELD_WEIGHT = { title: 1, alias: 0.75, keywords: 0.7, enTitle: 0.6, enAlias: 0.55, enKeywords: 0.5, path: 0.45, help: 0.3 };
const TIER_WEIGHT = { whole: 1, prefix: 0.8, inside: 0.4, typo: 0.2 };
const TITLE_IS_QUERY = 1;      // the query is the whole title: every word of it matched as a whole word already
// A title that starts with the query is preferred among hits of the same score only (`lead`): added to the score it
// would lift the start of a word ("Sombras") over a whole word ("Reproduzir som").
const LEAD = { title: 3, enWhole: 2, enStarts: 1, none: 0 };
const KIND_ORDER = { page: 0, section: 1, control: 2, row: 3 };
const TYPO_MIN = 4;            // one typo is forgiven in a word of four letters or more
const TYPO_FILL = 3;           // near misses are listed only while fewer exact hits than this were found
const JOIN_MIN = 3;            // "apikey" finds "API key": a word of the query may run across a space (short fields only)
const JOIN_TAIL = 3;           // …and must end on a whole word, or on this many letters of one ("darkmod", not "the me")
const ENDING_MIN = 4;          // from four typed letters on, a word with a short ending is the same word
const ENDING_MAX = 2;          // a short ending: one or two letters more ("Themes", "Temas", "Sounds")

// Controls whose label alone would not be found: settings.redesign.search.keywords.control.<id>.
const CONTROL_KEYWORDS = new Set((
  'GEN001 GEN007 GEN010 GEN012 OCP002 CLI001 MEM009 BRW003 BRW006 BRW021 BRW023 AUT042 AUT049 DIS001 YT001 NOT010 NOT012 UI001 UI011 UI014 APP001 SKN001 ICO001 MCP007 ML007'
).split(' '));

// ── Text ───────────────────────────────────────────────────────────────────

const MARK = /\p{M}/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Fold a string for matching: lower case, accents dropped, every run of punctuation and space turned into
 * one space ("API-key" → "api key", "Memória" → "memoria"). `map[i]` is the index in the source of folded
 * character i, so a match can be shown on the original text.
 */
function fold(source) {
  const src = String(source ?? '');
  let text = '';
  const map = [];
  let gap = false;
  for (let i = 0; i < src.length;) {
    const ch = String.fromCodePoint(src.codePointAt(i));
    if (MARK.test(ch)) { i += ch.length; continue; } // a combining accent typed on its own
    let kept = false;
    for (const c of ch.normalize('NFKD').toLowerCase()) {
      if (!WORD_CHAR.test(c)) continue;
      if (gap && text) { text += ' '; map.push(i); }
      gap = false;
      text += c;
      for (let u = 0; u < c.length; u++) map.push(i);
      kept = true;
    }
    if (!kept) gap = true;
    i += ch.length;
  }
  return { text, map };
}

/** Case-, accent- and punctuation-insensitive form of a string. */
export const normalizeSearchText = (source) => fold(source).text;

/** The words of a query, folded, each once. */
export function searchTokens(query) {
  const text = normalizeSearchText(String(query ?? '').slice(0, SEARCH_QUERY_MAX));
  return text ? [...new Set(text.split(' '))] : [];
}

/** A string ready to be matched: its folded text, the source positions, its words and where each starts. */
function field(source) {
  const src = String(source ?? '');
  const { text, map } = fold(src);
  const words = [];
  let at = 0;
  for (const w of text ? text.split(' ') : []) { words.push({ w, at }); at += w.length + 1; }
  return { source: src, text, map, words, joined: null };
}

/** The folded text without its spaces, for a query word that runs across two words. */
function joined(f) {
  if (!f.joined) {
    let text = '';
    const map = [];
    for (let i = 0; i < f.text.length; i++) if (f.text[i] !== ' ') { text += f.text[i]; map.push(i); }
    f.joined = { text, map };
  }
  return f.joined;
}

/** One edit apart or equal: a letter changed, added or dropped, or two neighbours swapped. */
export function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * How `token` matches a field: `{ tier, at, len }` in folded positions, or null.
 * `typo` looks for near misses only (the exact pass found nothing); `join` lets the token run across words
 * from the start of one ("darkmode" in "dark mode"), which a sentence of help text would match by accident.
 * A word that only adds a short ending to the token is the whole word (`len` stays the typed letters).
 */
function matchField(token, f, typo, join = false) {
  if (!f || !f.text) return null;
  if (!typo) {
    let best = null;
    for (const { w, at } of f.words) {
      if (w === token) return { tier: 'whole', at, len: w.length };
      if (best && best.tier === 'whole') continue;
      if (w.startsWith(token)) {
        if (token.length >= ENDING_MIN && w.length - token.length <= ENDING_MAX) best = { tier: 'whole', at, len: token.length };
        else if (!best || best.tier !== 'prefix') best = { tier: 'prefix', at, len: token.length };
        continue;
      }
      if (!best) { const i = w.indexOf(token); if (i > 0) best = { tier: 'inside', at: at + i, len: token.length }; }
    }
    if (best) return best;
    if (join && f.words.length > 1 && token.length >= JOIN_MIN) {
      const run = joined(f);
      for (let i = run.text.indexOf(token); i >= 0; i = run.text.indexOf(token, i + 1)) {
        const from = run.map[i];
        if (from !== 0 && f.text[from - 1] !== ' ') continue; // from the start of a word only
        // …and not ending on a stub of the last word: all of it, or enough letters of it to be meant
        const to = run.map[i + token.length - 1];
        const wholeWord = to + 1 === f.text.length || f.text[to + 1] === ' ';
        if (!wholeWord && to - f.text.lastIndexOf(' ', to) < JOIN_TAIL) continue;
        return { tier: 'inside', at: from, len: to - from + 1 };
      }
    }
    return null;
  }
  if (token.length < TYPO_MIN) return null;
  for (const { w, at } of f.words) if (w.length >= TYPO_MIN && withinOneEdit(token, w)) return { tier: 'typo', at, len: w.length };
  // the start of a longer word, one edit away: "notifcat" finds "Notifications"
  if (token.length > TYPO_MIN) {
    for (const { w, at } of f.words) {
      if (w.length <= token.length) continue;
      for (const n of [token.length, token.length + 1, token.length - 1]) if (n < w.length && withinOneEdit(token, w.slice(0, n))) return { tier: 'typo', at, len: n };
    }
  }
  return null;
}

/** A folded match as a `[start, end)` range of the source string. */
function sourceRange(f, m) {
  const start = f.map[m.at];
  let end = f.map[m.at + m.len - 1];
  end += String.fromCodePoint(f.source.codePointAt(end)).length;
  while (end < f.source.length && MARK.test(f.source[end])) end++; // an accent typed after its letter stays with it
  return [start, end];
}

function mergeRanges(ranges) {
  const out = [];
  for (const [s, e] of ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}

/** `text` cut at `ranges`: `[{ text, hit }]`, in order, for a renderer that emphasises the hits. */
export function highlightParts(text, ranges = []) {
  const src = String(text ?? '');
  const parts = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) parts.push({ text: src.slice(at, s), hit: false });
    parts.push({ text: src.slice(s, e), hit: true });
    at = e;
  }
  if (at < src.length) parts.push({ text: src.slice(at), hit: false });
  return parts;
}

// ── Index ──────────────────────────────────────────────────────────────────

const names = (text) => String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** The pane (old tab) each section of a page came from: a pane starts at the section its old tab lands on. */
function panesOfSections(page) {
  const starts = new Map();
  for (const pane of page.panes) { const alias = SETTINGS_TAB_ALIASES[pane.id]; if (alias && !starts.has(alias.section)) starts.set(alias.section, pane); }
  const out = new Map();
  let pane = page.panes[0] || null;
  for (const section of page.sections) { pane = starts.get(section.id) || pane; out.set(section.id, pane); }
  return out;
}

function makeEntry(order, raw) {
  const entry = {
    id: raw.id, kind: raw.kind, page: raw.page, section: raw.section || null, control: raw.control || null,
    title: String(raw.title ?? '').trim(), path: String(raw.path ?? '').trim(), help: String(raw.help ?? '').trim(),
    keywords: String(raw.keywords ?? '').trim(), aliases: raw.aliases || [],
    english: '', runtime: !!raw.runtime, order, target: raw.target,
  };
  if (raw.ref !== undefined) entry.ref = raw.ref;
  const fields = {
    title: field(entry.title),
    aliases: entry.aliases.map(field),
    keywords: field(entry.keywords),
    path: field(entry.path),
    context: field(raw.context ? `${entry.path} ${raw.context}` : entry.path),
    help: field(entry.help),
    en: null,
  };
  // The English names, when the locale is another one: what the active locale already says is not repeated.
  if (raw.en) {
    const title = field(String(raw.en.title ?? '').trim());
    const local = new Set(fields.aliases.map((a) => a.text));
    const aliases = (raw.en.aliases || []).map(field).filter((a) => a.text && !local.has(a.text));
    const keywords = field(String(raw.en.keywords ?? '').trim());
    const named = title.text && title.text !== fields.title.text;
    if (named) entry.english = title.source;
    if (named || aliases.length || keywords.text) fields.en = { title: named ? title : field(''), aliases, keywords };
  }
  Object.defineProperty(entry, 'fields', { enumerable: false, writable: true, value: fields });
  return entry;
}

/**
 * Every page, section and control of the IA as search entries, in IA order (a page, then each of its sections
 * followed by that section's controls).
 *
 * @param {Object} o
 * @param {(key: string, params?: Object) => string} o.t   the translate function of the active locale
 * @param {(key: string, params?: Object) => string} [o.en]  the English translate function, given when the active
 *        locale is not English: the English title, old names and keywords of every entry are matched too, under
 *        the active locale's own. A key it does not have may come back as the key or as nothing.
 * @param {Array<string|{id: string, label?: string}>} [o.variants]  the variant tabs that are loaded (the 2D map
 *        registers 'graphics'); a section that belongs to a variant is searchable only while it is loaded
 */
export function buildSettingsSearchIndex({ t, en = null, variants = [] } = {}) {
  if (typeof t !== 'function') throw new TypeError('buildSettingsSearchIndex: t(key, params) is required');
  const index = { entries: [], byId: new Map(), pages: new Map(), sections: new Map(), taken: new Set(), english: typeof en === 'function' };
  // English copy of a key: nothing when the bundle lacks it (a translate function answers a missing key with the key).
  const e = index.english ? (key) => { const value = en(key); return typeof value === 'string' && value !== key ? value : ''; } : null;
  const add = (raw) => { const entry = makeEntry(index.entries.length, raw); index.entries.push(entry); index.byId.set(entry.id, entry); return entry; };
  const loaded = new Map(variants.map((v) => (typeof v === 'string' ? [v, { id: v }] : [v.id, v])));
  const groupLabel = new Map(SETTINGS_GROUPS.map((g) => [g.id, t(g.labelKey)]));
  const pathOf = (page, section) => t('settings.redesign.search.path', { page, section });
  index.pathOf = pathOf;
  const control = (id, page, pageTitle, section, sectionTitle, context) => {
    const keys = controlKeys(id);
    const words = CONTROL_KEYWORDS.has(id) ? `settings.redesign.search.keywords.control.${id.toLowerCase()}` : '';
    add({
      id: `control:${id}`, kind: 'control', page: page.id, section: section ? section.id : null, control: id,
      title: t(keys.label), help: t(keys.help), context,
      keywords: words ? t(words) : '',
      en: e && { title: e(keys.label), keywords: words ? e(words) : '' },
      path: section ? pathOf(pageTitle, sectionTitle) : pageTitle,
      target: { tab: page.id, expand: section ? [section.id] : [], highlight: [id], scrollTo: id },
    });
  };

  // The old tab names land on the section their alias names.
  const legacyOf = (say) => {
    const out = new Map();
    for (const [tab, alias] of Object.entries(SETTINGS_TAB_ALIASES)) {
      const list = out.get(alias.section) || [];
      for (const name of names(say(`settings.redesign.search.legacy.${tab}`))) if (!list.includes(name)) list.push(name);
      out.set(alias.section, list);
    }
    return out;
  };
  const legacy = legacyOf(t);
  const legacyEn = e ? legacyOf(e) : null;

  for (const page of SETTINGS_PAGES) {
    const keys = pageKeys(page);
    const pageTitle = t(keys.title);
    const navLabel = t(keys.navLabel);
    index.pages.set(page.id, { title: pageTitle });
    add({
      id: `page:${page.id}`, kind: 'page', page: page.id, title: pageTitle, path: groupLabel.get(page.group) || '',
      help: `${t(keys.purpose)} ${t(keys.navHelp)}`,
      keywords: `${navLabel === pageTitle ? '' : `${navLabel} `}${t(`settings.redesign.search.keywords.page.${page.key}`)}`,
      en: e && { title: e(keys.title), keywords: `${e(keys.navLabel)} ${e(`settings.redesign.search.keywords.page.${page.key}`)}` },
      target: { tab: page.id },
    });
    for (const id of controlsOfPage(page.id)) control(id, page, pageTitle, null, '', '');

    const panes = panesOfSections(page);
    for (const section of page.sections) {
      if (section.variant && !loaded.has(section.variant)) continue;
      const sk = sectionKeys(page, section);
      const title = t(sk.title);
      // The product a section belongs to (WhatsApp, Discord, OpenCode …) is part of where it is.
      const pane = panes.get(section.id);
      const context = pane && pane.titleKey ? t(pane.titleKey) : '';
      index.sections.set(section.id, { title, page: page.id, context });
      add({
        id: `section:${section.id}`, kind: 'section', page: page.id, section: section.id,
        title, path: pageTitle, help: t(sk.purpose), context,
        keywords: t(`settings.redesign.search.keywords.section.${page.key}.${section.key}`),
        aliases: legacy.get(section.id) || [],
        en: e && { title: e(sk.title), keywords: e(`settings.redesign.search.keywords.section.${page.key}.${section.key}`), aliases: legacyEn.get(section.id) || [] },
        target: { tab: page.id, expand: [section.id], highlight: [section.id], scrollTo: section.id },
      });
      for (const id of controlsOfSection(section.id)) control(id, page, pageTitle, section, title, context);
    }

    // A variant tab the IA does not know: one section, named by the variant itself.
    if (page.variantPanes) for (const v of loaded.values()) {
      if (!v.label || page.sections.some((s) => s.variant === v.id)) continue;
      const id = `stg-sec-variant-${v.id}`;
      index.sections.set(id, { title: v.label, page: page.id, context: '' });
      add({ id: `section:${id}`, kind: 'section', page: page.id, section: id, title: v.label, path: pageTitle, target: { tab: page.id, expand: [id], highlight: [id], scrollTo: id } });
    }
  }
  for (const entry of index.entries) index.taken.add(`${entry.page}|${entry.section || ''}|${entry.fields.title.text}`);
  index.size = index.entries.length;
  return index;
}

/**
 * Rows found in the panel at query time, as entries: `{ title, page, section?, help?, ref }`. `ref` is whatever
 * the shell needs to land on the row. A row that repeats an entry of the index (same place, same title) or
 * another row is dropped. Runtime entries rank after index entries of equal quality.
 */
export function runtimeSearchEntries(index, rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const page = index.pages.get(row.page);
    const title = String(row.title ?? '').trim();
    if (!page || !title) continue;
    const section = row.section ? index.sections.get(row.section) : null;
    const entry = makeEntry(index.size + out.length, {
      id: `row:${out.length}`, kind: 'row', page: row.page, section: section ? row.section : null,
      title, help: row.help, runtime: true, ref: row.ref,
      path: section ? index.pathOf(page.title, section.title) : page.title,
      context: section ? section.context : '',
      target: { tab: row.page, expand: section ? [row.section] : [] },
    });
    if (!entry.fields.title.text) continue;
    const key = `${entry.page}|${entry.section || ''}|${entry.fields.title.text}`;
    if (index.taken.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// ── Search ─────────────────────────────────────────────────────────────────

function matchEntry(entry, tokens, queryText) {
  const f = entry.fields;
  let score = 0;
  let typos = 0;
  let alias = null;
  let inEnglish = false; // a word of the query was found best in the English title
  const title = [], path = [], english = [];
  for (const token of tokens) {
    let top = 0;
    let via = '';
    const weigh = (name, m) => { if (m && FIELD_WEIGHT[name] * TIER_WEIGHT[m.tier] > top) { top = FIELD_WEIGHT[name] * TIER_WEIGHT[m.tier]; via = name; } return m; };
    let hit = null; // the alias this token matched
    const scan = (typo) => {
      const inTitle = weigh('title', matchField(token, f.title, typo, true));
      if (inTitle) title.push(sourceRange(f.title, inTitle));
      for (const a of f.aliases) { const before = top; weigh('alias', matchField(token, a, typo, true)); if (top > before) hit = a.source; }
      weigh('keywords', matchField(token, f.keywords, typo, true));
      if (f.en) {
        // An English title is matched word by word: run across its spaces, "theme" would find "Show the memory map".
        const inEn = weigh('enTitle', matchField(token, f.en.title, typo));
        if (inEn) english.push(sourceRange(f.en.title, inEn));
        for (const a of f.en.aliases) { const before = top; weigh('enAlias', matchField(token, a, typo, true)); if (top > before) hit = a.source; }
        weigh('enKeywords', matchField(token, f.en.keywords, typo, true));
      }
      weigh('path', matchField(token, f.context, typo));
      const inPath = matchField(token, f.path, typo);
      if (inPath) path.push(sourceRange(f.path, inPath));
      if (!typo) weigh('help', matchField(token, f.help, false)); // a near miss in a sentence is noise
    };
    scan(false);
    if (!top) { scan(true); if (top) typos++; }
    if (!top) return null;
    if ((via === 'alias' || via === 'enAlias') && !alias) alias = hit;
    if (via === 'enTitle') inEnglish = true;
    score += top;
  }
  score /= tokens.length;
  let lead = LEAD.none;
  if (f.title.text === queryText) { score += TITLE_IS_QUERY; lead = LEAD.title; }
  else if (f.title.text.startsWith(queryText)) lead = LEAD.title;
  else if (inEnglish && f.en.title.text === queryText) lead = LEAD.enWhole;
  else if (inEnglish && f.en.title.text.startsWith(queryText)) lead = LEAD.enStarts;
  return {
    entry, score, lead, typo: typos > 0, alias, english: inEnglish ? entry.english : null,
    ranges: { title: mergeRanges(title), path: mergeRanges(path), english: inEnglish ? mergeRanges(english) : [] },
  };
}

/**
 * Search the index.
 *
 * @param {Object} index            buildSettingsSearchIndex()
 * @param {string} query
 * @param {Object} [o]
 * @param {number} [o.limit]        the most results to return (SEARCH_LIMIT)
 * @param {Object[]} [o.extra]      runtimeSearchEntries() to search with the index
 * @returns {{ query: string, tokens: string[], total: number, results: Array<{ entry: Object, score: number, lead: number, typo: boolean, alias: string|null, english: string|null, ranges: { title: number[][], path: number[][], english: number[][] } }> }}
 *          best first: exact hits before near misses, then by score; equal scores by a title that starts with the
 *          query, then page, section, control, runtime row, then IA order. `alias` is the old name that matched,
 *          `english` the English title when the query was found in it.
 */
export function searchSettings(index, query, { limit = SEARCH_LIMIT, extra = [] } = {}) {
  const tokens = searchTokens(query);
  const out = { query: String(query ?? ''), tokens, total: 0, results: [] };
  if (!tokens.length) return out;
  const queryText = normalizeSearchText(String(query ?? '').slice(0, SEARCH_QUERY_MAX));
  let hits = [];
  for (const list of [index.entries, extra]) for (const entry of list) { const m = matchEntry(entry, tokens, queryText); if (m) hits.push(m); }
  // A near miss is a guess: it is offered only when exact matching found little.
  const exact = hits.filter((h) => !h.typo);
  if (exact.length >= TYPO_FILL) hits = exact;
  hits.sort((a, b) => (a.typo - b.typo) || (b.score - a.score) || (b.lead - a.lead)
    || (KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind]) || (a.entry.order - b.entry.order));
  out.total = hits.length;
  out.results = hits.slice(0, Math.max(0, limit));
  return out;
}

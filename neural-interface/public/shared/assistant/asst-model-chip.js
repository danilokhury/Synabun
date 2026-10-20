// ═══════════════════════════════════════════
// SynaBun Assistant — what the composer's model chip says
// ═══════════════════════════════════════════
// The model as a short human name from its catalog label ("Opus 5.5 (1M
// context)" → "Opus 5.5", "Default (recommended) — Opus 5.5" → "Opus 5.5"),
// a context tag for a "[1m]" / "[extended]" variant ("1M"), and the forms the
// chip falls back to when the composer row has no room, longest first: the tag
// goes first, then the account cue, then the API badge, then the name shortens
// by whole words, to a form that still names this model alone when there is one
// ("Opus 5.5" → "Opus", "GPT-6-Luna" → "Luna"). Never a cut word.
// asst-brain-picker.js draws the first form that fits. DOM-free: node --test loads it.

const VARIANT = /\[(1m|extended)\]$/i;
const VERSION = /^v?\d+(?:\.\d+)*[a-z]?$/i;

function str(v) {
  return v == null ? '' : String(v).trim();
}

/** The id without its provider ("anthropic/…"), legacy ":<window>" and variant suffix. */
function bareId(id) {
  const tail = str(id).split('/').pop() || '';
  return tail.replace(/:\d+$/, '').replace(VARIANT, '');
}

/**
 * The model's short name: { name, raw }. The label's own words without what the
 * chip says otherwise (parentheses: the context, "recommended"); after a dash, the
 * model it runs as. No label (or the id itself): the bare id, `raw` (shown mono).
 */
export function modelChipName(label, id) {
  let text = str(label);
  if (text && text !== str(id)) {
    const runsAs = text.split(/\s+[—–]\s+/).pop();
    text = str(runsAs.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' '));
    if (text) return { name: text, raw: false };
  }
  const name = bareId(id) || str(id);
  return { name, raw: true };
}

/** "1M", "400K": a context window in tokens, never rounded up. */
function compactTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e6) return `${Math.floor(v / 1e5) / 10}M`;
  if (v >= 1e3) return `${Math.floor(v / 1e3)}K`;
  return String(v);
}

/**
 * What tells a context variant from its model ("opus[1m]" → "1M"): its window when
 * the catalog knows it, else "1M" for "[1m]", else the label's own word ("extended").
 * '' for a model that is not a variant.
 */
export function modelChipTag(id, { contextWindow = null, label = '' } = {}) {
  const m = str(id).match(VARIANT);
  if (!m) return '';
  const tokens = compactTokens(contextWindow);
  if (tokens) return tokens;
  if (m[1].toLowerCase() === '1m') return '1M';
  const note = str(label).match(/\(([^)]*)\)\s*$/);
  return note ? str(note[1].replace(/\bcontext\b/i, '')) : '';
}

// "GPT-6.1-Sol" → ['GPT', '6.1', 'Sol'] with the separators kept: whole words in, whole words out.
function parts(name) {
  return str(name).match(/[^\s-]+|[\s-]+/g) || [];
}
const isSep = (p) => /^[\s-]+$/.test(p);
const wordsOf = (name) => parts(name).filter(p => !isSep(p)).map(w => w.toLowerCase());

/** Whether `words` run in that order, whole, somewhere in `other` ("opus" in "Opus 5.5"). */
function within(words, other) {
  for (let i = 0; i + words.length <= other.length; i += 1) {
    if (words.every((w, j) => other[i + j] === w)) return true;
  }
  return false;
}

/**
 * The name's shorter forms, whole words only, longest first: `unique` still names this
 * model alone among `names` (the short names of every model the provider lists: "Opus"
 * for "Opus 5.5", "GPT-6.1" for "GPT-6.1-Sol", "Luna" for "GPT-6-Luna" when every
 * "GPT-6" is another model too), `other` drops trailing words whatever they lose
 * ("Sonnet" for "Sonnet 5.5" beside "Sonnet 5"; "GPT-6"). A form never starts with a
 * version ("5.5"), and a suffix is tried only when no shorter prefix is unique.
 */
export function modelChipShortNames(name, names = []) {
  const all = parts(name);
  const own = wordsOf(name);
  const others = [...new Set((Array.isArray(names) ? names : []).map(str).filter(n => n && n.toLowerCase() !== str(name).toLowerCase()))].map(wordsOf);
  const unique = (form) => { const w = wordsOf(form); return !others.some(o => within(w, o)); };
  const prefixes = [];
  const suffixes = [];
  for (let n = own.length - 1; n >= 1; n -= 1) {
    let seen = 0;
    const cut = all.findIndex(p => !isSep(p) && ++seen > n);
    prefixes.push(all.slice(0, cut).join('').replace(/[\s-]+$/, ''));
    let skip = own.length - n;
    const from = all.findIndex(p => !isSep(p) && skip-- === 0);
    if (!VERSION.test(all[from])) suffixes.push(all.slice(from).join(''));
  }
  const lossless = prefixes.filter(unique);
  const picked = lossless.length ? lossless : suffixes.filter(unique);
  return { unique: picked, other: prefixes.filter(p => !picked.includes(p)) };
}

/**
 * The chip's forms, longest first: [{ name, tag, cue, api }] (tag / cue / api: shown
 * or not). `tag`, `cue` and `api` say whether the chip has one at all; `names` are the
 * provider's models (modelChipShortNames). What goes, in order: the tag, the account
 * cue, the API badge, then the name. A shorter name that still names this model alone
 * loses nothing, so it is tried before the cue and before the badge go; one that
 * loses something only after.
 */
export function modelChipForms({ name, names = [], tag = false, cue = false, api = false } = {}) {
  const full = str(name);
  const out = [];
  const seen = new Set();
  const add = (n, t, c, a) => {
    const form = { name: n, tag: !!(t && tag), cue: !!(c && cue), api: !!(a && api) };
    const key = JSON.stringify(form);
    if (!seen.has(key)) { seen.add(key); out.push(form); }
  };
  const short = full ? modelChipShortNames(full, names) : { unique: [], other: [] };
  add(full, true, true, true);
  add(full, false, true, true);
  for (const u of short.unique) add(u, false, true, true);
  add(full, false, false, true);
  for (const u of short.unique) add(u, false, false, true);
  add(full, false, false, false);
  for (const n of [...short.unique, ...short.other]) add(n, false, false, false);
  return out;
}

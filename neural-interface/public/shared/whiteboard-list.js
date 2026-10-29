// ═══════════════════════════════════════════
// WHITEBOARD-LIST — nesting levels of a list card (DOM-free)
// ═══════════════════════════════════════════
//
// A list element keeps its bullets as `items: string[]`, as every board always has, and, only while some bullet
// is nested, `levels: number[]` beside them: levels[i] is how deep items[i] sits, 0 = top level. A list without
// `levels` (every board saved before nesting existed) reads as all level 0, and a reader that does not know
// `levels` still shows every bullet, flat. Callers may also hand items over as { text, level } objects; they are
// stored as the two arrays. Every writer keeps three rules: the first item is level 0, an item sits at most one
// level deeper than the item above it, and no item is deeper than WB_LIST_MAX_LEVEL.
//
// No imports: ui-whiteboard.js (the board), server.js (whiteboard_add / whiteboard_update) and node --test load it.
// mcp-server/src/services/whiteboard-geometry.ts reads the same format for the MCP tools.

export const WB_LIST_MAX_LEVEL = 4;

/** Level of one value: a whole number from 0 to WB_LIST_MAX_LEVEL (anything else is 0, more is the maximum). */
function levelOf(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, WB_LIST_MAX_LEVEL) : 0;
}

/** Text of one stored entry: a string, or the { text, level } form. */
export function listItemText(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') return item.text == null ? '' : String(item.text);
  return item == null ? '' : String(item);
}

/** `count` levels that keep the rules, read from `levels` (missing entries are 0). */
export function fitListLevels(levels, count) {
  const out = [];
  let above = -1;
  for (let i = 0; i < count; i++) {
    const level = Math.min(levelOf(Array.isArray(levels) ? levels[i] : 0), above + 1);
    out.push(level);
    above = level;
  }
  return out;
}

/**
 * A list's items in either form → { items: string[], levels: number[] } (levels always as long as items, keeping
 * the rules). A plain string is level `levels[i]` (0 when there is no such entry); a { text, level } object's own
 * level wins over `levels[i]`.
 */
export function readListItems(items, levels) {
  const list = Array.isArray(items) ? items : [];
  const texts = list.map(listItemText);
  const wanted = list.map((item, i) => (item && typeof item === 'object' && item.level !== undefined
    ? item.level
    : (Array.isArray(levels) ? levels[i] : 0)));
  return { items: texts, levels: fitListLevels(wanted, texts.length) };
}

/** True when some level is above 0 (only then is `levels` stored). */
export function hasNestedLevels(levels) {
  return Array.isArray(levels) && levels.some(level => level > 0);
}

/**
 * Store items + levels on a list element: `items` always, `levels` only while something is nested (removed
 * otherwise, so a flat list is stored exactly as before). Always new arrays, never an edit in place: copies of
 * an element (undo entries, the clipboard, a duplicate) share the arrays of the original.
 */
export function writeListItems(el, items, levels) {
  const read = readListItems(items, levels);
  el.items = read.items;
  if (hasNestedLevels(read.levels)) el.levels = read.levels;
  else delete el.levels;
  return el;
}

/**
 * The `items` / `levels` fields of an update to a list, made to keep the rules. Items sent without levels are
 * read in their own form (a plain string is level 0, an object carries its level): replacing the items of a
 * nested list with plain strings flattens it. Levels sent alone apply to the items the list already has.
 * `levels` comes back as null when nothing is nested (the update then removes it).
 */
export function normalizeListUpdate(currentItems, patch) {
  if (!patch || typeof patch !== 'object') return patch;
  const hasItems = Object.hasOwn(patch, 'items');
  const hasLevels = Object.hasOwn(patch, 'levels');
  if (!hasItems && !hasLevels) return patch;
  const read = hasItems ? readListItems(patch.items, patch.levels) : readListItems(currentItems, patch.levels);
  const out = { ...patch, levels: hasNestedLevels(read.levels) ? read.levels : null };
  if (hasItems) out.items = read.items;
  return out;
}

/** End (exclusive) of the item at `index` and its sub-items: the items right after it that sit deeper. */
export function listSubtreeEnd(levels, index) {
  let end = index + 1;
  while (end < levels.length && levels[end] > levels[index]) end++;
  return end;
}

/** Whether the item at `index` can go one level deeper: never the first, never more than one level deeper than
 *  the item above it, and neither it nor a sub-item of it past the maximum. */
export function canIndentListItem(levels, index) {
  if (!Array.isArray(levels) || index <= 0 || index >= levels.length) return false;
  if (levels[index] > levels[index - 1]) return false;
  const deepest = Math.max(...levels.slice(index, listSubtreeEnd(levels, index)));
  return deepest < WB_LIST_MAX_LEVEL;
}

/** Levels with the item at `index` one level deeper, its sub-items with it (they stay its sub-items), or null
 *  when it cannot go deeper. */
export function indentListItem(levels, index) {
  if (!canIndentListItem(levels, index)) return null;
  const next = levels.slice();
  for (let i = index, end = listSubtreeEnd(levels, index); i < end; i++) next[i] += 1;
  return fitListLevels(next, next.length);
}

/** Levels with the item at `index` one level shallower, its sub-items with it, or null when it is at the top
 *  level. The items after them keep their level (one that was its sibling becomes its sub-item, as in a flat
 *  outline nothing is reordered). */
export function outdentListItem(levels, index) {
  if (!Array.isArray(levels) || index < 0 || index >= levels.length || levels[index] <= 0) return null;
  const next = levels.slice();
  for (let i = index, end = listSubtreeEnd(levels, index); i < end; i++) next[i] -= 1;
  return fitListLevels(next, next.length);
}

// Bullet and number styles per level, in the order browsers nest them: the level-0 style is what a flat list
// always showed (a disc, a decimal number); deeper levels cycle.
export const UNORDERED_STYLES = ['disc', 'circle', 'square'];
export const ORDERED_STYLES = ['decimal', 'lower-alpha', 'lower-roman'];
const BULLET_GLYPHS = { disc: '•', circle: '◦', square: '▪' };

/** The list-style name of a level (the CSS in styles.css uses the same cycle). */
export function listStyleForLevel(level, ordered) {
  const styles = ordered ? ORDERED_STYLES : UNORDERED_STYLES;
  return styles[levelOf(level) % styles.length];
}

function toRoman(n) {
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [value, digits] of table) while (n >= value) { out += digits; n -= value; }
  return out;
}

function toAlpha(n) {
  let out = '';
  while (n > 0) { n -= 1; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

/** A counter value in one of the ordered styles: 1 → "1", "a", "i". */
export function formatListCounter(n, style) {
  if (style === 'lower-alpha') return toAlpha(n);
  if (style === 'lower-roman') return toRoman(n);
  return String(n);
}

/**
 * The marker drawn before each item: a bullet glyph per level, or the item's number in its level's style followed
 * by "." (numbering restarts under every item above, as nested ordered lists do).
 */
export function listMarkers(levels, ordered) {
  const counters = [];
  return (Array.isArray(levels) ? levels : []).map((raw) => {
    const level = levelOf(raw);
    const style = listStyleForLevel(level, ordered);
    if (!ordered) return BULLET_GLYPHS[style];
    counters.length = level + 1;
    counters[level] = (counters[level] || 0) + 1;
    return `${formatListCounter(counters[level], style)}.`;
  });
}

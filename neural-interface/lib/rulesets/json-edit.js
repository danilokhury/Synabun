// ═══════════════════════════════════════════
// SynaBun — one entry of a JSON list, edited as text (pure, no fs)
// ═══════════════════════════════════════════
//
// OpenCode's config.json belongs to the user. Parsing it and writing it back
// would re-indent it, re-space it and drop whatever JSON.stringify spells
// differently, all to add one string to one list. These two functions change
// only the characters of that entry (and of the key, when SynaBun adds or takes
// away the whole list): every other byte, the BOM, the line endings and the
// final newline stay as they were.
//
// Input must be strict JSON holding an object (the caller parsed it already).
// Both throw on text they cannot follow, and on a key that is there more than
// once (code DUPLICATE_KEY): JSON.parse keeps the last one, so an edit of
// either would lose or strand an entry. The caller then refuses to write;
// nothing here, and nothing in the installer, re-serialises the file.

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

function skipSpace(text, pos) {
  while (pos < text.length && WHITESPACE.has(text[pos])) pos++;
  return pos;
}

function skipString(text, pos) {
  for (let i = pos + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return i + 1;
  }
  throw new Error('JSON string without an end');
}

/** The offset just past the value that starts at `pos`. */
function skipValue(text, pos) {
  const first = text[pos];
  if (first === '"') return skipString(text, pos);
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let i = pos; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') { i = skipString(text, i) - 1; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
    }
    throw new Error('JSON value without an end');
  }
  let end = pos;
  while (end < text.length && !WHITESPACE.has(text[end]) && text[end] !== ',' && text[end] !== '}' && text[end] !== ']') end++;
  if (end === pos) throw new Error('JSON value expected');
  return end;
}

/** {open, close, members:[{key, keyStart, valueStart, valueEnd}]} for the object whose `{` is at `open`. */
function scanObject(text, open) {
  if (text[open] !== '{') throw new Error('JSON object expected');
  const members = [];
  let pos = skipSpace(text, open + 1);
  if (text[pos] === '}') return { open, close: pos, members };
  for (;;) {
    if (text[pos] !== '"') throw new Error('JSON key expected');
    const keyStart = pos;
    const keyEnd = skipString(text, pos);
    pos = skipSpace(text, keyEnd);
    if (text[pos] !== ':') throw new Error('JSON colon expected');
    const valueStart = skipSpace(text, pos + 1);
    const valueEnd = skipValue(text, valueStart);
    members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)), keyStart, valueStart, valueEnd });
    pos = skipSpace(text, valueEnd);
    if (text[pos] === ',') { pos = skipSpace(text, pos + 1); continue; }
    if (text[pos] === '}') return { open, close: pos, members };
    throw new Error('JSON object without an end');
  }
}

/** {open, close, items:[{start, end}]} for the list whose `[` is at `open`. */
function scanList(text, open) {
  if (text[open] !== '[') throw new Error('JSON list expected');
  const items = [];
  let pos = skipSpace(text, open + 1);
  if (text[pos] === ']') return { open, close: pos, items };
  for (;;) {
    const end = skipValue(text, pos);
    items.push({ start: pos, end });
    pos = skipSpace(text, end);
    if (text[pos] === ',') { pos = skipSpace(text, pos + 1); continue; }
    if (text[pos] === ']') return { open, close: pos, items };
    throw new Error('JSON list without an end');
  }
}

function rootObject(text) {
  return scanObject(text, skipSpace(text, text.startsWith('﻿') ? 1 : 0));
}

/** The whitespace `pos` is indented by, or null when something else comes before it on its line. */
function lineIndent(text, pos) {
  let start = pos;
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  return start === 0 || text[start - 1] === '\n' ? text.slice(start, pos) : null;
}

function styleOf(text, root) {
  const first = root.members.length ? lineIndent(text, root.members[0].keyStart) : null;
  return { eol: text.includes('\r\n') ? '\r\n' : '\n', unit: first || '  ' };
}

/** The index of the one member named `key`, or -1. Throws DUPLICATE_KEY when there are several. */
function findMember(root, key) {
  let at = -1;
  root.members.forEach((member, index) => {
    if (member.key !== key) return;
    if (at !== -1) {
      const error = new Error(`"${key}" is there more than once`);
      error.code = 'DUPLICATE_KEY';
      throw error;
    }
    at = index;
  });
  return at;
}

/** How many times `key` appears at the top level of the object in `text`. */
export function countJsonKey(text, key) {
  return rootObject(text).members.filter((member) => member.key === key).length;
}

/** Append the string `value` to the top-level list `key`, creating the list (as the last key) when there is none. */
export function addToJsonList(text, key, value) {
  const root = rootObject(text);
  const { eol, unit } = styleOf(text, root);
  const quoted = JSON.stringify(value);
  const at = findMember(root, key);

  if (at !== -1) {
    const member = root.members[at];
    const list = scanList(text, member.valueStart);
    if (list.items.length) {
      const last = list.items[list.items.length - 1];
      const indent = lineIndent(text, last.start);
      return text.slice(0, last.end) + (indent === null ? `, ${quoted}` : `,${eol}${indent}${quoted}`) + text.slice(last.end);
    }
    const outer = lineIndent(text, member.keyStart);
    const filled = outer === null ? `[${quoted}]` : `[${eol}${outer}${unit}${quoted}${eol}${outer}]`;
    return text.slice(0, list.open) + filled + text.slice(list.close + 1);
  }

  const name = JSON.stringify(key);
  if (root.members.length) {
    const last = root.members[root.members.length - 1];
    const indent = lineIndent(text, last.keyStart);
    const added = indent === null
      ? `, ${name}: [${quoted}]`
      : `,${eol}${indent}${name}: [${eol}${indent}${unit}${quoted}${eol}${indent}]`;
    return text.slice(0, last.valueEnd) + added + text.slice(last.valueEnd);
  }
  return `${text.slice(0, root.open)}{${eol}${unit}${name}: [${eol}${unit}${unit}${quoted}${eol}${unit}]${eol}}${text.slice(root.close + 1)}`;
}

/**
 * Take one occurrence of the string `value` (the last) out of the top-level
 * list `key`. With `dropEmptyKey`, a list left empty goes too, key and all.
 * Unchanged when the list or the string is not there.
 */
export function removeFromJsonList(text, key, value, { dropEmptyKey = false } = {}) {
  const root = rootObject(text);
  const at = findMember(root, key);
  if (at === -1) return text;
  const member = root.members[at];
  if (text[member.valueStart] !== '[') return text;
  const list = scanList(text, member.valueStart);
  let found = -1;
  list.items.forEach((item, index) => {
    if (text[item.start] === '"' && JSON.parse(text.slice(item.start, item.end)) === value) found = index;
  });
  if (found === -1) return text;

  if (list.items.length > 1) {
    // With its comma: the one before it, or for the first item the one after.
    if (found > 0) return text.slice(0, list.items[found - 1].end) + text.slice(list.items[found].end);
    return text.slice(0, list.items[0].start) + text.slice(list.items[1].start);
  }
  if (!dropEmptyKey) return `${text.slice(0, list.open)}[]${text.slice(list.close + 1)}`;
  if (root.members.length === 1) return `${text.slice(0, root.open)}{}${text.slice(root.close + 1)}`;
  if (at > 0) return text.slice(0, root.members[at - 1].valueEnd) + text.slice(member.valueEnd);
  return text.slice(0, member.keyStart) + text.slice(root.members[1].keyStart);
}

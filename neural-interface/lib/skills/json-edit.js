// ── One value of a JSON file, changed in place ──
// The owner's "Enable for …" (lib/skills/runtime-checks.js enable) changes one value of a runtime's settings file
// (opencode.json, Claude Code's settings.json) and nothing else: no reformatting, no reordering, every other byte
// as it was. A small scanner finds where the value at a path sits in the text (and the members of an object, the
// elements of an array, with their separators); an edit splices the text there. Comments are not JSON: a .jsonc is
// refused by the caller before this is asked.

/** The nodes of a JSON text with their offsets: `{ type, start, end, value?, members?, elements? }`. */
export function parseJsonWithOffsets(text) {
  const s = String(text);
  let i = 0;
  const fail = (what) => { throw new SyntaxError(`${what} at ${i}`); };
  const ws = () => { while (i < s.length && /[ \t\r\n]/.test(s[i])) i++; };
  const string = () => {
    const start = i;
    if (s[i] !== '"') fail('string expected');
    i++;
    while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
    if (s[i] !== '"') fail('unterminated string');
    i++;
    return { type: 'string', start, end: i, value: JSON.parse(s.slice(start, i)) };
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      const start = i; i++;
      const members = [];
      ws();
      if (s[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
      for (;;) {
        ws();
        const key = string();
        ws();
        if (s[i] !== ':') fail(': expected');
        i++;
        const v = value();
        members.push({ key: key.value, keyStart: key.start, valueStart: v.start, valueEnd: v.end, node: v });
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
        fail(', or } expected');
      }
    }
    if (c === '[') {
      const start = i; i++;
      const elements = [];
      ws();
      if (s[i] === ']') { i++; return { type: 'array', start, end: i, elements }; }
      for (;;) {
        const v = value();
        elements.push(v);
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return { type: 'array', start, end: i, elements }; }
        fail(', or ] expected');
      }
    }
    if (c === '"') return string();
    const start = i;
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
    if (!m) fail('value expected');
    i += m[0].length;
    return { type: 'scalar', start, end: i, value: JSON.parse(m[0]) };
  };
  const root = value();
  ws();
  if (i !== s.length) fail('trailing text');
  return root;
}

/** The node at a path of keys (and array indexes), or null. */
export function nodeAt(root, path) {
  let node = root;
  for (const key of path) {
    if (!node) return null;
    if (node.type === 'object') { const m = node.members.find((x) => x.key === key); node = m ? m.node : null; }
    else if (node.type === 'array' && Number.isInteger(key)) node = node.elements[key] || null;
    else return null;
  }
  return node || null;
}

/** The text with the value of one existing member replaced by `json` (the JSON text of the new value). */
export function replaceValue(text, node, json) {
  return `${text.slice(0, node.start)}${json}${text.slice(node.end)}`;
}

/**
 * The text with a member added as the last of an object (the indentation of its last member, or of the object's
 * closing brace plus two spaces when it is empty); the key must not be there already.
 */
export function appendMember(text, objectNode, key, json) {
  const s = String(text);
  if (objectNode.type !== 'object') throw new TypeError('not an object');
  if (objectNode.members.some((m) => m.key === key)) throw new Error(`"${key}" is there already`);
  const closing = objectNode.end - 1;
  const last = objectNode.members[objectNode.members.length - 1] || null;
  if (!last) {
    const lineStart = s.lastIndexOf('\n', closing) + 1;
    const inner = lineStart > objectNode.start ? /^[ \t]*/.exec(s.slice(lineStart, closing))[0] : '';
    const multiline = s.slice(objectNode.start + 1, closing).includes('\n');
    const pad = multiline ? `\n${inner}  ` : ' ';
    const tail = multiline ? `\n${inner}` : ' ';
    return `${s.slice(0, objectNode.start + 1)}${pad}${JSON.stringify(key)}: ${json}${tail}${s.slice(closing)}`;
  }
  const lineStart = s.lastIndexOf('\n', last.keyStart) + 1;
  const sameLine = lineStart <= objectNode.start;
  const indent = sameLine ? ' ' : `\n${/^[ \t]*/.exec(s.slice(lineStart, last.keyStart))[0]}`;
  return `${s.slice(0, last.valueEnd)},${indent}${JSON.stringify(key)}: ${json}${s.slice(last.valueEnd)}`;
}

/** The text without one member of an object (with the separator and the line it stood on). */
export function removeMember(text, objectNode, key) {
  const s = String(text);
  const at = objectNode.members.findIndex((m) => m.key === key);
  if (at < 0) return s;
  const m = objectNode.members[at];
  const prev = objectNode.members[at - 1] || null;
  const next = objectNode.members[at + 1] || null;
  let start;
  let end;
  if (prev) { start = prev.valueEnd; end = m.valueEnd; }            // ", <key>: <value>" after the one before
  else if (next) { start = m.keyStart; end = next.keyStart; }        // "<key>: <value>, " before the one after
  else { start = objectNode.start + 1; end = objectNode.end - 1; }   // the only one: the object is left empty
  return `${s.slice(0, start)}${s.slice(end)}`;
}

/** The text without one element of an array (by index). */
export function removeElement(text, arrayNode, index) {
  const s = String(text);
  const e = arrayNode.elements[index];
  if (!e) return s;
  const prev = arrayNode.elements[index - 1] || null;
  const next = arrayNode.elements[index + 1] || null;
  let start;
  let end;
  if (prev) { start = prev.end; end = e.end; }
  else if (next) { start = e.start; end = next.start; }
  else { start = arrayNode.start + 1; end = arrayNode.end - 1; }
  return `${s.slice(0, start)}${s.slice(end)}`;
}

/**
 * The text with an element added as the last of an array (on a line of its own, at the indentation of the last
 * element, when the array spans lines; else after a space).
 */
export function appendElement(text, arrayNode, json) {
  const s = String(text);
  if (arrayNode.type !== 'array') throw new TypeError('not an array');
  const closing = arrayNode.end - 1;
  const last = arrayNode.elements[arrayNode.elements.length - 1] || null;
  if (!last) {
    const lineStart = s.lastIndexOf('\n', closing) + 1;
    const inner = lineStart > arrayNode.start ? /^[ \t]*/.exec(s.slice(lineStart, closing))[0] : '';
    const multiline = s.slice(arrayNode.start + 1, closing).includes('\n');
    return multiline
      ? `${s.slice(0, arrayNode.start + 1)}\n${inner}  ${json}\n${inner}${s.slice(closing)}`
      : `${s.slice(0, arrayNode.start + 1)}${json}${s.slice(closing)}`;
  }
  const lineStart = s.lastIndexOf('\n', last.start) + 1;
  const sameLine = lineStart <= arrayNode.start;
  const indent = sameLine ? ' ' : `\n${/^[ \t]*/.exec(s.slice(lineStart, last.start))[0]}`;
  return `${s.slice(0, last.end)},${indent}${json}${s.slice(last.end)}`;
}

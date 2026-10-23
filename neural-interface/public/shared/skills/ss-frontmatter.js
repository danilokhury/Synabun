// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio: the frontmatter of a skill, a command or an agent
// ═══════════════════════════════════════════
//
// A skill's metadata is YAML between two `---` lines at the top of its file. It is read here with a real YAML
// parser (the `yaml` package), and changed one key at a time: an edit replaces the text of that one key and
// nothing else, so every key the edit does not touch keeps its bytes (order, quoting, folding, comments, keys
// no form knows). A change is checked by reading the result again before it is handed back: the key holds the
// new value, every other key what it held, or the change is refused and the text stays as it was.
//
// What is not plain YAML is said, never guessed: a syntax error, a key given twice, a root that is not a
// mapping, an alias, a tag the parser does not resolve. While the YAML has errors nothing is patched: the
// form waits, the raw text is still editable and saveable.
//
// No imports: the YAML library is handed in (the server gives it the `yaml` package, the page the copy in
// /vendor/yaml/), so `node --test` loads this module as it is.

/** A frontmatter longer than this is not parsed (a bound on what one request makes the parser do). */
export const FRONTMATTER_MAX_CHARS = 128 * 1024;
/** Aliases a document may expand while it is read (the `yaml` package's guard against alias bombs). */
export const MAX_ALIAS_COUNT = 100;

export const PARSE_OPTIONS = Object.freeze({
  uniqueKeys: true,          // a key given twice is an error, not "the last one wins"
  strict: true,
  prettyErrors: true,        // line and column on every error
  resolveKnownTags: false,   // !!binary, !!set, !!omap… stay unresolved (a warning), never other types
  merge: false,              // `<<` is a key like any other
  keepSourceTokens: false,
});

const BREAK = /\r\n|\n|\r/g;

/** The line ending at `index`: its length (0 at the end of the text). */
function breakAt(text, index) {
  if (text.charCodeAt(index) === 13) return text.charCodeAt(index + 1) === 10 ? 2 : 1;
  if (text.charCodeAt(index) === 10) return 1;
  return 0;
}

/** The index of the next line break at or after `from` (the text's length when there is none). */
function nextBreak(text, from) {
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) return i;
  }
  return text.length;
}

/** 1-based line number of an index in a text. */
export function lineOfIndex(text, index) {
  let line = 1;
  const s = String(text ?? '');
  BREAK.lastIndex = 0;
  let m;
  while ((m = BREAK.exec(s)) && m.index < index) line++;
  return line;
}

/**
 * Where the frontmatter is. It opens with a first line `---` (after a byte-order mark, if any) and closes at the
 * next line that is `---`; trailing blanks on either line are allowed.
 * @returns {{ bom: boolean, hasFrontmatter: boolean, unterminated: boolean, yamlStart: number, yamlEnd: number,
 *   bodyStart: number, yaml: string, body: string, startLine: number }} `yaml` is the text between the two lines
 *   (with the line ending of its last line), `startLine` the line it starts on (1-based), `bodyStart` where the
 *   text after the closing line starts.
 */
export function splitFrontmatter(text) {
  const s = String(text ?? '');
  const bom = s.charCodeAt(0) === 0xFEFF;
  const at = bom ? 1 : 0;
  const none = (unterminated = false) => ({
    bom, hasFrontmatter: false, unterminated, yamlStart: at, yamlEnd: at, bodyStart: at, yaml: '', body: s.slice(at), startLine: 1,
  });
  const firstEnd = nextBreak(s, at);
  if (!/^---[ \t]*$/.test(s.slice(at, firstEnd)) || firstEnd >= s.length) return none(false);
  const yamlStart = firstEnd + breakAt(s, firstEnd);
  let line = yamlStart;
  while (line <= s.length) {
    const end = nextBreak(s, line);
    if (/^---[ \t]*$/.test(s.slice(line, end))) {
      const bodyStart = end + breakAt(s, end);
      return {
        bom, hasFrontmatter: true, unterminated: false, yamlStart, yamlEnd: line, bodyStart,
        yaml: s.slice(yamlStart, line), body: s.slice(bodyStart), startLine: 2,
      };
    }
    if (end >= s.length) break;
    line = end + breakAt(s, end);
  }
  return none(true);
}

/** What kind of value a frontmatter key holds, for a form that shows only what it can write back. */
export function valueKind(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'other';
  if (Array.isArray(value)) return value.every((v) => typeof v === 'string') ? 'string-list' : 'list';
  return 'other';
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
}

/** A copy of `data` whose keys are own data properties of objects without a prototype chain to reach. */
function plainCopy(value, depth = 0) {
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map((v) => plainCopy(v, depth + 1));
  if (value && typeof value === 'object') {
    if (typeof value.length === 'number' && typeof value.BYTES_PER_ELEMENT === 'number') return null;   // typed arrays: not a skill value
    const out = Object.create(null);
    for (const key of Object.keys(value)) out[key] = plainCopy(value[key], depth + 1);
    return out;
  }
  return value;
}

/**
 * The frontmatter tools over one YAML library.
 * @param {object} YAML the `yaml` package (parseDocument, Document, isMap, isScalar, isSeq, isCollection, isAlias, visit)
 */
export function createFrontmatter(YAML) {
  const diag = (ruleId, severity, message, line = null, column = null) => ({ ruleId, severity, message, line, column });

  function fromYamlError(err, severity, startLine) {
    const pos = Array.isArray(err?.linePos) ? err.linePos[0] : null;
    const first = String(err?.message || 'YAML error').split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    const code = String(err?.code || '').toLowerCase().replace(/_/g, '-');
    const ruleId = code === 'duplicate-key' ? 'yaml-duplicate-key' : (code === 'tag-resolve-failed' ? 'yaml-tag' : 'yaml-syntax');
    return diag(ruleId, severity, first, pos ? pos.line + startLine - 1 : startLine, pos ? pos.col : null);
  }

  function parseYaml(yaml) {
    return YAML.parseDocument(yaml, PARSE_OPTIONS);
  }

  const keyName = (pair) => (YAML.isScalar(pair?.key) && typeof pair.key.value === 'string' ? pair.key.value : null);

  /**
   * Read a document's frontmatter.
   * @param {string} text the whole file (a byte-order mark and any line ending are fine)
   * @returns {{ hasFrontmatter: boolean, data: object | null, diagnostics: object[], keys: object[],
   *   editable: boolean, body: string, bodyLine: number, split: object }} `data` is null when the YAML cannot
   *   be read as a mapping; `editable` says whether patch() may change it; `keys` lists the top-level keys in
   *   order: `{ key, line, kind, style, flow }`.
   */
  function parse(text) {
    const s = String(text ?? '');
    const split = splitFrontmatter(s);
    const result = {
      hasFrontmatter: split.hasFrontmatter, data: null, diagnostics: [], keys: [], editable: false,
      body: split.hasFrontmatter ? split.body : s.slice(split.bom ? 1 : 0),
      bodyLine: split.hasFrontmatter ? lineOfIndex(s, split.bodyStart) : 1,
      split,
    };
    if (!split.hasFrontmatter) {
      if (split.unterminated) result.diagnostics.push(diag('yaml-unterminated', 'error', 'The frontmatter opens with --- but no line closes it with ---.', 1));
      result.data = Object.create(null);
      result.editable = !split.unterminated;
      return result;
    }
    if (split.yaml.length > FRONTMATTER_MAX_CHARS) {
      result.diagnostics.push(diag('yaml-too-large', 'error', `The frontmatter is longer than ${Math.round(FRONTMATTER_MAX_CHARS / 1024)} KB and was not read.`, split.startLine));
      return result;
    }
    let doc;
    try { doc = parseYaml(split.yaml); } catch (err) {
      result.diagnostics.push(diag('yaml-syntax', 'error', String(err?.message || 'The frontmatter could not be read.').split('\n')[0], split.startLine));
      return result;
    }
    for (const err of doc.errors) result.diagnostics.push(fromYamlError(err, 'error', split.startLine));
    for (const warn of doc.warnings) result.diagnostics.push(fromYamlError(warn, 'warning', split.startLine));
    const root = doc.contents;
    if (root === null || root === undefined) {
      result.data = Object.create(null);
      result.editable = doc.errors.length === 0;
      return result;
    }
    if (!YAML.isMap(root)) {
      result.diagnostics.push(diag('yaml-not-mapping', 'error', 'The frontmatter must be key: value lines (a YAML mapping).', split.startLine));
      return result;
    }
    // YAML with errors is not read as data at all: what a parser makes of it is a guess, and no value of it is
    // shown or checked as if it were what the file says.
    if (doc.errors.length) return result;
    let aliases = 0;
    YAML.visit(doc, { Alias() { aliases++; } });
    if (aliases) result.diagnostics.push(diag('yaml-alias', 'warning', `The frontmatter uses ${aliases === 1 ? 'an alias' : `${aliases} aliases`} (*name); the form leaves aliased values alone.`, split.startLine));
    let data;
    try { data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT }); } catch (err) {
      result.diagnostics.push(diag('yaml-alias-limit', 'error', String(err?.message || 'Too many aliases.').split('\n')[0], split.startLine));
      return result;
    }
    result.data = plainCopy(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
    let complexKeys = 0;
    for (const pair of root.items) {
      const key = keyName(pair);
      if (key === null) { complexKeys++; continue; }
      const value = pair.value;
      const start = pair.key.range?.[0] ?? 0;
      result.keys.push({
        key,
        line: lineOfIndex(split.yaml, start) + split.startLine - 1,
        kind: valueKind(result.data[key]),
        style: YAML.isScalar(value) ? (value.type || null) : (YAML.isCollection(value) ? (value.flow ? 'flow' : 'block') : (YAML.isAlias(value) ? 'alias' : null)),
        alias: YAML.isAlias(value),
      });
    }
    if (complexKeys) result.diagnostics.push(diag('yaml-complex-key', 'warning', 'A key of the frontmatter is not plain text; the form leaves the frontmatter alone.', split.startLine));
    result.editable = doc.errors.length === 0 && !root.flow && !complexKeys;
    return result;
  }

  // ── Patching ──

  /** How the value a key holds is written, so its new value is written the same way. */
  function styleOf(yamlText, pair) {
    const value = pair.value;
    const style = { type: null, flow: undefined, indentSeq: true, indent: 2 };
    if (YAML.isScalar(value)) style.type = value.type || null;
    if (YAML.isCollection(value)) {
      style.flow = !!value.flow;
      if (!value.flow && value.range) {
        const at = value.range[0];
        const lineStart = yamlText.lastIndexOf('\n', at - 1) + 1;
        const column = at - lineStart;
        if (YAML.isSeq(value)) { style.indentSeq = column > 0; if (column > 0) style.indent = column; }
        else if (column > 0) style.indent = column;
      }
    }
    if (YAML.isScalar(value) && (value.type === 'BLOCK_FOLDED' || value.type === 'BLOCK_LITERAL') && value.range) {
      // The indentation of the block's first line with text.
      const block = yamlText.slice(value.range[0], value.range[1]);
      const m = /\n( +)\S/.exec(block);
      if (m) style.indent = Math.max(1, Math.min(8, m[1].length));
    }
    return style;
  }

  /** `key: value` as YAML, written in `style` where the value allows it. Ends with "\n". */
  function serializePair(key, value, style = {}) {
    const doc = new YAML.Document();
    doc.contents = doc.createNode({ [key]: value });
    const node = doc.contents.items[0].value;
    if (style.type && YAML.isScalar(node) && typeof value === 'string') node.type = style.type;
    if (style.flow !== undefined && YAML.isCollection(node)) node.flow = style.flow;
    return doc.toString({
      lineWidth: style.type === 'BLOCK_FOLDED' ? 80 : 0,
      minContentWidth: 0,
      indent: style.indent || 2,
      indentSeq: style.indentSeq !== false,
      flowCollectionPadding: false,
    });
  }

  function findPair(root, key) {
    if (!root || !YAML.isMap(root)) return null;
    return root.items.find((pair) => keyName(pair) === key) || null;
  }

  // The text a pair spans: from the start of its key to the end of its value (a value written over several lines
  // takes its last line ending with it). A comment after a one-line value is outside it, and stays.
  function pairSpan(yamlText, pair) {
    const start = pair.key.range[0];
    const lineStart = yamlText.lastIndexOf('\n', start - 1) + 1;
    if (yamlText.slice(lineStart, start).trim() !== '') return null;   // the key is not at the start of its line
    let end;
    if (pair.value && pair.value.range) end = pair.value.range[1];
    else {
      const colon = yamlText.indexOf(':', pair.key.range[1]);
      if (colon < 0) return null;
      end = colon + 1;
    }
    return { start, end, lineStart, block: yamlText.charCodeAt(end - 1) === 10 };
  }

  // The whole lines a pair takes: what removing the key removes. A comment on its last line goes with it.
  function pairLines(yamlText, pair) {
    const span = pairSpan(yamlText, pair);
    if (!span) return null;
    let end = span.block ? span.end : Math.max(span.end, pair.value?.range?.[2] ?? span.end);
    if (yamlText.charCodeAt(end - 1) !== 10) {
      const nl = yamlText.indexOf('\n', end);
      const rest = yamlText.slice(end, nl < 0 ? yamlText.length : nl);
      if (rest.trim() !== '' && !rest.trim().startsWith('#')) return null;
      end = nl < 0 ? yamlText.length : nl + 1;
    }
    return { start: span.lineStart, end };
  }

  function patchOne(text, key, value) {
    const split = splitFrontmatter(text);
    const lead = split.bom ? '﻿' : '';
    if (!split.hasFrontmatter) {
      if (split.unterminated) return { ok: false, reason: 'unterminated' };
      if (value === undefined) return { ok: true, text };
      const pairText = serializePair(key, value);
      return { ok: true, text: `${lead}---\n${pairText}---\n${text.slice(split.bom ? 1 : 0)}` };
    }
    const yamlText = split.yaml;
    let doc;
    try { doc = parseYaml(yamlText); } catch { return { ok: false, reason: 'invalid' }; }
    if (doc.errors.length) return { ok: false, reason: 'invalid' };
    const root = doc.contents;
    if (root !== null && root !== undefined && (!YAML.isMap(root) || root.flow)) return { ok: false, reason: 'unsupported' };
    if (root && root.items.some((pair) => keyName(pair) === null)) return { ok: false, reason: 'unsupported' };
    const pair = findPair(root, key);
    if (pair && YAML.isAlias(pair.value)) return { ok: false, reason: 'alias' };
    let next;
    if (value === undefined) {
      if (!pair) return { ok: true, text };
      const lines = pairLines(yamlText, pair);
      if (!lines) return { ok: false, reason: 'unsupported' };
      next = yamlText.slice(0, lines.start) + yamlText.slice(lines.end);
    } else if (pair) {
      const span = pairSpan(yamlText, pair);
      if (!span) return { ok: false, reason: 'unsupported' };
      let replacement = serializePair(key, value, styleOf(yamlText, pair));
      if (!span.block) replacement = replacement.replace(/\n$/, '');
      next = yamlText.slice(0, span.start) + replacement + yamlText.slice(span.end);
    } else {
      const base = yamlText === '' || yamlText.endsWith('\n') ? yamlText : `${yamlText}\n`;
      next = base + serializePair(key, value);
    }
    return { ok: true, text: text.slice(0, split.yamlStart) + next + text.slice(split.yamlEnd) };
  }

  /**
   * Change keys of a document's frontmatter, each by its own text, and check the result.
   * @param {string} text the whole document
   * @param {Record<string, any>} changes key → new value; `undefined` removes the key
   * @returns {{ ok: true, text: string, changed: boolean } | { ok: false, text: string, reason: string, key: string }}
   *   `reason`: `invalid` (the YAML has errors), `unterminated`, `unsupported` (a layout this does not edit:
   *   a flow mapping, a key that is not plain text), `alias`, `mismatch` (the result did not read back as asked)
   */
  function patch(text, changes) {
    const source = String(text ?? '');
    const before = parse(source);
    if (before.hasFrontmatter && !before.editable) return { ok: false, text: source, reason: before.diagnostics.some((d) => d.severity === 'error') ? 'invalid' : 'unsupported', key: null };
    let current = source;
    const entries = Object.entries(changes || {});
    for (const [key, value] of entries) {
      const step = patchOne(current, key, value);
      if (!step.ok) return { ok: false, text: source, reason: step.reason, key };
      current = step.text;
    }
    if (current === source) return { ok: true, text: source, changed: false };
    // Read back: the keys asked for hold what was asked, every other key what it held, in the same order.
    const after = parse(current);
    if (!after.data || after.diagnostics.some((d) => d.severity === 'error')) return { ok: false, text: source, reason: 'mismatch', key: null };
    const asked = new Map(entries);
    for (const [key, value] of asked) {
      const has = Object.prototype.hasOwnProperty.call(after.data, key);
      if (value === undefined ? has : !(has && deepEqual(after.data[key], plainCopy(value)))) return { ok: false, text: source, reason: 'mismatch', key };
    }
    const kept = (before.keys || []).map((k) => k.key).filter((k) => !asked.has(k));
    const keptAfter = after.keys.map((k) => k.key).filter((k) => !asked.has(k));
    if (!deepEqual(kept, keptAfter)) return { ok: false, text: source, reason: 'mismatch', key: null };
    for (const key of kept) {
      if (!deepEqual(before.data[key], after.data[key])) return { ok: false, text: source, reason: 'mismatch', key };
    }
    if (before.body !== after.body) return { ok: false, text: source, reason: 'mismatch', key: null };
    return { ok: true, text: current, changed: true };
  }

  return { parse, patch, serializePair, splitFrontmatter, PARSE_OPTIONS };
}

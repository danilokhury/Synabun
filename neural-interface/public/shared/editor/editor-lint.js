// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: problems in the file
// ═══════════════════════════════════════════
//
// A JSON file that does not parse gets the place of the error underlined, a
// mark in the gutter and the parser's message (on hover, and with F8). The
// check is CodeMirror's lint (@codemirror/lint, a chunk of the vendored bundle
// fetched with the first JSON file) run with the JSON language's own linter.
// Files that are JSON with comments by convention (tsconfig.json, .vscode/…)
// are checked with comments and trailing commas allowed; files that are not
// one JSON value (JSON Lines, JSON5) are not checked.
// Takes the vendored bundle as an argument: no imports. The helpers at the top
// need no page: `node --test` loads them as they are.

/** The check runs this long after the last edit. */
export const LINT_DELAY_MS = 400;

// JSON with comments, by the name tools gave the file.
const JSONC_NAMES = /^(tsconfig|jsconfig)(\..+)?\.json$|^(\.?devcontainer|\.eslintrc|\.babelrc|deno|turbo|\.luarc|api-extractor|typedoc)\.json$|^(\.babelrc|\.eslintrc|\.prettierrc|\.stylelintrc|\.swcrc|bun\.lock)$/;

/**
 * Which check a file gets.
 * @param {string} path the file's path or name
 * @param {string} languageName the language it is shown in, as the status bar names it
 * @returns {'json' | 'jsonc' | null} `json`: strict; `jsonc`: comments and trailing commas are allowed; null: none
 */
export function lintKind(path, languageName) {
  if (languageName !== 'JSON') return null;
  const full = String(path ?? '').replace(/\\/g, '/');
  const name = full.slice(full.lastIndexOf('/') + 1).toLowerCase();
  const ext = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (ext === 'jsonl' || ext === 'ndjson' || ext === 'json5') return null;   // several values, or another syntax
  if (ext === 'jsonc' || ext === 'code-workspace' || /\/\.vscode\/[^/]+$/.test(full) || JSONC_NAMES.test(name)) return 'jsonc';
  return 'json';
}

/**
 * `text` with its comments and trailing commas turned into spaces, every other character where it was: what is
 * left is JSON when the text was JSON with comments, and an error in it is at the same place in the text.
 */
export function blankJsonComments(text) {
  const s = String(text ?? '');
  const n = s.length;
  const out = new Uint16Array(n);
  let comma = -1;   // a comma that nothing but blanks and comments has followed yet
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 34) {   // a string: copied as it is, to its closing quote or the end of its line
      out[i++] = c;
      while (i < n) {
        const d = s.charCodeAt(i);
        out[i++] = d;
        if (d === 92 && i < n) out[i] = s.charCodeAt(i++);
        else if (d === 34 || d === 10) break;
      }
      comma = -1;
      continue;
    }
    if (c === 47 && s.charCodeAt(i + 1) === 47) {
      while (i < n && s.charCodeAt(i) !== 10) out[i++] = 32;
      continue;
    }
    if (c === 47 && s.charCodeAt(i + 1) === 42) {
      const end = s.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) out[i] = s.charCodeAt(i) === 10 ? 10 : 32;
      continue;
    }
    out[i] = c;
    if (c === 44) comma = i;
    else if (c === 125 || c === 93) { if (comma >= 0) out[comma] = 32; comma = -1; }
    else if (c !== 32 && c !== 9 && c !== 10 && c !== 13) comma = -1;
    i++;
  }
  let result = '';
  for (let at = 0; at < n; at += 8192) result += String.fromCharCode.apply(null, out.subarray(at, Math.min(n, at + 8192)));
  return result;
}

/**
 * Where a parser's message says the error is, as an offset into the text. Null when the message names no place
 * (some engines' do not).
 */
export function parseErrorOffset(message, text) {
  const words = String(message ?? '');
  const s = String(text ?? '');
  let m = /\bat position (\d+)/.exec(words);
  if (m) return Math.min(Number(m[1]), s.length);
  m = /\bat line (\d+) column (\d+)/.exec(words);
  if (m) {
    let at = 0;
    for (let line = 1; line < Number(m[1]); line++) {
      const next = s.indexOf('\n', at);
      if (next === -1) return s.length;
      at = next + 1;
    }
    return Math.min(at + Math.max(0, Number(m[2]) - 1), s.length);
  }
  if (/end of (JSON )?(input|data)/i.test(words)) return s.length;
  return null;
}

const isWordChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 45 || c === 43 || c === 46 || c > 127;
const isBlank = (c) => c === 32 || c === 9 || c === 10 || c === 13;

/**
 * The stretch of text to underline for an error at `offset`: the word there, or the one character; at a blank
 * or past the end, the last thing before it. Never empty unless the text is, and never across a line break.
 * @returns {{ from: number, to: number }}
 */
export function problemSpan(text, offset) {
  const s = String(text ?? '');
  if (!s.length) return { from: 0, to: 0 };
  let at = Math.max(0, Math.min(Number(offset) || 0, s.length - 1));
  while (at > 0 && isBlank(s.charCodeAt(at))) at--;
  if (isBlank(s.charCodeAt(at))) return { from: at, to: at + 1 === s.length || s.charCodeAt(at) === 10 ? at : at + 1 };
  if (!isWordChar(s.charCodeAt(at))) return { from: at, to: at + 1 };
  let from = at; let to = at + 1;
  while (from > 0 && isWordChar(s.charCodeAt(from - 1))) from--;
  while (to < s.length && isWordChar(s.charCodeAt(to))) to++;
  return { from, to };
}

/**
 * The problems of a JSON text.
 * @param {string} text
 * @param {{ relaxed?: boolean }} [o] `relaxed`: comments and trailing commas are not problems
 * @returns {{ from: number, to: number, message: string, placed: boolean }[]} none, or the first one the parser
 *   met; `placed` is false when the parser's message named no place (`from` and `to` are then 0)
 */
export function jsonProblems(text, { relaxed = false } = {}) {
  const s = String(text ?? '');
  if (!s.trim()) return [];   // an empty file is not a broken one
  let checked = s;
  try { JSON.parse(s); return []; } catch (strict) {
    let error = strict;
    if (relaxed) {
      checked = blankJsonComments(s);
      try { JSON.parse(checked); return []; } catch (inner) { error = inner; }
    }
    if (!(error instanceof SyntaxError)) throw error;
    const offset = parseErrorOffset(error.message, checked);
    if (offset === null) return [{ from: 0, to: 0, message: error.message, placed: false }];
    return [{ ...problemSpan(s, offset), message: error.message, placed: true }];
  }
}

/**
 * @param {object} cm the vendored CodeMirror bundle (editor-loader.js)
 */
export function editorLint(cm) {
  let lint = null;          // @codemirror/lint, once loaded
  let strictLinter = null;  // the JSON language's own linter
  let loading = null;
  const built = new Map();  // kind → its extension, the same one for every document

  function load() {
    if (!loading) {
      loading = Promise.all([cm.loadLint(), typeof cm.loadJsonLinter === 'function' ? cm.loadJsonLinter() : null]).then(([module, jsonLinter]) => {
        lint = module;
        strictLinter = typeof jsonLinter === 'function' ? jsonLinter() : null;
      });
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  // A problem the parser's message did not place is put at the first node the editor's own parser could not read.
  function firstErrorNode(state) {
    let at = -1;
    cm.syntaxTree(state).iterate({ enter: (node) => { if (at < 0 && node.type.isError) at = node.from; return at < 0; } });
    return at;
  }

  function source(kind) {
    return (view) => {
      const text = view.state.doc.toString();
      let found;
      if (kind === 'json' && strictLinter) {
        // The JSON language's own linter says whether the file parses and with which message; where the
        // underline goes is worked out here, so it is a stretch of text instead of a point.
        found = text.trim() ? strictLinter(view).map((d) => {
          const offset = parseErrorOffset(d.message, text);
          return offset === null ? { from: 0, to: 0, message: d.message, placed: false } : { ...problemSpan(text, offset), message: d.message, placed: true };
        }) : [];
      } else {
        found = jsonProblems(text, { relaxed: kind === 'jsonc' });
      }
      return found.map((problem) => {
        let { from, to } = problem;
        if (!problem.placed) {
          const at = firstErrorNode(view.state);
          ({ from, to } = problemSpan(text, at < 0 ? 0 : at));
        }
        return { from, to, severity: 'error', message: problem.message };
      });
    };
  }

  function build(kind) {
    if (!built.has(kind)) built.set(kind, [lint.linter(source(kind), { delay: LINT_DELAY_MS }), lint.lintGutter()]);
    return built.get(kind);
  }

  return {
    /** The extension that checks a document of this kind, when the lint chunk is already there; else null. */
    ready: (kind) => (lint && kind ? build(kind) : null),

    /** The same, fetching the chunk first. Resolves to null for no kind; rejects when the chunk cannot be loaded. */
    async extension(kind) {
      if (!kind) return null;
      await load();
      return build(kind);
    },

    /** Go to the next / the previous problem. False when there is none (or nothing is checked). */
    next: (view) => (lint ? lint.nextDiagnostic(view) : false),
    previous: (view) => (lint ? lint.previousDiagnostic(view) : false),

    /** How many problems a state shows. */
    count: (state) => (lint ? lint.diagnosticCount(state) : 0),

    /** Call `use(from, to)` for each problem of a state (the minimap draws them). */
    each(state, use) {
      if (lint) lint.forEachDiagnostic(state, (_diagnostic, from, to) => use(from, to));
    },
  };
}

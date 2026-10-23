// What "the MCP server is built" means, in one place: mcp-server/dist/index.js and every module it imports by a
// relative path, transitively, are on disk. mcp-server/dist/ is build output that git ignores, yet a checkout can
// hold a tracked dist/index.js whose newer imports were never committed (they are ignored too): a server started
// from it fails to load /mcp. postinstall.js and setup.js build when this says no; the Neural Interface's restore,
// onboarding status and build route, the install details, the release and the packaged app's checks ask it too.
//
// The imports are read from the code itself, never from a comment or a string: a light tokenizer skips comments,
// strings, template literals and regular expressions, so a word "import" in a text cannot ask for a module that is
// not loaded (a packaged app has no compiler: a false "missing" there would stop it). Only plain fs and path:
// postinstall.js and setup.js import this on any Node.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MAX_MODULES = 5000;
const MAX_MODULE_BYTES = 8 * 1024 * 1024;
const CODE_EXT = /\.(?:m?js|cjs)$/i;
// After one of these a `/` starts a regular expression, after anything else it divides.
const REGEX_AFTER_PUNCT = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * The tokens of a module that matter for its imports: words, punctuation and string literals (their values), with
 * comments, template literal text and regular expressions left out.
 * @returns {{ t: 'word'|'punct'|'string', v: string }[]}
 */
export function codeTokens(text) {
  const src = String(text ?? '');
  const out = [];
  const frames = [];   // one per open `${` of a template literal: the brace depth that closes it
  let depth = 0;
  let i = 0;
  const last = () => out[out.length - 1];
  const regexAllowed = () => {
    const p = last();
    if (!p) return true;
    if (p.t === 'punct') return REGEX_AFTER_PUNCT.has(p.v);
    if (p.t === 'word') return REGEX_AFTER_WORD.has(p.v);
    return false;
  };
  const template = () => {
    // From just after a backtick (or a closing `}` of a `${`): to the closing backtick or the next `${`.
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i += 1; out.push({ t: 'string', v: '' }); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; frames.push(depth); depth += 1; return; }
      i += 1;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1; let v = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { v += src[j + 1] ?? ''; j += 2; continue; } v += src[j]; j += 1; }
      out.push({ t: 'string', v });
      i = j + 1;
      continue;
    }
    if (c === '`') { i += 1; template(); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1; let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j += 1;
      }
      i = j + 1;
      while (i < src.length && /[a-z]/i.test(src[i])) i += 1;
      out.push({ t: 'punct', v: ')' });   // a value, as far as a following `/` is concerned
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
      out.push({ t: 'word', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < src.length && /[\w.]/.test(src[j])) j += 1; out.push({ t: 'word', v: src.slice(i, j) }); i = j; continue; }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (frames.length && depth - 1 === frames[frames.length - 1]) { depth -= 1; frames.pop(); i += 1; template(); continue; }
      depth = Math.max(0, depth - 1);
    }
    out.push({ t: 'punct', v: c });
    i += 1;
  }
  return out;
}

/** The module specifiers a module loads: static imports, `export … from`, side-effect imports, `import('…')`. */
export function importSpecifiers(text) {
  const tokens = codeTokens(text);
  const found = [];
  const at = (k) => tokens[k] || { t: 'end', v: '' };
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t !== 'word' || (tok.v !== 'import' && tok.v !== 'export')) continue;
    if (k > 0 && at(k - 1).t === 'punct' && at(k - 1).v === '.') continue;   // obj.import
    const next = at(k + 1);
    if (tok.v === 'import') {
      if (next.t === 'punct' && next.v === '.') continue;   // import.meta
      if (next.t === 'punct' && next.v === '(') { if (at(k + 2).t === 'string' && at(k + 3).v === ')') found.push(at(k + 2).v); continue; }
      if (next.t === 'string') { found.push(next.v); continue; }
    }
    // import a, { b as c } from '…'; import * as d from '…'; export { e } from '…'; export * from '…'
    let j = k + 1;
    while (j < tokens.length) {
      const x = at(j);
      if (x.t === 'word' && x.v === 'from') break;
      if (x.t === 'word' || (x.t === 'punct' && (x.v === ',' || x.v === '{' || x.v === '}' || x.v === '*'))) { j += 1; continue; }
      j = -1;
      break;
    }
    if (j > k + 1 && at(j).v === 'from' && at(j + 1).t === 'string') {
      if (tok.v === 'export' && !(next.v === '*' || next.v === '{')) continue;
      found.push(at(j + 1).v);
    }
  }
  return found;
}

const posix = (p) => p.split(sep).join('/');

/**
 * Every module dist/index.js needs that is not on disk (or cannot be read), as paths from the package root.
 * Modules inside mcp-server/dist are followed; one outside it (the package's lib/) is only looked for.
 * @param {string} packageRoot
 * @param {{ exists?: (p: string) => boolean, readText?: (p: string) => string, entry?: string }} [o]
 * @returns {{ complete: boolean, missing: string[], checked: number }}
 */
export function mcpDistMissing(packageRoot, { exists = existsSync, readText = null, entry = 'index.js' } = {}) {
  const root = resolve(packageRoot);
  const dist = join(root, 'mcp-server', 'dist');
  const read = readText || ((p) => {
    const st = statSync(p);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > MAX_MODULE_BYTES) return null;
    return readFileSync(p, 'utf8');
  });
  const missing = new Set();
  const seen = new Set();
  const queue = [join(dist, entry)];
  let checked = 0;
  while (queue.length && checked < MAX_MODULES) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!exists(file)) { missing.add(posix(relative(root, file))); continue; }
    const inside = file.startsWith(dist + sep);
    if (!inside || !CODE_EXT.test(file)) continue;
    let text;
    try { text = read(file); } catch { missing.add(posix(relative(root, file))); continue; }
    checked += 1;
    if (text === null) continue;   // too large to read here: present, not followed
    for (const spec of importSpecifiers(text)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const target = resolve(dirname(file), spec.split(/[?#]/)[0]);
      if (!seen.has(target)) queue.push(target);
    }
  }
  const list = [...missing].sort();
  return { complete: list.length === 0, missing: list, checked };
}

/** Whether the MCP server is built: dist/index.js and everything it imports are there. */
export function mcpDistBuilt(packageRoot, options) {
  return mcpDistMissing(packageRoot, options).complete;
}

// ═══════════════════════════════════════════
// SynaBun Neural Interface — Code editor: what a file is on disk
// ═══════════════════════════════════════════
//
// CodeMirror holds every line break as "\n". These helpers read what the file
// used (line ending, byte-order mark, indentation) when it is opened, and write
// the document back the same way when it is saved. No DOM and no imports: loaded
// by `node --test` as it is.

export const BOM = '\uFEFF';
const REPLACEMENT = '\uFFFD';

/**
 * Take a leading byte-order mark off `content`.
 * @param {string} content what the server sent
 * @param {boolean} [reported] the server's `bom` field. A server that sends it has already taken the mark off;
 *   one that does not (it predates the field) sends the mark as the first character.
 * @returns {{ text: string, bom: boolean }}
 */
export function splitBom(content, reported) {
  const text = String(content ?? '');
  if (typeof reported === 'boolean') return { text, bom: reported };
  return text.charCodeAt(0) === 0xFEFF ? { text: text.slice(1), bom: true } : { text, bom: false };
}

/**
 * The line ending a text uses. `eol` is the style it is saved in: the more common of LF and CRLF (LF when
 * neither leads). `mixed` says the text holds more than one kind of line break, a lone CR included, so a save
 * rewrites some of them.
 * @returns {{ eol: 'LF' | 'CRLF', mixed: boolean, counts: { lf: number, crlf: number, cr: number } }}
 */
export function detectLineEnding(text) {
  const s = String(text ?? '');
  let lf = 0; let crlf = 0; let cr = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) {
    if (i > 0 && s.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  for (let i = s.indexOf('\r'); i !== -1; i = s.indexOf('\r', i + 1)) {
    if (s.charCodeAt(i + 1) !== 10) cr++;
  }
  const kinds = (lf ? 1 : 0) + (crlf ? 1 : 0) + (cr ? 1 : 0);
  return { eol: crlf > lf ? 'CRLF' : 'LF', mixed: kinds > 1, counts: { lf, crlf, cr } };
}

const SPACE_STEPS = [2, 4, 8];
/** The width a tab is drawn at when nothing says otherwise. */
export const DEFAULT_TAB_WIDTH = 4;
/** What Tab inserts in a file that shows no indentation of its own. */
export const DEFAULT_SPACE_STEP = 2;

/**
 * How a text is indented, read from its leading whitespace: with tabs, or with the step of 2, 4 or 8 spaces
 * that most often separates one line from the line before it.
 * @param {string} text
 * @param {{ maxLines?: number }} [o] lines read from the start (a large file is not read whole)
 * @returns {{ kind: 'spaces' | 'tabs', size: number, detected: boolean }} `size` is the space step, or the
 *   default tab width for a file indented with tabs; `detected` is false when the text gave no evidence
 */
export function detectIndentation(text, { maxLines = 5000 } = {}) {
  const s = String(text ?? '');
  let tabLines = 0; let spaceLines = 0;
  const steps = new Map(SPACE_STEPS.map((n) => [n, 0]));
  let previous = 0;      // leading spaces of the last line that had content and was not indented with a tab
  let at = 0;
  for (let n = 0; n < maxLines && at <= s.length; n++) {
    let end = s.indexOf('\n', at);
    if (end === -1) end = s.length;
    let i = at;
    let spaces = 0; let tab = false;
    for (; i < end; i++) {
      const c = s.charCodeAt(i);
      if (c === 32) spaces++;
      else if (c === 9) tab = true;
      else break;
    }
    const blank = i >= end || s.charCodeAt(i) === 13;
    if (!blank) {
      if (tab) tabLines++;
      else {
        if (spaces) spaceLines++;
        const step = Math.abs(spaces - previous);
        if (steps.has(step)) steps.set(step, steps.get(step) + 1);
        previous = spaces;
      }
    }
    at = end + 1;
  }
  if (tabLines > spaceLines) return { kind: 'tabs', size: DEFAULT_TAB_WIDTH, detected: true };
  let best = 0; let bestCount = 0;
  for (const n of SPACE_STEPS) {
    if (steps.get(n) > bestCount) { best = n; bestCount = steps.get(n); }
  }
  if (!best) return { kind: 'spaces', size: DEFAULT_SPACE_STEP, detected: false };
  return { kind: 'spaces', size: best, detected: true };
}

/**
 * The indentation the editor uses for a file: what was detected, unless a preference says otherwise.
 * @param {{ kind: 'spaces' | 'tabs', size: number }} detected from detectIndentation()
 * @param {{ tabSize?: 'auto' | number, indentWith?: 'auto' | 'spaces' | 'tabs' }} [editing] the `editing` preferences
 * @returns {{ kind: 'spaces' | 'tabs', tabSize: number, unit: string }} `unit` is what one level of indentation inserts
 */
export function resolveIndentation(detected, editing = {}) {
  const found = detected && (detected.kind === 'tabs' || detected.kind === 'spaces')
    ? detected : { kind: 'spaces', size: DEFAULT_SPACE_STEP };
  const kind = editing.indentWith === 'tabs' || editing.indentWith === 'spaces' ? editing.indentWith : found.kind;
  const wanted = Number(editing.tabSize);
  let tabSize;
  if (editing.tabSize !== 'auto' && Number.isInteger(wanted) && wanted >= 1 && wanted <= 16) tabSize = wanted;
  else if (kind === found.kind) tabSize = found.size;
  else tabSize = kind === 'tabs' ? DEFAULT_TAB_WIDTH : DEFAULT_SPACE_STEP;
  return { kind, tabSize, unit: kind === 'tabs' ? '\t' : ' '.repeat(tabSize) };
}

/**
 * The indentation a file uses when the user picked one in the status bar: that choice, over what was detected
 * and over the preferences. Without a choice it is resolveIndentation().
 * @param {{ kind: 'spaces' | 'tabs', size: number }} detected from detectIndentation()
 * @param {{ tabSize?: 'auto' | number, indentWith?: string }} [editing] the `editing` preferences
 * @param {{ kind: 'spaces', size: number } | { kind: 'tabs' } | null} [choice]
 * @returns {{ kind: 'spaces' | 'tabs', tabSize: number, unit: string }}
 */
export function chooseIndentation(detected, editing = {}, choice = null) {
  if (!choice) return resolveIndentation(detected, editing);
  if (choice.kind === 'tabs') {
    // How wide a tab is drawn is not part of the choice: the preference, else what the file showed.
    const wanted = Number(editing.tabSize);
    const tabSize = editing.tabSize !== 'auto' && Number.isInteger(wanted) && wanted >= 1 && wanted <= 16
      ? wanted : (detected?.kind === 'tabs' ? detected.size : DEFAULT_TAB_WIDTH);
    return { kind: 'tabs', tabSize, unit: '\t' };
  }
  const size = SPACE_STEPS.includes(choice.size) ? choice.size : DEFAULT_SPACE_STEP;
  return { kind: 'spaces', tabSize: size, unit: ' '.repeat(size) };
}

/**
 * The one change that turns `before` into `after`: what lies between the start and the end the two share.
 * A file reloaded from disk is applied this way, so the caret, the view and the undo history outside the
 * change stay where they are.
 * @returns {{ from: number, to: number, insert: string } | null} null when the texts are the same
 */
export function minimalChange(before, after) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  if (a === b) return null;
  const shortest = Math.min(a.length, b.length);
  let start = 0;
  while (start < shortest && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < shortest - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

/**
 * The text a save writes: `text` (line breaks as "\n", the way CodeMirror holds it) in the file's line ending,
 * behind its byte-order mark when it had one.
 */
export function serializeDocument(text, { eol = 'LF', bom = false } = {}) {
  const body = eol === 'CRLF' ? String(text ?? '').replace(/\n/g, '\r\n') : String(text ?? '');
  return bom ? BOM + body : body;
}

/**
 * Whether `content` lost bytes when it was decoded. A server that predates the encoding check decodes a file
 * that is not UTF-8 anyway, with U+FFFD in place of each invalid sequence: the text then no longer encodes to
 * the file's size, and saving it would write the damage to disk.
 * @param {string} content the text as received, byte-order mark included
 * @param {number} sizeOnDisk the size the server reported, in bytes
 */
export function looksLossyDecoded(content, sizeOnDisk) {
  const s = String(content ?? '');
  if (!Number.isFinite(sizeOnDisk) || !s.includes(REPLACEMENT)) return false;
  return new TextEncoder().encode(s).length !== sizeOnDisk;
}

/**
 * The document position of a 1-based line and column, held inside the document: a line past the end is the
 * last line, a column past the end of its line is the end of that line.
 * @param {{ lines: number, line: (n: number) => { from: number, length: number } }} doc a CodeMirror Text
 * @returns {{ pos: number, line: number, column: number }}
 */
export function positionAt(doc, lineNumber, columnNumber = 1) {
  const line = Math.min(Math.max(1, Math.floor(Number(lineNumber)) || 1), Math.max(1, doc.lines));
  const info = doc.line(line);
  const column = Math.min(Math.max(1, Math.floor(Number(columnNumber)) || 1), info.length + 1);
  return { pos: info.from + column - 1, line, column };
}

/**
 * What a "go to line" field asks for: `12`, `12:8` or `12,8`.
 * @returns {{ line: number, column: number } | null} null when it is not a line number
 */
export function parseLineTarget(input) {
  const m = /^\s*(\d{1,9})\s*(?:[:,]\s*(\d{1,9})\s*)?$/.exec(String(input ?? ''));
  if (!m) return null;
  const line = Number(m[1]);
  if (line < 1) return null;
  return { line, column: m[2] ? Math.max(1, Number(m[2])) : 1 };
}

/** Above this size the minimap, the git markers and the problem check are off for a document. */
export const LARGE_DOCUMENT_BYTES = 2 * 1024 * 1024;

/**
 * Whether a document is too large for the minimap, the git markers and the problem check.
 * @param {{ size?: number, length?: number }} o `size`: the file on disk, in bytes; `length`: the text in the editor
 */
export function isLargeDocument({ size = 0, length = 0 } = {}) {
  return Math.max(Number(size) || 0, Number(length) || 0) > LARGE_DOCUMENT_BYTES;
}

/**
 * What a save changes in the text before it is written, for the two on-save preferences.
 *   trimTrailingWhitespace  spaces and tabs at the end of a line go
 *   insertFinalNewline      the text ends with exactly one line break: a missing one is added, empty lines after
 *                           the last line with text go (with trimming on, a line of only spaces is an empty line)
 * An empty text stays empty. With both off nothing changes.
 * @param {string} text line breaks as "\n", the way CodeMirror holds it
 * @param {{ trimTrailingWhitespace?: boolean, insertFinalNewline?: boolean }} [o]
 * @returns {{ from: number, to: number, insert: string }[]} changes in document order that do not touch each other
 */
export function saveFixes(text, { trimTrailingWhitespace = false, insertFinalNewline = false } = {}) {
  const s = String(text ?? '');
  const changes = [];
  if (!s || (!trimTrailingWhitespace && !insertFinalNewline)) return changes;
  let contentEnd = s.length;
  let ending = null;
  if (insertFinalNewline) {
    const blank = trimTrailingWhitespace ? (c) => c === 10 || c === 32 || c === 9 : (c) => c === 10;
    while (contentEnd > 0 && blank(s.charCodeAt(contentEnd - 1))) contentEnd--;
    const wanted = contentEnd === 0 ? '' : '\n';
    if (s.slice(contentEnd) !== wanted) ending = { from: contentEnd, to: s.length, insert: wanted };
    else contentEnd = s.length;   // the end is as it should be: only lines are trimmed
  }
  if (trimTrailingWhitespace) {
    const trailing = /[ \t]+$/gm;
    for (let m = trailing.exec(s); m; m = trailing.exec(s)) {
      if (ending && m.index >= ending.from) break;   // what follows is replaced with the ending
      changes.push({ from: m.index, to: m.index + m[0].length, insert: '' });
    }
  }
  if (ending) changes.push(ending);
  return changes;
}

/** `text` with the changes of saveFixes() (or any changes in document order) applied. */
export function applyChanges(text, changes) {
  const s = String(text ?? '');
  let out = '';
  let at = 0;
  for (const change of changes) {
    out += s.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + s.slice(at);
}

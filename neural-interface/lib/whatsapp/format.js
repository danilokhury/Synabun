// ═══════════════════════════════════════════
// SynaBun — WhatsApp Link: Markdown → WhatsApp text, and message splitting
// ═══════════════════════════════════════════
//
// toWhatsApp turns the Assistant's Markdown into what WhatsApp renders:
// *bold*, _italic_, ~strike~, `code`, ``` blocks, "> " quotes and • bullets.
// Code (fenced or inline) is never converted; small tables become a ``` block,
// wide ones one "• *Header*: value" line per row.
//
// chunk splits converted text into messages of at most `max` UTF-16 code
// units (protocol.js validates String#length): at paragraphs, then lines,
// sentences and words, then a hard split that never separates a surrogate
// pair and avoids cutting inside a grapheme. A ``` block cut in two is closed
// at the end of one message and reopened in the next, so every message renders
// on its own. Pure string functions, no dependencies.

export const DEFAULT_TAIL = 'The rest is in SynaBun (open the WhatsApp conversation).';
export const MAX_CODE_LINES = 60;

const FENCE = '```';
const TABLE_MAX_COLUMNS = 3;
const TABLE_MAX_WIDTH = 32;
const MIN_TAIL_ROOM = 20;

// ── Markdown → WhatsApp ──
// Placeholders: PH_OPEN index PH_CLOSE stands for stashed literal text (code
// spans, escapes, decoded entities, URLs). BOLD / ITALIC / STRIKE mark
// converted emphasis until the very end, so a *bold* is never re-read as
// italic. Private-use characters; any already in the input are stashed as
// literals first.
const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';
const BOLD = '\uE002';
const ITALIC = '\uE003';
const STRIKE = '\uE004';
const PRIVATE_RE = /[\uE000-\uE004]/g;
const PH_RE = /\uE000(\d+)\uE001/g;
const SENTINEL_RE = /[\uE002-\uE004]/g;

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const ENTITY_RE = /&(?:(amp|lt|gt|quot|apos|nbsp)|#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6}));/g;
const LINK_RE = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^<>\n]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const AUTOLINK_RE = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/g;
const BARE_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const BR_RE = /<br\s*\/?>/gi;
const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9]*)(?:\s[^<>]*)?\/?>/g;
// Tags that are stripped. Only real HTML names, written in one case, so prose
// like Vec<String>, Promise<void> or a <Button> component keeps its text.
const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center',
  'cite', 'code', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'iframe', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav',
  'ol', 'p', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'source', 'span', 'strike',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'video', 'wbr',
]);

const FENCE_OPEN_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const QUOTE_RE = /^[ \t]*>/;
const UL_RE = /^([ \t]*)([-*+])[ \t]+(\S.*)$/;
const OL_RE = /^([ \t]*)(\d{1,9})([.)])[ \t]+(\S.*)$/;
const TASK_RE = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const DELIMITER_CELL_RE = /^:?-+:?$/;

function restore(s, stash, depth = 0) {
  return s.replace(PH_RE, (_m, n) => {
    const value = stash[Number(n)] ?? '';
    return depth < 8 ? restore(value, stash, depth + 1) : value;
  });
}

/** Code spans and backslash escapes, left to right (an escaped backtick opens nothing). */
function protectCode(s, put, plain) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) {
      out += put(s[i + 1]);
      i += 2;
      continue;
    }
    if (ch !== '`') {
      out += ch;
      i += 1;
      continue;
    }
    let n = 1;
    while (s[i + n] === '`') n += 1;
    let close = -1;
    for (let j = i + n; j < s.length;) {
      if (s[j] !== '`') { j += 1; continue; }
      let m = 1;
      while (s[j + m] === '`') m += 1;
      if (m === n) { close = j; break; }
      j += m;
    }
    if (close < 0) {
      out += put(s.slice(i, i + n));
      i += n;
      continue;
    }
    let code = s.slice(i + n, close);
    if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
    // WhatsApp inline code cannot hold a backtick: such a span becomes ``` monospace.
    out += put(plain ? code : code.includes('`') ? `${FENCE}${code}${FENCE}` : `\`${code}\``);
    i = close + n;
  }
  return out;
}

function decodeEntity(match, name, dec, hex, put) {
  if (name) return name === 'nbsp' ? ' ' : put(NAMED_ENTITIES[name]);
  const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
  if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return match;
  return put(String.fromCodePoint(cp));
}

function sameTarget(text, url) {
  const norm = (v) => v.replace(/^[*_~`]+|[*_~`]+$/g, '').trim().replace(/^[a-z][a-z0-9+.-]*:(?:\/\/)?/i, '').replace(/\/+$/, '').toLowerCase();
  const a = norm(text);
  return a !== '' && a === norm(url);
}

function trimUrl(url) {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (/[?!.,:;*_~'"]/.test(last)) { u = u.slice(0, -1); continue; }
    if (last === ')' && u.split('(').length < u.split(')').length) { u = u.slice(0, -1); continue; }
    return u;
  }
}

function isHtmlTag(name) {
  const lower = name.toLowerCase();
  return (name === lower || name === name.toUpperCase()) && HTML_TAGS.has(lower);
}

function emphasize(s, plain) {
  const wrap = (open, close) => (_m, inner) => (plain ? inner : `${open}${inner}${close}`);
  s = s.replace(/(?<![\p{L}\p{N}])\*\*\*(?=\S)([^\n]*?\S)\*\*\*(?![\p{L}\p{N}])/gu, wrap(BOLD + ITALIC, ITALIC + BOLD));
  s = s.replace(/(?<![\p{L}\p{N}])___(?=\S)([^\n]*?\S)___(?![\p{L}\p{N}])/gu, wrap(BOLD + ITALIC, ITALIC + BOLD));
  s = s.replace(/(?<![\p{L}\p{N}])\*\*(?=\S)([^\n]*?\S)\*\*(?![\p{L}\p{N}])/gu, wrap(BOLD, BOLD));
  s = s.replace(/(?<![\p{L}\p{N}])__(?=\S)([^\n]*?\S)__(?![\p{L}\p{N}])/gu, wrap(BOLD, BOLD));
  s = s.replace(/(?<![\p{L}\p{N}*])\*(?=[^\s*])([^\n]*?[^\s*])\*(?![\p{L}\p{N}*])/gu, wrap(ITALIC, ITALIC));
  // _x_ already is WhatsApp italic; only plain text drops it.
  if (plain) s = s.replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu, wrap('', ''));
  s = s.replace(/(?<![\p{L}\p{N}])~~(?=\S)([^\n]*?\S)~~(?![\p{L}\p{N}])/gu, wrap(STRIKE, STRIKE));
  return s;
}

/** One line of inline Markdown → WhatsApp (or plain text: headings, table cells). */
function inline(text, { plain = false } = {}) {
  const stash = [];
  const put = (value) => `${PH_OPEN}${stash.push(value) - 1}${PH_CLOSE}`;
  let s = String(text).replace(PRIVATE_RE, (ch) => put(ch));
  s = protectCode(s, put, plain);
  s = s.replace(ENTITY_RE, (m, name, dec, hex) => decodeEntity(m, name, dec, hex, put));
  s = s.replace(LINK_RE, (_m, bang, label, dest) => {
    const url = (dest.startsWith('<') && dest.endsWith('>') ? dest.slice(1, -1) : dest).trim();
    const words = label.trim();
    if (bang) return !url ? words : words ? `${words}: ${put(url)}` : put(url);
    if (!url) return words;
    return !words || sameTarget(restore(words, stash), restore(url, stash)) ? put(url) : `${words} (${put(url)})`;
  });
  s = s.replace(AUTOLINK_RE, (_m, url) => put(url));
  s = s.replace(BARE_URL_RE, (m) => { const url = trimUrl(m); return put(url) + m.slice(url.length); });
  s = s.replace(COMMENT_RE, '').replace(BR_RE, plain ? ' ' : '\n').replace(TAG_RE, (m, name) => (isHtmlTag(name) ? '' : m));
  s = emphasize(s, plain);
  if (!plain) s = s.replace(SENTINEL_RE, (ch) => (ch === BOLD ? '*' : ch === ITALIC ? '_' : '~'));
  return restore(s, stash);
}

const plainText = (text) => inline(text, { plain: true }).replace(/\s+/g, ' ').trim();

function heading(text) {
  const words = plainText(text);
  return words ? `*${words}*` : '';
}

/** An ATX_RE match → heading, without its optional closing #s. */
const atxHeading = (match) => heading((match[2] || '').replace(/(?:^|[ \t]+)#+[ \t]*$/, ''));

function indentWidth(ws) {
  let w = 0;
  for (const ch of ws) w = ch === '\t' ? w + 4 - (w % 4) : w + 1;
  return w;
}

/** Nesting level of a list item indented `width` columns; `stack` holds the open levels' indents. */
function listLevel(stack, width) {
  while (stack.length && stack[stack.length - 1] > width) stack.pop();
  if (!stack.length || stack[stack.length - 1] < width) stack.push(width);
  return stack.length - 1;
}

function listItem(level, content) {
  const pad = '  '.repeat(level);
  const task = TASK_RE.exec(content);
  if (task) return `${pad}${task[1] === ' ' ? '☐' : '☑'} ${inline(task[2] || '')}`.trimEnd();
  return `${pad}${level ? '◦' : '•'} ${inline(content)}`;
}

function orderedItem(level, number, content) {
  const pad = '  '.repeat(level);
  const task = TASK_RE.exec(content);
  if (task) return `${pad}${number} ${task[1] === ' ' ? '☐' : '☑'} ${inline(task[2] || '')}`.trimEnd();
  return `${pad}${number} ${inline(content)}`;
}

/** One "> " line (nesting flattened: WhatsApp quotes one level). */
function quoteLines(line) {
  const inner = line.replace(/^(?:[ \t]*>[ \t]?)+/, '');
  if (!inner.trim() || HR_RE.test(inner)) return [''];
  const atx = ATX_RE.exec(inner);
  const ul = UL_RE.exec(inner);
  const ol = ul ? null : OL_RE.exec(inner);
  let text;
  if (atx) text = atxHeading(atx);
  else if (ul) text = listItem(0, ul[3]);
  else if (ol) text = orderedItem(0, `${ol[2]}${ol[3]}`, ol[4]);
  else text = inline(inner.trim());
  return text.split('\n').map((part) => `> ${part}`);
}

function dedent(line, n) {
  let k = 0;
  while (k < n && (line[k] === ' ' || line[k] === '\t')) k += 1;
  return line.slice(k);
}

/** A fenced block starting at lines[start] → emitted; returns the index of its closing line. */
function codeBlock(lines, start, fence, emit) {
  const marker = fence[2];
  const closeRe = new RegExp(`^[ \\t]*${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
  const body = [];
  let j = start + 1;
  for (; j < lines.length && !closeRe.test(lines[j]); j += 1) body.push(dedent(lines[j], fence[1].length));
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (body.length) {
    const kept = body.slice(0, MAX_CODE_LINES);
    emit(FENCE);
    for (const line of kept) emit(line, true);
    emit(FENCE);
    if (body.length > kept.length) emit(`(${body.length - kept.length} more lines in SynaBun)`);
  }
  return j;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let k = 0; k < s.length; k += 1) {
    if (s[k] === '\\' && s[k + 1] === '|') { cell += '\\|'; k += 1; continue; }
    if (s[k] === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += s[k];
  }
  cells.push(cell.trim());
  return cells;
}

function isDelimiterRow(line, columns) {
  if (!line || !line.includes('-') || !/^[\s|:-]+$/.test(line)) return false;
  const cells = splitRow(line);
  return cells.length === columns && cells.every((cell) => DELIMITER_CELL_RE.test(cell));
}

const width = (s) => [...s].length;

/** A GFM table whose header is lines[start] → emitted; returns the index of its last row. */
function table(lines, start, header, emit) {
  const columns = header.length;
  const rows = [];
  let j = start + 2;
  for (; j < lines.length && lines[j].trim() && lines[j].includes('|'); j += 1) {
    const cells = splitRow(lines[j]);
    rows.push(Array.from({ length: columns }, (_v, c) => plainText(cells[c] ?? '')));
  }
  const head = header.map((cell) => plainText(cell));
  if (![head, ...rows].some((row) => row.some(Boolean))) return j - 1;
  const widths = head.map((h, c) => Math.max(width(h), ...rows.map((row) => width(row[c]))));
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (columns - 1);
  if (columns <= TABLE_MAX_COLUMNS && total <= TABLE_MAX_WIDTH) {
    const render = (cells) => cells.map((cell, c) => cell + ' '.repeat(widths[c] - width(cell))).join('  ').trimEnd();
    emit(FENCE);
    emit(render(head), true);
    emit('-'.repeat(total), true);
    for (const row of rows) emit(render(row), true);
    emit(FENCE);
  } else if (!rows.length) {
    emit(head.filter(Boolean).map((h) => `*${h}*`).join(' · '));
  } else {
    for (const row of rows) {
      const parts = row.map((value, c) => (!value ? '' : head[c] ? `*${head[c]}*: ${value}` : value)).filter(Boolean);
      if (parts.length) emit(`• ${parts.join(' · ')}`);
    }
  }
  return j - 1;
}

/** Trailing spaces off, at most one blank line in a row, trimmed; code lines stay verbatim. */
function finish(out) {
  const lines = [];
  let blanks = 0;
  for (const { text, raw } of out) {
    for (const part of raw ? [text] : text.split('\n')) {
      const line = raw ? part : part.replace(/\s+$/, '');
      if (!raw && !line) {
        blanks += 1;
        if (blanks === 1) lines.push('');
        continue;
      }
      blanks = 0;
      lines.push(line);
    }
  }
  return lines.join('\n').trim();
}

/** The Assistant's Markdown → WhatsApp formatting. Anything but a string → ''. */
export function toWhatsApp(md) {
  if (typeof md !== 'string') return '';
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const emit = (text, raw = false) => { out.push({ text, raw }); };
  let stack = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) { emit(''); continue; }
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      if (!fence[1]) stack = [];
      i = codeBlock(lines, i, fence, emit);
      continue;
    }
    // An HTML comment block: skipped up to its "-->" (never when it is not closed).
    if (/^[ \t]*<!--/.test(line) && !line.includes('-->')) {
      let end = i + 1;
      while (end < lines.length && !lines[end].includes('-->')) end += 1;
      if (end < lines.length) {
        lines[end] = lines[end].slice(lines[end].indexOf('-->') + 3);
        i = end - 1;
        continue;
      }
    }
    const indent = /^[ \t]*/.exec(line)[0];
    if (HR_RE.test(line)) {
      if (!indent) stack = [];
      emit('');
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (!indent && !ul && !ol) stack = [];
    const atx = ATX_RE.exec(line);
    if (atx) { emit(atxHeading(atx)); continue; }
    if (line.includes('|') && i + 1 < lines.length) {
      const header = splitRow(line);
      if (isDelimiterRow(lines[i + 1], header.length)) { i = table(lines, i, header, emit); continue; }
    }
    if (QUOTE_RE.test(line)) {
      for (const part of quoteLines(line)) emit(part);
      continue;
    }
    if (ul) { emit(listItem(listLevel(stack, indentWidth(ul[1])), ul[3])); continue; }
    if (ol) { emit(orderedItem(listLevel(stack, indentWidth(ol[1])), `${ol[2]}${ol[3]}`, ol[4])); continue; }
    if (!stack.length && i + 1 < lines.length && SETEXT_RE.test(lines[i + 1])) {
      emit(heading(line.trim()));
      i += 1;
      continue;
    }
    // A paragraph line; indented under a list item it keeps its indentation.
    emit(inline(stack.length && indent ? line : line.trim()));
  }
  return finish(out);
}

// ── Splitting ──

const isHigh = (u) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u) => u >= 0xdc00 && u <= 0xdfff;
const isRegional = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const MARK_RE = /\p{M}/u;
const SENTENCE_END = new Set(['.', '!', '?', '…']);
const CJK_SENTENCE_END = new Set(['。', '！', '？']);

const splitsPair = (s, c) => isHigh(s.charCodeAt(c - 1)) && isLow(s.charCodeAt(c));
const isLineCut = (s, c) => s[c] === '\n';
const isSpaceCut = (s, c) => s[c] === ' ' || s[c] === '\t';

function isParagraphCut(s, c) {
  if (s[c] !== '\n') return false;
  let k = c + 1;
  while (s[k] === ' ' || s[k] === '\t') k += 1;
  return k >= s.length || s[k] === '\n';
}

function isSentenceCut(s, c) {
  const before = s[c - 1];
  if (CJK_SENTENCE_END.has(before)) return true;
  return SENTENCE_END.has(before) && (s[c] === ' ' || s[c] === '\t' || s[c] === '\n');
}

function codePointBefore(s, c) {
  const unit = s.charCodeAt(c - 1);
  return c >= 2 && isLow(unit) && isHigh(s.charCodeAt(c - 2)) ? s.codePointAt(c - 2) : unit;
}

/** Not inside a surrogate pair, a ZWJ sequence, a flag, or before a mark / variation selector / skin tone / tag. */
function isGraphemeCut(s, c) {
  if (splitsPair(s, c)) return false;
  const next = s.codePointAt(c);
  const prev = codePointBefore(s, c);
  if (next === 0x200d || prev === 0x200d || next === 0xfe0f || next === 0xfe0e) return false;
  if ((next >= 0x1f3fb && next <= 0x1f3ff) || (next >= 0xe0020 && next <= 0xe007f)) return false;
  if (MARK_RE.test(String.fromCodePoint(next))) return false;
  if (isRegional(prev) && isRegional(next)) {
    let run = 0;
    for (let k = c; k >= 2 && isRegional(s.codePointAt(k - 2)); k -= 2) run += 1;
    if (run % 2 === 1) return false;
  }
  return true;
}

/**
 * Where to end a chunk that starts at p and may hold `room` code units: the
 * last paragraph, line, sentence or word boundary in the second half of the
 * window (in that order), else the last whitespace anywhere, else a hard
 * split. `minCut` keeps at least one visible character. -1: nothing fits.
 */
function findCut(s, p, room, minCut) {
  if (room < 1) return -1;
  const end = p + room;
  if (end >= s.length) return s.length;
  const floor = Math.max(minCut, p + Math.floor(room / 2));
  for (const isCut of [isParagraphCut, isLineCut, isSentenceCut, isSpaceCut]) {
    for (let c = end; c >= floor; c -= 1) if (isCut(s, c)) return c;
  }
  for (let c = Math.min(end, floor - 1); c >= minCut; c -= 1) if (isSpaceCut(s, c) || isLineCut(s, c)) return c;
  for (let c = end; c >= minCut; c -= 1) if (isGraphemeCut(s, c)) return c;
  for (let c = end; c >= minCut; c -= 1) if (!splitsPair(s, c)) return c;
  return -1;
}

const isFenceLineAt = (s, at) => s.startsWith(FENCE, at) && (at === 0 || s[at - 1] === '\n') && (at + 3 === s.length || s[at + 3] === '\n');

/** The next chunk starts at the next visible character, keeping the indentation of its line. */
function nextStart(s, c) {
  let f = c;
  while (f < s.length && /\s/.test(s[f])) f += 1;
  const nl = s.lastIndexOf('\n', f - 1);
  return nl >= c ? nl + 1 : f;
}

/**
 * Split converted text into WhatsApp messages.
 * @param {string} text
 * @param {{max?:number, maxChunks?:number, prefix?:string, tail?:string}} [options]
 * @returns {string[]} every entry at most `max` UTF-16 code units
 */
export function chunk(text, { max = 3500, maxChunks = 3, prefix, tail } = {}) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) return [];
  const limit = Number.isFinite(Number(max)) && Number(max) >= 1 ? Math.floor(Number(max)) : 3500;
  const most = Number.isFinite(Number(maxChunks)) ? Math.max(1, Math.floor(Number(maxChunks))) : 3;
  const tailText = tail === undefined ? DEFAULT_TAIL : String(tail ?? '');
  let head = typeof prefix === 'string' && prefix ? `${prefix} ` : '';

  // End offsets of the lines that are exactly ```; a position is in code after an odd number of them.
  let fenceEnds = [];
  for (let at = 0, k = 0; k <= body.length; k += 1) {
    if (k === body.length || body[k] === '\n') {
      if (k - at === 3 && body.startsWith(FENCE, at)) fenceEnds.push(k);
      at = k + 1;
    }
  }
  const inCodeAt = (pos) => {
    let n = 0;
    for (const end of fenceEnds) { if (end > pos) break; n += 1; }
    return n % 2 === 1;
  };
  const fenceWithin = (from, to) => fenceEnds.some((end) => end - 3 >= from && end - 3 < to);
  // A body that starts with a fence line puts the prefix on a line of its own.
  const compose = ({ nl, open, content, close, tailPart }) => `${head}${nl ? '\n' : ''}${open ? `${FENCE}\n` : ''}${content}${close ? `\n${FENCE}` : ''}${tailPart}`;

  const whole = compose({ nl: head && isFenceLineAt(body, 0), open: false, content: body, close: inCodeAt(body.length), tailPart: '' });
  if (whole.length <= limit) return [whole];

  // " (i/n)" or "\n(i/n)": sized for the widest i and n. Room too small for
  // the extras: drop the prefix, then the markers, then fence repairs.
  const markWidth = 4 + 2 * String(most).length;
  let marks = most > 1;
  const reserve = () => head.length + (head ? 1 : 0) + (marks ? markWidth : 0) + (fenceEnds.length ? 8 : 0);
  if (limit - reserve() < 8) head = '';
  if (limit - reserve() < 8) marks = false;
  if (limit - reserve() < 8) fenceEnds = [];
  const markRoom = marks ? markWidth : 0;

  const parts = [];
  let p = 0;
  while (p < body.length) {
    const last = parts.length === most - 1;
    const open = inCodeAt(p);
    const nl = head && (open || isFenceLineAt(body, p)) ? 1 : 0;
    const lead = head.length + nl + (open ? FENCE.length + 1 : 0);
    const closeAtEnd = inCodeAt(body.length);
    if (lead + (body.length - p) + (closeAtEnd ? 4 : 0) + markRoom <= limit) {
      parts.push({ nl, open, content: body.slice(p), close: closeAtEnd, tailPart: '' });
      break;
    }
    let tailPart = last && tailText ? `\n${tailText}` : '';
    let room = limit - lead - markRoom - tailPart.length;
    let closeRoom = open || fenceWithin(p, p + room) ? 4 : 0;
    if (tailPart && room - closeRoom < MIN_TAIL_ROOM) {
      room += tailPart.length;
      tailPart = '';
      closeRoom = open || fenceWithin(p, p + room) ? 4 : 0;
    }
    room -= closeRoom;
    let first = p;
    while (first < body.length && /\s/.test(body[first])) first += 1;
    if (first > p && first >= p + room) { p = first; continue; } // an indentation wider than the room
    let c = findCut(body, p, room, first + 1);
    if (c < 0) break; // not even one character fits
    if (inCodeAt(c)) {
      const lineStart = body.lastIndexOf('\n', c - 1) + 1;
      if (isFenceLineAt(body, c + 1)) c += FENCE.length + 1; // take the closing fence: it costs what the repair would
      else if (lineStart - 1 > p && body.slice(lineStart, c) === FENCE && body.slice(p, lineStart - 1).trim()) c = lineStart - 1; // don't end on an opening fence
    }
    const next = nextStart(body, c);
    const done = next >= body.length;
    parts.push({ nl, open, content: body.slice(p, c).trimEnd(), close: inCodeAt(c), tailPart: done ? '' : tailPart });
    if (done || last) break;
    p = next;
  }

  const n = parts.length;
  return parts.map((part, i) => {
    const out = compose(part);
    if (n < 2 || !marks) return out;
    return `${out}${out.endsWith(`\n${FENCE}`) || out === FENCE ? '\n' : ' '}(${i + 1}/${n})`;
  });
}

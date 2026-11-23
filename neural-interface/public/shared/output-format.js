// ═══════════════════════════════════════════
// SynaBun Neural Interface — an agent's answer as a readable document: the decisions
// ═══════════════════════════════════════════
//
// The six side panels (Assistant, Claude Code, Codex, OpenCode, Antigravity, Maritaca) show an agent's Markdown
// through the same sanitiser and, since this module, as the same document: one type scale, one spacing rhythm,
// one table, one code block. This is the part that needs no page: the words, the markup added to a panel's
// SANITISED Markdown (so a stream, a re-render, a morph and a stored transcript all keep it, exactly like the
// Copy button of code-copy.js), and what a table copies. ui-output.js gives it the page: the stylesheet, the
// one click listener per document, the wider view of a table.
//
// What it adds, and nothing else:
//   · a frame around every table (it wraps at words to fit the panel, and scrolls sideways inside the frame only
//     when its columns cannot fit), with Copy and, for a table worth it, Expand; a numeric column is
//     right-aligned and a column of sentences keeps a readable width;
//   · a class on a task-list item (the sanitiser turns its checkbox into ☑ / ☐: no bullet beside the box);
//   · the language of a fenced block on its <pre> (drawn as a label) and the lines of a diff as add / remove.
//
// Run it on the sanitiser's output, never before: the allowlist takes a model's own div, button and class out,
// so a reply cannot forge a frame or a button. It never adds a link, a handler or a style.
//
// No imports and no `document`: loaded by `node --test` as it is, and by the Markdown renderers.

/** The English of `output.*` in i18n/en.json (tests/output-format.test.mjs keeps them equal). */
export const OUTPUT_COPY = Object.freeze({
  copy: 'Copy',
  copied: 'Copied',
  failed: 'Not copied',
  copyTable: 'Copy table',
  tableCopied: 'Table copied',
  tableFailed: 'Could not copy the table.',
  expand: 'Expand',
  expandTable: 'Open the table in a wider view',
  tableTitle: 'Table',
  tableSize: '{rows} rows · {columns} columns',
  close: 'Close',
});

export const TABLE_FRAME_CLASS = 'sb-table';
export const TABLE_SCROLL_CLASS = 'sb-table-scroll';
export const TABLE_TOOLS_CLASS = 'sb-table-tools';
export const TABLE_BUTTON_CLASS = 'sb-table-btn';
export const NUMERIC_CLASS = 'sb-num';
export const LONG_CLASS = 'sb-long';
/** A column with a cell of at least this many characters in at least LONG_CELL_WORDS words holds sentences. */
export const LONG_CELL_CHARS = 28;
export const LONG_CELL_WORDS = 4;
export const TASK_CLASS = 'sb-task';

/** How long "Copied" (and the failure) stays on a table's button: the code block's timing. */
export const OUTPUT_FEEDBACK_MS = Object.freeze({ copied: 1500, failed: 4000 });

let translate = null;

/** Where a sentence comes from in the active locale: `fn(key, params)`, or a falsy value for the English. */
export function setOutputTranslator(fn) { translate = typeof fn === 'function' ? fn : null; }

/** An `output.*` sentence in the active locale, else the English. */
export function outputText(key, params = {}) {
  let text = '';
  try { text = translate?.(key, params) || ''; } catch { text = ''; }
  if (!text || typeof text !== 'string') text = OUTPUT_COPY[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? String(params[name]) : whole));
}

const escAttr = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A number as a reader sees one: an optional sign or comparison, a currency, digits with their separators, and a
// short unit (%, ms, s, MB, k, ×). A date (2026-11-21) or a time (12:30) is not one: nothing is aligned by it.
const NUMERIC_RE = /^[+\-−–~≈<>≤≥]?\s?(?:US\$|R\$|[$€£¥])?\s?\d[\d.,\s_]*(?:\s?(?:%|×|[a-zA-Zµ°]{1,5}(?:\/[a-zA-Z]{1,4})?))?$/;
const BLANK_RE = /^(?:|[-–—]|n\/a|—)$/i;

/** True when a cell's text is a number (see above). */
export function isNumericText(text) { return NUMERIC_RE.test(String(text ?? '').trim()); }

/**
 * Which columns of a table hold numbers: every filled cell of the body is one, and at least one is filled.
 * @param {string[][]} bodyRows the body's cells as text
 * @returns {boolean[]} one flag per column
 */
export function numericColumns(bodyRows) {
  const rows = Array.isArray(bodyRows) ? bodyRows : [];
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const flags = [];
  for (let col = 0; col < width; col += 1) {
    let filled = 0;
    let numeric = true;
    for (const row of rows) {
      const text = String(row[col] ?? '').trim();
      if (BLANK_RE.test(text)) continue;
      filled += 1;
      if (!NUMERIC_RE.test(text)) { numeric = false; break; }
    }
    flags.push(numeric && filled > 0);
  }
  return flags;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
// The text of a serialised cell: its tags out, the few entities a serialiser writes read back.
const cellText = (html) => String(html).replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name]).trim();

const ROW_RE = /<tr>([\s\S]*?)<\/tr>/g;
const CELL_RE = /<(t[hd])((?:\s[^>]*)?)>([\s\S]*?)<\/t[hd]>/g;

/**
 * Which columns of a table hold sentences: some cell (the header's too) is LONG_CELL_CHARS or longer and has
 * LONG_CELL_WORDS words or more. A long path or identifier is one word: it wraps where it can, and is not one.
 * @param {string[][]} rows every row's cells as text
 * @returns {boolean[]} one flag per column
 */
export function longColumns(rows) {
  const flags = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    row.forEach((cell, col) => {
      const text = String(cell ?? '').trim();
      if (text.length >= LONG_CELL_CHARS && text.split(/\s+/).length >= LONG_CELL_WORDS) flags[col] = true;
    });
  }
  return Array.from(flags, Boolean);
}

// A sanitised table with `class="sb-num"` on the cells of its numeric columns and `class="sb-long"` on those of
// its columns of sentences. A numeric column the writer aligned (`---:` in Markdown: the sanitiser keeps
// `align`) is left as written, and so is a table that holds a table.
function markColumns(table) {
  if (table.indexOf('<table', 1) !== -1) return table;
  const bodyStart = table.indexOf('<tbody>');
  const head = bodyStart === -1 ? '' : table.slice(0, bodyStart);
  const body = bodyStart === -1 ? table : table.slice(bodyStart);
  const rows = [];
  for (const row of body.matchAll(ROW_RE)) {
    const cells = [...row[1].matchAll(CELL_RE)];
    if (cells.some((cell) => /\s(?:colspan|rowspan)=/i.test(cell[2]))) return table;
    rows.push(cells.map((cell) => cellText(cell[3])));
  }
  const bodyRows = bodyStart === -1 ? rows.slice(1) : rows.slice();
  if (!bodyRows.length) return table;
  // The header's cells count for a column's width, wherever the header is.
  if (bodyStart !== -1) for (const row of head.matchAll(ROW_RE)) rows.push([...row[1].matchAll(CELL_RE)].map((cell) => cellText(cell[3])));
  const numeric = numericColumns(bodyRows);
  const long = longColumns(rows);
  if (!numeric.some(Boolean) && !long.some(Boolean)) return table;
  const mark = (part) => part.replace(ROW_RE, (whole, inner) => {
    let col = -1;
    return `<tr>${inner.replace(CELL_RE, (cell, tag, attrs, content) => {
      col += 1;
      if (/\sclass=/i.test(attrs)) return cell;
      const cls = numeric[col] && !/\salign=/i.test(attrs) ? NUMERIC_CLASS : long[col] && !numeric[col] ? LONG_CLASS : '';
      return cls ? `<${tag}${attrs} class="${cls}">${content}</${tag}>` : cell;
    })}</tr>`;
  });
  return mark(head) + mark(body);
}

/** How many body rows and columns a serialised table has. */
export function tableSize(table) {
  const rows = [...String(table).matchAll(ROW_RE)];
  const hasHead = /<thead>/i.test(table);
  const columns = rows.length ? [...rows[0][1].matchAll(CELL_RE)].length : 0;
  return { rows: Math.max(0, rows.length - (hasHead || rows.length > 1 ? 1 : 0)), columns };
}

function tableButton(action, label, name) {
  return `<button type="button" class="${TABLE_BUTTON_CLASS}" data-sb-act="${action}" data-label="${escAttr(label)}" aria-label="${escAttr(name)}"></button>`;
}

/** The strip above a table: its size (drawn by CSS for a table that is worth it), Expand and Copy. */
export function tableToolsHtml({ rows = 0, columns = 0 } = {}) {
  return `<div class="${TABLE_TOOLS_CLASS}" data-rows="${rows}" data-columns="${columns}" data-label="${escAttr(outputText('tableSize', { rows, columns }))}">`
    + `${tableButton('expand', outputText('expand'), outputText('expandTable'))}${tableButton('copy', outputText('copy'), outputText('copyTable'))}</div>`;
}

const FRAME_OPEN = `<div class="${TABLE_SCROLL_CLASS}">`;

/** One sanitised `<table>…</table>` inside its frame. */
export function tableFrameHtml(table) {
  const marked = markColumns(table);
  return `<div class="${TABLE_FRAME_CLASS}">${tableToolsHtml(tableSize(marked))}${FRAME_OPEN}${marked}</div></div>`;
}

// Every outermost table of a serialised document through `fn`; one already inside a frame is left alone, so the
// result is the same however often this runs.
function mapTables(html, fn) {
  const token = /<table>|<\/table>/gi;
  let out = '';
  let last = 0;
  let depth = 0;
  let start = -1;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    if (match[0][1] !== '/') {
      if (depth === 0) start = match.index;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth !== 0) continue;
      const end = match.index + match[0].length;
      const framed = html.slice(Math.max(0, start - FRAME_OPEN.length), start) === FRAME_OPEN;
      out += html.slice(last, start) + (framed ? html.slice(start, end) : fn(html.slice(start, end)));
      last = end;
    }
  }
  return out + html.slice(last);
}

const TASK_RE = /<li>(\s*(?:<p>)?)(☑|☐) /g;
const LANG_RE = /<pre><code class="language-([\w+#.-]{1,40})">/g;
const DIFF_RE = /(<pre data-lang="diff"><code class="language-diff">)([\s\S]*?)(<\/code>)/g;

/** The kind of a diff's line as a class (`sb-diff-add`, `-del`, `-hunk`, `-file`), or '' for a line of context. */
export function diffLineClass(line) {
  if (/^(?:\+\+\+ |--- |diff |index )/.test(line)) return 'sb-diff-file';
  if (line.startsWith('@@')) return 'sb-diff-hunk';
  if (line.startsWith('+')) return 'sb-diff-add';
  if (line.startsWith('-')) return 'sb-diff-del';
  return '';
}

// The lines of a diff block, each added, removed, hunk or file line in a span of its kind. The text is untouched
// (what the block copies is what was written); a block that already holds markup is left as it is.
export function markDiffLines(body) {
  if (body.includes('<')) return body;
  return body.split('\n').map((line) => {
    const cls = diffLineClass(line);
    return cls && line ? `<span class="${cls}">${line}</span>` : line;
  }).join('\n');
}

/**
 * Sanitised Markdown HTML as a readable document: tables in their frames, task items, code languages, diff lines.
 * Idempotent. `diff: false` leaves a diff block's lines alone (a panel that highlights code itself).
 */
export function withOutputFrames(html, { diff = true } = {}) {
  let out = typeof html === 'string' ? html : '';
  if (!out) return out;
  if (/<table>/i.test(out)) out = mapTables(out, tableFrameHtml);
  if (out.includes('☑') || out.includes('☐')) {
    out = out.replace(TASK_RE, (whole, lead, box) => `<li class="${TASK_CLASS}${box === '☑' ? ` ${TASK_CLASS}-done` : ''}">${lead}<span class="${TASK_CLASS}-box">${box}</span> `);
  }
  if (out.includes('<pre><code class="language-')) out = out.replace(LANG_RE, '<pre data-lang="$1"><code class="language-$1">');
  if (diff && out.includes('data-lang="diff"')) out = out.replace(DIFF_RE, (whole, open, body, close) => open + markDiffLines(body) + close);
  return out;
}

const tagOf = (node) => String(node?.localName || node?.nodeName || '').toLowerCase();

function nodeText(node) {
  let out = '';
  const walk = (parent) => {
    for (const child of parent.childNodes || []) {
      if (child.nodeType === 3 || child.nodeType === 4) { out += child.data ?? child.nodeValue ?? ''; continue; }
      if (child.nodeType !== 1) continue;
      const tag = tagOf(child);
      if (tag === 'button') continue;
      if (tag === 'br') { out += ' '; continue; }
      walk(child);
    }
  };
  walk(node);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * A table element's cells as text, row by row (the header first). Works on any DOM, a test's included.
 * @returns {string[][]}
 */
export function tableMatrix(table) {
  const rows = [];
  const walk = (node) => {
    for (const child of node?.childNodes || []) {
      if (child.nodeType !== 1) continue;
      const tag = tagOf(child);
      if (tag === 'tr') rows.push([...child.childNodes].filter((cell) => cell.nodeType === 1 && /^t[hd]$/.test(tagOf(cell))).map(nodeText));
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') walk(child);
    }
  };
  walk(table);
  return rows;
}

/** A table as tab-separated text: what a spreadsheet, a chat and a terminal all read. */
export function matrixToTsv(matrix) {
  return (matrix || []).map((row) => row.map((cell) => String(cell ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
}

const escText = (value) => String(value ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** The same table as plain, unstyled HTML (text only): what a document or a mail pastes as a table. */
export function matrixToHtml(matrix) {
  const rows = matrix || [];
  if (!rows.length) return '';
  const line = (row, tag) => `<tr>${row.map((cell) => `<${tag}>${escText(cell)}</${tag}>`).join('')}</tr>`;
  return `<table><thead>${line(rows[0], 'th')}</thead><tbody>${rows.slice(1).map((row) => line(row, 'td')).join('')}</tbody></table>`;
}

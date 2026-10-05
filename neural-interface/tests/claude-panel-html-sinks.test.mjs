// V01: values reaching HTML outside the Markdown sanitiser.
//
// The Claude panel builds markup in two ways. Markdown (what a model, a command
// or a transcript says) goes through md() and the allowlist sanitiser: that is
// tests/claude-panel-markdown.test.mjs. Everything else is markup the panel
// writes itself, as templates assigned to innerHTML, with values interpolated
// into it: a session's title and tag, a branch, a file name, a tool, hook or
// MCP server name. Those values are not ours. This file holds that class shut:
//
//   1. one escaper (escapeHtml in cp/cp-markdown.js), safe as element text and
//      inside a quoted attribute; the monolith's esc() / escH() are it;
//   2. the three sinks the review named, tested with hostile values;
//   3. a guard over the source: every interpolation into markup, in the monolith
//      and in every cp/ module, is escaped, sanitised, structurally safe, or on
//      the reviewed allowlist below. A new raw `${value}` in markup fails here.
//
// The monolith cannot be imported outside a browser, and the suite's DOM
// stand-in does not parse HTML, so markup is tested as strings.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniElement } from './fixtures/mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, '..', 'public', 'shared');
const read = (rel) => readFileSync(join(SHARED, rel), 'utf8').replace(/\r\n/g, '\n');
const load = (rel) => import(new URL(`../public/shared/${rel}`, import.meta.url));

const MONOLITH = 'ui-claude-panel.js';
const CP_FILES = readdirSync(join(SHARED, 'cp')).filter(f => f.endsWith('.js')).sort().map(f => `cp/${f}`);
const panel = read(MONOLITH);

/** `re` matches nothing in `src` (a failure prints the matches, not the file). */
function absent(src, re, message) {
  assert.deepEqual(src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) || [], [], message);
}

/** The body of a function declaration in the monolith, up to the next one. */
function fnBody(signature) {
  const start = panel.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = panel.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// Values an attacker would put in a tag, a branch, a file name.
const HOSTILE = [
  'x" onmouseover="alert(1)" x="',
  "' onfocus='alert(1)",
  '` onload=`alert(1)',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  'a&b',
];

/** No character of a value can end a quoted attribute or open a tag in `html`. */
function assertInert(html, what) {
  assert.doesNotMatch(html, /onmouseover="|onfocus='|onload=`|<img|<script/, `${what}: the value's markup is live`);
}

// ── 1. The escaper ──

test('escapeHtml neutralises a value for element text and for quoted attributes', async () => {
  const { escapeHtml } = await load('cp/cp-markdown.js');
  assert.equal(escapeHtml('x" onmouseover="alert(1)" x="'), 'x&quot; onmouseover=&quot;alert(1)&quot; x=&quot;');
  assert.equal(escapeHtml("' onfocus='x"), '&#39; onfocus=&#39;x');
  assert.equal(escapeHtml('`a`'), '&#96;a&#96;');
  assert.equal(escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;', 'an entity in the value is text, not an entity');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(false), 'false');
  for (const v of HOSTILE) {
    const out = escapeHtml(v);
    assert.doesNotMatch(out, /[<>"'`]/, `no markup character survives in ${JSON.stringify(out)}`);
    // Whatever quotes the attribute, the value cannot close it.
    for (const q of ['"', "'"]) assert.equal(`<a title=${q}${out}${q}>`.split(q).length, 3, 'the attribute has its two quotes only');
  }
});

test('classToken leaves only what a class name is made of', async () => {
  const { classToken } = await load('cp/cp-markdown.js');
  assert.equal(classToken('warn'), 'warn');
  assert.equal(classToken('needs-auth'), 'needs-auth');
  assert.equal(classToken('x" onmouseover="alert(1)'), 'xonmouseoveralert1');
  assert.equal(classToken('a b'), 'ab', 'a value cannot add a second class');
  assert.equal(classToken(null), '');
  assert.equal(classToken(undefined), '');
});

test('the panel has one escaper: esc(), escH() and cpCtx.esc are escapeHtml', () => {
  assert.match(panel, /import \{[^}]*\bescapeHtml\b[^}]*\} from '\.\/cp\/cp-markdown\.js';/);
  assert.match(panel, /\nfunction esc\(s\) \{ return escapeHtml\(s\); \}\n/);
  assert.match(panel, /\nfunction escH\(s\) \{ return escapeHtml\(s\); \}\n/);
  assert.match(panel, /setCpCtx\(\{\n\s+md: \(t\) => md\(t\),\n\s+esc: \(t\) => esc\(t\),/, 'the cp/ modules get the same escaper');
  // No second escaper anywhere: a chain of entity replaces lives in cp-markdown.js only.
  for (const file of [MONOLITH, ...CP_FILES]) {
    if (file === 'cp/cp-markdown.js') continue;
    absent(read(file), /replace\([^)]*,\s*'&(?:amp|lt|gt|quot|#39|#96);'\)/, `${file} escapes by hand`);
  }
});

test('an escaped value is never assigned to a DOM property', () => {
  // textContent, title, value, className and setAttribute take text: escaping
  // there would show the entities.
  for (const file of [MONOLITH, ...CP_FILES]) {
    absent(
      read(file),
      /\.(?:textContent|title|value|className|placeholder)\s*=[^;\n]*\b(?:esc|escH|escapeHtml)\(|setAttribute\([^;\n]*\b(?:esc|escH|escapeHtml)\(/,
      `${file} escapes a value for a DOM property`,
    );
  }
});

// ── 2. The three sinks of the review ──

const count = (text, ch) => text.split(ch).length - 1;
/** The markup characters of `html`, counted: a value that stays inert adds none. */
const shape = (html) => ['<', '>', '"', "'", '`'].map(ch => count(html, ch));

test('session menu: a hostile tag, branch, title or id stays inert in the row', async () => {
  const { sessionRowParts } = await load('cp/cp-sessions.js');
  assert.equal(typeof sessionRowParts, 'function', 'cp/cp-sessions.js exports sessionRowParts');
  // The pieces as the panel's template places them.
  const place = (row) => `<div class="cp-sess-prompt">${row.label}</div><button data-sid="${row.sid}" title="${row.tagTitle}">#</button><div class="cp-sess-meta">${row.meta}</div>`;
  const plain = place(sessionRowParts({ label: 'a', sessionId: 'a', tag: 'a', branch: 'a', messageCount: 0, when: 'a' }));
  for (const v of HOSTILE) {
    const row = sessionRowParts({ label: v, sessionId: v, tag: v, branch: v, messageCount: v, when: v });
    const html = place(row);
    assertInert(html, `row for ${JSON.stringify(v)}`);
    assert.deepEqual(shape(html), shape(plain), `the value adds no tag and no quote: ${html}`);
    for (const part of [row.label, row.sid, row.tagTitle]) assert.doesNotMatch(part, /[<>"'`]/, `${JSON.stringify(part)} cannot leave its text or its attribute`);
    assert.doesNotMatch(row.meta, /msgs/, 'a count that is not a number is not shown');
  }
  const row = sessionRowParts({ label: 'Fix the gauge', sessionId: 'abc-123', tag: 'x" onmouseover="alert(1)" x="', branch: 'main', messageCount: 12, when: '2h ago' });
  assert.equal(row.tagTitle, 'Tag: x&quot; onmouseover=&quot;alert(1)&quot; x=&quot; (click to change or clear)');
  assert.equal(row.label, 'Fix the gauge');
  assert.equal(row.sid, 'abc-123');
  assert.equal(row.meta, '<span>2h ago</span><span class="cp-sess-branch">main</span><span class="cp-sess-branch cp-sess-tag" title="Tag">#x&quot; onmouseover=&quot;alert(1)&quot; x=&quot;</span><span>12 msgs</span>');
  assert.equal(sessionRowParts({ label: 'a' }).tagTitle, 'Tag this session');
  assert.equal(sessionRowParts({ messageCount: '12' }).meta, '<span></span><span>12 msgs</span>');
  assert.equal(sessionRowParts({ tag: null, branch: null, sessionId: null }).meta, '<span></span>');
  assert.equal(sessionRowParts().meta, '<span></span>');
});

test('session menu: the row template takes the session only through sessionRowParts', () => {
  const item = fnBody('function cpSessRenderItem(s, projectPath, menu) {');
  assert.match(item, /const row = sessionRowParts\(\{/);
  const markup = /item\.innerHTML = `([\s\S]*?)`;\n/.exec(item);
  assert.ok(markup, 'the row template');
  assert.match(markup[1], /title="\$\{row\.tagTitle\}"/, 'the tag tooltip is the escaped part');
  assert.match(markup[1], /<div class="cp-sess-prompt">\$\{row\.label\}<\/div>/);
  assert.match(markup[1], /<div class="cp-sess-meta">\$\{row\.meta\}<\/div>/);
  assert.equal((item.match(/data-sid="\$\{row\.sid\}"/g) || []).length, 3, 'archive, unarchive and rename carry the escaped id');
  absent(item, /data-sid="\$\{(?!row\.sid\})/, 'no other id in data-sid');
  absent(item, /\$\{[^}]*\bs\.(?:tag|gitBranch|sessionId|messageCount|title|firstPrompt)\b[^}]*\}[^`\n]*</, 'no session value is interpolated into markup in this function');
  // The search box of the same menu: the query is an attribute value.
  assert.match(fnBody('async function renderSessionMenu() {'), /value="\$\{escH\(_cpSessSearch\)\}"/);
});

test('plan card: a hostile file name stays inert in the summary', async () => {
  const { planCardSummaryHtml } = await load('cp/cp-tool-cards.js');
  assert.equal(typeof planCardSummaryHtml, 'function', 'cp/cp-tool-cards.js exports planCardSummaryHtml');
  assert.match(planCardSummaryHtml('/repo/.claude/plans/next.md'), /<span class="plan-file">next\.md<\/span>/);
  assert.match(planCardSummaryHtml('C:\\repo\\.claude\\plans\\next.md'), /<span class="plan-file">next\.md<\/span>/);
  assert.match(planCardSummaryHtml(''), /<span class="plan-file">plan\.md<\/span>/);
  assert.match(planCardSummaryHtml(undefined), /<span class="plan-file">plan\.md<\/span>/);
  const plain = planCardSummaryHtml('plan.md');
  for (const v of ['<img src=x onerror=alert(1)>.md', '"><svg onload=alert(1)>.md', "a'b`c.md", '<script>alert(1)<script>.md', 'a&b.md']) {
    const html = planCardSummaryHtml(`/repo/.claude/plans/${v}`);
    assertInert(html, `plan card for ${JSON.stringify(v)}`);
    assert.doesNotMatch(html, /<svg/);
    assert.deepEqual(shape(html), shape(plain), `the name adds no tag and no quote: ${html}`);
  }
  assert.match(planCardSummaryHtml('/p/<b>.md'), /<span class="plan-file">&lt;b&gt;\.md<\/span>/);
  const body = fnBody('function buildPlanCard(block) {');
  assert.match(body, /card\.innerHTML = planCardSummaryHtml\(i\.file_path\);/);
  absent(body, /\$\{fileName\}|plan-file/, 'the file name is not interpolated in the monolith');
});

test('branch and project pickers: a hostile name is a value and a label, never markup', async () => {
  const { fillSelectOptions } = await load('cp/cp-sessions.js');
  assert.equal(typeof fillSelectOptions, 'function', 'cp/cp-sessions.js exports fillSelectOptions');
  const doc = { createElement: (tag) => new MiniElement(tag) };
  const select = new MiniElement('select');
  select.appendChild(new MiniElement('option'));
  const hostile = 'x"><img src=x onerror=alert(1)>';
  fillSelectOptions(select, [{ value: '', label: 'All branches' }, { value: hostile, label: hostile }, { value: 'main' }], doc);
  assert.equal(select.children.length, 3, 'the old options are replaced');
  assert.deepEqual(select.children.map(o => o.tagName), ['OPTION', 'OPTION', 'OPTION']);
  assert.deepEqual(select.children.map(o => [o.value, o.textContent]), [['', 'All branches'], [hostile, hostile], ['main', 'main']]);
  assert.equal(select.innerHTML, '', 'nothing is parsed as markup');
  for (const o of select.children) assert.equal(o.innerHTML, '');
  fillSelectOptions(null, [{ value: 'a' }], doc);
  fillSelectOptions(select, null, doc);
  assert.equal(select.children.length, 0);

  // Both branch pickers of the monolith use it; neither writes a branch into markup.
  assert.match(fnBody('async function cpSessLoadBatch(menu, listEl, refresh = false) {'), /fillSelectOptions\(branchSelect, \[\{ value: '', label: 'All branches' \}, \.\.\.branches\.map\(b => \(\{ value: b, label: b \}\)\)\]\);/);
  assert.match(panel, /fillSelectOptions\(branchSel, branches\.map\(b => \(\{ value: b, label: b \}\)\)\);/);
  absent(panel, /\$\{b\}|\$\{escH\(b\)\}|\$\{b\.replace\(/, 'no branch is interpolated');
  // The project picker of the same dialog is a template: value and label are escaped.
  assert.match(panel, /<option value="\$\{esc\(p\.path\)\}">\$\{esc\(p\.name\)\}<\/option>/);
  absent(panel, /<option value="\$\{(?!esc\()/, 'an option built as markup escapes its value');
  absent(panel, />\$\{(?!esc\()[^}]*\}<\/option>/, 'and its label');
});

test('no markup is appended to innerHTML, and the legacy quote-only escape is gone', () => {
  for (const file of [MONOLITH, ...CP_FILES]) {
    const src = read(file);
    absent(src, /innerHTML\s*\+=/, `${file}: innerHTML += re-parses what is already there`);
    absent(src, /\.replace\(\/"\/g, '&quot;'\)/, `${file}: escaping the quote alone leaves the text raw`);
  }
});

test('counts shown in markup are numbers', () => {
  // The context reading is in the context settings popover, built as elements
  // and text; its counts are numbers before they are added up or formatted.
  const reading = read('cp/cp-context-model.js');
  for (const name of ['cacheRead', 'cacheWrite', 'inputTokens']) assert.match(reading, new RegExp(`Number\\(u\\.${name}\\) \\|\\| 0`), `${name} is coerced`);
  assert.match(reading, /export function fmtTokens\(n\) \{\n\s+const v = Number\(n\) \|\| 0;/, 'fmtTokens formats a number, never a string');
  absent(read('cp/cp-context-menu.js'), /innerHTML|outerHTML|insertAdjacentHTML/, 'the popover takes no markup');
  const ctx = fnBody('function _showContextUsage(tab, detail = \'summary\') {');
  assert.match(ctx, /const total = \(Number\(u\.inputTokens\) \|\| 0\) \+ \(Number\(u\.cacheRead\) \|\| 0\) \+ \(Number\(u\.cacheWrite\) \|\| 0\);/);
  // The window is made a number where it is computed, so the gauge and /context
  // (whose lines an older contract test pins as plain calls) get one.
  assert.match(ctx, /const cw = _contextWindowFor\(tab\);/);
  assert.match(fnBody('function _contextWindowFor(tab) {'), /return Number\(gaugeContextWindow\(\{[\s\S]*?\}\)\) \|\| 0;/);
  const diff = read('cp/cp-diff.js');
  assert.match(diff, /const add = Number\(stats\?\.add\) \|\| 0;\n\s+const del = Number\(stats\?\.del\) \|\| 0;/);
});

test('an icon comes from the fixed maps, whatever the tool is called', () => {
  assert.match(panel, /if \(Object\.prototype\.hasOwnProperty\.call\(TOOL_ICONS, name\)\) return TOOL_ICONS\[name\];/);
  assert.match(panel, /if \(Object\.prototype\.hasOwnProperty\.call\(SYNABUN_TOOLS, key\)\) return SYNABUN_TOOLS\[key\];/);
});

test('a class name built from a value is a token', () => {
  // `cp-info-${tone}`, `cp-chip-${tone}`, `cp-hook-${outcome}`: classToken(), or
  // a choice between two fixed words.
  const tones = [...panel.matchAll(/cp-(?:info|chip|hook)-\$\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(tones.length >= 7, `class names built from a value: ${tones.length}`);
  assert.deepEqual(tones.filter(t => !/^classToken\(/.test(t) && !/^[\w.]+ \? '[\w-]+' : '[\w-]+'$/.test(t)), [], 'a tone goes through classToken()');
  assert.match(panel, /el\.className = 'msg msg-info-card cp-info-' \+ classToken\(kind\);/);
});

// ── 3. The guard ──
//
// A small scanner reads a source file into its code with every string, regex
// and template literal replaced by a placeholder (§S plain string, §M string
// holding markup, §R regex, §T<n> template), and keeps each template's text and
// the code of its `${…}` interpolations. Then these must all be safe:
//
//   · every interpolation of a template that holds markup;
//   · the right-hand side of every `innerHTML =` / `outerHTML =`, the markup
//     argument of insertAdjacentHTML, and every `html:` property;
//   · every assignment to a variable named …Html / html (the panel's convention
//     for a variable that holds markup);
//   · whatever is concatenated with `+` to a markup string or template.
//
// Safe is: a literal; a call of the escaper, of classToken() or of the Markdown
// sanitiser; a number coercion; a variable named …Html (its assignments are
// checked); a ternary, `+`, `||` or `list.map(…).join('…')` of such things; or
// an expression on the allowlist of its file, each entry reviewed and explained.
// It is a guard, not a proof: it reads names, not data flow.

const WRAPPERS = ['esc', 'escH', 'escapeHtml', 'classToken', 'md', 'cpCtx.md'];
const HTML_NAME = /^[A-Za-z_$][\w$]*[hH]tml$|^html$/;
const REGEX_BEFORE = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const hasMarkup = (text) => /<\/?[a-zA-Z!]/.test(text);

function scanSource(src) {
  const templates = [];
  let pos = 0;
  const lineAt = (p) => count(src.slice(0, p), '\n') + 1;

  function readString(quote) {
    const start = pos++;
    while (pos < src.length) {
      const c = src[pos];
      if (c === '\\') { pos += 2; continue; }
      if (c === quote) { pos++; return src.slice(start + 1, pos - 1); }
      if (c === '\n') break;
      pos++;
    }
    throw new Error(`unterminated string at line ${lineAt(start)}`);
  }
  function readRegex() {
    const start = pos++;
    let inClass = false;
    while (pos < src.length) {
      const c = src[pos];
      if (c === '\\') { pos += 2; continue; }
      if (c === '\n') throw new Error(`unterminated regex at line ${lineAt(start)}`);
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { pos++; break; }
      pos++;
    }
    while (/[a-z]/.test(src[pos] || '')) pos++;
  }
  function readTemplate() {
    const tpl = { id: templates.length, line: lineAt(pos), text: '', exprs: [], markup: false };
    templates.push(tpl);
    pos++;
    while (pos < src.length) {
      const c = src[pos];
      if (c === '\\') { tpl.text += src.slice(pos, pos + 2); pos += 2; continue; }
      if (c === '`') { pos++; tpl.markup = hasMarkup(tpl.text); return tpl.id; }
      if (c === '$' && src[pos + 1] === '{') { pos += 2; tpl.exprs.push(readCode(true, null)); tpl.text += '${}'; continue; }
      tpl.text += c;
      pos++;
    }
    throw new Error(`unterminated template at line ${tpl.line}`);
  }
  function regexAllowed(out) {
    const t = out.trimEnd();
    if (!t) return true;
    if (/§(?:[SMR]|T\d+)$/.test(t)) return false;
    const last = t[t.length - 1];
    if (/[)\]}]/.test(last)) return false;
    if (/[\w$]/.test(last)) return REGEX_BEFORE.has(/[\w$]+$/.exec(t)[0]);
    return true;
  }
  /** Code up to the end (or to the `}` that closes a `${`), literals replaced. `at` collects the source position of each character. */
  function readCode(untilBrace, at) {
    let out = '';
    let depth = 0;
    const emit = (text, from) => { out += text; if (at) for (let i = 0; i < text.length; i++) at.push(from); };
    while (pos < src.length) {
      const c = src[pos];
      const n = src[pos + 1];
      const from = pos;
      if (c === '/' && n === '/') { while (pos < src.length && src[pos] !== '\n') pos++; continue; }
      if (c === '/' && n === '*') { const end = src.indexOf('*/', pos + 2); pos = end < 0 ? src.length : end + 2; continue; }
      if (c === "'" || c === '"') { emit(hasMarkup(readString(c)) ? '§M' : '§S', from); continue; }
      if (c === '`') { emit(`§T${readTemplate()}`, from); continue; }
      if (c === '/' && regexAllowed(out)) { readRegex(); emit('§R', from); continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        if (untilBrace && depth === 0) { pos++; return out; }
        depth--;
      }
      emit(c, from);
      pos++;
    }
    if (untilBrace) throw new Error('unterminated ${');
    if (depth !== 0) throw new Error(`unbalanced braces (${depth})`);
    return out;
  }
  const at = [];
  const code = readCode(false, at);
  return { code, templates, lineOf: (index) => lineAt(at[index] ?? 0) };
}

const norm = (e) => e.replace(/\s+/g, ' ').replace(/ \./g, '.').trim();
const generic = (e) => norm(e).replace(/§T\d+/g, '§T');

/** Index of the bracket that closes the one at `open`. */
function closing(e, open) {
  let depth = 0;
  for (let i = open; i < e.length; i++) {
    if ('([{'.includes(e[i])) depth++;
    else if (')]}'.includes(e[i]) && --depth === 0) return i;
  }
  return -1;
}
/** Split at a top-level operator (`+`, `||`, `??`). */
function splitTop(e, op) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && e.startsWith(op, i)) {
      if (op === '+' && (e[i + 1] === '+' || e[i + 1] === '=' || e[i - 1] === '+')) continue;
      parts.push(e.slice(from, i));
      from = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(e.slice(from));
  return parts.map(norm);
}
/** The two branches of `cond ? a : b` at the top level, or null. */
function splitTernary(e) {
  let depth = 0;
  let q = -1;
  let nested = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if ('([{'.includes(c)) { depth++; continue; }
    if (')]}'.includes(c)) { depth--; continue; }
    if (depth !== 0) continue;
    if (c === '?' && e[i + 1] !== '.' && e[i + 1] !== '?' && e[i - 1] !== '?') { if (q < 0) q = i; else nested++; }
    else if (c === ':' && q >= 0) {
      if (nested) { nested--; continue; }
      return { a: norm(e.slice(q + 1, i)), b: norm(e.slice(i + 1)) };
    }
  }
  return null;
}
function stripParens(e) {
  let out = norm(e);
  while (out.startsWith('(') && closing(out, 0) === out.length - 1) out = norm(out.slice(1, -1));
  return out;
}
/** `name(…)` covering the whole expression. */
const isCallOf = (e, name) => e.startsWith(`${name}(`) && closing(e, name.length) === e.length - 1;

function auditSource(file, source, allow) {
  const { code, templates, lineOf } = scanSource(source);
  const allowed = new Set((allow.exprs || []).map(generic));
  const calls = allow.calls || [];
  const used = new Set();
  const constants = allow.constants || [];
  const problems = [];
  const checked = new Set();

  /** The parts of an expression that are not safe to put into markup (none: it is safe). */
  function offenders(raw) {
    const e = stripParens(raw);
    if (!e) return ['(nothing)'];
    if (/^§[SM]$/.test(e) || /^-?\d+(?:\.\d+)?$/.test(e) || e === 'null' || e === 'undefined') return [];
    const tpl = /^§T(\d+)$/.exec(e);
    if (tpl) { checkTemplate(templates[Number(tpl[1])]); return []; }
    if (WRAPPERS.some(w => isCallOf(e, w))) return [];
    if (isCallOf(e, 'Number') || (e.endsWith(' || 0') && isCallOf(e.slice(0, -5), 'Number'))) return [];
    if (HTML_NAME.test(e)) return [];
    if (constants.includes(e)) { used.add(e); return []; }
    if (allowed.has(generic(e))) { used.add(generic(e)); return []; }
    const call = calls.find(c => isCallOf(e, c));
    if (call) { used.add(call); return []; }
    const ternary = splitTernary(e);
    if (ternary) return [...offenders(ternary.a), ...offenders(ternary.b)];
    for (const op of ['||', '??', '+']) {
      const parts = splitTop(e, op);
      if (parts.length > 1) return parts.flatMap(offenders);
    }
    // list.map(callback).join('…'): the callback is the escaper, or returns checked markup.
    if (e.endsWith('.join(§S)')) {
      const head = e.slice(0, -'.join(§S)'.length);
      if (head.endsWith(')')) {
        let open = -1;
        for (let i = head.length - 1, depth = 0; i >= 0; i--) {
          if (')]}'.includes(head[i])) depth++;
          else if ('([{'.includes(head[i]) && --depth === 0) { open = i; break; }
        }
        if (open > 0 && head.slice(0, open).endsWith('.map')) {
          const cb = norm(head.slice(open + 1, -1));
          if (WRAPPERS.includes(cb)) return [];
          const arrow = cb.indexOf('=>');
          if (arrow >= 0) {
            const body = norm(cb.slice(arrow + 2));
            if (!body.startsWith('{')) return offenders(body);
            const returns = [...body.matchAll(/\breturn ([^;]*);/g)].map(m => m[1]);
            if (returns.length) return returns.flatMap(offenders);
          }
        }
      }
    }
    return [e];
  }
  const seen = new Set();
  function check(expr, line, kind) {
    for (const bad of offenders(expr)) {
      const key = `${line}: ${generic(bad)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push(`${file}:${line} ${kind}: ${generic(bad)}`);
    }
  }
  function checkTemplate(tpl) {
    if (checked.has(tpl.id)) return;
    checked.add(tpl.id);
    for (const expr of tpl.exprs) check(expr, tpl.line, 'interpolated into markup');
  }
  /** The expression that starts at `from`: up to a top-level stop character, or the bracket that closes its context. */
  function readForward(region, from, stops = ';,') {
    let depth = 0;
    for (let i = from; i < region.length; i++) {
      const c = region[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) return region.slice(from, i); depth--; }
      else if (depth === 0 && stops.includes(c) && !(c === '?' && region[i + 1] === '.')) return region.slice(from, i);
    }
    return region.slice(from);
  }
  /** Where the operand that ends at `to` (exclusive) starts, reading backwards. */
  function operandStart(region, to) {
    let i = to;
    let depth = 0;
    for (; i > 0; i--) {
      const c = region[i - 1];
      if (')]}'.includes(c)) { depth++; continue; }
      if ('([{'.includes(c)) { if (depth === 0) break; depth--; continue; }
      if (depth === 0 && !/[\w$.§]/.test(c)) break;
    }
    return i;
  }
  const isMarkupAtom = (m) => m[0] === '§M' || (m[1] != null && templates[Number(m[1])].markup);

  function auditRegion(region, line) {
    for (const m of region.matchAll(/\.(?:innerHTML|outerHTML)\s*\+?=(?!=)\s*/g)) {
      const rhs = readForward(region, m.index + m[0].length);
      check(rhs, line(m.index), 'assigned to innerHTML');
    }
    for (const m of region.matchAll(/\.insertAdjacentHTML\(\s*/g)) {
      const position = readForward(region, m.index + m[0].length);
      const markup = readForward(region, m.index + m[0].length + position.length + 1);
      check(markup, line(m.index), 'passed to insertAdjacentHTML');
    }
    for (const m of region.matchAll(/[{,]\s*html:\s*/g)) {
      const value = readForward(region, m.index + m[0].length);
      check(value, line(m.index), 'passed as html:');
    }
    for (const m of region.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\+?=(?![=>])\s*/g)) {
      if (!HTML_NAME.test(m[1])) continue;
      const rhs = readForward(region, m.index + m[0].length);
      check(rhs, line(m.index), `assigned to ${m[1]}`);
    }
    // a + '<markup>' + b: every operand of the chain around a markup literal.
    for (const m of region.matchAll(/§M|§T(\d+)/g)) {
      if (!isMarkupAtom(m)) continue;
      let i = m.index + m[0].length;
      for (;;) {
        const plus = /^\s*\+(?![+=])\s*/.exec(region.slice(i, i + 200));
        if (!plus) break;
        const operand = readForward(region, i + plus[0].length, ';,+?:');
        check(operand, line(m.index), 'concatenated to markup');
        i += plus[0].length + operand.length;
        if (!operand) break;
      }
      let end = m.index;
      for (;;) {
        const before = region.slice(Math.max(0, end - 200), end);
        const plus = /(?<![+])\+\s*$/.exec(before);
        if (!plus) break;
        let to = end - (before.length - plus.index);
        while (to > 0 && /\s/.test(region[to - 1])) to--;
        const start = operandStart(region, to);
        const operand = region.slice(start, to);
        if (!operand) break;
        check(operand, line(m.index), 'concatenated to markup');
        end = start;
      }
    }
  }

  auditRegion(code, lineOf);
  for (const tpl of templates) {
    if (tpl.markup) checkTemplate(tpl);
    for (const expr of tpl.exprs) auditRegion(expr, () => tpl.line);
  }
  // A constant on the list is a literal of this file (or another constant of the list).
  for (const name of constants) {
    const decl = new RegExp(`\\bconst ${name.replace(/\$/g, '\\$')} = (§[SM]|[A-Za-z_$][\\w$]*);`).exec(code);
    if (!decl || !(decl[1].startsWith('§') || constants.includes(decl[1]))) problems.push(`${file}: ${name} is on the list of constants and is not declared as a string literal`);
  }
  const stale = [...constants, ...allowed].filter(e => !used.has(e)).concat(calls.filter(c => !used.has(c)).map(c => `${c}(…)`));
  return { problems, stale, templates, code };
}

// The reviewed allowlist, per file. Each entry says why its value cannot carry
// markup of a session, a file, a tool, a hook, an MCP server or a model.
//   constants: names declared in that file as a string literal (the guard checks it)
//   calls:     functions whose result is markup they build safely themselves
//              (their own templates are checked by this same guard) or a constant
//   exprs:     exact expressions (strings read §S / §M, templates §T)
// Adding an entry is a security decision: prefer esc() in the template, or a
// variable named …Html.
const ALLOW = {
  [MONOLITH]: {
    constants: [
      // Inline SVG and <img> markup written in this file.
      'CLAUDE_ICON', '_CP_ICON_SVG', 'THINKING_ICON', 'ICON_CHECK', 'ICON_X', 'SYNABUN_LOGO_ICON',
      '_ICON_SEND', '_ICON_QUEUE_SEND', '_ICON_STOP', '_ICON_PLAY', '_ICON_PAUSE',
    ],
    calls: [
      'toolIconSvg',          // an icon of TOOL_ICONS / SYNABUN_* by own-property lookup, else one of two default icons
      'planCardSummaryHtml',  // cp/cp-tool-cards.js: the file name is escaped there (tested above)
      'formatSynaBunInput',   // keys and values escaped inside (its templates are checked here)
      '_infoRows',            // key and value escaped, tone through classToken()
      'row',                  // the /permissions row builder: same shape as _infoRows
    ],
    exprs: [
      // sessionRowParts() of cp/cp-sessions.js: each part is escaped there (tested above).
      'row.label', 'row.sid', 'row.tagTitle', 'row.meta',
      // Numbers. total / cw are Number()-coerced where they are read
      // (pinned by "counts shown in markup are numbers").
      'total.toLocaleString()', 'cw.toLocaleString()', 'Math.min(100, Math.round((total / cw) * 100))',
      'doneN', 'totalN',      // lengths of the todo list
      // One of a few fixed words, picked by comparing a value: never the value.
      'ic',                   // todo glyph: ✓ ◐ ○
      'cls',                  // todo state done / prog / pend; diff line class cp-diff-add / -del / -hunk / -file
      // Not markup for this page:
      'pathAttr', 'f.content',                          // buildPromptWithAttachments(): the <file path="…"> block is prompt text for the model
      'CP_STYLES',                                      // the stylesheet constant of cp/cp-styles.js, set as a <style>'s textContent
      // A stored snapshot's markup. It returns to the page only through
      // scrubStoredHtml() (tests/claude-panel-markdown.test.mjs).
      'typeof entry.html === §S ? entry.html : §S',     // _normalizeSnapshotEntry()
      '$msgs.innerHTML || §S',                          // writeSessionSnapshot(): the transcript's own markup, read to be stored
    ],
  },
  'cp/cp-agents.js': { constants: ['AGENT_ICON'] },
  'cp/cp-bash.js': { calls: ['toolIconSvg'] },                      // cpCtx.toolIconSvg: see the monolith
  'cp/cp-diff.js': {
    calls: ['toolIconSvg'],
    exprs: ['add', 'del'],                                          // statsEl(): Number()-coerced line counts (pinned above)
  },
  'cp/cp-markdown.js': {
    exprs: [
      'sanitize(parse(src), doc)',                                  // renderMarkdown(): the sanitiser's output
      'String(html ?? §S)',                                         // scrubStoredHtml(): parsed into an inert <template>, then scrubbed
    ],
  },
  'cp/cp-permissions.js': { constants: ['ICON_CHECK', 'ICON_X'], calls: ['toolIconSvg'] },
  'cp/cp-sessions.js': { exprs: ['count'] },                        // sessionRowParts(): Number(messageCount) || 0
  'cp/cp-tool-cards.js': { calls: ['cpCtx.toolIconSvg'] },
  'cp/cp-tool-results.js': { exprs: ['String(snapshot?.html || §S)'] }, // snapshotWantsResults(): a stored snapshot read with two regexes, never inserted
};
for (const file of CP_FILES) ALLOW[file] = ALLOW[file] || {};

for (const file of [MONOLITH, ...CP_FILES]) {
  test(`guard: every value that reaches markup in ${file} is escaped, sanitised or reviewed`, () => {
    const { problems, stale, templates, code } = auditSource(file, read(file), ALLOW[file]);
    absent(code, /['"`]/, 'the scanner read every string and template');
    if (file === MONOLITH) assert.ok(templates.filter(t => t.markup).length > 60, `markup templates found: ${templates.filter(t => t.markup).length}`);
    assert.deepEqual(problems, [], `raw values in markup (escape them with esc(), or review and allowlist):\n  ${problems.join('\n  ')}\n`);
    assert.deepEqual(stale, [], `allowlist entries nothing uses any more (remove them):\n  ${stale.join('\n  ')}\n`);
  });
}

test('guard: a URL reaches href, src or window.open only from a reviewed place', () => {
  // escapeHtml is no URL filter: `javascript:` has nothing to escape. Every
  // place the panel sets a URL is listed here with where the value comes from;
  // a new one fails until it is reviewed. (What a model, a tool or an MCP
  // server sends is reduced to http(s) in the DOM-free modules: httpUrl() in
  // cp-events.js and cp-tool-results.js, elicitationUrl() in
  // cp-permission-model.js, each with its own tests.)
  const reviewed = {
    [MONOLITH]: [
      'href = §S',                 // linkifyFilePaths(): '#'
      'src = §T',                  // a tool result's or a prompt's image: `data:<mime>;base64,<data>` (three places)
      'src = dataUrl',             // addImagePreview(): the data: URL of an image the user attached
      'open(§S, §S)',              // /login, /logout, the usage page: fixed https addresses
    ],
    'cp/cp-event-rows.js': ['href = c.url'],                      // citations: c.url went through httpUrl() in cp-events.js
    'cp/cp-tool-cards.js': ['href = c.url', 'href = l.url'],      // chips and result links: httpUrl() in cp-tool-results.js
    'cp/cp-permissions.js': ['open(url, §S, §S)'],                // elicitationUrl(): http(s) or ''
  };
  for (const file of [MONOLITH, ...CP_FILES]) {
    const { code, templates } = scanSource(read(file));
    const found = new Set();
    for (const m of code.matchAll(/\.(href|src)\s*=(?!=)\s*([^;]*);/g)) {
      found.add(`${m[1]} = ${generic(m[2])}`);
      const tpl = /^§T(\d+)$/.exec(norm(m[2]));
      if (tpl) assert.match(templates[Number(tpl[1])].text, /^data:\$\{\};base64,\$\{\}$/, `${file}: a ${m[1]} built from a template is a data: URL`);
    }
    for (const m of code.matchAll(/\bwindow\.open\(([^)]*)\)/g)) found.add(`open(${generic(m[1])})`);
    assert.deepEqual([...found].sort(), [...(reviewed[file] || [])].sort(), `${file}: URL sinks`);
  }
  absent(read('cp/cp-events.js') + read('cp/cp-tool-results.js'), /url: (?!httpUrl\(|url\b|o\.url|o\.sessionUrl)[^,}]*/, 'a link object takes its url from httpUrl()');
});

test('guard: it catches what it is there to catch', () => {
  const run = (source, allow = {}) => auditSource('sample.js', source, allow).problems;
  // The three shapes of the review, as they were.
  assert.equal(run('card.innerHTML = `<summary><span class="plan-file">${fileName}</span></summary>`;').length, 1, 'a raw file name');
  assert.equal(run('sel.innerHTML = branches.map(b => `<option value="${b.replace(/"/g, \'&quot;\')}">${b}</option>`).join(\'\');').length, 2, 'a raw branch, as value and as label');
  assert.equal(run('item.innerHTML = `<button title="${s.tag ? `Tag: ${s.tag} (click)` : \'Tag\'}">#</button>`;').length, 1, 'a raw tag in a nested template');
  // Other ways a value gets in.
  assert.equal(run('let html = \'<b>\' + name + \'</b>\';').length, 1, 'concatenated to markup');
  assert.equal(run('const x = first + second + \'<br>\';').length, 2, 'every operand of the chain');
  assert.equal(run('let html = `<i>${esc(a)}</i>`; html += other; el.innerHTML = html;').length, 1, 'appended to a markup variable');
  assert.equal(run('appendInfoCard(tab, { title: \'x\', html: `<div>${err.message}</div>` });').length, 1, 'in an info card');
  assert.equal(run('appendInfoCard(tab, { title: \'x\', html: text });').length, 1, 'a raw html: value');
  assert.equal(run('el.innerHTML = cond ? `<b>${a}</b>` : \'\';').length, 1, 'in a branch of a ternary');
  assert.equal(run('el.innerHTML = list.map(x => x.name).join(\'\');').length, 1, 'a map that returns raw values');
  assert.equal(run('el.innerHTML = text;').length, 1, 'a raw variable');
  assert.equal(run('el.insertAdjacentHTML(\'beforeend\', text);').length, 1, 'insertAdjacentHTML');
  assert.equal(run('el.innerHTML = `<p class="x-${tone}">hi</p>`;').length, 1, 'a raw class');
  assert.equal(run('el.innerHTML = `<a href="${url}">x</a>`;').length, 1, 'a raw URL');
  // The fixed shapes pass.
  assert.deepEqual(run('card.innerHTML = `<span class="plan-file">${esc(fileName)}</span>`;'), []);
  assert.deepEqual(run('el.innerHTML = rows.map(r => `<div class="x-${classToken(r.tone)}" title="${esc(r.t)}">${Number(r.n) || 0}</div>`).join(\'\') || \'<i>none</i>\';'), []);
  assert.deepEqual(run('el.innerHTML = md(text); other.innerHTML = \'\'; x.innerHTML = `<b>${a ? \'yes\' : `no ${escH(b)}`}</b>`;'), []);
  assert.deepEqual(run('let html = `<i>${esc(a)}</i>`; html += ok ? `<b>${esc(b)}</b>` : \'\'; el.innerHTML = html;'), []);
  assert.deepEqual(run('const partHtml = names.map(esc).join(\', \'); el.innerHTML = `<p>${partHtml}</p>`;'), []);
  assert.deepEqual(run('el.textContent = `${a} / ${c}`; const sel = `.card[data-id="${CSS.escape(id)}"]`; if (a < b) el.title = `${a}`;'), [], 'text and selectors are not markup');
  assert.deepEqual(run('el.innerHTML = `<i>${ICON}</i>${icon(name)}`;', { calls: ['icon'], exprs: ['ICON'] }), [], 'reviewed entries');
  assert.deepEqual(run('const ICON = \'<svg/>\'; const ALIAS = ICON; el.innerHTML = cond ? ICON : ALIAS;', { constants: ['ICON', 'ALIAS'] }), [], 'constants declared as literals');
  assert.equal(run('const ICON = pick(name); el.innerHTML = ICON;', { constants: ['ICON'] }).length, 1, 'a constant that is not a literal');
  assert.deepEqual(auditSource('sample.js', 'el.innerHTML = \'\';', { calls: ['icon'], exprs: ['ICON'] }).stale, ['ICON', 'icon(…)'], 'an entry nothing uses is reported');
  // The scanner is not fooled by quotes inside regexes and comments.
  assert.deepEqual(run('const re = /["\'`]/g; // it\'s `fine`\n/* "quoted" */ const d = a / b; el.innerHTML = `<b>${esc(x.replace(/"/g, \'\'))}</b>`;'), []);
});

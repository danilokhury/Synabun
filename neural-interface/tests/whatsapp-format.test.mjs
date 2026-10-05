// WhatsApp Link formatting: the Assistant's Markdown → WhatsApp text, and the
// splitter that turns it into messages of at most `max` UTF-16 code units.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAIL, chunk, toWhatsApp } from '../lib/whatsapp/format.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const fenceCount = (text) => text.split('\n').filter((line) => line === '```').length;
const md = (...lines) => lines.join('\n');

// ── toWhatsApp ──

test('toWhatsApp: anything but a string is empty; CRLF becomes LF', () => {
  for (const value of [null, undefined, 42, {}, ['**x**'], '']) assert.equal(toWhatsApp(value), '');
  assert.equal(toWhatsApp('**a**\r\n\r\nb\rc'), '*a*\n\nb\nc');
});

test('rule 1: fenced code blocks lose the info string and keep their content untouched', () => {
  assert.equal(toWhatsApp(md('Run:', '```bash', 'npm i **x**', '```', 'Done.')), md('Run:', '```', 'npm i **x**', '```', 'Done.'));
  assert.equal(toWhatsApp(md('~~~python', 'print("~~~")', '  indented = 1', '~~~')), md('```', 'print("~~~")', '  indented = 1', '```'));
  assert.equal(toWhatsApp(md('````md', '```js', 'x', '```', '````')), md('```', '```js', 'x', '```', '```'), 'a longer fence is closed only by one as long');
  assert.equal(toWhatsApp(md('Before', '```js', 'const a = 1;', '__b__')), md('Before', '```', 'const a = 1;', '__b__', '```'), 'an unclosed fence runs to the end');
  assert.equal(toWhatsApp(md('1. Run:', '   ```bash', '   npm install', '   ```', '2. Then')), md('1. Run:', '```', 'npm install', '```', '2. Then'), 'a fence indented under a list item');
  assert.equal(toWhatsApp(md('```', '   ', '```', 'after')), 'after', 'an empty block is dropped');
});

test('rule 1: a block over 60 lines keeps 60 and says how many more are in SynaBun', () => {
  const lines = Array.from({ length: 75 }, (_v, i) => `line ${i + 1}`);
  const out = toWhatsApp(md('```', ...lines, '```', 'after'));
  assert.equal(out, md('```', ...lines.slice(0, 60), '```', '(15 more lines in SynaBun)', 'after'));
  assert.equal(toWhatsApp(md('```', ...lines.slice(0, 60), '```')), md('```', ...lines.slice(0, 60), '```'), 'exactly 60 lines: no note');
});

test('rule 2: inline code keeps single backticks and nothing inside it is converted', () => {
  assert.equal(toWhatsApp('Call `run(**x**)` then ``a <b> &amp; _c_``.'), 'Call `run(**x**)` then `a <b> &amp; _c_`.');
  assert.equal(toWhatsApp('a ``x`y`` span'), 'a ```x`y``` span', 'a span holding a backtick becomes ``` monospace');
  assert.equal(toWhatsApp('an ` unmatched backtick'), 'an ` unmatched backtick');
});

test('rule 3: emphasis', () => {
  assert.equal(toWhatsApp('**bold** __bold__ *it* _it_ ***both*** ~~gone~~'), '*bold* *bold* _it_ _it_ *_both_* ~gone~');
  assert.equal(toWhatsApp('**a** then *b*, (**c**) and **Note:** d'), '*a* then _b_, (*c*) and *Note:* d', 'bold is never re-read as italic');
  assert.equal(toWhatsApp('*see **this** now*'), '_see *this* now_');
  const plain = 'snake_case_identifiers, file_names_like_this.js, 2 * 3 * 4 = 24, a lone * here, a*b*c, x__y__z';
  assert.equal(toWhatsApp(plain), plain);
  assert.equal(toWhatsApp('** not bold ** and *not italic *'), '** not bold ** and *not italic *');
});

test('rule 4: ATX and setext headings become a bold line without inner markup', () => {
  assert.equal(toWhatsApp('# Title'), '*Title*');
  assert.equal(toWhatsApp('## **Plan**'), '*Plan*');
  assert.equal(toWhatsApp('### The `run()` _step_ ###'), '*The run() step*');
  assert.equal(toWhatsApp(md('Setext one', '===', '', 'Setext two', '---', 'body')), md('*Setext one*', '', '*Setext two*', 'body'));
  assert.equal(toWhatsApp('#hashtag and ####### seven'), '#hashtag and ####### seven');
});

test('rule 5: links and autolinks', () => {
  assert.equal(toWhatsApp('[docs](https://x.y/docs)'), 'docs (https://x.y/docs)');
  assert.equal(toWhatsApp('[the site](https://a.b/c "Title")'), 'the site (https://a.b/c)');
  assert.equal(toWhatsApp('[https://x.y](https://x.y/) and [x.y](https://x.y)'), 'https://x.y/ and https://x.y');
  assert.equal(toWhatsApp('[**Docs**](https://x.y/pkg/__init__.py)'), '*Docs* (https://x.y/pkg/__init__.py)', 'the URL is never converted');
  assert.equal(toWhatsApp('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))'), 'wiki (https://en.wikipedia.org/wiki/Foo_(bar))');
  assert.equal(toWhatsApp('see <https://auto.link/a_b_> and <me@example.com>'), 'see https://auto.link/a_b_ and me@example.com');
  assert.equal(toWhatsApp('bare https://x.y/__init__.py, done'), 'bare https://x.y/__init__.py, done');
});

test('rule 6: images', () => {
  assert.equal(toWhatsApp('![diagram](https://x.y/d.png) ![](https://x.y/e.png)'), 'diagram: https://x.y/d.png https://x.y/e.png');
});

test('rule 7: lists, nesting, tasks and ordered items', () => {
  assert.equal(toWhatsApp(md('- a', '- b', '  - c', '    - d', '- e', '* x', '+ y')), md('• a', '• b', '  ◦ c', '    ◦ d', '• e', '• x', '• y'));
  assert.equal(toWhatsApp(md('- [ ] todo', '- [x] done', '  - [X] nested')), md('☐ todo', '☑ done', '  ☑ nested'));
  assert.equal(toWhatsApp(md('1. one', '2. two', '   1. sub', '   - bullet', '1) paren')), md('1. one', '2. two', '  1. sub', '  ◦ bullet', '1) paren'));
  assert.equal(toWhatsApp(md('- **bold** item', '  continued text')), md('• *bold* item', '  continued text'));
  assert.equal(toWhatsApp(md('- a', '', 'Para', '  - b')), md('• a', '', 'Para', '• b'), 'a paragraph ends the list');
});

test('rule 8: blockquotes keep "> " and convert the inside', () => {
  assert.equal(toWhatsApp(md('> **Note:** read', '> - item', '> > nested')), md('> *Note:* read', '> • item', '> nested'));
});

test('rule 9: small tables become a ``` block, wide ones one line per row', () => {
  assert.equal(toWhatsApp(md('| Name | Qty |', '|---|--:|', '| **Apple** | 3 |', '| Kiwi | 12 |')), md('```', 'Name   Qty', '----------', 'Apple  3', 'Kiwi   12', '```'));
  assert.equal(
    toWhatsApp(md('| Service | Status | Owner | Notes |', '| --- | :---: | --- | --- |', '| api | **up** | ana | fine |', '| db | down |  | disk `full` |')),
    md('• *Service*: api · *Status*: up · *Owner*: ana · *Notes*: fine', '• *Service*: db · *Status*: down · *Notes*: disk full'),
  );
  assert.equal(
    toWhatsApp(md('| Key | Description |', '|---|---|', '| a | [link](https://x.y) is longer than the width |')),
    '• *Key*: a · *Description*: link (https://x.y) is longer than the width',
    'two columns wider than 32 characters',
  );
  assert.equal(toWhatsApp(md('| a \\| b | c |', '|---|---|', '| 1 | 2 |')), md('```', 'a | b  c', '--------', '1      2', '```'), 'an escaped pipe stays in its cell');
});

test('rule 10: horizontal rules are removed', () => {
  assert.equal(toWhatsApp(md('a', '', '---', '', 'b', '***', 'c', '', '___', '', '- - -', 'd')), md('a', '', 'b', '', 'c', '', 'd'));
  assert.equal(toWhatsApp(md('- item', '---', 'text')), md('• item', '', 'text'), 'after a list item --- is a rule, not a heading');
});

test('rule 11: HTML is stripped outside code and entities are decoded', () => {
  assert.equal(toWhatsApp('line<br>next<br/>third<br />end'), md('line', 'next', 'third', 'end'));
  assert.equal(toWhatsApp('a <!-- hidden -->b <b>bold</b> <span class="x">text</span> <DIV>up</DIV>'), 'a b bold text up');
  assert.equal(toWhatsApp(md('keep', '<!-- a', 'b', '--> tail', 'end')), md('keep', 'tail', 'end'));
  assert.equal(toWhatsApp('Vec<String>, Promise<void> and <Button>'), 'Vec<String>, Promise<void> and <Button>', 'not HTML');
  assert.equal(
    toWhatsApp('a &amp; b &lt;c&gt; &quot;q&quot; &#39;s&#39; &apos; x&nbsp;y &#x1F600; &#65; &#xD800; &#1114112; &amp;lt;'),
    'a & b <c> "q" \'s\' \' x y 😀 A &#xD800; &#1114112; &lt;',
  );
  assert.equal(toWhatsApp('&lt;b&gt;kept&lt;/b&gt; &#42;not bold&#42;'), '<b>kept</b> *not bold*', 'decoded characters are literal');
});

test('rule 12: backslash escapes are literal characters', () => {
  assert.equal(toWhatsApp('\\*not italic\\* \\_no\\_ \\`no code\\` \\[x\\]\\(y\\) \\> \\| \\\\ \\~\\~z\\~\\~'), '*not italic* _no_ `no code` [x](y) > | \\ ~~z~~');
  assert.equal(toWhatsApp(md('\\# not a heading', '\\- not a bullet', '1\\. not a list')), md('# not a heading', '- not a bullet', '1. not a list'));
});

test('rule 13: trailing spaces, blank runs and the ends are trimmed', () => {
  assert.equal(toWhatsApp('\n\n  a  \n\n\n\n\nb   \n \t \n\nc\n\n'), md('a', '', 'b', '', 'c'));
  assert.equal(toWhatsApp(md('```', 'x = 1   ', '', '', '', 'y = 2', '```')), md('```', 'x = 1   ', '', '', '', 'y = 2', '```'), 'code keeps its own whitespace');
});

test('nothing is formatted inside code, fenced or inline', () => {
  const raw = '**x** _x_ <b> &amp; [a](b) ~~s~~ <!-- c --> \\* # h';
  assert.equal(toWhatsApp(md('```', raw, '# not a heading', '- not a bullet', '| a | b |', '|---|---|', '```')), md('```', raw, '# not a heading', '- not a bullet', '| a | b |', '|---|---|', '```'));
  assert.equal(toWhatsApp(`Inline \`${raw}\` done`), `Inline \`${raw}\` done`);
});

// ── chunk ──

test('chunk: empty → [], a short text is one message without a marker', () => {
  assert.deepEqual(chunk(''), []);
  assert.deepEqual(chunk(' \n\t '), []);
  assert.deepEqual(chunk(null), []);
  assert.deepEqual(chunk('hello'), ['hello']);
  assert.deepEqual(chunk('  hello  ', { prefix: 'SynaBun:' }), ['SynaBun: hello']);
  assert.deepEqual(chunk('x'.repeat(3491), { prefix: 'SynaBun:' }).map((c) => c.length), [3500], 'exactly max still fits');
  assert.deepEqual(chunk('hello', { prefix: '' }), ['hello']);
});

test('chunk: paragraphs, markers (i/n) and the prefix on every message', () => {
  const text = md('First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.');
  assert.deepEqual(chunk(text, { max: 30, maxChunks: 3 }), ['First paragraph. (1/3)', 'Second paragraph. (2/3)', 'Third paragraph. (3/3)']);
  assert.deepEqual(chunk(text, { max: 40, maxChunks: 5, prefix: 'SynaBun:' }), ['SynaBun: First paragraph. (1/3)', 'SynaBun: Second paragraph. (2/3)', 'SynaBun: Third paragraph. (3/3)']);
  assert.deepEqual(chunk(text, { max: 60, maxChunks: 3, prefix: 'Jarvis' }), [`Jarvis ${text}`], 'prefix + text = max: one message');
  assert.deepEqual(chunk(text, { max: 55, maxChunks: 3, prefix: 'Jarvis' }), ['Jarvis First paragraph.\n\nSecond paragraph. (1/2)', 'Jarvis Third paragraph. (2/2)']);
});

test('chunk: lines, then sentences, then words', () => {
  assert.deepEqual(chunk(md('one two three', 'four five six', 'seven eight'), { max: 36, maxChunks: 3 }), ['one two three\nfour five six (1/2)', 'seven eight (2/2)']);
  assert.deepEqual(chunk('First sentence here. Second sentence here. Third one.', { max: 50, maxChunks: 3 }), ['First sentence here. Second sentence here. (1/2)', 'Third one. (2/2)']);
  assert.deepEqual(chunk('alpha beta gamma delta epsilon zeta eta theta', { max: 30, maxChunks: 3 }), ['alpha beta gamma delta (1/2)', 'epsilon zeta eta theta (2/2)']);
});

test('chunk: a ``` block cut in two is closed and reopened', () => {
  const text = md('Look:', '```', 'line one', 'line two', 'line three', 'line four', '```', 'Done.');
  const out = chunk(text, { max: 40, maxChunks: 5 });
  assert.deepEqual(out, [md('Look:', '```', 'line one', 'line two', '```', '(1/2)'), md('```', 'line three', 'line four', '```', 'Done. (2/2)')]);
  const prefixed = chunk(text, { max: 50, maxChunks: 5, prefix: 'SynaBun:' });
  assert.ok(prefixed.length > 1);
  for (const c of prefixed) {
    assert.ok(c.startsWith('SynaBun: '), c);
    assert.equal(fenceCount(c) % 2, 0, c);
    assert.ok(c.length <= 50);
  }
  assert.ok(prefixed[1].startsWith('SynaBun: \n```\n'), 'a message that opens with a fence puts the prefix on its own line');
});

test('chunk: the tail only when something was dropped', () => {
  const tail = '… (the rest is in SynaBun on your computer)';
  const three = md('Paragraph one is here.', '', 'Paragraph two is here.', '', 'Paragraph three is here.');
  assert.deepEqual(chunk(three, { max: 70, maxChunks: 3, tail }), ['Paragraph one is here.\n\nParagraph two is here. (1/2)', 'Paragraph three is here. (2/2)'], 'split, nothing dropped: no tail');
  const six = md('Paragraph one is here.', '', 'Paragraph two is here.', '', 'Paragraph three is here.', '', 'Paragraph four is here.', '', 'Paragraph five is here.', '', 'Paragraph six is here.');
  assert.deepEqual(chunk(six, { max: 200, maxChunks: 2 }), [six]);
  assert.deepEqual(chunk(six, { max: 75, maxChunks: 2, tail }), ['Paragraph one is here.\n\nParagraph two is here. (1/2)', `Paragraph three is here.\n${tail} (2/2)`]);
  assert.deepEqual(chunk(six, { max: 90, maxChunks: 1 }), [`Paragraph one is here.\n${DEFAULT_TAIL}`]);
  assert.deepEqual(chunk(six, { max: 40, maxChunks: 1, tail: null }), ['Paragraph one is here.'], 'tail: null drops silently');
});

test('chunk: maxChunks 1 (or less) is one message ending with the tail, never a marker', () => {
  const text = 'word '.repeat(400).trim();
  for (const maxChunks of [1, 0, -3]) {
    const out = chunk(text, { max: 200, maxChunks, prefix: 'SynaBun:' });
    assert.equal(out.length, 1);
    assert.ok(out[0].length <= 200);
    assert.ok(out[0].startsWith('SynaBun: word word'));
    assert.ok(out[0].endsWith(`word\n${DEFAULT_TAIL}`), out[0]);
  }
});

test('chunk: a max too small for the tail drops it and never exceeds max', () => {
  const text = 'word '.repeat(100).trim();
  const out = chunk(text, { max: 60, maxChunks: 2, prefix: 'SynaBun:' });
  assert.equal(out.length, 2);
  for (const c of out) assert.ok(c.length <= 60, c);
  assert.ok(!out[1].includes(DEFAULT_TAIL));
  for (const max of [1, 2, 3, 5, 9, 12]) {
    for (const c of chunk(`${'😀'.repeat(8)} ${md('```', 'code', '```')} tail words`, { max, maxChunks: 50, prefix: 'SynaBun:' })) {
      assert.ok(c.length <= max, `${max}: ${JSON.stringify(c)}`);
      assert.ok(!LONE_SURROGATE.test(c));
    }
  }
});

test('chunk: hard splits never leave a lone surrogate or cut a grapheme', () => {
  const strip = (c) => c.replace(/ \(\d+\/\d+\)$/, '');
  const emoji = '😀'.repeat(300);
  const a = chunk(emoji, { max: 101, maxChunks: 20 });
  for (const c of a) { assert.ok(c.length <= 101); assert.ok(!LONE_SURROGATE.test(c), c); }
  assert.equal(a.map(strip).join(''), emoji);
  for (const unit of ['👩‍💻', '🇧🇷', '👍🏽', '1️⃣', 'é']) {
    const text = unit.repeat(120);
    const out = chunk(text, { max: 97, maxChunks: 40 });
    assert.ok(out.length > 1, unit);
    for (const c of out) {
      assert.ok(c.length <= 97);
      assert.ok(!LONE_SURROGATE.test(c));
      assert.equal(strip(c).replaceAll(unit, ''), '', `${unit} kept whole in ${JSON.stringify(c)}`);
    }
    assert.equal(out.map(strip).join(''), text);
  }
  const long = 'x'.repeat(1000);
  const b = chunk(long, { max: 101, maxChunks: 20, prefix: 'SynaBun:' });
  for (const c of b) assert.ok(c.length <= 101);
  assert.equal(b.map((c) => strip(c).slice('SynaBun: '.length)).join(''), long);
  const mixed = `${'ab😀'.repeat(200)}`;
  for (const c of chunk(mixed, { max: 120, maxChunks: 30 })) assert.ok(!LONE_SURROGATE.test(c));
});

test('chunk: what the bridge sends for a converted reply', () => {
  const reply = toWhatsApp(md('## Summary', '', ...Array.from({ length: 80 }, (_v, i) => `- **Item ${i}**: ${'details '.repeat(10)}`)));
  const tail = '… (the rest is in SynaBun on your computer)';
  const out = chunk(reply, { max: 3500, maxChunks: 3, prefix: 'SynaBun:', tail });
  assert.ok(out.length >= 2 && out.length <= 3);
  for (const [i, c] of out.entries()) {
    assert.ok(c.length <= 3500);
    assert.ok(c.startsWith('SynaBun: '));
    assert.ok(c.endsWith(` (${i + 1}/${out.length})`));
  }
  assert.ok(out[0].startsWith('SynaBun: *Summary*\n\n• *Item 0*: details'));
});

// ── Property test ──

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EMOJI = ['😀', '👩‍💻', '🇧🇷'];
const CJK = [...'漢字かなカナ中文測試한국어'];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function randomDoc(rng) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const word = () => {
    const r = rng();
    if (r < 0.06) return pick(EMOJI);
    if (r < 0.1) return pick(EMOJI).repeat(int(10, 60));
    if (r < 0.16) return Array.from({ length: int(1, 12) }, () => pick(CJK)).join('');
    if (r < 0.19) return 'x'.repeat(int(40, 900));
    return Array.from({ length: int(1, 9) }, () => pick([...LETTERS])).join('');
  };
  const sentence = () => `${Array.from({ length: int(1, 14) }, word).join(' ')}${pick(['.', '!', '?', '…', '.'])}`;
  const block = () => {
    const r = rng();
    if (r < 0.2) return ['```', ...Array.from({ length: int(1, 18) }, () => `${' '.repeat(int(0, 4))}${Array.from({ length: int(1, 8) }, word).join(' ')}`), '```'].join('\n');
    if (r < 0.3) return Array.from({ length: int(2, 8) }, () => `• ${sentence()}`).join('\n');
    const lines = Array.from({ length: int(1, 4) }, () => Array.from({ length: int(1, 6) }, sentence).join(' '));
    return lines.join('\n');
  };
  return Array.from({ length: int(1, 9) }, block).join(pick(['\n\n', '\n', '\n\n\n']));
}

test('chunk property: limits, markers, fences, surrogates, prefix, tail and content hold for random documents', () => {
  const rng = mulberry32(0x5eed2026);
  const stripFences = (text) => text.split('\n').filter((line) => line !== '```').join('\n').replace(/\s+/g, '');
  let split = 0;
  let truncated = 0;
  for (let run = 0; run < 400; run += 1) {
    const doc = randomDoc(rng);
    const max = 120 + Math.floor(rng() * 481);
    const maxChunks = [1, 3, 5][Math.floor(rng() * 3)];
    const prefix = rng() < 0.5 ? undefined : 'SynaBun:';
    const where = `run ${run} (max ${max}, maxChunks ${maxChunks}, prefix ${prefix})`;
    const out = chunk(doc, { max, maxChunks, prefix });
    assert.ok(out.length >= 1 && out.length <= maxChunks, `${where}: ${out.length} chunks`);
    const n = out.length;
    let dropped = false;
    const bodies = out.map((c, i) => {
      assert.ok(c.length <= max, `${where}: chunk ${i} is ${c.length}`);
      assert.ok(!LONE_SURROGATE.test(c), `${where}: lone surrogate in chunk ${i}`);
      assert.equal(fenceCount(c) % 2, 0, `${where}: odd fences in chunk ${i}: ${JSON.stringify(c)}`);
      let body = c;
      if (prefix) {
        assert.ok(body.startsWith(`${prefix} `), `${where}: chunk ${i} lacks the prefix`);
        body = body.slice(prefix.length + 1);
      }
      if (n > 1) {
        const marker = /[ \n]\((\d+)\/(\d+)\)$/.exec(body);
        assert.ok(marker, `${where}: chunk ${i} has no marker`);
        assert.equal(Number(marker[1]), i + 1);
        assert.equal(Number(marker[2]), n);
        body = body.slice(0, marker.index);
      } else {
        assert.ok(!/\(\d+\/\d+\)$/.test(body), `${where}: a single chunk has a marker`);
      }
      if (i === n - 1 && body.endsWith(`\n${DEFAULT_TAIL}`)) {
        dropped = true;
        body = body.slice(0, -(DEFAULT_TAIL.length + 1));
      }
      assert.ok(body.trim() && body.trim() !== '```', `${where}: chunk ${i} has no content`);
      assert.ok(!body.includes(DEFAULT_TAIL), `${where}: tail inside chunk ${i}`);
      return body;
    });
    const input = stripFences(doc);
    const kept = stripFences(bodies.join('\n'));
    if (dropped) {
      truncated += 1;
      assert.equal(n, maxChunks, `${where}: truncated but only ${n} chunks`);
      assert.ok(kept.length < input.length && input.startsWith(kept), `${where}: kept text is not a proper prefix of the input`);
    } else {
      assert.equal(kept, input, `${where}: content lost without a tail`);
    }
    if (n > 1) split += 1;
  }
  assert.ok(split > 100, `only ${split} documents were split`);
  assert.ok(truncated > 50, `only ${truncated} documents were truncated`);
});

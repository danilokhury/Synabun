import assert from 'node:assert/strict';
import test from 'node:test';

// The renderer's icon module reads session identity at import time; md needs no DOM.
const previousStorage = globalThis.sessionStorage;
globalThis.sessionStorage = { getItem: () => 'markdown-test' };
let md, setRenderContext;
try {
  ({ md, setRenderContext } = await import('../public/shared/cdx/cdx-render.js'));
} finally {
  if (previousStorage === undefined) delete globalThis.sessionStorage;
  else globalThis.sessionStorage = previousStorage;
}

test('markdown is memoized across context bindings with the same renderer', () => {
  let calls = 0;
  const renderer = { parse(text) { calls++; return `<p>${text}</p>`; } };
  setRenderContext({ marked: renderer });
  assert.equal(md('streaming'), '<p>streaming</p>');
  setRenderContext({ marked: renderer });
  assert.equal(md('streaming'), '<p>streaming</p>');
  assert.equal(calls, 1);
});

test('a late renderer replaces cached fallback HTML and removal restores escaped text', () => {
  let renderer = null;
  setRenderContext({ get marked() { return renderer; } });
  const text = '# Plan\n<unsafe>';
  assert.equal(md(text), '# Plan<br>&lt;unsafe&gt;');
  renderer = { parse: () => '<h1>Plan</h1><p>&lt;unsafe&gt;</p>' };
  assert.equal(md(text), '<h1>Plan</h1><p>&lt;unsafe&gt;</p>');
  renderer = null;
  assert.equal(md(text), '# Plan<br>&lt;unsafe&gt;');
});

test('renderer and parser replacements cannot reuse the previous renderer output', () => {
  const context = { marked: { parse: () => '<p>Visual fixture</p>' } };
  setRenderContext(context);
  assert.equal(md('# Revision'), '<p>Visual fixture</p>');
  context.marked = { prefix: 'Real', parse(text) { return `<p>${this.prefix}: ${text}</p>`; } };
  assert.equal(md('# Revision'), '<p>Real: # Revision</p>');
  context.marked.parse = () => '<h1>Revision</h1>';
  assert.equal(md('# Revision'), '<h1>Revision</h1>');
});

test('a throwing renderer falls back safely without poisoning a replacement', () => {
  const context = { marked: { parse() { throw new Error('Unavailable parser'); } } };
  setRenderContext(context);
  assert.equal(md('<unsafe>\nnext'), '&lt;unsafe&gt;<br>next');
  context.marked = { parse: () => '<p>Recovered</p>' };
  assert.equal(md('<unsafe>\nnext'), '<p>Recovered</p>');
});

test('streaming markdown cache remains bounded', () => {
  let calls = 0;
  setRenderContext({ marked: { parse(text) { calls++; return text; } } });
  for (let i = 0; i <= 512; i++) md(`delta ${i}`);
  assert.equal(md('delta 512'), 'delta 512');
  assert.equal(calls, 513);
  assert.equal(md('delta 0'), 'delta 0');
  assert.equal(calls, 514, 'Oldest entry is evicted while recent text stays memoized');
});

test('the offline markdown fallback retains JSON fences as pretty, escaped code', () => {
  setRenderContext({ marked: null });
  const html = md('Before\n\n\`\`\`json\n{"ok":true,"text":"<unsafe>"}\n\`\`\`\nAfter');
  assert.match(html, /<pre><code class="language-json">/);
  assert.match(html, /&quot;ok&quot;: true/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /After$/);
});

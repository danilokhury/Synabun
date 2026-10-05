// Source-level contract for the activity rack: the stylesheet's bans and motion
// rules, every assistant.rack.* string the code asks for exists in en.json
// (plural bases with one/other, verbs with now/done), en.json stays CRLF, and
// the renderer builds the rack DOM W-D wires (no old .asst-work markup).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');
const rackStyles = read('public/shared/assistant/asst-rack-styles.js');
const renderer = read('public/shared/assistant/asst-render.js');
const kinds = read('public/shared/assistant/asst-tool-kinds.js');
const enRaw = read('i18n/en.json');
const en = JSON.parse(enRaw);
const { RACK_CSS } = await import('../public/shared/assistant/asst-rack-styles.js');
const { VERBS, KIND_SPECS } = await import('../public/shared/assistant/asst-tool-kinds.js');

const lookup = (key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), en);

test('the rack stylesheet: no backdrop blur, no layer hints, no transition: all', () => {
  assert.doesNotMatch(rackStyles, /backdrop-filter/);
  assert.doesNotMatch(rackStyles, /will-change/);
  assert.doesNotMatch(rackStyles, /transition\s*:\s*all\b/);
  assert.doesNotMatch(rackStyles, /transition-property\s*:\s*all\b/);
  assert.match(renderer, /import \{ injectRackStyles \} from '\.\/asst-rack-styles\.js';/);
  assert.match(renderer, /createRenderer\([^)]*\) \{\n\s+loadMarked\(\);\n\s+injectRackStyles\(\);/, 'injected once per renderer, idempotent');
  assert.match(rackStyles, /style\.id = RACK_STYLE_ID/);
  assert.match(rackStyles, /RACK_STYLE_ID = 'asst-rack-styles'/);
  assert.match(rackStyles, /getElementById\('assistant-panel-styles'\)[\s\S]*main\.after\(style\)/, 'after the main assistant styles');
});

test('motion: paused while dragging with valid selectors, static under reduced motion', () => {
  // A pseudo-element inside :is() is an invalid selector: the whole rule would be dropped.
  for (const m of RACK_CSS.matchAll(/:is\(([^)]*)\)/g)) assert.doesNotMatch(m[1], /::?(?:before|after)/, `:is(${m[1]})`);
  assert.match(RACK_CSS, /body\.ui-interacting \.asst-rack \*,\s*body\.ui-interacting \.asst-rack \*::before,\s*body\.ui-interacting \.asst-rack \*::after \{ animation-play-state: paused !important; \}/);
  const reduced = RACK_CSS.slice(RACK_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /animation: none !important; transition: none !important;/);
  // Infinite loops run only on the live rack.
  for (const m of RACK_CSS.matchAll(/^\s*([^{}\n]+)\{[^}]*animation:\s*asst-rk-[\w-]+[^;]*infinite/gm)) assert.match(m[1], /is-live|data-state="running"/, m[1].trim());
  assert.match(RACK_CSS, /\.asst-rack\.is-live \+ \.asst-working[\s\S]*?\{ display: none; \}/, 'the live rack stands in for "Working…"');
  assert.match(RACK_CSS, /\.asst-rack\[data-state="settled"\] \{\s*content-visibility: auto;\s*contain-intrinsic-size: auto \d+px;/);
  // Tokens with fallbacks; the existing container name.
  for (const m of RACK_CSS.matchAll(/var\((--asst-[\w-]+)(\s*\))/g)) assert.fail(`${m[1]} has no fallback`);
  assert.ok(RACK_CSS.includes('@container asst (max-width: 400px)') && RACK_CSS.includes('@container asst (max-width: 320px)'));
  assert.doesNotMatch(RACK_CSS, /@container (?!asst )/);
  // Radii: 10 for the rack, 3 12 12 12 for the bubble (its notch sits by the 3px corner), 4 for code.
  assert.match(RACK_CSS, /\.asst-rack \{[^}]*border-radius: 10px;/);
  assert.match(RACK_CSS, /\.asst-bubble \{[^}]*border-radius: 3px 12px 12px 12px;/);
  assert.doesNotMatch(RACK_CSS, /border-radius: 12px 12px 12px 3px;/);
  // The tail: an 8px notch in the bubble's own fill with a ring edge, pointing left at the mascot, up under it when stacked.
  assert.match(RACK_CSS, /\.asst-bubble::before \{[^}]*background: var\(--rk-fill-1\);[^}]*box-shadow: inset 1px -1px 0 var\(--rk-line\);[^}]*clip-path: polygon\(/);
  assert.match(RACK_CSS, /@container asst \(max-width: 400px\) \{[\s\S]*?\.asst-bubble::before \{[^}]*top: -5\.5px;[^}]*clip-path: polygon\(0 100%, 0 0, 100% 0\);/);
  assert.match(RACK_CSS, /\.asst-rack-stage \{[^}]*column-gap: 8px;/);
  assert.match(RACK_CSS, /\.asst-rack \.asst-tool-section \{[^}]*border-radius: 4px;/);
  assert.match(RACK_CSS, /animation: asst-rk-caret 1\.06s steps\(1\) infinite/);
  assert.match(RACK_CSS, /asst-rk-sweep 1\.8s/);
  assert.doesNotMatch(RACK_CSS, /text-transform:\s*uppercase|letter-spacing:\s*\.0[5-9]/, 'no tracked all-caps labels');
  assert.doesNotMatch(RACK_CSS, /background-clip:\s*text/, 'no gradient text');
});

test('every assistant.rack.* key the code uses exists in en.json', () => {
  const used = new Set();
  for (const src of [renderer, kinds]) for (const m of src.matchAll(/['"`](assistant\.rack\.[\w.]+)['"`]/g)) used.add(m[1]);
  assert.ok(used.size > 100, `found ${used.size} keys`);
  const missing = [];
  for (const key of used) {
    const value = lookup(key);
    if (typeof value === 'string') continue;
    if (value && typeof value === 'object' && Object.values(value).every(v => typeof v === 'string')) continue; // a plural base or a verb
    missing.push(key);
  }
  assert.deepEqual(missing, []);
  // Plural bases carry one/other (i18n.js tp()), verbs now/done.
  for (const src of [renderer, kinds]) {
    for (const m of src.matchAll(/plural\(t, '(assistant\.rack\.[\w.]+)'/g)) {
      const value = lookup(m[1]);
      assert.equal(typeof value?.one, 'string', `${m[1]}.one`);
      assert.equal(typeof value?.other, 'string', `${m[1]}.other`);
    }
  }
  for (const [id, [key, now, done]] of Object.entries(VERBS)) {
    assert.equal(lookup(`${key}.now`), now, `${id} now`);
    assert.equal(lookup(`${key}.done`), done, `${id} done`);
  }
  for (const spec of Object.values(KIND_SPECS)) assert.equal(lookup(spec.label[0]), spec.label[1]);
  // The keys the rack reuses from elsewhere in en.json.
  for (const key of ['assistant.work.agents', 'assistant.work.agentId', 'assistant.tool.done', 'assistant.tool.error', 'assistant.thinking', 'assistant.computer.tool.computer']) assert.equal(typeof lookup(key), 'string', key);
});

test('en.json keeps CRLF line endings', () => {
  const lf = (enRaw.match(/\n/g) || []).length;
  assert.ok(lf > 100);
  assert.equal((enRaw.match(/\r\n/g) || []).length, lf, 'every \\n is preceded by \\r');
  assert.doesNotMatch(enRaw, /[^\r]\n/);
});

test('the renderer builds the rack DOM contract, not the old work card', () => {
  for (const cls of ['asst-rack', 'asst-rack-stage', 'asst-rack-face', 'asst-rack-caption', 'asst-bubble', 'asst-bubble-verb', 'asst-bubble-subject', 'asst-bubble-meta', 'asst-rack-sweep',
    'asst-rack-ledger', 'asst-station', 'asst-station-hdr', 'asst-station-face', 'asst-station-label', 'asst-station-agg', 'asst-station-ticks', 'asst-tick', 'asst-station-time', 'asst-station-log',
    'asst-rack-receipt', 'asst-rack-view', 'asst-rack-status']) {
    assert.ok(renderer.includes(`'${cls}'`) || renderer.includes(`"${cls}"`) || new RegExp(`class="[^"]*\\b${cls}\\b`).test(renderer), cls);
  }
  assert.match(renderer, /row\.setAttribute\('role', 'group'\)/);
  assert.match(renderer, /<div class="asst-rack-status" role="status" aria-live="polite"><\/div>/);
  assert.match(renderer, /class="asst-bubble" aria-live="off"/);
  assert.match(renderer, /<button type="button" class="asst-rack-receipt" aria-expanded="false"/);
  assert.match(renderer, /<button type="button" class="asst-station-hdr" aria-expanded="false"/);
  assert.match(renderer, /rack\.row\.dataset\.kind|row\.dataset\.kind = rack\.awake\.step\.kind/);
  assert.doesNotMatch(renderer, /asst-work(?!ing)/, 'the old work card is gone from the renderer (asst-working is the "Working…" row)');
  assert.doesNotMatch(renderer, /setInterval\(/, 'one shared ticker, no interval');
  assert.match(renderer, /subscribe\(tickRacks, \{ fps: 1 \}\)/);
  assert.match(renderer, /from '\.\.\/synabun-ticker\.js'/);
  assert.doesNotMatch(renderer, /addEventListener\('(?:pointermove|resize|scroll|keydown)'[^)]*\)[^;]*window|window\.addEventListener/, 'no per-rack window listeners');
  assert.match(renderer, /setActive\?\.\(false\)/, 'a settled stage stops its rig');
  assert.match(renderer, /react\?\.\('wince'\)/);
  assert.match(renderer, /setPose\?\.\(/);
});

// ── Fix pass (2026-09-29): visual QA must-fix and should-fix, pinned ──
test('fix pass: waiting on a card, one chevron, reduced motion without a sweep, a row that never truncates its failures', () => {
  // Blocked: no gold, no caret, ◆ "Waiting for you" in the warn tone; the awake row's ring and tick go neutral.
  assert.match(RACK_CSS, /\.asst-bubble\[data-state="waiting"\] \.asst-bubble-verb \{ color: var\(--rk-warn\); \}/);
  assert.match(RACK_CSS, /\.asst-bubble\[data-state="waiting"\] \.asst-bubble-verb::before \{ content: '◆';/);
  assert.match(RACK_CSS, /\.asst-bubble\[data-state="running"\] \.asst-bubble-caret \{ display: inline-block;/, 'the caret only while running');
  assert.match(RACK_CSS, /\.asst-station\[data-state="waiting"\] > \.asst-station-hdr \{ box-shadow: inset 0 0 0 1px var\(--rk-line-2\); \}/);
  assert.match(RACK_CSS, /\.asst-tick\[data-state="waiting"\] \{ background: var\(--rk-text-3\); \}/);
  assert.match(RACK_CSS, /\.asst-rack\.is-live:not\(\[data-state="waiting"\]\) > \.asst-rack-stage > \.asst-rack-sweep::after/, 'no sweep while a card holds the rack');
  // One chevron per container: the receipt's.
  assert.doesNotMatch(RACK_CSS, /asst-station-chev/);
  assert.doesNotMatch(renderer, /asst-station-chev/);
  assert.match(renderer, /class="asst-rack-chev" aria-hidden="true"/);
  // Reduced motion: no sweep at all (a frozen one is a stray gold stub).
  const reduced = RACK_CSS.slice(RACK_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.asst-rack-sweep \{ display: none; \}/);
  // The failed count never truncates: the aggregate keeps its width, the ticks give way.
  assert.match(RACK_CSS, /\.asst-station-agg \{ flex: 0 0 auto;/);
  assert.match(RACK_CSS, /\.asst-station-ticks \{ flex: 0 1 auto;[^}]*min-width: 0; margin-left: auto;/);
  assert.match(RACK_CSS, /@container asst \(max-width: 400px\) \{[\s\S]*?\.asst-station-time \{ display: none; \}/);
  // Squint hierarchy: settled labels text-2, the awake row text.
  assert.match(RACK_CSS, /\.asst-station-label \{[^}]*color: var\(--rk-text-2\);/);
  assert.match(RACK_CSS, /\.asst-station\[data-state="awake"\] \.asst-station-label \{ color: var\(--rk-text\); \}/);
  // Wide hosts keep the ledger compact.
  assert.match(RACK_CSS, /\.asst-rack \{[^}]*max-width: 560px;/);
});

test('fix pass: narrow stages keep the error, the ticks and the faces; the Timeline is one grid', () => {
  const narrow = RACK_CSS.slice(RACK_CSS.indexOf('@container asst (max-width: 320px)'), RACK_CSS.indexOf('@container asst (max-width: 299px)'));
  assert.match(narrow, /\.asst-bubble-subject \{ --rk-cut: head; \}/, 'cut from the head: the file name survives');
  assert.match(narrow, /\.asst-bubble-meta \{ display: none; \}/);
  assert.doesNotMatch(narrow, /asst-bubble-err|asst-station-ticks|asst-station-face|white-space: nowrap|32px/, 'nothing else goes, and nothing single-lines the subject');
  assert.match(RACK_CSS, /\.asst-bubble-err \{[^}]*-webkit-line-clamp: 2;/, 'the error keeps two lines');
  assert.match(RACK_CSS, /@container asst \(max-width: 299px\) \{\s*\.asst-rack-face svg \{ width: 56px; height: 28px; \}/, 'the stage face is 72×36 down to a 300px container, 56×28 under it');
  assert.doesNotMatch(RACK_CSS, /width: 32px; height: 16px; \}\s*\n\s*\.asst-bubble \{ grid-template-columns/, 'no 32×16 stage face');
  assert.match(RACK_CSS, /\.asst-tl \{ display: grid; grid-template-columns: 5\.5em minmax\(0, 1fr\) auto;/);
  assert.match(RACK_CSS, /\.asst-tl-verb \{[^}]*text-align: right;/);
  assert.match(RACK_CSS, /\.asst-tl-subject \{[^}]*color: var\(--rk-text-2\);/);
  assert.doesNotMatch(RACK_CSS + renderer, /asst-tl-time/, 'no offset column: a time on the right is a duration');
  // The receipt is an sm capsule: a 32×16 still cameo as the glyph half, two lines of sentence.
  // Its corners and the small controls' are the panel's scale (sm 6px, xs 5px): rounded rectangles, never full capsules.
  assert.match(RACK_CSS, /--rk-pill-r: var\(--asst-pill-r-sm, 6px\);\s*--rk-pill-r-xs: var\(--asst-pill-r-xs, 5px\);/);
  assert.match(RACK_CSS, /\.asst-rack-receipt \{[^}]*min-height: var\(--rk-pill-h\);[^}]*border-radius: var\(--rk-pill-r\);/);
  assert.match(RACK_CSS, /\.asst-rack-view button \{[^}]*border-radius: var\(--rk-pill-r\);/, 'By kind / Timeline');
  assert.match(RACK_CSS, /\.asst-bubble-copy \{[^}]*border-radius: var\(--rk-pill-r\);/);
  assert.match(RACK_CSS, /\.asst-copy, \.asst-tool-more, \.asst-rack \.asst-reveal \{[^}]*height: 20px;[^}]*border-radius: var\(--rk-pill-r-xs\);/);
  assert.doesNotMatch(RACK_CSS, /border-radius:\s*(?:999px|50%|11px)/);
  assert.match(RACK_CSS, /\.asst-rack-receipt-face svg \{ display: block; width: 32px; height: 16px; \}/);
  assert.match(RACK_CSS, /\.asst-rack-receipt-text \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(renderer, /mountStill\(r\.face, pose, '✓', \{ width: 32, height: 16 \}\)/);
  // 24×24 hit areas for the small controls.
  assert.match(RACK_CSS, /:is\(\.asst-copy, \.asst-tool-more, \.asst-bubble-copy, \.asst-rack-view button, \.asst-rack-receipt\)::after,\s*\.asst-rack \.asst-reveal::after \{ content: ''; position: absolute; inset: -3px -2px;/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUT_LIMITS as limits, jsonAnswer, looksLikeStreamingJson, prettyJsonFences, isPreformattedText, cleanTerminal, structuredValueModel, readableStructuredValue, parseUnifiedDiff, fileChangeDiffs, deduplicateTurnDiff, boundedText, hasOverlongRun, outputOverflows, displayDiffPath } from '../public/shared/cdx/cdx-output-model.js';

test('only whole unfenced JSON objects and arrays become structured answers', () => {
  for (const text of [' {"ok":true,"empty":"","none":null} ', '[0,false,null,"",{},[]]']) assert.equal(jsonAnswer(text).kind, 'json');
  for (const text of ['\`\`\`json\n{"ok":true}\n\`\`\`', '~~~\n[1,2]\n~~~', '{"ok":true}\nDone.', 'Here is {"ok":true}', '{oops}', '[1,', '"text"', 'null', '\`\`\`js\n{}\n\`\`\`']) assert.equal(jsonAnswer(text), null, text);
  assert.equal(jsonAnswer('{"x":"' + 'x'.repeat(limits.input) + '"}').kind, 'oversized');
  assert.equal(looksLikeStreamingJson('{\n "checks": ['), true);
  assert.equal(looksLikeStreamingJson('An ordinary sentence [aside]'), false);
  assert.equal(looksLikeStreamingJson('[Documentation](https://example.com)'), false);
});

test('JSON fences within prose pretty print without restructuring inline JSON or other fences', () => {
  const text = 'Before\n\n\`\`\`json\n{"x":[1,2]}\n\`\`\`\n\nAfter {"y":true}';
  assert.match(prettyJsonFences(text), /"x": \[\n/);
  assert.match(prettyJsonFences(text), /After {"y":true}/);
  assert.match(prettyJsonFences('\`\`\`\n{"ok":true}\n\`\`\`'), /"ok": true/);
  assert.equal(prettyJsonFences('\`\`\`js\n{"ok":true}\n\`\`\`'), '\`\`\`js\n{"ok":true}\n\`\`\`');
});

test('structured model keeps empty values, scalar arrays, nesting and bounded previews', () => {
  const model = structuredValueModel({ empty: '', null: null, zero: 0, no: false, obj: {}, array: [], long: Array.from({length:40}, (_, i) => i) });
  assert.equal(model.entries[0].value.text, '""');
  assert.equal(model.entries[1].value.text, 'null');
  assert.equal(model.entries[2].value.text, '0');
  assert.equal(model.entries[3].value.text, 'false');
  assert.equal(model.entries[4].value.total, 0);
  assert.equal(model.entries[5].value.total, 0);
  assert.equal(model.entries[6].value.entries.length, 40);
  const wide = structuredValueModel(Array.from({length:5000}, (_, i) => i));
  assert.equal(wide.truncated, true);
  assert.ok(wide.entries.length < limits.nodes);
  const deep = structuredValueModel({a:{b:{c:{d:{e:'value'}}}}});
  assert.equal(deep.entries[0].value.entries[0].value.entries[0].value.entries[0].value.kind, 'raw');
});

test('huge/deep/cyclic structured values remain bounded; prototype keys remain data', () => {
  const huge = { text: 'x'.repeat(1000000), list: Array.from({length:5000}, () => false) };
  assert.ok(readableStructuredValue(huge).length < limits.raw + 100);
  let deep = {}; const root = deep;
  for (let i = 0; i < 20000; i++) deep = deep.next = {};
  assert.match(readableStructuredValue(root), /Depth limit/);
  const cycle = {}; cycle.self = cycle;
  assert.match(readableStructuredValue(cycle), /Circular reference/);
  assert.match(readableStructuredValue(JSON.parse('{"__proto__":{"safe":true}}')), /__proto__/);
  assert.match(boundedText('x'.repeat(limits.raw + 1)), /Truncated/);
});

test('preformatted detection recognizes consecutive trees, traces, columns, logs, indentation and YAML', () => {
  for (const source of [
    'src\n├── a\n├── b\n└── c',
    'Error: failure\n    at run (app.js:1)\n    at start (app.js:2)\n    at main (app.js:3)',
    'NAME    STATUS    COUNT\napp     ready     1\nbridge  ready     2',
    '[INFO] start\n[WARN] retry\n[ERROR] fail',
    '    run()\n    next()\n    stop()',
    'name: app\nready: true\nitems:\n  - one',
  ]) assert.equal(isPreformattedText(source), true, source);
  for (const source of [
    'A normal sentence.\nAnother normal sentence.\nA third sentence.',
    '# Heading\n\n- One\n- Two\n- Three',
    'The explanation:\n\nThis stays prose.',
    'First: a sentence\nSecond line\nThird line',
    'One  double space\n\nTwo sentences.',
    '    - nested one\n    - nested two\n    - nested three',
    '\`\`\`\n    one\n    two\n    three\n\`\`\`',
  ]) assert.equal(isPreformattedText(source), false, source);
});

test('terminal cleaning removes CSI/OSC/DCS and controls, resolves CR progress and backspaces, preserves tabs', () => {
  assert.equal(cleanTerminal('\u001b[32mgreen\u001b[0m\u001b[2K\u001b[1G'), 'green');
  assert.equal(cleanTerminal('\u001b]8;;https://example.com\u0007link\u001b]8;;\u001b\\'), 'link');
  assert.equal(cleanTerminal('\u001bPprivate\u001b\\visible'), 'visible');
  assert.equal(cleanTerminal('1%\r50%\r100%\r\nnext'), '100%\nnext');
  assert.equal(cleanTerminal('100%\r'), '100%');
  assert.equal(cleanTerminal('abc\b\bXY\tready'), 'aXY\tready');
  assert.equal(cleanTerminal('\u009b31mred\u009b0m'), 'red');
  assert.ok(!cleanTerminal('x\u001b[0m\u0000').includes('\u001b'));
  assert.match(cleanTerminal('x'.repeat(limits.input + 1)), /truncated/);
});

const patch = 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -2,3 +2,3 @@\n context\n-old\n+new\n end\n\\ No newline at end of file';
test('unified diff files/hunks/signs/numbers, no-newline notes and CRLF', () => {
  const [file] = parseUnifiedDiff(patch.replaceAll('\n', '\r\n'));
  assert.equal(file.path, 'src/app.js'); assert.equal(file.oldPath, 'src/app.js');
  assert.equal(file.added, 1); assert.equal(file.removed, 1);
  assert.deepEqual(file.hunks, [{oldStart:2, newStart:2}]);
  assert.equal(file.lines[1].oldLine, 2); assert.equal(file.lines[1].newLine, 2);
  assert.equal(file.lines[2].oldLine, 3); assert.equal(file.lines[2].newLine, null);
  assert.equal(file.lines[3].oldLine, null); assert.equal(file.lines[3].newLine, 3);
  assert.equal(file.lines.at(-1).kind, 'note');
});

test('added, deleted, renamed and binary files keep their headers and meaningful status', () => {
  const files = parseUnifiedDiff('diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+new\ndiff --git a/old b/old\ndeleted file mode 100644\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\ndiff --git a/before b/after\nsimilarity index 100%\nrename from before\nrename to after\ndiff --git a/icon.png b/icon.png\nBinary files a/icon.png and b/icon.png differ');
  assert.deepEqual(files.map(f => f.status), ['added','deleted','renamed','modified']);
  assert.equal(files[1].path, 'old'); assert.equal(files[2].oldPath, 'before'); assert.equal(files[2].path, 'after');
  assert.equal(files[3].binary, true);
  const [renamed] = fileChangeDiffs({changes:[{path:'old',kind:{type:'update',move_path:'new'},diff:'@@ -1 +1 @@\n-old\n+new'}]});
  assert.equal(renamed.status, 'renamed'); assert.equal(renamed.path, 'new');
});

test('diff bounds mark oversized patches and do not produce unbounded lines', () => {
  assert.equal(parseUnifiedDiff('x'.repeat(limits.input + 1))[0].oversized, true);
  const [file] = parseUnifiedDiff('@@ -0,0 +1,3000 @@\n' + '+x\n'.repeat(3000), {path:'big'});
  assert.equal(file.oversized, true); assert.equal(file.lines.length, limits.diffLines);
  assert.equal(fileChangeDiffs({changes:[{path:'no-patch',kind:'update'}]})[0].unavailable, true);
  const many = fileChangeDiffs({changes:Array.from({length:101}, (_, i) => ({path:String(i),kind:'update',diff:'@@ -1 +1 @@\n-old\n+new'}))});
  assert.equal(many.length, 100); assert.equal(many.at(-1).filesTruncated, true);
  const two = parseUnifiedDiff('--- a/one\n+++ b/one\n@@ -1 +1 @@\n-old\n+new\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-old\n+new');
  assert.deepEqual(two.map(file => file.path), ['one', 'two']);
});

test('turn diff dedup removes identical per-file content, retaining shell edits and changed patches', () => {
  const aggregate = parseUnifiedDiff(patch);
  const shown = fileChangeDiffs({changes:[{path:'src/app.js',kind:'update',diff:patch.split('@@')[1] ? '@@' + patch.split('@@').slice(1).join('@@') : patch}]});
  assert.deepEqual(deduplicateTurnDiff(aggregate, shown), []);
  assert.equal(deduplicateTurnDiff(parseUnifiedDiff(patch.replace('+new', '+newer')), shown).length, 1);
  assert.equal(deduplicateTurnDiff(aggregate, []).length, 1, 'Caller scopes shown cards to this turn');
});


test('unbroken run limit bounds tokens wherever they occur, leaving wordy paragraphs alone', () => {
  assert.equal(hasOverlongRun('x'.repeat(limits.unbrokenRun)), false);
  assert.equal(hasOverlongRun('x'.repeat(limits.unbrokenRun + 1)), true);
  assert.equal(hasOverlongRun('Here is the token: ' + 'x'.repeat(12000) + ' after it.'), true);
  assert.equal(hasOverlongRun('Ordinary words make an ordinary paragraph. '.repeat(3000)), false);
});

test('cap state requires visible measured overflow, tolerating rounding', () => {
  assert.equal(outputOverflows(100, 100), false);
  assert.equal(outputOverflows(321, 320), false);
  assert.equal(outputOverflows(322, 320), true);
  assert.equal(outputOverflows(1000, 0), false);
});

test('diff paths are workspace-relative only within a directory boundary, and keep filenames', () => {
  assert.equal(displayDiffPath('/work/app/src/app.js', '/work/app/'), 'src/app.js');
  assert.equal(displayDiffPath('/work/application/app.js', '/work/app'), '/work/application/app.js');
  assert.equal(displayDiffPath('/outside/app.js', '/work/app'), '/outside/app.js');
  assert.equal(displayDiffPath('src/app.js', '/work/app'), 'src/app.js');
  assert.equal(displayDiffPath('C:\\work\\app\\src\\app.js', 'c:\\work\\app'), 'src/app.js');
  const full = '/work/app/' + 'deep-directory/'.repeat(10) + 'README.md';
  const short = displayDiffPath(full, '/work/app', 40);
  assert.ok(short.length <= 40);
  assert.match(short, /^deep.*….*\/README\.md$/);
  assert.equal(displayDiffPath(full, '/work/app', 1), '…/README.md');
  assert.equal(displayDiffPath('very-long-filename.js', '', 1), 'very-long-filename.js');
});

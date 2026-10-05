import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { jsonlLines, rejoinSplitJsonLines, patchCodexLineSplitting } from '../lib/jsonl-lines.js';

const collect = async (iterable) => { const out = []; for await (const x of iterable) out.push(x); return out; };

// node:readline ends a line at U+2028 / U+2029 on the Node versions that have the
// bug this module works around; Node 22 does not. The module must be right on
// both, so the readline half of each case follows what this runtime does.
const READLINE_SPLITS_AT_SEPARATORS = (await collect(createInterface({ input: Readable.from(['a\u2028b\n']), crlfDelay: Infinity }))).length > 1;

test('jsonlLines splits on \\n only: U+2028 / U+2029 stay inside their line', async () => {
  const records = [{ a: 'x\u2028y' }, { b: 'p\u2029q' }, { c: 'plain' }];
  const text = `${records.map((r) => JSON.stringify(r)).join('\r\n')}\n${JSON.stringify({ d: 'no final newline' })}`;
  // Chunks cut anywhere, including inside a record.
  const chunks = [text.slice(0, 7), text.slice(7, 20), text.slice(20)];
  const lines = await collect(jsonlLines(chunks));
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [...records, { d: 'no final newline' }]);
  // What readline does to the same text (the bug this replaces).
  const rl = await collect(createInterface({ input: Readable.from([text]), crlfDelay: Infinity }));
  if (READLINE_SPLITS_AT_SEPARATORS) assert.ok(rl.length > lines.length, 'readline splits at U+2028 / U+2029');
  else assert.equal(rl.length, lines.length, 'this Node keeps the separators inside the line');
});

test('rejoinSplitJsonLines puts a readline-split record back together', async () => {
  const item = { type: 'item.completed', item: { type: 'command_execution', aggregated_output: '{"s":"line1 é 👩‍👩‍👧 \u2028"} two\u2028seps', exit_code: 0 } };
  const line = JSON.stringify(item);
  const split = await collect(createInterface({ input: Readable.from([`${JSON.stringify({ type: 'turn.started' })}\n${line}\n${JSON.stringify({ type: 'turn.completed' })}\n`]), crlfDelay: Infinity }));
  if (READLINE_SPLITS_AT_SEPARATORS) assert.ok(split.length > 3, 'the SDK sees more than three lines');
  else assert.equal(split.length, 3, 'this Node hands the SDK whole records');
  const run = async function* () { yield* split; };
  const joined = await collect(rejoinSplitJsonLines(run)());
  assert.equal(joined.length, 3);
  assert.deepEqual(joined.map((l) => JSON.parse(l).type), ['turn.started', 'item.completed', 'turn.completed']);
  assert.equal(JSON.parse(joined[1]).item.aggregated_output, item.item.aggregated_output);
});

test('rejoinSplitJsonLines leaves broken or non-record lines as they came', async () => {
  const lines = ['not json at all', '{"type":"a"', '{"type":"b"}', '{"unterminated'];
  const out = await collect(rejoinSplitJsonLines(async function* () { yield* lines; })());
  // "not json" passes through; the broken record is handed over before the next whole one; the tail is flushed.
  assert.deepEqual(out, ['not json at all', '{"type":"a"', '{"type":"b"}', '{"unterminated']);
  const big = await collect(rejoinSplitJsonLines(async function* () { yield '{"x":"'; yield 'y'.repeat(50); yield 'z'; }, { maxChars: 40 })());
  assert.equal(big.length, 2, 'past maxChars the buffer is handed over as it is');
});

test('patchCodexLineSplitting wraps an SDK-shaped exec once and ignores other shapes', async () => {
  const exec = { calls: 0, async *run(args) { this.calls += 1; yield '{"type":"x","t":"a'; yield `b${args.suffix}"}`; } };
  const codex = { exec };
  assert.equal(patchCodexLineSplitting(codex), true);
  assert.equal(patchCodexLineSplitting(codex), false, 'never wrapped twice');
  const out = await collect(codex.exec.run({ suffix: '!' }));
  assert.deepEqual(out.map((l) => JSON.parse(l)), [{ type: 'x', t: 'a\u2028b!' }]);
  assert.equal(exec.calls, 1);
  assert.equal(patchCodexLineSplitting({}), false);
  assert.equal(patchCodexLineSplitting(null), false);
});

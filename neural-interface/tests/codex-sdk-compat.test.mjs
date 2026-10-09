import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex, Thread } from '@openai/codex-sdk';
import { patchCodexLineSplitting } from '../lib/jsonl-lines.js';
import { createCodexNativeLoopAdapter } from '../lib/native-loop-providers.js';
import { codexUsageTokens } from '../lib/assistant-usage.js';

// Exercise the actual SDK transport without a model request. Run this same file
// with either SDK using an external Node module-resolution hook.
const transportTest = (name, fn) => test(name, {
  skip: process.platform === 'win32' && 'Fake CLI fixture requires a POSIX executable',
}, fn);

function fixture(t, events, exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'synabun-codex-sdk-compat-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capture = join(root, 'capture.json');
  const cli = join(root, 'codex');
  writeFileSync(cli, `#!${process.execPath}\n` + `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
    argv: process.argv.slice(2), input,
    pin: process.env.SDK_TEST_PIN, inherited: process.env.SDK_TEST_INHERITED,
    originator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
  }));
  process.stdout.write(${JSON.stringify(events.map(JSON.stringify).join('\n') + '\n')});
  if (${exitCode}) process.stderr.write('fixture transport error');
  process.exitCode = ${exitCode};
});
`, { mode: 0o700 });
  return { root, cli, capture: () => JSON.parse(readFileSync(capture, 'utf8')) };
}

const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 12, reasoning_output_tokens: 5 };
const completed = [
  { type: 'thread.started', thread_id: 'fixture-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OK' } },
  { type: 'turn.completed', usage },
];

transportTest('the real SDK finds no Codex of its own here, runs the one it is given, and older usage payloads remain compatible', async (t) => {
  // SynaBun installs the SDK without the Codex CLI it would carry (lib/external-tools.js
  // at the package root): left to itself the SDK has nothing to start, and says so.
  assert.throws(() => new Codex(), /Unable to locate Codex CLI binaries/);
  const oldUsage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 12 };
  const f = fixture(t, [completed[0], { type: 'turn.completed', usage: oldUsage }]);
  const sdk = new Codex({ codexPathOverride: f.cli });
  const result = await sdk.startThread().run('old usage');
  // 0.160 supplies cache_write_input_tokens=0; 0.121 leaves it absent.
  assert.equal(result.usage.cache_write_input_tokens ?? 0, 0);
  assert.deepEqual(codexUsageTokens(result.usage).tokens, { input: 80, cacheWrite: 0, cacheRead: 20, output: 12, reasoning: 0 });
});

transportTest('real SDK exports, explicit binary, env isolation, run and resumeThread remain compatible', async (t) => {
  const f = fixture(t, completed);
  const inherited = process.env.SDK_TEST_INHERITED;
  process.env.SDK_TEST_INHERITED = 'must not leak';
  t.after(() => {
    if (inherited === undefined) delete process.env.SDK_TEST_INHERITED;
    else process.env.SDK_TEST_INHERITED = inherited;
  });
  const sdk = new Codex({ codexPathOverride: f.cli, env: { SDK_TEST_PIN: 'pinned' }, config: { web_search: 'disabled' } });
  assert.equal(patchCodexLineSplitting(sdk), true);
  assert.equal(patchCodexLineSplitting(sdk), false);
  const options = { workingDirectory: f.root, skipGitRepoCheck: true, approvalPolicy: 'never', sandboxMode: 'read-only' };
  const first = sdk.startThread(options);
  assert.ok(first instanceof Thread);
  assert.equal(first.id, null);
  const result = await first.run('first');
  assert.equal(result.finalResponse, 'OK');
  assert.deepEqual(result.usage, usage);
  const resumed = sdk.resumeThread(first.id, options);
  const streamed = await resumed.runStreamed('second');
  assert.deepEqual(await Array.fromAsync(streamed.events), completed);
  const seen = f.capture();
  assert.equal(seen.pin, 'pinned');
  assert.equal(seen.inherited, undefined);
  assert.equal(seen.originator, 'codex_sdk_ts');
  assert.equal(seen.input, 'second');
  assert.deepEqual(seen.argv.slice(-2), ['resume', 'fixture-thread']);
  assert.ok(seen.argv.includes('web_search="disabled"'));
});

transportTest('real SDK adapter handles both Unicode separators and preserves cumulative usage', async (t) => {
  const text = 'before\u2028middle\u2029after';
  const f = fixture(t, [completed[0], completed[1],
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }, completed[3]]);
  const events = [];
  const adapter = await createCodexNativeLoopAdapter({
    cwd: f.root, codexPath: f.cli, capability: 'read-only',
    onEvent: entry => events.push(entry),
  });
  t.after(() => adapter.dispose());
  const first = await adapter.runTurn('first');
  const second = await adapter.runTurn('second');
  // Where readline splits at the separators it discards which one it saw, and the
  // repair substitutes U+2028 for either; where it does not (Node 22) the text
  // arrives as it was written. Neither may break JSON parsing.
  assert.ok([text, text.replaceAll('\u2029', '\u2028')].includes(first.text), JSON.stringify(first.text));
  assert.equal(second.text, first.text);
  assert.deepEqual(second.usage, usage, 'adapter passes through totals; dispatcher books deltas');
  assert.deepEqual(codexUsageTokens(second.usage).tokens, { input: 70, cacheWrite: 10, cacheRead: 20, output: 7, reasoning: 5 });
  assert.deepEqual(f.capture().argv.slice(-2), ['resume', 'fixture-thread']);
  assert.deepEqual(events.filter(e => e.event.type === 'turn.completed').map(e => e.providerTurn), [1, 2]);
});

transportTest('real SDK adapter surfaces turn.failed and nonzero transport exit errors', async (t) => {
  for (const [events, exitCode, message] of [
    [[completed[0], { type: 'turn.failed', error: { message: 'fixture turn failed' } }], 0, /fixture turn failed/],
    [[completed[0]], 7, /Codex Exec exited with code 7: fixture transport error/],
  ]) {
    const f = fixture(t, events, exitCode);
    const adapter = await createCodexNativeLoopAdapter({ cwd: f.root, codexPath: f.cli });
    t.after(() => adapter.dispose());
    await assert.rejects(adapter.runTurn('fail'), message);
  }
});

transportTest('real SDK adapter cancels its own active exec child', async (t) => {
  const f = fixture(t, completed);
  writeFileSync(f.cli, `#!${process.execPath}\nprocess.stdin.resume(); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const adapter = await createCodexNativeLoopAdapter({ cwd: f.root, codexPath: f.cli });
  t.after(() => adapter.dispose());
  const turn = adapter.runTurn('wait');
  const rejection = assert.rejects(turn, error => error.name === 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 100));
  await adapter.abort();
  await rejection;
});

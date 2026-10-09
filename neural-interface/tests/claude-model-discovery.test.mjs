import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { queryClaudeCliModels } from '../lib/claude-model-catalog.js';

// Model discovery asks the Claude CLI over its stdin. When the CLI is not
// installed, the shell that was asked to run it exits at once, and the request
// may be written to a pipe nobody reads any more. That has to degrade the model
// list, never take the server down.

function fakeChild({ write }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write });
  child.killed = 0;
  child.kill = () => { child.killed++; };
  return child;
}

test('a CLI that is gone before the request is written yields an empty list', async () => {
  let spawned = null;
  const child = fakeChild({
    write: (_chunk, _encoding, done) => done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' })),
  });
  // An unhandled 'error' on the stream would surface here and fail the test run.
  const models = await queryClaudeCliModels('claude', { timeoutMs: 5000, spawnImpl: (bin, args, options) => { spawned = { bin, args, options }; return child; } });
  assert.deepEqual(models, []);
  assert.equal(child.stdin.listenerCount('error') > 0, true);
  assert.equal(child.killed, 1);
  // A bare command name goes through a shell, with the settings flag in its one-token form.
  assert.equal(spawned.bin, 'claude');
  assert.equal(spawned.options.shell, true);
  assert.ok(spawned.args.includes('--setting-sources='));
});

test('the models of a CLI that answers are returned, and it is stopped', async () => {
  const written = [];
  const child = fakeChild({ write: (chunk, _encoding, done) => { written.push(String(chunk)); done(); } });
  const pending = queryClaudeCliModels('/opt/claude/bin/claude', { timeoutMs: 5000, spawnImpl: () => child });
  child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'control_response', response: { response: { models: [{ value: 'opus' }] } } })}\n`);
  assert.deepEqual(await pending, [{ value: 'opus' }]);
  assert.equal(JSON.parse(written[0]).request.subtype, 'initialize');
  assert.equal(child.killed, 1);
});

test('a CLI that cannot be started, or exits, yields an empty list', async () => {
  assert.deepEqual(await queryClaudeCliModels('claude', { timeoutMs: 5000, spawnImpl: () => { throw new Error('spawn ENOENT'); } }), []);
  const child = fakeChild({ write: (_chunk, _encoding, done) => done() });
  const pending = queryClaudeCliModels('claude', { timeoutMs: 5000, spawnImpl: () => child });
  child.emit('exit', 127, null);
  assert.deepEqual(await pending, []);
});

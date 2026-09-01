import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  codexOrphanCollisionAction,
  codexWriterHasActiveWork,
  CodexWriterRetirementRegistry,
  codexWriterKey,
  isCodexActiveWriterConflict,
  retireCodexChildProcess,
  shouldReleaseCodexWriter,
} from '../lib/codex-writer-lifecycle.js';

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.signals = [];
  }

  kill(signal) {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }
}

test('recognizes Codex thread-store active-writer conflicts', () => {
  assert.equal(isCodexActiveWriterConflict(new Error(
    'thread-store conflict: thread thr-1 already has an active writer',
  )), true);
  assert.equal(isCodexActiveWriterConflict({
    message: 'Could not resume thread',
    data: { detail: 'thread thr-2 already has an active writer' },
  }), true);
  assert.equal(isCodexActiveWriterConflict(new Error('Thread not found')), false);
  assert.equal(isCodexActiveWriterConflict(new Error(
    'thread-store conflict: thread thr-3 is corrupt',
  )), false);
});

test('releases only explicitly requested idle writers', () => {
  assert.equal(shouldReleaseCodexWriter({ requested: true }), true);
  assert.equal(shouldReleaseCodexWriter({ requested: false }), false);
  assert.equal(shouldReleaseCodexWriter({ requested: true, activeTurnId: 'turn-1' }), false);
  assert.equal(shouldReleaseCodexWriter({ requested: true, pendingServerRequestCount: 1 }), false);
  assert.equal(shouldReleaseCodexWriter({ requested: true, pendingRpcRequestCount: 1 }), false);
  assert.equal(shouldReleaseCodexWriter({ requested: true, operationsInFlight: 1 }), false);
});

test('classifies every source of reattachable writer work', () => {
  assert.equal(codexWriterHasActiveWork(), false);
  assert.equal(codexWriterHasActiveWork({ activeTurnId: 'turn-1' }), true);
  assert.equal(codexWriterHasActiveWork({ pendingServerRequestCount: 1 }), true);
  assert.equal(codexWriterHasActiveWork({ pendingRpcRequestCount: 1 }), true);
  assert.equal(codexWriterHasActiveWork({ operationsInFlight: 1 }), true);
});

test('orphan collisions never retire the active detached writer', () => {
  assert.equal(codexOrphanCollisionAction({ hasPrevious: false, currentIdle: true }), 'register-current');
  assert.equal(codexOrphanCollisionAction({
    hasPrevious: true,
    previousIdle: true,
    currentIdle: false,
  }), 'replace-idle-previous');
  assert.equal(codexOrphanCollisionAction({
    hasPrevious: true,
    previousIdle: false,
    currentIdle: true,
  }), 'retire-idle-current');
  assert.equal(codexOrphanCollisionAction({
    hasPrevious: true,
    previousIdle: false,
    currentIdle: false,
  }), 'retain-both');
});

test('process retirement does not mistake signal delivery for process exit', async () => {
  const proc = new FakeChildProcess();
  let settled = false;
  const retirement = retireCodexChildProcess(proc, { forceAfterMs: 1000 })
    .then((result) => { settled = true; return result; });

  assert.deepEqual(proc.signals, ['SIGTERM']);
  assert.equal(proc.killed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  proc.emit('close', null, 'SIGTERM');
  assert.deepEqual(await retirement, { exited: true, forced: false });
});

test('process retirement escalates but still waits for close', async () => {
  const proc = new FakeChildProcess();
  let settled = false;
  const retirement = retireCodexChildProcess(proc, { forceAfterMs: 5 })
    .then((result) => { settled = true; return result; });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);

  proc.emit('close', null, 'SIGKILL');
  assert.deepEqual(await retirement, { exited: true, forced: true });
});

test('retirement barriers are isolated by CODEX_HOME and thread', async () => {
  const registry = new CodexWriterRetirementRegistry();
  let finish;
  const retirement = new Promise((resolve) => { finish = resolve; });

  registry.register('/tmp/codex-a', ['thr-1', 'thr-1'], retirement);
  assert.equal(registry.has('/tmp/codex-a', 'thr-1'), true);
  assert.equal(registry.has('/tmp/codex-a', 'thr-2'), false);
  assert.equal(registry.has('/tmp/codex-b', 'thr-1'), false);
  assert.notEqual(
    codexWriterKey('/tmp/codex-a', 'thr-1'),
    codexWriterKey('/tmp/codex-b', 'thr-1'),
  );

  const wait = registry.wait('/tmp/codex-a', 'thr-1', { timeoutMs: 1000 });
  finish();
  assert.deepEqual(await wait, { waited: true, timedOut: false });
  await Promise.resolve();
  assert.equal(registry.has('/tmp/codex-a', 'thr-1'), false);
  assert.equal(registry.settledRecently('/tmp/codex-a', 'thr-1', { withinMs: 1000 }), true);
});

test('retirement wait is bounded', async () => {
  const registry = new CodexWriterRetirementRegistry();
  registry.register('/tmp/codex-a', ['thr-1'], new Promise(() => {}));
  assert.deepEqual(
    await registry.wait('/tmp/codex-a', 'thr-1', { timeoutMs: 5 }),
    { waited: true, timedOut: true },
  );
  assert.deepEqual(
    await registry.wait('/tmp/codex-a', 'thr-missing', { timeoutMs: 5 }),
    { waited: false, timedOut: false },
  );
});

test('wait observes every concurrent retirement for one writer', async () => {
  const registry = new CodexWriterRetirementRegistry();
  let finishFirst;
  let finishSecond;
  registry.register('/tmp/codex-a', ['thr-1'], new Promise((resolve) => { finishFirst = resolve; }));
  registry.register('/tmp/codex-a', ['thr-1'], new Promise((resolve) => { finishSecond = resolve; }));

  let settled = false;
  const wait = registry.wait('/tmp/codex-a', 'thr-1', { timeoutMs: 1000 })
    .then((result) => { settled = true; return result; });
  finishFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finishSecond();
  assert.deepEqual(await wait, { waited: true, timedOut: false });
});

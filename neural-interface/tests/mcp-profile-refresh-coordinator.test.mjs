import test from 'node:test';
import assert from 'node:assert/strict';
import { McpProfileRefreshCoordinator } from '../lib/mcp-profile-refresh-coordinator.js';

function manualClock() {
  const jobs = [];
  return {
    setTimer(fn, delay) {
      const job = { fn, delay, cancelled: false, ran: false, unref() {} };
      jobs.push(job);
      return job;
    },
    clearTimer(job) { job.cancelled = true; },
    async runNext() {
      const job = jobs.find((candidate) => !candidate.cancelled && !candidate.ran);
      if (!job) throw new Error('No pending timer');
      job.ran = true;
      await job.fn();
    },
    pending() { return jobs.filter((job) => !job.cancelled && !job.ran).length; },
  };
}

function idFactory() {
  let value = 0;
  return () => `refresh-${++value}`;
}

test('coalesces pending refreshes for one runtime to the newest profile', async () => {
  const clock = manualClock();
  const calls = [];
  const coordinator = new McpProfileRefreshCoordinator({
    delayMs: 250,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    correlationId: idFactory(),
  });

  const firstId = coordinator.schedule('runtime-a', 'core', 'opencode', async (id) => calls.push(['core', id]));
  const secondId = coordinator.schedule('runtime-a', 'linkedin', 'opencode', async (id) => calls.push(['linkedin', id]));

  assert.equal(firstId, 'refresh-1');
  assert.equal(secondId, 'refresh-2');
  assert.equal(clock.pending(), 1);
  await clock.runNext();
  assert.deepEqual(calls, [['linkedin', 'refresh-2']]);
  assert.equal(coordinator.size, 0);
});

test('serializes a newer refresh behind an already-running refresh', async () => {
  const clock = manualClock();
  const calls = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const coordinator = new McpProfileRefreshCoordinator({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    correlationId: idFactory(),
  });

  coordinator.schedule('runtime-a', 'core', 'codex', async () => {
    calls.push('first-start');
    await firstBlocked;
    calls.push('first-end');
  });
  const running = clock.runNext();
  await Promise.resolve();
  coordinator.schedule('runtime-a', 'linkedin', 'codex', async () => calls.push('second'));
  assert.equal(clock.pending(), 0);

  releaseFirst();
  await running;
  assert.equal(clock.pending(), 1);
  await clock.runNext();
  assert.deepEqual(calls, ['first-start', 'first-end', 'second']);
  assert.equal(coordinator.size, 0);
});

test('cancels a pending runtime refresh without affecting another runtime', async () => {
  const clock = manualClock();
  const calls = [];
  const coordinator = new McpProfileRefreshCoordinator({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    correlationId: idFactory(),
  });

  coordinator.schedule('runtime-a', 'core', 'opencode', async () => calls.push('a'));
  coordinator.schedule('runtime-b', 'core', 'codex', async () => calls.push('b'));
  assert.equal(coordinator.cancel('runtime-a'), true);
  assert.equal(coordinator.size, 1);
  await clock.runNext();
  assert.deepEqual(calls, ['b']);
  assert.equal(coordinator.size, 0);
});

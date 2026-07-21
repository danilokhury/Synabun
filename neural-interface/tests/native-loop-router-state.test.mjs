import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalReleaseTracker,
  resolveRouteClaim,
} from '../public/shared/ui-native-loop-router-state.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const baseRun = {
  runId: 'run-1',
  surface: 'sidepanel',
  provider: 'codex',
  providerThreadId: 'thread-1',
  source: 'manual',
  focus: true,
  status: 'running',
  version: 1,
  currentIteration: 1,
  updatedAt: '2026-07-14T12:00:00.000Z',
  claimedBy: null,
  claimedAt: null,
};

test('a self-claim broadcast arriving before the claim response does not invalidate the route', async () => {
  const entry = { run: baseRun, focus: true };
  let latestEntry = entry;
  let claimCalls = 0;
  const claimedRun = {
    ...baseRun,
    version: 2,
    updatedAt: '2026-07-14T12:00:01.000Z',
    claimedBy: 'window-a',
    claimedAt: '2026-07-14T12:00:01.000Z',
  };

  const result = await resolveRouteClaim({
    entry,
    alreadyOwned: false,
    claim: async () => {
      claimCalls++;
      // NativeLoopRuntime broadcasts synchronously before Express completes
      // the claim response, so the WebSocket handler records this first.
      latestEntry = { run: claimedRun, focus: true };
      return claimedRun;
    },
    getLatestEntry: () => latestEntry,
    windowId: 'window-a',
    claimTtlMs: 90_000,
    terminalStatuses: TERMINAL_STATUSES,
    now: () => new Date('2026-07-14T12:00:02.000Z').getTime(),
  });

  assert.equal(claimCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.run, claimedRun);
  assert.equal(result.release, undefined);
});

test('an owned route reuses its lease while applying the newest run descriptor', async () => {
  const entry = { run: baseRun, focus: false };
  const updatedRun = {
    ...baseRun,
    version: 3,
    currentIteration: 2,
    updatedAt: '2026-07-14T12:00:03.000Z',
    claimedBy: 'window-a',
    claimedAt: '2026-07-14T12:00:01.000Z',
  };
  let claimCalls = 0;

  const result = await resolveRouteClaim({
    entry,
    alreadyOwned: true,
    claim: async () => { claimCalls++; return null; },
    getLatestEntry: () => ({ run: updatedRun, focus: false }),
    windowId: 'window-a',
    claimTtlMs: 90_000,
    terminalStatuses: TERMINAL_STATUSES,
    now: () => new Date('2026-07-14T12:00:04.000Z').getTime(),
  });

  assert.equal(claimCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.run, updatedRun);
  assert.equal(result.focus, false);
});

test('a live foreign claim still cancels local routing', async () => {
  const entry = { run: baseRun };
  const foreignRun = {
    ...baseRun,
    version: 4,
    claimedBy: 'window-b',
    claimedAt: '2026-07-14T12:00:04.000Z',
  };

  const result = await resolveRouteClaim({
    entry,
    alreadyOwned: true,
    claim: async () => assert.fail('owned routes must not reclaim'),
    getLatestEntry: () => ({ run: foreignRun }),
    windowId: 'window-a',
    claimTtlMs: 90_000,
    terminalStatuses: TERMINAL_STATUSES,
    now: () => new Date('2026-07-14T12:00:05.000Z').getTime(),
  });

  assert.deepEqual(result, { ok: false, release: false, reason: 'foreign_claim' });
});

test('local claim-release broadcasts are consumed once and expire', () => {
  let now = 1_000;
  const tracker = new LocalReleaseTracker({ ttlMs: 5_000, now: () => now });

  tracker.mark('run-1');
  assert.equal(tracker.consume('run-1'), true);
  assert.equal(tracker.consume('run-1'), false);

  tracker.mark('run-2');
  now += 5_001;
  assert.equal(tracker.consume('run-2'), false);
});

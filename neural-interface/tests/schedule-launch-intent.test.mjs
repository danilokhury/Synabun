import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createScheduleSidepanelIntent,
  mergeScheduleLaunchSnapshot,
  resolveScheduleRunPresentation,
} from '../lib/schedule-launch-intent.js';

test('manual schedule intent is bounded and requires both ownership values', () => {
  assert.equal(createScheduleSidepanelIntent({ sidepanelWindowId: 'window-only' }), null);
  const intent = createScheduleSidepanelIntent({
    sidepanelWindowId: `  ${'w'.repeat(200)}  `,
    sidepanelClaimToken: ' claim-token ',
  });
  assert.equal(intent.windowId.length, 128);
  assert.equal(intent.claimToken, 'claim-token');
  assert.equal(intent.focus, true);
});

test('persisted schedule refresh preserves only transient launch metadata', () => {
  const intent = { windowId: 'window-a', claimToken: 'claim-a', focus: true };
  const merged = mergeScheduleLaunchSnapshot(
    { id: 'schedule-a', name: 'Fresh name', enabled: true },
    {
      id: 'schedule-a', name: 'Stale name', enabled: false,
      _forced: true, _quickTimer: true, _sidepanelLaunch: intent,
      untrustedTransient: 'drop-me',
    },
  );
  assert.equal(merged.name, 'Fresh name');
  assert.equal(merged.enabled, true);
  assert.equal(merged._forced, true);
  assert.equal(merged._quickTimer, true);
  assert.deepEqual(merged._sidepanelLaunch, intent);
  assert.equal(merged.untrustedTransient, undefined);
});

test('Run now focuses and claims its origin while cron and revoked launches stay background', () => {
  const schedule = {
    _sidepanelLaunch: createScheduleSidepanelIntent({
      sidepanelWindowId: 'window-a',
      sidepanelClaimToken: 'claim-a',
    }),
  };
  assert.deepEqual(resolveScheduleRunPresentation(schedule), {
    source: 'schedule-manual',
    focus: true,
    claimedBy: 'window-a',
  });
  assert.deepEqual(resolveScheduleRunPresentation(schedule, () => true), {
    source: 'schedule',
    focus: false,
    claimedBy: null,
  });
  assert.deepEqual(resolveScheduleRunPresentation({}), {
    source: 'schedule',
    focus: false,
    claimedBy: null,
  });
  assert.deepEqual(resolveScheduleRunPresentation({ _quickTimer: true }), {
    source: 'quick-timer',
    focus: false,
    claimedBy: null,
  });
});


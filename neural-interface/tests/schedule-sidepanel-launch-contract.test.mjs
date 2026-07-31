import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('Codex native schedules use only the trusted global CLI', () => {
  const server = read('neural-interface/server.js');
  const resolver = read('neural-interface/lib/codex-runtime-path.js');
  assert.match(server, /function getNativeCodexBin\(\)/);
  assert.match(server, /codexPath: getNativeCodexBin\(\)/);
  const nativeFactory = server.slice(
    server.indexOf('codex: (state) => {'),
    server.indexOf('opencode: async (state)', server.indexOf('codex: (state) => {')),
  );
  assert.match(nativeFactory, /ensureCanonicalCodexConfig\(\{ strict: true \}\)/);
  assert.ok(
    nativeFactory.indexOf('ensureCanonicalCodexConfig') < nativeFactory.indexOf('createCodexNativeLoopAdapter'),
    'Codex config must be repaired before the native SDK adapter starts',
  );
  assert.match(server, /resolveTrustedWindowsCodexBinary/);
  assert.match(server, /acceptBinary: \(candidate\) => !isInsideSynabun\(candidate\)/);
  assert.match(resolver, /@openai\/codex-win32-x64/);
  assert.match(resolver, /@openai\/codex-win32-arm64/);
  assert.match(resolver, /if \(\/\\\.exe\$\/i\.test\(launcher\)/);
  assert.match(server, /Codex schedules require a trusted global Codex CLI/);
  assert.doesNotMatch(server, /resolveBundledCodexRuntime|getBundledCodexBin|ensureBundledCodexExecutable/);
});

test('both schedule surfaces send ownership for Run now entrypoints', () => {
  const api = read('neural-interface/public/shared/api.js');
  const schedules = read('neural-interface/public/shared/ui-schedules-studio.js');
  const automations = read('neural-interface/public/shared/ui-automation-studio.js');
  for (const source of [api, schedules, automations]) {
    assert.match(source, /sidepanelWindowId/);
    assert.match(source, /sidepanelClaimToken/);
  }
  assert.match(schedules, /testSchedule\(id, \{/);
  assert.match(automations, /testSchedule\(id, \{/);
  assert.match(schedules, /triggerQuickTimerNow\(templateId, \{/);
  assert.match(automations, /triggerQuickTimerNow\(templateId, \{/);
});

test('schedule queue preserves focus intent and native outcomes update schedule state', () => {
  const server = read('neural-interface/server.js');
  const router = read('neural-interface/public/shared/ui-native-loop-router.js');
  assert.match(server, /mergeScheduleLaunchSnapshot\(persisted, schedule\)/);
  assert.match(server, /mergeScheduleLaunchSnapshot\(persistedQueued, schedule\)/);
  assert.match(server, /resolveScheduleRunPresentation/);
  assert.match(server, /claimedBy: presentation\.claimedBy/);
  assert.match(server, /persistNativeScheduleOutcome\(run, runningInfo\)/);
  assert.match(server, /persistExecScheduleOutcome\(loopState, 'completed'\)/);
  assert.match(server, /persistExecScheduleOutcome\(loopState, 'failed'/);
  assert.match(server, /persistExecScheduleOutcome\(data, 'stopped', 'user'\)/);
  assert.match(server, /persistExecScheduleOutcome\(ls, 'failed', ls\.stoppedReason\)/);
  assert.match(server, /type: 'schedule:failed'/);
  assert.match(server, /driverType: loopState\.driverType/);
  assert.match(router, /typeof run\.focus === 'boolean'/);
});

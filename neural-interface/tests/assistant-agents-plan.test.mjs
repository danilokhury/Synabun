// Agents tray lifecycle (dispatcher views vs runtime descriptors), finished-run
// removal, and plan mode beside the approval mode for every brain provider.
process.env.SYNABUN_TYPESAFE = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunDescriptor, runFromPayload, isTerminalRunStatus, isRemovableRun, isRunIdle, normalizeBrain, brainModePatch, permissionModeLabel } from '../public/shared/assistant/asst-state.js';
import { runStatusFromState } from '../lib/assistant-dispatch.js';
import { claudeSdkMode } from '../lib/assistant-brains/claude.js';
import { codexApprovalMode } from '../lib/assistant-brains/codex.js';
import { opencodeAutoAccepts } from '../lib/assistant-brains/opencode.js';
import { normalizeBrain as serverBrain, brainModeUpdate } from '../lib/assistant-runtime.js';

const rt = (o) => ({ runId: 'r1', surface: 'sidepanel', runtimeType: 'native', assistantSessionId: 's1', ...o });
const dv = (o) => ({ runId: 'r1', dispatchId: 'r1', assistantSessionId: 's1', ...o });

test('a dispatcher-only terminal view ends the run in the tray', () => {
  let m = mergeRunDescriptor(null, runFromPayload({ run: rt({ status: 'running', version: 7 }) }));
  m = mergeRunDescriptor(m, runFromPayload({ run: dv({ state: 'idle', turnState: 'idle', version: 8 }) }));
  assert.equal(isRunIdle(m), true);
  m = mergeRunDescriptor(m, runFromPayload({ run: dv({ state: 'stopped', turnState: 'terminal', version: 9, finishedAt: '2026-09-26T10:00:00Z' }) }));
  assert.equal(m.status, 'stopped');
  assert.equal(isTerminalRunStatus(m.status), true);
  assert.equal(m.completedAt, '2026-09-26T10:00:00Z');
});

test('a fresh listing of finished runs is not shown as running', () => {
  const m = mergeRunDescriptor(null, runFromPayload({ run: dv({ state: 'completed', version: 3 }) }));
  assert.equal(m.status, 'completed');
});

test('a finished idle worker offers Remove while an active or input-waiting worker does not', () => {
  assert.equal(isRemovableRun(dv({ state: 'idle', status: 'running', outcome: 'done' })), true);
  assert.equal(isRemovableRun(dv({ state: 'idle', status: 'running', lastResult: { status: 'blocked' } })), true);
  assert.equal(isRemovableRun(dv({ state: 'running', status: 'running', outcome: 'done' })), false);
  assert.equal(isRemovableRun(dv({ state: 'idle', status: 'running', lastResult: { status: 'needs_input' } })), false);
  assert.equal(isRemovableRun(dv({ state: 'completed', status: 'completed' })), true);
});

test('runtime terminal first, then the dispatcher view with a smaller version counter', () => {
  let m = mergeRunDescriptor(null, dv({ state: 'idle', version: 8 }));
  m = mergeRunDescriptor(m, rt({ status: 'completed', version: 40, completedAt: '2026-09-26T10:05:00Z' }));
  assert.equal(m.status, 'completed');
  assert.equal(m.state, 'completed');
  m = mergeRunDescriptor(m, dv({ state: 'completed', version: 9, lastResult: { status: 'done' } }));
  assert.equal(m.status, 'completed');
  assert.equal(m.lastResult.status, 'done');
  // a late non-terminal runtime event never revives it
  m = mergeRunDescriptor(m, rt({ status: 'running', version: 41, claimedBy: 'w1' }));
  assert.equal(m.status, 'completed');
  assert.equal(m.claimedBy, 'w1');
});

test('server views report status from state', () => {
  assert.equal(runStatusFromState('idle'), 'running');
  assert.equal(runStatusFromState('awaiting_route'), 'queued');
  assert.equal(runStatusFromState('interrupted'), 'interrupted');
});

test('plan mode combines with every approval mode', () => {
  const b = normalizeBrain({ provider: 'codex', permissionMode: 'auto', planMode: true });
  assert.deepEqual([b.permissionMode, b.planMode], ['auto', true]);
  assert.equal(permissionModeLabel(b), 'Plan, then Auto-accept', 'a sentence, not a dot-joined pair');
  assert.equal(permissionModeLabel(normalizeBrain({ provider: 'claude-code', permissionMode: 'bypassPermissions', planMode: true })), 'Plan, then Bypass');
  // Claude leaving 'plan' (plan approved) keeps the approval mode; Codex reports plan explicitly.
  assert.deepEqual(brainModePatch({ provider: 'claude-code', planMode: true }, 'bypassPermissions'), { permissionMode: 'bypassPermissions', planMode: false });
  assert.deepEqual(brainModePatch({ provider: 'codex', planMode: true }, 'auto', true), { permissionMode: 'auto', planMode: true });
  assert.equal(claudeSdkMode('bypassPermissions', true), 'plan');
  assert.equal(claudeSdkMode('acceptEdits', false), 'acceptEdits');
  assert.equal(codexApprovalMode('auto'), 'auto'); // was never auto-accepted before
  const s = serverBrain({ provider: 'claude-code', permissionMode: 'plan' });
  assert.deepEqual([s.permissionMode, s.planMode], ['default', true]);
  assert.equal(serverBrain({ provider: 'codex', planMode: undefined }, { planMode: true }).planMode, true);
  assert.deepEqual(brainModeUpdate({ provider: 'claude-code' }, 'acceptEdits'), { permissionMode: 'acceptEdits' });
});

test('OpenCode auto-accept answers permission asks, never questions, never edits in plan mode', () => {
  const ask = (tool, kind = 'permission') => ({ request: { tool_name: tool, brain_native: { kind } } });
  assert.equal(opencodeAutoAccepts(ask('webfetch'), { approvalMode: 'auto', planMode: true }), true);
  assert.equal(opencodeAutoAccepts(ask('edit'), { approvalMode: 'auto', planMode: true }), false);
  assert.equal(opencodeAutoAccepts(ask('edit'), { approvalMode: 'auto', planMode: false }), true);
  assert.equal(opencodeAutoAccepts(ask('q', 'question'), { approvalMode: 'auto', planMode: false }), false);
  assert.equal(opencodeAutoAccepts(ask('bash'), { approvalMode: 'default', planMode: false }), false);
});

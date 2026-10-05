import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLimit,
  applyLimitPacket,
  applyUsagePacket,
  DEFAULT_BRAIN,
  DEFAULT_ROUTE_MODE,
  ROUTE_MODES,
  brainLabel,
  brainRequiresSwitch,
  createTabState,
  compactUsageView,
  deserializeTabState,
  fmtConfidence,
  fmtCost,
  fmtElapsed,
  fmtRunLine,
  limitExpiresIn,
  limitNoticeText,
  mergeRunDescriptor,
  normalizeBrain,
  normalizeComputerMode,
  normalizeLimit,
  normalizeRouteMode,
  resolveBrainDefaults,
  routeKindLabel,
  routeTargetLabel,
  runFromPayload,
  runNeedsAttention,
  runTone,
  serializeTabState,
  sortRuns,
  summarizeMailbox,
  tabStorageKey,
} from '../public/shared/assistant/asst-state.js';

test('usage packet keeps authoritative totals and rejects stale or invalid updates', () => {
  const state = createTabState('s1', { provider: 'codex' });
  const packet = { type: 'assistant:usage', sessionId: 's1', task: { id: 't1', n: 2, live: true, fidelity: 'live', tokens: { total: 150 }, pending: { total: 50 }, agents: [] }, session: { tokens: { total: 150 }, tasks: 1 }, recent: [] };
  assert.equal(applyUsagePacket(state, packet), true);
  assert.equal(state.usageView.task.tokens.total, 150);
  assert.equal(applyUsagePacket(state, { ...packet, sessionId: 'wrong' }), false);
  assert.equal(applyUsagePacket(state, { ...packet, task: { ...packet.task, n: 1 } }), false);
  assert.equal(applyUsagePacket(state, { ...packet, task: { ...packet.task, tokens: { total: NaN } } }), false);
  assert.equal(applyUsagePacket(state, { ...packet, task: { ...packet.task, live: false, fidelity: 'partial', tokens: { total: 140 } } }), true);
  assert.equal(applyUsagePacket(state, packet), false, 'late live replay cannot undo settlement');
  assert.equal(state.usageView.task.tokens.total, 140);
});

test('a follow-up task replaces the view without lowering the session; an older view never comes back', () => {
  const state = createTabState('s1', { provider: 'claude-code' });
  const view = (settled, pending, task) => ({ type: 'assistant:usage', sessionId: 's1', task: { agents: [], tokens: { total: 0 }, ...task }, session: { tokens: { total: settled + pending }, pending: { total: pending }, fidelity: pending ? 'live' : 'exact', live: pending > 0, tasks: task.n }, recent: [] });
  assert.equal(applyUsagePacket(state, view(3_615_015, 0, { id: 'task-1', n: 1, fidelity: 'exact', tokens: { total: 3_615_015 } })), true);
  // The follow-up prompt: task-2 begins at zero, the session keeps its total.
  assert.equal(applyUsagePacket(state, view(3_615_015, 0, { id: 'task-2', n: 2, fidelity: 'exact', tokens: { total: 0 } })), true);
  assert.deepEqual([state.usageView.task.id, state.usageView.task.tokens.total, state.usageView.session.tokens.total], ['task-2', 0, 3_615_015]);
  // A settled task going live again (a mailbox turn for it) is shown, not dropped as a replay.
  assert.equal(applyUsagePacket(state, view(3_615_015, 4000, { id: 'task-2', n: 2, fidelity: 'live', live: true, tokens: { total: 4000 } })), true);
  assert.equal(applyUsagePacket(state, view(3_620_000, 0, { id: 'task-2', n: 2, fidelity: 'exact', tokens: { total: 4985 } })), true);
  // A packet computed before that settle arrives late: fewer settled tokens, so it is older.
  assert.equal(applyUsagePacket(state, view(3_615_015, 4000, { id: 'task-2', n: 2, fidelity: 'live', live: true, tokens: { total: 4000 } })), false);
  assert.equal(state.usageView.session.tokens.total, 3_620_000);
  // What a reload restores keeps the headline and what orders views.
  const saved = deserializeTabState(JSON.stringify(serializeTabState(state))).usageView;
  assert.deepEqual([saved.session.tokens.total, saved.session.pending, saved.session.fidelity, saved.session.live], [3_620_000, { total: 0 }, 'exact', false]);
});

test('usage persistence stores a bounded snapshot and restores its display data', () => {
  const state = createTabState('s1', { provider: 'codex' });
  const view = { sessionId: 's1', task: { id: 't1', n: 1, title: 'Read tokens', fidelity: 'exact', tokens: { input: 2, total: 10 }, agents: [{ key: 'brain', scope: 'brain', tokens: { total: 10 }, provider: 'codex', model: 'gpt' }] }, session: { tokens: { total: 10 }, tasks: 1 }, recent: [] };
  assert.equal(applyUsagePacket(state, { type: 'assistant:usage', ...view }), true);
  const saved = serializeTabState(state);
  assert.equal(saved.usageView.task.tokens.total, 10);
  assert.equal(saved.usageView.task.agents[0].tokens.total, 10);
  assert.equal(saved.usageView.task.models, undefined);
  assert.equal(deserializeTabState(JSON.stringify(saved)).usageView.task.title, 'Read tokens');
  assert.equal(compactUsageView({ task: { id: 'bad', tokens: { total: -1 } } }), null);
});
import { resolvableModels } from '../public/shared/assistant/asst-brain-picker.js';
import { KEYS } from '../public/shared/constants.js';

const T0 = '2026-09-13T10:00:00.000Z';
const T1 = '2026-09-13T10:00:05.000Z';

// ── mergeRunDescriptor ─────────────────────────────────────────────────────

test('mergeRunDescriptor: newer version wins, older only fills gaps', () => {
  const current = { runId: 'r1', status: 'running', version: 2, updatedAt: T1, title: 'Docs', model: 'gpt-5.5' };
  const stale = { runId: 'r1', status: 'starting', version: 1, updatedAt: T0, provider: 'codex', costUsd: 0.01 };
  const merged = mergeRunDescriptor(current, stale);
  assert.equal(merged.status, 'running');       // current kept
  assert.equal(merged.version, 2);
  assert.equal(merged.provider, 'codex');       // gap filled from the stale one
  assert.equal(merged.title, 'Docs');
  assert.equal(merged.costUsd, 0.01);

  const fresh = { runId: 'r1', status: 'running', version: 3, updatedAt: T1, turnState: 'idle', model: undefined };
  const merged2 = mergeRunDescriptor(current, fresh);
  assert.equal(merged2.version, 3);
  assert.equal(merged2.turnState, 'idle');
  assert.equal(merged2.model, 'gpt-5.5');       // undefined in `next` does not clobber
});

test('mergeRunDescriptor: terminal status beats a higher-version active descriptor', () => {
  const done = { runId: 'r1', status: 'completed', version: 3, updatedAt: T1, completedAt: T1 };
  const lateRunning = { runId: 'r1', status: 'running', version: 9, updatedAt: '2026-09-13T10:01:00.000Z' };
  const merged = mergeRunDescriptor(done, lateRunning);
  assert.equal(merged.status, 'completed');
  assert.equal(merged.completedAt, T1);
  // and the reverse: a terminal descriptor arriving over an active one always applies
  const merged2 = mergeRunDescriptor(lateRunning, done);
  assert.equal(merged2.status, 'completed');
  assert.equal(merged2.version, 3);
});

test('mergeRunDescriptor: cost is monotonic and title falls back', () => {
  const a = { runId: 'r1', status: 'running', version: 1, updatedAt: T0, costUsd: 0.5 };
  const b = { runId: 'r1', status: 'running', version: 2, updatedAt: T1, costUsd: 0.2, title: 'late title' };
  assert.equal(mergeRunDescriptor(a, b).costUsd, 0.5);
  assert.equal(mergeRunDescriptor(a, b).title, 'late title');
  assert.equal(mergeRunDescriptor({ runId: 'r1', title: 'first', status: 'running' }, { runId: 'r1', status: 'running', title: '' }).title, 'first');
  assert.deepEqual(mergeRunDescriptor(null, { runId: 'r2', x: undefined, status: 'queued' }), { runId: 'r2', status: 'queued' });
  assert.deepEqual(mergeRunDescriptor({ runId: 'r3' }, null), { runId: 'r3' });
  assert.equal(mergeRunDescriptor(null, null), null);
});

test('sortRuns: attention first, then active, then terminal; newest first within a group', () => {
  const runs = [
    { runId: 'done', status: 'completed', startedAt: '2026-09-13T09:00:00Z' },
    { runId: 'old-run', status: 'running', startedAt: '2026-09-13T08:00:00Z' },
    { runId: 'new-run', status: 'running', startedAt: '2026-09-13T09:30:00Z' },
    { runId: 'ask', status: 'running', turnState: 'awaiting_permission', startedAt: '2026-09-13T07:00:00Z' },
    { runId: 'queued', status: 'queued', startedAt: '2026-09-13T09:45:00Z' },
  ];
  assert.deepEqual(sortRuns(runs).map(r => r.runId), ['ask', 'queued', 'new-run', 'old-run', 'done']);
  assert.equal(runTone(runs[3]), 'action');
  assert.equal(runTone(runs[0]), 'done');
  assert.equal(runTone(runs[4]), 'queued');
  assert.equal(runTone({ status: 'failed' }), 'error');
  assert.equal(runTone({ status: 'running', turnState: 'idle' }), 'idle');
  assert.equal(runTone({ status: 'running' }), 'running');
});

// ── Formatting ─────────────────────────────────────────────────────────────

test('fmtElapsed', () => {
  const start = Date.parse(T0);
  assert.equal(fmtElapsed(start, start + 12_000), '12s');
  assert.equal(fmtElapsed(T0, start + 184_000), '3m 04s');
  assert.equal(fmtElapsed(start, start + 72 * 60_000), '1h 12m');
  assert.equal(fmtElapsed(start, start + (51 * 3600_000)), '2d 3h');
  assert.equal(fmtElapsed(start, start - 1), '');
  assert.equal(fmtElapsed(null), '');
  assert.equal(fmtElapsed('not a date', start), '');
});

test('fmtCost', () => {
  assert.equal(fmtCost(null), '');
  assert.equal(fmtCost(''), '');
  assert.equal(fmtCost('abc'), '');
  assert.equal(fmtCost(-1), '');
  assert.equal(fmtCost(0), '$0.00');
  assert.equal(fmtCost(0.004), '<$0.01');
  assert.equal(fmtCost(0.12), '$0.12');
  assert.equal(fmtCost('1.5'), '$1.50');
});

test('fmtRunLine composes the terse status line', () => {
  const now = Date.parse(T1);
  const line = fmtRunLine({ runId: 'r1', provider: 'codex', model: 'openai/gpt-5.4-mini', title: 'Docs', status: 'running', startedAt: T0, costUsd: 0.02 }, { index: 3, now });
  assert.equal(line, '#3 codex/gpt-5.4-mini · Docs · running · 5s · $0.02');
  const asking = fmtRunLine({ runId: 'r2', provider: 'claude-code', status: 'running', turnState: 'awaiting_permission', startedAt: T0 }, { now });
  assert.equal(asking, 'claude-code · awaiting permission · 5s');
  assert.equal(fmtRunLine(null), '');
});

// ── Brains ─────────────────────────────────────────────────────────────────

test('normalizeBrain coerces aliases, modes and provider-specific fields', () => {
  assert.deepEqual(normalizeBrain(null), { ...DEFAULT_BRAIN });
  const b = normalizeBrain({ provider: 'claude', model: ' opus ', effort: 'high', agent: 'build', accountId: 'work', permissionMode: 'plan', cwd: '/repo' });
  assert.equal(b.provider, 'claude-code');
  assert.equal(b.model, 'opus');
  assert.equal(b.agent, null);          // only OpenCode carries an agent
  assert.equal(b.project, '/repo');     // cwd alias
  assert.equal(b.permissionMode, 'default'); // legacy 'plan' is the plan flag now
  assert.equal(b.planMode, true);
  const oc = normalizeBrain({ brain: 'oc', agent: 'build', accountId: 'x', permissionMode: 'bypassPermissions' });
  assert.equal(oc.provider, 'opencode');
  assert.equal(oc.agent, 'build');
  assert.equal(oc.accountId, null);     // no account picker for OpenCode
  assert.equal(oc.permissionMode, 'default'); // invalid for this provider
  assert.equal(normalizeBrain({ provider: 'nope' }).provider, 'claude-code');
});

test('resolveBrainDefaults fills model/effort/account/mcp/project from the catalog', () => {
  const catalog = {
    models: { codex: [{ id: 'gpt-5.4-mini' }, { id: 'gpt-5.5', tier: 'default', effortLevels: ['low', 'high'] }] },
    efforts: { codex: [{ id: 'low' }, { id: 'medium', tier: 'default' }, { id: 'high' }] },
    accounts: { codex: [{ id: 'default', isDefault: true }, { id: 'work' }], 'claude-code': [] },
    mcpProfiles: { core: {}, full: {}, browser: {} },
    defaultMcpProfile: 'standard', // not in the list → falls back to 'full'
    projects: [{ path: '/only' }],
  };
  const b = resolveBrainDefaults({ provider: 'codex', model: 'gone', effort: 'xhigh', accountId: 'missing', mcpProfile: 'nope' }, catalog);
  assert.equal(b.model, 'gpt-5.5');
  // xhigh is not one of gpt-5.5's levels (low/high) and its list default (medium) is not either → auto.
  assert.equal(b.effort, null);
  // The model's own default wins when it runs it.
  const withDefault = { ...catalog, models: { codex: [{ id: 'gpt-5.5', tier: 'default', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] } };
  assert.equal(resolveBrainDefaults({ provider: 'codex', model: 'gpt-5.5', effort: 'minimal' }, withDefault).effort, 'high');
  // A model change checks the effort against the NEW model's levels.
  const twoModels = { models: { codex: [{ id: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }] } };
  assert.equal(resolveBrainDefaults({ provider: 'codex', model: 'gpt-6-sol', effort: 'ultra' }, twoModels).effort, 'ultra');
  assert.equal(resolveBrainDefaults({ provider: 'codex', model: 'gpt-5.5', effort: 'ultra' }, twoModels).effort, null);
  assert.equal(b.accountId, 'default');
  assert.equal(b.mcpProfile, 'full');
  assert.equal(b.project, '/only');

  // Valid values are preserved; explicit null effort stays null
  const keep = resolveBrainDefaults({ provider: 'codex', model: 'gpt-5.4-mini', effort: 'low', accountId: 'work', mcpProfile: 'core', project: '/mine' }, catalog);
  assert.equal(keep.model, 'gpt-5.4-mini');
  assert.equal(keep.effort, 'low');
  assert.equal(keep.accountId, 'work');
  assert.equal(keep.mcpProfile, 'core');
  assert.equal(keep.project, '/mine');
  assert.equal(resolveBrainDefaults({ provider: 'codex', effort: null }, catalog).effort, null);

  // 'off' default effort becomes null; empty effort list clears effort
  assert.equal(resolveBrainDefaults({ provider: 'codex', effort: 'bad' }, { efforts: { codex: [{ id: 'off', tier: 'default' }] } }).effort, null);
  assert.equal(resolveBrainDefaults({ provider: 'codex', effort: 'high' }, { efforts: { codex: [] } }).effort, null);
});

test('picker defaults resolve against the model menu: a context-variant pick stays, the default is never a disabled model', () => {
  // The menu for a live list: the base GPT-6 rows (Codex's default among them) off, their extended windows on.
  // The provider's own list has no "[extended]" ids, so checking against it swapped every pick for the disabled default.
  const menu = {
    codex: [
      { id: 'gpt-6-astra[extended]', selector: 'gpt-6-astra[extended]', isDefault: false, efforts: ['low', 'high'] },
      { id: 'gpt-6-sol[extended]', selector: 'gpt-6-sol[extended]', isDefault: false, efforts: ['low', 'high'] },
    ],
    'claude-code': [{ id: 'default', selector: 'default', tier: 'default' }, { id: 'opus[1m]', selector: 'opus[1m]' }],
  };
  const resolve = (brain, catalog = menu) => resolveBrainDefaults(brain, { models: { [brain.provider]: resolvableModels(brain.provider, brain.model, catalog) } });
  assert.equal(resolve({ provider: 'codex', model: 'gpt-6-sol[extended]', effort: 'high' }).model, 'gpt-6-sol[extended]');
  assert.equal(resolve({ provider: 'codex', model: 'gpt-6-sol[extended]', effort: 'high' }).effort, 'high');
  assert.equal(resolve({ provider: 'claude-code', model: 'opus[1m]' }).model, 'opus[1m]', 'not swapped for "default"');
  assert.equal(resolve({ provider: 'codex', model: '' }).model, 'gpt-6-astra[extended]', 'a new Codex brain starts on an enabled model');
  assert.equal(resolve({ provider: 'codex', model: 'gpt-9-gone' }).model, 'gpt-6-astra[extended]', 'an unknown id is replaced');
  // Before the first catalog load the brain's model is kept: nothing can tell a context variant from an unknown id yet.
  assert.equal(resolve({ provider: 'codex', model: 'gpt-6-sol[extended]' }, null).model, 'gpt-6-sol[extended]');
});

test('resolveBrainDefaults: OpenCode picks a primary agent and keeps its model variant; accounts default when unknown', () => {
  const oc = resolveBrainDefaults({ provider: 'opencode', effort: 'high', agent: 'ghost' }, { agents: [{ name: 'explore', mode: 'subagent' }, { name: 'build', mode: 'primary' }] });
  assert.equal(oc.effort, 'high', 'an unknown model keeps its variant (it cannot be checked)');
  const glm = { models: { opencode: [{ id: 'zai/glm-5.3-flash', variants: { low: {}, high: {}, max: {}, xhigh: { disabled: true } } }, { id: 'zai/plain', variants: {} }] } };
  assert.equal(resolveBrainDefaults({ provider: 'opencode', model: 'zai/glm-5.3-flash', effort: 'max' }, glm).effort, 'max');
  assert.equal(resolveBrainDefaults({ provider: 'opencode', model: 'zai/glm-5.3-flash', effort: 'xhigh' }, glm).effort, null, 'a disabled variant is not offered');
  assert.equal(resolveBrainDefaults({ provider: 'opencode', model: 'zai/plain', effort: 'high' }, glm).effort, null, 'a model without variants takes none');
  assert.equal(oc.agent, 'build');
  assert.equal(oc.accountId, null);
  const noCatalog = resolveBrainDefaults({ provider: 'claude-code' }, {});
  assert.equal(noCatalog.accountId, 'default');
  assert.equal(noCatalog.model, '');
  assert.equal(resolveBrainDefaults({ provider: 'claude-code', mcpProfile: '' }, { defaultMcpProfile: 'standard' }).mcpProfile, 'standard');
});

test('brainLabel / brainRequiresSwitch', () => {
  assert.equal(brainLabel({ provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' }), 'Claude · claude-sonnet-4-6 · high');
  assert.equal(brainLabel({ provider: 'opencode', model: 'anthropic/claude-opus:1', agent: 'build' }), 'OpenCode · claude-opus · build');
  assert.equal(brainRequiresSwitch({ provider: 'codex' }, { provider: 'codex', model: 'x' }), false);
  assert.equal(brainRequiresSwitch({ provider: 'codex', accountId: 'a' }, { provider: 'codex', accountId: 'b' }), true);
  assert.equal(brainRequiresSwitch({ provider: 'codex', mcpProfile: 'full' }, { provider: 'codex', mcpProfile: 'core' }), true);
  assert.equal(brainRequiresSwitch({ provider: 'codex' }, { provider: 'claude-code' }), true);
});

// ── Payloads, mailbox, persistence ─────────────────────────────────────────

test('runFromPayload + summarizeMailbox', () => {
  assert.deepEqual(runFromPayload({ run: { runId: 'r1' } }), { runId: 'r1' });
  assert.deepEqual(runFromPayload({ runId: 'r2', status: 'running' }), { runId: 'r2', status: 'running' });
  assert.equal(runFromPayload({ nope: true }), null);
  assert.equal(runFromPayload(null), null);
  const summary = summarizeMailbox({ events: [{ kind: 'result', runId: 'a' }, { kind: 'result', runId: 'b' }, { type: 'failed', run: { runId: 'c' } }, {}] });
  assert.deepEqual(summary, [
    { kind: 'result', count: 2, runIds: ['a', 'b'] },
    { kind: 'failed', count: 1, runIds: ['c'] },
    { kind: 'event', count: 1, runIds: [] },
  ]);
});

test('tab state serializes to a JSON-safe subset and round-trips', () => {
  assert.equal(tabStorageKey('assistant-1'), `${KEYS.ASSISTANT_TAB_PREFIX}assistant-1`);
  const state = { sessionId: 'assistant-1', brain: { provider: 'codex', model: 'gpt-5.5' }, title: ' Docs ', dockOpen: false, dockShowAll: true, draft: 'hello', costUsd: '1.25', runs: new Map(), queue: [{ text: 'x' }] };
  const ser = serializeTabState(state);
  assert.equal(ser.v, 1);
  assert.equal(ser.title, 'Docs');
  assert.equal(ser.costUsd, 1.25);
  assert.equal(ser.runs, undefined);
  const back = deserializeTabState(JSON.stringify(ser));
  assert.equal(back.sessionId, 'assistant-1');
  assert.equal(back.brain.provider, 'codex');
  assert.equal(back.dockOpen, false);
  assert.equal(back.dockShowAll, true);
  assert.equal(back.draft, 'hello');
  assert.equal(deserializeTabState('{bad json'), null);
  assert.equal(deserializeTabState(null), null);
  assert.equal(serializeTabState(null), null);
});

// ── Routing + computer use ────────────────────────────────────────────────

test('route modes: canonical list, default and aliases', () => {
  assert.deepEqual(ROUTE_MODES, ['always-ask', 'ask-unsure', 'never']);
  assert.equal(DEFAULT_ROUTE_MODE, 'ask-unsure');
  for (const alias of ['always-ask', 'always', 'ask', 'ALWAYS', 'ask always']) assert.equal(normalizeRouteMode(alias), 'always-ask', alias);
  for (const alias of ['ask-unsure', 'unsure', 'ask_unsure', 'when-unsure']) assert.equal(normalizeRouteMode(alias), 'ask-unsure', alias);
  for (const alias of ['never', 'auto', 'autonomous', 'never-ask', ' Never ']) assert.equal(normalizeRouteMode(alias), 'never', alias);
  assert.equal(normalizeRouteMode('sometimes'), null);
  assert.equal(normalizeRouteMode(null), null);
  assert.equal(normalizeRouteMode('', 'ask-unsure'), 'ask-unsure');
});

test('computer mode: on/off/true/false, null = server default', () => {
  for (const on of ['on', 'ON', 'true', true, '1', 'yes', 'enabled']) assert.equal(normalizeComputerMode(on), true, String(on));
  for (const off of ['off', 'false', false, '0', 'no', 'disabled']) assert.equal(normalizeComputerMode(off), false, String(off));
  assert.equal(normalizeComputerMode(null), null);
  assert.equal(normalizeComputerMode('maybe'), null);
  assert.equal(normalizeComputerMode(undefined, false), false);
});

test('route and computer modes round-trip through tab state; old payloads read as defaults', () => {
  const state = createTabState('assistant-9', { provider: 'claude-code' }, { routeMode: 'always', computerUse: 'on' });
  assert.equal(state.routeMode, 'always');
  const ser = serializeTabState(state);
  assert.equal(ser.v, 1);
  assert.equal(ser.routeMode, 'always-ask');
  assert.equal(ser.computerUse, true);
  const back = deserializeTabState(JSON.stringify(ser));
  assert.equal(back.routeMode, 'always-ask');
  assert.equal(back.computerUse, true);
  const off = deserializeTabState(serializeTabState({ ...state, routeMode: 'never', computerUse: false }));
  assert.equal(off.routeMode, 'never');
  assert.equal(off.computerUse, false);
  // Pre-routing payload (no keys) and junk values → null (server default).
  const legacy = deserializeTabState({ v: 1, sessionId: 'assistant-1', brain: { provider: 'codex' }, dockOpen: false });
  assert.equal(legacy.routeMode, null);
  assert.equal(legacy.computerUse, null);
  assert.equal(legacy.dockOpen, false);
  const junk = deserializeTabState({ sessionId: 'x', routeMode: 'sometimes', computerUse: 'maybe' });
  assert.equal(junk.routeMode, null);
  assert.equal(junk.computerUse, null);
  assert.equal(createTabState('a', null).routeMode, null);
});

test('route labels and confidence helpers', () => {
  assert.equal(routeTargetLabel({ provider: 'codex', model: 'gpt-5.5', label: 'GPT-5.5' }), 'GPT-5.5');
  assert.equal(routeTargetLabel({ provider: 'opencode', model: 'openai/gpt-5.5:1' }), 'gpt-5.5');
  assert.equal(routeTargetLabel({ provider: 'claude' }), 'Claude');
  assert.equal(routeTargetLabel({ provider: 'codex', model: 'gpt-5.5', effort: 'high' }, { effort: true }), 'gpt-5.5 · high');
  assert.equal(routeTargetLabel({ provider: 'codex', model: 'gpt-5.5', effort: 'off' }, { effort: true }), 'gpt-5.5');
  assert.equal(routeTargetLabel(null), '');
  assert.equal(routeKindLabel('direct'), 'here');
  assert.equal(routeKindLabel('dispatch'), 'dispatch');
  assert.equal(routeKindLabel('computer'), 'computer');
  assert.equal(routeKindLabel('Other'), 'other');
  assert.equal(fmtConfidence(0.86), '86%');
  assert.equal(fmtConfidence(86), '86%');
});

test('runs waiting for a model choice need attention', () => {
  assert.equal(runNeedsAttention({ status: 'queued', state: 'awaiting_route' }), true);
  assert.equal(runNeedsAttention({ status: 'running', route: { status: 'pending' } }), true);
  assert.equal(runNeedsAttention({ status: 'running', route: { status: 'approved' } }), false);
  assert.equal(runTone({ status: 'queued', state: 'awaiting_route' }), 'action');
  assert.match(fmtRunLine({ runId: 'r', provider: 'codex', status: 'queued', state: 'awaiting_route' }), /awaiting model choice/);
});

test('summarizeMailbox accepts { items } (runtime), { events } and arrays', () => {
  const items = [{ kind: 'result', run: { runId: 'a' } }, { kind: 'failed', runId: 'b' }, { kind: 'result', run: { runId: 'c' } }];
  const expected = [{ kind: 'result', count: 2, runIds: ['a', 'c'] }, { kind: 'failed', count: 1, runIds: ['b'] }];
  assert.deepEqual(summarizeMailbox({ items }), expected);
  assert.deepEqual(summarizeMailbox({ events: items }), expected);
  assert.deepEqual(summarizeMailbox(items), expected);
  assert.deepEqual(summarizeMailbox({}), []);
  assert.deepEqual(summarizeMailbox(null), []);
});

test('the usage limit is one notice: upserted in place, never appended, and it clears', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const state = createTabState('s1', { provider: 'claude-code' });
  assert.equal(state.limit, null);
  const reset = now + 3_600_000;
  const warning = { status: 'allowed_warning', resetsAt: reset, rateLimitType: 'five_hour' };
  // Set once; the same report again (every response repeats it) changes nothing.
  assert.equal(applyLimitPacket(state, { type: 'assistant:limit', sessionId: 's1', limit: warning }, now), true);
  assert.deepEqual(state.limit, { status: 'warning', resetsAt: reset });
  for (let i = 0; i < 5; i += 1) assert.equal(applyLimitPacket(state, { type: 'assistant:limit', sessionId: 's1', limit: { ...warning, utilization: 0.9 + i / 100 } }, now), false);
  assert.deepEqual(state.limit, { status: 'warning', resetsAt: reset }, 'one object, not a list');
  // A new reset time, then a new status: the same notice, updated.
  assert.equal(applyLimitPacket(state, { sessionId: 's1', limit: { ...warning, resetsAt: reset + 600_000 } }, now), true);
  assert.deepEqual(state.limit, { status: 'warning', resetsAt: reset + 600_000 });
  assert.equal(applyLimitPacket(state, { sessionId: 's1', limit: { status: 'rejected', resetsAt: reset + 600_000 } }, now), true);
  assert.deepEqual(state.limit, { status: 'rejected', resetsAt: reset + 600_000 });
  // Another session's packet and a packet without a limit block are ignored.
  assert.equal(applyLimitPacket(state, { sessionId: 'other', limit: null }, now), false);
  assert.equal(applyLimitPacket(state, { sessionId: 's1' }, now), false);
  assert.equal(state.limit.status, 'rejected');
  // The server's clear, once.
  assert.equal(applyLimitPacket(state, { sessionId: 's1', limit: null }, now), true);
  assert.equal(state.limit, null);
  assert.equal(applyLimitPacket(state, { sessionId: 's1', limit: null }, now), false);
});

test('an older server\'s raw limit reports go through the same upsert: seconds, allowed clears, a passed reset clears', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const state = createTabState('s1', { provider: 'claude-code' });
  const secs = now / 1000 + 1800;
  assert.equal(applyLimit(state, { status: 'allowed_warning', resetsAt: secs, utilization: 0.91 }, now), true);
  assert.equal(applyLimit(state, { status: 'allowed_warning', resetsAt: secs, utilization: 0.95 }, now), false);
  assert.deepEqual(state.limit, { status: 'warning', resetsAt: secs * 1000 });
  assert.equal(applyLimit(state, {}, now), false, 'a report without a status says nothing');
  assert.equal(applyLimit(state, undefined, now), false);
  assert.equal(state.limit.status, 'warning');
  assert.equal(applyLimit(state, { status: 'allowed' }, now), true);
  assert.equal(state.limit, null);
  assert.equal(applyLimit(state, { status: 'rejected', resetsAt: now / 1000 - 1 }, now), false, 'already over: nothing to show');
  assert.equal(state.limit, null);
  // The reset time passing clears a notice that is up (the panel's timer applies the same rule).
  applyLimit(state, { status: 'rejected', resetsAt: secs }, now);
  assert.equal(limitExpiresIn(state.limit, now), 1_800_000);
  assert.equal(limitExpiresIn(state.limit, secs * 1000 + 5), 0);
  assert.equal(normalizeLimit(state.limit, secs * 1000 + 5), null);
  assert.deepEqual(normalizeLimit(state.limit, now), state.limit, 'a notice normalizes to itself');
  assert.equal(limitExpiresIn(null, now), null);
  assert.equal(limitExpiresIn({ status: 'rejected', resetsAt: null }, now), null, 'no reset time: nothing to wait for');
});

test('the limit notice keeps its wording and the local resets HH:MM', () => {
  const resetsAt = new Date(2026, 9, 2, 13, 0, 0).getTime();
  const time = new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  assert.equal(limitNoticeText({ status: 'warning', resetsAt }), `Approaching the usage limit · resets ${time}`);
  assert.equal(limitNoticeText({ status: 'rejected', resetsAt }), `Usage limit reached · resets ${time}`);
  assert.equal(limitNoticeText({ status: 'rejected', resetsAt: null }), 'Usage limit reached');
  assert.equal(limitNoticeText(null), '');
  // The panel's translator: the existing keys, the time as a parameter.
  const seen = [];
  const text = limitNoticeText({ status: 'warning', resetsAt }, (key, fallback, params) => { seen.push(key); return key === 'assistant.status.resetsAt' ? `volta ${params.time}` : fallback; });
  assert.equal(text, `Approaching the usage limit · volta ${time}`);
  assert.deepEqual(seen, ['assistant.status.rateLimitWarn', 'assistant.status.resetsAt']);
});

test('the limit notice is not persisted with the tab: the server sends it again on attach', () => {
  const state = createTabState('s1', { provider: 'claude-code' });
  applyLimit(state, { status: 'rejected', resetsAt: Date.now() + 60_000 });
  assert.equal('limit' in serializeTabState(state), false);
  assert.equal('limit' in deserializeTabState(JSON.stringify(serializeTabState(state))), false);
});

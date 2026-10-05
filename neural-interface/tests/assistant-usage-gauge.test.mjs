import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  USAGE_COST_NOTE, USAGE_SEMANTICS, costBasisLabel, formatCompactTokens, formatExactTokens, formatRunTokens, formatUsageCost, modelSegments,
  orderedAgents, reasonLabel, segmentWeights, settledTotal, statusLabel, taskPartialReason, tokenSides, usageCopyText, usageHeadline, usagePacketIsStale, usageStatus,
} from '../public/shared/assistant/asst-usage.js';
const en = JSON.parse(readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
const tr = (key, fallback) => key.split('.').reduce((value, part) => value?.[part], en) || fallback;

const view = {
  sessionId: 's1', task: { id: 't1', n: 4, title: 'Fix usage', live: true, fidelity: 'live', costUsd: 1.2,
    tokens: { input: 10, cacheWrite: 20, cacheRead: 30, output: 40, reasoning: 50, total: 150 }, pending: { total: 50 },
    agents: [
      { key: 'r1', scope: 'run', runId: 'r1', title: 'Codex', provider: 'codex', model: 'gpt', state: 'running', fidelity: 'live', tokens: { total: 1 }, subagents: { total: 1 } },
      { key: 'judgments', scope: 'judgments', title: 'Jev', state: 'done', fidelity: 'exact', tokens: { total: 2 } },
      { key: 'brain', scope: 'brain', title: 'Brain', provider: 'claude-code', state: 'idle', fidelity: 'exact', tokens: { total: 147 } },
    ] },
  session: { tokens: { total: 1000 }, costUsd: 2, tasks: 4 },
  recent: [{ id: 'old', n: 3, title: 'Old task', total: 850, costUsd: 0.8, fidelity: 'exact' }],
};

test('exact and compact token formatting carries units without 1000K', () => {
  assert.equal(formatExactTokens(123456789), '123,456,789');
  assert.deepEqual([999, 1000, 12400, 999999, 123456789].map(formatCompactTokens), ['999', '1.0K', '12.4K', '1.0M', '123M']);
  assert.equal(formatRunTokens({ total: 1500000 }, 'live').text, '≈1.5M tok');
  assert.equal(formatRunTokens({ total: 0 }, 'partial').label, '0 tokens, Partial');
  assert.equal(formatRunTokens(null, 'exact'), null);
  assert.equal(formatUsageCost(null), 'Cost unavailable');
  assert.equal(formatUsageCost(0), '$0.00');
});

test('bar orders brain first and Jev last, keeping tiny and zero segments', () => {
  assert.deepEqual(orderedAgents(view.task.agents).map(a => a.key), ['brain', 'r1', 'judgments']);
  assert.deepEqual(segmentWeights(view.task.agents).map(({ grow, positive }) => [grow, positive]), [[147, true], [1, true], [2, true]]);
  assert.deepEqual(segmentWeights([{ key: 'q', tokens: { total: 0 } }]), [{ key: 'q', grow: 0, positive: false }]);
});

test('status and partial reasons remain explicit', () => {
  assert.equal(usageStatus(view.task), 'live');
  assert.equal(usageStatus({ live: false, fidelity: 'partial' }), 'partial');
  assert.equal(statusLabel('exact'), 'Exact');
  assert.equal(reasonLabel('no-baseline'), 'No starting count was available.');
  assert.equal(reasonLabel('surprise'), 'A final token count was unavailable.');
  for (const [code, expected] of Object.entries({
    'no-model-usage': 'Claude reported no model totals; only its main loop was counted.',
    'counter-mismatch': 'Provider totals went backwards; this turn uses its own reported count.',
    'codex-rollout-missing': "Codex usage records were missing; the turn's own totals were used.",
    'opencode-not-reconciled': "OpenCode's final message check did not finish.",
  })) assert.equal(reasonLabel(code, tr), expected, code);
});

test('partial task reason falls back to its first partial agent and reaches copied text', () => {
  const task = { ...view.task, live: false, fidelity: 'partial', agents: [
    { fidelity: 'exact', partialReason: 'no-baseline' },
    { fidelity: 'partial', partialReason: 'codex-rollout-missing' },
    { fidelity: 'partial', partialReason: 'counter-mismatch' },
  ] };
  assert.equal(taskPartialReason(task), 'codex-rollout-missing');
  assert.equal(taskPartialReason({ ...task, partialReason: 'no-model-usage' }), 'no-model-usage', 'future task reason takes priority');
  assert.equal(taskPartialReason({ ...task, fidelity: 'exact' }), null);
  assert.equal(taskPartialReason({ ...task, agents: [] }), null);
  assert.match(usageCopyText({ ...view, task }), /Codex usage records were missing; the turn's own totals were used\./);
});

test('copy of an older packet (no session split) keeps the task block and its five classes', () => {
  const copied = usageCopyText(view);
  assert.match(copied, /^Session: 1,000 tokens · Live · 4 tasks · Cost \$2\.00\n/, 'the session comes first');
  assert.match(copied, /Task 4: Fix usage\n150 tokens \(input 60 · output 90\) · Live · Cost \$1\.20/);
  assert.ok(copied.includes('Brain (Claude Code): 147 tokens, Idle, Exact'));
  assert.ok(copied.includes('Old task: 850 tokens · Exact · $0.80'));
  assert.ok(!copied.includes('200 tokens'), 'pending is included, not added');
  // Without any session block the task is the headline, with its classes.
  const { session: _session, ...taskOnly } = view;
  for (const part of ['Uncached input: 10', 'Cache write: 20', 'Cache read: 30', 'Visible output: 40', 'Reasoning: 50']) assert.ok(usageCopyText(taskOnly).includes(part), part);
});

// A packet as the server sends it now: the session block is the headline.
const T = (input, cacheWrite, cacheRead, output, reasoning) => ({ input, cacheWrite, cacheRead, output, reasoning, total: input + cacheWrite + cacheRead + output + reasoning, inputTotal: input + cacheWrite + cacheRead, outputTotal: output + reasoning });
const sessionView = {
  sessionId: 's1',
  task: { id: 'task-2', n: 2, title: 'A follow-up', live: false, fidelity: 'exact', costUsd: 0, costBasis: null, tokens: T(0, 0, 0, 0, 0), pending: T(0, 0, 0, 0, 0), agents: [], models: [] },
  session: {
    tokens: T(68, 470_626, 3_048_288, 15_555, 40_407), pending: T(0, 0, 0, 0, 0), costUsd: 4.3762, costBasis: 'estimated', live: false, fidelity: 'exact', tasks: 2, unsynced: 0,
    models: [
      { provider: 'claude-code', model: 'claude-opus-5-5[1m]', tokens: T(30, 217_917, 1_435_941, 6095, 37_478), costUsd: 2.9021, costBasis: 'reported' },
      { provider: 'codex', model: 'gpt-6-sol', tokens: T(18_415, 0, 129_920, 1102, 1235), costUsd: 0.0862, costBasis: 'estimated' },
      { provider: 'opencode', model: 'xiaomi-token-plan-sgp/mimo-v2.6-flash', tokens: T(18_855, 0, 54_784, 777, 394), costUsd: 0, costBasis: 'free' },
    ],
  },
  recent: [{ id: 'task-1', n: 1, title: 'Token usage test', total: 3_615_015, inputTotal: 3_559_053, outputTotal: 55_962, costUsd: 4.3762, fidelity: 'partial', live: false }],
};

test('the headline is the session: a follow-up task at zero does not lower it', () => {
  const head = usageHeadline(sessionView);
  assert.deepEqual([head.scope, head.tokens.total, head.costUsd, head.costBasis, head.status, head.tasks], ['session', 3_574_944, 4.3762, 'estimated', 'exact', 2]);
  assert.equal(sessionView.task.tokens.total, 0, 'the current task has spent nothing');
  assert.deepEqual(tokenSides(head.tokens), { input: 3_518_982, output: 55_962, total: 3_574_944 }, 'input and output apart, and they add up');
  // Live anywhere in the session makes the headline provisional.
  assert.equal(usageHeadline({ ...sessionView, session: { ...sessionView.session, live: true, fidelity: 'live' } }).status, 'live');
  assert.equal(usageHeadline({ ...sessionView, session: { ...sessionView.session, fidelity: 'partial' } }).status, 'partial');
  // An older server (no fidelity on the session, no models): the session total still leads, the task fills the gaps.
  const older = { sessionId: 's1', task: { id: 't', n: 1, live: true, fidelity: 'live', tokens: T(1, 0, 0, 1, 0), models: [{ provider: 'codex', model: 'gpt', tokens: T(1, 0, 0, 1, 0) }] }, session: { tokens: T(10, 0, 0, 5, 0), costUsd: 1, tasks: 3 }, recent: [] };
  assert.deepEqual([usageHeadline(older).tokens.total, usageHeadline(older).status, usageHeadline(older).models.length], [15, 'live', 1]);
  // No session block at all: the task is shown, never a zero.
  assert.deepEqual([usageHeadline({ task: older.task }).scope, usageHeadline({ task: older.task }).tokens.total], ['task', 2]);
});

test('both sides come from the server, else from the classes, and are never made up', () => {
  assert.deepEqual(tokenSides({ input: 1, cacheWrite: 2, cacheRead: 3, output: 4, reasoning: 5, total: 15, inputTotal: 6, outputTotal: 9 }), { input: 6, output: 9, total: 15 });
  assert.deepEqual(tokenSides({ input: 1, cacheWrite: 2, cacheRead: 3, output: 4, reasoning: 5, total: 15 }), { input: 6, output: 9, total: 15 }, 'an older packet: the classes are added up');
  assert.deepEqual(tokenSides({ total: 1000 }), { input: null, output: null, total: 1000 }, 'only a total: no split is shown');
  assert.deepEqual(tokenSides(null), { input: null, output: null, total: 0 });
});

test('the bar has one segment per model of the session, and dollars say how they are known', () => {
  assert.deepEqual(modelSegments(sessionView.session.models), [
    { key: 'claude-code/claude-opus-5-5[1m]', grow: 1_697_461, positive: true },
    { key: 'codex/gpt-6-sol', grow: 150_672, positive: true },
    { key: 'opencode/xiaomi-token-plan-sgp/mimo-v2.6-flash', grow: 74_810, positive: true },
  ]);
  assert.deepEqual(modelSegments(null), []);
  assert.deepEqual(['reported', 'estimated', 'free', 'unpriced', null].map((basis) => costBasisLabel(basis)), ['reported', 'list-price equivalent', 'free', 'no list price', '']);
  assert.equal(costBasisLabel('estimated', tr), en.assistant.usage.basis.estimated);
  for (const key of ['semantics', 'costNote', 'toggleSession', 'toggleSessionClose', 'settledSession', 'inputTotal', 'outputTotal', 'models']) assert.ok(en.assistant.usage[key], key);
  assert.deepEqual([en.assistant.usage.semantics, en.assistant.usage.costNote], [USAGE_SEMANTICS, USAGE_COST_NOTE], 'the tooltip states the same semantics as the fallback text');
  assert.match(USAGE_SEMANTICS, /Codex reports cached tokens inside its input and reasoning inside its output, Claude reports them apart/);
  assert.equal(reasonLabel('interrupted', tr), en.assistant.usage.reason.interrupted);
});

test('an older view never replaces a newer one: the settled tokens of a session only grow', () => {
  const at = (settled, pending = 0, task = {}) => ({ sessionId: 's1', task: { id: 'task-2', n: 2, fidelity: pending ? 'live' : 'exact', live: pending > 0, tokens: { total: 0 }, ...task }, session: { tokens: { total: settled + pending }, pending: { total: pending }, tasks: 2 } });
  assert.equal(settledTotal(at(100, 20)), 100);
  assert.equal(usagePacketIsStale(null, at(0)), false);
  assert.equal(usagePacketIsStale(at(100), at(100, 30)), false, 'the same task going live again (a mailbox turn) is news');
  assert.equal(usagePacketIsStale(at(100, 30), at(140)), false, 'settled: newer');
  assert.equal(usagePacketIsStale(at(140), at(100, 30)), true, 'a live packet from before the settle lost the race');
  assert.equal(usagePacketIsStale(at(140), at(140, 0, { id: 'task-3', n: 3 })), false, 'a new task at the same total');
  assert.equal(usagePacketIsStale({ sessionId: 's1', task: { id: 'task-2', n: 2, fidelity: 'exact', tokens: { total: 5 } }, session: { tokens: { total: 5 } } }, at(100, 30)), false, 'a snapshot saved by an older panel never holds back a view that can say');
  // Views that cannot say (an older server): the task number and the settle rule still hold.
  const old = (n, fidelity) => ({ sessionId: 's1', task: { id: `t${n}`, n, fidelity, tokens: { total: 1 } }, session: { tokens: { total: 1 } } });
  assert.deepEqual([usagePacketIsStale(old(2, 'exact'), old(1, 'exact')), usagePacketIsStale(old(2, 'exact'), old(2, 'live')), usagePacketIsStale(old(2, 'live'), old(2, 'exact'))], [true, true, false]);
});

test('copy leads with the session: total, both sides, classes, models with dollars, then the task and the notes', () => {
  const copied = usageCopyText(sessionView).split('\n');
  assert.equal(copied[0], 'Session: 3,574,944 tokens (input 3,518,982 · output 55,962) · Exact · 2 tasks · Cost $4.38 (list-price equivalent)');
  assert.deepEqual(copied.slice(1, 6), ['Uncached input: 68', 'Cache write: 470,626', 'Cache read: 3,048,288', 'Visible output: 15,555', 'Reasoning: 40,407']);
  assert.deepEqual(copied.slice(6, 10), [
    'Models',
    'claude-opus-5-5[1m] (Claude Code): input 1,653,888 · output 43,573 · $2.90 (reported)',
    'gpt-6-sol (Codex): input 148,335 · output 2,337 · $0.09 (list-price equivalent)',
    'xiaomi-token-plan-sgp/mimo-v2.6-flash (OpenCode): input 73,639 · output 1,171 · $0.00 (free)',
  ]);
  assert.deepEqual(copied.slice(10, 12), ['Task 2: A follow-up', '0 tokens (input 0 · output 0) · Exact · Cost $0.00']);
  assert.ok(copied.includes('1. Token usage test: 3,615,015 tokens · Partial · $4.38'));
  assert.deepEqual(copied.slice(-2), [USAGE_SEMANTICS, USAGE_COST_NOTE]);
});
